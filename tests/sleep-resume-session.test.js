'use strict';
// The real main-session.js with a fake clock and a stand-in terminal: a session
// cut short by sleep or a dropped network is nudged to carry on after the
// machine wakes, not reported as "已结束，未提交回执". Nothing really sleeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const S = require('../sleep-resume-core');

const PROMPT = '\n╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts';
const CLAUDE_SLEEP = 'work so far\n⎿  API Error: Your computer went to sleep mid-response. Try again.' + PROMPT;
const CLAUDE_LOST = 'work so far\n⎿  API Error: Connection lost mid-response' + PROMPT;
const CLAUDE_DOWN = 'work so far\n⎿  API Error: Unable to connect. Can\'t reach the API server (retried 10 times)' + PROMPT;
const AGY_NETWORK = '>\nThere was a network issue connecting to the server.\nAntigravity\nContext: [#####] 12k/2000k';
const AGY_PIPE = '>\nError: write: broken pipe\nAntigravity\nContext: [#####] 12k/2000k';
const CLEAN = 'all done, summary above\n' + PROMPT;
const MINUTE = 60_000;

function world({ cmd = 'claude', task = {}, turns, withClock = true, nav } = {}) {
  const app = { now: 1_000_000_000, sends: [], boardEvents: [] };
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd };
  const entry = { alive: true, state: 'done', lastOutputAt: app.now, lastScreen: CLEAN };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const turnList = turns || [{ id: 'turn', done: true }];
  const clock = S.createClock(() => app.now);
  const window = {
    deck: {
      saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, seatAuthFailure: () => Promise.resolve(),
      taskBoard(op, input) { app.boardEvents.push({ op, input }); return Promise.resolve({}); },
    },
    MainCore: M, BoardCore: B,
    ...(withClock ? { SleepResume: { ...S, clock } } : {}),
    ChatUI: { hasDraft: () => false, turnsOf: (id) => (id === worker.id ? turnList : []), updateCard() {} },
  };
  const context = vm.createContext({
    window, console, setTimeout, clearTimeout,
    document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
    Date: class extends Date { static now() { return app.now; } },
    ...(nav ? { navigator: nav } : {}),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const open = { id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1, ...task };
  const state = { colId: captain.id, gen: 1, tasks: [open], pending: [], waitlist: [] };
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, saveConfig() {}, flushConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
    showToast() {},
    sendWhenReady(col, text, opts) { app.sends.push({ col, text, opts }); },
  });
  Object.assign(app, { api: window.MainSession, task: open, entry, clock, state, turns: turnList });
  app.tick = () => { clock.beat(); app.api.onTick(worker.id, entry); };
  // Time passes in 1 s ticks, like the status loop.
  app.run = (ms) => { for (let t = 0; t < ms; t += 1000) { app.now += 1000; app.tick(); } };
  app.screen = (s) => { entry.lastScreen = s; entry.state = 'done'; entry.lastOutputAt = app.now; };
  app.deliver = () => { // the nudge goes in: the session is working again
    const last = app.sends.at(-1);
    last.opts.onSent(null);
    entry.state = 'working'; entry.lastScreen = 'Doing…\n' + PROMPT; entry.lastOutputAt = app.now;
  };
  return app;
}

const QUIET = 10 * MINUTE;

test('a Claude session cut short by sleep, quiet for ten minutes, is not reported as finished without a receipt', async () => {
  const w = world();
  w.task.endedAt = w.now - QUIET;
  w.entry.lastOutputAt = w.now - QUIET;
  w.screen(CLAUDE_SLEEP);
  w.entry.lastOutputAt = w.now - QUIET;
  w.run(1000);
  assert.notEqual(w.task.receipt?.source, 'fallback', 'a sleep interruption is not a missing receipt');
  assert.equal(w.task.status, 'working');
  assert.equal(w.task.receipt, undefined);
  assert.equal(w.state.pending.length, 0, 'the Captain hears nothing yet');
});

for (const [name, cmd, screen] of [
  ['Claude: computer went to sleep', 'claude', CLAUDE_SLEEP],
  ['Claude: connection lost', 'claude', CLAUDE_LOST],
  ['Claude: cannot reach the API server', 'claude', CLAUDE_DOWN],
  ['agy: network issue', B.commandForAgent('agy'), AGY_NETWORK],
  ['agy: broken pipe', B.commandForAgent('agy'), AGY_PIPE],
]) {
  test(`${name}: nudged once the machine is awake, no missing-receipt report`, async () => {
    const w = world({ cmd });
    w.task.endedAt = w.now - QUIET;
    w.screen(screen);
    w.run(S.SETTLE_MS + 2000);
    assert.equal(w.sends.length, 1, 'one short nudge, not a flood');
    w.deliver();
    w.run(5 * MINUTE);
    assert.equal(w.task.status, 'working', 'still the same open task');
    assert.equal(w.task.receipt, undefined);
    assert.equal(w.state.pending.length, 0);
    assert.deepEqual(w.boardEvents.filter((e) => e.input.type), [], 'no fallback or failure goes to the card');
    assert.equal(w.sends.length, 1, 'and no second one while it works');
    assert.equal(w.sends[0].text, S.message());
    assert.equal(w.sends[0].opts.guardUserInput, true, 'never typed over a draft');
    assert.equal(w.sends[0].opts.requireIdle, true);
  });
}

