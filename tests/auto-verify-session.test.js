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
  const w = { root, dir: path.join(root, 'tasks'), out: new Set(), pressure: null, failOps: new Map() };
  w.config = { folders: [], archived: [], mainSession: { colId: 'captain', tasks: [], pending: [], inflight: [], waitlist: [], gen: 1, cmd: '' }, concurrencyCap: 5 };
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
      memoryPressure: async () => ({ level: w.pressure }), saveLongPrompt: async () => '/tmp/long-task.txt', onTasksChanged() {},
    },
    MainCore: M, BoardCore: B, AutoVerifyCore: AV,
    QuotaCore: {
      commandQuota: (_store, cmd) => ({ out: [...w.out].some((p) => String(cmd).startsWith(p)) }),
      // Same out-set as commandQuota. This harness does not model same-tier switches.
      quotaFallback: (_store, cmd) => {
        const out = [...w.out].some((p) => String(cmd).startsWith(p));
        return out
          ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' }
          : { action: 'open', cmd, note: '' };
      },
    },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {}, readFooter: () => null }, Sidebar: { render() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = {
    config: w.config, platform: 'darwin', terms: entries, userComposing: () => false, columnLabel: (c) => c.displayTitle || c.title || c.id,
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
  await app.finish(exec, '修好了。 第二句：登录页已改，测试 a.test.js 通过。', { files: ['/repo/login.js', '/repo/shot.png'] });
  assert.equal(app.card(card.id).status, 'review');
  await app.scan();
  const [reviewer, ...extra] = app.reviewers(card);
  assert.equal(extra.length, 0); assert.ok(reviewer);
  assert.match(reviewer.cmd, /^agy .*gemini-3\.8-flash-high/, 'Claude executor → Gemini reviewer, from the dispatcher table');
  assert.equal(reviewer.boardAttempt, AV.reviewAttemptId(card.id, 1)); assert.deepEqual([...reviewer.reviews], [exec.id]);
  assert.equal(reviewer.title, '审查：修登录');
  const [prompt] = app.texts(reviewer);
  for (const part of ['修登录', '把登录修好', '第二句：登录页已改，测试 a.test.js 通过。', '/repo/login.js', '/repo/shot.png', exec.id, '只审不改', '不跑全量 E2E']) assert.ok(prompt.includes(part), part);
  const bound = app.card(card.id);
  assert.equal(bound.session_id, reviewer.id); assert.equal(bound.review_session, true); assert.equal(bound.review_claim.delivered, true);
  assert.deepEqual(bound.assignee.agent, 'Antigravity'); assert.equal(bound.exec_receipt.assignee.model, 'claude-sonnet-5-5');
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
  w.out.add('agy'); w.out.add('codex');
  const card = await newCard(app);
  const exec = await app.execute(card); await app.finish(exec, '做完');
  await app.scan();
  let c = app.card(card.id);
  assert.equal(c.status, 'review'); assert.equal(app.reviewers(card).length, 0); assert.equal(c.review_block.round, 1);
  assert.match(c.review_block.reason, /额度用尽/); assert.match(c.review_block.reason, /同属 Anthropic/);
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

test('an executor of unknown make is never reviewed by a guess', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const exec = await app.execute(card, 'node fake-agent.js --screen-only'); await app.finish(exec, '做完');
  await app.scan();
  assert.equal(app.reviewers(card).length, 0); assert.match(app.card(card.id).review_block.reason, /看不出执行会话/);
  assert.equal(app.card(card.id).status, 'review');
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
  w.pressure = 1; w.out.add('agy');
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
