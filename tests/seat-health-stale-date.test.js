'use strict';
// Bug hunt ④ #18 (2.0.4 features, 席位状态颜色): QuotaCore.seatHealth says when a yellow 数据已旧 seat's numbers
// stopped: 「额度数字停在 HH:MM」. Its clock() adds the date only for a time more than a day *ahead*
// (written for the recovery time), so a sample from three days ago reads 「停在 14:05」, which on the
// desktop's detail row, the phone's state line and 队长's `quota` text means "today at 14:05". The
// numbers look a few hours old when they are days old. A spare seat nobody used for a while, or one
// whose queries kept failing, is exactly the seat that shows this.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quota-core');

const pad = (v) => String(v).padStart(2, '0');

test('数据已旧 names the day when the numbers stopped on an earlier day', () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime();
  const sampledAt = new Date(2026, 9, 6, 14, 5).getTime();
  const h = Q.seatHealth({ seat: null, stale: true, failures: 3, sampledAt }, now);
  assert.equal(h.kind, 'stale');
  assert.match(h.reason, /10-06 14:05/, h.reason);
});

test('control: numbers that stopped earlier today keep the short time', () => {
  const now = new Date(2026, 9, 9, 15, 0).getTime();
  const h = Q.seatHealth({ seat: null, stale: true, sampledAt: new Date(2026, 9, 9, 14, 5).getTime() }, now);
  assert.match(h.reason, /停在 14:05/, h.reason);
});
