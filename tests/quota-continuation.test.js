'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const Q = require('../quota-core');

const SEATS = [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }];
const WALL = 'Usage limit reached · continuing automatically at 5:50pm';
const blocked = (seat, resetAt) => ({ scope: Q.SCOPES.Claude, configDir: seat.configDir, blocked: { at: Date.now(), resetAt } });

// One Captain, one Claude worker on CN that is stopped at the quota wall.
function world({ out = ['cn'], seats = SEATS, hops = 0, boardId = 'card-1' } = {}) {
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'w1', cmd: 'claude --model claude-opus-5-5 --effort high', cwd: '/work/tree-1', captainCrew: true, claudeSeatId: 'cn',
    boardId, project: 'P', title: '修登录', displayTitle: '修登录' };
  const columns = [captain, worker], archived = [], created = [], boardCalls = [], sent = [];
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '' }],
    [worker.id, { alive: true, state: 'quota', lastOutputAt: Date.now(), lastScreen: WALL }]]);
  const quotas = {};
  for (const seat of seats) if (out.includes(seat.id)) quotas[Q.seatKey(seat.id)] = blocked(seat, Date.now() + 3600_000 * (seat.id === 'cn' ? 1 : 2));
  const task = { id: 't1', colId: worker.id, title: '修登录', gen: 1, status: 'working', prompt: '把登录页的报错修掉', boardId, boardAttempt: 'a1', hops };
  const mainSession = { colId: captain.id, gen: 1, tasks: [task], pending: [], waitlist: [], inflight: [] };
  const queue = [];
  const window = { MainCore: M, BoardCore: B, QuotaCore: Q,
    deck: { onTaskStart() {}, memoryPressure: async () => ({ level: null }),
      taskBoard: async (op, input) => { boardCalls.push({ op, ...input }); return { notices: [], card: {} }; } },
    ChatUI: { readFooter: () => null, hasDraft: () => false, turnsOf: () => [], addCard() {}, updateCard() {}, onColumnArchived() {} } };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
    setTimeout, clearTimeout, Date, console });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const config = { mainSession, claudeSeats: seats, quotas, activeClaudeSeatId: 'cn', folders: [] };
  window.MainSession.init({ config, columns: () => columns, terms: entries, userComposing: () => false, columnLabel: (c) => c.displayTitle || c.id,
    saveConfig() {}, showToast: (m) => queue.push(m), platform: 'darwin', isBackstage: () => true, focusedId: () => '', lastTurnTs: () => 0,
    createSession: (c) => { const col = { ...c, role: 'manual' }; created.push(col); columns.push(col); entries.set(col.id, { alive: true, state: 'plain', lastOutputAt: 0, lastScreen: '' }); return col; },
    archiveColumn: (col) => { archived.push(col.id); columns.splice(columns.indexOf(col), 1); entries.delete(col.id); },
    sendWhenReady: (col, text) => sent.push({ colId: col.id, text: text() }), restoreArchived() {}, agentInForeground: async () => true });
  return { api: window.MainSession, config, mainSession, task, worker, entries, columns, archived, created, boardCalls, sent, toasts: queue,
    tick: async () => { window.MainSession.onTick(worker.id, entries.get(worker.id) || { alive: false }); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
    pumpTick: async () => { window.MainSession.onTick(captain.id, entries.get(captain.id)); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); } };
}

test('the plan picks the other seat with the most room, else waits for the earliest recovery', () => {
  const quota = (rows) => (id) => rows[id];
  const seats = [{ id: 'cn', name: 'CN' }, { id: 'us', name: 'US' }, { id: 'eu', name: 'EU' }];
  assert.deepEqual(M.continuePlan({ seats, currentSeatId: 'cn', quotaOf: quota({ cn: { out: true }, us: { out: false, shortRemaining: 20 }, eu: { out: false, shortRemaining: 70 } }) }),
    { kind: 'switch', seatId: 'eu', seatName: 'EU' });
  assert.equal(M.continuePlan({ seats, currentSeatId: 'cn', quotaOf: quota({ cn: { out: true }, us: { out: false }, eu: { out: true } }) }).seatId, 'us');
  assert.deepEqual(M.continuePlan({ seats, currentSeatId: 'cn', quotaOf: quota({ cn: { out: true, recoveryAt: 500 }, us: { out: true, recoveryAt: 900 }, eu: { out: true, recoveryAt: 700 } }) }),
    { kind: 'wait', recoveryAt: 500 });
  assert.equal(M.continuePlan({ seats: seats.slice(0, 1), currentSeatId: 'cn', quotaOf: () => ({}) }).kind, 'none');
  assert.equal(M.continuePlan({ seats, currentSeatId: 'cn', hops: M.MAX_CONTINUE_HOPS, quotaOf: () => ({ out: false }) }).kind, 'none');
  assert.equal(M.continuePlan({ seats, currentSeatId: null, quotaOf: quota({ cn: { out: true }, us: { out: false } }) }).seatId, 'us');
});

