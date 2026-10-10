'use strict';
// 挖虫④ 拍板：`todo list` 只给队长带 @ai 的待办，或者已经有 AI 状态的；
// 用户自己的其他待办原文不给队长看（docs/todo.md：不带 @ai 的「AI 不碰」）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoStore } = require('../todo-store');
const { TaskStore } = require('../task-board');
const { TodoAI, forCaptain } = require('../todo-ai');

test('todo list gives 队长 only the 待办 handed to AI, never the user\'s own ones', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-captain-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const todos = new TodoStore(path.join(root, 'todos'), { deviceId: 'dev-mac' });
  const ai = new TodoAI({ todos, tasks: new TaskStore(path.join(root, 'tasks')), deliver() {}, notify: async () => {} });
  todos.add({ text: '给妈妈打电话，问体检报告' });
  todos.add({ text: '@ai 找《三体》的 EPUB' });
  const edited = todos.add({ text: '@ai 查一下签证材料' });
  ai.scan();
  // the @ai was taken out after it was handed over: it still carries its AI state from before
  todos.update({ id: edited.id, text: '签证材料自己查' });
  todos.writeAi(edited.id, () => ({ status: 'working', taskId: 'todo-' + 'a'.repeat(64), revision: 'x', ownerDevice: 'dev-mac', updated: todos.stamp() }));
  const shown = forCaptain(todos.list()).map((i) => i.text).sort();
  assert.deepEqual(shown, ['@ai 找《三体》的 EPUB', '签证材料自己查'].sort());
  assert.ok(!JSON.stringify(forCaptain(todos.list())).includes('给妈妈打电话'));
});

test('main.js answers todo list with that view', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /request\.op === 'list'\) result = Promise\.resolve\(\{ items: forCaptain\(todoStore\.list\(\)\) \}\)/);
});
