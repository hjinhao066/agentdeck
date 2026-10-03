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
  // only the finished one has sent something back
  assert.deepEqual(map.edges.filter((e) => e.type === 'return').map((e) => `${e.from}>${e.to}:${e.kind}`), ['b>cap:ok']);
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

// The typical chain: 队长 sends three sessions out, one reviews the other two,
// and its result comes back to 队长.
function reviewScenario(extra = {}) {
  return C.buildCrewMap({
    captain,
    columns: [col('c3001', '实现登录接口'), col('c3002', '实现注册接口'), col('c3003', '代码审查')],
    archived: [],
    tasks: [
      task('k1', 'c3001', 'done', 1, { receipt: { summary: 'ok', files: ['/demo/login.js'] } }),
      task('k2', 'c3002', 'done', 2, { receipt: { summary: 'ok', files: ['/demo/register.js'] } }),
      task('k3', 'c3003', 'done', 3, { receipt: { summary: '审查通过', files: [] } }),
    ],
    prompts: { c3003: '请审查 /demo/login.js 和 /demo/register.js' },
    ...extra,
  });
}

test('results flow back to 队长: a reviewed session through its review, a question or failure directly', () => {
  const map = reviewScenario();
  const by = (type) => map.edges.filter((e) => e.type === type).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(by('dispatch'), ['cap>c3001', 'cap>c3002', 'cap>c3003']);
  assert.deepEqual(by('review'), ['c3001>c3003', 'c3002>c3003']);
  assert.deepEqual(by('return'), ['c3003>cap']);
  const asking = reviewScenario({ tasks: [
    task('k1', 'c3001', 'asking', 1, { receipt: { question: '用哪个库？', files: [] } }),
    task('k2', 'c3002', 'done', 2, { receipt: { summary: 'ok', files: ['/demo/register.js'] } }),
    task('k3', 'c3003', 'working', 3),
  ], prompts: { c3003: '请审查 c3001 和 /demo/register.js' } });
  assert.deepEqual(asking.edges.filter((e) => e.type === 'return').map((e) => `${e.from}:${e.kind}`), ['c3001:question']);
});

test('an archived session a live review still links to stays on the map', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('c3003', '代码审查', { state: 'working' })],
    archived: [{ id: 'c3001', title: '实现登录接口', captainCrew: true, archivedAt: 5 }, { id: 'c0001', title: '无关旧活', captainCrew: true, archivedAt: 1 }],
    tasks: [task('k0', 'c0001', 'done', 0), task('k1', 'c3001', 'done', 1, { receipt: { summary: 'ok', files: ['/demo/login.js'] } }), task('k3', 'c3003', 'working', 3)],
    prompts: { c3003: '请审查 /demo/login.js' },
  });
  assert.deepEqual(map.nodes.map((n) => `${n.id}:${n.archived}`), ['c3001:true', 'c3003:false']);
  assert.equal(map.hiddenArchived, 1);
});

test('zones: waiting work left, work in progress next, finished work set apart on the right', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('c4001', '做完的'), col('c4002', '干活的', { state: 'working' }), col('c4003', '等回复的'), col('c4004', '排队的', { state: 'plain' })],
    archived: [],
    tasks: [task('a', 'c4001', 'done', 1), task('b', 'c4002', 'working', 2), task('c', 'c4003', 'asking', 3, { receipt: { question: '?' } }), task('d', 'c4004', 'queued', 4)],
  });
  const lay = C.layout(map, {});
  const x = (id) => lay.nodes.get(id).x;
  assert.ok(x('c4003') < x('c4002') && x('c4004') < x('c4002'));
  assert.ok(x('c4002') < x('c4001'));
  assert.deepEqual(['c4003', 'c4004', 'c4002', 'c4001'].map((id) => lay.nodes.get(id).zone), [0, 0, 1, 2]);
  // 队长 centers over the open work, not over the finished
  const cx = lay.captain.x + lay.captain.w / 2;
  assert.ok(cx < x('c4001'));
  assert.deepEqual(lay.openSpan, [x('c4003'), x('c4002') + lay.nodes.get('c4002').w]);
});

