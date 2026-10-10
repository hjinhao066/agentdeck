// ↑ in an empty composer brings back your earlier messages. In the 队长 column the
// history was every saved turn's `user`, which there is mostly not yours: dispatch
// cards (their task title), 永动机 notices ("永动机") and receipt deliveries AgentDeck
// typed ("": the box stayed empty and ↑ looked dead).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/chat-ui-page');

const t0 = Date.now() - 3600_000;
test('↑ in 队长\'s composer recalls your last message, not a card title or a notice', async () => {
  const h = load({
    cols: [{ id: 'cap', cmd: 'claude', isMain: true }],
    saved: [{ id: 'cap', turns: [
      { id: 'u1', ts: t0, user: '把看板那个 bug 修了', reply: '好，派出去了。', done: true, atts: [] },
      { id: 'k1', ts: t0 + 1000, kind: 'task', user: '修看板打不开（Opus）', reply: '', done: true, atts: [], task: { colId: 'w1', title: '修看板打不开（Opus）', status: 'working', receipt: null } },
      { id: 'r1', ts: t0 + 60_000, user: '', reply: '收到回执，看板修好了。', done: true, atts: [] },
      { id: 'n1', ts: t0 + 90_000, kind: 'notice', user: '永动机', reply: '永动机：已切到 US2 席位。', done: true, atts: [] },
    ] }],
  });
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  h.stop();
  const ta = h.textarea('cap');
  ta.value = '';
  ta.dispatch('keydown', { key: 'ArrowUp', isComposing: false, shiftKey: false });
  assert.equal(ta.value, '把看板那个 bug 修了');
  // and one more ↑ has nothing older of yours: it stays
  ta.dispatch('keydown', { key: 'ArrowUp', isComposing: false, shiftKey: false });
  assert.equal(ta.value, '把看板那个 bug 修了');
});
