'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('../quota-claude');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');
const Q = require('../quota-core');
const { readLocal } = require('../quota-local');
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quota-claude-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const seat of S.normalize()) {
    const loc = M.credentialLocation(seat, home);
    fs.mkdirSync(loc.dir);
    fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'fake-account-' + seat.id, emailAddress: seat.id + '@example.com' } }));
  }
  return home;
}
const bound = (seat, home, value) => { const loc = M.credentialLocation(seat, home); return { ...value, accountKey: M.usageAccountKey(loc), configDir: loc.dir }; };
const credential = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'fake-never-return-refresh', scopes: ['user:profile'], expiresAt: Date.now() + 3600000 } });
test('each seat reads its own credential store; expired/missing/symlinked auth cannot borrow a login', async (t) => {
  const home = fixture(t), [cn, us] = S.normalize();
  for (const seat of [cn, us]) fs.writeFileSync(M.credentialLocation(seat, home).credentialsPath, credential('fake-' + seat.id));
  assert.equal(await C.readCredentials(cn, home, 'win32'), 'fake-cn');
  assert.equal(await C.readCredentials(us, home, 'win32'), 'fake-us');
  const services = [];
  const keychain = (bin, args, opts, cb) => {
    assert.equal(bin, '/usr/bin/security'); assert.equal(args.at(-1), '-w');
    assert.equal(args[1], '-a'); assert.equal(args[2], os.userInfo().username);
    assert.equal(opts.timeout, 2000); assert.equal(opts.maxBuffer, 65536);
    services.push(args[4]); cb(null, credential('fake-keychain-' + services.length));
  };
  assert.equal(await C.readCredentials(cn, home, 'darwin', keychain), 'fake-keychain-1');
  assert.equal(await C.readCredentials(us, home, 'darwin', keychain), 'fake-keychain-2');
  assert.notEqual(services[0], services[1]);
  const file = M.credentialLocation(us, home).credentialsPath;
  fs.writeFileSync(file, credential('expired').replace(/"expiresAt":\d+/, '"expiresAt":1').replace(',"refreshToken":"fake-never-return-refresh"', ''));
  assert.equal(await C.readCredentials(us, home, 'win32'), null);
  fs.unlinkSync(file);
  fs.symlinkSync(M.credentialLocation(cn, home).credentialsPath, file);
  assert.equal(await C.readSeat(us, home, (seat, root) => C.readCredentials(seat, root, 'win32')), null);
  fs.unlinkSync(file);
  assert.equal(await C.readSeat(us, home, (seat, root) => C.readCredentials(seat, root, 'win32')), null);
});
function transport(status, body, calls, { hang = false, error = false } = {}) {
  return (url, options, callback) => {
    calls.push({ url, options });
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    queueMicrotask(() => {
      if (error) return req.emit('error', new Error('fake-sensitive-error'));
      const res = new EventEmitter(); res.statusCode = status; res.setEncoding = () => {};
      res.destroy = () => { res.destroyed = true; }; callback(res);
      if (!res.destroyed && !hang) { res.emit('data', body); res.emit('end'); }
    });
    return req;
  };
}
test('one pinned HTTPS GET returns only real subscription windows and absolute resets, with no messages', async () => {
  const calls = [], reset = new Date(Date.now() + 3600000).toISOString();
  const body = JSON.stringify({ five_hour: { utilization: 32.5, resets_at: reset }, seven_day: { utilization: 100, resets_at: reset }, extra_usage: { secret: 'fake-never-return' } });
  const usage = await C.requestUsage('fake-access', transport(200, body, calls));
  assert.deepEqual(usage.windows, [{ key: 'fiveHour', remaining: 67.5, resetText: reset }, { key: 'weekly', remaining: 0, resetText: reset }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fake-access');
  assert.equal(calls[0].options.agent, false);
  assert.ok(!JSON.stringify(usage).includes('fake-'));
});
test('official usage preserves only boolean Extra Usage state; missing or nonboolean remains unknown', async () => {
  const reset = new Date(Date.now() + 3600000).toISOString();
  for (const [extra, expected] of [[{ is_enabled: false }, false], [{ is_enabled: true }, true], [undefined, null], [{ is_enabled: 'false' }, null]]) {
    const body = JSON.stringify({ five_hour: { utilization: 20, resets_at: reset }, seven_day: { utilization: 30, resets_at: reset },
      extra_usage: extra && { ...extra, monthly_limit: 12345, used_credits: 54321, secret: 'fake-never-return' } });
    const usage = await C.requestUsage('fake-access', transport(200, body, []));
    assert.equal(usage.extraUsageEnabled, expected);
    assert.ok(!JSON.stringify(usage).includes('12345'));
    assert.ok(!JSON.stringify(usage).includes('54321'));
    assert.ok(!JSON.stringify(usage).includes('fake-'));
  }
});
test('redirect/rate limit/malformed/oversized/timeout/network responses fail closed without retry', async () => {
  for (const [status, body, options] of [[302, '{}'], [403, '{}'], [429, '{}'], [500, '{}'], [200, '{'], [200, '{}'], [200, 'x'.repeat(65537)], [200, '', { hang: true }], [200, '', { error: true }]]) {
    const calls = [];
    assert.equal(await C.requestUsage('fake-access', transport(status, body, calls, options), 10), null);
    assert.equal(calls.length, 1);
  }
  const partial = await C.requestUsage('fake', transport(200, JSON.stringify({ five_hour: { utilization: 50, resets_at: 'fake-secret' }, seven_day: { utilization: 120 } }), []));
  assert.equal(partial, null);
  const reset = new Date(Date.now() + 3600000).toISOString();
  const tiny = await C.requestUsage('fake', transport(200, JSON.stringify({ five_hour: { utilization: 99.999, resets_at: reset }, seven_day: { utilization: 5, resets_at: reset } }), []));
  assert.equal(Math.round(tiny.windows[0].remaining * 10) / 10, 0);
  assert.equal(Q.cacheClaude(tiny, tiny.at).windows[0].exhausted, false);
  // Rounding a non-exhausted value to zero must not invent exhaustion.
  assert.equal(C.officialUsage({ five_hour: { utilization: 99.999, resets_at: reset }, seven_day: { utilization: 5, resets_at: reset } }, S.normalize()[0], 'service', Date.now()).windows[0].exhausted, false);
});
test('idle seats refresh independently every five minutes; failure retains samples and persists no credentials', async (t) => {
  const home = fixture(t), seats = S.normalize();
  let now = Date.now(), fail = false;
  const calls = [];
  const poller = C.createRefresh({ home, getSeats: () => seats, now: () => now, read: async (seat) => {
    calls.push(seat.id);
    if (fail && seat.id === 'us') throw new Error('fake-sensitive-error');
    return bound(seat, home, { windows: [{ key: 'fiveHour', remaining: seat.id === 'cn' ? 25 : 80 }, { key: 'weekly', remaining: 60 }], accessToken: 'fake-never-return' });
  } });
  t.after(() => poller.dispose());
  await poller.tick(); await poller.tick();
  assert.deepEqual(calls, ['cn', 'us', 'us2']);
  now += C.INTERVAL_MS - 1; await poller.tick(); assert.equal(calls.length, 3);
  now++; fail = true; await poller.tick(); assert.deepEqual(calls, ['cn', 'us', 'us2', 'cn', 'us', 'us2']);
  const data = await readLocal(home, undefined, now, seats);
  assert.deepEqual(poller.samples().map(q => [q.seatId, q.windows?.length || 0]), [['cn', 2], ['us', 0], ['us2', 2]]);
  assert.ok(data.every(q => !q.windows?.length || q.accountBound));
  assert.ok(!JSON.stringify(data).includes('fake-'));
  for (const seat of seats) assert.ok(!fs.readFileSync(M.credentialLocation(seat, home).usagePath, 'utf8').includes('fake-'));
  const store = {};
  for (const sample of poller.samples()) Q.observe(store, sample, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[0]).displayLabel, '5h 剩 25% ↻未知 · 7d 剩 60% ↻未知');
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).state, 'unknown');
});
test('refresh coalesces concurrent ticks, does not apply removed seats, and tolerates cache-write failure', async (t) => {
  const home = fixture(t); let seats = S.normalize(), release, reads = 0;
  const poller = C.createRefresh({ home, getSeats: () => seats, read: () => { reads++; return new Promise(r => { release = r; }); }, write: () => { throw new Error('read-only'); } });
  seats = [seats[0]];
  const pending = poller.tick(), concurrent = poller.tick(); assert.equal(reads, 1);
  seats = [S.normalize()[1]]; poller.samples(); release({ windows: [{ key: 'weekly', remaining: 90 }] }); await Promise.all([pending, concurrent]);
  assert.deepEqual(poller.samples(), []);
  poller.dispose(); assert.deepEqual(poller.samples(), []); await poller.tick(); assert.equal(reads, 1);
  const badDisk = C.createRefresh({ home, getSeats: () => seats, read: async (seat) => bound(seat, home, { windows: [{ key: 'weekly', remaining: 90 }] }), write: () => { throw new Error('read-only'); } });
  await badDisk.tick(); assert.equal(badDisk.samples()[0].windows[0].remaining, 90); badDisk.dispose();
});
test('startup keeps real cached windows and concurrent quota readers wait for the first actual result', async (t) => {
  const home = fixture(t), seats = S.normalize(), now = Date.now(), releases = new Map();
  M.writeUsage(seats[0], home, bound(seats[0], home, { at: now - 1000, source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'fiveHour', remaining: 45 }] }));
  const poller = C.createRefresh({ home, getSeats: () => seats, now: () => now, read: (seat) => new Promise(resolve => releases.set(seat.id, resolve)) });
  t.after(() => poller.dispose());
  assert.deepEqual(poller.samples().map(s => [s.seatId, s.windows[0].remaining]), [['cn', 45]]);
  const startup = poller.tick();
  let settled = false;
  const quotaRead = poller.tick().then(() => { settled = true; return poller.samples(); });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(releases.size, 3);
  assert.deepEqual(poller.samples().map(s => [s.seatId, s.windows[0].remaining]), [['cn', 45]]);
  for (const [id, resolve] of releases) resolve(bound(seats.find(s => s.id === id), home, { windows: [{ key: 'fiveHour', remaining: id === 'cn' ? 40 : 80 }, { key: 'weekly', remaining: 60 }] }));
  await startup;
  assert.deepEqual((await quotaRead).map(s => [s.seatId, s.windows.length]), [['cn', 2], ['us', 2], ['us2', 2]]);
});
test('bound server samples retain explicit screen exhaustion; empty and unbound samples have no authority', () => {
  const seat = S.normalize()[0], store = {}, now = Date.now();
  const sample = (at, windows) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows }, at), seatId: seat.id, configDir: seat.configDir, accountKey: 'fake-account', accountBound: true });
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: seat.id, at: now - 1000, source: '会话屏幕', exhausted: true, windows: [] }, now);
  Q.observe(store, sample(now, [{ key: 'weekly', remaining: 60 }]), now);
  assert.equal(Q.summary(store, 'Claude', now, seat).displayLabel, '5h 已用尽 ↻未知 · 7d 剩 60% ↻未知');
  assert.equal(Q.summary(store, 'Claude', now + C.INTERVAL_MS + 1000, seat).state, 'exhausted');
  Q.observe(store, sample(now + 1, []), now + 1);
  assert.equal(Q.summary(store, 'Claude', now + 1, seat).state, 'exhausted');
  Q.observe(store, { ...sample(now + 2, [{ key: 'weekly', remaining: 99 }]), accountBound: false }, now + 2);
  assert.equal(Q.summary(store, 'Claude', now + 2, seat).state, 'exhausted');
  Q.observe(store, sample(now + 3, [{ key: 'weekly', remaining: 0 }]), now + 3);
  assert.equal(Q.summary(store, 'Claude', now + 3, seat).state, 'exhausted');
  assert.equal(Q.summary(store, 'Claude', now + 31 * 60000, seat).state, 'exhausted');
});
test('official numbers remain current between successful polls; rereading an older server sample does not clear a new quota error', () => {
  const store = {}, seat = S.normalize()[0], now = Date.now();
  const api = { ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining: 70 }] }, now), seatId: seat.id, configDir: seat.configDir, accountKey: 'fake-account', accountBound: true };
  Q.observe(store, api, now);
  Q.observe(store, { ...api, at: now + 1000, official: false, source: '会话屏幕', windows: [{ label: '每周', remaining: 55 }] }, now + 1000);
  Q.observe(store, api, now + 1000);
  assert.equal(Q.summary(store, 'Claude', now + 1000, seat).displayLabel, '7d 剩 70% ↻未知');
  Q.observe(store, { ...api, at: now + 2000, official: false, source: '会话屏幕', exhausted: true, windows: [] }, now + 2000);
  Q.observe(store, api, now + 2000);
  assert.equal(Q.summary(store, 'Claude', now + 2000, seat).state, 'exhausted');
  // A newer weekly-only sample cannot prove the 5-hour window has room.
  Q.observe(store, { ...api, at: now + 3000 }, now + 3000);
  assert.equal(Q.summary(store, 'Claude', now + 3000, seat).state, 'exhausted');
  Q.observe(store, { ...api, at: now + 4000, official: false, source: '会话屏幕', windows: [], resumed: true }, now + 4000);
  assert.equal(Q.summary(store, 'Claude', now + 4000, seat).state, 'normal');
});
test('OAuth reads bind a stable account and discard account changes during the request', async (t) => {
  const home = fixture(t), seat = S.normalize()[0], loc = M.credentialLocation(seat, home);
  let calls = 0;
  const credentials = async () => 'fake-token';
  const usage = async () => { calls++; return { at: Date.now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining: 70 }] }; };
  const result = await C.readSeat(seat, home, credentials, usage);
  assert.equal(result.accountKey, M.usageAccountKey(loc));
  assert.equal(result.configDir, loc.dir);
  assert.ok(!JSON.stringify(result).includes('fake-token'));
  assert.equal(await C.readSeat(seat, home, credentials, async () => {
    const value = await usage();
    fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'new-account', emailAddress: 'new@example.com' } }));
    return value;
  }), null);
  const other = S.normalize()[1], otherLoc = M.credentialLocation(other, home);
  fs.copyFileSync(loc.metadataPath, otherLoc.metadataPath);
  const movingSeat = { ...seat };
  assert.equal(await C.readSeat(movingSeat, home, credentials, async () => {
    const value = await usage(); movingSeat.configDir = other.configDir; return value;
  }), null);
  fs.unlinkSync(loc.metadataPath);
  assert.equal(await C.readSeat(seat, home, credentials, usage), null);
  assert.equal(calls, 3);
});
test('OAuth persistence rejects missing identity, old accounts and wrong directories without replacing the cache', async (t) => {
  const home = fixture(t), seat = S.normalize()[0], loc = M.credentialLocation(seat, home);
  const value = bound(seat, home, { at: Date.now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining: 65 }] });
  M.writeUsage(seat, home, value);
  const original = fs.readFileSync(loc.usagePath, 'utf8');
  for (const invalid of [{ ...value, accountKey: undefined }, { ...value, accountKey: 'old-account' }, { ...value, configDir: loc.dir + '-other' }]) {
    assert.throws(() => M.writeUsage(seat, home, invalid));
    assert.equal(fs.readFileSync(loc.usagePath, 'utf8'), original);
  }
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'changed-account' } }));
  assert.throws(() => M.writeUsage(seat, home, value));
  assert.equal(M.readUsage(seat, home), null);
  assert.equal(fs.readFileSync(loc.usagePath, 'utf8'), original);
});
test('polling rechecks identity before exposing samples or persisting an in-flight result', async (t) => {
  const home = fixture(t), seat = S.normalize()[0], loc = M.credentialLocation(seat, home);
  const value = bound(seat, home, { at: Date.now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining: 75 }] });
  let release, writes = 0;
  const poller = C.createRefresh({ home, getSeats: () => [seat], read: () => new Promise(resolve => { release = resolve; }), write: () => { writes++; } });
  t.after(() => poller.dispose());
  const pending = poller.tick();
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'changed-account' } }));
  release(value); await pending;
  assert.equal(writes, 0);
  assert.equal(poller.samples()[0].failureOnly, true);
  assert.equal(poller.samples()[0].windows, undefined);
  const current = bound(seat, home, value);
  const cached = C.createRefresh({ home, getSeats: () => [seat], read: async () => current });
  t.after(() => cached.dispose());
  await cached.tick();
  assert.equal(cached.samples()[0].accountBound, true);
  assert.equal(cached.samples()[0].configDir, seat.configDir);
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'changed-again' } }));
  assert.deepEqual(cached.samples(), []);
});
test('OAuth zeros retain a numeric latch until reset and unbound or mismatched samples cannot clear it', () => {
  const seat = S.normalize()[0], now = Date.now(), store = {};
  const sample = (at, remaining) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining, resetText: new Date(now + 10000).toISOString() }] }, at), seatId: seat.id, accountKey: 'fake-account', configDir: seat.configDir, accountBound: true });
  Q.observe(store, sample(now, 0), now);
  assert.equal(Q.summary(store, 'Claude', now, seat).state, 'exhausted');
  assert.equal(Q.observe(store, { ...sample(now + 1, 70), accountBound: false }, now + 1), false);
  assert.equal(Q.observe(store, { ...sample(now + 2, 70), accountKey: 'other-account' }, now + 2), false);
  assert.equal(Q.observe(store, { ...sample(now + 3, 70), configDir: '~/elsewhere' }, now + 3), false);
  assert.equal(Q.summary(store, 'Claude', now + 3, seat).state, 'exhausted');
  assert.equal(Q.summary(store, 'Claude', now + 10000, seat).state, 'danger');
  Q.observe(store, { ...sample(now + 10000, 70), identityOnly: true }, now + 10000);
  assert.equal(store[Q.seatKey(seat.id)].blocked, undefined);
});