test('the review chain lays out top-down and its lines never share a stretch', () => {
  const map = reviewScenario();
  const lay = C.layout(map, {});
  const r = lay.nodes.get('c3003'), a = lay.nodes.get('c3001'), b = lay.nodes.get('c3002');
  assert.ok(r.y > a.y && a.y === b.y && lay.captain.y < a.y);
  assert.equal(r.x + r.w / 2, (a.x + a.w / 2 + b.x + b.w / 2) / 2);
  const routes = C.routes(map, lay, {});
  const end = (t, to) => routes.find((x) => x.type === t && x.to === to).points.slice(-1)[0];
  // out enters the review session from the left; back enters 队长 from the right
  assert.ok(end('dispatch', 'c3003')[0] < r.x + 1);
  assert.ok(end('return', 'cap')[0] > lay.captain.x + lay.captain.w);
  assert.equal(noSharedStretch(routes), '');
});

test('a busier map: no two lines run on top of each other', () => {
  const map = C.buildCrewMap({
    captain,
    columns: ['c5001', 'c5002', 'c5003', 'c5004', 'c5005', 'c5006', 'c5007'].map((id, i) => col(id, '活 ' + id, { state: i === 2 ? 'working' : 'done' })),
    archived: [],
    tasks: [
      task('a', 'c5001', 'asking', 1, { receipt: { question: '?' } }), task('b', 'c5002', 'queued', 2),
      task('c', 'c5003', 'working', 3), task('d', 'c5004', 'done', 4, { receipt: { summary: 'ok', files: ['/x/one.js'] } }),
      task('e', 'c5005', 'done', 5, { receipt: { summary: 'ok', files: ['/x/two.js'] } }), task('f', 'c5006', 'working', 6),
      task('g', 'c5007', 'failed', 7, { receipt: { failed: 'no' } }),
    ],
    prompts: { c5006: 'review /x/one.js and /x/two.js' },
  });
  const routes = C.routes(map, C.layout(map, { fold: true }), {});
  assert.ok(routes.filter((r) => r.type === 'return').length >= 2);
  assert.equal(noSharedStretch(routes), '');
  // the check itself is real: with no spacing between lanes the returns collide
  assert.notEqual(noSharedStretch(C.routes(map, C.layout(map, { fold: true }), { lane: 0 })), '');
});

test('saved positions win over the layout; saved state is checked on load', () => {
  const map = reviewScenario();
  const lay = C.applyPositions(C.layout(map, {}), { c3003: { x: 900, y: 40 }, cap: { x: 5, y: 6 }, junk: { x: 'a' } }, 'cap');
  assert.deepEqual([lay.nodes.get('c3003').x, lay.nodes.get('c3003').y], [900, 40]);
  assert.deepEqual([lay.captain.x, lay.captain.y], [5, 6]);
  const s = C.normalizeSaved({ mode: 'canvas', positions: { a: { x: 1.4, y: 2 }, b: { x: NaN, y: 1 } }, view: { x: 1, y: 2, scale: 99 } });
  assert.deepEqual(s, { mode: 'canvas', positions: { a: { x: 1, y: 2 } }, view: { x: 1, y: 2, scale: C.MAX_SCALE } });
  assert.deepEqual(C.normalizeSaved(null), { mode: 'crew', positions: {}, view: null });
});

// '' when no straight stretch of one line lies on a stretch of another line
// (same direction, same coordinate within 2px, overlapping by more than 2px).
function noSharedStretch(routes) {
  const segs = [];
  routes.forEach((r, i) => r.points.forEach((p, k) => {
    if (!k) return;
    const [x1, y1] = r.points[k - 1], [x2, y2] = p;
    if (Math.abs(x1 - x2) < 0.5) segs.push({ i, v: true, c: x1, a: Math.min(y1, y2), b: Math.max(y1, y2), r });
    else if (Math.abs(y1 - y2) < 0.5) segs.push({ i, v: false, c: y1, a: Math.min(x1, x2), b: Math.max(x1, x2), r });
  }));
  for (const s of segs) for (const t of segs) {
    if (s.i >= t.i || s.v !== t.v || Math.abs(s.c - t.c) > 2) continue;
    // lines leaving the same port share their first few pixels by design
    if (Math.min(s.b, t.b) - Math.max(s.a, t.a) > 2) return `${s.r.type} ${s.r.from}>${s.r.to} overlaps ${t.r.type} ${t.r.from}>${t.r.to}`;
  }
  return '';
}
