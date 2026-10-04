'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quota-core');
const now = Date.parse('2026-10-03T23:00:00Z');

test('Claude percentages are consumed quota, context is ignored, resets are per window', () => {
  const q = Q.screen('Claude', '', ['Context: 99% | Session: 81% | Reset: 2hr 10m', 'Weekly: 9% | Reset: 3d 10hr'], now);
  assert.deepEqual(q.windows.map((w) => [w.label, w.remaining, w.resetAt]), [['5 小时', 19, now + 7800000], ['每周', 91, now + 295200000]]);
  const lone = Q.screen('Claude', '', ['Session: 26%', 'Weekly Reset: 16hr'], now);
  assert.equal(lone.windows[0].resetAt, null);
  assert.equal(Q.screen('Claude', 'The response discusses Session: 90% and Weekly: 90%.', [], now).windows.length, 0);
  assert.equal(Q.screen('Claude', '', ['Context: 99%'], now).windows.length, 0);
  assert.deepEqual(Q.screen('Claude', '', ['Opus 5.5 · context 20%   5h 17% · 7d 2%'], now).windows.map((w) => w.remaining), [83, 98]);
});

test('Claude /usage and Codex /status accept explicit used/left semantics', () => {
  const claude = Q.screen('Claude', 'Current session\n████\n22% used\nResets in 2h\nCurrent week (all models)\n██\n3% used\nResets in 3d\n', [], now);
  assert.deepEqual(claude.windows.map((w) => w.remaining), [78, 97]);
  const codex = Q.screen('Codex', '│ 5-hour limit: [████] 8% left (resets 23:59)\n│ Weekly limit: 60% left (resets 2026-10-07T10:00:00Z)\nContext: 95%\n', [], now);
  assert.deepEqual(codex.windows.map((w) => w.remaining), [8, 60]);
  assert.equal(codex.windows[1].resetAt, Date.parse('2026-10-07T10:00:00Z'));
});

test('local cache adapters keep only valid known quota windows', () => {
  assert.equal(Q.cacheClaude({ sessionUsage: -1, weeklyUsage: 1900000000 }, now), null);
  const q = Q.cacheCodex({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 24, window_minutes: 10080, resets_at: 1791580221 }, secondary: null }, secret: 'never return this' } });
  assert.deepEqual(q.windows.map((w) => [w.label, w.remaining]), [['每周', 76]]);
  assert.ok(!JSON.stringify(q).includes('secret'));
  assert.equal(Q.cacheCodex({ type: 'event_msg', payload: { type: 'token_count' } }), null);
  assert.equal(Q.cacheCodex({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count', rate_limits: { limit_id: 'review', primary: { used_percent: 24, window_minutes: 300 } } } }), null);
});

test('agy optional quota snapshot keeps Gemini and third-party windows distinct and drops identity fields', () => {
  const q = Q.cacheAntigravity({ email: 'never-return', quota: {
    'gemini-5h': { remaining_fraction: 0.2304688, reset_time: '2026-10-04T01:21:09Z' },
    'gemini-weekly': { remaining_fraction: 0.15764906, reset_time: '2026-10-05T22:09:10Z' },
    '3p-5h': { remaining_fraction: 0.9230664 },
    '3p-weekly': { remaining_fraction: 2 },
  } }, now);
  assert.deepEqual(q.windows.map((w) => [w.label, w.remaining]), [['Gemini 5 小时', 23], ['Gemini 每周', 15.8], ['第三方 5 小时', 92.3]]);
  assert.ok(!JSON.stringify(q).includes('never-return'));
  assert.equal(Q.cacheAntigravity({ quota: { 'gemini-5h': { remaining_fraction: '0.25' } } }, now), null);
});

test('zero remains exhausted beyond sample freshness until reset; fresh positive numbers can clear a numeric latch', () => {
  const store = {};
  Q.observe(store, Q.cacheClaude({ sessionUsage: 100, sessionResetAt: new Date(now + 3600000).toISOString() }, now), now);
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 1).label, '已用尽');
  assert.equal(Q.summary(store, 'Claude', now + 3600001).label, '未知');
  Q.observe(store, Q.cacheClaude({ sessionUsage: 10 }, now + Q.FRESH_MS + 2), now + Q.FRESH_MS + 2);
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 2).label, '90%');
  Q.observe(store, Q.cacheClaude({ sessionUsage: 99.99 }, now + Q.FRESH_MS + 3), now + Q.FRESH_MS + 3);
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 3).label, '<0.1%');
});

