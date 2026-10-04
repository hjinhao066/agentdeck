'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileWebServer, LOGIN_LIMITS, boardVersionOf, supportsLoginItem, readEndpoint, withEndpoint, persistable } = require('../mobile-web');
const PUBLIC_ORIGIN = 'https://agentdeck.18-139-28-180.sslip.io';
const PROXY = { Host: new URL(PUBLIC_ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };

function machine(options = {}) {
  const sessions = [{ id: 'captain', title: '队长', model: 'Codex', status: 'idle', isMain: true, receipt: '' }];
  const captain = { id: 'captain', title: '队长', status: 'idle', turns: [{ id: 'turn-1', user: '指令', reply: '回复', done: true }] };
  const messages = [], saved = [];
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: () => [], getCaptain: () => captain,
    getOutput: () => null, sendCaptain: (message) => messages.push(message), saveSettings: (settings) => saved.push(settings),
    getBoardVersion: () => 'board-v1', machine: { platform: 'win32', hostname: 'OWENJH', appVersion: '1.1.4' }, ...options });
  return { server, sessions, captain, messages, saved };
}
async function start(t, basePath, label, settings = {}, options = {}) {
  const m = machine(options);
  t.after(() => m.server.close());
  const status = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath, label, ...settings });
  assert.equal(status.enabled, true, status.error);
  m.status = status;
  m.base = basePath || '/';
  return m;
}
function raw(status, route, { method = 'GET', headers = {}, body, proxy = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(status.url + route, { method, headers: { ...(proxy ? PROXY : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (m, route, headers, proxy = true) => raw(m.status, m.base + route, { headers, proxy });
function post(m, route, body, headers = {}, { proxy = true, origin = PUBLIC_ORIGIN } = {}) {
  return raw(m.status, m.base + route, { method: 'POST', proxy, headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
}
async function login(m) {
  const response = await post(m, 'login', { token: m.status.token });
  assert.equal(response.status, 200);
  const setCookie = response.headers['set-cookie'][0];
  const cookie = setCookie.split(';')[0];
  const snapshot = JSON.parse((await get(m, 'api/snapshot', { Cookie: cookie })).text);
  return { setCookie, cookie, csrf: snapshot.csrfToken };
}

test('basePath must be one lowercase path segment with slashes and label must be short plain text; invalid values never start or persist', async (t) => {
  for (const basePath of ['mac', '/mac', '/', '//', '/a/b/', '/Mac/', '/mac /', '/../', '/mac%2f/', '/' + 'a'.repeat(33) + '/', 7, 0, null, false, true, {}, ['/mac/']]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath });
    assert.equal(result.enabled, false, String(basePath));
    assert.equal(result.error, 'Invalid base path.');
    assert.equal(m.saved.length, 0);
  }
  for (const label of ['x'.repeat(33), 'a\nb', 'a\0b', '<b>', 7, 0, null, false, {}]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label });
    assert.equal(result.enabled, false, String(label));
    assert.equal(result.error, 'Invalid machine label.');
    assert.equal(m.saved.length, 0);
  }
  const ok = await start(t, '/win/', 'Windows');
  assert.equal(ok.status.basePath, '/win/');
  assert.equal(ok.status.label, 'Windows');
  assert.equal(ok.saved.at(-1).basePath, '/win/');
});

test('with basePath, public requests without the prefix are 404 before any authentication, even with a valid bearer or cookie', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const { cookie } = await login(m);
  const bearer = { Authorization: `Bearer ${m.status.token}` };
  for (const route of ['/', '/login', '/api/snapshot', '/api/auth', '/api/sessions', '/app.js', '/logout',
    '/win', '/winx/api/snapshot', '/WIN/api/snapshot', '//win/api/snapshot', '/mac/api/snapshot', '/win/../api/snapshot', '/win/%2e%2e/api/snapshot']) {
    for (const headers of [{}, bearer, { Cookie: cookie }]) {
      const response = await raw(m.status, route, { headers });
      // A protocol-relative path parses as another origin and is refused earlier as an invalid URL.
      if (route === '//win/api/snapshot') { assert.equal(response.status, 400, route); continue; }
      assert.equal(response.status, 404, route);
      assert.deepEqual(JSON.parse(response.text), { error: 'Not found.' });
    }
  }
  const unprefixedLogin = await raw(m.status, '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN }, body: JSON.stringify({ token: m.status.token }) });
  assert.equal(unprefixedLogin.status, 404);
  assert.equal(unprefixedLogin.headers['set-cookie'], undefined);
  assert.equal(m.saved.at(-1).devices.length, 1);
  assert.equal((await get(m, 'api/snapshot', bearer)).status, 200);
  // An encoded slash is not decoded, so it stays inside this machine's prefix and matches no route.
  assert.equal((await get(m, '..%2fmac/api/snapshot')).status, 401);
  assert.equal((await get(m, '..%2fmac/api/snapshot', bearer)).status, 404);
});

test('prefixed requests with a wrong explicit credential are not counted before the prefix check but are counted and banned after it', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  for (let i = 0; i < LOGIN_LIMITS.perIp + 2; i++) assert.equal((await raw(m.status, '/api/snapshot', { headers: { Authorization: 'Bearer wrong' } })).status, 404);
  assert.equal((await post(m, 'login', { token: m.status.token })).status, 200);
  for (let i = 1; i <= LOGIN_LIMITS.perIp; i++) {
    const result = await get(m, 'api/snapshot', { Authorization: 'Bearer wrong' });
    assert.equal(result.status, i === LOGIN_LIMITS.perIp ? 429 : 401);
  }
  assert.equal((await post(m, 'login', { token: m.status.token })).status, 429);
});

test('unauthenticated prefixed routes are JSON 401 and never serve the embedded login page or bundled assets; loopback keeps the legacy page', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  for (const route of ['', 'api/snapshot', 'api/auth', 'api/captain', 'api/sessions', 'api/tasks', 'api/output?id=captain', 'app.js', 'style.css', 'other']) {
    const response = await get(m, route);
    assert.equal(response.status, 401, route);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(response.text), { error: 'Unauthorized.' });
    assert.ok(!response.text.includes('登录 token'));
  }
  const auth = { Authorization: `Bearer ${m.status.token}` };
  for (const route of ['', 'app.js', 'style.css']) assert.equal((await get(m, route, auth)).status, 404, route);
  const direct = await raw(m.status, '/', { proxy: false });
  assert.equal(direct.status, 401);
  assert.match(direct.text, /登录 token/);
  assert.equal((await raw(m.status, '/', { proxy: false, headers: auth })).status, 200);
  assert.equal((await raw(m.status, '/win/api/snapshot', { proxy: false, headers: auth })).status, 404);
  assert.equal((await raw(m.status, '/api/snapshot', { proxy: false, headers: auth })).status, 200);
});

test('prefixed login sets a machine-specific Secure host-only cookie scoped to the prefix, and the cookie authenticates only there', async (t) => {
  const win = await start(t, '/win/', 'Windows');
  const mac = await start(t, '/mac/', 'Mac');
  const a = await login(win), b = await login(mac);
  assert.match(a.setCookie, /^__Secure-agentdeck_win=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/win\/; Max-Age=2592000$/);
  assert.match(b.setCookie, /^__Secure-agentdeck_mac=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/mac\/; Max-Age=2592000$/);
  assert.ok(!a.setCookie.includes('Domain='));
  assert.ok(!a.setCookie.includes(win.status.token));
  const value = a.cookie.split('=')[1];
  const stored = win.saved.at(-1).devices;
  assert.deepEqual(stored.map((d) => d.hash), [crypto.createHash('sha256').update(value).digest('hex')]);
  assert.equal((await get(win, 'api/snapshot', { Cookie: a.cookie })).status, 200);
  assert.equal((await get(win, 'api/snapshot', { Cookie: `__Secure-agentdeck_win=${stored[0].hash}` })).status, 401);
});

test('a Mac cookie under /win/ and a Windows cookie under /mac/ are 401 by name and by value, and legacy cookie names are ignored', async (t) => {
  const win = await start(t, '/win/', 'Windows');
  const mac = await start(t, '/mac/', 'Mac');
  const a = await login(win), b = await login(mac);
  const winValue = a.cookie.split('=')[1], macValue = b.cookie.split('=')[1];
  assert.equal((await get(win, 'api/snapshot', { Cookie: b.cookie })).status, 401);
  assert.equal((await get(mac, 'api/snapshot', { Cookie: a.cookie })).status, 401);
  // Even renamed to the other machine's expected cookie name, a foreign value has no registered hash.
  assert.equal((await get(win, 'api/snapshot', { Cookie: `__Secure-agentdeck_win=${macValue}` })).status, 401);
  assert.equal((await get(mac, 'api/snapshot', { Cookie: `__Secure-agentdeck_mac=${winValue}` })).status, 401);
  for (const name of ['__Host-agentdeck_mobile', 'agentdeck_mobile']) {
    assert.equal((await get(win, 'api/snapshot', { Cookie: `${name}=${winValue}` })).status, 401, name);
  }
  // A prefix-sharing name is not this machine's cookie, and a duplicate of the right name is refused.
  assert.equal((await get(win, 'api/snapshot', { Cookie: `__Secure-agentdeck_win2=${winValue}` })).status, 401);
  assert.equal((await get(win, 'api/snapshot', { Cookie: `${a.cookie}; ${a.cookie}` })).status, 401);
  assert.equal((await get(win, 'api/snapshot', { Cookie: `${b.cookie}; ${a.cookie}` })).status, 200);
});

test('tokens are per machine: the other machine\'s token cannot log in and counts toward that machine\'s ban', async (t) => {
  const win = await start(t, '/win/', 'Windows');
  const mac = await start(t, '/mac/', 'Mac');
  assert.notEqual(win.status.token, mac.status.token);
  for (let i = 1; i <= LOGIN_LIMITS.perIp; i++) {
    const result = await post(win, 'login', { token: mac.status.token });
    assert.equal(result.status, i === LOGIN_LIMITS.perIp ? 429 : 401);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.equal((await post(win, 'login', { token: win.status.token })).status, 429);
  assert.equal((await post(mac, 'login', { token: mac.status.token })).status, 200);
  assert.equal((await get(win, 'api/snapshot', { Authorization: `Bearer ${mac.status.token}` })).status, 429);
});

test('CSRF tokens are per machine and per device, and each machine requires its own for writes and logout', async (t) => {
  const win = await start(t, '/win/', 'Windows');
  const mac = await start(t, '/mac/', 'Mac');
  const a = await login(win), b = await login(mac);
  const second = await login(win);
  assert.match(a.csrf, /^[a-f0-9]{64}$/);
  assert.notEqual(a.csrf, b.csrf);
  assert.notEqual(a.csrf, second.csrf);
  const headers = { Cookie: a.cookie };
  assert.equal((await post(win, 'api/captain', { message: 'send' }, headers)).status, 403);
  assert.equal((await post(win, 'api/captain', { message: 'send' }, { ...headers, 'X-CSRF-Token': b.csrf })).status, 403);
  assert.equal((await post(win, 'api/captain', { message: 'send' }, { ...headers, 'X-CSRF-Token': second.csrf })).status, 403);
  assert.equal((await post(win, 'logout', {}, { ...headers, 'X-CSRF-Token': b.csrf })).status, 403);
  assert.deepEqual(win.messages, []);
  assert.equal((await post(win, 'api/captain', { message: 'to windows' }, { ...headers, 'X-CSRF-Token': a.csrf })).status, 200);
  assert.deepEqual(win.messages, ['to windows']);
  assert.deepEqual(mac.messages, []);
  assert.equal((await post(mac, 'api/captain', { message: 'x' }, { Cookie: b.cookie, 'X-CSRF-Token': a.csrf })).status, 403);
  assert.deepEqual(mac.messages, []);
});

test('prefixed writes still require an exact public Origin and the proxy contract', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const { cookie, csrf } = await login(m);
  const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  for (const origin of ['https://evil.example', 'null', 'http://' + new URL(PUBLIC_ORIGIN).host, m.status.url]) {
    assert.equal((await post(m, 'api/captain', { message: 'x' }, headers, { origin })).status, 403, origin);
  }
  assert.equal((await post(m, 'api/captain', { message: 'x' }, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(m, 'login', { token: m.status.token }, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(m, 'api/snapshot', { Cookie: cookie, Host: 'other.example' })).status, 403);
  assert.equal((await get(m, 'api/snapshot', { Cookie: cookie, 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' })).status, 403);
  assert.deepEqual(m.messages, []);
});

test('prefixed logout revokes only this device, clears the scoped cookie, and refuses bearer credentials', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const first = await login(m), second = await login(m);
  assert.equal((await post(m, 'logout', {}, { Authorization: `Bearer ${m.status.token}`, 'X-CSRF-Token': first.csrf })).status, 403);
  const bearerAuth = JSON.parse((await get(m, 'api/auth', { Authorization: `Bearer ${m.status.token}` })).text);
  const bearer = await post(m, 'logout', {}, { Authorization: `Bearer ${m.status.token}`, 'X-CSRF-Token': bearerAuth.csrfToken });
  assert.equal(bearer.status, 400);
  const out = await post(m, 'logout', {}, { Cookie: first.cookie, 'X-CSRF-Token': first.csrf });
  assert.equal(out.status, 200);
  assert.equal(out.headers['set-cookie'][0], '__Secure-agentdeck_win=; HttpOnly; Secure; SameSite=Strict; Path=/win/; Max-Age=0');
  assert.equal((await get(m, 'api/snapshot', { Cookie: first.cookie })).status, 401);
  assert.equal((await get(m, 'api/snapshot', { Cookie: second.cookie })).status, 200);
  assert.equal(m.saved.at(-1).devices.length, 1);
});

test('desktop revocation on one machine rotates only that machine\'s token, devices and CSRF secret', async (t) => {
  const win = await start(t, '/win/', 'Windows');
  const mac = await start(t, '/mac/', 'Mac');
  const a = await login(win), b = await login(mac);
  const revoked = await win.server.revokeDevices();
  assert.equal(revoked.basePath, '/win/');
  assert.equal(revoked.deviceCount, 0);
  assert.equal((await get(win, 'api/snapshot', { Cookie: a.cookie })).status, 401);
  assert.equal((await post(win, 'api/captain', { message: 'x' }, { Cookie: a.cookie, 'X-CSRF-Token': a.csrf })).status, 401);
  assert.equal((await post(win, 'login', { token: win.status.token })).status, 401);
  assert.equal((await post(win, 'login', { token: revoked.token })).status, 200);
  assert.equal((await get(mac, 'api/snapshot', { Cookie: b.cookie })).status, 200);
  assert.equal((await post(mac, 'api/captain', { message: 'still ok' }, { Cookie: b.cookie, 'X-CSRF-Token': b.csrf })).status, 200);
});

test('device persistence under a prefix keeps only hashes, survives restart, and expiry and the 20-device cap still apply', async (t) => {
  let now = 1_000_000;
  const m = await start(t, '/win/', 'Windows', {}, { now: () => now });
  const logins = [];
  for (let i = 0; i < 21; i++) logins.push(await login(m));
  assert.equal(m.saved.at(-1).devices.length, 20);
  assert.equal((await get(m, 'api/snapshot', { Cookie: logins[0].cookie })).status, 401);
  assert.equal((await get(m, 'api/snapshot', { Cookie: logins[20].cookie })).status, 200);
  const stored = m.saved.at(-1);
  assert.ok(!JSON.stringify(stored).includes(logins[20].cookie.split('=')[1]));
  await m.server.close();
  const restarted = machine({ now: () => now });
  t.after(() => restarted.server.close());
  restarted.status = await restarted.server.configure(stored);
  restarted.base = '/win/';
  assert.equal(restarted.status.basePath, '/win/');
  assert.equal((await get(restarted, 'api/snapshot', { Cookie: logins[20].cookie })).status, 200);
  now += 30 * 24 * 60 * 60 * 1000;
  assert.equal((await get(restarted, 'api/snapshot', { Cookie: logins[20].cookie })).status, 401);
});

test('api/snapshot returns exactly the contract fields from one request and needs a credential', async (t) => {
  const m = await start(t, '/win/', 'Windows', {}, { now: () => 1_700_000_000_000 });
  assert.equal((await get(m, 'api/snapshot')).status, 401);
  assert.equal((await get(m, 'api/snapshot', { Authorization: 'Bearer wrong' })).status, 401);
  const { cookie, csrf } = await login(m);
  const response = await get(m, 'api/snapshot', { Cookie: cookie });
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = JSON.parse(response.text);
  assert.deepEqual(Object.keys(body).sort(), ['apiVersion', 'boardVersion', 'captain', 'csrfToken', 'machine', 'now', 'sessions']);
  assert.equal(body.apiVersion, 2);
  assert.deepEqual(body.machine, { id: 'win', label: 'Windows', platform: 'win32', hostname: 'OWENJH', appVersion: '1.1.4' });
  assert.equal(body.now, 1_700_000_000_000);
  assert.equal(body.csrfToken, csrf);
  assert.deepEqual(Object.keys(body.captain).sort(), ['id', 'status', 'title', 'turns']);
  assert.deepEqual(body.captain, { id: 'captain', title: '队长', status: 'idle', turns: m.captain.turns });
  assert.deepEqual(body.sessions, m.sessions);
  assert.equal(body.boardVersion, 'board-v1');
  const auth = JSON.parse((await get(m, 'api/auth', { Cookie: cookie })).text);
  assert.equal(auth.csrfToken, body.csrfToken);
  const bearer = JSON.parse((await get(m, 'api/snapshot', { Authorization: `Bearer ${m.status.token}` })).text);
  assert.notEqual(bearer.csrfToken, body.csrfToken);
  assert.equal((await post(m, 'api/snapshot', {}, { Cookie: cookie, 'X-CSRF-Token': csrf })).status, 404);
});

test('api/snapshot degrades safely when the captain or board version is unavailable and surfaces source failures as generic 500s', async (t) => {
  const m = await start(t, '/mac/', undefined, {}, { getBoardVersion: () => { throw new Error('private path'); } });
  m.server.sources.getCaptain = () => ({ turns: [], status: 'unavailable' });
  const auth = { Authorization: `Bearer ${m.status.token}` };
  const body = JSON.parse((await get(m, 'api/snapshot', auth)).text);
  assert.deepEqual(body.captain, { id: '', title: '', status: 'unavailable', turns: [] });
  assert.equal(body.boardVersion, '');
  assert.equal(body.machine.label, 'Windows', 'label defaults from the platform when none is configured');
  m.server.sources.getCaptain = null;
  assert.equal(JSON.parse((await get(m, 'api/snapshot', auth)).text).captain.status, 'unavailable');
  m.server.sources.getSessions = () => { throw new Error('private terminal output'); };
  const failure = await get(m, 'api/snapshot', auth);
  assert.equal(failure.status, 500);
  assert.deepEqual(JSON.parse(failure.text), { error: 'Local service unavailable.' });
  assert.ok(!failure.text.includes('private'));
});

test('api/snapshot on a legacy loopback client reports machine id local and the same CSRF contract', async (t) => {
  const m = machine();
  t.after(() => m.server.close());
  const status = await m.server.configure({ enabled: true, port: 0 });
  const auth = { Authorization: `Bearer ${status.token}` };
  const body = JSON.parse((await raw(status, '/api/snapshot', { headers: auth, proxy: false })).text);
  assert.equal(body.machine.id, 'local');
  assert.equal(body.apiVersion, 2);
  assert.equal(body.csrfToken, JSON.parse((await raw(status, '/api/auth', { headers: auth, proxy: false })).text).csrfToken);
  assert.equal(status.basePath, undefined);
});

test('boardVersion changes only when board files change and never contains board content', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const empty = boardVersionOf(dir);
  assert.match(empty, /^[a-f0-9]{16}$/);
  assert.equal(boardVersionOf(dir), empty);
  const file = path.join(dir, 'AgentDeck.json');
  fs.writeFileSync(file, JSON.stringify({ cards: [{ title: 'SECRET-CARD-TEXT' }] }));
  const one = boardVersionOf(dir);
  assert.notEqual(one, empty);
  assert.ok(!one.includes('SECRET'));
  assert.equal(boardVersionOf(dir), one);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a board file');
  assert.equal(boardVersionOf(dir), one, 'non-board files are ignored');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ cards: [{ title: 'SECRET-CARD-TEXT' }, 1] }));
  fs.renameSync(file + '.tmp', file);
  const two = boardVersionOf(dir);
  assert.notEqual(two, one);
  const same = JSON.stringify({ cards: [{ title: 'SECRET-CARD-TEXT' }, 2] });
  fs.writeFileSync(file + '.tmp', same);
  fs.renameSync(file + '.tmp', file);
  assert.notEqual(boardVersionOf(dir), two, 'same-size rewrite still changes the version');
  fs.writeFileSync(path.join(dir, 'Other.json'), '{}');
  assert.notEqual(boardVersionOf(dir), two);
  fs.rmSync(path.join(dir, 'Other.json'));
  fs.rmSync(file);
  assert.equal(boardVersionOf(dir), empty);
  assert.equal(boardVersionOf(path.join(dir, 'missing')), '');
});

test('without basePath the legacy login page, cookie and routes are byte for byte unchanged', async (t) => {
  const m = machine();
  t.after(() => m.server.close());
  const status = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN });
  assert.deepEqual(Object.keys(status).sort(), ['deviceCount', 'enabled', 'error', 'port', 'publicOrigin', 'publicUrl', 'token', 'url']);
  assert.deepEqual(Object.keys(m.saved.at(-1)).sort(), ['devices', 'enabled', 'port', 'publicOrigin', 'token']);
  const root = await raw(status, '/');
  assert.equal(root.status, 401);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.match(root.text, /fetch\('\/login'/);
  const response = await raw(status, '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN }, body: JSON.stringify({ token: status.token }) });
  assert.match(response.headers['set-cookie'][0], /^__Host-agentdeck_mobile=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  for (const route of ['/', '/app.js', '/style.css']) assert.equal((await raw(status, route, { headers: { Cookie: cookie } })).status, 200, route);
  assert.equal((await raw(status, '/mac/api/sessions', { headers: { Cookie: cookie } })).status, 404);
  const cookieOnly = (name) => raw(status, '/api/sessions', { headers: { Cookie: `${name}=${cookie.split('=')[1]}` } });
  assert.equal((await cookieOnly('__Secure-agentdeck_mac')).status, 401);
  assert.equal((await cookieOnly('__Host-agentdeck_mobile')).status, 200);
  const local = machine();
  t.after(() => local.server.close());
  const localStatus = await local.server.configure({ enabled: true, port: 0 });
  const localLogin = await raw(localStatus, '/login', { method: 'POST', proxy: false, headers: { 'Content-Type': 'application/json', Origin: localStatus.url }, body: JSON.stringify({ token: localStatus.token }) });
  assert.match(localLogin.headers['set-cookie'][0], /^agentdeck_mobile=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
});

test('login item registration is supported on macOS and Windows only', () => {
  assert.equal(supportsLoginItem('darwin'), true);
  assert.equal(supportsLoginItem('win32'), true);
  for (const platform of ['linux', 'freebsd', '', undefined, null]) assert.equal(supportsLoginItem(platform), false);
});

test('api/info is an unauthenticated, fixed, non-sensitive probe that respects prefix, host and method rules and never counts as a login failure', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const response = await get(m, 'api/info');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  const body = JSON.parse(response.text);
  assert.deepEqual(body, { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath'],
    machine: { id: 'win', label: 'Windows', platform: 'win32' } });
  for (const secret of [m.status.token, 'OWENJH', '1.1.4', 'captain']) assert.ok(!response.text.includes(secret), secret);
  // Same answer with a cookie, and the probe ignores query-free credentials entirely.
  const { cookie } = await login(m);
  assert.deepEqual(JSON.parse((await get(m, 'api/info', { Cookie: cookie })).text), body);
  // Prefix, host, method and URL rules still apply.
  assert.equal((await raw(m.status, '/api/info')).status, 404);
  assert.equal((await get(m, 'api/info', { Host: 'other.example' })).status, 403);
  assert.equal((await get(m, 'api/info', { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' })).status, 403);
  assert.equal((await raw(m.status, '/win/api/info?token=x', { headers: {} })).status, 400);
  assert.equal((await post(m, 'api/info', {})).status, 401);
  assert.equal((await get(m, 'api/info/')).status, 401);
  // Unlimited probes never ban the caller; an explicit wrong credential still counts.
  for (let i = 0; i < LOGIN_LIMITS.perIp * 3; i++) assert.equal((await get(m, 'api/info')).status, 200);
  assert.equal((await post(m, 'login', { token: m.status.token })).status, 200);
  assert.equal((await get(m, 'api/info', { Authorization: 'Bearer wrong' })).status, 401);
  // Other machine reports its own identity; a legacy unprefixed loopback client is 'local'.
  const mac = await start(t, '/mac/', 'Mac');
  assert.equal(JSON.parse((await get(mac, 'api/info')).text).machine.id, 'mac');
  const local = machine();
  t.after(() => local.server.close());
  const status = await local.server.configure({ enabled: true, port: 0 });
  assert.equal(JSON.parse((await raw(status, '/api/info', { proxy: false })).text).machine.id, 'local');
});

test('basePath null, false or 0 refuse to start like any malformed prefix; only undefined and the empty string mean the legacy mode', async (t) => {
  for (const basePath of [null, false, 0, NaN, true]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath });
    assert.equal(result.enabled, false, String(basePath));
    assert.equal(result.error, 'Invalid base path.');
    assert.equal(m.saved.length, 0);
  }
  for (const basePath of [undefined, '']) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath });
    assert.equal(result.enabled, true, result.error);
    assert.equal(result.basePath, undefined);
    assert.equal(m.saved.at(-1).basePath, undefined);
  }
});

test('a label without a base path is ignored with a warning and the legacy mode starts normally', async (t) => {
  for (const label of ['Windows', '<b>', 7, null]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, label });
    assert.equal(result.enabled, true, String(label));
    assert.equal(result.error, '');
    assert.equal(result.warning, 'Machine label ignored without a base path.');
    assert.equal(result.label, undefined);
    assert.equal(m.saved.at(-1).label, undefined);
    assert.equal((await raw(result, '/api/info', { proxy: false })).status, 200);
    assert.equal(JSON.parse((await raw(result, '/api/info', { proxy: false })).text).machine.label, 'Windows', 'label comes from the platform');
    const again = await m.server.configure({ enabled: true, port: 0 });
    assert.equal(again.warning, undefined, 'the warning does not outlive the configuration that caused it');
  }
  const none = machine();
  t.after(() => none.server.close());
  assert.equal((await none.server.configure({ enabled: true, port: 0 })).warning, undefined);
});

