'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeJob, knownBasesCommand, HUB, checkHome, removeRunCommand, prepareCommand, queueCommand, parseArgs, makeRunId } = require('../scripts/e2e-remote-win');
const { checkJob } = require('../scripts/e2e-remote-job');

const base = { runId: 'r1', sha: 'a'.repeat(40), ref: 'refs/e2e-remote/r1', winBase: 'C:\\Users\\u\\agentdeck-e2e-win', needBundle: true,
  specs: ['tests/e2e/a.spec.js'], playwrightArgs: ['--workers=1'], install: 'auto' };

test('jobs use the hub folder, never the old shared "work" folder that older dispatchers still install into and clean', () => {
  const job = makeJob(base);
  assert.equal(HUB, 'hub');
  assert.equal(job.workDir, 'C:\\Users\\u\\agentdeck-e2e-win\\hub');
  assert.equal(job.runDir, 'C:\\Users\\u\\agentdeck-e2e-win\\runs\\r1');
  assert.equal(job.bundle, 'C:\\Users\\u\\agentdeck-e2e-win\\inbox\\r1\\commit.bundle');
  assert.equal(makeJob({ ...base, needBundle: false }).bundle, null);
  assert.deepEqual(job.specs, base.specs);
});
test('the list of commits Windows already holds is read from the hub too', () => {
  assert.match(knownBasesCommand('agentdeck-e2e-win'), /agentdeck-e2e-win\\hub" for-each-ref/);
  assert.doesNotMatch(knownBasesCommand('agentdeck-e2e-win'), /\\work /);
});

// A home folder can contain a space ("C:\\Users\\John Smith"). Unquoted, `rmdir /s /q C:\\Users\\John Smith\\...` deletes C:\\Users\\John.
const SPACED = 'C:\\Users\\John Smith\\agentdeck-e2e-win';
test('a home folder with a space is refused up front', () => {
  assert.equal(checkHome('C:\\Users\\hjinh'), 'C:\\Users\\hjinh');
  assert.throws(() => checkHome('C:\\Users\\John Smith'), /Unexpected Windows home/);
  assert.throws(() => checkHome('C:\\Users\\x & del *'), /Unexpected Windows home/);
});
test('every Windows path in a command is quoted, delete commands included', () => {
  const rm = removeRunCommand(SPACED, 'r1');
  assert.ok(rm.includes('rmdir /s /q "C:\\Users\\John Smith\\agentdeck-e2e-win\\inbox\\r1"'), rm);
  assert.ok(rm.includes('rmdir /s /q "C:\\Users\\John Smith\\agentdeck-e2e-win\\runs\\r1"'), rm);
  assert.doesNotMatch(rm, /rmdir \/s \/q [^"]/);
  assert.match(prepareCommand(SPACED, 'r1'), /mkdir "C:\\Users\\John Smith\\agentdeck-e2e-win\\inbox\\r1\\tools"/);
  const q = queueCommand('C:\\Users\\John Smith', 'r1', { waitMinutes: 1, runMinutes: 2 });
  assert.ok(q.includes('"C:\\Users\\John Smith\\agentdeck-e2e-win\\inbox\\r1\\tools\\e2e-queue.js"'), q);
  assert.match(knownBasesCommand('agentdeck-e2e-win'), /git -C "%USERPROFILE%\\agentdeck-e2e-win\\hub"/);
});
test('delete commands refuse anything that is not a run folder under agentdeck-e2e-win', () => {
  assert.throws(() => removeRunCommand(SPACED, 'r1 & del *'), /run id/);
  assert.throws(() => removeRunCommand(SPACED, '..'), /run id/);
  assert.throws(() => removeRunCommand('C:\\Users\\John Smith', 'r1'), /agentdeck-e2e-win/);
  assert.throws(() => removeRunCommand('C:\\Users\\x\\agentdeck-e2e-win\\..\\..', 'r1'), /agentdeck-e2e-win/);
  assert.throws(() => removeRunCommand('C:\\Users\\x"\\agentdeck-e2e-win', 'r1'), /agentdeck-e2e-win/);
});

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
  // Every Windows path is quoted (a home folder with odd characters cannot split the command).
  assert.equal(cmd, 'node "C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\tools\\e2e-queue.js" --queue-wait-timeout 7 --queue-run-timeout 9 -- node "C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\tools\\e2e-remote-job.js" "C:\\Users\\x\\agentdeck-e2e-win\\inbox\\run1\\job.json"');
});

test('job files are validated before anything runs', () => {
  const ok = { runId: 'r-1', sha: 'b'.repeat(40), workDir: 'w', runDir: 'r', specs: [] };
  assert.equal(checkJob(ok), ok);
  assert.throws(() => checkJob({ ...ok, sha: 'main' }), /commit id/);
  assert.throws(() => checkJob({ ...ok, runId: '..\\x' }), /runId/);
  assert.throws(() => checkJob({ ...ok, specs: 'x' }), /specs/);
  assert.throws(() => checkJob({ ...ok, workDir: '' }), /workDir/);
});
