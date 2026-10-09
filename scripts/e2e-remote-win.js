#!/usr/bin/env node
'use strict';

// Run E2E specs of one branch/commit on the Windows PC (ssh winpc) and bring the log
// and results back. Usage:
//   node scripts/e2e-remote-win.js <branch|commit> <spec> [<spec>...] [options] [-- extra playwright args]
// Options: --host winpc  --out DIR  --queue-wait-timeout MIN  --queue-run-timeout MIN  --no-install
// Only committed work is tested (the commit is shipped as a git bundle, so the branch
// need not be pushed). Everything lives in %USERPROFILE%\agentdeck-e2e-win on Windows;
// the installed AgentDeck and other session folders are never touched. Windows runs one
// group at a time through the same e2e-queue as the Mac.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'agentdeck-e2e-win'; // relative to the Windows home
// The shared repository + node_modules. Not "work": dispatchers from older branches still install
// into and clean "work" while their jobs run, which wrecks any job sharing that folder.
const HUB = 'hub';
const TOOLS = ['e2e-queue.js', 'e2e-queue-core.js', 'e2e-remote-job.js'];
const say = (message) => console.log(`[e2e-remote-win] ${message}`);

function parseArgs(argv) {
  const o = { host: 'winpc', waitMinutes: 120, runMinutes: 45, install: 'auto', ref: null, specs: [], playwrightArgs: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === '--') { o.playwrightArgs = argv.slice(i + 1); break; }
    else if (arg === '--host') o.host = next();
    else if (arg === '--out') o.out = path.resolve(next());
    else if (arg === '--queue-wait-timeout') o.waitMinutes = Number(next());
    else if (arg === '--queue-run-timeout') o.runMinutes = Number(next());
    else if (arg === '--no-install') o.install = 'skip';
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else if (!o.ref) o.ref = arg;
    else o.specs.push(arg);
  }
  if (!o.ref || !o.specs.length) throw new Error('Usage: e2e-remote-win.js <branch|commit> <spec> [<spec>...] [options] [-- playwright args]');
  if (!/^[\w.@/-]+$/.test(o.ref) || o.ref.startsWith('-')) throw new Error(`Odd branch name: ${o.ref}`);
  if (!/^[\w.@-]+$/.test(o.host)) throw new Error(`Odd host: ${o.host}`);
  for (const spec of o.specs) if (!/^[\w./@-]+$/.test(spec)) throw new Error(`Spec must be a plain path like tests/e2e/x.spec.js: ${spec}`);
  if (!(o.waitMinutes > 0) || !(o.runMinutes > 0)) throw new Error('Timeouts must be positive numbers of minutes');
  return o;
}

const makeRunId = (sha, now = new Date()) =>
  `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${sha.slice(0, 7)}-${crypto.randomBytes(2).toString('hex')}`;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ssh = (host, command, options = {}) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, command], { encoding: 'utf8', ...options });
