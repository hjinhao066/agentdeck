'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../version-progress-core');

const card = (id, title, status, extra = {}) => ({ id, project: 'agentdeck', title, detail: '', status, flag: null, archived: false, ...extra });

test('version mentions skip lookalikes but accept v-prefixes and sentence ends', () => {
  assert.deepEqual(V.versionsIn('1.1.3 发版；v1.2.0。修 1.1.30 和 1.1.3.4、21.1.3 以及 1.1.3.'), ['1.1.3', '1.2.0', '1.1.30', '21.1.3', '1.1.3']);
  assert.deepEqual(V.versionsOf(card('a', '无版本', 'todo', { version: 'v1.1.3', detail: '还有 1.1.3' })), ['1.1.3']);
});

test('the target is the smallest mentioned version newer than the app, else the app version', () => {
  const cards = [
    card('old', '1.1.1 实测发现的小 bug（1.1.2 修）', 'done'),
    card('next', '1.2.0：派活指定 Mac/Windows', 'todo'),
    card('rel', '1.1.3 发版', 'todo'),
    card('arch', '归档的 1.1.2.9 和 1.1.2', 'done', { archived: true }),
    { ...card('other', 'Hermes 1.1.4', 'todo'), project: 'hermes' },
  ];
  assert.equal(V.targetVersion(cards, '1.1.2'), '1.1.3');
  assert.equal(V.targetVersion(cards, '1.1.3'), '1.2.0');
  assert.equal(V.targetVersion(cards, '1.2.0'), '1.2.0');
  // Without an app version: the oldest version that still has open work.
  assert.equal(V.targetVersion(cards), '1.1.3');
  assert.equal(V.targetVersion([]), null);
});

test('progress lists the version\'s cards, counts archived done work and skips other projects', () => {
  const cards = [
    card('row', '侧边栏队长行', 'doing', { detail: '看整体进度。1.1.3' }),
    card('font', '字体缩放', 'done', { detail: '1.1.3' }),
    card('draft', '草稿同步', 'done', { detail: '1.1.3', archived: true }),
    card('dropped', '放弃的 1.1.3 想法', 'todo', { archived: true }),
    card('label', '版本号', 'review', { version: '1.1.3' }),
    card('fail', '1.1.3 打包', 'doing', { flag: 'failed' }),
    card('later', '1.1.30 迁移', 'todo'),
    { ...card('h', 'Hermes 1.1.3', 'todo'), project: 'hermes' },
  ];
  const p = V.progress(cards, '1.1.2');
  assert.equal(p.version, '1.1.3');
  assert.deepEqual(p.items.map((i) => [i.id, i.done, i.label]), [
    ['row', false, '进行中'], ['font', true, '完成'], ['draft', true, '完成'], ['label', false, '待验收'], ['fail', false, '失败'],
  ]);
  assert.deepEqual([p.done, p.total, p.percent], [2, 5, 40]);
  assert.deepEqual(V.progress([], '1.1.2'), { version: '1.1.2', items: [], done: 0, total: 0, percent: 0 });
});
