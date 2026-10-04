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

test('a review session links only to declared ids, regardless of mentioned titles or files', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('a', '实现登录接口'), col('b', '实现注册接口'), col('c', '无关的活'), col('c17000000009', '按 id 点名'), col('r', '代码审查', { reviews: ['a', 'b', 'c17000000009'] })],
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

test('prose never implies a review, and explicit targets omit self and missing ids', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('c17000000001', 'review 一下', { reviews: ['c17000000001', 'missing'] }), col('c17000000005', '后来的活')],
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
    columns: [col('c3001', '实现登录接口'), col('c3002', '实现注册接口'), col('c3003', '代码审查', { reviews: ['c3001', 'c3002'] })],
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
    columns: [col('c3003', '代码审查', { state: 'working', reviews: ['c3001'] })],
    archived: [{ id: 'c3001', title: '实现登录接口', captainCrew: true, archivedAt: 5 }, { id: 'c0001', title: '无关旧活', captainCrew: true, archivedAt: 1 }],
    tasks: [task('k0', 'c0001', 'done', 0), task('k1', 'c3001', 'done', 1, { receipt: { summary: 'ok', files: ['/demo/login.js'] } }), task('k3', 'c3003', 'working', 3)],
    prompts: { c3003: '请审查 /demo/login.js' },
  });
  assert.deepEqual(map.nodes.map((n) => `${n.id}:${n.archived}`), ['c3001:true', 'c3003:false']);
  assert.equal(map.hiddenArchived, 1);
});

test('projects stay side by side; states do not move workers into another group or layer', () => {
  const map = C.buildCrewMap({ captain, columns: [
    col('a', 'one', { project: 'A' }), col('b', 'two', { project: 'B', state: 'working' }),
    col('c', 'three', { project: 'A' }), col('d', 'unmarked'),
  ], tasks: [task('a', 'a', 'done', 1), task('b', 'b', 'working', 2), task('c', 'c', 'asking', 3), task('d', 'd', 'queued', 4)] });
  const lay = C.layout(map);
  assert.deepEqual(lay.groups.map((g) => g.name), ['A', 'B', '其他']);
  const a = lay.nodes.get('a'), c = lay.nodes.get('c'), b = lay.nodes.get('b');
  assert.equal(a.y, c.y);
  assert.ok(b.x > c.x + c.w);
  assert.ok(lay.captain.y < a.y);
  lay.groups.forEach((g) => g.nodes.filter((n) => lay.nodes.has(n.id)).forEach((n) => {
    const box = lay.nodes.get(n.id);
    assert.ok(box.x >= g.x && box.x + box.w <= g.x + g.w);
    assert.ok(box.y >= g.y + 48 && box.y + box.h <= g.y + g.h);
  }));
});

