#!/usr/bin/env node
'use strict';

// Release into an owned worktree. Never install, launch, push, or touch main.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

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
  return path.join(fs.realpathSync(existing), ...suffix);
}

function parseArgs(argv) {
  const options = { branches: [], dryRun: false, base: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (['--base', '--worktree', '--output'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!options.version && /^\d/.test(arg)) options.version = arg;
    else options.branches.push(...arg.split(','));
  }
  if (options.version && !/^[1-9]\d*\.(0|[1-9]\d*)(?:\.0)?$/.test(options.version)) {
    throw new Error('Version must be MAJOR.MINOR or MAJOR.MINOR.0 (next release: 1.2 / 1.2.0; no 1.1.12)');
  }
  for (const ref of [options.base, ...options.branches]) {
    if (!ref || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error(`Invalid ref: ${ref}`);
  }
  options.branches = [...new Set(options.branches)];
  return options;
}

function planRelease(repo, options) {
  const baseCommit = git(repo, 'rev-parse', '--verify', `${options.base}^{commit}`);
  const previous = JSON.parse(git(repo, 'show', `${baseCommit}:package.json`)).version;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(previous);
  if (!parts) throw new Error(`Unsupported base version: ${previous}`);
  const version = options.version ? options.version.replace(/^(\d+\.\d+)$/, '$1.0') : `${parts[1]}.${Number(parts[2]) + 1}.0`;
  const [major, minor] = version.split('.').map(Number);
  if (major < Number(parts[1]) || (major === Number(parts[1]) && minor <= Number(parts[2]))) {
    throw new Error(`Release ${version} must be newer than base ${previous}`);
  }
  const label = `${major}.${minor}`;
  const merges = options.branches.map((ref) => ({ ref, commit: git(repo, 'rev-parse', '--verify', `${ref}^{commit}`) }));
  const worktree = canonical(options.worktree || path.join(path.dirname(repo), `agentdeck-release-${label}`));
  const output = canonical(options.output || path.join(path.dirname(repo), 'reports', `agentdeck-${label}`));
  const common = canonical(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir')));
  // Output must not pollute a source checkout, including a different existing worktree.
  const checkouts = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((s) => s.startsWith('worktree ')).map((s) => canonical(s.slice(9)));
  const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
  if (checkouts.some((root) => inside(root, output)) || inside(worktree, output) || inside(common, output)) {
    throw new Error('Release output must be outside source worktrees and the git directory');
  }
  if (checkouts.some((root) => inside(root, worktree) || inside(worktree, root)) && !checkouts.includes(worktree)) {
    throw new Error('Release worktree must be separate from existing checkouts');
  }
  return { version, label, previous, branch: `release/${label}`, baseCommit, merges, worktree, output };
}

function isolatedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('AGENTDECK_') && key !== 'ELECTRON_RUN_AS_NODE'));
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

function hashTree(root, hash, prefix = '') {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    const file = path.join(root, entry.name);
    hash.update(relative + '\0');
    if (entry.isDirectory()) hashTree(file, hash, relative + '/');
    else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else { hash.update(String(fs.statSync(file).mode)); hash.update(fs.readFileSync(file)); }
  }
}

function fingerprint(repo) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(__filename));
  // The tree includes tests/config/build assets, not just build.files. Dependencies
  // are hashed too: a changed native binary must invalidate a cached DMG.
  hash.update(git(repo, 'rev-parse', 'HEAD^{tree}'));
  hashTree(path.join(repo, 'node_modules'), hash);
  hash.update(JSON.stringify({ platform: process.platform, arch: process.arch, os: os.release(), node: process.version,
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CSC_|APPLE_|ELECTRON_|PLAYWRIGHT_|NODE_OPTIONS$|NODE_ENV$|CI$|SOURCE_DATE_EPOCH$)/.test(key)).sort()) }));
  return hash.digest('hex');
}

function cachedBuild(cache, key, output) {
  if (!cache || cache.key !== key || !cache.dmg || path.basename(cache.dmg) !== cache.dmg) return false;
  const file = path.join(output, cache.dmg);
  return fs.existsSync(file) && sha(fs.readFileSync(file)) === cache.sha256;
}