test('every provider exhaustion latches until reset, not cleared by another normal session', () => {
  for (const [provider, message] of [['Claude', "You've hit your limit · resets in 2h"], ['Codex', 'You have hit your usage limit. Try again in 2h.'], ['Cursor', 'Error: You have exceeded your usage limit. Resets in 2h'], ['Antigravity', 'Individual quota reached\nResets in 2h 30m']]) {
    const store = {};
    Q.observe(store, Q.screen(provider, message, [], now), now);
    assert.equal(Q.summary(store, provider, now).label, '已用尽', provider);
    assert.ok(store[provider].blocked.resetAt > now, provider);
    Q.observe(store, Q.screen(provider, 'Welcome', [], now + 1), now + 1);
    assert.equal(Q.summary(store, provider, now + 1).label, '已用尽');
    assert.equal(Q.summary(JSON.parse(JSON.stringify(store)), provider, now + 3 * 3600000).label, '未知');
  }
});

test('no reset is invented; unknown exhaustion needs an explicit resume', () => {
  const store = {};
  Q.observe(store, Q.screen('Cursor', 'Usage limit reached. Resets at secret-token', [], now), now);
  assert.equal(store.Cursor.blocked.resetText, '');
  assert.equal(Q.summary(store, 'Cursor', now + 86400000).label, '已用尽');
  Q.observe(store, Q.screen('Cursor', 'Usage limit reset', [], now + 86400000), now + 86400000);
  assert.equal(Q.summary(store, 'Cursor', now + 86400000).label, '正常');
  assert.equal(Q.screen('Cursor', 'Please handle the error Individual quota reached in code.', [], now).exhausted, false);
  assert.equal(Q.screen('Cursor', 'Agent-store quota exceeded: file write failed', [], now).exhausted, false);
  assert.equal(Q.resetTime('8pm (America/Los_Angeles)', now), Date.parse('2026-10-04T03:00:00Z'));
  assert.equal(Q.resetTime('8pm (Invalid/Zone)', now), null);
  const clock = Q.screen('Claude', "You've hit your limit · resets 8pm (America/Los_Angeles)", [], now);
  assert.equal(clock.resetAt, Date.parse('2026-10-04T03:00:00Z'));
});

test('fresh screen numbers win; stale samples and reset windows become unknown without inventing 100%', () => {
  const store = {};
  Q.observe(store, Q.screen('Claude', '', ['Session: 81%'], now), now);
  Q.observe(store, Q.cacheClaude({ sessionUsage: 10 }, now + 1), now + 1);
  assert.equal(Q.summary(store, 'Claude', now + 1).label, '19%');
  assert.equal(Q.summary(store, 'Claude', now).state, 'warning');
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 1).label, '未知');
  assert.equal(Q.observe(store, Q.cacheClaude({ sessionUsage: 1 }, now), now + Q.FRESH_MS + 1), false);
  Q.observe(store, Q.cacheClaude({ sessionUsage: 95, sessionResetAt: new Date(now + Q.FRESH_MS + 100).toISOString() }, now + Q.FRESH_MS + 2), now + Q.FRESH_MS + 2);
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 2).state, 'danger');
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 101).label, '未知');
  assert.equal(Q.text(store, now).split('\n').length, 4);
});
