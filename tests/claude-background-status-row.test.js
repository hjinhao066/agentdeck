'use strict';
// 10-06 08:27: a Claude worker (c-board-muwt64vknlbuhw) finished its turn while a
// shell and a Monitor were still running, and AgentDeck sent 已结束，未提交回执
// twice. Claude Code puts the count on the completed-turn status row ABOVE the
// prompt's top rule; the custom status line under the prompt carries no count.
// Layouts below are the rows read off real sessions' terminal logs that day
// (a 55-column worker with "Update available!" under the status row, and the
// 90-column Captain's "✻ Churned for 2m 58s · done 9:24 AM · 1 shell still running").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const RULE = '───────────────────────────────────────────────────────';
const UPDATE = 'Update available! Run: brew upgrade c…';
const STATUS_LINE = ['Sonnet 5h 69%', '░░░░░░░░░░ ctx 41%'];
// What the worker screen looks like at the end of a turn.
const worker = (...above) => [...above, UPDATE, RULE, '❯ ', RULE, ...STATUS_LINE].join('\n');

const MONITOR = worker('  ⏺ 继续等包内 E2E，不重跑。', '', '✻ Baked for 1m 5s · done 8:27 AM · 1 monitor still running');
const SHELL = worker('  ⏺ 继续等测试。', '', '✻ Sautéed for 20s · done 9:07 AM · 1 shell still running');
const BOTH = worker('  ⏺ 继续等。', '', '✻ Churned for 2m 58s · done 9:24 AM · 1 shell, 1 monitor still running');
// A narrow column wraps the same row after a word, and Update sits right under it.
const BOTH_WRAPPED = worker('  ⏺ 继续等。', '', '✻ Baked for 40s · done 8:27 AM · 1', 'shell, 1 monitor still running');
const MONITOR_WRAPPED = worker('  ⏺ 继续等。', '', '✻ Baked for 40s · done 8:27 AM ·', '1 monitor still running');
const NONE = worker('  ⏺ 做完了，回执已提交。', '', '✻ Baked for 40s · done 8:27 AM');
// The tasks ended: the wake-up turn replied and left no count.
const AFTER_END = worker('✻ Baked for 40s · done 8:27 AM · 1 monitor still running', '', '  ⏺ 后台的 E2E 跑完了。', '', '✻ Brewed for 9s · done 8:41 AM');
// The Captain's layout: no rules, a blank row between status row and prompt.
const CAPTAIN_STYLE = '  ⏺ 现在只有这一个会话在干活。\n\n✻ Churned for 2m 58s · done 9:24 AM · 1 shell still running\n\n❯ \n\n  ⎇ 0';

test('the completed-turn status row above the prompt counts a running monitor, shell, or both', () => {
  for (const [name, screen] of [['monitor', MONITOR], ['shell', SHELL], ['both', BOTH], ['both, wrapped', BOTH_WRAPPED],
    ['monitor, wrapped', MONITOR_WRAPPED], ['no rules (Captain style)', CAPTAIN_STYLE]]) {
    assert.equal(M.claudeBackgroundTasks(screen, 'claude'), true, name);
  }
});

test('no background task: a finished turn reads idle', () => {
  assert.equal(M.claudeBackgroundTasks(NONE, 'claude'), false);
  assert.equal(M.claudeBackgroundTasks(NONE.replace(UPDATE + '\n', ''), 'claude'), false);
});

test('after the background tasks end, the old status row is history', () => {
  assert.equal(M.claudeBackgroundTasks(AFTER_END, 'claude'), false);
  // The same row followed by a new user message or a tool row is also history.
  const old = '✻ Baked for 40s · done 8:27 AM · 1 shell still running';
  assert.equal(M.claudeBackgroundTasks(worker(old, '', '❯ 继续', '', '  Ran 1 shell command'), 'claude'), false);
  assert.equal(M.claudeBackgroundTasks(worker(old, '', '  Ran 1 shell command'), 'claude'), false);
  assert.equal(M.claudeBackgroundTasks(worker(old, '', '  ⏺ 好了。'), 'claude'), false);
});

