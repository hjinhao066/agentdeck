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
  assert.deepEqual(merged.reports.map((i) => i.key), ['mac:at-m3-report', 'mac:at-m4-report']);
  assert.deepEqual(merged.done.map((i) => i.key), ['win:at-w2-done', 'win:at-w3-other']);
  assert.equal(merged.needs[2].machineLabel, 'Windows');
  assert.deepEqual(merged.counts, { need: 3, reports: 2, unreadReports: 1, badge: 4 });
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
