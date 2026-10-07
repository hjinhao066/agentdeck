'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoStore } = require('../todo-store');
const { TaskStore } = require('../task-board');
const { TodoAI, isAi, taskId, taskDetail } = require('../todo-ai');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-ai-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const todos = new TodoStore(path.join(root, 'todos'), { deviceId: 'dev-mac' });
  const tasks = new TaskStore(path.join(root, 'tasks'));
  const deliveries = [], alerts = [];
  const options = { todos, tasks, deliver: (value) => deliveries.push(value), notify: async (value) => alerts.push(value) };
  return { root, todos, tasks, deliveries, alerts, options, ai: new TodoAI(options) };
}

test('@ai accepts adjacent Chinese, end/whitespace/punctuation and excludes handles and email addresses', () => {
  for (const text of ['@ai 查资料', '@AI', '@Ai', '@aI', '＠ai', '＠AI 查资料', '查资料@ai', '查@AI，一下', '查＠ ai。', '@\nai 找书', '查 @ai 资料', '@ai,找书', '@ai.查资料', '@ai：找书', '@ai（找书）', '引用「@ai」', '@ai查火车', '帮我@ai找本书', '＠AI查资料', '帮我＠ aI查资料', '@Ai𠀀字资料']) assert.equal(isAi(text), true, text);
  for (const text of ['', '查资料', '找电子书', '病历 CT', 'AI', '了解一下 AI', '学习 AI', '查 AI 资料', 'OpenAI', '学AI', 'ai@', '@a i', '@Aidan', '@aiden', '联系 @air_france 客服', '找 @aimee 要资料', '问问@AIRPORT', 'bob@aiden.com', 'me@ai.com', 'first.last+tag@AI.com', '用户@ai.com', '用户@ai中文.com', '"用户"@AI资料.cn', 'a!@ai.com', '"bob"@ai.com', 'a%tag@ai.中国', '@ai1', '@ai2', '@AI2查火车', '@aiA查火车', '@ai_tool', '@aid', '@air', '@aix', '@ai🤖', null, 4]) assert.equal(isAi(text), false, String(text));
});

test('Chinese-adjacent @ai submits original text once and accepts Captain status write-back', async (t) => {
  const { todos, tasks, deliveries, ai } = fixture(t);
  const texts = ['@ai查火车', '帮我@ai找本书', '＠AI整理资料'];
  const items = texts.map((text) => todos.add({ text }));
  for (const text of ['@aiden找本书', '@ai2查火车', '联系用户@ai中文.com']) todos.add({ text });
  ai.scan();
  for (const item of items) ai.acknowledge(item.id, taskId(item));
  ai.scan();
  assert.equal(deliveries.length, texts.length);
  assert.equal(tasks.list().length, texts.length);
  for (const item of items) {
    const card = tasks.list().find((entry) => entry.id === taskId(item));
    assert.equal(card.title, item.text); assert.ok(card.detail.includes('待办内容：' + item.text));
  }
  const working = await ai.status({ id: items[0].id, taskId: taskId(items[0]), status: 'working' });
  assert.equal(working.ai.status, 'working');
});

test('scan ignores personal, done/deleted todos; one card and acknowledged delivery survive restart', (t) => {
  const { todos, tasks, deliveries, ai, options } = fixture(t);
  todos.add({ text: '帮我找书' });
  const done = todos.add({ text: '@ai 已勾掉' }); todos.update({ id: done.id, done: true });
  const gone = todos.add({ text: '@ai 已删除' }); todos.remove({ id: gone.id });
  const item = todos.add({ text: '@ai 找电子书' });
  ai.scan(); ai.scan();
  assert.equal(tasks.list().length, 1);
  assert.equal(tasks.list()[0].project, 'todo');
  assert.equal(tasks.list()[0].id, taskId(item));
  assert.equal(deliveries.length, 2, 'unacknowledged outbox retries');
  ai.acknowledge(item.id, taskId(item));
  new TodoAI(options).scan();
  assert.equal(deliveries.length, 2);
  assert.ok(todos.list().find((x) => x.id === item.id).ai.deliveredAt);
});

