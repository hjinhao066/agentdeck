'use strict';
// Real renderer session state + real disk board. Only the terminal delivery and
// renderer timers are controlled, so receipts and late callbacks are deterministic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const R = require('../restart-resume');
const { TaskStore } = require('../task-board');
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

function world(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const col = { id: 'worker', captainCrew: true, cmd: 'codex', boardId: 'card', boardAttempt: 'attempt', role: 'manual', ...extra.col };
  const task = { id: 'task', colId: col.id, gen: 1, status: 'working', title: '修复登录', boardId: 'card', boardAttempt: 'attempt', startedAt: 1, ...extra.task };
  const w = { root, col, config: { resumeOnRestart: true, columns: [col], archived: [], mainSession: { colId: 'captain', gen: 1, tasks: [task], pending: [], inflight: [], waitlist: [] } }, manifest: { version: 1, claims: {}, entries: [] } };
  w.store = new TaskStore(path.join(root, 'tasks'), { sessions: () => w.config.columns });
  w.store.add({ id: 'card', project: 'fixture', title: '修复登录', detail: extra.detail || '完整卡片任务' });
  w.store.bind({ id: 'card', session_id: col.id, attempt_id: 'attempt', assignee: { agent: 'Codex', model: 'fake' } });
  w.store.event({ id: 'card', session_id: col.id, attempt_id: 'attempt', type: 'started' });
  w.boot = () => boot(w);
  return w;
}

function boot(w) {
  const sends = [], toasts = [], timers = [], restarts = [], alarms = [], resolved = [], barks = [];
  const app = { w, sends, toasts, timers, restarts, alarms, resolved, barks, blockedList: null, now: Date.now() };
  const window = {
    MainCore: M, RestartResume: R,
    ChatUI: { updateCard() {}, addCard() {}, turnsOf: () => [], readFooter: () => null },
    // 待我处理 (sidebar and phone) and the urgent phone push, as the restart watch uses them.
    AttentionUI: { alarm(item) { alarms.push(item); return { id: 'at-alarm-' + alarms.length }; }, resolveAlarm(id, note) { resolved.push({ id, note }); } },
    deck: {
      restartAlarm: async (message, key) => { barks.push({ message, key }); return { ok: true }; },
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      restartManifestLoad: () => w.manifest,
      restartManifestSave(doc) { w.manifest = JSON.parse(JSON.stringify(doc)); return true; },
      saveConfigSync: () => true,
      taskBoard: async (op, input) => op === 'list' && app.blockedList ? app.blockedList : w.store[op](input),
    },
  };
  const context = vm.createContext({ window, document: {}, console, Date: class extends Date { static now() { return app.now; } }, setTimeout(fn, ms) { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cancelled = true; } });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8').replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, loadResumeManifest, flushResume, dispatch, pendingInstruction, startup(id) { startupBrief = id; briefing = id; } };\n  window.MainSession = {');
  vm.runInContext(source, context);
  const host = {
    config: w.config, columns: () => w.config.columns,
    terms: new Map(w.config.columns.map((c) => [c.id, { alive: true, state: 'done', lastScreen: '' }])),
    columnLabel: (c) => c.id, saveConfig() {}, flushConfig() {}, showToast: (m) => toasts.push(m),
    isBackstage: () => false, dumpScreen: (term) => term.lastScreen || '',
    sendWhenReady(col, text, opts) { sends.push({ col, text, opts }); },
    restartWorker(col) { restarts.push(col.id); delete col.modelSessionId; col.restartMode = 'resend'; window.MainSession.noteColdColumn(col, true); return true; },
  };
  window.__test.setHost(host);
  window.__test.loadResumeManifest();
  Object.assign(app, { host, api: window.MainSession, internals: window.__test });
  app.task = () => w.config.mainSession.tasks.at(-1);
  app.col = () => w.config.columns[0];
  app.card = () => w.store.list({ archived: true })[0];
  app.resume = async (fresh = false) => { app.api.noteColdColumn(app.col(), fresh); app.internals.flushResume(); await tick(); };
  app.deliver = async (send = sends.at(-1)) => {
    assert.ok(send, 'a delivery was scheduled');
    send.deliveredText = typeof send.text === 'function' ? send.text() : send.text;
    send.opts.onSent?.({ id: 'turn-' + sends.indexOf(send) });
    await tick();
    return send.deliveredText;
  };
  app.persist = () => { w.config = JSON.parse(JSON.stringify(w.config)); return w.boot(); };
  return app;
}

