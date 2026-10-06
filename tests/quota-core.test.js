'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../quota-core');
const now = Date.parse('2026-10-03T23:00:00Z');

test('Cursor monthly billing errors recognize the native unpunctuated suffix without matching narration', () => {
  // Native wording from saved Cursor errors; account-specific amount replaced.
  const sample = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/cursor-monthly-limit.txt'), 'utf8').trim();
  const brief = sample.split(' fallbackModel:')[0];
  for (const line of [sample, brief, sample.replace('usage limit You', 'usage limit for Opus You')]) {
    for (const decorated of [line, '● ' + line, '│ ' + line + ' │']) {
      assert.equal(Q.resourceError(decorated), 'quota');
      assert.equal(Q.screen('Cursor', decorated, [], now, 'grok-4.7').exhausted, true);
    }
  }
  for (const line of [sample + ' fixed', brief + ' 的识别已补测试', brief + ' regression test added',
    'The error was ' + sample, 'Error: You\'ve hit your usage limit handling test failed',
    brief.replace('hit your usage limit', 'used 80% of your usage limit')]) {
    assert.equal(Q.resourceError(line), '', line);
  }
});

test('Claude Session/Weekly percentages are used; compact footers are remaining, context is ignored, resets are per window', () => {
  const q = Q.screen('Claude', '', ['Context: 99% | Session: 81% | Reset: 2hr 10m', 'Weekly: 9% | Reset: 3d 10hr'], now);
  assert.deepEqual(q.windows.map((w) => [w.label, w.remaining, w.resetAt]), [['5 小时', 19, now + 7800000], ['每周', 91, now + 295200000]]);
  const lone = Q.screen('Claude', '', ['Session: 26%', 'Weekly Reset: 16hr'], now);
  assert.equal(lone.windows[0].resetAt, null);
  assert.equal(Q.screen('Claude', 'The response discusses Session: 90% and Weekly: 90%.', [], now).windows.length, 0);
  assert.equal(Q.screen('Claude', '', ['Context: 99%'], now).windows.length, 0);
  assert.deepEqual(Q.screen('Claude', '', ['Opus 5.5 · context 20%   5h 17% · 7d 2%'], now).windows.map((w) => w.remaining), [17, 2]);
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
  assert.equal(Q.summary(store, 'Claude', now, seats[0], 'east').displayLabel, '5h 80% ↻未知 · 7d 70% ↻未知');
  assert.match(Q.summary(store, 'Claude', now, seats[0], 'east').detail, /当前队长使用此席位/);
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).label, '已用尽');
  assert.match(Q.summary(store, 'Claude', now, seats[1]).detail, /7d 无数据/);
  assert.equal(store['Claude:west'].blocked.accountBound, true);
  assert.equal(store['Claude:west'].blocked.accountKey, 'west-account');
  assert.equal(store['Claude:west'].blocked.configDir, '~/.claude-west');

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
  assert.equal(Q.summary(store, 'Claude', now).displayLabel, '5h 54% ↻未知 · 7d 95% ↻未知');
  // A subsequent redraw without numbers must keep the known fresh windows.
  Q.observe(store, Q.screen('Claude', 'Claude Code', [], now + 1000), now + 1000);
  assert.equal(Q.summary(store, 'Claude', now + 1000).displayLabel, '5h 54% ↻未知 · 7d 95% ↻未知');
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
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).displayLabel, '5h 53% ↻未知 · 7d 55% ↻未知');
  const cn = Q.summary(store, 'Claude', now, seats[0]);
  assert.equal(cn.label, '已用尽');
  assert.match(cn.detail, /已用尽 ↻/);
  assert.match(cn.detail, /报错会话：cn-captain/);
  assert.doesNotMatch(cn.detail, /剩余 53|剩余 55/);
  assert.match(Q.text(store, now, seats), /Claude \/ 🇨🇳 CN：已用尽/);
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 20 }, now), seatId: 'cn', configDir: '~/.claude', accountBound: true, accountKey: 'cn-account' }, now);
  assert.match(Q.summary(store, 'Claude', now, seats[0]).detail, /5h 80% ↻/);
});


test('account ID migration retains genuine exhaustion but never promotes legacy numbers', () => {
  const seat = { id: 'cn', configDir: '~/.claude' }, store = { 'Claude:cn': { scope: 'claude', configDir: seat.configDir, accountKey: 'old-email-key', blocked: { at: now, resetAt: now + 3600000, source: '会话屏幕' }, sample: { at: now, windows: [{ label: '5 小时', remaining: 53 }] } } };
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: seat.configDir, identityOnly: true, at: now, accountKey: 'account-id-key', legacyAccountKey: 'old-email-key' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seat).label, '已用尽');
  assert.doesNotMatch(Q.summary(store, 'Claude', now, seat).detail, /剩余 53/);
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: seat.configDir, identityOnly: true, at: now, accountKey: 'other-account-id', legacyAccountKey: 'old-email-key' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seat).label, '未知');
});

test('exhaustion binds to the erroring session seat and clears itself after its reset time', () => {
  const seats = Q.claudeSeats([{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }]), store = {};
  const column = { claudeSeatId: 'us', claudeConfigDir: '~/.claude-us' };
  const seat = Q.seatForColumn(column, seats);
  const error = Q.screen('Claude', "You've hit your session limit · resets in 2h", [], now);
  Q.observe(store, { ...error, seatId: seat.id, configDir: seat.configDir, sourceColumnId: 'us-captain' }, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).label, '已用尽');
  assert.match(Q.summary(store, 'Claude', now, seats[1]).detail, /报错会话：us-captain/);
  assert.equal(Q.summary(store, 'Claude', now, seats[0]).label, '未知');
  // A column whose pinned directory no longer matches the seat cannot exhaust it.
  assert.equal(Q.seatForColumn({ claudeSeatId: 'cn', claudeConfigDir: '~/.claude-old' }, seats), null);
  const later = now + 2 * 3600000 + 1;
  assert.equal(Q.summary(store, 'Claude', later, seats[1]).label, '未知');
  assert.doesNotMatch(Q.text(store, later, seats), /已用尽/);
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'us', configDir: '~/.claude-us', identityOnly: true, at: later }, later);
  assert.equal(store['Claude:us'].blocked, undefined);
});

