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

test('agy snapshot uses only Gemini windows even when Claude is exhausted', () => {
  const q = Q.cacheAntigravity({ email: 'never-return', quota: {
    'gemini-5h': { remaining_fraction: 0.2304688, reset_time: '2026-10-04T01:21:09Z' },
    'gemini-weekly': { remaining_fraction: 0.15764906, reset_time: '2026-10-05T22:09:10Z' },
    '3p-5h': { remaining_fraction: 0 },
    '3p-weekly': { remaining_fraction: 2 },
  } }, now);
  assert.deepEqual(q.windows.map((w) => [w.label, w.remaining]), [['Gemini 5 小时', 23], ['Gemini 每周', 15.8]]);
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
    Q.observe(store, Q.screen(provider, message, [], now, provider === 'Cursor' ? 'grok-4.7-high-fast' : 'gemini-3.8-flash-high'), now);
    assert.equal(Q.summary(store, provider, now).label, '已用尽', provider);
    assert.ok(store[provider].blocked.resetAt > now, provider);
    Q.observe(store, Q.screen(provider, 'Welcome', [], now + 1, provider === 'Cursor' ? 'grok-4.7-high-fast' : 'gemini-3.8-flash-high'), now + 1);
    assert.equal(Q.summary(store, provider, now + 1).label, '已用尽');
    assert.equal(Q.summary(JSON.parse(JSON.stringify(store)), provider, now + 3 * 3600000).label, provider === 'Claude' ? '未知' : '未知');
  }
});

