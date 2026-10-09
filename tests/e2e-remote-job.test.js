'use strict';
// e2e-remote-job.js runs on the Windows PC inside a queue slot. With AGENTDECK_E2E_SLOTS > 1
// several jobs run at once, possibly for different commits: each must test its own commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const JOB = path.join(__dirname, '..', 'scripts', 'e2e-remote-job.js');
const { depsKey } = require(JOB);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } }).trim();

// A fake Playwright: reports what its working directory holds at the start and 2 s later.
const FAKE_CLI = `
const fs = require('fs'), path = require('path');
const read = () => fs.readFileSync('marker.txt', 'utf8');
const first = read();
setTimeout(() => {
  fs.writeFileSync(path.join(path.dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME), 'seen.txt'), first + ',' + read() + ',' + path.basename(process.cwd()));
}, 2000);
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-remote-job-'));
  const src = path.join(root, 'src'), hub = path.join(root, 'work');
  fs.mkdirSync(src); git(src, 'init', '-q'); git(src, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(src, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"x"}'); fs.writeFileSync(path.join(src, 'package-lock.json'), '{}');
  const shas = {};
  for (const name of ['A', 'B']) {
    fs.writeFileSync(path.join(src, 'marker.txt'), name); git(src, 'add', '-A'); git(src, 'commit', '-qm', name, '--no-verify');
    shas[name] = git(src, 'rev-parse', 'HEAD');
  }
  // The Windows side: a repository that already holds both commits, with Playwright installed once.
  fs.mkdirSync(hub); git(hub, 'init', '-q');
  git(hub, 'fetch', '-q', src, `${shas.A}:refs/e2e/a`, `${shas.B}:refs/e2e/b`);
  const cli = path.join(hub, 'node_modules', '@playwright', 'test', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, FAKE_CLI);
  return { root, hub, shas, fakeCliSource: FAKE_CLI, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A fake `npm` first in PATH: `npm ci` takes 1.5 s, writes a node_modules with the fake Playwright, logs
// "<cwd>" per call, and fails loudly if two installs run in the same folder at once.
function fakeNpm(env) {
  const bin = path.join(env.root, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const log = path.join(env.root, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
busy="$PWD/.npm-busy"
if [ -e "$busy" ]; then echo "CONCURRENT npm ci in $PWD" >&2; exit 1; fi
touch "$busy"; echo "$PWD" >> "${log}"
sleep 1.5
mkdir -p node_modules/@playwright/test
cp "${path.join(env.root, 'fake-cli.js')}" node_modules/@playwright/test/cli.js
rm -f "$busy"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(env.root, 'fake-cli.js'), FAKE_CLI);
  fs.rmSync(path.join(env.hub, 'node_modules'), { recursive: true, force: true }); // nothing installed yet
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, log };
}
const installs = (fake) => (fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8').trim().split('\n').filter(Boolean) : []);

function startJob(env, name, sha, { install = 'skip', extraEnv = {}, lock } = {}) {
  const runDir = path.join(env.root, 'runs', name);
  const jobFile = path.join(env.root, `${name}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ runId: name, sha, ref: 'unused', bundle: null, workDir: env.hub, runDir, specs: ['x.spec.js'], playwrightArgs: [], install }));
  const child = spawn(process.execPath, [JOB, jobFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, output, runDir })));
}
const seen = (job) => fs.readFileSync(path.join(job.runDir, 'seen.txt'), 'utf8');

test('two jobs for different commits at the same time each test their own commit', async () => {
  const env = setup();
  try {
    const [a, b] = await Promise.all([startJob(env, 'run-a', env.shas.A), startJob(env, 'run-b', env.shas.B)]);
    assert.equal(a.code, 0, a.output); assert.equal(b.code, 0, b.output);
    assert.match(seen(a), /^A,A,/, 'job A must still see commit A when job B started meanwhile');
    assert.match(seen(b), /^B,B,/);
    assert.notEqual(seen(a).split(',')[2], seen(b).split(',')[2], 'each job has its own checkout folder');
  } finally { env.done(); }
});

