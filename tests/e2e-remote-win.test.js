'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeJob, knownBasesCommand, HUB } = require('../scripts/e2e-remote-win');

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
  assert.match(knownBasesCommand('agentdeck-e2e-win'), /agentdeck-e2e-win\\hub for-each-ref/);
  assert.doesNotMatch(knownBasesCommand('agentdeck-e2e-win'), /\\work /);
});