test('every restart resumes the same unfinished task once, even after a sent claim', async (t) => {
  const w = world(t); let app = w.boot();
  await app.resume(); await app.deliver();
  assert.equal(app.sends.length, 1);
  await app.resume(); assert.equal(app.sends.length, 1, 'repeated cold-column notification in one run is deduplicated');
  app.api.parkForRestart(); app = app.persist();
  await app.resume(); await app.deliver();
  assert.equal(app.sends.length, 1, 'a second application run sends again');
  assert.equal(app.task().status, 'working');
  assert.equal(app.task().id, 'task');
});

for (const phase of ['sent', 'failed', 'armed', 'retrying']) test('a previous run ' + phase + ' claim cannot suppress a newer task in the same column', async (t) => {
  const w = world(t);
  w.manifest.claims.worker = { phase, taskId: 'older-task', runId: 'previous-run' };
  const app = w.boot(); await app.resume(); await app.deliver();
  assert.equal(app.sends.length, 1);
  assert.equal(w.manifest.claims.worker.taskId, 'task');
});

test('unsent dispatch bodies survive a crash without truncation or losing the newest supplement', async (t) => {
  const w = world(t, { task: { status: 'done' } }); const app = w.boot();
  const body = '前半段'.repeat(1800) + '\nUNIQUE UNSENT END';
  app.internals.dispatch(app.col(), body, '补充任务');
  app.internals.dispatch(app.col(), 'SECOND UNSENT BODY', '第二条');
  const pending = app.internals.pendingInstruction('worker');
  assert.ok(pending.includes(body)); assert.ok(pending.endsWith('SECOND UNSENT BODY'));
  assert.ok(w.config.mainSession.tasks.at(-2).instruction.includes(body), 'dispatch persists the full body in config before any exit hook');
  assert.ok(w.manifest.entries.some((e) => e.pendingText.includes(body)), 'manifest already contains the body for an abrupt exit');
  const crash = app.persist(); await crash.resume();
  const crashText = await crash.deliver();
  assert.ok(crashText.includes(body)); assert.ok(crashText.includes('SECOND UNSENT BODY'));
});

test('parking captures queued supplement text before changing its task to paused', async (t) => {
  const w = world(t, { task: { status: 'done' } }); const app = w.boot();
  const body = '完整补充任务'.repeat(1100) + '\nUNIQUE UNSENT END';
  app.internals.dispatch(app.col(), body, '补充任务');
  app.internals.dispatch(app.col(), 'SECOND UNSENT BODY', '第二条');
  app.api.parkForRestart();
  const entry = w.manifest.entries.find((e) => e.colId === 'worker');
  assert.ok(entry.pendingText.includes(body)); assert.ok(entry.pendingText.endsWith('SECOND UNSENT BODY'));
  const again = app.persist(); await again.resume();
  const text = await again.deliver();
  assert.ok(text.includes(body)); assert.ok(text.includes('SECOND UNSENT BODY'));
});

test('a sent supplementary instruction is retained alongside card detail on the next fresh resend', async (t) => {
  const w = world(t, { task: { status: 'done' } }); const app = w.boot();
  const body = '已送达的补充正文'.repeat(700) + ' SENT SUPPLEMENT END';
  app.internals.dispatch(app.col(), body, '已经送达的补充任务'); await app.deliver();
  assert.equal(app.internals.pendingInstruction('worker'), '');
  app.api.parkForRestart();
  const again = app.persist(); await again.resume(); const text = await again.deliver();
  assert.ok(text.includes('完整卡片任务')); assert.ok(text.includes(body), 'the card detail must not replace the last dispatched instruction');
});

for (const action of ['complete', 'ask', 'progress']) test('a restored unsent task binds its ' + action + ' receipt', async (t) => {
  const w = world(t, { task: { status: 'queued', startedAt: 0, instruction: 'queued original instruction' } });
  const app = w.boot(); await app.resume(); await app.deliver();
  assert.ok(app.task().startedAt); assert.ok(app.task().turnId);
  const message = action === 'complete' ? { action, result: '全部完成' } : action === 'ask' ? { action, question: '选哪一种？' } : { action, message: '正在验证' };
  const result = await app.api.submit(message, app.col());
  assert.ok(result?.done);
  if (action === 'progress') { assert.equal(app.task().progress, '正在验证'); assert.equal(app.task().status, 'working'); }
  else {
    assert.equal(app.task().status, action === 'complete' ? 'done' : 'asking');
    assert.equal(w.config.mainSession.pending.at(-1).taskId, 'task');
    assert.equal(app.card().status, action === 'complete' ? 'done' : 'needs_user');
  }
});

