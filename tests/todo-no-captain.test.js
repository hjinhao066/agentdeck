'use strict';
// 挖虫④ 拍板：待办记在没有队长的那台电脑上，明确显示「这台电脑没有队长，打开队长后才会交出去」，
// 不做跨电脑自动接手。打开队长后照常交出去，那句话随之消失。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoStore } = require('../todo-store');
const { TaskStore } = require('../task-board');
const { TodoAI } = require('../todo-ai');
const Hub = require('../mobile-web/hub/core.js');

function fixture(t, deviceId, platform, dir) {
  const todos = new TodoStore(dir, { deviceId });
  const tasks = new TaskStore(path.join(path.dirname(dir), 'tasks-' + deviceId));
  const deliveries = [];
  let captain = false;
  const ai = new TodoAI({ todos, tasks, deliver: (v) => deliveries.push(v), notify: async () => {}, hasCaptain: () => captain, platform });
  return { todos, ai, deliveries, setCaptain: (v) => { captain = v; } };
}

test('a 待办 on a computer with no 队长 says so, waits, and goes once a 队长 is open', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-no-captain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'todos');
  const win = fixture(t, 'dev-win', 'win32', shared);
  const mac = fixture(t, 'dev-mac', 'darwin', shared);
  mac.setCaptain(true);                        // the other computer has a 队长
  const item = win.todos.add({ text: '@ai 找一份公开的年报' });
  win.ai.scan();
  mac.ai.scan();
  assert.deepEqual(win.deliveries, [], 'no 队长 here: nothing handed over');
  assert.deepEqual(mac.deliveries, [], 'and the other computer\'s 队长 does not take it');
  const ai = win.todos.list().find((i) => i.id === item.id).ai;
  assert.equal(ai.noCaptain, true);
  // what the computer that holds it shows, what the other computer and the phone show
  assert.equal(Hub.todoAiChip(ai, true), '这台电脑没有队长，打开队长后才会交出去');
  assert.equal(Hub.todoAiChip(ai, false), 'Windows 上没有队长，在那台打开队长后才会交出去');
  const phone = Hub.cleanTodos({ items: win.todos.phone().items }).find((i) => i.id === item.id).ai;
  assert.equal(Hub.todoAiChip(phone, false), 'Windows 上没有队长，在那台打开队长后才会交出去');
  // a 队长 opens on Windows: it is handed over and the line goes back to the usual one
  win.setCaptain(true);
  win.ai.scan();
  assert.equal(win.deliveries.length, 1);
  const waiting = win.todos.list().find((i) => i.id === item.id).ai;
  assert.equal(waiting.noCaptain, undefined);
  assert.equal(Hub.todoAiChip(waiting, true), '已交给 AI · 等队长接收');
  win.ai.acknowledge(item.id, waiting.taskId);
  assert.equal(Hub.todoAiChip(win.todos.list().find((i) => i.id === item.id).ai, true), '已交给 AI · 队长已收到');
});

test('the desktop 待办 page and the phone both take the line from HubCore.todoAiChip', () => {
  const desktop = fs.readFileSync(path.join(__dirname, '..', 'todo-ui.js'), 'utf8');
  const phone = fs.readFileSync(path.join(__dirname, '..', 'mobile-web', 'hub', 'app.js'), 'utf8');
  assert.match(desktop, /HubCore\.todoAiChip\(ai, !!device && ai\.ownerDevice === device\)/);
  assert.match(phone, /Core\.todoAiChip\(ai, false\)/);
  assert.doesNotMatch(desktop + phone, /等队长接收'\)\)/);
});