test('display after three consecutive failures retains last remaining percentages, resets and sample time across restart', async (t) => {
  const home = fixture(t), seat = S.normalize()[0];
  let time = Date.now(), failed = false;
  const sampledAt = time, reset5h = new Date(time + 2 * 3600000).toISOString(), reset7d = new Date(time + 4 * 86400000).toISOString();
  const api = { five_hour: { utilization: 9, resets_at: reset5h }, seven_day: { utilization: 10, resets_at: reset7d } };
  const poller = C.createRefresh({ home, getSeats: () => [seat], now: () => time, read: async () => {
    if (failed) throw new Error('fake-secret');
    return bound(seat, home, { windows: C.officialUsage(api, seat, 'offline-service', time).windows });
  } });
  t.after(() => poller.dispose());
  let store = {};
  const read = async () => { await poller.tick(); for (const sample of poller.samples()) Q.observe(store, sample, time); };
  await read();
  const before = Q.summary(store, 'Claude', time, seat), windows = structuredClone(store[Q.seatKey(seat.id)].sample.windows);
  assert.match(before.displayLabel, /5h 剩 91% ↻.* · 7d 剩 90% ↻/);
  failed = true;
  for (let failures = 1; failures <= 3; failures++) {
    time += C.INTERVAL_MS; await read();
    // The old statusline prints remaining, and cannot replace this official sample.
    const footer = Q.screen('Claude', '', ['5h 91% ↻02:50 · 7d 90% ↻10-07 03:00'], time);
    Q.observe(store, { ...footer, seatId: seat.id, configDir: seat.configDir }, time);
    Q.observe(store, { ...Q.cacheClaude({ sessionUsage: 80, weeklyUsage: 90 }, time), seatId: seat.id, configDir: seat.configDir, accountBound: true, accountKey: store[Q.seatKey(seat.id)].accountKey }, time);
    assert.equal(store[Q.seatKey(seat.id)].sample.at, sampledAt);
    assert.deepEqual(store[Q.seatKey(seat.id)].sample.windows, windows);
    assert.equal(Q.summary(store, 'Claude', time, seat).displayLabel, before.displayLabel);
  }
  store = JSON.parse(JSON.stringify(store));
  for (const display of [Q.summary(store, 'Claude', time, seat), Q.summary(store, 'Claude', time + 3 * 86400000, seat)]) {
    assert.equal(display.displayLabel, before.displayLabel);
    assert.match(display.sampleLabel, /采样.*数据已旧/);
    assert.match(display.detail, /连续 3 次.*保留上次成功采样（数据已旧）/);
    assert.ok(display.detail.includes(new Date(sampledAt).toLocaleString()));
  }
  assert.match(Q.text(store, time, [seat]), /5h 剩 91% ↻.*7d 剩 90% ↻.*数据已旧/);
  assert.doesNotMatch(Q.text(store, time, [seat]), /5h 剩 9%|7d 剩 10%|fake-secret/);
  failed = false; time += C.INTERVAL_MS; await read();
  assert.equal(store[Q.seatKey(seat.id)].officialStatus.failures, 0);
  assert.equal(store[Q.seatKey(seat.id)].sample.at, time);
  assert.doesNotMatch(Q.summary(store, 'Claude', time, seat).sampleLabel, /数据已旧/);
});