test('reconfiguring without a basePath or label returns to the legacy mode instead of keeping the previous prefix', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  assert.equal(m.status.basePath, '/win/');
  assert.equal(m.saved.at(-1).label, 'Windows');
  const status = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, token: m.status.token });
  assert.equal(status.enabled, true, status.error);
  assert.equal(status.basePath, undefined);
  assert.equal(status.label, undefined);
  assert.equal(m.saved.at(-1).basePath, undefined);
  assert.equal(m.saved.at(-1).label, undefined);
  assert.equal(JSON.parse((await raw(status, '/api/info')).text).machine.id, 'local');
  assert.equal((await raw(status, '/win/api/info')).status, 401, 'no prefix route exists any more');
  assert.equal((await raw(status, '/win/api/snapshot', { headers: { ...PROXY, Authorization: `Bearer ${status.token}` } })).status, 404);
  // The login page and legacy cookie scheme are back for the public host too.
  assert.equal((await raw(status, '/')).status, 401);
  const response = await raw(status, '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN }, body: JSON.stringify({ token: status.token }) });
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /^__Host-agentdeck_mobile=[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/;/);
});

test('machine labels reject control, bidirectional, zero-width, separator, quote and angle-bracket characters and overlong names', async (t) => {
  const bad = ['\u200b', 'a\u200bb', 'a\u200cb', 'a\u200db', 'a\u2060b', '\ufeffa', 'a\u180eb', '\u200e', '\u200f', '\u202a', '\u202e', 'a\u2066b', 'a\u2069b', '\u061cA',
    'a\u0085b', 'a\x7fb', 'a\tb', 'a\rb', 'a\u2028b', 'a\u2029b', '"x"', "a'b", 'a`b', '\u201cx\u201d', '\u2018x\u2019', '<b>', 'a>b', '\uff1cb\uff1e',
    ' lead', 'trail ', ' ', '\u{1F600}'.repeat(33), 'x'.repeat(33)];
  for (const label of bad) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label });
    assert.equal(result.enabled, false, JSON.stringify(label));
    assert.equal(result.error, 'Invalid machine label.');
    assert.equal(m.saved.length, 0);
  }
  for (const label of ['Windows', 'Work PC', 'Mac-2', '办公室电脑', 'x'.repeat(32), '\u{1F600}'.repeat(32), 'Dell (office)']) {
    const m = await start(t, '/win/', label);
    assert.equal(m.status.label, label);
  }
});