test('restoring a supplement supersedes an earlier task and receipts bind the latest delivery', async (t) => {
  const w = world(t);
  w.config.mainSession.tasks.unshift({ id: 'older-task', colId: 'worker', gen: 1, status: 'working', startedAt: 1 });
  Object.assign(w.config.mainSession.tasks.at(-1), { status: 'queued', startedAt: 0, instruction: 'new supplement' });
  const app = w.boot(); await app.resume(); await app.deliver();
  assert.equal(w.config.mainSession.tasks[0].status, 'done');
  await app.api.submit({ action: 'complete', result: '最新任务完成' }, app.col());
  assert.equal(app.task().receipt.summary, '最新任务完成');
  assert.equal(w.config.mainSession.pending.at(-1).taskId, 'task');
});

test('a completion during asynchronous card loading cancels resume delivery', async (t) => {
  const w = world(t); const app = w.boot();
  let releaseList;
  app.blockedList = new Promise((resolve) => { releaseList = resolve; });
  await app.resume(); assert.equal(app.sends.length, 0);
  await app.api.submit({ action: 'complete', result: 'CLI 已经完成旧任务' }, app.col());
  releaseList(w.store.list({ archived: true })); await tick();
  assert.equal(app.sends.length, 0);
  assert.equal(app.task().status, 'done'); assert.equal(app.card().status, 'done'); assert.equal(app.card().attempt_closed, true);
});

test('a late delivery callback cannot revive a task after its completion receipt', async (t) => {
  const w = world(t); const app = w.boot(); await app.resume();
  const waiting = app.sends[0]; assert.ok(waiting);
  await app.api.submit({ action: 'complete', result: 'CLI 已提交完成' }, app.col());
  assert.equal(waiting.opts.cancelled(), true, 'delivery loop must stop before typing');
  await app.deliver(waiting);
  assert.equal(app.task().status, 'done'); assert.equal(app.task().receipt.summary, 'CLI 已提交完成');
  assert.equal(app.card().status, 'done'); assert.equal(app.card().attempt_closed, true);
});

test('fresh columns and ordinary archive restores do not enter application restart delivery', async (t) => {
  const w = world(t); const app = w.boot();
  await app.resume(true); assert.equal(app.sends.length, 0, 'fresh spawn is ordinary dispatch');
  const restored = { id: 'restored', captainCrew: true, cmd: 'codex' };
  w.config.columns.push(restored);
  w.config.mainSession.tasks.push({ id: 'restored-task', colId: restored.id, gen: 1, status: 'queued' });
  app.host.terms.set(restored.id, { alive: true, state: 'done' });
  app.api.noteColdColumn(restored, false); app.internals.flushResume(); await tick();
  assert.equal(app.sends.length, 0, 'a task introduced after startup is not a cold-start task');
});

for (const reason of ['exit', 'timeout', 'slot-timeout']) test('failed true resume (' + reason + ') opens a fresh worker and resends the full task and last receipt once', async (t) => {
  const body = '原始任务正文'.repeat(1100) + ' ORIGINAL TASK END';
  const receipt = '上次进度'.repeat(180) + ' LAST RECEIPT END';
  const w = world(t, { detail: body, col: { restartMode: 'resume', modelSessionId: '01234567-89ab-cdef-0123-456789abcdef' }, task: { receipt: { summary: receipt, explicit: true, source: 'command' } } });
  const app = w.boot(); await app.resume();
  assert.ok(app.sends[0]);
  if (reason.startsWith('exit')) await app.api.submit({ action: 'session-exit', code: 1 }, app.col());
  else if (reason === 'slot-timeout') app.timers.find((timer) => timer.ms === 45000 && !timer.cancelled).fn();
  else app.sends[0].opts.onGiveUp();
  await tick(); app.internals.flushResume(); await tick();
  assert.deepEqual(app.restarts, ['worker']); assert.equal(app.col().restartMode, 'resend'); assert.equal(app.col().modelSessionId, undefined);
  const text = await app.deliver();
  assert.ok(text.includes(body), 'entire card task survives fallback'); assert.ok(text.includes(receipt), 'entire last receipt survives fallback');
  assert.equal(app.task().status, 'working'); assert.equal(app.card().status, 'doing');
});

