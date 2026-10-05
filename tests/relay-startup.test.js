'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../relay-startup-core');

const NOW = Date.UTC(2026, 9, 5, 10, 51);
const begin = (state = {}, targetId = 'cn', at = NOW) => R.begin(state, { colId: 'captain-' + targetId, targetId, at });
const check = (state, event = {}) => R.check(state, { colId: state.attempt?.colId, now: NOW, ...event });

test('Relay startup core is available in both browser and CommonJS', () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../relay-startup-core'), 'utf8'), browser);
  assert.equal(typeof browser.RelayStartupCore.check, 'function');
  assert.equal(R.STARTUP_MS, 180_000);
  assert.equal(R.MAX_FAILURES, 3);
});

test('normalization discards invalid state and preserves a bounded consecutive failure history', () => {
  const empty = { attempt: null, failures: [], stopped: false, reason: null };
  for (const value of [undefined, null, 7, 'bad', {}]) assert.deepEqual(R.normalize(value), empty);
  assert.deepEqual(R.normalize({ attempt: { colId: '../bad', targetId: 'cn', at: NOW },
    failures: ['us', null, '../bad', 'cn', 'chatgpt', 'us2'] }),
  { ...empty, failures: ['us', 'cn', 'chatgpt'], stopped: true });
  const state = begin();
  assert.equal(R.normalize({ ...state, attempt: { ...state.attempt, deadline: NOW + 86400_000 } }).attempt.deadline, NOW + R.STARTUP_MS);
  assert.equal(R.normalize({ ...state, attempt: { ...state.attempt, deadline: null } }).attempt.deadline, NOW + R.STARTUP_MS);
});

test('begin retains failures, binds the new column and starts one three-minute deadline', () => {
  const state = begin({ failures: ['us'], reason: 'quota' }, 'cn');
  assert.deepEqual(state, { attempt: { colId: 'captain-cn', targetId: 'cn', at: NOW,
    deadline: NOW + R.STARTUP_MS, promptSent: false, output: false }, failures: ['us'], stopped: false, reason: null });
  for (const event of [{}, { colId: 'c', targetId: 'cn', at: -1 }, { colId: 'c', targetId: null, at: NOW }]) {
    assert.deepEqual(R.begin(state, event), state);
  }
});

test('idle, stopped and unrelated columns do not trigger supervision actions', () => {
  assert.equal(check(R.normalize()).action, 'none');
  assert.equal(R.fail({}, 'quota').action, 'none');
  const state = begin();
  const result = check(state, { colId: 'previous-captain', quota: true, exited: true, now: NOW + R.STARTUP_MS });
  assert.equal(result.action, 'none');
  assert.deepEqual(result.state, state);
  const stopped = R.normalize({ stopped: true, failures: ['us'] });
  assert.deepEqual(begin(stopped), stopped);
  assert.equal(check(stopped).action, 'none');
});

test('prompt delivery and real output accumulate but stay under supervision for three minutes', () => {
  let state = begin({ failures: ['us'] });
  let result = check(state, { promptSent: true, now: NOW + 1 });
  assert.equal(result.action, 'waiting');
  result = check(result.state, { output: true, now: NOW + R.STARTUP_MS - 1 });
  assert.equal(result.action, 'waiting');
  assert.equal(result.state.attempt.promptSent, true);
  assert.equal(result.state.attempt.output, true);
  assert.deepEqual(result.state.failures, ['us']);
  result = check(result.state, { now: NOW + R.STARTUP_MS });
  assert.equal(result.action, 'healthy');
  assert.deepEqual(result.state, R.normalize());
});

test('missing prompt delivery fails at the deadline even if output exists', () => {
  const result = check(begin(), { output: true, now: NOW + R.STARTUP_MS });
  assert.equal(result.action, 'retry');
  assert.equal(result.state.reason, 'prompt-not-sent');
  assert.deepEqual(result.state.failures, ['cn']);
});

test('delivered prompt without output fails at the deadline', () => {
  assert.equal(check(begin(), { promptSent: true, now: NOW + R.STARTUP_MS - 1 }).action, 'waiting');
  const result = check(begin(), { promptSent: true, now: NOW + R.STARTUP_MS });
  assert.equal(result.action, 'retry');
  assert.equal(result.state.reason, 'no-output');
});

