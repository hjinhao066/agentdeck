'use strict';
// The whole loop in Node: the real task store and heartbeat, the real main-session.js
// (in a vm, as in main-ledger-state.test.js) and a stand-in deck. No model, no PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const AV = require('../auto-verify-core');
const { TaskStore, localSessions } = require('../task-board');
const { TaskHeartbeat } = require('../task-heartbeat');

const SONNET = 'claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high';
const CODEX = 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox';
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
const savedCap = M.MAX_ACTIVE;

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-autoverify-session-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); M.MAX_ACTIVE = savedCap; });
  const w = { root, dir: path.join(root, 'tasks'), out: new Set(), heldOnly: new Set(), stale: new Set(), seatOut: new Set(), seats: null, pressure: null, failOps: new Map() };
  w.config = { folders: [], archived: [], mainSession: { colId: 'captain', tasks: [], pending: [], inflight: [], waitlist: [], gen: 1, cmd: '' }, concurrencyCap: 5, activeClaudeSeatId: 'default' };
  w.columns = [{ id: 'captain', isMain: true, cmd: '' }];
  w.boot = () => boot(w);
  return w;
}
// (Re)start the app over the same disk: tasks directory, and config.json as it was written.
function boot(w, persisted) {
  if (persisted) { w.config = JSON.parse(persisted); w.columns = w.config.columns.map((c) => c); }
  w.config.columns = w.columns;
  const sent = [], toasts = [];
  const store = new TaskStore(w.dir, { sessions: () => localSessions(w.config) });
  let reviewCb = () => {}, reworkCb = () => {};
  const entries = new Map([['captain', { alive: true, state: 'done', lastScreen: '' }]]);
  const window = {
    deck: {
      onTaskStart() {}, onTaskReview(cb) { reviewCb = cb; }, onTaskRework(cb) { reworkCb = cb; },
      taskBoard(op, input) {
        return Promise.resolve().then(() => {
          const fail = w.failOps.get(op); if (fail > 0) { w.failOps.set(op, fail - 1); throw new Error('board busy: ' + op); }
          const result = store[op](input);
          if (op === 'list') w.afterList?.();
          return result;
        });
      },
      claudeSeats: async () => w.seatInfos || [],
      trustWorktree: async (input) => { (w.trusts ||= []).push(input); return w.trustResult || { ok: true }; },
      memoryPressure: async () => ({ level: w.pressure }), saveLongPrompt: async () => '/tmp/long-task.txt', onTasksChanged() {},
    },
    MainCore: M, BoardCore: B, AutoVerifyCore: AV, ClaudeSeatsCore: require('../claude-seats-core'),
    QuotaCore: {
      claudeSeats: () => w.seats || [{ id: 'default', name: 'Claude', configDir: '~/.claude' }],
      // The passive reading `quota` shows, as the choosers ask it (QuotaCore.commandStance): a command prefix or a
      // Claude seat can be out, and a prefix can have only an old or missing reading (unknown).
      commandStance: (_store, cmd, _seats, seatId) => {
        if (/^claude/.test(String(cmd)) && w.seatOut.has(seatId)) return 'out';
        if ([...w.out].some((p) => String(cmd).startsWith(p))) return 'out';
        return [...w.stale].some((p) => String(cmd).startsWith(p)) ? 'unknown' : 'ok';
      },
      // heldOnly: the ordinary open/queue decision says out while the passive reading the choosers use still said room (it changed in between)
      commandQuota: (_store, cmd) => ({ out: [...w.out, ...w.heldOnly].some((p) => String(cmd).startsWith(p)) }),
      // Same out-set as commandQuota. This harness does not model same-tier switches.
      quotaFallback: (_store, cmd) => {
        const out = [...w.out, ...w.heldOnly].some((p) => String(cmd).startsWith(p));
        return out
          ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' }
          : { action: 'open', cmd, note: '' };
      },
    },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {}, readFooter: () => null }, Sidebar: { render() {} },
  };
  // the real QuotaCore over a fake quota store: what `quota` itself would read
  if (w.realQuota) { window.QuotaCore = require('../quota-core'); w.config.quotas = w.quotaStore ||= {}; }
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = {
    config: w.config, platform: 'darwin', testInstance: !!w.testInstance, terms: entries, userComposing: () => false, columnLabel: (c) => c.displayTitle || c.title || c.id,
    saveConfig() {}, flushConfig() { w.flushes = (w.flushes || 0) + 1; }, showToast: (m) => toasts.push(m),
    columns: () => w.columns,
    createSession(meta) { const col = { ...meta, createdByRequestId: null };   // a Captain-made session is a 'manual' column: board-core drops this field
      w.columns.push(col); entries.set(col.id, { alive: true, state: 'done', lastScreen: '' }); return col; },
    restoreArchived(id) {
      const a = w.config.archived.find((x) => x.id === id); w.config.archived = w.config.archived.filter((x) => x !== a);
      const { archivedAt, ...rest } = a; const col = { ...rest }; w.columns.push(col); entries.set(col.id, { alive: true, state: 'done', lastScreen: '' }); return col;
    },
    sendWhenReady(col, text, opts) { sent.push({ col, text: typeof text === 'function' ? text() : text }); opts?.onSent?.({ id: 'turn-' + sent.length }); },
  };
  window.MainSession.init(host);
  const app = {
    w, store, window, host, sent, toasts, entries, api: window.MainSession, captain: w.columns[0], hb: null,
    // The main-process heartbeat, wired to the renderer exactly as main.js wires it.
    beat() {
      app.hb = new TaskHeartbeat(store, { onReview: (i) => { reviewCb(i); return false; }, onRework: (i) => { reworkCb(i); return false; } });
      return app.hb;
    },
    async scan() { (app.hb || app.beat()).scan(); await tick(); },
    persisted: () => JSON.stringify(w.config),
    card: (id) => store.list({ archived: true }).find((c) => c.id === id),
    notices: () => w.config.mainSession.pending.filter((p) => p.title === '任务看板').map((p) => p.summary),
    async execute(card, command = SONNET, id = 'exec-req') {
      await app.api.handle({ action: 'main-new', id, title: '执行 ' + card.title, task: '做这件事', boardId: card.id, project: card.project, command }, app.captain);
      await tick();
      return w.columns.find((c) => c.boardAttempt === id);
    },
    finish: (col, result, extra = {}) => app.api.submit({ action: 'complete', result, ...extra }, col),
    reviewers: (card) => w.columns.concat(w.config.archived).filter((c) => c.boardId === card.id && String(c.boardAttempt).startsWith(AV.REVIEW_PREFIX)),
    texts: (col) => sent.filter((s) => s.col.id === col.id).map((s) => s.text),
  };
  return app;
}
const newCard = async (app, extra = {}) => (await app.window.TaskBoard.add({ project: 'p', title: '修登录', detail: '把登录修好', verify: true, ...extra })).card;

test('automatic reviewers inherit only an unchanged explicitly authorized directory', async (t) => {
  for (const authorized of [true, false]) {
    const w = world(t), app = w.boot(), card = await newCard(app);
    const exec = await app.execute(card);
    exec.cwd = path.join(w.root, 'copy');
    exec.trustedCwd = authorized ? exec.cwd : path.join(w.root, 'previous-copy');
    await app.finish(exec, '执行完成');
    await app.scan();
    const review = app.reviewers(card)[0];
    assert.ok(review);
    assert.equal(review.cwd, exec.cwd);
    assert.equal(review.trustedCwd, authorized ? exec.cwd : undefined);
  }
});

async function manualReview(app, card, exec, id = 'manual-review') {
  await app.api.handle({ action: 'main-new', id, title: '重开审查', task: '独立审查', boardId: card.id, project: card.project, reviews: [exec.id], command: CODEX }, app.captain);
  await tick();
  return app.w.columns.find((c) => c.boardAttempt === id);
}

test('new --reviews on a reopened doing card binds its existing review round, passes to done and never reviews the reviewer', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '原执行全文。第二句', { files: ['/repo/a.js'] });
  app.store.move({ id: card.id, status: 'todo' }); app.store.move({ id: card.id, status: 'doing' });
  const receipt = app.card(card.id).exec_receipt;
  const review = await manualReview(app, card, exec);
  assert.equal(app.card(card.id).review_session, true);
  assert.equal(app.card(card.id).review_round, 1);
  await app.finish(review, '通过：已核对提交和测试');
  await app.scan(); await app.scan();
  assert.equal(app.card(card.id).status, 'done');
  assert.deepEqual(app.card(card.id).exec_receipt, receipt);
  assert.equal(app.card(card.id).consecutive_failures, 0);
  assert.equal(app.reviewers(card).length, 0);
});

