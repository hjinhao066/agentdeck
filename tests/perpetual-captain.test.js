'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../perpetual-captain-core');
const Q = require('../quota-core');

const NOW = Date.UTC(2026, 9, 3, 12);
const info = { id: 'cn', loggedIn: true, accountKey: 'cn-account', configDir: '/home/test/.claude', configuredDir: '~/.claude' };
const unknown = (id) => ({ id, loggedIn: true, trusted: false, remaining: null });
const quota = (id, remaining, extra = {}) => ({ id, loggedIn: true, trusted: true, remaining, remainingAt: NOW, resetAt: NOW + 3600_000, weeklyTrusted: true, weeklyRemaining: 60, weeklyResetAt: NOW + 7 * 86400_000, ...extra });
const sample = (extra = {}) => ({ at: NOW, accountBound: true, accountKey: info.accountKey, configDir: info.configuredDir,
  windows: [{ label: '5 小时', remaining: 3, resetAt: NOW + 3600_000 }, { label: '每周', remaining: 60 }], ...extra });
const choose = (extra = {}) => P.decide({ currentId: 'cn', seats: [quota('cn', 3), quota('us', 80)], now: NOW, ...extra });
function exhausted(state, id, at = NOW, resetAt = NOW + 3600_000) {
  return P.observe(state, { seatId: id, at, exhausted: true, resetAt }, at);
}