test('a non-Mac, non-Windows machine without a label reports a fixed generic name, never its hostname', async (t) => {
  const m = await start(t, '/box/', undefined, {}, { machine: { platform: 'linux', hostname: 'private-host.local', appVersion: '9.9.9' } });
  assert.equal(m.status.label, 'AgentDeck');
  const info = await get(m, 'api/info');
  assert.equal(JSON.parse(info.text).machine.label, 'AgentDeck');
  assert.ok(!info.text.includes('private-host'));
  assert.ok(!info.text.includes('9.9.9'));
});

test('api/info reports exactly app, apiVersion, capabilities and machine: no exact app version or hostname', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const response = await get(m, 'api/info');
  const body = JSON.parse(response.text);
  assert.deepEqual(Object.keys(body).sort(), ['apiVersion', 'app', 'capabilities', 'machine']);
  assert.deepEqual(Object.keys(body.machine).sort(), ['id', 'label', 'platform']);
  for (const leak of ['1.1.4', 'appVersion', 'OWENJH', 'hostname']) assert.ok(!response.text.includes(leak), leak);
});

test('HEAD on api/info is never answered as the probe: 401 without credentials, 404 with them, and never a body', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const anonymous = await raw(m.status, '/win/api/info', { method: 'HEAD', headers: {} });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.text, '');
  const { cookie } = await login(m);
  const authed = await raw(m.status, '/win/api/info', { method: 'HEAD', headers: { Cookie: cookie } });
  assert.equal(authed.status, 404);
  assert.equal(authed.text, '');
  assert.equal((await raw(m.status, '/api/info', { method: 'HEAD' })).status, 404, 'prefix is still required');
  const local = machine();
  t.after(() => local.server.close());
  const status = await local.server.configure({ enabled: true, port: 0 });
  const legacy = await raw(status, '/api/info', { method: 'HEAD', proxy: false });
  assert.equal(legacy.status, 401);
  assert.equal(legacy.text, '');
});

