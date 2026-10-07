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

test('picker helpers: title from the first line, busy count, queued label and result wording', () => {
  assert.deepEqual(Web.MODES.map((m) => m.id), ['chat', 'deep-research']);
  assert.equal(Web.modeLabel('deep-research'), 'Deep Research'); assert.equal(Web.modeLabel('chat'), '普通');
  assert.equal(Web.titleFor('\n  Why   is the sky blue?  \nsecond line'), 'Why is the sky blue?');
  assert.equal(Web.titleFor('x'.repeat(60)).length, 40); assert.equal(Web.titleFor('  \n '), '');
  const columns = [{ id: 'w1', executor: 'chatgpt-web' }, { id: 'w2', executor: 'chatgpt-web' }, { id: 'c', cmd: 'claude' }];
  const tasks = [{ colId: 'w1', status: 'working' }, { colId: 'w2', status: 'done' }, { colId: 'c', status: 'working' }];
  assert.equal(Web.busyCount(tasks, columns), 1); assert.equal(Web.busyCount(undefined, undefined), 0);
  assert.equal(Web.isQueued({ status: 'working', webPhase: 'queued' }), true);
  assert.equal(Web.isQueued({ status: 'working', webPhase: 'running' }), false);
  assert.equal(Web.isQueued({ status: 'done', webPhase: 'queued' }), false);
  assert.match(Web.dispatchResult(0), /已派给网页版 ChatGPT/); assert.match(Web.dispatchResult(2), /排队中：前面还有 2 件/);
  assert.match(Web.PUBLIC_NOTICE, /公开调研/); assert.match(Web.PUBLIC_NOTICE, /密钥、隐私或内部信息/);
  assert.match(Web.NO_SEAT_NOTE, /席位/); assert.match(Web.NO_SEAT_NOTE, /启动命令/);
});

test('dispatchWeb opens a web session like new --agent chatgpt-web and says so only when nothing is ahead', async () => {
  const w = world();
  const first = await w.api.dispatchWeb('Why is the sky blue?\nUse public sources.', 'deep-research'); await tick();
  const col = w.columns[1], task = w.task();
  assert.equal(first.queued, false); assert.equal(first.colId, col.id); assert.match(first.result, /已派给网页版 ChatGPT/);
  assert.equal(col.executor, 'chatgpt-web'); assert.equal(col.cmd, 'chatgpt-web'); assert.equal(col.webMode, 'deep-research');
  assert.equal(col.claudeSeatId, undefined); assert.equal(task.title, 'Why is the sky blue?');
  assert.deepEqual(JSON.parse(JSON.stringify(w.runs)), [{ id: col.id, taskId: task.id, task: 'Why is the sky blue?\nUse public sources.', mode: 'deep-research' }]);
  const second = await w.api.dispatchWeb('Why is the sea salty?', 'chat'); await tick();
  assert.equal(second.queued, true); assert.match(second.result, /排队中：前面还有 1 件/);
  assert.equal(w.shellInputs.length, 0);
});

test('dispatchWeb refuses credentials, an empty question and an unknown mode before anything is saved', async () => {
  const w = world();
  await assert.rejects(w.api.dispatchWeb('password = hunter2hunter2', 'chat'), /疑似含凭据/);
  await assert.rejects(w.api.dispatchWeb('   \n', 'chat'), /先写下要调研的问题/);
  await assert.rejects(w.api.dispatchWeb('Why is the sky blue?', 'agent'), /网页模式/);
  assert.equal(w.columns.length, 1); assert.equal(w.tasks().length, 0); assert.equal(w.runs.length, 0);
});

test('a web task is queued until the executor reports the page is open, and the terminal entry follows', async () => {
  const w = world(); await w.create(); await tick();
  const col = w.columns[1], task = w.task(), entry = w.terms.get(col.id);
  assert.equal(task.status, 'working'); assert.equal(task.webPhase, 'queued'); assert.equal(entry.webQueued, true);
  assert.equal(Web.isQueued(task), true); assert.match(task.progress, /排队中/);
  await w.api.submit({ action: 'progress', taskId: task.id, message: '排队等待 ChatGPT 网页：本机一次只做一个请求。', phase: 'queued' }, col);
  assert.equal(task.webPhase, 'queued'); assert.equal(entry.webQueued, true);
  await w.api.submit({ action: 'progress', taskId: task.id, message: '等待 ChatGPT 网页：6 Pro', phase: 'running' }, col);
  assert.equal(task.webPhase, 'running'); assert.equal(entry.webQueued, false); assert.equal(Web.isQueued(task), false);
  await w.api.submit({ action: 'complete', taskId: task.id, result: 'Air scatters blue light.' }, col);
  assert.equal(task.status, 'done'); assert.equal(Web.isQueued(task), false);
});

test('discussion receipts require the Captain, validate the payload and deduplicate the same receipt without replacing its text', async () => {
  const w = world();
  const receipt = { action: 'main-discuss-receipt', receiptId: 'd-example-complete-1',
    result: '讨论已完成。建议先核对约束；主要分歧保留。完整答案：/tmp/discussion/final.md', deadline: Date.now() + 5000 };
  const worker = w.host.createSession({ id: 'discussion-worker', cmd: 'claude', captainCrew: true });
  await assert.rejects(w.api.handle(receipt, worker), /只有队长/);
  assert.equal(w.config.mainSession.pending.length, 0);
  for (const malformed of [{ receiptId: '../invalid' }, { receiptId: '' }, { result: '' }, { result: 'x'.repeat(4001) }]) {
    await assert.rejects(w.api.handle({ ...receipt, ...malformed }, w.captain), /无效讨论回执/);
  }
  assert.equal(w.config.mainSession.pending.length, 0);
  const first = await w.api.handle(receipt, w.captain);
  assert.equal(first.done, true);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.pending[0].summary, receipt.result);
  assert.equal(w.config.mainSession.pending[0].taskId, receipt.receiptId);
  assert.deepEqual(Array.from(w.config.mainSession.discussionReceipts), [receipt.receiptId]);
  await w.api.handle({ ...receipt, result: '重复通知不得覆盖原始结果。' }, w.captain);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.pending[0].summary, receipt.result);
  assert.equal(w.config.mainSession.discussionReceipts.length, 1);
  assert.equal(w.runs.length, 0);
  assert.equal(w.shellInputs.length, 0);
});

test('an expired discussion receipt never enters the Captain queue or consumes its deduplication id', async () => {
  const w = world();
  const receipt = { action: 'main-discuss-receipt', receiptId: 'd-example-paused-1', result: '讨论已暂停，网页原请求待处理。' };
  await assert.rejects(w.api.handle({ ...receipt, deadline: Date.now() - 1000 }, w.captain), /超时|没有执行/);
  assert.equal(w.config.mainSession.pending.length, 0);
  assert.equal(w.config.mainSession.discussionReceipts, undefined);
  await w.api.handle({ ...receipt, deadline: Date.now() + 5000 }, w.captain);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.pending[0].summary, receipt.result);
  assert.deepEqual(Array.from(w.config.mainSession.discussionReceipts), [receipt.receiptId]);
});
