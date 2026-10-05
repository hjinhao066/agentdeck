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

test('cards always show in task order (project/order/id), whatever their update time', () => {
  const cards = [
    card('x1', { project: 'b', order: 0, updated: '2026-10-01T10:00:00Z' }),
    card('x2', { project: 'a', order: 2, updated: '2026-10-03T10:00:00Z' }),
    card('x3', { project: 'a', order: 1, updated: '2026-10-02T10:00:00Z' }),
    card('x0', { project: 'a', order: 1, updated: '2026-10-02T10:00:00Z' }),
    card('x4', { project: 'a', order: 1.5 }),
  ];
  assert.deepEqual(ids(column(U.buildBoard(cards), 'todo')), ['x0', 'x3', 'x4', 'x2', 'x1']);
});

test('lanes follow the saved lane order, new projects go after by name; the overview keeps every project', () => {
  const cards = [card('a', { project: 'alpha', status: 'doing' }), card('b', { project: 'beta', status: 'needs_user' }), card('c', { project: 'gamma', status: 'done' }), card('d', { project: 'delta' })];
  assert.deepEqual(U.buildBoard(cards).lanes.map((l) => l.key), ['alpha', 'beta', 'delta', 'gamma']);
  const board = U.buildBoard(cards, { laneOrder: ['Gamma', 'gone', 'beta'], project: 'beta' });
  assert.deepEqual(board.projects.map((p) => p.key), ['gamma', 'beta', 'alpha', 'delta']);
  assert.deepEqual(board.lanes.map((l) => l.key), ['beta']);
  assert.deepEqual(board.projects.map((p) => [p.open, p.counts.needs_user, p.counts.done]), [[0, 0, 1], [1, 1, 0], [1, 0, 0], [1, 0, 0]]);
  assert.equal(U.buildBoard(cards).open, 3);
  assert.deepEqual(U.moveLane(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(U.moveLane(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
  assert.deepEqual(U.moveLane(['a', 'b', 'c'], 'b', 'b'), ['a', 'c', 'b'], 'an anchor that is the lane itself means last');
});

test('需要你: only a real question is shown; internal wording and stale results are not questions', () => {
  const ask = (extra) => card('q', { status: 'needs_user', ...extra });
  assert.equal(U.userQuestion(ask({ latest_receipt: '密码最短 8 位还是 12 位？', last_event: 'a1:ask:command:abc' })), '密码最短 8 位还是 12 位？');
  assert.equal(U.userQuestion(ask({ latest_receipt: '用哪个配色？' })), '用哪个配色？', 'a dispatcher question has no event key');
  assert.equal(U.userQuestion(ask({ latest_receipt: '已结束，未提交回执', last_event: 'a1:fallback::x' })), '');
  assert.equal(U.userQuestion(ask({ latest_receipt: '调度已结束，尚未派出执行会话' })), '');
  assert.equal(U.userQuestion(ask({ latest_receipt: '' })), '');
  assert.equal(U.userQuestion(ask({ latest_receipt: '已完成，限流 10 次/分钟。', last_event: 'a1:complete:command:abc' })), '', 'an old result is not a question');
  assert.equal(U.userQuestion(ask({ user_question: ' 选 A 还是 B？ ', latest_receipt: '已结束，未提交回执' })), '选 A 还是 B？');
  assert.equal(U.userQuestion(card('d', { status: 'doing', latest_receipt: '进度如何？' })), '', 'only 需要你 cards carry a question');
  assert.equal(U.buildBoard([ask({ latest_receipt: '选哪个？' })]).lanes[0].columns[3].cards[0].question, '选哪个？');
  assert.equal(U.receiptText({ latest_receipt: '已结束，未提交回执' }), '队员停下了，但没有交结果。');
  assert.equal(U.receiptText({ latest_receipt: '调度已结束，尚未派出执行会话' }), '这件事还没有派给队员。');
  assert.equal(U.receiptText({ latest_receipt: '模板已合并。' }), '模板已合并。');
});

test('drop anchors, status steps and file paths', () => {
  assert.deepEqual(U.dropAnchor(['a', 'b', 'c'], 'c', 0), { before: 'a' });
  assert.deepEqual(U.dropAnchor(['a', 'b', 'c'], 'a', 2), { after: 'c' });
  assert.equal(U.dropAnchor(['a', 'b', 'c'], 'b', 1), null, 'dropped where it already is');
  assert.deepEqual(U.dropAnchor(['a', 'b'], 'x', 1), { before: 'b' }, 'a card from another column');
  assert.deepEqual(U.dropAnchor(['a', 'b'], 'x', 9), { after: 'b' });
  assert.equal(U.dropAnchor([], 'x', 0), null);
  assert.equal(U.stepStatus('todo', 1), 'doing');
  assert.equal(U.stepStatus('todo', -1), null);
  assert.equal(U.stepStatus('done', 1), null);
  assert.equal(U.labelOf('needs_user'), '需要你');
  assert.deepEqual(U.filePaths('见 /Users/a/reports/x/receipt.md，以及 ~/agentdeck/main.js。C:\\a\\b.txt；a/b 和 http://x.com/a/b 不算', ['/x/y', '/Users/a/reports/x/receipt.md']),
    ['/Users/a/reports/x/receipt.md', '~/agentdeck/main.js', 'C:\\a\\b.txt', '/x/y']);
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

test('groups: finished projects leave the active list for the completed area; a named project stays', () => {
  const cards = [
    card('a', { project: 'alpha', status: 'doing' }), card('a2', { project: 'alpha', status: 'done' }),
    card('b', { project: 'beta', status: 'done' }), card('b2', { project: 'beta', status: 'done' }),
    card('c', { project: 'gamma', status: 'done' }), card('c2', { project: 'gamma', status: 'done', archived: true }),
    card('d', { project: 'delta', status: 'needs_user', latest_receipt: '选哪个？' }),
  ];
  const board = U.buildBoard(cards);
  assert.deepEqual(board.active.map((l) => l.key), ['alpha', 'delta']);
  assert.deepEqual(board.finished.map((l) => l.key), ['beta', 'gamma']);
  assert.equal(board.finishedDone, 3, 'archived cards are not counted');
  assert.deepEqual(board.lanes.map((l) => l.key), ['alpha', 'beta', 'delta', 'gamma'], 'lanes still lists every shown project');
  assert.equal(board.open, 2);
  assert.deepEqual(board.columns.map((c) => c.count), [0, 1, 0, 1, 4]);
  const one = U.buildBoard(cards, { project: 'beta' });
  assert.deepEqual(one.active.map((l) => l.key), ['beta'], 'picked by name, a finished project is shown as a normal group');
  assert.deepEqual(one.finished, []);
  assert.deepEqual(U.buildBoard(cards, { laneOrder: ['delta', 'gamma'] }).active.map((l) => l.key), ['delta', 'alpha']);
});

test('需要你 reminder lists every waiting card of the shown projects, in lane order', () => {
  const cards = [
    card('q1', { project: 'beta', status: 'needs_user', title: '配色', latest_receipt: '用哪个配色？' }),
    card('q2', { project: 'alpha', status: 'needs_user', title: '对账', latest_receipt: '已结束，未提交回执' }),
    card('x', { project: 'alpha', status: 'doing' }),
  ];
  const board = U.buildBoard(cards);
  assert.deepEqual(board.alerts.map((a) => [a.card.id, a.lane, a.name, a.question]), [['q2', 'alpha', 'alpha', ''], ['q1', 'beta', 'beta', '用哪个配色？']]);
  assert.deepEqual(U.buildBoard(cards, { project: 'beta' }).alerts.map((a) => a.card.id), ['q1']);
  assert.deepEqual(U.buildBoard([card('x')]).alerts, []);
});

test('activity line: failure reason, hold, wait, receipt, run state, then the brief', () => {
  const c = (extra) => card('a', { status: 'doing', detail: '第一行说明\n第二行', latest_receipt: '', ...extra });
  assert.deepEqual(U.activity(c({ flag: 'failed', latest_receipt: '缺少权限\n详情' }), '等「X」完成', '队员正在干活'), { text: '缺少权限', tone: 'failed' });
  assert.deepEqual(U.activity(c({ flag: 'failed' })), { text: '执行失败，没有写明原因', tone: 'failed' });
  assert.deepEqual(U.activity(c({ flag: 'failed', latest_receipt: '已结束，未提交回执' })), { text: '队员停下了，但没有交结果。', tone: 'failed' });
  assert.deepEqual(U.activity(c({ flag: 'quota' })), { text: '额度、登录或限流问题', tone: 'failed' });
  assert.deepEqual(U.activity(c({ flag: 'held', latest_receipt: '旧回执' }), '', ''), { text: '已挂起，等队长放行', tone: 'wait' });
  assert.deepEqual(U.activity(c({ latest_receipt: '旧回执' }), '等「X」完成', ''), { text: '等「X」完成', tone: 'wait' });
  const blocked = { status: 'review', review_round: 2, review_block: { round: 2, reason: '没有可用的审查者。Gemini：额度用尽' }, latest_receipt: '做完了' };
  assert.deepEqual(U.activity(c(blocked), '', ''), { text: '待验收，需队长处理：没有可用的审查者。Gemini：额度用尽', tone: 'wait' });
  assert.deepEqual(U.activity(c({ ...blocked, review_block: { round: 1, reason: '旧轮' } }), '', ''), { text: '做完了', tone: '' }, 'a block from an earlier round is not shown');
  assert.deepEqual(U.activity(c({ ...blocked, status: 'doing' }), '', ''), { text: '做完了', tone: '' });
  assert.deepEqual(U.activity(c({ latest_receipt: ' 已接好入口。\n第二行 ' }), '', '队员正在干活'), { text: '已接好入口。', tone: '' });
  assert.deepEqual(U.activity(c(), '', '还没有队员在做'), { text: '还没有队员在做', tone: 'quiet' }, 'a 进行中 card with no news says whether anyone is on it');
  assert.deepEqual(U.activity(c({ status: 'todo' }), '', ''), { text: '第一行说明', tone: 'quiet' });
  assert.deepEqual(U.activity(c({ status: 'todo', detail: '' })), { text: '', tone: 'quiet' });
  assert.equal(U.moreLabel(6), '展开剩余 6 项');
});

test('dependency lines: one per shown card and unfinished live prerequisite, toned by how the prerequisite is doing', () => {
  const cards = [
    card('run', { status: 'doing' }), card('check', { status: 'review' }), card('ask', { status: 'needs_user' }), card('broken', { status: 'doing', flag: 'failed' }),
    card('nofunds', { status: 'review', flag: 'quota' }), card('parked', { status: 'doing', flag: 'held' }), card('later'), card('finished', { status: 'done' }),
    card('gone', { status: 'doing', archived: true }), card('far', { project: 'Other', status: 'doing' }),
    card('w', { order: 9, depends_on: ['run', 'check', 'ask', 'broken', 'nofunds', 'parked', 'later', 'finished', 'gone', 'missing', 'far'] }),
  ];
  const board = U.buildBoard(cards);
  assert.deepEqual(board.links.map((l) => [l.from, l.tone]), [['run', 'flow'], ['check', 'flow'], ['ask', 'stuck'], ['broken', 'stuck'], ['nofunds', 'stuck'], ['parked', 'idle'], ['later', 'idle'], ['far', 'flow']],
    'a finished prerequisite needs no line; an archived or unknown one has nowhere to start');
  assert.ok(board.links.every((l) => l.to === 'w'));
  // each line knows where its prerequisite sits, for when that card is folded away
  assert.deepEqual(board.links.filter((l) => l.from === 'far' || l.from === 'check').map((l) => [l.lane, l.status]), [['agentdeck', 'review'], ['other', 'doing']]);
  // only the shown project's cards draw lines, but they still reach into other projects
  assert.deepEqual(U.buildBoard(cards, { project: 'other' }).links, []);
  assert.deepEqual(U.buildBoard([...cards, card('w2', { project: 'Other', depends_on: ['run'] })], { project: 'other' }).links, [{ from: 'run', to: 'w2', lane: 'agentdeck', status: 'doing', tone: 'flow' }]);
  assert.deepEqual(U.buildBoard([card('a'), card('b', { status: 'doing' })]).links, []);
});

test('a dependency line leaves the prerequisite, runs down the gap beside its column and enters the waiting card', () => {
  const todo = { x: 20, y: 100, w: 200, h: 60 }, doing = { x: 230, y: 300, w: 200, h: 40 }, review = { x: 440, y: 100, w: 200, h: 60 };
  // the prerequisite is to the right: out of its left side, down the gap, into the waiting card's right side
  let r = U.linkRoute(doing, todo, 10);
  assert.deepEqual(r.points, [[230, 320], [225, 320], [225, 130], [220, 130]]);
  assert.equal(r.length, 200);
  assert.equal(r.d, 'M230 320 L227.5 320 Q225 320 225 317.5 L225 132.5 Q225 130 222.5 130 L220 130', 'corners are rounded, never more than half a segment');
  // to the left: out of its right side
  assert.deepEqual(U.linkRoute(todo, doing, 10).points, [[220, 130], [225, 130], [225, 320], [230, 320]]);
  // level with each other: one straight line across the gap
  r = U.linkRoute(review, todo, 10);
  assert.deepEqual(r.points, [[440, 130], [220, 130]]);
  assert.equal(r.d, 'M440 130 L220 130');
  // in one column: a bracket in the gap on the left
  const below = { x: 20, y: 240, w: 200, h: 60 };
  r = U.linkRoute(below, todo, 10);
  assert.deepEqual(r.points, [[20, 270], [15, 270], [15, 130], [20, 130]]);
  assert.equal(r.length, 150);
  // lines to different cards sharing a gap fan out a little, and stay inside the gap however many there are
  assert.deepEqual([0, 1, 2, 9].map((slot) => U.linkRoute(below, todo, 10, slot).points[1][0]), [15, 13.5, 12, 12]);
  assert.deepEqual([0, 1, 5].map((slot) => U.linkRoute(doing, todo, 10, slot).points[1][0]), [225, 223.5, 222]);
  assert.equal(U.linkRoute(todo, doing, 10, 2).points[1][0], 228);
  // every point is on a card edge or in the gap, and the path is made of right angles
  for (const [a, b] of [[doing, todo], [todo, doing], [below, todo], [review, doing]]) {
    const p = U.linkRoute(a, b, 10).points;
    for (let i = 1; i < p.length; i++) assert.ok(p[i][0] === p[i - 1][0] || p[i][1] === p[i - 1][1]);
  }
  assert.equal(U.roundedPath([[0, 0], [100, 0], [100, 100]], 7), 'M0 0 L93 0 Q100 0 100 7 L100 100');
});

test('progress meter: the share done (never rounded up to finished) and a segment per status that has cards', () => {
  const columns = (counts) => U.COLUMNS.map((c) => ({ ...c, count: counts[c.key] || 0 }));
  assert.deepEqual(U.progress(columns({ todo: 9, doing: 9, review: 4, needs_user: 2, done: 14 })), { total: 38, done: 14, percent: 36,
    segments: [{ key: 'done', label: '完成', count: 14 }, { key: 'review', label: '待验收', count: 4 }, { key: 'doing', label: '进行中', count: 9 }, { key: 'needs_user', label: '需要你', count: 2 }, { key: 'todo', label: '待办', count: 9 }] });
  assert.equal(U.progress(columns({ doing: 1, done: 199 })).percent, 99, '199 of 200 is not 100%');
  assert.equal(U.progress(columns({ done: 3 })).percent, 100);
  assert.deepEqual(U.progress(columns({})), { total: 0, done: 0, percent: 0, segments: [] });
  assert.deepEqual(U.progress(U.buildBoard([card('a'), card('b', { status: 'done' })]).columns).segments.map((s) => s.key), ['done', 'todo']);
});
