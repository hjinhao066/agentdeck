'use strict';
// 2026-10-10 03:52–04:29Z the Windows disk holding the hub was full ("磁盘空间不足",
// system error 112). Every save failed: each left a 0-byte store.json.*.tmp (301 of
// them) and answered 500 with nothing in the hub's log. Worse, the change had
// already been applied in memory with a receipt, so the client's retry was answered
// 200 from that receipt although the disk never had it: a hub restart before the
// next good save would have lost it on both computers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');

const TOKEN = 'hub-save-failure-token';
function hubIn(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'store.json');
}
// The next `count` writes into an open file fail as a full disk does.
function diskFull(t, count = 1) {
  const real = fs.writeFileSync;
  let left = count;
  t.mock.method(fs, 'writeFileSync', function (target, ...rest) {
    if (typeof target === 'number' && left > 0) {
      left -= 1;
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
    }
    return real.call(this, target, ...rest);
  });
}
const temps = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
const card = { opId: 'op-create-0000', cardId: 't-1', expectedRevision: 0, deviceId: 'dev-mac', set: { title: '卡片', project: 'agentdeck', status: 'todo' } };
const doing = { opId: 'op-doing-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { status: 'doing' } };

test('a change the disk did not take is not kept: no temp file, and its retry is applied and saved', (t) => {
  const file = hubIn(t);
  const hub = new SharedStore({ file });
  hub.pushTask(card);
  diskFull(t);
  assert.throws(() => hub.pushTask(doing), (err) => err.status === 507);
  assert.deepEqual(temps(file), [], 'no 0-byte temp file left behind');
  assert.equal(hub.data.cards['t-1'].status, 'todo', 'the hub holds what its file holds');
  assert.equal(hub.data.ops['op-doing-0000'], undefined, 'no receipt for a change that was not saved');
  // the disk has room again: the client sends the same operation
  const retry = hub.pushTask(doing);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.card.revision, 2);
  assert.equal(new SharedStore({ file }).data.cards['t-1'].status, 'doing', 'and it is on disk');
});

test('a heartbeat or transcript the disk did not take leaves the hub as its file has it', (t) => {
  const file = hubIn(t);
  const hub = new SharedStore({ file });
  hub.heartbeat({ id: 'dev-mac', name: 'Mac', platform: 'darwin' });
  const before = JSON.stringify(hub.data);
  diskFull(t, 2);
  assert.throws(() => hub.heartbeat({ id: 'dev-win', name: 'Windows', platform: 'win32' }), (err) => err.status === 507);
  assert.throws(() => hub.pushHistory({ opId: 'op-hist-0000', sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), turns: [{ prompt: 'p' }] }), (err) => err.status === 507);
  assert.equal(JSON.stringify(hub.data), before);
  assert.deepEqual(temps(file), []);
  assert.equal(JSON.stringify(new SharedStore({ file }).data), before);
});

test('the hub answers 507 for a full disk and says why in its log, once a minute', async (t) => {
  const file = hubIn(t);
  const store = new SharedStore({ file });
  const lines = [];
  const server = await startSyncServer({ store, token: TOKEN, report: (line) => lines.push(line) });
  t.after(() => server.close());
  const beat = () => fetch(server.url + '/v1/heartbeat', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'dev-mac', name: 'Mac', platform: 'darwin' }) });
  diskFull(t, 2);
  const first = await beat();
  assert.equal(first.status, 507);
  assert.deepEqual(await first.json(), { error: 'storage-full' });
  assert.equal((await beat()).status, 507);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /POST \/v1\/heartbeat 507 ENOSPC/);
  assert.doesNotMatch(lines[0], new RegExp(TOKEN));
  assert.equal((await beat()).status, 200, 'room again: the heartbeat goes in');
});

test('a client tells the user the hub computer is out of disk space instead of a bare status', async (t) => {
  const { FleetClient } = require('../sync-client');
  const { TaskStore } = require('../task-board');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-save-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'token'), TOKEN + '\n', { mode: 0o600 });
  const fleet = new FleetClient({
    baseUrl: 'http://hub.invalid', tokenFile: path.join(root, 'token'), device: { id: 'dev-mac', name: 'Mac', platform: 'darwin' },
    taskStore: new TaskStore(path.join(root, 'tasks')), historyDir: path.join(root, 'history'), stateFile: path.join(root, 'state.json'),
    fetchImpl: async () => new Response(JSON.stringify({ error: 'storage-full' }), { status: 507 }),
  });
  const result = await fleet.syncOnce();
  assert.match(result.error, /同步服务那台电脑的磁盘满了/);
});
