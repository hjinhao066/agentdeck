'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createQueue, QueueTimeout } = require('../scripts/e2e-queue-core');
const { parseArgs } = require('../scripts/e2e-queue');

const CLI = path.join(__dirname, '..', 'scripts', 'e2e-queue.js');
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-queue-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A pid that really is gone: a child that already exited.
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
// Several "sessions" in one test process: each gets its own fake pid, alive unless listed in `dead`.
function sessions(dir, dead = new Set(), extra = {}) {
  const logs = [];
  const make = (pid, slots = 1) => createQueue({
    dir, slots, pid, pollMs: 5, identity: () => null, log: (m) => logs.push(`${pid}: ${m}`),
    isAlive: (owner) => !dead.has(owner.pid) || (owner.childPid ? !dead.has(owner.childPid) : false), ...extra,
  });
  return { make, logs };
}

test('only one group runs; the next waits and is told how many are ahead', async (t) => {
  const { make, logs } = sessions(tempDir(t));
  const a = await make(1001).acquire();
  let bGot = false;
  const bPromise = make(1002).acquire().then((lease) => { bGot = true; return lease; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bGot, false);
  assert.ok(logs.some((m) => m.startsWith('1002:') && m.includes('排队中，前面还有 1 组')), logs.join('\n'));
  a.release();
  const b = await bPromise;
  assert.equal(bGot, true);
  b.release();
});

test('waiters go in arrival order and the count shrinks as the line moves', async (t) => {
  const { make, logs } = sessions(tempDir(t));
  const first = await make(1).acquire();
  const order = [];
  const waiter = (pid) => make(pid).acquire().then((lease) => { order.push(pid); return lease; });
  const p2 = waiter(2); await new Promise((r) => setTimeout(r, 15));
  const p3 = waiter(3); await new Promise((r) => setTimeout(r, 15));
  const p4 = waiter(4); await new Promise((r) => setTimeout(r, 30));
  assert.ok(logs.some((m) => m.startsWith('4:') && m.includes('前面还有 3 组')), logs.join('\n'));
  first.release();
  (await p2).release();
  (await p3).release();
  (await p4).release();
  assert.deepEqual(order, [2, 3, 4]);
});

test('N slots let N groups run together and the N+1th waits', async (t) => {
  const { make } = sessions(tempDir(t));
  const a = await make(1, 2).acquire();
  const b = await make(2, 2).acquire();
  assert.notEqual(a.slot, b.slot);
  await assert.rejects(make(3, 2).acquire({ timeoutMs: 40 }), QueueTimeout);
  a.release();
  const c = await make(4, 2).acquire({ timeoutMs: 1000 });
  c.release(); b.release();
});

test('a holder that crashed is reclaimed instead of deadlocking the line', async (t) => {
  const dir = tempDir(t);
  const dead = new Set();
  const { make, logs } = sessions(dir, dead);
  await make(1).acquire(); // never released: the process "crashed"
  dead.add(1);
  const lease = await make(2).acquire({ timeoutMs: 1000 });
  assert.ok(logs.some((m) => m.includes('回收失效的锁')), logs.join('\n'));
  lease.release();
});

test('a crashed holder is detected with real pids too', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'slots', '0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'slots', '0', 'owner.json'), JSON.stringify({ pid: deadPid(), label: 'ghost' }));
  const lease = await createQueue({ dir, pollMs: 5 }).acquire({ timeoutMs: 2000 });
  lease.release();
});

test('a dead wrapper whose test process is still running keeps its slot', async (t) => {
  const dir = tempDir(t);
  const dead = new Set();
  const { make } = sessions(dir, dead);
  const a = await make(10).acquire();
  a.setChild(20); // Electron still running under the wrapper...
  dead.add(10); // ...which has been killed
  await assert.rejects(make(11).acquire({ timeoutMs: 50 }), QueueTimeout);
  dead.add(20);
  (await make(12).acquire({ timeoutMs: 1000 })).release();
});

test('a waiter that died does not block the ones behind it', async (t) => {
  const dir = tempDir(t);
  const dead = new Set();
  const { make } = sessions(dir, dead);
  const holder = await make(1).acquire();
  make(2).acquire().catch(() => {}); // joins the line, then "dies"
  await new Promise((r) => setTimeout(r, 30));
  dead.add(2);
  const third = make(3).acquire({ timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 30));
  holder.release();
  (await third).release();
});