for (const mode of ['resume', 'resend']) for (const failure of ['command-exit', 'terminal-exit', 'quota']) {
  test('delivered ' + mode + ' treats subsequent ' + failure + ' as ordinary task failure', async (t) => {
    const w = world(t, { col: { restartMode: mode } }); const app = w.boot();
    await app.resume(); await app.deliver();
    assert.equal(app.task().restartHold, undefined);
    assert.equal(app.task().resumeDeadline, undefined);
    if (failure === 'command-exit') await app.api.submit({ action: 'session-exit', code: 7 }, app.col());
    else {
      app.now += 4 * 60 * 60 * 1000;
      const entry = app.host.terms.get('worker');
      if (failure === 'terminal-exit') Object.assign(entry, { alive: false, exitReason: 'ordinary task crashed' });
      else entry.state = 'quota';
      app.api.onTick('worker', entry);
      await tick();
    }
    assert.deepEqual(app.restarts, []);
    assert.equal(app.task().status, 'failed');
    assert.equal(app.task().receipt.source, failure === 'quota' ? 'quota' : 'process');
    assert.ok(!app.task().receipt.failed.includes('续接'));
    assert.equal(w.config.mainSession.pending.at(-1).source, app.task().receipt.source);
    assert.equal(w.manifest.claims.worker.phase, 'sent');
    app.sends[0].opts.onGiveUp(); await tick();
    assert.deepEqual(app.restarts, [], 'late delivery failure callbacks cannot retry a delivered task');
  });
}

for (const alive of [false, true]) test('startup and batch wait expire after 30 seconds (terminal alive: ' + alive + ')', async (t) => {
  const w = world(t); const app = w.boot();
  if (alive) {
    for (const id of ['busy-1', 'busy-2']) {
      const col = { id, captainCrew: true, cmd: 'codex' };
      w.config.columns.push(col);
      w.config.mainSession.tasks.push({ id: id + '-task', colId: id, gen: 1, status: 'working' });
      app.host.terms.set(id, { alive: true });
    }
    app.internals.loadResumeManifest();
    for (const col of w.config.columns.slice(1)) app.api.noteColdColumn(col, false);
    app.internals.flushResume(); await tick();
  } else app.host.terms.get('worker').alive = false;
  app.api.noteColdColumn(w.col, false); app.internals.flushResume(); await tick();
  assert.equal(w.config.mainSession.tasks[0].restartHold, true);
  assert.equal(app.sends.some((s) => s.col.id === 'worker'), false);
  app.now += 30001;
  app.internals.flushResume(); await tick();
  const task = w.config.mainSession.tasks[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.receipt.source, 'resume');
  assert.ok(task.receipt.failed.includes('30 秒'));
  assert.ok(w.config.mainSession.pending.some((p) => p.taskId === 'task' && p.failed.includes('30 秒')));
});

for (const [change, reason] of [
  [{ archived: true }, '卡片已归档'], [{ attempt_closed: true }, '本轮任务已关闭'],
  [{ status: 'done' }, '卡片已完成'], [{ status: 'review', review_session: false }, '待验收'],
  [{ session_id: 'other-worker' }, '转交会话 other-worker'], [{ attempt_id: 'other-attempt' }, '另一轮任务'],
]) test('closed or reassigned card reports a stopped continuation: ' + reason, async (t) => {
  const w = world(t); const app = w.boot();
  app.blockedList = Promise.resolve([{ ...app.card(), ...change }]);
  await app.resume();
  assert.equal(app.sends.length, 0);
  assert.equal(app.task().status, 'stopped');
  assert.equal(app.task().restartHold, undefined);
  assert.ok(app.task().receipt.summary.includes(reason));
  assert.ok(app.task().receipt.summary.includes('卡片 card 核验处'));
  assert.equal(w.config.mainSession.pending.filter((p) => p.taskId === 'task').length, 1);
  assert.equal(app.card().status, 'doing', 'the stale task must not mutate the board');
  await app.resume();
  assert.equal(w.config.mainSession.pending.filter((p) => p.taskId === 'task').length, 1);
  const reboot = app.persist(); await reboot.resume();
  assert.equal(reboot.sends.length, 0, 'the stale task remains closed after another restart');
});