test('backslashes and dot segments are normalized before the prefix check, so they reach the same routes and never another machine', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const id = async (route) => { const r = await raw(m.status, route, { headers: {} }); return r.status === 200 ? JSON.parse(r.text).machine.id : r.status; };
  for (const route of ['/win\\api/info', '\\win/api/info', '\\win\\api\\info', '/x/../win/api/info', '/win/x/../api/info', '/win/./api/info', '/win/x/..\\api/info']) {
    assert.equal(await id(route), 'win', route);
  }
  // A protocol-relative path would change the host, so it is an invalid URL rather than a route.
  for (const route of ['//win/api/info', '//x/win/api/info']) assert.equal((await raw(m.status, route, { headers: { Authorization: `Bearer ${m.status.token}` } })).status, 400, route);
  assert.equal(await id('/win\\'), 401, 'a backslash after the prefix is the prefix root, which is still unauthenticated');
  // Everything that normalizes outside /win/ is a plain 404, even with valid credentials.
  const auth = { Authorization: `Bearer ${m.status.token}` };
  for (const route of ['/win/../mac/api/info', '/win/../api/info', '/win', '/WIN/api/info', '/win%2fapi/info', '/win%2Fapi%2Finfo', '/%77in/api/info', '/win/%2e%2e/mac/api/info']) {
    assert.equal(await id(route), 404, route);
    assert.equal((await raw(m.status, route, { headers: auth })).status, 404, route);
  }
});

