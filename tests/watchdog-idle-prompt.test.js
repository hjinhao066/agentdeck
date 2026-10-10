'use strict';
// A crew member whose turn is over sits at its input box and waits for 队长 (a stage receipt handed in,
// waiting for 「齐了」; a receipt handed in, waiting for the user's nod). The screen shows no spinner
// (entry.state 'done'): nothing is being worked on, so "N minutes without output" is no news. Until now the
// silence watchdog (main-session.js onTick) only knew about background waits (71eaa32, 20f32ce) and sent
// 队长 「异常回执（长时间无输出）」 for every idle prompt after 20 minutes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');

const RULE = '───────────────────────────────────────────────────────';
// the member's screen at rest: last words, a bare input box, the status line under it
const IDLE = ['  ⏺ 阶段回执已交，等队长说「齐了」。', '', '✻ Baked for 41s · done 2:10 AM', RULE, '❯ ', RULE, 'Sonnet 5h 69%'].join('\n');
// a working Claude whose screen is static (deep thinking): the spinner row is there, nothing is drawn
const THINKING = ['  ⏺ 正在想。', '', '✻ Pondering… (12m 3s · esc to interrupt)', RULE, '❯ ', RULE, 'Sonnet 5h 69%'].join('\n');
// the real shape of a worker screen found idle 10-10 (text masked): turn over, bare input box, a status line
// under it, and NO background-shell count anywhere (footer cut): only the process tree knows a command still runs
const IDLE_WITH_HIDDEN_COMMAND = ['  - xxxxx/a31-xxxxxx-10s.mp4', '', '✻ Worked for 23m 5s · done 4:54 AM', '', '', '❯ ', '', '            7d 43', '             7   71      ⎇ xxxx*'].join('\n');
const WAITING = ['  ⏺ 继续等测试排队。', '', '✻ Baked for 27s · done 1:23 AM · 1 shell still running', RULE, '❯ ', RULE, 'Sonnet 5h 69%'].join('\n');

function world(cmd = 'claude') {
  let now = 10_000_000;
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const worker = { id: 'worker', cmd };
  const columns = [captain, worker], turns = [];
  const s = { colId: 'captain', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] };
  const terms = new Map([[worker.id, { alive: true, state: 'done', hasWorked: true, lastOutputAt: now, lastScreen: IDLE }]]);
  const window = { MainCore: M, BoardCore: B, deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, ptyInput() {} }, ChatUI: {
    hasDraft: () => false, updateCard() {}, turnsOf: () => turns, sendPrompt: async () => true,
  } };
  const context = vm.createContext({ window, setTimeout, Date: class extends Date { static now() { return now; } } });
  const source = fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8')
    .replace('  window.MainSession = {', '  window.__test = { setHost(h) { host = h; } };\n  window.MainSession = {');
  vm.runInContext(source, context);
  window.__test.setHost({ config: { mainSession: s }, terms, columns: () => columns, saveConfig() {},
    ptyBackgroundWork: () => w.work, isBackstage: () => true, focusedId: () => 'captain', lastTurnTs: () => 1, archiveColumn() {},
    columnLabel: (c) => c.id, userComposing: () => false, agentInForeground: async () => true });
  const entry = terms.get(worker.id);
  const w = {
    s, entry, turns, work: null,   // work: what the process-tree listing says (true / false / null unknown)
    task(extra = {}) { const t = { id: 'task-' + s.tasks.length, colId: worker.id, gen: 1, status: 'working', title: 'x', startedAt: now, sentAt: now, ...extra }; s.tasks.push(t); return t; },
    // the terminal draws nothing (only cursor queries) for `ms`
    quiet(ms) { for (let t = 0; t < ms; t += 2000) { now += 2000; if (M.drawsOutput('\x1b[?6n')) entry.lastOutputAt = now; window.MainSession.onTick(worker.id, entry); } },
    silent: () => s.pending.filter((p) => p.anomaly === 'no_output'),
    // the chat record shows this task's turn as over: the three-minute 已结束，未提交回执 fallback can speak for it
    finishTurn(t) { t.turnId = 'turn-' + t.id; turns.push({ id: t.turnId, done: true }); return t; },
  };
  return w;
}

test('waiting at the input box for 队长: no 「没有输出」 report, however long', () => {
  const w = world(), t = w.finishTurn(w.task());
  w.quiet(90 * 60_000);
  assert.deepEqual(w.silent().map((p) => p.summary), []);
  assert.equal(t.status, 'stopped', 'the fallback closed it, once');
});

test('waiting at the input box, with every agent that rests at a prompt', () => {
  for (const cmd of ['claude', 'codex', 'agy', 'cursor-agent']) {
    const w = world(cmd); w.finishTurn(w.task());
    w.quiet(60 * 60_000);
    assert.deepEqual(w.silent(), [], cmd);
  }
});

test('at the input box after handing in a receipt: nothing is reported', () => {
  const w = world();
  w.task({ status: 'done', doneAt: 1, receipt: { summary: '阶段回执', explicit: true, source: 'board' } });
  w.quiet(90 * 60_000);
  assert.deepEqual(w.silent(), []);
  assert.deepEqual(w.s.pending, []);
});

