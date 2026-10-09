#!/usr/bin/env node
'use strict';

// Runs on the remote machine (Windows), inside a slot of its e2e-queue. Started by
// scripts/e2e-remote-win.js, which uploads this file next to e2e-queue.js and a job.json:
//   { runId, sha, ref, bundle, workDir, runDir, specs: [...], playwrightArgs: [...], install }
// workDir is the shared repository on the Windows PC (commits). Every job tests its own
// checkout, `checkouts/<runId>` next to workDir, so jobs of different commits can run at the
// same time (AGENTDECK_E2E_SLOTS > 1). Dependencies live in `deps/<lockfile key>` next to
// workDir: one folder per lockfile, installed once under a lock while other jobs wait and then
// reuse it, and never changed afterwards, so no job can pull node_modules out from under another.
// It only ever touches those folders, its own checkout and runDir (this run's output).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const say = (message) => console.log(`[remote-job] ${message}`);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
const out = (command, args, options = {}) => {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  return r.status === 0 ? r.stdout.trim() : null;
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function checkJob(job) {
  const need = ['runId', 'sha', 'workDir', 'runDir'];
  for (const key of need) if (!job[key]) throw new Error(`job.json lacks ${key}`);
  if (!/^[0-9a-f]{40}$/.test(job.sha)) throw new Error('job.json sha must be a full commit id');
  if (!/^[\w.-]+$/.test(job.runId)) throw new Error('job.json runId has odd characters');
  if (!Array.isArray(job.specs)) throw new Error('job.json specs must be a list');
  return job;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const envMs = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);

// git operations on the shared repository can collide for a moment (ref or config locks).
function retry(label, attempt, times = 8) {
  let code = 1;
  for (let i = 0; i < times; i++) { code = attempt(); if (code === 0) return 0; sleep(500 + 500 * i); }
  say(`${label} failed after ${times} tries`);
  return code;
}

// One folder of dependencies per lockfile (and platform, CPU, Node version).
const depsKey = (lockfileBytes) => crypto.createHash('sha256').update(lockfileBytes).update(`-${process.platform}-${process.arch}-${process.version}`).digest('hex').slice(0, 16);

class InstallWaitTimeout extends Error {}

// Right after npm ci the Electron binary is often still locked by the virus scanner ("the file is in
// use by another process") and the first launch fails. Start it until it answers, before any job
// relies on it. Not fatal if it never does: the tests will report the failure themselves.
function warmElectron(modules) {
  const marker = path.join(modules, 'electron', 'path.txt');
  if (!fs.existsSync(marker)) return;
  const exe = path.join(modules, 'electron', 'dist', fs.readFileSync(marker, 'utf8').trim());
  const gap = envMs('AGENTDECK_E2E_ELECTRON_RETRY_MS', 3000);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const r = spawnSync(exe, ['--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', timeout: 60000 });
    if (r.status === 0) { say(`electron starts (try ${attempt})`); return; }
    sleep(gap);
  }
  say('warning: electron did not start after install; the first tests may fail to launch it');
}

// One installer per lock. While another job holds it we log why we wait, every 30 s. A lock older
// than the stale limit (a crashed job) is broken; waiting longer than the wait limit gives up.
function withInstallLock(lockDir, fn) {
  const waitMs = envMs('AGENTDECK_E2E_INSTALL_WAIT_MS', 25 * 60000), staleMs = envMs('AGENTDECK_E2E_INSTALL_STALE_MS', 30 * 60000);
  const started = Date.now();
  let lastNote = 0;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) { say(`breaking a stale install lock (${path.basename(lockDir)})`); fs.rmdirSync(lockDir); continue; } } catch {}
      const waited = Date.now() - started;
      if (waited > waitMs) throw new InstallWaitTimeout(`waited ${Math.round(waited / 1000)} s for another job's dependency install (${path.basename(lockDir)}); giving up`);
      if (Date.now() - lastNote > 30000) { say(`waiting for another job to finish installing dependencies (${Math.round(waited / 1000)} s so far)`); lastNote = Date.now(); }
      sleep(1000);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch {} }
}

