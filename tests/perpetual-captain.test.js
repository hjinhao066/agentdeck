'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../perpetual-captain-core');
const Q = require('../quota-core');

const NOW = Date.UTC(2026, 9, 3, 12);
const info = { id: 'cn', loggedIn: true, accountKey: 'cn-account', configDir: '/home/test/.claude', configuredDir: '~/.claude' };
const unknown = (id) => ({ id, loggedIn: true, trusted: false, remaining: null });
const quota = (id, remaining, extra = {}) => ({ id, loggedIn: true, trusted: true, remaining, remainingAt: NOW, resetAt: NOW + 3600_000, ...extra });
const sample = (extra = {}) => ({ at: NOW, accountBound: true, accountKey: info.accountKey, configDir: info.configuredDir,
  windows: [{ label: '5 小时', remaining: 3, resetAt: NOW + 3600_000 }, { label: '每周', remaining: 60 }], ...extra });
const choose = (extra = {}) => P.decide({ currentId: 'cn', seats: [quota('cn', 3), unknown('us')], now: NOW, ...extra });
function exhausted(state, id, at = NOW, resetAt = NOW + 3600_000) {
  return P.observe(state, { seatId: id, at, exhausted: true, resetAt }, at);
}

test('perpetual defaults enabled at 3 percent and normalizes invalid settings', () => {
  assert.deepEqual(P.normalizeSettings(), { enabled: true, threshold: 3 });
  assert.deepEqual(P.normalizeSettings(null), { enabled: true, threshold: 3 });
  assert.deepEqual(P.normalizeSettings({ enabled: false, threshold: 7.5 }), { enabled: false, threshold: 7.5 });
  assert.equal(P.normalizeSettings({ threshold: -1 }).threshold, 3);
  assert.equal(P.normalizeSettings({ threshold: '3' }).threshold, 3);
  assert.equal(P.normalizeSettings({ threshold: 101 }).threshold, 3);
});
test('trusted 5-hour remaining at the threshold relays to the other Claude seat', () => {
  assert.equal(choose().targetId, 'us');
  assert.equal(choose().reason, 'threshold');
  assert.equal(choose({ seats: [quota('us', 0.1), unknown('cn')], currentId: 'us' }).targetId, 'cn');
  assert.equal(choose({ seats: [quota('cn', 3.1), unknown('us')] }), null);
  assert.equal(choose({ settings: { threshold: 5 }, seats: [quota('cn', 5), unknown('us')] }).targetId, 'us');
});
test('unknown or unbound digits cannot trigger threshold or reject the other seat', () => {
  assert.equal(choose({ seats: [quota('cn', 0, { trusted: false }), unknown('us')] }), null);
  assert.equal(choose({ seats: [quota('cn', 3), quota('us', 0, { trusted: false })] }).targetId, 'us');
  assert.equal(choose({ seats: [quota('cn', 3, { remainingAt: NOW - P.FRESH_MS - 1 }), unknown('us')] }), null);
});
test('an actual rate-limit error triggers relay without numeric usage', () => {
  const state = exhausted({}, 'cn');
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).targetId, 'us');
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).reason, 'quota-exhausted');
});
test('two actually exhausted Claude seats relay to Codex', () => {
  let state = exhausted({}, 'cn'); state = exhausted(state, 'us');
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).reason, 'claude-unavailable');
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 0)] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state: exhausted({}, 'us'), seats: [quota('cn', 0), unknown('us')] }).targetId, P.CODEX_ID);
});
test('low positive percentages or an unknown unlogged seat do not count as two exhausted Claude seats', () => {
  assert.equal(choose({ seats: [quota('cn', 3), quota('us', 2)] }), null);
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 2)] }), null);
  assert.equal(choose({ seats: [quota('cn', 3), { ...unknown('us'), loggedIn: false }] }), null);
  assert.equal(choose({ state: exhausted({}, 'cn'), seats: [unknown('cn'), { ...unknown('us'), loggedIn: false }] }), null);
  assert.equal(choose({ state: exhausted({}, 'cn'), seats: [unknown('cn')] }), null);
});
test('a persisted trusted zero proves exhaustion until its reset, then the Claude seat becomes usable', () => {
  let state = P.observe({}, { seatId: 'cn', at: NOW, remaining: 0, trusted: true, resetAt: NOW + 3600_000 }, NOW);
  state = exhausted(state, 'us', NOW, NOW + 7200_000);
  const seats = [unknown('cn'), unknown('us')];
  assert.equal(choose({ state, currentId: 'us', seats, now: NOW + P.FRESH_MS + 1 }).targetId, P.CODEX_ID);
  assert.equal(choose({ state, currentId: 'us', seats, now: NOW + 3600_000 }).targetId, 'cn');
});
test('busy turns, drafts, briefing and an in-progress switch never auto relay', () => {
  for (const guard of ['busy', 'draft', 'briefing', 'switching']) {
    assert.equal(choose({ [guard]: true }), null, guard);
    assert.equal(choose({ [guard]: true, state: exhausted({}, 'cn') }), null, `${guard} with quota error`);
  }
  assert.equal(choose({ busy: false, state: exhausted({}, 'cn') }).targetId, 'us');
});
test('disabled setting prevents switching while quota observations continue', () => {
  const state = exhausted({}, 'cn');
  assert.equal(choose({ settings: { enabled: false }, state }), null);
  assert.equal(state.seats.cn.exhaustedAt, NOW);
  assert.equal(choose({ settings: { enabled: true }, state }).targetId, 'us');
});
test('CN to US to Codex can advance immediately while both Claude targets remain in cooldown', () => {
  let state = exhausted({}, 'cn');
  const us = choose({ state, seats: [unknown('cn'), unknown('us')] });
  state = P.recordSwitch(state, { fromId: 'cn', ...us });
  state = exhausted(state, 'us', NOW + 1000);
  const codex = choose({ state, currentId: 'us', seats: [unknown('cn'), unknown('us')], now: NOW + 1000 });
  assert.equal(codex.targetId, P.CODEX_ID);
  state = P.recordSwitch(state, { fromId: 'us', ...codex });
  state = P.observe(state, { seatId: 'cn', at: NOW + 2000, resumed: true }, NOW + 2000);
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + 2000 }), null);
  const returned = choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + P.COOLDOWN_MS });
  assert.equal(returned.targetId, 'cn');
  assert.equal(returned.reason, 'claude-recovered');
});
test('cooldown is per target and an otherwise healthy Claude cooldown does not force Codex', () => {
  let state = P.recordSwitch({}, { fromId: 'cn', targetId: 'us', reason: 'threshold', at: NOW });
  state = exhausted(state, 'us', NOW + 1000);
  assert.equal(choose({ state, currentId: 'us', seats: [unknown('cn'), unknown('us')], now: NOW + 1000 }), null);
  assert.equal(choose({ state, currentId: 'us', seats: [unknown('cn'), unknown('us')], now: NOW + P.COOLDOWN_MS }).targetId, 'cn');
});
test('returning Claude cannot immediately bounce back into the same Codex target', () => {
  let state = exhausted({}, 'us');
  state = P.recordSwitch(state, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW });
  state = P.recordSwitch(state, { fromId: P.CODEX_ID, targetId: 'cn', reason: 'claude-recovered', at: NOW + P.COOLDOWN_MS });
  state = exhausted(state, 'cn', NOW + P.COOLDOWN_MS + 1000);
  const seats = [unknown('cn'), unknown('us')];
  assert.equal(choose({ state, seats, now: NOW + P.COOLDOWN_MS + 1000 }), null);
  assert.equal(choose({ state, seats, now: NOW + P.COOLDOWN_MS * 2 }).targetId, P.CODEX_ID);
});
test('Codex waits for real Claude recovery, then returns at an idle boundary', () => {
  let state = exhausted({}, 'cn', NOW, NOW + P.COOLDOWN_MS + 1000);
  state = exhausted(state, 'us', NOW, NOW + 3600_000);
  state = P.recordSwitch(state, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW });
  const seats = [unknown('cn'), unknown('us')];
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats, now: NOW + P.COOLDOWN_MS }), null);
  const resumedNow = NOW + P.COOLDOWN_MS + 1001;
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats, now: resumedNow, busy: true }), null);
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats, now: resumedNow }).targetId, 'cn');
  state = P.observe(state, null, resumedNow);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(state.seats.cn.recoveredAt, NOW + P.COOLDOWN_MS + 1000);
});
test('a low trusted numeric seat becomes available after its reset even when usage is unknown', () => {
  let state = P.observe({}, { seatId: 'cn', at: NOW, remaining: 3, trusted: true, resetAt: NOW + P.COOLDOWN_MS + 1000 }, NOW);
  state = exhausted(state, 'us');
  state = P.recordSwitch(state, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW });
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + P.COOLDOWN_MS + 1001 }).targetId, 'cn');
});
test('Codex does not immediately return to a never-exhausted unknown Claude seat', () => {
  const state = P.recordSwitch({}, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW });
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + P.COOLDOWN_MS }), null);
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [quota('cn', 80), unknown('us')], now: NOW + P.COOLDOWN_MS }), null);
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [quota('cn', 80, { remainingAt: NOW + P.COOLDOWN_MS }), unknown('us')], now: NOW + P.COOLDOWN_MS }).targetId, 'cn');
});
test('reset expiry cannot be undone by replaying an old quota observation', () => {
  const resetAt = NOW + 1000;
  let state = exhausted({}, 'cn', NOW, resetAt);
  state = P.observe(state, null, resetAt + 1);
  state = P.observe(state, { seatId: 'cn', at: NOW, exhausted: true }, resetAt + 1);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')], now: resetAt + 1 }), null);
  assert.equal(choose({ seats: [quota('cn', 0, { resetAt }), unknown('us')], now: resetAt + 1 }), null);
});
test('a replay without a reset does not erase the same quota event known reset', () => {
  const resetAt = NOW + 1000;
  let state = exhausted({}, 'cn', NOW, resetAt);
  state = P.observe(state, { seatId: 'cn', at: NOW, exhausted: true }, NOW + 1);
  assert.equal(state.seats.cn.resetAt, resetAt);
});
test('a fresh positive number clears low usage but cannot clear a real quota error', () => {
  let state = P.observe({}, { seatId: 'cn', at: NOW, remaining: 2, trusted: true }, NOW);
  state = exhausted(state, 'cn');
  state = P.observe(state, { seatId: 'cn', at: NOW + 1000, remaining: 90, trusted: true }, NOW + 1000);
  assert.equal(state.seats.cn.lowAt, undefined);
  assert.equal(state.seats.cn.exhaustedAt, NOW);
  assert.equal(choose({ state, seats: [quota('cn', 90), unknown('us')] }).reason, 'quota-exhausted');
});
test('account or directory changes discard old account quota latches while keeping cooldown', () => {
  let state = P.observe({}, { seatId: 'cn', accountKey: 'old', configDir: '~/.claude' }, NOW);
  state = exhausted(state, 'cn');
  state = P.recordSwitch(state, { fromId: 'cn', targetId: 'us', reason: 'quota-exhausted', at: NOW });
  state = P.observe(state, { seatId: 'cn', accountKey: 'new', configDir: '~/.claude' }, NOW + 1);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(state.seats.cn.leftAt, NOW);
  assert.equal(state.seats.cn.accountKey, 'new');
  state = exhausted(state, 'cn', NOW + 2);
  state = P.observe(state, { seatId: 'cn', accountKey: 'new', configDir: '~/.claude-new' }, NOW + 3);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(state.seats.cn.configDir, '~/.claude-new');
  assert.equal(state.seats.cn.leftAt, NOW);
});
test('numeric quota requires its own account and directory ownership and only uses the 5-hour window', () => {
  const known = P.seatQuota({ sample: sample() }, info, NOW);
  assert.equal(known.remaining, 3); assert.equal(known.trusted, true);
  for (const extra of [{ accountBound: false }, { accountKey: 'us-account' }, { accountKey: null }, { configDir: '~/.claude-us' }, { accountBound: true, configDir: null }]) {
    const result = P.seatQuota({ accountKey: info.accountKey, configDir: info.configuredDir, sample: sample(extra) }, info, NOW);
    assert.equal(result.remaining, null); assert.equal(result.trusted, false);
  }
  assert.equal(P.seatQuota({ sample: sample({ windows: [{ label: '每周', remaining: 0 }] }) }, info, NOW).remaining, null);
  assert.equal(P.seatQuota({ sample: sample({ windows: [{ label: '5 小时', remaining: 70 }, { label: '每周', remaining: 0 }] }) }, info, NOW).remaining, 70);
});
test('official quota binds to the current seat directory and credential storage slot without changing the API payload', () => {
  const current = { ...info, credentialKey: 'cn-current-slot' };
  const official = { provider: 'Claude', scope: 'claude', official: true, seatId: 'cn', configDir: info.configuredDir,
    credentialKey: current.credentialKey, at: NOW,
    windows: [{ key: 'fiveHour', used: 97, remaining: 3, resetAt: NOW + 3600_000 }] };
  const before = JSON.stringify(official);
  assert.equal(P.bound(official, current), true);
  assert.equal(P.seatQuota({ sample: official }, current, NOW).remaining, 3);
  assert.equal(P.bound({ ...official, configDir: current.configDir }, current), true);
  assert.equal(JSON.stringify(official), before);
  for (const extra of [{ official: false }, { provider: 'Codex' }, { scope: 'codex' }, { seatId: 'us' },
    { configDir: '~/.claude-us' }, { credentialKey: 'old-slot' }, { credentialKey: null }, { accountKey: 'us-account' }]) {
    assert.equal(P.bound({ ...official, ...extra }, current), false, JSON.stringify(extra));
  }
  assert.equal(P.bound(official, { ...current, credentialKey: null }), false);
  assert.equal(P.bound({ ...official, accountKey: current.accountKey }, current), true);
  // A slot hash is insufficient to promote a native/legacy cache's digits.
  assert.equal(P.bound(sample({ accountBound: false, credentialKey: current.credentialKey }), current), false);
});
test('official samples cannot trigger automation when stale, future-dated or past their five-hour reset', () => {
  const current = { ...info, credentialKey: 'cn-current-slot' };
  const official = { provider: 'Claude', scope: 'claude', official: true, seatId: 'cn', configDir: info.configDir,
    credentialKey: current.credentialKey, at: NOW,
    windows: [{ key: 'fiveHour', used: 100, remaining: 0, exhausted: true, resetAt: NOW + 3600_000 }] };
  const blocked = { at: NOW, numeric: true, resetAt: NOW + 3600_000 };
  const active = P.seatQuota({ sample: official, blocked }, current, NOW);
  assert.equal(active.trusted, true); assert.equal(active.exhausted, true);
  for (const now of [NOW + P.FRESH_MS + 1, NOW - 60_001, NOW + 3600_000]) {
    const result = P.seatQuota({ sample: official, blocked }, current, now);
    assert.equal(result.trusted, false); assert.equal(result.exhausted, false);
  }
  const ownedBlock = { ...official, windows: undefined, numeric: true, resetAt: NOW + 3600_000 };
  assert.equal(P.seatQuota({ blocked: ownedBlock }, current, NOW).exhausted, true);
  assert.equal(P.seatQuota({ blocked: ownedBlock }, current, NOW + P.FRESH_MS + 1).exhausted, false);
});
test('known account or directory changes invalidate older official samples but first identity observation preserves them', () => {
  const current = { ...info, credentialKey: 'cn-current-slot' };
  const official = { provider: 'Claude', scope: 'claude', official: true, seatId: 'cn', configDir: info.configuredDir,
    credentialKey: current.credentialKey, at: NOW, windows: [{ key: 'fiveHour', remaining: 3, resetAt: NOW + 3600_000 }] };
  let state = P.observe({}, { seatId: 'cn', accountKey: info.accountKey, configDir: info.configuredDir }, NOW + 1);
  assert.equal(state.seats.cn.officialNotBefore, undefined);
  assert.equal(P.seatQuota({ sample: official }, { ...current, ...state.seats.cn }, NOW + 1).trusted, true);
  state = P.observe(state, { seatId: 'cn', accountKey: 'new-account', configDir: info.configuredDir }, NOW + 2);
  assert.equal(state.seats.cn.officialNotBefore, NOW + 2);
  assert.equal(P.bound(official, { ...current, officialNotBefore: NOW + 2 }), false);
  assert.equal(P.seatQuota({ sample: official, officialNotBefore: NOW + 2 }, current, NOW + 2).trusted, false);
  assert.equal(P.seatQuota({ sample: official, officialNotBefore: NOW + 2 }, { ...current, officialNotBefore: NOW - 1 }, NOW + 2).trusted, false);
  assert.equal(P.seatQuota({ sample: official, officialNotBefore: NOW - 1 }, { ...current, officialNotBefore: NOW + 2 }, NOW + 2).trusted, false);
  assert.equal(P.bound({ ...official, at: NOW + 2 }, { ...current, officialNotBefore: NOW + 2 }), true);
  state = P.observe(state, { seatId: 'cn', accountKey: 'new-account', configDir: '~/.claude-new' }, NOW + 3);
  assert.equal(state.seats.cn.officialNotBefore, NOW + 3);
  assert.deepEqual(P.normalizeState(JSON.parse(JSON.stringify(state))), P.normalizeState(state));
  assert.equal(P.seatQuota({ sample: sample(), officialNotBefore: NOW + 2 }, current, NOW + 2).trusted, true);
});
test('a newer official available sample clears an earlier indefinite rate-limit observation, but not an exhausted weekly window', () => {
  const current = { ...info, credentialKey: 'cn-current-slot' };
  const official = { provider: 'Claude', scope: 'claude', official: true, seatId: 'cn', configDir: info.configuredDir,
    credentialKey: current.credentialKey, at: NOW + 1,
    windows: [{ key: 'fiveHour', remaining: 80, resetAt: NOW + 3600_000 },
      { key: 'weekly', remaining: 70, resetAt: NOW + 7 * 86400_000 }] };
  let state = P.observe({}, { seatId: 'cn', at: NOW, exhausted: true }, NOW);
  const q = P.seatQuota({ sample: official }, current, NOW + 1);
  assert.equal(q.resumedAt, NOW + 1);
  state = P.observe(state, { seatId: 'cn', at: q.resumedAt, resumed: true }, NOW + 1);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(P.seatQuota({ sample: { ...official, windows: [official.windows[0],
    { ...official.windows[1], remaining: 0, exhausted: true }] } }, current, NOW + 1).resumedAt, null);
  assert.equal(P.seatQuota({ sample: official, blocked: { at: NOW + 2, sourceColumnId: 'cn-native', configDir: info.configuredDir } }, current, NOW + 2).resumedAt, null);
});
test('expired, reset, future or invalid numeric observations become unknown', () => {
  for (const extra of [{ at: NOW - P.FRESH_MS - 1 }, { at: NOW + 60_001 }, { windows: [{ label: '5 小时', remaining: -1 }] },
    { windows: [{ label: '5 小时', remaining: 0, resetAt: NOW }] }]) {
    assert.equal(P.seatQuota({ sample: sample(extra) }, info, NOW).trusted, false);
  }
});
test('quota directory ownership respects Windows case-insensitive paths', () => {
  const windowsInfo = { ...info, configDir: 'C:\\Users\\Test\\.claude', configuredDir: null };
  assert.equal(P.seatQuota({ sample: sample({ configDir: 'c:/users/test/.claude/' }) }, windowsInfo, NOW).trusted, true);
  assert.equal(P.seatQuota({ sample: sample({ configDir: '/HOME/test/.claude' }) }, info, NOW).trusted, false);
});
test('real error quota requires a source column and its seat directory, and does not cross account identity', () => {
  const blocked = { at: NOW, sourceColumnId: 'captain-cn', configDir: info.configuredDir, resetAt: NOW + 1000 };
  assert.equal(P.seatQuota({ blocked }, info, NOW).exhausted, true);
  for (const extra of [{ sourceColumnId: null }, { configDir: '~/.claude-us' }, { accountKey: 'us-account' }]) {
    assert.equal(P.seatQuota({ blocked: { ...blocked, ...extra } }, info, NOW).exhausted, false);
  }
  assert.equal(P.seatQuota({ blocked }, info, NOW + 1000).exhausted, false);
});
test('cached numeric exhausted latches also need account ownership', () => {
  const blocked = { at: NOW, numeric: true, accountBound: true, accountKey: info.accountKey, configDir: info.configuredDir };
  assert.equal(P.seatQuota({ blocked }, info, NOW + P.FRESH_MS + 1).exhausted, true);
  assert.equal(P.seatQuota({ blocked: { ...blocked, accountKey: 'us-account' } }, info, NOW).exhausted, false);
  assert.equal(P.seatQuota({ blocked: { ...blocked, accountBound: false } }, info, NOW).exhausted, false);
});
test('resumption evidence is passed only for an owned source observation', () => {
  assert.equal(P.seatQuota({ sample: sample({ resumed: true }) }, info, NOW).resumedAt, NOW);
  assert.equal(P.seatQuota({ sample: sample({ resumed: true, accountKey: 'us-account' }) }, info, NOW).resumedAt, null);
  assert.equal(P.seatQuota({ sample: sample({ resumed: true, accountBound: false, sourceColumnId: 'captain-cn' }) }, info, NOW).resumedAt, NOW);
  const resumed = { at: NOW, sourceColumnId: 'captain-cn', configDir: info.configuredDir, accountKey: info.accountKey };
  assert.equal(P.seatQuota({ resumed }, info, NOW + P.FRESH_MS + 1).resumedAt, NOW);
  for (const extra of [{ sourceColumnId: null }, { configDir: '~/.claude-us' }, { accountKey: 'us-account' }]) {
    assert.equal(P.seatQuota({ resumed: { ...resumed, ...extra } }, info, NOW).resumedAt, null);
  }
});
test('retaining old numeric usage does not hide a native reset from the persistent policy lock', () => {
  const store = {}, owner = { seatId: 'cn', configDir: info.configuredDir, accountKey: info.accountKey, sourceColumnId: 'captain-cn' };
  Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 20 }, NOW), ...owner, accountBound: true }, NOW);
  Q.observe(store, { ...Q.screen('Claude', 'Usage limit reached', [], NOW + 1), ...owner }, NOW + 1);
  let state = exhausted({}, 'cn', NOW + 1, null);
  Q.observe(store, { ...Q.screen('Claude', 'Usage limit reset', [], NOW + 2), ...owner }, NOW + 2);
  const q = P.seatQuota(store['Claude:cn'], info, NOW + 2);
  assert.equal(q.remainingAt, NOW);
  assert.equal(q.resumedAt, NOW + 2);
  state = P.observe(state, { seatId: 'cn', resumed: true, at: q.resumedAt }, NOW + 2);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(state.seats.cn.recoveredAt, NOW + 2);
});
test('state and switch history survive JSON persistence and pure calls do not mutate their inputs', () => {
  const state = exhausted({}, 'cn');
  const before = JSON.stringify(state);
  const next = P.recordSwitch(state, { fromId: 'cn', targetId: 'us', reason: 'quota-exhausted', at: NOW });
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(P.normalizeState(JSON.parse(JSON.stringify(next))), next);
  assert.deepEqual(P.normalizeState({ seats: { '../bad': { exhaustedAt: NOW }, cn: { exhaustedAt: 'bad', enteredAt: NOW } } }),
    { seats: { cn: { enteredAt: NOW } }, lastSwitch: null });
  assert.equal(P.recordSwitch(state, { fromId: 'cn', targetId: 'cn', at: NOW }).lastSwitch, null);
  for (const malformed of [undefined, null, 3, 'invalid']) assert.deepEqual(P.normalizeState(malformed), { seats: {}, lastSwitch: null });
  assert.deepEqual(P.seatQuota(null, null, NOW), { remaining: null, remainingAt: null, resetAt: null, trusted: false, exhausted: false, exhaustedAt: null, exhaustedResetAt: null, resumedAt: null });
});
