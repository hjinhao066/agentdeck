'use strict';
// 10-09 11:04: a Claude worker (c-board-mv19vcwa91nbzy) ended its turn while 3 background
// agents ran, and AgentDeck sent 已结束，未提交回执 three minutes later; the card left 进行中.
// Claude's live area read "✻ Waiting for 3 background agents to finish", but its SendFeedback
// panel ("Bug report drafted … 1 to review · 2 to send · 0 to dismiss", a 12-row box) stood
// between that row and the prompt, and stays there until the user deals with it. The status
// row only counts with nothing but blank rows and rules under it, so every later turn with
// background work was misread the same way. Layout below is that screen (29 columns, the
// last 40 rows of 50) with the reply and the report replaced by neutral words.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const TOP = [
  '⏺ The three searches are still',
  '  running in the background.',
  '  I will wait for their real',
  '  completion notices.',
  '              ',
  '✻ Waiting for 3 background ',
  '  agents to finish',
  '',
];
const BOX = [
  '╭───────────────────────────╮',
  '│ ✻ Bug report drafted: Mo… │',
  '│ │ - What happened: While  │',
  '│ │ 3 background research   │',
  '│ │ agents were running,    │',
  '│ │ the model wrote text    │',
  '│ │ shaped like a           │',
  '│ │ notification            │',
  '│ │   …                     │',
  '│ 1 to review · 2 to send · │',
  '│ 0 to dismiss              │',
  '╰───────────────────────────╯',
  '     ',
  '',
];
const PROMPT = [
  '─────────────────────────────',
  '❯ ',
  '─────────────────────────────',
  '  Opus 5h 97%',
  '  ░░░░░ 8% 78k/1M  ⎇ 0',
  '  ⏵⏵ bypass permissions on ',
  '',
  '  ⏺ main',
  '  ◯ general-purpose 1m 17s · ',
  '  ◯ general-purpose ↓1m 3s · ',
];
const filler = (n) => Array.from({ length: n }, (_, i) => `  earlier output row ${i + 1}`);
// dumpScreen keeps the last 40 rows of the 50-row terminal
const screen = (rows) => [...filler(40), ...rows].slice(-40).join('\n');
const UNDER_BOX = screen([...TOP, ...BOX, ...PROMPT]);

test('control: without the panel the background agents are seen', () => {
  assert.equal(M.claudeBackgroundTasks(screen([...TOP, ...PROMPT]), CMD), true);
});

test('the SendFeedback panel between the wait row and the prompt does not hide the background agents', () => {
  assert.equal(M.claudeBackgroundTasks(UNDER_BOX, CMD), true);
  // a completed-turn row counting a shell, under the same panel
  const shell = [...TOP.slice(0, 5), '✻ Baked for 40s · done 11:04', '  AM · 1 shell still running', ''];
  assert.equal(M.claudeBackgroundTasks(screen([...shell, ...BOX, ...PROMPT]), CMD), true);
});

test('the panel is set aside only as a whole box right above the prompt: later rows still make the wait row history', () => {
  // a reply after the panel is a newer turn
  const later = ['⏺ All three agents are done.', ''];
  assert.equal(M.claudeBackgroundTasks(screen([...TOP, ...BOX, ...later, ...PROMPT.slice(0, 6)]), CMD), false);
  // a box cut at the top of the screen is not taken away
  assert.equal(M.claudeBackgroundTasks(screen([...TOP, ...BOX.slice(1), ...PROMPT]), CMD), false);
  // no status row at all under the panel: nothing running
  const done = ['⏺ Done, receipt submitted.', '', '✻ Baked for 40s · done 11:04 AM', ''];
  assert.equal(M.claudeBackgroundTasks(screen([...done, ...BOX, ...PROMPT]), CMD), false);
});

// ---- the worker's session: the missing-receipt clock (main-session.js) ----
function runtime({ task, entry, turns }) {
  const boardEvents = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const col = { id: 'worker', cmd: CMD };
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

test('a finished turn waiting on background agents under the panel is not 已结束，未提交回执', async () => {
  const QUIET = 10 * 60_000;
  const turns = [{ id: 'turn', done: true }];
  const task = { id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1 };
  const entry = { alive: true, state: 'done', lastOutputAt: Date.now() - QUIET, lastScreen: UNDER_BOX };
  const { api, col, boardEvents } = runtime({ task, entry, turns });
  api.onTurnDone(col.id, turns[0]);
  task.endedAt = Date.now() - QUIET;
  api.onTick(col.id, entry);
  assert.equal(task.status, 'working');
  assert.equal(task.receipt, undefined);
  await new Promise(setImmediate);
  assert.equal(boardEvents.some((e) => e.input?.type === 'fallback'), false);
});