test('compact Claude footers retain remaining semantics and local reset clocks; explicit used footers stay unknown', () => {
  const fiveHour = new Date(now + 2 * 3600000), weekly = new Date(now + 4 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const q = Q.screen('Claude', '', [`5h 91% ↻${clock(fiveHour)} · 7d 90% ↻${pad(weekly.getMonth() + 1)}-${pad(weekly.getDate())} ${clock(weekly)}`], now);
  assert.deepEqual(q.windows.map((w) => [w.used, w.remaining, w.resetAt]), [[9, 91, fiveHour.getTime()], [10, 90, weekly.getTime()]]);
  for (const remaining of [0, 2, 17, 91, 100]) {
    const w = Q.screen('Claude', '', [`5h ${remaining}%`], now).windows[0];
    assert.equal(w.remaining, remaining);
    assert.equal(w.exhausted, remaining === 0);
  }
  assert.equal(Q.screen('Claude', '', ['5h 9% used · 7d已用 10%'], now).windows.length, 0);
  assert.deepEqual(Q.screen('Claude', '', ['5h剩余 91% · 7d remaining 90%'], now).windows.map((w) => w.remaining), [91, 90]);
});

test('official success overrides a recent bound screen and supplies the reset for a genuine unknown-reset error', () => {
  const seat = { id: 'cn', configDir: '~/.claude' }, store = {};
  const bind = (q) => ({ ...q, seatId: seat.id, configDir: seat.configDir, accountBound: true, accountKey: 'offline-cn' });
  Q.observe(store, bind(Q.screen('Claude', '', ['5h 17% · 7d 2%'], now)), now);
  const api = bind(Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'fiveHour', remaining: 91, resetText: new Date(now + 3600000).toISOString() }, { key: 'weekly', remaining: 90 }] }, now + 1));
  Q.observe(store, api, now + 1);
  assert.equal(store[Q.seatKey(seat.id)].sample.official, true);
  assert.match(Q.summary(store, 'Claude', now + 1, seat).displayLabel, /5h 91% ↻.*7d 90%/);
  Q.observe(store, bind(Q.screen('Claude', 'Usage limit reached', [], now + 2)), now + 2);
  assert.equal(store[Q.seatKey(seat.id)].blocked.resetAt, now + 3600000);
  const priorError = {};
  Q.observe(priorError, bind(Q.screen('Claude', 'Usage limit reached', [], now)), now);
  Q.observe(priorError, api, now + 1);
  // The newer official sample has room in both windows, so the older error is cleared.
  assert.equal(priorError[Q.seatKey(seat.id)].blocked, undefined);
  assert.equal(Q.summary(priorError, 'Claude', now + 1, seat).state, 'normal');
});

test('a newer official sample with room clears an older screen error; a newer 0% sample stays exhausted', () => {
  const seats = Q.claudeSeats([{ id: 'us', configDir: '~/.claude-us' }, { id: 'cn', configDir: '~/.claude-cn' }]), store = {};
  const official = (seat, at, five, week) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: five, resetText: new Date(now + 2 * 3600000).toISOString() },
    { key: 'weekly', remaining: week, resetText: new Date(now + 5 * 86400000).toISOString() }] }, at),
    seatId: seat.id, configDir: seat.configDir, accountBound: true, accountKey: `${seat.id}-account`, credentialKey: `${seat.id}-cred` });
  const error = (seat, at) => ({ ...Q.screen('Claude', "You've hit your limit", [], at), seatId: seat.id, configDir: seat.configDir, sourceColumnId: `${seat.id}-col` });
  for (const seat of seats) {
    Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: seat.id, at: now - 11 * 60000, identityOnly: true, configDir: seat.configDir, accountKey: `${seat.id}-account`, credentialKey: `${seat.id}-cred` }, now);
    Q.observe(store, error(seat, now - 10 * 60000), now);
    assert.equal(Q.summary(store, 'Claude', now, seat).state, 'exhausted');
  }
  // Stored state from an older build already holds the stale error next to the newer sample.
  const persisted = JSON.parse(JSON.stringify(store));
  Q.observe(store, official(seats[0], now, 93, 48), now);
  Q.observe(store, official(seats[1], now, 0, 82), now);
  const us = Q.summary(store, 'Claude', now, seats[0]), cn = Q.summary(store, 'Claude', now, seats[1]);
  assert.equal(store['Claude:us'].blocked, undefined);
  assert.equal(us.state, 'normal');
  assert.deepEqual([us.fiveHour, us.weekly], [93, 48]);
  assert.equal(cn.state, 'exhausted');
  assert.equal(cn.recoveryAt, now + 2 * 3600000);
  const text = Q.text(store, now, seats);
  assert.doesNotMatch(text.split('\n')[0], /已用尽/);
  assert.match(text.split('\n')[1], /已用尽/);
  // Summary applies the same rule to a persisted error that observe never cleared.
  persisted['Claude:us'].sample = official(seats[0], now, 93, 48);
  assert.equal(Q.summary(persisted, 'Claude', now, seats[0]).state, 'normal');
  // An error after the official sample is newer and still counts.
  Q.observe(store, error(seats[0], now + 1000), now + 1000);
  assert.equal(Q.summary(store, 'Claude', now + 1000, seats[0]).state, 'exhausted');
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
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).displayLabel, '5h 53% ↻未知 · 7d 55% ↻未知');
  const cn = Q.summary(store, 'Claude', now, seats[0]);
  assert.equal(cn.label, '已用尽');
  assert.match(cn.detail, /已用尽 ↻/);
  assert.match(cn.detail, /报错会话：cn-captain/);
  assert.doesNotMatch(cn.detail, /剩余 53|剩余 55/);
  assert.match(Q.text(store, now, seats), /Claude \/ 🇨🇳 CN：已用尽/);
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 20 }, now), seatId: 'cn', configDir: '~/.claude', accountBound: true, accountKey: 'cn-account' }, now);
  const retained = Q.summary(store, 'Claude', now, seats[0]);
  assert.equal(retained.label, '已用尽');
  assert.match(retained.detail, /上次采样：5h 80%/);
  assert.match(retained.detail, /报错会话：cn-captain/);
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

