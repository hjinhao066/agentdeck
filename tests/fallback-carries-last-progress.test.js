'use strict';
// A worker that ends its turn right after `progress --message "已暂停，等 21:10 额度恢复后继续"`
// has still submitted no receipt (complete/ask), so three minutes later it is reported as
// 「已结束，未提交回执」 as before. The notice now carries the task's last progress, so the
// Captain reads why the worker stopped. On the live Mac 2026-10-09, 12 of the 13 fallback notices
// on record had a progress for that very task, 9 of them saying it was waiting or paused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const IDLE = '⏺ 已暂停。\n❯ \n  ⏵⏵ bypass permissions on';

function world() {
  let now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd: 'claude', captainCrew: false };
  const columns = [captain, worker];
  const s = { colId: 'captain', gen: 3, tasks: [], pending: [], inflight: [], waitlist: [] };
  const entry = { alive: true, state: 'working', lastOutputAt: now, lastScreen: '✻ Cogitating… (2s · esc to interrupt)', term: { screen: '' } };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const turn = { id: 'turn-1', done: false, user: '先停下，21:10 额度恢复后再继续', reply: '' };
  const window = {
    MainCore: M, BoardCore: B,
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {}, taskBoard: (op) => Promise.resolve(op === 'list' ? [] : { card: {}, notices: [] }) },
    ChatUI: { hasDraft: () => false, updateCard() {}, turnsOf: (id) => (id === worker.id ? [turn] : []), captainArchives: () => [], sendPrompt: async () => true },
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
  const task = { id: 'task-1', colId: worker.id, gen: 3, status: 'working', title: 'probe', startedAt: now, sentAt: now, instructionSent: true, supplement: true, turnId: turn.id };
  s.tasks.push(task);
  const api = window.MainSession, tick = () => api.onTick(worker.id, entry);
  // The turn ends; three minutes pass without a complete or ask.
  const endTurn = () => {
    turn.done = true; entry.state = 'done'; entry.lastScreen = IDLE;
    tick(); now += 3 * 60_000 + 1000; tick();
    return s.pending.filter((p) => p.taskId === task.id);
  };
  return { api, worker, task, endTurn };
}

test('已结束，未提交回执 after a progress carries the worker\'s last progress', async () => {
  const w = world();
  await w.api.submit({ action: 'progress', message: '先看日志' }, w.worker);
  await w.api.submit({ action: 'progress', message: '已暂停，等 21:10 额度恢复后继续' }, w.worker);
  const notices = w.endTurn();
  assert.equal(w.task.status, 'stopped', 'still the no-receipt notice: progress is not a receipt');
  assert.deepEqual([...notices.map((p) => p.source)], ['fallback']);
  assert.match(notices[0].summary, /^已结束，未提交回执/);
  assert.ok(notices[0].summary.includes('已暂停，等 21:10 额度恢复后继续'), `the Captain got: ${notices[0].summary}`);
  assert.ok(!notices[0].summary.includes('先看日志'), 'only the last progress');
});

test('without a progress the notice stays the bare 已结束，未提交回执', () => {
  const w = world();
  const notices = w.endTurn();
  assert.deepEqual([...notices.map((p) => p.summary)], ['已结束，未提交回执']);
});
