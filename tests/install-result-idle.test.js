'use strict';
// The installed app polls install-result.json every second. The installer
// leaves the file in place after an install (only the next install replaces
// it), so once its receipt is acknowledged and no alert is still owed, a poll
// has nothing left to do. It used to parse the whole config.json (a few MB)
// and rewrite the acknowledgement file anyway, every second, for as long as
// that version ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResultMonitor } = require('../install-result');

function fixture(t, result, ack) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-idle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appPath = path.join(dir, 'AgentDeck.app');
  const file = path.join(dir, 'install-result.json');
  const runtime = { execPath: path.join(appPath, 'Contents', 'MacOS', 'AgentDeck'), version: '1.2.0' };
  fs.writeFileSync(file, JSON.stringify({ id: 'install-1', status: 'success', targetVersion: '1.2.0', activeVersion: '1.2.0', running: true, appPath,
    createdAt: Date.now(), taskId: 'task', columnId: 'worker', ...result }));
  if (ack) fs.writeFileSync(file + '.ack.json', JSON.stringify({ id: 'install-1', ...ack }));
  const counts = { config: 0, deliver: 0, notify: 0 };
  const config = { columns: [{ id: 'captain', isMain: true }], mainSession: { tasks: [{ id: 'task', colId: 'worker', installResultId: 'install-1' }] } };
  const poll = createResultMonitor({ file, runtime: () => runtime,
    getConfig: () => { counts.config++; return config; },
    deliver: async () => { counts.deliver++; }, notify: async () => { counts.notify++; return true; } });
  return { file, poll, counts };
}

async function idlePolls(t, f) {
  const before = fs.statSync(f.file + '.ack.json');
  const writes = [];
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (from, to) { writes.push(to); return real.call(this, from, to); });
  for (let i = 0; i < 5; i++) await f.poll();
  t.mock.restoreAll();
  return { writes, before };
}

test('an acknowledged successful install costs no config read and no write per poll', async (t) => {
  const f = fixture(t, {}, { receipt: true });
  const { writes } = await idlePolls(t, f);
  assert.equal(f.counts.config, 0, 'config.json is not parsed');
  assert.deepEqual(writes, [], 'the acknowledgement file is not rewritten');
  assert.equal(f.counts.deliver, 0);
  assert.equal(f.counts.notify, 0);
});

test('a failed install whose alert was accepted, or that used up its attempts, is idle too', async (t) => {
  for (const ack of [{ receipt: true, notification: true, notificationAccepted: true }, { receipt: true, notificationAttempts: 3 }]) {
    const f = fixture(t, { status: 'failed', reason: 'copy failed' }, ack);
    const { writes } = await idlePolls(t, f);
    assert.equal(f.counts.config, 0);
    assert.deepEqual(writes, []);
    assert.equal(f.counts.notify, 0);
  }
});

test('work still owed is still done: an unacknowledged receipt, and an alert for a failed install', async (t) => {
  const fresh = fixture(t, {}, null);
  await fresh.poll();
  assert.equal(fresh.counts.deliver, 1);
  assert.equal(JSON.parse(fs.readFileSync(fresh.file + '.ack.json', 'utf8')).receipt, true);
  const failed = fixture(t, { status: 'failed', reason: 'copy failed' }, { receipt: true });
  await failed.poll();
  assert.equal(failed.counts.notify, 1, 'the urgent alert for a failed install is still sent');
  assert.equal(JSON.parse(fs.readFileSync(failed.file + '.ack.json', 'utf8')).notificationAccepted, true);
});
