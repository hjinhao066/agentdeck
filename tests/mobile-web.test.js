'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { MobileWebServer, DEFAULT_PORT, LOGIN_LIMITS } = require('../mobile-web');
const PUBLIC_ORIGIN = 'https://agentdeck.18-139-28-180.sslip.io';

function fixture(options = {}) {
  const sessions = [{ id: 'captain', title: '队长', model: 'Codex', status: 'idle', isMain: true, receipt: '' },
    { id: 'worker', title: '手机页面', model: 'Codex', status: 'working', isMain: false, receipt: '完成服务接口' }];
  const cards = [{ id: 't-mobile', project: 'AgentDeck', title: '手机页面', status: 'doing', latest_receipt: '服务已就绪' }];
  const captain = { id: 'captain', title: '队长', status: 'idle', turns: [{ id: 'turn-1', user: '最近指令', reply: '最近回复', done: true }] };
  const messages = [], saved = [];
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: () => cards,
    getCaptain: () => captain,
    getOutput: (id) => id === 'worker' ? { id, title: '手机页面', text: '<script>plain text</script>\n最新输出' } : null,
    sendCaptain: (message) => messages.push(message), saveSettings: (settings) => saved.push(settings), ...options });
  return { server, sessions, cards, captain, messages, saved };
}
async function start(t, settings = {}, options = {}) {
  const f = fixture(options);
  t.after(() => f.server.close());
  const status = await f.server.configure({ enabled: true, port: 0, ...settings });
  assert.equal(status.enabled, true);
  f.status = status;
  status.origin = settings.publicOrigin || status.url;
  if (settings.publicOrigin) status.proxyHeaders = { Host: new URL(settings.publicOrigin).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };
  f.auth = { Authorization: `Bearer ${status.token}` };
  f.auth['X-CSRF-Token'] = JSON.parse((await request(status, '/api/auth', { headers: f.auth })).text).csrfToken;
  return f;
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
  return request(status, route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: status.origin || status.url, ...headers }, body: JSON.stringify(body) });
}
function delayedPost(server, status, route, body, headers) {
  const data = Buffer.from(JSON.stringify(body));
  const arrived = new Promise((resolve) => server.server.once('request', resolve));
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(status.url + route, { method: 'POST', headers: { ...status.proxyHeaders,
      'Content-Type': 'application/json', 'Content-Length': data.length, Origin: status.origin || status.url, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(data.subarray(0, 1));
  });
  response.catch(() => {});
  return { arrived, response, complete: () => req.end(data.subarray(1)) };
}

test('mobile web is disabled by default and never opens a listener or generates a token', async () => {
  const { server, saved } = fixture();
  assert.deepEqual(server.status(), { enabled: false, url: '', publicUrl: '', publicOrigin: '', token: '', port: DEFAULT_PORT, deviceCount: 0, error: '' });
  assert.equal(server.server, null);
  await server.configure({ enabled: false });
  assert.equal(server.server, null);
  assert.deepEqual(saved, [{ enabled: false, token: '', port: DEFAULT_PORT, publicOrigin: '', devices: [] }]);
  await server.close();
});

test('first enable generates and persists a random token, binds only loopback, and closes', async (t) => {
  const { server, status, saved } = await start(t);
  assert.match(status.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(saved, [{ enabled: true, port: 0, token: status.token, publicOrigin: '', devices: [] }]);
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
    assert.ok([401, 429].includes((await request(status, route, { headers: { Authorization: 'Bearer incorrect' } })).status), route);
  }
  assert.equal((await request(status, '/?token=' + status.token)).status, 400);
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
  assert.deepEqual(saved.at(-1), { enabled: false, token: status.token, port: 0, publicOrigin: '', devices: saved.at(-2).devices });
  const restarted = await server.configure({ enabled: true });
  assert.equal((await request(restarted, '/api/sessions', { headers: { Cookie: cookie } })).status, 200);
});

test('read APIs return sessions, task-board cards, captain conversation and plain output; writes queue the captain', async (t) => {
  const { status, auth, sessions, cards, captain, messages } = await start(t);
  assert.deepEqual(JSON.parse((await request(status, '/api/sessions', { headers: auth })).text), { sessions });
  assert.deepEqual(JSON.parse((await request(status, '/api/tasks', { headers: auth })).text), { cards });
  assert.deepEqual(JSON.parse((await request(status, '/api/captain', { headers: auth })).text), captain);
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
  assert.equal((await request(status, '/api/captain', { method: 'POST', headers: { ...auth, Origin: status.url, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await request(status, '/api/captain', { method: 'POST', headers: { ...auth, Origin: status.url }, body: 'message=send' })).status, 415);
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

test('remote requests require the configured HTTPS host and loopback proxy contract', async (t) => {
  const local = await start(t);
  const proxy = { Host: new URL(PUBLIC_ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };
  assert.equal((await request(local.status, '/', { headers: proxy })).status, 403);
  const { server, status, auth } = await start(t, { publicOrigin: PUBLIC_ORIGIN });
  assert.equal(status.publicUrl, PUBLIC_ORIGIN);
  assert.equal(server.server.address().address, '127.0.0.1');
  assert.equal((await request(status, '/api/sessions', { headers: auth })).status, 200);
  for (const headers of [
    { 'X-Forwarded-Proto': '' }, { 'X-Forwarded-Proto': 'http' },
    { 'X-Forwarded-For': '' }, { 'X-Forwarded-For': '203.0.113.7, 198.51.100.4' },
    { 'X-Forwarded-For': 'private-user.example' }, { Host: 'other.example' },
    { Origin: 'http://' + new URL(PUBLIC_ORIGIN).host }, { 'Sec-Fetch-Site': 'same-site' }
  ]) assert.equal((await request(status, '/api/sessions', { headers: { ...auth, ...headers } })).status, 403, JSON.stringify(headers));
  assert.equal(server.requestContext({ rawHeaders: [], headers: proxy, socket: { remoteAddress: '192.168.1.9' } }), null);
  assert.equal(server.requestContext({ rawHeaders: ['Host', proxy.Host, 'Host', proxy.Host], headers: proxy, socket: { remoteAddress: '127.0.0.1' } }), null);
  assert.equal((await post(status, '/login', { token: status.token }, { Origin: status.url })).status, 403);
});

test('login and every authenticated POST require an exact Origin, and writes also require per-device CSRF', async (t) => {
  const { status, messages } = await start(t, { publicOrigin: PUBLIC_ORIGIN });
  const noOrigin = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: status.token }) };
  assert.equal((await request(status, '/login', noOrigin)).status, 403);
  assert.equal((await post(status, '/login', { token: status.token }, { Origin: 'https://evil.example' })).status, 403);
  const first = await post(status, '/login', { token: status.token });
  const second = await post(status, '/login', { token: status.token });
  const firstCookie = first.headers['set-cookie'][0].split(';')[0];
  const secondCookie = second.headers['set-cookie'][0].split(';')[0];
  const firstAuth = JSON.parse((await request(status, '/api/auth', { headers: { Cookie: firstCookie } })).text);
  const secondAuth = JSON.parse((await request(status, '/api/auth', { headers: { Cookie: secondCookie } })).text);
  assert.match(firstAuth.csrfToken, /^[a-f0-9]{64}$/);
  assert.notEqual(firstAuth.csrfToken, secondAuth.csrfToken);
  const headers = { Cookie: secondCookie };
  for (const route of ['/api/captain', '/logout', '/unknown']) {
    assert.equal((await post(status, route, { message: 'send' }, headers)).status, 403);
    assert.equal((await post(status, route, { message: 'send' }, { ...headers, 'X-CSRF-Token': firstAuth.csrfToken })).status, 403);
  }
  const valid = { ...headers, 'X-CSRF-Token': secondAuth.csrfToken };
  assert.equal((await request(status, '/api/captain', { method: 'POST', headers: { ...valid, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'send' }) })).status, 403);
  assert.equal((await post(status, '/api/captain', { message: 'send' }, valid)).status, 200);
  assert.deepEqual(messages, ['send']);
});

test('remote device cookies are independent, Secure, host-only, and persist only as hashes across restarts', async (t) => {
  const { status, server, saved } = await start(t, { publicOrigin: PUBLIC_ORIGIN });
  const first = await post(status, '/login', { token: status.token });
  const second = await post(status, '/login', { token: status.token });
  const a = first.headers['set-cookie'][0], b = second.headers['set-cookie'][0];
  assert.match(a, /^__Host-agentdeck_mobile=[a-f0-9]{64};/);
  assert.match(a, /; Secure;/);
  assert.match(a, /; HttpOnly;/);
  assert.match(a, /; SameSite=Strict;/);
  assert.match(a, /; Path=\//);
  assert.ok(!a.includes('Domain='));
  assert.notEqual(a, b);
  const value = a.split(';')[0].split('=')[1];
  assert.notEqual(value, status.token);
  const stored = saved.at(-1);
  assert.equal(stored.devices.length, 2);
  assert.ok(stored.devices.some((device) => device.hash === crypto.createHash('sha256').update(value).digest('hex')));
  assert.ok(!JSON.stringify(stored.devices).includes(value));
  assert.equal(server.status().deviceCount, 2);
  await server.close();
  const restarted = fixture();
  t.after(() => restarted.server.close());
  const restoredStatus = await restarted.server.configure(stored);
  restoredStatus.proxyHeaders = status.proxyHeaders;
  assert.equal((await request(restoredStatus, '/api/sessions', { headers: { Cookie: a.split(';')[0] } })).status, 200);
  assert.equal((await request(restoredStatus, '/api/sessions', { headers: { Cookie: '__Host-agentdeck_mobile=' + stored.devices[0].hash } })).status, 401);
  assert.equal((await request(restoredStatus, '/api/sessions', { headers: { Cookie: 'agentdeck_mobile=' + value } })).status, 401);
  assert.equal((await request(restoredStatus, '/api/sessions', { headers: { Cookie: a.split(';')[0] + '; ' + a.split(';')[0] } })).status, 401);
});

test('logout revokes one device durably and desktop revocation rotates token and all devices without changing the listener', async (t) => {
  const { status, server, saved } = await start(t);
  const loginA = await post(status, '/login', { token: status.token });
  const loginB = await post(status, '/login', { token: status.token });
  const a = loginA.headers['set-cookie'][0].split(';')[0], b = loginB.headers['set-cookie'][0].split(';')[0];
  const auth = JSON.parse((await request(status, '/api/auth', { headers: { Cookie: a } })).text);
  const logout = await post(status, '/logout', {}, { Cookie: a, 'X-CSRF-Token': auth.csrfToken });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: a } })).status, 401);
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: b } })).status, 200);
  assert.equal(saved.at(-1).devices.length, 1);
  const revoked = await server.revokeDevices();
  assert.equal(revoked.url, status.url);
  assert.notEqual(revoked.token, status.token);
  assert.equal(revoked.deviceCount, 0);
  assert.deepEqual(saved.at(-1).devices, []);
  assert.equal(saved.at(-1).token, revoked.token);
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: b } })).status, 401);
  assert.equal((await request(status, '/api/sessions', { headers: { Authorization: `Bearer ${status.token}` } })).status, 401);
  assert.equal((await post(status, '/login', { token: status.token })).status, 401);
  assert.equal((await post(status, '/login', { token: revoked.token })).status, 200);
});

