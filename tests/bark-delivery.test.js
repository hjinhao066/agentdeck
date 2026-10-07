'use strict';
process.env.TZ = 'America/Los_Angeles';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBarkDelivery, createFileBarkDelivery, digest } = require('../bark-delivery');
const { createNotifyUser } = require('../notify-user');
const local = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const payload = (message, extra = {}) => ({ title: '席位掉登录', message, level: 'critical', ...extra });
function harness(extra = {}) {
  const h = { at: local(7, 23), saved: {}, calls: [], classes: [], settings: {}, ...extra };
  h.options = { state: h.saved, saveState: (value) => { h.saved = structuredClone(value); }, now: () => h.at,
    getSettings: () => h.settings, getClasses: () => h.classes,
    sendNow: async (p) => { h.calls.push(p); return { ok: true, message: 'sent' }; } };
  h.delivery = createBarkDelivery(h.options); return h;
}
test('all Bark levels defer, dedupe by kind, survive restart and merge once at 10:00', async () => {
  const h = harness();
  assert.equal((await h.delivery.send(payload('US 未登录', { dedupeKey: 'seat:us' }))).queued, true);
  await h.delivery.send(payload('US 仍未登录', { dedupeKey: 'seat:us' }));
  await h.delivery.send(payload('US 仍未登录', { dedupeKey: 'seat:us', level: 'active' }));
  await h.delivery.send(payload('额度提醒', { level: 'active' }));
  await h.delivery.send(payload('额度提醒', { level: 'active' }));
  assert.equal(h.saved.pending.length, 2); assert.equal(h.calls.length, 0);
  h.delivery = createBarkDelivery({ ...h.options, state: h.saved });
  h.at = local(8, 9, 59); await h.delivery.flush(); assert.equal(h.calls.length, 0);
  h.at = local(8, 10); await h.delivery.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].level, 'critical');
  assert.match(h.calls[0].message, /2 项提醒/); assert.match(h.calls[0].message, /US 仍未登录/);
  assert.match(h.calls[0].message, /额度提醒/); assert.deepEqual(h.saved.pending, []);
  await h.delivery.flush(); assert.equal(h.calls.length, 1);
});
test('first send waits for cached calendar preparation and releases at the class end', async () => {
  const h = harness({ at: local(7, 10, 30) });
  let preparations = 0;
  h.delivery = createBarkDelivery({ ...h.options, prepare: async () => {
    await Promise.resolve(); preparations++;
    h.classes = [{ start: local(7, 10, 30), end: local(7, 12, 20) }];
  } });
  assert.equal((await h.delivery.send(payload('课中提醒'))).queued, true);
  assert.equal(h.calls.length, 0); assert.equal(preparations, 1);
  h.at = local(7, 12, 20); await h.delivery.flush(); assert.equal(h.calls.length, 1);
});
test('failed digest retains every reminder with bounded retries and accepts new reminders', async () => {
  const h = harness(); let attempts = 0;
  h.delivery = createBarkDelivery({ ...h.options, sendNow: async () => { attempts++; return { ok: attempts > 1 }; } });
  await h.delivery.send(payload('A')); h.at = local(8, 10);
  await h.delivery.flush(); assert.equal(h.saved.pending.length, 1); assert.equal(attempts, 1);
  await h.delivery.send(payload('B')); assert.equal(h.saved.pending.length, 2); assert.equal(attempts, 1);
  h.at += 60_000; await h.delivery.flush(); assert.equal(attempts, 2); assert.equal(h.saved.pending.length, 0);
});
test('local notification is recorded immediately while urgent Bark is deferred', async () => {
  const h = harness(), alerts = [];
  const notify = createNotifyUser({ getConfig: () => ({ columns: [{ id: 'captain', isMain: true }], barkKeyFile: '/private/fake-key' }),
    notifications: { show: (p) => alerts.push(p) }, delivery: h.delivery,
    fetchImpl: () => { throw new Error('should not send'); } });
  const result = await notify({ callerId: 'captain', id: 'request', message: 'US 掉登录', urgent: true }, false);
  assert.equal(alerts.length, 1); assert.equal(alerts[0].reply, 'US 掉登录'); assert.match(result, /Bark 已延后/);
  assert.equal(h.saved.pending.length, 1);
});
test('a blank key setting still queues for the shared default key during sleep hours', async () => {
  const h = harness(), alerts = [];
  const notify = createNotifyUser({ getConfig: () => ({ columns: [{ id: 'captain', isMain: true }] }),
    notifications: { show: (p) => alerts.push(p) }, delivery: h.delivery, keyHome: '/private/isolated-no-key',
    fetchImpl: () => { throw new Error('should not send'); } });
  const result = await notify({ callerId: 'captain', id: 'request', message: 'US 掉登录', urgent: true }, false);
  assert.equal(alerts.length, 1); assert.match(result, /Bark 已延后/);
  assert.equal(h.delivery.status().queuedCount, 1);
});
test('file outbox reloads under lock across independent app and installer instances', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-outbox-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pending.json'), h = harness();
  const options = { ...h.options, file };
  const app = createFileBarkDelivery(options), installer = createFileBarkDelivery(options);
  await Promise.all([app.send(payload('seat')), installer.send(payload('install'))]);
  assert.equal(JSON.parse(fs.readFileSync(file)).pending.length, 2);
  h.at = local(8, 10); await Promise.all([app.flush(), installer.flush()]);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].message, /2 项提醒/);
  assert.equal(JSON.parse(fs.readFileSync(file)).pending.length, 0);
});
test('proven dead lock owner is reclaimed; damaged queue is preserved without crashing construction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-dead-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pending.json'), h = harness();
  fs.mkdirSync(file + '.lock'); fs.writeFileSync(file + '.lock/owner', JSON.stringify({ pid: 99999999 }));
  const delivery = createFileBarkDelivery({ ...h.options, file });
  await delivery.send(payload('A')); assert.equal(fs.existsSync(file + '.lock'), false);
  fs.writeFileSync(file, '{damaged');
  const next = createFileBarkDelivery({ ...h.options, file });
  await assert.rejects(next.send(payload('B')), /queue cannot be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{damaged'); assert.equal(fs.existsSync(file + '.lock'), false);
  const damaged = JSON.stringify({ pending: ['damaged-item'], retryAt: 0 });
  fs.writeFileSync(file, damaged);
  await assert.rejects(next.flush(), /queue cannot be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});
test('large digest is one bounded push and reports extra items without losing queue detail', () => {
  const pending = Array.from({ length: 20 }, (_, i) => ({ ...payload('x'.repeat(4000)), createdAt: local(7, 23), key: String(i) }));
  const result = digest(pending); assert.ok(result.message.length <= 4000);
  assert.match(result.message, /20 项提醒/); assert.match(result.message, /另有 \d+ 项/);
  assert.equal(pending[19].message.length, 4000);
});

test('daytime immediate failure persists, reports the failure and retries only after 60 seconds across restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-day-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness({ at: local(7, 12) }), file = path.join(dir, 'pending.json'), failures = [];
  const failed = createFileBarkDelivery({ ...h.options, file, onFailure: (p) => failures.push(p) });
  const first = await failed.send(payload('US 未登录', { dedupeKey: 'seat-auth:Claude:us' }), async () => ({ ok: false }));
  assert.equal(first.ok, false); assert.equal(first.accepted, true); assert.equal(first.queued, true);
  assert.equal(failures[0].retained, true); assert.deepEqual(failures[0].keys, ['seat-auth:Claude:us']);
  assert.match(failed.status().lastError, /发送失败.*60 秒/);
  const restarted = createFileBarkDelivery({ ...h.options, file });
  await restarted.flush(); assert.equal(h.calls.length, 0);
  h.at += 59_999; await restarted.flush(); assert.equal(h.calls.length, 0);
  h.at++; await restarted.flush(); assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].message, /US 未登录/);
  await restarted.flush(); assert.equal(h.calls.length, 1);
  assert.equal(restarted.status().lastError, '');
});
test('cancel removes only a recovered seat durably and lets a later outage rearm', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = harness(), file = path.join(dir, 'pending.json');
  const delivery = createFileBarkDelivery({ ...h.options, file });
  await delivery.send(payload('US', { dedupeKey: 'seat-auth:Claude:us' }));
  await delivery.send(payload('CN', { dedupeKey: 'seat-auth:Claude:cn' }));
  await delivery.cancel('seat-auth:Claude:us');
  const reloaded = createFileBarkDelivery({ ...h.options, file });
  h.at = local(8, 10); await reloaded.flush();
  assert.equal(h.calls.length, 1); assert.doesNotMatch(h.calls[0].message, /US/);
  await reloaded.send(payload('US 又掉线', { dedupeKey: 'seat-auth:Claude:us' }));
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].message, 'US 又掉线');
});
test('successful send with failed cleanup retries disk only and preserves another process new reminder', async () => {
  const h = harness({ at: local(7, 12) }); let failCleanup = true, calls = 0;
  const options = { ...h.options, readState: () => h.saved,
    saveState: (next) => {
      if (calls === 1 && next.inflight === null && failCleanup) throw new Error('disk full');
      h.saved = structuredClone(next);
    }, sendNow: async () => { calls++; return { ok: true }; } };
  const first = createBarkDelivery(options);
  const result = await first.send(payload('A'));
  assert.equal(result.sent, true); assert.equal(result.ok, false);
  assert.match(first.status().lastError, /已送达.*不会重复发送/);
  await first.flush(); assert.equal(calls, 1);
  const second = createBarkDelivery({ ...h.options, readState: () => h.saved, sendNow: options.sendNow });
  await second.send(payload('B')); assert.equal(calls, 1);
  failCleanup = false;
  await first.flush(); assert.equal(calls, 2);
  assert.deepEqual(h.saved.pending, []);
});
test('interrupted inflight batch is visible and paused until explicit retry, which still respects quiet hours', async () => {
  const h = harness({ at: local(7, 12) }), failures = [];
  h.delivery = createBarkDelivery({ ...h.options, state: { pending: [{ ...payload('A'), key: 'a', createdAt: h.at }],
    retryAt: 0, inflight: { ownerPid: 99999999 } }, onFailure: (p) => failures.push(p) });
  const result = await h.delivery.flush();
  assert.equal(result.ok, false); assert.equal(h.delivery.status().uncertain, true);
  assert.match(failures[0].message, /送达结果不明/);
  await h.delivery.flush(); assert.equal(h.calls.length, 0);
  h.at = local(7, 23); await h.delivery.retry(); assert.equal(h.calls.length, 0);
  h.at = local(8, 10); await h.delivery.flush(); assert.equal(h.calls.length, 1);
});
test('old ownerless locks recover after initialization grace and new locks atomically contain the owner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bark-empty-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pending.json'), h = harness({ at: local(7, 12) });
  fs.mkdirSync(file + '.lock'); const old = new Date(Date.now() - 60_000); fs.utimesSync(file + '.lock', old, old);
  const delivery = createFileBarkDelivery({ ...h.options, file, sendNow: async () => {
    assert.equal(fs.statSync(file + '.lock').isFile(), true);
    assert.equal(JSON.parse(fs.readFileSync(file + '.lock')).pid, process.pid);
    return { ok: true };
  } });
  await delivery.send(payload('A')); assert.equal(fs.existsSync(file + '.lock'), false);
});

test('cancelling an uncertain old batch does not suspend later unrelated reminders', async () => {
  const h = harness({ at: local(7, 12) });
  h.delivery = createBarkDelivery({ ...h.options, state: {
    pending: [{ ...payload('US'), key: 'seat:us', createdAt: h.at }, { ...payload('CN'), key: 'seat:cn', createdAt: h.at }],
    retryAt: 0, inflight: { ownerPid: 99999999, keys: ['seat:us'] },
  } });
  await h.delivery.flush(); assert.equal(h.delivery.status().uncertain, true);
  await h.delivery.cancel('seat:us'); await h.delivery.flush();
  assert.equal(h.calls.length, 1); assert.doesNotMatch(h.calls[0].message, /US/);
});
test('one explicit retry recovers a dead inflight owner without requiring a second click', async () => {
  const h = harness({ at: local(7, 12) });
  h.delivery = createBarkDelivery({ ...h.options, state: {
    pending: [{ ...payload('A'), key: 'a', createdAt: h.at }], retryAt: 0,
    inflight: { ownerPid: 99999999, keys: ['a'] },
  } });
  await h.delivery.retry(); assert.equal(h.calls.length, 1);
});