test('perpetual defaults enabled at 3 percent and normalizes invalid settings', () => {
  const order = ['us2', 'us', 'cn'];
  assert.deepEqual(P.normalizeSettings(), { enabled: true, threshold: 3, preferEarlier: true, order });
  assert.deepEqual(P.normalizeSettings(null), { enabled: true, threshold: 3, preferEarlier: true, order });
  assert.deepEqual(P.normalizeSettings({ enabled: false, threshold: 7.5, preferEarlier: true }), { enabled: false, threshold: 7.5, preferEarlier: true, order });
  assert.equal(P.normalizeSettings({ threshold: -1 }).threshold, 3);
  assert.equal(P.normalizeSettings({ threshold: '3' }).threshold, 3);
  assert.equal(P.normalizeSettings({ threshold: 101 }).threshold, 3);
});
test('trusted 5-hour remaining at the threshold relays to the other Claude seat', () => {
  assert.equal(choose().targetId, 'us');
  assert.equal(choose().reason, 'threshold');
  assert.equal(choose({ seats: [quota('us', 0.1), quota('cn', 80)], currentId: 'us' }).targetId, 'cn');
  assert.equal(choose({ seats: [quota('cn', 3.1), unknown('us')] }), null);
  assert.equal(choose({ settings: { threshold: 5 }, seats: [quota('cn', 5), quota('us', 80)] }).targetId, 'us');
});
test('unknown or unbound digits cannot trigger threshold or qualify a destination', () => {
  assert.equal(choose({ seats: [quota('cn', 0, { trusted: false }), unknown('us')] }), null);
  assert.equal(choose({ seats: [quota('cn', 3), quota('us', 0, { trusted: false })] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 3, { remainingAt: NOW - P.FRESH_MS - 1 }), unknown('us')] }), null);
});
test('an actual rate-limit error triggers relay without numeric usage', () => {
  const state = exhausted({}, 'cn');
  assert.equal(choose({ state, seats: [unknown('cn'), quota('us', 80)] }).targetId, 'us');
  assert.equal(choose({ state, seats: [unknown('cn'), quota('us', 80)] }).reason, 'quota-exhausted');
});
test('two actually exhausted Claude seats relay to Codex', () => {
  let state = exhausted({}, 'cn'); state = exhausted(state, 'us');
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state, seats: [unknown('cn'), unknown('us')] }).reason, 'claude-unavailable');
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 0)] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state: exhausted({}, 'us'), seats: [quota('cn', 0), unknown('us')] }).targetId, P.CODEX_ID);
});
test('low positive quotas and missing logins do not strand the captain without a usable destination', () => {
  assert.equal(choose({ seats: [quota('cn', 3), quota('us', 2)] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 2)] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 3), { ...unknown('us'), loggedIn: false }] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state: exhausted({}, 'cn'), seats: [unknown('cn'), { ...unknown('us'), loggedIn: false }] }).targetId, P.CODEX_ID);
  assert.equal(choose({ state: exhausted({}, 'cn'), seats: [unknown('cn')] }).targetId, P.CODEX_ID);
});
test('quota banner follows rotation order and reports the earliest recovery when no seat is ready', () => {
  const seats = [quota('cn', 0), quota('us', 0), quota('us2', 80)];
  const input = { currentId: 'us', settings: { enabled: true }, seats, now: NOW };
  assert.deepEqual(P.quotaAction(input), { targetId: 'us2', recoveryAt: null, reason: 'quota-exhausted' });
  assert.equal(P.quotaAction({ ...input, settings: { enabled: false } }).targetId, 'us2');

  const blocked = [
    quota('cn', 0, { resetAt: NOW + 2 * 3600_000 }),
    quota('us', 0, { resetAt: NOW + 3600_000 }),
    quota('us2', 80, { onboardingComplete: false, resetAt: NOW + 5 * 60_000 })
  ];
  assert.deepEqual(P.quotaAction({ ...input, seats: blocked }), {
    targetId: null, recoveryAt: NOW + 3600_000, reason: 'claude-unavailable'
  });
});
test('a persisted trusted zero waits for a fresh sample after reset before the Claude seat becomes usable', () => {
  let state = P.observe({}, { seatId: 'cn', at: NOW, remaining: 0, trusted: true, resetAt: NOW + 3600_000 }, NOW);
  state = exhausted(state, 'us', NOW, NOW + 7200_000);
  const seats = [unknown('cn'), unknown('us')];
  assert.equal(choose({ state, currentId: 'us', seats, now: NOW + P.FRESH_MS + 1 }).targetId, P.CODEX_ID);
  assert.equal(choose({ state, currentId: 'us', seats, now: NOW + 3600_000 }).targetId, P.CODEX_ID);
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
  const us = choose({ state, seats: [unknown('cn'), quota('us', 80)] });
  state = P.recordSwitch(state, { fromId: 'cn', ...us });
  state = exhausted(state, 'us', NOW + 1000);
  const codex = choose({ state, currentId: 'us', seats: [unknown('cn'), unknown('us')], now: NOW + 1000 });
  assert.equal(codex.targetId, P.CODEX_ID);
  state = P.recordSwitch(state, { fromId: 'us', ...codex });
  state = P.observe(state, { seatId: 'cn', at: NOW + 2000, resumed: true }, NOW + 2000);
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + 2000 }), null);
  const returned = choose({ state, currentId: P.CODEX_ID, seats: [quota('cn', 80, { remainingAt: NOW + P.COOLDOWN_MS }), unknown('us')], now: NOW + P.COOLDOWN_MS });
  assert.equal(returned.targetId, 'cn');
  assert.equal(returned.reason, 'claude-recovered');
});
test('cooldown is per target and an otherwise healthy Claude cooldown does not force Codex', () => {
  let state = P.recordSwitch({}, { fromId: 'cn', targetId: 'us', reason: 'threshold', at: NOW });
  state = exhausted(state, 'us', NOW + 1000);
  assert.equal(choose({ state, currentId: 'us', seats: [quota('cn', 80), unknown('us')], now: NOW + 1000 }), null);
  assert.equal(choose({ state, currentId: 'us', seats: [quota('cn', 80), unknown('us')], now: NOW + P.COOLDOWN_MS }).targetId, 'cn');
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
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats, now: resumedNow }), null);
  state = P.observe(state, null, resumedNow);
  assert.equal(state.seats.cn.exhaustedAt, undefined);
  assert.equal(state.seats.cn.recoveredAt, NOW + P.COOLDOWN_MS + 1000);
});
test('a low trusted numeric seat stays unknown after reset until sampled', () => {
  let state = P.observe({}, { seatId: 'cn', at: NOW, remaining: 3, trusted: true, resetAt: NOW + P.COOLDOWN_MS + 1000 }, NOW);
  state = exhausted(state, 'us');
  state = P.recordSwitch(state, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW });
  assert.equal(choose({ state, currentId: P.CODEX_ID, seats: [unknown('cn'), unknown('us')], now: NOW + P.COOLDOWN_MS + 1001 }), null);
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
  assert.equal(choose({ state, seats: [quota('cn', 90), quota('us', 80)] }).reason, 'quota-exhausted');
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
  assert.equal(P.seatQuota({ sample: official, resumed: { at: NOW - 1, sourceColumnId: 'cn-native', configDir: info.configuredDir } }, current, NOW + 1).resumedAt, NOW + 1);
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
  assert.deepEqual(P.seatQuota(null, null, NOW), { remaining: null, remainingAt: null, resetAt: null, trusted: false, weeklyRemaining: null, weeklyTrusted: false, weeklyRemainingAt: null, weeklyResetAt: null, exhausted: false, exhaustedAt: null, exhaustedResetAt: null, resumedAt: null });
});