test('forced refresh targets one seat; normal polling includes CN and coalesces duplicate credential directories', async (t) => {
  const home = fixture(t), seats = S.normalize(), calls = [];
  let time = Date.now();
  const poller = C.createRefresh({ home, getSeats: () => seats, now: () => time, read: async (seat) => {
    calls.push(seat.id);
    return bound(seat, home, { windows: [{ key: 'fiveHour', remaining: 53 }, { key: 'weekly', remaining: 87 }] });
  } });
  t.after(() => poller.dispose());
  await Promise.all([poller.tick(), poller.tick()]);
  assert.deepEqual(calls, ['cn', 'us', 'us2']);
  await poller.tick(); assert.equal(calls.length, 3);
  time++;
  await poller.tick({ force: true, seatId: 'cn' }); assert.deepEqual(calls, ['cn', 'us', 'us2', 'cn']);
  const duplicates = C.createRefresh({ home, getSeats: () => [seats[0], { ...seats[1], configDir: seats[0].configDir }], read: async (seat) => {
    calls.push(seat.id);
    return bound(seat, home, { windows: [{ key: 'fiveHour', remaining: 53 }] });
  } });
  t.after(() => duplicates.dispose());
  await duplicates.tick();
  assert.deepEqual(duplicates.samples().map(s => s.seatId), ['cn', 'us2']);
  assert.deepEqual(calls, ['cn', 'us', 'us2', 'cn', 'cn', 'us2']);
});

