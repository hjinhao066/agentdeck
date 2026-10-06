'use strict';
// A quota failure receipt is provisional: Claude waits out the limit and carries on by itself
// ("Usage limit reset · continuing automatically"). 2026-10-06 01:55: two sessions had worked for
// 30 minutes while the ledger still showed 额度用尽, one was archived under it, and its saved
// chat could not be read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');
const { TaskStore } = require('../task-board');

const QUOTA = '⚠ Usage limit reached · limit resets';
const RESET = '⎿  Usage limit reset · continuing automatically\n✻ Cogitating… (12s · esc to interrupt)\n❯ \n  ⏵⏵ bypass permissions on';
const IDLE = '⏺ All done.\n❯ \n  ⏵⏵ bypass permissions on';
// a 360px column cuts the footer after the count: "still running" never shows
const NARROW_MONITOR = '✻ Sautéed for 6s · done 1:51 AM · 1\n  monitor still running\n\n❯ \n──────\n  Opus 5h 46%\n  ⏵⏵ bypass permissions on · 1 monitor ·';

function world({ cmd = 'claude', crew = false, archivedCrew = [] } = {}) {
  let now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd, captainCrew: crew };
  const columns = [captain, worker], archived = [], boardEvents = [], saved = new Map();
  const s = { colId: 'captain', gen: 3, tasks: [], pending: [], inflight: [], waitlist: [] };
  const entry = { alive: true, state: 'quota', lastOutputAt: now, lastScreen: QUOTA, term: { screen: QUOTA } };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    MainCore: M, BoardCore: B,
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {}, taskBoard: (op, input) => { if (op === 'event') boardEvents.push(input); return Promise.resolve(op === 'list' ? [] : { card: {}, notices: [] }); } },
    ChatUI: { hasDraft: () => false, updateCard() {}, turnsOf: (id) => saved.get(id) || [], captainArchives: () => [], sendPrompt: async () => true },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, setTimeout, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: s, archived: archivedCrew, folders: [] }, terms, columns: () => columns, saveConfig() {},
    isBackstage: (c) => !!c.captainCrew, focusedId: () => 'captain', lastTurnTs: () => now - 30 * 60_000,
    archiveColumn: (c) => { if (!archived.includes(c.id)) archived.push(c.id); }, columnLabel: (c) => c.title || c.id, userComposing: () => false,
    agentInForeground: async () => true, sendWhenReady() {}, dumpScreen: (term) => term.screen,
    // the page's own classifier: a spinner line is work, a prompt alone is not
    screenState: (text) => (/…\s*\(.*esc to interrupt/.test(text) ? 'working' : 'done'),
  });
  const api = window.MainSession;
  const screen = (state, text) => { if (state === 'working') entry.lastOutputAt = now; entry.state = state; entry.lastScreen = text; entry.term.screen = text; };
  const tick = () => api.onTick(worker.id, entry);
  return {
    api, s, worker, captain, entry, archived, boardEvents, saved, screen, tick,
    advance(ms) { now += ms; },
    // the task as the first tick of the quota screen settles it
    failedByQuota(extra = {}) {
      const t = { id: 'task-' + s.tasks.length, colId: worker.id, gen: 3, status: 'working', title: 'probe', startedAt: now, sentAt: now, instructionSent: true, ...extra };
      s.tasks.push(t); screen('quota', QUOTA); tick();
      assert.equal(t.status, 'failed'); assert.equal(t.receipt.source, 'quota');
      return t;
    },
  };
}

test('the footer cut short by a narrow column still counts as background work', () => {
  assert.equal(M.claudeBackgroundTasks(NARROW_MONITOR, 'claude'), true);
  assert.equal(M.claudeBackgroundTasks('❯ \n  ⏵⏵ bypass permissions on · 2 shells ·', 'claude'), true);
  assert.equal(M.claudeBackgroundTasks('❯ \n  ⏵⏵ bypass permissions on · 1 shell, 1 monitor', 'claude'), true);
  // unchanged: finished/zero counts, prose above the prompt, a menu, another provider
  for (const screen of ['❯ \n  ⏵⏵ bypass permissions on · 0 monitors ·', '❯ \n1 shell completed', '❯ \n  Opus 5h 46%\n  ⏵⏵ bypass permissions on',
    'I saw 1 monitor still running\n❯ \n  ⏵⏵ bypass permissions on', '❯ 1. Allow\n  · 1 monitor ·']) assert.equal(M.claudeBackgroundTasks(screen, 'claude'), false, screen);
  assert.equal(M.claudeBackgroundTasks('❯ \n  · 1 monitor ·', 'cursor-agent'), false);
});