test('healthy counting windows prefer the earlier reset, with weekly availability, unknown data and the icon setting respected', () => {
  const available = (id, resetAt, extra = {}) => quota(id, 80, { resetAt, weeklyTrusted: true, weeklyRemaining: 60, ...extra });
  const cn = available('cn', NOW + 5 * 3600000), us = available('us', NOW + 3600000);
  assert.equal(choose({ seats: [cn, us] }).reason, 'earlier-reset');
  assert.equal(choose({ seats: [cn, us] }).targetId, 'us');
  assert.equal(choose({ settings: { preferEarlier: false }, seats: [cn, us] }), null);
  for (const extra of [{ remaining: 0 }, { remaining: 3 }, { weeklyRemaining: 0 }, { weeklyRemaining: 3 },
    { weeklyTrusted: false }, { trusted: false }, { resetAt: null }, { resetAt: NOW - 1 }]) {
    assert.equal(choose({ seats: [cn, { ...us, ...extra }] }), null, JSON.stringify(extra));
  }
  for (const extra of [{ trusted: false }, { weeklyTrusted: false }, { resetAt: null }, { resetAt: NOW - 1 }]) {
    assert.equal(choose({ seats: [{ ...cn, ...extra }, us] }), null, JSON.stringify(extra));
  }
  assert.equal(choose({ seats: [cn, { ...us, resetAt: cn.resetAt }] }), null);
  assert.equal(choose({ seats: [cn, us], busy: true }), null);
});
test('earlier-reset rotations keep the ten-minute return cooldown', () => {
  const seats = [quota('cn', 80, { resetAt: NOW + 5 * 3600000, weeklyTrusted: true, weeklyRemaining: 60 }),
    quota('us', 60, { resetAt: NOW + 3600000, weeklyTrusted: true, weeklyRemaining: 60 })];
  const first = choose({ seats });
  const state = P.recordSwitch({}, { fromId: 'cn', ...first });
  const reversed = [{ ...seats[0], resetAt: NOW + 1800000 }, { ...seats[1], resetAt: NOW + 5 * 3600000 }];
  assert.equal(choose({ state, currentId: 'us', seats: reversed, now: NOW + 1000 }), null);
  assert.equal(choose({ state, currentId: 'us', seats: reversed, now: NOW + P.COOLDOWN_MS }).targetId, 'cn');
});
test('earlier-reset requires at least ten minutes of useful advancement', () => {
  const cn = quota('cn', 80, { resetAt: NOW + 5 * 3600000, weeklyTrusted: true, weeklyRemaining: 60 });
  const us = quota('us', 80, { weeklyTrusted: true, weeklyRemaining: 60 });
  for (const advance of [0, 247, 305, 600, 60000, 599999]) {
    assert.equal(choose({ seats: [cn, { ...us, resetAt: cn.resetAt - advance }] }), null, `${advance}ms`);
  }
  for (const advance of [600000, 600001, 1800000]) {
    assert.equal(choose({ seats: [cn, { ...us, resetAt: cn.resetAt - advance }] }).reason, 'earlier-reset');
  }
  // Low quota still uses its existing fallback even when both resets align.
  assert.equal(choose({ seats: [{ ...cn, remaining: 3 }, { ...us, resetAt: cn.resetAt }] }).reason, 'threshold');
});
test('aligned reset windows stay put despite fresh jitter after every cooldown for three hours', () => {
  const resetAt = NOW + 5 * 3600000, noise = [[247, 0], [-300, 300], [300, -300], [0, 0], [0, 247]];
  let state = {}, currentId = 'cn', switches = 0;
  for (let tick = 0; tick < 360; tick++) {
    const now = NOW + tick * 30000;
    const seats = ['cn', 'us'].map((id, index) => quota(id, 90, { remainingAt: now,
      resetAt: resetAt + noise[tick % noise.length][index], weeklyTrusted: true, weeklyRemaining: 50 }));
    const decision = P.decide({ state, currentId, seats, now });
    if (decision) {
      state = P.recordSwitch(state, { fromId: currentId, ...decision });
      currentId = decision.targetId; switches++;
    }
  }
  assert.equal(switches, 0);
  assert.equal(currentId, 'cn');
});
test('a materially earlier jittered window gets one rotation across three hours', () => {
  let state = {}, currentId = 'cn', switches = 0;
  for (let tick = 0; tick < 360; tick++) {
    const now = NOW + tick * 30000, jitter = tick % 2 ? -300 : 300;
    const seats = ['cn', 'us'].map((id, index) => quota(id, 90, { remainingAt: now,
      resetAt: NOW + 5 * 3600000 - index * 1800000 + (index ? -jitter : jitter),
      weeklyTrusted: true, weeklyRemaining: 50 }));
    const decision = P.decide({ state, currentId, seats, now });
    if (decision) {
      assert.equal(decision.reason, 'earlier-reset');
      state = P.recordSwitch(state, { fromId: currentId, ...decision });
      currentId = decision.targetId; switches++;
    }
  }
  assert.equal(switches, 1);
  assert.equal(currentId, 'us');
});
test('weekly low quota is never a Relay destination, including the old low-five-hour fallback', () => {
  assert.equal(choose({ seats: [quota('cn', 2), quota('us', 80, { weeklyTrusted: true, weeklyRemaining: 3 })] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 80, { weeklyTrusted: true, weeklyRemaining: 0 })] }).targetId, P.CODEX_ID);
});
test('strategy details use plain language and show the reset, threshold and weekly guard', () => {
  const seats = [{ ...quota('cn', 80), name: 'CN' }, { ...quota('us', 80), name: 'US' }];
  const text = P.strategyText({ currentId: 'cn', seats, warmups: [{ seatId: 'us', resetAt: NOW + 3600000, status: 'pending' }], now: NOW });
  assert.match(text, /正在用 CN/); assert.match(text, /US .*重置后自动预热/); assert.match(text, /CN 剩 3% 时切到 US/);
  assert.match(P.strategyText({ currentId: 'cn', seats: [seats[0], { ...seats[1], weeklyRemaining: 0 }], now: NOW }), /每周额度不足，不切换也不预热/);
});

