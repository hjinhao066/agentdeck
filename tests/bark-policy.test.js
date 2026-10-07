'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, blockedUntil } = require('../bark-policy');
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

test('shared critical volume and sleep defaults use latest preferences and reject malformed values', () => {
  for (const value of [undefined, null, [], 'bad', { criticalVolume: 11, sleepStart: '25:00', sleepEnd: 'bad' }]) {
    const result = settings(value);
    assert.equal(result.criticalVolume, 4);
    assert.equal(result.sleepStart, '23:00'); assert.equal(result.sleepEnd, '10:00');
  }
  assert.equal(settings({ criticalVolume: 0 }).criticalVolume, 0);
  assert.equal(settings({ criticalVolume: 7 }).criticalVolume, 7);
  assert.equal(settings({ criticalVolume: 3.5 }).criticalVolume, 4);
  assert.equal(settings({ sleepStart: '10:00', sleepEnd: '10:00' }).sleepStart, '23:00');
});
test('sleep is inclusive at 23:00 and releases at 10:00 in the local timezone', () => {
  assert.equal(blockedUntil(local(7, 22, 59)), null);
  assert.equal(blockedUntil(local(7, 23)), local(8, 10));
  assert.equal(blockedUntil(local(8, 0)), local(8, 10));
  assert.equal(blockedUntil(local(8, 9, 59)), local(8, 10));
  assert.equal(blockedUntil(local(8, 10)), null);
  assert.equal(blockedUntil(local(7, 23), { sleepEnabled: false }), null);
});
test('configured daytime quiet hours and class boundaries extend across touching periods', () => {
  assert.equal(blockedUntil(local(7, 14), { sleepStart: '13:00', sleepEnd: '15:00' }), local(7, 15));
  const classes = [{ start: local(7, 10, 30), end: local(7, 12, 20) },
    { start: local(7, 12, 20), end: local(7, 13) }];
  assert.equal(blockedUntil(local(7, 10, 29), {}, classes), null);
  assert.equal(blockedUntil(local(7, 10, 30), {}, classes), local(7, 13));
  assert.equal(blockedUntil(local(7, 13), {}, classes), null);
  assert.equal(blockedUntil(local(7, 11), { classesEnabled: false }, classes), null);
  const overlap = [{ start: local(8, 9, 30), end: local(8, 12, 20) }];
  assert.equal(blockedUntil(local(7, 23), {}, overlap), local(8, 12, 20));
  assert.equal(blockedUntil(local(7, 22, 50), {}, [{ start: local(7, 22), end: local(8, 0) }]), local(8, 10));
});
test('sleep end uses wall-clock time across daylight-saving changes', () => {
  // In zones with DST this night can be 12 hours; the required release is still 10:00.
  const start = new Date(2026, 9, 31, 23).getTime();
  assert.equal(blockedUntil(start), new Date(2026, 10, 1, 10).getTime());
});
