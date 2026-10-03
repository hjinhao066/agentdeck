'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../crew-map-core');

const captain = { id: 'cap', title: '队长', alive: true, state: 'done', provider: 'Claude', model: 'Opus 5.5' };
const col = (id, title, extra) => ({ id, title, alive: true, state: 'done', live: '', provider: 'Cursor', model: 'Opus 5.5', lastReceipt: null, captainCrew: true, ...extra });
const task = (id, colId, status, sentAt, extra) => ({ id, colId, title: id, status, sentAt, receipt: null, ...extra });

test('task and terminal states map onto the five map states', () => {
  assert.equal(C.nodeStatus(task('a', 'x', 'working'), { alive: true, state: 'done' }).status, 'working');
  assert.deepEqual(C.nodeStatus(task('a', 'x', 'asking'), { alive: true, state: 'done' }), { status: 'input', detail: '在问队长' });
  assert.deepEqual(C.nodeStatus(task('a', '', 'waiting'), null), { status: 'queued', detail: '等空位' });
  assert.equal(C.nodeStatus(task('a', 'x', 'queued'), { alive: true, state: 'plain' }).status, 'queued');
  assert.equal(C.nodeStatus(task('a', 'x', 'done'), { alive: true, state: 'done' }).status, 'done');
  assert.equal(C.nodeStatus(task('a', 'x', 'failed'), null).status, 'failed');
  // the live terminal wins over a finished task: someone typed into it again
  assert.equal(C.nodeStatus(task('a', 'x', 'done'), { alive: true, state: 'working' }).status, 'working');
  assert.equal(C.nodeStatus(task('a', 'x', 'done'), { alive: true, state: 'input' }).status, 'input');
});

test('receipt line: question, then failure, then summary, then the column ledger receipt', () => {
  assert.equal(C.receiptLine({ receipt: { question: '用哪个库？', summary: 'x' } }), '提问：用哪个库？');
  assert.equal(C.receiptLine({ receipt: { failed: '没权限', summary: 'x' } }), '失败：没权限');
  assert.equal(C.receiptLine({ receipt: { summary: '  修好了\n登录  ' } }), '修好了 登录');
  assert.equal(C.receiptLine(null, { summary: '旧回执' }), '旧回执');
  assert.ok(C.receiptLine({ receipt: { summary: 'x'.repeat(500) } }).length <= 140);
});

test('the map follows the ledger: one line from 队长 to each session it handed work to', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('a', '改登录', { state: 'working', live: 'Editing login.js' }), col('b', '写文档'), col('manual', '我自己的', { captainCrew: false })],
    archived: [],
    tasks: [task('t1', 'a', 'working', 1), task('t2', 'b', 'done', 2, { receipt: { summary: '文档写好了', files: [] } }), task('t3', '', 'waiting', 3, { title: '等位的活' })],
  });
  assert.deepEqual(map.nodes.map((n) => n.id), ['a', 'b', 'wait:t3']);
  assert.deepEqual(map.edges.filter((e) => e.type === 'dispatch').map((e) => e.to), ['a', 'b', 'wait:t3']);
  assert.ok(map.edges.every((e) => e.type !== 'dispatch' || e.from === 'cap'));
  const a = map.nodes[0];
  assert.equal(a.status, 'working');
  assert.equal(a.live, 'Editing login.js');
  assert.equal(map.nodes[1].line, '文档写好了');
  assert.equal(map.nodes[2].kind, 'waiting');
  assert.equal(map.captain.line, '1 干活中 · 1 排队 · 1 已完成');
});

test('archived sessions fold away by default and come back faded on request', () => {
  const input = {
    captain,
    columns: [col('a', '活的')],
    archived: [{ id: 'old', title: '旧活', captainCrew: true, archivedAt: 5, lastReceipt: { summary: '早做完了' } }],
    tasks: [task('t0', 'old', 'done', 1), task('t1', 'a', 'working', 2)],
  };
  const folded = C.buildCrewMap(input);
  assert.deepEqual(folded.nodes.map((n) => n.id), ['a']);
  assert.equal(folded.hiddenArchived, 1);
  const open = C.buildCrewMap({ ...input, showArchived: true });
  assert.deepEqual(open.nodes.map((n) => n.id), ['old', 'a']);
  assert.equal(open.nodes[0].archived, true);
  assert.equal(open.hiddenArchived, 0);
  assert.equal(open.archivedCount, 1);
  // closed for good (neither live nor archived): not drawn
  const gone = C.buildCrewMap({ ...input, tasks: [...input.tasks, task('t9', 'deleted', 'done', 3)] });
  assert.ok(!gone.nodes.some((n) => n.id === 'deleted'));
});