test('three Claude seats cycle US2 to US to CN to US2, skipping unavailable seats', () => {
  for (const [currentId, next] of [['us2', 'us'], ['us', 'cn'], ['cn', 'us2']]) {
    const seats = ['cn', 'us', 'us2'].map((id) => quota(id, id === currentId ? 0 : 80));
    assert.equal(choose({ currentId, seats }).targetId, next);
    seats.find((s) => s.id === next).loggedIn = false;
    assert.notEqual(choose({ currentId, seats }).targetId, next);
    seats.find((s) => s.id === next).loggedIn = true;
    seats.find((s) => s.id === next).remaining = 0;
    assert.notEqual(choose({ currentId, seats }).targetId, next);
  }
  assert.equal(choose({ currentId: 'us', seats: [quota('cn', 0), quota('us', 0), quota('us2', 60)] }).targetId, 'us2');
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 0), { ...unknown('us2'), loggedIn: false }] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 0), quota('us2', 0)] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [quota('cn', 0), quota('us', 0), quota('us2', 2)] }).targetId, P.CODEX_ID);
});
test('rotation order is independent of the order seats are listed in', () => {
  for (const listed of [['cn', 'us', 'us2'], ['us2', 'us', 'cn'], ['us', 'cn', 'us2']]) {
    for (const [currentId, next] of [['us2', 'us'], ['us', 'cn'], ['cn', 'us2']]) {
      const seats = listed.map((id) => quota(id, id === currentId ? 0 : 80));
      assert.equal(choose({ currentId, seats }).targetId, next, `${currentId} listed as ${listed}`);
    }
  }
});
test('with every Claude seat healthy the current seat stays', () => {
  for (const currentId of ['us2', 'us', 'cn']) {
    assert.equal(choose({ currentId, seats: ['cn', 'us', 'us2'].map((id) => quota(id, 100)) }), null, currentId);
  }
});
test('a US seat at the weekly threshold is skipped: US2 goes straight to CN', () => {
  const weekly = (remaining) => ({ weeklyTrusted: true, weeklyRemaining: remaining });
  const seats = (usWeekly) => [quota('cn', 80, weekly(60)), quota('us', 80, weekly(usWeekly)), quota('us2', 0, weekly(60))];
  assert.equal(choose({ currentId: 'us2', seats: seats(60) }).targetId, 'us');
  assert.equal(choose({ currentId: 'us2', seats: seats(3) }).targetId, 'cn');
  assert.equal(choose({ currentId: 'us2', seats: seats(2) }).targetId, 'cn');
  assert.equal(choose({ currentId: 'us2', seats: seats(3.1) }).targetId, 'us');
});
test('a configured order replaces the default; missing order uses the default', () => {
  const seats = (currentId) => ['cn', 'us', 'us2'].map((id) => quota(id, id === currentId ? 0 : 80));
  assert.equal(choose({ currentId: 'us2', seats: seats('us2'), settings: { order: ['cn', 'us', 'us2'] } }).targetId, 'cn');
  assert.equal(choose({ currentId: 'cn', seats: seats('cn'), settings: { order: ['cn', 'us', 'us2'] } }).targetId, 'us');
  for (const order of [undefined, null, 'us', 7, {}, [], [''], [null, 3]]) {
    assert.deepEqual(P.normalizeSettings({ order }).order, ['us2', 'us', 'cn'], JSON.stringify(order));
    assert.equal(choose({ currentId: 'us2', seats: seats('us2'), settings: { order } }).targetId, 'us');
  }
  assert.deepEqual(P.normalizeSettings({ order: ['cn', 'cn', 'us'] }).order, ['cn', 'us']);
});
test('rotation order ignores unknown ids and puts unlisted seats last', () => {
  const seats = (currentId) => ['cn', 'us', 'us2'].map((id) => quota(id, id === currentId ? 0 : 80));
  const settings = { order: ['ghost', 'us', 'bad id!', 'nope'] };
  assert.equal(choose({ currentId: 'us', seats: seats('us'), settings }).targetId, 'cn');
  assert.equal(choose({ currentId: 'cn', seats: seats('cn'), settings }).targetId, 'us2');
  assert.equal(choose({ currentId: 'us2', seats: seats('us2'), settings }).targetId, 'us');
  assert.deepEqual(P.orderSeats([{ id: 'cn' }, { id: 'x' }, { id: 'us2' }, { id: 'us' }], ['us', 'ghost']).map((s) => s.id), ['us', 'cn', 'x', 'us2']);
  assert.deepEqual(P.orderSeats([{ id: 'cn' }, { id: 'us' }, { id: 'us2' }]).map((s) => s.id), ['us2', 'us', 'cn']);
});
test('Codex hands back to the first available Claude seat in rotation order', () => {
  const state = P.recordSwitch({}, { fromId: 'us', targetId: P.CODEX_ID, reason: 'claude-unavailable', at: NOW - P.COOLDOWN_MS - 1 });
  const seats = ['cn', 'us', 'us2'].map((id) => quota(id, 80, { remainingAt: NOW }));
  assert.equal(choose({ currentId: P.CODEX_ID, state, seats }).targetId, 'us2');
  assert.equal(choose({ currentId: P.CODEX_ID, state, seats: seats.map((s) => s.id === 'us2' ? { ...s, loggedIn: false } : s) }).targetId, 'us');
});
test('the one-click quota action and the strategy text follow the rotation order', () => {
  const seats = [quota('cn', 80), quota('us', 80), quota('us2', 0)];
  assert.equal(P.quotaAction({ currentId: 'us2', seats, now: NOW }).targetId, 'us');
  assert.equal(P.quotaAction({ currentId: 'us2', seats: seats.map((s) => s.id === 'us' ? quota('us', 0) : s), now: NOW }).targetId, 'cn');
  const named = ['cn', 'us', 'us2'].map((id) => ({ ...quota(id, 80), name: id.toUpperCase() }));
  assert.match(P.strategyText({ currentId: 'us2', seats: named, now: NOW }), /US2 剩 3% 时切到 US(?!2)/);
  assert.match(P.strategyText({ currentId: 'cn', seats: named, now: NOW }), /CN 剩 3% 时切到 US2/);
});
test('a seat with unfinished onboarding is skipped by rotation and does not block the Codex fallback', () => {
  const current = quota('cn', 0), us = quota('us', 0), us2 = quota('us2', 80, { onboardingComplete: false });
  assert.equal(choose({ seats: [current, quota('us', 80), us2] }).targetId, 'us');
  assert.equal(choose({ currentId: 'us2', seats: [quota('cn', 80), us, us2] }).targetId, 'cn');
  assert.equal(choose({ seats: [current, us, us2] }).targetId, P.CODEX_ID);
  assert.equal(choose({ seats: [current, us, quota('us2', 0)] }).targetId, P.CODEX_ID);
});


