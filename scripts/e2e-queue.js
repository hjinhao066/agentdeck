#!/usr/bin/env node
'use strict';

// The one way to run Playwright/Electron E2E on a shared machine:
//   npm run e2e -- tests/e2e/foo.spec.js [more playwright args]
//   node scripts/e2e-queue.js [--queue-slots N] [--queue-wait-timeout MIN] [--queue-run-timeout MIN] -- <any command>
//   node scripts/e2e-queue.js --queue-status
// Only `slots` groups (default 1) run at once across all sessions and checkouts;
// the others print "排队中，前面还有 X 组" and wait. See README「E2E 排队」.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createQueue, QueueTimeout } = require('./e2e-queue-core');

const ROOT = path.resolve(__dirname, '..');
const say = (message) => console.log(`[e2e-queue] ${message}`);

function parseArgs(argv, env = process.env) {
  const options = {
    slots: Number(env.AGENTDECK_E2E_SLOTS) || 1,
    waitMinutes: Number(env.AGENTDECK_E2E_WAIT_MINUTES) || 120,
    runMinutes: Number(env.AGENTDECK_E2E_RUN_MINUTES) || 45,
    status: false, command: null, passthrough: [],
  };
  const value = (i, name) => {
    const n = Number(argv[i + 1]);
    if (!(n > 0)) throw new Error(`${name} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { options.command = argv.slice(i + 1); break; }
    else if (arg === '--queue-slots') options.slots = Math.floor(value(i++, arg));
    else if (arg === '--queue-wait-timeout') options.waitMinutes = value(i++, arg);
    else if (arg === '--queue-run-timeout') options.runMinutes = value(i++, arg);
    else if (arg === '--queue-status') options.status = true;
    else options.passthrough.push(arg);
  }
  if (options.command && !options.command.length) throw new Error('Nothing after --');
  return options;
}

function playwrightCommand(args) {
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('Playwright is not installed here; run npm ci first');
  return [process.execPath, cli, 'test', ...args];
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TAG_VAR = 'AGENTDECK_E2E_RUN_TAG';

// One read of the process table: pid, parent, process group and start time.
function processTable() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' });
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
  if (process.platform === 'win32' || !run.pid) return [];
  const table = processTable();
  const members = new Set();
  const kids = new Map();
  for (const row of table) {
    kids.set(row.ppid, [...(kids.get(row.ppid) || []), row.pid]);
    if (row.pgid === run.pid) members.add(row.pid);
    const earlier = run.seen.get(row.pid);
    if (earlier && earlier === row.start) members.add(row.pid);
  }
  const walk = (pid) => { for (const kid of kids.get(pid) || []) { members.add(kid); walk(kid); } };
  walk(run.pid);
  for (const pid of taggedPids(run.tag)) members.add(pid);
  for (const row of table) if (members.has(row.pid)) run.seen.set(row.pid, row.start);
  members.delete(process.pid);
  return [...members].filter(isAlive);
}

function signalRun(run, signal, members = runMembers(run)) {
  if (!run.pid) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(run.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
  try { process.kill(-run.pid, signal); } catch {}
  for (const pid of members) { try { process.kill(pid, signal); } catch {} }
}

// The slot may only be released once nothing of the run is left: a child that ignores
// SIGTERM, or helpers left behind by a run that ended normally, would otherwise overlap
// the next group.
async function reap(run, graceMs) {
  if (process.platform === 'win32') return;
  let members = runMembers(run);
  if (!members.length) return;
  say(`清理残留的子进程（${members.length} 个）`);
  const gone = async (ms) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (!members.some(isAlive)) { members = runMembers(run); if (!members.length) return true; }
      await pause(100);
    }
    members = runMembers(run);
    return !members.length;
  };
  signalRun(run, 'SIGTERM', members);
  if (await gone(graceMs)) return;
  signalRun(run, 'SIGKILL', members);
  if (!(await gone(30000))) say('警告：仍有进程没能结束，不再等待');
}

function runChild(command, lease, runMs, graceMs = 10000) {
  return new Promise((resolve) => {
    const tag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(), stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, AGENTDECK_E2E_QUEUE_HELD: '1', [TAG_VAR]: tag },
    });
    lease.setChild(child.pid, { deadline: Date.now() + runMs + graceMs });
    const run = { pid: child.pid, tag, seen: new Map() };
    // Remember descendants while the run goes on (they may leave before the run ends).
    const watch = setInterval(() => { try { runMembers(run); } catch {} }, 1000);
    watch.unref();
    let timedOut = false;
    let killer;
    const stop = (signal) => {
      signalRun(run, signal);
      // A child that ignores the polite signal gets the hard one after the grace period.
      clearTimeout(killer);
      killer = setTimeout(() => signalRun(run, 'SIGKILL'), graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      say(`运行超过 ${Math.round(runMs / 60000 * 100) / 100} 分钟，强制结束整棵进程树，全部退出后才释放锁`);
      stop('SIGTERM');
    }, runMs);
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stop(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM')]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = async (code) => {
      clearTimeout(timer); clearTimeout(killer); clearInterval(watch);
      await reap(run, graceMs);
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      resolve(timedOut ? 124 : code);
    };
    child.on('error', (error) => { say(`命令没能启动：${error.message}`); finish(127); });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 + (require('node:os').constants.signals[signal] || 0) : 1)));
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  const queue = createQueue({ slots: options.slots, log: say, label: path.basename(ROOT), pollMs: Number(env.AGENTDECK_E2E_POLL_MS) || 2000 });
  if (options.status) {
    const { running, waiting } = queue.snapshot();
    say(`并发上限 ${queue.slots}，正在跑 ${running.length} 组，排队 ${waiting.length} 组（${queue.dir}）`);
    for (const r of running) say(`  跑：pid ${r.pid} ${r.label || ''} ${r.cwd || ''} 自 ${r.startedAt}`);
    for (const w of waiting) say(`  等：pid ${w.pid} ${w.label || ''} ${w.cwd || ''} 自 ${w.queuedAt}`);
    return 0;
  }
  const command = options.command || playwrightCommand(options.passthrough);
  if (env.AGENTDECK_E2E_QUEUE_HELD === '1') {
    // Already inside a queued run (e.g. release.js -> npm run test:smoke): do not wait for ourselves.
    return runChild(command, { setChild() {} }, options.runMinutes * 60000, Number(env.AGENTDECK_E2E_KILL_GRACE_MS) || 10000);
  }
  let lease;
  const abort = (signal) => () => { process.exit(signal === 'SIGINT' ? 130 : 143); };
  const early = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, abort(signal)]);
  for (const [signal, handler] of early) process.on(signal, handler);
  try {
    lease = await queue.acquire({ timeoutMs: options.waitMinutes * 60000 });
  } catch (error) {
    if (error instanceof QueueTimeout) { say(error.message); return 75; }
    throw error;
  } finally {
    for (const [signal, handler] of early) process.removeListener(signal, handler);
  }
  say(`轮到了（等了 ${Math.round(lease.waitedMs / 1000)} 秒），开始跑：${command.slice(1).map((a) => path.basename(a) === 'cli.js' ? 'playwright' : a).join(' ')}`);
  try { return await runChild(command, lease, options.runMinutes * 60000, Number(env.AGENTDECK_E2E_KILL_GRACE_MS) || 10000); }
  finally { lease.release(); }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { console.error(`[e2e-queue] ${error.message}`); process.exit(2); });
}

module.exports = { parseArgs, main };
