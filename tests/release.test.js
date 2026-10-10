'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// the machine queue's own markers (release.js keeps them for a release run inside the queue)
const QUEUE_MARKERS = ['AGENTDECK_E2E_QUEUE_HELD', 'AGENTDECK_E2E_RUN_TAG'];
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const asar = require('@electron/asar');
const { parseArgs, planRelease, checkReleaseNotes, isolatedEnv, withTestLock, verifyArchive, fingerprint, cachedBuild, installer, release } = require('../scripts/release');
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function mobileReceipt(args, cwd) {
  const stamp = { version: JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'))).version,
    commit: git(cwd, 'rev-parse', 'HEAD'), builtAt: '2026-10-05T18:00:00.000Z' };
  write(path.join(args[args.indexOf('--output') + 1], 'mobile-deploy-result.json'),
    JSON.stringify({ status: 'passed', release: stamp, online: stamp }));
}
// release-notes.json naming `version` as the newest release, as the release script requires.
const notesFor = (version) => JSON.stringify({ schema: 1, updated: '2026-10-05', upcoming: [],
  released: [{ version, date: '2026-10-05', title: 'Fixture', items: ['one', 'two', 'three'] }] });
function fixture(t, version = '1.1.11', notes = version.replace(/^(\d+)\.(\d+)\.\d+$/, (_, a, b) => `${a}.${Number(b) + 1}`)) {
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
  write(path.join(repo, 'release-notes.json'), notesFor(notes));
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
  for (const value of ['1.1.012', '1.2.01', '01.2', '1.2-beta']) assert.throws(() => parseArgs([value]), /Version/);
  assert.throws(() => planRelease(repo, { ...options, version: '1.1' }), /newer/);
  assert.deepEqual(parseArgs(['fix/a,fix/b', 'fix/a']).branches, ['fix/a', 'fix/b']);
  assert.throws(() => parseArgs(['--base']), /Missing/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  const next = fixture(t, '1.2.0');
  assert.equal(planRelease(next.repo, next.options).version, '1.3.0');
});

test('explicit patch releases are strictly newer and use distinct artifact labels', (t) => {
  const { repo, options } = fixture(t, '1.2.0');
  for (const version of ['1.2.1', '1.2.12', '1.3.1', '2.0.1']) {
    const plan = planRelease(repo, { ...options, ...parseArgs([version]), worktree: options.worktree, output: options.output });
    assert.equal(plan.version, version); assert.equal(plan.label, version); assert.equal(plan.branch, `release/${version}`);
  }
  for (const version of ['1.2.0', '1.1.99', '1.0.1']) assert.throws(() => planRelease(repo, { ...options, version }), /newer/);
  const prior = fixture(t, '1.1.11');
  assert.equal(planRelease(prior.repo, { ...prior.options, version: '1.1.12' }).version, '1.1.12');
  const patched = fixture(t, '1.2.9');
  assert.throws(() => planRelease(patched.repo, { ...patched.options, version: '1.2.8' }), /newer/);
  assert.throws(() => planRelease(patched.repo, { ...patched.options, version: '1.2.9' }), /newer/);
  assert.equal(planRelease(patched.repo, patched.options).version, '1.3.0');
});