const scp = (...args) => execFileSync('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// Every Windows path that goes into a cmd.exe command line is quoted, and every command that deletes
// something is built here from a validated base folder and run id. An unquoted `rmdir /s /q C:\Users\John Smith\...`
// would delete C:\Users\John.
const checkHome = (home) => {
  if (!/^[A-Za-z]:\\[\w.\\-]+$/.test(home) || home.includes('..')) throw new Error(`Unexpected Windows home: ${home}`);
  return home;
};
const q = (p) => { if (/["%^&|<>]/.test(p)) throw new Error(`Refusing odd path: ${p}`); return `"${p}"`; };
const checkBase = (winBase) => {
  if (!winBase.endsWith(`\\${BASE}`) || winBase.includes('..') || /["%^&|<>]/.test(winBase)) throw new Error(`Windows folder must be a clean path ending in \\${BASE}: ${winBase}`);
  return winBase;
};
const checkRunId = (runId) => {
  if (!/^[\w.-]+$/.test(runId) || /^\.+$/.test(runId)) throw new Error(`Odd run id: ${runId}`);
  return runId;
};
const prepareCommand = (winBase, runId) =>
  `mkdir ${q(`${checkBase(winBase)}\\inbox\\${checkRunId(runId)}\\tools`)} 2>nul & mkdir ${q(`${winBase}\\runs`)} 2>nul & exit /b 0`;
const removeRunCommand = (winBase, runId) =>
  `rmdir /s /q ${q(`${checkBase(winBase)}\\inbox\\${checkRunId(runId)}`)} & rmdir /s /q ${q(`${winBase}\\runs\\${runId}`)}`;

// The remote command: the same queue as everywhere, running the uploaded job inside a slot.
function queueCommand(home, runId, o) {
  const base = `${home}\\${BASE}`;
  // Tools are uploaded per run, so overlapping runs never overwrite a file another run is loading.
  const tools = `${base}\\inbox\\${runId}\\tools`;
  return `node ${q(`${tools}\\e2e-queue.js`)} --queue-wait-timeout ${o.waitMinutes} --queue-run-timeout ${o.runMinutes} -- node ${q(`${tools}\\e2e-remote-job.js`)} ${q(`${base}\\inbox\\${runId}\\job.json`)}`;
}

const knownBasesCommand = (base) => `git -C "%USERPROFILE%\\${base}\\${HUB}" for-each-ref refs/e2e --format=%(objectname)`;

function makeJob({ runId, sha, ref, winBase, needBundle, specs, playwrightArgs, install }) {
  return { runId, sha, ref, bundle: needBundle ? `${winBase}\\inbox\\${runId}\\commit.bundle` : null,
    workDir: `${winBase}\\${HUB}`, runDir: `${winBase}\\runs\\${runId}`, specs, playwrightArgs, install };
}

// Commits Windows already has, so the bundle only carries what is new.
function knownBases(host) {
  let listing = '';
  try { listing = ssh(host, knownBasesCommand(BASE), { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return []; }
  return listing.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s))
    .filter((sha) => { try { git('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; } });
}

function pull(host, runId, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try { scp('-r', `${host}:${BASE}/runs/${runId}/.`, dest); return true; }
  catch (error) { say(`could not copy results back: ${error.message}`); return false; }
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const sha = git('rev-parse', '--verify', `${o.ref}^{commit}`);
  if (git('status', '--porcelain', '--untracked-files=no') && o.ref === git('rev-parse', '--abbrev-ref', 'HEAD')) {
    say('note: uncommitted changes in this checkout are NOT sent; only commit ' + sha.slice(0, 8));
  }
  const runId = makeRunId(sha);
  const out = o.out || path.join(os.homedir(), 'reports', 'agentdeck-e2e-remote', runId);
  fs.mkdirSync(out, { recursive: true });
  say(`commit ${sha.slice(0, 8)} (${o.ref}) -> ${o.host}, run ${runId}`);

  const home = ssh(o.host, 'echo %USERPROFILE%').trim();
  checkHome(home);
  const winBase = `${home}\\${BASE}`;
  // mkdir makes parents; errors for "already exists" are expected and ignored. (`if ... & ...` would skip the rest.)
  ssh(o.host, prepareCommand(winBase, runId));

  // Ship the commit as a bundle (no GitHub login needed, unpushed commits work).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-remote-'));
  const tempRef = `refs/e2e-remote/${runId}`;
  try {
    git('update-ref', tempRef, sha);
    const bundle = path.join(tmp, 'commit.bundle');
    const known = knownBases(o.host);
    const needBundle = !known.includes(sha); // Windows may already hold this exact commit
    if (needBundle) git('bundle', 'create', bundle, tempRef, ...known.map((b) => `^${b}`));
    const job = makeJob({ runId, sha, ref: tempRef, winBase, needBundle, specs: o.specs, playwrightArgs: o.playwrightArgs, install: o.install });
    fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job, null, 2));
    for (const file of TOOLS) scp(path.join(__dirname, file), `${o.host}:${BASE}/inbox/${runId}/tools/${file}`);
    const inbox = `${o.host}:${BASE}/inbox/${runId}`;
    if (needBundle) scp(bundle, `${inbox}/commit.bundle`);
    scp(path.join(tmp, 'job.json'), `${inbox}/job.json`);
  } finally {
    try { git('update-ref', '-d', tempRef); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Run it, streaming the Windows output here and into a local log.
  const log = fs.createWriteStream(path.join(out, 'console.log'));
  const code = await new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', o.host, queueCommand(home, runId, o)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, sink) => stream.on('data', (chunk) => { sink.write(chunk); log.write(chunk); });
    tee(child.stdout, process.stdout); tee(child.stderr, process.stderr);
    process.on('SIGINT', () => child.kill('SIGTERM'));
    child.on('close', (c, signal) => resolve(c ?? (signal ? 130 : 1)));
  });
  log.end();

  const pulled = pull(o.host, runId, out);
  // Remove only what this run created on Windows (full path, validated run id).
  try { ssh(o.host, removeRunCommand(winBase, runId)); } catch {}
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')); } catch {}
  say(`exit ${code}${summary ? `, playwright exit ${summary.exitCode}, ${summary.seconds ?? '?'} s` : ''}; results in ${out}${pulled ? '' : ' (incomplete)'}`);
  return code;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { console.error(`[e2e-remote-win] ${error.message}`); process.exit(2); });
}

module.exports = { main, parseArgs, makeRunId, queueCommand, makeJob, knownBasesCommand, HUB, checkHome, removeRunCommand, prepareCommand };
