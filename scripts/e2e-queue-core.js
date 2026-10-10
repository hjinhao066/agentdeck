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
const { execFileSync, spawnSync } = require('node:child_process');

const defaultDir = () => process.env.AGENTDECK_E2E_QUEUE_DIR
  || path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agentdeck-e2e-queue');

// Start time of a process; tells a live holder apart from a new process that reused its pid.
// Always read in one format: `ps` prints it in the reader's locale and time zone, and a waiter
// compares it with what the holder recorded in its own environment.
const psEnv = () => {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  delete env.TZ;
  return env;
};

function processIdentity(pid) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: psEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
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

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const TAG_VAR = 'AGENTDECK_E2E_RUN_TAG';

// One read of the process table: pid, parent, process group and start time (always in the same
// format, see processIdentity: the table is written by one session and compared by another).
function processTable() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', env: psEnv() });
  const rows = [];
  for (const line of (result.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], start: m[4] });
  }
  return rows;
}

// Processes that carry this run's tag in their environment. A helper that detached from
// the process group and whose parent already exited can no longer be found through the
// process tree, but it still has the environment it was started with.
function taggedPids(tag) {
  const needle = `${TAG_VAR}=${tag}`;
  const found = [];
  if (fs.existsSync('/proc/self/environ')) {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { if (fs.readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(needle)) found.push(+name); } catch {}
    }
    return found;
  }
  const result = spawnSync('ps', ['-E', '-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  for (const line of (result.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s/.exec(line);
    if (m && new RegExp(`(^|\\s)${needle}(\\s|$)`).test(line)) found.push(+m[1]);
  }
  return found;
}

// Everything that still belongs to the run: its process group, everything below it in the
// process tree, everything seen below it earlier (pid + start time, so a reused pid is not
// mistaken for it), and everything carrying its tag.
function runMembers(run) {
  // `run.pid` may be 0: the run's own process is gone, but its record (tag, seen) can still find leftovers.
  if (process.platform === 'win32' || (!run.pid && !run.tag && !run.seen.size)) return [];
  const table = processTable();
  const members = new Set();
  const kids = new Map();
  for (const row of table) {
    kids.set(row.ppid, [...(kids.get(row.ppid) || []), row.pid]);
    if (run.pid && row.pgid === run.pid) members.add(row.pid);
    const earlier = run.seen.get(row.pid);
    if (earlier && earlier === row.start) members.add(row.pid);
  }
  const walk = (pid) => { for (const kid of kids.get(pid) || []) { members.add(kid); walk(kid); } };
  if (run.pid) walk(run.pid);
  if (run.tag) for (const pid of taggedPids(run.tag)) members.add(pid);
  for (const row of table) if (members.has(row.pid)) run.seen.set(row.pid, row.start);
  members.delete(process.pid);
  return [...members].filter(isAlive);
}

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

  // What the wrapper kept in memory about its run, written to the slot directory by the wrapper
  // while it runs (setChild/saveSeen): the run tag and every process seen below it, with start
  // times. They are all that is left to find a helper after the wrapper itself is killed.
  const seenFile = (name) => path.join(slotDir(name), 'seen.json');
  function runOf(name, owner) {
    const seen = new Map();
    for (const [key, start] of Object.entries(readJson(seenFile(name)) || {})) seen.set(Number(key), start);
    // The test process's pid is only trusted as a process group / tree root while it is the same
    // process (or gone): a pid reused by an unrelated process must not pull that one in.
    const rootGone = !owner.childPid || pidAlive(owner.childPid, owner.childIdentity) || !isAlive(owner.childPid);
    return { pid: rootGone ? owner.childPid || 0 : 0, tag: owner.tag, seen };
  }

  // Processes of the holder's run that are still alive (empty on Windows, where the run is ended as one tree).
  function leftovers(name, owner) {
    if (process.platform === 'win32') return { all: [], recorded: [] };
    const run = runOf(name, owner);
    const all = runMembers(run).filter((p) => p !== pid);
    // Only what the slot directory recorded may be ended: the test process, its group and the
    // processes seen below it. A process found only through the tag keeps the slot but is left alone.
    const recorded = all.filter((p) => run.seen.has(p) || p === owner.childPid);
    return { all, recorded, run };
  }

  // The run limit is kept by the wrapper. A wrapper killed with SIGKILL leaves its test process (and
  // whatever that started) running with nobody to end them: once past the deadline it recorded
  // (limit + grace), a waiter ends the recorded ones, and a later look reclaims the slot.
  function overdue(owner, left) {
    return process.platform !== 'win32' && Number.isFinite(owner.deadline) && clock() > owner.deadline && !owner.young
      && !pidAlive(owner.pid, owner.identity) && left.recorded.length > 0;
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
        if (!owner || owner.young) continue;
        const dead = owner.orphan || !alive(owner);
        // A holder that is gone may still have helpers running (a detached grandchild outlives a
        // killed wrapper and test process): the next group must not start on top of them.
        const left = (owner.orphan || !(owner.tag || owner.childPid)) ? { all: [], recorded: [] } : leftovers(name, owner);
        if (dead && !left.all.length) {
          log(`回收失效的锁：第 ${name} 组，持有者 pid ${owner.pid}${owner.label ? `（${owner.label}）` : ''} 已不在`);
          fs.rmSync(slotDir(name), { recursive: true, force: true });
        } else if (overdue(owner, left)) {
          log(`第 ${name} 组的包装进程已不在，测试进程留下的 ${left.recorded.length} 个进程（pid ${left.recorded.join('、')}）超过运行上限仍在跑：结束它们，之后回收锁`);
          if (owner.childPid > 0 && left.run && left.run.pid) { try { process.kill(-owner.childPid, 'SIGKILL'); } catch {} }
          for (const p of left.recorded) { try { process.kill(p, 'SIGKILL'); } catch {} }
        } else if (dead && left.all.length) {
          log(`第 ${name} 组的持有者已不在，但它留下的进程仍在跑（pid ${left.all.join('、')}）：等它们结束，不放行下一组`);
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
    let lastSeen = '';
    return {
      slot: n,
      waitedMs,
      // Record the test process so a killed wrapper does not hide a still-running Electron, and
      // the time by which the run must be over (see overdue).
      setChild(childPid, { deadline, tag } = {}) {
        const current = readJson(ownerFile);
        if (current && current.pid === pid) {
          fs.writeFileSync(ownerFile, JSON.stringify({ ...current, childPid, childIdentity: identityOf(childPid), ...(Number.isFinite(deadline) ? { deadline } : {}), ...(tag ? { tag } : {}) }));
        }
      },
      // The processes seen below the run (pid -> start time), kept for a waiter to find after this
      // wrapper is killed. Written whole, then renamed into place, so a reader never sees half of it.
      saveSeen(seen) {
        const text = JSON.stringify(Object.fromEntries(seen));
        if (text === lastSeen) return;
        const file = path.join(slotDir(n), 'seen.json');
        try { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file); lastSeen = text; } catch {}
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

module.exports = { createQueue, defaultDir, pidAlive, processIdentity, processTable, taggedPids, runMembers, isAlive, TAG_VAR, QueueTimeout };
