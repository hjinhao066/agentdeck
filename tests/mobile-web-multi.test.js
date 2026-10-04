'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MobileWebServer, LOGIN_LIMITS, boardVersionOf, supportsLoginItem } = require('../mobile-web');
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
  for (const basePath of ['mac', '/mac', '/', '//', '/a/b/', '/Mac/', '/mac /', '/../', '/mac%2f/', '/' + 'a'.repeat(33) + '/', 7, {}, ['/mac/']]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath });
    assert.equal(result.enabled, false, String(basePath));
    assert.equal(result.error, 'Invalid base path.');
    assert.equal(m.saved.length, 0);
  }
  for (const label of ['x'.repeat(33), 'a\nb', 'a\0b', '<b>', 7, {}]) {
    const m = machine();
    t.after(() => m.server.close());
    const result = await m.server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath: '/win/', label });
    assert.equal(result.enabled, false, String(label));
    assert.equal(result.error, 'Invalid machine label.');
    assert.equal(m.saved.length, 0);
  }
  const noBase = machine();
  t.after(() => noBase.server.close());
  assert.equal((await noBase.server.configure({ enabled: true, port: 0, label: 'Windows' })).error, 'Invalid machine label.');
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
    machine: { id: 'win', label: 'Windows', platform: 'win32' }, appVersion: '1.1.4' });
  for (const secret of [m.status.token, 'OWENJH', 'captain']) assert.ok(!response.text.includes(secret), secret);
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