test('fresh confirmed Claude seats take precedence over unknown, stale and reset-expired seats', () => {
  const variants = [unknown('us'), quota('us', 80, { remainingAt: NOW - P.FRESH_MS - 1 }),
    quota('us', 80, { weeklyTrusted: false }), quota('us', 80, { weeklyRemainingAt: NOW - P.FRESH_MS - 1 }),
    quota('us', 80, { resetAt: NOW }), quota('us', 80, { weeklyResetAt: NOW })];
  for (const us of variants) {
    assert.equal(choose({ currentId: 'us2', seats: [quota('us2', 0), us, quota('cn', 80)] }).targetId, 'cn');
    assert.equal(choose({ currentId: 'us2', seats: [quota('us2', 0), us] }).targetId, P.CODEX_ID);
  }
});
test('a weekly exhausted US seat stays excluded through stale samples and rejoins only with post-reset samples', () => {
  const resetAt = NOW + 4 * 86400_000;
  let state = P.observe({}, { seatId: 'us', at: NOW, weeklyTrusted: true, weeklyRemaining: 0, weeklyResetAt: resetAt }, NOW);
  state = P.normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(state.seats.us.weeklyLowResetAt, resetAt);
  const later = NOW + P.FRESH_MS + 1;
  assert.equal(P.status(unknown('us'), state.seats.us, 3, later).exhausted, true);
  for (const [currentId, next] of [['cn', 'us2'], ['us2', 'cn']]) {
    const seats = [quota('cn', currentId === 'cn' ? 0 : 80, { remainingAt: later }), unknown('us'),
      quota('us2', currentId === 'us2' ? 0 : 80, { remainingAt: later })];
    assert.equal(choose({ currentId, state, seats, now: later }).targetId, next);
  }
  const seats = [quota('us2', 0, { remainingAt: resetAt, resetAt: resetAt + 3600_000 }), unknown('us'),
    quota('cn', 80, { remainingAt: resetAt, resetAt: resetAt + 3600_000 })];
  assert.equal(choose({ currentId: 'us2', state, seats, now: resetAt }).targetId, 'cn');
  // A sample from before the reset remains insufficient, even when its advertised reset changes.
  seats[1] = quota('us', 80, { remainingAt: resetAt - 1, resetAt: resetAt + 3600_000, weeklyResetAt: resetAt + 7 * 86400_000 });
  assert.equal(choose({ currentId: 'us2', state, seats, now: resetAt }).targetId, 'cn');
  seats[1] = { ...seats[1], remainingAt: resetAt, weeklyRemainingAt: resetAt };
  assert.equal(choose({ currentId: 'us2', state, seats, now: resetAt }).targetId, 'us');
});
test('a five-hour exhausted seat rejoins only after reset and a fresh sample confirming both windows', () => {
  const resetAt = NOW + 3600_000;
  const state = exhausted({}, 'cn', NOW, resetAt);
  const current = quota('us', 0, { remainingAt: resetAt, resetAt: resetAt + 3600_000 });
  const ready = quota('cn', 80, { remainingAt: resetAt, resetAt: resetAt + 3600_000 });
  for (const seat of [unknown('cn'), { ...ready, remainingAt: resetAt - 1 }, { ...ready, weeklyTrusted: false }]) {
    assert.equal(choose({ state, currentId: 'us', seats: [seat, current], now: resetAt }).targetId, P.CODEX_ID);
  }
  assert.equal(choose({ state, currentId: 'us', seats: [ready, current], now: resetAt }).targetId, 'cn');
});
test('03:51 regression: weekly exhausted US cannot relay to CN on reset expiry without fresh confirmation', () => {
  const at0351 = Date.UTC(2026, 9, 5, 10, 51), cnReset = at0351 - 60_000;
  const usReset = Date.UTC(2026, 9, 9, 10);
  let state = exhausted({}, 'cn', cnReset - 3600_000, cnReset);
  state = exhausted(state, 'us', at0351 - 1000, usReset);
  const seats = [quota('us', 80, { remainingAt: at0351, resetAt: at0351 + 3600_000,
    weeklyRemaining: 0, weeklyResetAt: usReset }),
    quota('cn', 0, { remainingAt: cnReset - 60000, resetAt: cnReset }),
    quota('us2', 0, { remainingAt: at0351, resetAt: at0351 + 3600_000 })];
  assert.equal(choose({ state, currentId: 'us', seats, now: at0351 }).targetId, P.CODEX_ID);
  seats[1] = quota('cn', 100, { remainingAt: at0351, resetAt: at0351 + 5 * 3600_000 });
  assert.equal(choose({ state, currentId: 'us', seats, now: at0351 }).targetId, 'cn');
});
test('an official sample must contain both quota windows before it can prove recovery', () => {
  const current = { ...info, credentialKey: 'cn-current-slot' };
  const official = { provider: 'Claude', scope: 'claude', official: true, seatId: 'cn', configDir: info.configuredDir,
    credentialKey: current.credentialKey, at: NOW,
    windows: [{ key: 'fiveHour', remaining: 80, resetAt: NOW + 3600_000 }] };
  assert.equal(P.seatQuota({ sample: official }, current, NOW).resumedAt, null);
  official.windows.push({ key: 'weekly', remaining: 60, resetAt: NOW + 7 * 86400_000 });
  const result = P.seatQuota({ sample: official }, current, NOW);
  assert.equal(result.weeklyRemainingAt, NOW);
  assert.equal(result.weeklyResetAt, NOW + 7 * 86400_000);
  assert.equal(result.resumedAt, NOW);
});


