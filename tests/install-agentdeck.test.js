'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install, parseArgs } = require('../scripts/install-agentdeck');
function fixture(t, fail = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { id: 'test-operation', appPath: path.join(root, 'AgentDeck.app'), data: path.join(root, 'data'), backups: path.join(root, 'backups'), targetVersion: '1.2.0' };
  const source = path.join(root, 'source.app');
  for (const [dir, ver] of [[options.appPath, '1.1.11'], [source, '1.2.0']]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'version'), ver); }
  let running = true, starts = [], notifications = 0;
  const ops = {
    version: (dir) => fs.readFileSync(path.join(dir, 'version'), 'utf8'),
    running: () => running,
    stop: async () => { running = false; },
    verify: (dir) => { assert.ok(fs.existsSync(path.join(dir, 'version'))); },
    copy: (from, to) => fs.cpSync(from, to, { recursive: true }),
    source: async () => ({ app: source, cleanup() {} }),
    start: async () => { starts.push(ops.version(options.appPath)); running = true; },
    healthy: async () => !(fail && ops.version(options.appPath) === '1.2.0'),
    notify: async () => { notifications++; return true; },
  };
  return { options, ops, starts, notifications: () => notifications, result: () => JSON.parse(fs.readFileSync(path.join(options.data, 'install-result.json'))) };
}
test('three failed launches stop, restore and start the old bundle, and persist an urgent failure', async (t) => {
  const f = fixture(t, true);
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 3);
  assert.equal(result.activeVersion, '1.1.11'); assert.equal(result.running, true);
  assert.equal(f.starts.filter((v) => v === '1.2.0').length, 3);
  assert.equal(f.starts.at(-1), '1.1.11'); assert.equal(f.notifications(), 1);
  assert.equal(f.result().notificationSent, true);
  await assert.rejects(install(f.options, f.ops), /already claimed/);
  assert.equal(f.starts.filter((v) => v === '1.2.0').length, 3);
});
test('success requires both target version and running process, then persists success', async (t) => {
  const f = fixture(t);
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'success'); assert.equal(result.activeVersion, '1.2.0');
  assert.equal(result.running, true); assert.equal(result.attempts, 1);
  assert.equal(f.notifications(), 0); assert.deepEqual(f.result(), JSON.parse(JSON.stringify(result)));
});
test('a successful health probe cannot hide the wrong active version', async (t) => {
  const f = fixture(t);
  const start = f.ops.start;
  f.ops.start = async () => { await start(); if (f.ops.version(f.options.appPath) === '1.2.0') fs.writeFileSync(path.join(f.options.appPath, 'version'), 'wrong'); };
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 3); assert.equal(result.activeVersion, '1.1.11');
});
test('missing source reports failure without removing the installed app', async (t) => {
  const f = fixture(t);
  f.ops.source = async () => { throw new Error('Missing prerequisite: dmg'); };
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 0); assert.equal(result.activeVersion, '1.1.11');
  assert.match(result.reason, /Missing prerequisite/); assert.equal(f.notifications(), 1);
});
test('rollback uses same verifier and sends urgent notification even when successful', async (t) => {
  const f = fixture(t); f.options.rollback = true;
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'success'); assert.equal(result.operation, 'rollback'); assert.equal(f.notifications(), 1);
});
test('formal launchers have no launchd restart policy; worker request is consumed once', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/install-agentdeck.js'), 'utf8');
  assert.doesNotMatch(source, /launchctl|<key>KeepAlive|<key>StartInterval/);
  assert.match(source, /fs\.unlinkSync\(options\.request\)/);
  assert.match(source, /flag: 'wx'/);
  assert.throws(() => parseArgs(['--dmg']), /missing value/);
});
test('three staging copy failures stop with old bundle restored and running', async (t) => {
  const f = fixture(t);
  const copy = f.ops.copy;
  let copies = 0;
  f.ops.copy = (from, to) => { if (from.endsWith('source.app')) { copies++; throw new Error('staging disk failure'); } copy(from, to); };
  const result = await install(f.options, f.ops);
  assert.equal(copies, 3); assert.equal(result.attempts, 3); assert.equal(result.status, 'failed');
  assert.equal(result.activeVersion, '1.1.11'); assert.equal(result.running, true); assert.equal(f.starts.at(-1), '1.1.11');
});