test('quotaResumed: working again with no quota wait on screen; waiting, idle, dead and asking are not', () => {
  const entry = (state, lastScreen, alive = true) => ({ alive, state, lastScreen });
  assert.equal(M.quotaResumed(entry('working', RESET), 'claude'), true);
  assert.equal(M.quotaResumed(entry('done', RESET), 'claude'), false, 'idle dot and no Doing/stop marker: the dot decides the spinner');
  assert.equal(M.quotaResumed(entry('done', NARROW_MONITOR), 'claude'), true, 'a background monitor is work');
  assert.equal(M.quotaResumed(entry('quota', QUOTA), 'claude'), false);
  assert.equal(M.quotaResumed(entry('working', QUOTA + '\n✻ Cogitating… (1s)'), 'claude'), false, 'a quota line below the spinner is still a wait');
  assert.equal(M.quotaResumed(entry('done', IDLE), 'claude'), false);
  assert.equal(M.quotaResumed(entry('working', RESET, false), 'claude'), false);
  assert.equal(M.quotaResumed(entry('input', '❯ 1. Yes\n  2. No'), 'claude'), false);
});

test('a session that carries on after its quota reset voids the old 额度用尽 receipt', async () => {
  const w = world({ crew: true });
  const t = w.failedByQuota({ boardId: 'card', boardAttempt: 'a1' });
  w.s.pending.push({ taskId: 'other', colId: 'x', source: 'command', summary: 'a real result' });
  assert.equal(w.worker.lastReceipt.source, 'quota');
  assert.equal(w.s.pending.filter((p) => p.taskId === t.id).length, 1);
  w.advance(90 * 60_000);
  w.screen('working', RESET);
  w.tick();
  assert.equal(t.status, 'failed', 'one glimpse of work is not enough');
  w.advance(20_000); w.tick();
  assert.equal(t.status, 'working');
  assert.equal(t.receipt, undefined);
  assert.equal(t.doneAt, undefined);
  assert.equal(t.gen, w.s.gen, 'the current Captain gets what it sends next');
  assert.equal(w.worker.lastReceipt, undefined);
  assert.deepEqual([...w.s.pending.map((p) => p.taskId)], ['other'], 'only the stale notice is retracted');
  const ledger = (await w.api.handle({ action: 'main-ledger' }, w.captain)).result;
  assert.doesNotMatch(ledger, /额度用尽/);
  assert.match(ledger, new RegExp(M.statusLabel('working')));
  await new Promise(setImmediate);
  assert.deepEqual([...w.boardEvents.map((e) => e.type)], ['failed', 'started']);
  assert.match(w.boardEvents[1].source, /^resume-quota-/);
});

test('after the revival the real receipt reaches the current Captain, and a new generation did not drop it', async () => {
  const w = world();
  const t = w.failedByQuota({ gen: 1 });
  w.s.pending.length = 0;
  w.advance(60_000); w.screen('working', RESET); w.tick(); w.advance(20_000); w.tick();
  assert.equal(t.status, 'working');
  await w.api.submit({ action: 'complete', result: '做完了' }, w.worker);
  assert.equal(t.status, 'done');
  assert.equal(w.s.pending.length, 1);
  assert.equal(w.s.pending[0].summary, '做完了');
});

test('a real receipt that arrives while the quota failure still stands goes to the current Captain too', async () => {
  const w = world();
  const t = w.failedByQuota({ gen: 1 });
  w.s.pending.length = 0;
  await w.api.submit({ action: 'complete', result: '做完了' }, w.worker);
  assert.equal(t.status, 'done');
  assert.equal(t.gen, w.s.gen);
  assert.deepEqual([...w.s.pending.map((p) => p.summary)], ['做完了']);
});