test('manual reviewers return both rejection forms verbatim to the archived executor, exactly once', async (t) => {
  for (const failedFlag of [false, true]) {
    const w = world(t), app = w.boot(), card = await newCard(app);
    const exec = await app.execute(card); await app.finish(exec, '执行完成');
    w.config.archived.unshift({ ...exec, archivedAt: 1 }); w.columns.splice(w.columns.indexOf(exec), 1);
    const review = await manualReview(app, card, exec);
    const findings = '不通过：1) 缺少断言\n2) 提交没推送  （保留两个空格）';
    await app.finish(review, findings, failedFlag ? { failed: findings } : {});
    await app.finish(review, findings, failedFlag ? { failed: findings } : {});
    assert.equal(app.card(card.id).review_reject?.findings, findings);
    assert.equal(app.card(card.id).consecutive_failures, 1);
    for (let i = 0; i < 3; i++) await app.scan();
    const restored = w.columns.find((c) => c.id === exec.id);
    assert.ok(restored, 'restores the original archived executor');
    assert.ok(app.texts(restored).at(-1).endsWith(findings));
    assert.equal(app.texts(restored).length, 2);
    assert.equal(app.card(card.id).review_session, false);
    assert.equal(app.card(card.id).attempt_id, AV.reworkAttemptId(card.id, 1));
    assert.equal(app.card(card.id).flag, null);
    assert.equal(app.reviewers(card).length, 0);
  }
});

test('reopening a reviewer of the same execution round does not count a second rejection or hold the card', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '执行完成');
  const first = await manualReview(app, card, exec);
  await app.finish(first, '不通过：缺断言');
  const second = await manualReview(app, card, exec, 'manual-review-again');
  await app.finish(second, '不通过：同一版仍缺断言');
  assert.equal(app.card(card.id).consecutive_failures, 1);
  assert.equal(app.card(card.id).rework_count, 1);
  assert.notEqual(app.card(card.id).flag, 'held');
});

test('an explicit review after a Captain rejection does not double-count the rejected execution round', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '执行完成');
  app.store.move({ id: card.id, status: 'doing' });
  assert.equal(app.card(card.id).consecutive_failures, 1);
  const review = await manualReview(app, card, exec);
  await app.finish(review, '不通过：缺断言');
  assert.equal(app.card(card.id).consecutive_failures, 1);
  assert.equal(app.card(card.id).rework_count, 1);
  await app.scan();
  assert.equal(app.card(card.id).session_id, exec.id);
  assert.ok(app.texts(exec).at(-1).endsWith('不通过：缺断言'));
});

test('a reviewer process failure followed by its authoritative rejection counts the round only once', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '执行完成');
  const review = await manualReview(app, card, exec);
  await app.api.submit({ action: 'session-exit', code: 7 }, review);
  assert.equal(app.card(card.id).consecutive_failures, 1);
  await app.finish(review, '不通过：缺断言');
  assert.equal(app.card(card.id).consecutive_failures, 1);
  assert.equal(app.card(card.id).flag, 'failed');
  await app.scan();
  assert.equal(app.card(card.id).session_id, exec.id);
  assert.ok(app.texts(exec).at(-1).endsWith('不通过：缺断言'));
});

test('a reviewer quota stop does not suppress the first real rejection failure', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '执行完成');
  const review = await manualReview(app, card, exec);
  app.store.event({ id: card.id, session_id: review.id, attempt_id: review.boardAttempt, type: 'failed', source: 'quota', message: 'RESOURCE_EXHAUSTED' });
  assert.equal(app.card(card.id).consecutive_failures, 0);
  await app.finish(review, '不通过：缺断言');
  assert.equal(app.card(card.id).consecutive_failures, 1);
  await app.scan(); assert.equal(app.card(card.id).session_id, exec.id);
});

test('a legacy execution receipt can be reviewed, but an unrelated session cannot become this card executor', async (t) => {
  const w = world(t), app = w.boot(), card = await newCard(app, { verify: false });
  const exec = await app.execute(card); await app.finish(exec, '旧执行完整回执', { files: ['/repo/legacy.js'] });
  app.store.move({ id: card.id, status: 'doing' });
  const unrelated = await newCard(app, { title: '其他卡片' });
  await assert.rejects(manualReview(app, unrelated, exec), /原执行会话/);
  assert.equal(app.card(unrelated.id).session_id, null);
  const review = await manualReview(app, card, exec);
  assert.equal(app.card(card.id).exec_receipt.text, '旧执行完整回执');
  await app.finish(review, '不通过：旧版缺断言'); await app.scan();
  assert.equal(app.card(card.id).session_id, exec.id);
  assert.equal(app.card(card.id).attempt_id, AV.reworkAttemptId(card.id, 1));
  assert.equal(app.card(unrelated.id).session_id, null);
});

test('manual review verdict context survives restart, unclear blocks without a failure, and two actual rejected rounds still hold', async (t) => {
  const w = world(t); let app = w.boot(); const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '第一版');
  await manualReview(app, card, exec, 'unclear-review');
  app = w.boot(app.persisted());
  await app.finish(w.columns.find((c) => c.boardAttempt === 'unclear-review'), '看起来不错');
  assert.equal(app.card(card.id).status, 'review');
  assert.equal(app.card(card.id).review_block.round, 1);
  assert.equal(app.card(card.id).consecutive_failures, 0);
  await app.scan(); assert.equal(app.reviewers(card).length, 0);
  const r1 = await manualReview(app, card, exec, 'reject-round-1');
  await app.finish(r1, '不通过：第一版有错'); await app.scan();
  const restored = w.columns.find((c) => c.id === exec.id);
  await app.finish(restored, '第二版');
  const r2 = await manualReview(app, card, restored, 'reject-round-2');
  await app.finish(r2, '不通过：第二版仍有错');
  const before = app.texts(restored).length;
  await app.scan(); await app.scan();
  assert.equal(app.card(card.id).review_round, 2);
  assert.equal(app.card(card.id).consecutive_failures, 2);
  assert.equal(app.card(card.id).flag, 'held');
  assert.equal(app.texts(restored).length, before, 'held rounds never dispatch another rework');
});

test('a queued explicit reviewer retains its round across restart and cannot review a later execution', async (t) => {
  const w = world(t); let app = w.boot(); const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '第一版');
  w.pressure = 4;
  await manualReview(app, card, exec);
  assert.equal(w.config.mainSession.waitlist.length, 1);
  app = w.boot(app.persisted());
  app.store.move({ id: card.id, status: 'doing' });
  app.store.bind({ id: card.id, session_id: exec.id, attempt_id: 'later-execution', assignee: { agent: 'Claude', model: 'default' } });
  app.store.event({ id: card.id, session_id: exec.id, attempt_id: 'later-execution', type: 'complete', source: 'command', message: '第二版' });
  w.pressure = 1;
  app.api.onTick('captain', app.entries.get('captain')); await tick();
  assert.equal(w.columns.some((c) => c.boardAttempt === 'manual-review'), false);
  assert.equal(app.card(card.id).review_round, 2);
  assert.equal(app.card(card.id).exec_receipt.text, '第二版');
});