test('failure to deliver the fresh fallback notifies the captain and stops retrying', async (t) => {
  const w = world(t, { col: { restartMode: 'resume' } }); const app = w.boot();
  await app.resume(); app.sends[0].opts.onGiveUp(); await tick();
  app.internals.flushResume(); await tick();
  assert.equal(app.sends.length, 2);
  app.sends[1].opts.onGiveUp(); await tick();
  assert.deepEqual(app.restarts, ['worker'], 'the fallback is attempted once');
  assert.equal(app.task().status, 'failed'); assert.ok(app.toasts.some((m) => /续接失败/.test(m)));
  assert.ok(w.config.mainSession.pending.some((p) => p.taskId === 'task' && /续接失败/.test(p.failed)));
});


test('restart identity requires the column owner and cwd, and rejects duplicate UUIDs regardless of case', (t) => {
  const id = 'abcdefab-1234-4123-8123-abcdefabcdef';
  const w = world(t, { col: { cmd: 'claude', cwd: '/repo', modelSessionId: id, modelSessionOwner: 'worker', modelSessionCwd: '/repo' } });
  const app = w.boot(); const col = app.col();
  assert.equal(app.api.restartLaunch(col, false).mode, 'resume');
  delete col.modelSessionOwner;
  assert.equal(app.api.restartLaunch(col, false).mode, 'resend');
  col.modelSessionOwner = col.id; col.modelSessionCwd = '/other';
  assert.equal(app.api.restartLaunch(col, false).mode, 'resend');
  col.modelSessionCwd = '/repo';
  w.config.columns.push({ id: 'other', cmd: 'claude', modelSessionId: id.toUpperCase() });
  assert.equal(app.api.restartLaunch(col, false).mode, 'resend');
});

for (const [cmd, provider] of [['codex', 'Codex'], ['cursor-agent', 'Cursor'], ['agy', 'Antigravity']]) {
  test(provider + ' authenticated progress captures the owned id for crash and clean restart', async (t) => {
    const id = 'abcdefab-1234-4123-8123-abcdefabcdef';
    const w = world(t, { col: { cmd, cwd: '/repo' } }); const app = w.boot();
    await app.api.submit({ action: 'progress', message: '已完成一半', modelSessionIds: { [provider]: id } }, app.col());
    assert.equal(app.col().modelSessionId, id);
    assert.equal(app.col().modelSessionSource, 'agent-env');
    const crashed = app.persist();
    assert.equal(crashed.api.restartLaunch(crashed.col(), false).mode, 'resume');
    crashed.api.parkForRestart({ worker: null });
    assert.equal(crashed.col().modelSessionId, id, 'stale shutdown disk metadata cannot erase newer authenticated proof');
    const parked = crashed.persist();
    assert.equal(parked.api.restartLaunch(parked.col(), false).mode, 'resume');
  });
}

test('the latest question replaces earlier progress in the restart snapshot', async (t) => {
  const w = world(t); const app = w.boot();
  await app.api.submit({ action: 'progress', message: 'EARLIER PROGRESS' }, app.col());
  await app.api.submit({ action: 'ask', question: 'LATEST QUESTION' }, app.col());
  app.api.parkForRestart();
  assert.equal(w.manifest.entries[0].receipt, 'LATEST QUESTION');
});

test('parking awaits a best-effort checkpoint delivery with an independent 800ms bound', async (t) => {
  const w = world(t); const app = w.boot();
  let finished = false;
  const parked = app.api.parkForRestart().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  const send = app.sends.at(-1);
  assert.ok(send.text.includes('AgentDeck 即将重启'));
  assert.equal(send.opts.timeout, 800);
  assert.ok(app.task().receipt.summary.includes('尚未确认'));
  app.timers.find((timer) => timer.ms === 800).fn();
  await parked; assert.equal(finished, true, 'even an agent which never becomes ready cannot hold shutdown');
});


test('a worker already archived before startup is restored only by ordinary dispatch', async (t) => {
  const w = world(t, { task: { status: 'paused' } });
  const archived = w.config.columns.pop(); w.config.archived.push(archived);
  const app = w.boot();
  w.config.columns.push(archived); w.config.archived = [];
  assert.equal(app.api.restartLaunch(archived, false).mode, 'leave');
  app.api.noteColdColumn(archived, false); app.internals.flushResume(); await tick();
  assert.equal(app.sends.length, 0);
  app.internals.dispatch(archived, 'ordinary restore instruction', 'restore');
  await app.deliver();
  assert.equal(app.sends.length, 1);
  assert.equal(app.sends[0].deliveredText, 'ordinary restore instruction');
});

