'use strict';
// 挖虫④ #14：Todo 后台异常回执「连续同一故障只排一条，恢复后再次故障算新事件」（docs/todo.md）。
// TodoBackendErrors 只在 run(stage) 成功时结束一个故障阶段；main.js 里 status（队长回填）、
// delivery（投递被拒）、watch（目录监听）、notification-queue-write（失败提醒入队）这几个阶段
// 只调 report()、从不结束。active 标记还写进 todo-backend-errors.json，重启也不清：
// 第一次出过错之后，这一阶段以后再出错，队长永远收不到异常回执。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('every Todo error stage main.js reports can also end (a later fault files a new receipt)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // Literal stage names only ('notification-' + stage from TodoFailureNotifications has the same gap, see findings).
  const reported = new Set([...source.matchAll(/todoErrors\??\.report\('([a-z-]*[a-z])'[,)]/g)].map((m) => m[1]));
  const ended = new Set([...source.matchAll(/todoErrors\??\.(?:run|recovered)\('([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(reported.has('status') && reported.has('delivery'), 'the stages this test is about are still reported');
  const never = [...reported].filter((stage) => !ended.has(stage));
  assert.deepEqual(never, [], 'stages reported but never ended: ' + never.join(', '));
});

test('a stage that recovered and fails again files a new receipt', (t) => {
  const os = require('os');
  const { TodoBackendErrors } = require('../todo-backend-errors');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const errors = new TodoBackendErrors({ file: path.join(dir, 'e.json'), log() {}, deliver: (c) => sent.push(c.id) });
  errors.report('status', Object.assign(new Error('x'), { code: 'EIO' }));
  errors.report('status', Object.assign(new Error('x'), { code: 'EIO' }));   // the same fault going on: no second receipt
  assert.equal(new Set(sent).size, 1);
  errors.recovered('status');
  errors.recovered('status');                                                  // nothing open: nothing written
  errors.report('status', Object.assign(new Error('x'), { code: 'EIO' }));
  assert.equal(new Set(sent).size, 2, 'after it worked again, the next fault is a new event');
});
