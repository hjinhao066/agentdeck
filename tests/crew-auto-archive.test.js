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
function runtime({ tasks, entry = {}, col = {}, cards = [], pending = [], focused = '' }) {
  const archived = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true, ...col };
  const term = { alive: true, state: 'plain', lastOutputAt: NOW - 30 * MIN, lastScreen: '', ...entry };
  const terms = new Map([[captain.id, { alive: true, state: 'done' }], [worker.id, term]]);
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
  });
  // one heartbeat; a second one after the card list had time to arrive
  const tick = async () => { window.MainSession.onTick(worker.id, term); await new Promise(setImmediate); window.MainSession.onTick(worker.id, term); };
  return { archived, tick, term, state };
}
const done = (extra) => ({ id: 't', colId: 'worker', status: 'done', sentAt: NOW - 60 * MIN, doneAt: NOW - 40 * MIN, ...extra });
const failed = (extra) => done({ status: 'failed', receipt: { failed: '额度用尽' }, ...extra });

test('after a restart a finished session (fresh terminal, never worked this run) is archived', async () => {
  const r = runtime({ tasks: [done()] });
  await r.tick();
  assert.deepEqual(r.archived, ['worker']);
});

test('after a restart a session whose terminal is still printing is left alone until it goes quiet', async () => {
  const r = runtime({ tasks: [done()], entry: { lastOutputAt: NOW - 5_000 } });
  await r.tick();
  assert.deepEqual(r.archived, []);
  r.term.lastOutputAt = NOW - 2 * MIN;
  await r.tick();
  assert.ok(r.archived.length > 0);
});

test('a session working, waiting on a confirmation or quota is never archived', async () => {
  for (const state of ['working', 'input', 'quota']) {
    const r = runtime({ tasks: [done()], entry: { state } });
    await r.tick();
    assert.deepEqual(r.archived, [], state);
  }
  const busy = runtime({ tasks: [done()], entry: { lastScreen: '✻ Doing…' } });
  await busy.tick();
  assert.deepEqual(busy.archived, [], 'screen shows work');
  const sending = runtime({ tasks: [done()], entry: { sendingPrompt: true } });
  await sending.tick();
  assert.deepEqual(sending.archived, []);
});

test('an unread receipt, an open card, a manual terminal or the one you look at is never archived', async () => {
  const cases = {
    'unread receipt': { tasks: [done()], pending: [{ taskId: 't', colId: 'worker' }] },
    'supplement waiting': { tasks: [done(), done({ id: 't2', status: 'queued', sentAt: NOW - MIN })] },
    'still working card': { tasks: [done(), done({ id: 't2', status: 'working', sentAt: NOW - MIN })] },
    'asking 队长': { tasks: [done({ status: 'asking' })] },
    'manual terminal': { tasks: [done()], col: { captainCrew: false } },
    'focused': { tasks: [done()], focused: 'worker' },
    'finished minutes ago': { tasks: [done({ sentAt: NOW - 2 * MIN, doneAt: NOW - MIN })] },
  };
  for (const [name, input] of Object.entries(cases)) {
    const r = runtime(input);
    await r.tick();
    assert.deepEqual(r.archived, [], name);
  }
});

test('a session whose terminal exited is archived by the same rule', async () => {
  const r = runtime({ tasks: [done()], entry: { alive: false, state: 'exited' } });
  await r.tick();
  assert.ok(r.archived.length > 0);
});

test('a failed or stopped session stays while nobody has taken over and its card is not done', async () => {
  for (const status of ['failed', 'stopped']) {
    const cases = {
      'no card at all': { tasks: [failed({ status })], cards: [] },
      'card still open, bound to itself': { tasks: [failed({ status, boardId: 'c1' })], cards: [{ id: 'c1', status: 'doing', session_id: 'worker' }] },
      'card sent back to todo': { tasks: [failed({ status, boardId: 'c1' })], cards: [{ id: 'c1', status: 'todo', session_id: null }] },
      'card unknown': { tasks: [failed({ status, boardId: 'c1' })], cards: [] },
      'another card, another session': { tasks: [failed({ status, boardId: 'c1' }), done({ id: 'o', colId: 'other', boardId: 'c2', sentAt: NOW - 30 * MIN })], cards: [{ id: 'c1', status: 'doing', session_id: 'worker' }] },
    };
    for (const [name, input] of Object.entries(cases)) {
      const r = runtime(input);
      await r.tick();
      assert.deepEqual(r.archived, [], `${status}: ${name}`);
    }
  }
});

test('a failed or stopped session is archived once its card is done or another session has the card', async () => {
  for (const status of ['failed', 'stopped']) {
    const cases = {
      'card done': { tasks: [failed({ status, boardId: 'c1' })], cards: [{ id: 'c1', status: 'done', session_id: 'other' }] },
      'card archived': { tasks: [failed({ status, boardId: 'c1' })], cards: [{ id: 'c1', status: 'doing', archived: true }] },
      'a later session took the card (task record)': { tasks: [failed({ status, boardId: 'c1' }), done({ id: 'o', colId: 'other', boardId: 'c1', status: 'working', sentAt: NOW - 30 * MIN })], cards: [{ id: 'c1', status: 'doing', session_id: 'worker' }] },
      'a later session took the card (card binding)': { tasks: [failed({ status, boardId: 'c1' })], cards: [{ id: 'c1', status: 'doing', session_id: 'other' }] },
    };
    for (const [name, input] of Object.entries(cases)) {
      const r = runtime(input);
      await r.tick();
      assert.ok(r.archived.length > 0, `${status}: ${name}`);
    }
  }
});

test('a failed session whose card went to another session earlier than its own try is not counted as handled', () => {
  const s = { tasks: [failed({ boardId: 'c1', sentAt: NOW - 20 * MIN }), done({ id: 'o', colId: 'other', boardId: 'c1', sentAt: NOW - 90 * MIN })] };
  assert.equal(M.archivable({ ...s, pending: [] }, 'worker', 0, NOW, M.ARCHIVE_AFTER, { c1: { status: 'doing', session_id: 'worker' } }), false);
});

test('a failed session in the 10 quiet minutes is kept even if the card is done', () => {
  const s = { tasks: [failed({ boardId: 'c1', doneAt: NOW - 2 * MIN })] };
  assert.equal(M.archivable(s, 'worker', 0, NOW, M.ARCHIVE_AFTER, { c1: { status: 'done' } }), false);
});
