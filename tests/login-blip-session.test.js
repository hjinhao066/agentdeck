'use strict';
// A "Not logged in" on a seat whose login checks out is a blip, not a logout. 10-08 18:02:52-18:03:31
// three US2 sessions reported it within 40 s and one carried on by itself 35 s later. The sleep/network
// rules carry it: wait about a minute, one 「接着做」, and a second "Not logged in" after that nudge is a
// failure receipt. A seat that is really signed out still gets the ordinary 未登录 receipt at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const S = require('../sleep-resume-core');
const Seats = require('../claude-seats-core');
const C = require('../chat-core');

const PROMPT = '\n────────────────────────────────────\n❯ \n────────────────────────────────────\n  ⏵⏵ bypass permissions on';
const AUTH = 'work so far\n  ⎿  Not logged in · Please run /login\n\n✻ Baked for 1s · done 6:03 PM' + PROMPT;
const NUDGED = '> ' + S.message('login');
// After the nudge the old error is still on screen, above it; the session is working again.
const WORKING_AGAIN = 'work so far\n  ⎿  Not logged in · Please run /login\n✻ Baked for 1s\n' + NUDGED + '\n⏺ 接着改 crew-map.js\n✻ Thinking… (esc to interrupt)' + PROMPT;
// The nudge got the same answer.
const AGAIN = 'work so far\n  ⎿  Not logged in · Please run /login\n✻ Baked for 1s\n' + NUDGED + '\n  ⎿  Not logged in · Please run /login\n\n✻ Baked for 1s · done 6:05 PM' + PROMPT;
const MINUTE = 60_000;
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const signedIn = { id: 'us2', loggedIn: true, loginReason: '', authReason: '' };
const signedOut = { id: 'us2', loggedIn: false, loginReason: 'US2（us2）：没有登录凭据', authReason: '' };

test('core: a login blip waits about a minute, gets one nudge, then gives up; its message carries a marker', () => {
  const rec = { firstSeenAt: 0, attempts: 0, lastAt: 0, evidence: 'login' };
  const clock = { asleep: false, wokeAt: 0 };
  assert.equal(S.decide(rec, { now: 59_000, clock, online: true }).action, 'wait');
  assert.equal(S.decide(rec, { now: 60_000, clock, online: true }).action, 'send');
  assert.equal(S.decide({ ...rec, attempts: 1, lastAt: 60_000 }, { now: 10 * MINUTE, clock, online: true }).action, 'giveup');
  assert.ok(S.message('login').startsWith(S.LOGIN_MARK));
  assert.notEqual(S.message('login'), S.message());
  assert.match(S.failure({ ...rec, attempts: 1 }), /登录/);
});

test('MainCore: once the nudge is on screen, only what follows it counts; the error above it is history', () => {
  assert.equal(M.resourceKind(AUTH, 'claude'), 'auth');
  assert.equal(M.resourceKind('all done' + PROMPT, 'claude'), '');
  assert.equal(M.LOGIN_NUDGE_MARK, S.LOGIN_MARK, 'one marker text in both modules');
  // above the nudge: answered, the screen is the session's work again
  assert.equal(M.resourceKind(WORKING_AGAIN, 'claude'), '');
  assert.equal(M.terminalActivity(WORKING_AGAIN, 'claude'), '');
  assert.equal(M.resourceReceipt(WORKING_AGAIN, 'claude'), null);
  // below it: a new report, and only that one is quoted
  assert.equal(M.resourceKind(AGAIN, 'claude'), 'auth');
  assert.equal(M.resourceReceipt(AGAIN, 'claude').failed, '未登录：⎿  Not logged in · Please run /login');
  // the nudge scrolled away but an error is still visible: it came after
  assert.equal(M.resourceKind('  ⎿  Not logged in · Please run /login\n✻ Baked for 1s' + PROMPT, 'claude'), 'auth');
  assert.equal(M.loginNudgeShown(WORKING_AGAIN), true);
  assert.equal(M.loginNudgeShown(AUTH), false);
});

