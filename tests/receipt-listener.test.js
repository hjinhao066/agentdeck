'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Listener = require('../receipt-listener-core');

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-listener-'));
  const instance = Listener.initialize(dir);
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, instance };
}
function cli(t, dir, args = []) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'board-cli.js'), 'receipts', '--wait', ...args], {
    env: { ...process.env, AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-token', AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_TERMINAL_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (value) => { stdout += value; });
  child.stderr.on('data', (value) => { stderr += value; });
  const result = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, result };
}
async function firstRequest(dir) {
  for (let i = 0; i < 100; i++) {
    const file = fs.readdirSync(path.join(dir, 'requests')).find((name) => name.endsWith('.json'));
    if (file) return { file, request: JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8')) };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('listener did not register');
}

test('a capability generation owns exactly one listener; release allows a replacement', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {});
  const first = Listener.claim(dir, 'captain');
  assert.ok(first.valid());
  assert.equal(Listener.claim(dir, 'captain'), null);
  const other = Listener.claim(dir, 'other-captain');
  assert.ok(other.valid());
  first.release();
  assert.equal(first.valid(), false);
  assert.equal(Listener.claim(dir, 'captain'), null); // Only the application can retire it.
  registry.reap(['captain']);
  assert.equal(Listener.retiring(dir, 'captain'), true, 'reaped between claim and retry still permits replacement');
  const replacement = Listener.claim(dir, 'captain');
  first.release(); // An old exit handler cannot revoke a replacement.
  assert.ok(replacement.valid());
  replacement.release(); other.release();
  registry.dispose();
});

test('app restart invalidates old leases and accepts exactly one restored listener', (t) => {
  const { dir } = profile(t);
  const old = Listener.claim(dir, 'captain');
  Listener.initialize(dir);
  assert.equal(old.valid(), false);
  const restored = Listener.claim(dir, 'captain');
  old.release();
  assert.ok(restored.valid());
  assert.equal(Listener.claim(dir, 'captain'), null);
  restored.release();
});

test('concurrent CLI processes publish one complete lease atomically', async (t) => {
  const { dir } = profile(t);
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e',
    "const listener = require(process.argv[1]).claim(process.argv[2], 'captain'); process.stdout.write(listener ? 'owner' : 'duplicate'); if (listener) setInterval(() => {}, 1000);",
    path.join(__dirname, '..', 'receipt-listener-core.js'), dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(String(data)));
    child.once('error', reject);
  })));
  assert.equal(results.filter((result) => result === 'owner').length, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'receipt-listeners')).filter((file) => file.endsWith('.json')).length, 1);
  const exits = children.map((child) => child.exitCode === null ? new Promise((resolve) => child.once('close', resolve)) : Promise.resolve());
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all(exits);
});

test('a listener lease is revoked when its owning agent exits although the terminal is still alive', async (t) => {
  const { dir, instance } = profile(t);
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null) owner.kill(); });
  const lease = Listener.claim(dir, 'captain', owner.pid);
  assert.ok(lease.valid());
  const registry = Listener.createRegistry(dir, instance, () => {});
  assert.equal(registry.register('captain', 'captain', lease.lease), true);
  const exited = new Promise((resolve) => owner.once('close', resolve));
  owner.kill(); await exited;
  assert.equal(lease.valid(), false);
  registry.tick(['captain']);
  assert.ok(Listener.claim(dir, 'captain').valid());
  registry.dispose();
});

test('registry reports death immediately and only repeats its cheap status every ten seconds', (t) => {
  const { dir, instance } = profile(t);
  let now = 0, running = true;
  const status = [], lease = Listener.claim(dir, 'captain');
  const registry = Listener.createRegistry(dir, instance, (id, alive) => status.push({ id, alive }), () => now, () => running);
  assert.equal(registry.register('captain', 'wrong-token', lease.lease), false);
  assert.equal(registry.register('captain', 'captain', { ...lease.lease, pid: 0 }), false);
  assert.equal(registry.register('captain', 'captain', lease.lease), true);
  registry.tick(['captain']); registry.tick(['captain']);
  assert.deepEqual(status, [{ id: 'captain', alive: true }]);
  running = false; registry.tick(['captain']);
  assert.deepEqual(status.at(-1), { id: 'captain', alive: false });
  assert.equal(lease.valid(), false);
  const length = status.length;
  now = 9999; registry.tick(['captain']); assert.equal(status.length, length);
  now = 10000; registry.tick(['captain']); assert.equal(status.length, length + 1);
  registry.dispose();
});