test('official slot samples survive first identity observation but older samples are rejected after a saved identity change', () => {
  const seat = { id: 'cn', configDir: '/home/test/.claude' }, store = {};
  const sample = { provider: 'Claude', scope: 'claude', seatId: seat.id, configDir: seat.configDir,
    at: now, official: true, credentialKey: 'cn-slot',
    windows: [{ key: 'fiveHour', label: '5 小时', used: 20, remaining: 80, resetAt: now + 3600000 }] };
  Q.observe(store, sample, now);
  Q.observe(store, { ...sample, identityOnly: true, official: false, at: now + 1, accountKey: 'first-account' }, now + 1);
  assert.equal(Q.summary(store, 'Claude', now + 1, seat).label, '80%');
  assert.equal(store['Claude:cn'].officialNotBefore, undefined);
  Q.observe(store, { ...sample, identityOnly: true, official: false, at: now + 2, accountKey: 'second-account' }, now + 2);
  const restored = JSON.parse(JSON.stringify(store));
  assert.equal(restored['Claude:cn'].officialNotBefore, now + 2);
  assert.equal(Q.observe(restored, sample, now + 2), false);
  assert.equal(Q.summary(restored, 'Claude', now + 2, seat).label, '未知');
  Q.observe(restored, { ...sample, at: now + 3 }, now + 3);
  assert.equal(Q.summary(restored, 'Claude', now + 3, seat).label, '80%');
});

test('any exhausted window (5-hour or weekly) shows exhausted with the recovery time for Gemini, ChatGPT and Claude', () => {
  const store = {}, hour = 3600000;
  Q.observe(store, Q.cacheAntigravity({ model: 'gemini-3.8-flash-high', quota: {
    'gemini-5h': { remaining_fraction: 0.975, reset_time: new Date(now + 3 * hour).toISOString() },
    'gemini-weekly': { remaining_fraction: 0, reset_time: new Date(now + 40 * hour).toISOString() } } }, now), now);
  const gemini = Q.summary(store, 'Antigravity', now);
  assert.deepEqual([gemini.out, gemini.statusText, gemini.fiveHour, gemini.recoveryAt], [true, '已用尽', 97.5, now + 40 * hour]);
  // ChatGPT weekly rounded to 0% without the server's exhausted flag still counts as used up.
  Q.observe(store, Q.codexServer({ rateLimits: { limitId: 'codex',
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.round((now + 2 * hour) / 1000) },
    secondary: { usedPercent: 99.97, windowDurationMins: 10080, resetsAt: Math.round((now + 50 * hour) / 1000) } } }, now), now);
  const codex = Q.summary(store, 'Codex', now);
  assert.deepEqual([codex.out, codex.fiveHour, codex.recoveryAt], [true, 88, now + 50 * hour]);
  const seat = { id: 'us', name: '🇺🇸 US', configDir: '~/.claude-us' };
  Q.observe(store, { ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 64, resetText: new Date(now + hour).toISOString() },
    { key: 'weekly', remaining: 0, resetText: new Date(now + 30 * hour).toISOString() }] }, now),
    seatId: 'us', configDir: seat.configDir, accountBound: true, accountKey: 'us-account', credentialKey: 'us-cred' }, now);
  const claude = Q.summary(store, 'Claude', now, seat);
  assert.deepEqual([claude.out, claude.fiveHour, claude.recoveryAt], [true, 64, now + 30 * hour]);
  // Both windows with room: not exhausted, 5-hour % is shown.
  Q.observe(store, Q.codexServer({ rateLimits: { limitId: 'codex',
    primary: { usedPercent: 59, windowDurationMins: 300, resetsAt: Math.round((now + 2 * hour) / 1000) },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: Math.round((now + 50 * hour) / 1000) } } }, now + 1000), now + 1000);
  const ok = Q.summary(store, 'Codex', now + 1000);
  assert.deepEqual([ok.out, ok.fiveHour, ok.recoveryAt, ok.statusText], [false, 41, null, '正常']);
});

test('sidebar row value: 5-hour %, else weekly %, else 正常 when nothing is exhausted, else a distinct status word', () => {
  const weeklyOnly = {};
  Q.observe(weeklyOnly, Q.cacheCodex({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 85, window_minutes: 10080, resets_at: now / 1000 + 86400 }, secondary: null } } }), now);
  const codex = Q.summary(weeklyOnly, 'Codex', now);
  assert.deepEqual([codex.shortText, codex.shortRemaining, codex.fiveHour, codex.weekly, codex.out], ['周 15%', 15, null, 15, false]);
  assert.deepEqual(codex.cells.map((c) => c.key), ['7d']);
  const both = {};
  Q.observe(both, Q.screen('Codex', '│ 5-hour limit: [████] 8% left (resets 23:59)\n│ Weekly limit: 60% left (resets 2026-10-07T10:00:00Z)\n', [], now), now);
  assert.equal(Q.summary(both, 'Codex', now).shortText, '8%');
  const grok = {};
  Q.observe(grok, Q.screen('Cursor', 'Welcome', [], now, 'grok-4.7-high-fast'), now);
  const sampled = Q.summary(grok, 'Cursor', now);
  assert.deepEqual([sampled.shortText, sampled.shortRemaining, sampled.state], ['正常', null, 'normal']);
  assert.deepEqual(sampled.cells, []);
  // Missing and expired samples must not look like healthy or exhausted quota.
  assert.equal(Q.summary({}, 'Cursor', now).shortText, '未知');
  assert.equal(Q.summary({}, 'Codex', now).shortText, '未知');
  assert.equal(Q.summary(grok, 'Cursor', now + Q.FRESH_MS + 1).shortText, '过期');
  grok.Cursor.blocked = { at: now, source: '会话屏幕' };
  assert.equal(Q.summary(grok, 'Cursor', now).shortText, '已用尽');
  assert.equal(Q.summary(grok, 'Cursor', now + Q.FRESH_MS + 1).shortText, '已用尽');
  // Exhaustion with a known reset keeps the recovery time in the renderer.
  Q.observe(grok, Q.screen('Cursor', 'Error: You have exceeded your usage limit. Resets in 2h', [], now + 1, 'grok-4.7-high-fast'), now + 1);
  assert.equal(Q.summary(grok, 'Cursor', now + 1).out, true);
});

