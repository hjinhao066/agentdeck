'use strict';
// A slot holder's identity is its start time as `ps` prints it. Every session reads it with its
// own environment: a waiter whose locale or time zone differs from the holder's must still see a
// live holder as alive, or it deletes the slot and a second group runs at the same time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CORE = path.join(__dirname, '..', 'scripts', 'e2e-queue-core.js');

test('a live holder is not reclaimed by a waiter that reads ps in another locale or time zone', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-queue-locale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch {} });
  // The holder records its identity the way acquire() does, in an English session.
  const english = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  delete english.TZ;
  const identity = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(CORE)}).processIdentity(${holder.pid})))`], { env: english, encoding: 'utf8' }).stdout;
  assert.ok(identity && identity !== 'null', 'could not read the holder start time');
  const slot = path.join(dir, 'slots', '0');
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: holder.pid, identity, label: 'holder' }));
  for (const extra of [{ LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }, { TZ: 'UTC' }]) {
    const env = { ...english, ...extra };
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CORE)}).createQueue({ dir: ${JSON.stringify(dir)} }).snapshot()`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(slot, 'owner.json')), `a waiter with ${JSON.stringify(extra)} deleted the slot of a holder that is still running`);
  }
});
