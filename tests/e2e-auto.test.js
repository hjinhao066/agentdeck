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
for (const code of [255, 75, 10, 11, 12, 13, 14]) {
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
