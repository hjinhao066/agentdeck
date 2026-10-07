'use strict';
// The phone hub's to-do rules (mobile-web/hub/core.js): what it keeps from a
// computer's answer, how two answers become one list, and where a write goes.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mobile-web/hub/core.js');

const at = (minutes) => new Date(Date.parse('2026-10-06T12:00:00Z') - minutes * 60000).toISOString();
const item = (id, text, minutes, extra = {}) => ({ id: 'td-' + id, text, done: false, doneAt: null, created: at(minutes), updated: at(minutes), ...extra });

test('cleanTodos keeps only well-formed items and bare deletion marks, and drops anything extra', () => {
  const clean = Core.cleanTodos({ items: [
    item('good-item-01', '买书', 5, { ai: { state: 'requested' }, path: '/Users/x' }),
    { id: 'td-gone-item-01', deleted: true, updated: at(3), text: 'kept text must not travel' },
    { id: '../escape', text: 'bad id', updated: at(1) },
    { id: 'td-no-time-001', text: 'no updated' },
    { id: 'td-blank-text1', text: '   ', updated: at(1) },
    'not an object',
  ] });
  assert.deepEqual(clean, [
    { id: 'td-good-item-01', text: '买书', done: false, doneAt: null, created: at(5), updated: at(5) },
    { id: 'td-gone-item-01', deleted: true, updated: at(3) },
  ]);
  assert.deepEqual(Core.cleanTodos(null), []);
  assert.deepEqual(Core.cleanTodos({ items: 'x' }), []);
});

test('mergeTodos: the copy updated last wins, a later deletion hides the item, open newest first then finished', () => {
  const mac = [item('a-item-00001', 'A', 30), item('b-item-00001', 'B', 20), item('c-item-00001', 'C', 10)];
  const win = [item('a-item-00001', 'A', 30, { done: true, doneAt: at(2), updated: at(2) }), { id: 'td-b-item-00001', deleted: true, updated: at(1) },
    item('d-item-00001', 'D (Windows only)', 5)];
  const { open, done } = Core.mergeTodos([{ id: 'mac', todos: mac }, { id: 'win', todos: win }]);
  assert.deepEqual(open.map((t) => t.text), ['D (Windows only)', 'C']);
  assert.deepEqual(done.map((t) => t.text), ['A']);
  assert.equal(open[0].seenOn, 'win');
  // An older deletion does not hide a newer live copy.
  const back = Core.mergeTodos([{ id: 'mac', todos: [item('e-item-00001', 'E', 1)] }, { id: 'win', todos: [{ id: 'td-e-item-00001', deleted: true, updated: at(9) }] }]);
  assert.deepEqual(back.open.map((t) => t.text), ['E']);
  assert.deepEqual(Core.mergeTodos([]), { open: [], done: [] });
});

test('todoWriter prefers the chosen computer, then the default one, and only ever an online one that has to-dos', () => {
  const m = (id, extra = {}) => ({ id, state: 'online', todosReady: true, csrf: 'c', ...extra });
  assert.equal(Core.todoWriter([m('mac', { default: true }), m('win')], '').id, 'mac');
  assert.equal(Core.todoWriter([m('mac', { default: true }), m('win')], 'win').id, 'win');
  assert.equal(Core.todoWriter([m('mac', { default: true, state: 'offline' }), m('win')], 'mac').id, 'win');
  assert.equal(Core.todoWriter([m('mac', { default: true, todosReady: false }), m('win')], 'mac').id, 'win');
  assert.equal(Core.todoWriter([m('mac', { default: true, csrf: '' })], ''), null);
  assert.equal(Core.todoWriter([m('mac', { state: 'login' }), m('win', { state: 'unresponsive' })], ''), null);
});

test('todoBlock and todoFailure explain in plain words why nothing was recorded', () => {
  const m = (id, extra = {}) => ({ id, state: 'online', todosReady: true, csrf: 'c', ...extra });
  assert.equal(Core.todoBlock([m('mac')]), '');
  assert.match(Core.todoBlock([m('mac', { todosReady: false }), m('win', { state: 'offline' })]), /版本还没有待办/);
  assert.match(Core.todoBlock([m('mac', { state: 'login' }), m('win', { state: 'offline' })]), /先在「总览」登录/);
  assert.match(Core.todoBlock([m('mac', { state: 'offline' }), m('win', { state: 'unresponsive' })]), /都连不上/);
  assert.match(Core.todoFailure({ failed: true }, 'Mac'), /没连上 Mac/);
  assert.match(Core.todoFailure({ timedOut: true }, 'Mac'), /没有响应/);
  assert.match(Core.todoFailure({ status: 401 }, 'Mac'), /重新登录/);
  assert.match(Core.todoFailure({ status: 403 }, 'Mac'), /安全校验/);
  assert.equal(Core.todoFailure({ status: 400, body: { error: '待办最多 500 个字。' } }, 'Mac'), '待办最多 500 个字。');
  assert.match(Core.todoFailure({ status: 400, body: { error: 'Invalid to-do request.' } }, 'Mac'), /HTTP 400/);
});
