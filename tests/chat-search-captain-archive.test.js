// The sidebar search left out the 队长's conversations from before each context clear
// (chats saved with captainArchive), though README says the search reaches every turn
// and the 队长 column shows those conversations read-only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/chat-ui-page');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now() - 7 * 86400_000;
const turn = (id, user, reply, at) => ({ id, ts: at, end: at + 5000, user, reply, done: true, atts: [] });

test('a message said to 队长 before a context clear is found by the sidebar search, and opens', async () => {
  const h = load({
    cols: [{ id: 'cap', cmd: 'claude', isMain: true }],
    saved: [
      { id: 'cap', turns: [turn('c1', '今天先做发版', '好的。', Date.now() - 60_000)] },
      { id: 'captain-mold1', captainArchive: true, turns: [
        turn('o1', '把部署密钥轮换的事记一下，下周做', '记下了，下周一提醒你。', t0),
        turn('o2', '谢谢', '不客气。', t0 + 60_000),
      ] },
    ],
  });
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  const input = h.doc.getElementById('navSearch');
  input.value = '密钥轮换';
  input.dispatch('input');
  await wait(200);
  const items = h.doc.getElementById('navResults').querySelectorAll('.nr-item');
  assert.ok(items.length >= 1, 'the search finds the message said before the clear');
  // clicking the hit shows it, in the 队长 column's read-only history
  items[0].dispatch('click');
  await wait(50);
  const retired = h.scroll('cap').querySelector('.retired-chat');
  assert.ok(retired, 'the earlier 队长 conversations are opened');
  assert.ok(retired.textContent.includes('把部署密钥轮换的事记一下'), 'with the found message on screen');
  assert.ok(items[0].textContent.includes('只读'), 'the hit says it is read-only');
  const flashed = retired.querySelector('.flash');
  assert.ok(flashed && flashed.textContent.includes('把部署密钥轮换的事记一下'), 'the found turn is the one scrolled to and flashed');
  h.stop();
});