test('a crew column with no task record (respawned under a new id, or its old records pruned) reopens plainly instead of throwing', async (t) => {
  const w = world(t);
  w.config.mainSession.tasks = [];
  const app = w.boot();
  // respawnColumn and restartWorker pass isFresh; a restore or app restart does not
  assert.equal(app.api.restartLaunch(w.col, true).mode, 'leave');
  w.col.modelSessionId = '11111111-1111-4111-8111-111111111111'; w.col.modelSessionOwner = w.col.id; w.col.modelSessionCwd = '';
  assert.equal(app.api.restartLaunch(w.col, false).mode, 'leave');
});


// 10-09 12:10: told to stop at a safe point before the 2.0.3 install, this session wrote its progress and ended
// the turn. Three minutes later the no-receipt fallback closed the task (已结束，未提交回执) and at 12:15 the quit
// did not park it, so the restart never continued it (ledger: 未开始) until the Captain woke it by hand at 16:12.
test('a crew task closed by the no-receipt fallback after its safe-point progress is parked silently and continued after the restart', async (t) => {
  const w = world(t, { task: { status: 'stopped', doneAt: 5, progress: '停在安全点：修复已推送 00e23a3，下一步写在 progress.md',
    receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } } });
  w.config.mainSession.pending.push({ taskId: 'task', colId: 'worker', title: '修复登录', ts: 5, summary: '已结束，未提交回执', files: [], failed: '', source: 'fallback' });
  let app = w.boot();
  await app.api.parkForRestart();
  assert.equal(app.sends.length, 0, 'nothing is typed into a session that has already stopped');
  assert.equal(app.task().status, 'paused');
  assert.equal(app.task().receipt.checkpoint, true);
  assert.deepEqual(w.config.mainSession.pending.filter((p) => p.taskId === 'task'), [], 'its 已结束 notice is no longer what happened');
  app = app.persist();
  await app.resume();
  const text = await app.deliver();
  assert.match(text, /AgentDeck 刚重启/);
  assert.match(text, /停在安全点：修复已推送 00e23a3/, 'its own progress is the last receipt');
  assert.doesNotMatch(text, /最后回执：已结束，未提交回执/);
  assert.equal(app.task().status, 'working');
});

// A restarted app with a Captain in the deck. Its restart notice is "sent" when typed into the terminal; the
// Captain is back only when it works or runs a command after that.
function withCaptain(t, extra = {}) {
  const w = world(t, extra);
  w.config.columns.unshift({ id: 'captain', isMain: true, title: '队长', cmd: 'claude --dangerously-skip-permissions --effort high', role: 'manual' });
  const app = w.boot();
  // What the Captain's own heartbeat asks of the page; nothing here is typed anywhere.
  Object.assign(app.host, { userComposing: () => false, agentInForeground: async () => false, captainColumnVisible: () => false });
  app.cap = () => w.config.columns.find((c) => c.id === 'captain');
  app.tickAll = async (ms) => {
    app.now += ms;
    for (const [id, entry] of app.host.terms) app.api.onTick(id, entry);
    await tick();
  };
  return app;
}

// 10-09 12:15:27: the restart notice went into the Captain's terminal while its Claude was still starting; the
// Enter was lost, the text sat in the input box, and nobody knew until the user pressed Enter at 16:12:33.
test('a Captain not back at work a minute after the restart is reported once on 待我处理, the phone and Bark, and ticked off when it is back', async (t) => {
  const app = withCaptain(t, { task: { status: 'done', receipt: { summary: '做完了', files: [], failed: '', explicit: true, source: 'command' } } });
  app.internals.startup('captain');
  app.api.noteColdColumn(app.cap(), false, true);
  const notice = app.sends.find((s) => s.col.id === 'captain');
  assert.ok(notice, 'the restart notice is on its way');
  await app.deliver(notice);
  await app.tickAll(30_000);
  assert.equal(app.alarms.length, 0);
  await app.tickAll(31_000);
  assert.equal(app.alarms.length, 1, 'one minute after the start the Captain has done nothing');
  assert.match(app.alarms[0].title, /队长/);
  assert.equal(app.alarms[0].session, 'captain');
  assert.equal(app.barks.length, 1, 'an urgent phone push');
  assert.match(app.barks[0].message, /队长/);
  await app.tickAll(120_000);
  assert.equal(app.alarms.length, 1, 'reported once');
  assert.equal(app.barks.length, 1);
  app.host.terms.get('captain').state = 'working';
  await app.tickAll(1500);
  assert.deepEqual(app.resolved.map((r) => r.id), ['at-alarm-1'], 'its item is ticked off once the Captain works');
});

