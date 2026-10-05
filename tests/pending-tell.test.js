'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const C = require('../chat-core');
const M = require('../main-core');
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function world() {
  let now = 1_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude' };
  const columns = [captain, worker], timers = [], delivered = [];
  const config = { mainSession: { colId: captain.id, gen: 1, tasks: [
    { id: 'original', colId: worker.id, gen: 1, status: 'working', startedAt: now, instructionSent: true },
  ], pending: [], inflight: [], waitlist: [] } };
  const terms = new Map([[worker.id, { alive: true, state: 'working', lastScreen: '✻ Doing…\nClaude Code', foreground: true }]]);
  let chat = { turns: [] }, archives = [];
  const storeCard = (id, task) => {
    const turn = { id: task.id, kind: 'task', user: task.title, task };
    const at = chat.turns.findIndex((t) => t.id === task.id);
    if (at < 0) chat.turns.push(turn); else chat.turns[at] = turn;
    chat = C.normalizeChat(chat, captain.id);
  };
  const window = { MainCore: M, BoardCore: B, deck: { saveConfigSync() {}, onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, ChatUI: {
    addCard: storeCard, updateCard: storeCard, turnsOf: () => chat.turns, captainArchives: () => archives,
    async sendPrompt(col, text) { delivered.push(text); return { id: 'turn-' + delivered.length }; },
  } };
  const context = vm.createContext({ window, ChatUI: window.ChatUI, MainCore: M, columns, terms,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    env: { platform: 'darwin' }, AGENT_IDLE_RE: /Claude Code/,
    terminalIdle: () => true, userComposing: () => false,
    agentInForeground: async (col) => terms.get(col.id)?.foreground,
  });
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, dispatch };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config, columns: () => columns, terms, saveConfig() {}, columnLabel: (col) => col.id,
    sendWhenReady: context.sendWhenReady, showToast() {} });
  return { config, worker, captain, terms, columns, delivered, api: window.MainSession,
    dispatch: (text) => window.__test.dispatch(worker, text, '补充任务'),
    async advance(ms) { now += ms; const due = timers.splice(0); for (const fn of due) await fn(); await tick(); },
    archiveCards() { archives = [{ id: 'old-captain', turns: JSON.parse(JSON.stringify(chat.turns)) }]; chat = { turns: [] }; config.mainSession.tasks = []; },
    sendWhenReady: context.sendWhenReady,
  };
}

test('a live busy supplement survives 30 minutes, reminds once, then delivers the entire batch once', async () => {
  const w = world(); const first = w.dispatch('FIRST BODY'); w.dispatch('SECOND BODY');
  await tick(); await w.advance(31 * 60_000);
  assert.equal(first.status, 'queued'); assert.equal(w.delivered.length, 0);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.match(w.config.mainSession.pending[0].summary, /仍在排队/);
  await w.advance(40 * 60_000);
  assert.equal(w.config.mainSession.pending.length, 1, 'the timeout reminder is emitted only once');
  Object.assign(w.terms.get('worker'), { state: 'done', lastScreen: 'Claude Code' });
  await w.advance(500);
  assert.deepEqual(w.delivered, ['FIRST BODY\n\nSECOND BODY']);
  assert.equal(first.status, 'done'); assert.equal(w.config.mainSession.tasks.at(-1).status, 'working');
  await w.advance(500); assert.equal(w.delivered.length, 1);
});

test('quota while the agent is alive holds a supplement instead of failing it', async () => {
  const w = world(); const task = w.dispatch('AFTER QUOTA');
  const entry = w.terms.get('worker');
  Object.assign(entry, { state: 'quota', lastScreen: "You've hit your usage limit · resets 5pm" });
  w.api.onTick('worker', entry);
  assert.equal(task.status, 'queued'); assert.equal(task.receipt, null);
  await w.advance(31 * 60_000); assert.equal(task.status, 'queued');
  Object.assign(entry, { state: 'done', lastScreen: 'Claude Code' });
  await w.advance(500); assert.deepEqual(w.delivered, ['AFTER QUOTA']);
});

test('a shell foreground without an exit signal cannot discard an unsent supplement', async () => {
  const w = world(); const task = w.dispatch('NOT SHELL CODE');
  Object.assign(w.terms.get('worker'), { state: 'plain', lastScreen: '$', foreground: false });
  await w.advance(31 * 60_000);
  assert.equal(task.status, 'queued'); assert.equal(w.delivered.length, 0);
});

for (const reason of ['terminal exit', 'removed column']) test(reason + ' fails unsent work with a durable full-text recovery command', async () => {
  const w = world(); const body = '未送达原文🙂\n'.repeat(1500) + 'UNIQUE END'; const task = w.dispatch(body);
  if (reason === 'terminal exit') Object.assign(w.terms.get('worker'), { alive: false, exitReason: 'terminal exit 7' });
  else w.columns.splice(w.columns.indexOf(w.worker), 1);
  await w.advance(500);
  assert.equal(task.status, 'failed'); assert.equal(task.receipt.undeliveredInstruction, body);
  const receipt = await w.api.handle({ action: 'main-receipts' }, w.captain);
  assert.match(receipt.result, new RegExp('read --id ' + task.id));
  assert.ok(!receipt.result.includes(body), 'full instruction text does not flood the Captain receipt');
  assert.equal((await w.api.handle({ action: 'main-read', to: task.id }, w.captain)).result, body);
  w.archiveCards();
  assert.equal((await w.api.handle({ action: 'main-read', to: task.id }, w.captain)).result, body, 'saved cards retain text after config eviction and Captain clear');
  await w.advance(31 * 60_000); assert.equal(w.delivered.length, 0);
});

for (const code of [0, 7]) test('agent exit ' + code + ' fails every supplement even while its parent shell is alive', async () => {
  const w = world(); const first = w.dispatch('UNSENT ONE'); const second = w.dispatch('UNSENT TWO');
  await w.api.submit({ action: 'session-exit', code }, w.worker);
  assert.equal(w.terms.get('worker').alive, true);
  for (const task of [first, second]) {
    assert.equal(task.status, 'failed'); assert.match(task.receipt.failed, new RegExp('exit ' + code));
    assert.equal(task.receipt.undeliveredInstruction, task.instruction);
  }
  await w.advance(500); assert.equal(w.delivered.length, 0);
});

test('completion of the delivered task does not bind to or discard its queued supplement', async () => {
  const w = world(); const task = w.dispatch('NEXT TASK');
  await w.api.submit({ action: 'complete', result: 'ORIGINAL FINISHED' }, w.worker);
  assert.equal(w.config.mainSession.tasks[0].receipt.summary, 'ORIGINAL FINISHED');
  assert.equal(task.status, 'queued');
  await w.api.submit({ action: 'session-exit', code: 0 }, w.worker);
  assert.equal(task.status, 'failed'); assert.equal(task.receipt.undeliveredInstruction, 'NEXT TASK');
  assert.equal(w.config.mainSession.tasks[0].receipt.summary, 'ORIGINAL FINISHED');
});

test('non-Captain scheduled delivery retains its existing bounded timeout', async () => {
  const w = world(); let failed = 0;
  w.sendWhenReady(w.worker, 'SCHEDULE', { timeout: 1000, onGiveUp() { failed++; } });
  await w.advance(1001); assert.equal(failed, 1);
  await w.advance(500); assert.equal(failed, 1);
});