test('revoked Captain generation and stale listener polls clear ownership without killing unrelated PIDs', (t) => {
  const { dir, instance } = profile(t);
  let now = 0;
  const registry = Listener.createRegistry(dir, instance, () => {}, () => now);
  const old = Listener.claim(dir, 'captain');
  registry.register('captain', 'captain', old.lease);
  registry.tick([]); assert.equal(old.valid(), false);
  const stale = Listener.claim(dir, 'captain');
  registry.register('captain', 'captain', stale.lease);
  now = 30000; registry.tick(['captain']); assert.equal(stale.valid(), false);
  const fresh = Listener.claim(dir, 'captain');
  registry.register('captain', 'captain', fresh.lease);
  registry.dispose(); assert.equal(fresh.valid(), false);
});

test('a long timeout returns an arriving receipt promptly and a duplicate listener exits quietly', async (t) => {
  const { dir, instance } = profile(t);
  const waiting = cli(t, dir, ['--timeout', '6900']);
  const { file, request } = await firstRequest(dir);
  assert.equal(request.action, 'main-receipts');
  assert.equal(request.listener.pid, waiting.child.pid);
  const duplicate = await cli(t, dir, ['--timeout', '6900']).result;
  assert.deepEqual(duplicate, { code: 0, stdout: '', stderr: '' });
  const started = Date.now();
  fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: 'worker: 长时间无输出' }));
  assert.deepEqual(await waiting.result, { code: 0, stdout: 'worker: 长时间无输出\n', stderr: '' });
  assert.ok(Date.now() - started < 1500);
  Listener.createRegistry(dir, instance, () => {}).reap(['captain-token']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipt-listeners')), []);
});

test('stale takeover and delayed release never unlink a replacement lease from CLI processes', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {}, Date.now, () => false);
  const stale = Listener.claim(dir, 'captain');
  const file = path.join(dir, 'receipt-listeners', fs.readdirSync(path.join(dir, 'receipt-listeners')).find((name) => name.endsWith('.json')));
  assert.equal(Listener.claim(dir, 'captain'), null);
  registry.reap(['captain']); // Main process alone can clear a stale lease.
  const replacement = Listener.claim(dir, 'captain');
  stale.release();
  assert.ok(replacement.valid());
  // Simulate an old release publishing its own marker after the app reaped it.
  fs.writeFileSync(file + '.' + stale.lease.id + '.released', JSON.stringify(stale.lease));
  const liveRegistry = Listener.createRegistry(dir, instance, () => {});
  liveRegistry.reap(['captain']);
  assert.ok(replacement.valid());
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.released')).length, 0);
  liveRegistry.dispose();
});

test('a restarted listener waits briefly for application cleanup of a released lease and then takes ownership', async (t) => {
  const { dir, instance } = profile(t);
  const first = Listener.claim(dir, 'captain-token');
  first.release();
  const registry = Listener.createRegistry(dir, instance, () => {});
  const waiting = cli(t, dir, ['--timeout', '6900']);
  const cleanup = setTimeout(() => registry.reap(['captain-token']), 300);
  t.after(() => clearTimeout(cleanup));
  const { file, request } = await firstRequest(dir);
  assert.equal(request.listener.pid, waiting.child.pid);
  fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: 'replacement received receipt' }));
  assert.deepEqual(await waiting.result, { code: 0, stdout: 'replacement received receipt\n', stderr: '' });
  registry.dispose();
});

test('an indefinitely waiting CLI exits quietly on app restart rather than becoming an orphan', async (t) => {
  const { dir } = profile(t);
  const waiting = cli(t, dir);
  await firstRequest(dir);
  Listener.initialize(dir);
  assert.deepEqual(await waiting.result, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), []);
});

test('an indefinitely waiting CLI exits when its Captain terminal is ended', async (t) => {
  const { dir, instance } = profile(t);
  const waiting = cli(t, dir);
  const { request } = await firstRequest(dir);
  const registry = Listener.createRegistry(dir, instance, () => {});
  assert.equal(registry.register('captain', 'captain-token', request.listener), true);
  registry.remove('captain');
  assert.deepEqual(await waiting.result, { code: 0, stdout: '', stderr: '' });
  registry.dispose();
});
