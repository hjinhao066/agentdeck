'use strict';

// 待我处理 on the phone hub: cleaning each computer's answer and merging both.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mobile-web/hub/core.js');
const { attentionFixture } = require('./fixtures/hub-proxy.js');

test('each computer\'s list is cleaned again: no foreign ids, no markup tricks, line breaks kept', () => {
  const items = Core.cleanAttention({ items: [
    { id: 'at-ok-1', kind: 'need', label: '等你拍板', options: ['继续', ' 先放着\n', '继续', { x: 1 }], title: ' 一句\n话 ', detail: '第一行\n第二行\u0007', created: 5, replies: [{ text: '好', at: 6, from: 'phone', seen: true, notice: 'secret' }] },
    { id: '../x', kind: 'need', title: 'x', created: 1 },
    { id: 'at-ok-2', kind: 'todo', title: 'x', created: 1 },
    { id: 'at-ok-3', kind: 'report', title: '   ', created: 1 },
    { id: 'at-ok-4', kind: 'report', title: '<img src=x onerror=alert(1)>', created: 1, source: 'evil' },
  ] });
  assert.deepEqual(items.map((i) => i.id), ['at-ok-1', 'at-ok-4']);
  assert.equal(items[0].title, '一句 话');
  assert.equal(items[0].detail, '第一行\n第二行 ');
  assert.deepEqual(items[0].replies, [{ text: '好', at: 6, from: 'phone', seen: true }]);
  assert.deepEqual(items[0].options, ['继续', '先放着']);
  assert.deepEqual(items[1].options, []);
  assert.equal(items[1].title, '<img src=x onerror=alert(1)>', 'kept as text; the page only ever sets textContent');
  assert.equal(items[1].source, 'captain');
  assert.equal(items[1].label, '结果汇报');
  assert.deepEqual(Core.cleanAttention(null), []);
});

test('both computers on one page: needs first, then reports, newest first; finished by when; each item keeps its computer', () => {
  const data = attentionFixture();
  const merged = Core.mergeAttention([
    { id: 'mac', label: 'Mac', items: Core.cleanAttention({ items: data.mac }) },
    { id: 'win', label: 'Windows', items: Core.cleanAttention({ items: data.win }) },
  ]);
  assert.deepEqual(merged.needs.map((i) => i.key), ['mac:at-m1-decide', 'mac:at-m2-login', 'win:at-w1-held']);
  assert.deepEqual(merged.reports.map((i) => i.key), ['mac:at-m5-chat', 'mac:at-m3-report']);
  assert.deepEqual(merged.done.map((i) => i.key), ['mac:at-m4-report', 'win:at-w2-done', 'win:at-w3-other']);
  assert.equal(merged.needs[2].machineLabel, 'Windows');
  assert.deepEqual([merged.reports[0].turn, merged.done[0].doneBy], ['mac-t5', 'chat']);
  assert.deepEqual(merged.counts, { need: 3, reports: 2, unreadReports: 2, badge: 3 }, 'the number is 要你处理 only');
});

test('a reply or tick that did not go through says why, in words', () => {
  assert.match(Core.attentionFailure({ failed: true }, 'Mac'), /连不上 Mac.*草稿还在/);
  assert.match(Core.attentionFailure({ timedOut: true }, 'Mac'), /没有回应/);
  assert.equal(Core.attentionFailure({ status: 409, body: { error: '回复最多 4000 字。' } }, 'Mac'), '回复最多 4000 字。');
  // The computer says "sidebar"; the phone has none, so it says where to go instead.
  assert.equal(Core.attentionFailure({ status: 409, body: { error: '还没有队长：回复要交给队长，先在侧边栏创建队长。' } }, 'Mac'), 'Mac 上还没有队长。先到那台电脑的 AgentDeck 里创建队长，再回来回复。草稿还在。');
  assert.match(Core.attentionFailure({ status: 404 }, 'Windows'), /版本太旧/);
  assert.match(Core.attentionFailure({ status: 403 }, 'Mac'), /刷新/);
});

test('a reply counts as seen only when most of it is in view on both axes, cut by its scroll area, the deck and the window', () => {
  const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const win = box(0, 0, 1280, 900), deck = box(252, 40, 1280, 900);
  // In front: the 队长 column fills the deck, the reply sits in the middle of its chat.
  const chat = box(260, 60, 1250, 820);
  assert.equal(Core.mostlyShown(box(300, 200, 1200, 500), [chat, deck, win]), true);
  // The review's case: the column scrolled left until 4 px of it show at the deck's edge;
  // the reply ends at 120.5, left of the deck. Tall and vertically in view, but not seen.
  const slid = box(-794, 60, 256, 820);
  assert.equal(Core.mostlyShown(box(-760, 200, 120.5, 500), [slid, deck, win]), false);
  // Only the sliver of a reply that reaches into those 4 px: still not seen.
  assert.equal(Core.mostlyShown(box(-760, 200, 255, 500), [slid, deck, win]), false);
  // Half of it out of the deck sideways: not most of it.
  assert.equal(Core.mostlyShown(box(-200, 200, 700, 500), [box(-300, 60, 1250, 820), deck, win]), false);
  // Mostly in, a narrow strip cut: seen. Past the window's right edge: cut there too.
  assert.equal(Core.mostlyShown(box(200, 200, 1100, 500), [box(150, 60, 1250, 820), deck, win]), true);
  assert.equal(Core.mostlyShown(box(900, 200, 1800, 500), [box(260, 60, 1900, 820), box(252, 40, 1900, 900), win]), false);
  // Vertically as before: scrolled out above, or nothing measured.
  assert.equal(Core.mostlyShown(box(300, -400, 1200, 70), [chat, deck, win]), false);
  assert.equal(Core.mostlyShown(box(300, 200, 300, 500), [chat, deck, win]), false);
  assert.equal(Core.mostlyShown(box(300, 200, 1200, 500), []), false);
  // A reply taller than its chat counts once it fills half the chat.
  assert.equal(Core.mostlyShown(box(300, 0, 1200, 3000), [chat, deck, win]), true);
});
