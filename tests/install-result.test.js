'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readResult, createResultMonitor, MAX_PENDING_MS } = require('../install-result');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-result-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appPath = path.join(dir, 'AgentDeck.app');
  const file = path.join(dir, 'install-result.json');
  const runtime = { execPath: path.join(appPath, 'Contents', 'MacOS', 'AgentDeck'), version: '1.2.0' };
  const r = { id: 'install-1', status: 'success', targetVersion: '1.2.0', activeVersion: '1.2.0', running: true, appPath, createdAt: Date.now(), taskId: 'task', columnId: 'worker' };
  const write = (extra = {}) => fs.writeFileSync(file, JSON.stringify({ ...r, ...extra }));
  const config = { columns: [{ id: 'captain', isMain: true }], mainSession: { tasks: [{ id: 'task', colId: 'worker', pendingInstall: { id: r.id } }] } };
  write();
  return { file, runtime, r, write, config };
}

test('success requires the actual target executable and matching running version', (t) => {
  const f = fixture(t);
  assert.equal(readResult(f.file, f.runtime).status, 'success');
  assert.equal(readResult(f.file, { ...f.runtime, execPath: '/fake/dev/Electron' }), null);
  assert.equal(readResult(f.file, { ...f.runtime, version: '1.1.11' }).status, 'failed');
  f.write({ running: false });
  assert.equal(readResult(f.file, f.runtime).status, 'failed');
});

test('pending waits for the installer then reports a bounded timeout', (t) => {
  const f = fixture(t); f.write({ status: 'pending' });
  assert.equal(readResult(f.file, f.runtime), null);
  assert.match(readResult(f.file, f.runtime, Date.now() + MAX_PENDING_MS + 1).reason, /30 分钟/);
});

for (const status of ['success', 'failed']) test(`${status} produces one durable captain receipt and failure sends urgent notification`, async (t) => {
  const f = fixture(t); f.write({ status, reason: status === 'failed' ? 'copy failed' : '' });
  const commands = [], notices = [];
  const options = { file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async (cmd) => commands.push(cmd), notify: async (cmd) => { notices.push(cmd); return true; } };
  await createResultMonitor(options)();
  await createResultMonitor(options)();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].installResult.status, status);
  assert.equal(commands[0].installResult.taskId, 'task');
  assert.equal(notices.length, status === 'failed' ? 1 : 0);
  if (notices.length) { assert.equal(notices[0].urgent, true); assert.match(notices[0].message, /1\.2\.0.*copy failed/); }
  assert.equal(JSON.parse(fs.readFileSync(f.file + '.ack.json')).receipt, true);
});

test('failed receipt delivery is retried and never acknowledged; notification failure does not replay receipts', async (t) => {
  const f = fixture(t); f.write({ status: 'failed', reason: 'bad install' });
  let deliveries = 0, notifications = 0;
  const poll = createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => { if (++deliveries === 1) throw new Error('renderer not ready'); },
    notify: async () => { if (++notifications === 1) throw new Error('network'); return true; } });
  await assert.rejects(poll(), /renderer/);
  assert.equal(fs.existsSync(f.file + '.ack.json'), false);
  await assert.rejects(poll(), /network/);
  await poll();
  assert.equal(deliveries, 2);
  assert.equal(notifications, 2);
});

test('a result cannot settle a different task or a different installation identity', async (t) => {
  const f = fixture(t); f.write({ taskId: 'different-task' });
  let count = 0;
  await createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => count++, notify: async () => true })();
  assert.equal(count, 0);
  assert.equal(fs.existsSync(f.file + '.ack.json'), false);
});
