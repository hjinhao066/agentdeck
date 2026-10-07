'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../task-board');
const { createNeedsUserBark, barkEnabled, barkReady } = require('../needs-user-bark');

function harness({ state = { entries: {} }, coalesceMs = 0, enabled = true, ready = true } = {}) {
  const calls = [], errors = [];
  let saved = null;
  const jobs = [];
  const observe = createNeedsUserBark({
    state,
    saveState: (value) => { saved = JSON.parse(JSON.stringify(value)); },
    sendBark: (alert) => { calls.push(alert); return Promise.resolve({ ok: true }); },
    onError: (message) => errors.push(message),
    coalesceMs,
    schedule: (fn) => { jobs.push(fn); return fn; },
    clear: (fn) => { const index = jobs.indexOf(fn); if (index >= 0) jobs.splice(index, 1); },
  });
  return { calls, errors, jobs, observe: (cards, options = {}) => observe(cards, { enabled, ready, ...options }), saved: () => saved, state };
}

function card(id, extra = {}) {
  return { id, project: '门户', title: '确认密码策略', status: 'needs_user', needs_user_entry: '2026-10-05T04:00:00.000Z',
    user_question: '选 8 位还是 12 位？ 第二句说明原因。第三句不要。', latest_receipt: '选 8 位还是 12 位？', ...extra };
}

test('the phone switch defaults on and delivery can resolve configured or shared default keys', () => {
  assert.equal(barkEnabled(undefined), true);
  assert.equal(barkEnabled({}), true);
  assert.equal(barkEnabled({ needsUserBark: true }), true);
  assert.equal(barkEnabled({ needsUserBark: false }), false);
  assert.equal(barkReady({ barkKeyFile: ' ~/.secrets/bark-key.txt ' }), true);
  assert.equal(barkReady({ barkKeyFile: '' }), true);
  assert.equal(barkReady({}), true);
  assert.equal(barkReady(undefined), true);
});

test('one visit sends the project, title and the first two sentences, then stays quiet', async () => {
  const h = harness();
  await h.observe([card('a')]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].title, '需要你');
  assert.equal(h.calls[0].level, 'active');
  assert.match(h.calls[0].message, /^门户 · 确认密码策略\n选 8 位还是 12 位？ 第二句说明原因。$/);
  assert.doesNotMatch(h.calls[0].message, /第三句/);
  await h.observe([card('a')]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.saved(), { entries: { a: '2026-10-05T04:00:00.000Z' } });
});

test('a restarted watcher does not send the same visit again', async () => {
  const h = harness();
  await h.observe([card('a')]);
  const restarted = harness({ state: h.saved() });
  await restarted.observe([card('a')]);
  assert.equal(restarted.calls.length, 0);
});

test('a missing or unreadable state file baselines existing cards instead of replaying them', async () => {
  const calls = [];
  const state = { entries: {} };
  const observe = createNeedsUserBark({ state, suppressInitial: true, coalesceMs: 0,
    saveState: (value) => { state.entries = { ...value.entries }; },
    sendBark: (alert) => { calls.push(alert); return Promise.resolve({ ok: true }); } });
  await observe([card('already-waiting')]);
  assert.equal(calls.length, 0);
  await observe([card('already-waiting', { status: 'doing' })]);
  await observe([card('already-waiting', { needs_user_entry: '2026-10-05T05:00:00.000Z' })]);
  assert.equal(calls.length, 1);
});

test('leaving and entering again sends once more', async () => {
  const h = harness();
  await h.observe([card('a')]);
  await h.observe([card('a', { status: 'doing' })]);
  await h.observe([card('a', { needs_user_entry: '2026-10-05T05:00:00.000Z', user_question: '换成令牌？' })]);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].message, /换成令牌？/);
  assert.equal(h.saved().entries.a, '2026-10-05T05:00:00.000Z');
});

test('cards that were already waiting before this feature are not pushed', async () => {
  const h = harness();
  await h.observe([card('old', { needs_user_entry: undefined, latest_receipt: '旧问题？', user_question: '' })]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved().entries.old, 'legacy:old');
  await h.observe([card('old', { needs_user_entry: undefined, user_question: '' })]);
  assert.equal(h.calls.length, 0);
});

test('several cards in a short window become one Bark message', async () => {
  const h = harness({ coalesceMs: 2000 });
  await h.observe([card('a', { project: '门户', title: '密码' })]);
  await h.observe([card('a', { project: '门户', title: '密码' }), card('b', { project: '报表', title: '对账', user_question: '用哪份账单？' })]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.jobs.length, 1);
  await h.jobs[0]();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].title, '需要你 · 2');
  assert.match(h.calls[0].message, /门户 · 密码/);
  assert.match(h.calls[0].message, /报表 · 对账\n用哪份账单？/);
});