test('a duplicated device cookie under a prefix is rejected, as is a duplicated bearer or an ambiguous pair', async (t) => {
  const m = await start(t, '/win/', 'Windows');
  const { cookie } = await login(m);
  const second = await login(m);
  const status = (cookieHeader) => get(m, 'api/snapshot', { Cookie: cookieHeader }).then((r) => r.status);
  assert.equal(await status(cookie), 200);
  assert.equal(await status(`${cookie}; ${cookie}`), 401, 'the same cookie twice');
  assert.equal(await status(`${cookie}; ${second.cookie}`), 401, 'two valid cookies of the same name');
  assert.equal(await status(`${second.cookie};${cookie}`), 401);
  assert.equal(await status(`${cookie}; __Secure-agentdeck_win=${'0'.repeat(64)}`), 401, 'a valid cookie plus an injected same-name one');
  assert.equal(await status(`__Secure-agentdeck_win=${'0'.repeat(64)}; ${cookie}`), 401);
  assert.equal(await status(`${cookie}; agentdeck_mobile=${'0'.repeat(64)}; __Host-agentdeck_mobile=${'0'.repeat(64)}`), 200, 'legacy cookie names are not this machine\'s cookie');
});

test('cookie names of /win/ and /win-2/ never mix: a cookie of one is invisible to the other even when both are sent', async (t) => {
  const a = await start(t, '/win/', 'Windows');
  const b = await start(t, '/win-2/', 'Windows 2');
  const loginA = await login(a), loginB = await login(b);
  assert.match(loginA.setCookie, /^__Secure-agentdeck_win=[a-f0-9]{64}; .*Path=\/win\/;/);
  assert.match(loginB.setCookie, /^__Secure-agentdeck_win-2=[a-f0-9]{64}; .*Path=\/win-2\/;/);
  const code = (m, cookieHeader) => get(m, 'api/snapshot', { Cookie: cookieHeader }).then((r) => r.status);
  assert.equal(await code(a, loginB.cookie), 401);
  assert.equal(await code(b, loginA.cookie), 401);
  for (const header of [`${loginA.cookie}; ${loginB.cookie}`, `${loginB.cookie}; ${loginA.cookie}`]) {
    assert.equal(await code(a, header), 200, header.slice(0, 40));
    assert.equal(await code(b, header), 200, header.slice(0, 40));
  }
  // A cookie whose name merely starts with the other machine's name is not it.
  assert.equal(await code(a, `__Secure-agentdeck_win-2=${loginA.cookie.split('=')[1]}`), 401);
  assert.equal(await code(b, `__Secure-agentdeck_win=${loginB.cookie.split('=')[1]}`), 401);
});

