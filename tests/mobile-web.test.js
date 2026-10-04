'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MobileWebServer, DEFAULT_PORT } = require('../mobile-web');

function fixture() {
  const sessions = [{ id: 'captain', title: '队长', model: 'Codex', status: 'idle', isMain: true, receipt: '' },
    { id: 'worker', title: '手机页面', model: 'Codex', status: 'working', isMain: false, receipt: '完成服务接口' }];
  const cards = [{ id: 't-mobile', project: 'AgentDeck', title: '手机页面', status: 'doing', latest_receipt: '服务已就绪' }];
  const messages = [], saved = [];
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: () => cards,
    getOutput: (id) => id === 'worker' ? { id, title: '手机页面', text: '<script>plain text</script>\n最新输出' } : null,
    sendCaptain: (message) => messages.push(message), saveSettings: (settings) => saved.push(settings) });
  return { server, sessions, cards, messages, saved };
}
async function start(t) {
  const f = fixture();
  t.after(() => f.server.close());
  const status = await f.server.configure({ enabled: true, port: 0 });
  assert.equal(status.enabled, true);
  f.status = status;
  f.auth = { Authorization: `Bearer ${status.token}` };
  return f;
}
function request(status, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(status.url + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function post(status, route, body, headers = {}) {
  return request(status, route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('mobile web is disabled by default and never opens a listener or generates a token', async () => {
  const { server, saved } = fixture();
  assert.deepEqual(server.status(), { enabled: false, url: '', token: '', port: DEFAULT_PORT, error: '' });
  assert.equal(server.server, null);
  await server.configure({ enabled: false });
  assert.equal(server.server, null);
  assert.deepEqual(saved, [{ enabled: false, token: '', port: DEFAULT_PORT }]);
  await server.close();
});

test('first enable generates and persists a random token, binds only loopback, and closes', async (t) => {
  const { server, status, saved } = await start(t);
  assert.match(status.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved, [{ enabled: true, port: 0, token: status.token }]);
  assert.equal(server.server.address().address, '127.0.0.1');
  await server.configure({ enabled: true, token: status.token, port: 0 });
  assert.equal(saved.length, 2);
  assert.equal(server.status().token, status.token);
  await server.close();
  assert.equal(server.status().enabled, false);
  await assert.rejects(request(server.status().url ? server.status() : status, '/api/sessions'));
});

test('unauthenticated root is a 401 login shell, all app assets and APIs reject missing or wrong credentials', async (t) => {
  const { status, auth } = await start(t);
  const root = await request(status, '/');
  assert.equal(root.status, 401);
  assert.match(root.text, /登录 token/);
  assert.ok(!root.text.includes(status.token));
  assert.match(root.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(root.headers['content-security-policy'], /nonce-/);
  for (const route of ['/app.js', '/style.css', '/api/sessions', '/api/tasks', '/api/output?id=worker', '/other']) {
    assert.equal((await request(status, route)).status, 401, route);
    assert.equal((await request(status, route, { headers: { Authorization: 'Bearer incorrect' } })).status, 401, route);
  }
  assert.equal((await request(status, '/?token=' + status.token)).status, 401);
  assert.equal((await request(status, '/api/sessions', { headers: auth })).status, 200);
});

test('login remembers the device with HttpOnly strict cookies and refuses wrong explicit credentials', async (t) => {
  const { status, server, saved } = await start(t);
  assert.equal((await post(status, '/login', { token: 'wrong' })).status, 401);
  const login = await post(status, '/login', { token: status.token });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.ok(!setCookie.includes(status.token));
  const cookie = setCookie.split(';')[0];
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: cookie } })).status, 200);
  for (const authorization of ['Bearer incorrect', 'Basic secret', '']) {
    assert.equal((await request(status, '/api/sessions', { headers: { Cookie: cookie, Authorization: authorization } })).status, 401);
  }
  assert.equal((await post(status, '/login', { token: 'wrong' }, { Cookie: cookie })).status, 401);
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: 'agentdeck_mobile=' + status.token } })).status, 401);
  await server.configure({ enabled: false });
  assert.deepEqual(saved.at(-1), { enabled: false, token: status.token, port: 0 });
  const restarted = await server.configure({ enabled: true });
  assert.equal((await request(restarted, '/api/sessions', { headers: { Cookie: cookie } })).status, 200);
});

