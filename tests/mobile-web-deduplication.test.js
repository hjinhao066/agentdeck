'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MobileWebServer } = require('../mobile-web');

// A message to the Captain carries a deduplicationKey made once on the phone and
// reused by every retry. The computer remembers the keys it took: a repeat gets
// the first answer back and is never typed into the Captain a second time.
const PUBLIC_ORIGIN = 'https://agentdeck.example';
const KEY = 'k-0123456789abcdef0123456789abcdef';

async function start(t, settings = {}, options = {}) {
  const messages = [];
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getCaptain: () => ({ turns: [] }), getOutput: () => null, saveSettings: () => {},
    sendCaptain: (message) => { messages.push(message); }, ...options });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0, ...settings });
  assert.equal(status.enabled, true);
  status.origin = settings.publicOrigin || status.url;
  if (settings.publicOrigin) status.proxyHeaders = { Host: new URL(settings.publicOrigin).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };
  const auth = { Authorization: `Bearer ${status.token}` };
  auth['X-CSRF-Token'] = JSON.parse((await request(status, (settings.basePath || '/') + 'api/auth', { headers: auth })).text).csrfToken;
  return { server, status, auth, messages };
}
function request(status, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(status.url + route, { method, headers: { ...status.proxyHeaders, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function post(status, route, body, headers = {}) {
  return request(status, route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: status.origin, ...headers }, body: JSON.stringify(body) });
}
const answer = (result) => ({ status: result.status, body: JSON.parse(result.text) });

test('the computer says it can take a send key', async (t) => {
  const { status } = await start(t);
  assert.ok(JSON.parse((await request(status, '/api/info')).text).capabilities.includes('send-dedupe'));
});

test('the same key sent twice reaches the Captain once and both get the first answer', async (t) => {
  const { status, auth, messages } = await start(t);
  const first = answer(await post(status, '/api/captain', { message: '把锁修好', deduplicationKey: KEY }, auth));
  const retry = answer(await post(status, '/api/captain', { message: '把锁修好', deduplicationKey: KEY }, auth));
  assert.deepEqual(first, { status: 200, body: { queued: true } });
  assert.deepEqual(retry, first);
  assert.deepEqual(messages, ['把锁修好']);
  // A different key is a different message, even with the same words.
  assert.equal((await post(status, '/api/captain', { message: '把锁修好', deduplicationKey: KEY.replace('k-', 'j-') }, auth)).status, 200);
  assert.deepEqual(messages, ['把锁修好', '把锁修好']);
});

test('a retry that arrives while the first is still being queued waits for it and is not sent again', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { status, auth } = await start(t, {}, { sendCaptain: async (message) => { calls.push(message); await gate; } });
  const first = post(status, '/api/captain', { message: '慢慢排队', deduplicationKey: KEY }, auth);
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  const retry = post(status, '/api/captain', { message: '慢慢排队', deduplicationKey: KEY }, auth);
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  assert.deepEqual((await Promise.all([first, retry])).map(answer), [{ status: 200, body: { queued: true } }, { status: 200, body: { queued: true } }]);
  assert.deepEqual(calls, ['慢慢排队']);
});

test('a key that failed to queue can be retried, and the retry is sent', async (t) => {
  let fail = true;
  const calls = [];
  const { status, auth } = await start(t, {}, { sendCaptain: (message) => { calls.push(message); if (fail) throw new Error('captain busy'); } });
  assert.equal((await post(status, '/api/captain', { message: '再试一次', deduplicationKey: KEY }, auth)).status, 500);
  fail = false;
  assert.equal((await post(status, '/api/captain', { message: '再试一次', deduplicationKey: KEY }, auth)).status, 200);
  assert.equal((await post(status, '/api/captain', { message: '再试一次', deduplicationKey: KEY }, auth)).status, 200);
  assert.deepEqual(calls, ['再试一次', '再试一次']);
});

test('a key reused for other words is refused and nothing is sent', async (t) => {
  const { status, auth, messages } = await start(t);
  assert.equal((await post(status, '/api/captain', { message: '第一条', deduplicationKey: KEY }, auth)).status, 200);
  const other = await post(status, '/api/captain', { message: '另一条', deduplicationKey: KEY }, auth);
  assert.equal(other.status, 409);
  assert.equal((await post(status, '/api/captain', { message: '第一条', images: [], deduplicationKey: KEY }, auth)).status, 200);
  assert.deepEqual(messages, ['第一条']);
});

test('without a key every send goes through, as before; a malformed key is refused', async (t) => {
  const { status, auth, messages } = await start(t);
  assert.equal((await post(status, '/api/captain', { message: 'old phone' }, auth)).status, 200);
  assert.equal((await post(status, '/api/captain', { message: 'old phone' }, auth)).status, 200);
  for (const deduplicationKey of ['short', 'x'.repeat(65), 'has space in it 0123456789', 42, null, '']) {
    assert.equal((await post(status, '/api/captain', { message: 'bad key', deduplicationKey }, auth)).status, 400, String(deduplicationKey));
  }
  assert.deepEqual(messages, ['old phone', 'old phone']);
});

test('keys are remembered for a day, then forgotten', async (t) => {
  let now = Date.now();
  const { status, auth, messages } = await start(t, {}, { now: () => now });
  assert.equal((await post(status, '/api/captain', { message: '隔天重试', deduplicationKey: KEY }, auth)).status, 200);
  now += 23 * 3600_000;
  assert.equal((await post(status, '/api/captain', { message: '隔天重试', deduplicationKey: KEY }, auth)).status, 200);
  assert.equal(messages.length, 1);
  now += 2 * 3600_000;
  assert.equal((await post(status, '/api/captain', { message: '隔天重试', deduplicationKey: KEY }, auth)).status, 200);
  assert.equal(messages.length, 2);
});

test('one phone cannot replay or block another phone\'s key', async (t) => {
  const { status, auth, messages } = await start(t);
  const login = await post(status, '/login', { token: status.token });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const phone = { Cookie: cookie, 'X-CSRF-Token': JSON.parse((await request(status, '/api/auth', { headers: { Cookie: cookie } })).text).csrfToken };
  assert.equal((await post(status, '/api/captain', { message: '同一个号', deduplicationKey: KEY }, auth)).status, 200);
  assert.equal((await post(status, '/api/captain', { message: '同一个号', deduplicationKey: KEY }, phone)).status, 200);
  assert.deepEqual(messages, ['同一个号', '同一个号']);
});

test('through the hub entry (public origin, machine prefix) a retry is not sent twice', async (t) => {
  const { status, auth, messages } = await start(t, { publicOrigin: PUBLIC_ORIGIN, basePath: '/mac/', label: 'Mac' });
  const info = JSON.parse((await request(status, '/mac/api/info')).text);
  assert.ok(info.capabilities.includes('send-dedupe'));
  for (let i = 0; i < 2; i++) assert.equal((await post(status, '/mac/api/captain', { message: '总台发来的', deduplicationKey: KEY }, auth)).status, 200);
  assert.deepEqual(messages, ['总台发来的']);
});
