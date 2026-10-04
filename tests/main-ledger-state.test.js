'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

function ledger(task, terminalState) {
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: 'cursor-agent' };
  const entries = new Map([[captain.id, { alive: true, state: 'done' }], [worker.id, { alive: true, state: terminalState }]]);
  const window = { deck: { onTaskStart() {} }, MainCore: M, BoardCore: B, ChatUI: { hasDraft: () => false, turnsOf: () => [] } };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({ config: { mainSession: { colId: captain.id, tasks: [task], pending: [], waitlist: [] }, folders: [] },
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id });
  return window.MainSession.handle({ action: 'main-ledger' }, captain).then((r) => r.result);
}

test('ledger status follows the terminal until a command receipt completes the task', async () => {
  const screenDone = await ledger({ id: 't', colId: 'worker', status: 'done', receipt: { source: 'screen' } }, 'working');
  assert.match(screenDone, new RegExp(M.statusLabel('working')));
  assert.doesNotMatch(screenDone, /终端:/);
  const noReceipt = await ledger({ id: 't', colId: 'worker', status: 'done' }, 'working');
  assert.match(noReceipt, new RegExp(M.statusLabel('working')));
  assert.doesNotMatch(noReceipt, /终端:/);
  const command = await ledger({ id: 't', colId: 'worker', status: 'done', receipt: { source: 'command' } }, 'working');
  assert.match(command, new RegExp(M.statusLabel('done')));
  assert.match(command, new RegExp('终端:' + M.statusLabel('working')));
});
