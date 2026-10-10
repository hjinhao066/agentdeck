'use strict';
// 已结束，未提交回执 is provisional: when the worker carries on, the status tick (or a later
// session-exit) reopens the task. A closed task keeps the generation of the Captain it was closed
// under, and push() drops every receipt whose task.gen is not the current one. The Captain's
// context is cleared several times a day (清空上下文, Relay, 省 token), so a reopened task must
// join the current generation, as reopenAfterQuota does; otherwise the worker's real 回执, its
// crash or its dead terminal never reaches the Captain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const IDLE = '⏺ All done.\n❯ \n  ⏵⏵ bypass permissions on';
const WORKING = '✻ Cogitating… (12s · esc to interrupt)\n❯ \n  ⏵⏵ bypass permissions on';

function world() {
  let now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: false };
  const columns = [captain, worker];
  // gen 3: the Captain's context was cleared twice since the task was closed under gen 1
  const s = { colId: 'captain', gen: 3, tasks: [], pending: [], inflight: [], waitlist: [] };
  const entry = { alive: true, state: 'done', lastOutputAt: now, lastScreen: IDLE, term: { screen: IDLE } };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const window = {
    MainCore: M, BoardCore: B,
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {}, taskBoard: (op) => Promise.resolve(op === 'list' ? [] : { card: {}, notices: [] }) },
    ChatUI: { hasDraft: () => false, updateCard() {}, turnsOf: () => [], captainArchives: () => [], sendPrompt: async () => true },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, setTimeout, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: s, archived: [], folders: [] }, terms, columns: () => columns, saveConfig() {},
    isBackstage: () => false, focusedId: () => 'captain', lastTurnTs: () => now - 30 * 60_000,
    archiveColumn() {}, columnLabel: (c) => c.title || c.id, userComposing: () => false,
    agentInForeground: async () => true, sendWhenReady() {}, dumpScreen: (term) => term.screen,
    screenState: (text) => (/…\s*\(.*esc to interrupt/.test(text) ? 'working' : 'done'),
  });
  const screen = (state, text) => { if (state === 'working') entry.lastOutputAt = now; entry.state = state; entry.lastScreen = text; entry.term.screen = text; };
  // The task as the old Captain left it: closed by the three-minute no-command notice, which that
  // Captain's listener already read (so the clear did not carry it to the new generation).
  const task = { id: 'task-1', colId: worker.id, gen: 1, status: 'stopped', title: 'probe', startedAt: now - 600_000, sentAt: now - 600_000,
    instructionSent: true, endedAt: now - 400_000, doneAt: now - 220_000,
    receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } };
  s.tasks.push(task);
  return { api: window.MainSession, s, worker, entry, task, screen, tick: () => window.MainSession.onTick(worker.id, entry), advance(ms) { now += ms; } };
}

test('a worker that carries on after 已结束，未提交回执 gets its real 回执 to the current Captain', async () => {
  const w = world();
  w.screen('working', WORKING);
  w.tick();
  assert.equal(w.task.status, 'working', 'the provisional notice is voided once the terminal works again');
  w.screen('done', IDLE);
  await w.api.submit({ action: 'complete', result: '做完了，报告在 /tmp/r.md' }, w.worker);
  assert.equal(w.task.status, 'done');
  assert.deepEqual([...w.s.pending.map((p) => p.summary)], ['做完了，报告在 /tmp/r.md'],
    'the complete reached nobody: push() dropped it because the reopened task still has gen 1');
});

test('a terminal that dies after 已结束，未提交回执 reaches the current Captain as a failure', () => {
  const w = world();
  w.entry.alive = false;
  w.tick();
  assert.equal(w.task.status, 'failed');
  assert.equal(w.s.pending.length, 1, 'the dead-terminal receipt was dropped for the old generation');
});

test('a worker that crashes after 已结束，未提交回执 reaches the current Captain as a failure', async () => {
  const w = world();
  w.entry.term.screen = '$ ';
  await w.api.submit({ action: 'session-exit', code: 1 }, w.worker);
  assert.equal(w.task.status, 'failed');
  assert.equal(w.s.pending.length, 1, 'the exit receipt was dropped for the old generation');
  assert.match(w.s.pending[0].failed, /exit 1/);
});
