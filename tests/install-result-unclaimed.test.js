'use strict';
// The installed app polls install-result.json every second. A result nobody could take (no 队长,
// or the installing task gone from mainSession.tasks, e.g. its 队长 was closed and a new one
// made) made every poll parse the whole config.json (a few MB, synchronous, main process) and
// return. A gone task also never got its receipt, so no acknowledgement was written and every
// later scripted install stopped at "Previous installation result has not been acknowledged".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createResultMonitor } = require('../install-result');

function fixture(t, result, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-unclaimed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appPath = path.join(dir, 'AgentDeck.app');
  const file = path.join(dir, 'install-result.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'install-1', status: 'success', targetVersion: '2.0.3', activeVersion: '2.0.3', running: true,
    appPath, createdAt: new Date().toISOString(), ...result }));
  const runtime = { execPath: path.join(appPath, 'Contents', 'MacOS', 'AgentDeck'), version: '2.0.3' };
  const sent = { config: 0, deliver: [], notify: [] };
  const poll = createResultMonitor({ file, runtime: () => runtime, getConfig: () => { sent.config++; return config; },
    deliver: async (c) => { sent.deliver.push(c.installResult); }, notify: async (c) => { sent.notify.push(c.message); return true; } });
  const ack = () => { try { return JSON.parse(fs.readFileSync(file + '.ack.json', 'utf8')); } catch (_) { return null; } };
  return { poll, sent, ack, config };
}

test('with no 队长, polls do not parse config.json every second, and the result goes out once one exists', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, {}, { columns: [{ id: 'c1', title: 'zsh' }] });
  for (let i = 0; i < 60; i++) { await f.poll(); now += 1000; }
  assert.equal(f.sent.deliver.length, 0);
  assert.ok(f.sent.config <= 3, `config.json parsed ${f.sent.config} times in 60 polls`);
  f.config.columns.push({ id: 'cap', isMain: true });
  for (let i = 0; i < 30; i++) { await f.poll(); now += 1000; }
  assert.equal(f.sent.deliver.length, 1);
});

for (const status of ['success', 'failed']) test(`a ${status} result whose task is gone reaches the 队长 as a notice and is acknowledged`, async (t) => {
  const f = fixture(t, { status, reason: status === 'failed' ? 'copy failed' : '', taskId: 'gone', columnId: 'worker' },
    { columns: [{ id: 'cap', isMain: true }], mainSession: { tasks: [] } });
  for (let i = 0; i < 3; i++) await f.poll();
  assert.equal(f.sent.deliver.length, 1);
  assert.equal(f.sent.deliver[0].taskId, undefined, 'no task is settled by it');
  assert.equal(f.sent.deliver[0].columnId, undefined);
  // What install-agentdeck.js checks before it starts another install.
  assert.equal(f.ack().id, 'install-1');
  assert.equal(f.ack().receipt, true);
  assert.equal(f.sent.notify.length, status === 'failed' ? 1 : 0);
});