test('only actual text edits resubmit, A to B to A creates new revision; late status cannot touch new task', async (t) => {
  const { todos, tasks, deliveries, ai } = fixture(t);
  const item = todos.add({ text: '@ai A' }); ai.scan(); ai.acknowledge(item.id, taskId(item));
  todos.update({ id: item.id, text: '@ai A' }); ai.scan();
  todos.update({ id: item.id, done: true }); todos.update({ id: item.id, done: false }); ai.scan();
  assert.equal(deliveries.length, 1);
  todos.update({ id: item.id, text: '@ai B' }); ai.scan();
  const b = todos.list()[0]; ai.acknowledge(item.id, b.ai.taskId);
  assert.notEqual(b.ai.taskId, taskId(item));
  await assert.rejects(ai.status({ id: item.id, taskId: taskId(item), status: 'failed', message: 'late' }), /过期/);
  ai.acknowledge(item.id, taskId(item));
  assert.equal(todos.list()[0].ai.taskId, b.ai.taskId);
  todos.update({ id: item.id, text: '@ai A' }); ai.scan();
  assert.equal(tasks.list().length, 3);
  assert.notEqual(todos.list()[0].ai.taskId, taskId(item));
  todos.update({ id: item.id, text: '我的事' }); ai.scan();
  assert.equal(todos.list()[0].ai, null);
  assert.equal(tasks.list().length, 3);
});

test('startup/hourly fallback recovers a missed save and interrupted card creation without duplicate', (t) => {
  const { todos, tasks, deliveries, ai, options } = fixture(t);
  const item = todos.add({ text: '＠AI 漏掉的保存' });
  const add = tasks.add.bind(tasks); let fail = true;
  tasks.add = (input) => { const result = add(input); if (fail) { fail = false; throw new Error('crash after card write'); } return result; };
  assert.throws(() => ai.scan(), /crash/);
  assert.equal(deliveries.length, 0);
  assert.equal(todos.list()[0].ai.taskId, taskId(item));
  new TodoAI(options).scan();
  assert.equal(tasks.list().length, 1);
  assert.equal(deliveries.length, 1);
  ai.acknowledge(item.id, taskId(item)); ai.scan();
  assert.equal(deliveries.length, 1);
});

test('state flow waits for user, requires real artifacts, never changes user checkbox, alerts only once for failure', async (t) => {
  const { root, todos, tasks, alerts, ai } = fixture(t);
  const item = todos.add({ text: '@ai 整理 CT' }); ai.scan(); ai.acknowledge(item.id, taskId(item));
  const update = (status, extra) => ai.status({ id: item.id, taskId: taskId(item), status, ...extra });
  await update('working');
  await update('needs_user', { message: '等你提供 CT 报告，不要自己猜、不要瞎编' });
  assert.equal(todos.phone().items[0].ai.status, 'needs_user');
  assert.match(tasks.list()[0].user_question, /CT/);
  await assert.rejects(update('needs_user'), /说明/);
  await assert.rejects(update('done'), /落盘/);
  await assert.rejects(update('done', { files: [path.join(root, 'missing.pdf')] }), /落盘/);
  await assert.rejects(update('done', { files: [root] }), /落盘/);
  await assert.rejects(update('done', { files: ['relative.pdf'] }), /绝对/);
  assert.equal(alerts.length, 0);
  await update('working');
  await update('failed', { message: '未找到正版电子书' });
  await update('failed', { message: '未找到正版电子书' });
  new TodoAI({ ...fixtureOptions(todos, tasks, alerts) }).scan();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].urgent, true);
  assert.doesNotMatch(JSON.stringify(alerts), /CT|电子书|病历/);
  await update('working');
  const file = path.join(root, 'artifact.pdf'); fs.writeFileSync(file, 'stand-in artifact');
  await update('done', { files: [file] });
  assert.equal(todos.list()[0].done, false);
  assert.deepEqual(todos.list()[0].ai.files, [file]);
  assert.equal(tasks.list()[0].status, 'done');
  assert.equal(alerts.length, 1);
  await assert.rejects(update('working'), /transition/);
  await assert.rejects(update('queued'), /status/);
});
function fixtureOptions(todos, tasks, alerts) { return { todos, tasks, deliver() {}, notify: async (value) => alerts.push(value) }; }

test('failed reminder enqueue remains retryable; successful enqueue is durable across restart', async (t) => {
  const { todos, tasks, ai } = fixture(t);
  const item = todos.add({ text: '@ai test' }); ai.scan();
  let calls = 0;
  const failing = new TodoAI({ todos, tasks, deliver() {}, notify: async () => { calls++; if (calls === 1) throw new Error('offline'); } });
  const input = { id: item.id, taskId: taskId(item), status: 'failed', message: '失败' };
  await assert.rejects(failing.status(input), /offline/);
  assert.equal(todos.list()[0].ai.exceptionNotifiedAt, null);
  await failing.status(input);
  await new TodoAI({ todos, tasks, deliver() {}, notify: async () => calls++ }).status(input);
  assert.equal(calls, 2);
});