test('the review chain lays out top-down and its lines never share a stretch', () => {
  const map = reviewScenario();
  const lay = C.layout(map, { collapsedProjects: { '': false } });
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
    columns: ['c5001', 'c5002', 'c5003', 'c5004', 'c5005', 'c5006', 'c5007'].map((id, i) => col(id, '活 ' + id, { state: i === 2 ? 'working' : 'done', reviews: i === 5 ? ['c5004', 'c5005'] : [] })),
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
  const lay = C.applyPositions(C.layout(map, { collapsedProjects: { '': false } }), { c3003: { x: 900, y: 40 }, cap: { x: 5, y: 6 }, junk: { x: 'a' } }, 'cap');
  const box = lay.nodes.get('c3003');
  assert.deepEqual([box.x, box.y], [900, 40]);
  // A refresh/resize must not clamp an existing manual position.
  assert.equal(box.moved, true);
  assert.deepEqual([lay.captain.x, lay.captain.y], [5, 6]);
  const s = C.normalizeSaved({ projectPositions: {}, mode: 'canvas', positions: { a: { x: 1.4, y: 2 }, b: { x: NaN, y: 1 } }, view: { x: 1, y: 2, scale: 99 } });
  assert.deepEqual(s, { projectPositions: {}, mode: 'canvas', positions: { a: { x: 1, y: 2 } }, view: { x: 1, y: 2, scale: C.MAX_SCALE }, collapsedProjects: {}, showReturn: false });
  assert.deepEqual(C.normalizeSaved(null), { projectPositions: {}, mode: 'crew', positions: {}, view: null, collapsedProjects: {}, showReturn: false });
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


test('completed projects fold to a summary, including archived sessions; failed/stopped do not', () => {
  const map = C.buildCrewMap({ captain, columns: [col('b', 'bad', { project: '失败' }), col('s', 'stop', { project: '停下' })],
    archived: [{ id: 'a', title: 'old', captainCrew: true, project: '完成' }],
    tasks: [task('a', 'a', 'done', 1), task('b', 'b', 'failed', 2), task('s', 's', 'stopped', 3)] });
  const lay = C.layout(map);
  assert.equal(lay.groups.find((g) => g.key === '完成').collapsed, true);
  assert.equal(lay.nodes.has('a'), false);
  assert.equal(lay.nodes.has('b'), true);
  assert.equal(lay.nodes.has('s'), true);
  assert.equal(C.routes(map, lay).some((r) => r.from === 'a' || r.to === 'a'), false);
  assert.equal(C.layout(map, { collapsedProjects: { '完成': false } }).nodes.has('a'), true);
  const saved = C.normalizeSaved({ collapsedProjects: { '完成': false, '失败': true, junk: 'yes' } });
  assert.deepEqual(saved.collapsedProjects, { '完成': false, '失败': true });
});

test('waiting work carries project and declared reviews; session metadata survives task pruning', () => {
  const input = { captain, columns: [col('a', 'worker', { project: 'A', state: 'working' }), col('r', 'inspector', { project: 'A', reviews: ['a'] })],
    tasks: [task('q', '', 'waiting', 5, { title: '排队审查', project: 'B', reviews: ['a'] })] };
  const map = C.buildCrewMap(input);
  assert.deepEqual(map.projects.map((g) => g.key), ['A', 'B']);
  assert.deepEqual(map.edges.filter((e) => e.type === 'review').map((e) => `${e.from}>${e.to}`), ['a>r', 'a>wait:q']);
  const lay = C.layout(map);
  assert.ok(lay.nodes.get('r').y > lay.nodes.get('a').y);
  const changed = C.buildCrewMap({ ...input, columns: [col('a', 'worker', { project: 'C' }), input.columns[1]] });
  assert.notEqual(C.signature(map), C.signature(changed));
});

test('review-sounding titles and prompts alone create no review links', () => {
  const map = C.buildCrewMap({ captain, columns: [col('a', '登录接口'), col('r', '审查登录接口')], tasks: [], prompts: { r: 'review a 登录接口' } });
  assert.equal(map.nodes.find((n) => n.id === 'r').review, false);
  assert.deepEqual(map.edges.filter((e) => e.type === 'review'), []);
});

test('archived project summaries survive task pruning; declared user-opened targets remain visible', () => {
  const archivedMap = C.buildCrewMap({ captain, columns: [], tasks: [], archived: [
    { id: 'old', title: 'old', captainCrew: true, project: '完成', lastReceipt: { summary: '成功', explicit: true } },
  ] });
  assert.equal(archivedMap.projects[0].completed, true);
  assert.equal(C.layout(archivedMap).groups[0].collapsed, true);
  const failedMap = C.buildCrewMap({ captain, columns: [], tasks: [], showArchived: true, archived: [
    { id: 'failed', title: 'failed', captainCrew: true, project: '失败', lastReceipt: { failed: '检查失败', explicit: true } },
  ] });
  assert.equal(failedMap.projects[0].completed, false);
  assert.equal(failedMap.nodes[0].line, '失败：检查失败');
  assert.equal(failedMap.edges.find((e) => e.type === 'return').kind, 'failed');
  const map = C.buildCrewMap({ captain, columns: [col('manual', 'user', { captainCrew: false }), col('r', 'inspection', { reviews: ['manual'] })], tasks: [] });
  assert.deepEqual(map.edges.filter((e) => e.type === 'review'), [{ from: 'manual', to: 'r', type: 'review' }]);
});

test('multiple projects keep separate routes and reserve space for a busy return bus', () => {
  const columns = Array.from({ length: 15 }, (_, i) => col('w' + i, 'worker ' + i, { project: i < 8 ? 'A' : 'B' }));
  columns.push(col('r', 'review', { project: 'A', reviews: ['w0', 'w1', 'w2'] }));
  const map = C.buildCrewMap({ captain, columns, tasks: columns.map((c, i) => task('t' + i, c.id, 'done', i + 1, { receipt: { summary: 'ok', explicit: true } })) });
  const lay = C.layout(map, { collapsedProjects: { A: false, B: false } });
  const routes = C.routes(map, lay);
  assert.equal(noSharedStretch(routes), '');
  routes.forEach((r) => r.points.forEach(([x, y]) => assert.ok(x >= 0 && x <= lay.width && y >= 0 && y <= lay.height, `${r.type}: ${x},${y} outside canvas`)));
});

test('ten ungrouped sessions wrap into a contained grid without overlapping nodes', () => {
  const columns = Array.from({ length: 10 }, (_, i) => col('w' + i, 'worker', { state: 'working' }));
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  const lay = C.layout(map, { maxWidth: 1100, columnsPerProject: 4 });
  assert.equal(new Set([...lay.nodes.values()].map((b) => b.y)).size, 3);
  assert.ok(lay.width <= 1200);
  const boxes = [...lay.nodes.values()];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
  const g = lay.groups[0];
  boxes.forEach((b) => assert.ok(b.x >= g.x && b.y >= g.y + 48 && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h));
});

test('project wrapping uses the tallest previous shelf and moves cards with their own group', () => {
  const columns = [col('a', 'a', { project: 'A', state: 'working' }), col('r', 'r', { project: 'A', reviews: ['a'], state: 'working' }), col('b', 'b', { project: 'B', state: 'working' })];
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  const lay = C.layout(map, { maxWidth: 400 });
  const [a, b] = lay.groups;
  assert.ok(b.y > a.y + a.h);
  assert.ok(lay.nodes.get('b').y >= b.y + 48);
  const old = { ...lay.nodes.get('b') };
  C.translateProject(lay, 'B', 80, 30);
  assert.equal(lay.nodes.get('b').x, old.x + 80);
  assert.equal(lay.nodes.get('b').y, old.y + 30);
  assert.equal(lay.nodes.get('a').project, 'A');
  const saved = C.normalizeSaved({ projectPositions: { B: { x: 80, y: 30 }, bad: { x: NaN, y: 0 } } });
  assert.deepEqual(saved.projectPositions, { B: { x: 80, y: 30 } });
  const restored = C.applyPositions(C.layout(map, { maxWidth: 400 }), {}, 'cap', saved.projectPositions);
  assert.deepEqual(restored.nodes.get('b'), lay.nodes.get('b'));
});
