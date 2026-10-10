'use strict';
// The run limit (--queue-run-timeout) is enforced by the wrapper. A wrapper killed with SIGKILL
// leaves its test process running and holding the machine's only slot; past the limit that run
// must be ended and the slot freed, or a hung test blocks every other group on the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'e2e-queue.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function cli(dir, args) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, AGENTDECK_E2E_QUEUE_DIR: dir, AGENTDECK_E2E_POLL_MS: '40', AGENTDECK_E2E_QUEUE_HELD: '', AGENTDECK_E2E_KILL_GRACE_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  // 'exit', not 'close': a test process left running keeps the inherited pipes open.
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out: () => out })));
  return { child, done, out: () => out };
}
const waitFor = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  assert.fail('timed out waiting');
};

test('a hung run whose wrapper was SIGKILLed is ended at its run limit and frees the slot', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-queue-orphan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Run limit 0.02 min = 1.2 s; the test process never ends by itself.
  const a = cli(dir, ['--queue-run-timeout', '0.02', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const childPid = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'slots', '0', 'owner.json'))).childPid; } catch { return 0; } });
  t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });
  a.child.kill('SIGKILL');
  await a.done;
  t.after(() => { a.child.stdout.destroy(); a.child.stderr.destroy(); });
  // The next group may wait 0.15 min = 9 s: far past the first run's limit.
  const b = cli(dir, ['--queue-wait-timeout', '0.15', '--', process.execPath, '-e', '0']);
  const result = await b.done;
  assert.equal(result.code, 0, `the next group never got the slot:\n${result.out()}`);
  assert.equal(alive(childPid), false, 'the hung test process of the killed wrapper is still running');
});