test('a verify card is reviewed automatically: right provider, full task, one session however often it is triggered', async (t) => {
  const w = world(t); let app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card);
  assert.ok(exec); assert.equal(app.card(card.id).status, 'doing');
  await app.finish(exec, '修好了。 第二句：登录校验已改，测试 a.test.js 通过。', { files: ['/repo/login.js', '/repo/notes.txt'] });
  assert.equal(app.card(card.id).status, 'review');
  await app.scan();
  const [reviewer, ...extra] = app.reviewers(card);
  assert.equal(extra.length, 0); assert.ok(reviewer);
  assert.match(reviewer.cmd, /^claude .*--model claude-sonnet-5-5 /, 'a simple card: a new Claude session, Sonnet 5.5, never another provider');
  assert.equal(reviewer.boardAttempt, AV.reviewAttemptId(card.id, 1)); assert.deepEqual([...reviewer.reviews], [exec.id]);
  assert.equal(reviewer.title, '审查：修登录（Claude Sonnet 5.5）', 'the title says what really runs');
  const [prompt] = app.texts(reviewer);
  for (const part of ['修登录', '把登录修好', '第二句：登录校验已改，测试 a.test.js 通过。', '/repo/login.js', '/repo/notes.txt', exec.id, '只审不改', '不跑全量 E2E']) assert.ok(prompt.includes(part), part);
  const bound = app.card(card.id);
  assert.equal(bound.session_id, reviewer.id); assert.equal(bound.review_session, true); assert.equal(bound.review_claim.delivered, true);
  assert.deepEqual(bound.assignee.agent, 'Claude'); assert.equal(bound.assignee.model, 'claude-sonnet-5-5'); assert.equal(bound.exec_receipt.assignee.model, 'claude-sonnet-5-5');
  assert.ok(w.flushes > 0, 'config flushed before the claim was marked delivered');
  // Heartbeat reruns, extra start events, a restart: still exactly one reviewer and one prompt.
  for (let i = 0; i < 3; i++) await app.scan();
  app = w.boot(app.persisted()); await app.scan(); await app.scan();
  assert.equal(app.reviewers(card).length, 1); assert.equal(app.sent.length, 0, 'the restarted app sent nothing new');
  // Passing it: done, and nothing else is opened.
  await app.finish(app.reviewers(card)[0], '通过：文件都在，测试我亲自跑过');
  assert.equal(app.card(card.id).status, 'done'); await app.scan();
  assert.equal(app.reviewers(card).length, 1);
});

test('a card without --verify behaves exactly as before: done, no reviewer, no new fields', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { verify: false });
  const exec = await app.execute(card);
  await app.finish(exec, '做完了'); await app.scan(); await app.scan();
  const done = app.card(card.id);
  assert.equal(done.status, 'done'); assert.equal(app.reviewers(card).length, 0);
  for (const key of ['review_round', 'exec_receipt', 'review_claim', 'review_block', 'review_reject']) assert.ok(!(key in done), key);
});

test('rejection goes back to the executor verbatim, an archived executor is restored first, and the next round gets its own reviewer; two failed rounds hold the card', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card);
  await app.finish(exec, '第一版做完', { files: ['/repo/a.js'] });
  await app.scan();
  const [r1] = app.reviewers(card);
  const findings = '不通过：\n1) /repo/a.js 第 3 行的断言被删了\n2) 提交 abc123 没有推送  （两个空格）';
  await app.finish(r1, 'x', { failed: findings });
  const rejected = app.card(card.id);
  assert.equal(rejected.status, 'doing'); assert.equal(rejected.flag, 'failed'); assert.equal(rejected.rework_count, 1);
  // The executor was archived meanwhile.
  w.config.archived.unshift({ ...exec, archivedAt: 1 }); w.columns.splice(w.columns.indexOf(exec), 1);
  await app.scan();
  const restored = w.columns.find((c) => c.id === exec.id); assert.ok(restored, 'archived executor restored');
  assert.equal(w.config.archived.some((c) => c.id === exec.id), false);
  const message = app.texts(restored).at(-1);
  assert.ok(message.endsWith(findings), 'the reviewer\'s words, unchanged'); assert.match(message, /验收没有通过/);
  const reworked = app.card(card.id);
  assert.equal(reworked.session_id, exec.id); assert.equal(reworked.review_session, false); assert.equal(reworked.attempt_id, AV.reworkAttemptId(card.id, 1)); assert.equal(reworked.review_reject.delivered, true);
  // more heartbeats do not repeat the rework
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(app.texts(restored).length, 2, 'original task + one rework message');
  // The executor's next receipt starts round 2 with a fresh reviewer.
  const sessionTask = w.config.mainSession.tasks.findLast((t) => t.colId === exec.id); assert.equal(sessionTask.boardAttempt, AV.reworkAttemptId(card.id, 1));
  await app.finish(restored, '返工完成', { files: ['/repo/a.js'] });
  assert.equal(app.card(card.id).review_round, 2); assert.equal(app.card(card.id).status, 'review');
  await app.scan();
  const all = app.reviewers(card); assert.equal(all.length, 2); const r2 = all.find((c) => c.boardAttempt === AV.reviewAttemptId(card.id, 2)); assert.ok(r2);
  await app.finish(r2, 'x', { failed: '不通过：断言还是被放宽了' });
  const held = app.card(card.id);
  assert.equal(held.flag, 'held'); assert.equal(held.rework_count, 2);
  assert.ok(app.notices().some((n) => /连续失败 2 次，已挂起/.test(n)));
  const before = app.texts(restored).length;
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(app.reviewers(card).length, 2, 'no third reviewer'); assert.equal(app.texts(restored).length, before, 'no third rework');
  assert.equal(held.status, 'doing'); assert.notEqual(app.card(card.id).status, 'done');
});

test('a rework waits out a confirmation prompt and is sent once, without being marked delivered early', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完'); await app.scan();
  await app.finish(app.reviewers(card)[0], 'x', { failed: '不通过：缺断言' });
  app.entries.get(exec.id).state = 'input';
  await app.scan(); await app.scan();
  assert.equal(app.texts(exec).length, 1, 'the prompt blocks the rework message');
  assert.equal(app.card(card.id).review_reject.delivered, false);
  assert.equal(app.card(card.id).flag, 'failed');
  assert.equal(app.card(card.id).attempt_id, AV.reviewAttemptId(card.id, 1), 'not rebound until the message can go in');
  app.entries.get(exec.id).state = 'done';
  await app.scan();
  assert.equal(app.texts(exec).length, 2);
  assert.ok(app.texts(exec).at(-1).includes('不通过：缺断言'));
  assert.equal(app.card(card.id).review_reject.delivered, true);
  assert.equal(app.card(card.id).attempt_id, AV.reworkAttemptId(card.id, 1));
  await app.scan();
  assert.equal(app.texts(exec).length, 2, 'a later heartbeat does not send it again');
});

test('a rejection whose executor session no longer exists goes to the Captain instead of being lost or retried', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完'); await app.scan();
  await app.finish(app.reviewers(card)[0], 'x', { failed: '不通过：缺文件' });
  w.columns.splice(w.columns.indexOf(exec), 1);   // closed for good, not even archived
  await app.scan(); await app.scan();
  assert.ok(app.notices().some((n) => n.includes('原执行会话') && n.includes('不通过：缺文件')));
  assert.equal(app.card(card.id).review_reject.delivered, true);
  assert.equal(app.notices().filter((n) => n.includes('原执行会话')).length, 1);
});

test('no acceptable reviewer: the card stays in review, says why, the Captain is told once, and nothing is opened — also after quota recovers or a restart', async (t) => {
  const w = world(t); let app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.out.add('claude');   // the executor has run; now every Claude seat is out
  await app.scan();
  let c = app.card(card.id);
  assert.equal(c.status, 'review'); assert.equal(app.reviewers(card).length, 0); assert.equal(c.review_block.round, 1);
  assert.match(c.review_block.reason, /额度用尽/); assert.match(c.review_block.reason, /Claude 各席位/);
  assert.equal(app.notices().filter((n) => n.includes('不能自动开审查会话')).length, 1);
  w.out.clear();
  for (let i = 0; i < 3; i++) await app.scan();
  app = w.boot(app.persisted()); await app.scan();
  assert.equal(app.reviewers(card).length, 0, 'not reviewed by itself, not skipped');
  assert.equal(app.card(card.id).status, 'review'); assert.equal(app.notices().filter((n) => n.includes('不能自动开审查会话')).length, 1);
  // the Captain opens the review by hand; the block clears
  await app.api.handle({ action: 'main-new', id: 'captain-review', title: '队长开的审查', task: '审查', boardId: card.id, project: 'p', command: CODEX }, app.captain);
  await tick();
  assert.equal(app.card(card.id).review_block, null); assert.equal(app.card(card.id).review_session, true);
});