test('a session really stopped on its quota stays failed, and so does one that finished and sits idle', () => {
  const w = world();
  const t = w.failedByQuota();
  for (let i = 0; i < 5; i++) { w.advance(60_000); w.tick(); }
  assert.equal(t.status, 'failed', 'still on the quota wait');
  assert.equal(w.worker.lastReceipt.source, 'quota');
  w.screen('done', IDLE);
  for (let i = 0; i < 5; i++) { w.advance(60_000); w.tick(); }
  assert.equal(t.status, 'failed', 'idle at the prompt is not work');
  assert.ok(w.worker.lastReceipt);
});

test('work that flickers on and off does not count: the window restarts', () => {
  const w = world();
  const t = w.failedByQuota();
  w.screen('working', RESET); w.tick();
  w.advance(10_000); w.screen('done', IDLE); w.tick();
  assert.equal(t.resumeSeenAt, undefined);
  w.advance(10_000); w.screen('working', RESET); w.tick();
  w.advance(10_000); w.tick();
  assert.equal(t.status, 'failed');
  w.advance(10_000); w.tick();
  assert.equal(t.status, 'working');
});

test('a dead process, an instruction that never went in and other failures are never revived', () => {
  const dead = world(), a = dead.failedByQuota();
  dead.entry.alive = false; dead.screen('quota', QUOTA);
  dead.s.tasks.length = 0; dead.s.tasks.push({ id: 'p', colId: 'worker', gen: 3, status: 'working', startedAt: 1, sentAt: 1, instructionSent: true });
  dead.tick();
  const exited = dead.s.tasks[0];
  assert.equal(exited.status, 'failed'); assert.equal(exited.receipt.exited, true);
  dead.entry.alive = true; dead.screen('working', RESET);
  dead.tick(); dead.advance(20_000); dead.tick();
  assert.equal(exited.status, 'failed', 'a relaunched terminal is not the old task carrying on');
  assert.ok(a);

  const unsent = world();
  const u = unsent.failedByQuota({ instructionSent: false, instruction: 'never typed' });
  assert.equal(u.receipt.undeliveredTaskId, u.id);
  unsent.screen('working', RESET); unsent.tick(); unsent.advance(20_000); unsent.tick();
  assert.equal(u.status, 'failed');

  const crash = world();
  const c = { id: 'c', colId: 'worker', gen: 3, status: 'failed', startedAt: 1, sentAt: 1, instructionSent: true, receipt: { failed: '测试没过', source: 'command', explicit: true } };
  crash.s.tasks.push(c);
  crash.screen('working', RESET); crash.tick(); crash.advance(20_000); crash.tick();
  assert.equal(c.status, 'failed');
});

test('only the latest task of the session can be revived', () => {
  const w = world();
  const old = w.failedByQuota();
  const next = { id: 'next', colId: 'worker', gen: 3, status: 'done', startedAt: 5, sentAt: 5, receipt: { summary: 'ok', source: 'command', explicit: true } };
  w.s.tasks.push(next);
  w.screen('working', RESET); w.tick(); w.advance(20_000); w.tick();
  assert.equal(old.status, 'failed');
  assert.equal(next.status, 'done');
});

test('a background session under a quota receipt is not archived while its terminal is working, then not at all once revived', async () => {
  const w = world({ crew: true });
  const t = w.failedByQuota({ boardId: 'card', boardAttempt: 'a1', doneAt: 1, sentAt: 1 });
  w.s.pending.length = 0;
  w.advance(90 * 60_000);
  // the board says another session took the card, which alone would make a failed session archivable
  w.api.__cards = null;
  w.screen('done', IDLE); // idle: the control, it is archived by the old rule once the card is handled elsewhere
  w.s.tasks.push({ id: 'o', colId: 'other', boardId: 'card', status: 'working', sentAt: t.sentAt + 5 });
  w.tick(); await new Promise(setImmediate); w.tick();
  assert.deepEqual([...w.archived], ['worker'], 'finished and handled elsewhere: archived as before');
  w.archived.length = 0;

  for (const [state, text] of [['done', NARROW_MONITOR], ['working', RESET]]) {
    w.screen(state, text); w.tick(); await new Promise(setImmediate); w.tick();
    assert.deepEqual([...w.archived], [], state + ' on screen');
  }
  w.advance(20_000); w.tick();
  assert.equal(t.status, 'working');
  w.tick(); assert.deepEqual([...w.archived], []);
});