test('waiting past the limit gives up, leaves the line and says how many were ahead', async (t) => {
  const dir = tempDir(t);
  const { make } = sessions(dir);
  const a = await make(1).acquire();
  await assert.rejects(make(2).acquire({ timeoutMs: 40 }), (error) => error instanceof QueueTimeout && /前面还有 1 组/.test(error.message));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'queue')), []);
  a.release();
});

test('a slot directory with no owner file is reclaimed once it is clearly orphaned', async (t) => {
  const dir = tempDir(t);
  const slot = path.join(dir, 'slots', '0');
  fs.mkdirSync(slot, { recursive: true });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(slot, old, old);
  const { make } = sessions(dir);
  (await make(1).acquire({ timeoutMs: 1000 })).release();
});

test('release never removes a slot that already belongs to another holder', async (t) => {
  const dir = tempDir(t);
  const dead = new Set();
  const { make } = sessions(dir, dead);
  const a = await make(1).acquire();
  dead.add(1);
  const b = await make(2).acquire({ timeoutMs: 1000 });
  assert.equal(a.release(), false);
  assert.ok(fs.existsSync(path.join(dir, 'slots', String(b.slot))));
  b.release();
});

test('arguments: queue options are separate from Playwright arguments', () => {
  const o = parseArgs(['tests/e2e/a.spec.js', '--grep', 'x', '--queue-slots', '2', '--queue-wait-timeout', '5'], {});
  assert.deepEqual(o.passthrough, ['tests/e2e/a.spec.js', '--grep', 'x']);
  assert.equal(o.slots, 2); assert.equal(o.waitMinutes, 5); assert.equal(o.command, null);
  assert.deepEqual(parseArgs(['--queue-slots', '3', '--', 'node', '-v'], {}).command, ['node', '-v']);
  assert.equal(parseArgs([], { AGENTDECK_E2E_SLOTS: '4' }).slots, 4);
  assert.throws(() => parseArgs(['--queue-slots', 'x'], {}));
});

// ---- the real command-line entry, with real processes ----
function cli(dir, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, AGENTDECK_E2E_QUEUE_DIR: dir, AGENTDECK_E2E_POLL_MS: '40', AGENTDECK_E2E_QUEUE_HELD: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out: () => out })));
  return { child, done, out: () => out };
}
const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('timed out waiting');
};

test('cli: a second run queues behind the first, then runs; exit codes pass through', async (t) => {
  const dir = tempDir(t);
  const a = cli(dir, ['--', process.execPath, '-e', 'setTimeout(()=>{},700)']);
  await waitFor(() => /轮到了/.test(a.out()));
  const b = cli(dir, ['--', process.execPath, '-e', 'process.exit(3)']);
  await waitFor(() => /排队中，前面还有 1 组/.test(b.out()));
  assert.equal((await a.done).code, 0);
  const result = await b.done;
  assert.equal(result.code, 3);
  assert.match(result.out(), /轮到了/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'slots')), []);
});

test('cli: a holder killed with SIGKILL is reclaimed; nothing deadlocks', async (t) => {
  const dir = tempDir(t);
  const a = cli(dir, ['--', process.execPath, '-e', 'setTimeout(()=>{},60000)']);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'slots', '0', 'owner.json'))).childPid; } catch { return false; } });
  const { childPid } = JSON.parse(fs.readFileSync(path.join(dir, 'slots', '0', 'owner.json')));
  const b = cli(dir, ['--', process.execPath, '-e', '0']);
  await waitFor(() => /排队中/.test(b.out()));
  // The wrapper dies, but its test process still runs: the slot must stay taken.
  a.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  // (On Windows the child is in a kill-on-close job object and dies with its wrapper, so
  // there the slot is rightly free at once.)
  if (process.platform !== 'win32') assert.doesNotMatch(b.out(), /轮到了/);
  try { process.kill(childPid, 'SIGKILL'); } catch {}
  const result = await b.done;
  assert.equal(result.code, 0);
  assert.match(result.out(), /回收失效的锁/);
});