test('no reset is invented; unknown exhaustion needs an explicit resume', () => {
  const store = {};
  Q.observe(store, Q.screen('Cursor', 'Usage limit reached. Resets at secret-token', [], now, 'grok-4.7-high-fast'), now);
  assert.equal(store.Cursor.blocked.resetText, '');
  assert.equal(Q.summary(store, 'Cursor', now + 86400000).label, '已用尽');
  Q.observe(store, Q.screen('Cursor', 'Usage limit reset', [], now + 86400000, 'grok-4.7-high-fast'), now + 86400000);
  assert.equal(Q.summary(store, 'Cursor', now + 86400000).label, '正常');
  assert.equal(Q.screen('Cursor', 'Please handle the error Individual quota reached in code.', [], now, 'grok-4.7-high-fast').exhausted, false);
  assert.equal(Q.screen('Cursor', 'Agent-store quota exceeded: file write failed', [], now, 'grok-4.7-high-fast').exhausted, false);
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

test('selected model scopes reject unrelated limits and retire old provider-wide blocks', () => {
  const store = { Antigravity: { blocked: { at: now, resetAt: now + 3600000 } } };
  assert.equal(Q.summary(store, 'Antigravity', now).label, '未知');
  for (const provider of ['Cursor', 'Antigravity']) {
    assert.equal(Q.screen(provider, 'Usage limit reached', [], now, 'claude-opus-5-5-high'), null);
    assert.equal(Q.screen(provider, 'Usage limit reached', [], now), null);
  }
  Q.observe(store, Q.cacheAntigravity({ quota: { 'gemini-5h': { remaining_fraction: 0.75 }, '3p-5h': { remaining_fraction: 0 } } }, now), now);
  assert.equal(Q.summary(store, 'Antigravity', now).label, '75%');
  const model = 'grok-4.7-high-fast';
  Q.observe(store, { ...Q.screen('Cursor', 'Usage limit reached', [], now, model), accountKey: 'first', account: 'aa***@example.com' }, now);
  assert.equal(Q.summary(store, 'Cursor', now).label, '已用尽');
  Q.observe(store, { provider: 'Cursor', scope: 'grok-4.7', at: now + 1, identityOnly: true, accountKey: 'second', account: 'bb***@example.com' }, now + 1);
  assert.equal(Q.summary(store, 'Cursor', now + 1).label, '未知');
  assert.match(Q.summary(store, 'Cursor', now + 1).detail, /Grok 4.7.*bb\*\*\*@example.com/);
});

test('official Codex RPC distinguishes 5h/weekly durations and never borrows other buckets', () => {
  const weekly = { limitId: 'codex', primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: now / 1000 + 3600 } };
  const q = Q.codexServer({ rateLimits: weekly }, now);
  assert.deepEqual(q.windows.map(w => [w.label, w.remaining]), [['每周', 72]]);
  assert.match(q.note, /服务端未提供/);
  const both = Q.codexServer({ rateLimits: { limitId: 'review' }, rateLimitsByLimitId: { codex: { ...weekly, secondary: { usedPercent: 10, windowDurationMins: 300 } }, review: { primary: { usedPercent: 100, windowDurationMins: 300 } } } }, now);
  assert.deepEqual(both.windows.map(w => [w.label, w.remaining]), [['每周', 72], ['5 小时', 90]]);
  assert.equal(Q.codexServer({ rateLimits: { limitId: 'review', primary: { usedPercent: 100, windowDurationMins: 300 } } }, now), null);
});

test('old error above a model switch does not exhaust the newly selected pool', () => {
  const q = Q.screen('Cursor', 'Model: claude-opus-5-5-high\nUsage limit reached\nSwitched model to grok-4.7-high-fast\nModel: grok-4.7-high-fast', [], now, 'grok-4.7-high-fast');
  assert.equal(q.exhausted, false);
  const agy = Q.cacheAntigravity({ model: { id: 'Gemini 3.8 Flash (Medium)' }, quota: { 'gemini-5h': { remaining_fraction: 0.8 } } }, now);
  assert.equal(agy.model, 'Gemini 3.8 Flash (Medium)');
});

test('Claude seats isolate percentages and exhaustion; missing/stale windows stay explicitly unavailable', () => {
  const seats = Q.claudeSeats([{ id: 'east', name: '东席', configDir: '~/.claude' }, { id: 'west', name: '西席', configDir: '~/.claude-west' }]);
  const store = {};
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 20, weeklyUsage: 30 }, now), seatId: 'east', configDir: '~/.claude', accountBound: true, accountKey: 'east-account' }, now);
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 100, sessionResetAt: new Date(now + 3600000).toISOString() }, now), seatId: 'west', configDir: '~/.claude-west', accountBound: true, accountKey: 'west-account' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[0], 'east').displayLabel, '5h 80% · 7d 70%');
  assert.match(Q.summary(store, 'Claude', now, seats[0], 'east').detail, /当前队长使用此席位/);
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).label, '已用尽');
  assert.equal(store['Claude:west'].blocked.accountBound, true);
  assert.equal(store['Claude:west'].blocked.accountKey, 'west-account');
  assert.equal(store['Claude:west'].blocked.configDir, '~/.claude-west');
  assert.match(Q.summary(store, 'Claude', now, seats[1]).detail, /每周：未知/);
  assert.equal(Q.summary(store, 'Claude', now + Q.FRESH_MS + 1, seats[0]).label, '未知');
  assert.equal(Q.summary(store, 'Claude', now, { ...seats[0], configDir: '~/.different' }).label, '未知');
  assert.equal(Q.text(store, now, seats).split('\n').length, 5);
  assert.equal(Q.claudeSeats()[0].configDir, '~/.claude');
  assert.equal(Q.claudeSeats().length, 1);
  assert.deepEqual(Q.claudeSeats([{ id: 'us', name: 'US', configDir: '~/.custom-us' }, { id: 'cn', name: '🇨🇳 CN', configDir: '~/.custom-cn' }]).map(s => [s.id, s.name, s.configDir]), [['us', '🇺🇸 US', '~/.custom-us'], ['cn', '🇨🇳 CN', '~/.custom-cn']]);
  assert.equal(Q.seatForColumn({ claudeSeatId: 'west' }, seats).id, 'west');
  assert.equal(Q.seatForColumn({ cmd: 'CLAUDE_CONFIG_DIR="~/.claude-west" claude' }, seats).id, 'west');
  assert.equal(Q.seatForColumn({ claudeSeatId: 'unknown' }, seats), null);
});


test('a fresh numeric cache replaces a newer screen without quota numbers', () => {
  const store = {};
  Q.observe(store, Q.screen('Claude', 'Claude Code', [], now), now);
  Q.observe(store, Q.cacheClaude({ sessionUsage: 46, weeklyUsage: 5 }, now - 60000), now);
  assert.equal(Q.summary(store, 'Claude', now).displayLabel, '5h 54% · 7d 95%');
  // A subsequent redraw without numbers must keep the known fresh windows.
  Q.observe(store, Q.screen('Claude', 'Claude Code', [], now + 1000), now + 1000);
  assert.equal(Q.summary(store, 'Claude', now + 1000).displayLabel, '5h 54% · 7d 95%');
});


