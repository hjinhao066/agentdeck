'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const B = require('../board-core');
const M = require('../main-core');
const Web = require('../chatgpt-web-core');
const tick = async () => { for (let i = 0; i < 15; i++) await new Promise((resolve) => setImmediate(resolve)); };

function world() {
  const captain = { id: 'captain', isMain: true, cmd: 'codex' };
  const columns = [captain], runs = [], boardEvents = [], shellInputs = [];
  const hooks = {};
  const config = { columns, archived: [], folders: [], mainSession: { colId: captain.id, tasks: [], pending: [], waitlist: [], inflight: [], gen: 1 } };
  const terms = new Map([[captain.id, { alive: true, state: 'done' }]]);
  const window = {
    MainCore: M, BoardCore: B, ChatGPTWebCore: Web,
    ChatUI: { updateCard() {}, addCard() {}, turnsOf: () => [] },
    deck: {
      onTaskStart: (callback) => { hooks.start = callback; },
      onTaskReview: (callback) => { hooks.review = callback; },
      onTaskRework: (callback) => { hooks.rework = callback; },
      onTasksChanged: (callback) => { hooks.changed = callback; return () => { delete hooks.changed; }; },
      saveConfigSync: () => true, memoryPressure: async () => ({ level: null }),
      chatgptWebRun: async (input) => { runs.push(input); return { accepted: true }; },
      chatgptWebCancel: async () => ({ cancelled: true }),
      chatgptWebStatus: async () => ({ active: false }),
      taskBoard: async (op, input) => { boardEvents.push({ op, input }); return {}; },
      ptyInput: (id, input) => shellInputs.push({ id, input }),
    },
  };
  const context = vm.createContext({ window, document: {}, console, setTimeout, clearTimeout });
  const source = fs.readFileSync(require.resolve('../main-session.js'), 'utf8').replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, dispatch, ledgerRows };\n  window.MainSession = {');
  vm.runInContext(source, context);
  const host = {
    config, terms, platform: 'darwin', columns: () => columns, columnLabel: (col) => col.title || col.id,
    saveConfig() {}, flushConfig() {}, showToast() {}, isBackstage: () => false,
    sendWhenReady() { assert.fail('web executor must never send text to a terminal'); },
    createSession(meta) { const col = { ...meta }; columns.push(col); terms.set(col.id, { alive: true, state: 'plain', lastScreen: 'shell ready' }); return col; },
  };
  window.__test.setHost(host);
  const api = window.MainSession;
  const create = (extra = {}) => api.handle({ id: 'request-' + columns.length, action: 'main-new', title: '公开问题', task: 'Why is the sky blue?', agent: 'chatgpt-web', ...extra }, captain);
  return { api, window, host, columns, terms, runs, boardEvents, shellInputs, config, hooks, captain, create, tasks: () => config.mainSession.tasks, task: () => config.mainSession.tasks.at(-1) };
}

test('chatgpt-web new sends only the raw question and receipts update ordinary ledger/card lifecycle', async () => {
  const w = world();
  await w.create({ webMode: 'deep-research' }); await tick();
  const col = w.columns[1], task = w.task();
  assert.equal(col.cmd, 'chatgpt-web'); assert.equal(col.executor, 'chatgpt-web');
  assert.equal(B.inferAgentType(col.cmd), 'ChatGPT Web');
  assert.equal(task.instructionSent, true); assert.equal(task.status, 'working');
  assert.deepEqual(JSON.parse(JSON.stringify(w.runs)), [{ id: col.id, taskId: task.id, task: 'Why is the sky blue?', mode: 'deep-research' }]);
  await w.api.submit({ action: 'progress', taskId: task.id, message: '正在等待网页生成报告' }, col);
  assert.match((await w.api.handle({ action: 'main-peek', to: col.id }, w.captain)).result, /等待网页/);
  w.api.onTick(col.id, { alive: true, state: 'done', lastScreen: '', lastOutputAt: 0 });
  assert.equal(task.status, 'working', 'quiet shell output must never finish web work');
  await w.api.submit({ action: 'complete', taskId: task.id, result: 'Air scatters blue light.', files: ['/tmp/public-report.md'] }, col);
  assert.equal(task.status, 'done');
  assert.deepEqual(Array.from(task.receipt.files), ['/tmp/public-report.md']);
  assert.equal(w.window.__test.ledgerRows()[0].state, 'done');
  assert.match((await w.api.handle({ action: 'main-peek', to: col.id }, w.captain)).result, /public-report.md/);
  assert.equal(w.config.mainSession.pending.at(-1).summary, 'Air scatters blue light.');
  assert.equal(w.shellInputs.length, 0);
});

