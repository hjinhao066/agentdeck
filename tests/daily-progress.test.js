'use strict';

// 每日进展 page: the cards, deliveries and highlights HubCore takes from the
// daily-progress tool's JSON, and the files that carry the page to both ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../mobile-web/hub/core.js');

const ROOT = path.resolve(__dirname, '..');
const card = (id, title, result = '', extra = {}) => ({ id, title, result, ...extra });
const raw = (date, projects, deliveries = [], done = 5) => ({ date, partial: false, as_of: date + 'T23:59', window: [],
  summary: { projects: projects.length, done, created: 2, sessions: 3, reject: 1, rework: 2, needs_user: 1, deliveries: deliveries.length, versions: [] },
  projects, deliveries });
const project = (name, lists) => ({ project: name, done: [], created: [], doing: [], needs_user: [], sessions: 1, reject: 0, rework: 0, ...lists });

test('each card the day touched shows once, with its project, title, short result and state', () => {
  const day = H.progressDay(raw('2026-10-07', [
    project('agentdeck', {
      done: [card('t-1', '修：额度弹层', '验收通过。'), card('t-2', '已经回到等你', '旧结果'), card('', '没有编号也算'), card('t-3', '')],
      doing: [card('t-4', '在做', '', { status: 'doing' }), card('t-5', '待验收', '复审中', { status: 'review' }), card('t-1', '重复的不再出现')],
      needs_user: [card('t-2', '已经回到等你')],
      created: [card('t-9', '只是新建，不算一件事')],
    }),
    project('秋招', { done: [card('t-6', 'JD 批量分析', '已抓取 300 条')] }),
  ]));
  assert.deepEqual(day.items, [
    { project: 'agentdeck', title: '已经回到等你', result: '', state: 'needs_user' },
    { project: 'agentdeck', title: '修：额度弹层', result: '验收通过。', state: 'done' },
    { project: 'agentdeck', title: '没有编号也算', result: '', state: 'done' },
    { project: 'agentdeck', title: '在做', result: '', state: 'doing' },
    { project: 'agentdeck', title: '待验收', result: '复审中', state: 'review' },
    { project: '秋招', title: 'JD 批量分析', result: '已抓取 300 条', state: 'done' },
  ]);
  // No card ids leave the file.
  assert.ok(!/t-\d/.test(JSON.stringify(day)));
});

test('long or messy card words are cut to one clean line, and a day keeps at most 150 cards', () => {
  const long = '标'.repeat(300), many = Array.from({ length: 200 }, (_, k) => card('t-' + k, '第 ' + k + ' 件'));
  const day = H.progressDay(raw('2026-10-07', [project('p', { done: [card('t-a', ` 多\n行\t${long} `, '结'.repeat(400)), ...many] })]));
  assert.equal(day.items.length, H.PROGRESS_LIMITS.items);
  assert.equal(day.items[0].title.length, 120);
  assert.ok(!/\s{2}|\n|\t/.test(day.items[0].title));
  assert.equal(day.items[0].result.length, 140);
});

test('a file that only names counts has no cards to show (null), and an empty day has none ([])', () => {
  const counts = H.progressDay({ date: '2026-10-07', summary: { done: 3 }, projects: [{ name: 'agentdeck', done: 3, sessions: 2 }] });
  assert.equal(counts.items, null);
  assert.equal(H.progressDay(raw('2026-10-07', [project('p', {})])).items.length, 0);
});

test('deliveries come with their clock time, earliest first; lines without words are dropped', () => {
  const day = H.progressDay(raw('2026-10-07', [], [
    { time: '22:33 gen 43 US2', text: 'AgentDeck 1.8 全部交付完成', versions: ['1.8'] },
    { time: '09:35 gen 43', text: '', versions: ['1.7'] },
    { time: '约 3:35 真实时钟', text: 'iPad 修复已部署到 VPS', versions: [] },
    { time: '没有时间', text: '收尾', versions: [] },
    { time: '25:99', text: '时间不对', versions: [] },
    'only a string',
  ]));
  assert.deepEqual(day.delivered, [
    { time: '03:35', text: 'iPad 修复已部署到 VPS' },
    { time: '22:33', text: 'AgentDeck 1.8 全部交付完成' },
    { time: '', text: '收尾' },
    { time: '', text: '时间不对' },
  ]);
  // The 版本更新 card keeps its own short list.
  assert.deepEqual(day.deliveries, ['AgentDeck 1.8 全部交付完成', 'iPad 修复已部署到 VPS', '收尾', '时间不对', 'only a string']);
});