test('three jobs for the same commit at the same time all pass', async () => {
  const env = setup();
  try {
    const jobs = await Promise.all(['r1', 'r2', 'r3'].map((n) => startJob(env, n, env.shas.A)));
    for (const j of jobs) { assert.equal(j.code, 0, j.output); assert.match(seen(j), /^A,A,/); }
  } finally { env.done(); }
});

test('after a job: its checkout is gone, the shared node_modules is intact, git has no stale worktree', async () => {
  const env = setup();
  try {
    const job = await startJob(env, 'run-a', env.shas.A);
    assert.equal(job.code, 0, job.output);
    assert.ok(fs.existsSync(path.join(env.hub, 'node_modules', '@playwright', 'test', 'cli.js')), 'shared node_modules must survive cleanup');
    const checkouts = path.join(env.root, 'checkouts');
    assert.deepEqual(fs.existsSync(checkouts) ? fs.readdirSync(checkouts) : [], []);
    assert.equal(git(env.hub, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  } finally { env.done(); }
});

test('a commit that is not on the machine and has no bundle fails with the setup code', async () => {
  const env = setup();
  try {
    const job = await startJob(env, 'run-x', 'f'.repeat(40));
    assert.equal(job.code, 11);
  } finally { env.done(); }
});

const posix = { skip: process.platform === 'win32' ? 'fake npm is a shell script' : false };

test('three jobs for the same lockfile at once: dependencies are installed ONCE, the others wait and reuse them, all three run', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const jobs = await Promise.all(['r1', 'r2', 'r3'].map((n) => startJob(env, n, env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } })));
    for (const j of jobs) { assert.equal(j.code, 0, j.output); assert.match(seen(j), /^A,A,/); }
    assert.equal(installs(fake).length, 1, 'one npm ci for one lockfile');
    assert.ok(jobs.filter((j) => /waiting for another job/.test(j.output)).length >= 1, 'a waiting job says why it waits');
  } finally { env.done(); }
});

test('a later job with the same lockfile reuses the install without running npm again', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const first = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    const second = await startJob(env, 'r2', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    assert.equal(first.code, 0, first.output); assert.equal(second.code, 0, second.output);
    assert.equal(installs(fake).length, 1);
    assert.match(second.output, /dependencies already installed/);
  } finally { env.done(); }
});

test('different lockfiles install in their own folders and do not disturb each other', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    // commit C changes the lockfile
    const src = path.join(env.root, 'src');
    fs.writeFileSync(path.join(src, 'package-lock.json'), '{"changed":true}'); fs.writeFileSync(path.join(src, 'marker.txt'), 'C');
    git(src, 'add', '-A'); git(src, 'commit', '-qm', 'C', '--no-verify');
    const c = git(src, 'rev-parse', 'HEAD'); git(env.hub, 'fetch', '-q', src, `${c}:refs/e2e/c`);
    const [a, b] = await Promise.all([startJob(env, 'ra', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } }), startJob(env, 'rc', c, { install: 'auto', extraEnv: { PATH: fake.PATH } })]);
    assert.equal(a.code, 0, a.output); assert.equal(b.code, 0, b.output);
    assert.match(seen(a), /^A,A,/); assert.match(seen(b), /^C,C,/);
    const dirs = installs(fake);
    assert.equal(dirs.length, 2); assert.notEqual(dirs[0], dirs[1]);
  } finally { env.done(); }
});

test('a failed npm ci leaves no half-installed folder behind; the next job installs cleanly', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const good = fs.readFileSync(path.join(env.root, 'bin', 'npm'), 'utf8');
    fs.writeFileSync(path.join(env.root, 'bin', 'npm'), '#!/bin/sh\nmkdir -p node_modules/half; exit 1\n', { mode: 0o755 });
    const bad = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    assert.equal(bad.code, 13, bad.output);
    fs.writeFileSync(path.join(env.root, 'bin', 'npm'), good, { mode: 0o755 });
    const ok = await startJob(env, 'r2', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    assert.equal(ok.code, 0, ok.output);
    assert.equal(installs(fake).length, 1);
  } finally { env.done(); }
});