test('nothing is sent while the machine sleeps or the network is down; it goes out after waking', () => {
  const w = world();
  w.screen(CLAUDE_SLEEP);
  w.api.onPower(true, w.now);
  w.run(30 * MINUTE);
  assert.equal(w.sends.length, 0, 'asleep: no spinning');
  assert.equal(w.task.status, 'working');
  w.api.onPower(false, w.now);
  w.run(S.WAKE_MS - 2000);
  assert.equal(w.sends.length, 0, 'the network gets time to come back');
  w.run(5000);
  assert.equal(w.sends.length, 1);
});

test('offline after waking holds the nudge until the network is back', () => {
  const nav = { onLine: false };
  const w = world({ nav });
  w.screen(CLAUDE_DOWN);
  w.api.onPower(false, w.now);
  w.run(10 * MINUTE);
  assert.equal(w.sends.length, 0);
  nav.onLine = true;
  w.run(2000);
  assert.equal(w.sends.length, 1);
});

test('nudges have gaps and a cap; then one anomaly receipt goes to the Captain', async () => {
  const w = world();
  const times = [];
  w.screen(CLAUDE_LOST);
  w.api.onPower(false, w.now);
  for (let i = 0; i < 40 * 60 && w.task.status === 'working'; i++) {
    w.run(1000);
    if (w.sends.length > times.length) { times.push(w.now); w.sends.at(-1).opts.onSent(null); w.screen(CLAUDE_LOST); }
  }
  assert.equal(times.length, S.MAX_SCREEN, 'capped');
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  gaps.forEach((gap, i) => assert.ok(gap >= S.GAPS[i + 1] && gap < S.GAPS[i + 1] + 3000, `gap ${i + 1} is ${gap}`));
  assert.equal(w.task.status, 'failed');
  assert.equal(w.task.receipt.source, 'sleep');
  assert.match(w.task.receipt.failed, /睡眠或断网/);
  assert.match(w.task.receipt.failed, new RegExp(String(S.MAX_SCREEN)));
  const item = w.state.pending.at(-1);
  assert.equal(item.anomaly, 'interrupted');
  await new Promise(setImmediate);
  assert.equal(w.boardEvents.at(-1).input.type, 'failed');
});

test('a nudge that works ends the episode; a later sleep gets a fresh set of nudges', () => {
  const w = world();
  w.screen(CLAUDE_SLEEP);
  w.api.onPower(false, w.now);
  w.run(S.WAKE_MS + 12000);
  assert.equal(w.sends.length, 1);
  w.deliver();
  w.run(2 * MINUTE);
  assert.equal(w.task.sleepResume, undefined, 'working again, the episode is closed');
  w.screen(CLAUDE_LOST);
  w.run(S.SETTLE_MS + 2000);
  assert.equal(w.sends.length, 2, 'the second interruption is nudged right away, no inherited gap');
});

test('a nudge that could not go in (draft in the box) is retried, not counted', () => {
  const w = world();
  w.screen(CLAUDE_SLEEP);
  w.run(S.SETTLE_MS + 2000);
  assert.equal(w.sends.length, 1);
  w.run(80_000);
  assert.equal(w.sends.length, 1, 'one send waits at a time');
  w.sends[0].opts.onGiveUp(); // the send's own 90 s timeout
  w.run(2000);
  assert.equal(w.sends.length, 2);
  assert.equal(w.task.sleepResume.attempts, 0);
});

test('a receipt from the session settles it as before, and no nudge goes out after it', () => {
  const w = world();
  w.screen(CLAUDE_SLEEP);
  w.run(S.SETTLE_MS + 2000);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].opts.cancelled(), false);
  w.task.status = 'done';
  assert.equal(w.sends[0].opts.cancelled(), true, 'a closed task cancels the pending send');
  w.run(10 * MINUTE);
  assert.equal(w.sends.length, 1);
});