test('strategy details never promise a switch to unknown or stale quota and retain persisted weekly exclusions', () => {
  const seats = [{ ...quota('us2', 0), name: 'US2' }, { ...unknown('us'), name: 'US' }, { ...quota('cn', 80), name: 'CN' }];
  let text = P.strategyText({ currentId: 'us2', seats, now: NOW });
  assert.match(text, /US 额度未知，等待新采样确认/);
  assert.match(text, /US2 剩 3% 时切到 CN/);
  const state = P.observe({}, { seatId: 'us', at: NOW, weeklyTrusted: true, weeklyRemaining: 0, weeklyResetAt: NOW + 4 * 86400_000 }, NOW);
  text = P.strategyText({ state, currentId: 'us2', seats, now: NOW + P.FRESH_MS + 1 });
  assert.match(text, /US 每周额度不足/);
  assert.match(text, /CN 额度未知，等待新采样确认/);
  assert.doesNotMatch(text, /剩 3% 时切到/);
});
test('native five-hour resumption does not clear a persisted weekly quota lock', () => {
  let state = P.observe({}, { seatId: 'us', at: NOW, weeklyTrusted: true, weeklyRemaining: 0, weeklyResetAt: NOW + 4 * 86400_000 }, NOW);
  state = P.observe(state, { seatId: 'us', at: NOW + 1000, resumed: true }, NOW + 1000);
  assert.equal(state.seats.us.weeklyLowRemaining, 0);
  assert.equal(P.status(unknown('us'), state.seats.us, 3, NOW + 1000).exhausted, true);
});