function expiredCredential(extra = {}) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'expired-access', refreshToken: 'fake-refresh-token', scopes: ['user:inference', 'user:profile'],
      expiresAt: 1, refreshTokenExpiresAt: Date.now() + 86400000, subscriptionType: 'pro', ...extra },
    mcpOAuth: { keep: 'yes' },
  });
}
function refreshResponse(over = {}) {
  return { access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token', expires_in: 28800,
    refresh_token_expires_in: 86400 * 30, scope: 'user:inference user:profile', ...over };
}
test('only an explicit usage authentication rejection reports logout; success proves login', async () => {
  const rejected = await C.requestUsage('fake-access', transport(401, '{"secret":"fake-never-return"}', []));
  assert.equal(rejected.authStatus, 'logged-out');
  assert.ok(!JSON.stringify(rejected).includes('fake-'));
  const reset = new Date(Date.now() + 3600000).toISOString();
  const success = await C.requestUsage('fake-access', transport(200, JSON.stringify({ five_hour: { utilization: 10, resets_at: reset }, seven_day: { utilization: 20, resets_at: reset } }), []));
  assert.equal(success.authStatus, 'logged-in');
});

test('credential absence, unusable expired credentials and a refused renewal report logout; read failures and network errors do not', async (t) => {
  const home = fixture(t), seat = S.normalize()[1], loc = M.credentialLocation(seat, home);
  const signals = [], deps = { onAuth: (status) => signals.push(status) };
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, deps), null);
  assert.deepEqual(signals.splice(0), ['logged-out']);
  assert.equal(await C.readCredentials(seat, home, 'darwin', (_bin, _args, _options, cb) => cb({ code: 36 }), deps), null);
  assert.deepEqual(signals, []);
  assert.equal(await C.readCredentials(seat, home, 'darwin', (_bin, _args, _options, cb) => cb({ code: 44 }), deps), null);
  assert.deepEqual(signals.splice(0), ['logged-out']);
  fs.writeFileSync(loc.credentialsPath, '{');
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, deps), null);
  assert.deepEqual(signals, []);
  fs.writeFileSync(loc.credentialsPath, expiredCredential({ refreshToken: undefined }));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, deps), null);
  assert.deepEqual(signals.splice(0), ['logged-out']);
  fs.writeFileSync(loc.credentialsPath, expiredCredential());   // the CLI on this seat can still renew it
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, deps), null);
  assert.deepEqual(signals, []);
  fs.writeFileSync(loc.credentialsPath, expiredCredential({ refreshTokenExpiresAt: 1 }));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, deps), null);
  assert.deepEqual(signals.splice(0), ['logged-out']);
  // renewing on a free seat: a refused refresh token is a logout, a network failure is not
  fs.writeFileSync(loc.credentialsPath, expiredCredential());
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { ...deps, exclusive: (fn) => fn(), post: async () => null }), null);
  assert.deepEqual(signals, []);
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { ...deps, exclusive: (fn) => fn(), post: async () => ({ authStatus: 'logged-out' }) }), null);
  assert.deepEqual(signals.splice(0), ['logged-out']);
});

