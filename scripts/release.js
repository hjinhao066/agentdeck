#!/usr/bin/env node
'use strict';

// Release an owned worktree or a prepared checkout. Never install, launch, push, or touch main.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { releaseGap } = require('../mobile-web/hub/core.js');
const execFileAsync = promisify(execFile);

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const shellQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const children = new Set();
let stopping = false;
function canonical(file) {
  const suffix = [];
  let existing = path.resolve(file);
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
  // Git for Windows expands 8.3 aliases in getcwd (GetLongPathNameW). JS realpath
  // keeps the typed alias, so GitHub's RUNNER~1 temp does not match the checkout
  // and an output directory inside the repo is accepted.
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

function parseArgs(argv) {
  const options = { branches: [], dryRun: false, base: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--prepared') options.prepared = true;
    else if (arg === '--package-only') options.packageOnly = true;
    else if (['--base', '--worktree', '--output'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.version && /^\d/.test(arg)) options.version = arg;
    else options.branches.push(...arg.split(','));
  }
  if (options.version && !/^[1-9]\d*\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(options.version)) {
    throw new Error('Version must be MAJOR.MINOR or MAJOR.MINOR.PATCH (no leading zeros)');
  }
  for (const ref of [options.base, ...options.branches]) {
    if (!ref || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error(`Invalid ref: ${ref}`);
  }
  options.branches = [...new Set(options.branches)];
  if (options.prepared && (options.branches.length || options.worktree || argv.includes('--base'))) {
    throw new Error('--prepared uses the current checkout; do not supply branches, --worktree or --base');
  }
  return options;
}

function planRelease(repo, options) {
  const baseCommit = git(repo, 'rev-parse', '--verify', `${options.base}^{commit}`);
  const previous = JSON.parse(git(repo, 'show', `${baseCommit}:package.json`)).version;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(previous);
  if (!parts) throw new Error(`Unsupported base version: ${previous}`);
  const version = options.version ? options.version.replace(/^(\d+\.\d+)$/, '$1.0') : options.prepared ? previous : `${parts[1]}.${Number(parts[2]) + 1}.0`;
  const [major, minor, patch] = version.split('.').map(Number);
  const previousParts = parts.slice(1).map(Number);
  const newer = [major, minor, patch].some((value, index, values) =>
    values.slice(0, index).every((part, i) => part === previousParts[i]) && value > previousParts[index]);
  if (!options.prepared && !newer) {
    throw new Error(`Release ${version} must be newer than base ${previous}`);
  }
  if (options.prepared) {
    if (options.branches.length || options.worktree || options.base !== 'HEAD') throw new Error('--prepared uses the current checkout; do not supply branches, --worktree or --base');
    if (!/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Prepared release version must be MAJOR.MINOR.PATCH');
    if (git(repo, 'branch', '--show-current') !== `release/${version}`) throw new Error(`Prepared checkout must be on release/${version}`);
    if (git(repo, 'status', '--porcelain')) throw new Error('Prepared release checkout must be clean');
    const lock = json(path.join(repo, 'package-lock.json'));
    if (previous !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
      throw new Error('Prepared package.json and package-lock.json versions must match the release version');
    }
  }
  const label = patch === 0 ? `${major}.${minor}` : version;
  const merges = options.branches.map((ref) => ({ ref, commit: git(repo, 'rev-parse', '--verify', `${ref}^{commit}`) }));
  const worktree = options.prepared ? canonical(repo) : canonical(options.worktree || path.join(path.dirname(repo), `agentdeck-release-${label}`));
  const output = canonical(options.output || path.join(path.dirname(repo), 'reports', `agentdeck-${label}`));
  const common = canonical(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir')));
  // Output must not pollute a source checkout, including a different existing worktree.
  const checkouts = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((s) => s.startsWith('worktree ')).map((s) => canonical(s.slice(9)));
  // path.relative is case-insensitive on Windows; a prefix compare is not.
  const inside = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  if (checkouts.some((root) => inside(root, output)) || inside(worktree, output) || inside(common, output)) {
    throw new Error('Release output must be outside source worktrees and the git directory');
  }
  if (checkouts.some((root) => inside(root, worktree) || inside(worktree, root)) && !checkouts.includes(worktree)) {
    throw new Error('Release worktree must be separate from existing checkouts');
  }
  return { version, label, previous, branch: `release/${options.prepared ? version : label}`, baseCommit, merges, worktree, output,
    ...(options.prepared ? { prepared: true } : {}), ...(options.packageOnly ? { packageOnly: true } : {}) };
}

// 版本更新: the release must be written down as the newest entry of release-notes.json
// (what changed, in plain words) before anything is tested or built.
function checkReleaseNotes(directory, version) {
  let notes;
  try { notes = JSON.parse(fs.readFileSync(path.join(directory, 'release-notes.json'), 'utf8')); }
  catch { throw new Error(`release-notes.json 不存在或不是合法 JSON：发版前先写好 ${version} 的更新内容`); }
  const gap = releaseGap(notes, version);
  if (gap) throw new Error(gap);
}

// The machine queue's own markers stay: inside a queued release (e2e-queue.js -- node scripts/release.js …)
// the smoke step's `npm run test:smoke` must know it already holds the slot, or it waits for itself.
const QUEUE_MARKERS = new Set(['AGENTDECK_E2E_QUEUE_HELD', 'AGENTDECK_E2E_RUN_TAG']);
function isolatedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => (QUEUE_MARKERS.has(key) || !key.startsWith('AGENTDECK_')) && key !== 'ELECTRON_RUN_AS_NODE'));
}

function run(command, args, cwd, log, env = process.env) {
  return new Promise((resolve, reject) => {
    if (stopping) { reject(new Error('Release canceled')); return; }
    const stream = fs.createWriteStream(log);
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('error', (error) => { stream.end(); reject(error); });
    child.on('close', (code, signal) => {
      children.delete(child);
      stream.end(() => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}); see ${log}`)));
    });
  });
}

async function withTestLock(action, branch, directory = '/tmp/agentdeck-test.lock') {
  const started = performance.now();
  for (;;) {
    try { fs.mkdirSync(directory); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log(`Waiting for the machine test lock: ${directory}`);
      // Never remove someone else's lock; a stale one needs the 40-minute/dead-owner check.
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
  }
  const owner = path.join(directory, 'owner');
  const releaseLock = () => { fs.rmSync(owner, { force: true }); fs.rmdirSync(directory); };
  const stop = async (signal) => {
    stopping = true;
    await Promise.all([...children].map((child) => new Promise((resolve) => {
      child.once('close', resolve); child.kill(signal);
    })));
    releaseLock(); process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => { void stop('SIGINT'); };
  const terminate = () => { void stop('SIGTERM'); };
  try {
    save(owner, { pid: process.pid, branch, startedAt: new Date().toISOString() });
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    return await action(+((performance.now() - started) / 1000).toFixed(3));
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (!stopping) releaseLock();
  }
}

function included(file, patterns) {
  return patterns.some((pattern) => {
    // Match the repository's explicit allowlist. Fail closed if its grammar changes.
    if (typeof pattern !== 'string' || /[!*?{}\[\]]/.test(pattern.replace(/\/\*\*$/, ''))) {
      throw new Error(`Unsupported build.files pattern: ${JSON.stringify(pattern)}`);
    }
    return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
  });
}

function verifyArchive(repo, archive, asar) {
  asar.uncache(archive);
  const commit = git(repo, 'rev-parse', 'HEAD');
  const pkg = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { cwd: repo }));
  const files = git(repo, 'ls-files', '-z').split('\0').filter((file) => file && included(file, pkg.build.files)).sort();
  const packedFiles = asar.listPackage(archive).map((file) => file.replace(/\\/g, '/').replace(/^\//, '')).filter((file) =>
    included(file, pkg.build.files) && !Object.hasOwn(asar.statFile(archive, file), 'files')).sort();
  if (JSON.stringify(files) !== JSON.stringify(packedFiles)) throw new Error('Packaged runtime file inventory mismatch');
  // One git process reads every committed blob, rather than spawning git per file.
  const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: repo,
    input: files.map((file) => `${commit}:${file}\n`).join(''), maxBuffer: 64 * 1024 * 1024 });
  let offset = 0;
  const verified = files.map((file) => {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString();
    if (!/^[a-f0-9]+ blob \d+$/.test(header)) throw new Error(`Missing committed blob: ${file}`);
    const size = Number(header.split(' ')[2]);
    const original = blobs.subarray(end + 1, end + 1 + size);
    offset = end + size + 2;
    const packed = asar.extractFile(archive, file);
    if (!original.equals(packed)) throw new Error(`Packaged source mismatch: ${file}`);
    return { file, sha256: sha(packed) };
  });
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
  for (const key of ['name', 'version', 'main', 'dependencies']) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(pkg[key])) throw new Error(`Package metadata mismatch: ${key}`);
  }
  return { commit, version: pkg.version, asarSha256: sha(fs.readFileSync(archive)), sourceFilesVerified: files.length, verified };
}

async function hashTree(root, hash, prefix = '') {
  for (const entry of (await fs.promises.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    const file = path.join(root, entry.name);
    hash.update(relative + '\0');
    if (entry.isDirectory()) await hashTree(file, hash, relative + '/');
    else if (entry.isSymbolicLink()) hash.update(await fs.promises.readlink(file));
    else {
      hash.update(String((await fs.promises.stat(file)).mode));
      // Bound synchronous hashing to one chunk so test/audit pipes keep draining,
      // including while reading large Electron or native binaries.
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    }
  }
}

async function fingerprint(repo) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.promises.readFile(__filename));
  // The tree includes tests/config/build assets, not just build.files. Dependencies
  // are hashed too: a changed native binary must invalidate a cached DMG.
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' });
  hash.update(stdout.trim());
  await hashTree(path.join(repo, 'node_modules'), hash);
  hash.update(JSON.stringify({ platform: process.platform, arch: process.arch, os: os.release(), node: process.version,
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CSC_|APPLE_|ELECTRON_|PLAYWRIGHT_|NODE_OPTIONS$|NODE_ENV$|CI$|SOURCE_DATE_EPOCH$)/.test(key)).sort()) }));
  return hash.digest('hex');
}

function cachedBuild(cache, key, output) {
  if (!cache || cache.key !== key || !cache.dmg || path.basename(cache.dmg) !== cache.dmg) return false;
  const file = path.join(output, cache.dmg);
  return fs.existsSync(file) && sha(fs.readFileSync(file)) === cache.sha256;
}

function installer({ version, dmg, sha256, asarSha256, scriptPath = path.join(__dirname, 'restart-agentdeck.sh') }) {
  // Generated launchers contain only immutable artifact coordinates; the formal
  // installer owns retries, rollback, process checks and the durable result.
  return `#!/bin/bash
set -euo pipefail
installer=${shellQuote(scriptPath)}
[[ -f "$installer" ]] || { echo 'Missing formal AgentDeck installer' >&2; exit 1; }
exec bash "$installer" --go --dmg ${shellQuote(dmg)} --sha256 ${shellQuote(sha256)} --asar-sha256 ${shellQuote(asarSha256)} --version ${shellQuote(version)} "$@"
`;
}

async function release(repo, options, runCommand = run) {
  const plan = planRelease(repo, options);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...plan, dryRun: true, steps: [
      ...(plan.prepared ? ['verify clean prepared release checkout (no merges or version changes)'] :
        ['create owned release worktree', 'merge branches in order (stop on conflict)', 'commit package + lock version']),
      'check release-notes.json names this version as the newest release (版本更新)',
      'npm ci + Electron preparation (lock/platform cache)', 'machine test lock: npm test then npm run test:smoke (one worker); audit in parallel',
      'npm run dist:mac -- --publish never (unchanged-input cache)',
      'SHA256 + verified DMG mount/signature/packaged source in parallel',
      ...(plan.packageOnly ? ['skip installer generation; defer all mobile build/upload/online verification; finish package-ready'] : [
        'generate bounded verified installer launcher (do not execute installer)',
        'build/upload mobile hub; preserve rollback point; verify public version/commit/build/assets (at most 3 attempts; rollback on failure)',
      ]),
    ] }, null, 2));
    return;
  }
  if (process.platform !== 'darwin') throw new Error('DMG releases require macOS; --dry-run works on any platform');
  const planFile = path.join(plan.output, 'fast-release-plan.json');
  if (fs.existsSync(plan.output) && fs.readdirSync(plan.output).length &&
      (!fs.existsSync(planFile) || JSON.stringify(json(planFile)) !== JSON.stringify(plan))) {
    throw new Error('Output contains another release; choose a new --output (historical reports are preserved)');
  }
  fs.mkdirSync(plan.output, { recursive: true });
  save(planFile, plan);
  const report = { ...plan, startedAt: new Date().toISOString(), steps: [], status: 'running',
    mobile: plan.packageOnly ? { status: 'deferred', reason: '--package-only: mobile build, deployment and online verification deferred' } : { status: 'not-deployed' } };
  const started = performance.now();
  const writeReport = () => {
    report.elapsedSeconds = +( (performance.now() - started) / 1000).toFixed(3);
    save(path.join(plan.output, 'release-report.json'), report);
    fs.writeFileSync(path.join(plan.output, 'release-report.md'), `# AgentDeck ${plan.label} (${plan.version})\n\nBranch: ${plan.branch}; commit: ${report.commit || 'pending'}; status: ${report.status}.\n\n` +
      report.steps.map((step) => `- ${step.name}: ${step.seconds}s (${step.status})`).join('\n') +
      `\n\nWall time: ${report.elapsedSeconds}s. Parallel step durations overlap.\n` +
      (report.sha256 ? `DMG SHA256: ${report.sha256}\n` : '') +
      (report.error ? `\nFailure: ${report.error}\n` : '') +
      `\n${report.mobile.status === 'passed' ? '🟢' : report.mobile.status === 'deferred' ? '⏸' : '🔴'} Mobile: ${report.mobile.status}; ${report.mobile.error || report.mobile.reason || 'see mobile-deploy-result.json'}\n` +
      `\nCache hits: dependencies=${!!report.dependenciesCached}, tests=${!!report.testsCached}, build=${!!report.buildCached}.\n` +
      '\nRemoved: intermediate-merge test/build repeats; full E2E from the patch-release gate; serial audit waits; separate DMG verification pass (attach -verify performs it); one git process per runtime file; copying the old app during installation (rename preserves it). Unit and smoke run sequentially under the machine test lock.\n' +
      `\nTest lock wait: ${report.testLockWaitSeconds ?? 'cached / not reached'} seconds.\n` +
      (plan.packageOnly ? '\nPackage-only: no installer launcher generated; installation and mobile deployment remain deferred.\n' :
        '\nInstallation is not executed here. The generated launcher uses the formal installer: at most three attempts, rollback on failure, then a durable version/process verification result in userData/install-result.json.\n') +
      '\nNo main merge, tag, push, installation or restart performed.\n');
  };
  async function step(name, action) {
    const entry = { name, status: 'running' };
    report.steps.push(entry);
    const start = performance.now();
    try { const value = await action(); entry.status = 'passed'; return value; }
    catch (error) { entry.status = 'failed'; throw error; }
    finally { entry.seconds = +((performance.now() - start) / 1000).toFixed(3); writeReport(); }
  }
  const logRun = (name, command, args, env) => step(name, () => runCommand(command, args, plan.worktree, path.join(plan.output, `${name}.log`), env));
  const parallel = async (actions) => {
    // Wait for all logs to close even when one gate fails. Never build on failure.
    const results = await Promise.allSettled(actions);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  try {
    if (plan.prepared) {
      await step('prepared-checkout', () => {
        if (git(repo, 'rev-parse', 'HEAD') !== plan.baseCommit || git(repo, 'branch', '--show-current') !== plan.branch || git(repo, 'status', '--porcelain')) {
          throw new Error('Prepared release checkout changed after planning; commit changes and rerun');
        }
        report.commit = plan.baseCommit;
      });
    }
    if (!plan.prepared) await step('worktree', () => {
      const ownership = { version: plan.version, baseCommit: plan.baseCommit, merges: plan.merges };
      if (!fs.existsSync(plan.worktree)) {
        git(repo, 'worktree', 'add', '-b', plan.branch, plan.worktree, plan.baseCommit);
        save(path.resolve(plan.worktree, git(plan.worktree, 'rev-parse', '--git-path', 'fast-release.json')), ownership);
      } else {
        if (!fs.existsSync(path.join(plan.worktree, '.git'))) throw new Error('Existing worktree is not owned by this release plan');
        const marker = path.resolve(plan.worktree, git(plan.worktree, 'rev-parse', '--git-path', 'fast-release.json'));
        if (!fs.existsSync(marker) || JSON.stringify(json(marker)) !== JSON.stringify(ownership) || git(plan.worktree, 'branch', '--show-current') !== plan.branch) {
          throw new Error('Existing worktree is not owned by this release plan; choose a new --worktree and version');
        }
      }
      if (git(plan.worktree, 'status', '--porcelain')) throw new Error('Release worktree is dirty; resolve/commit conflicts before rerunning');
    });
    for (const merge of plan.merges) {
      await step(`merge-${merge.ref.replace(/[^\w.-]/g, '_')}`, () => {
        try { git(plan.worktree, 'merge', '--no-ff', '--no-edit', merge.commit); }
        catch (error) {
          report.conflictFiles = git(plan.worktree, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
          throw new Error(`Merge ${merge.ref} stopped. Conflicts: ${report.conflictFiles.join(', ') || 'none (check git identity/merge hooks)'}. ${error.message}`);
        }
      });
    }
    if (!plan.prepared) await step('version', () => {
      const pkgFile = path.join(plan.worktree, 'package.json');
      const lockFile = path.join(plan.worktree, 'package-lock.json');
      const pkg = json(pkgFile), lock = json(lockFile);
      pkg.version = lock.version = lock.packages[''].version = plan.version;
      save(pkgFile, pkg); save(lockFile, lock);
      if (git(plan.worktree, 'status', '--porcelain')) {
        git(plan.worktree, 'add', 'package.json', 'package-lock.json');
        git(plan.worktree, 'commit', '-m', `Release ${plan.version}`);
      }
      report.commit = git(plan.worktree, 'rev-parse', 'HEAD');
    });
    await step('release-notes', () => checkReleaseNotes(plan.worktree, plan.version));
    const stateDir = path.dirname(path.resolve(plan.worktree, git(plan.worktree, 'rev-parse', '--git-path', 'fast-release.json')));
    const depsState = path.join(stateDir, 'fast-release-deps.json');
    const depsKey = sha(fs.readFileSync(path.join(plan.worktree, 'package-lock.json'))) + `-${process.platform}-${process.arch}-${process.version}`;
    const npmEnv = { ...isolatedEnv(), ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(os.homedir(), 'Library', 'Caches', 'electron') };
    await step('dependencies', async () => {
      if (!fs.existsSync(depsState) || json(depsState).key !== depsKey || !fs.existsSync(path.join(plan.worktree, 'node_modules/electron/dist/Electron.app'))) {
        await runCommand('npm', ['ci', '--prefer-offline'], plan.worktree, path.join(plan.output, 'dependencies.log'), npmEnv);
        save(depsState, { key: depsKey });
      } else report.dependenciesCached = true;
      // Also repairs the spawn-helper permissions on a cached install.
      await runCommand(process.execPath, ['scripts/check-native.js'], plan.worktree, path.join(plan.output, 'native-check.log'), npmEnv);
      // Electron 44 can download lazily on first require. Do it before E2E's
      // launch timeout starts, sharing the same Electron download cache.
      await runCommand(process.execPath, ['-e', 'require("electron")'], plan.worktree, path.join(plan.output, 'electron-check.log'), npmEnv);
    });
    const gatesFile = path.join(stateDir, 'fast-release-gates.json');
    // On the first release there are no reusable gates. Start the expensive
    // checks before hashing dependencies, so hashing does not extend the gate.
    let key = fs.existsSync(gatesFile) ? await step('fingerprint', () => fingerprint(plan.worktree)) : null;
    const gatesCached = key !== null && json(gatesFile).key === key;
    const testing = async () => {
      const checks = async (waitSeconds) => {
        report.testLockWaitSeconds = waitSeconds;
        await logRun('unit', 'npm', ['test'], npmEnv);
        // test:smoke waits in the machine-wide E2E queue (scripts/e2e-queue.js) by itself.
        await logRun('smoke', 'npm', ['run', 'test:smoke'], npmEnv);
      };
      // Injected runners execute fixture commands, not machine tests.
      if (runCommand === run) await withTestLock(checks, plan.branch);
      else await checks(0);
    };
    const gates = parallel([
      ...(gatesCached ? [] : [testing()]),
      logRun('audit', 'npm', ['audit'], npmEnv),
    ]);
    await parallel([gates, ...(key === null ? [step('fingerprint', async () => { key = await fingerprint(plan.worktree); })] : [])]);
    report.testsCached = gatesCached;
    if (gatesCached) await step('unit-smoke-cache', () => undefined);
    save(gatesFile, { key });
    const cacheFile = path.join(stateDir, 'fast-release-build.json');
    const cache = fs.existsSync(cacheFile) ? json(cacheFile) : null;
    let dmg;
    await step('signing-identity', () => runCommand(process.execPath, ['scripts/signing-check.js', '--identity'], plan.worktree, path.join(plan.output, 'signing-identity.log')));
    await step('build', async () => {
      if (cachedBuild(cache, key, plan.output)) { dmg = path.join(plan.output, cache.dmg); report.buildCached = true; return; }
      // Unique output prevents accepting an old artifact after a partial build.
      fs.mkdirSync(path.join(plan.worktree, 'dist'), { recursive: true });
      const buildDir = fs.mkdtempSync(path.join(plan.worktree, 'dist/release-'));
      await runCommand('npm', ['run', 'dist:mac', '--', '--publish', 'never', `--config.directories.output=${buildDir}`], plan.worktree, path.join(plan.output, 'build.log'), npmEnv);
      const dmgs = fs.readdirSync(buildDir).filter((file) => file.endsWith('.dmg'));
      if (dmgs.length !== 1) throw new Error(`Expected one DMG, found ${dmgs.length}`);
      dmg = path.join(plan.output, dmgs[0]);
      fs.copyFileSync(path.join(buildDir, dmgs[0]), dmg);
    });
    await parallel([
      step('sha256', () => { report.sha256 = sha(fs.readFileSync(dmg)); fs.writeFileSync(path.join(plan.output, 'SHA256SUMS'), `${report.sha256}  ${path.basename(dmg)}\n`); }),
      step('verify-package', async () => {
        const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-release-'));
        let attached = false;
        try {
          await runCommand('hdiutil', ['attach', dmg, '-verify', '-noignorebadchecksums', '-readonly', '-nobrowse', '-mountpoint', mount], plan.worktree, path.join(plan.output, 'dmg-mount.log'));
          attached = true;
          const app = path.join(mount, 'AgentDeck.app');
          await runCommand('codesign', ['--verify', '--deep', '--strict', app], plan.worktree, path.join(plan.output, 'codesign.log'));
          await runCommand(process.execPath, ['scripts/signing-check.js', app], plan.worktree, path.join(plan.output, 'signing-requirement.log'));
          const asar = require(require.resolve('@electron/asar', { paths: [plan.worktree] }));
          report.verification = verifyArchive(plan.worktree, path.join(app, 'Contents/Resources/app.asar'), asar);
          save(path.join(plan.output, 'package-source-verification.json'), report.verification);
        } finally {
          if (attached) await runCommand('hdiutil', ['detach', mount], plan.worktree, path.join(plan.output, 'dmg-detach.log'));
          fs.rmdirSync(mount);
        }
      }),
    ]);
    if (!plan.packageOnly) await step('installer', async () => {
      const file = path.join(plan.output, `install-${plan.label}.sh`);
      fs.writeFileSync(file, installer({ version: plan.version, dmg, sha256: report.sha256, asarSha256: report.verification.asarSha256, scriptPath: path.join(plan.worktree, 'scripts/restart-agentdeck.sh') }), { mode: 0o755 });
      await runCommand('bash', ['-n', file], plan.worktree, path.join(plan.output, 'installer-syntax.log'));
    });
    save(cacheFile, { key, dmg: path.basename(dmg), sha256: report.sha256 });
    if (!plan.packageOnly) await step('mobile-deploy', async () => {
      try { report.mobile = await deployMobileGate(plan, report.commit, runCommand); }
      catch (error) { report.mobile = { status: 'failed', error: error.message }; throw error; }
    });
    report.status = plan.packageOnly ? 'package-ready' : 'passed';
    console.log(`Release ${plan.version} prepared in ${plan.output}; ${plan.packageOnly ? 'package-ready; mobile deferred; no installer generated; ' : ''}nothing installed or restarted.`);
  } catch (error) {
    report.status = 'failed'; report.error = error.message; throw error;
  } finally { writeReport(); }
}

async function deployMobileGate(plan, commit, runCommand = run) {
  const resultFile = path.join(plan.output, 'mobile-deploy-result.json');
  // A skipped/no-op command must not reuse a previous successful receipt.
  fs.rmSync(resultFile, { force: true });
  await runCommand(process.execPath, ['scripts/mobile-release.js', 'deploy', '--output', plan.output,
    '--version', plan.version, '--commit', commit], plan.worktree, path.join(plan.output, 'mobile-deploy.log'), isolatedEnv());
  if (!fs.existsSync(resultFile)) throw new Error('Mobile was not deployed: no deployment receipt');
  const result = json(resultFile);
  if (result.status !== 'passed' || result.release?.version !== plan.version || result.release?.commit !== commit ||
      result.online?.version !== plan.version || result.online?.commit !== commit || !result.release?.builtAt ||
      result.online?.builtAt !== result.release.builtAt) throw new Error('Mobile deployment receipt does not match the release/online page');
  return result;
}

if (require.main === module) {
  Promise.resolve().then(() => release(git(process.cwd(), 'rev-parse', '--show-toplevel'), parseArgs(process.argv.slice(2))))
    .catch((error) => { console.error(`\x1b[31mRELEASE FAILED: ${error.message}\x1b[0m`); process.exitCode = 1; });
}
module.exports = { parseArgs, planRelease, checkReleaseNotes, isolatedEnv, withTestLock, included, verifyArchive, fingerprint, cachedBuild, installer, release, deployMobileGate };