test('at the input box, turn over, no receipt and no question: told once (已结束，未提交回执), never every 20 minutes', () => {
  const w = world(), t = w.task({ turnId: 'turn-1' });
  w.turns.push({ id: 'turn-1', done: true });
  w.quiet(90 * 60_000);
  assert.deepEqual(w.silent(), []);
  const notices = w.s.pending.filter((p) => /已结束，未提交回执/.test(p.summary || ''));
  assert.equal(notices.length, 1);
  assert.equal(w.s.pending.length, 1, 'one notice, nothing else');
  assert.equal(t.status, 'stopped');
});

test('at the input box, but the fallback cannot speak (no finished turn on record): reported once after 20 minutes, never again', () => {
  const w = world(), t = w.task();
  w.quiet(19 * 60_000);
  assert.deepEqual(w.silent(), [], 'not before 20 minutes');
  w.quiet(2 * 60_000);
  assert.equal(w.silent().length, 1);
  assert.match(w.silent()[0].summary, /20 分钟/);
  w.quiet(3 * 3600_000);
  assert.equal(w.silent().length, 1, 'not repeated');
  assert.equal(t.status, 'working');
});

test('at the input box with a turn the captain interrupted: the fallback stays out, so it is reported once after 20 minutes', () => {
  const w = world(), t = w.task({ turnId: 'turn-i' });
  w.turns.push({ id: 'turn-i', done: true, interrupted: true });
  w.quiet(90 * 60_000);
  assert.equal(w.silent().length, 1);
});

test('really working (spinner on screen) but drawing nothing for 25 minutes: still reported', () => {
  const w = world(), t = w.task();
  w.entry.state = 'working'; w.entry.lastScreen = THINKING;
  w.quiet(25 * 60_000);
  assert.equal(w.silent().length, 1);
  assert.match(w.silent()[0].summary, /20 分钟/);
  assert.equal(t.status, 'working');
});

test('waiting on a background command: quiet for 25 minutes, reported after 3 hours (71eaa32, 20f32ce unchanged)', () => {
  const w = world(), t = w.task();
  w.entry.state = 'working'; w.entry.lastScreen = WAITING;
  w.quiet(25 * 60_000);
  assert.deepEqual(w.silent(), []);
  w.quiet(2.7 * 3600_000);
  assert.equal(w.silent().length, 1);
  assert.match(w.silent()[0].summary, /在等后台命令，已经 3 小时没有输出/);
  assert.equal(t.status, 'working');
});

test('a Claude that goes back to work after resting is watched again from its new output', () => {
  const w = world(); w.finishTurn(w.task());
  w.quiet(60 * 60_000);
  w.entry.state = 'working'; w.entry.lastScreen = THINKING;
  w.entry.lastOutputAt = 10_000_000 + 60 * 60_000;
  w.quiet(25 * 60_000);
  assert.equal(w.silent().length, 1);
});

test('at the input box, turn over, but the process tree still has a command running (the fallback is held off): quiet for 90 minutes, reported once at 3 hours as a background wait', () => {
  const w = world(), t = w.finishTurn(w.task());
  w.entry.lastScreen = IDLE_WITH_HIDDEN_COMMAND;
  assert.equal(M.claudeBackgroundTasks(IDLE_WITH_HIDDEN_COMMAND, 'claude'), false, 'the screen alone shows no background task');
  w.work = true;
  w.quiet(90 * 60_000);
  assert.deepEqual(w.silent(), [], 'no 20-minute notice');
  assert.equal(t.status, 'working', 'the fallback stays out while the command runs');
  w.quiet(1.4 * 3600_000);
  assert.deepEqual(w.silent(), [], 'still quiet before 3 hours');
  w.quiet(0.2 * 3600_000);
  assert.equal(w.silent().length, 1);
  assert.match(w.silent()[0].summary, /在等后台命令，已经 3 小时没有输出/);
  assert.doesNotMatch(w.silent()[0].summary, /20 分钟/);
  w.quiet(2 * 3600_000);
  assert.equal(w.silent().length, 1, 'only once');
  assert.equal(t.status, 'working');
});

test('the same screen and finished turn, command gone from the process tree: the fallback closes it once and no silence notice follows', () => {
  const w = world(), t = w.finishTurn(w.task());
  w.entry.lastScreen = IDLE_WITH_HIDDEN_COMMAND;
  w.work = false;
  w.quiet(90 * 60_000);
  assert.deepEqual(w.silent(), []);
  assert.equal(t.status, 'stopped');
  assert.equal(w.s.pending.filter((p) => /已结束，未提交回执/.test(p.summary || '')).length, 1);
});

test('a command in the process tree under a screen that is not at rest (spinner) changes nothing: still the 20-minute notice', () => {
  const w = world(), t = w.task();
  w.entry.state = 'working'; w.entry.lastScreen = THINKING; w.work = true;
  w.quiet(25 * 60_000);
  assert.equal(w.silent().length, 1);
  assert.match(w.silent()[0].summary, /20 分钟/);
});