test('readSeat exposes credential logout even after account metadata is removed, without mistaking a custom null result', async (t) => {
  const home = fixture(t), seat = S.normalize()[1], loc = M.credentialLocation(seat, home);
  fs.unlinkSync(loc.metadataPath);
  const read = (item, root, _platform, _exec, deps) => C.readCredentials(item, root, 'win32', undefined, deps);
  const value = await C.readSeat(seat, home, read, async () => { throw new Error('must not query without credentials'); });
  assert.equal(value.authStatus, 'logged-out');
  assert.equal(value.configDir, loc.dir);
  assert.equal(await C.readSeat(seat, home, async () => null), null);
});

test('refresh reports one auth observation per real poll; caches and concurrent readers produce no extra proof', async (t) => {
  const home = fixture(t), seat = S.normalize()[1], loc = M.credentialLocation(seat, home);
  let now = Date.now(), mode = 'success';
  const signals = [];
  const poller = C.createRefresh({ home, getSeats: () => [seat], now: () => now, onSample: (sample) => signals.push(sample), read: async () => {
    if (mode === 'unknown') return null;
    if (mode === 'logout') return { authStatus: 'logged-out', configDir: loc.dir };
    return bound(seat, home, { windows: [{ key: 'weekly', remaining: 80 }] });
  } });
  t.after(() => poller.dispose());
  await Promise.all([poller.tick(), poller.tick()]);
  assert.deepEqual(signals.map(s => s.authStatus), ['logged-in']);
  poller.samples(); poller.samples(); await poller.tick();
  assert.equal(signals.length, 1);
  assert.equal(poller.samples()[0].authStatus, undefined);
  for (const state of ['logout', 'unknown', 'logout', 'success']) {
    mode = state; now += C.INTERVAL_MS; await poller.tick();
  }
  assert.deepEqual(signals.map(s => s.authStatus), ['logged-in', 'logged-out', undefined, 'logged-out', 'logged-in']);
  assert.equal(signals[1].failureOnly, true);
  assert.equal(signals[1].checkedAt, signals[1].at);
  assert.notEqual(signals[1].failure, '未登录');
});

