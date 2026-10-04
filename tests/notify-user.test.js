const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNotifyUser } = require('../notify-user');

function harness(fetchImpl) {
  const config = { columns: [{ id: 'captain', isMain: true }, { id: 'crew' }] }, alerts = [], calls = [];
  const notify = createNotifyUser({ getConfig: () => config,
    notifications: { show: (p) => alerts.push(p) },
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ code: 200 }) }; } });
  return { config, alerts, calls, notify: (extra = {}, visible = false, turnId) => notify({
    callerId: 'captain', id: 'request-1', message: '请亲自登录。第二句。', urgent: false, ...extra,
  }, visible, turnId) };
}
test('default uses local alerts and current turn, never reads a key or sends Bark', async () => {
  const h = harness(); h.config.barkKeyFile = '/does/not/exist';
  assert.match(await h.notify({}, true, 'reply-turn'), /本机提醒/);
  assert.deepEqual(h.alerts, [{ id: 'captain', turnId: 'reply-turn', state: 'input', reply: '请亲自登录。第二句。', visible: true }]);
  assert.deepEqual(h.calls, []);
});
test('workers and malformed requests fail before any alert or file/network access', async () => {
  const h = harness();
  for (const extra of [{ callerId: 'crew' }, { callerId: 'missing' }, { message: '' }, { message: true },
    { message: ' '.repeat(5) }, { message: 'a'.repeat(4001) }, { urgent: 'true' }]) {
    await assert.rejects(h.notify(extra));
  }
  assert.deepEqual(h.alerts, []); assert.deepEqual(h.calls, []);
});
test('missing configuration skips Bark with an actionable hint after local delivery', async () => {
  const h = harness();
  assert.match(await h.notify({ urgent: true }), /Bark 已跳过.*设置.*密钥文件路径/);
  assert.equal(h.alerts.length, 1); assert.equal(h.calls.length, 0);
});
test('urgent sends fixed HTTPS POST critical/4/minuet, key only in body, regardless of local preferences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bark-unit-'));
  try {
    const h = harness(); h.config.barkKeyFile = path.join(dir, 'key');
    h.config.captainNotifications = { enabled: false, sound: false };
    fs.writeFileSync(h.config.barkKeyFile, 'fake_device-key\n');
    const result = await h.notify({ urgent: true }, true);
    assert.match(result, /Bark 紧急提醒已发送/); assert.ok(!result.includes('fake_device-key'));
    const [url, options] = h.calls[0];
    assert.equal(url, 'https://api.day.app/push'); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { device_key: 'fake_device-key', title: '队长',
      body: '请亲自登录。第二句。', level: 'critical', volume: 4, sound: 'minuet' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bad paths, directories, oversized or malformed key files never send or expose content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bark-invalid-'));
  try {
    for (const value of ['', 'secret with spaces', 'https://api.day.app/secret', 'k'.repeat(513), 'k'.repeat(4097)]) {
      const h = harness(); h.config.barkKeyFile = path.join(dir, 'key');
      fs.writeFileSync(h.config.barkKeyFile, value);
      assert.match(await h.notify({ urgent: true }), /不可读或格式无效/);
      assert.equal(h.calls.length, 0);
    }
    for (const file of [dir, path.join(dir, 'absent'), 'relative-key']) {
      const h = harness(); h.config.barkKeyFile = file;
      assert.match(await h.notify({ urgent: true }), /不可读或格式无效/); assert.equal(h.calls.length, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('HTTP/API/network/timeout/JSON errors are redacted and do not cancel the local alert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bark-errors-'));
  try {
    const file = path.join(dir, 'key'); fs.writeFileSync(file, 'fake_private_key');
    for (const fetchImpl of [async () => { throw new Error('fake_private_key'); },
      async () => { throw new DOMException('fake_private_key', 'TimeoutError'); },
      async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ code: 400, message: 'fake_private_key' }) }),
      async () => ({ ok: true, json: async () => { throw new Error('fake_private_key'); } })]) {
      const h = harness(fetchImpl); h.config.barkKeyFile = file;
      const result = await h.notify({ urgent: true });
      assert.match(result, /Bark 发送失败/); assert.ok(!result.includes('fake_private_key')); assert.equal(h.alerts.length, 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