test('a review session links to the sessions its work names, by id, title or receipt file', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('a', '实现登录接口'), col('b', '实现注册接口'), col('c', '无关的活'), col('c17000000009', '按 id 点名'), col('r', '代码审查')],
    archived: [],
    tasks: [
      task('t1', 'a', 'done', 1, { receipt: { summary: 'ok', files: ['/repo/src/login.js'] } }),
      task('t2', 'b', 'done', 2, { receipt: { summary: 'ok', files: [] } }),
      task('t3', 'c', 'done', 3),
      task('t3b', 'c17000000009', 'done', 3),
      task('t4', 'r', 'working', 4),
    ],
    prompts: { r: '请审查 /repo/src/login.js 和「实现注册接口」的产出，再看看 c17000000009 的结果', c: '与 a 无关' },
  });
  const reviews = map.edges.filter((e) => e.type === 'review');
  assert.deepEqual(reviews.map((e) => `${e.from}>${e.to}`).sort(), ['a>r', 'b>r', 'c17000000009>r']);
  assert.equal(map.nodes.find((n) => n.id === 'r').review, true);
  assert.equal(map.nodes.find((n) => n.id === 'c').review, false);
  // the layout puts the reviewer one row below, centered under what it reviews
  const lay = C.layout(map, {});
  const r = lay.nodes.get('r'), a = lay.nodes.get('a'), b = lay.nodes.get('b');
  assert.ok(r.y > a.y);
  const n = lay.nodes.get('c17000000009');
  assert.equal(r.x + r.w / 2, (a.x + a.w / 2 + n.x + n.w / 2) / 2);
  assert.ok(b.y === a.y);
  assert.equal(lay.rows, 2);
  assert.ok(lay.captain.y < a.y);
});

test('review detection ignores later sessions and a session never reviews itself', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('c17000000001', 'review 一下'), col('c17000000005', '后来的活')],
    archived: [],
    tasks: [task('t1', 'c17000000001', 'working', 1), task('t2', 'c17000000005', 'working', 5)],
    prompts: { r: 'review c17000000005 and c17000000001' },
  });
  assert.deepEqual(map.edges.filter((e) => e.type === 'review'), []);
  assert.equal(map.nodes.find((n) => n.id === 'c17000000001').review, true);
});

test('signature changes on state or receipt, not on the live activity line', () => {
  const base = { captain, columns: [col('a', 'x', { state: 'working', live: 'one' })], archived: [], tasks: [task('t1', 'a', 'working', 1)] };
  const s1 = C.signature(C.buildCrewMap(base));
  const s2 = C.signature(C.buildCrewMap({ ...base, columns: [col('a', 'x', { state: 'working', live: 'two' })] }));
  assert.equal(s1, s2);
  const s3 = C.signature(C.buildCrewMap({ ...base, tasks: [task('t1', 'a', 'done', 1, { receipt: { summary: 'done' } })], columns: [col('a', 'x')] }));
  assert.notEqual(s1, s3);
});

test('no 队长: nothing to draw', () => {
  const map = C.buildCrewMap({ captain: null, columns: [col('a', 'x')], archived: [], tasks: [] });
  assert.equal(map.captain, null);
});

test('many sessions wrap onto a shared grid; the archived pill takes the next slot', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const map = C.buildCrewMap({
    captain, columns: ids.map((id) => col(id, '活 ' + id)), archived: [],
    tasks: ids.map((id, i) => task('t' + id, id, 'working', i + 1)),
  });
  const lay = C.layout(map, { perRow: 3, fold: true });
  assert.deepEqual(ids.map((id) => lay.nodes.get(id).row), [1, 1, 1, 2, 2]);
  assert.equal(lay.nodes.get('d').x, lay.nodes.get('a').x);
  assert.deepEqual([lay.fold.row, lay.fold.x], [2, lay.nodes.get('c').x]);
  assert.equal(lay.gaps.length, 4);
  // the gaps lie between grid columns, clear of every card
  lay.nodes.forEach((p) => lay.gaps.forEach((g) => assert.ok(g < p.x || g > p.x + p.w)));
});