// Renewal goes through the seat gate (main.js: createSeatGate with the warm-up's process inventory).
const free = (fn) => fn();          // no Claude runs on the seat
const busy = async () => null;      // a Claude runs on it: the gate refuses

test('an expired token is renewed only when no Claude runs on its seat; with one running it is only read', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), loc = M.credentialLocation(seat, home);
  const raw = expiredCredential(), posts = [], writes = [], signals = [];
  const post = async (body) => { posts.push(body); return refreshResponse(); };
  const spawn = (bin, args) => { writes.push(args); const child = new EventEmitter(); child.stdin = { write() { return true; }, end() {} }; child.kill = () => {}; queueMicrotask(() => child.emit('close', 0)); return child; };
  const keychain = (_bin, _args, _opts, cb) => cb(null, raw);
  fs.writeFileSync(loc.credentialsPath, raw);
  // a Claude runs on the seat (the gate says no), or no gate at all: read only, the CLI renews its own token
  for (const deps of [{ post, spawn, exclusive: busy }, { post, spawn }]) {
    assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { ...deps, onAuth: (s) => signals.push(s) }), null);
    assert.equal(await C.readCredentials(seat, home, 'darwin', keychain, { ...deps, onAuth: (s) => signals.push(s) }), null);
  }
  assert.equal(fs.readFileSync(loc.credentialsPath, 'utf8'), raw);
  assert.deepEqual([posts.length, writes.length, signals], [0, 0, []]);
  // nothing runs on the seat: renewed once and written back
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, spawn, exclusive: free }), 'fresh-access-token');
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(loc.credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'fresh-access-token');
  // a token the seat's own CLI renewed while the gate was waited for is used as it is
  C.clearCredentialCache();
  fs.writeFileSync(loc.credentialsPath, raw);
  const late = async (fn) => { fs.writeFileSync(loc.credentialsPath, credential('renewed-by-cli')); return fn(); };
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, spawn, exclusive: late }), 'renewed-by-cli');
  assert.equal(posts.length, 1);
});

test('the seat gate renews only a free seat, and a renewal never overlaps AgentDeck starting Claude on that seat', async () => {
  const log = []; let busySeat = false;
  const gate = C.createSeatGate({ occupied: async (seat) => { log.push('check ' + seat.id); return busySeat; } });
  const us2 = { id: 'us2' };
  assert.equal(await gate.renew(us2, async () => 'renewed'), 'renewed');
  busySeat = true;
  assert.equal(await gate.renew(us2, async () => { log.push('must not run'); return 'renewed'; }), null);
  assert.ok(!log.includes('must not run'));
  busySeat = false;
  // a renewal in progress holds a launch on the same seat until it is written; another seat goes on
  let release; const writing = new Promise((resolve) => { release = resolve; });
  log.length = 0;
  const renewal = gate.renew(us2, async () => { log.push('renew'); await writing; log.push('written'); return 'ok'; });
  const launch = gate.launch('us2', async () => log.push('launch us2'));
  await gate.launch('cn', async () => log.push('launch cn'));
  await new Promise(setImmediate);
  assert.deepEqual([...log].sort(), ['check us2', 'launch cn', 'renew'].sort());
  assert.ok(!log.includes('launch us2'), 'the us2 launch waits for the renewal');
  release();
  await Promise.all([renewal, launch]);
  assert.deepEqual(log.slice(-2), ['written', 'launch us2']);
  // a Claude AgentDeck is starting (the quota warm-up) holds a renewal, whose seat check comes after it
  let finish; const running = new Promise((resolve) => { finish = resolve; });
  log.length = 0;
  const warmup = gate.launch('us2', async () => { log.push('warm-up'); await running; log.push('warm-up done'); });
  const after = gate.renew(us2, async () => { log.push('renew'); return 'ok'; });
  await new Promise(setImmediate);
  assert.deepEqual(log, ['warm-up']);
  finish();
  await Promise.all([warmup, after]);
  assert.deepEqual(log, ['warm-up', 'warm-up done', 'check us2', 'renew']);
  // a failed step does not jam the seat
  await assert.rejects(gate.launch('us2', async () => { throw new Error('boom'); }));
  assert.equal(await gate.renew(us2, async () => 'still works'), 'still works');
});