test('prepared patch plans enforce clean checkout, exact branch and all package versions', async (t) => {
  const { repo, root } = fixture(t, '1.2.1');
  git(repo, 'checkout', '-qb', 'release/1.2.1');
  const options = parseArgs(['1.2.1', '--prepared', '--dry-run', '--output', path.join(root, 'output')]);
  const plan = planRelease(repo, options);
  assert.equal(plan.label, '1.2.1'); assert.equal(plan.branch, 'release/1.2.1'); assert.equal(plan.version, '1.2.1');
  assert.equal(plan.worktree, fs.realpathSync.native(repo));
  const before = git(repo, 'show-ref');
  await release(repo, options, () => assert.fail('runner called'));
  assert.equal(git(repo, 'show-ref'), before); assert.deepEqual(fs.readdirSync(root), ['source']);
  assert.equal(planRelease(repo, { ...options, version: undefined }).version, '1.2.1');
  assert.throws(() => planRelease(repo, { ...options, version: '1.2.2' }), /release\/1.2.2/);
  write(path.join(repo, 'local.txt'), 'uncommitted');
  assert.throws(() => planRelease(repo, options), /must be clean/); fs.unlinkSync(path.join(repo, 'local.txt'));
  write(path.join(repo, 'package-lock.json'), JSON.stringify({ version: '1.2.1', packages: { '': { version: '1.2.0' } } }));
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'mismatched patch lock');
  assert.throws(() => planRelease(repo, options), /versions must match/);
  git(repo, 'checkout', '-q', 'main'); assert.throws(() => planRelease(repo, options), /must be on release/);
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

// release.js run through the machine queue (e2e-queue.js -- node scripts/release.js …): its smoke step runs
// `npm run test:smoke`, which queues again. Without the queue's own marker it waits for the slot its parent
// holds until the run limit kills both (2.0.4 package run: smoke 43 minutes, exit 124).
test('isolation keeps the machine queue markers, so smoke inside a queued release does not wait for itself', () => {
  const env = { PATH: 'fixture', AGENTDECK_CONTROL_TOKEN: 'private', AGENTDECK_E2E_QUEUE_HELD: '1', AGENTDECK_E2E_RUN_TAG: 'tag-1' };
  assert.deepEqual(isolatedEnv(env), { PATH: 'fixture', AGENTDECK_E2E_QUEUE_HELD: '1', AGENTDECK_E2E_RUN_TAG: 'tag-1' });
});

test('package-only is pinned in the plan and dry-run lists deferred work without writing files', async (t) => {
  const { repo, root, options } = fixture(t);
  const packageOptions = { ...options, ...parseArgs(['--package-only', '--dry-run']), worktree: options.worktree, output: options.output };
  assert.equal(packageOptions.packageOnly, true);
  assert.equal(planRelease(repo, packageOptions).packageOnly, true);
  assert.notDeepEqual(planRelease(repo, packageOptions), planRelease(repo, options));
  const output = [];
  const log = t.mock.method(console, 'log', (value) => output.push(value));
  await release(repo, packageOptions, () => assert.fail('runner called'));
  log.mock.restore();
  const plan = JSON.parse(output.join(''));
  assert.equal(plan.packageOnly, true);
  assert.ok(plan.steps.some((step) => /skip installer generation; defer all mobile/.test(step)));
  assert.ok(!plan.steps.some((step) => /generate bounded|build\/upload mobile/.test(step)));
  for (const gate of ['npm test', 'npm run test:smoke', 'audit', 'dist:mac', 'SHA256', 'signature', 'packaged source']) {
    assert.ok(plan.steps.some((step) => step.includes(gate)), gate);
  }
  assert.deepEqual(fs.readdirSync(root), ['source']);
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
  let active = 0, maxActive = 0, failUnit = false, failMobile = false;
  const packed = path.join(root, 'fixture.asar');
  const runner = async (command, args, cwd) => {
    const operation = `${command === 'npm' ? 'npm' : path.basename(command)} ${args.join(' ')}`;
    calls.push(operation);
    if (args[0] === 'scripts/mobile-release.js') {
      if (failMobile) throw new Error('fixture mobile failure');
      mobileReceipt(args, cwd);
    }
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
  assert.ok(calls.some((c) => c.includes('scripts/mobile-release.js')), 'cached desktop build still deploys mobile');
  failMobile = true;
  await assert.rejects(release(repo, options, runner), /fixture mobile failure/);
  report = JSON.parse(fs.readFileSync(path.join(options.output, 'release-report.json')));
  assert.equal(report.status, 'failed'); assert.equal(report.mobile.status, 'failed');
  assert.match(fs.readFileSync(path.join(options.output, 'release-report.md'), 'utf8'), /🔴 Mobile: failed/);
  failMobile = false;
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
  const { root, repo } = fixture(t, '1.2.0', '1.2.0');
  git(repo, 'checkout', '-qb', 'release/1.2.0');
  const options = parseArgs(['--prepared', '--output', path.join(root, 'output')]);
  const refs = git(repo, 'show-ref'), worktrees = git(repo, 'worktree', 'list', '--porcelain');
  const pkg = fs.readFileSync(path.join(repo, 'package.json'));
  const lock = fs.readFileSync(path.join(repo, 'package-lock.json'));
  const packed = path.join(root, 'fixture.asar'), calls = [];
  const runner = async (command, args, cwd, log, env) => {
    assert.equal(cwd, fs.realpathSync.native(repo));
    assert.equal(Object.keys(env || {}).some((key) => key.startsWith('AGENTDECK_') && !QUEUE_MARKERS.includes(key)), false);
    calls.push([command, ...args]);
    if (args[0] === 'scripts/mobile-release.js') mobileReceipt(args, cwd);
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
  for (const gate of ['unit', 'smoke', 'audit', 'build', 'verify-package', 'mobile-deploy']) assert.ok(report.steps.some((step) => step.name === gate), gate);
  assert.equal(report.mobile.online.version, '1.2.0');
  assert.ok(!report.steps.some((step) => ['worktree', 'version'].includes(step.name) || step.name.startsWith('merge-')));
  assert.ok(calls.findIndex((call) => call.join(' ') === 'npm test') < calls.findIndex((call) => call.join(' ') === 'npm run test:smoke'));
  assert.ok(calls.some((call) => call[0] === 'codesign' && call.includes('--deep') && call.includes('--strict')));
  assert.ok(calls.some((call) => call.includes('scripts/signing-check.js') && call.includes('--identity')));
  assert.ok(calls.some((call) => call.some((arg) => /signing-check\.js$/.test(arg)) && call.some((arg) => /AgentDeck\.app$/.test(arg))));
  assert.equal(git(repo, 'show-ref'), refs); assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktrees);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.deepEqual(fs.readFileSync(path.join(repo, 'package.json')), pkg);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'package-lock.json')), lock);
  assert.equal(fs.existsSync(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'fast-release.json'))), false);
});

