'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWarmupService } = require('../quota-warmup-service');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-warmup-service-'));
  const stateFile = path.join(dir, 'state.json'), logFile = path.join(dir, 'warmup.log');
  let now = Date.parse('2026-10-03T12:01:01Z'), accountKey = 'own-account', busy = new Set();
  const seat = { id: 'cn', name: 'CN', configDir: '/home/test/.claude' }, calls = [];
  let usage = { accountBound: true, accountKey, configDir: seat.configDir, at: now - 3600_000,
    windows: [{ key: 'fiveHour', remaining: 0, resetText: '2026-10-03T12:00:00Z' }] };
  const settings = { enabled: true };
  const options = { stateFile, logFile, getSettings: () => settings, getSeats: () => [seat],
    readSeat: async () => ({ accountKey, configDir: seat.configDir, usage }),
    occupied: async () => busy, now: () => now,
    run: async (_seat, o) => {
      calls.push(o);
      assert.equal(JSON.parse(fs.readFileSync(stateFile)).seats.cn.status, 'running');
      return { ok: true, provenNative: true, resetAt: now + 5 * 3600_000 };
    }, ...overrides };
  const service = createWarmupService(options);
  t.after(() => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { service, options, seat, calls, stateFile, logFile, settings,
    setBusy: (v) => { busy = v; }, advance: (ms) => { now += ms; },
    setUsage: (v) => { usage = v; }, setAccount: (v) => { accountKey = v; } };
}
test('service claims before a headless request, logs only metadata, and persists one warmup across reopen', async (t) => {
  const f = fixture(t);
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 1);
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  const record = JSON.parse(fs.readFileSync(f.logFile, 'utf8'));
  assert.equal(record.outcome, 'warmed'); assert.equal(record.seat, 'CN');
  assert.equal(record.newResetAt, Date.parse('2026-10-03T17:01:01Z'));
  f.service.dispose();
  const reopened = createWarmupService(f.options);
  await reopened.tick(); reopened.dispose();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.snapshot())[0].warmAt, Date.parse('2026-10-03T12:01:01Z'));
});
test('unknown or another account reset cannot cause a real request', async (t) => {
  const f = fixture(t);
  f.setUsage({ accountBound: true, accountKey: 'other-account', configDir: f.seat.configDir, at: Date.now(),
    windows: [{ key: 'fiveHour', resetText: '2026-10-03T12:00:00Z' }] });
  await f.service.tick(); assert.equal(f.calls.length, 0);
  f.setUsage(null); await f.service.tick(); assert.equal(f.calls.length, 0);
});
test('occupied and disabled seats skip without consuming a window', async (t) => {
  const f = fixture(t);
  f.setBusy(new Set(['cn'])); await f.service.tick(); assert.equal(f.calls.length, 0);
  f.setBusy(new Set()); f.settings.enabled = false;
  await f.service.tick(); assert.equal(f.calls.length, 0);
  f.settings.enabled = true; await f.service.tick(); assert.equal(f.calls.length, 1);
});
test('failure retries once after a minute, then abandons with two metadata log entries', async (t) => {
  let calls = 0;
  const f = fixture(t, { run: async () => { calls++; return { ok: false, status: 'failed', unsafeRaw: 'do not log' }; } });
  await f.service.tick(); await f.service.tick(); assert.equal(calls, 1);
  f.advance(60_000); await f.service.tick(); await f.service.tick(); assert.equal(calls, 2);
  assert.equal((await f.service.snapshot())[0].status, 'abandoned');
  const text = fs.readFileSync(f.logFile, 'utf8');
  assert.equal(text.trim().split('\n').length, 2); assert.ok(!text.includes('do not log'));
});
test('a newly starting normal session aborts only the owned warmup and never records success', async (t) => {
  let started;
  const ready = new Promise((r) => { started = r; });
  const f = fixture(t, { run: async (_seat, { signal }) => {
    started(); await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
    return { ok: true, resetAt: Date.parse('2026-10-03T17:00:00Z'), provenNative: true };
  } });
  const pending = f.service.tick(); await ready; f.service.cancel('cn'); await pending;
  const status = (await f.service.snapshot())[0];
  assert.equal(status.status, 'retry'); assert.equal(status.warmAt, undefined);
  assert.equal(JSON.parse(fs.readFileSync(f.logFile)).reason, 'seat-in-use');
});
test('disabling during the last asynchronous idle scan prevents the first request', async (t) => {
  let release, reached;
  const ready = new Promise((r) => { reached = r; });
  let scans = 0;
  const f = fixture(t, { occupied: async () => {
    if (++scans === 2) { reached(); await new Promise((r) => { release = r; }); }
    return new Set();
  } });
  const pending = f.service.tick(); await ready;
  f.settings.enabled = false; release(); await pending;
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.snapshot())[0].attempts, 0);
});
test('warmup consumes the existing seat quota structure without a private API reader or native cache', async (t) => {
  const sample = { provider: 'Claude', scope: 'claude', seatId: 'cn', accountBound: true,
    accountKey: 'own-account', configDir: '/home/test/.claude', at: Date.parse('2026-10-03T11:55:00Z'),
    official: true, windows: [{ key: 'fiveHour', remaining: 0, resetAt: Date.parse('2026-10-03T12:00:00Z') }] };
  const f = fixture(t, { readSeat: async () => ({ accountKey: 'own-account', configDir: '/home/test/.claude', quota: { sample } }) });
  await f.service.tick(); assert.equal(f.calls.length, 1);
});
test('another seat in the existing quota structure cannot preheat this seat', async (t) => {
  const f = fixture(t, { readSeat: async () => ({ accountKey: 'own-account', configDir: '/home/test/.claude',
    quota: { sample: { seatId: 'us', accountBound: true, accountKey: 'own-account', configDir: '/home/test/.claude',
      at: Date.parse('2026-10-03T11:55:00Z'), windows: [{ key: 'fiveHour', resetAt: Date.parse('2026-10-03T12:00:00Z') }] } } }) });
  await f.service.tick(); assert.equal(f.calls.length, 0);
});
test('a later trusted quota sample supplies the next reset after a successful request had no reset metadata', async (t) => {
  let calls = 0;
  let sample = { provider: 'Claude', scope: 'claude', seatId: 'cn', accountBound: true,
    accountKey: 'own-account', configDir: '/home/test/.claude', at: Date.parse('2026-10-03T11:55:00Z'),
    windows: [{ key: 'fiveHour', remaining: 0, resetAt: Date.parse('2026-10-03T12:00:00Z') }] };
  const f = fixture(t, { readSeat: async () => ({ accountKey: 'own-account', configDir: '/home/test/.claude', quota: { sample } }),
    run: async () => { calls++; return { ok: true, provenNative: false, resetAt: null }; } });
  await f.service.tick();
  assert.equal((await f.service.snapshot())[0].newResetAt, undefined);
  sample = { ...sample, at: Date.parse('2026-10-03T12:01:02Z'),
    windows: [{ key: 'fiveHour', remaining: 99, resetAt: Date.parse('2026-10-03T17:00:00Z') }] };
  const status = (await f.service.snapshot())[0];
  assert.equal(status.newResetAt, Date.parse('2026-10-03T17:00:00Z'));
  assert.ok(status.warmAt); await f.service.tick(); assert.equal(calls, 1);
});
