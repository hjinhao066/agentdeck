'use strict';
// `stop --id`, `archive --id` and `tell --now` (endSession) clear that session's unread notices
// from the Captain's queue. A worker's own complete or ask (source 'command') is a real result
// for a task that is already closed: it stays for the Captain. Automatic notices about the
// session (停在确认, 已结束，未提交回执, watchdog …) go, as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const IDLE = '⏺ All done.\n❯ \n  ⏵⏵ bypass permissions on';

function world() {
  const now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true };
  const columns = [captain, worker], archived = [], keys = [];
  const s = { colId: 'captain', gen: 3, tasks: [], pending: [], inflight: [], waitlist: [] };
  const entry = { alive: true, state: 'done', lastOutputAt: now - 60_000, lastScreen: IDLE, term: { screen: IDLE } };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    MainCore: M, BoardCore: B,
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput: (id, k) => keys.push([id, k]), taskBoard: (op) => Promise.resolve(op === 'list' ? [] : { card: {}, notices: [] }) },
    ChatUI: { hasDraft: () => false, updateCard() {}, turnsOf: () => [], captainArchives: () => [], sendPrompt: async () => true },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, setTimeout, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: s, archived, folders: [] }, terms, columns: () => columns, saveConfig() {},
    isBackstage: () => true, focusedId: () => 'captain', lastTurnTs: () => now - 30 * 60_000,
    archiveColumn: (c) => { columns.splice(columns.indexOf(c), 1); archived.push({ ...c }); }, columnLabel: (c) => c.title || c.id, userComposing: () => false,
    agentInForeground: async () => true, sendWhenReady() {}, dumpScreen: (term) => term.screen,
    screenState: () => 'done',
  });
  s.tasks.push({ id: 'task-1', colId: worker.id, gen: 3, status: 'working', title: 'probe', startedAt: now - 600_000, sentAt: now - 600_000, instructionSent: true });
  return { api: window.MainSession, s, captain, worker, keys };
}

for (const action of ['main-archive', 'main-stop']) {
  test(`${action} keeps the worker's unread complete receipt for the Captain`, async () => {
    const w = world();
    await w.api.submit({ action: 'complete', result: '做完了，报告 /tmp/report.md', files: ['/tmp/report.md'] }, w.worker);
    assert.equal(w.s.pending.length, 1, 'precondition: the real result is waiting for the Captain');
    await w.api.handle({ action, to: 'worker' }, w.captain);
    assert.deepEqual([...w.s.pending.map((p) => p.summary)], ['做完了，报告 /tmp/report.md'],
      'the finished task\'s real receipt was thrown away unread');
  });

  test(`${action} keeps an unread ask and drops the automatic notices`, async () => {
    const w = world();
    await w.api.submit({ action: 'ask', question: '用哪个分支做基线？' }, w.worker);
    w.s.pending.push({ taskId: 'task-1', colId: 'worker', title: 'probe', ts: 1, waiting: 'Do you want to proceed?' },
      { taskId: 'task-1', colId: 'worker', title: 'probe', ts: 2, summary: '已结束，未提交回执', source: 'fallback' },
      { taskId: 'other', colId: 'elsewhere', title: 'x', ts: 3, summary: '别的会话的回执', source: 'command' });
    await w.api.handle({ action, to: 'worker' }, w.captain);
    assert.deepEqual([...w.s.pending.map((p) => p.question || p.summary)], ['用哪个分支做基线？', '别的会话的回执']);
  });
}
