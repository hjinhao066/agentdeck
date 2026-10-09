#!/usr/bin/env node
'use strict';

// Runs on the remote machine (Windows), inside a slot of its e2e-queue. Started by
// scripts/e2e-remote-win.js, which uploads this file next to e2e-queue.js and a job.json:
//   { runId, sha, ref, bundle, workDir, runDir, specs: [...], playwrightArgs: [...], install }
// It only ever touches workDir (its own checkout) and runDir (this run's output).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const say = (message) => console.log(`[remote-job] ${message}`);
const run = (command, args, options = {}) => {
  // On Windows, run with BelowNormal priority to avoid blocking user's foreground work
  if (process.platform === 'win32' && options.lowPriority) {
    // Use PowerShell to start process with BelowNormal priority
    const psCmd = `Start-Process -NoNewWindow -Wait -FilePath "${command}" -ArgumentList ${JSON.stringify(args)} -Priority BelowNormal`;
    const result = spawnSync('powershell', ['-Command', psCmd], { stdio: 'inherit', shell: false, ...options });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
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

  // 1. Get the commit into our own repository (created on first use).
  if (!fs.existsSync(path.join(workDir, '.git'))) {
    fs.mkdirSync(workDir, { recursive: true });
    if (run('git', ['init', '-q', workDir])) return finish(10, { failed: 'git init' });
  }
  const git = (...args) => run('git', ['-C', workDir, ...args]);
  const have = out('git', ['-C', workDir, 'cat-file', '-t', job.sha]) === 'commit';
  if (!have) {
    if (!job.bundle) return finish(11, { failed: 'commit not on this machine and no bundle uploaded' });
    say(`fetching ${job.sha.slice(0, 8)} from the uploaded bundle`);
    if (git('fetch', '-q', job.bundle, `${job.ref}:refs/e2e/${job.sha.slice(0, 12)}`)) return finish(11, { failed: 'git fetch bundle' });
  }
  if (git('checkout', '-q', '-f', '--detach', job.sha)) return finish(12, { failed: 'git checkout' });
  // Our own checkout only: drop leftovers of a previous run, keep node_modules.
  git('clean', '-q', '-fdx', '-e', 'node_modules', '-e', 'test-results');

  // 2. Dependencies, only when the lockfile changed since the last install here.
  const stamp = path.join(workDir, 'node_modules', '.e2e-remote-lock');
  const lockHash = fingerprint(path.join(workDir, 'package-lock.json')) + `-${process.platform}-${process.arch}-${process.version}`;
  const installed = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lockHash;
  if (job.install !== 'skip' && !installed) {
    say('npm ci (lockfile changed or first run)');
    if (run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: workDir, shell: process.platform === 'win32' })) return finish(13, { failed: 'npm ci' });
    fs.writeFileSync(stamp, lockHash);
  } else say('dependencies already installed');

  // 3. The specs.
  const cli = path.join(workDir, 'node_modules', '@playwright', 'test', 'cli.js');
  const args = [cli, 'test', ...job.specs, '--reporter=list,json', `--output=${path.join(runDir, 'test-results')}`, ...(job.playwrightArgs || [])];
  say(`playwright test ${job.specs.join(' ')}`);
  const started = Date.now();
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(runDir, 'results.json'), AGENTDECK_E2E_QUEUE_HELD: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows: run with low priority to avoid blocking user's foreground work
  const code = run(process.execPath, args, { cwd: workDir, env, lowPriority: process.platform === 'win32' });
  return finish(code, { seconds: Math.round((Date.now() - started) / 1000) });
}

if (require.main === module) {
  try { process.exit(main(process.argv[2])); } catch (error) { console.error(`[remote-job] ${error.message}`); process.exit(14); }
}
module.exports = { checkJob };
