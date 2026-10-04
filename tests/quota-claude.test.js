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
  for (const seat of S.normalize()) fs.mkdirSync(M.credentialLocation(seat, home).dir);
  return home;
}
const credential = (token) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'fake-never-return-refresh', scopes: ['user:profile'], expiresAt: Date.now() + 3600000 } });
test('each seat reads its own credential store; expired/missing/symlinked auth cannot borrow a login', async (t) => {
  const home = fixture(t), [cn, us] = S.normalize();
  for (const seat of [cn, us]) fs.writeFileSync(M.credentialLocation(seat, home).credentialsPath, credential('fake-' + seat.id));
  assert.equal(await C.readCredentials(cn, home, 'win32'), 'fake-cn');
  assert.equal(await C.readCredentials(us, home, 'win32'), 'fake-us');
  const services = [];
  const keychain = (bin, args, opts, cb) => {
    assert.equal(bin, '/usr/bin/security'); assert.equal(args.at(-1), '-w');
    assert.equal(opts.timeout, 2000); assert.equal(opts.maxBuffer, 65536);
    services.push(args[2]); cb(null, credential('fake-keychain-' + services.length));
  };
  assert.equal(await C.readCredentials(cn, home, 'darwin', keychain), 'fake-keychain-1');
  assert.equal(await C.readCredentials(us, home, 'darwin', keychain), 'fake-keychain-2');
  assert.notEqual(services[0], services[1]);
  const file = M.credentialLocation(us, home).credentialsPath;
  fs.writeFileSync(file, credential('expired').replace(/"expiresAt":\d+/, '"expiresAt":1'));
  assert.equal(await C.readCredentials(us, home, 'win32'), null);
  fs.unlinkSync(file);
  fs.symlinkSync(M.credentialLocation(cn, home).credentialsPath, file);
  assert.equal(await C.readSeat(us, home), null);
  fs.unlinkSync(file);
  assert.equal(await C.readSeat(us, home), null);
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
  assert.deepEqual(partial.windows, [{ key: 'fiveHour', remaining: 50, resetText: '' }]);
  const tiny = await C.requestUsage('fake', transport(200, JSON.stringify({ five_hour: { utilization: 99.999, resets_at: 'in 1h' } }), []));
  assert.equal(tiny.windows[0].resetText, '');
  assert.equal(Q.cacheClaude(tiny, tiny.at).windows[0].exhausted, false);
});
test('idle seats refresh independently every 15 minutes; failure clears old numbers and persists no credentials', async (t) => {
  const home = fixture(t), seats = S.normalize();
  let now = Date.now(), fail = false;
  const calls = [];
  const poller = C.createRefresh({ home, getSeats: () => seats, now: () => now, read: async (seat) => {
    calls.push(seat.id);
    if (fail && seat.id === 'us') throw new Error('fake-sensitive-error');
    return { windows: [{ key: 'fiveHour', remaining: seat.id === 'cn' ? 25 : 80 }, { key: 'weekly', remaining: 60 }], accessToken: 'fake-never-return' };
  } });
  t.after(() => poller.dispose());
  await poller.tick(); await poller.tick();
  assert.deepEqual(calls, ['cn', 'us']);
  now += C.INTERVAL_MS - 1; await poller.tick(); assert.equal(calls.length, 2);
  now++; fail = true; await poller.tick(); assert.deepEqual(calls, ['cn', 'us', 'cn', 'us']);
  const data = await readLocal(home, undefined, now, seats);
  assert.deepEqual(data.map(q => [q.seatId, q.windows.length]), [['cn', 2], ['us', 0]]);
  assert.ok(!JSON.stringify(data).includes('fake-'));
  for (const seat of seats) assert.ok(!fs.readFileSync(M.credentialLocation(seat, home).usagePath, 'utf8').includes('fake-'));
  const store = {};
  for (const sample of poller.samples()) Q.observe(store, sample, now);
  assert.equal(Q.summary(store, 'Claude', now, seats[0]).displayLabel, '5h 25% · 7d 60%');
  assert.equal(Q.summary(store, 'Claude', now, seats[1]).state, 'unknown');
});
test('refresh coalesces concurrent ticks, does not apply removed seats, and tolerates cache-write failure', async (t) => {
  const home = fixture(t); let seats = S.normalize(), release, reads = 0;
  const poller = C.createRefresh({ home, getSeats: () => seats, read: () => { reads++; return new Promise(r => { release = r; }); }, write: () => { throw new Error('read-only'); } });
  seats = [seats[0]];
  const pending = poller.tick(); await poller.tick(); assert.equal(reads, 1);
  seats = [S.normalize()[1]]; poller.samples(); release({ windows: [{ key: 'weekly', remaining: 90 }] }); await pending;
  assert.deepEqual(poller.samples().map(s => [s.seatId, s.windows.length]), [['us', 0]]);
  poller.dispose(); assert.deepEqual(poller.samples(), []); await poller.tick(); assert.equal(reads, 1);
  const badDisk = C.createRefresh({ home, getSeats: () => seats, read: async () => ({ windows: [{ key: 'weekly', remaining: 90 }] }), write: () => { throw new Error('read-only'); } });
  await badDisk.tick(); assert.equal(badDisk.samples()[0].windows[0].remaining, 90); badDisk.dispose();
});
test('server samples replace stale screen/exhaustion; failure and missing windows cannot retain or resurrect old percentages', () => {
  const seat = S.normalize()[0], store = {}, now = Date.now();
  const sample = (at, windows) => ({ ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows }, at), seatId: seat.id });
  Q.observe(store, { provider: 'Claude', scope: 'claude', seatId: seat.id, at: now - 1000, source: '会话屏幕', exhausted: true, windows: [] }, now);
  Q.observe(store, sample(now, [{ key: 'weekly', remaining: 60 }]), now);
  assert.equal(Q.summary(store, 'Claude', now, seat).displayLabel, '5h 无数据 · 7d 60%');
  assert.equal(Q.summary(store, 'Claude', now + C.INTERVAL_MS + 1000, seat).state, 'normal');
  Q.observe(store, sample(now + 1, []), now + 1);
  assert.equal(Q.summary(store, 'Claude', now + 1, seat).state, 'unknown');
  Q.observe(store, { ...sample(now + 2, [{ key: 'weekly', remaining: 99 }]), source: '会话屏幕' }, now + 2);
  assert.equal(Q.summary(store, 'Claude', now + 2, seat).state, 'unknown');
  Q.observe(store, sample(now + 3, [{ key: 'weekly', remaining: 0 }]), now + 3);
  assert.equal(Q.summary(store, 'Claude', now + 3, seat).state, 'exhausted');
  assert.equal(Q.summary(store, 'Claude', now + 31 * 60000, seat).state, 'unknown');
});
test('new live observations remain current between successful polls; rereading an older server sample does not clear a new quota error', () => {
  const store = {}, seat = S.normalize()[0], now = Date.now();
  const api = { ...Q.cacheClaude({ source: Q.CLAUDE_OAUTH_SOURCE, windows: [{ key: 'weekly', remaining: 70 }] }, now), seatId: seat.id };
  Q.observe(store, api, now);
  Q.observe(store, { ...api, at: now + 1000, source: '会话屏幕', windows: [{ label: '每周', remaining: 55 }] }, now + 1000);
  Q.observe(store, api, now + 1000);
  assert.equal(Q.summary(store, 'Claude', now + 1000, seat).displayLabel, '5h 无数据 · 7d 55%');
  Q.observe(store, { ...api, at: now + 2000, source: '会话屏幕', exhausted: true, windows: [] }, now + 2000);
  Q.observe(store, api, now + 2000);
  assert.equal(Q.summary(store, 'Claude', now + 2000, seat).state, 'exhausted');
  Q.observe(store, { ...api, at: now + 3000 }, now + 3000);
  assert.equal(Q.summary(store, 'Claude', now + 3000, seat).state, 'normal');
});