test('archive looks at the terminal itself, not only at the screen copy a few seconds old', async () => {
  const w = world({ crew: true });
  w.s.tasks.push({ id: 'd', colId: 'worker', gen: 3, status: 'done', startedAt: 1, sentAt: 1, doneAt: 1, receipt: { source: 'command', explicit: true } });
  w.advance(30 * 60_000);
  w.entry.state = 'done'; w.entry.lastScreen = IDLE;
  w.entry.term.screen = RESET; // the terminal started again after the last screen copy
  w.tick(); w.tick();
  assert.deepEqual([...w.archived], []);
  w.entry.term.screen = IDLE;
  w.tick();
  assert.deepEqual([...w.archived], ['worker'], 'finished and idle: archived as before');
});

test('read gives the saved chat of an archived session instead of refusing', async () => {
  const gone = { id: 'gone', title: '浏览器后台化收尾', captainCrew: true };
  const w = world({ archivedCrew: [gone] });
  w.saved.set('gone', [{ id: 't1', ts: 1, done: true, user: '做小鹅通收尾', reply: '提交 3c433df' }]);
  const byId = (await w.api.handle({ action: 'main-read', to: 'gone', turns: 1 }, w.captain)).result;
  assert.match(byId, /用户：做小鹅通收尾/); assert.match(byId, /提交 3c433df/);
  const found = (await w.api.handle({ action: 'main-read', to: 'gone', find: '3c433df' }, w.captain)).result;
  assert.match(found, /3c433df/);
  const byTitle = (await w.api.handle({ action: 'main-read', to: '浏览器后台化收尾' }, w.captain)).result;
  assert.match(byTitle, /用户：做小鹅通收尾/);
  w.saved.delete('gone');
  assert.match((await w.api.handle({ action: 'main-read', to: 'gone' }, w.captain)).result, /浏览器后台化收尾.*已归档.*还没有保存的对话/);
  await assert.rejects(() => w.api.handle({ action: 'main-read', to: 'nobody' }, w.captain), /找不到会话/);
});

test('the board reopens a card whose quota stop was not final, and leaves every other closed attempt closed', (t) => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agentdeck-quota-card-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(path.join(root, 'tasks'));
  const make = (title) => {
    const card = store.add({ project: 'p', title, detail: 'Precise instructions.' }).card;
    store.bind({ id: card.id, attempt_id: 'a1', session_id: 's1', assignee: { agent: 'claude', model: 'm' } });
    return card.id;
  };
  const get = (id) => store.list({ archived: true }).find((c) => c.id === id);
  const fail = (id, source, message) => store.event({ id, session_id: 's1', attempt_id: 'a1', type: 'failed', message, source });
  const resume = (id, attempt = 'a1', session = 's1') => store.event({ id, session_id: session, attempt_id: attempt, type: 'started', message: '', source: 'resume-quota-1' });

  const quota = make('quota card');
  fail(quota, 'quota', '额度用尽：⚠ Usage limit reached · limit resets');
  assert.equal(get(quota).flag, 'quota'); assert.equal(get(quota).attempt_closed, true);
  assert.equal(resume(quota, 'other-attempt').ignored, true);
  assert.equal(resume(quota, 'a1', 'other-session').ignored, true);
  assert.equal(get(quota).attempt_closed, true);
  resume(quota);
  const card = get(quota);
  assert.equal(card.status, 'doing'); assert.equal(card.flag, null); assert.equal(card.resource_failure, null);
  assert.equal(card.attempt_closed, false); assert.equal(card.latest_receipt, '');
  assert.equal(card.consecutive_failures || 0, 0);
  store.event({ id: quota, session_id: 's1', attempt_id: 'a1', type: 'complete', message: '做完了', source: 'command' });
  assert.equal(get(quota).latest_receipt, '做完了'); assert.equal(get(quota).attempt_closed, true);

  const crash = make('crash card');
  fail(crash, 'command', '测试没过');
  assert.equal(resume(crash).ignored, true, 'a real failure is not undone by output on the screen');
  assert.equal(get(crash).flag, 'failed'); assert.equal(get(crash).attempt_closed, true);
});
