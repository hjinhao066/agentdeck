'use strict';
// `tell` brings an archived background session back by itself. A `new --worktree` worker's copy is
// removed once it is archived, clean and its branch pushed or merged, and settleArchivedWorktree
// then points the archived entry's cwd at worktree.repo, the main checkout. Restoring it there
// would put its old conversation (about the copy and its branch) to work on the user's main
// checkout or the shared ~/.agents repo. Such a worker is not restored: the Captain is told why
// and to dispatch again with `new --worktree`. Nothing is queued, nothing is written to the board.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const REPO = '/Users/jinhao/agentdeck';
const COPY = { repo: REPO, path: '/Users/jinhao/agentdeck-worktrees/agentdeck/fix-x', branch: 'fix-x', base: 'origin/release/2.0.4', removed: true, reason: '' };

function world(entry) {
  const now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const columns = [captain], restored = [], boardCalls = [];
  const archived = [{ id: 'worker', title: '修 bug', cmd: 'claude --model claude-opus-5-5', captainCrew: true, claudeSeatId: 'default',
    modelSessionId: '0b8e1b2c-1111-4222-8333-944455556666', archivedAt: now - 3600_000, ...entry }];
  const s = { colId: 'captain', gen: 3, tasks: [], pending: [], inflight: [], waitlist: [] };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }]]);
  const window = {
    MainCore: M, BoardCore: B,
    ClaudeSeatsCore: { launchBlock: () => '' },
    TaskBoard: { list: async () => [] },
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {}, claudeSeats: async () => [], saveConfigSync: () => true,
      taskBoard: (op, input) => { boardCalls.push(op); return Promise.resolve(op === 'list' ? [] : { card: {}, notices: [] }); } },
    ChatUI: { hasDraft: () => false, updateCard() {}, addCard() {}, turnsOf: () => [], captainArchives: () => [], sendPrompt: async () => true },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, setTimeout, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const config = { mainSession: s, archived, folders: [], columns };
  window.MainSession.init({
    config, terms, columns: () => columns, saveConfig() {},
    isBackstage: () => true, focusedId: () => 'captain', lastTurnTs: () => now - 30 * 60_000,
    archiveColumn() {}, columnLabel: (c) => c.title || c.id, userComposing: () => false,
    agentInForeground: async () => true, sendWhenReady() {}, dumpScreen: () => '',
    restoreArchived: (id) => {
      const a = config.archived.find((x) => x.id === id);
      if (!a) return null;
      config.archived = config.archived.filter((x) => x !== a);
      const { archivedAt, ...col } = a;
      columns.push(col); restored.push(col);
      return col;
    },
  });
  const tell = () => window.MainSession.handle({ action: 'main-tell', id: 'req-1', to: 'worker', message: '先 rebase 到 origin/release/2.0.5 再推送' }, captain);
  return { tell, s, config, restored, boardCalls };
}

for (const [name, entry] of [
  ['copy was removed', { cwd: REPO, worktree: COPY }],
  ['cwd already points at the main checkout', { cwd: REPO, worktree: { ...COPY, removed: false } }],
]) {
  test(`tell refuses to restore a worker whose ${name}, and says why`, async () => {
    const w = world(entry);
    await assert.rejects(w.tell(), (error) => /副本/.test(error.message) && /new --worktree/.test(error.message) && error.message.includes(REPO));
    assert.deepEqual(w.restored.map((c) => c.id), [], 'not brought back into the main checkout');
    assert.deepEqual(w.config.archived.map((a) => a.id), ['worker'], 'still archived');
    assert.equal(w.s.tasks.length, 0, 'nothing queued');
    assert.deepEqual(w.boardCalls.filter((op) => op !== 'list'), [], 'nothing is written to the board');
  });
}

test('other archived workers are still restored by tell, a live copy included', async () => {
  for (const entry of [{ cwd: '/tmp/project' }, { cwd: COPY.path, worktree: { ...COPY, removed: false } }]) {
    const w = world(entry);
    const result = await w.tell();
    assert.equal(result.done, true);
    assert.deepEqual(w.restored.map((c) => c.id), ['worker']);
    assert.equal(w.s.tasks.length, 1);
  }
});