test('the reviewer no longer depends on who made the executor: any executor gets a fresh Claude session', async (t) => {
  for (const command of ['node fake-agent.js --screen-only', CODEX, SONNET]) {
    const w = world(t); const app = w.boot();
    const card = await newCard(app);
    const exec = await app.execute(card, command); await app.finish(exec, '做完');
    await app.scan();
    const [reviewer, ...extra] = app.reviewers(card);
    assert.equal(extra.length, 0); assert.ok(reviewer, command);
    assert.match(reviewer.cmd, /^claude .*--model claude-sonnet-5-5 /); assert.equal(app.card(card.id).review_session, true);
    assert.notEqual(reviewer.id, exec.id, 'a separate session from the executor');
  }
});

// ---- who the automatic reviewer is, through the whole loop (fake quota state, no session starts a model) ----
test('Gemini out or with an old reading changes nothing: the reviewer is a fresh Claude session and its title names it, not the executor', async (t) => {
  for (const mode of ['out', 'stale']) {
    const w = world(t); const app = w.boot();
    const card = await newCard(app, { title: '修登录（Opus 5.5 high·066us）' });
    const exec = await app.execute(card); await app.finish(exec, '做完');
    (mode === 'out' ? w.out : w.stale).add('agy');
    await app.scan();
    const [reviewer, ...extra] = app.reviewers(card);
    assert.equal(extra.length, 0); assert.ok(reviewer, mode);
    assert.match(reviewer.cmd, /^claude .*--model claude-sonnet-5-5 /);
    assert.equal(reviewer.title, '审查：修登录（Claude Sonnet 5.5）', 'the title is the model that runs, not the executor\'s label on the card');
    assert.doesNotMatch(reviewer.displayTitle, /Opus|Gemini/);
    assert.equal(app.card(card.id).assignee.model, 'claude-sonnet-5-5');
  }
});
test('an important card is reviewed by Opus 5.5, and its title says Opus 5.5', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  await app.scan();
  const [reviewer] = app.reviewers(card);
  assert.match(reviewer.cmd, /^claude .*--model claude-opus-5-5 --effort high/);
  assert.equal(reviewer.title, '审查：修登录（Claude Opus 5.5）');
});
test('a Claude seat that is out is skipped: the reviewer opens on the first seat with room and carries that seat', async (t) => {
  const w = world(t);
  w.seats = [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }];
  w.config.activeClaudeSeatId = 'cn';
  const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.seatOut.add('cn');
  await app.scan();
  const [reviewer] = app.reviewers(card);
  assert.ok(reviewer); assert.equal(reviewer.claudeSeatId, 'us'); assert.equal(reviewer.claudeConfigDir, '~/.claude-us');
  // the active seat has room: nothing extra is attached, a new session defaults to it
  const w2 = world(t); w2.seats = w.seats; w2.config.activeClaudeSeatId = 'cn';
  const app2 = w2.boot(); const card2 = await newCard(app2);
  const exec2 = await app2.execute(card2); await app2.finish(exec2, '做完');
  await app2.scan();
  const [reviewer2] = app2.reviewers(card2);
  assert.ok(reviewer2); assert.equal(reviewer2.claudeSeatId, undefined);
});
test('every Claude seat out: the card stays in review with the reason and the Captain is told, not left waiting on a queue entry', async (t) => {
  const w = world(t);
  w.seats = [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }];
  w.config.activeClaudeSeatId = 'cn';
  const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.seatOut.add('cn'); w.seatOut.add('us');
  await app.scan();
  assert.equal(app.reviewers(card).length, 0); assert.equal(w.config.mainSession.waitlist.length, 0);
  assert.match(app.card(card.id).review_block.reason, /额度用尽/);
  assert.equal(app.notices().filter((n) => n.includes('不能自动开审查会话')).length, 1);
});
// The command the Captain is given to put another reviewer in: the model is in --command, and nothing `new` does not know.
const { splitPosix, flagsOfNew } = require('./fixtures/shell-words');
async function assertManualReviewCommand(app, notice, cardId, executorId, model, { run = true } = {}) {
  const line = /(node "\$AGENTDECK_BOARD_CLI" new .*)$/m.exec(notice);
  assert.ok(line, 'the notice carries a full new command: ' + notice);
  const { before, flags } = flagsOfNew(splitPosix(line[1]).words);
  assert.deepEqual(before, ['node', '$AGENTDECK_BOARD_CLI']);
  assert.equal(flags['task-id'], cardId); assert.equal(flags.reviews, executorId);
  assert.equal(flags.command, `claude --dangerously-skip-permissions --model ${model} --effort high`);
  assert.deepEqual(Object.keys(flags).filter((k) => !['task-id', 'project', 'title', 'task', 'reviews', 'command', 'seat'].includes(k)), [], 'new has no --model / --effort / --verify');
  assert.match(flags.title, new RegExp('^审查：.*（Claude ' + (model.includes('opus') ? 'Opus' : 'Sonnet') + ' 5\\.5）$'), 'the title names the model that runs');
  if (!run) return flags;
  // pasted into the Captain's terminal it must work: main-new takes it (no "already queued", no unknown flag)
  const result = await app.api.handle({ action: 'main-new', id: 'notice-cmd-' + Math.random().toString(36).slice(2), title: flags.title, task: flags.task, boardId: flags['task-id'], project: flags.project,
    reviews: flags.reviews.split(','), command: flags.command, ...(flags.seat ? { seatId: flags.seat } : {}) }, app.captain);
  await tick();
  assert.equal(result.done, true, JSON.stringify(result));
  return { flags, result };
}
test('interface work is always reviewed by Opus 5.5, even a small change a Sonnet made', async (t) => {
  const cases = [
    ['a screen file', { files: ['/repo/task-board-ui.js'], text: '改了一行' }, '修登录校验'],
    ['a style file', { files: ['/repo/style.css'], text: '改了颜色值' }, '小修'],
    ['a screenshot', { files: ['/repo/notes.md', '/tmp/shot.png'], text: '改完' }, '小修'],
    ['an interface word in the receipt', { files: ['/repo/a.js'], text: '侧栏的按钮对齐了' }, '小修'],
    ['an interface word in the title', { files: ['/repo/a.js'], text: '改完' }, '手机端布局小改'],
  ];
  for (const [name, receipt, title] of cases) {
    const w = world(t); const app = w.boot();
    const card = await newCard(app, { title, detail: '把它改好' });
    const exec = await app.execute(card); await app.finish(exec, receipt.text, { files: receipt.files });
    await app.scan();
    const [reviewer] = app.reviewers(card);
    assert.ok(reviewer, name);
    assert.match(reviewer.cmd, /--model claude-opus-5-5 /, name + ': Opus');
    assert.match(reviewer.title, /（Claude Opus 5\.5）$/, name);
  }
  // the same card with nothing interface-like stays simple
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { title: '修登录校验', detail: '把校验改好' });
  const exec = await app.execute(card); await app.finish(exec, '改完', { files: ['/repo/a.js'] });
  await app.scan();
  assert.match(app.reviewers(card)[0].cmd, /--model claude-sonnet-5-5 /);
});
test('a reviewer held back by quota after the pick (the reading changed) tells the Captain with the full command, model in --command', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.heldOnly.add('claude');   // the chooser saw room; the queue decision a moment later does not
  await app.scan();
  assert.equal(app.reviewers(card).length, 0); assert.equal(w.config.mainSession.waitlist.length, 1);
  const told = app.notices().filter((n) => n.includes('没能马上开'));
  assert.equal(told.length, 1);
  const { flags, result } = await assertManualReviewCommand(app, told[0], card.id, exec.id, 'claude-opus-5-5');
  // the command takes the waiting automatic review's place (it was refused as "already queued" before): still held by quota, so queued again
  assert.match(result.result, /已排队/); assert.equal(w.config.mainSession.waitlist.length, 1); assert.equal(w.config.mainSession.waitlist[0].metadata.autoReviewRound, undefined);
  w.heldOnly.clear();
  app.api.onTick('captain', app.entries.get('captain')); await tick();
  const [reviewer] = app.reviewers(card).concat(w.columns.filter((c) => c.boardId === card.id && c.reviews?.length && !String(c.boardAttempt).startsWith(AV.REVIEW_PREFIX)));
  assert.ok(reviewer, 'the replacing review opened when quota returned'); assert.equal(reviewer.title, flags.title); assert.match(reviewer.title, /（Claude Opus 5\.5）$/);
});
test('a reviewer that cannot start after all (quota, crash) tells the Captain at once how to put another in; its own written verdict is not that case', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  await app.scan();
  const [review] = app.reviewers(card);
  await app.api.submit({ action: 'session-exit', code: 7 }, review); await tick();
  const told = app.notices().filter((n) => n.includes('自动审查会话') && n.includes('没能跑起来'));
  assert.equal(told.length, 1);
  assert.ok(told[0].includes(card.id)); assert.match(told[0], /不用等它/);
  const { flags, result } = await assertManualReviewCommand(app, told[0], card.id, exec.id, 'claude-sonnet-5-5');
  assert.match(result.result, /已开新会话/); assert.ok(w.columns.some((c) => c.title === flags.title && /claude-sonnet-5-5/.test(c.cmd)), 'the command opened a Sonnet reviewer titled with the model');
  // a reviewer's own "不通过" is a finding, not a failure to start
  const w2 = world(t); const app2 = w2.boot();
  const card2 = await newCard(app2);
  const exec2 = await app2.execute(card2); await app2.finish(exec2, '做完'); await app2.scan();
  const [review2] = app2.reviewers(card2);
  await app2.finish(review2, '不通过：缺断言', { failed: '不通过：缺断言' });
  assert.equal(app2.notices().filter((n) => n.includes('没能跑起来')).length, 0);
});

