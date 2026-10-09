'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const auto = require('../scripts/e2e-auto');
const { isMacOnlySource, isMacOnlySpec, parseArgs, main, snapshotCommit, INFRA_EXIT_CODES } = auto;

const ROOT = path.join(__dirname, '..');
const withSpec = (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-auto-spec-'));
  const file = path.join(dir, 'x.spec.js');
  fs.writeFileSync(file, source);
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

// ---- Mac-only detection ---------------------------------------------------------------
const MAC_ONLY = {
  'skip option, win32': "test('a', { skip: process.platform === 'win32' }, async () => {});",
  'test.skip(win32, reason)': "test('a', async () => { test.skip(process.platform === 'win32', 'posix only'); });",
  'test.skip(!== darwin)': "test('a', async () => { test.skip(process.platform !== 'darwin', 'mac only'); });",
  'skip option, !== darwin': "test('a', { skip: process.platform !== 'darwin' }, async () => {});",
  'double quotes and loose equality': 'test.skip(process.platform == "win32");',
  'reversed operands': "test.skip('win32' === process.platform);",
  'os.platform()': "const os = require('node:os');\ntest.skip(os.platform() === 'win32');",
  'alias const isWin': "const isWin = process.platform === 'win32';\ntest.skip(isWin, 'posix');",
  'negated alias const isMac': "const isMac = process.platform === 'darwin';\ntest.skip(!isMac);",
  'describe.skip': "test.describe.skip(process.platform === 'win32', () => { test('a', () => {}); });",
  'test.fixme': "test.fixme(process.platform === 'win32', 'broken there');",
  'win32 or linux skipped': "test.skip(process.platform === 'win32' || process.platform === 'linux');",
  'newline and spaces inside the call': "test.skip(\n   process.platform\n     === 'win32',\n  'x');",
};
for (const [name, source] of Object.entries(MAC_ONLY)) {
  test(`Mac-only spec is detected: ${name}`, () => assert.equal(isMacOnlySource(source), true, source));
}

const CROSS_PLATFORM = {
  'plain spec': "test('a', async () => {});",
  'platform used only to pick a key': "const mod = process.platform === 'darwin' ? 'Meta' : 'Control';\ntest('a', async () => {});",
  'skip that does not involve the platform': "test.skip(!process.env.SHOTS, 'set SHOTS');",
  'skip only when Windows AND a mode (other modes run on Windows)': "for (const mode of ['a','b']) test(mode, async () => { test.skip(mode === 'a' && process.platform === 'win32', 'x'); });",
  'skips on darwin only (Windows runs it)': "test.skip(process.platform === 'darwin', 'x');",
  'Windows-only spec': "test.skip(process.platform !== 'win32');",
  'a test title that mentions win32 is not a condition': "test.skip('skips on win32 machines', async () => {});",
  'commented-out skip': "// test.skip(process.platform === 'win32');\n/* test.skip(process.platform !== 'darwin') */\ntest('a', () => {});",
  'skip text inside a string': "const note = \"test.skip(process.platform === 'win32')\";\ntest('a', () => {});",
  'unconditional alias that is not about the platform': "const flag = process.env.X === '1';\ntest.skip(flag);",
};
for (const [name, source] of Object.entries(CROSS_PLATFORM)) {
  test(`cross-platform spec stays on the Windows route: ${name}`, () => assert.equal(isMacOnlySource(source), false, source));
}

test('the two benchmark specs are cross-platform and the repo specs with a Windows skip are Mac-only', () => {
  for (const spec of ['chat', 'quota-warmup']) assert.equal(isMacOnlySpec(path.join(ROOT, 'tests/e2e', `${spec}.spec.js`)), false, spec);
  for (const spec of ['mobile-release', 'auto-worktree']) assert.equal(isMacOnlySpec(path.join(ROOT, 'tests/e2e', `${spec}.spec.js`)), true, spec);
});

test('isMacOnlySpec reads the file; a missing file is not Mac-only', () => {
  const t = withSpec(MAC_ONLY['test.skip(!== darwin)']);
  try { assert.equal(isMacOnlySpec(t.file), true); } finally { t.done(); }
  assert.equal(isMacOnlySpec('/nonexistent/path/test.spec.js'), false);
});

// ---- arguments ---------------------------------------------------------------------------
test('parseArgs splits specs, host and playwright args', () => {
  assert.deepEqual(parseArgs(['tests/e2e/a.spec.js', 'tests/e2e/b.spec.js', '--host', 'box', '--', '--workers=1', '--grep', 'x']),
    { status: false, host: 'box', specs: ['tests/e2e/a.spec.js', 'tests/e2e/b.spec.js'], playwrightArgs: ['--workers=1', '--grep', 'x'] });
  assert.equal(parseArgs(['--status']).status, true);
});
test('parseArgs refuses an argument it would otherwise silently drop', () => {
  assert.throws(() => parseArgs(['tests/e2e/a.spec.js', '--workers=1']), /--workers=1.*after --/);
  assert.throws(() => parseArgs(['tests/e2e/a.spec.js', 'stray']), /stray/);
});

// ---- routing ---------------------------------------------------------------------------
const fakeDeps = (over = {}) => {
  const calls = { win: [], local: [], lines: [] };
  return { calls, deps: {
    say: (m) => calls.lines.push(m),
    isMacOnlySpec: (p) => /mac/.test(p),
    isWindowsOnline: () => true,
    runOnWindows: async (specs, pw, host) => { calls.win.push({ specs, pw, host }); return 0; },
    runLocal: async (specs, pw) => { calls.local.push({ specs, pw }); return 0; },
    ...over } };
};
const run = (argv, over) => { const f = fakeDeps(over); return main(argv, f.deps).then((code) => ({ code, ...f.calls })); };

test('cross-platform specs go to Windows in ONE group, Mac-only specs go to the local queue', async () => {
  const r = await run(['tests/e2e/a.spec.js', 'tests/e2e/mac.spec.js', 'tests/e2e/b.spec.js', '--', '--workers=1']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.win, [{ specs: ['tests/e2e/a.spec.js', 'tests/e2e/b.spec.js'], pw: ['--workers=1'], host: 'winpc' }]);
  assert.deepEqual(r.local, [{ specs: ['tests/e2e/mac.spec.js'], pw: ['--workers=1'] }]);
});
test('Windows offline: everything runs on the Mac queue and Windows is never called', async () => {
  const r = await run(['tests/e2e/a.spec.js', 'tests/e2e/mac.spec.js'], { isWindowsOnline: () => false });
  assert.equal(r.win.length, 0);
  assert.deepEqual(r.local[0].specs.sort(), ['tests/e2e/a.spec.js', 'tests/e2e/mac.spec.js']);
});
for (const code of [255, 75, 10, 11, 12, 13, 14, 15, 16]) {
  test(`Windows setup/connection failure (exit ${code}) falls back to the Mac queue`, async () => {
    assert.ok(INFRA_EXIT_CODES.has(code));
    const r = await run(['tests/e2e/a.spec.js'], { runOnWindows: async () => code });
    assert.deepEqual(r.local, [{ specs: ['tests/e2e/a.spec.js'], pw: [] }]);
    assert.equal(r.code, 0);
  });
}
test('Windows run that throws (ssh gone mid-way) falls back to the Mac queue', async () => {
  const r = await run(['tests/e2e/a.spec.js'], { runOnWindows: async () => { throw new Error('ssh: connect failed'); } });
  assert.deepEqual(r.local, [{ specs: ['tests/e2e/a.spec.js'], pw: [] }]);
  assert.equal(r.code, 0);
});
test('a real test failure on Windows is a failure: no silent re-run on the Mac, exit code kept', async () => {
  const r = await run(['tests/e2e/a.spec.js'], { runOnWindows: async () => 1 });
  assert.equal(r.local.length, 0);
  assert.equal(r.code, 1);
  assert.ok(r.lines.some((l) => /test\.skip\(process\.platform/.test(l)), 'hint how to mark a POSIX-only spec');
});
test('no specs: usage error, nothing runs', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.equal(r.win.length + r.local.length, 0);
});

// ---- what gets tested on Windows is what is in the working tree --------------------------------
test('snapshotCommit: clean tree uses HEAD; dirty tree (modified + new file) becomes a commit without touching HEAD, index or stash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-auto-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } }).trim();
  try {
    git('init', '-q'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one'); git('add', '.'); git('commit', '-qm', 'base', '--no-verify');
    const head = git('rev-parse', 'HEAD');
    assert.equal(snapshotCommit(dir), head, 'clean tree: HEAD itself');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new');
    const statusBefore = git('status', '--porcelain');
    const sha = snapshotCommit(dir);
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.notEqual(sha, head);
    assert.equal(git('show', `${sha}:a.txt`), 'two');
    assert.equal(git('show', `${sha}:new.txt`), 'brand new');
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('status', '--porcelain'), statusBefore, 'index and working tree untouched');
    assert.equal(git('stash', 'list'), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('snapshotCommit: a node_modules link in the worktree stays out of the snapshot (this repo\'s .gitignore covers links too)', {
  skip: process.platform === 'win32' && 'a symlink needs developer mode on Windows',
}, () => {
  // Worktrees often link node_modules to a main checkout. `node_modules/` matches only folders, so the link
  // made the tree dirty and went to Windows inside the snapshot, where it blocks the job's own link.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-auto-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } }).trim();
  try {
    git('init', '-q'); git('config', 'commit.gpgsign', 'false');
    fs.copyFileSync(path.join(ROOT, '.gitignore'), path.join(dir, '.gitignore'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one'); git('add', '.'); git('commit', '-qm', 'base', '--no-verify');
    const head = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'main-checkout-modules'));
    fs.symlinkSync(path.join(dir, 'main-checkout-modules'), path.join(dir, 'node_modules'));
    fs.rmSync(path.join(dir, 'main-checkout-modules'), { recursive: true }); // only the link is in the tree
    assert.equal(snapshotCommit(dir), head, 'a tree with only the link is clean');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
    const sha = snapshotCommit(dir);
    assert.deepEqual(git('ls-tree', '--name-only', sha).split('\n').sort(), ['.gitignore', 'a.txt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the real modules e2e-auto calls must offer what it calls (a mismatch was hidden by the fallback) ----
test('e2e-auto calls main() of e2e-remote-win and e2e-queue: both modules export it', () => {
  assert.equal(typeof require('../scripts/e2e-remote-win').main, 'function');
  assert.equal(typeof require('../scripts/e2e-queue').main, 'function');
});

test('Mac-only and Windows groups run at the same time, not one after the other', async () => {
  let release;
  const winStarted = new Promise((resolve) => { release = resolve; });
  const order = [];
  const f = fakeDeps({
    runOnWindows: async () => { order.push('win:start'); await new Promise((r) => setTimeout(r, 50)); order.push('win:end'); return 0; },
    runLocal: async () => { order.push('local:start'); await new Promise((r) => setTimeout(r, 10)); order.push('local:end'); return 0; },
  });
  const code = await main(['tests/e2e/a.spec.js', 'tests/e2e/mac.spec.js'], f.deps);
  assert.equal(code, 0);
  assert.deepEqual(order.slice(0, 2).sort(), ['local:start', 'win:start']);
  assert.ok(order.indexOf('local:start') < order.indexOf('win:end'));
});
test('a spec given as an absolute path or from another folder is judged by the file it names', async () => {
  const seenPaths = [];
  const f = fakeDeps({ isMacOnlySpec: (p) => { seenPaths.push(p); return false; } });
  await main([path.join(ROOT, 'tests/e2e/a.spec.js')], f.deps);
  assert.deepEqual(seenPaths, [path.join(ROOT, 'tests/e2e/a.spec.js')]);
});