test('each text revision is delivered by its saving device, synced AI state is read-only on the peer', async (t) => {
  const { todos, tasks, ai, deliveries } = fixture(t);
  const item = todos.add({ text: '@ai Mac' });
  const peer = new TodoStore(todos.dir, { deviceId: 'dev-win' });
  let peerDeliveries = 0;
  const other = new TodoAI({ todos: peer, tasks, deliver: () => peerDeliveries++, notify: async () => {} });
  other.scan(); assert.equal(peerDeliveries, 0); assert.equal(tasks.list().length, 0);
  ai.scan(); ai.acknowledge(item.id, taskId(item));
  peer.update({ id: item.id, done: true }); peer.update({ id: item.id, done: false }); other.scan(); ai.scan();
  assert.equal(deliveries.length, 1); assert.equal(peerDeliveries, 0);
  await assert.rejects(other.status({ id: item.id, taskId: taskId(item), status: 'working' }), /设备/);
  peer.update({ id: item.id, text: '@ai Windows edit' }); other.scan(); ai.scan();
  assert.equal(peerDeliveries, 1); assert.equal(deliveries.length, 1);
  assert.equal(tasks.list().length, 2);
});

test('template carries source/id, deliverables, local privacy, missing-material and quiet-phone rules', () => {
  const text = taskDetail({ id: 'td-template-test', text: '@ai 找书' }, 'todo-abc');
  for (const part of ['td-template-test', '@ai 找书', 'PDF/EPUB', '资料本身搜全', '等用户提供，不要自己猜、不要瞎编', '不得上传到任何在线服务', '手机提醒默认一律不发', 'todo status', 'needs_user']) assert.ok(text.includes(part), part);
});

test('an edit arriving between status validation and disk mutation cannot corrupt the new revision', async (t) => {
  const { todos, tasks, ai, alerts } = fixture(t);
  const item = todos.add({ text: '@ai old' }); ai.scan();
  const original = tasks.todoStatus.bind(tasks);
  tasks.todoStatus = (input) => { const result = original(input); todos.update({ id: item.id, text: '@ai new' }); return result; };
  await assert.rejects(ai.status({ id: item.id, taskId: taskId(item), status: 'failed', message: 'old failure' }), /过期/);
  assert.equal(todos.list()[0].text, '@ai new');
  assert.equal(todos.list()[0].ai, null);
  assert.equal(alerts.length, 0);
});

test('an unsynced phone checkbox base waits for original ownership, avoiding a second Captain delivery', (t) => {
  const { root, todos, tasks, ai, deliveries } = fixture(t);
  const remote = new TodoStore(path.join(root, 'remote-todos'), { deviceId: 'dev-win' });
  const original = remote.add({ text: '@ai 查火车' });
  const staleCopy = fs.readFileSync(path.join(remote.dir, 'dev-win.json'), 'utf8');
  const remoteAI = new TodoAI({ todos: remote, tasks, deliver() {}, notify: async () => {} });
  remoteAI.scan(); remoteAI.acknowledge(original.id, taskId(original));
  todos.update({ id: original.id, done: true, base: { text: original.text, created: original.created, updated: remote.list()[0].updated }, source: 'phone' });
  todos.update({ id: original.id, done: false, source: 'phone' });
  ai.scan(); assert.equal(deliveries.length, 0);
  fs.writeFileSync(path.join(todos.dir, 'dev-win.json'), staleCopy);
  ai.scan(); assert.equal(todos.list()[0].awaitingOrigin, true, 'a stale original cannot erase the newer AI state');
  fs.copyFileSync(path.join(remote.dir, 'dev-win.json'), path.join(todos.dir, 'dev-win.json'));
  ai.scan();
  const seen = todos.list()[0];
  assert.equal(seen.done, false);
  assert.equal(seen.textDevice, 'dev-win');
  assert.equal(seen.awaitingOrigin, false);
  assert.equal(seen.ai.taskId, taskId(original));
  assert.ok(seen.ai.deliveredAt);
  assert.equal(deliveries.length, 0);
  assert.equal(tasks.list().length, 1);
});
test('backend card write errors receive a stable diagnostic code for Captain exception reporting', async (t) => {
  const { todos, tasks, ai } = fixture(t);
  const item = todos.add({ text: '@ai 测试' }); ai.scan();
  tasks.todoStatus = () => { throw new Error('invalid JSON with private content'); };
  await assert.rejects(ai.status({ id: item.id, taskId: taskId(item), status: 'working' }), (error) => error.code === 'TODO_BOARD_WRITE');
  assert.equal(todos.list()[0].ai.status, 'queued');
});
