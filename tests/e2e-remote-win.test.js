'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeJob, knownBasesCommand, HUB, checkHome, removeRunCommand, prepareCommand, queueCommand } = require('../scripts/e2e-remote-win');

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