function installer({ version, dmg, sha256, asarSha256 }) {
  // Derived from the historical installers: refuses a live app, stages the
  // entire signed bundle, backs up user data, and never launches anything.
  return `#!/bin/bash
set -euo pipefail
release_dmg=${shellQuote(dmg)}
expected_sha=${shellQuote(sha256)}
expected_asar=${shellQuote(asarSha256)}
running() { pgrep -f '^/Applications/AgentDeck[.]app/Contents/' >/dev/null; }
if running; then echo 'Quit AgentDeck before installing.' >&2; exit 1; fi
[[ -w /Applications ]]
timing_file=${shellQuote(path.join(path.dirname(dmg), 'install-timing.tsv'))}
printf 'step\\tseconds\\tstatus\\n' > "$timing_file"
install_started=$SECONDS
timed() {
  local name="$1" start=$SECONDS code=0
  shift
  "$@" || code=$?
  printf '%s\\t%s\\t%s\\n' "$name" "$((SECONDS - start))" "$code" >> "$timing_file"
  return "$code"
}
release_mount=$(mktemp -d /tmp/agentdeck-install.XXXXXX)
release_stamp="$(date +%Y%m%d-%H%M%S)-$$"
staged_app="/Applications/AgentDeck-${version}.new-$release_stamp.app"
backup_app="/Applications/AgentDeck.pre-${version}-$release_stamp.app"
destination=/Applications/AgentDeck.app
cleanup() { local code=$?; hdiutil detach "$release_mount" >/dev/null 2>&1 || true; rmdir "$release_mount" 2>/dev/null || true; rm -rf "$staged_app"; printf 'total\\t%s\\t%s\\n' "$((SECONDS - install_started))" "$code" >> "$timing_file"; }
trap cleanup EXIT
verify_sha() { [[ "$(shasum -a 256 "$1" | awk '{print $1}')" == "$2" ]]; }
timed dmg-sha256 verify_sha "$release_dmg" "$expected_sha"
timed mount hdiutil attach "$release_dmg" -verify -noignorebadchecksums -readonly -nobrowse -mountpoint "$release_mount"
timed source-signature codesign --verify --deep --strict "$release_mount/AgentDeck.app"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$release_mount/AgentDeck.app/Contents/Info.plist")" == '${version}' ]]
user_home="$HOME"
if [[ -n "\${SUDO_USER:-}" ]]; then user_home=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | cut -d ' ' -f 2-); fi
data_dir="$user_home/Library/Application Support/agentdeck"
data_backup="$user_home/AgentDeck-backups/pre-${version}-$release_stamp"
if [[ -d "$data_dir" ]]; then
  mkdir -p "$data_backup"
  for item in config.json sessions chats long-prompts; do
    if [[ -e "$data_dir/$item" ]]; then timed "backup-$item" ditto "$data_dir/$item" "$data_backup/$item"; fi
  done
fi
[[ ! -e "$staged_app" && ! -e "$backup_app" ]]
timed stage ditto "$release_mount/AgentDeck.app" "$staged_app"
timed staged-signature codesign --verify --deep --strict "$staged_app"
timed staged-asar-sha256 verify_sha "$staged_app/Contents/Resources/app.asar" "$expected_asar"
if running; then echo 'AgentDeck restarted; installation canceled.' >&2; exit 1; fi
if [[ -e "$destination" ]]; then timed preserve-old mv "$destination" "$backup_app"; fi
if ! timed replace mv "$staged_app" "$destination"; then
  if [[ -e "$backup_app" && ! -e "$destination" ]]; then mv "$backup_app" "$destination"; fi
  exit 1
fi
if ! timed installed-signature codesign --verify --deep --strict "$destination"; then
  mv "$destination" "$staged_app"
  if [[ -e "$backup_app" ]]; then mv "$backup_app" "$destination"; fi
  exit 1
fi
echo "Installed ${version}; user data untouched; old bundle: $backup_app. No app launched."
`;
}