test('a Captain that starts working on its notice is never reported', async (t) => {
  const app = withCaptain(t, { task: { status: 'done', receipt: { summary: '做完了', files: [], failed: '', explicit: true, source: 'command' } } });
  app.internals.startup('captain');
  app.api.noteColdColumn(app.cap(), false, true);
  await app.deliver(app.sends.find((s) => s.col.id === 'captain'));
  await app.tickAll(3000);
  app.host.terms.get('captain').state = 'working';
  await app.tickAll(1500);
  await app.tickAll(10 * 60_000);
  assert.equal(app.alarms.length, 0);
  assert.equal(app.barks.length, 0);
});

test('a crew session whose continue message went in but that never started is reported; one that works is not', async (t) => {
  const w = world(t, { col: { cmd: 'claude' } });
  const app = w.boot();
  app.tickAll = async (ms) => {
    app.now += ms;
    for (const [id, entry] of app.host.terms) app.api.onTick(id, entry);
    await tick();
  };
  const other = { id: 'worker-2', captainCrew: true, cmd: 'claude', role: 'manual' };
  app.w.config.columns.push(other);
  app.w.config.mainSession.tasks.push({ id: 'task-2', colId: 'worker-2', gen: 1, status: 'working', title: '写文档', startedAt: 1 });
  app.host.terms.set('worker-2', { alive: true, state: 'done', lastScreen: '' });
  app.internals.loadResumeManifest();
  app.api.noteColdColumn(app.col(), false); app.api.noteColdColumn(other, false);
  app.internals.flushResume(); await tick();
  for (const send of app.sends.filter((s) => s.col.captainCrew)) await app.deliver(send);
  app.host.terms.get('worker-2').state = 'working';
  await app.tickAll(1500);
  await app.tickAll(60_000);
  assert.equal(app.alarms.length, 0);
  await app.tickAll(31_000);
  assert.equal(app.alarms.length, 1);
  assert.match(app.alarms[0].title, /1 个队员/);
  assert.match(app.alarms[0].detail, /（worker）/);
  assert.doesNotMatch(app.alarms[0].detail, /worker-2/);
  assert.equal(app.barks.length, 1);
  assert.ok(w.config.mainSession.pending.some((p) => p.colId === 'worker' && p.source === 'restart-watch'), 'the 队长 hears it too and can wake it');
});

test('a 队长 replaced within the minute (a Relay, a cleared context) or one a Relay is still starting is not reported', async (t) => {
  for (const change of ['replaced', 'relay']) {
    const app = withCaptain(t, { task: { status: 'done', receipt: { summary: '做完了', files: [], failed: '', explicit: true, source: 'command' } } });
    app.internals.startup('captain');
    app.api.noteColdColumn(app.cap(), false, true);
    await app.deliver(app.sends.find((s) => s.col.id === 'captain'));
    if (change === 'replaced') app.w.config.mainSession.colId = 'captain-2';
    else app.w.config.mainSession.relayStartup = { attempt: { colId: 'captain', deadline: app.now + 180_000 }, failures: [], stopped: false };
    await app.tickAll(61_000);
    assert.equal(app.alarms.length, 0, change);
    assert.equal(app.barks.length, 0, change);
  }
});


// The quit did not park it (a force quit, a crash, or the version before this fix): a crew task closed by the
// fallback after its safe-point progress is still continued at the next start, its stale 已结束 notice dropped.
test('a crew task the fallback closed before a quit that did not park it is continued at the next start', async (t) => {
  const w = world(t, { task: { status: 'stopped', doneAt: 5, progress: '停在安全点：改动已推送，下一步写在 progress.md',
    receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } } });
  w.config.mainSession.pending.push({ taskId: 'task', colId: 'worker', title: '修复登录', ts: 5, summary: '已结束，未提交回执', files: [], failed: '', source: 'fallback' });
  const app = w.boot();
  await app.resume();
  assert.equal(app.sends.length, 1, 'its continue message is on its way');
  const text = await app.deliver();
  assert.match(text, /AgentDeck 刚重启/);
  assert.match(text, /停在安全点：改动已推送/, 'its own progress is the last receipt');
  assert.doesNotMatch(text, /最后回执：已结束，未提交回执/);
  assert.equal(app.task().status, 'working');
  assert.deepEqual(w.config.mainSession.pending.filter((p) => p.taskId === 'task' && p.source === 'fallback'), []);
});