test('read APIs return sessions, task-board cards and plain output; the sole write route queues the captain', async (t) => {
  const { status, auth, sessions, cards, messages } = await start(t);
  assert.deepEqual(JSON.parse((await request(status, '/api/sessions', { headers: auth })).text), { sessions });
  assert.deepEqual(JSON.parse((await request(status, '/api/tasks', { headers: auth })).text), { cards });
  const output = await request(status, '/api/output?id=worker', { headers: auth });
  assert.deepEqual(JSON.parse(output.text), { id: 'worker', title: '手机页面', text: '<script>plain text</script>\n最新输出' });
  assert.equal(output.headers['cache-control'], 'no-store');
  assert.equal((await request(status, '/api/output', { headers: auth })).status, 400);
  assert.equal((await request(status, '/api/output?id=unknown', { headers: auth })).status, 404);
  const result = await post(status, '/api/captain', { message: '请查看手机页面回执。' }, auth);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { queued: true });
  assert.deepEqual(messages, ['请查看手机页面回执。']);
  assert.equal((await post(status, '/api/captain', { message: 'send', id: 'worker' }, auth)).status, 400);
  for (const route of ['/api/tell', '/api/tasks', '/api/output', '/ipc']) assert.equal((await post(status, route, { message: 'send' }, auth)).status, 404);
  assert.equal(messages.length, 1);
});

test('authenticated static files are served from a fixed allowlist with restrictive headers', async (t) => {
  const { status, auth } = await start(t);
  for (const route of ['/', '/app.js', '/style.css']) {
    const result = await request(status, route, { headers: auth });
    assert.equal(result.status, 200, route);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-security-policy'], /default-src 'none'/);
  }
  for (const route of ['/main.js', '/package.json', '/..%2fmain.js', '/api/../main.js']) {
    assert.equal((await request(status, route, { headers: auth })).status, 404, route);
  }
});

test('malformed, oversized and empty writes are refused before calling the captain', async (t) => {
  const { status, auth, messages } = await start(t);
  for (const body of [{}, { message: '' }, { message: '  ' }, { message: 7 }, { message: '\0' }, { message: 'x'.repeat(8001) }, null, []]) {
    assert.equal((await post(status, '/api/captain', body, auth)).status, 400);
  }
  assert.equal((await request(status, '/api/captain', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await request(status, '/api/captain', { method: 'POST', headers: auth, body: 'message=send' })).status, 415);
  assert.equal((await post(status, '/api/captain', { message: 'x'.repeat(70_000) }, auth)).status, 413);
  assert.equal((await post(status, '/login', { token: 7 })).status, 401);
  assert.deepEqual(messages, []);
});

test('the 8000-character message limit accepts multibyte Chinese JSON at the boundary', async (t) => {
  const { status, auth, messages } = await start(t);
  const message = '中'.repeat(8000);
  assert.equal((await post(status, '/api/captain', { message }, auth)).status, 200);
  assert.deepEqual(messages, [message]);
});

test('Host, Origin and Fetch Metadata block rebinding and cross-site writes', async (t) => {
  const { status, auth, messages } = await start(t);
  assert.equal((await request(status, '/api/sessions', { headers: { ...auth, Host: 'attacker.example' } })).status, 403);
  assert.equal((await post(status, '/api/captain', { message: 'send' }, { ...auth, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post(status, '/login', { token: status.token }, { Origin: 'null' })).status, 403);
  assert.equal((await post(status, '/api/captain', { message: 'send' }, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.deepEqual(messages, []);
  assert.equal((await post(status, '/api/captain', { message: 'safe' }, { ...auth, Origin: status.url, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('startup failure is visible without enabling the server or leaking callback errors', async (t) => {
  const { server } = fixture();
  t.after(() => server.close());
  const badPort = await server.configure({ enabled: true, port: -1 });
  assert.equal(badPort.enabled, false);
  assert.match(badPort.error, /port/);
  server.sources.saveSettings = () => { throw new Error('secret file contents'); };
  const failure = await server.configure({ enabled: true, port: 0 });
  assert.equal(failure.enabled, false);
  assert.equal(failure.error, 'Could not start local web service.');
  assert.equal(server.server, null);
});

test('port collisions surface a disabled status, and queued toggles finish with no listener', async (t) => {
  const first = await start(t);
  const second = fixture();
  t.after(() => second.server.close());
  const collision = await second.server.configure({ enabled: true, port: first.status.port });
  assert.equal(collision.enabled, false);
  assert.equal(collision.error, 'Local port is already in use.');
  await Promise.all([second.server.configure({ enabled: true, port: 0 }), second.server.configure({ enabled: false })]);
  assert.equal(second.server.status().enabled, false);
  assert.equal(second.server.server, null);
  assert.equal(second.saved.at(-1).enabled, false);
});

test('callback errors become generic responses and output is bounded without interpreting markup', async (t) => {
  const { server, status, auth } = await start(t);
  server.sources.getOutput = (id) => ({ id, title: 'worker', text: 'old'.repeat(30000) + '\n<literal>' });
  const output = JSON.parse((await request(status, '/api/output?id=worker', { headers: auth })).text);
  assert.equal(output.text.length, 64_000);
  assert.ok(output.text.endsWith('\n<literal>'));
  server.sources.sendCaptain = () => { throw new Error('private terminal output and token'); };
  const failure = await post(status, '/api/captain', { message: 'send' }, auth);
  assert.equal(failure.status, 500);
  assert.deepEqual(JSON.parse(failure.text), { error: 'Local service unavailable.' });
});