function world({ infos = [signedIn], cmd = 'claude --dangerously-skip-permissions --model claude-opus-5-5' } = {}) {
  const app = { now: 1_000_000_000, sends: [], seatChecks: 0 };
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const worker = { id: 'worker', cmd, claudeSeatId: 'us2', claudeConfigDir: '~/.claude-us2' };
  const entry = { alive: true, state: 'done', lastOutputAt: app.now, lastScreen: 'start' + PROMPT };
  const entries = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }], [worker.id, entry]]);
  const clock = S.createClock(() => app.now);
  const window = {
    deck: {
      saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, seatAuthFailure: () => Promise.resolve(),
      taskBoard() { return Promise.resolve({}); },
      claudeSeats: async (fresh) => { app.seatChecks++; app.fresh = fresh; return infos; },
    },
    MainCore: M, BoardCore: B, ClaudeSeatsCore: Seats, SleepResume: { ...S, clock },
    ChatUI: { hasDraft: () => false, turnsOf: () => [{ id: 'turn', done: true }], updateCard() {} },
  };
  const context = vm.createContext({
    window, console, setTimeout, clearTimeout,
    document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
    Date: class extends Date { static now() { return app.now; } },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const open = { id: 't', gen: 1, colId: 'worker', boardId: 'card', boardAttempt: 'attempt', status: 'working', turnId: 'turn', startedAt: 1 };
  const state = { colId: captain.id, gen: 1, tasks: [open], pending: [], waitlist: [] };
  window.MainSession.init({
    config: { mainSession: state, folders: [], claudeSeats: Seats.normalize(), activeClaudeSeatId: 'cn' }, saveConfig() {}, flushConfig() {},
    columns: () => [captain, worker], terms: entries, userComposing: () => false, columnLabel: (c) => c.id,
    showToast() {},
    sendWhenReady(col, text, opts) { app.sends.push({ col, text, opts }); },
  });
  Object.assign(app, { api: window.MainSession, task: open, entry, state });
  app.tick = () => { clock.beat(); app.api.onTick(worker.id, entry); };
  app.run = async (ms) => { for (let t = 0; t < ms; t += 1000) { app.now += 1000; app.tick(); await tick(); } };
  // what the status loop does with an error row on screen: the column reads as a resource wait
  app.screen = (s) => {
    entry.lastScreen = s; entry.lastOutputAt = app.now;
    entry.state = M.terminalActivity(s, cmd) === 'quota' ? 'quota' : /esc to interrupt/.test(s) ? 'working' : 'done';
  };
  return app;
}

test('a Not logged in on a seat that checks out signed in: no receipt, one 接着做 after about a minute, quiet while it works again', async () => {
  const w = world();
  w.screen(AUTH);
  await w.run(30_000);
  assert.equal(w.task.status, 'working', 'not reported as 未登录 while the seat is signed in');
  assert.equal(w.task.receipt, undefined);
  assert.equal(w.sends.length, 0, 'nothing before the minute is up');
  assert.equal(w.seatChecks, 1, 'the seat is checked once');
  assert.equal(w.fresh, true, 'with a fresh login check');
  await w.run(32_000);
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].text, S.message('login'));
  assert.equal(w.sends[0].opts.guardUserInput, true, 'never typed over a draft');
  assert.equal(w.sends[0].opts.overLoginError, true, 'the old error row does not hold it back');
  w.sends[0].opts.onSent(null);
  w.screen(WORKING_AGAIN);
  await w.run(5 * MINUTE);
  assert.equal(w.task.status, 'working');
  assert.equal(w.task.receipt, undefined);
  assert.equal(w.state.pending.length, 0, 'the Captain hears nothing');
  assert.equal(w.sends.length, 1, 'only once');
});