test('panel cells list only the windows a provider really has, with their own reset times', () => {
  const hour = 3600000, store = {};
  Q.observe(store, Q.screen('Claude', '', ['Session: 81% | Reset: 2hr', 'Weekly: 9% | Reset: 3d'], now), now);
  assert.deepEqual(Q.summary(store, 'Claude', now).cells, [
    { key: '5h', remaining: 19, out: false, resetAt: now + 2 * hour }, { key: '7d', remaining: 91, out: false, resetAt: now + 72 * hour }]);
  // Weekly-only: no 5h placeholder cell; the shared fallback still names it as weekly.
  Q.observe(store, Q.codexServer({ rateLimits: { limitId: 'codex', secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: Math.round((now + 50 * hour) / 1000) } } }, now), now);
  const weekly = Q.summary(store, 'Codex', now);
  assert.deepEqual(weekly.cells, [{ key: '7d', remaining: 70, out: false, resetAt: now + 50 * hour }]);
  assert.equal(weekly.shortText, '周 70%');
  // Status-only providers have no cells at all; the row shows 正常 / 已用尽 instead of a dash.
  Q.observe(store, Q.screen('Cursor', 'ready', [], now, 'grok-4.7'), now);
  const grok = Q.summary(store, 'Cursor', now);
  assert.deepEqual([grok.cells, grok.shortText, grok.state, grok.out], [[], '正常', 'normal', false]);
  Q.observe(store, Q.screen('Cursor', 'Usage limit reached. Resets in 3h', [], now + 1, 'grok-4.7'), now + 1);
  const out = Q.summary(store, 'Cursor', now + 1);
  assert.deepEqual([out.cells, out.out, out.recoveryAt], [[], true, now + 1 + 3 * hour]);
  // An exhausted 5h window is marked on its own cell and keeps the weekly cell readable.
  Q.observe(store, Q.screen('Claude', '', ['Session: 100% | Reset: 1hr', 'Weekly: 40% | Reset: 3d'], now + 2), now + 2);
  assert.deepEqual(Q.summary(store, 'Claude', now + 2).cells.map((c) => [c.key, c.out, c.remaining]), [['5h', true, 0], ['7d', false, 60]]);
});

test('opening gates use the selected provider and Claude seat, clear at reset and allow unknown observations', () => {
  const seats = [{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }];
  const store = { 'Claude:cn': { scope: 'claude', configDir: '~/.claude', blocked: { at: now, resetAt: now + 1000 } }, Antigravity: { scope: 'gemini', blocked: { at: now, resetAt: now + 1000 } } };
  assert.equal(Q.commandQuota(store, 'claude --model opus', seats, 'cn', now).out, true);
  assert.equal(Q.commandQuota(store, 'claude --model opus', seats, 'us', now).out, false);
  assert.equal(Q.commandQuota(store, 'claude', seats, 'cn', now + 1001).out, false);
  assert.equal(Q.commandQuota(store, 'agy --model gemini-3.8-flash-high', seats, 'cn', now).out, true);
  assert.equal(Q.commandQuota(store, 'agy --model gemini-3.8-flash-high', seats, 'cn', now + 1001).out, false);
  assert.equal(Q.commandQuota(store, 'codex', seats, 'cn', now).out, false);
  assert.equal(Q.commandQuota(store, 'cursor-agent --model grok-4.7-high-fast', seats, 'cn', now).out, false);
  assert.equal(Q.commandQuota(store, 'cursor-agent --model claude-opus-5-5', seats, 'cn', now), null);
  assert.equal(Q.commandQuota(store, 'agy --model claude-opus-5-5', seats, 'cn', now), null);
  assert.equal(Q.commandQuota(store, 'node fake-agent.js', seats, 'cn', now), null);
});

test('resourceError recognizes each CLI\'s native quota, rate-limit and login messages', () => {
  for (const [line, kind] of [
    // Claude
    ["You've hit your session limit · resets 9:20pm", 'quota'], ['Usage limit reached · limit resets 3:10pm', 'quota'],
    ["You've hit your limit ∙ resets 5pm", 'quota'], ['Claude AI usage limit reached|1760000000', 'quota'],
    ['5-hour limit reached ∙ resets 3pm', 'quota'], ['Opus weekly limit reached ∙ resets Mon 9am', 'quota'],
    ["⎿ You're out of extra usage · resets 3am", 'quota'], ['Credit balance is too low', 'quota'],
    ['Not logged in · Please run /login', 'auth'], ['Invalid API key · Please run /login', 'auth'],
    ['OAuth token has expired · Please run /login', 'auth'], ['API Error: 401 Unauthorized', 'auth'],
    // Codex
    ["You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:10 PM.", 'quota'],
    ["You've hit your usage limit. To get more access now, send a request to your admin or try again at 5pm.", 'quota'],
    ["■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2h", 'quota'],
    ['stream error: exceeded retry limit, last status: 429 Too Many Requests', 'rate_limit'], ['Not signed in. Run codex login', 'auth'],
    // Cursor
    ["Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.", 'auth'],
    ["Error: Not logged in. Please run 'cursor-agent login'", 'auth'], ["You've hit your usage limit for Grok 4.7", 'quota'],
    ['Authentication failed: token expired', 'auth'],
    // agy / Gemini
    ['Individual quota reached', 'quota'], ["Quota exceeded for quota metric 'Generate Content API requests per minute'", 'quota'],
    ['✕ [API Error: You have exhausted your capacity on this model. Your quota will reset after 2h.]', 'quota'],
    ['RESOURCE_EXHAUSTED: quota exhausted', 'quota'], ['Please log in to continue.', 'auth'],
    // shared
    ['Rate limited. Retrying in 5s…', 'rate_limit'], ['Rate limit reached. Resets in 1h', 'rate_limit'], ['429 Too many requests', 'rate_limit'],
  ]) {
    for (const decorated of [line, '⏺ ' + line, '│ ' + line + ' │']) assert.equal(Q.resourceError(decorated), kind, decorated);
  }
});

test('resourceError strips every TUI\'s leading glyph, including the Codex bullet', () => {
  for (const [line, kind] of [
    ['Not logged in · Please run /login', 'auth'], ['Usage limit reached · limit resets 3:10pm', 'quota'],
    ["You've hit your session limit · resets 9:20pm", 'quota'],
    ["You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:10 PM.", 'quota'],
    ["You've hit your usage limit. To get more access now, send a request to your admin or try again at 5pm.", 'quota'],
    ["Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.", 'auth'], ['Rate limit reached. Resets in 1h', 'rate_limit'],
  ]) {
    for (const glyph of ['•', '■', '⚠', '⚠️', '✗', '✘', '⏺', '⎿', '✻', '✳', '✶', '✢', '●', '◦', '◆', '⬢', '✦', '✕', '✖', 'ℹ', '│ •']) {
      assert.equal(Q.resourceError(glyph + ' ' + line), kind, glyph + ' ' + line);
    }
  }
  // the glyph alone never turns ordinary text into an error
  for (const line of ['• Rate limit handling test fails in api.js', '• RATE_LIMITED\\|function resourceError', '• 修复了 Usage limit reached 的识别', '• Ran npm test']) {
    assert.equal(Q.resourceError(line), '', line);
  }
});

