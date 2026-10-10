'use strict';
// A slot is not handed to the next group while anything of the previous run is still alive, even
// when the wrapper AND the test process it started were both killed with SIGKILL: the wrapper's
// in-memory process table and run tag are gone, so they are kept in the slot directory. Every test
// uses its own temporary queue directory; the machine's real queue and locks are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createQueue, processTable } = require('../scripts/e2e-queue-core');

const CLI = path.join(__dirname, '..', 'scripts', 'e2e-queue.js');
const posix = { skip: process.platform === 'win32' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await pause(20); }
  assert.fail('timed out waiting');
};
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-queue-residue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const slotFile = (dir, name) => path.join(dir, 'slots', '0', name);

function cli(dir, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, AGENTDECK_E2E_QUEUE_DIR: dir, AGENTDECK_E2E_POLL_MS: '40', AGENTDECK_E2E_QUEUE_HELD: '', AGENTDECK_E2E_KILL_GRACE_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  // 'exit', not 'close': a process left running keeps the inherited pipes open.
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out: () => out })));
  return { child, done, out: () => out };
}

// A run (the "test process") that starts a helper in its own process group and keeps running.
// The helper sits in a script file named like the decoy below, so only its pid tells them apart.
function helperRun(dir) {
  const helper = path.join(dir, 'helper.js');
  const parent = path.join(dir, 'parent.js');
  const pidFile = path.join(dir, 'helper.pid');
  fs.writeFileSync(helper, 'setInterval(() => {}, 1000);');
  fs.writeFileSync(parent, `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: 'ignore', detached: true });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setInterval(() => {}, 1000);`);
  return { helper, parent, helperPid: () => Number(fs.readFileSync(pidFile, 'utf8')), pidFile };
}

// Start a group, wait until its helper is recorded in the slot directory, then SIGKILL the wrapper
// and the test process: only the helper is left.
async function killedGroupWithLiveHelper(t, dir, args = []) {
  const run = helperRun(dir);
  const first = cli(dir, [...args, '--', process.execPath, run.parent]);
  t.after(() => { first.child.stdout.destroy(); first.child.stderr.destroy(); });
  await waitFor(() => fs.existsSync(run.pidFile));
  const helperPid = run.helperPid();
  t.after(() => { try { process.kill(helperPid, 'SIGKILL'); } catch {} });
  const owner = await waitFor(() => { const o = readJson(slotFile(dir, 'owner.json')); return o && o.childPid ? o : null; });
  // The wrapper writes what it has seen about once a second.
  await waitFor(() => Object.keys((readJson(slotFile(dir, 'seen.json')) || {})).includes(String(helperPid)), 10000);
  first.child.kill('SIGKILL');
  await first.done;
  try { process.kill(owner.childPid, 'SIGKILL'); } catch {}
  await waitFor(() => !alive(owner.childPid));
  assert.equal(alive(helperPid), true, 'the helper must outlive the wrapper and the test process');
  return { run, helperPid, owner };
}

test('the next group waits while a helper of a group whose wrapper and test process were both SIGKILLed is alive', posix, async (t) => {
  const dir = tempDir(t);
  const { helperPid } = await killedGroupWithLiveHelper(t, dir);
  const second = cli(dir, ['--', process.execPath, '-e', `process.stdout.write('HELPER-ALIVE-WHEN-SECOND-STARTED=' + (${alive.toString()})(${helperPid}))`]);
  t.after(() => { second.child.kill('SIGKILL'); second.child.stdout.destroy(); second.child.stderr.destroy(); });
  await waitFor(() => /排队中/.test(second.out()));
  await pause(1500);
  assert.doesNotMatch(second.out(), /HELPER-ALIVE/, 'the second group started while the helper was still alive');
  assert.ok(fs.existsSync(slotFile(dir, 'owner.json')), 'the slot was handed out while the helper was still alive');
  process.kill(helperPid, 'SIGKILL');
  const result = await second.done;
  assert.equal(result.code, 0, result.out());
  assert.match(result.out(), /HELPER-ALIVE-WHEN-SECOND-STARTED=false/);
});

