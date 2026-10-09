'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs, makeRunId, queueCommand } = require('../scripts/e2e-remote-win');
const { checkJob } = require('../scripts/e2e-remote-job');

const JOB = path.join(__dirname, '..', 'scripts', 'e2e-remote-job.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('remote runner arguments: branch, specs, options and extra Playwright arguments', () => {
  const o = parseArgs(['agentdeck/t-1', 'tests/e2e/a.spec.js', 'tests/e2e/b.spec.js', '--host', 'pc2', '--queue-wait-timeout', '10', '--no-install', '--', '--grep', 'two words']);
  assert.equal(o.ref, 'agentdeck/t-1'); assert.deepEqual(o.specs, ['tests/e2e/a.spec.js', 'tests/e2e/b.spec.js']);
  assert.equal(o.host, 'pc2'); assert.equal(o.waitMinutes, 10); assert.equal(o.install, 'skip');
  assert.deepEqual(o.playwrightArgs, ['--grep', 'two words']);
  assert.equal(parseArgs(['b', 's.spec.js']).host, 'winpc');
});

test('remote runner refuses anything that could be read as a shell command or option', () => {
  assert.throws(() => parseArgs(['b']), /Usage/);
  assert.throws(() => parseArgs(['b; calc', 'x.spec.js']), /Odd branch/);
  assert.throws(() => parseArgs(['-x', 'x.spec.js']));
  assert.throws(() => parseArgs(['b', 'x.spec.js & del *']), /plain path/);
  assert.throws(() => parseArgs(['b', 'x.spec.js', '--host', 'a b']), /Odd host/);
  assert.throws(() => parseArgs(['b', 'x.spec.js', '--queue-run-timeout', '0']), /positive/);
});

test('run ids are unique, filename-safe and name the commit', () => {
  const sha = 'a'.repeat(40);
  const ids = new Set(Array.from({ length: 50 }, () => makeRunId(sha, new Date('2026-10-09T01:02:03.456Z'))));
  assert.ok(ids.size > 40);
  for (const id of ids) assert.match(id, /^20261009T010203Z-aaaaaaa-[0-9a-f]{4}$/);
});

test('the Windows command runs the uploaded job through the same queue, with the chosen timeouts', () => {
  const cmd = queueCommand('C:\\Users\\x', 'run1', { waitMinutes: 7, runMinutes: 9 });
  assert.equal(cmd, 'node C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\tools\\e2e-queue.js --queue-wait-timeout 7 --queue-run-timeout 9 -- node C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\tools\\e2e-remote-job.js C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\job.json');
});

test('job files are validated before anything runs', () => {
  const ok = { runId: 'r-1', sha: 'b'.repeat(40), workDir: 'w', runDir: 'r', specs: [] };
  assert.equal(checkJob(ok), ok);
  assert.throws(() => checkJob({ ...ok, sha: 'main' }), /commit id/);
  assert.throws(() => checkJob({ ...ok, runId: '..\\x' }), /runId/);
  assert.throws(() => checkJob({ ...ok, specs: 'x' }), /specs/);
  assert.throws(() => checkJob({ ...ok, workDir: '' }), /workDir/);
});

test('the remote job fetches the commit into its own checkout, runs the specs and records the result', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-remote-job-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 't@t'); git(source, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(source, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(source, 'marker.txt'), 'one');
  git(source, 'add', '.'); git(source, 'commit', '-q', '-m', 'one');
  const sha = git(source, 'rev-parse', 'HEAD');
  git(source, 'update-ref', 'refs/e2e-remote/test', sha);
  const bundle = path.join(root, 'c.bundle');
  git(source, 'bundle', 'create', bundle, 'refs/e2e-remote/test');

  // A stand-in Playwright that echoes its arguments and the marker file of the checked-out commit.
  const work = path.join(root, 'work');
  const cli = path.join(work, 'node_modules', '@playwright', 'test', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `console.log('ARGS ' + JSON.stringify(process.argv.slice(2)));
console.log('MARKER ' + require('fs').readFileSync('marker.txt', 'utf8'));
process.exit(Number(process.env.FAKE_EXIT || 0));`);

  const runJob = (runId, extra = {}, env = {}) => {
    const job = { runId, sha, ref: 'refs/e2e-remote/test', bundle, workDir: work, runDir: path.join(root, 'runs', runId),
      specs: ['tests/e2e/a.spec.js'], playwrightArgs: ['--grep', 'x'], install: 'skip', ...extra };
    const file = path.join(root, `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify(job));
    const r = spawnSync(process.execPath, [JOB, file], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { r, summary: JSON.parse(fs.readFileSync(path.join(job.runDir, 'summary.json'), 'utf8')) };
  };

  const first = runJob('r1');
  assert.equal(first.r.status, 0, first.r.stdout + first.r.stderr);
  assert.match(first.r.stdout, /MARKER one/);
  const args = JSON.parse(/ARGS (.*)/.exec(first.r.stdout)[1]);
  assert.deepEqual(args.slice(0, 2), ['test', 'tests/e2e/a.spec.js']);
  assert.ok(args.includes('--reporter=list,json') && args.includes('--grep'));
  assert.equal(first.summary.exitCode, 0);
  assert.equal(git(work, 'rev-parse', 'HEAD'), sha);

  // A second run of the same commit needs no bundle; a failing run reports its exit code.
  const second = runJob('r2', { bundle: null }, { FAKE_EXIT: '3' });
  assert.equal(second.r.status, 3);
  assert.equal(second.summary.exitCode, 3);

  // An unknown commit without a bundle fails loudly instead of testing something else.
  const lost = runJob('r3', { bundle: null, sha: 'c'.repeat(40) });
  assert.equal(lost.r.status, 11);
  assert.match(lost.summary.failed, /no bundle/);
});