test('cleaning twice gives the same days (the desktop cleans in main and again in the page)', () => {
  const list = [raw('2026-10-06', [project('a', { done: [card('t-1', '一')] })], [{ time: '10:00', text: '发了' }]),
    raw('2026-10-07', [project('b', { doing: [card('t-2', '二', '', { status: 'review' })] })])];
  const once = H.progressDays(list);
  assert.deepEqual(H.progressDays(once), once);
  assert.deepEqual(once[0].items, [{ project: 'b', title: '二', result: '', state: 'review' }]);
});

test('highlights: what shipped, the project that moved most, and how the day compares', () => {
  const day = (date, done, deliveries, top = 'agentdeck') => raw(date, [project(top, { done: Array.from({ length: Math.ceil(done / 2) }, (_, k) => card(date + k, 'x')) }), project('z', {})], deliveries, done);
  const days = H.progressDays([
    day('2026-10-07', 58, [{ time: '10:12', text: 'AgentDeck 1.7 全部交付完成' }, { time: '21:45', text: '1.8 包就绪' }, { time: '22:33', text: 'AgentDeck 1.8 全部交付完成' }]),
    day('2026-10-06', 55, []),
    day('2026-10-05', 97, [{ time: '23:08', text: '1.2.4 全部交付完成' }]),
  ]);
  assert.deepEqual(H.progressHighlights(days, 0), [
    { kind: 'ship', text: 'AgentDeck 1.7 全部交付完成' },
    { kind: 'ship', text: 'AgentDeck 1.8 全部交付完成' },
    { kind: 'top', text: 'agentdeck 完成 29 件，占全天 50%' },
  ]);
  assert.deepEqual(H.progressHighlights(days, 2).map((h) => h.kind), ['ship', 'top', 'trend']);
  assert.equal(H.progressHighlights(days, 2)[2].text, '最近 3 天里完成最多的一天');
  // 10-06 did fewer than 10-05: no trend line; nothing shipped either.
  assert.deepEqual(H.progressHighlights(days, 1).map((h) => h.kind), ['top']);
  const two = H.progressDays([day('2026-10-07', 10, []), day('2026-10-06', 4, [])]);
  assert.deepEqual(H.progressHighlights(two, 0).at(-1), { kind: 'trend', text: '比前一天多完成 6 件' });
  assert.deepEqual(H.progressHighlights([], 0), []);
});

test('the 每日进展 page ships with the hub and loads on both ends', () => {
  const release = fs.readFileSync(path.join(ROOT, 'scripts/mobile-release.js'), 'utf8');
  assert.match(release, /'progress\.js', 'progress\.css'/);
  const hub = fs.readFileSync(path.join(ROOT, 'mobile-web/hub/index.html'), 'utf8');
  assert.match(hub, /<script src="progress\.js" defer><\/script>/);
  assert.match(hub, /<link rel="stylesheet" href="progress\.css">/);
  const desk = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(desk, /<script src="mobile-web\/hub\/progress\.js"><\/script>/);
  assert.match(desk, /<link rel="stylesheet" href="mobile-web\/hub\/progress\.css" \/>/);
  assert.match(desk, /<script src="daily-progress-ui\.js"><\/script>/);
  assert.ok(require('../package.json').build.files.includes('daily-progress-ui.js'));
  const view = require('../mobile-web/hub/progress.js');
  assert.equal(typeof view.render, 'function');
  assert.match(view.EMPTY.none[1], /每天 0 点/);
});
