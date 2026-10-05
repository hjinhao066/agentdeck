'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const asar = require('@electron/asar');
const { parseArgs, planRelease, isolatedEnv, withTestLock, verifyArchive, fingerprint, cachedBuild, installer, release } = require('../scripts/release');
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function fixture(t, version = '1.1.11') {
  // Keep os.tmpdir()'s own spelling. Windows CI's temp is an 8.3 alias (RUNNER~1);
  // pre-resolving it would hide the checkout containment check.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  write(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version, main: 'main.js', dependencies: {}, build: { files: ['main.js', 'mobile-web/**'] } }));
  write(path.join(repo, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  write(path.join(repo, 'main.js'), 'module.exports = "baseline";\n');
  write(path.join(repo, 'mobile-web/app.js'), 'window.fixture = true;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const options = parseArgs(['--worktree', path.join(root, 'release'), '--output', path.join(root, 'output')]);
  return { root, repo, options };
}
async function archive(repo, dest, mutate = () => {}) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-asar-test-'));
  try {
    for (const file of ['package.json', 'main.js', 'mobile-web/app.js']) write(path.join(source, file), fs.readFileSync(path.join(repo, file)));
    mutate(source);
    // createPackage resolves before its output stream closes. A child process
    // drains the stream before exit, matching the real builder lifecycle.
    execFileSync(process.execPath, ['-e', 'require(process.argv[1]).createPackage(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });',
      require.resolve('@electron/asar'), source, dest], { stdio: 'pipe' });
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
}

test('versions use the next minor by default; accept labels and package versions', (t) => {
  const { repo, options } = fixture(t);
  for (const value of [undefined, '1.2', '1.2.0']) {
    const plan = planRelease(repo, { ...options, version: value });
    assert.equal(plan.version, '1.2.0'); assert.equal(plan.label, '1.2'); assert.equal(plan.branch, 'release/1.2');
  }
  for (const value of ['1.1.12', '1.2.1', '01.2', '1.2-beta']) assert.throws(() => parseArgs([value]), /Version/);
  assert.throws(() => planRelease(repo, { ...options, version: '1.1' }), /newer/);
  assert.deepEqual(parseArgs(['fix/a,fix/b', 'fix/a']).branches, ['fix/a', 'fix/b']);
  assert.throws(() => parseArgs(['--base']), /Missing/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  const next = fixture(t, '1.2.0');
  assert.equal(planRelease(next.repo, next.options).version, '1.3.0');
});

test('dry-run resolves pinned commits but writes nothing or runs commands', async (t) => {
  const { repo, root, options } = fixture(t);
  const before = git(repo, 'show-ref');
  await release(repo, { ...options, dryRun: true }, () => assert.fail('runner called'));
  assert.deepEqual(fs.readdirSync(root), ['source']);
  assert.equal(git(repo, 'show-ref'), before);
  assert.throws(() => planRelease(repo, { ...options, output: path.join(repo, 'reports') }), /outside/);
  assert.throws(() => planRelease(repo, { ...options, worktree: path.join(repo, 'nested') }), /separate/);
});

test('prepared plans pin a clean versioned release checkout without creating or bumping it', async (t) => {
  const { repo, root } = fixture(t, '1.2.0');
  git(repo, 'checkout', '-qb', 'release/1.2.0');
  const options = parseArgs(['--prepared', '--dry-run', '--output', path.join(root, 'output')]);
  const before = git(repo, 'show-ref');
  const plan = planRelease(repo, options);
  assert.equal(plan.prepared, true); assert.equal(plan.branch, 'release/1.2.0');
  assert.equal(plan.worktree, fs.realpathSync.native(repo)); assert.equal(plan.version, '1.2.0');
  assert.equal(plan.baseCommit, git(repo, 'rev-parse', 'HEAD')); assert.deepEqual(plan.merges, []);
  await release(repo, options, () => assert.fail('runner called'));
  assert.equal(git(repo, 'show-ref'), before); assert.deepEqual(fs.readdirSync(root), ['source']);
  assert.equal(planRelease(repo, { ...options, version: '1.2' }).version, '1.2.0');
  for (const args of [['fix/a'], ['--base', 'main'], ['--base', 'HEAD'], ['--worktree', path.join(root, 'other')]]) {
    assert.throws(() => parseArgs(['--prepared', ...args]), /current checkout/);
  }
  assert.throws(() => planRelease(repo, { ...options, branches: ['main'] }), /current checkout/);
  assert.throws(() => planRelease(repo, { ...options, version: '1.3.0' }), /release\/1.3.0/);
  assert.throws(() => planRelease(repo, { ...options, output: path.join(repo, 'reports') }), /outside/);
  write(path.join(repo, 'untracked.txt'), 'local data');
  assert.throws(() => planRelease(repo, options), /must be clean/);
  fs.unlinkSync(path.join(repo, 'untracked.txt'));
  write(path.join(repo, 'package-lock.json'), JSON.stringify({ version: '1.1.11', packages: { '': { version: '1.2.0' } } }));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'mismatched lock');
  assert.throws(() => planRelease(repo, options), /versions must match/);
  git(repo, 'checkout', '-q', 'main');
  assert.throws(() => planRelease(repo, options), /must be on release/);
});

test('isolation strips app routing only from child environment', () => {
  const env = { PATH: 'fixture', AGENTDECK_RECEIPT_TOKEN: 'private', ELECTRON_RUN_AS_NODE: '1' };
  assert.deepEqual(isolatedEnv(env), { PATH: 'fixture' });
  assert.equal(env.AGENTDECK_RECEIPT_TOKEN, 'private');
});

test('package inventory, committed bytes and metadata are all verified', async (t) => {
  const { repo, root } = fixture(t);
  const file = path.join(root, 'app.asar');
  await archive(repo, file);
  assert.equal(verifyArchive(repo, file, asar).sourceFilesVerified, 2);
  assert.equal(verifyArchive(repo, file, { ...asar,
    listPackage: (name) => asar.listPackage(name).map((entry) => entry.replace(/\//g, '\\')) }).sourceFilesVerified, 2);
  await archive(repo, file, (dir) => write(path.join(dir, 'main.js'), 'tampered'));
  assert.throws(() => verifyArchive(repo, file, asar), /source mismatch/);
  await archive(repo, file, (dir) => write(path.join(dir, 'mobile-web/extra.js'), 'extra'));
  assert.throws(() => verifyArchive(repo, file, asar), /inventory mismatch/);
  await archive(repo, file, (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))); pkg.version = '99.0.0';
    write(path.join(dir, 'package.json'), JSON.stringify(pkg));
  });
  assert.throws(() => verifyArchive(repo, file, asar), /metadata mismatch/);
});

test('cache invalidates on dependency bytes, mode, commit or damaged artifact', async (t) => {
  const { repo, root } = fixture(t);
  const binary = path.join(repo, 'node_modules/native.node'); write(binary, 'one');
  const first = await fingerprint(repo);
  assert.equal(await fingerprint(repo), first);
  write(binary, 'two'); assert.notEqual(await fingerprint(repo), first);
  const second = await fingerprint(repo);
  if (process.platform !== 'win32') {
    fs.chmodSync(binary, 0o755); assert.notEqual(await fingerprint(repo), second);
  }
  const third = await fingerprint(repo); write(path.join(repo, 'main.js'), 'changed');
  git(repo, 'add', 'main.js'); git(repo, 'commit', '-qm', 'runtime changed');
  assert.notEqual(await fingerprint(repo), third);
  write(path.join(root, 'fixture.dmg'), 'image');
  const cache = { key: first, dmg: 'fixture.dmg', sha256: digest('image') };
  assert.equal(cachedBuild(cache, first, root), true);
  assert.equal(cachedBuild(cache, second, root), false);
  write(path.join(root, 'fixture.dmg'), 'broken'); assert.equal(cachedBuild(cache, first, root), false);
});

test('fingerprinting drains child stdout beyond pipe capacity before hashing finishes', { timeout: 15000 }, async (t) => {
  const { repo, root } = fixture(t);
  // A large dependency keeps real hashing in flight; no elapsed-time threshold.
  write(path.join(repo, 'node_modules/electron.bin'), Buffer.alloc(32 * 1024 * 1024, 1));
  const emitter = path.join(root, 'emit.js');
  const outputSize = 2 * 1024 * 1024;
  write(emitter, `process.once('message', () => {
    process.stdout.write(Buffer.alloc(${outputSize}, 120), () => process.disconnect());
  });
  process.send('ready');\n`);
  const child = fork(emitter, [], { env: isolatedEnv(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  const closed = once(child, 'close');
  let bytes = 0;
  child.stdout.on('data', (chunk) => { bytes += chunk.length; });
  await once(child, 'message');
  assert.equal(bytes, 0);
  child.send('write');
  const key = await fingerprint(repo);
  const bytesDuringHash = bytes;
  assert.deepEqual(await closed, [0, null]);
  assert.equal(bytes, outputSize);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.ok(bytesDuringHash > 65536, `stdout drained only ${bytesDuringHash} bytes during fingerprint`);
  t.diagnostic(`stdout drained during fingerprint: ${bytesDuringHash}/${outputSize} bytes`);
});

test('conflicts stop before tests/build and retain both worktrees', { skip: process.platform !== 'darwin' }, async (t) => {
  const { repo, options } = fixture(t);
  for (const branch of ['feature-a', 'feature-b']) {
    git(repo, 'checkout', '-qb', branch, 'main'); write(path.join(repo, 'main.js'), branch);
    git(repo, 'add', 'main.js'); git(repo, 'commit', '-qm', branch);
  }
  git(repo, 'checkout', '-q', 'main'); options.branches = ['feature-a', 'feature-b'];
  await assert.rejects(release(repo, options, () => assert.fail('runner called')), /Conflicts: main.js/);
  const report = JSON.parse(fs.readFileSync(path.join(options.output, 'release-report.json')));
  assert.equal(report.status, 'failed'); assert.deepEqual(report.conflictFiles, ['main.js']);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.match(git(options.worktree, 'status', '--porcelain'), /UU main.js/);
});

test('full isolated rehearsal: serial tests with parallel audit, cache reuse, damaged build and failing gate', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, repo, options } = fixture(t);
  const calls = [];
  let active = 0, maxActive = 0, failUnit = false;
  const packed = path.join(root, 'fixture.asar');
  const runner = async (command, args, cwd) => {
    const operation = `${command === 'npm' ? 'npm' : path.basename(command)} ${args.join(' ')}`;
    calls.push(operation);
    if (args[0] === 'ci') {
      fs.mkdirSync(path.join(cwd, 'node_modules/electron/dist/Electron.app'), { recursive: true });
      write(path.join(cwd, 'node_modules/@electron/asar/index.js'), `module.exports = require(${JSON.stringify(require.resolve('@electron/asar'))});`);
    }
    if (command === 'npm' && (args[0] === 'test' || args.includes('test:smoke') || args[0] === 'audit')) {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20)); active--;
      if (failUnit && args[0] === 'test') throw new Error('fixture unit failure');
    }
    if (args.includes('dist:mac')) {
      const dir = args.find((arg) => arg.startsWith('--config.directories.output=')).split('=')[1];
      write(path.join(dir, 'fixture.dmg'), 'fixture image'); await archive(cwd, packed);
    }
    if (command === 'hdiutil' && args[0] === 'attach') {
      assert.ok(args.includes('-verify')); assert.ok(args.includes('-noignorebadchecksums'));
      write(path.join(args.at(-1), 'AgentDeck.app/Contents/Resources/app.asar'), fs.readFileSync(packed));
    }
    if (command === 'hdiutil' && args[0] === 'detach') fs.rmSync(path.join(args[1], 'AgentDeck.app'), { recursive: true });
    if (command === 'bash') execFileSync(command, args);
  };
  await release(repo, options, runner);
  assert.equal(maxActive, 2);
  assert.ok(calls.indexOf('npm test') < calls.indexOf('npm run test:smoke'));
  let report = JSON.parse(fs.readFileSync(path.join(options.output, 'release-report.json')));
  t.diagnostic(`Cold fixture (mock build/OS commands): ${JSON.stringify({ elapsedSeconds: report.elapsedSeconds, steps: report.steps })}`);
  assert.equal(report.status, 'passed'); assert.equal(report.version, '1.2.0');
  assert.equal(git(repo, 'branch', '--show-current'), 'main'); assert.equal(git(repo, 'status', '--porcelain'), '');
  calls.length = 0; await release(repo, options, runner);
  report = JSON.parse(fs.readFileSync(path.join(options.output, 'release-report.json')));
  t.diagnostic(`Cached fixture (mock build/OS commands): ${JSON.stringify({ elapsedSeconds: report.elapsedSeconds, steps: report.steps })}`);
  assert.equal(report.dependenciesCached, true); assert.equal(report.testsCached, true); assert.equal(report.buildCached, true);
  assert.ok(calls.includes('npm audit')); assert.ok(!calls.some((c) => /dist:mac|test:smoke|npm test|npm ci/.test(c)));
  write(path.join(options.output, 'fixture.dmg'), 'corrupt');
  calls.length = 0; await release(repo, options, runner);
  assert.ok(calls.some((c) => c.includes('dist:mac')));
  // Changing a native binary invalidates successful gates. A failing gate must stop the build.
  write(path.join(options.worktree, 'node_modules/native.node'), 'changed'); failUnit = true; calls.length = 0;
  await assert.rejects(release(repo, options, runner), /fixture unit failure/);
  assert.equal(active, 0); assert.ok(!calls.some((c) => c.includes('dist:mac')));
  await assert.rejects(release(repo, { ...options, base: 'feature-missing' }, runner));
  const unsafe = fixture(t); fs.mkdirSync(unsafe.options.worktree); write(path.join(unsafe.options.worktree, 'keep.txt'), 'keep');
  await assert.rejects(release(unsafe.repo, unsafe.options, runner), /not owned/);
  assert.equal(fs.readFileSync(path.join(unsafe.options.worktree, 'keep.txt'), 'utf8'), 'keep');
});

test('prepared release runs packaging gates while preserving checkout, commit and metadata', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, repo } = fixture(t, '1.2.0');
  git(repo, 'checkout', '-qb', 'release/1.2.0');
  const options = parseArgs(['--prepared', '--output', path.join(root, 'output')]);
  const refs = git(repo, 'show-ref'), worktrees = git(repo, 'worktree', 'list', '--porcelain');
  const pkg = fs.readFileSync(path.join(repo, 'package.json'));
  const lock = fs.readFileSync(path.join(repo, 'package-lock.json'));
  const packed = path.join(root, 'fixture.asar'), calls = [];
  const runner = async (command, args, cwd, log, env) => {
    assert.equal(cwd, fs.realpathSync.native(repo));
    assert.equal(Object.keys(env || {}).some((key) => key.startsWith('AGENTDECK_')), false);
    calls.push([command, ...args]);
    if (args[0] === 'ci') {
      fs.mkdirSync(path.join(cwd, 'node_modules/electron/dist/Electron.app'), { recursive: true });
      write(path.join(cwd, 'node_modules/@electron/asar/index.js'), `module.exports = require(${JSON.stringify(require.resolve('@electron/asar'))});`);
    }
    if (args.includes('dist:mac')) {
      const dir = args.find((arg) => arg.startsWith('--config.directories.output=')).split('=')[1];
      write(path.join(dir, 'fixture.dmg'), 'prepared image'); await archive(cwd, packed);
    }
    if (command === 'hdiutil' && args[0] === 'attach') {
      assert.ok(args.includes('-verify')); assert.ok(args.includes('-noignorebadchecksums'));
      write(path.join(args.at(-1), 'AgentDeck.app/Contents/Resources/app.asar'), fs.readFileSync(packed));
    }
    if (command === 'hdiutil' && args[0] === 'detach') fs.rmSync(path.join(args[1], 'AgentDeck.app'), { recursive: true });
    if (command === 'bash') execFileSync(command, args);
  };
  await release(repo, options, runner);
  const report = JSON.parse(fs.readFileSync(path.join(options.output, 'release-report.json')));
  assert.equal(report.status, 'passed'); assert.equal(report.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(report.prepared, true); assert.equal(report.verification.commit, report.commit);
  assert.equal(report.sha256, digest('prepared image'));
  assert.ok(report.steps.some((step) => step.name === 'prepared-checkout'));
  assert.ok(report.steps.every((step) => step.status === 'passed' && step.seconds >= 0));
  for (const gate of ['unit', 'smoke', 'audit', 'build', 'verify-package']) assert.ok(report.steps.some((step) => step.name === gate), gate);
  assert.ok(!report.steps.some((step) => ['worktree', 'version'].includes(step.name) || step.name.startsWith('merge-')));
  assert.ok(calls.findIndex((call) => call.join(' ') === 'npm test') < calls.findIndex((call) => call.join(' ') === 'npm run test:smoke'));
  assert.ok(calls.some((call) => call[0] === 'codesign' && call.includes('--deep') && call.includes('--strict')));
  assert.equal(git(repo, 'show-ref'), refs); assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktrees);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'package.json')), pkg);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'package-lock.json')), lock);
  assert.equal(fs.existsSync(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'fast-release.json'))), false);
});

test('test lock records owner PID and branch and releases after success or failure', async (t) => {
  const { root } = fixture(t);
  const lock = path.join(root, 'test.lock');
  await withTestLock(async (wait) => {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner')));
    assert.equal(owner.pid, process.pid); assert.equal(owner.branch, 'release/1.2');
    assert.ok(owner.startedAt); assert.ok(wait >= 0);
  }, 'release/1.2', lock);
  assert.equal(fs.existsSync(lock), false);
  await assert.rejects(withTestLock(() => { throw new Error('fixture failure'); }, 'release/1.2', lock), /fixture failure/);
  assert.equal(fs.existsSync(lock), false);
});

test('generated installer delegates to the formal bounded installer with pinned artifact checks', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'install.sh');
  const script = installer({ version: '1.2.0', dmg: path.join(root, "odd ' name.dmg"), sha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64) });
  write(file, script); execFileSync('bash', ['-n', file]);
  assert.match(script, /restart-agentdeck\.sh/);
  assert.match(script, /--sha256/); assert.match(script, /--asar-sha256/);
  assert.match(script, /--version '1\.2\.0'/);
  assert.doesNotMatch(script, /launchctl|KeepAlive|while|until/);
});
