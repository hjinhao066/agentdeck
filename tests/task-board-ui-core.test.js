'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../task-board-ui-core');
const CrewMapCore = require('../crew-map-core');

const card = (id, extra) => ({ id, project: 'agentdeck', title: id, status: 'todo', flag: null, order: 0, depends_on: [],
  assignee: null, session_id: null, updated: '2026-10-01T00:00:00.000Z', archived: false, ...extra });
const ids = (col) => col.cards.map((c) => c.card.id);
const column = (board, key) => board.columns.find((c) => c.key === key);

test('cards group by data-layer status, failed flag pulled into its own column', () => {
  const board = U.buildBoard([
    card('a'), card('b', { status: 'doing' }), card('c', { status: 'review' }), card('d', { status: 'needs_user' }),
    card('e', { status: 'done' }), card('f', { status: 'doing', flag: 'failed' }), card('g', { status: 'done', archived: true }),
  ]);
  assert.deepEqual(board.columns.map((c) => c.key), ['todo', 'doing', 'review', 'needs_user', 'done', 'failed']);
  assert.deepEqual(board.columns.map((c) => c.label), ['待办', '进行中', '待验收', '等用户', '已完成', '失败']);
  assert.deepEqual(board.columns.map(ids), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  assert.equal(board.total, 6, 'archived cards are not shown');
});

test('project filter keeps one project; 全部 keeps all; project list is sorted and skips archived-only projects', () => {
  const cards = [card('a', { project: 'zeta' }), card('b', { project: '阿尔法' }), card('c', { project: 'agentdeck' }),
    card('d', { project: 'old', archived: true, status: 'done' })];
  assert.deepEqual(U.buildBoard(cards, { project: 'zeta' }).columns[0].cards.map((c) => c.card.id), ['a']);
  assert.equal(U.buildBoard(cards, { project: U.ALL }).total, 3);
  assert.deepEqual(U.buildBoard(cards).projects, ['agentdeck', 'zeta', '阿尔法'].sort((a, b) => a.localeCompare(b)));
  assert.ok(!U.projects(cards).includes('old'));
});

test('sort by updated is newest first; sort by order follows project/order/id', () => {
  const cards = [
    card('x1', { project: 'b', order: 0, updated: '2026-10-01T10:00:00Z' }),
    card('x2', { project: 'a', order: 2, updated: '2026-10-03T10:00:00Z' }),
    card('x3', { project: 'a', order: 1, updated: '2026-10-02T10:00:00Z' }),
    card('x0', { project: 'a', order: 1, updated: '2026-10-02T10:00:00Z' }),
  ];
  assert.deepEqual(ids(column(U.buildBoard(cards, { sort: 'updated' }), 'todo')), ['x2', 'x0', 'x3', 'x1']);
  assert.deepEqual(ids(column(U.buildBoard(cards, { sort: 'order' }), 'todo')), ['x0', 'x3', 'x2', 'x1']);
  assert.deepEqual(ids(column(U.buildBoard(cards, { sort: 'bogus' }), 'todo')), ['x2', 'x0', 'x3', 'x1'], 'unknown sort falls back to updated');
});

test('dependencies: unfinished prerequisites read 等 X 完成, met ones are parallel', () => {
  const cards = [
    card('pre', { title: '先做 A', status: 'doing' }),
    card('old', { title: '旧的', status: 'done', archived: true }),
    card('wait', { title: 'B', depends_on: ['pre', 'old'], flag: 'blocked' }),
    card('free', { title: 'C', depends_on: ['old'] }),
    card('lone', { title: 'D' }),
    card('held', { title: 'E', flag: 'held' }),
    card('ghost', { title: 'F', depends_on: ['t-missing'] }),
    card('many', { title: 'G', depends_on: ['pre', 'wait', 'free'] }),
  ];
  const todo = new Map(column(U.buildBoard(cards), 'todo').cards.map((c) => [c.card.id, c]));
  assert.equal(todo.get('wait').waitLabel, '等「先做 A」完成');
  assert.equal(todo.get('wait').parallel, false);
  assert.equal(todo.get('free').waitLabel, '', 'an archived done prerequisite counts as finished');
  assert.equal(todo.get('free').parallel, true);
  assert.equal(todo.get('lone').parallel, true);
  assert.equal(todo.get('held').parallel, false);
  assert.equal(todo.get('ghost').waitLabel, '等「t-missing」完成');
  assert.equal(todo.get('many').waitLabel, '等「先做 A」、「B」 等 3 项完成');
  const doing = column(U.buildBoard(cards), 'doing').cards[0];
  assert.equal(doing.parallel, false, 'only todo cards are marked parallel');
});

test('archive goes through the data layer archiveDone, scoped to the filtered project', async () => {
  const calls = [];
  const api = { archiveDone: (...args) => { calls.push(args); return Promise.resolve({ cards: [], notices: [] }); } };
  await U.archiveDone(api, 'agentdeck');
  await U.archiveDone(api, U.ALL);
  assert.deepEqual(calls, [['agentdeck'], []]);
});

test('owner and updated labels', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(U.formatUpdated('2026-10-04T11:59:30Z', now), '刚刚');
  assert.equal(U.formatUpdated('2026-10-04T11:15:00Z', now), '45 分钟前');
  assert.equal(U.formatUpdated('2026-10-04T09:00:00Z', now), '3 小时前');
  assert.equal(U.formatUpdated('2026-10-02T12:00:00Z', now), '2 天前');
  assert.match(U.formatUpdated('2026-08-01T12:00:00Z', now), /^2026-08-0[12]$/);
  assert.equal(U.formatUpdated('', now), '');
  const label = (id) => (id === 'col-1' ? 'Codex 修复' : null);
  assert.equal(U.ownerLabel(card('a', { session_id: 'col-1' }), label), 'Codex 修复');
  assert.equal(U.ownerLabel(card('a', { session_id: 'gone' }), label), '会话 gone');
  assert.equal(U.ownerLabel(card('a', { assignee: { agent: 'codex', model: 'default' } }), label), 'codex');
  assert.equal(U.ownerLabel(card('a', { assignee: { agent: 'claude', model: 'opus' } }), label), 'claude · opus');
  assert.equal(U.ownerLabel(card('a'), label), '未派活');
});

test('project hue is keyed by name, so both views agree on a project colour', () => {
  assert.equal(CrewMapCore.projectHue(''), 210);
  assert.equal(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('agentdeck'));
  assert.notEqual(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('阿尔法'));
  assert.notEqual(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('mobile'));
  for (const p of ['a', 'agentdeck', '阿尔法', 'x'.repeat(200)]) {
    const h = CrewMapCore.projectHue(p);
    assert.ok(h >= 0 && h < 360, p);
  }
});
