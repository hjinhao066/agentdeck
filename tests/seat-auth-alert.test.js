'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeatAuthMonitor, loginCommand, authFailure, CONFIRM_MS } = require('../seat-auth-alert');
const NOW = 1_800_000_000_000;
const US = { id: 'us', name: 'US', configDir: '~/.claude-us' };
function harness(state = {}) {
  const alerts = [], statuses = [], writes = [];
  const monitor = createSeatAuthMonitor({ home: '/home/test', platform: 'darwin', state,
    saveState: (s) => writes.push(JSON.parse(JSON.stringify(s))), onAlert: (a) => alerts.push(a),
    onStatus: (s) => statuses.push(s), id: () => `alert-${alerts.length + 1}` });
  const observe = (authStatus, at, seat = US, provider = 'Claude') => monitor.observe(seat, { provider, at, authStatus });
  return { alerts, statuses, writes, monitor, observe };
}
test('two independent logout proofs at least thirty seconds apart alert immediately with an actionable command', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  assert.equal(h.alerts.length, 0); assert.equal(h.monitor.needsConfirmation(US, 'Claude'), true);
  h.observe('logged-out', NOW + 1 + CONFIRM_MS);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].message, /Claude US（us）席位掉登录.*任务会失败或排队/);
  assert.match(h.alerts[0].message, /CLAUDE_CONFIG_DIR=~\/.claude-us claude auth login/);
  assert.match(h.alerts[0].message, /队长.*改派/);
  assert.equal(h.statuses.at(-1).authStatus, 'logged-out');
  assert.equal(h.monitor.needsConfirmation(US, 'Claude'), false);
});
test('network failure, one miss, duplicate polls and startup never-logged-in seats do not alert', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + 1); h.observe('logged-out', NOW + 2);
  assert.equal(h.alerts.length, 0);
  h.observe(undefined, NOW + CONFIRM_MS); // Query/network/permission failure breaks confirmation.
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  assert.equal(h.alerts.length, 0);
  h.observe('logged-in', NOW + CONFIRM_MS + 2); assert.equal(h.alerts.length, 0);
  const initial = harness(); initial.observe('logged-out', NOW); initial.observe('logged-out', NOW + CONFIRM_MS);
  assert.equal(initial.alerts.length, 0); assert.equal(initial.statuses.at(-1).authStatus, 'logged-out');
});
test('one alert per episode persists across relaunch; recovery is silent and rearms the next logout', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + 1 + CONFIRM_MS); h.observe('logged-out', NOW + 2 + CONFIRM_MS);
  h.observe(undefined, NOW + 3 + CONFIRM_MS); h.observe('logged-out', NOW + 4 + CONFIRM_MS);
  assert.equal(h.alerts.length, 1);
  const restart = harness(h.writes.at(-1));
  restart.observe('logged-out', NOW + 5 + CONFIRM_MS); assert.equal(restart.alerts.length, 0);
  restart.observe('logged-in', NOW + 6 + CONFIRM_MS); assert.equal(restart.alerts.length, 0);
  restart.observe('logged-in', NOW); // Old recovery cannot change an episode.
  restart.observe('logged-out', NOW + 7 + CONFIRM_MS);
  restart.observe('logged-out', NOW + 7 + 2 * CONFIRM_MS);
  assert.equal(restart.alerts.length, 1);
});
test('undelivered Captain receipt survives recovery/relaunch until explicitly acknowledged', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1); h.observe('logged-in', NOW + CONFIRM_MS + 2);
  const restarted = harness(h.writes.at(-1));
  assert.deepEqual(restarted.monitor.pendingReceipts(), h.alerts);
  restarted.monitor.acknowledge(h.alerts[0].id);
  assert.deepEqual(restarted.monitor.pendingReceipts(), []);
});
test('custom directory changes cannot inherit a prior login or outage', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  const changed = { ...US, configDir: '~/new-seat' };
  h.observe('logged-out', NOW + CONFIRM_MS + 1, changed);
  h.observe('logged-out', NOW + 2 * CONFIRM_MS + 1, changed);
  assert.equal(h.alerts.length, 0);
});
test('persist episode before alert; failed writes never send', () => {
  let snapshot, called = 0;
  const m = createSeatAuthMonitor({ home: '/home/test', saveState: (s) => { snapshot = s; },
    onAlert: () => { called++; assert.equal(snapshot['Claude:us'].notified, true); } });
  for (const [authStatus, at] of [['logged-in', NOW], ['logged-out', NOW + 1], ['logged-out', NOW + CONFIRM_MS + 1]]) m.observe(US, { provider: 'Claude', at, authStatus });
  assert.equal(called, 1);
  const broken = createSeatAuthMonitor({ saveState: () => { throw new Error('disk full'); }, onAlert: () => assert.fail('must persist first') });
  assert.throws(() => broken.observe(US, { provider: 'Claude', at: NOW, authStatus: 'logged-in' }), /disk full/);
});
test('Codex uses the same confirmation and episode rules; unsupported providers are ignored', () => {
  const h = harness(), codex = { id: 'codex', name: 'Codex', configDir: '~/.codex' };
  h.observe('logged-in', NOW, codex, 'Codex'); h.observe('logged-out', NOW + 1, codex, 'Codex');
  h.observe('logged-out', NOW + CONFIRM_MS + 1, codex, 'Codex');
  assert.match(h.alerts[0].message, /env -u CODEX_HOME codex login/);
  assert.equal(h.observe('logged-out', NOW, codex, 'Cursor'), false);
});
test('login commands derive default and custom seats safely on macOS and Windows', () => {
  assert.equal(loginCommand('Claude', { configDir: '~/.claude' }, '/home/test', 'darwin'), 'env -u CLAUDE_CONFIG_DIR claude auth login');
  assert.equal(loginCommand('Claude', US, '/home/test', 'darwin'), 'CLAUDE_CONFIG_DIR=~/.claude-us claude auth login');
  assert.equal(loginCommand('Claude', { configDir: "/custom/path with 'quote;$()" }, '/home/test', 'darwin'), "CLAUDE_CONFIG_DIR='/custom/path with '\\''quote;$()' claude auth login");
  assert.equal(loginCommand('Claude', { configDir: '~/.claude-us2' }, 'C:\\Users\\Test', 'win32'), "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; $env:CLAUDE_CONFIG_DIR='C:\\Users\\Test\\.claude-us2'; claude auth login");
  assert.equal(loginCommand('Claude', { configDir: 'c:\\users\\test\\.claude' }, 'C:\\Users\\Test', 'win32'), 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; claude auth login');
  assert.equal(loginCommand('Codex', { configDir: '~/custom-codex' }, '/home/test', 'darwin'), 'CODEX_HOME=~/custom-codex codex login');
});
test('authenticated failure wording triggers a check while ordinary failures do not', () => {
  for (const text of ['Not logged in', 'US seat: Not logged in. Please run /login', 'Claude US 未登录，请先登录', 'Error: 401 Unauthorized']) assert.equal(authFailure(text), true, text);
  for (const text of ['Network timeout', 'usage query failed', 'rate limit reached', 'Unknown provider', undefined]) assert.equal(authFailure(text), false, text);
});