test('a missing key waits, a closed switch remembers without sending, and a failed save sends nothing', async () => {
  const waiting = harness({ ready: false });
  await waiting.observe([card('a')]);
  assert.equal(waiting.calls.length, 0);
  assert.equal(waiting.saved(), null);
  await waiting.observe([card('a')], { ready: true });
  assert.equal(waiting.calls.length, 1);

  const off = harness({ coalesceMs: 2000 });
  await off.observe([card('a')]);
  await off.observe([card('a')], { enabled: false });
  assert.equal(off.jobs.length, 0);
  await off.observe([card('b', { needs_user_entry: '2026-10-05T06:00:00.000Z' })], { enabled: false });
  assert.equal(off.calls.length, 0);
  await off.observe([card('b', { needs_user_entry: '2026-10-05T06:00:00.000Z' })], { enabled: true });
  assert.equal(off.calls.length, 0);

  const calls = [];
  const observe = createNeedsUserBark({
    saveState: () => { throw new Error('disk full'); },
    sendBark: (alert) => { calls.push(alert); return Promise.resolve({ ok: true }); },
    coalesceMs: 0,
  });
  await assert.rejects(async () => observe([card('a')]), /disk full/);
  assert.equal(calls.length, 0);
});

test('internal receipts are translated and the sender never sees a device key', async () => {
  const h = harness();
  await h.observe([
    card('gone', { project: '报表', title: '对账', user_question: '', latest_receipt: '已结束，未提交回执', needs_user_entry: '2026-10-05T04:00:00.000Z' }),
    card('idle', { project: '调度', title: '没派出', user_question: '', latest_receipt: '调度已结束，尚未派出执行会话', needs_user_entry: '2026-10-05T04:00:01.000Z' }),
    card('blank', { project: '手工', title: '挪过来', user_question: '', latest_receipt: '', needs_user_entry: '2026-10-05T04:00:02.000Z' }),
  ]);
  assert.match(h.calls[0].message, /队员停下了，但没有交结果。/);
  assert.match(h.calls[0].message, /这件事还没有派给队员。/);
  assert.match(h.calls[0].message, /请到看板决定下一步。/);
  assert.equal(JSON.stringify(h.calls), JSON.stringify(h.calls).replace(/device_key|fake_device/g, ''));
  assert.doesNotMatch(JSON.stringify(h.saved()), /device_key|Bark|api\.day\.app/);
});

test('the board stamps one entry per visit and keeps two sentences of the question', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-needs-user-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(path.join(root, 'tasks'));
  const card = store.add({ project: '门户', title: '确认密码策略', detail: '定长度。' }).card;
  store.bind({ id: card.id, attempt_id: 'a1', session_id: 'worker', assignee: { agent: 'codex', model: 'gpt' } });
  const asked = store.event({ id: card.id, type: 'ask', attempt_id: 'a1', session_id: 'worker', source: 'command', message: '选 8 位？\n第二句说明原因。第三句不要。' });
  assert.equal(asked.card.status, 'needs_user');
  assert.equal(asked.card.latest_receipt, '选 8 位？');
  assert.equal(asked.card.user_question, '选 8 位？ 第二句说明原因。');
  const entry = asked.card.needs_user_entry;
  assert.equal(entry, asked.card.updated);
  const again = store.event({ id: card.id, type: 'ask', attempt_id: 'a1', session_id: 'worker', source: 'command', message: '换成令牌？' });
  assert.equal(again.card.needs_user_entry, entry);
  store.event({ id: card.id, type: 'started', attempt_id: 'a1', session_id: 'worker', source: 'command', message: '' });
  assert.equal(store.list()[0].status, 'doing');
  assert.equal(store.list()[0].user_question, undefined);
  const back = store.event({ id: card.id, type: 'ask', attempt_id: 'a1', session_id: 'worker', source: 'command', message: '再问一次？' });
  assert.notEqual(back.card.needs_user_entry, entry);

  const moved = store.add({ project: '报表', title: '对账', detail: '选月份。' }).card;
  store.move({ id: moved.id, status: 'needs_user' });
  const first = store.list().find((item) => item.id === moved.id).needs_user_entry;
  assert.ok(first);
  store.move({ id: moved.id, status: 'doing' });
  store.move({ id: moved.id, status: 'needs_user' });
  assert.notEqual(store.list().find((item) => item.id === moved.id).needs_user_entry, first);

  store.dispatch({ id: moved.id, session_id: 'dispatcher-1' });
  const dispatched = store.dispatcherReceipt({ id: moved.id, session_id: 'dispatcher-1', question: '用哪份？\n含税还是不含税。其余忽略。' });
  assert.equal(dispatched.card.user_question, '用哪份？ 含税还是不含税。');
  assert.equal(dispatched.card.latest_receipt, '用哪份？');
});
