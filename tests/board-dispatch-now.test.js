'use strict';
// 马上派人做 / 排到最前 on a task card (docs/task-board-api.md「马上派人做、排到最前」):
// what the board file records, when the buttons are grey and why, the order a
// 下一个做 card takes, and the phone's POST api/tasks behind the usual login,
// Origin, Fetch Metadata and CSRF checks. No model, no PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore, syncedCard } = require('../task-board');
const U = require('../task-board-ui-core');
const Hub = require('../mobile-web/hub/core');
const { MobileWebServer, taskActionRequest } = require('../mobile-web');

function store(t, sessions = () => []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dispatch-now-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new TaskStore(path.join(root, 'tasks'), { sessions });
}
const bind = (s, id, session = 'w-1') => s.bind({ id, session_id: session, attempt_id: 'a-' + session, assignee: { agent: 'claude', model: 'default' } });

// ---- 马上派人做: the request on the card ----
test('dispatchNow records one request for the Captain on a card nobody works on, and a worker taking the card clears it', (t) => {
  const s = store(t);
  const card = s.add({ project: 'p', title: '修复登录' }).card;
  const { card: asked, ignored } = s.dispatchNow({ id: card.id });
  assert.equal(ignored, undefined);
  assert.equal(asked.status, 'todo', 'the card stays where it is until a worker takes it');
  assert.equal(asked.dispatch_now.delivered, false);
  assert.equal(asked.dispatch_now.host, os.hostname());
  assert.ok(Date.parse(asked.dispatch_now.at));
  assert.notEqual(asked.updated, card.updated);

  // A second click while it waits changes nothing.
  const again = s.dispatchNow({ id: card.id });
  assert.equal(again.ignored, true);
  assert.equal(again.card.dispatch_now.at, asked.dispatch_now.at);

  // Only this computer's undelivered requests are waiting for its Captain.
  assert.deepEqual(s.dispatchNowWaiting().map((c) => c.id), [card.id]);
  assert.equal(s.dispatchNowDelivered({ id: card.id, at: 'not-this-one' }).ignored, true);
  const delivered = s.dispatchNowDelivered({ id: card.id, at: asked.dispatch_now.at }).card;
  assert.equal(delivered.dispatch_now.delivered, true);
  assert.equal(s.dispatchNowDelivered({ id: card.id, at: asked.dispatch_now.at }).ignored, true, 'delivered once');
  assert.deepEqual(s.dispatchNowWaiting(), []);

  // The Captain's `new --task-id` binds a worker: the request is done.
  const bound = bind(s, card.id).card;
  assert.equal(bound.dispatch_now, undefined);
  assert.equal(syncedCard(bound).dispatch_now, undefined);
});