// Merging at delivery takes in the column's unsent supplements, never an older task that ran and ended long ago.
test('a continue message does not relabel an older task of the same column that the fallback closed', async (t) => {
  const w = world(t);
  w.config.mainSession.tasks.unshift({ id: 'old', colId: 'worker', gen: 1, status: 'stopped', title: '更早的活', startedAt: 1, doneAt: 2, instructionSent: true,
    receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } });
  const app = w.boot();
  await app.resume(); await app.deliver();
  const old = w.config.mainSession.tasks.find((x) => x.id === 'old');
  assert.equal(old.status, 'stopped');
  assert.equal(old.receipt.source, 'fallback');
  assert.equal(app.task().status, 'working');
});

// 10-10 00:51 (2.0.6 install): the session that ran the install was closed with the app. Its install result was filed
// as its final receipt, so the restart saw a finished card and left it out of the continue list; the post-install
// check had no one until the Captain woke it by hand.
const captain = { id: 'captain', isMain: true, cmd: '' };
const installMessage = (extra = {}) => ({ action: 'main-install-result', result: 'AgentDeck 安装 2.0.6 成功；现在运行 2.0.6。',
  installResult: { id: 'install-206', taskId: 'task', columnId: 'worker', targetVersion: '2.0.6', status: 'success', ...extra } });
async function installer(t) {
  const w = world(t); let app = w.boot();
  await app.api.submit({ action: 'progress', message: '安装已启动，等核对', installId: 'install-206', targetVersion: '2.0.6' }, app.col());
  assert.equal(app.task().pendingInstall.id, 'install-206');
  return { w, app: app.persist() };   // the install ends the app: a new run, the same config
}

test('an installer session closed by its own install is continued after the restart, and the result does not close its card', async (t) => {
  const { w, app } = await installer(t);
  await app.resume();
  const text = await app.deliver();
  assert.match(text, /AgentDeck 刚重启/);
  assert.match(text, /2\.0\.6/);
  assert.match(text, /不要重新安装/);
  assert.equal(w.manifest.claims.worker.phase, 'sent');
  assert.equal(app.task().status, 'working');
  await app.api.handle(installMessage(), captain);
  await tick();
  assert.equal(app.task().status, 'working', 'the install result is not this session\'s final receipt');
  assert.equal(app.task().pendingInstall, undefined);
  assert.equal(app.task().installResultId, 'install-206');
  assert.notEqual(app.card().status, 'done');
  assert.notEqual(app.card().status, 'review');
  assert.equal(app.card().attempt_closed, false);
  assert.equal(w.config.mainSession.pending.filter((p) => p.taskId === 'task').length, 0);
  const seen = w.config.mainSession.pending.filter((p) => /安装 2\.0\.6 成功/.test(p.summary || ''));
  assert.equal(seen.length, 1, 'the Captain still sees the result, once');
  assert.equal(w.manifest.claims.worker.phase, 'sent');
});

test('an install result that lands before the continue message still reaches the session in it', async (t) => {
  const { w, app } = await installer(t);
  await app.api.handle(installMessage(), captain);
  await tick();
  await app.resume();
  const text = await app.deliver();
  assert.match(text, /安装 2\.0\.6 成功；现在运行 2\.0\.6/);
  assert.match(text, /不要重新安装/);
  assert.equal(app.task().status, 'working');
  assert.equal(app.task().installOutcome, undefined, 'said once, not repeated at a later restart');
  assert.equal(w.manifest.claims.worker.phase, 'sent');
});

test('a failed install leaves its session open too, with the failure in front of the Captain', async (t) => {
  const { w, app } = await installer(t);
  await app.resume(); await app.deliver();
  await app.api.handle({ ...installMessage({ status: 'failed', reason: '复制失败' }), result: 'AgentDeck 安装 2.0.6 失败；复制失败。' }, captain);
  await tick();
  assert.equal(app.task().status, 'working');
  assert.equal(w.config.mainSession.pending.filter((p) => /安装 2\.0\.6 失败/.test(p.summary || '')).length, 1);
});

test('a session with no install pending is continued exactly as before', async (t) => {
  const w = world(t); const app = w.boot();
  await app.resume();
  const text = await app.deliver();
  assert.doesNotMatch(text, /安装/);
});
