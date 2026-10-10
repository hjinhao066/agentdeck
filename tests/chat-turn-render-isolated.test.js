// One turn that cannot be drawn must not take the rest of the chat area with it: at
// launch the turns and columns after it still render, and a turn ending with such a
// reply is still saved, handed to 队长 and notified (the 2.0.3 bad-% URL was one such
// throw; this guards against the next one).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fixtures/chat-ui-page');

const t0 = Date.now() - 3600_000;
const turn = (id, user, reply, at) => ({ id, ts: at, end: at + 5000, user, reply, done: true, atts: [] });

test('a turn that throws while drawn leaves the other turns and columns on screen', async () => {
  const h = load({
    cols: [{ id: 'cap', cmd: 'claude', isMain: true }, { id: 'colB', cmd: 'claude' }],
    renderCard: () => () => { throw new Error('card renderer broke'); },
    saved: [
      { id: 'cap', turns: [
        { id: 'k1', ts: t0, kind: 'task', user: '修看板', reply: '', done: true, atts: [], task: { colId: 'w1', title: '修看板', status: 'working', receipt: null } },
        turn('c2', '今天先做发版', '好的。', t0 + 1000),
      ] },
      { id: 'colB', turns: [turn('b1', '今天几号', '今天 10 月 9 日。', t0 + 2000)] },
    ],
  });
  const ready = h.init();
  h.mount(h.columns[0]); h.mount(h.columns[1]);
  let error = null;
  try { await ready; } catch (e) { error = e; }
  h.stop();
  assert.equal(error, null, 'ChatUI.init must not fail on one turn: ' + (error && error.message));
  const cap = h.turnRows('cap');
  assert.equal(cap.length, 2, 'both turns of the column keep a row');
  assert.ok(cap[1].textContent.includes('今天先做发版'), 'the turn after the broken one is drawn');
  assert.equal(h.turnRows('colB').length, 1, 'the next column still shows its conversation');
  assert.equal(h.calls.sidebarRender, 1, 'the sidebar is refreshed once the chats are loaded');
});

test('a turn whose reply throws while drawn still finishes: saved, 队长 told, notification armed', async () => {
  const h = load({ cols: [{ id: 'cap', cmd: 'claude', isMain: true }] });
  const findLinks = h.host.findLinks;
  h.host.findLinks = (line) => { if (line.includes('BROKEN')) throw new Error('link finder broke'); return findLinks(line); };
  const ready = h.init();
  h.mount(h.columns[0]);
  await ready;
  const entry = h.terminal('cap', ['❯ 说一句', '']);
  h.ChatUI.noteSent(h.columns[0], '说一句');
  entry.screen.lines = ['❯ 说一句', '', '⏺ BROKEN 这一句', ''];
  let error = null;
  try { h.ChatUI.onExit('cap'); } catch (e) { error = e; }
  h.stop();
  assert.equal(error, null, 'finishing the turn must not throw into the status tick: ' + (error && error.message));
  const saved = h.ChatUI.turnsOf('cap');
  assert.ok(saved[0].done && saved[0].reply.includes('BROKEN'), 'the reply was read');
  assert.equal(h.calls.turnDone.length, 1, 'MainSession.onTurnDone ran');
  assert.equal(h.calls.manualTurnDone.length, 1, 'host.manualTurnDone ran');
  assert.equal(h.calls.pagesRefresh, 1, 'Artifacts refreshed');
});
