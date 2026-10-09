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
  return { root, hub, shas, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function startJob(env, name, sha) {
  const runDir = path.join(env.root, 'runs', name);
  const jobFile = path.join(env.root, `${name}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ runId: name, sha, ref: 'unused', bundle: null, workDir: env.hub, runDir, specs: ['x.spec.js'], playwrightArgs: [], install: 'skip' }));
  const child = spawn(process.execPath, [JOB, jobFile], { stdio: ['ignore', 'pipe', 'pipe'] });
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
