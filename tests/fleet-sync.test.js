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
async function hub(t, { leaseMs, now, token = 'fleet-secret-token-value' } = {}) {
  const root = tmp(t);
  const logs = [];
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json'), leaseMs, now });
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
  let now = Date.now();
  const { root, server, tokenFile } = await hub(t, { leaseMs: 200, now: () => now });
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  assert.equal(win.client.snapshot().devices.find((device) => device.id === 'dev-mac').online, true);
  now += 350;
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

function edit(side, patch) {
  const card = side.tasks.list()[0];
  side.client.noteResult(side.tasks.update({ id: card.id, updated: card.updated, patch }));
}

test('a lost acknowledgement and offline restart replay the immutable operation before later edits', async (t) => {
  const { root, server, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  mac.client.noteResult(mac.tasks.add({ project: 'agentdeck', title: 'base' }));
  await mac.client.syncOnce();
  await win.client.syncOnce();
  edit(mac, { title: 'first' });
  let lost = false;
  mac.client.fetchImpl = async (url, options) => {
    if (lost) throw new Error('offline');
    const response = await fetch(url, options);
    if (url.endsWith('/v1/tasks')) {
      await response.text();
      lost = true;
      throw new Error('response lost after commit');
    }
    return response;
  };
  assert.match((await mac.client.syncOnce()).error, /同步失败/);
  const firstOp = mac.client.taskOutbox.values().next().value.opId;
  edit(mac, { title: 'second' });
  assert.equal(mac.client.taskOutbox.values().next().value.opId, firstOp);
  // The other computer remains useful while this writer cannot connect.
  await win.client.syncOnce();
  edit(win, { detail: 'Windows worked while Mac was offline' });
  await win.client.syncOnce();
  const restarted = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  await restarted.client.syncOnce();
  assert.equal(restarted.tasks.list()[0].title, 'second');
  assert.equal(restarted.client.taskOutbox.size, 1);
  await restarted.client.syncOnce();
  await win.client.syncOnce();
  const card = win.tasks.list()[0];
  assert.equal(card.title, 'second');
  assert.equal(card.detail, 'Windows worked while Mac was offline');
  assert.deepEqual(card.conflicts, []);
  assert.equal(card.revision, 4); // create, first, Windows detail, second; replay adds none
  assert.equal(restarted.client.taskOutbox.size, 0);
});

test('edits during a task POST or snapshot pull survive and synchronize on the next round', async (t) => {
  const { root, server, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  mac.client.noteResult(mac.tasks.add({ project: 'agentdeck', title: 'base' }));
  await mac.client.syncOnce();
  await win.client.syncOnce();
  edit(mac, { title: 'first' });
  let stage = 'post';
  mac.client.fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (stage === 'post' && url.endsWith('/v1/tasks')) {
      stage = 'pull';
      edit(mac, { title: 'second' });
    } else if (stage === 'pull' && url.endsWith('/v1/snapshot')) {
      stage = 'done';
      // A separate local writer does not go through the renderer's noteResult.
      const card = mac.tasks.list()[0];
      mac.tasks.update({ id: card.id, updated: card.updated, patch: { detail: 'edited during pull' } });
    }
    return response;
  };
  await mac.client.syncOnce();
  assert.equal(mac.tasks.list()[0].title, 'second');
  assert.equal(mac.tasks.list()[0].detail, 'edited during pull');
  await mac.client.syncOnce();
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].title, 'second');
  assert.equal(win.tasks.list()[0].detail, 'edited during pull');
  assert.deepEqual(win.tasks.list()[0].conflicts, []);
});

test('captain saves during a history POST and long histories are delivered in full', async (t) => {
  const { root, server, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  const turns = Array.from({ length: 205 }, (_, i) => ({ prompt: 'turn-' + i, reply: i === 204 ? 'x'.repeat(20001) : 'reply', token: 'must-not-sync' }));
  mac.client.noteCaptain('mac-cap', { turns: turns.slice(0, 1) });
  let saved = false;
  mac.client.fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (!saved && url.endsWith('/v1/history')) {
      saved = true;
      mac.client.noteCaptain('mac-cap', { turns });
    }
    return response;
  };
  await mac.client.syncOnce();
  assert.equal(mac.client.historyOutbox.size, 1);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  const file = path.join(win.dir, 'history', 'mac-cap--dev-mac.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.turns.length, 205);
  assert.equal(record.turns[204].reply.length, 20001);
  assert.equal(fs.readFileSync(file, 'utf8').includes('must-not-sync'), false);
  assert.equal(mac.client.historyOutbox.size, 0);
});

test('release 1.1.11 task ownership, quota, review and question fields survive a round trip', async (t) => {
  const { root, server, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  const card = mac.tasks.add({ project: 'agentdeck', title: 'bound task', verify: true }).card;
  const fields = {
    flag: 'quota', session_id: 'mac-worker', attempt_id: 'attempt-1', session_host: 'Mac', session_bound_at: 100,
    dispatch_host: 'Mac', dispatch_bound_at: 50, dispatch_wait: 'waiting', resource_failure: 'quota',
    user_question: 'which?', needs_user_entry: 'entry-1', review_round: 1,
    exec_receipt: { text: 'complete', files: ['/tmp/result'], session_id: 'mac-worker', attempt_id: 'attempt-1' },
    review_claim: { round: 1, key: 'claim-1', owner: 'Mac', delivered: false },
    review_block: { round: 1, reason: 'blocked' }, review_reject: { round: 1, findings: 'redo' },
  };
  mac.tasks.upsertSynced({ ...card, ...fields });
  mac.client.noteCard({ ...card, ...fields });
  await mac.client.syncOnce();
  await win.client.syncOnce();
  const got = win.tasks.list()[0];
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(got[key], value, key);
  // Optional fields deleted locally must disappear remotely too.
  const cleaned = { ...got };
  delete cleaned.user_question;
  mac.tasks.upsertSynced(cleaned);
  mac.client.noteCard(cleaned);
  await mac.client.syncOnce();
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].user_question ?? null, null);
});

test('restored revisioned cards are retained and re-uploaded when client state and hub are empty', async (t) => {
  const { root, server, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  const card = mac.tasks.add({ project: 'agentdeck', title: 'only remaining copy' }).card;
  mac.tasks.upsertSynced({ ...card, revision: 4 });
  const restored = machine(root, 'mac', 'dev-mac', 'darwin', server.url, tokenFile);
  await restored.client.syncOnce();
  assert.equal(restored.tasks.list()[0].title, card.title);
  await restored.client.syncOnce();
  const win = machine(root, 'win', 'dev-win', 'win32', server.url, tokenFile);
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].title, card.title);
});
