const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, createQuotaLowBark } = require('../quota-low-bark');
const NOW = Date.parse('2026-10-04T12:00:00Z');
function harness(state = {}, sendBark) {
  const config = { barkKeyFile: '/private/key', claudeSeats: [
    { id: 'cn', name: 'CN', configDir: '/cn' }, { id: 'us', name: 'US', configDir: '/us' },
  ], quotas: {} }, calls = [], writes = [];
  const check = createQuotaLowBark({ state, saveState: (s) => writes.push(JSON.parse(JSON.stringify(s))),
    sendBark: (alert) => { calls.push(alert); return sendBark ? sendBark(alert) : Promise.resolve({ ok: true }); } });
  const sample = (remaining, { id = 'cn', at = NOW, resetAt = NOW + 3600000, label = '5 小时', accountKey = 'hash-' + id } = {}) => {
    config.quotas[`Claude:${id}`] = { scope: 'claude', configDir: `/${id}`, accountKey,
      sample: { at, accountBound: true, accountKey, configDir: `/${id}`, windows: [{ label, remaining, resetAt }] } };
  };
  return { config, state, calls, writes, sample, check: (now = NOW) => check(config, now) };
}
test('inclusive threshold alerts each CN/US seat, names account/reset and leaves volume to shared policy', async () => {
  const h = harness(); h.sample(2.1); await h.check(); assert.equal(h.calls.length, 0);
  h.sample(2, { at: NOW + 1 }); h.sample(0, { id: 'us' }); await h.check();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].message, /CN.*5 小时.*剩余 2%.*重置时间/);
  assert.match(h.calls[1].message, /US.*剩余 0%/);
  assert.equal(h.calls[0].volume, undefined);
});
test('dedup survives repeated samples, restart, unknown data and learning identity', async () => {
  const h = harness(); h.sample(2); await h.check(); await h.check();
  h.sample(1, { at: NOW + 1 }); await h.check();
  delete h.config.quotas['Claude:cn']; await h.check();
  h.sample(1, { at: NOW + 2, accountKey: 'hash-cn' }); await h.check();
  assert.equal(h.calls.length, 1);
  const restarted = harness(h.writes.at(-1));
  restarted.sample(0, { at: NOW + 3, accountKey: 'hash-cn' }); await restarted.check();
  assert.equal(restarted.calls.length, 0);
});
test('only a newer recovery above threshold rearms, including after restart', async () => {
  const h = harness(); h.sample(1); await h.check();
  h.sample(2, { at: NOW + 1 }); await h.check(); assert.equal(h.calls.length, 1);
  h.sample(50, { at: NOW - 1 }); await h.check(); // Stale recovery cannot rearm.
  h.sample(2, { at: NOW + 2 }); await h.check(); assert.equal(h.calls.length, 1);
  h.sample(100, { at: NOW + 3 }); await h.check();
  const restarted = harness(h.writes.at(-1));
  restarted.sample(2, { at: NOW + 4 }); await restarted.check();
  assert.equal(restarted.calls.length, 1);
});
test('reset rearms on a post-reset sample, without a high sample in between', async () => {
  const h = harness(), resetAt = NOW + 1000;
  h.sample(1, { resetAt }); await h.check();
  await h.check(NOW + 1001); assert.equal(h.calls.length, 1); // Old window expired.
  h.sample(1, { at: NOW + 1002, resetAt: NOW + 5 * 3600000 }); await h.check(NOW + 1002);
  assert.equal(h.calls.length, 2); await h.check(NOW + 1003); assert.equal(h.calls.length, 2);
});
test('relative reset drift and first discovery of reset time do not send again', async () => {
  const h = harness(); h.sample(2, { resetAt: null }); await h.check();
  h.sample(1, { at: NOW + 1 }); await h.check();
  h.sample(0, { at: NOW + 2, resetAt: NOW + 3600002 }); await h.check();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state['account:hash-cn'].resetAt, NOW + 3600000);
});
test('unknown, malformed, weekly-only, stale, future and expired samples never send', async () => {
  for (const remaining of [null, undefined, NaN, -1, 101, '2']) {
    const h = harness(); h.sample(remaining); await h.check(); assert.equal(h.calls.length, 0);
  }
  for (const options of [{ label: '每周' }, { at: NOW - 16 * 60000 }, { at: NOW + 60001 },
    { resetAt: NOW }, { at: NaN }]) {
    const h = harness(); h.sample(0, options); await h.check(); assert.equal(h.calls.length, 0);
  }
  const h = harness(); await h.check(); assert.equal(h.calls.length, 0);
  h.sample(1); h.config.quotas['Claude:cn'].configDir = '/other'; await h.check(); assert.equal(h.calls.length, 0);
});
test('missing reset still alerts once; missing key does not consume the alert', async () => {
  const h = harness(); h.sample(0, { resetAt: null }); h.config.barkKeyFile = '';
  await h.check(); assert.equal(h.writes.length, 0);
  h.config.barkKeyFile = '/private/key'; await h.check(); await h.check();
  assert.equal(h.calls.length, 1); assert.doesNotMatch(h.calls[0].message, /重置时间/);
});
test('account changes are independent; two seats of one known account deduplicate', async () => {
  const h = harness(); h.sample(1, { accountKey: 'a' }); h.sample(1, { id: 'us', accountKey: 'a' });
  await h.check(); assert.equal(h.calls.length, 1);
  h.sample(1, { accountKey: 'b' }); await h.check(); assert.equal(h.calls.length, 2);
  h.sample(1, { accountKey: 'a' }); await h.check(); assert.equal(h.calls.length, 2);
});
test('persist before network; in-flight and unsuccessful deliveries never flood retries', async () => {
  let finish;
  const h = harness({}, () => new Promise((resolve) => { finish = resolve; }));
  h.sample(2); const pending = h.check();
  assert.equal(h.writes[0]['account:hash-cn'].notified, true);
  await h.check(); assert.equal(h.calls.length, 1);
  finish({ ok: false }); await pending; await h.check(); assert.equal(h.calls.length, 1);
});
test('failed persistence prevents network sends', () => {
  const h = harness(); h.sample(2);
  const check = createQuotaLowBark({ saveState: () => { throw new Error('disk full'); },
    sendBark: () => assert.fail('must not send without a durable latch') });
  assert.throws(() => check(h.config, NOW), /disk full/);
});
test('settings defaults and explicit overrides', async () => {
  assert.deepEqual(settings(), { thresholdPercent: 2 });
  assert.deepEqual(settings({ thresholdPercent: -2, volume: 11 }), settings());
  const h = harness(); h.config.claudeQuotaAlert = { thresholdPercent: 5, volume: 1 };
  h.sample(5); await h.check(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].volume, undefined);
});