test('readEndpoint tolerates a missing, malformed or non-object endpoint.json and reads a valid one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-endpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'endpoint.json');
  assert.deepEqual(readEndpoint(file), {});
  for (const text of ['', '{', 'not json']) { fs.writeFileSync(file, text); assert.deepEqual(readEndpoint(file), {}, JSON.stringify(text)); }
  fs.writeFileSync(file, 'null');
  assert.equal(readEndpoint(file), null);
  assert.deepEqual(withEndpoint({ enabled: true }, readEndpoint(file)), { enabled: true }, 'a null document is the legacy mode, not a crash');
  fs.writeFileSync(file, JSON.stringify({ publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label: 'Windows' }));
  assert.deepEqual(readEndpoint(file), { publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label: 'Windows' });
});

test('withEndpoint takes basePath and label only from endpoint.json, never from previously saved settings, and passes malformed values on', () => {
  const stale = { enabled: true, port: 43121, token: 'a'.repeat(64), basePath: '/old/', label: 'Old', devices: [] };
  const legacy = withEndpoint(stale, {});
  assert.deepEqual(legacy, { enabled: true, port: 43121, token: 'a'.repeat(64), devices: [] }, 'removing the prefix from endpoint.json drops the saved one');
  assert.ok(!('basePath' in legacy) && !('label' in legacy));
  assert.deepEqual(withEndpoint(stale, { basePath: '/win/', label: 'Windows' }), { ...legacy, basePath: '/win/', label: 'Windows' });
  assert.equal(withEndpoint(stale, { basePath: '/mac/' }).label, undefined, 'a stale saved label never rides along with a new prefix');
  assert.equal(withEndpoint(stale, { basePath: null }).basePath, null, 'malformed prefix reaches configure, which refuses it');
  assert.equal(withEndpoint(stale, { basePath: false }).basePath, false);
  assert.equal(withEndpoint(stale, { basePath: '' }).basePath, '');
  assert.equal(withEndpoint({ ...stale, publicOrigin: 'https://kept.example' }, { publicOrigin: PUBLIC_ORIGIN }).publicOrigin, 'https://kept.example', 'a configured origin wins');
  assert.equal(withEndpoint(stale, { publicOrigin: PUBLIC_ORIGIN }).publicOrigin, PUBLIC_ORIGIN);
  assert.equal(withEndpoint(stale, { publicOrigin: 7 }).publicOrigin, undefined);
  assert.equal(stale.basePath, '/old/', 'the input is not mutated');
});