test('past the run limit only the processes recorded in the slot directory are ended, never look-alikes', posix, async (t) => {
  const dir = tempDir(t);
  // Run limit 0.03 min = 1.8 s (+ grace); the helper never ends by itself.
  const { run, helperPid } = await killedGroupWithLiveHelper(t, dir, ['--queue-run-timeout', '0.03']);
  // Same program, same command line as the helper, but not part of the run.
  const decoy = spawn(process.execPath, [run.helper], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(decoy.pid, 'SIGKILL'); } catch {} });
  const second = cli(dir, ['--queue-wait-timeout', '0.3', '--', process.execPath, '-e', '0']);
  const result = await second.done;
  assert.equal(result.code, 0, `the next group never got the slot:\n${result.out()}`);
  assert.equal(alive(helperPid), false, 'the recorded helper was left running');
  assert.equal(alive(decoy.pid), true, 'a process that only looks like the helper was ended');
});

// ---- the queue itself, with a hand-made slot ----
function deadSlot(dir, owner) {
  const slot = path.join(dir, 'slots', '0');
  fs.mkdirSync(slot, { recursive: true });
  // A pid that really is gone.
  const gone = spawn(process.execPath, ['-e', '0']);
  return new Promise((resolve) => gone.on('exit', () => {
    fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: gone.pid, childPid: gone.pid, label: 'dead', ...owner }));
    resolve(slot);
  }));
}
const startOf = (pid) => processTable().find((row) => row.pid === pid)?.start;
const quiet = (dir) => createQueue({ dir, slots: 1, pollMs: 5, pid: process.pid });

test('a process recorded in the slot directory keeps the slot; a recycled pid with another start time does not', posix, async (t) => {
  const dir = tempDir(t);
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { try { helper.kill('SIGKILL'); } catch {} });
  const start = await waitFor(() => startOf(helper.pid));
  const slot = await deadSlot(dir, { tag: 'no-process-carries-this-tag' });
  fs.writeFileSync(path.join(slot, 'seen.json'), JSON.stringify({ [helper.pid]: start }));
  assert.equal(quiet(dir).snapshot().running.length, 1, 'a live recorded process must keep the slot');
  fs.writeFileSync(path.join(slot, 'seen.json'), JSON.stringify({ [helper.pid]: 'Thu Jan  1 00:00:00 1970' }));
  assert.equal(quiet(dir).snapshot().running.length, 0, 'a pid now used by an unrelated process must not keep the slot');
});

test('a process carrying the run tag keeps the slot even if it was never recorded, and is not ended', posix, async (t) => {
  const dir = tempDir(t);
  const tag = `reclaim-test-${process.pid}-${Date.now()}`;
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH, AGENTDECK_E2E_RUN_TAG: tag } });
  t.after(() => { try { helper.kill('SIGKILL'); } catch {} });
  await waitFor(() => startOf(helper.pid));
  // Deadline long past: a recorded process would be ended now.
  await deadSlot(dir, { tag, deadline: Date.now() - 60000 });
  assert.equal(quiet(dir).snapshot().running.length, 1, 'a live process of the run must keep the slot');
  assert.equal(alive(helper.pid), true, 'a process that is not recorded in the slot directory must not be ended');
  helper.kill('SIGKILL');
  await waitFor(() => quiet(dir).snapshot().running.length === 0 ? true : null, 5000);
});

test('a dead slot with nothing left behind is reclaimed at once', posix, async (t) => {
  const dir = tempDir(t);
  await deadSlot(dir, { tag: `reclaim-test-nobody-${process.pid}-${Date.now()}` });
  assert.equal(quiet(dir).snapshot().running.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'slots')), []);
});