test('a reviewer that cannot start yet waits in the ordinary queue (limit, memory, quota) and opens exactly once', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  // another session is working and the limit is 1
  M.MAX_ACTIVE = 1;
  w.columns.push({ id: 'busy', captainCrew: true, cmd: CODEX });
  w.config.mainSession.tasks.push({ id: 'k-busy', colId: 'busy', status: 'working', gen: 1 });
  await app.scan();
  assert.equal(app.reviewers(card).length, 0, 'no column yet');
  const waiting = w.config.mainSession.waitlist; assert.equal(waiting.length, 1);
  assert.equal(waiting[0].requestId, AV.reviewAttemptId(card.id, 1)); assert.equal(waiting[0].metadata.boardId, card.id);
  assert.equal(app.card(card.id).review_claim.delivered, true);
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(w.config.mainSession.waitlist.length, 1, 'the heartbeat never queues it again');
  // restart while it waits
  const again = w.boot(app.persisted()); await again.scan();
  assert.equal(w.config.mainSession.waitlist.length, 1);
  // memory pressure critical, slot free: still waiting
  w.config.mainSession.tasks.find((x) => x.colId === 'busy').status = 'done';
  w.pressure = 4;
  again.api.onTick('captain', again.entries.get('captain')); await tick();
  assert.equal(again.reviewers(card).length, 0); assert.equal(again.api.memoryHeld(), true);
  // pressure over but the reviewer's own quota is out: still waiting
  w.pressure = 1; w.out.add('claude');
  again.api.onTick('captain', again.entries.get('captain')); await tick();
  assert.equal(again.reviewers(card).length, 0);
  // everything clear: opens once, however many ticks follow
  w.out.clear();
  for (let i = 0; i < 4; i++) { again.api.onTick('captain', again.entries.get('captain')); await tick(); }
  assert.equal(again.reviewers(card).length, 1); assert.equal(w.config.mainSession.waitlist.length, 0);
  assert.equal(again.card(card.id).review_session, true);
  await again.scan(); assert.equal(again.reviewers(card).length, 1);
});

test('a queued reviewer is dropped if its round is no longer the open one', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  M.MAX_ACTIVE = 1; w.columns.push({ id: 'busy', captainCrew: true, cmd: CODEX }); w.config.mainSession.tasks.push({ id: 'k-busy', colId: 'busy', status: 'working', gen: 1 });
  await app.scan(); assert.equal(w.config.mainSession.waitlist.length, 1);
  app.store.move({ id: card.id, status: 'doing' });   // the Captain rejected it by hand meanwhile
  w.config.mainSession.tasks.find((x) => x.colId === 'busy').status = 'done';
  app.api.onTick('captain', app.entries.get('captain')); await tick();
  assert.equal(app.reviewers(card).length, 0); assert.equal(app.card(card.id).review_session, false);
  assert.equal(app.card(card.id).status, 'doing');
});

test('review admission rechecks a concurrent card move or manual queue request under the queue lock', async (t) => {
  for (const action of ['move', 'manual']) {
    const w = world(t), app = w.boot(), card = await newCard(app);
    const exec = await app.execute(card); await app.finish(exec, '做完');
    w.pressure = 4;
    let competing;
    w.afterList = () => {
      w.afterList = null;
      // The automatic reviewer has a snapshot, but the Captain gets the queue
      // lock before that reviewer can attempt admission.
      competing = action === 'move' ? app.window.TaskBoard.move(card.id, 'todo') : app.execute(card, CODEX, 'manual-review');
    };
    await app.scan(); await competing; await tick();
    assert.equal(app.reviewers(card).length, 0);
    if (action === 'move') {
      assert.equal(w.config.mainSession.waitlist.length, 0);
      assert.equal(app.card(card.id).status, 'todo');
    } else {
      assert.equal(w.config.mainSession.waitlist.length, 1);
      assert.equal(w.config.mainSession.waitlist[0].requestId, 'manual-review');
    }
  }
});

test('a Captain who already opened or queued a review keeps it: no automatic second reviewer', async (t) => {
  // bound reviewer
  let w = world(t); let app = w.boot();
  let card = await newCard(app);
  let exec = await app.execute(card); await app.finish(exec, '做完');
  await app.api.handle({ action: 'main-new', id: 'captain-review', title: '队长开的审查', task: '审查', boardId: card.id, project: 'p', command: CODEX }, app.captain);
  await tick(); await app.scan(); await app.scan();
  assert.equal(app.reviewers(card).length, 0); assert.equal(app.card(card.id).review_claim, undefined);
  // queued (not yet bound) review request from the Captain: the claim defers to it
  w = world(t); app = w.boot();
  card = await newCard(app, { title: '第二张' });
  exec = await app.execute(card); await app.finish(exec, '做完');
  M.MAX_ACTIVE = 1; w.columns.push({ id: 'busy', captainCrew: true, cmd: CODEX }); w.config.mainSession.tasks.push({ id: 'k-busy', colId: 'busy', status: 'working', gen: 1 });
  const queued = await app.api.handle({ action: 'main-new', id: 'captain-review-2', title: '队长排的审查', task: '审查', boardId: card.id, project: 'p', command: CODEX }, app.captain);
  assert.match(queued.result, /已排队/);
  await app.scan(); await app.scan();
  assert.equal(w.config.mainSession.waitlist.length, 1); assert.equal(w.config.mainSession.waitlist[0].requestId, 'captain-review-2');
  assert.equal(app.reviewers(card).length, 0);
  assert.equal(app.card(card.id).review_claim.delivered, true, 'claim consumed without opening anything');
});

test('a board write that fails after the reviewer was queued is retried without opening a second one', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.failOps.set('reviewDispatched', 1);
  await app.scan();
  assert.equal(app.reviewers(card).length, 1); assert.ok(app.toasts.some((m) => /自动验收/.test(m)));
  await app.scan(); await app.scan();
  assert.equal(app.reviewers(card).length, 1); assert.equal(app.card(card.id).review_claim.delivered, true);
  assert.equal(app.texts(app.reviewers(card)[0]).length, 1);
  // The same when the reviewer was only queued (limit reached): the retry finds the queue entry.
  const w2 = world(t); const app2 = w2.boot();
  const card2 = await newCard(app2);
  const exec2 = await app2.execute(card2); await app2.finish(exec2, '做完');
  M.MAX_ACTIVE = 1; w2.columns.push({ id: 'busy', captainCrew: true, cmd: CODEX }); w2.config.mainSession.tasks.push({ id: 'k-busy', colId: 'busy', status: 'working', gen: 1 });
  w2.failOps.set('reviewDispatched', 1);
  await app2.scan();
  assert.equal(w2.config.mainSession.waitlist.length, 1); assert.equal(app2.card(card2.id).review_claim.delivered, false);
  await app2.scan(); await app2.scan();
  assert.equal(w2.config.mainSession.waitlist.length, 1); assert.equal(app2.card(card2.id).review_claim.delivered, true);
});