test('resourceError accepts only the CLI\'s own reset, retry or login text after a separator', () => {
  for (const [line, kind] of [
    ["You've hit your session limit · resets 9:20pm (America/Los_Angeles)", 'quota'], ["You've hit your session limit · resets Oct 5 at 3pm", 'quota'],
    ["You've hit your limit · resets 3pm · /upgrade to increase your usage limit", 'quota'], ["You've hit your limit · resets in 2h", 'quota'],
    ['Claude usage limit reached. Your limit will reset at 3pm (America/New_York).', 'quota'], ["You've hit your usage limit. Try again in 2h", 'quota'],
    ["You've hit your usage limit for gpt-5-codex. Switch to another model now, or try again at 3pm.", 'quota'],
    // a native sentence cut by the terminal width is still native
    ["You've hit your usage limit. To get more access now, send a request to your", 'quota'],
    ['Not logged in · Run /login', 'auth'], ['Please run /login', 'auth'], ["Please run 'cursor-agent login' first.", 'auth'],
  ]) assert.equal(Q.resourceError(line), kind, line);
  for (const line of [
    // receipts that open with the full native message and keep talking
    'Usage limit reached · limit resets 3:10pm 的识别已补测试', 'Not logged in · Please run /login 的提示已补测试', 'Not logged in · Please run /login，已补测试',
    "You've hit your session limit · resets 9pm 已能识别", "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage 的识别已补", 'Authentication failed: 已补测试',
    'Usage limit reached · limit resets 3:10pm is now detected', 'Usage limit reached. Resets in 3h is now detected',
    'Not logged in · tests pass', 'Not logged in · see /login', "You've hit your session limit · fixed", "You've hit your limit. Fixed in 9d09317",
    "You've hit your limit — tests now pass", "You've reached your limit on retries; fixing", 'You have exceeded your limit - see test 3',
    "You've hit your usage limit. Visit the docs", 'Authentication required. Please see section 3', 'Invalid API key. Please see the docs',
    'Not logged in. Please run the test suite', 'Please run login tests', 'Please run the login tests',
    'RATE_LIMITED\\|const AUTH \\|function', 'grep -n "RATE_LIMITED\\|const AUTH \\|function" quota-core.js',
  ]) {
    for (const decorated of [line, '• ' + line, '⏺ ' + line, '│ ' + line + ' │']) {
      assert.equal(Q.resourceError(decorated), '', decorated);
      assert.equal(Q.screen('Claude', decorated, []).exhausted, false, decorated);
    }
  }
});

test('resourceError ignores resource words in ordinary replies, code and grep output', () => {
  for (const line of [
    // live false alarm: a review session's grep pattern on screen
    'RATE_LIMITED\\|function resourceError', 'grep -n "RATE_LIMITED\\|function resourceError" quota-core.js', 'RATE_LIMITED|function resourceError',
    'RESOURCE_EXHAUSTED\\|rate_limit_error', 'Usage limit reached|function foo', 'const RATE_LIMITED = new RegExp(',
    'Rate limit', 'Unauthorized', 'Limit reached', 'Invalid API key',
    'Rate limit handling test fails in api.js', 'Rate limit reached check is broken', 'Rate limited. The retry test passes now',
    'Unauthorized access test still failing', '401 Unauthorized access test still failing', '429 Too many requests test fails',
    'Limit reached check broken', 'Usage limit reached check broken', 'Usage limit reached. I fixed the test', 'Quota exhausted handling test fails',
    'Not logged in handling is fixed', 'Not logged in. Run the tests again', 'Authentication required flow reviewed', 'Please log in page now has a button',
    "if (/You've hit your limit/.test(line)) return 'quota';", "'Usage limit reached. Resets in 3h', 'quota'],",
    'quota-core.js:47:  const EXHAUSTED = /^(?:you hit your limit', "tests/a.test.js:88: assert.equal(kind('Not logged in · Please run /login'), 'auth')",
  ]) {
    for (const decorated of [line, '⏺ ' + line, '│ ' + line + ' │']) {
      assert.equal(Q.resourceError(decorated), '', decorated);
      assert.equal(Q.screen('Claude', decorated, []).exhausted, false, decorated);
    }
  }
});

test('phone rows carry display fields only: masked account, no config dir, and never show old or missing data as usable', () => {
  const seats = Q.claudeSeats([{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }]), store = {};
  const official = (seat, at, five, week, extra = {}) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: five, resetText: new Date(now + 2 * 3600000).toISOString() }, { key: 'weekly', remaining: week, resetText: new Date(now + 3 * 86400000).toISOString() }] }, at),
    seatId: seat.id, configDir: seat.configDir, accountBound: true, accountKey: `${seat.id}-account`, credentialKey: `${seat.id}-cred`, ...extra });
  Q.observe(store, official(seats[0], now, 26, 61, { account: 'hjinhao@gmail.com' }), now);
  Q.observe(store, official(seats[1], now, 0, 40, { account: 'us***@example.com' }), now);
  Q.observe(store, { ...Q.screen('Codex', 'Weekly limit: 70% left (resets 10:00)', [], now), account: 'co***@example.com' }, now);
  const rows = Q.mobile(store, now, seats, 'cn');
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.short, r.flag, r.captain, r.status]), [
    ['Claude:cn', 'Claude 🇨🇳 CN', 'CN', '🇨🇳', true, 'normal'], ['Claude:us', 'Claude 🇺🇸 US', 'US', '🇺🇸', false, 'out'],
    ['Codex', 'Codex', 'Codex', '', false, 'normal'], ['Cursor', 'Cursor Grok', 'Cursor', '', false, 'unknown'], ['Antigravity', 'Gemini', 'Gemini', '', false, 'unknown']]);
  assert.deepEqual(rows[0].cells.map((c) => [c.key, c.remaining, c.out]), [['5h', 26, false], ['7d', 61, false]]);
  assert.deepEqual([rows[0].account, rows[1].account, rows[2].account, rows[3].account], ['h***@gmail.com', 'u***@example.com', 'c***@example.com', '']);
  assert.equal(rows[1].cells[0].out, true);
  assert.equal(rows[1].recoveryAt, now + 2 * 3600000);
  // Where the numbers came from, as the desktop names it; nothing when there are none.
  assert.deepEqual(rows.map((r) => r.source), [Q.CLAUDE_OAUTH_SOURCE, Q.CLAUDE_OAUTH_SOURCE, '会话屏幕', '', '']);
  assert.deepEqual(rows[2].cells.map((c) => c.key), ['7d']);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['account', 'captain', 'cells', 'failed', 'flag', 'key', 'name', 'provider', 'recoveryAt', 'sampledAt', 'short', 'source', 'status']);
    assert.doesNotMatch(JSON.stringify(row), /\.claude|account-|-cred|hjinhao/);
  }
  // Past the freshness window an official sample keeps its numbers but is marked old; a screen sample loses them.
  const later = Q.mobile(store, now + 31 * 60000, seats, 'cn');
  assert.deepEqual([later[0].status, later[0].cells.length, later[0].sampledAt], ['stale', 2, now]);
  assert.deepEqual([later[2].status, later[2].cells.length, later[2].sampledAt], ['expired', 0, now]);
  // Failed refreshes are reported, and three in a row mark the kept numbers old.
  for (const failures of [1, 3]) {
    Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: 'cn', at: now + 60000, failureOnly: true, failures, checkedAt: now + 60000, failure: '网络错误', configDir: '~/.claude', accountKey: 'cn-account' }, now + 60000);
    const row = Q.mobile(store, now + 60000, seats, 'cn')[0];
    assert.deepEqual([row.failed, row.status], [true, failures === 3 ? 'stale' : 'normal']);
  }
  // A Captain on another provider marks that provider's row.
  assert.deepEqual(Q.mobile(store, now, seats, null, 'Codex').map((r) => r.captain), [false, false, true, false, false]);
  assert.equal(Q.mobile({}, now)[0].name, 'Claude');
  for (const [value, masked] of [['a@b.co', 'a***@b.co'], ['hj***@gmail.com', 'h***@gmail.com'], ['未识别', ''], ['a b@c.d', ''], [null, ''], ['x@y@z', '']]) assert.equal(Q.maskAccount(value), masked);
});