test('a Captain stop or a user Esc is never resumed', () => {
  const stopped = world({ task: { status: 'stopped', receipt: { source: 'captain-stop', summary: '队长已请求中断当前操作。', explicit: true } } });
  stopped.screen(CLAUDE_SLEEP);
  stopped.run(10 * MINUTE);
  assert.equal(stopped.sends.length, 0);

  const esc = world({ turns: [{ id: 'turn', done: true, interrupted: true }] });
  esc.screen(CLAUDE_SLEEP);
  esc.run(10 * MINUTE);
  assert.equal(esc.sends.length, 0);
  assert.equal(esc.task.status, 'working');
});

test('a session that did not stop at the prompt but is working is left alone', () => {
  const w = world();
  w.entry.state = 'working';
  w.entry.lastScreen = 'API Error: Connection lost mid-response\nDoing…\n' + PROMPT;
  w.run(10 * MINUTE);
  assert.equal(w.sends.length, 0);
  assert.equal(w.task.sleepResume, undefined);
});

test('a normal finish with no receipt still reports 已结束，未提交回执 (nothing slept)', async () => {
  const w = world();
  w.task.endedAt = w.now - QUIET;
  w.screen(CLEAN);
  w.entry.lastOutputAt = w.now - QUIET;
  w.tick();
  assert.equal(w.task.status, 'stopped');
  assert.equal(w.task.receipt.summary, '已结束，未提交回执');
  assert.equal(w.task.receipt.source, 'fallback');
  assert.equal(w.sends.length, 0);
});

test('the words quoted inside the session\'s own output are not an interruption', () => {
  const w = world();
  w.task.endedAt = w.now - QUIET;
  w.screen('- expected "Connection lost mid-response" in the screen\n+ handled "write: broken pipe"\n' + PROMPT);
  w.entry.lastOutputAt = w.now - QUIET;
  w.tick();
  assert.equal(w.task.status, 'stopped');
  assert.equal(w.task.receipt.source, 'fallback');
  assert.equal(w.sends.length, 0);
});

test('slept while working, then the turn ended soon after waking with no sign on screen: one nudge, then the old rule', () => {
  const w = world();
  w.task.endedAt = w.now - QUIET;
  w.api.onPower(true, w.now);
  assert.ok(w.task.sleptAt);
  w.now += 20 * MINUTE; // asleep: no ticks
  w.api.onPower(false, w.now);
  w.task.endedAt = w.now; // the turn ended just now
  w.screen(CLEAN);
  w.run(S.WAKE_MS + S.SETTLE_MS + 2000);
  assert.equal(w.sends.length, 1, 'one nudge on the event alone');
  assert.equal(w.task.status, 'working');
  w.deliver();
  w.screen(CLEAN);
  w.entry.lastOutputAt = w.now - QUIET;
  w.task.endedAt = w.now - QUIET;
  w.run(2000);
  assert.equal(w.sends.length, 1, 'no second nudge on the event alone');
  assert.equal(w.task.status, 'stopped', 'back to the ordinary missing-receipt report');
  assert.equal(w.task.receipt.source, 'fallback');
});

test('a task that was not working when the machine slept is not marked', () => {
  const w = world({ task: { status: 'done', receipt: { source: 'command', explicit: true, summary: 'x' } } });
  w.api.onPower(true, w.now);
  assert.equal(w.task.sleptAt, undefined);
});

test('without the sleep module loaded the session behaves exactly as before', () => {
  const w = world({ withClock: false });
  w.task.endedAt = w.now - QUIET;
  w.screen(CLAUDE_SLEEP);
  w.entry.lastOutputAt = w.now - QUIET;
  w.tick();
  assert.equal(w.task.receipt.source, 'fallback');
  assert.doesNotThrow(() => w.api.onPower(true, w.now));
});

test('a wake whose events never arrive is still seen as a long silence between ticks', () => {
  const w = world();
  w.screen(CLAUDE_SLEEP);
  w.run(2000);
  w.now += 45 * MINUTE; // the machine slept; no suspend/resume event reached the page
  w.screen(CLAUDE_SLEEP);
  w.tick();
  assert.equal(w.sends.length, 0, 'the network gets its moment first');
  w.run(S.WAKE_MS + 2000);
  assert.equal(w.sends.length, 1);
});

test('the first tick after waking, before any event, never lets the ordinary rule report 已结束', () => {
  const w = world();
  w.task.endedAt = w.now - QUIET;
  w.screen(CLAUDE_SLEEP);
  w.entry.lastOutputAt = w.now - QUIET;
  w.api.onPower(true, w.now);
  w.now += 30 * MINUTE;
  w.tick(); // timers run before the queued wake message
  assert.equal(w.task.status, 'working', 'the screen says it was cut short: no 已结束，未提交回执');
  assert.equal(w.task.receipt, undefined);
});