test('the same Not logged in after the 接着做 is a failure receipt', async () => {
  const w = world();
  w.screen(AUTH);
  await w.run(62_000);
  assert.equal(w.sends.length, 1);
  w.sends[0].opts.onSent(null);
  // the TUI has not drawn the nudge yet: the old error alone is not a second report
  await w.run(5000);
  assert.equal(w.task.status, 'working');
  w.screen(AGAIN);
  await w.run(3000);
  assert.equal(w.task.status, 'failed');
  assert.match(w.task.receipt.failed, /^未登录：/);
  assert.match(w.task.receipt.failed, /接着做/);
  assert.equal(M.exceptionReason(w.task.receipt), 'auth');
  assert.equal(w.sends.length, 1);
});

// Review 5ca1705 (review-evidence/review-login-blip-hang.test.js): after the nudge the agent answers
// briefly and stops without a receipt, the old error still in the last 20 rows. The task hung in
// working for an hour; it must end the way the same ending without that old row does.
const SHORT_REPLY = '\n⏺ 我看了一下，上一步其实已经做完了，请确认是否需要我继续。\n\n✻ Worked for 3s' + PROMPT;
const IDLE_AFTER = 'work so far\n  ⎿  Not logged in · Please run /login\n✻ Baked for 1s\n' + NUDGED + SHORT_REPLY;
test('after the 接着做, a short reply and no receipt ends like any other turn: the old error above it does not hold the task', async () => {
  const w = world();
  w.screen(AUTH);
  await w.run(62_000);
  assert.equal(w.sends.length, 1);
  w.sends[0].opts.onSent(null);
  w.screen(IDLE_AFTER);
  await w.run(10 * MINUTE);
  const control = world();
  control.screen('work so far\n' + NUDGED + SHORT_REPLY);
  await control.run(10 * MINUTE);
  assert.equal(control.task.status, 'stopped');
  assert.equal(w.task.status, control.task.status, 'not stuck in working');
  assert.equal(JSON.stringify(w.state.pending.map((p) => p.summary)), JSON.stringify(control.state.pending.map((p) => p.summary)));
  assert.ok(w.state.pending.some((p) => /已结束，未提交回执/.test(p.summary)));
  assert.equal(w.sends.length, 1);
});

test('a seat that is really signed out gets the ordinary 未登录 receipt, with no nudge', async () => {
  const w = world({ infos: [signedOut] });
  w.screen(AUTH);
  await w.run(3000);
  assert.equal(w.task.status, 'failed');
  assert.match(w.task.receipt.failed, /^未登录：/);
  assert.equal(w.sends.length, 0);
});

// The real sendWhenReady from renderer.js: a column showing only the login error is otherwise held as a resource wait.
test('sendWhenReady lets the 接着做 past a login error row, and only with overLoginError', async () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
  const delivered = [];
  const col = { id: 'w', cmd: 'claude' };
  const entry = { alive: true, state: 'quota', lastScreen: AUTH, lastOutputAt: 0 };
  const context = vm.createContext({
    MainCore: M, columns: [col], terms: new Map([['w', entry]]), env: { platform: 'darwin' }, Date, setTimeout, clearTimeout, Promise,
    AGENT_IDLE_RE: /bypass permissions/, terminalIdle: () => true, userComposing: () => false, agentInForeground: async () => true,
    showToast() {}, columnLabel: (c) => c.id,
    ChatUI: { async sendPrompt(_col, text) { delivered.push(text); return true; } },
    window: { SleepResume: null, BoardCore: B },
  });
  vm.runInContext(renderer.slice(renderer.indexOf('function sendWhenReady('), renderer.indexOf('\nfunction addColumn(')), context);
  context.sendWhenReady(col, 'held', { timeout: 1500 });
  context.sendWhenReady(col, S.message('login'), { overLoginError: true, timeout: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(delivered, [S.message('login')]);
  // a quota row is still a wait, even with the option
  entry.lastScreen = "work\n  ⎿  You've hit your limit · resets 5pm" + PROMPT;
  context.sendWhenReady(col, 'quota', { overLoginError: true, timeout: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(delivered.length, 1);
  assert.equal(C.promptLeftInBox(AUTH, 'x'), false);
});
