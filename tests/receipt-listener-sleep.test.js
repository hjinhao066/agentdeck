'use strict';
// The Captain's `receipts --wait` across a sleeping computer. The app's own
// clock is faked (a "sleep" is a jump of that clock); nothing really sleeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const Listener = require('../receipt-listener-core');

const MINUTE = 60_000;

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-listener-sleep-'));
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
  const result = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, result };
}
async function firstRequest(dir) {
  const requests = path.join(dir, 'requests');
  for (let i = 0; i < 1200; i++) {
    for (const file of fs.readdirSync(requests).filter((name) => name.endsWith('.json'))) {
      try { return { file, request: JSON.parse(fs.readFileSync(path.join(requests, file), 'utf8')) }; } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('listener did not register');
}

// The real processBoardRequests from main.js, with the app's clock under test control.
function host(t, dir, registry, clock) {
  const pendingBoardCommands = new Map(), responses = new Map();
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const context = vm.createContext({
    fs, path, boardControlDir: dir, receiptListeners: registry, pendingBoardCommands, AutomationCore: require('../automation-core'), automation: null,
    boardRendererReady: false, receiptSessions: new Map(), managedSessions: new Map([['captain', 'captain-token']]),
    validId: (id) => /^[a-z0-9-]+$/.test(id),
    writeBoardResponse: (id, response) => responses.set(id, response),
    send() {},
    Date: class extends Date { static now() { return clock.now; } },
  });
  vm.runInContext(source.slice(source.indexOf('let processingBoardRequests = false;'), source.indexOf('function setupBoardControl()')), context);
  return { context, responses, poll: () => context.processBoardRequests(),
    enqueue(id, lease) {
      fs.writeFileSync(path.join(dir, 'requests', id + '.json'), JSON.stringify({
        id, token: 'captain-token', action: 'main-receipts', wait: true,
        expiresAt: Date.now() + 5000, listener: lease, watcher: lease.id, watcherStartedAt: 1000,
      }));
      context.processBoardRequests();
    } };
}

test('a computer that slept ten minutes does not make a live listener look abandoned', (t) => {
  const { dir, instance } = profile(t);
  const clock = { now: 1_000_000 };
  const status = [];
  const registry = Listener.createRegistry(dir, instance, (id, alive) => status.push(alive), () => clock.now);
  const app = host(t, dir, registry, clock);
  const waiting = Listener.claim(dir, 'captain-token');
  app.enqueue('first', waiting.lease);
  assert.equal(waiting.valid(), true);
  // 队长's CLI polls every few seconds; then the lid closes, and the app wakes first.
  clock.now += 3000; app.poll();
  clock.now += 10 * MINUTE;
  app.poll();
  assert.equal(waiting.valid(), true, 'the lease survives the gap');
  assert.equal(status.at(-1), true, 'and the Captain is not told the listener is gone');
  clock.now += 1000;
  app.enqueue('after-wake', waiting.lease);
  assert.deepEqual(JSON.parse(JSON.stringify(app.responses.get('after-wake') || {})).listenerStopped, undefined, 'the next poll is accepted');
  registry.dispose();
});

test('an explicit wake keeps listeners alive, but one whose process is gone still goes', (t) => {
  const { dir, instance } = profile(t);
  let now = 0, running = true;
  const registry = Listener.createRegistry(dir, instance, () => {}, () => now, () => running);
  const lease = Listener.claim(dir, 'captain');
  assert.equal(registry.register('captain', 'captain', lease.lease), true);
  now = 20 * MINUTE; registry.wake(); registry.tick(['captain']);
  assert.equal(lease.valid(), true);
  running = false; now += 1000; registry.wake(); registry.tick(['captain']);
  assert.equal(lease.valid(), false, 'a dead process is not revived by waking');
  registry.dispose();
});

test('a listener that really stopped polling is still dropped, and says why when it leaves', async (t) => {
  const { dir, instance } = profile(t);
  const clock = { now: 1_000_000 };
  const registry = Listener.createRegistry(dir, instance, () => {}, () => clock.now);
  const waiting = cli(t, dir);
  const { request } = await firstRequest(dir);
  assert.equal(registry.register('captain', 'captain-token', request.listener), true);
  clock.now += 31_000; // thirty seconds with no poll and no wake in between
  registry.tick(['captain']);
  const result = await waiting.result;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, Listener.EXPIRED_NOTICE + '\n');
  assert.match(Listener.EXPIRED_NOTICE, /睡眠/);
  assert.match(Listener.EXPIRED_NOTICE, /重新挂|重挂/);
  registry.reap(['captain-token']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipt-listeners')), [], 'host cleanup leaves nothing behind');
  registry.dispose();
});

// On Windows child.kill() ends the process outright and never runs a signal handler,
// so there is no "why it left" message to read; the check only applies to POSIX.
const noSignalHandlers = process.platform === 'win32' ? { skip: 'Windows terminates the process without running signal handlers' } : {};
for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`${signal} makes the waiting CLI say why it left`, noSignalHandlers, async (t) => {
    const { dir } = profile(t);
    const waiting = cli(t, dir);
    await firstRequest(dir);
    waiting.child.kill(signal);
    const result = await waiting.result;
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp('^【AgentDeck 监听】.*' + signal));
  });
}

test('the exits that were already quiet by design stay quiet: app restart and an ended Captain terminal', async (t) => {
  const { dir, instance } = profile(t);
  const restarted = cli(t, dir);
  await firstRequest(dir);
  Listener.initialize(dir);
  assert.deepEqual(await restarted.result, { code: 0, signal: null, stdout: '', stderr: '' });
  const next = profile(t);
  const ended = cli(t, next.dir);
  const { request } = await firstRequest(next.dir);
  const registry = Listener.createRegistry(next.dir, next.instance, () => {});
  assert.equal(registry.register('captain', 'captain-token', request.listener), true);
  registry.remove('captain');
  assert.deepEqual(await ended.result, { code: 0, signal: null, stdout: '', stderr: '' });
  registry.dispose();
  void instance;
});
