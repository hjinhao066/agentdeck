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

function runtime({ tasks, entry = {}, col = {}, cards = [], pending = [], focused = '', hostHasBackgroundProcess = false }) {
  const archived = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true, ...col };
  const term = { alive: true, state: 'plain', lastOutputAt: NOW - 30 * MIN, lastScreen: '', ...entry };
  term.term = term;  // Add self-reference for dumpScreen to work
  const terms = new Map([[captain.id, { alive: true, state: 'done' }], [worker.id, term]]);
  const dumpScreenCalls = [];
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
    focusedId: () => focused, lastTurnTs: () => NOW - 30 * MIN, archiveColumn: (c) => { if (!archived.includes(c.id)) archived.push(c.id); },
    dumpScreen: (t, lines) => {
      // Simulate dumpScreen that returns quiet screen (no "still running" text)
      // but the host knows there's a background process
      dumpScreenCalls.push({ hasBackground: hostHasBackgroundProcess });
      return '❯ ';  // Just a prompt, no background tasks indicator
    },
    screenState: (screen) => {
      return 'done';
    },
    hasChildProcesses: (t) => hostHasBackgroundProcess,  // Mock: tell if there's a real child process
  });
  const tick = async () => { window.MainSession.onTick(worker.id, term); await new Promise(setImmediate); window.MainSession.onTick(worker.id, term); };
  return { archived, tick, term, state, dumpScreenCalls };
}
const done = (extra) => ({ id: 't', colId: 'worker', status: 'done', sentAt: NOW - 60 * MIN, doneAt: NOW - 40 * MIN, ...extra });

test('Issue #1: a session with hidden background process (not shown in screen) should not be archived', async () => {
  // Simulate:
  // - Session is done (no task running in the worker session)
  // - Terminal state is 'plain' (idle)
  // - lastScreen is empty (no visible task indicator)
  // - BUT: The host (Electron main) knows there's actually a background process running
  //
  // Current behavior: maybeArchive archices the session because screen is empty
  // Expected behavior: With the fix, the session should NOT be archived if there's a real background process

  const r = runtime({
    tasks: [done()],
    hostHasBackgroundProcess: true,  // Simulate: host.checkHasChildProcesses() would return true
    entry: { lastOutputAt: NOW - 30 * MIN }  // Very quiet for 30 minutes
  });

  await r.tick();

  // This test demonstrates the current problem:
  // Even though hostHasBackgroundProcess=true, maybeArchive still archives the session
  // because it only checks the screen content, not the actual process tree.
  //
  // The fix would require adding a check for real child processes.
  assert.deepEqual(r.archived, [], 'session with hidden background process should not be archived');
});