test('an upgraded CN/US profile lists US2 in both the desktop items and the phone rows', () => {
  const seats = require('../claude-seats-core').normalize([
    { id: 'cn', name: 'CN', configDir: '~/.claude' },
    { id: 'us', name: 'US', configDir: '~/.claude-us' },
  ]);
  const keys = ['Claude:cn', 'Claude:us', 'Claude:us2', 'Codex', 'Cursor', 'Antigravity'];
  assert.deepEqual(Q.items(seats).map((item) => item.key), keys);
  const rows = Q.mobile({}, now, seats);
  assert.deepEqual(rows.map((row) => row.key), keys);
  assert.equal(rows[2].short, 'US2');
  assert.equal(rows[2].flag, '🇺🇸');
  assert.equal(rows[2].status, 'unknown');
});

test('same-tier quota fallback switches only on a clear shortage and names the substitute', () => {
  const M = require('../main-core');
  const opus = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
  const sonnet = 'claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high';
  const gemini = 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high';
  const grok = 'cursor-agent --force --model grok-4.7-high-fast';
  const sol = 'codex --model gpt-6.1-sol --no-daemon --dangerously-bypass-approvals-and-sandbox';
  const commands = Q.QUOTA_TIERS.flat().map((member) => member.command);
  assert.deepEqual(Q.QUOTA_TIERS.map((tier) => tier.map((member) => member.label)), [
    ['Claude Opus 5.5', 'Cursor claude-opus-5-5-high'],
    ['Claude Sonnet 5.5', 'Cursor claude-sonnet-5-5-high', 'agy claude-sonnet-4-6'],
    ['Gemini Flash', 'agy gpt-oss-120b-medium', 'Cursor grok-4.7-high-fast'],
    ['Codex GPT-6.1 Sol', 'Cursor claude-sonnet-5-5-high'],
  ]);
  assert.equal(Q.QUOTA_LOW_PERCENT, 20);
  assert.equal(Q.QUOTA_TIERS[1][1], Q.QUOTA_TIERS[3][1]);
  for (const command of commands) {
    assert.equal(M.checkCommand(command).cmd, command, command);
    assert.doesNotMatch(command, /haiku/i, command);
    assert.doesNotMatch(command, /claude-opus-4/i, command);
    if (/^(?:agy|antigravity)\b/.test(command)) assert.doesNotMatch(command, /--effort\b/, command);
    if (/claude-(?:sonnet|opus)-4/.test(command)) assert.match(command, /^agy\b.*claude-sonnet-4-6\b/);
  }
  const claude = (used5h, usedWeek) => {
    const store = {};
    Q.observe(store, Q.screen('Claude', '', [`Session: ${used5h}% | Reset: 2hr`, `Weekly: ${usedWeek}% | Reset: 3d`], now), now);
    return store;
  };
  const blocked = (provider, scope) => ({ [provider]: { scope, blocked: { at: now, resetAt: now + 60_000 } } });
  const healthyGemini = () => {
    const store = {};
    Q.observe(store, Q.cacheAntigravity({ model: 'gemini-3.8-flash-high', quota: {
      'gemini-5h': { remaining_fraction: 0.8, reset_time: new Date(now + 3_600_000).toISOString() },
      'gemini-weekly': { remaining_fraction: 0.7, reset_time: new Date(now + 86_400_000).toISOString() },
    } }, now), now);
    return store;
  };
  const switched = Q.quotaFallback(blocked('Claude', 'claude'), opus, null, null, now);
  assert.equal(switched.action, 'switch');
  assert.equal(switched.note, '原本派Claude Opus 5.5，因额度换成Cursor claude-opus-5-5-high');
  assert.equal(switched.cmd, 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(switched.provider, 'Cursor');
  assert.equal(Q.quotaFallback(claude(80, 10), opus, null, null, now).action, 'switch');
  assert.equal(Q.quotaFallback(claude(79, 10), opus, null, null, now).action, 'open');
  assert.equal(Q.quotaFallback(claude(50, 90), opus, null, null, now).action, 'open');
  assert.equal(Q.quotaFallback({}, opus, null, null, now).action, 'open');
  assert.equal(Q.quotaFallback(claude(85, 10), opus, null, null, now + Q.FRESH_MS + 1).action, 'open');
  const named = Q.quotaFallback(blocked('Claude', 'claude'), opus, null, null, now, { explicit: true });
  assert.equal(named.action, 'queue');
  assert.equal(named.reason, 'explicit');
  assert.equal(named.held, 'out');
  assert.equal(named.cmd, opus);
  assert.match(named.note, /点名 Claude Opus 5\.5，不自动更换/);
  const namedLow = Q.quotaFallback(claude(85, 10), opus, null, null, now, { explicit: true });
  assert.equal(namedLow.action, 'queue');
  assert.equal(namedLow.held, 'low');
  assert.equal(Q.quotaFallback({}, opus, null, null, now, { explicit: true }).action, 'open');
  const toCursorSonnet = Q.quotaFallback(blocked('Claude', 'claude'), sonnet, null, null, now);
  assert.equal(toCursorSonnet.cmd, 'cursor-agent --force --model claude-sonnet-5-5-high');
  assert.match(toCursorSonnet.note, /^原本派Claude Sonnet 5\.5，因额度换成Cursor claude-sonnet-5-5-high$/);
  const flashLow = 'agy --dangerously-skip-permissions --model gemini-3.8-flash-low';
  const toOss = Q.quotaFallback(blocked('Antigravity', 'gemini'), flashLow, null, null, now);
  assert.equal(toOss.action, 'switch');
  assert.equal(toOss.from, 'Gemini Flash');
  assert.equal(toOss.cmd, 'agy --dangerously-skip-permissions --model gpt-oss-120b-medium');
  assert.doesNotMatch(toOss.cmd, /--effort/);
  const geminiFirst = healthyGemini();
  Q.observe(geminiFirst, Q.screen('Cursor', 'Welcome', [], now, 'grok-4.7-high-fast'), now);
  assert.equal(Q.quotaFallback(geminiFirst, gemini, null, null, now).action, 'open');
  const grokOut = healthyGemini();
  Q.observe(grokOut, Q.screen('Cursor', 'Error: You have exceeded your usage limit. Resets in 2h', [], now, 'grok-4.7-high-fast'), now);
  assert.equal(Q.quotaFallback(grokOut, grok, null, null, now).cmd, gemini);
  const grokOnly = {};
  Q.observe(grokOnly, Q.screen('Cursor', 'Error: You have exceeded your usage limit. Resets in 2h', [], now, 'grok-4.7-high-fast'), now);
  const oss = Q.quotaFallback(grokOnly, grok, null, null, now);
  assert.equal(oss.cmd, 'agy --dangerously-skip-permissions --model gpt-oss-120b-medium');
  assert.doesNotMatch(oss.cmd, /--effort/);
  assert.equal(Q.quotaFallback(blocked('Codex', 'codex'), sol, null, null, now).cmd, 'cursor-agent --force --model claude-sonnet-5-5-high');
  assert.equal(Q.quotaFallback(blocked('Codex', 'codex'), 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox', null, null, now).to, 'Cursor claude-sonnet-5-5-high');
  const luna = Q.quotaFallback(blocked('Codex', 'codex'), 'codex -m gpt-6-luna', null, null, now);
  assert.equal(luna.action, 'queue');
  assert.equal(luna.reason, 'out');
  assert.equal(luna.cmd, 'codex -m gpt-6-luna');
  assert.equal(Q.quotaFallback(blocked('Claude', 'claude'), 'cursor-agent --force --model claude-opus-5-5-xhigh', null, null, now).action, 'open');
  assert.equal(Q.quotaFallback(blocked('Claude', 'claude'), '/opt/bin/claude --model "claude-opus-5-5"', null, null, now).action, 'switch');
  const titled = Q.quotaFallbackTitle(`${'标题'.repeat(80)}`, switched.note, 120);
  assert.ok(titled.endsWith(switched.note));
  assert.ok(titled.length <= 120);
  assert.equal(Q.quotaFallbackTitle('审查', ''), '审查');
  const B = require('../board-core');
  const modelOf = (cmd) => cmd.match(/(?:--model|-m)(?:\s+|=)["']?([^\s"']+)/)?.[1];
  assert.equal(B.inferAgentType(switched.cmd), 'Cursor');
  assert.equal(modelOf(switched.cmd), 'claude-opus-5-5-high');
  assert.equal(B.inferAgentType(toOss.cmd), 'Antigravity');
  assert.equal(modelOf(toOss.cmd), 'gpt-oss-120b-medium');
  assert.doesNotMatch(toOss.cmd, /--effort/);
});

test('a screen with no remaining percent is not a usable substitute', () => {
  const grok = 'cursor-agent --force --model grok-4.7-high-fast';
  const welcome = {};
  Q.observe(welcome, Q.screen('Cursor', 'Error: You have exceeded your usage limit. Resets in 2h', [], now, 'grok-4.7-high-fast'), now);
  Q.observe(welcome, Q.screen('Antigravity', 'Welcome', [], now, 'gemini-3.8-flash-high'), now);
  const picked = Q.quotaFallback(welcome, grok, null, null, now);
  assert.equal(picked.action, 'switch');
  assert.equal(picked.to, 'agy gpt-oss-120b-medium');
  assert.equal(picked.cmd, 'agy --dangerously-skip-permissions --model gpt-oss-120b-medium');
  assert.doesNotMatch(picked.cmd, /--effort/);
  const resumed = {};
  Q.observe(resumed, Q.screen('Cursor', 'Error: You have exceeded your usage limit. Resets in 2h', [], now, 'grok-4.7-high-fast'), now);
  Q.observe(resumed, Q.screen('Antigravity', 'Usage limit reset', [], now, 'gemini-3.8-flash-high'), now);
  assert.equal(Q.quotaFallback(resumed, grok, null, null, now).to, 'Gemini Flash');
});

test('stale or expired quota numbers do not trigger a switch', () => {
  const opus = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
  const bind = (sample) => ({ ...sample, accountBound: true, accountKey: 'acc', configDir: '~/.claude', seatId: 'default', credentialKey: 'cred' });
  const stale = {};
  Q.observe(stale, bind(Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 15, resetText: new Date(now + 3_600_000).toISOString() },
    { key: 'weekly', remaining: 80, resetText: new Date(now + 86_400_000).toISOString() },
  ] }, now)), now);
  assert.equal(Q.summary(stale, 'Claude', now + 31 * 60_000).stale, true);
  assert.equal(Q.quotaFallback(stale, opus, null, null, now + 31 * 60_000).action, 'open');
  const expired = {};
  Q.observe(expired, bind(Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 0, resetText: new Date(now + 60_000).toISOString() },
    { key: 'weekly', remaining: 10, resetText: new Date(now + 120_000).toISOString() },
  ] }, now)), now);
  assert.equal(Q.quotaFallback(expired, opus, null, null, now + 31 * 60_000).action, 'open');
});