test('manual choices for the phone: the seat in use, used-up, low and unlogged seats cannot be picked, and each says why', () => {
  const seats = [quota('cn', 40), quota('us', 80), quota('us2', 2), { ...quota('eu', 0), remaining: 0 }, { id: 'jp', loggedIn: false },
    { ...quota('kr', 70), onboardingComplete: false }, unknown('br'), quota('wk', 50, { weeklyRemaining: 1 })];
  const list = P.manualChoices({ currentId: 'cn', seats, codex: { out: false }, now: NOW });
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.deepEqual(list.map((c) => [c.id, c.selectable, c.reason]), [['cn', false, 'current'], ['us', true, ''], ['us2', false, 'low'], ['eu', false, 'exhausted'],
    ['jp', false, 'login'], ['kr', false, 'onboarding'], ['br', true, 'unknown'], ['wk', false, 'low'], ['chatgpt', true, '']]);
  assert.equal(by.cn.current, true);
  assert.equal(list.filter((c) => c.current).length, 1);
  // The time it comes back is the window that ran out: 5 hours, or the week.
  assert.equal(by.eu.recoveryAt, NOW + 3600_000);
  assert.equal(by.wk.weekly, true);
  assert.equal(by.wk.recoveryAt, NOW + 7 * 86400_000);
  assert.equal(by.us.recoveryAt, null);
  // A native rate-limit error blocks a seat even while its last number looked fine.
  const blocked = P.manualChoices({ currentId: 'cn', seats: [quota('cn', 40), quota('us', 80)], state: exhausted({}, 'us', NOW, NOW + 1800_000), now: NOW });
  assert.deepEqual(blocked.map((c) => [c.id, c.selectable, c.reason, c.recoveryAt]), [['cn', false, 'current', null], ['us', false, 'exhausted', NOW + 1800_000]]);
});

