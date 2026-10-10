'use strict';
// 挖虫④ 拍板（@ai 待办）：
// - 改字：通知原来的队长「待办改了」；已经办完的待办改字，不自动重新交；
// - 用户自己勾掉：告诉队长（「待我处理」那条的关闭见 todo-tick-closes.test.js）；
// - 队长还没读的过时通知要撤掉。
// 原来的做法：改字就当新任务交出去，旧任务的队长什么都不知道；勾掉、删掉后队长没读的「Todo 新任务」照样留着。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');
const { TodoStore } = require('../todo-store');
const { TaskStore } = require('../task-board');
const { TodoAI } = require('../todo-ai');
const Hub = require('../mobile-web/hub/core.js');
const hex = (n) => n.toString(16).padStart(64, '0');

// ---- the computer that hands a 待办 over (TodoAI) ----
function machine(t, { now = () => Date.now() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-change-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const todos = new TodoStore(path.join(root, 'todos'), { deviceId: 'dev-mac' });
  const deliveries = [], reports = [];
  let accept = true;
  const ai = new TodoAI({ todos, tasks: new TaskStore(path.join(root, 'tasks')), deliver: (v) => deliveries.push(v), notify: async () => {},
    report: (r) => { if (!accept) return false; reports.push(r); return true; }, now });
  // hand one over, 队长's inbox takes it (acknowledged), 队长 starts on it
  const handOver = async (text, status = 'working') => {
    const item = todos.add({ text });
    ai.scan();
    const cur = todos.list().find((i) => i.id === item.id);
    ai.acknowledge(item.id, cur.ai.taskId);
    if (status !== 'queued') await ai.status({ id: item.id, taskId: cur.ai.taskId, status: 'working' });
    if (status === 'done') {
      const file = path.join(root, 'book.epub'); fs.writeFileSync(file, 'x');
      await ai.status({ id: item.id, taskId: cur.ai.taskId, status: 'done', files: [file] });
    }
    return todos.list().find((i) => i.id === item.id);
  };
  return { todos, ai, deliveries, reports, handOver, refuse: (v) => { accept = !v; } };
}

test('an edit tells the 队长 that had it, once; the edited text goes out as a new task', async (t) => {
  const m = machine(t);
  const before = await m.handOver('@ai 找《三体》的 EPUB');
  m.todos.update({ id: before.id, text: '@ai 找《三体》英文版的 EPUB' });
  m.ai.scan(); m.ai.scan();
  assert.equal(m.reports.length, 1, 'one notice for the edit');
  assert.equal(m.reports[0].kind, 'edit');
  assert.equal(m.reports[0].taskId, before.ai.taskId);
  assert.match(m.reports[0].result, /原来是「@ai 找《三体》的 EPUB」，现在是「@ai 找《三体》英文版的 EPUB」/);
  assert.match(m.reports[0].result, /作为一条新的 Todo 任务交给你/);
  const after = m.todos.list().find((i) => i.id === before.id);
  assert.notEqual(after.ai.taskId, before.ai.taskId);
  assert.equal(m.deliveries.at(-1).card.id, after.ai.taskId, 'the edited text is handed over as a new task');
});

test('a finished 待办 edited later is not handed over again; its 队长 is told that', async (t) => {
  const m = machine(t);
  const done = await m.handOver('@ai 找《三体》的 EPUB', 'done');
  const handed = m.deliveries.length;
  m.todos.update({ id: done.id, text: '@ai 找《三体》的 EPUB（要中文版）' });
  m.ai.scan();
  assert.equal(m.deliveries.length, handed, 'nothing handed over again');
  const after = m.todos.list().find((i) => i.id === done.id);
  assert.equal(after.ai, null);
  assert.equal(after.aiBefore.status, 'done');
  assert.equal(m.reports.length, 1);
  assert.match(m.reports[0].result, /已经办完的待办.*不会重新交给你/);
  // a second edit does not hand it over either
  m.todos.update({ id: done.id, text: '@ai 找《三体》的 EPUB（中文版，要 PDF）' });
  m.ai.scan();
  assert.equal(m.deliveries.length, handed);
});

test('ticking off or deleting a 待办 AI has not finished tells its 队长; a finished one is just ticked', async (t) => {
  const m = machine(t);
  const ticked = await m.handOver('@ai 查签证材料');
  const deleted = await m.handOver('@ai 订周五的车票');
  const finished = await m.handOver('@ai 找年报', 'done');
  m.todos.update({ id: ticked.id, done: true });
  m.todos.remove({ id: deleted.id });
  m.todos.update({ id: finished.id, done: true });
  m.ai.scan(); m.ai.scan();
  assert.deepEqual(m.reports.map((r) => [r.kind, r.taskId]).sort(), [['stop', ticked.ai.taskId], ['stop', deleted.ai.taskId]].sort());
  assert.match(m.reports.find((r) => r.taskId === ticked.ai.taskId).result, /用户自己勾掉了.*「@ai 查签证材料」.*不用再办了/);
  assert.match(m.reports.find((r) => r.taskId === deleted.ai.taskId).result, /用户删掉了.*「@ai 订周五的车票」.*不用再办了/);
});

test('a change 队长 could not take yet is tried again; one older than a day is not sent at all', async (t) => {
  let clock = Date.now();
  const m = machine(t, { now: () => clock });
  const item = await m.handOver('@ai 查资料');
  m.refuse(true);
  m.todos.update({ id: item.id, done: true });
  m.ai.scan();
  assert.equal(m.reports.length, 0);
  m.refuse(false);
  m.ai.scan();
  assert.equal(m.reports.length, 1, 'tried again on the next scan');
  // a tick from two days ago (found after an upgrade) is old news
  const old = await m.handOver('@ai 很久以前的事');
  m.todos.update({ id: old.id, done: true });
  clock += 2 * 24 * 60 * 60 * 1000;
  m.ai.scan();
  assert.equal(m.reports.length, 1);
});

// ---- 队长's side (MainSession) ----
function captain() {
  const col = { id: 'captain', isMain: true, cmd: 'claude' }, columns = [col];
  const config = { folders: [], captainHistory: [], todoDeliveries: {}, todoInbox: {}, mainSession: {
    colId: col.id, cmd: col.cmd, gen: 1, pending: [], inflight: [], tasks: [], waitlist: [] } };
  const window = { MainCore: M, BoardCore: B, Sidebar: { render() {} },
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, saveConfigSync: () => true },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {} } };
  const elements = new Map();
  const context = vm.createContext({ window, document: {
    getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); }, querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = { config, platform: 'darwin', columns: () => columns, terms: new Map(), saveConfig() {}, flushConfig() {},
    userComposing: () => false, columnLabel: (c) => c.id, captainTurnDone() {}, showToast() {}, jumpToColumn() {},
    sendWhenReady(_c, _t, o) { o?.onSent?.(); } };
  const api = window.MainSession; api.init(host);
  const card = (n) => 'todo-' + String(n).repeat(64).slice(0, 64);
  const change = (n, id = 'todo-change-' + String(n).repeat(64).slice(0, 64)) =>
    api.handle({ id, action: 'main-todo-change', nativeWeb: true, kind: 'stop', taskId: card(n), result: '用户自己勾掉了这条交给你的待办：「…」。' }, col);
  const deliver = (n) => api.handle({ id: 'delivery-' + n, action: 'main-todo-delivery', nativeWeb: true, taskId: card(n), result: '新任务 ' + n }, col);
  return { api, config, col, change, deliver };
}

