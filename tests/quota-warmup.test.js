'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../quota-warmup-core');

const RESET = Date.UTC(2026, 9, 3, 12);
const DUE = RESET + W.RESET_DELAY_MS;
const cn = { id: 'cn', accountKey: 'cn-account', configDir: '/home/test/.claude', occupied: false };
const us = { id: 'us', accountKey: 'us-account', configDir: '/home/test/.claude-us', occupied: false };
const observation = (seat = cn, extra = {}) => ({ seatId: seat.id, accountKey: seat.accountKey, configDir: seat.configDir, resetAt: RESET, proven: true, ...extra });
const observed = (seat = cn, extra = {}) => W.observe({}, observation(seat, extra), RESET);
const choose = (state, extra = {}) => W.decide({ state, seats: [cn, us], now: DUE, ...extra });

test('warmup defaults enabled, and disabling it retains proven window state', () => {
  for (const value of [undefined, null, 'invalid']) assert.deepEqual(W.normalizeSettings(value), { enabled: true });
  assert.deepEqual(W.normalizeSettings({ enabled: false }), { enabled: false });
  const state = observed();
  assert.equal(choose(state, { settings: { enabled: false } }), null);
  assert.equal(choose(state).seatId, 'cn');
});
test('a proven reset becomes due exactly sixty seconds after the five-hour window resets', () => {
  const state = observed();
  assert.equal(choose(state, { now: RESET - 1 }), null);
  assert.equal(choose(state, { now: DUE - 1 }), null);
  assert.deepEqual(choose(state), { seatId: 'cn', accountKey: cn.accountKey, configDir: cn.configDir, resetAt: RESET, attempt: 1, at: DUE });
});
test('unknown windows and unproven account or directory ownership never start warmup', () => {
  for (const extra of [{ proven: false }, { proven: undefined }, { accountKey: '' }, { configDir: '~/.claude' },
    { configDir: 'relative/.claude' }, { resetAt: null }, { resetAt: Infinity }]) assert.equal(choose(observed(cn, extra)), null);
  assert.equal(choose({}), null);
  assert.equal(choose(observed(), { seats: [{ ...cn, accountKey: null }] }), null);
});
test('any occupied session skips its seat, and missing occupancy information is also skipped', () => {
  let state = observed(); state = W.observe(state, observation(us), RESET);
  assert.equal(choose(state, { seats: [{ ...cn, occupied: true }, us] }).seatId, 'us');
  assert.equal(choose(state, { seats: [{ ...cn, occupied: true }, { ...us, occupied: true }] }), null);
  assert.equal(choose(state, { seats: [{ ...cn, occupied: undefined }] }), null);
});
test('the running attempt is persisted before execution and cannot be started twice', () => {
  let state = observed(); const decision = choose(state);
  state = W.begin(state, decision);
  assert.equal(state.seats.cn.status, 'running');
  assert.equal(state.seats.cn.attempts, 1);
  assert.equal(choose(state), null);
  assert.deepEqual(W.begin(state, decision), state);
});
test('one successful warmup per window remains complete through restart and repeated old samples', () => {
  let state = observed(); const decision = choose(state);
  state = W.begin(state, decision);
  state = W.finish(state, { ...decision, success: true }, DUE + 1000);
  assert.equal(state.seats.cn.status, 'succeeded');
  assert.equal(state.seats.cn.warmAt, DUE + 1000);
  assert.equal(state.seats.cn.warmWindowResetAt, RESET);
  state = W.observe(JSON.parse(JSON.stringify(state)), observation(), DUE + 2000);
  assert.equal(choose(state, { now: DUE + 5 * 3600_000 }), null);
});
test('the first failure waits sixty seconds before its only retry, and a second failure abandons the window', () => {
  let state = observed(); let decision = choose(state);
  state = W.begin(state, decision);
  const failedAt = DUE + 1000;
  state = W.finish(state, { ...decision, success: false }, failedAt);
  assert.equal(state.seats.cn.status, 'retry');
  assert.equal(choose(state, { now: failedAt + W.RETRY_DELAY_MS - 1 }), null);
  decision = choose(state, { now: failedAt + W.RETRY_DELAY_MS });
  assert.equal(decision.attempt, 2);
  state = W.begin(state, decision);
  state = W.finish(state, { ...decision, success: false }, decision.at + 1000);
  assert.equal(state.seats.cn.status, 'abandoned');
  assert.equal(state.seats.cn.attempts, 2);
  assert.equal(choose(state, { now: decision.at + 3600_000 }), null);
});
test('a successful retry also seals the window and cannot become a third attempt', () => {
  let state = observed(); let decision = choose(state);
  state = W.finish(W.begin(state, decision), { ...decision, success: false }, DUE);
  decision = choose(state, { now: DUE + W.RETRY_DELAY_MS });
  state = W.finish(W.begin(state, decision), { ...decision, success: true }, decision.at + 1);
  assert.equal(state.seats.cn.attempts, 2);
  assert.equal(state.seats.cn.status, 'succeeded');
  assert.equal(choose(state, { now: decision.at + 3600_000 }), null);
});
test('startup recovery counts a crashed started request as one failure and never grants a third attempt', () => {
  let state = observed(); let decision = choose(state);
  state = W.recoverRunning(JSON.parse(JSON.stringify(W.begin(state, decision))), DUE + 500);
  assert.equal(state.seats.cn.attempts, 1);
  assert.equal(state.seats.cn.status, 'retry');
  assert.equal(choose(state, { now: DUE + 500 + W.RETRY_DELAY_MS - 1 }), null);
  decision = choose(state, { now: DUE + 500 + W.RETRY_DELAY_MS });
  state = W.recoverRunning(W.begin(state, decision), decision.at + 500);
  assert.equal(state.seats.cn.attempts, 2);
  assert.equal(state.seats.cn.status, 'abandoned');
  assert.equal(choose(state, { now: decision.at + 3600_000 }), null);
});
test('a new proven window resets attempts while preserving the latest successful warmup for the UI', () => {
  let state = observed(); const decision = choose(state);
  state = W.finish(W.begin(state, decision), { ...decision, success: true }, DUE + 1000);
  const nextReset = RESET + 5 * 3600_000;
  state = W.observe(state, observation(cn, { resetAt: nextReset }), DUE + 2000);
  assert.equal(state.seats.cn.resetAt, nextReset);
  assert.equal(state.seats.cn.attempts, 0);
  assert.equal(state.seats.cn.status, 'pending');
  assert.equal(state.seats.cn.warmAt, DUE + 1000);
  assert.equal(state.seats.cn.warmWindowResetAt, RESET);
  assert.equal(choose(state, { now: nextReset + W.RESET_DELAY_MS }).attempt, 1);
  state = W.observe(state, observation(), nextReset);
  assert.equal(state.seats.cn.resetAt, nextReset);
});
test('only a proven native new reset from success can schedule the next window', () => {
  const nextReset = DUE + 5 * 3600_000;
  const initial = observed(), decision = choose(initial), running = W.begin(initial, decision);
  for (const extra of [{ newResetAt: nextReset }, { newResetAt: nextReset, provenNative: false }, { newResetAt: RESET, provenNative: true }]) {
    assert.equal(W.finish(running, { ...decision, success: true, ...extra }, DUE + 1000).seats.cn.resetAt, RESET);
  }
  const state = W.finish(running, { ...decision, success: true, newResetAt: nextReset, provenNative: true }, DUE + 1000);
  assert.equal(state.seats.cn.resetAt, nextReset);
  assert.equal(state.seats.cn.newResetAt, nextReset);
  assert.equal(state.seats.cn.warmAt, DUE + 1000);
  assert.equal(state.seats.cn.status, 'pending');
  assert.equal(choose(state, { now: nextReset + W.RESET_DELAY_MS }).attempt, 1);
});
test('unknown reset preserves an already proven old window but still requires matching current identity', () => {
  const state = W.observe(observed(), observation(cn, { resetAt: null, proven: false }), DUE);
  assert.equal(choose(state).seatId, 'cn');
  for (const extra of [{ accountKey: 'other-account' }, { configDir: '/home/test/other-profile' }, { accountKey: null }]) {
    assert.equal(choose(state, { seats: [{ ...cn, ...extra }] }), null);
  }
});
test('account or absolute directory changes discard the previous window and its success history', () => {
  let state = observed(); const decision = choose(state);
  state = W.finish(W.begin(state, decision), { ...decision, success: true }, DUE + 1);
  for (const extra of [{ accountKey: 'other-account' }, { configDir: '/home/test/new-profile' }]) {
    const changed = W.observe(state, observation(cn, { ...extra, proven: false }), DUE);
    assert.equal(changed.seats.cn, undefined);
  }
  const changed = W.observe(state, observation(cn, { accountKey: 'other-account' }), DUE);
  assert.equal(changed.seats.cn.attempts, 0);
  assert.equal(changed.seats.cn.warmAt, undefined);
});
test('late completions from an old identity or reset window cannot change newer state', () => {
  const initial = observed(), decision = choose(initial), running = W.begin(initial, decision);
  const changed = W.observe(running, observation(cn, { resetAt: RESET + 5 * 3600_000 }), DUE);
  assert.deepEqual(W.finish(changed, { ...decision, success: true }, DUE + 1), changed);
  assert.deepEqual(W.finish(running, { ...decision, accountKey: 'wrong', success: true }, DUE + 1), running);
});
test('Windows absolute paths compare without case sensitivity and Unix paths remain case sensitive', () => {
  const seat = { ...cn, configDir: 'C:\\Users\\Test\\.claude' };
  const state = observed(seat);
  assert.equal(choose(state, { seats: [{ ...seat, configDir: 'c:/users/test/.claude/' }] }).seatId, 'cn');
  assert.equal(choose(observed(), { seats: [{ ...cn, configDir: '/HOME/test/.claude' }] }), null);
});
test('warmup state is pure and survives JSON round trips; malformed and out-of-scope state is discarded', () => {
  const state = observed(), before = JSON.stringify(state), decision = choose(state);
  const started = W.begin(state, decision);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(W.normalizeState(JSON.parse(JSON.stringify(started))), started);
  for (const malformed of [undefined, null, 0, 'invalid']) assert.deepEqual(W.normalizeState(malformed), { seats: {} });
  assert.deepEqual(W.normalizeState({ seats: { other: { ...state.seats.cn }, us: { ...state.seats.cn, configDir: '~/.claude-us' } } }), { seats: {} });
});
