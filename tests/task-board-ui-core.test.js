'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../task-board-ui-core');
const CrewMapCore = require('../crew-map-core');

const card = (id, extra) => ({ id, project: 'agentdeck', title: id, status: 'todo', flag: null, order: 0, depends_on: [],
  assignee: null, session_id: null, updated: '2026-10-01T00:00:00.000Z', archived: false, ...extra });
const ids = (col) => col.cards.map((c) => c.card.id);
const lane = (board, key) => board.lanes.find((l) => l.key === key);
// one column across every lane, for single-project checks
const column = (board, key) => ({ cards: board.lanes.flatMap((l) => l.columns.find((c) => c.key === key).cards) });

test('cards sit in their data-layer status column; failed cards stay there marked, archived ones are hidden', () => {
  const board = U.buildBoard([
    card('a'), card('b', { status: 'doing' }), card('c', { status: 'review' }), card('d', { status: 'needs_user' }),
    card('e', { status: 'done' }), card('f', { status: 'doing', flag: 'failed' }), card('g', { status: 'done', archived: true }),
  ]);
  assert.deepEqual(board.columns.map((c) => c.key), ['todo', 'doing', 'review', 'needs_user', 'done']);
  assert.deepEqual(board.columns.map((c) => c.label), ['待办', '进行中', '待验收', '需要你', '完成']);
  assert.deepEqual(board.columns.map((c) => c.count), [1, 2, 1, 1, 1]);
  assert.deepEqual(board.lanes[0].columns.map(ids), [['a'], ['b', 'f'], ['c'], ['d'], ['e']]);
  assert.equal(board.lanes[0].columns[1].cards[1].card.flag, 'failed');
  assert.equal(board.total, 6, 'archived cards are not shown');
});

test('one lane per project, project names compared case-insensitively', () => {
  const cards = [
    card('a', { project: 'AgentDeck' }), card('b', { project: 'agentdeck', status: 'doing' }), card('c', { project: 'agentdeck ' }),
    card('d', { project: 'zeta' }), card('e', { project: '阿尔法', status: 'done' }),
  ];
  const board = U.buildBoard(cards);
  assert.deepEqual(board.lanes.map((l) => l.key), ['agentdeck', 'zeta', '阿尔法'].sort((x, y) => x.localeCompare(y)));
  const deck = lane(board, 'agentdeck');
  assert.equal(deck.name, 'agentdeck', 'the spelling most cards use is shown');
  assert.equal(deck.total, 3);
  assert.deepEqual(ids(deck.columns[0]).sort(), ['a', 'c']);
  assert.deepEqual(ids(deck.columns[1]), ['b']);
  assert.equal(U.projectKey(' AgentDeck '), 'agentdeck');
  assert.equal(U.projects(cards).length, 3);
});

test('project filter keeps one project (any spelling); 全部 keeps all; archived-only projects are skipped', () => {
  const cards = [card('a', { project: 'zeta' }), card('b', { project: '阿尔法' }), card('c', { project: 'agentdeck' }),
    card('c2', { project: 'AgentDeck' }), card('d', { project: 'old', archived: true, status: 'done' })];
  assert.deepEqual(U.buildBoard(cards, { project: 'zeta' }).lanes.map((l) => l.key), ['zeta']);
  assert.deepEqual(ids(U.buildBoard(cards, { project: 'AGENTDECK' }).lanes[0].columns[0]).sort(), ['c', 'c2']);
  assert.equal(U.buildBoard(cards, { project: U.ALL }).total, 4);
  assert.deepEqual(U.buildBoard(cards).projects.map((p) => p.key), ['agentdeck', 'zeta', '阿尔法'].sort((a, b) => a.localeCompare(b)));
  assert.ok(!U.projects(cards).some((p) => p.key === 'old'));
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

test('an archived-only or removed project filter returns all visible projects immediately', () => {
  const cards = [card('a'), card('old', { project: 'old', status: 'done', archived: true })];
  for (const project of ['old', 'removed']) {
    const board = U.buildBoard(cards, { project });
    assert.equal(board.project, U.ALL);
    assert.deepEqual(board.lanes.map((l) => l.key), ['agentdeck']);
    assert.equal(board.total, 1);
  }
  assert.deepEqual(U.buildBoard([]).lanes, []);
  assert.equal(U.archiveDone, undefined, 'read-only UI has no archive helper');
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
  assert.equal(U.ownerLabel(card('a', { session_id: 'gone' }), label), '会话已关闭');
  assert.equal(U.ownerLabel(card('a', { session_id: 'gone', assignee: { agent: 'codex', model: 'default' } }), label), 'codex');
  assert.equal(U.ownerLabel(card('a', { assignee: { agent: 'codex', model: 'default' } }), label), 'codex');
  assert.equal(U.ownerLabel(card('a', { assignee: { agent: 'claude', model: 'opus' } }), label), 'claude');
  assert.equal(U.ownerLabel(card('a'), label), '未派活');
  assert.equal(U.modelLabel(card('a', { assignee: { agent: 'claude', model: 'opus' } })), 'opus');
  assert.equal(U.modelLabel(card('a', { assignee: { agent: 'codex', model: 'default' } })), '');
  assert.equal(U.modelLabel(card('a')), '');
});

test('project hue is keyed by name, so both views agree on a project colour', () => {
  assert.equal(CrewMapCore.projectHue(''), 210);
  assert.equal(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('agentdeck'));
  assert.notEqual(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('阿尔法'));
  assert.notEqual(CrewMapCore.projectHue('agentdeck'), CrewMapCore.projectHue('mobile'));
  assert.equal(CrewMapCore.projectHue('AgentDeck '), CrewMapCore.projectHue('agentdeck'), 'case does not split a project colour');
  for (const p of ['a', 'agentdeck', '阿尔法', 'x'.repeat(200)]) {
    const h = CrewMapCore.projectHue(p);
    assert.ok(h >= 0 && h < 360, p);
  }
});