test('expired devices cannot authenticate or mint CSRF tokens', async (t) => {
  let now = 1_000_000;
  const { status, server } = await start(t, {}, { now: () => now });
  const login = await post(status, '/login', { token: status.token });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  now += 30 * 24 * 60 * 60 * 1000;
  assert.equal(server.status().deviceCount, 0);
  assert.equal((await request(status, '/api/auth', { headers: { Cookie: cookie } })).status, 401);
});

test('login failure bans use overwritten proxy IPs, stop correct-token attempts while banned, and expire', async (t) => {
  let now = 1_000_000;
  const { status } = await start(t, { publicOrigin: PUBLIC_ORIGIN }, { now: () => now });
  for (let i = 1; i <= LOGIN_LIMITS.perIp; i++) {
    const result = await post(status, '/login', { token: 'incorrect' });
    assert.equal(result.status, i === LOGIN_LIMITS.perIp ? 429 : 401);
    if (result.status === 429) assert.equal(Number(result.headers['retry-after']), LOGIN_LIMITS.banMs / 1000);
  }
  assert.equal((await post(status, '/login', { token: status.token })).status, 429);
  assert.equal((await post(status, '/login', { token: status.token }, { 'X-Forwarded-For': '198.51.100.9' })).status, 200);
  now += LOGIN_LIMITS.banMs;
  assert.equal((await post(status, '/login', { token: status.token })).status, 200);
});