test('package-only rehearsal retains desktop gates and verification, creates no installer and never deploys mobile', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, repo } = fixture(t, '1.2.4', '1.2.4');
  git(repo, 'checkout', '-qb', 'release/1.2.4');
  const options = parseArgs(['--prepared', '--package-only', '--output', path.join(root, 'output')]);
  const commit = git(repo, 'rev-parse', 'HEAD');
  const packed = path.join(root, 'fixture.asar'), calls = [];
  let failUnit = false;
  const runner = async (command, args, cwd) => {
    calls.push([command, ...args]);
    assert.notEqual(args[0], 'scripts/mobile-release.js', 'package-only must not build or deploy mobile');
    assert.notEqual(command, 'bash', 'package-only must not generate/check an installer');
    if (args[0] === 'ci') {
      fs.mkdirSync(path.join(cwd, 'node_modules/electron/dist/Electron.app'), { recursive: true });
      write(path.join(cwd, 'node_modules/@electron/asar/index.js'), `module.exports = require(${JSON.stringify(require.resolve('@electron/asar'))});`);
    }
    if (command === 'npm' && args[0] === 'test' && failUnit) throw new Error('fixture package-only unit failure');
    if (args.includes('dist:mac')) {
      assert.ok(args.includes('--publish') && args.includes('never'));
      const dir = args.find((arg) => arg.startsWith('--config.directories.output=')).split('=')[1];
      write(path.join(dir, 'fixture.dmg'), 'package-only image'); await archive(cwd, packed);
    }
    if (command === 'hdiutil' && args[0] === 'attach') {
      assert.ok(args.includes('-verify')); assert.ok(args.includes('-noignorebadchecksums'));
      assert.ok(args.includes('-readonly'));
      write(path.join(args.at(-1), 'AgentDeck.app/Contents/Resources/app.asar'), fs.readFileSync(packed));
    }
    if (command === 'hdiutil' && args[0] === 'detach') fs.rmSync(path.join(args[1], 'AgentDeck.app'), { recursive: true });
  };
  await release(repo, options, runner);
  const reportFile = path.join(options.output, 'release-report.json');
  let report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.status, 'package-ready'); assert.equal(report.packageOnly, true);
  assert.equal(report.mobile.status, 'deferred'); assert.match(report.mobile.reason, /online verification deferred/);
  assert.equal(report.commit, commit); assert.equal(report.verification.commit, commit);
  assert.equal(report.verification.version, '1.2.4'); assert.equal(report.verification.sourceFilesVerified, 2);
  assert.equal(report.sha256, digest('package-only image'));
  for (const gate of ['dependencies', 'unit', 'smoke', 'audit', 'build', 'sha256', 'verify-package']) {
    assert.ok(report.steps.some((step) => step.name === gate && step.status === 'passed'), gate);
  }
  assert.ok(!report.steps.some((step) => ['installer', 'mobile-deploy'].includes(step.name)));
  assert.ok(calls.findIndex((call) => call.join(' ') === 'npm test') < calls.findIndex((call) => call.join(' ') === 'npm run test:smoke'));
  assert.ok(calls.some((call) => call[0] === 'codesign' && call.includes('--deep') && call.includes('--strict')));
  assert.ok(calls.some((call) => call.includes('scripts/signing-check.js') && call.includes('--identity')));
  assert.ok(calls.some((call) => call.some((arg) => /signing-check\.js$/.test(arg)) && call.some((arg) => /AgentDeck\.app$/.test(arg))));
  assert.ok(!fs.readdirSync(options.output).some((file) => /^install-|^mobile-/.test(file)));
  const markdown = fs.readFileSync(path.join(options.output, 'release-report.md'), 'utf8');
  assert.match(markdown, /status: package-ready/); assert.match(markdown, /Mobile: deferred/);
  assert.match(markdown, /no installer launcher generated/); assert.doesNotMatch(markdown, /🟢 Mobile|see mobile-deploy-result/);
  // A different mode cannot reuse the package-only output plan and deploy by accident.
  await assert.rejects(release(repo, { ...options, packageOnly: false }, runner), /Output contains another release/);
  // A real failed gate remains fatal in package-only mode and cannot reach packaging.
  write(path.join(repo, 'node_modules/native.node'), 'invalidate gates'); failUnit = true; calls.length = 0;
  await assert.rejects(release(repo, options, runner), /fixture package-only unit failure/);
  report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.status, 'failed'); assert.equal(report.mobile.status, 'deferred');
  assert.ok(calls.some((call) => call.join(' ') === 'npm audit'));
  assert.ok(!calls.some((call) => call.includes('dist:mac')));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), commit); assert.equal(git(repo, 'status', '--porcelain'), '');
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

test('release stops until release-notes.json names the version as the newest release', (t) => {
  const { repo } = fixture(t, '1.9.0', '1.9');
  assert.doesNotThrow(() => checkReleaseNotes(repo, '1.9.0'));
  assert.throws(() => checkReleaseNotes(repo, '2.0.0'), /最新一版是 1\.9，还没写 2\.0 的更新内容/);
  write(path.join(repo, 'release-notes.json'), JSON.stringify({ schema: 1, updated: '2026-10-05', upcoming: [], released: [{ version: '2.0', date: '2026-10-05', title: 'x', items: ['only one'] }] }));
  assert.throws(() => checkReleaseNotes(repo, '2.0.0'), /要写 3–6 条/);
  fs.unlinkSync(path.join(repo, 'release-notes.json'));
  assert.throws(() => checkReleaseNotes(repo, '2.0.0'), /不存在/);
  // The repository's own file always describes the version in package.json.
  const root = path.join(__dirname, '..');
  assert.doesNotThrow(() => checkReleaseNotes(root, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version));
});
