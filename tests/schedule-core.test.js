'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../schedule-core');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('daily schedules pick the next allowed weekday at the set time', () => {
  // 2026-10-01 is a Thursday
  const s = S.normalizeSchedule({ prompt: 'p', kind: 'daily', time: '9:05', days: [1, 2, 3, 4, 5] });
  assert.equal(s.time, '09:05');
  assert.equal(S.computeNext(s, at(2026, 10, 1, 8, 0)), at(2026, 10, 1, 9, 5));
  assert.equal(S.computeNext(s, at(2026, 10, 1, 9, 5)), at(2026, 10, 2, 9, 5));   // strictly after
  assert.equal(S.computeNext(s, at(2026, 10, 2, 10, 0)), at(2026, 10, 5, 9, 5));  // Friday evening → Monday
  assert.equal(S.describe(s), '工作日 09:05');
});

test('once and interval schedules', () => {
  const now = at(2026, 10, 1, 12, 0);
  const once = S.normalizeSchedule({ prompt: 'p', kind: 'once', at: now + 3600_000 });
  assert.equal(S.validate(once, now), '');
  assert.equal(S.validate({ ...once, at: now - 1 }, now), '这个时间已经过去了');
  const armed = S.arm(once, now);
  assert.equal(armed.nextAt, now + 3600_000);
  const done = S.settle(armed, now + 3600_000, 'ok');
  assert.equal(done.enabled, false);
  assert.equal(done.nextAt, null);
  const every = S.normalizeSchedule({ prompt: 'p', kind: 'interval', every: 1 });
  assert.equal(every.every, S.MIN_EVERY);
  assert.equal(S.arm(every, now).nextAt, now + S.MIN_EVERY * 60_000);
  assert.equal(S.describe(S.normalizeSchedule({ prompt: 'p', kind: 'interval', every: 120 })), '每 2 小时');
});

test('due runs fire, runs overdue at launch are reported as missed', () => {
  const now = at(2026, 10, 1, 12, 0);
  const s = { ...S.normalizeSchedule({ prompt: 'p', kind: 'interval', every: 30 }), nextAt: now - 1000 };
  assert.equal(S.dueAction(s, now, false), 'run');
  assert.equal(S.dueAction(s, now, true), 'run');                        // just due: still fires
  assert.equal(S.dueAction({ ...s, nextAt: now - S.STARTUP_GRACE - 1 }, now, true), 'missed');
  assert.equal(S.dueAction({ ...s, enabled: false }, now, false), null);
  assert.equal(S.dueAction({ ...s, nextAt: now + 1 }, now, false), null);
  const after = S.settle(s, now, 'missed', 'AgentDeck 当时没开');
  assert.equal(after.nextAt, now + 30 * 60_000);
  assert.equal(after.lastStatus, 'missed');
});

test('normalization keeps prompts multi-line and rejects bad targets', () => {
  const s = S.normalizeSchedule({ id: '../evil', prompt: 'line 1\r\nline 2\u0007', target: '../x', agent: 'rm -rf', kind: 'weird' });
  assert.notEqual(s.id, '../evil');
  assert.equal(s.prompt, 'line 1\nline 2');
  assert.equal(s.target, 'new');
  assert.equal(s.agent, 'claude');
  assert.equal(s.kind, 'daily');
  assert.equal(S.normalizeSchedules([{ prompt: '' }, { id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]).length, 1);
});