test('a reviewer session that already exists for the round is recognised even when the card forgot its binding', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完'); await app.scan();
  assert.equal(app.reviewers(card).length, 1);
  app.store.mutate((docs) => { const c = app.store.find(docs, card.id); c.review_session = false; c.review_claim.delivered = false; return {}; });
  await app.scan(); await app.scan();
  assert.equal(app.reviewers(card).length, 1); assert.equal(app.card(card.id).review_claim.delivered, true);
});

test('a reviewer\'s start that keeps failing is handed to the Captain after three tries, not retried forever', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.failOps.set('bind', 99);
  for (let i = 0; i < 4; i++) await app.scan();
  assert.equal(app.reviewers(card).length, 0, 'bind failed before any session was created');
  const c = app.card(card.id);
  assert.equal(c.status, 'review'); assert.match(c.review_block.reason, /连续失败/);
  assert.equal(app.notices().filter((n) => n.includes('不能自动开审查会话')).length, 1);
});

test('the automatic switch defaults to on, is persisted for the main-process heartbeat, and keeps the dispatcher setting', async (t) => {
  const w = world(t); const app = w.boot();
  const TB = app.window.TaskBoard;
  assert.equal(TB.autoVerify(), true);
  TB.settings('captain');
  assert.equal(TB.autoVerify(false), false); assert.deepEqual({ ...w.config.taskBoard }, { dispatcher: 'captain', autoVerify: false }); assert.ok(w.flushes > 0);
  assert.deepEqual({ ...TB.settings() }, { dispatcher: 'captain' });
  assert.throws(() => TB.autoVerify('no'), /boolean/);
  assert.equal(TB.autoVerify(true), true); assert.equal(TB.settings('gemini').dispatcher, 'gemini'); assert.equal(w.config.taskBoard.autoVerify, true);
});

// ---- a second receipt from an executor who was told more ----
let tellSeq = 0;
const tellExec = (app, col, message = '补充：再把 README 也改了') => app.api.handle({ action: 'main-tell', id: 'tell-req-' + (++tellSeq), to: col.id, message }, app.captain);
test('one receipt opens exactly one reviewer; a supplement before the reviewer starts and a second receipt void that round and open a new one', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card);
  await app.finish(exec, '第一版做完', { files: ['/repo/a.js'] });
  assert.equal(app.card(card.id).review_round, 1);
  // The round is claimed but its reviewer has not started: the Captain sends the executor more work.
  const claim = app.store.claimReview({ id: card.id }); assert.equal(claim.card.review_claim.round, 1);
  await tellExec(app, exec); await tick();
  const told = app.card(card.id);
  assert.equal(told.session_id, exec.id, 'the executor is working on the card again');
  assert.equal(told.review_session, false, 'an executor is never taken for a reviewer');
  assert.notEqual(told.status, 'done');
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(app.reviewers(card).length, 0, 'the old round is void: no reviewer for the receipt that was replaced');
  await app.finish(exec, '补充做完', { files: ['/repo/a.js', '/repo/README.md'] });
  const second = app.card(card.id); assert.equal(second.status, 'review'); assert.equal(second.review_round, 2); assert.equal(second.exec_receipt.text, '补充做完');
  await app.scan();
  const [reviewer, ...extra] = app.reviewers(card);
  assert.equal(extra.length, 0); assert.equal(reviewer.boardAttempt, AV.reviewAttemptId(card.id, 2));
  assert.match(reviewer.cmd, /^claude .*claude-sonnet-5-5/, 'a fresh Claude session again');
  assert.ok(app.texts(reviewer)[0].includes('补充做完'));
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(app.reviewers(card).length, 1, 'still exactly one reviewer for round 2');
  await app.finish(reviewer, '通过：核对过'); assert.equal(app.card(card.id).status, 'done');
});

test('a receipt that arrives while the reviewer is working voids that review and opens a new round, though the old reviewer is still busy', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card);
  await app.finish(exec, '第一版做完', { files: ['/repo/a.js'] });
  await app.scan();
  const [r1] = app.reviewers(card); assert.equal(r1.boardAttempt, AV.reviewAttemptId(card.id, 1));
  assert.equal(app.card(card.id).session_id, r1.id);
  // the old reviewer is still working
  w.config.mainSession.tasks.push({ id: 'rt', colId: r1.id, status: 'working', boardId: card.id, boardAttempt: r1.boardAttempt });
  await tellExec(app, exec); await tick();
  await app.finish(exec, '补充做完', { files: ['/repo/a.js', '/repo/README.md'] });
  const second = app.card(card.id);
  assert.equal(second.status, 'review'); assert.equal(second.review_round, 2); assert.equal(second.exec_receipt.text, '补充做完');
  assert.equal(second.exec_receipt.session_id, exec.id); assert.equal(second.exec_receipt.assignee.agent, 'Claude', 'the executor, not the old reviewer, is who made the receipt');
  // the voided reviewer's verdict changes nothing
  await app.finish(r1, 'x', { failed: '不通过：旧结论' });
  assert.equal(app.card(card.id).status, 'review'); assert.equal(app.card(card.id).rework_count, 0); assert.ok(!app.card(card.id).review_reject);
  await app.scan(); await app.scan();
  const reviewers = app.reviewers(card);
  assert.equal(reviewers.length, 2); const r2 = reviewers.find((c) => c.boardAttempt === AV.reviewAttemptId(card.id, 2)); assert.ok(r2, 'round 2 has its own reviewer');
  assert.match(r2.cmd, /^claude .*claude-sonnet-5-5/);
  assert.equal(app.card(card.id).session_id, r2.id);
  await app.scan(); assert.equal(app.reviewers(card).length, 2);
});

test('after a supplement the two-failure hold still applies: the third round\'s rejection holds the card, a held card opens nothing', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card);
  await app.finish(exec, '第一版', { files: ['/repo/a.js'] }); await app.scan();
  const [r1] = app.reviewers(card);
  await app.finish(r1, 'x', { failed: '不通过：第一轮' });
  await app.scan();   // rework goes back to the executor
  assert.equal(app.card(card.id).rework_count, 1);
  await app.finish(exec, '返工完成', { files: ['/repo/a.js'] }); await app.scan();
  assert.equal(app.card(card.id).review_round, 2);
  const r2 = app.reviewers(card).find((c) => c.boardAttempt === AV.reviewAttemptId(card.id, 2)); assert.ok(r2);
  // supplement + receipt while round 2 is being reviewed
  await tellExec(app, exec); await tick();
  await app.finish(exec, '补充完成', { files: ['/repo/a.js'] });
  assert.equal(app.card(card.id).review_round, 3); assert.equal(app.card(card.id).consecutive_failures, 1, 'the earlier failure still counts');
  await app.scan();
  const r3 = app.reviewers(card).find((c) => c.boardAttempt === AV.reviewAttemptId(card.id, 3)); assert.ok(r3);
  await app.finish(r3, 'x', { failed: '不通过：第三轮' });
  const held = app.card(card.id); assert.equal(held.flag, 'held');
  const count = app.reviewers(card).length;
  await app.finish(exec, '再来一次', { files: [] });
  for (let i = 0; i < 3; i++) await app.scan();
  assert.equal(app.reviewers(card).length, count, 'held: no further automatic review');
  assert.equal(app.card(card.id).flag, 'held');
});

