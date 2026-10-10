'use strict';
// 挖虫④ #2：队长用 `todo status --status done --files` 回填时，文件名里带英文逗号
// （英文书名很常见：「Thinking, Fast and Slow.epub」）会被拆成两段，第二段不是绝对路径，
// 回填直接被拒，这条 @ai 待办永远标不成「AI 办完了」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TodoStore } = require('../todo-store');
const { TaskStore } = require('../task-board');
const { TodoAI, taskId } = require('../todo-ai');

const cli = path.join(__dirname, '..', 'board-cli.js');
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_TERMINAL_ID: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('todo status --files keeps a product file whose name contains an ASCII comma', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh4-todo-comma-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The book the AI found, saved under its real title.
  const book = path.join(root, 'books', 'Thinking, Fast and Slow.epub');
  const notes = path.join(root, 'books', 'summary.md');
  fs.mkdirSync(path.dirname(book), { recursive: true });
  fs.writeFileSync(book, 'epub'); fs.writeFileSync(notes, '# 总结');

  // What board-cli sends to the app (fake control channel, like tests/board-cli.test.js).
  const dir = path.join(root, 'control');
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true }); fs.mkdirSync(path.join(dir, 'responses'));
  const requests = [];
  const server = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests')).filter((n) => n.endsWith('.json'))) {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8'));
      fs.unlinkSync(path.join(dir, 'requests', file)); requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: '{}' }));
    }
  }, 20);
  t.after(() => clearInterval(server));
  const run = await runCli(['todo', 'status', '--id', 'td-11111111-aaaa', '--task-id', 'todo-x', '--status', 'done',
    '--files', `${book},${notes}`], { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'test-token' });
  assert.equal(run.code, 0, run.stderr);
  const input = requests[0].input;

  // The app side: a real @ai to-do and its card, then the backfill the Captain just sent.
  const todos = new TodoStore(path.join(root, 'todos'), { deviceId: 'dev-mac' });
  const tasks = new TaskStore(path.join(root, 'tasks'));
  const ai = new TodoAI({ todos, tasks, deliver: () => {}, notify: async () => {} });
  const item = todos.add({ text: '@ai 找《Thinking, Fast and Slow》的 EPUB' });
  ai.scan();
  await ai.status({ id: item.id, taskId: taskId(item), status: 'working' });
  const done = await ai.status({ ...input, id: item.id, taskId: taskId(item) });
  assert.equal(done.ai.status, 'done');
  assert.deepEqual(done.ai.files, [book, notes]);
});
