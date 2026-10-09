'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const MIN = 60_000;
const NOW = Date.now();

// A background session as it is right after AgentDeck restarted: a fresh
// terminal (state 'plain', nothing worked this run) holding an old, closed task.
function runtime({ tasks, entry = {}, col = {}, cards = [], pending = [], focused = '', hasBackgroundProcess = false }) {
  const archived = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true, ...col };
  const term = { alive: true, state: 'plain', lastOutputAt: NOW - 30 * MIN, lastScreen: '', ...entry };
  // Add a way to track if this session has background processes
  if (hasBackgroundProcess) {
    term._hasBackgroundProcess = true;
  }
  const terms = new Map([[captain.id, { alive: true, state: 'done' }], [worker.id, term]]);
  const dumpScreenCalls = [];
  // Add a term reference to the entry so dumpScreen can be called
  term.term = term;
  const window = {
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, taskBoard: (op) => Promise.resolve(op === 'list' ? cards : {}) },
    MainCore: M, BoardCore: B, ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const state = { colId: captain.id, tasks, pending, inflight: [], waitlist: [] };
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, saveConfig() {}, columns: () => [captain, worker], terms,
    userComposing: () => false, columnLabel: (c) => c.id, isBackstage: (c) => !!c.captainCrew && !c.isMain,
    focusedId: () => focused, lastTurnTs: () => NOW - 30 * MIN,
    archiveColumn: (c) => { if (!archived.includes(c.id)) archived.push(c.id); },
    // Add dumpScreen method to simulate live terminal check
    dumpScreen: (t, lines) => {
      dumpScreenCalls.push({ hasBackground: t._hasBackgroundProcess });
      if (t._hasBackgroundProcess) {
        // Simulate showing background processes in live screen with proper prompt format
        return 'some output\n❯\n1 monitor still running';
      }
      return '❯ ';
    },
    screenState: (screen) => {
      if (screen && screen.includes('still running')) return 'working';
      return 'done';
    },
  });
  // one heartbeat; a second one after the card list had time to arrive
  const tick = async () => { window.MainSession.onTick(worker.id, term); await new Promise(setImmediate); window.MainSession.onTick(worker.id, term); };
  return { archived, tick, term, state, dumpScreenCalls };
}
const done = (extra) => ({ id: 't', colId: 'worker', status: 'done', sentAt: NOW - 60 * MIN, doneAt: NOW - 40 * MIN, ...extra });

test('Issue #1: a session with background processes is not archived even if lastScreen is empty', async () => {
  // This test should fail with the current code because it archives the session
  // even though it has background processes running
  const r = runtime({ tasks: [done()], hasBackgroundProcess: true });
  await r.tick();
  // The session should NOT be archived because it has background processes
  assert.deepEqual(r.archived, [], 'session with background processes should not be archived');
});

test('Issue #2: binding should clear active review_session', () => {
  const os = require('os');
  const { TaskStore } = require('../task-board');

  // Create a temporary directory for the task store
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-session-test-'));
  const store = new TaskStore(root, { sessions: () => [
    // Simulating an active review session
    { id: 'review-1', archived: false, active: true, boardId: undefined }
  ] });

  try {
    // Create a card
    const result1 = store.add({
      project: 'test',
      title: 'test card',
      detail: 'test',
      verify: true
    });
    const card = result1.card;

    // Simulate moving to doing and binding to an executor
    store.move({ id: card.id, status: 'doing' });
    const executor = store.bind({
      id: card.id,
      project: 'test',
      session_id: 'exec-1',
      attempt_id: 'attempt-1',
      assignee: { agent: 'Claude', model: 'default' }
    });

    // Now manually set review_session=true to simulate an active review
    store.mutate((docs) => {
      const c = store.find(docs, card.id);
      c.review_session = true;
      c.review_verdict = true;
      c.review_round = 1;
      c.status = 'review';
      return {};
    });

    let updated = store.list({ archived: true }).find(c => c.id === card.id);
    assert.equal(updated.review_session, true, 'setup: card has active review_session');

    // NOW: trying to bind to a new execution
    // With the fix, it should clear review_session and allow the bind
    // Without the fix, it should throw an error
    let caughtError = false;
    try {
      const rework = store.bind({
        id: card.id,
        project: 'test',
        session_id: 'exec-2',
        attempt_id: 'attempt-2',
        assignee: { agent: 'Claude', model: 'default' }
      });
      // If we get here, the fix is working - review_session was cleared
      assert.equal(rework.card.review_session, false, 'review_session should be false after rework bind');
      assert.equal(rework.card.session_id, 'exec-2', 'should bind to new executor');
    } catch (e) {
      // With current code (before fix): "Card already has an active execution or verification session"
      caughtError = true;
    }

    // The fix should ensure we get here without catching an error
    assert.equal(caughtError, false, 'bind should succeed after clearing review_session (this will fail before the fix is applied)');
  } finally {
    // Cleanup
    fs.rmSync(root, { recursive: true, force: true });
  }
});