// ---- a test instance (--test-user-data) never lets the auto reviewer start a real model ----
test('in a test instance the auto reviewer refuses a real claude and says why; a stand-in command runs as usual', async (t) => {
  const w = world(t); w.testInstance = true;
  const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card, 'node fake-agent.js --screen-only'); await app.finish(exec, '做完');
  await app.scan();
  assert.equal(app.reviewers(card).length, 0, 'the real claude candidate is not opened');
  assert.match(app.card(card.id).review_block.reason, /测试实例里自动审查只许开替身命令，不开真的 claude/);
  assert.equal(w.config.mainSession.waitlist.length, 0);
  assert.equal(app.notices().filter((n) => n.includes('不能自动开审查会话')).length, 1);
  // a stand-in candidate table (what the E2E specs swap in) opens
  const saved = AV.CANDIDATES.slice();
  try {
    AV.CANDIDATES.splice(0, AV.CANDIDATES.length, { id: 'stand-in', label: '替身审查员', family: 'x', command: 'node fake-agent.js --reviewer' });
    const w2 = world(t); w2.testInstance = true; const app2 = w2.boot();
    const card2 = await newCard(app2);
    const exec2 = await app2.execute(card2, 'node fake-agent.js --screen-only'); await app2.finish(exec2, '做完');
    await app2.scan();
    const [reviewer] = app2.reviewers(card2);
    assert.ok(reviewer); assert.equal(reviewer.cmd, 'node fake-agent.js --reviewer'); assert.equal(reviewer.title, '审查：修登录（替身审查员）');
  } finally { AV.CANDIDATES.splice(0, AV.CANDIDATES.length, ...saved); }
  // outside a test instance the same real command is fine
  const w3 = world(t); const app3 = w3.boot();
  const card3 = await newCard(app3);
  const exec3 = await app3.execute(card3); await app3.finish(exec3, '做完'); await app3.scan();
  assert.match(app3.reviewers(card3)[0].cmd, /^claude /);
});

