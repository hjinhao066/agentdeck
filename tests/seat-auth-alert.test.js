'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeatAuthMonitor, loginCommand, authFailure, CONFIRM_MS } = require('../seat-auth-alert');
const NOW = 1_800_000_000_000;
const US = { id: 'us', name: 'US', configDir: '~/.claude-us' };
function harness(state = {}) {
  const alerts = [], statuses = [], recoveries = [], writes = []; let sequence = 0;
  const monitor = createSeatAuthMonitor({ home: '/home/test', platform: 'darwin', state,
    saveState: (s) => writes.push(JSON.parse(JSON.stringify(s))), onAlert: (a) => alerts.push(a),
    onStatus: (s) => statuses.push(s), onRecovery: (s) => recoveries.push(s), id: () => `alert-${++sequence}` });
  const observe = (authStatus, at, seat = US, provider = 'Claude') => monitor.observe(seat, { provider, at, authStatus });
  return { alerts, statuses, recoveries, writes, monitor, observe };
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
  assert.equal(h.monitor.needsConfirmation(US, 'Claude'), true);
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

test('confirmed logout keeps requesting fast checks through unknown polls, relaunch and until reliable recovery', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  assert.equal(h.monitor.needsConfirmation(US, 'Claude'), true);
  h.observe(undefined, NOW + 2 * CONFIRM_MS + 1);
  assert.equal(h.monitor.needsConfirmation(US, 'Claude'), true);
  assert.equal(h.monitor.needsConfirmation({ ...US, configDir: '~/different' }, 'Claude'), false);
  const restarted = harness(h.writes.at(-1));
  assert.equal(restarted.monitor.needsConfirmation(US, 'Claude'), true);
  restarted.observe('logged-in', NOW + 3 * CONFIRM_MS + 1);
  assert.equal(restarted.monitor.needsConfirmation(US, 'Claude'), false);
});

test('recovery callback fires once after durable recovery and does not ring or cancel on unknown results', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  h.observe(undefined, NOW + CONFIRM_MS + 2);
  assert.deepEqual(h.recoveries, []);
  h.observe('logged-in', NOW + CONFIRM_MS + 3);
  assert.deepEqual(h.recoveries, [{ provider: 'Claude', seatId: US.id, configDir: US.configDir, alertId: h.alerts[0].id }]);
  assert.equal(h.writes.at(-1)['Claude:us'].status, 'logged-in');
  h.observe('logged-in', NOW + CONFIRM_MS + 4);
  assert.equal(h.recoveries.length, 1);
  assert.equal(h.alerts.length, 1);
  assert.deepEqual(h.monitor.pendingReceipts(), h.alerts);
});

test('confirmed status carries the same configured login command used by its alert', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  const command = 'CLAUDE_CONFIG_DIR=~/.claude-us claude auth login';
  assert.equal(h.statuses.at(-1).loginCommand, command);
  assert.equal(h.monitor.samples()[0].loginCommand, command);
  assert.ok(h.alerts[0].message.includes(command));
});

test('a phone-delivery problem becomes one durable exception per outage and survives receipt acknowledgement and restart', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  const reason = '手机通知发送失败，已保留并每60秒重试，请留意本机/通知设置。';
  assert.equal(h.monitor.recordDeliveryFailure(h.alerts[0].id, reason), true);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', reason), false);
  assert.equal(h.monitor.pendingReceipts().length, 2);
  assert.match(h.monitor.pendingReceipts()[1].message, /Claude US（us）席位.*已保留.*60秒/);
  h.monitor.acknowledge(h.alerts[0].id);
  h.monitor.acknowledge(h.monitor.pendingReceipts()[0].id);
  const restarted = harness(h.writes.at(-1));
  assert.equal(restarted.monitor.recordDeliveryFailure('seat-auth:Claude:us', reason), false);
  assert.deepEqual(restarted.monitor.pendingReceipts(), []);
  restarted.observe('logged-in', NOW + CONFIRM_MS + 2);
  restarted.observe('logged-out', NOW + CONFIRM_MS + 3);
  restarted.observe('logged-out', NOW + 2 * CONFIRM_MS + 3);
  assert.equal(restarted.monitor.recordDeliveryFailure('seat-auth:Claude:us', '手机通知发送失败，未保留，请介入。'), true);
  assert.equal(restarted.monitor.pendingReceipts().length, 2);
});

test('delivery exceptions require an actual episode and persist before acknowledging success', () => {
  const h = harness(); h.observe('logged-in', NOW);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', '失败'), false);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:missing', '失败'), false);
  h.observe('logged-out', NOW + 1); h.observe('logged-out', NOW + CONFIRM_MS + 1);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', ''), false);
  const broken = createSeatAuthMonitor({ home: '/home/test', state: h.writes.at(-1), saveState: () => { throw new Error('disk full'); } });
  assert.throws(() => broken.recordDeliveryFailure('seat-auth:Claude:us', '手机通知未保留，请介入'), /disk full/);
});

test('recovery cancellation failure remains durable even when that outage already reported a transport failure', () => {
  const h = harness(); h.observe('logged-in', NOW); h.observe('logged-out', NOW + 1);
  h.observe('logged-out', NOW + CONFIRM_MS + 1);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', '手机发送失败，已保留重试'), true);
  h.observe('logged-in', NOW + CONFIRM_MS + 2);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', '旧手机提醒撤销失败，请介入', 'cancel'), true);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', '旧手机提醒撤销失败，请介入', 'cancel'), false);
  assert.equal(h.monitor.pendingReceipts().length, 3);
  assert.match(h.monitor.pendingReceipts().at(-1).message, /撤销失败/);
});

test('an already notified legacy outage can report a durable transport issue after upgrade', () => {
  const legacy = { 'Claude:us': { provider: 'Claude', seatId: 'us', name: 'US', configDir: US.configDir,
    status: 'logged-out', statusAt: NOW, lastAt: NOW, wasLoggedIn: true, notified: true, receipts: [] } };
  const h = harness(legacy);
  assert.equal(h.monitor.recordDeliveryFailure('seat-auth:Claude:us', '旧掉线提醒发送失败，已保留'), true);
  assert.equal(h.monitor.pendingReceipts().length, 1);
  const restarted = harness(h.writes.at(-1));
  assert.equal(restarted.monitor.recordDeliveryFailure('seat-auth:Claude:us', '旧掉线提醒发送失败，已保留'), false);
});
