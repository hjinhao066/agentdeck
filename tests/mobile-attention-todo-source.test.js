'use strict';
// A 待我处理 item filed from a 待办 handed to AI has source 'todo' and reads 「来自待办」 on
// the desktop and on the phone. On its way from the desktop store to the phone page it
// passes api/attention (mobile-web.js attentionView), which must keep that source.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../attention-core');
const Hub = require('../mobile-web/hub/core');
const { attentionView } = require('../mobile-web');

const T0 = Date.UTC(2026, 9, 8, 4, 0, 0);
const DEV = 'dev-mac-0001';
const todo = { id: 'td-11111111-aaaa', text: '@ai 找一本书的 EPUB', done: false, deleted: false,
  ai: { revision: 'a'.repeat(64), taskId: 'todo-' + 'a'.repeat(64), ownerDevice: DEV, deliveredAt: '2026-10-08T04:00:00.000Z', files: [], status: 'needs_user', message: '书放在哪个文件夹？' } };

test('a 待办 item keeps its source from the desktop store to the phone page', () => {
  const store = A.normalize({});
  assert.equal(A.syncTodos(store, [todo], DEV, T0), 1);
  const desktop = A.phoneView(store);
  assert.equal(desktop.items[0].source, 'todo');
  const phone = Hub.cleanAttention(JSON.parse(JSON.stringify(attentionView(desktop, T0))));
  assert.equal(phone.length, 1);
  assert.equal(phone[0].source, 'todo', 'the phone shows 「来自待办」 for source todo, as the desktop does');
  // An unknown source still reads as the 队长's.
  assert.equal(attentionView({ items: [{ ...desktop.items[0], source: 'elsewhere' }] }, T0).items[0].source, 'captain');
});