test('configured Claude seats discard shared screen numbers and persisted unbound samples in all summaries', () => {
  const seats = Q.claudeSeats([{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }]), store = {};
  const shared = Q.screen('Claude', 'Claude Code', ['Session: 47% | Weekly: 45%'], now);
  for (const seat of seats) Q.observe(store, { ...shared, seatId: seat.id, configDir: seat.configDir }, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[0]).label, '未知');
  // Migration must reject data written by an older AgentDeck as well.
  store['Claude:cn'].sample = { ...shared, windows: [{ label: '5 小时', remaining: 53 }], configDir: '~/.claude', at: now };
  assert.doesNotMatch(Q.text(store, now, seats), /剩余 53/);
  Q.observe(store, { ...shared, seatId: 'cn', configDir: '~/.claude', exhausted: true, resetText: '9:20 PM', resetAt: now + 3600000, sourceColumnId: 'cn-captain' }, now);
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 47, weeklyUsage: 45 }, now - 1000), seatId: 'us', configDir: '~/.claude-us', accountBound: true, accountKey: 'us-account' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).displayLabel, '5h 53% · 7d 55%');
  const cn = Q.summary(store, 'Claude', now, seats[0]);
  assert.equal(cn.label, '已用尽');
  assert.match(cn.detail, /恢复/);
  assert.match(cn.detail, /报错会话：cn-captain/);
  assert.doesNotMatch(cn.detail, /剩余 53|剩余 55/);
  assert.match(Q.text(store, now, seats), /Claude \/ 🇨🇳 CN：已用尽/);
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 20 }, now), seatId: 'cn', configDir: '~/.claude', accountBound: true, accountKey: 'cn-account' }, now);
  assert.match(Q.summary(store, 'Claude', now, seats[0]).detail, /5 小时剩余 80/);
});


test('account ID migration retains genuine exhaustion but never promotes legacy numbers', () => {
  const seat = { id: 'cn', configDir: '~/.claude' }, store = { 'Claude:cn': { scope: 'claude', configDir: seat.configDir, accountKey: 'old-email-key', blocked: { at: now, resetAt: now + 3600000, source: '会话屏幕', accountKey: 'old-email-key' }, sample: { at: now, windows: [{ label: '5 小时', remaining: 53 }] } } };
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: seat.configDir, identityOnly: true, at: now, accountKey: 'account-id-key', legacyAccountKey: 'old-email-key' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seat).label, '已用尽');
  assert.equal(store['Claude:cn'].blocked.accountKey, 'account-id-key');
  assert.doesNotMatch(Q.summary(store, 'Claude', now, seat).detail, /剩余 53/);
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: seat.configDir, identityOnly: true, at: now, accountKey: 'other-account-id', legacyAccountKey: 'old-email-key' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seat).label, '未知');
});

test('native rate limit errors latch quota, quoted mentions do not', () => {
  for (const text of ['API Error: 429 rate_limit_error: Too many requests', 'Rate limit reached. Resets in 1h']) {
    assert.equal(Q.screen('Claude', text, [], Date.now()).exhausted, true);
  }
  assert.equal(Q.screen('Claude', 'The report mentions rate_limit errors.', [], Date.now()).exhausted, false);
});

test('explicit recovery survives retaining the older fresh numeric sample', () => {
  const store = {}, owner = { seatId: 'cn', configDir: '~/.claude', accountKey: 'cn-account', sourceColumnId: 'captain-cn' };
  const numeric = { ...Q.cacheClaude({ sessionUsage: 20 }, now), ...owner, accountBound: true };
  Q.observe(store, numeric, now);
  Q.observe(store, { ...Q.screen('Claude', 'Usage limit reached', [], now + 1), ...owner }, now + 1);
  assert.equal(store['Claude:cn'].blocked.at, now + 1);
  Q.observe(store, { ...Q.screen('Claude', 'Usage limit reset', [], now + 2), ...owner }, now + 2);
  const saved = store['Claude:cn'];
  assert.deepEqual(saved.sample, numeric);
  assert.equal(saved.blocked, undefined);
  assert.deepEqual(saved.resumed, { at: now + 2, sourceColumnId: owner.sourceColumnId, accountKey: owner.accountKey, configDir: owner.configDir, source: '会话屏幕', accountBound: false });
  Q.observe(store, { provider: 'Claude', scope: 'claude', ...owner, identityOnly: true, at: now + 3, accountKey: 'other-account' }, now + 3);
  assert.equal(store['Claude:cn'].resumed, undefined);
});