test('tell queues distinct web questions and a stale receipt cannot settle the next assignment', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], first = w.task();
  await w.api.handle({ id: 'tell-second', action: 'main-tell', to: col.id, message: 'Why is the sea salty?' }, w.captain);
  const second = w.task(); await tick();
  assert.equal(second.status, 'queued'); assert.equal(w.runs.length, 1);
  await w.api.submit({ action: 'complete', taskId: first.id, result: 'First answer' }, col); await tick();
  assert.equal(second.status, 'working'); assert.equal(w.runs.length, 2);
  assert.equal(w.runs[1].task, 'Why is the sea salty?');
  await w.api.submit({ action: 'complete', taskId: first.id, result: 'Duplicate old receipt' }, col);
  assert.equal(second.status, 'working'); assert.equal(first.receipt.summary, 'First answer');
});

for (const extra of [{ command: 'echo wrong' }, { seatId: 'us' }, { webMode: 'invalid' }]) test('invalid native options are rejected before opening or storing a session: ' + JSON.stringify(extra), async () => {
  const w = world(); await assert.rejects(w.create(extra), /不支持|web-mode/);
  assert.equal(w.columns.length, 1); assert.equal(w.tasks().length, 0); assert.equal(w.runs.length, 0);
});

test('obvious credentials in new/tell are rejected before task persistence', async () => {
  const w = world();
  const secret = 'Please use API key sk-' + 'a'.repeat(40);
  await assert.rejects(w.create({ task: secret })); assert.equal(w.columns.length, 1); assert.equal(w.tasks().length, 0);
  await w.create(); await tick();
  const count = w.tasks().length;
  await assert.rejects(w.api.handle({ action: 'main-tell', to: w.columns[1].id, message: secret }, w.captain));
  assert.equal(w.tasks().length, count);
  assert.ok(!JSON.stringify(w.config).includes(secret));
});

test('native progress/complete update bound board via the same events as CLI workers', async () => {
  const w = world();
  const col = w.host.createSession({ id: 'web-card', title: '研究', executor: 'chatgpt-web', cmd: 'chatgpt-web', captainCrew: true, boardId: 'card', boardAttempt: 'attempt' });
  const task = w.window.__test.dispatch(col, 'What is photosynthesis?', '研究'); await tick();
  await w.api.submit({ action: 'complete', taskId: task.id, result: 'Plants use light.', files: ['/tmp/plants.md'] }, col); await tick();
  const events = w.boardEvents.filter((event) => event.op === 'event');
  assert.equal(events[0].input.type, 'started');
  assert.equal(events.at(-1).input.type, 'complete');
  assert.equal(events.at(-1).input.session_id, col.id);
  assert.deepEqual(Array.from(events.at(-1).input.files), ['/tmp/plants.md']);
});

test('native stop cancels the executor and consumes its late failure receipt', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], task = w.task(); let cancelled = '';
  w.window.deck.chatgptWebCancel = async (id) => { cancelled = id; return { cancelled: true }; };
  await w.api.handle({ action: 'main-stop', to: col.id }, w.captain);
  assert.equal(cancelled, col.id); assert.equal(task.status, 'stopped'); assert.equal(w.shellInputs.length, 0);
  assert.equal(w.terms.get(col.id).webExecutorState, 'stopped');
  assert.equal(w.window.__test.ledgerRows()[0].state, 'stopped');
  await w.api.submit({ action: 'complete', taskId: task.id, failed: '已取消' }, col);
  assert.equal(task.status, 'stopped');
});

