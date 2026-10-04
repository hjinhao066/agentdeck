'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../restart-resume');

const crew = (id, extra = {}) => ({ id, title: id, captainCrew: true, coldSpawned: true, cmd: 'cursor-agent', ...extra });
const task = (colId, status, summary) => ({ colId, title: colId, status, receipt: summary ? { summary, files: [], failed: '' } : null });

test('a safe-stop receipt is not a finished task', () => {
  for (const text of [
    '已停在安全点并推送，等待续派',
    '已安全停工并推送未完成提交',
    '停下等待，重启后继续',
    '等待队长恢复任务',
    'stopped at a safe point and pushed',
  ]) assert.equal(R.isSafetyCheckpoint(text), true, text);
  for (const text of ['功能已做完并推送', '验收通过', '队长已请求中断当前操作。', '']) assert.equal(R.isSafetyCheckpoint(text), false, text);
});

test('resume plans cover in-flight crew and safe-stop closures, not finished or manual work', () => {
  const columns = [
    crew('live'),
    crew('paused'),
    crew('checkpoint'),
    crew('finished'),
    crew('stopped'),
    crew('asking'),
    crew('quota'),
    crew('manual', { captainCrew: false }),
    crew('hot', { coldSpawned: false }),
    { id: 'cap', isMain: true, captainCrew: false, coldSpawned: true, cmd: 'claude' },
  ];
  const tasks = [
    task('live', 'working'),
    task('paused', 'paused', '重启前停在安全点，重启后会自动续上'),
    task('checkpoint', 'done', '已停在安全点并推送，等待续派'),
    task('finished', 'done', '功能已做完并推送'),
    task('stopped', 'stopped', '队长已请求中断当前操作。'),
    task('asking', 'asking'),
    task('quota', 'quota'),
    task('manual', 'working'),
    task('hot', 'working'),
    task('cap', 'working'),
  ];
  const plans = R.planResume(columns, tasks);
  assert.deepEqual(plans.map((p) => p.id), ['live', 'paused', 'checkpoint']);
  assert.match(plans[0].message, /刚重启/);
  assert.match(plans[0].message, /不要用 complete/);
  assert.equal(R.planResume(columns, tasks).length, 3);
});

test('parking before quit only marks crew that are still on the same job', () => {
  const columns = [crew('live'), crew('done'), crew('ask'), { id: 'cap', isMain: true, captainCrew: false }];
  const tasks = [task('live', 'working'), task('done', 'done', '功能已做完并推送'), task('ask', 'asking'), task('cap', 'working')];
  const plans = R.planPark(columns, tasks);
  assert.deepEqual(plans.map((p) => p.id), ['live']);
  assert.match(plans[0].message, /不要用 complete 报告安全点/);
});

test('ledger keeps an open resumed worker out of the finished bucket', () => {
  assert.equal(R.ledgerState('done', true, { status: 'working' }), 'working');
  assert.equal(R.ledgerState('plain', true, { status: 'queued' }), 'working');
  assert.equal(R.ledgerState('done', true, { status: 'paused' }), 'paused');
  assert.equal(R.ledgerState('done', true, { status: 'done' }), 'done');
  assert.equal(R.ledgerState('exited', false, { status: 'working' }), 'exited');
});
