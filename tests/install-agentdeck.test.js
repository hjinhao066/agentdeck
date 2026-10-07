'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install, parseArgs, newestBackup, macOperations } = require('../scripts/install-agentdeck');
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
test('relaunching the formal CLI cannot reset the same artifact retry budget', (t) => {
  const f = fixture(t);
  const crypto = require('node:crypto');
  const { spawnSync } = require('node:child_process');
  const dmg = path.join(path.dirname(f.options.data), 'fixture.dmg');
  fs.writeFileSync(dmg, 'fixture');
  const sha = crypto.createHash('sha256').update('fixture').digest('hex');
  const id = crypto.createHash('sha256').update(JSON.stringify([f.options.appPath, dmg, sha, '1.2.0', false])).digest('hex');
  const claim = path.join(f.options.data, 'install-claims', id);
  fs.mkdirSync(path.dirname(claim), { recursive: true }); fs.writeFileSync(claim, 'already exhausted');
  const previous = { id, status: 'failed', attempts: 3, reason: 'already exhausted' };
  fs.writeFileSync(path.join(f.options.data, 'install-result.json'), JSON.stringify(previous));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
  Object.assign(env, { AGENTDECK_APP: f.options.appPath, AGENTDECK_DATA: f.options.data, AGENTDECK_BACKUPS: f.options.backups });
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawnSync(process.execPath, [path.join(__dirname, '../scripts/install-agentdeck.js'), '--go', '--dmg', dmg, '--sha256', sha, '--version', '1.2.0'], { env, encoding: 'utf8' });
    assert.equal(child.status, 1); assert.match(child.stderr, /already attempted/);
    assert.equal(fs.existsSync(path.join(f.options.data, 'install-entry.lock')), false);
    assert.deepEqual(f.result(), previous);
  }
  assert.equal(f.ops.version(f.options.appPath), '1.1.11');
});
test('backup deadline exhaustion grants a bounded recovery budget and starts old version', async (t) => {
  const f = fixture(t);
  let deadlineExpired = false, recoveryGranted = false;
  const copy = f.ops.copy;
  f.ops.copy = (from, to) => { if (to.includes('backups')) { deadlineExpired = true; throw new Error('Installation exceeded 20 minute deadline'); } copy(from, to); };
  const start = f.ops.start;
  f.ops.start = async () => { if (deadlineExpired && !recoveryGranted) throw new Error('deadline expired'); await start(); };
  f.ops.recoveryBudget = () => { recoveryGranted = true; };
  const result = await install(f.options, f.ops);
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 0); assert.equal(result.activeVersion, '1.1.11');
  assert.equal(result.running, true); assert.equal(recoveryGranted, true); assert.deepEqual(f.starts, ['1.1.11']);
});

test('rollback chooses newest backup by directory mtime across legacy and epoch names', (t) => {
  const f = fixture(t);
  const old = path.join(f.options.backups, '20261005-040100-1.1.11');
  const latest = path.join(f.options.backups, '1791234000000-new-operation');
  const invalid = path.join(f.options.backups, '9999999999999-incomplete');
  for (const dir of [old, latest]) fs.mkdirSync(path.join(dir, 'AgentDeck.app'), { recursive: true });
  fs.mkdirSync(invalid);
  fs.utimesSync(old, 100, 100); fs.utimesSync(latest, 200, 200); fs.utimesSync(invalid, 300, 300);
  assert.equal(newestBackup(f.options.backups), latest);
  fs.utimesSync(old, 400, 400);
  assert.equal(newestBackup(f.options.backups), old);
});

test('installer retains accepted queued state without claiming the reminder was sent', async (t) => {
  const f = fixture(t, true);
  f.ops.notify = async () => ({ ok: true, queued: true, sent: false });
  const result = await install(f.options, f.ops);
  assert.equal(result.notificationAccepted, true);
  assert.equal(result.notificationQueued, true);
  assert.equal(result.notificationSent, false);
  assert.equal(result.notificationPending, false);
  assert.equal(result.notificationOwnerPid, process.pid);
  assert.deepEqual(f.result(), JSON.parse(JSON.stringify(result)));
});

test('installer persists the owning process before a notification begins', async (t) => {
  const f = fixture(t, true);
  f.ops.notify = async () => {
    const pending = f.result();
    assert.equal(pending.notificationPending, true);
    assert.equal(pending.notificationOwnerPid, process.pid);
    return { ok: true, queued: true };
  };
  await install(f.options, f.ops);
  assert.equal(f.result().notificationPending, false);
  assert.equal(f.result().notificationAccepted, true);
});

test('installer preserves a rejected structured response for app fallback', async (t) => {
  const f = fixture(t, true);
  f.ops.notify = async () => ({ ok: false });
  const result = await install(f.options, f.ops);
  assert.equal(result.notificationAccepted, false);
  assert.equal(result.notificationQueued, false);
  assert.equal(result.notificationSent, false);
});

test('offline installer queues by result identity, coalescing changed text without collapsing another installation', async (t) => {
  const f = fixture(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-08T10:00:00Z'));
  fs.mkdirSync(f.options.data);
  fs.writeFileSync(path.join(f.options.data, 'config.json'), JSON.stringify({ barkNotifications: {
    sleepEnabled: true, sleepStart: '00:00', sleepEnd: '23:59', classesEnabled: false,
  } }));
  const result = { id: 'first-install', targetVersion: '1.2.0', operation: 'install', reason: 'copy failed', running: true, activeVersion: '1.1.11' };
  const ops = macOperations(f.options);
  const queued = await ops.notify(result);
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  await ops.notify({ ...result, reason: 'different failure summary' });
  let state = JSON.parse(fs.readFileSync(path.join(f.options.data, 'bark-pending.json'), 'utf8'));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].key, 'install:first-install');
  await ops.notify({ ...result, id: 'second-install' });
  state = JSON.parse(fs.readFileSync(path.join(f.options.data, 'bark-pending.json'), 'utf8'));
  assert.deepEqual(state.pending.map((item) => item.key).sort(), ['install:first-install', 'install:second-install']);
});