test('cli: waiting too long exits 75; running too long is killed (124) and frees the slot', async (t) => {
  const dir = tempDir(t);
  const slow = cli(dir, ['--queue-run-timeout', '0.03', '--', process.execPath, '-e', 'setTimeout(()=>{},60000)']);
  await waitFor(() => /轮到了/.test(slow.out()));
  const impatient = cli(dir, ['--queue-wait-timeout', '0.01', '--', process.execPath, '-e', '0']);
  const waited = await impatient.done;
  assert.equal(waited.code, 75);
  assert.match(waited.out(), /排队超时/);
  const killed = await slow.done;
  assert.equal(killed.code, 124);
  assert.match(killed.out(), /强制结束整棵进程树/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'slots')), []);
  assert.equal((await cli(dir, ['--', process.execPath, '-e', '0']).done).code, 0);
});

test('cli: a run inside a queued run does not wait for itself', async (t) => {
  const dir = tempDir(t);
  const outer = cli(dir, ['--', process.execPath, CLI, '--', process.execPath, '-e', 'console.log("inner-ran")']);
  const result = await outer.done;
  assert.equal(result.code, 0);
  assert.match(result.out(), /inner-ran/);
  assert.doesNotMatch(result.out(), /排队中/);
});

test('cli: --queue-status lists who is running and who is waiting', async (t) => {
  const dir = tempDir(t);
  const a = cli(dir, ['--', process.execPath, '-e', 'setTimeout(()=>{},600)']);
  await waitFor(() => /轮到了/.test(a.out()));
  const status = cli(dir, ['--queue-status']);
  const result = await status.done;
  assert.match(result.out(), /正在跑 1 组，排队 0 组/);
  await a.done;
});

// ---- the slot is released only after the whole process tree is gone ----
const GRACE = { AGENTDECK_E2E_KILL_GRACE_MS: '300' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// A parent that starts a stubborn descendant (ignores SIGTERM) and records its pid.
function stubbornTree(dir, { detached = false, parentExits = false } = {}) {
  const pidFile = path.join(dir, 'descendant.pid');
  const stubborn = path.join(dir, 'stubborn.js');
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(stubborn, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  fs.writeFileSync(parent, `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(stubborn)}], { stdio: 'ignore', detached: ${detached} });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
${parentExits ? 'c.unref();' : 'setInterval(() => {}, 1000);'}`);
  return { parent, descendantPid: () => Number(fs.readFileSync(pidFile, 'utf8')), pidFile };
}

test('cli: a run that times out frees the slot only after a SIGTERM-ignoring descendant is gone', async (t) => {
  const dir = tempDir(t);
  const tree = stubbornTree(dir);
  const run = cli(dir, ['--queue-run-timeout', '0.03', '--', process.execPath, tree.parent], GRACE);
  const result = await run.done;
  assert.equal(result.code, 124);
  assert.equal(alive(tree.descendantPid()), false, 'descendant survived the timeout');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'slots')), []);
  if (process.platform !== 'win32') assert.match(result.out(), /清理残留的子进程/);
});

test('cli: the next group does not start while the previous group still has a process', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDir(t);
  const tree = stubbornTree(dir);
  const first = cli(dir, ['--queue-run-timeout', '0.03', '--', process.execPath, tree.parent], { AGENTDECK_E2E_KILL_GRACE_MS: '1500' });
  await waitFor(() => fs.existsSync(tree.pidFile));
  const second = cli(dir, ['--', process.execPath, '-e', `process.stdout.write('SECOND-SAW-' + (${alive.toString()})(${'${PID}'}))`.replace('${PID}', String(tree.descendantPid()))]);
  await first.done;
  const result = await second.done;
  assert.match(result.out(), /SECOND-SAW-false/);
});

test('cli: a finished run does not leave helpers behind', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDir(t);
  const tree = stubbornTree(dir, { parentExits: true });
  const result = await cli(dir, ['--', process.execPath, tree.parent], GRACE).done;
  assert.equal(result.code, 0);
  assert.equal(alive(tree.descendantPid()), false, 'helper survived the run');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'slots')), []);
});

test('cli: a descendant that left the process group is also ended on timeout', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDir(t);
  const tree = stubbornTree(dir, { detached: true });
  const result = await cli(dir, ['--queue-run-timeout', '0.03', '--', process.execPath, tree.parent], GRACE).done;
  assert.equal(result.code, 124);
  assert.equal(alive(tree.descendantPid()), false, 'escaped descendant survived the timeout');
});
