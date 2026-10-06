'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Listener = require('../receipt-listener-core');
const vm = require('vm');

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
async function firstRequest(dir, predicate) {
  const requestsDir = path.join(dir, 'requests');
  const inspect = () => {
    try {
      const files = fs.readdirSync(requestsDir).filter((name) => name.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(requestsDir, file), 'utf8');
          const request = JSON.parse(content);
          if (!predicate || predicate(request, file)) return { file, request };
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  };
  const immediate = inspect();
  if (immediate) return immediate;

  return new Promise((resolve, reject) => {
    let watcher = null, fallback = null, timer = null, settled = false;
    const cleanup = () => {
      settled = true;
      if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
      if (fallback) { clearInterval(fallback); fallback = null; }
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const check = () => {
      if (settled) return;
      const found = inspect();
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    try {
      watcher = fs.watch(requestsDir, () => { check(); });
      watcher.on('error', () => {});
    } catch (_) {}
    fallback = setInterval(check, 25);
    timer = setTimeout(() => {
      cleanup();
      try { assert.fail('listener did not register'); } catch (error) { reject(error); }
    }, 30000);
  });
}

test('later host registration replaces exactly one listener; an old release cannot revoke it', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {});
  const first = Listener.claim(dir, 'captain');
  assert.ok(first.valid());
  assert.equal(registry.register('captain', 'captain', first.lease), true);
  const replacement = Listener.claim(dir, 'captain');
  const other = Listener.claim(dir, 'other-captain');
  assert.ok(other.valid());
  assert.equal(registry.register('captain', 'captain', replacement.lease), true);
  assert.equal(first.valid(), false);
  assert.equal(first.superseded(), true);
  assert.equal(registry.register('captain', 'captain', first.lease), false);
  first.release();
  registry.reap(['captain']);
  assert.ok(replacement.valid(), 'only the old nonce is retired');
  assert.equal(replacement.superseded(), false);
  replacement.release(); other.release();
  registry.dispose();
});

test('app restart invalidates old leases and accepts exactly one restored listener', (t) => {
  const { dir } = profile(t);
  const old = Listener.claim(dir, 'captain');
  const instance = Listener.initialize(dir);
  assert.equal(old.valid(), false);
  const restored = Listener.claim(dir, 'captain');
  old.release();
  assert.ok(restored.valid());
  const registry = Listener.createRegistry(dir, instance, () => {});
  assert.equal(registry.register('captain', 'captain', restored.lease), true);
  assert.equal(registry.register('captain', 'captain', old.lease), false);
  assert.equal(old.superseded(), false, 'a restart is a quiet revocation');
  restored.release(); registry.dispose();
});

test('concurrent CLI candidates publish complete leases atomically and host registration selects one', async (t) => {
  const { dir, instance } = profile(t);
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e',
    "const listener = require(process.argv[1]).claim(process.argv[2], 'captain'); process.stdout.write(listener ? 'owner' : 'duplicate'); if (listener) setInterval(() => {}, 1000);",
    path.join(__dirname, '..', 'receipt-listener-core.js'), dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(String(data)));
    child.once('error', reject);
  })));
  assert.deepEqual(results, Array(6).fill('owner'));
  const files = fs.readdirSync(path.join(dir, 'receipt-listeners')).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 6);
  const leases = files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, 'receipt-listeners', file), 'utf8')));
  assert.equal(new Set(leases.map((lease) => lease.id)).size, 6);
  const registry = Listener.createRegistry(dir, instance, () => {});
  for (const lease of leases) assert.equal(registry.register('captain', 'captain', lease), true);
  for (const lease of leases.slice(0, -1)) assert.equal(registry.register('captain', 'captain', lease), false);
  assert.equal(registry.register('captain', 'captain', leases.at(-1)), true);
  const exits = children.map((child) => child.exitCode === null ? new Promise((resolve) => child.once('close', resolve)) : Promise.resolve());
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.all(exits);
  registry.reap(['captain']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipt-listeners')), []);
  registry.dispose();
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
  const unregistered = Listener.claim(dir, 'not-yet-polled');
  registry.remove('not-yet-polled', 'not-yet-polled');
  assert.equal(unregistered.valid(), false, 'agent exit also revokes a lease before its first poll');
  const stale = Listener.claim(dir, 'captain');
  registry.register('captain', 'captain', stale.lease);
  now = 30000; registry.tick(['captain']); assert.equal(stale.valid(), false);
  const fresh = Listener.claim(dir, 'captain');
  registry.register('captain', 'captain', fresh.lease);
  registry.dispose(); assert.equal(fresh.valid(), false);
});