// The node_modules of this lockfile: reused when complete, otherwise installed here exactly once.
// Installing needs the commit's whole tree (postinstall runs a repo script), so the folder is a
// checkout of this commit; only its node_modules is used afterwards. Returns { modules } or { failed, code }.
function ensureDeps({ workDir, sha, lockfile, install }) {
  if (install === 'skip') return { modules: path.join(workDir, 'node_modules') };
  const key = depsKey(fs.readFileSync(lockfile));
  const base = path.join(path.dirname(workDir), 'deps');
  const dir = path.join(base, key), done = path.join(dir, '.e2e-deps-done');
  if (fs.existsSync(done)) { say(`dependencies already installed (${key})`); return { modules: path.join(dir, 'node_modules') }; }
  fs.mkdirSync(base, { recursive: true });
  try {
    return withInstallLock(path.join(base, `${key}.lock`), () => {
      if (fs.existsSync(done)) { say(`dependencies already installed (${key})`); return { modules: path.join(dir, 'node_modules') }; }
      // A folder without the done marker is the leftover of a failed or crashed install.
      spawnSync('git', ['-C', workDir, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
      fs.rmSync(dir, { recursive: true, force: true });
      spawnSync('git', ['-C', workDir, 'worktree', 'prune'], { stdio: 'ignore' });
      say(`npm ci (no install for this lockfile yet, ${key})`);
      if (spawnSync('git', ['-C', workDir, 'worktree', 'add', '-q', '--detach', '--force', dir, sha], { stdio: 'inherit' }).status) return { failed: 'git worktree add (deps)', code: 12 };
      if (run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: dir, shell: process.platform === 'win32' })) {
        spawnSync('git', ['-C', workDir, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
        fs.rmSync(dir, { recursive: true, force: true });
        return { failed: 'npm ci', code: 13 };
      }
      warmElectron(path.join(dir, 'node_modules'));
      fs.writeFileSync(done, new Date().toISOString());
      return { modules: path.join(dir, 'node_modules') };
    });
  } catch (error) {
    if (error instanceof InstallWaitTimeout) { say(error.message); return { failed: 'waiting for the dependency install lock', code: 15 }; }
    throw error;
  }
}

function removeCheckout(workDir, checkout) {
  // The junction goes first: removing the checkout must never reach into the shared node_modules.
  try { fs.unlinkSync(path.join(checkout, 'node_modules')); } catch { try { fs.rmdirSync(path.join(checkout, 'node_modules')); } catch {} }
  spawnSync('git', ['-C', workDir, 'worktree', 'remove', '--force', checkout], { stdio: 'ignore' });
  try { fs.rmSync(checkout, { recursive: true, force: true }); } catch {}
  spawnSync('git', ['-C', workDir, 'worktree', 'prune'], { stdio: 'ignore' });
}

function main(jobFile) {
  const job = checkJob(JSON.parse(fs.readFileSync(jobFile, 'utf8')));
  const { workDir, runDir } = job;
  fs.mkdirSync(runDir, { recursive: true });
  const summary = { runId: job.runId, sha: job.sha, specs: job.specs, platform: process.platform, node: process.version, started: new Date().toISOString() };
  const finish = (code, extra = {}) => {
    Object.assign(summary, { exitCode: code, finished: new Date().toISOString() }, extra);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    return code;
  };

  // 1. Get the commit into the shared repository (created on first use).
  if (!fs.existsSync(path.join(workDir, '.git'))) {
    fs.mkdirSync(workDir, { recursive: true });
    if (run('git', ['init', '-q', workDir])) return finish(10, { failed: 'git init' });
  }
  const git = (...args) => run('git', ['-C', workDir, ...args]);
  const have = () => out('git', ['-C', workDir, 'cat-file', '-t', job.sha]) === 'commit';
  if (!have()) {
    if (!job.bundle) return finish(11, { failed: 'commit not on this machine and no bundle uploaded' });
    say(`fetching ${job.sha.slice(0, 8)} from the uploaded bundle`);
    // A job for the same commit may be fetching it right now: success is that the commit is there.
    if (retry('git fetch', () => (git('fetch', '-q', job.bundle, `${job.ref}:refs/e2e/${job.sha.slice(0, 12)}`) && !have() ? 1 : 0))) return finish(11, { failed: 'git fetch bundle' });
  }

  // 2. This job's own checkout; node_modules is shared through a link.
  const checkout = path.join(path.dirname(workDir), 'checkouts', job.runId);
  try {
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    if (retry('git worktree add', () => { removeCheckout(workDir, checkout); return git('worktree', 'add', '-q', '--detach', '--force', checkout, job.sha); })) {
      return finish(12, { failed: 'git worktree add' });
    }

    // 3. Dependencies of this commit's lockfile (installed once, shared read-only).
    const deps = ensureDeps({ workDir, sha: job.sha, lockfile: path.join(checkout, 'package-lock.json'), install: job.install });
    if (deps.failed) return finish(deps.code, { failed: deps.failed });
    fs.symlinkSync(deps.modules, path.join(checkout, 'node_modules'), 'junction');

    // 4. The specs.
    const cli = path.join(checkout, 'node_modules', '@playwright', 'test', 'cli.js');
    const args = [cli, 'test', ...job.specs, '--reporter=list,json', `--output=${path.join(runDir, 'test-results')}`, ...(job.playwrightArgs || [])];
    say(`playwright test ${job.specs.join(' ')}`);
    const started = Date.now();
    const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(runDir, 'results.json'), AGENTDECK_E2E_QUEUE_HELD: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const code = run(process.execPath, args, { cwd: checkout, env });
    return finish(code, { seconds: Math.round((Date.now() - started) / 1000) });
  } finally { removeCheckout(workDir, checkout); }
}

if (require.main === module) {
  try { process.exit(main(process.argv[2])); } catch (error) { console.error(`[remote-job] ${error.message}`); process.exit(14); }
}
module.exports = { checkJob, depsKey };