test('a 新任务 the 队长 has not read is taken back instead of being followed by a change', async () => {
  const c = captain();
  await c.deliver(1);
  assert.equal(c.config.mainSession.pending.length, 1);
  const r = await c.change(1);
  assert.equal(r.result, 'Todo notice taken back.');
  assert.equal(c.config.mainSession.pending.length, 0, 'the out-of-date 新任务 is gone and nothing else is said');
  assert.equal(Object.keys(c.config.todoInbox).length, 0);
  // the same change sent again (after a restart) does nothing
  await c.change(1);
  assert.equal(c.config.mainSession.pending.length, 0);
});

test('a 新任务 the 队长 already read is followed by one 待办有变 notice', async () => {
  const c = captain();
  await c.deliver(2);
  await c.api.handle({ action: 'main-receipts' }, c.col);        // 队长 reads it
  const r = await c.change(2);
  assert.equal(r.result, 'Todo change recorded.');
  assert.equal(c.config.mainSession.pending.length, 1);
  assert.equal(c.config.mainSession.pending[0].title, '待办有变');
  const reply = await c.api.handle({ action: 'main-receipts' }, c.col);
  assert.match(reply.result, /用户自己勾掉了/);
  await c.change(2);
  assert.equal(c.config.mainSession.pending.length, 0, 'once only, also after it was read');
});

test('a change notice is a program message: it is not the 队长 starting work, and it survives a relaunch\'s config filter', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main-session.js'), 'utf8');
  assert.match(source, /'main-todo-delivery', 'main-todo-error', 'main-todo-change'\]\.includes\(message\.action\)/);
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /\^todo-\(\?:error-\|change-\)\?\[a-f0-9\]\{64\}\$/);
  assert.match(renderer, /message\.action === 'main-todo-change'\) \{/);
});

test('an edited 待办 AI had finished says it is not handed over again, on the desktop and the phone', () => {
  const edited = { id: 'td-00000009-aaaa', text: '@ai 找年报（要 2025 的）', done: false, ai: null, aiBefore: { status: 'done', taskId: 'todo-' + hex(9) } };
  assert.equal(Hub.todoAiBefore(edited), 'AI 改字前已办完；改字后不会再交给 AI');
  const phone = Hub.cleanTodos({ items: [{ ...edited, updated: '2026-10-10T04:00:00.000Z', created: '2026-10-10T03:00:00.000Z' }] })[0];
  assert.equal(Hub.todoAiBefore(phone), 'AI 改字前已办完；改字后不会再交给 AI');
  assert.equal(Hub.todoAiBefore({ ...edited, aiBefore: { status: 'working' } }), '');
  assert.equal(Hub.todoAiBefore({ ...edited, ai: { status: 'queued' } }), '');
});
