// A reply naming a URL with a malformed % escape (a Python format string
// "https://api.github.com/repos/%s/%s", "…/100%", a cut "%E4%B8") made its link card
// call decodeURI, which throws. The throw ran out of chat-ui's render: the columns after
// it stayed blank at launch, and a turn ending with such a reply skipped its save, the
// 队长's turn-done handling and the notification.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/chat-ui-page');

const BAD = '好了，客户端这样写：\n\n```python\nurl = "https://api.github.com/repos/%s/%s" % (owner, repo)\n```\n\n照这个改就行。';
const t0 = Date.now() - 3600_000;
const turn = (id, user, reply, at) => ({ id, ts: at, end: at + 5000, user, reply, done: true, atts: [] });

test('a reply with a malformed % URL renders, and the columns after it still render at launch', async () => {
  const h = load({
    cols: [{ id: 'colA', cmd: 'claude' }, { id: 'colB', cmd: 'claude' }],
    saved: [
      { id: 'colA', turns: [turn('a1', '给我一个调 GitHub 的例子', BAD, t0)] },
      { id: 'colB', turns: [turn('b1', '今天几号', '今天 10 月 9 日。', t0 + 1000)] },
    ],
  });
  // renderer.js order: ChatUI.init, then the columns are built, then the saved chats arrive
  const ready = h.init();
  h.mount(h.columns[0]); h.mount(h.columns[1]);
  let error = null;
  try { await ready; } catch (e) { error = e; }
  h.stop();
  assert.equal(error, null, 'ChatUI.init must not fail on one reply: ' + (error && error.message));
  assert.equal(h.turnRows('colA').length, 1, 'the column holding the reply shows its turn');
  assert.equal(h.turnRows('colB').length, 1, 'the next column still shows its conversation');
  assert.equal(h.calls.sidebarRender, 1, 'the sidebar is refreshed once the chats are loaded');
});

test('a turn that ends with such a reply still finishes: saved, 队长 told, notification armed', async () => {
  const h = load({ cols: [{ id: 'cap', cmd: 'claude', isMain: true }] });
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  const entry = h.terminal('cap', ['❯ 给我一个调 GitHub 的例子', '']);
  const started = h.ChatUI.noteSent(h.columns[0], '给我一个调 GitHub 的例子');
  void started;
  // the agent answered: its reply is on the screen under the echoed prompt
  entry.screen.lines = ['❯ 给我一个调 GitHub 的例子', '', '⏺ 好了，客户端这样写：', '',
    '  url = "https://api.github.com/repos/%s/%s" % (owner, repo)', '', '  照这个改就行。', ''];
  let error = null;
  try { h.ChatUI.onExit('cap'); } catch (e) { error = e; }
  h.stop();
  assert.equal(error, null, 'finishing the turn must not throw into the status tick: ' + (error && error.message));
  const saved = h.ChatUI.turnsOf('cap');
  assert.equal(saved.length, 1);
  assert.ok(saved[0].done && saved[0].reply.includes('api.github.com'), 'the reply was read');
  assert.equal(h.calls.turnDone.length, 1, 'MainSession.onTurnDone ran (receipt delivery, captainTurnDone)');
  assert.equal(h.calls.manualTurnDone.length, 1, 'host.manualTurnDone ran (the user notification)');
  assert.equal(h.calls.pagesRefresh, 1, 'Artifacts refreshed');
  assert.equal(h.turnRows('cap').length, 1, 'and the turn is on screen');
  assert.ok(h.scroll('cap').querySelector('.link-card'), 'with its link card');
});