test('local clients cannot evade rate limits by spoofing forwarded client IPs', async (t) => {
  const { status } = await start(t);
  for (let i = 1; i <= LOGIN_LIMITS.perIp; i++) {
    assert.equal((await post(status, '/login', { token: 'incorrect' }, { 'X-Forwarded-For': `203.0.113.${i}`, 'X-Forwarded-Proto': 'https' })).status, i === LOGIN_LIMITS.perIp ? 429 : 401);
  }
  assert.equal((await post(status, '/login', { token: status.token }, { 'X-Forwarded-For': '198.51.100.99' })).status, 429);
});

test('distributed failures hit a global ceiling while remembered devices stay usable', async (t) => {
  const { status } = await start(t, { publicOrigin: PUBLIC_ORIGIN });
  const login = await post(status, '/login', { token: status.token });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  for (let i = 1; i <= LOGIN_LIMITS.global; i++) {
    assert.equal((await post(status, '/login', { token: 'incorrect' }, { 'X-Forwarded-For': `198.51.100.${i}` })).status, i === LOGIN_LIMITS.global ? 429 : 401);
  }
  assert.equal((await post(status, '/login', { token: status.token }, { 'X-Forwarded-For': '203.0.113.99' })).status, 429);
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: cookie } })).status, 200);
});

