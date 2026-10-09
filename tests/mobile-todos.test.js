'use strict';
// 随手记待办 on the phone: GET/POST api/todos sit behind the same login,
// Origin, Fetch Metadata and CSRF checks as every other phone write.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MobileWebServer } = require('../mobile-web');
const { TodoStore } = require('../todo-store');
const PUBLIC_ORIGIN = 'https://agentdeck.18-139-28-180.sslip.io';
const PROXY = { Host: new URL(PUBLIC_ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };

// The same two callbacks main.js gives the server, over a real store in a temp folder.
function todoSources(store) {
  return {
    getTodos: () => store.phone(),
    writeTodos: (input) => store.phoneWrite(input),
  };
}
async function start(t, { basePath = '/mac/', todos = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-todos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TodoStore(path.join(dir, 'todos'), { deviceId: 'dev-mac' });
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getCaptain: () => ({ turns: [] }), getOutput: () => null,
    sendCaptain: () => {}, saveSettings: () => {}, machine: { platform: 'darwin' }, ...(todos ? todoSources(store) : {}) });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath, label: 'Mac' });
  assert.equal(status.enabled, true, status.error);
  return { server, status, store, base: basePath };
}
function raw(m, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(m.status.url + m.base + route, { method, headers: { ...PROXY, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (m, route, headers) => raw(m, route, { headers });
const post = (m, route, body, headers = {}) => raw(m, route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN, ...headers }, body: JSON.stringify(body) });
async function login(m) {
  const response = await post(m, 'login', { token: m.status.token });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const csrf = JSON.parse((await get(m, 'api/snapshot', { Cookie: cookie })).text).csrfToken;
  return { Cookie: cookie, 'X-CSRF-Token': csrf };
}

test('without a login the phone gets 401 for reading and writing to-dos, and nothing is written', async (t) => {
  const m = await start(t);
  m.store.add({ text: '桌面上记的' });
  assert.equal((await get(m, 'api/todos')).status, 401);
  assert.equal((await post(m, 'api/todos', { op: 'add', text: '偷偷记一条' })).status, 401);
  assert.equal((await get(m, 'api/todos', { Cookie: '__Secure-agentdeck_mac=forged' })).status, 401);
  assert.equal((await post(m, 'api/todos', { op: 'add', text: '偷偷记一条' }, { Cookie: '__Secure-agentdeck_mac=forged' })).status, 401);
  assert.deepEqual(m.store.list().map((x) => x.text), ['桌面上记的']);
  // The capability probe tells the hub this computer has to-dos, without any data.
  const info = JSON.parse((await get(m, 'api/info')).text);
  assert.ok(info.capabilities.includes('todos'));
  assert.equal(JSON.stringify(info).includes('桌面上记的'), false);
});

test('a logged-in phone still needs the CSRF token, the exact origin and same-site fetch metadata', async (t) => {
  const m = await start(t);
  const auth = await login(m);
  const body = { op: 'add', text: '买书' };
  assert.equal((await post(m, 'api/todos', body, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await post(m, 'api/todos', body, { Cookie: auth.Cookie, 'X-CSRF-Token': 'f'.repeat(64) })).status, 403);
  assert.equal((await post(m, 'api/todos', body, { ...auth, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(m, 'api/todos', body, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await raw(m, 'api/todos', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  assert.deepEqual(m.store.list(), []);
  const ok = await post(m, 'api/todos', body, auth);
  assert.equal(ok.status, 200);
  const item = JSON.parse(ok.text).item;
  assert.equal(item.text, '买书');
  // The answer is the item as api/todos shows it, part clocks included.
  assert.deepEqual(Object.keys(item).sort(), ['created', 'deletedUpdated', 'done', 'doneAt', 'doneUpdated', 'id', 'text', 'textUpdated', 'updated']);
  assert.equal(m.store.list()[0].source, 'phone');
});

test('the phone can only record and tick: anything else in the body is refused before the store is called', async (t) => {
  const m = await start(t);
  const auth = await login(m);
  const { id } = m.store.add({ text: '原来的' });
  const updated = '2026-10-06T08:00:00.000Z';
  for (const body of [{}, { op: 'remove', id }, { op: 'add' }, { op: 'add', text: '' }, { op: 'add', text: '   ' }, { op: 'add', text: 'x'.repeat(2001) },
    { op: 'add', text: 'ok', ai: { state: 'requested' } }, { op: 'add', text: ['a'] }, { op: 'update', id, text: '改字' }, { op: 'update', id, done: 'yes' },
    { op: 'update', id, done: true, deleted: true }, { op: 'update', id: '../../etc/passwd', done: true }, { op: 'update', id: 'td-x', done: true },
    { op: 'update', id, done: true, base: { text: 'a', updated, ai: 'x' } }, { op: 'update', id, done: true, base: { updated } }, { op: 'update', id, done: true, base: [] },
    { op: 'update', id, done: true, base: { text: 'a', updated, textUpdated: 42 } }, { op: 'update', id, done: true, base: { text: 'a', updated, doneUpdated: updated } }]) {
    assert.equal((await post(m, 'api/todos', body, auth)).status, 400, JSON.stringify(body));
  }
  // Too long after the server's own limit (500 characters) is refused by the store.
  assert.equal((await post(m, 'api/todos', { op: 'add', text: '字'.repeat(501) }, auth)).status, 400);
  assert.deepEqual(m.store.list().map((x) => [x.text, x.done]), [['原来的', false]]);
  assert.equal(m.store.list()[0].ai, null);
});

test('ticking works for an item recorded on the other computer, and the list carries deletions as bare marks', async (t) => {
  const m = await start(t);
  const auth = await login(m);
  const base = { text: 'Windows 上记的', done: false, doneAt: null, created: '2026-10-06T08:00:00.000Z', updated: '2026-10-06T08:00:00.000Z' };
  const ticked = await post(m, 'api/todos', { op: 'update', id: 'td-from-windows-1', done: true, base }, auth);
  assert.equal(ticked.status, 200);
  assert.equal(JSON.parse(ticked.text).item.done, true);
  // The content version the phone saw goes along when this build lists it.
  const answer = JSON.parse((await get(m, 'api/todos', { Cookie: auth.Cookie })).text);
  assert.ok(answer.baseKeys.includes('textUpdated'));
  const edited = { ...base, text: 'Windows 上改过的', textUpdated: '2026-10-06T09:00:00.000Z', updated: '2026-10-06T09:00:00.000Z' };
  const again = await post(m, 'api/todos', { op: 'update', id: 'td-from-windows-1', done: false, base: edited }, auth);
  assert.equal(again.status, 200);
  assert.deepEqual([JSON.parse(again.text).item.text, JSON.parse(again.text).item.textUpdated], ['Windows 上改过的', '2026-10-06T09:00:00.000Z']);
  const gone = m.store.add({ text: '删掉的' });
  m.store.remove({ id: gone.id });
  const list = JSON.parse((await get(m, 'api/todos', { Cookie: auth.Cookie })).text).items;
  assert.deepEqual(list.find((x) => x.id === 'td-from-windows-1').done, false);
  assert.deepEqual(Object.keys(list.find((x) => x.id === gone.id)).sort(), ['deleted', 'deletedUpdated', 'id', 'updated']);
  assert.equal(JSON.stringify(list).includes('删掉的'), false);
  // Unknown items without a base are an answer in plain words, not a crash.
  const missing = await post(m, 'api/todos', { op: 'update', id: 'td-not-here-1', done: true }, auth);
  assert.equal(missing.status, 400);
  assert.match(JSON.parse(missing.text).error, /不在了/);
});

test('a logout that lands while a to-do is still uploading stops the write', async (t) => {
  const m = await start(t);
  const auth = await login(m);
  const data = Buffer.from(JSON.stringify({ op: 'add', text: 'must not be written' }));
  const arrived = new Promise((resolve) => m.server.server.once('request', resolve));
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(m.status.url + m.base + 'api/todos', { method: 'POST', headers: { ...PROXY, ...auth, Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(data.subarray(0, 1));
  });
  await arrived;
  await m.server.revokeDevices();
  req.end(data.subarray(1));
  assert.equal(await response, 401);
  assert.deepEqual(m.store.list(), []);
});

test('a build without the to-do sources has no route and does not claim the capability', async (t) => {
  const m = await start(t, { todos: false });
  const auth = await login(m);
  assert.equal((await get(m, 'api/todos', { Cookie: auth.Cookie })).status, 404);
  assert.equal((await post(m, 'api/todos', { op: 'add', text: 'x' }, auth)).status, 404);
  assert.equal(JSON.parse((await get(m, 'api/info')).text).capabilities.includes('todos'), false);
});
