'use strict';
// install-result.json stays in place after a verified install (only the next scripted install
// replaces it), and readResult checks a success against the version running now. Once a success
// receipt had gone out, running any other version (a DMG opened by hand, a copy made outside
// restart-agentdeck.sh) turned that old success into "failed" and raised an urgent
// "安装 X 失败" alert. Only the check before the receipt goes out may fail an install.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResultMonitor } = require('../install-result');

function fixture(t, ack) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-settled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appPath = path.join(dir, 'AgentDeck.app');
  const file = path.join(dir, 'install-result.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'install-203', status: 'success', operation: 'install', targetVersion: '2.0.3', activeVersion: '2.0.3',
    running: true, appPath, createdAt: new Date().toISOString(), finishedAt: Date.now(), taskId: 'task', columnId: 'worker',
    notificationPending: false, reason: 'Target version and running process verified' }));
  if (ack) fs.writeFileSync(file + '.ack.json', JSON.stringify({ id: 'install-203', ...ack }));
  const runtime = { execPath: path.join(appPath, 'Contents', 'MacOS', 'AgentDeck'), version: '2.0.3' };
  const config = { columns: [{ id: 'captain', isMain: true }], mainSession: { tasks: [{ id: 'task', colId: 'worker', installResultId: 'install-203' }] } };
  const sent = { deliver: [], notify: [] };
  const poll = createResultMonitor({ file, runtime: () => runtime, getConfig: () => config,
    deliver: async (c) => { sent.deliver.push(c.installResult.status); }, notify: async (c) => { sent.notify.push(c.message); return true; } });
  return { poll, sent, runtime };
}

test('a reported success is not turned into an urgent failure when another version runs later', async (t) => {
  const f = fixture(t);
  await f.poll();
  assert.deepEqual(f.sent.deliver, ['success']);
  f.runtime.version = '2.0.4';
  for (let i = 0; i < 3; i++) await f.poll();
  assert.deepEqual(f.sent.deliver, ['success']);
  assert.deepEqual(f.sent.notify, []);
});

test('an acknowledgement written before the receipt status was recorded counts as a reported success', async (t) => {
  const f = fixture(t, { receipt: true });
  f.runtime.version = '2.0.4';
  for (let i = 0; i < 3; i++) await f.poll();
  assert.deepEqual(f.sent.deliver, []);
  assert.deepEqual(f.sent.notify, []);
});

test('a success that no longer matches when its receipt goes out still fails and alerts', async (t) => {
  const f = fixture(t);
  f.runtime.version = '2.0.2';
  await f.poll();
  assert.deepEqual(f.sent.deliver, ['failed']);
  assert.equal(f.sent.notify.length, 1);
  assert.match(f.sent.notify[0], /安装 2\.0\.3 失败/);
});