test('native failed receipts remain failed in the ledger and dot state, including hot reload', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], task = w.task();
  await w.api.submit({ action: 'complete', taskId: task.id, result: '没有交付报告', failed: 'TIMEOUT：网页等待超时' }, col);
  assert.equal(task.status, 'failed');
  assert.equal(w.terms.get(col.id).state, 'failed');
  assert.equal(w.terms.get(col.id).webExecutorState, 'failed');
  assert.equal(w.window.__test.ledgerRows()[0].state, 'failed');
  const ledger = (await w.api.handle({ action: 'main-ledger' }, w.captain)).result;
  assert.match(ledger.split('\n')[0], /没做成/);
  assert.doesNotMatch(ledger, /已完成/);
  w.terms.get(col.id).webExecutorState = 'plain';
  w.api.notePtySurvived(col); await tick();
  assert.equal(w.terms.get(col.id).webExecutorState, 'failed');
  assert.equal(w.runs.length, 1);
});

for (const replace of [false, true]) test('native tell --now prioritizes C after interrupting A' + (replace ? ' and --replace cancels B' : ' while preserving B'), async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], first = w.task();
  await w.api.handle({ id: 'tell-B', action: 'main-tell', to: col.id, message: 'What makes clouds white?' }, w.captain);
  const second = w.task();
  let releaseCancel;
  w.window.deck.chatgptWebCancel = () => new Promise((resolve) => { releaseCancel = resolve; });
  const telling = w.api.handle({ id: 'tell-C', action: 'main-tell', to: col.id, now: true, replace, message: 'What makes sunsets red?' }, w.captain);
  await tick();
  // The ordinary heartbeat must not drain B while cancellation IPC is pending.
  w.api.onTick(col.id, w.terms.get(col.id)); await tick();
  assert.equal(w.runs.length, 1);
  releaseCancel({ cancelled: true }); await telling; await tick();
  const urgent = w.task();
  assert.equal(first.status, 'stopped');
  assert.equal(second.status, replace ? 'stopped' : 'queued');
  assert.equal(urgent.status, 'working');
  assert.equal(w.runs.length, 2);
  assert.equal(w.runs[1].taskId, urgent.id);
  assert.equal(w.runs[1].task, 'What makes sunsets red?');
  await w.api.submit({ action: 'complete', taskId: first.id, failed: '已取消' }, col); await tick();
  assert.equal(urgent.status, 'working', 'late A receipt must not finish C or start B');
  assert.equal(w.runs.length, 2);
  await w.api.submit({ action: 'complete', taskId: urgent.id, result: 'Urgent answer' }, col); await tick();
  assert.equal(second.status, replace ? 'stopped' : 'working');
  assert.equal(w.runs.length, replace ? 2 : 3);
  if (!replace) assert.equal(w.runs[2].taskId, second.id);
  assert.equal(w.shellInputs.length, 0);
});

test('a hot renderer reload recovers the completed native receipt without repeating the question', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], task = w.task();
  w.window.deck.chatgptWebStatus = async () => ({ active: false, receipt: { action: 'complete', taskId: task.id, result: 'Recovered public answer', files: ['/tmp/recovered.md'] } });
  w.api.notePtySurvived(col); await tick();
  assert.equal(task.status, 'done'); assert.equal(task.receipt.summary, 'Recovered public answer');
  assert.equal(w.runs.length, 1);
});

test('tell --replace cancels native queued supplements without interrupting the active question', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], active = w.task();
  await w.api.handle({ id: 'tell-old', action: 'main-tell', to: col.id, message: 'What makes clouds white?' }, w.captain);
  const old = w.task();
  await w.api.handle({ id: 'tell-replacement', action: 'main-tell', to: col.id, replace: true, message: 'What makes sunsets red?' }, w.captain);
  const replacement = w.task(); await tick();
  assert.equal(old.status, 'stopped'); assert.equal(active.status, 'working');
  assert.equal(replacement.status, 'queued'); assert.equal(w.runs.length, 1);
  await w.api.submit({ action: 'complete', taskId: active.id, result: 'First answer' }, col); await tick();
  assert.equal(replacement.status, 'working'); assert.equal(w.runs.length, 2);
  assert.equal(w.runs[1].task, 'What makes sunsets red?');
  assert.ok(w.runs.every((run) => run.task !== old.instruction));
});
