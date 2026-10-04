'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient, readFleetSettings, SYNC_MS, HEARTBEAT_MS, LEASE_MS } = require('../sync-client');
const { TaskStore } = require('../task-board');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeToken(root, name, token) {
  const file = path.join(root, name);
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return file;
}
async function hub(t, { leaseMs, token = 'fleet-secret-token-value' } = {}) {
  const root = tmp(t);
  const logs = [];
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json'), leaseMs });
  const server = await startSyncServer({ store, token, log: (line) => logs.push(line) });
  t.after(() => server.close());
  return { root, server, logs, token, tokenFile: writeToken(root, 'token', token) };
}
function machine(root, name, id, platform, url, tokenFile) {
  const dir = path.join(root, name);
  const tasks = new TaskStore(path.join(dir, 'tasks'), { deviceId: id });
  const client = new FleetClient({
    baseUrl: url, tokenFile, device: { id, name, platform }, taskStore: tasks,
    historyDir: path.join(dir, 'history'), stateFile: path.join(dir, 'state.json'),
    sessions: () => [{ id: name + '-cap', role: 'captain', title: name + ' 队长' }],
    version: '1.2.0', syncMs: 40,
  });
  return { tasks, client, dir };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sync stays inside a minute and does not accept a token inside the address', () => {
  assert.equal(SYNC_MS, 10_000);
  assert.equal(HEARTBEAT_MS, 15_000);
  assert.equal(LEASE_MS, 45_000);
  assert.ok(SYNC_MS < 60_000);
  assert.equal(readFleetSettings({ env: {} }), null);
  assert.match(readFleetSettings({ env: { AGENTDECK_FLEET_URL: 'http://127.0.0.1:9' } }).error, /不完整/);
  assert.match(readFleetSettings({ env: { AGENTDECK_FLEET_URL: 'http://user:fleet-secret-token-value@127.0.0.1:9', AGENTDECK_FLEET_TOKEN_FILE: '/tmp/token' } }).error, /不能带令牌/);
});

test('two isolated machines share a card, keep both edits, and share captain history', async (t) => {
  const { root, server, logs, token, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  t.after(() => { mac.client.stop(); win.client.stop(); });

  const created = mac.tasks.add({ project: 'agentdeck', title: 'Mac 新建的卡', detail: '原始说明' });
  mac.client.noteResult(created);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  assert.equal(win.tasks.list().find((card) => card.title === 'Mac 新建的卡').deviceId, 'dev-mac');
  assert.equal(win.client.snapshot().devices.find((device) => device.id === 'dev-mac').sessions[0].deviceId, 'dev-mac');

  const macCard = mac.tasks.list()[0];
  const winCard = win.tasks.list()[0];
  mac.client.noteResult(mac.tasks.update({ id: macCard.id, updated: macCard.updated, patch: { title: 'Mac 改标题' } }));
  win.client.noteResult(win.tasks.update({ id: winCard.id, updated: winCard.updated, patch: { detail: 'Win 改说明' } }));
  await mac.client.syncOnce();
  await win.client.syncOnce();
  await mac.client.syncOnce();
  for (const side of [mac, win]) {
    const card = side.tasks.list()[0];
    assert.equal(card.title, 'Mac 改标题');
    assert.equal(card.detail, 'Win 改说明');
  }

  const macNow = mac.tasks.list()[0];
  const winNow = win.tasks.list()[0];
  mac.client.noteResult(mac.tasks.update({ id: macNow.id, updated: macNow.updated, patch: { title: '来自 Mac 的标题' } }));
  win.client.noteResult(win.tasks.update({ id: winNow.id, updated: winNow.updated, patch: { title: '来自 Win 的标题' } }));
  await mac.client.syncOnce();
  await win.client.syncOnce();
  await mac.client.syncOnce();
  for (const side of [mac, win]) {
    const raw = fs.readFileSync(path.join(side.dir, 'tasks', 'agentdeck.json'), 'utf8');
    assert.match(raw, /来自 Mac 的标题/);
    assert.match(raw, /来自 Win 的标题/);
    assert.equal(side.tasks.list()[0].title, '来自 Mac 的标题');
    assert.ok(side.client.snapshot().conflictCount >= 1);
  }

  mac.client.noteCaptain('mac-cap', { turns: [{ prompt: 'Mac 队长记下了', ts: '2026-10-04T01:00:00.000Z', token: token }] });
  await mac.client.syncOnce();
  await win.client.syncOnce();
  const historyFile = fs.readdirSync(path.join(win.dir, 'history')).find((name) => name.includes('mac-cap'));
  const history = fs.readFileSync(path.join(win.dir, 'history', historyFile), 'utf8');
  assert.match(history, /Mac 队长记下了/);
  assert.equal(history.includes(token), false);
  assert.equal(win.client.snapshot().history.some((item) => item.summary === 'Mac 队长记下了' && item.deviceId === 'dev-mac'), true);
  assert.equal(fs.readFileSync(path.join(mac.dir, 'state.json'), 'utf8').includes(token), false);
  assert.equal(logs.join('\n').includes(token), false);

  await mac.client.start();
  const second = mac.tasks.add({ project: 'agentdeck', title: '稍后同步的卡', detail: '定时器' });
  mac.client.noteResult(second);
  await delay(200);
  await win.client.syncOnce();
  assert.equal(win.tasks.list().some((card) => card.title === '稍后同步的卡'), true);
});

test('a machine that stops heartbeating is shown offline with its last seen time', async (t) => {
  const { root, server, tokenFile } = await hub(t, { leaseMs: 200 });
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  assert.equal(win.client.snapshot().devices.find((device) => device.id === 'dev-mac').online, true);
  await delay(350);
  await win.client.syncOnce();
  const quiet = win.client.snapshot().devices.find((device) => device.id === 'dev-mac');
  assert.equal(quiet.online, false);
  assert.match(quiet.lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(win.client.snapshot().devices.find((device) => device.id === 'dev-win').online, true);
});

test('sync failures stay visible and never repeat the token', async (t) => {
  const { root, server, logs, token } = await hub(t);
  const badFile = writeToken(root, 'bad', 'different-token-value');
  const tasks = new TaskStore(path.join(root, 'bad-tasks'));
  const rejected = new FleetClient({
    baseUrl: server.url, tokenFile: badFile, device: { id: 'dev-bad', name: 'Bad', platform: 'darwin' },
    taskStore: tasks, historyDir: path.join(root, 'bad-history'), stateFile: path.join(root, 'bad-state.json'),
  });
  const denied = await rejected.syncOnce();
  assert.match(denied.error, /拒绝/);
  assert.equal(denied.error.includes(token), false);
  assert.equal(denied.error.includes('different-token-value'), false);
  assert.equal(logs.join('\n').includes(token), false);

  const missing = new FleetClient({
    baseUrl: 'http://127.0.0.1:1', tokenFile: badFile, device: { id: 'dev-down', name: 'Down', platform: 'win32' },
    taskStore: new TaskStore(path.join(root, 'down-tasks')), historyDir: path.join(root, 'down-history'), stateFile: path.join(root, 'down-state.json'),
  });
  const offline = await missing.syncOnce();
  assert.match(offline.error, /连不上同步服务/);
  assert.equal(offline.error.includes('different-token-value'), false);
});
