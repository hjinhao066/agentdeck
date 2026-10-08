'use strict';

// 待我处理 on the phone: the server side of api/attention.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MobileWebServer, attentionView, attentionRequest } = require('../mobile-web');

const ITEMS = [
  { id: 'at-mabc-1', kind: 'need', label: '等你拍板', title: '网页端登录改成 1 有风险', ask: '回复「仍要 1」或「登录一次长期有效」', detail: '第一行\n第二行\u0007', files: ['/Users/x/facts.md'],
    project: 'agentdeck', cardTitle: '登录改 1', sessionTitle: '', source: 'captain', created: 1000, readAt: 0, done: false, doneAt: 0, doneText: '',
    replies: [], notice: 'attention-secret', key: 'needs:t-1:e', options: ['仍要 1', '登录一次长期有效', '仍要 1', '很'.repeat(30), 7] },
  { id: 'at-mabc-2', kind: 'report', label: '结果汇报', title: '小福助手排查报告回来了', ask: '', detail: '', files: [], project: '', created: 900, readAt: 0, done: false, replies: [], turn: 'tq1abc' },
  { id: 'at-mabc-3', kind: 'report', label: '结果汇报', title: '旧汇报', created: 800, readAt: 850, done: true, doneAt: 860, doneText: '你看过了', doneBy: 'seen', turn: 'bad turn',
    replies: [{ text: '好', at: 855, from: 'phone', seen: true, notice: 'attention-x' }] },
  { id: '../evil', kind: 'need', title: 'x', created: 1 },
  { id: 'at-mabc-4', kind: 'todo', title: 'x', created: 1 },
];

function setup(t, writes) {
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getOutput: () => null, sendCaptain: () => {}, saveSettings: () => {},
    getAttention: () => ({ items: ITEMS }),
    writeAttention: async (input) => {
      writes.push(input);
      if (input.id === 'at-mabc-9') throw new Error('还没有队长：回复要交给队长。\n');
      return { item: { ...ITEMS[0], done: true, doneAt: 2000, doneText: '你已回复', replies: [{ text: input.text || '', at: 2000, from: 'phone', seen: false }] } };
    } });
  t.after(() => server.close());
  return server;
}
function request(status, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(status.url + route, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('api/attention lists items field by field: no receipt ids, keys or foreign entries', async (t) => {
  const server = setup(t, []);
  const status = await server.configure({ enabled: true, port: 0 });
  const auth = { Authorization: `Bearer ${status.token}` };
  assert.equal((await request(status, '/api/attention')).status, 401, 'login first');
  const res = await request(status, '/api/attention', { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((i) => i.id), ['at-mabc-1', 'at-mabc-2', 'at-mabc-3']);
  const [need, , done] = res.json.items;
  assert.equal(need.detail, '第一行\n第二行 ', 'line breaks stay, other control characters go');
  assert.equal('notice' in need, false);
  assert.equal('key' in need, false);
  assert.deepEqual(need.options, ['仍要 1', '登录一次长期有效', '很'.repeat(24)], 'one line each, once, clipped; nothing but text');
  assert.deepEqual(res.json.items[1].options, [], 'a report has no answers to pick');
  assert.equal('notice' in done.replies[0], false);
  assert.deepEqual(done.replies[0], { text: '好', at: 855, from: 'phone', seen: true });
  assert.deepEqual(res.json.counts, { need: 1, reports: 1, unreadReports: 1, badge: 1 }, 'the number is 要你处理 only');
  // The 队长 turn a report was said in, and how a finished one was finished: the phone reads them with the chat.
  assert.deepEqual([need.turn, res.json.items[1].turn, done.turn, done.doneBy, need.doneBy], ['', 'tq1abc', '', 'seen', '']);
});

test('POST api/attention needs the device, CSRF and same origin, and takes only read / reply / done / reopen', async (t) => {
  const writes = [];
  const server = setup(t, writes);
  const status = await server.configure({ enabled: true, port: 0 });
  const auth = { Authorization: `Bearer ${status.token}` };
  const csrf = (await request(status, '/api/auth', { headers: auth })).json.csrfToken;
  const post = (body, headers = {}) => request(status, '/api/attention', { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: status.url, ...auth, 'X-CSRF-Token': csrf, ...headers } });

  assert.equal((await post({ op: 'done', id: 'at-mabc-1' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await post({ op: 'done', id: 'at-mabc-1' }, { Origin: 'https://evil.example' })).status, 403);
  for (const bad of [{ op: 'delete', id: 'at-mabc-1' }, { op: 'done', id: '../x' }, { op: 'reply', id: 'at-mabc-1', text: '  ' },
    { op: 'reply', id: 'at-mabc-1', text: 'x'.repeat(4001) }, { op: 'done', id: 'at-mabc-1', extra: 1 }, { op: 'read', ids: 'at-mabc-1' },
    { op: 'read', ids: Array.from({ length: 101 }, (_, i) => 'at-mabc-' + i) }, { op: 'read', ids: ['at-mabc-2'], via: 'phone' }, { op: 'read', ids: ['at-mabc-2'], extra: 1 }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.deepEqual(writes, [], 'nothing reached the desktop');

  const replied = await post({ op: 'reply', id: 'at-mabc-1', text: '登录一次长期有效' });
  assert.equal(replied.status, 200);
  assert.equal(replied.json.item.doneText, '你已回复');
  assert.equal(replied.json.item.replies[0].text, '登录一次长期有效');
  assert.equal((await post({ op: 'read', ids: ['at-mabc-2', 'at-mabc-2'] })).status, 200);
  assert.equal((await post({ op: 'read', ids: ['at-mabc-2'], via: 'chat' })).status, 200, 'seen in the 队长 chat');
  assert.equal((await post({ op: 'done', id: 'at-mabc-2' })).status, 200);
  assert.equal((await post({ op: 'reopen', id: 'at-mabc-3' })).status, 200);
  assert.deepEqual(writes, [{ op: 'reply', id: 'at-mabc-1', text: '登录一次长期有效' }, { op: 'read', ids: ['at-mabc-2'] },
    { op: 'read', ids: ['at-mabc-2'], via: 'chat' }, { op: 'done', id: 'at-mabc-2' }, { op: 'reopen', id: 'at-mabc-3' }]);
  const refused = await post({ op: 'reply', id: 'at-mabc-9', text: '你好' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, '还没有队长：回复要交给队长。');
});

test('without the attention sources there is no api/attention route', async (t) => {
  const server = new MobileWebServer({ getSessions: () => [], getTasks: () => [], getOutput: () => null, sendCaptain: () => {}, saveSettings: () => {} });
  t.after(() => server.close());
  const status = await server.configure({ enabled: true, port: 0 });
  assert.equal((await request(status, '/api/attention', { headers: { Authorization: `Bearer ${status.token}` } })).status, 404);
});

test('the request filter and the view stand alone', () => {
  assert.deepEqual(attentionRequest({ op: 'reply', id: 'at-a1b2-c', text: '好' }), { op: 'reply', id: 'at-a1b2-c', text: '好' });
  assert.equal(attentionRequest({ op: 'reply', id: 'at-a1b2-c', text: 'a\u0000b' }), null);
  assert.equal(attentionView(null, 5).items.length, 0);
  assert.equal(attentionView({ items: [{ id: 'at-a1b2-c', kind: 'need', title: '   ', created: 1 }] }, 5).items.length, 0, 'an item needs a title');
});
