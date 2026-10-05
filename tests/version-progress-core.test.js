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
    card('row', '侧边栏队长行', 'doing', { detail: '看整体进度。1.1.3', updated: '2026-10-04T05:00:00Z' }),
    card('font', '字体缩放', 'done', { detail: '1.1.3', updated: '2026-10-04T04:00:00Z' }),
    card('draft', '草稿同步', 'done', { detail: '1.1.3', archived: true, updated: '2026-10-04T03:00:00Z' }),
    card('dropped', '放弃的 1.1.3 想法', 'todo', { archived: true }),
    card('label', '版本号', 'review', { version: '1.1.3' }),
    card('fail', '1.1.3 打包', 'doing', { flag: 'failed' }),
    card('later', '1.1.30 迁移', 'todo'),
    { ...card('h', 'Hermes 1.1.3', 'todo'), project: 'hermes' },
  ];
  const p = V.progress(cards, '1.1.2');
  assert.equal(p.version, '1.1.3');
  assert.deepEqual(p.groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)]), [
    ['attention', '需要处理', ['fail']], ['doing', '进行中', ['row']], ['review', '待验收', ['label']], ['done', '已完成', ['font', 'draft']],
  ]);
  assert.deepEqual(p.items.map((i) => [i.id, i.done, i.label, i.reason]), [
    ['fail', false, '失败', 'named'], ['row', false, '进行中', 'named'], ['label', false, '待验收', 'named'],
    ['font', true, '完成', 'named'], ['draft', true, '完成', 'named'],
  ]);
  assert.deepEqual([p.done, p.total, p.percent], [2, 5, 40]);
  assert.deepEqual(p.counts, { attention: 1, doing: 1, review: 1, done: 2 });
  assert.deepEqual(V.progress([], '1.1.2'), { version: '1.1.2', items: [], groups: [], done: 0, total: 0, percent: 0, counts: {} });
});

test('the release card pulls in its prerequisites, in-flight work joins and finished work stays', () => {
  const cards = [
    card('rel', '1.1.4 发版（必须含：cursor 状态修复）', 'todo', { flag: 'blocked', depends_on: ['cursor'] }),
    card('cursor', 'bug：cursor 会话被标成已完成', 'doing', { depends_on: ['probe'], assignee: { agent: 'Codex', model: 'GPT-6.1-Sol high' }, latest_receipt: '定位到\n 状态机' }),
    { ...card('probe', '调研 cursor 状态输出', 'done'), project: 'opencli' },
    card('drawer', '版本进度改成右侧抽屉', 'doing'),
    card('ask', '额度面板要不要分两池', 'needs_user', { detail: '只记得 1.1.2 时提过' }),
    card('backlog', 'Artifacts：按项目收集回执', 'todo'),
    card('next', '1.2.0：派活指定 Mac/Windows', 'doing'),
    card('next-dep', '两机在线状态', 'doing', { detail: '1.2.0' }),
    card('old', '侧边栏加 Hermes 入口', 'done'),
    card('gone', '撤掉的想法', 'doing', { archived: true }),
  ];
  const p = V.progress(cards, '1.1.3');
  assert.equal(p.version, '1.1.4');
  const why = Object.fromEntries(p.items.map((i) => [i.id, i.reason]));
  assert.deepEqual(why, { rel: 'named', cursor: 'dependency', probe: 'dependency', drawer: 'active', ask: 'active' });
  const cursor = p.items.find((i) => i.id === 'cursor');
  assert.deepEqual([cursor.agent, cursor.model, cursor.receipt, cursor.reasonLabel], ['Codex', 'GPT-6.1-Sol high', '定位到 状态机', '前置']);
  assert.deepEqual(p.items.find((i) => i.id === 'rel').waits, ['bug：cursor 会话被标成已完成']);
  // 'old' finished after an earlier render listed it: it stays, ticked. A
  // remembered card later earmarked for 1.2.0 leaves.
  const done = cards.map((c) => (c.id === 'drawer' ? { ...c, status: 'done' } : c));
  const kept = V.progress(done, '1.1.3', { remembered: ['drawer', 'old', 'next', 'missing'] });
  assert.deepEqual(kept.items.filter((i) => i.reason === 'kept').map((i) => [i.id, i.done]).sort(), [['drawer', true], ['old', true]]);
  assert.equal(V.progress(done, '1.1.3').items.some((i) => i.id === 'drawer'), false);
  // In-flight work is for the next release, not the one already running.
  assert.deepEqual(V.progress([card('w', '修个 bug', 'doing')], '1.1.3').items, []);
});

test('elapsed time runs from card creation to completion, or to now while open', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = (iso) => ({ created: iso, updated: '2026-10-04T11:00:00Z' });
  assert.equal(V.elapsed({ status: 'doing', done: false, ...at('2026-10-04T11:25:00Z') }, now), '35 分');
  assert.equal(V.elapsed({ status: 'done', done: true, ...at('2026-10-04T08:50:00Z') }, now), '2 时 10 分');
  assert.equal(V.elapsed({ status: 'review', done: false, ...at('2026-10-02T09:00:00Z') }, now), '2 天 3 时');
  assert.equal(V.elapsed({ status: 'doing', done: false, ...at('2026-10-04T11:59:40Z') }, now), '<1 分');
  assert.equal(V.elapsed({ status: 'todo', done: false, ...at('2026-10-04T08:00:00Z') }, now), '');
  assert.equal(V.elapsed({ status: 'doing', done: false, created: '' }, now), '');
});
