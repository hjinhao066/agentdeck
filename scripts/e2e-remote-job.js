#!/usr/bin/env node
'use strict';

// Runs on the remote machine (Windows), inside a slot of its e2e-queue. Started by
// scripts/e2e-remote-win.js, which uploads this file next to e2e-queue.js and a job.json:
//   { runId, sha, ref, bundle, workDir, runDir, specs: [...], playwrightArgs: [...], install }
// workDir is the shared repository on the Windows PC (commits, node_modules, install stamp).
// Every job tests its own checkout, `checkouts/<runId>` next to workDir, so jobs of different
// commits can run at the same time (AGENTDECK_E2E_SLOTS > 1). It only ever touches workDir,
// its own checkout and runDir (this run's output).
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
const fingerprint = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'none'; }
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

// git operations on the shared repository can collide for a moment (ref or config locks).
function retry(label, attempt, times = 8) {
  let code = 1;
  for (let i = 0; i < times; i++) { code = attempt(); if (code === 0) return 0; sleep(500 + 500 * i); }
  say(`${label} failed after ${times} tries`);
  return code;
}

// One installer at a time. A lock left by a crashed job is broken after 30 minutes.
function withInstallLock(lockDir, fn) {
  const deadline = Date.now() + 25 * 60000;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 30 * 60000) { fs.rmdirSync(lockDir); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('another job has been installing dependencies for 25 minutes');
      sleep(2000);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch {} }
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

    // 3. Dependencies, only when the lockfile changed since the last install here. Installing
    // needs the commit's whole tree (postinstall runs a repo script), so it happens in the shared
    // repository under a lock; jobs that do not need it never touch that tree.
    const stamp = path.join(workDir, 'node_modules', '.e2e-remote-lock');
    const lockHash = fingerprint(path.join(checkout, 'package-lock.json')) + `-${process.platform}-${process.arch}-${process.version}`;
    const installed = () => fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lockHash;
    if (job.install !== 'skip' && !installed()) {
      const failed = withInstallLock(path.join(workDir, '.install.lock'), () => {
        if (installed()) return 0;
        say('npm ci (lockfile changed or first run)');
        if (git('checkout', '-q', '-f', '--detach', job.sha)) return 12;
        git('clean', '-q', '-fdx', '-e', 'node_modules', '-e', 'test-results');
        if (run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: workDir, shell: process.platform === 'win32' })) return 13;
        fs.writeFileSync(stamp, lockHash);
        return 0;
      });
      if (failed) return finish(failed, { failed: failed === 12 ? 'git checkout' : 'npm ci' });
    } else say('dependencies already installed');
    fs.symlinkSync(path.join(workDir, 'node_modules'), path.join(checkout, 'node_modules'), 'junction');

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
module.exports = { checkJob };
