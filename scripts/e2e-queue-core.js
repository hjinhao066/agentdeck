'use strict';

// Machine-wide queue for Playwright/Electron E2E runs. Every checkout and every
// session on the machine shares one directory, so only `slots` groups run at once
// and the rest wait their turn (FIFO). No daemon: slots and tickets are plain
// directories/files, and a holder that died is reclaimed by looking at its pid.
//
//   <dir>/slots/<n>/owner.json     one directory per running group (mkdir is atomic)
//   <dir>/queue/<ticket>.json      one file per waiting group, sorted = arrival order
//   <dir>/reclaim.lock             short mutex around removing a dead slot
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const defaultDir = () => process.env.AGENTDECK_E2E_QUEUE_DIR
  || path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agentdeck-e2e-queue');

// Start time of a process; tells a live holder apart from a new process that reused its pid.
function processIdentity(pid) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function pidAlive(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  if (!identity) return true;
  const now = processIdentity(pid);
  return now === null || now === identity;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class QueueTimeout extends Error {
  constructor(message) { super(message); this.name = 'QueueTimeout'; this.code = 'QUEUE_TIMEOUT'; }
}

function createQueue(options = {}) {
  const dir = options.dir || defaultDir();
  const slots = Math.max(1, Math.floor(Number(options.slots) || 1));
  const pid = options.pid ?? process.pid;
  const clock = options.now || Date.now;
  const wait = options.sleep || sleep;
  const pollMs = options.pollMs ?? 2000;
  const log = options.log || (() => {});
  const label = options.label || '';
  // A holder is alive while its wrapper OR the test process it started is alive, so a
  // wrapper killed with SIGKILL does not free a slot while Electron is still running.
  const alive = options.isAlive || ((owner) => pidAlive(owner.pid, owner.identity)
    || (owner.childPid ? pidAlive(owner.childPid, owner.childIdentity) : false));
  const identityOf = options.identity || processIdentity;
  const slotsDir = path.join(dir, 'slots');
  const queueDir = path.join(dir, 'queue');
  const orphanMs = options.orphanMs ?? 15000;

  const slotDir = (n) => path.join(slotsDir, String(n));
  fs.mkdirSync(slotsDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });

  function slotOwner(n) {
    const owner = readJson(path.join(slotDir(n), 'owner.json'));
    if (owner) return owner;
    // mkdir happened but the holder crashed before writing owner.json.
    try { return clock() - fs.statSync(slotDir(n)).mtimeMs > orphanMs ? { pid: 0, orphan: true } : { pid, young: true }; }
    catch { return null; }
  }

  // Remove a slot whose holder is gone. Done under a mutex and re-checked, so two
  // waiters cannot both decide and one of them delete a slot someone just took.
  function reclaimDead() {
    const mutex = path.join(dir, 'reclaim.lock');
    try { fs.mkdirSync(mutex); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (clock() - fs.statSync(mutex).mtimeMs > 30000) fs.rmdirSync(mutex); } catch {}
      return;
    }
    try {
      for (const name of fs.readdirSync(slotsDir)) {
        const owner = slotOwner(name);
        if (owner && !owner.young && (owner.orphan || !alive(owner))) {
          log(`回收失效的锁：第 ${name} 组，持有者 pid ${owner.pid}${owner.label ? `（${owner.label}）` : ''} 已不在`);
          fs.rmSync(slotDir(name), { recursive: true, force: true });
        }
      }
    } finally { try { fs.rmdirSync(mutex); } catch {} }
  }

  function snapshot() {
    reclaimDead();
    const running = [];
    for (const name of fs.readdirSync(slotsDir)) {
      const owner = slotOwner(name);
      if (owner && !owner.young) running.push({ slot: name, ...owner });
    }
    const waiting = [];
    for (const file of fs.readdirSync(queueDir).sort()) {
      const ticket = readJson(path.join(queueDir, file));
      if (!ticket) continue;
      if (!alive(ticket)) { fs.rmSync(path.join(queueDir, file), { force: true }); continue; }
      waiting.push({ ticket: file, ...ticket });
    }
    return { running, waiting };
  }

  async function acquire({ timeoutMs = Infinity } = {}) {
    const started = clock();
    const identity = identityOf(pid);
    const ticket = `${String(started).padStart(15, '0')}-${String(pid).padStart(8, '0')}-${Math.random().toString(36).slice(2, 8)}`;
    const ticketFile = path.join(queueDir, ticket + '.json');
    fs.writeFileSync(ticketFile, JSON.stringify({ pid, identity, label, cwd: process.cwd(), queuedAt: new Date(started).toISOString() }));
    let lastShown = '';
    let lastShownAt = 0;
    try {
      for (;;) {
        const { running, waiting } = snapshot();
        const ahead = waiting.findIndex((entry) => entry.ticket === ticket + '.json');
        const free = [];
        for (let n = 0; n < slots; n++) if (!fs.existsSync(slotDir(n))) free.push(n);
        if (ahead >= 0 && ahead < free.length) {
          for (const n of free) {
            try { fs.mkdirSync(slotDir(n)); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
            const owner = { pid, identity, label, cwd: process.cwd(), startedAt: new Date(clock()).toISOString() };
            fs.writeFileSync(path.join(slotDir(n), 'owner.json'), JSON.stringify(owner));
            fs.rmSync(ticketFile, { force: true });
            return makeLease(n, owner, clock() - started);
          }
        }
        const groups = running.length + Math.max(ahead, 0);
        const message = `排队中，前面还有 ${groups} 组（正在跑 ${running.length} 组，排在前面 ${Math.max(ahead, 0)} 组，并发上限 ${slots}）`;
        if (message !== lastShown || clock() - lastShownAt > 60000) { log(message); lastShown = message; lastShownAt = clock(); }
        if (clock() - started >= timeoutMs) {
          throw new QueueTimeout(`排队超时：等了 ${Math.round((clock() - started) / 1000)} 秒仍没轮到（前面还有 ${groups} 组）`);
        }
        await wait(pollMs);
      }
    } catch (error) {
      fs.rmSync(ticketFile, { force: true });
      throw error;
    }
  }

  function makeLease(n, owner, waitedMs) {
    const ownerFile = path.join(slotDir(n), 'owner.json');
    return {
      slot: n,
      waitedMs,
      // Record the test process so a killed wrapper does not hide a still-running Electron.
      setChild(childPid) {
        const current = readJson(ownerFile);
        if (current && current.pid === pid) {
          fs.writeFileSync(ownerFile, JSON.stringify({ ...current, childPid, childIdentity: identityOf(childPid) }));
        }
      },
      release() {
        const current = readJson(ownerFile);
        // Never remove a slot that now belongs to somebody else.
        if (current && current.pid !== pid) return false;
        fs.rmSync(slotDir(n), { recursive: true, force: true });
        return true;
      },
    };
  }

  return { acquire, snapshot, dir, slots };
}

module.exports = { createQueue, defaultDir, pidAlive, processIdentity, QueueTimeout };
