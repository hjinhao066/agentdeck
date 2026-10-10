'use strict';
// 挖虫④ #6：「待我处理」用 todoFiled 记住每条 @ai 待办的每次回答已经登记过，最多记 500 个、先进先出。
// 用户勾掉待办而不删除时，这条待办和它的 AI 结果一直留在列表里；累计登记满 500 次后，
// 最早那条仍在列表里的待办的记号被挤掉，下一次刷新它的「AI 办完了」就又冒出来一遍。
// 列表里有结果的 @ai 待办超过 500 条时，每次刷新都会挤掉一条、再冒一条，没有尽头。
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../attention-core');

const DEV = 'dev-mac-0001';
const T0 = Date.UTC(2026, 9, 8, 4, 0, 0);
const hex = (n) => n.toString(16).padStart(64, '0');
function todo(n, ai) {
  return { id: 'td-' + String(n).padStart(8, '0') + '-aaaa', text: `@ai 第 ${n} 件事`, done: true, deleted: false,
    ai: { revision: hex(n), taskId: 'todo-' + hex(n), ownerDevice: DEV, deliveredAt: '2026-10-08T04:00:00.000Z', files: [], message: '', ...ai } };
}
const reports = (s, n) => s.items.filter((i) => i.title === `AI 办完了：@ai 第 ${n} 件事`).length;

test('an AI result the user already saw is not filed again after 500 later answers', () => {
  const s = A.normalize({});
  // The first @ai to-do: the AI finished it, the user read the report and ticked the to-do (not deleted).
  const first = todo(0, { status: 'done', round: 1, message: '办好了' });
  assert.equal(A.syncTodos(s, [first], DEV, T0), 1);
  for (const item of s.items) A.resolve(s, item.id, 'user', '', T0 + 1);
  // 250 later to-dos, each answered twice (等你提供 → 办完了): 500 answers filed over the months.
  const later = [];
  for (let n = 1; n <= 250; n++) later.push(n);
  let now = T0 + 10;
  A.syncTodos(s, [first, ...later.map((n) => todo(n, { status: 'needs_user', round: 1, message: '缺材料' }))], DEV, now++);
  A.syncTodos(s, [first, ...later.map((n) => todo(n, { status: 'done', round: 3, message: '办好了' }))], DEV, now++);
  for (const item of s.items) if (!item.done) A.resolve(s, item.id, 'user', '', now);
  // Nothing changed on the first to-do; a plain refresh must not bring its report back.
  const all = [first, ...later.map((n) => todo(n, { status: 'done', round: 3, message: '办好了' }))];
  assert.equal(A.syncTodos(s, all, DEV, now + 1), 0, 'a refresh with no new answer files nothing');
  assert.equal(reports(s, 0), 1, '「AI 办完了：第 0 件事」只登记一次');
});

test('more than 500 answered @ai to-dos in the list do not re-file one old report on every refresh', () => {
  const s = A.normalize({});
  const all = [];
  for (let n = 0; n < 501; n++) all.push(todo(n, { status: 'done', round: 1, message: '办好了' }));
  assert.equal(A.syncTodos(s, all, DEV, T0), 501);
  for (const item of s.items) A.resolve(s, item.id, 'user', '', T0 + 1);
  let refiled = 0;
  for (let i = 0; i < 5; i++) refiled += A.syncTodos(s, all, DEV, T0 + 10 + i);
  assert.equal(refiled, 0, 'five refreshes with nothing new file nothing');
});

test('an answer whose 待办 is missing from one read (a damaged or half-synced file) is not filed again when it is back', () => {
  const s = A.normalize({});
  const kept = todo(0, { status: 'done', round: 1, message: '办好了' });
  assert.equal(A.syncTodos(s, [kept], DEV, T0), 1);
  for (const item of s.items) A.resolve(s, item.id, 'user', '', T0 + 1);
  // one read without it, while another 待办 gets an answer
  assert.equal(A.syncTodos(s, [todo(1, { status: 'done', round: 1, message: '也办好了' })], DEV, T0 + 10), 1);
  // it is back: nothing new about it
  assert.equal(A.syncTodos(s, [kept, todo(1, { status: 'done', round: 1, message: '也办好了' })], DEV, T0 + 20), 0);
  assert.equal(reports(s, 0), 1);
});
