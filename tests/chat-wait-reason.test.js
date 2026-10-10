// A task waiting for its turn carries why it waits (task.waitReason: quota, a seat, the
// session limit) and the 队长 card shows `task.waitReason || M.queueNote(...)`. The chat
// card's copy of the task went through ChatCore.normalizeTask, which dropped waitReason,
// so the card always read the generic session-limit note, also while waiting on quota.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, ChatCore, ROOT } = require('./fixtures/chat-ui-page');
const MainCore = require(path.join(ROOT, 'main-core.js'));

const REASON = '已排队：额度用尽，稍后自动开新会话「修看板」。';

test('a saved waiting card keeps why it waits', () => {
  const chat = ChatCore.normalizeChat({ turns: [{ id: 'k1', user: '修看板', kind: 'task', done: true, task: { colId: '', title: '修看板', status: 'waiting', waitReason: REASON } }] }, 'cap');
  assert.equal(chat.turns[0].task.waitReason, REASON);
});

// The real card renderer, cut out of main-session.js.
function realRenderCard(doc, win) {
  const src = fs.readFileSync(path.join(ROOT, 'main-session.js'), 'utf8');
  const from = src.indexOf('  const STATUS_TEXT = ');
  const to = src.indexOf('\n  function init(h) {', from);
  assert.ok(from > 0 && to > from, 'renderCard found in main-session.js');
  const ctx = vm.createContext({
    window: win, document: doc, M: MainCore, memoryHold: false, capInfo: () => ({ limited: false }),
    host: { columns: () => [], jumpToColumn() {} },
    el: (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
  });
  vm.runInContext(src.slice(from, to) + '\nthis.renderCard = renderCard;', ctx);
  return ctx.renderCard;
}

test("队长's chat card for a task waiting on quota says so", async () => {
  const h = load({ cols: [{ id: 'cap', cmd: 'claude', isMain: true }], renderCard: realRenderCard });
  h.ctx.ChatGPTWebCore.isQueued = () => false;
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  h.ChatUI.addCard('cap', { id: 'k1', colId: '', title: '修看板', status: 'waiting', sentAt: Date.now(), receipt: null, waitReason: REASON });
  h.stop();
  const note = h.scroll('cap').querySelector('.task-note');
  assert.ok(note, 'the waiting card has its note');
  assert.equal(note.textContent, REASON);
});