// ---- round three: seats read the way `quota` reads them, a copy trusted for the reviewing seat, a card that cannot be read ----
const Q = require('../quota-core');
const SEAT_DIRS = { cn: '~/.claude', us: '~/.claude-us', us2: '~/.claude-us2' };
function realWorld(t, ids = ['cn', 'us'], active = ids[0]) {
  const w = world(t); w.realQuota = true;
  w.config.claudeSeats = ids.map((id) => ({ id, name: id.toUpperCase(), configDir: SEAT_DIRS[id] }));
  w.config.activeClaudeSeatId = active;
  w.seatInfos = ids.map((id) => ({ id, loggedIn: true }));
  return w;
}
// an official reading for one seat: what is left of the 5-hour and weekly windows, `ageMin` minutes old
function reading(w, id, five, week, ageMin = 0, extra = {}) {
  const at = Date.now() - ageMin * 60000;
  Q.observe(w.quotaStore ||= {}, { ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: five, resetText: new Date(Date.now() + 2 * 3600000).toISOString() }, { key: 'weekly', remaining: week, resetText: new Date(Date.now() + 3 * 86400000).toISOString() }] }, at),
  seatId: id, configDir: SEAT_DIRS[id], accountBound: true, accountKey: id + '-account', credentialKey: id + '-cred', ...extra }, Date.now());
}
test('low Claude quota: the automatic reviewer and the Captain\'s own Claude review still open on Claude, never swapped to Cursor; out waits', async (t) => {
  const w = realWorld(t, ['cn']); const app = w.boot();
  const card = await newCard(app, { important: true }), card2 = await newCard(app, { important: true }), card3 = await newCard(app, { important: true });
  const exec = await app.execute(card, SONNET, 'exec-1'), exec2 = await app.execute(card2, SONNET, 'exec-2'), exec3 = await app.execute(card3, SONNET, 'exec-3');
  assert.ok(exec && exec2 && exec3);
  await app.finish(exec, '做完'); await app.finish(exec2, '做完'); await app.finish(exec3, '做完');
  reading(w, 'cn', 12, 60);   // 5 hours: 12% left, under the 20% line the ordinary same-tier switch acts on
  assert.equal(Q.quotaFallback(w.quotaStore, AV.CANDIDATES[0].command, w.config.claudeSeats, 'cn', Date.now()).action, 'switch', 'the ordinary new would switch this command to Cursor');
  // the Captain's own review with a named Claude command: low opens as well (no explicit "hold at low", no switch)
  const manual = await app.api.handle({ action: 'main-new', id: 'manual-low', title: '手动审查', task: '审查', boardId: card2.id, project: 'p', reviews: [exec2.id], command: AV.CANDIDATES[0].command }, app.captain);
  assert.match(manual.result, /已开新会话/); assert.ok(!/换成/.test(manual.result));
  assert.match(w.columns.find((c) => c.boardAttempt === 'manual-low').cmd, /^claude .*claude-opus-5-5/);
  // out: the Captain's own review waits for the quota (still on Claude)
  reading(w, 'cn', 0, 60);
  const waiting = await app.api.handle({ action: 'main-new', id: 'manual-out', title: '手动审查', task: '审查', boardId: card3.id, project: 'p', reviews: [exec3.id], command: AV.CANDIDATES[0].command }, app.captain);
  assert.match(waiting.result, /已排队/); assert.equal(w.columns.some((c) => c.boardAttempt === 'manual-out'), false);
  assert.match(w.config.mainSession.waitlist.at(-1).cmd, /^claude /);
  // the automatic reviewer of the first card, with the account low again
  reading(w, 'cn', 12, 60);
  await app.scan();
  // it waits its turn behind the Captain's own request that waits for the same quota, and opens on the next turns
  for (let i = 0; i < 3; i++) { app.api.onTick('captain', app.entries.get('captain')); await tick(); }
  const [reviewer] = app.reviewers(card);
  assert.ok(reviewer); assert.match(reviewer.cmd, /^claude --dangerously-skip-permissions --model claude-opus-5-5 /);
  assert.doesNotMatch(reviewer.title, /换成|cursor/i); assert.match(reviewer.title, /（Claude Opus 5\.5）$/);
  assert.equal(app.notices().filter((n) => /换成|Cursor/.test(n)).length, 0);
  assert.equal(w.columns.filter((c) => /cursor/i.test(c.cmd || '')).length, 0, 'nothing was opened on Cursor');
});
test('a seat with a damaged credential reads as error and is never the unverified fallback, though its numbers are old', async (t) => {
  const w = realWorld(t, ['cn', 'us'], 'us'); const app = w.boot();
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  // both readings are 40 minutes old (an official reading counts for 30): unknown. us (the active one, tried first) has a damaged credential file.
  reading(w, 'cn', 80, 80, 40); reading(w, 'us', 80, 80, 40);
  w.seatInfos = [{ id: 'cn', loggedIn: true }, { id: 'us', loggedIn: true, credential: { state: 'invalid', bytes: 5, store: 'file' } }];
  await app.scan();
  const [reviewer] = app.reviewers(card);
  assert.ok(reviewer, 'the other seat, unverified, is the last resort'); assert.equal(reviewer.claudeSeatId, 'cn');
  // every seat damaged: nobody, the Captain is told
  const w2 = realWorld(t, ['cn', 'us'], 'cn'); const app2 = w2.boot();
  const card2 = await newCard(app2, { important: true });
  const exec2 = await app2.execute(card2); await app2.finish(exec2, '做完');
  reading(w2, 'cn', 80, 80, 40); reading(w2, 'us', 80, 80, 40);
  w2.seatInfos = [{ id: 'cn', loggedIn: true, credential: { state: 'expired', bytes: 300, store: 'file' } }, { id: 'us', loggedIn: true, credential: { state: 'no-oauth', bytes: 20, store: 'keychain' } }];
  await app2.scan();
  assert.equal(app2.reviewers(card2).length, 0); assert.match(app2.card(card2.id).review_block.reason, /登录或额度查询出错/);
});
// A seat goes by its account in what the Captain reads (the user's rule of 2026-10-08): the part of the e-mail before the @,
// no flag, no CN / US / US2; a directory whose login nobody knows yet reads 识别中 (not 未登录: that says it is signed out),
// and two that read the same carry a number. `--seat us` stays in commands. The seat codes are matched as whole words, so
// an account such as bob.us is not mistaken for a seat name.
const SEAT_CODE = /\b(?:CN|US2?)\b/;
// the lowercase ids (`cn`, `us`, `us2`, as in `--seat us`) are seat names too; bob.us and us2@ are accounts, not seat names
const SEAT_ID = /(?<![\w.])(?:cn|us2?)(?![\w.@])/;
test('the lowercase seat-id pattern catches a seat id and leaves account names alone', () => {
  for (const bad of ['（us）：额度用尽', '席位 cn', '--seat us2 重派', '(cn, us)']) assert.match(bad, SEAT_ID, bad);
  for (const ok of ['（bob.us）：额度用尽', '（alice）', 'status 其余', 'bus', 'us2@example.com', 'v1.cn', '识别中 1']) assert.doesNotMatch(ok, SEAT_ID, ok);
});
test('every seat out: the review reason, review_block and the notice to the Captain name the accounts, not CN / US or a flag', async (t) => {
  const w = realWorld(t, ['cn', 'us'], 'cn'); const app = w.boot();
  w.seatInfos = [{ id: 'cn', loggedIn: true, loginEmail: 'alice@example.com' }, { id: 'us', loggedIn: true, loginEmail: 'bob.us@example.com' }];
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  reading(w, 'cn', 0, 60); reading(w, 'us', 0, 60);
  await app.scan();
  assert.equal(app.reviewers(card).length, 0);
  const reason = app.card(card.id).review_block.reason;
  assert.match(reason, /Claude Opus 5\.5（alice）：额度用尽/); assert.match(reason, /Claude Opus 5\.5（bob\.us）：额度用尽/);
  const notice = app.notices().find((n) => n.includes('不能自动开审查会话'));
  assert.ok(notice && notice.includes('alice'));
  for (const text of [reason, notice]) { assert.doesNotMatch(text, /\p{Regional_Indicator}/u); assert.doesNotMatch(text, SEAT_CODE); assert.doesNotMatch(text, SEAT_ID); }
});
test('a seat directory whose login is not known yet reads 识别中, not 未登录, and two of them are told apart by a number', async (t) => {
  const w = realWorld(t, ['cn', 'us'], 'cn'); const app = w.boot();
  w.seatInfos = [];   // the seat list could not be read and no account is remembered for either directory
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  reading(w, 'cn', 0, 60); reading(w, 'us', 0, 60);
  await app.scan();
  const reason = app.card(card.id).review_block.reason;
  assert.match(reason, /Claude Opus 5\.5（识别中 1）：额度用尽/); assert.match(reason, /Claude Opus 5\.5（识别中 2）：额度用尽/);
  assert.doesNotMatch(reason, /未登录/);
  assert.doesNotMatch(reason, /\p{Regional_Indicator}/u); assert.doesNotMatch(reason, SEAT_CODE); assert.doesNotMatch(reason, SEAT_ID);
});
test('the numbers follow the seat settings: a signed-out seat that reads the same still takes its place in the order', async (t) => {
  const w = realWorld(t, ['cn', 'us', 'us2'], 'cn'); const app = w.boot();
  // cn is signed out (its directory still remembers carol), us and us2 are two directories signed in to the same account
  w.seatInfos = [{ id: 'cn', loggedIn: false, loginEmail: 'carol@example.com' }, { id: 'us', loggedIn: true, loginEmail: 'carol@example.com' }, { id: 'us2', loggedIn: true, loginEmail: 'carol@example.com' }];
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  reading(w, 'us', 0, 60); reading(w, 'us2', 0, 60);
  await app.scan();
  const reason = app.card(card.id).review_block.reason;
  // settings order cn, us, us2: the signed-out cn is carol 1, so the two that were tried are carol 2 and carol 3
  assert.match(reason, /Claude Opus 5\.5（carol 2）：额度用尽/); assert.match(reason, /Claude Opus 5\.5（carol 3）：额度用尽/);
  assert.doesNotMatch(reason, /carol 1/);
  assert.doesNotMatch(reason, SEAT_CODE); assert.doesNotMatch(reason, SEAT_ID);
});
test('a seat choice carries no hover text: the full address never travels with it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main-session.js'), 'utf8');
  const body = source.slice(source.indexOf('function seatChoices('), source.indexOf('async function claudeSeatChoices'));
  assert.ok(body.length > 100 && body.includes('return { id: seat.id, label'));
  assert.doesNotMatch(body.replace(/\/\/[^\n]*/g, ''), /\btitle\b|\bemail\b/i);
});
test('one seat unknown and one known: only the repeated reading gets a number', async (t) => {
  const w = realWorld(t, ['cn', 'us'], 'cn'); const app = w.boot();
  w.seatInfos = [{ id: 'us', loggedIn: true, loginEmail: 'bob.us@example.com' }];   // nothing is known about the cn directory
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  reading(w, 'cn', 0, 60); reading(w, 'us', 0, 60);
  await app.scan();
  const reason = app.card(card.id).review_block.reason;
  assert.match(reason, /Claude Opus 5\.5（识别中）：额度用尽/); assert.match(reason, /Claude Opus 5\.5（bob\.us）：额度用尽/);
  assert.doesNotMatch(reason, SEAT_CODE); assert.doesNotMatch(reason, SEAT_ID);
});
test('no signed-in Claude seat at all: nobody is picked and the reason says so (the default seat is not brought back)', async (t) => {
  const w = realWorld(t, ['cn', 'us'], 'cn'); const app = w.boot();
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  w.seatInfos = [{ id: 'cn', loggedIn: false }, { id: 'us', loggedIn: false }];
  await app.scan();
  assert.equal(app.reviewers(card).length, 0); assert.match(app.card(card.id).review_block.reason, /没有已登录的 Claude 席位/);
});
test('the copy the executor worked in is trusted for the seat that reviews it, before the session opens', async (t) => {
  const w = world(t);
  w.seats = [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us2', name: 'US2', configDir: '~/.claude-us2' }];
  w.config.activeClaudeSeatId = 'cn';
  const app = w.boot();
  const card = await newCard(app, { important: true });
  const exec = await app.execute(card);
  exec.cwd = path.join(w.root, 'copy'); exec.trustedCwd = exec.cwd; exec.claudeSeatId = 'us2';   // a copy made for the executor's own seat
  await app.finish(exec, '做完');
  await app.scan();
  const [reviewer] = app.reviewers(card);
  assert.ok(reviewer); assert.equal(reviewer.claudeSeatId, undefined, 'the reviewer takes the active seat cn');
  assert.deepEqual((w.trusts || []).map((x) => [x.seatId, x.configDir, x.path]), [['cn', '~/.claude', exec.cwd]]);
  // a seat other than the active one is trusted as itself
  const w2 = world(t); w2.seats = w.seats; w2.config.activeClaudeSeatId = 'cn'; const app2 = w2.boot();
  const card2 = await newCard(app2, { important: true });
  const exec2 = await app2.execute(card2); exec2.cwd = path.join(w2.root, 'copy'); exec2.trustedCwd = exec2.cwd; await app2.finish(exec2, '做完');
  w2.seatOut.add('cn');
  await app2.scan();
  assert.equal(app2.reviewers(card2)[0].claudeSeatId, 'us2'); assert.deepEqual((w2.trusts || []).map((x) => x.seatId), ['us2']);
  // not a copy the app authorized: nothing is recorded
  const w3 = world(t); const app3 = w3.boot();
  const card3 = await newCard(app3, { important: true });
  const exec3 = await app3.execute(card3); await app3.finish(exec3, '做完'); await app3.scan();
  assert.equal((w3.trusts || []).length, 0);
  // a trust that could not be recorded is said, the review still opens
  const w4 = world(t); w4.trustResult = { ok: false, reason: '席位配置文件读不了' }; const app4 = w4.boot();
  const card4 = await newCard(app4, { important: true });
  const exec4 = await app4.execute(card4); exec4.cwd = path.join(w4.root, 'copy'); exec4.trustedCwd = exec4.cwd; await app4.finish(exec4, '做完'); await app4.scan();
  assert.equal(app4.reviewers(card4).length, 1); assert.ok(app4.notices().some((n) => n.includes('没能预先登记 Claude 的文件夹信任') && n.includes('席位配置文件读不了')));
});
test('a card that cannot be read when a review fails to start: the command is for Opus and the title is the card\'s own', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { title: '修登录（Opus 5.5 high·066us）' });
  const exec = await app.execute(card); await app.finish(exec, '做完');
  await app.scan();
  const [review] = app.reviewers(card);
  assert.match(review.title, /（Claude Sonnet 5\.5）$/, 'the simple card was given to Sonnet');
  w.failOps.set('list', 1);   // the board cannot be read for the notice
  await app.api.submit({ action: 'session-exit', code: 7 }, review); await tick();
  const told = app.notices().filter((n) => n.includes('没能跑起来'));
  assert.equal(told.length, 1);
  const flags = await assertManualReviewCommand(app, told[0], card.id, exec.id, 'claude-opus-5-5', { run: false });
  assert.equal(flags.title, '审查：修登录（Claude Opus 5.5）', 'not 审查：审查：…, and no guess that it is simple');
});
