'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, summarizeSamples, newProcesses, snapshotField, throughputFactor, queueWait } = require('../scripts/perf-e2e-benchmark');

const SHA = 'a'.repeat(40);

test('samples: averages, peaks, Defender share and the sessions E2E processes ran in', () => {
  const s = summarizeSamples([
    'time,totalCpuPct,defenderCpuPct,e2eProcs,e2eSessions,jobs',
    '2026-10-08T22:00:00.0000000-07:00,40,2.0,0,,0',
    '2026-10-08T22:00:03.0000000-07:00,80,6.0,12,0,2',
    '2026-10-08T22:00:06.0000000-07:00,60,4.0,20,0,3',
    'half a line', '',
  ]);
  assert.deepEqual(s, { samples: 3, totalCpuAvg: 60, totalCpuPeak: 80, defenderAvg: 4, defenderPeak: 6, maxE2eProcs: 20, maxJobs: 3, e2eSessions: ['0'] });
});
test('samples: an empty sampler output is not a number', () => {
  assert.equal(summarizeSamples([]).samples, 0);
});
test('desktop snapshot diff lists only processes that appeared', () => {
  const before = ['desktopSession=1', 'P|10|2026-01-01T00:00:00|explorer.exe', 'P|11|2026-01-01T00:00:01|Zoom.exe'];
  const after = ['desktopSession=1', 'P|10|2026-01-01T00:00:00|explorer.exe', 'P|11|2026-01-01T00:00:01|Zoom.exe', 'P|99|2026-01-01T00:09:00|electron.exe',
    'P|11|2026-01-01T00:08:00|Reused.exe'];
  assert.deepEqual(newProcesses(before, after), ['electron.exe(99)', 'Reused.exe(11)']);
  assert.equal(snapshotField(['desktopSession=1', 'e2eInDesktopSession=0'], 'e2eInDesktopSession'), '0');
});
test('throughput factor: N groups done in the time T, against one group alone', () => {
  assert.equal(throughputFactor(100, 3, 150), 2);
  assert.equal(throughputFactor(100, 1, 100), 1);
});
test('queue wait is read from the queue line', () => {
  assert.equal(queueWait('[e2e-queue] 轮到了（等了 87 秒），开始跑：playwright'), 87);
  assert.equal(queueWait('nothing'), 0);
});
test('arguments need a mode, a full commit id, an output folder and a spec', () => {
  assert.deepEqual(parseArgs(['--mode', 'win', '--groups', '2', '--sha', SHA, '--out', '/tmp/x', 'tests/e2e/a.spec.js']),
    { mode: 'win', groups: 2, sha: SHA, out: '/tmp/x', host: 'winpc', specs: ['tests/e2e/a.spec.js'] });
  assert.throws(() => parseArgs(['--mode', 'win', '--sha', 'HEAD', '--out', '/tmp/x', 'a.spec.js']), /full commit id/);
  assert.throws(() => parseArgs(['--mode', 'x', '--sha', SHA, '--out', '/tmp/x', 'a.spec.js']), /mode/);
  assert.throws(() => parseArgs(['--mode', 'mac', '--sha', SHA, '--out', '/tmp/x']), /spec/);
  assert.throws(() => parseArgs(['--mode', 'mac', '--groups', '1.5', '--sha', SHA, '--out', '/tmp/x', 'a.spec.js']), /whole number/);
});