async function release(repo, options, runCommand = run) {
  const plan = planRelease(repo, options);
  if (options.dryRun) {
    console.log(JSON.stringify({ ...plan, dryRun: true, steps: [
      'create owned release worktree', 'merge branches in order (stop on conflict)', 'commit package + lock version',
      'npm ci + Electron preparation (lock/platform cache)', 'machine test lock: npm test then npm run test:smoke (one worker); audit in parallel',
      'npm run dist:mac -- --publish never (unchanged-input cache)',
      'SHA256 + verified DMG mount/signature/packaged source in parallel', 'generate timed installer + timing report (do not execute installer)',
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
  const report = { ...plan, startedAt: new Date().toISOString(), steps: [], status: 'running' };
  const started = performance.now();
  const writeReport = () => {
    report.elapsedSeconds = +( (performance.now() - started) / 1000).toFixed(3);
    save(path.join(plan.output, 'release-report.json'), report);
    fs.writeFileSync(path.join(plan.output, 'release-report.md'), `# AgentDeck ${plan.label} (${plan.version})\n\nBranch: ${plan.branch}; commit: ${report.commit || 'pending'}; status: ${report.status}.\n\n` +
      report.steps.map((step) => `- ${step.name}: ${step.seconds}s (${step.status})`).join('\n') +
      `\n\nWall time: ${report.elapsedSeconds}s. Parallel step durations overlap.\n` +
      (report.sha256 ? `DMG SHA256: ${report.sha256}\n` : '') +
      (report.error ? `\nFailure: ${report.error}\n` : '') +
      `\nCache hits: dependencies=${!!report.dependenciesCached}, tests=${!!report.testsCached}, build=${!!report.buildCached}.\n` +
      '\nRemoved: intermediate-merge test/build repeats; full E2E from the patch-release gate; serial audit waits; separate DMG verification pass (attach -verify performs it); one git process per runtime file; copying the old app during installation (rename preserves it). Unit and smoke run sequentially under the machine test lock.\n' +
      `\nTest lock wait: ${report.testLockWaitSeconds ?? 'cached / not reached'} seconds.\n` +
      '\nInstallation is not executed here. The generated installer writes install-timing.tsv (whole seconds) alongside this report. Relaunch and application health checks remain the release operator\'s final step.\n' +
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
    await step('worktree', () => {
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
    await step('version', () => {
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
    await parallel([gates, ...(key === null ? [step('fingerprint', () => { key = fingerprint(plan.worktree); })] : [])]);
    report.testsCached = gatesCached;
    if (gatesCached) await step('unit-smoke-cache', () => undefined);
    save(gatesFile, { key });
    const cacheFile = path.join(stateDir, 'fast-release-build.json');
    const cache = fs.existsSync(cacheFile) ? json(cacheFile) : null;
    let dmg;
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
          const asar = require(require.resolve('@electron/asar', { paths: [plan.worktree] }));
          report.verification = verifyArchive(plan.worktree, path.join(app, 'Contents/Resources/app.asar'), asar);
          save(path.join(plan.output, 'package-source-verification.json'), report.verification);
        } finally {
          if (attached) await runCommand('hdiutil', ['detach', mount], plan.worktree, path.join(plan.output, 'dmg-detach.log'));
          fs.rmdirSync(mount);
        }
      }),
    ]);
    await step('installer', async () => {
      const file = path.join(plan.output, `install-${plan.label}.sh`);
      fs.writeFileSync(file, installer({ version: plan.version, dmg, sha256: report.sha256, asarSha256: report.verification.asarSha256 }), { mode: 0o755 });
      await runCommand('bash', ['-n', file], plan.worktree, path.join(plan.output, 'installer-syntax.log'));
    });
    save(cacheFile, { key, dmg: path.basename(dmg), sha256: report.sha256 });
    report.status = 'passed';
    console.log(`Release ${plan.version} prepared in ${plan.output}; nothing installed or restarted.`);
  } catch (error) {
    report.status = 'failed'; report.error = error.message; throw error;
  } finally { writeReport(); }
}

if (require.main === module) {
  Promise.resolve().then(() => release(git(process.cwd(), 'rev-parse', '--show-toplevel'), parseArgs(process.argv.slice(2))))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { parseArgs, planRelease, isolatedEnv, withTestLock, included, verifyArchive, fingerprint, cachedBuild, installer, release };