test('configured seats never alert or rearm from unbound, missing or mismatched identity and directory', async () => {
  const mutations = [
    (entry) => { delete entry.sample.accountBound; },
    (entry) => { entry.sample.accountBound = false; },
    (entry) => { delete entry.sample.accountKey; },
    (entry) => { delete entry.accountKey; },
    (entry) => { entry.sample.accountKey = 'other-account'; },
    (entry) => { entry.sample.configDir = '/other'; },
    (entry) => { delete entry.sample.configDir; },
  ];
  for (const mutate of mutations) {
    const h = harness(); h.sample(1); mutate(h.config.quotas['Claude:cn']);
    await h.check(); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
    h.sample(1); await h.check(); assert.equal(h.calls.length, 1);
    const before = JSON.stringify(h.state);
    h.sample(90, { at: NOW + 1 }); mutate(h.config.quotas['Claude:cn']);
    await h.check(); assert.equal(JSON.stringify(h.state), before);
    h.sample(1, { at: NOW + 2 }); await h.check(); assert.equal(h.calls.length, 1);
  }
});
test('learning a proven account identity migrates an existing directory latch without alerting twice', async () => {
  const h = harness({ 'seat:/cn': { at: NOW - 1, resetAt: NOW + 3600000, notified: true } });
  h.sample(1); await h.check();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state['seat:/cn'], undefined);
  assert.equal(h.state['account:hash-cn'].notified, true);
});
test('bound OAuth samples use the same thirty-minute freshness as quota summaries', async () => {
  const h = harness(); h.sample(1, { at: NOW - 20 * 60000 });
  h.config.quotas['Claude:cn'].sample.source = 'Claude OAuth usage';
  await h.check(); assert.equal(h.calls.length, 1);
  const expired = harness(); expired.sample(1, { at: NOW - 31 * 60000 });
  expired.config.quotas['Claude:cn'].sample.source = 'Claude OAuth usage';
  await expired.check(); assert.equal(expired.calls.length, 0);
});
