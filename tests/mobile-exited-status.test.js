'use strict';
// A terminal whose process ended is 已退出 on the desktop (renderer.js onPtyExit sets
// entry.state 'exited'; sidebar DOT_TIP, MainCore STATUS). The phone must say the same:
// the 会话 list and wide sidebar get `status` from renderer.js onMobileRequest op
// 'sessions', the 队长 cell from captain-history, and nothing may be sent to an exited 队长.
// A finished session the user opened (no 队长 task, desktop dot 已完成) is done, not idle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const Core = require('../mobile-web/hub/core');
const { MobileWebServer } = require('../mobile-web');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const DOT_TIP = vm.runInNewContext('(' + /const DOT_TIP = (\{[^\n]*\});/.exec(renderer)[1] + ')');

// What the phone receives for these columns, from the desktop's own sessions answer.
function phoneStatus(columns, terms, tasks = []) {
  const OPEN = "if (op === 'sessions') {";
  const start = renderer.indexOf(OPEN), end = renderer.indexOf("} else if (op === 'output')", start);
  assert.ok(start > 0 && end > start, 'the sessions answer is where it was');
  const context = { columns, terms: new Map(Object.entries(terms)), MainSession: { state: () => ({ tasks }) },
    AgentInfo: { resolveAgentInfo: () => ({ model: 'claude-opus' }) }, columnLabel: (col) => col.title };
  const result = vm.runInNewContext(`(() => { let result; ${renderer.slice(start + OPEN.length, end)}; return result; })()`, context);
  return Object.fromEntries(result.map((s) => [s.id, s.status]));
}

test('a session whose process ended reads exited on the phone, as in the desktop sidebar, not failed', () => {
  const columns = [{ id: 'cap', title: '队长', isMain: true }, { id: 'w1', title: '整理周报' }];
  const terms = { cap: { alive: false, state: 'exited' }, w1: { alive: false, state: 'exited' } };
  assert.equal(DOT_TIP.exited, '已退出');
  assert.deepEqual(phoneStatus(columns, terms, [{ colId: 'w1', status: 'failed' }]), { cap: 'exited', w1: 'exited' });
  // A live session whose last task failed is still 失败.
  assert.deepEqual(phoneStatus([{ id: 'w2', title: '修锁' }], { w2: { alive: true, state: 'plain' } }, [{ colId: 'w2', status: 'failed' }]), { w2: 'failed' });
});

test('a session the user opened that finished its work reads done on the phone, as the desktop dot does', () => {
  assert.equal(DOT_TIP.done, '已完成');
  assert.deepEqual(phoneStatus([{ id: 'm1', title: '手动开的会话' }], { m1: { alive: true, state: 'done' } }), { m1: 'done' });
  assert.deepEqual(phoneStatus([{ id: 'm2', title: '刚开的会话' }], { m2: { alive: true, state: 'plain' } }), { m2: 'idle' });
});

test('the phone does not offer to send to a 队长 whose process has exited', () => {
  const mac = (status) => ({ label: 'Mac', state: 'online', csrf: 'c', snap: { captain: { id: 'mac-captain', status, turns: [] } } });
  assert.match(Core.sendBlock(mac('exited')), /Mac 的队长终端已经退出/);
  assert.equal(Core.sendBlock(mac('idle')), '');
});

// The desktop's refusal when its 队长 is not running (MainSession.sendMessage), word for word.
const NO_CAPTAIN = /throw new Error\('(请先在 AgentDeck 创建并启动队长[^']*)'\)/.exec(fs.readFileSync(path.join(root, 'main-session.js'), 'utf8'))[1];

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a send the desktop refuses because no 队长 is running comes back as 409 with the reason, and the phone shows it', async (t) => {
  let failure = new Error(NO_CAPTAIN);
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getCaptain: () => ({ turns: [] }), getOutput: () => null, saveSettings: () => {},
    sendCaptain: () => { throw failure; } });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0 });
  const auth = { Authorization: `Bearer ${status.token}` };
  auth['X-CSRF-Token'] = (await request(status.url + '/api/auth', { headers: auth })).body.csrfToken;
  const send = (body) => request(status.url + '/api/captain', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: status.url, ...auth }, body: JSON.stringify(body) });

  const keyed = await send({ message: '继续', deduplicationKey: 'k-0123456789abcdef0123456789abcdef' });
  assert.deepEqual(keyed, { status: 409, body: { error: NO_CAPTAIN } });
  assert.deepEqual(await send({ message: '继续' }), { status: 409, body: { error: NO_CAPTAIN } });
  assert.equal(Core.sendFailure(keyed, 'Mac', true), `Mac 没有接收这条消息：${NO_CAPTAIN}`);
  // Any other failure is still the plain 500, and the phone names only the status.
  failure = new Error('captain busy');
  const other = await send({ message: '继续' });
  assert.deepEqual(other, { status: 500, body: { error: 'Local service unavailable.' } });
  assert.equal(Core.sendFailure(other, 'Mac'), 'Mac 没有接收这条消息（HTTP 500）。');
  // A refusal in English (a key reused for other words) is not shown as it is.
  assert.equal(Core.sendFailure({ status: 409, body: { error: 'This deduplicationKey was used for a different message.' } }, 'Mac'), 'Mac 没有接收这条消息（HTTP 409）。');
});