const holdLock = (env, ageMs) => {
  // The lock a (crashed or slow) installer of this lockfile would hold.
  const lock = path.join(env.root, 'deps', `${depsKey(fs.readFileSync(path.join(env.root, 'src', 'package-lock.json')))}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  const t = new Date(Date.now() - ageMs); fs.utimesSync(lock, t, t);
  return lock;
};

test('waiting for another job\'s install has a time limit and a clear message (exit 15)', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    holdLock(env, 0);
    const job = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH, AGENTDECK_E2E_INSTALL_WAIT_MS: '1500' } });
    assert.equal(job.code, 15, job.output);
    assert.match(job.output, /waited \d+ s for another job's dependency install/);
    assert.equal(installs(fake).length, 0);
  } finally { env.done(); }
});

test('an install lock left by a crashed job is broken once it is stale', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    holdLock(env, 2 * 60 * 60 * 1000);
    const job = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    assert.equal(job.code, 0, job.output);
    assert.equal(installs(fake).length, 1);
  } finally { env.done(); }
});

test('after npm ci the Electron binary must start before jobs use it: a first launch that fails is retried (fresh files are often locked by the virus scanner)', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const counter = path.join(env.root, 'electron-starts');
    const npm = path.join(env.root, 'bin', 'npm');
    // npm ci that also drops a fake Electron which fails its first two starts
    fs.writeFileSync(npm, fs.readFileSync(npm, 'utf8') + `mkdir -p node_modules/electron/dist
echo electron > node_modules/electron/path.txt
cat > node_modules/electron/dist/electron <<'EOS'
#!/bin/sh
echo x >> "${counter}"
[ "$(wc -l < "${counter}")" -ge 3 ] || { echo "file is in use by another process" >&2; exit 1; }
echo v1.0.0
EOS
chmod +x node_modules/electron/dist/electron
`, { mode: 0o755 });
    const job = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH, AGENTDECK_E2E_ELECTRON_RETRY_MS: '100' } });
    assert.equal(job.code, 0, job.output);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 3, 'started until it worked');
    assert.match(job.output, /electron starts \(try 3\)/);
    // a later job finds the install complete and does not start it again
    const second = await startJob(env, 'r2', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } });
    assert.equal(second.code, 0, second.output);
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 3);
  } finally { env.done(); }
});

test('an Electron that never starts after install: the job still runs (the test itself reports the failure) but says so', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const npm = path.join(env.root, 'bin', 'npm');
    fs.writeFileSync(npm, fs.readFileSync(npm, 'utf8') + `mkdir -p node_modules/electron/dist
echo electron > node_modules/electron/path.txt
printf '#!/bin/sh\\nexit 1\\n' > node_modules/electron/dist/electron
chmod +x node_modules/electron/dist/electron
`, { mode: 0o755 });
    const job = await startJob(env, 'r1', env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH, AGENTDECK_E2E_ELECTRON_RETRY_MS: '10' } });
    assert.equal(job.code, 0, job.output);
    assert.match(job.output, /warning: electron did not start after install/);
  } finally { env.done(); }
});

test('Electron that downloads its binary on first use is fetched once, during the install, not inside the first test', posix, async () => {
  const env = setup();
  try {
    const fake = fakeNpm(env);
    const downloads = path.join(env.root, 'downloads.log');
    const npm = path.join(env.root, 'bin', 'npm');
    // like the real package: requiring it downloads the binary when path.txt is missing
    fs.writeFileSync(npm, fs.readFileSync(npm, 'utf8') + `mkdir -p node_modules/electron
cat > node_modules/electron/index.js <<'EOJ'
const fs = require('fs'), path = require('path');
if (!fs.existsSync(path.join(__dirname, 'path.txt'))) {
  fs.appendFileSync(${JSON.stringify(downloads)}, 'download\\n');
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'electron'), '#!/bin/sh\\necho v1.0.0\\n', { mode: 0o755 });
  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron');
}
module.exports = path.join(__dirname, 'dist', 'electron');
EOJ
`, { mode: 0o755 });
    const jobs = await Promise.all(['r1', 'r2', 'r3'].map((n) => startJob(env, n, env.shas.A, { install: 'auto', extraEnv: { PATH: fake.PATH } })));
    for (const j of jobs) assert.equal(j.code, 0, j.output);
    assert.equal(fs.readFileSync(downloads, 'utf8').trim().split('\n').length, 1, 'one download for three jobs');
    assert.ok(jobs.some((j) => /electron starts \(try 1\)/.test(j.output)));
  } finally { env.done(); }
});