test('a request made on another computer is not this computer\'s to deliver', (t) => {
  const s = store(t);
  const card = s.add({ project: 'p', title: '别处点的' }).card;
  s.dispatchNow({ id: card.id });
  const file = path.join(s.dir, 'p.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.cards[0].dispatch_now.host = 'other-computer';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  assert.deepEqual(s.dispatchNowWaiting(), []);
  // the synced copy keeps the request and the mark
  assert.deepEqual(syncedCard(s.list()[0]).dispatch_now, doc.cards[0].dispatch_now);
});

test('dispatchNow refuses a card that is done, being worked on, waiting on the user or on another card, with the reason', (t) => {
  const s = store(t);
  const done = s.add({ project: 'p', title: 'done' }).card;
  s.move({ id: done.id, status: 'done' });
  assert.throws(() => s.dispatchNow({ id: done.id }), /已经完成/);
  const busy = s.add({ project: 'p', title: 'busy' }).card;
  bind(s, busy.id);
  assert.throws(() => s.dispatchNow({ id: busy.id }), /已经有队员在做/);
  const ask = s.add({ project: 'p', title: 'ask' }).card;
  s.move({ id: ask.id, status: 'needs_user' });
  assert.throws(() => s.dispatchNow({ id: ask.id }), /等你回答/);
  const first = s.add({ project: 'p', title: 'first' }).card;
  const after = s.add({ project: 'p', title: 'after', depends_on: [first.id] }).card;
  assert.throws(() => s.dispatchNow({ id: after.id }), /前面的卡/);
  assert.throws(() => s.dispatchNow({ id: 'missing' }), /Unknown task/);

  // A failed card whose worker stopped can be sent again.
  const failed = s.add({ project: 'p', title: 'failed' }).card;
  bind(s, failed.id, 'w-f');
  s.event({ id: failed.id, session_id: 'w-f', attempt_id: 'a-w-f', type: 'failed', message: '没跑通。', source: 'command' });
  assert.equal(s.dispatchNow({ id: failed.id }).card.dispatch_now.delivered, false);
  // Moving the card to done ends the request.
  assert.equal(s.move({ id: failed.id, status: 'done' }).card.dispatch_now, undefined);
});

// ---- 排到最前 ----
test('nextUp marks the card 高优先级 and 下一个做, puts it first in its project, and there is only ever one', (t) => {
  const s = store(t);
  const a = s.add({ project: 'p', title: 'a' }).card;
  const b = s.add({ project: 'p', title: 'b', priority: 'high' }).card;
  const c = s.add({ project: 'p', title: 'c' }).card;
  const other = s.add({ project: 'q', title: 'other' }).card;
  const next = s.nextUp({ id: c.id }).card;
  assert.equal(next.important, true);
  assert.ok(Date.parse(next.next_up));
  const order = s.list({ project: 'p' }).map((x) => x.title);
  assert.deepEqual(order, ['c', 'a', 'b']);
  assert.equal(s.list().find((x) => x.id === a.id).order >= 0, true);

  // the newest click wins, in any project
  s.nextUp({ id: other.id });
  assert.deepEqual(s.list().filter((x) => x.next_up).map((x) => x.id), [other.id]);
  assert.equal(s.list().find((x) => x.id === c.id).important, true, 'the earlier one keeps 高优先级');

  // again on the same card: nothing new
  const stamp = s.list().find((x) => x.id === other.id).updated;
  assert.equal(s.nextUp({ id: other.id }).card.updated, stamp);

  // only a 待办 card can be put first
  s.move({ id: a.id, status: 'doing' });
  assert.throws(() => s.nextUp({ id: a.id }), /只有待办/);
  // leaving 待办, or going back to ordinary, ends the mark
  assert.equal(s.move({ id: other.id, status: 'doing' }).card.next_up, undefined);
  s.nextUp({ id: b.id });
  assert.equal(s.priority({ id: b.id, level: 'normal' }).card.next_up, undefined);
  s.nextUp({ id: c.id });
  assert.equal(bind(s, c.id).card.next_up, undefined);
  assert.equal(syncedCard({ ...s.list()[0], next_up: '2026-10-10T00:00:00.000Z' }).next_up, '2026-10-10T00:00:00.000Z');
});

test('nextUp puts the card first even when the project already starts at order 0', (t) => {
  const s = store(t);
  const cards = ['a', 'b', 'c'].map((title) => s.add({ project: 'p', title }).card);
  assert.equal(cards[0].order, 0);
  s.nextUp({ id: cards[2].id });
  assert.deepEqual(s.list({ project: 'p' }).map((x) => x.title), ['c', 'a', 'b']);
  s.nextUp({ id: cards[1].id });
  assert.deepEqual(s.list({ project: 'p' }).map((x) => x.title), ['b', 'c', 'a']);
});

// ---- the board's order and words ----
test('the 下一个做 card leads its column, ahead of the other 高优先级 cards', () => {
  const card = (id, extra = {}) => ({ id, project: 'p', title: id, detail: '', status: 'todo', flag: null, order: 0, depends_on: [], important: false, archived: false, ...extra });
  const board = U.buildBoard([card('h1', { important: true, order: 0 }), card('n1', { order: 1 }), card('nx', { important: true, order: 2, next_up: '2026-10-10T00:00:00.000Z' })]);
  assert.deepEqual(board.lanes[0].columns[0].cards.map((x) => x.card.id), ['nx', 'h1', 'n1']);
  assert.equal(board.lanes[0].columns[0].cards[0].next, true);
  assert.equal(U.isNextUp(card('done', { status: 'done', next_up: 'x' })), false);
});

test('a card handed to the Captain says so on its line until a worker takes it', () => {
  const waiting = { id: 'w', project: 'p', title: 'w', detail: '说明', status: 'todo', flag: null, dispatch_now: { at: '2026-10-10T00:00:00.000Z', host: 'mac', delivered: true } };
  assert.deepEqual(U.activity(waiting, '', ''), { text: '已交给队长 · 等派人', tone: 'wait' });
  assert.deepEqual(U.activity({ ...waiting, dispatch_now: { ...waiting.dispatch_now, delivered: false } }, '', ''), { text: '这台电脑没有队长，打开队长后才会派', tone: 'wait' });
  assert.equal(Hub.dispatchNote(waiting), '已交给队长 · 等派人');
  assert.equal(Hub.dispatchNote({ ...waiting, dispatch_now: null }), '');
});

test('when 马上派人做 and 排到最前 are grey, and the reason each gives', () => {
  const card = (extra = {}) => ({ id: 'c', project: 'p', title: 'c', status: 'todo', flag: null, archived: false, ...extra });
  assert.deepEqual(Hub.dispatchNowState(card()), { enabled: true, reason: '' });
  assert.deepEqual(Hub.dispatchNowState(card({ status: 'done' })), { enabled: false, reason: '这张卡已经完成了，不用再派' });
  assert.deepEqual(Hub.dispatchNowState(card({ archived: true, status: 'done' })), { enabled: false, reason: '这张卡已经完成了，不用再派' });
  assert.deepEqual(Hub.dispatchNowState(card({ status: 'doing', session_id: 'w1', attempt_closed: false })), { enabled: false, reason: '已经有队员在做这张卡了' });
  assert.deepEqual(Hub.dispatchNowState(card({ status: 'review', session_id: 'w1', attempt_closed: false })), { enabled: false, reason: '已经有队员在做这张卡了' });
  assert.equal(Hub.dispatchNowState(card({ status: 'doing', session_id: 'w1', attempt_closed: false, flag: 'failed' })).enabled, true, 'a failed worker can be replaced');
  assert.equal(Hub.dispatchNowState(card({ status: 'doing', session_id: 'w1', attempt_closed: true })).enabled, true);
  assert.deepEqual(Hub.dispatchNowState(card({ status: 'needs_user' })), { enabled: false, reason: '这张卡在等你回答，先回答它' });
  assert.deepEqual(Hub.dispatchNowState(card({ flag: 'blocked' })), { enabled: false, reason: '前面的卡还没做完，现在派不了' });
  assert.deepEqual(Hub.dispatchNowState(card({ dispatch_now: { at: 'x', delivered: true } })), { enabled: false, reason: '已经交给队长了，等它派人', pending: true });
  assert.deepEqual(Hub.dispatchNowState(card({ dispatch_now: { at: 'x', delivered: false } })), { enabled: false, reason: '这台电脑没有队长，打开队长后才会派', pending: true });

  assert.deepEqual(Hub.nextUpState(card()), { enabled: true, reason: '' });
  assert.deepEqual(Hub.nextUpState(card({ next_up: 'x', important: true })), { enabled: false, reason: '已经排在最前，队长下一个派它', on: true });
  assert.deepEqual(Hub.nextUpState(card({ status: 'doing' })), { enabled: false, reason: '只有待办里的卡能排到最前' });
  assert.deepEqual(Hub.nextUpState(card({ status: 'done' })), { enabled: false, reason: '这张卡已经完成了' });
});

test('the phone sends the two actions to the computer that ran the card, else one with a Captain, else any that is online', () => {
  const m = (id, extra = {}) => ({ id, label: id.toUpperCase(), state: 'online', csrf: 't', taskActions: true, hostname: id + '.local', meta: { captainStatus: 'idle' }, ...extra });
  const card = { id: 'c', dispatch_claim: { owner: 'win.local' } };
  assert.equal(Hub.taskActionMachine(card, [m('mac'), m('win')]).id, 'win');
  assert.equal(Hub.taskActionMachine(card, [m('mac'), m('win', { state: 'offline' })]).id, 'mac');
  assert.equal(Hub.taskActionMachine({ id: 'c' }, [m('mac', { meta: { captainStatus: 'unavailable' } }), m('win')]).id, 'win');
  assert.equal(Hub.taskActionMachine({ id: 'c', dispatch_now: { host: 'mac.local' } }, [m('win'), m('mac')]).id, 'mac', 'a waiting request stays with its computer');
  assert.equal(Hub.taskActionMachine({ id: 'c' }, [m('mac', { taskActions: false })]), null, 'an older build has no such route');
  assert.equal(Hub.taskActionMachine({ id: 'c' }, [m('mac', { state: 'login' })]), null);
});

// ---- the phone's route ----
test('taskActionRequest takes exactly an op and a card id', () => {
  assert.deepEqual(taskActionRequest({ op: 'dispatch-now', id: 't-1' }), { op: 'dispatch-now', id: 't-1' });
  assert.deepEqual(taskActionRequest({ op: 'next-up', id: 'todo-abc' }), { op: 'next-up', id: 'todo-abc' });
  for (const body of [{ op: 'move', id: 't-1' }, { op: 'dispatch-now' }, { op: 'dispatch-now', id: '../x' }, { op: 'next-up', id: 't-1', status: 'done' }, { op: 'dispatch-now', id: 'x'.repeat(161) }, {}]) {
    assert.equal(taskActionRequest(body), null, JSON.stringify(body));
  }
});

const PUBLIC_ORIGIN = 'https://agentdeck.18-139-28-180.sslip.io';
const PROXY = { Host: new URL(PUBLIC_ORIGIN).host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7' };
async function start(t, writeTasks) {
  const calls = [];
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getCaptain: () => ({ turns: [] }), getOutput: () => null,
    sendCaptain: () => {}, saveSettings: () => {}, machine: { platform: 'darwin' },
    writeTasks: async (input) => { calls.push(input); return writeTasks(input); } });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0, publicOrigin: PUBLIC_ORIGIN, basePath: '/mac/', label: 'Mac' });
  assert.equal(status.enabled, true, status.error);
  return { server, status, calls, base: '/mac/' };
}
function raw(m, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(m.status.url + m.base + route, { method, headers: { ...PROXY, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (m, route, body, headers = {}) => raw(m, route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN, ...headers }, body: JSON.stringify(body) });
async function login(m) {
  const response = await post(m, 'login', { token: m.status.token });
  assert.equal(response.status, 200);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const csrf = JSON.parse((await raw(m, 'api/snapshot', { headers: { Cookie: cookie } })).text).csrfToken;
  return { Cookie: cookie, 'X-CSRF-Token': csrf };
}

test('POST api/tasks needs the login, the CSRF token, the exact origin and same-site fetch metadata, and takes only the two actions', async (t) => {
  const m = await start(t, async (input) => ({ outcome: input.op === 'next-up' ? 'next' : 'delivered', card: { id: input.id, title: '修复登录' } }));
  const info = JSON.parse((await raw(m, 'api/info')).text);
  assert.ok(info.capabilities.includes('task-actions'));
  const body = { op: 'dispatch-now', id: 't-1' };
  assert.equal((await post(m, 'api/tasks', body)).status, 401);
  assert.equal((await post(m, 'api/tasks', body, { Cookie: '__Secure-agentdeck_mac=forged' })).status, 401);
  const auth = await login(m);
  assert.equal((await post(m, 'api/tasks', body, { Cookie: auth.Cookie })).status, 403);
  assert.equal((await post(m, 'api/tasks', body, { Cookie: auth.Cookie, 'X-CSRF-Token': 'f'.repeat(64) })).status, 403);
  assert.equal((await post(m, 'api/tasks', body, { ...auth, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(m, 'api/tasks', body, { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await raw(m, 'api/tasks', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  for (const bad of [{ op: 'move', id: 't-1', status: 'done' }, { op: 'dispatch-now', id: 't-1', extra: 1 }, { op: 'archive' }]) {
    assert.equal((await post(m, 'api/tasks', bad, auth)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(m.calls, [], 'nothing refused reached the desktop');
  const ok = await post(m, 'api/tasks', body, auth);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { ok: true, outcome: 'delivered', card: { id: 't-1', title: '修复登录' } });
  assert.equal((await post(m, 'api/tasks', { op: 'next-up', id: 't-2' }, auth)).status, 200);
  assert.deepEqual(m.calls, [{ op: 'dispatch-now', id: 't-1' }, { op: 'next-up', id: 't-2' }]);
});

test('a refusal from the desktop reaches the phone as a short sentence', async (t) => {
  const m = await start(t, async () => { throw new Error('已经有队员在做这张卡了\n'); });
  const auth = await login(m);
  const refused = await post(m, 'api/tasks', { op: 'dispatch-now', id: 't-1' }, auth);
  assert.equal(refused.status, 409);
  assert.equal(JSON.parse(refused.text).error, '已经有队员在做这张卡了');
});