test('an idle seat refreshes an expired access token once and rewrites only that credential file', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), loc = M.credentialLocation(seat, home);
  const other = M.credentialLocation(S.normalize()[0], home), untouched = credential('cn-stays');
  fs.writeFileSync(loc.credentialsPath, expiredCredential());
  fs.writeFileSync(other.credentialsPath, untouched);
  const posts = [], now = 1_700_000_000_000;
  const post = async (body) => { posts.push(body); return refreshResponse(); };
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, now: () => now, exclusive: free }), 'fresh-access-token');
  assert.deepEqual(posts.map((body) => body.grant_type), ['refresh_token']);
  assert.equal(posts[0].refresh_token, 'fake-refresh-token');
  assert.equal(posts[0].client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(posts[0].scope, 'user:inference user:profile');
  const saved = JSON.parse(fs.readFileSync(loc.credentialsPath, 'utf8'));
  assert.equal(saved.claudeAiOauth.accessToken, 'fresh-access-token');
  assert.equal(saved.claudeAiOauth.refreshToken, 'rotated-refresh-token');
  assert.equal(saved.claudeAiOauth.expiresAt, now + 28800000);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'pro');
  assert.equal(saved.mcpOAuth.keep, 'yes');
  // Windows has no group/other permission bits (stat reports 0o666, or 0o444 when
  // read-only; access is by ACL inherited from the profile folder), so there the
  // check is that the rewritten file is still a normal writable file.
  const mode = fs.statSync(loc.credentialsPath).mode & 0o777;
  if (process.platform === 'win32') assert.equal(mode & 0o200, 0o200);
  else assert.equal(mode, 0o600);
  assert.equal(fs.readFileSync(other.credentialsPath, 'utf8'), untouched);
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, now: () => now + 1000, exclusive: free }), 'fresh-access-token');
  assert.equal(posts.length, 1);
});
test('a dead refresh token, a rejected refresh, or another account leaves the stored credential unchanged', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), loc = M.credentialLocation(seat, home);
  const posts = [];
  const post = async (body) => { posts.push(body); return null; };
  fs.writeFileSync(loc.credentialsPath, expiredCredential({ refreshTokenExpiresAt: 1 }));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, exclusive: free }), null);
  assert.equal(posts.length, 0);
  const rejected = expiredCredential();
  fs.writeFileSync(loc.credentialsPath, rejected);
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, exclusive: free }), null);
  assert.equal(fs.readFileSync(loc.credentialsPath, 'utf8'), rejected);
  assert.equal(posts.length, 1);
  const mismatch = async () => refreshResponse({ account: { uuid: 'someone-else' } });
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post: mismatch, exclusive: free }), null);
  assert.equal(fs.readFileSync(loc.credentialsPath, 'utf8'), rejected);
  fs.writeFileSync(loc.credentialsPath, credential('still-valid'));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post: mismatch, exclusive: free }), 'still-valid');
});
test('darwin keychain refresh passes the secret on stdin and keeps a rotated token in memory if the write fails', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), raw = expiredCredential();
  const keychain = (bin, args, opts, cb) => { assert.equal(bin, '/usr/bin/security'); assert.equal(args.at(-1), '-w'); cb(null, raw); };
  const writes = [], posts = [];
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.stdin = { write(chunk) { child.stdin.text = (child.stdin.text || '') + chunk; return true; }, end() {} };
    child.kill = () => {};
    writes.push({ bin, args, child });
    queueMicrotask(() => child.emit('close', 1));
    return child;
  };
  const token = await C.readCredentials(seat, home, 'darwin', keychain, {
    post: async () => { posts.push('refresh'); return refreshResponse(); }, spawn: spawnImpl, exclusive: free,
  });
  assert.equal(token, 'fresh-access-token');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bin, '/usr/bin/security');
  assert.deepEqual(writes[0].args.slice(0, 2).concat(writes[0].args.slice(3)), ['add-generic-password', '-a', '-s', M.credentialLocation(seat, home).keychainService, '-U', '-w']);
  assert.equal(writes[0].args.includes('fresh-access-token') || writes[0].args.includes('rotated-refresh-token'), false);
  const stored = writes[0].child.stdin.text;
  assert.equal(stored, stored.split('\n')[0] + '\n' + stored.split('\n')[0] + '\n');
  assert.equal(JSON.parse(stored.split('\n')[0]).claudeAiOauth.refreshToken, 'rotated-refresh-token');
  assert.equal(JSON.parse(stored.split('\n')[0]).mcpOAuth.keep, 'yes');
  assert.equal(fs.existsSync(M.credentialLocation(seat, home).credentialsPath), false);
  assert.equal(await C.readCredentials(seat, home, 'darwin', keychain, {
    post: async () => { posts.push('refresh'); return refreshResponse(); }, spawn: spawnImpl, exclusive: free,
  }), 'fresh-access-token');
  assert.deepEqual(posts, ['refresh']);
  assert.equal(writes.length, 2);
});
test('token refresh posts only to the pinned Claude Code token URL and drops auth and rate-limit bodies', async () => {
  const calls = [];
  const transport = (status, body) => (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = (payload) => {
      calls.push({ url, options, payload });
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = status; res.setEncoding = () => {}; res.destroy = () => { res.destroyed = true; };
        callback(res);
        if ([200, 400].includes(status) && !res.destroyed) { res.emit('data', body); res.emit('end'); }
      });
    };
    return req;
  };
  const ok = await C.postRefresh({ grant_type: 'refresh_token', refresh_token: 'fake-refresh-token' }, transport(200, JSON.stringify({ access_token: 'fresh-access-token', expires_in: 10 })));
  assert.equal(ok.access_token, 'fresh-access-token');
  assert.equal(calls[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.agent, false);
  assert.equal(JSON.parse(calls[0].payload).refresh_token, 'fake-refresh-token');
  assert.deepEqual(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(401, '{"error":"invalid_grant","refresh_token":"fake-never-return"}')), { authStatus: 'logged-out' });
  assert.deepEqual(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(400, '{"error":"invalid_grant","refresh_token":"fake-never-return"}')), { authStatus: 'logged-out' });
  assert.equal(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(400, '{"error":"invalid_request"}')), null);
  assert.equal(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(429, '{"error":"rate_limited"}')), null);
  assert.equal(calls.length, 5);
  assert.ok(!JSON.stringify(ok).includes('fake-refresh-token'));
});

