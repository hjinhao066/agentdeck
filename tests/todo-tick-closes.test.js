'use strict';
// 挖虫④ 拍板：用户自己勾掉 @ai 待办，同时关掉「待我处理」里它的那条（「AI 在等你」「AI 没办成」
// 和没看的「AI 办完了」）。原来这些一直开着，要用户再去点一次。勾掉以后 AI 再回填也不再登记新的一条。
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../attention-core');
const Hub = require('../mobile-web/hub/core.js');

const DEV = 'dev-mac-0001';
const T0 = Date.UTC(2026, 9, 10, 4, 0, 0);
const hex = (n) => n.toString(16).padStart(64, '0');
const todo = (n, ai, done = false) => ({ id: 'td-' + String(n).padStart(8, '0') + '-aaaa', text: `@ai 第 ${n} 件事`, done, deleted: false,
  ai: { revision: hex(n), taskId: 'todo-' + hex(n), ownerDevice: DEV, deliveredAt: '2026-10-10T04:00:00.000Z', files: [], message: '', round: 1, ...ai } });

test('ticking off a 待办 closes what 待我处理 still holds for it, and files nothing new for it', () => {
  const s = A.normalize({});
  const asking = todo(1, { status: 'needs_user', message: '缺病历' });
  const failed = todo(2, { status: 'failed', message: '没找到' });
  const finished = todo(3, { status: 'done', message: '办好了', files: ['/Users/me/a.pdf'] });
  const other = todo(4, { status: 'needs_user', message: '缺材料' });
  assert.equal(A.syncTodos(s, [asking, failed, finished, other], DEV, T0), 4);
  const open = () => s.items.filter((i) => !i.done).map((i) => i.card).sort();
  assert.equal(open().length, 4);
  // the user ticks three of them off
  assert.equal(A.syncTodos(s, [{ ...asking, done: true }, { ...failed, done: true }, { ...finished, done: true }, other], DEV, T0 + 10), 3);
  assert.deepEqual(open(), [other.ai.taskId]);
  for (const item of s.items.filter((i) => i.done)) assert.equal(A.doneText(item), '你勾掉了这条待办');
  // the phone gets the same words and keeps who closed it
  const phone = Hub.cleanAttention({ items: [{ id: 'at-tick0001', kind: 'need', title: 'AI 在等你：@ai 第 1 件事', done: true, doneBy: 'todo', doneText: '你勾掉了这条待办' }] })[0];
  assert.deepEqual([phone.doneBy, phone.doneText], ['todo', '你勾掉了这条待办']);
  // AI writes back again on a ticked one: nothing new is filed
  assert.equal(A.syncTodos(s, [{ ...asking, done: true, ai: { ...asking.ai, status: 'done', round: 2, files: ['/Users/me/b.pdf'], message: '也办好了' } }, other], DEV, T0 + 20), 0);
  assert.deepEqual(open(), [other.ai.taskId]);
});