test('the continuation prompt tells the new session to read the working tree and keep it', () => {
  const text = M.continuationPrompt('把登录页的报错修掉', 'CN');
  assert.match(text, /git status/); assert.match(text, /不要回滚/); assert.ok(text.endsWith('把登录页的报错修掉'));
});

test('a worker at the wall carries on in the other seat: same directory and card, old session archived, nobody told to redo it', async () => {
  const w = world();
  await w.tick();
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].claudeSeatId, 'us');
  assert.equal(w.created[0].cwd, '/work/tree-1');
  assert.equal(w.created[0].boardId, 'card-1');
  assert.equal(w.created[0].captainCrew, true);
  assert.match(w.created[0].cmd, /^claude /);
  assert.deepEqual(w.archived, ['w1']);
  assert.match(w.sent[0].text, /git status/); assert.match(w.sent[0].text, /把登录页的报错修掉/);
  const events = w.boardCalls.filter((c) => c.op === 'event'), bind = w.boardCalls.find((c) => c.op === 'bind');
  assert.equal(events.length, 1); assert.equal(events[0].type, 'failed'); assert.equal(events[0].source, 'quota');
  assert.equal(bind.id, 'card-1'); assert.equal(bind.session_id, w.created[0].id);
  assert.ok(w.boardCalls.indexOf(events[0]) < w.boardCalls.indexOf(bind));
  assert.equal(w.task.status, 'stopped');
  assert.ok(!w.mainSession.pending.some((p) => p.failed), 'no failure receipt reaches the Captain');
  assert.match(w.mainSession.pending.at(-1).summary, /不用重派/);
  assert.equal(w.mainSession.tasks.find((t) => t.colId === w.created[0].id).hops, 1);
  await w.tick(); assert.equal(w.created.length, 1, 'later ticks do not start a second continuation');
});

test('a quota failure on the board is a quota flag, never a counted failure', () => {
  const { TaskStore } = require('../task-board');
  assert.ok(TaskStore);
  const card = { consecutive_failures: 0, rework_count: 0 };
  TaskStore.prototype.failure.call({}, card, 'a1', M.resourceReceipt(WALL, 'claude').failed, false, 'quota');
  assert.equal(card.flag, 'quota'); assert.equal(card.consecutive_failures, 0); assert.equal(card.resource_failure, 'quota');
});

test('with every seat out the work waits, the old session is still archived, and the earliest recovery starts it', async () => {
  const w = world({ out: ['cn', 'us'] });
  await w.tick();
  assert.equal(w.created.length, 0);
  assert.deepEqual(w.archived, ['w1']);
  assert.equal(w.mainSession.waitlist.length, 1);
  const waiting = w.mainSession.tasks.find((t) => t.status === 'waiting');
  assert.match(waiting.waitReason, /所有席位额度都用尽/);
  assert.ok(!w.mainSession.pending.some((p) => p.failed));
  await w.pumpTick(); assert.equal(w.created.length, 0, 'still no seat with room');
  // CN recovers first.
  delete w.config.quotas[Q.seatKey('cn')];
  await w.pumpTick();
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].claudeSeatId, 'cn');
  assert.equal(w.created[0].cwd, '/work/tree-1'); assert.equal(w.created[0].boardId, 'card-1');
  assert.equal(w.mainSession.waitlist.length, 0);
  assert.match(w.sent[0].text, /把登录页的报错修掉/);
  assert.equal(w.boardCalls.filter((c) => c.op === 'bind').length, 1);
});

test('without another seat, after too many hops, or for a non-Claude worker the normal failure receipt is kept', async () => {
  for (const options of [{ seats: SEATS.slice(0, 1) }, { hops: M.MAX_CONTINUE_HOPS }]) {
    const w = world(options);
    await w.tick();
    assert.equal(w.created.length, 0); assert.equal(w.archived.length, 0);
    assert.equal(w.task.status, 'failed');
    assert.ok(w.mainSession.pending.some((p) => p.failed));
  }
  const other = world();
  other.worker.cmd = 'codex --model gpt-6';
  await other.tick();
  assert.equal(other.created.length, 0); assert.equal(other.task.status, 'failed');
});

test('a worker waiting on a decision is not moved', async () => {
  const w = world();
  w.mainSession.tasks.push({ id: 't2', colId: 'w1', title: '问', gen: 1, status: 'asking', receipt: { question: '要不要?' } });
  await w.tick();
  assert.equal(w.created.length, 0);
});

test('Claude\'s "Usage limit reached · continuing automatically at …" line is recognised as a quota stop', () => {
  assert.equal(M.terminalActivity(WALL, 'claude'), 'quota');
  assert.equal(M.resourceFailure(M.resourceReceipt(WALL, 'claude').failed, 'quota'), 'quota');
  assert.equal(M.terminalActivity('Usage limit reached check broken', 'claude'), '');
});