// ---- a signed-in account with no running 5-hour window (US2 shown as 未登录 after signing in) ----
test('a usage answer without a 5-hour reset time is still an answer: windows it has are kept, nothing is invented', async (t) => {
  const seat = S.normalize()[2], now = Date.now(), weekly = new Date(now + 4 * 86400000).toISOString();
  // Just signed in, not used yet: the 5-hour window has not started, so it has no reset time.
  const fresh = C.officialUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 12, resets_at: weekly } }, seat, 'service', now);
  assert.deepEqual(fresh.windows.map((w) => [w.key, w.remaining, w.resetAt, w.resetText]), [['fiveHour', 100, null, ''], ['weekly', 88, Date.parse(weekly), weekly]]);
  // No 5-hour window at all: the weekly one is still shown.
  for (const five_hour of [null, undefined, { utilization: null, resets_at: null }]) {
    const partial = C.officialUsage({ five_hour, seven_day: { utilization: 12, resets_at: weekly } }, seat, 'service', now);
    assert.deepEqual(partial.windows.map((w) => w.key), ['weekly']);
  }
  // Neither window: no numbers, but not an error.
  assert.deepEqual(C.officialUsage({ five_hour: null, seven_day: null }, seat, 'service', now).windows, []);
  // Still refused: not a usage answer at all, an impossible percentage, or a reset time that is not a time.
  for (const bad of [{}, null, 'x', { five_hour: { utilization: 120, resets_at: null }, seven_day: null }, { five_hour: { utilization: 'many' }, seven_day: null },
    { five_hour: { utilization: 5, resets_at: 'soon' }, seven_day: null }, { five_hour: { resets_at: weekly }, seven_day: null }]) {
    assert.throws(() => C.officialUsage(bad, seat, 'service', now), /invalid-usage/);
  }
  const usage = await C.requestUsage('fake-access', transport(200, JSON.stringify({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 12, resets_at: weekly } }), []));
  assert.equal(usage.authStatus, 'logged-in');
  assert.deepEqual(usage.windows, [{ key: 'fiveHour', remaining: 100, resetText: '' }, { key: 'weekly', remaining: 88, resetText: weekly }]);
  const none = await C.requestUsage('fake-access', transport(200, JSON.stringify({ five_hour: null, seven_day: null }), []));
  assert.equal(none.authStatus, 'logged-in'); assert.deepEqual(none.windows, []);
  // The numbers survive the trip to the sidebar: 5h 100% with an unknown reset, never 未登录 or 已用尽.
  const store = {}, home = fixture(t), loc = M.credentialLocation(seat, home);
  const sample = { ...Q.cacheClaude({ ...usage, source: Q.CLAUDE_OAUTH_SOURCE }, now), seatId: seat.id, configDir: seat.configDir, accountKey: M.usageAccountKey(loc), credentialKey: 'key', accountBound: true, official: true };
  assert.equal(Q.observe(store, sample, now), true);
  const row = Q.summary(store, 'Claude', now, seat);
  assert.equal(row.authStatus, undefined); assert.equal(row.out, false); assert.equal(row.fiveHour, 100); assert.equal(row.weekly, 88);
  assert.deepEqual(row.cells.map((c) => [c.key, c.remaining, c.resetAt]), [['5h', 100, null], ['7d', 88, Date.parse(weekly)]]);
});
test('a seat that answers without any quota number is proven signed in, so its 未登录 clears', async (t) => {
  const { createSeatAuthMonitor, CONFIRM_MS } = require('../seat-auth-alert');
  const home = fixture(t), seat = S.normalize()[2], loc = M.credentialLocation(seat, home);
  let now = Date.now(), mode = 'out';
  const statuses = [];
  const monitor = createSeatAuthMonitor({ home, platform: 'darwin', saveState: () => {}, onStatus: (s) => statuses.push(s.authStatus) });
  const poller = C.createRefresh({ home, getSeats: () => [seat], now: () => now, onSample: (sample) => monitor.observe(seat, sample), read: async () => {
    if (mode === 'out') return { authStatus: 'logged-out', configDir: loc.dir, at: now };
    if (mode === 'network') return null;
    // Signed in again, the account has not been used yet: HTTP 200, no window to show.
    return bound(seat, home, { at: now, source: Q.CLAUDE_OAUTH_SOURCE, windows: [], authStatus: 'logged-in' });
  } });
  t.after(() => poller.dispose());
  const state = () => monitor.samples().find((s) => s.seatId === seat.id)?.authStatus;
  await poller.tick(); now += CONFIRM_MS + C.INTERVAL_MS; await poller.tick();
  assert.equal(state(), 'logged-out');
  // A failed query proves nothing either way.
  mode = 'network'; now += C.INTERVAL_MS; await poller.tick();
  assert.equal(state(), 'logged-out');
  // The service accepts the seat's token but has no numbers yet: signed in.
  mode = 'unused'; now += C.INTERVAL_MS; await poller.tick();
  assert.equal(state(), 'logged-in');
  assert.deepEqual(statuses, ['logged-out', 'logged-in']);
  // What the row is told meanwhile: no numbers yet, and not a network failure.
  const [failure] = poller.samples();
  assert.equal(failure.failureOnly, true); assert.equal(failure.authStatus, undefined);
  assert.match(failure.failure, /已登录/); assert.doesNotMatch(failure.failure, /查询失败/);
  // An answer for another directory is not this seat's proof.
  const other = createSeatAuthMonitor({ home, platform: 'darwin', saveState: () => {} });
  let clock = Date.now(), step = 0;
  const stray = C.createRefresh({ home, getSeats: () => [seat], now: () => clock, onSample: (sample) => other.observe(seat, sample),
    read: async () => step++ < 2 ? { authStatus: 'logged-out', configDir: loc.dir } : { windows: [], authStatus: 'logged-in', configDir: loc.dir + '-other', accountKey: M.usageAccountKey(loc) } });
  t.after(() => stray.dispose());
  await stray.tick(); clock += CONFIRM_MS + C.INTERVAL_MS; await stray.tick(); clock += C.INTERVAL_MS; await stray.tick();
  assert.equal(other.samples()[0].authStatus, 'logged-out');
});