test('manual choices include ChatGPT only when asked, refuse it when used up, and mark it when the Captain is on it', () => {
  const seats = [quota('cn', 40), quota('us', 80)];
  assert.equal(P.manualChoices({ currentId: 'cn', seats, now: NOW }).some((c) => c.id === P.CODEX_ID), false);
  const out = P.manualChoices({ currentId: 'cn', seats, codex: { out: true, recoveryAt: NOW + 60_000 }, now: NOW }).find((c) => c.id === P.CODEX_ID);
  assert.deepEqual([out.selectable, out.reason, out.recoveryAt], [false, 'exhausted', NOW + 60_000]);
  const on = P.manualChoices({ currentId: P.CODEX_ID, seats, codex: { out: true }, now: NOW });
  assert.deepEqual(on.map((c) => [c.id, c.current, c.selectable]), [['cn', false, true], ['us', false, true], ['chatgpt', true, false]]);
  // Unlike the automatic rotation, a person's choice ignores the 10-minute cooldown and the on/off switch.
  const cooled = P.recordSwitch({}, { fromId: 'us', targetId: 'cn', at: NOW - 60_000 });
  assert.equal(P.manualChoices({ currentId: 'cn', seats, state: cooled, settings: { enabled: false }, now: NOW }).find((c) => c.id === 'us').selectable, true);
});
