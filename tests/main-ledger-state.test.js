'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

function runtime(task, terminalState, lastReceipt) {
  const boardEvents = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: 'cursor-agent', lastReceipt };
  const entries = new Map([[captain.id, { alive: true, state: 'done' }], [worker.id, { alive: true, state: terminalState }]]);
  const window = { deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard(op, input) { if (op !== 'list') boardEvents.push({ op, input }); return Promise.resolve(op === 'list' ? [] : {}); } }, MainCore: M, BoardCore: B, ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {} } };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const state = { colId: captain.id, tasks: [task], pending: [], waitlist: [] };
  window.MainSession.init({ config: { mainSession: state, folders: [] }, saveConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id });
  return { api: window.MainSession, window, captain, worker, state, boardEvents, entry: entries.get(worker.id) };
}
function ledger(task, terminalState) {
  const { api, captain } = runtime(task, terminalState);
  return api.handle({ action: 'main-ledger' }, captain).then((r) => r.result);
}

test('Cursor ledger follows live work even after a command receipt completes the assignment', async () => {
  const screenDone = await ledger({ id: 't', colId: 'worker', status: 'done', receipt: { source: 'screen' } }, 'working');
  assert.match(screenDone, new RegExp(M.statusLabel('working')));
  assert.doesNotMatch(screenDone, /终端:/);
  const noReceipt = await ledger({ id: 't', colId: 'worker', status: 'done' }, 'working');
  assert.match(noReceipt, new RegExp(M.statusLabel('working')));
  assert.doesNotMatch(noReceipt, /终端:/);
  const command = await ledger({ id: 't', colId: 'worker', status: 'done', receipt: { source: 'command' } }, 'working');
  assert.match(command, new RegExp(M.statusLabel('working')));
  assert.doesNotMatch(command, new RegExp(M.statusLabel('done')));
  const done = await ledger({ id: 't', colId: 'worker', status: 'done', receipt: { source: 'command' } }, 'done');
  assert.match(done, new RegExp(M.statusLabel('done')));
});

test('resumed work retracts only the automatic no-receipt notice from the ledger and task', async () => {
  const receipt = { summary: '已结束，未提交回执', explicit: false, source: 'fallback' };
  const task = { id: 't', colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'stopped', receipt, endedAt: 1, doneAt: 1, processEnded: true };
  const { api, captain, worker, state, entry, boardEvents } = runtime(task, 'working', receipt);
  state.pending.push({ taskId: task.id, summary: receipt.summary, source: 'fallback' });
  state.pending.push({ taskId: 'other', summary: 'real result', source: 'command' });
  api.onTick(worker.id, entry);
  assert.equal(worker.lastReceipt, undefined);
  assert.equal(task.status, 'working');
  assert.equal(task.receipt, undefined);
  assert.equal(task.endedAt, 0);
  assert.equal(task.processEnded, undefined);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].source, 'command');
  assert.doesNotMatch((await api.handle({ action: 'main-ledger' }, captain)).result, /已结束，未提交回执/);
  await new Promise(setImmediate);
  assert.equal(boardEvents.length, 1);
  assert.equal(boardEvents[0].input.type, 'started');
  assert.equal(boardEvents[0].input.id, 'card');
  assert.equal(boardEvents[0].input.attempt_id, 'attempt');
  assert.match(boardEvents[0].input.source, /^resume-fallback-/);
});

test('a new working instruction clears the old column fallback but keeps actual receipts', () => {
  for (const source of ['fallback', 'command']) {
    const receipt = { summary: '已结束，未提交回执', explicit: source === 'command', source };
    const task = { id: 'new', colId: 'worker', status: 'working', receipt: source === 'command' ? receipt : undefined };
    const { api, worker, entry } = runtime(task, 'working', receipt);
    api.onTick(worker.id, entry);
    assert.equal(worker.lastReceipt, source === 'command' ? receipt : undefined);
    assert.equal(task.receipt, source === 'command' ? receipt : undefined);
  }
  const receipt = { summary: '已结束，未提交回执', explicit: false, source: 'fallback' };
  const task = { id: 'idle', colId: 'worker', status: 'stopped', receipt };
  const { api, worker, entry } = runtime(task, 'done', receipt);
  api.onTick(worker.id, entry);
  assert.equal(worker.lastReceipt, receipt);
  assert.equal(task.status, 'stopped');
});

test('installation registration persists before acknowledgement and blocks early completion and process failures', async () => {
  const task = { id: 'install-task', gen: 1, colId: 'worker', status: 'working', startedAt: 1 };
  const { api, worker, boardEvents, entry } = runtime(task, 'working');
  const registered = await api.submit({ action: 'progress', message: '安装待核对', installId: 'install-1', targetVersion: '1.2.0' }, worker);
  assert.deepEqual(JSON.parse(registered.result), { taskId: 'install-task', columnId: 'worker' });
  assert.equal(task.pendingInstall.id, 'install-1');
  await assert.rejects(api.submit({ action: 'complete', result: '马上触发' }, worker), /安装待核对/);
  await api.submit({ action: 'session-exit', code: 1 }, worker);
  entry.alive = false;
  api.onTick(worker.id, entry);
  assert.equal(task.status, 'working');
  assert.equal(boardEvents.length, 0);
});

for (const status of ['success', 'failed']) test(`runtime installation ${status} settles exactly its registered task once`, async () => {
  const task = { id: 'install-task', gen: 1, colId: 'worker', boardId: 'card', status: 'working', startedAt: 1 };
  const { api, worker, captain, state, boardEvents } = runtime(task, 'working');
  await api.submit({ action: 'progress', message: '安装待核对', installId: 'install-1', targetVersion: '1.2.0' }, worker);
  const r = { id: 'install-1', taskId: task.id, columnId: worker.id, targetVersion: '1.2.0', status, reason: status === 'failed' ? '复制失败' : '' };
  await assert.rejects(api.handle({ action: 'main-install-result', installResult: { ...r, id: 'other' }, result: 'wrong' }, captain), /不匹配/);
  const message = { action: 'main-install-result', installResult: r, result: '运行结果已核对' };
  await api.handle(message, captain);
  await api.handle(message, captain);
  assert.equal(task.status, status === 'success' ? 'done' : 'failed');
  assert.equal(task.pendingInstall, undefined);
  assert.equal(task.installResultId, 'install-1');
  assert.equal(boardEvents.filter((e) => e.op === 'event').length, 1);
  assert.equal(state.pending.filter((p) => p.taskId === task.id).length, 1);
});


test('installation registration and receipt refuse acknowledgement when synchronous persistence fails', async () => {
  const task = { id: 'install-task', gen: 1, colId: 'worker', status: 'working', startedAt: 1 };
  const { api, window, worker, captain } = runtime(task, 'working');
  const registration = { action: 'progress', message: '安装待核对', installId: 'install-1', targetVersion: '1.2.0' };
  window.deck.saveConfigSync = () => false;
  await assert.rejects(api.submit(registration, worker), /持久保存/);
  window.deck.saveConfigSync = () => true;
  await api.submit(registration, worker);
  const message = { action: 'main-install-result', result: '安装成功', installResult: {
    id: 'install-1', taskId: task.id, columnId: worker.id, targetVersion: '1.2.0', status: 'success',
  } };
  window.deck.saveConfigSync = () => false;
  await assert.rejects(api.handle(message, captain), /持久保存/);
  window.deck.saveConfigSync = () => true;
  await api.handle(message, captain);
  assert.equal(task.status, 'done');
});