test('two real CLI listeners register in order; the replaced one exits and only its replacement gets the receipt', async (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {});
  const waiting = cli(t, dir, ['--timeout', '6900']);
  const first = await firstRequest(dir, (r) => r.listener?.pid === waiting.child.pid);
  assert.equal(first.request.action, 'main-receipts');
  assert.equal(first.request.listener.pid, waiting.child.pid);
  assert.equal(registry.register('captain', 'captain-token', first.request.listener), true);
  fs.unlinkSync(path.join(dir, 'requests', first.file));
  const replacement = cli(t, dir, ['--timeout', '6900']);
  const second = await firstRequest(dir, (r) => r.listener?.pid === replacement.child.pid);
  assert.equal(second.request.listener.pid, replacement.child.pid);
  assert.notEqual(second.request.watcher, first.request.watcher);
  assert.equal(registry.register('captain', 'captain-token', second.request.listener), true);
  // The host rejects an obsolete request before it can reach the renderer.
  fs.writeFileSync(path.join(dir, 'responses', first.file), JSON.stringify({ done: true, result: '', listenerStopped: true }));
  assert.deepEqual(await waiting.result, { code: 0, stdout: Listener.SUPERSEDED_NOTICE + '\n', stderr: '' });
  const started = Date.now();
  fs.writeFileSync(path.join(dir, 'responses', second.file), JSON.stringify({ done: true, result: 'worker: 长时间无输出' }));
  assert.deepEqual(await replacement.result, { code: 0, stdout: 'worker: 长时间无输出\n', stderr: '' });
  assert.ok(Date.now() - started < 1500);
  registry.reap(['captain-token']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipt-listeners')), []);
  registry.dispose();
});

test('stale takeover and delayed release never unlink a replacement lease from CLI processes', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {}, Date.now, () => false);
  const stale = Listener.claim(dir, 'captain');
  const file = path.join(dir, 'receipt-listeners', fs.readdirSync(path.join(dir, 'receipt-listeners')).find((name) => name.endsWith('.json')));
  const contender = Listener.claim(dir, 'captain');
  assert.ok(contender.valid());
  registry.reap(['captain']); // Main process alone can clear stale nonce leases.
  assert.equal(contender.valid(), false);
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

test('a restarted listener registers while a released older lease awaits host cleanup', async (t) => {
  const { dir, instance } = profile(t);
  const first = Listener.claim(dir, 'captain-token');
  first.release();
  const registry = Listener.createRegistry(dir, instance, () => {});
  const waiting = cli(t, dir, ['--timeout', '6900']);
  const { file, request } = await firstRequest(dir);
  assert.equal(request.listener.pid, waiting.child.pid);
  assert.equal(registry.register('captain', 'captain-token', request.listener), true);
  registry.reap(['captain-token']);
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


test('claim order and client timestamps do not replace first host registration order, and repeat polls keep their place', (t) => {
  const { dir, instance } = profile(t);
  let now = 1000;
  const registry = Listener.createRegistry(dir, instance, () => {}, () => now);
  const claimedFirst = Listener.claim(dir, 'captain');
  const registeredFirst = Listener.claim(dir, 'captain');
  registeredFirst.lease.startedAt = now;
  claimedFirst.lease.startedAt = now - 1000;
  assert.equal(registry.register('captain', 'captain', registeredFirst.lease), true);
  assert.equal(registry.register('captain', 'captain', registeredFirst.lease), true);
  assert.equal(registry.register('captain', 'captain', claimedFirst.lease), true);
  assert.equal(registeredFirst.superseded(), true);
  assert.equal(registry.register('captain', 'captain', registeredFirst.lease), false);
  assert.equal(registry.register('captain', 'captain', claimedFirst.lease), true);
  assert.ok(claimedFirst.valid());
  registry.dispose();
});

test('same clock readings across three registrations still leave exactly the newest listener active', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {}, () => 1000);
  const listeners = Array.from({ length: 3 }, () => Listener.claim(dir, 'captain'));
  for (const listener of listeners) assert.equal(registry.register('captain', 'captain', listener.lease), true);
  assert.deepEqual(listeners.map((listener) => listener.valid()), [false, false, true]);
  for (const listener of listeners.slice(0, -1)) assert.equal(registry.register('captain', 'captain', listener.lease), false);
  assert.equal(registry.register('captain', 'captain', listeners[2].lease), true);
  registry.tick([]);
  assert.deepEqual(listeners.map((listener) => listener.superseded()), [false, false, false]);
  assert.deepEqual(listeners.map((listener) => listener.valid()), [false, false, false]);
  registry.dispose();
});


