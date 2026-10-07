'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readResult, createResultMonitor, notificationOutcome, MAX_PENDING_MS } = require('../install-result');

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
  const ack = JSON.parse(fs.readFileSync(f.file + '.ack.json'));
  ack.nextNotificationAt = 0;
  fs.writeFileSync(f.file + '.ack.json', JSON.stringify(ack));
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


test('failed phone notifications have a durable three-attempt limit and never replay receipts', async (t) => {
  const f = fixture(t); f.write({ status: 'failed' });
  let delivered = 0, notified = 0;
  const poll = createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => delivered++, notify: async () => { notified++; return false; } });
  for (let i = 0; i < 5; i++) {
    await poll();
    const ack = JSON.parse(fs.readFileSync(f.file + '.ack.json'));
    ack.nextNotificationAt = 0;
    fs.writeFileSync(f.file + '.ack.json', JSON.stringify(ack));
  }
  assert.equal(delivered, 1);
  assert.equal(notified, 3);
});


test('phone fallback waits for the installer notification attempt but records the receipt immediately', async (t) => {
  const f = fixture(t); f.write({ status: 'failed', notificationPending: true, finishedAt: Date.now() });
  let delivered = 0, notified = 0;
  const poll = createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => delivered++, notify: async () => { notified++; return true; } });
  await poll();
  assert.equal(delivered, 1); assert.equal(notified, 0);
  f.write({ status: 'failed', notificationPending: true, finishedAt: Date.now() - 16000 });
  await poll();
  assert.equal(delivered, 1); assert.equal(notified, 1);
});

test('a live notification owner keeps its attempt past 15 seconds while the captain receipt is delivered', async (t) => {
  const f = fixture(t); f.write({ status: 'failed', notificationPending: true, notificationOwnerPid: process.pid, finishedAt: Date.now() - 120000 });
  let delivered = 0, notified = 0;
  const poll = createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => delivered++, notify: async () => { notified++; return true; } });
  await poll(); await poll();
  assert.equal(delivered, 1);
  assert.equal(notified, 0);
  f.write({ status: 'failed', notificationPending: false, notificationOwnerPid: process.pid, finishedAt: Date.now() - 120000 });
  await poll();
  assert.equal(notified, 1);
});

test('a definitely exited notification owner permits immediate fallback without waiting out the legacy window', async (t) => {
  const f = fixture(t), ownerPid = 123456;
  f.write({ status: 'failed', notificationPending: true, notificationOwnerPid: ownerPid, finishedAt: Date.now() });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, ownerPid); assert.equal(signal, 0);
    throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
  });
  let notified = 0;
  await createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => {}, notify: async () => { notified++; return true; } })();
  assert.equal(notified, 1);
});

test('permission denial cannot prove that the installer notification owner has exited', async (t) => {
  const f = fixture(t); f.write({ status: 'failed', notificationPending: true, notificationOwnerPid: 123456, finishedAt: Date.now() - 120000 });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  let notified = 0;
  await createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => {}, notify: async () => { notified++; return true; } })();
  assert.equal(notified, 0);
});

test('after observing owner exit the monitor rereads notification state written while receipt delivery awaited', async (t) => {
  const f = fixture(t), ownerPid = 123456;
  f.write({ status: 'failed', notificationPending: true, notificationOwnerPid: ownerPid, finishedAt: Date.now() - 120000 });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, ownerPid); assert.equal(signal, 0);
    throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
  });
  let notified = 0;
  await createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => f.write({ status: 'failed', notificationPending: false, notificationOwnerPid: ownerPid,
      notificationSent: true, notificationAccepted: true, finishedAt: Date.now() }),
    notify: async () => { notified++; return true; } })();
  assert.equal(notified, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file + '.ack.json', 'utf8')).receipt, true);
});

for (const change of ['replaced', 'removed']) test(`owner-exit recheck never sends for an installation result ${change} during receipt delivery`, async (t) => {
  const f = fixture(t);
  f.write({ status: 'failed', notificationPending: true, notificationOwnerPid: 123456, finishedAt: Date.now() - 120000 });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('process exited'), { code: 'ESRCH' }); });
  let notified = 0;
  await createResultMonitor({ file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => change === 'removed' ? fs.unlinkSync(f.file) : f.write({ id: 'another-install', status: 'failed' }),
    notify: async () => { notified++; return true; } })();
  assert.equal(notified, 0);
});

test('notification outcomes distinguish accepted queues from delivered reminders and retain boolean compatibility', () => {
  assert.deepEqual(notificationOutcome(true), { accepted: true, queued: false, sent: true });
  assert.deepEqual(notificationOutcome(false), { accepted: false, queued: false, sent: false });
  assert.deepEqual(notificationOutcome({ ok: true, queued: true }), { accepted: true, queued: true, sent: false });
  assert.deepEqual(notificationOutcome({ ok: false, accepted: true, queued: true, sent: false }), { accepted: true, queued: true, sent: false });
  assert.deepEqual(notificationOutcome({ ok: true }), { accepted: true, queued: false, sent: true });
  assert.deepEqual(notificationOutcome({ ok: false }), { accepted: false, queued: false, sent: false });
});

for (const flags of [{ notificationAccepted: true }, { notificationQueued: true }, { notificationSent: true }]) {
  test(`installer notification acceptance prevents app retry: ${Object.keys(flags)[0]}`, async (t) => {
    const f = fixture(t); f.write({ status: 'failed', ...flags });
    let delivered = 0, notified = 0;
    const options = { file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
      deliver: async () => delivered++, notify: async () => { notified++; return true; } };
    await createResultMonitor(options)(); await createResultMonitor(options)();
    assert.equal(delivered, 1);
    assert.equal(notified, 0);
  });
}

test('queued app fallback is acknowledged across restarts and uses a stable installation-result key', async (t) => {
  const f = fixture(t); f.write({ status: 'failed' });
  const notified = [];
  const options = { file: f.file, runtime: () => f.runtime, getConfig: () => f.config,
    deliver: async () => {}, notify: async (command) => { notified.push(command); return { ok: true, queued: true }; } };
  await createResultMonitor(options)();
  await createResultMonitor(options)();
  const ack = JSON.parse(fs.readFileSync(f.file + '.ack.json', 'utf8'));
  assert.equal(ack.notification, true);
  assert.equal(ack.notificationAccepted, true);
  assert.equal(ack.notificationQueued, true);
  assert.equal(ack.notificationSent, false);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].dedupeKey, 'install:' + f.r.id);
  f.config.mainSession.tasks[0].pendingInstall.id = 'install-2';
  f.write({ id: 'install-2', status: 'failed' });
  await createResultMonitor(options)();
  assert.equal(notified.length, 2);
  assert.equal(notified[1].dedupeKey, 'install:install-2');
});

test('a structured notification rejection remains retryable rather than being truthily acknowledged', async (t) => {
  const f = fixture(t); f.write({ status: 'failed' });
  let notified = 0;
  const options = { file: f.file, runtime: () => f.runtime, getConfig: () => f.config, deliver: async () => {},
    notify: async () => { notified++; return { ok: false }; } };
  await createResultMonitor(options)();
  const ack = JSON.parse(fs.readFileSync(f.file + '.ack.json', 'utf8'));
  assert.equal(ack.notificationAccepted, false);
  assert.equal(ack.notificationSent, false);
  ack.nextNotificationAt = 0; fs.writeFileSync(f.file + '.ack.json', JSON.stringify(ack));
  await createResultMonitor(options)();
  assert.equal(notified, 2);
});