test('quota failure has priority over healthy output, including at the deadline', () => {
  for (const now of [NOW, NOW + 1, NOW + R.STARTUP_MS]) {
    const result = check(begin(), { quota: true, promptSent: true, output: true, now });
    assert.equal(result.action, 'retry');
    assert.equal(result.state.reason, 'quota');
  }
  const waiting = check(begin({ failures: ['us'] }), { promptSent: true, output: true, now: NOW + 1 });
  const result = check(waiting.state, { quota: true, now: NOW + 2 });
  assert.deepEqual(result.state.failures, ['us', 'cn']);
  assert.equal(result.action, 'retry');
});

test('a process exit fails immediately even after a brief real reply', () => {
  const result = check(begin(), { promptSent: true, output: true, exited: true, now: NOW + 1 });
  assert.equal(result.action, 'retry');
  assert.equal(result.state.reason, 'exited');
});

test('three consecutive failures stop once, including Codex failure, without infinite retries', () => {
  let state = R.normalize();
  for (const [index, targetId] of ['cn', 'us2', 'chatgpt'].entries()) {
    state = begin(state, targetId, NOW + index);
    const result = check(state, { quota: true });
    assert.equal(result.action, index === 2 ? 'stop' : 'retry');
    assert.equal(result.state.failures.length, index + 1);
    state = result.state;
  }
  assert.deepEqual(state.failures, ['cn', 'us2', 'chatgpt']);
  assert.equal(state.stopped, true);
  assert.equal(state.attempt, null);
  assert.deepEqual(begin(state, 'cn', NOW + R.STARTUP_MS), state);
  assert.equal(check(state).action, 'none');
  assert.equal(R.fail(state, 'quota').action, 'none');
});

test('repeated failure of the same target still counts as separate attempts', () => {
  let state = R.normalize();
  for (let index = 0; index < 3; index++) state = R.fail(begin(state), 'launch-failed').state;
  assert.deepEqual(state.failures, ['cn', 'cn', 'cn']);
  assert.equal(state.stopped, true);
});

test('successful supervised startup clears consecutive failures for the next rotation', () => {
  let state = begin({ failures: ['us', 'us2'] });
  state = check(state, { promptSent: true, output: true, now: NOW + R.STARTUP_MS }).state;
  const result = R.fail(begin(state, 'chatgpt', NOW + R.STARTUP_MS + 1), 'launch-failed');
  assert.equal(result.action, 'retry');
  assert.deepEqual(result.state.failures, ['chatgpt']);
});

test('restart preserves the original deadline, observations and consecutive failures', () => {
  let state = check(begin({ failures: ['us'] }), { promptSent: true, now: NOW + 1 }).state;
  state = R.normalize(JSON.parse(JSON.stringify(state)));
  assert.equal(state.attempt.deadline, NOW + R.STARTUP_MS);
  assert.equal(state.attempt.promptSent, true);
  const result = check(state, { now: NOW + R.STARTUP_MS + 1 });
  assert.equal(result.action, 'retry');
  assert.deepEqual(result.state.failures, ['us', 'cn']);
});

test('03:51 rotation with no delivered captain prompt is retried by 03:54 instead of waiting until 10:25', () => {
  const switchedAt = Date.UTC(2026, 9, 5, 10, 51);
  let state = begin({}, 'cn', switchedAt);
  state = R.normalize(JSON.parse(JSON.stringify(state)));
  const result = check(state, { now: switchedAt + R.STARTUP_MS });
  assert.equal(result.action, 'retry');
  assert.equal(result.state.reason, 'prompt-not-sent');
  assert.deepEqual(result.state.failures, ['cn']);
});

test('pure operations never mutate caller-owned state or failure arrays', () => {
  const state = begin({ failures: ['us'] });
  const before = JSON.stringify(state);
  R.normalize(state);
  begin(state, 'us2');
  check(state, { promptSent: true, output: true });
  R.fail(state, 'quota');
  assert.equal(JSON.stringify(state), before);
});