test('only a status row counts: prose, zero or finished counts, other agents do not', () => {
  for (const row of ['⏺ I saw 1 shell, 1 monitor still running', '  1 shell still running', '✻ Baked for 40s · done 8:27 AM · 0 shells still running',
    '✻ Baked for 40s · done 8:27 AM · 1 shell completed', '✻ Baked for 40s · done 8:27 AM · 1 shell, 1 monitor']) {
    assert.equal(M.claudeBackgroundTasks(worker('', row), 'claude'), false, row);
  }
  assert.equal(M.claudeBackgroundTasks(MONITOR, 'cursor-agent'), false);
  assert.equal(M.claudeBackgroundTasks(MONITOR, 'codex'), false);
  // A permission list is a question, not a wait.
  assert.equal(M.claudeBackgroundTasks(MONITOR.replace('❯ \n', '❯ 1. Allow\n'), 'claude'), false);
});

test('the footer under the prompt still counts, with or without a status row above', () => {
  assert.equal(M.claudeBackgroundTasks('❯ \n⏵⏵ bypass permissions on · 1 shell, 1 monitor still running', 'claude'), true);
  assert.equal(M.claudeBackgroundTasks(NONE + '\n⏵⏵ bypass permissions on · 1 monitor still running', 'claude'), true);
});

// ---- the worker's session: the missing-receipt clock ----
function runtime({ task, entry, turns }) {
  const boardEvents = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const col = { id: 'worker', cmd: B.commandForAgent('claude') };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [col.id, entry]]);
  const window = {
    deck: {
      saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      taskBoard(op, input) { boardEvents.push({ op, input }); return Promise.resolve({}); },
    },
    MainCore: M, BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: (id) => (id === col.id ? turns : []), updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const state = { colId: captain.id, gen: 1, tasks: [task], pending: [], waitlist: [] };
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, saveConfig() {},
    columns: () => [captain, col], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
  });
  return { api: window.MainSession, col, boardEvents };
}
const QUIET = 10 * 60_000;
const finishedTurn = [{ id: 'turn', done: true }];
const newTask = () => ({ id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1 });
const idleEntry = (lastScreen) => ({ alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen });
const flush = () => new Promise(setImmediate);

for (const [name, screen] of [['a monitor', MONITOR], ['a shell', SHELL], ['a shell and a monitor', BOTH], ['a wrapped status row', BOTH_WRAPPED]]) {
  test(`a finished turn waiting on ${name} past the quiet limit is not a missing receipt`, async () => {
    const task = newTask(), entry = idleEntry(screen);
    const { api, col, boardEvents } = runtime({ task, entry, turns: finishedTurn });
    task.endedAt = Date.now() - QUIET;
    api.onTick(col.id, entry);
    assert.equal(task.status, 'working');
    assert.equal(task.endedAt, 0);
    assert.equal(task.receipt, undefined);
    await flush();
    assert.equal(boardEvents.some((e) => e.input.type === 'fallback'), false);
  });
}

test('with no background task running, an idle finished turn still gets the missing-receipt notice', async () => {
  const task = newTask(), entry = idleEntry(NONE);
  const { api, col, boardEvents } = runtime({ task, entry, turns: finishedTurn });
  api.onTurnDone(col.id, finishedTurn[0]);
  task.endedAt = Date.now() - QUIET;
  api.onTick(col.id, entry);
  assert.equal(task.status, 'stopped');
  assert.equal(task.receipt.summary, '已结束，未提交回执');
  assert.equal(task.receipt.source, 'fallback');
  await flush();
  assert.equal(boardEvents.at(-1).input.type, 'fallback');
});

test('once the background tasks end without a receipt, the notice comes after a fresh quiet period', async () => {
  const task = newTask(), entry = idleEntry(MONITOR);
  const { api, col, boardEvents } = runtime({ task, entry, turns: finishedTurn });
  task.endedAt = Date.now() - QUIET;
  api.onTick(col.id, entry);
  assert.equal(task.status, 'working'); // held while the monitor runs
  // The monitor ended, the wake-up turn answered and again handed in nothing.
  entry.lastScreen = AFTER_END;
  entry.lastOutputAt = Date.now() - QUIET;
  api.onTick(col.id, entry);
  assert.equal(task.status, 'working'); // the grace restarts, no instant notice
  assert.ok(task.endedAt > Date.now() - 5000);
  task.endedAt = Date.now() - QUIET;
  api.onTick(col.id, entry);
  assert.equal(task.status, 'stopped');
  assert.equal(task.receipt.summary, '已结束，未提交回执');
  await flush();
  assert.equal(boardEvents.at(-1).input.type, 'fallback');
});