test('every measured substitute being exhausted queues the original command', () => {
  // quotaFallback follows a replaced commandQuota on the shared module. Run that
  // replacement in a child so it cannot change other tests in this file.
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, ['-e', `
    const Q = require('./quota-core');
    const assert = require('assert');
    const now = ${JSON.stringify(now)};
    const orig = Q.commandQuota;
    Q.commandQuota = (store, cmd, ...args) => /cursor-agent|gpt-oss|claude-sonnet-4-6/.test(cmd)
      ? { out: true, state: 'exhausted', stale: false, fiveHour: 0, weekly: 0 }
      : orig(store, cmd, ...args);
    const opus = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
    const gemini = 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high';
    const plan = Q.quotaFallback({ Claude: { scope: 'claude', blocked: { at: now, resetAt: now + 60_000 } } }, opus, null, null, now);
    assert.equal(plan.action, 'queue');
    assert.equal(plan.reason, 'out');
    assert.equal(plan.cmd, opus);
    const flash = Q.quotaFallback({ Antigravity: { scope: 'gemini', blocked: { at: now, resetAt: now + 60_000 } } }, gemini, null, null, now);
    assert.equal(flash.action, 'queue');
    assert.equal(flash.cmd, gemini);
    assert.equal(flash.to, '');
  `], { cwd: require('path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('summary exposes the evidence source and confidence for the panel details', () => {
  const store = {};
  Q.observe(store, Q.screen('Codex', '', [], now), now);
  const q = Q.summary(store, 'Codex', now);
  assert.equal(q.source, '会话屏幕');
  assert.equal(q.confidence, '低（仅未见用尽报错）');
  assert.match(q.detail, /来源：会话屏幕；低（仅未见用尽报错）；/);
  const empty = Q.summary({}, 'Cursor', now);
  assert.deepEqual([empty.source, empty.confidence], ['', '']);
});

test('dispatch quota gate: only 5-hour window participates in low/fallback gating; weekly 0% is out', () => {
  const opus = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
  const seats = [
    { id: 'default', name: '默认', configDir: '~/.claude' },
    { id: 'cn', name: 'CN 席位', configDir: '~/.claude-cn' },
    { id: 'us2', name: 'US2 席位', configDir: '~/.claude-us2' },
  ];
  const bind = (id, sample) => {
    const seat = seats.find((s) => s.id === id);
    return { ...sample, accountBound: true, accountKey: 'acc-' + id, configDir: seat.configDir, seatId: id, credentialKey: 'cred-' + id };
  };

  // 1. 5h 高+周低 → 放行 (周窗口不参与拦截、不参与自动换模型)
  // CN 席位实测：5 小时剩 96%、周剩 14%
  const store = {};
  Q.observe(store, bind('cn', Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 96, resetText: new Date(now + 3_600_000).toISOString() },
    { key: 'weekly', remaining: 14, resetText: new Date(now + 86_400_000).toISOString() },
  ] }, now)), now);
  // US2 席位实测：5 小时剩 99%、周剩 16%
  Q.observe(store, bind('us2', Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 99, resetText: new Date(now + 3_600_000).toISOString() },
    { key: 'weekly', remaining: 16, resetText: new Date(now + 86_400_000).toISOString() },
  ] }, now)), now);

  // CN: 放行，不排队，不自动换模型
  const cnExplicit = Q.quotaFallback(store, opus, seats, 'cn', now, { explicit: true });
  assert.equal(cnExplicit.action, 'open');
  assert.equal(cnExplicit.reason, 'ok');
  const cnAuto = Q.quotaFallback(store, opus, seats, 'cn', now, { explicit: false });
  assert.equal(cnAuto.action, 'open');
  assert.equal(cnAuto.reason, 'ok');

  // US2: 放行，不排队，不自动换模型
  const us2Explicit = Q.quotaFallback(store, opus, seats, 'us2', now, { explicit: true });
  assert.equal(us2Explicit.action, 'open');
  assert.equal(us2Explicit.reason, 'ok');
  const us2Auto = Q.quotaFallback(store, opus, seats, 'us2', now, { explicit: false });
  assert.equal(us2Auto.action, 'open');
  assert.equal(us2Auto.reason, 'ok');

  // 2. 5h 低+周高 → 排队 (点名时排队且说明 5 小时额度低) / 自动换模型 (非点名时切 Cursor)
  const low5h = {};
  Q.observe(low5h, bind('default', Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 15, resetText: new Date(now + 3_600_000).toISOString() },
    { key: 'weekly', remaining: 80, resetText: new Date(now + 86_400_000).toISOString() },
  ] }, now)), now);
  const lowExplicit = Q.quotaFallback(low5h, opus, seats, 'default', now, { explicit: true });
  assert.equal(lowExplicit.action, 'queue');
  assert.equal(lowExplicit.held, 'low');
  assert.equal(lowExplicit.reason, 'explicit');
  assert.match(lowExplicit.note, /已用 --command 点名/);
  const lowAuto = Q.quotaFallback(low5h, opus, seats, 'default', now, { explicit: false });
  assert.equal(lowAuto.action, 'switch');
  assert.equal(lowAuto.to, 'Cursor claude-opus-5-5-high');

  // 3. 5h 未知 → 行为不变 (放行开会话，不因未知拦截；但其它模型不自动切入该席位)
  const unknownStore = {};
  const unkExplicit = Q.quotaFallback(unknownStore, opus, seats, 'cn', now, { explicit: true });
  assert.equal(unkExplicit.action, 'open');
  assert.equal(unkExplicit.reason, 'unknown');
  const unkAuto = Q.quotaFallback(unknownStore, opus, seats, 'cn', now, { explicit: false });
  assert.equal(unkAuto.action, 'open');
  assert.equal(unkAuto.reason, 'unknown');

  // 4. 周 0% → 不可用 (5h 充裕但周额度用尽 0%，服务端会直接拒绝，算不可用 / 排队)
  const weekZeroStore = {};
  Q.observe(weekZeroStore, bind('cn', Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [
    { key: 'fiveHour', remaining: 96, resetText: new Date(now + 3_600_000).toISOString() },
    { key: 'weekly', remaining: 0, resetText: new Date(now + 86_400_000).toISOString() },
  ] }, now)), now);
  assert.equal(Q.commandQuota(weekZeroStore, opus, seats, 'cn', now).out, true);
  const weekZeroExplicit = Q.quotaFallback(weekZeroStore, opus, seats, 'cn', now, { explicit: true });
  assert.equal(weekZeroExplicit.action, 'queue');
  assert.equal(weekZeroExplicit.held, 'out');
  assert.equal(weekZeroExplicit.reason, 'explicit');
});