function hostQueue(t, dir, registry) {
  const pendingBoardCommands = new Map(), responses = new Map(), delivered = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const context = vm.createContext({
    fs, path, boardControlDir: dir, receiptListeners: registry, pendingBoardCommands,
    boardRendererReady: false, receiptSessions: new Map(), managedSessions: new Map([['captain', 'captain-token']]),
    validId: (id) => /^[a-z0-9-]+$/.test(id),
    writeBoardResponse: (id, response) => responses.set(id, response),
    send: (channel, command) => { delivered.push({ channel, command }); },
  });
  vm.runInContext(source.slice(source.indexOf('let processingBoardRequests = false;'), source.indexOf('function setupBoardControl()')), context);
  return { context, pendingBoardCommands, responses, delivered, enqueue(id, lease) {
    fs.writeFileSync(path.join(dir, 'requests', id + '.json'), JSON.stringify({
      id, token: 'captain-token', action: 'main-receipts', wait: true,
      expiresAt: Date.now() + 5000, listener: lease, watcher: lease.id, watcherStartedAt: 1000,
    }));
    context.processBoardRequests();
  } };
}

test('real host queue drops a replaced listener before renderer recovery and only delivers the replacement', (t) => {
  const { dir, instance } = profile(t);
  const registry = Listener.createRegistry(dir, instance, () => {});
  const host = hostQueue(t, dir, registry), first = Listener.claim(dir, 'captain-token');
  host.enqueue('first', first.lease);
  assert.equal(host.pendingBoardCommands.size, 1);
  assert.equal(host.delivered.length, 0);
  const replacement = Listener.claim(dir, 'captain-token');
  host.enqueue('replacement', replacement.lease);
  assert.equal(first.superseded(), true);
  assert.equal(host.pendingBoardCommands.has('first'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(host.responses.get('first'))), { done: true, result: '', listenerStopped: true });
  host.context.boardRendererReady = true;
  host.context.dispatchPendingBoardCommands();
  assert.deepEqual(host.delivered.map((item) => item.command.id), ['replacement']);
  assert.equal(host.delivered[0].channel, 'board:command');
  assert.equal(host.delivered[0].command.listener, undefined, 'process identity remains private to the host');
  assert.equal(host.delivered[0].command.token, undefined, 'capability remains private to the host');
  assert.equal(host.delivered[0].command.watcher, replacement.lease.id);
  registry.dispose();
});

test('real host queue discards leases revoked by owner death, Captain exit, or application restart', async (t) => {
  for (const reason of ['owner-death', 'captain-exit', 'app-restart']) {
    const { dir, instance } = profile(t);
    const registry = Listener.createRegistry(dir, instance, () => {}), host = hostQueue(t, dir, registry);
    const owner = reason === 'owner-death' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : null;
    t.after(() => { if (owner && owner.exitCode === null) owner.kill(); });
    const waiting = Listener.claim(dir, 'captain-token', owner?.pid || 0);
    host.enqueue(reason, waiting.lease);
    if (owner) { const exited = new Promise((resolve) => owner.once('close', resolve)); owner.kill(); await exited; }
    else if (reason === 'captain-exit') registry.remove('captain');
    else Listener.initialize(dir);
    host.context.boardRendererReady = true;
    host.context.dispatchPendingBoardCommands();
    assert.equal(host.delivered.length, 0, reason + ' never consumes a receipt');
    assert.equal(host.pendingBoardCommands.size, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(host.responses.get(reason))), { done: true, result: '', listenerStopped: true });
    assert.equal(waiting.superseded(), false, reason + ' remains a quiet revocation');
    registry.dispose();
  }
});
