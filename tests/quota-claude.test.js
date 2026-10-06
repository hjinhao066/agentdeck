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
test('redirect/auth/rate limit/malformed/oversized/timeout/network responses fail closed without retry', async () => {
  for (const [status, body, options] of [[302, '{}'], [401, '{}'], [429, '{}'], [200, '{'], [200, '{}'], [200, 'x'.repeat(65537)], [200, '', { hang: true }], [200, '', { error: true }]]) {
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
  assert.equal(Q.summary(store, 'Claude', now, seats[0]).displayLabel, '5h 25% ↻未知 · 7d 60% ↻未知');
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
  assert.equal(Q.summary(store, 'Claude', now, seat).displayLabel, '5h 已用尽 ↻未知 · 7d 60% ↻未知');
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
  assert.equal(Q.summary(store, 'Claude', now + 1000, seat).displayLabel, '7d 70% ↻未知');
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
  assert.match(before.displayLabel, /5h 91% ↻.* · 7d 90% ↻/);
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
  assert.match(Q.text(store, time, [seat]), /5h 91% ↻.*7d 90% ↻.*数据已旧/);
  assert.doesNotMatch(Q.text(store, time, [seat]), /5h 9%|7d 10%|fake-secret/);
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
test('an idle seat refreshes an expired access token once and rewrites only that credential file', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), loc = M.credentialLocation(seat, home);
  const other = M.credentialLocation(S.normalize()[0], home), untouched = credential('cn-stays');
  fs.writeFileSync(loc.credentialsPath, expiredCredential());
  fs.writeFileSync(other.credentialsPath, untouched);
  const posts = [], now = 1_700_000_000_000;
  const post = async (body) => { posts.push(body); return refreshResponse(); };
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, now: () => now }), 'fresh-access-token');
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
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post, now: () => now + 1000 }), 'fresh-access-token');
  assert.equal(posts.length, 1);
});
test('a dead refresh token, a rejected refresh, or another account leaves the stored credential unchanged', async (t) => {
  const home = fixture(t), seat = S.normalize().find((item) => item.id === 'us'), loc = M.credentialLocation(seat, home);
  const posts = [];
  const post = async (body) => { posts.push(body); return null; };
  fs.writeFileSync(loc.credentialsPath, expiredCredential({ refreshTokenExpiresAt: 1 }));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post }), null);
  assert.equal(posts.length, 0);
  const rejected = expiredCredential();
  fs.writeFileSync(loc.credentialsPath, rejected);
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post }), null);
  assert.equal(fs.readFileSync(loc.credentialsPath, 'utf8'), rejected);
  assert.equal(posts.length, 1);
  const mismatch = async () => refreshResponse({ account: { uuid: 'someone-else' } });
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post: mismatch }), null);
  assert.equal(fs.readFileSync(loc.credentialsPath, 'utf8'), rejected);
  fs.writeFileSync(loc.credentialsPath, credential('still-valid'));
  assert.equal(await C.readCredentials(seat, home, 'win32', undefined, { post: mismatch }), 'still-valid');
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
    post: async () => { posts.push('refresh'); return refreshResponse(); }, spawn: spawnImpl,
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
    post: async () => { posts.push('refresh'); return refreshResponse(); }, spawn: spawnImpl,
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
        if (status === 200 && !res.destroyed) { res.emit('data', body); res.emit('end'); }
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
  assert.equal(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(401, '{"error":"invalid_grant","refresh_token":"fake-never-return"}')), null);
  assert.equal(await C.postRefresh({ refresh_token: 'fake-refresh-token' }, transport(429, '{"error":"rate_limited"}')), null);
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(ok).includes('fake-refresh-token'));
});