test('persistable strips basePath and label so config.json never holds them, and main.js persists only through it', async (t) => {
  const settings = { enabled: true, port: 1, token: 'b'.repeat(64), publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label: 'Windows', devices: [{ hash: 'c'.repeat(64), expiresAt: 5 }] };
  const stored = persistable(settings);
  assert.deepEqual(stored, { enabled: true, port: 1, token: 'b'.repeat(64), publicOrigin: PUBLIC_ORIGIN, devices: [{ hash: 'c'.repeat(64), expiresAt: 5 }] });
  assert.equal(settings.basePath, '/win/');
  // What the server itself hands to saveSettings round-trips through the same stripping.
  const m = await start(t, '/win/', 'Windows');
  assert.equal(m.saved.at(-1).basePath, '/win/');
  const json = JSON.stringify(persistable(m.saved.at(-1)));
  assert.ok(!json.includes('basePath') && !json.includes('label') && !json.includes('/win/'));
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.equal(source.match(/mobileWeb: persistable\(settings\)/g)?.length, 1);
  assert.equal(source.match(/cfg\.mobileWeb = persistable\(mobileSettings\)/g)?.length, 1);
  assert.ok(!/mobileWeb:\s*(?:settings|mobileSettings)\b/.test(source) && !/cfg\.mobileWeb = (?!persistable)/.test(source), 'no other write of mobile settings into config');
});
