'use strict';
// Second false 已结束，未提交回执 for c-board-mv1x25yc821s0t (2026-10-09): one of its Bash tool calls was waiting in the
// machine-wide E2E queue (`npm run e2e` → scripts/e2e-queue.js, "排队中，前面还有 5 组"), so the screen stayed the same
// for a long time and the three-minute fallback called the turn over. A command Claude started is still running in
// the terminal's process tree (pty-work.js already reads it for the automatic archive): the turn is not over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const PtyWork = require('../pty-work');

const renderer = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const rctx = vm.createContext({ MainCore: M, env: { platform: 'darwin' } });
vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')), rctx);
const CMD = 'claude --dangerously-skip-permissions';
const RULE = '─'.repeat(36);
// Nothing on screen says the turn is running: no spinner row, a footer cut down to a bare count.
const STILL = ['  ⎿  Updated tests/e2e/sample.spec.js', '      362 +  // a changed line', '  Update available! Run: brew upg…', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · 2'].join('\n');

function runtime(work) {
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: CMD };
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - 600_000, lastScreen: STILL, term: {} };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard: () => Promise.resolve({}) },
    MainCore: M, BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: (id) => (id === worker.id ? [{ id: 'turn', done: true }] : []), updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const task = { id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1, endedAt: Date.now() - 600_000 };
  const asked = [];
  window.MainSession.init({
    config: { mainSession: { colId: captain.id, gen: 1, tasks: [task], pending: [], waitlist: [] }, folders: [] }, saveConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
    dumpScreen: () => STILL, screenState: (text, e, cmd) => rctx.classify(text, e, cmd), platform: 'darwin',
    ptyBackgroundWork: (col) => { asked.push(col.id); return work.value; },
  });
  return { api: window.MainSession, worker, entry, task, asked };
}

test('the screen reads idle, but the E2E queue a tool call waits in is still under the terminal: not ended', () => {
  assert.equal(rctx.classify(STILL, { state: 'done', hasWorked: true }, CMD), 'done', 'the screen alone looks finished');
  const work = { value: true };
  const r = runtime(work);
  r.api.onTick(r.worker.id, r.entry);
  assert.equal(r.task.status, 'working', 'reported 已结束 while its command was waiting in the queue');
  assert.equal(r.task.endedAt, 0);
  assert.deepEqual(r.asked, ['worker']);
  // the command has finished: the three minutes start again from now, then the usual notice
  work.value = false;
  r.api.onTick(r.worker.id, r.entry);
  assert.equal(r.task.status, 'working');
  r.task.endedAt = Date.now() - 4 * 60_000;
  r.api.onTick(r.worker.id, r.entry);
  assert.equal(r.task.status, 'stopped');
  assert.equal(r.task.receipt.summary, '已结束，未提交回执');
});

test('no answer from the process table yet: wait for it; a listing that failed leaves it to the screen', () => {
  const pending = runtime({ value: undefined });
  pending.api.onTick(pending.worker.id, pending.entry);
  assert.equal(pending.task.status, 'working');
  const failed = runtime({ value: null });
  failed.api.onTick(failed.worker.id, failed.entry);
  assert.equal(failed.task.status, 'stopped');
  assert.equal(failed.task.receipt.summary, '已结束，未提交回执');
});

test('pty-work counts a tool call waiting in the machine queue as work under the terminal', () => {
  const rows = PtyWork.parseProcessTable([
    '  100     1 /bin/zsh -l',
    '  200   100 claude --dangerously-skip-permissions',
    "  300   200 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run e2e -- tests/e2e/x.spec.js' < /dev/null",
    '  301   300 npm run e2e',
    '  302   301 node scripts/e2e-queue.js tests/e2e/x.spec.js',
  ].join('\n'), 'darwin');
  assert.deepEqual(PtyWork.shellWork(rows, 100).sort(), [300, 301, 302]);
});
