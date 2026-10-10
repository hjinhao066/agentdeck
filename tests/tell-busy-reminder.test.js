'use strict';
// An instruction added to a worker that is still in its turn waits (待补充) and goes in when the
// turn is over. 2026-10-09: such additions waited up to 52 minutes, mostly behind a worker whose
// Bash call sat in the machine-wide E2E queue, and the Captain heard nothing for the first 30.
// After 5 minutes the Captain now gets one notice saying why (the turn still running, for how
// long, the worker's last progress) and that `tell --now` is the way for something urgent.
// Delivery itself still waits for the turn to end. Real dispatch + real sendWhenReady.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const CMD = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const RULE = '─'.repeat(30);
const BUSY = ['⏺ 在跑测试。', '', '✻ Churning… (23m 10s · esc to interrupt)', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function world() {
  let now = 10_000_000_000;
  const captain = { id: 'captain', isMain: true, cmd: CMD };
  const col = { id: 'worker', cmd: CMD };
  const columns = [captain, col], timers = [], delivered = [];
  const s = { colId: captain.id, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  // The task it has been working on for 23 minutes, with its own last progress.
  s.tasks.push({ id: 'first', colId: col.id, gen: 1, status: 'working', title: '修 bug', startedAt: now - 23 * 60_000, sentAt: now - 23 * 60_000,
    instructionSent: true, progress: '单测过了，在等全机 E2E 锁' });
  const config = { mainSession: s };
  const entry = { alive: true, hasWorked: true, state: 'working', lastOutputAt: now, lastScreen: BUSY, foreground: true };
  const terms = new Map([[col.id, entry]]);
  const window = { MainCore: M, BoardCore: B, deck: { saveConfigSync() {}, onTaskStart() {}, onTaskReview() {}, onTaskRework() {} }, ChatUI: {
    addCard() {}, updateCard() {}, turnsOf: () => [],
    async sendPrompt(_col, text) { delivered.push(text); return { id: 'turn-' + delivered.length }; },
  } };
  const context = vm.createContext({ window, ChatUI: window.ChatUI, MainCore: M, columns, terms,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
    env: { platform: 'darwin' }, userComposing: () => false,
    agentInForeground: async (c) => terms.get(c.id)?.foreground,
  });
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
  vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  entry.state = context.classify(BUSY, entry, CMD);
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; }, dispatch };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config, columns: () => columns, terms, saveConfig() {}, columnLabel: (c) => c.id,
    sendWhenReady: context.sendWhenReady, showToast() {} });
  return {
    s, entry, delivered,
    dispatch: (text) => window.__test.dispatch(col, text, '队长 tell'),
    // Time moves, then the waiting send loop takes one look.
    async advance(ms) { now += ms; entry.lastOutputAt = now; const due = timers.splice(0); for (const fn of due) await fn(); await flush(); },
  };
}

test('a tell waiting on a busy worker tells the Captain why after 5 minutes, once, and still waits', async () => {
  const w = world();
  assert.equal(w.entry.state, 'working');
  const task = w.dispatch('补充：顺手把 README 也改了');
  await flush();
  await w.advance(4 * 60_000 + 50_000);
  assert.deepEqual([...w.s.pending], [], 'nothing before 5 minutes');
  await w.advance(15_000);
  const notices = w.s.pending.filter((p) => p.taskId === task.id);
  assert.equal(notices.length, 1, 'one notice after 5 minutes');
  const text = notices[0].summary;
  assert.match(text, /5 分钟/);
  assert.match(text, /终端仍显示在干活/);
  assert.match(text, /队员这一轮已跑 28 分钟/, text);
  assert.match(text, /单测过了，在等全机 E2E 锁/, 'the worker\'s own last progress');
  assert.match(text, /tell --now/);
  assert.equal(w.delivered.length, 0, 'delivery still waits for the turn to end');
  assert.equal(task.status, 'queued');
  await w.advance(40 * 60_000);
  assert.equal(w.s.pending.filter((p) => p.taskId === task.id).length, 1, 'a single reminder');
});

test('when something else holds it (a quota wait), the notice names that instead', async () => {
  const w = world();
  w.s.tasks.find((t) => t.id === 'first').status = 'quota';
  w.entry.state = 'quota'; w.entry.lastScreen = '⚠ Usage limit reached · limit resets 9pm';
  const task = w.dispatch('补充：再看一眼');
  await flush();
  await w.advance(5 * 60_000 + 1000);
  const notices = w.s.pending.filter((p) => p.taskId === task.id);
  assert.equal(notices.length, 1);
  assert.match(notices[0].summary, /额度/);
  assert.doesNotMatch(notices[0].summary, /这一轮已跑/);
});