test('URL credentials are rejected without reflecting them and explicit bad headers never fall back to a remembered device', async (t) => {
  const { status } = await start(t, { publicOrigin: PUBLIC_ORIGIN });
  const login = await post(status, '/login', { token: status.token });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  for (const key of ['token', 'TOKEN', 'access_token', 'password']) {
    const response = await request(status, `/api/sessions?${key}=${status.token}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 400);
    assert.ok(!response.text.includes(status.token));
  }
  assert.equal((await request(status, '/api/sessions', { headers: { Cookie: cookie, Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await post(status, '/login', { token: 'incorrect' }, { Cookie: cookie })).status, 401);
});

test('failed device persistence issues no cookie, and failed revocation disables the service', async (t) => {
  const { server, status } = await start(t);
  server.sources.saveSettings = () => { throw new Error('private credential storage'); };
  const response = await post(status, '/login', { token: status.token });
  assert.equal(response.status, 500);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(server.status().deviceCount, 0);
  assert.ok(!response.text.includes('private'));
  const revoked = await server.revokeDevices();
  assert.equal(revoked.enabled, false);
  assert.equal(revoked.error, 'Could not save device revocation.');
});

test('configuration accepts only a pathless HTTPS public origin and a long random-format token', async (t) => {
  const { server, saved } = fixture();
  t.after(() => server.close());
  for (const origin of ['http://public.example', 'https://public.example/mobile', 'https://user:pass@public.example', 'https://public.example/?token=value', 'not a url']) {
    const result = await server.configure({ enabled: true, port: 0, publicOrigin: origin });
    assert.equal(result.enabled, false);
    assert.match(result.error, /HTTPS origin/);
  }
  assert.equal(saved.length, 0);
  assert.equal((await server.configure({ enabled: true, port: 0, publicOrigin: '', token: 'short-token' })).enabled, false);
  assert.equal(saved.length, 0);
});

test('device and bearer uploads accepted before revocation cannot execute captain or logout writes after revocation', async (t) => {
  for (const kind of ['cookie', 'bearer']) {
    for (const route of ['/api/captain', '/logout']) {
      const { server, status, auth, messages } = await start(t);
      let headers = auth;
      if (kind === 'cookie') {
        const login = await post(status, '/login', { token: status.token });
        const Cookie = login.headers['set-cookie'][0].split(';')[0];
        const session = JSON.parse((await request(status, '/api/auth', { headers: { Cookie } })).text);
        headers = { Cookie, 'X-CSRF-Token': session.csrfToken };
      }
      const held = delayedPost(server, status, route, route === '/logout' ? {} : { message: 'must not execute' }, headers);
      await held.arrived;
      await server.revokeDevices();
      held.complete();
      assert.equal((await held.response).status, 401, `${kind} ${route}`);
      assert.deepEqual(messages, []);
      assert.equal(server.status().deviceCount, 0);
    }
  }
});

test('device logout also blocks an already uploading command from the same device', async (t) => {
  const { server, status, messages } = await start(t);
  const login = await post(status, '/login', { token: status.token });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  const session = JSON.parse((await request(status, '/api/auth', { headers: { Cookie } })).text);
  const headers = { Cookie, 'X-CSRF-Token': session.csrfToken };
  const held = delayedPost(server, status, '/api/captain', { message: 'must not execute' }, headers);
  await held.arrived;
  assert.equal((await request(status, '/logout', { method: 'POST', headers: { ...headers, Origin: status.url } })).status, 200);
  held.complete();
  assert.equal((await held.response).status, 401);
  assert.deepEqual(messages, []);
});

test('a correct login upload started before an IP ban cannot clear or bypass the active ban', async (t) => {
  const { server, status } = await start(t);
  const held = delayedPost(server, status, '/login', { token: status.token });
  await held.arrived;
  for (let i = 1; i <= LOGIN_LIMITS.perIp; i++) {
    assert.equal((await post(status, '/login', { token: 'incorrect' })).status, i === LOGIN_LIMITS.perIp ? 429 : 401);
  }
  held.complete();
  assert.equal((await held.response).status, 429);
  assert.equal(server.status().deviceCount, 0);
  assert.equal((await post(status, '/login', { token: status.token })).status, 429);
});

test('logout persistence failure returns a generic 500 and closes the service with all current credentials invalidated', async (t) => {
  const { server, status } = await start(t);
  const login = await post(status, '/login', { token: status.token });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  const session = JSON.parse((await request(status, '/api/auth', { headers: { Cookie } })).text);
  const headers = { Cookie, 'X-CSRF-Token': session.csrfToken };
  server.sources.saveSettings = () => { throw new Error('private credential store error'); };
  const logout = await post(status, '/logout', {}, headers);
  assert.equal(logout.status, 500);
  assert.equal(server.status().enabled, false);
  assert.equal(server.status().deviceCount, 0);
  assert.equal(server.credential({ headers }), null);
  assert.equal(server.credential({ headers: { authorization: `Bearer ${status.token}` } }), null);
  assert.ok(!logout.text.includes('private'));
});

// ---- image upload ----
const fsp = require('node:fs/promises');
const os = require('node:os');
const nodePath = require('node:path');
const { IMAGE_LIMITS } = require('../mobile-web');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
const SAMPLES = {
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]),
  png: PNG,
  gif: Buffer.from('GIF89a gif body'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
};
async function startUploads(t, options = {}) {
  const uploadDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'agentdeck-upload-test-'));
  t.after(() => fsp.rm(uploadDir, { recursive: true, force: true }));
  const f = await start(t, {}, { uploadDir, ...options });
  f.uploadDir = uploadDir;
  f.upload = (body, headers = {}) => request(f.status, '/api/upload', { method: 'POST', body,
    headers: { 'Content-Type': 'application/octet-stream', Origin: f.status.url, ...f.auth, ...headers } });
  f.stored = () => fsp.readdir(uploadDir).catch(() => []);
  return f;
}

test('image upload requires login, CSRF and the same origin, and writes nothing when refused', async (t) => {
  const f = await startUploads(t);
  const { status } = f;
  const send = (headers) => request(status, '/api/upload', { method: 'POST', body: PNG, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
  assert.equal((await send({ Origin: status.url })).status, 401);
  assert.equal((await send({ Origin: status.url, Authorization: f.auth.Authorization })).status, 403);
  assert.equal((await send({ Origin: status.url, Authorization: f.auth.Authorization, 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await send({ Origin: 'https://other.example', ...f.auth })).status, 403);
  assert.equal((await send({ ...f.auth })).status, 403);
  // A remembered device cookie alone is not enough either.
  const login = await post(status, '/login', { token: status.token });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await send({ Origin: status.url, Cookie })).status, 403);
  const csrf = JSON.parse((await request(status, '/api/auth', { headers: { Cookie } })).text).csrfToken;
  assert.equal((await send({ Origin: status.url, Cookie, 'X-CSRF-Token': csrf })).status, 200);
  assert.equal((await f.stored()).length, 1);
  assert.equal((await request(status, '/api/upload', { headers: f.auth })).status, 404);
});

test('image upload trusts only the file signature, limits size and never uses a client name', async (t) => {
  const f = await startUploads(t);
  // Not an image, whatever the request claims.
  assert.equal((await f.upload(Buffer.from('<script>alert(1)</script>'))).status, 415);
  assert.equal((await f.upload(Buffer.from('#!/bin/sh\nrm -rf ~\n'), { 'X-File-Name': 'photo.png' })).status, 415);
  assert.equal((await f.upload(Buffer.alloc(0))).status, 415);
  // HEIC is converted on the phone; the raw container is refused here.
  assert.equal((await f.upload(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]))).status, 415);
  assert.equal((await f.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
  // The declared type is not what decides: only raw bytes are read.
  assert.equal((await f.upload(PNG, { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await f.upload(PNG, { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await f.upload(Buffer.concat([PNG, Buffer.alloc(IMAGE_LIMITS.bytes)]))).status, 413);
  assert.deepEqual(await f.stored(), []);
  for (const [kind, data] of Object.entries(SAMPLES)) {
    const response = await f.upload(data, { 'X-File-Name': '../../evil.sh', 'Content-Disposition': 'attachment; filename="../../evil.sh"' });
    assert.equal(response.status, 200);
    const { id } = JSON.parse(response.text);
    assert.match(id, new RegExp('^[a-f0-9]{32}\\.' + kind + '$'));
    const file = nodePath.join(f.uploadDir, id);
    assert.deepEqual(await fsp.readFile(file), data);
    if (process.platform !== 'win32') assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  }
  const names = await f.stored();
  assert.equal(names.length, 4);
  assert.ok(names.every((name) => /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(name)));
  assert.equal(new Set(names).size, 4);
});

test('uploaded images are served only to a logged-in device and only by server id', async (t) => {
  const f = await startUploads(t);
  const { status } = f;
  const { id } = JSON.parse((await f.upload(PNG)).text);
  assert.equal((await request(status, '/api/image?id=' + id)).status, 401);
  assert.equal((await request(status, '/api/image?id=' + id, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const image = await request(status, '/api/image?id=' + id, { headers: f.auth });
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.equal(image.text, PNG.toString('utf8'));
  // Anything that is not a server id is refused before touching the disk.
  await fsp.writeFile(nodePath.join(f.uploadDir, '..', 'outside.png'), PNG).catch(() => {});
  for (const bad of ['../outside.png', '..%2Foutside.png', '%2e%2e%2f' + id, '/etc/passwd', id + '/..', 'a.png', id.toUpperCase(), id + '%00', '']) {
    assert.equal((await request(status, '/api/image?id=' + bad, { headers: f.auth })).status, 400, bad);
  }
  await fsp.rm(nodePath.join(f.uploadDir, '..', 'outside.png'), { force: true });
  assert.equal((await request(status, '/api/image', { headers: f.auth })).status, 400);
  assert.equal((await request(status, '/api/image?id=' + '0'.repeat(32) + '.png', { headers: f.auth })).status, 404);
  // A link planted under a valid-looking name is not followed.
  if (process.platform !== 'win32') {
    const planted = 'f'.repeat(32) + '.png';
    await fsp.symlink('/etc/hosts', nodePath.join(f.uploadDir, planted));
    assert.equal((await request(status, '/api/image?id=' + planted, { headers: f.auth })).status, 404);
    assert.equal((await post(status, '/api/captain', { message: '看图', images: [planted] }, f.auth)).status, 400);
  }
});

test('a Captain message carries uploaded images as paths inside the upload directory', async (t) => {
  const sent = [];
  const f = await startUploads(t, { sendCaptain: (message, files) => sent.push({ message, files }) });
  const { status } = f;
  const ids = [];
  for (let i = 0; i < IMAGE_LIMITS.perMessage + 1; i++) ids.push(JSON.parse((await f.upload(PNG)).text).id);
  const send = (body) => post(status, '/api/captain', body, f.auth);
  assert.equal((await send({ message: '看这两张', images: ids.slice(0, 2) })).status, 200);
  assert.equal((await send({ message: '', images: ids.slice(2, 3) })).status, 200);
  assert.equal((await send({ message: '只有文字' })).status, 200);
  assert.deepEqual(sent, [
    { message: '看这两张', files: ids.slice(0, 2).map((id) => nodePath.join(f.uploadDir, id)) },
    { message: '', files: [nodePath.join(f.uploadDir, ids[2])] },
    { message: '只有文字', files: [] },
  ]);
  for (const body of [
    { message: '', images: [] }, { message: '   ' },
    { message: '太多', images: ids },
    { message: '重复', images: [ids[0], ids[0]] },
    { message: '不存在', images: ['0'.repeat(32) + '.png'] },
    { message: '路径', images: ['../../etc/passwd'] },
    { message: '路径', images: [nodePath.join(f.uploadDir, ids[0])] },
    { message: '类型', images: ids[0] }, { message: '类型', images: [42] },
    { message: '多余字段', images: [ids[0]], to: 'worker' },
  ]) assert.equal((await send(body)).status, 400, JSON.stringify(body));
  assert.equal(sent.length, 3);
  assert.equal((await post(status, '/api/captain', { message: '看图', images: [ids[0]] }, { Authorization: f.auth.Authorization })).status, 403);
});

test('device revocation during an upload leaves no file behind', async (t) => {
  const f = await startUploads(t);
  const { server, status } = f;
  const arrived = new Promise((resolve) => server.server.once('request', resolve));
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(status.url + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': PNG.length, Origin: status.url, ...f.auth } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(PNG.subarray(0, 4));
  });
  await arrived;
  await server.revokeDevices();
  req.end(PNG.subarray(4));
  assert.equal(await response, 401);
  assert.deepEqual(await f.stored(), []);
});

test('uploads older than a month are swept when the service starts; other files are left alone', async (t) => {
  const uploadDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'agentdeck-upload-test-'));
  t.after(() => fsp.rm(uploadDir, { recursive: true, force: true }));
  const stale = 'a'.repeat(32) + '.jpg', fresh = 'b'.repeat(32) + '.png';
  for (const name of [stale, fresh, 'notes.txt']) await fsp.writeFile(nodePath.join(uploadDir, name), PNG);
  const old = new Date(Date.now() - IMAGE_LIMITS.keepMs - 60_000);
  await fsp.utimes(nodePath.join(uploadDir, stale), old, old);
  await fsp.utimes(nodePath.join(uploadDir, 'notes.txt'), old, old);
  const f = fixture({ uploadDir });
  t.after(() => f.server.close());
  await f.server.configure({ enabled: true, port: 0 });
  await f.server.sweepUploads();
  assert.deepEqual((await fsp.readdir(uploadDir)).sort(), [fresh, 'notes.txt']);
});

test('without an upload directory the upload route does not exist', async (t) => {
  const f = await start(t);
  assert.equal((await request(f.status, '/api/upload', { method: 'POST', body: PNG, headers: { 'Content-Type': 'application/octet-stream', Origin: f.status.url, ...f.auth } })).status, 404);
  assert.equal((await request(f.status, '/api/image?id=' + '0'.repeat(32) + '.png', { headers: f.auth })).status, 404);
});

test('the upload directory is capped: day-old images make room, otherwise the upload is refused', async (t) => {
  const limits = { ...IMAGE_LIMITS };
  t.after(() => Object.assign(IMAGE_LIMITS, limits));
  const f = await startUploads(t);
  IMAGE_LIMITS.maxFiles = 3;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(JSON.parse((await f.upload(PNG)).text).id);
  // Full of today's images: refused with a clear status, nothing removed.
  const refused = await f.upload(PNG);
  assert.equal(refused.status, 507);
  assert.match(refused.text, /storage is full/);
  assert.deepEqual((await f.stored()).sort(), [...ids].sort());
  // Parallel uploads cannot slip past the cap together.
  assert.deepEqual((await Promise.all([f.upload(PNG), f.upload(PNG), f.upload(PNG)])).map((r) => r.status), [507, 507, 507]);
  // Two images are more than a day old: the oldest one is dropped, only as many as needed.
  const age = (id, hours) => { const time = new Date(Date.now() - hours * 60 * 60 * 1000); return fsp.utimes(nodePath.join(f.uploadDir, id), time, time); };
  await age(ids[0], 30); await age(ids[1], 50);
  const next = await f.upload(PNG);
  assert.equal(next.status, 200);
  assert.deepEqual((await f.stored()).sort(), [ids[0], ids[2], JSON.parse(next.text).id].sort());
  // The byte cap works the same way.
  IMAGE_LIMITS.maxFiles = 200; IMAGE_LIMITS.maxTotalBytes = PNG.length * 3;
  assert.equal((await f.upload(PNG)).status, 200);
  assert.ok(!(await f.stored()).includes(ids[0]));
  assert.equal((await f.upload(PNG)).status, 507);
  assert.equal((await f.stored()).length, 3);
  // Expired images are cleared on upload too, not only at start.
  const old = new Date(Date.now() - IMAGE_LIMITS.keepMs - 60_000);
  for (const name of await f.stored()) await fsp.utimes(nodePath.join(f.uploadDir, name), old, old);
  IMAGE_LIMITS.maxTotalBytes = limits.maxTotalBytes;
  assert.equal((await f.upload(PNG)).status, 200);
  assert.equal((await f.stored()).length, 1);
});
