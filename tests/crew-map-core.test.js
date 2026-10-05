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
    showArchived: true,   // all of them are done: only the archive view still lists such a project
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
  assert.deepEqual(s, { projectPositions: {}, mode: 'canvas', positions: { a: { x: 1, y: 2 } }, view: { x: 1, y: 2, scale: C.MAX_SCALE }, collapsedProjects: {}, showReturn: false, projectOrder: [], plan: null });
  assert.deepEqual(C.normalizeSaved(null), { projectPositions: {}, mode: 'crew', positions: {}, view: null, collapsedProjects: {}, showReturn: false, projectOrder: [], plan: null });
  // the user's project order and the arrangement their hand-placed map stands on are kept, checked
  const kept = C.normalizeSaved({ projectOrder: ['B', 'A', 'B', 7, 'x'.repeat(200)], plan: { lanes: [['A'], ['B', 'C']], caps: { A: 3, B: 2, C: 2.5, D: 99 }, tight: 1, junk: true } });
  assert.deepEqual(kept.projectOrder, ['B', 'A']);
  assert.deepEqual(kept.plan, { lanes: [['A'], ['B', 'C']], caps: { A: 3, B: 2 }, tight: true });
  assert.equal(C.normalizeSaved({ plan: { lanes: 'A' } }).plan, null);
  assert.equal(C.normalizeSaved({ plan: { lanes: [['A', 5]] } }).plan, null);
});

const onSpine = (s) => (s.v ? Math.abs(s.c - s.r.hub[0]) < 0.5 && s.b <= s.r.hub[1] + 0.5 : Math.abs(s.c - s.r.hub[1]) < 0.5);
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
    // dispatch lines are one bundled tree: they share the trunk and main bus,
    // and lines into one project share that project's bus; nothing else
    if (s.r.type === 'dispatch' && t.r.type === 'dispatch' && (s.r.project === t.r.project || onSpine(s) || onSpine(t))) continue;
    // lines leaving the same port share their first few pixels by design
    if (Math.min(s.b, t.b) - Math.max(s.a, t.a) > 2) return `${s.r.type} ${s.r.from}>${s.r.to} overlaps ${t.r.type} ${t.r.from}>${t.r.to}`;
  }
  return '';
}


test('a project with nothing left to do leaves the map; failed or stopped ones stay', () => {
  const input = { captain, columns: [col('b', 'bad', { project: '失败' }), col('s', 'stop', { project: '停下' }), col('d', 'fin', { project: '做完' })],
    archived: [{ id: 'a', title: 'old', captainCrew: true, project: '完成' }],
    tasks: [task('a', 'a', 'done', 1), task('b', 'b', 'failed', 2), task('s', 's', 'stopped', 3), task('d', 'd', 'done', 4)] };
  const map = C.buildCrewMap(input);
  assert.deepEqual(map.projects.map((g) => g.key), ['失败', '停下']);
  assert.deepEqual(map.nodes.map((n) => n.id), ['b', 's']);
  assert.deepEqual(map.edges.filter((e) => e.type === 'dispatch').map((e) => e.to), ['b', 's']);
  const lay = C.layout(map);
  assert.equal(lay.nodes.has('d') || lay.nodes.has('a'), false);
  assert.equal(C.routes(map, lay).some((r) => r.from === 'd' || r.to === 'd'), false);
  assert.equal(map.captain.line, '1 失败 · 1 已停下', 'the top box counts what is on the map');
  // the archive view still lists every project
  assert.deepEqual(C.buildCrewMap({ ...input, showArchived: true }).projects.map((g) => g.key).sort(), ['停下', '做完', '失败', '完成'].sort());
  // a new session in a finished project brings its box back
  const back = C.buildCrewMap({ ...input, tasks: [...input.tasks, task('n', 'd', 'working', 5)] });
  assert.deepEqual(back.projects.map((g) => g.key), ['失败', '停下', '做完']);
  // an archived session does not keep a project on the map; a queued or waiting one does
  const waiting = C.buildCrewMap({ captain, columns: [], tasks: [task('q', '', 'waiting', 1, { project: '排队' })] });
  assert.deepEqual(waiting.projects.map((g) => g.key), ['排队']);
  const saved = C.normalizeSaved({ collapsedProjects: { '完成': false, '失败': true, junk: 'yes' } });
  assert.deepEqual(saved.collapsedProjects, { '完成': false, '失败': true });
});

test('project names are grouped without regard to case, shown as the earliest session spelled it', () => {
  const map = C.buildCrewMap({ captain, columns: [col('a', 'one', { project: 'agentdeck', state: 'working' }), col('b', 'two', { project: 'AgentDeck', state: 'working' }), col('c', 'three', { project: 'AGENTDECK' }), col('d', 'other', { project: 'Hermes', state: 'working' })],
    tasks: [task('t1', 'b', 'working', 1), task('t2', 'a', 'working', 2), task('t3', 'c', 'done', 3), task('t4', 'd', 'working', 5)] });
  assert.deepEqual(map.projects.map((g) => [g.key, g.nodes.length]), [['AgentDeck', 3], ['Hermes', 1]]);
  assert.ok(map.nodes.filter((n) => n.project === 'AgentDeck').length === 3);
  assert.deepEqual(map.projects[0].counts, { working: 2, done: 1 });
  assert.equal(C.layout(map).groups.length, 2);
  // different names stay different, and an empty name is its own project
  const other = C.buildCrewMap({ captain, columns: [col('a', 'x', { project: 'agentdeck', state: 'working' }), col('b', 'y', { project: 'agentdeck2', state: 'working' }), col('c', 'z', { project: '', state: 'working' })], tasks: [] });
  assert.equal(other.projects.length, 3);
  // the input is never rewritten
  const column = col('e', 'e', { project: 'Late', state: 'working' });
  C.buildCrewMap({ captain, columns: [col('f', 'f', { project: 'late', state: 'working' }), column], tasks: [task('x', 'f', 'working', 9), task('y', 'e', 'working', 1)] });
  assert.equal(column.project, 'Late');
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
  const map = C.buildCrewMap({ captain, columns: [col('a', '登录接口'), col('r', '审查登录接口')], tasks: [], showArchived: true, prompts: { r: 'review a 登录接口' } });
  assert.equal(map.nodes.find((n) => n.id === 'r').review, false);
  assert.deepEqual(map.edges.filter((e) => e.type === 'review'), []);
});

test('archived project summaries survive task pruning; declared user-opened targets remain visible', () => {
  const archivedMap = C.buildCrewMap({ captain, columns: [], tasks: [], archived: [
    { id: 'old', title: 'old', captainCrew: true, project: '完成', lastReceipt: { summary: '成功', explicit: true } },
  ] });
  assert.deepEqual(archivedMap.projects, [], 'a finished, archived project is not on the map');
  assert.equal(archivedMap.archivedCount, 1);
  const withArchive = C.buildCrewMap({ captain, columns: [], tasks: [], showArchived: true, archived: [{ id: 'old', title: 'old', captainCrew: true, project: '完成', lastReceipt: { summary: '成功', explicit: true } }] });
  assert.equal(withArchive.projects[0].completed, true);
  assert.equal(C.layout(withArchive).groups[0].collapsed, true);
  const failedMap = C.buildCrewMap({ captain, columns: [], tasks: [], showArchived: true, archived: [
    { id: 'failed', title: 'failed', captainCrew: true, project: '失败', lastReceipt: { failed: '检查失败', explicit: true } },
  ] });
  assert.equal(failedMap.projects[0].completed, false);
  assert.equal(failedMap.nodes[0].line, '失败：检查失败');
  assert.equal(failedMap.edges.find((e) => e.type === 'return').kind, 'failed');
  const map = C.buildCrewMap({ captain, columns: [col('manual', 'user', { captainCrew: false }), col('r', 'inspection', { reviews: ['manual'], state: 'working' })], tasks: [] });
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
  const lay = C.layout(map, { columnsPerProject: 4 });
  assert.equal(new Set([...lay.nodes.values()].map((b) => b.y)).size, 3);
  assert.ok(lay.width <= 1200);
  const boxes = [...lay.nodes.values()];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
  const g = lay.groups[0];
  boxes.forEach((b) => assert.ok(b.x >= g.x && b.y >= g.y + 48 && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h));
});

test('frames in one lane stand one under another, and a frame moves its own cards with it', () => {
  const columns = [col('a', 'a', { project: 'A', state: 'working' }), col('r', 'r', { project: 'A', reviews: ['a'], state: 'working' }), col('b', 'b', { project: 'B', state: 'working' })];
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  // with nothing said, every project has a lane of its own
  const apart = C.layout(map);
  assert.equal(apart.groups[0].y, apart.groups[1].y);
  assert.ok(apart.groups[1].x >= apart.groups[0].x + apart.groups[0].w + 52);
  assert.deepEqual(apart.groups.map((g) => g.lane), [0, 1]);
  const lay = C.layout(map, { lanes: [['A', 'B']] });
  const [a, b] = lay.groups;
  assert.equal(b.y, a.y + a.h + 52, 'B sits under A, one gap below');
  assert.equal(b.x, a.x);
  assert.ok(lay.nodes.get('b').y >= b.y + 48);
  const old = { ...lay.nodes.get('b') };
  C.translateProject(lay, 'B', 80, 30);
  assert.equal(lay.nodes.get('b').x, old.x + 80);
  assert.equal(lay.nodes.get('b').y, old.y + 30);
  assert.equal(lay.nodes.get('a').project, 'A');
  const saved = C.normalizeSaved({ projectPositions: { B: { x: 80, y: 30 }, bad: { x: NaN, y: 0 } } });
  assert.deepEqual(saved.projectPositions, { B: { x: 80, y: 30 } });
  const restored = C.applyPositions(C.layout(map, { lanes: [['A', 'B']] }), {}, 'cap', saved.projectPositions);
  assert.deepEqual(restored.nodes.get('b'), lay.nodes.get('b'));
  // a lane names a project once; a project no lane names, or one named twice, still gets exactly one frame
  assert.deepEqual(C.layout(map, { lanes: [['B', 'B', 'nope'], ['B']] }).groups.map((g) => [g.key, g.lane]), [['B', 0], ['A', 1]]);
  // caps: how many cards wide each project's frame is
  const wide = C.buildCrewMap({ captain, columns: Array.from({ length: 6 }, (_, i) => col('w' + i, 'w', { project: i < 5 ? 'A' : 'B', state: 'working' })), tasks: [] });
  const capped = C.layout(wide, { grid: true, lanes: [['A'], ['B']], caps: { A: 2 } });
  assert.equal(new Set([...capped.nodes.values()].filter((n) => n.project === 'A').map((n) => n.x)).size, 2);
  assert.equal(new Set([...capped.nodes.values()].filter((n) => n.project === 'A').map((n) => n.y)).size, 3);
});

// no dispatch line enters a project frame other than its own
function staysOutOfOtherFrames(dispatch, lay) {
  dispatch.forEach((r) => r.points.slice(1).forEach(([x2, y2], k) => {
    const [x1, y1] = r.points[k];
    lay.groups.filter((g) => g.key !== r.project).forEach((g) => assert.ok(
      !(Math.max(x1, x2) > g.x + 1 && Math.min(x1, x2) < g.x + g.w - 1 && Math.max(y1, y2) > g.y + 1 && Math.min(y1, y2) < g.y + g.h - 1),
      `${r.to} crosses ${g.key}`));
  }));
}

test('dispatch is one bundled tree: one port, a bus per project, a frame below another is reached down the gap beside its lane', () => {
  const spec = { A: 4, B: 1, C: 1, D: 2 };
  const columns = Object.entries(spec).flatMap(([p, n]) => Array.from({ length: n }, (_, i) => col(p + i, p + ' ' + i, { project: p, state: i ? 'done' : 'working' })));
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  const dims = { nodeW: 240, nodeH: 176, captainW: 340, captainH: 140, gapX: 24, clusterGap: 52, fanY: 64, gapY: 64 };
  // A alone in the first lane; B, C and D one under another in the second
  const lay = C.layout(map, { ...dims, lanes: [['A'], ['B', 'C', 'D']], caps: { A: 4, B: 2, C: 2, D: 2 } });
  const [a, bb, c, d] = lay.groups;
  assert.ok(bb.x > a.x + a.w && c.y > bb.y + bb.h && d.y > c.y + c.h && c.x === bb.x && d.x === bb.x);
  // the lines to C and D come down the gap between the lanes, D's (the lower) farther from its own lane, and turn in above their frames
  assert.deepEqual([...lay.feeds.keys()].sort(), ['C', 'D']);
  const gapLeft = a.x + a.w, gapRight = bb.x;
  for (const key of ['C', 'D']) assert.ok(lay.feeds.get(key).x > gapLeft + 8 && lay.feeds.get(key).x < gapRight - 8, key + ' runs inside the gap');
  assert.ok(lay.feeds.get('D').x < lay.feeds.get('C').x);
  assert.equal(lay.feeds.get('C').y, c.y - 26);
  assert.equal(lay.feeds.get('D').y, d.y - 26);
  const routes = C.routes(map, lay, { clusterGap: 52 });
  const dispatch = routes.filter((r) => r.type === 'dispatch');
  assert.equal(new Set(dispatch.map((r) => r.points[0].join())).size, 1);
  assert.deepEqual(dispatch[0].points[0], [lay.captain.x + lay.captain.w / 2, lay.captain.y + lay.captain.h]);
  // one feeder per project, the planned one for the frames below
  ['A', 'B', 'C', 'D'].forEach((p) => assert.equal(new Set(dispatch.filter((r) => r.project === p).map((r) => r.feederX)).size, 1));
  assert.equal(dispatch.find((r) => r.project === 'D').feederX, lay.feeds.get('D').x);
  staysOutOfOtherFrames(dispatch, lay);
  assert.equal(noSharedStretch(routes), '');
  // the branch drawn per line ends where the full line ends
  dispatch.forEach((r) => assert.deepEqual(r.branch.at(-1), r.points.at(-1)));
  const s = C.spine(routes);
  assert.deepEqual(s.trunk, [dispatch[0].points[0], s.hub]);
  assert.equal(s.active, true);
  const xs = dispatch.map((r) => r.feederX);
  if (Math.min(...xs) < s.hub[0]) assert.equal(s.left.points[1][0], Math.min(...xs));
  if (Math.max(...xs) > s.hub[0]) assert.equal(s.right.points[1][0], Math.max(...xs));
  assert.equal(C.spine([]), null);
  // a frame dragged by hand has no planned line any more: the lines find their own way round, still outside other frames
  C.translateProject(lay, 'D', -300, 40);
  assert.equal(lay.feeds.size, 0);
  staysOutOfOtherFrames(C.routes(map, lay, { clusterGap: 52 }).filter((r) => r.type === 'dispatch'), lay);
});

test('lanes on both sides of a gap share it without a line crossing or riding another; one lane alone uses its outer edge', () => {
  const spec = { A: 2, B: 1, C: 3, D: 1, E: 2, F: 1, G: 1 };
  const columns = Object.entries(spec).flatMap(([p, n]) => Array.from({ length: n }, (_, i) => col(p + i, p + ' ' + i, { project: p, state: 'working' })));
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  for (const lanes of [[['A', 'B', 'C'], ['D', 'E', 'F', 'G']], [['A', 'B'], ['C', 'D'], ['E', 'F', 'G']], [['A', 'B', 'C', 'D', 'E', 'F', 'G']], [['A'], ['B'], ['C', 'D', 'E'], ['F', 'G']]]) {
    const lay = C.layout(map, { ...A_GRID, lanes, caps: { C: 2, E: 2 } });
    const below = lanes.reduce((n, l) => n + l.length - 1, 0);
    assert.equal(lay.feeds.size, below, JSON.stringify(lanes));
    // no two frames overlap, and frames of a lane share its left edge
    lay.groups.forEach((g, i) => lay.groups.slice(i + 1).forEach((h) => assert.ok(g.x + g.w <= h.x || h.x + h.w <= g.x || g.y + g.h <= h.y || h.y + h.h <= g.y)));
    lanes.forEach((keys) => assert.equal(new Set(keys.map((key) => lay.groups.find((g) => g.key === key).x)).size, 1));
    // every planned line keeps 8px or more from every frame, and no two share an x
    const xs = [...lay.feeds.values()].map((f) => f.x);
    assert.equal(new Set(xs).size, xs.length);
    xs.forEach((x) => lay.groups.forEach((g) => assert.ok(x <= g.x - 8 || x >= g.x + g.w + 8, `${x} too close to ${g.key}`)));
    const routes = C.routes(map, lay, { clusterGap: A_GRID.clusterGap, gapX: A_GRID.gapX });
    const dispatch = routes.filter((r) => r.type === 'dispatch');
    staysOutOfOtherFrames(dispatch, lay);
    assert.equal(noSharedStretch(routes), '');
    // no feeder's drop crosses another project's bus (the stretch running along the top of a frame)
    const feeder = (p) => dispatch.find((r) => r.project === p);
    lay.feeds.forEach((f, key) => lay.feeds.forEach((other, otherKey) => {
      if (key === otherKey || other.y <= f.y) return;   // `other` belongs to a frame lower down: its drop passes f's turn
      const bus = feeder(key).points.filter(([, y]) => Math.abs(y - f.y) < 0.5).map(([x]) => x);
      assert.ok(!(other.x > Math.min(...bus) + 0.5 && other.x < Math.max(...bus) - 0.5), `${otherKey}'s line crosses ${key}'s bus`);
    }));
    routes.forEach((r) => r.points.forEach(([x, y]) => assert.ok(x >= 0 && x <= lay.width && y >= 0 && y <= lay.height, `${r.type}: ${x},${y} outside canvas`)));
  }
});

test('tidy drops repeats and straight-run midpoints only', () => {
  assert.deepEqual(C.tidy([[0, 0], [0, 0], [0, 5], [0, 10], [4, 10], [4, 10]]), [[0, 0], [0, 10], [4, 10]]);
});

// ---- A 版: tray, reopen on activity, fit, grid layout ----
const A_GRID = { nodeW: 296, nodeH: 172, captainW: 420, captainH: 104, gapX: 24, clusterGap: 52, fanY: 64, gapY: 20, pad: 32, padX: 24, padBottom: 20, rowGap: 20, reviewGap: 52, grid: true, center: true, tray: true };
function trayMap() {
  const columns = [
    ...Array.from({ length: 7 }, (_, i) => col('a' + i, 'agentdeck ' + i, { project: 'agentdeck', state: 'working' })),
    col('t0', '豆包', { project: 'type4me-windows' }), col('m0', '地图', { project: 'ai-unified-map' }),
    col('h0', '复核', { project: 'hermes-quality' }), col('h1', '日报', { project: 'hermes-quality' }), col('o0', '封装', { project: 'opencli' }),
  ];
  const tasks = [
    ...Array.from({ length: 7 }, (_, i) => task('ta' + i, 'a' + i, 'working', i)),
    task('tt', 't0', 'done', 10, { receipt: { summary: 'ok' } }), task('tm', 'm0', 'done', 11, { receipt: { summary: 'ok' } }),
    task('th0', 'h0', 'done', 12, { receipt: { summary: 'ok' } }), task('th1', 'h1', 'failed', 13, { receipt: { failed: 'no' } }), task('to', 'o0', 'done', 14, { receipt: { summary: 'ok' } }),
  ];
  return C.buildCrewMap({ captain, columns, tasks });
}

test('a project with nothing working, waiting on an answer or queued is inactive and goes to the tray with real counts', () => {
  const map = trayMap();
  assert.deepEqual(map.projects.filter((p) => p.inactive).map((p) => p.key).sort(), ['hermes-quality'], 'finished projects are not on the map at all');
  assert.deepEqual(map.projects.map((p) => p.key).sort(), ['agentdeck', 'hermes-quality']);
  assert.equal(map.projects.find((p) => p.key === 'agentdeck').inactive, false);
  const tray = C.trayProjects(map, {});
  assert.deepEqual(tray.map((p) => [p.key, p.failed, p.expanded]), [['hermes-quality', 1, false]]);
  assert.equal(C.traySummary(tray), '1 个项目（1 个失败）');
  assert.equal(C.traySummary([]), '0 个项目');
  // a user-opened project stays listed (chip pressed), a user-folded active project is not a tray project
  const opened = C.trayProjects(map, { 'hermes-quality': false });
  assert.equal(opened.find((p) => p.key === 'hermes-quality').expanded, true);
  assert.deepEqual(C.trayProjects(map, { agentdeck: true }).map((p) => p.key), tray.map((p) => p.key));
  assert.equal(C.isCollapsed({ key: 'x', inactive: true, completed: false }, {}, true), true);
  assert.equal(C.isCollapsed({ key: 'x', inactive: false, completed: false }, {}, true), false);
  assert.equal(C.isCollapsed({ key: 'x', inactive: true, completed: true }, { x: false }, true), false);
});

test('tray layout: only active projects (and the ones the user opened) take canvas room', () => {
  const map = trayMap();
  const lay = C.layout(map, { ...A_GRID, collapsedProjects: {}, columnsPerProject: 3 });
  assert.deepEqual(lay.groups.map((g) => g.key), ['agentdeck']);
  assert.equal(lay.nodes.size, 7);
  const opened = C.layout(map, { ...A_GRID, collapsedProjects: { 'hermes-quality': false }, columnsPerProject: 3 });
  assert.deepEqual(opened.groups.map((g) => g.key).sort(), ['agentdeck', 'hermes-quality']);
  assert.ok(opened.nodes.has('h0') && opened.nodes.has('h1') && !opened.nodes.has('t0'));
  // an active project the user folded stays a one-row group on the canvas, not in the tray
  const folded = C.layout(map, { ...A_GRID, collapsedProjects: { agentdeck: true }, columnsPerProject: 3 });
  assert.equal(folded.groups[0].collapsed, true);
  assert.equal(folded.nodes.size, 0);
});

test('grid layout: 3 columns on a wide window, rows share the column grid, groups centred under 队长', () => {
  const map = trayMap();
  const lay = C.layout(map, { ...A_GRID, collapsedProjects: {}, columnsPerProject: 3 });
  const xs = [...lay.nodes.values()].map((b) => b.x);
  assert.equal(new Set(xs).size, 3);
  const rows = new Set([...lay.nodes.values()].map((b) => b.y));
  assert.equal(rows.size, 3);                       // 3 + 3 + 1
  const [g] = lay.groups;
  assert.equal(Math.min(...xs), g.x + A_GRID.padX);  // left-aligned to the grid, not centred per row
  assert.ok(Math.abs(g.x + g.w / 2 - (lay.captain.x + lay.captain.w / 2)) <= 1, 'group centred under 队长');
  // no overlap, every card inside its group
  const boxes = [...lay.nodes.values()];
  boxes.forEach((a, i) => {
    assert.ok(a.x >= g.x && a.x + a.w <= g.x + g.w && a.y >= g.y && a.y + a.h <= g.y + g.h);
    boxes.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
  });
  // 2 and 1 columns
  assert.equal(new Set([...C.layout(map, { ...A_GRID, collapsedProjects: {}, columnsPerProject: 2 }).nodes.values()].map((b) => b.x)).size, 2);
  assert.equal(new Set([...C.layout(map, { ...A_GRID, collapsedProjects: {}, columnsPerProject: 1 }).nodes.values()].map((b) => b.x)).size, 1);
});

test('grid routes: rows below the first share one channel per column, left of the cards, and reviewers use the nearest one', () => {
  const columns = [...Array.from({ length: 7 }, (_, i) => col('w' + i, 'w' + i, { project: 'P', state: 'working' })), col('rv', 'review', { project: 'P', state: 'working', reviews: ['w0', 'w1'] })];
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  const lay = C.layout(map, { ...A_GRID, collapsedProjects: {}, columnsPerProject: 3 });
  const routes = C.routes(map, lay, { clusterGap: 52, gapX: 24 });
  const dispatch = routes.filter((r) => r.type === 'dispatch');
  const channel = (id) => { const pts = dispatch.find((r) => r.to === id).points; return pts[pts.length - 3][0]; };
  const below = [...lay.nodes].filter(([, b]) => b.row > 1);
  assert.ok(below.length >= 4);
  below.forEach(([id, b]) => assert.equal(channel(id), b.x - 12, id + ' enters from the channel left of its column'));
  // every row-2+ card of a column uses the same channel
  const byColumn = new Map();
  below.forEach(([id, b]) => byColumn.set(b.x, [...(byColumn.get(b.x) || []), channel(id)]));
  byColumn.forEach((list) => assert.equal(new Set(list).size, 1));
  assert.ok(byColumn.size >= 2, 'more than one column below the first row');
  assert.equal(channel('rv'), lay.nodes.get('rv').x - 12);
  // first-row cards are entered from the top, at their centre
  const [firstId, first] = [...lay.nodes].find(([, b]) => b.row === 1);
  assert.equal(dispatch.find((r) => r.to === firstId).points.at(-1)[0], first.x + first.w / 2);
  // the review lines carry the reviewer's own state so only a working reviewer flows
  assert.ok(routes.filter((r) => r.type === 'review').every((r) => / st-working/.test(r.cls)));
  assert.equal(noSharedStretch(routes), '');
});

test('reopenOnActivity: a new active session brings a folded project back; the first pass only records', () => {
  const proj = (key, statuses) => ({ key, nodes: statuses.map(([id, status]) => ({ id, status })) });
  const first = C.reopenOnActivity(null, [proj('P', [['a', 'done']])], { P: true });
  assert.deepEqual(first.overrides, { P: true });
  assert.deepEqual(first.reopened, []);
  assert.deepEqual(first.active, { P: [] });
  // nothing new: still folded
  const same = C.reopenOnActivity(first.active, [proj('P', [['a', 'done']])], first.overrides);
  assert.deepEqual(same.overrides, { P: true });
  // a session of the folded project starts working: the saved fold is dropped, the project shows again
  const woke = C.reopenOnActivity(same.active, [proj('P', [['a', 'working']])], same.overrides);
  assert.deepEqual(woke.overrides, {});
  assert.deepEqual(woke.reopened, ['P']);
  // a queued or waiting session counts as activity too
  assert.deepEqual(C.reopenOnActivity({ P: [] }, [proj('P', [['a', 'queued']])], { P: true }).reopened, ['P']);
  assert.deepEqual(C.reopenOnActivity({ P: [] }, [proj('P', [['a', 'input']])], { P: true }).reopened, ['P']);
  // work that was already running is not "new"
  assert.deepEqual(C.reopenOnActivity({ P: ['a'] }, [proj('P', [['a', 'working']])], { P: true }).reopened, []);
  // a project the user opened from the tray tucks itself away again once it is active
  assert.deepEqual(C.reopenOnActivity({ P: [] }, [proj('P', [['a', 'working']])], { P: false }).overrides, {});
  // the input is never mutated
  const ov = { P: true };
  C.reopenOnActivity({ P: [] }, [proj('P', [['a', 'working']])], ov);
  assert.deepEqual(ov, { P: true });
});

test('computeFit shows the bounds whole and centred, clear of the insets, never past the zoom limits', () => {
  const bounds = { left: 100, top: 50, right: 1100, bottom: 650 };            // 1000 × 600
  const f = C.computeFit(bounds, { w: 2000, h: 1200 }, {}, { max: 1 });
  assert.equal(f.scale, 1);                                                   // never zooms in past max
  assert.equal(f.x + 100 * f.scale, (2000 - 1000) / 2);                       // centred
  assert.equal(f.y + 50 * f.scale, (1200 - 600) / 2);
  const small = C.computeFit(bounds, { w: 500, h: 600 }, {}, { max: 1 });
  assert.equal(small.scale, 0.5);                                              // width limits
  assert.equal((1100 - 100) * small.scale, 500);
  const inset = C.computeFit(bounds, { w: 1000, h: 700 }, { top: 8, right: 8, bottom: 8, left: 8 }, { max: 1 });
  assert.equal(inset.scale, 984 / 1000);                                       // 8px kept free on every side
  assert.ok(inset.x + bounds.left * inset.scale >= 8 - 1e-9);
  assert.ok(inset.x + bounds.right * inset.scale <= 1000 - 8 + 1e-9);
  assert.ok(inset.y + bounds.top * inset.scale >= 8 - 1e-9);
  assert.ok(inset.y + bounds.bottom * inset.scale <= 700 - 8 + 1e-9);
  // a floor keeps the text readable: too big for the window at the floor stays at the floor
  const floored = C.computeFit({ left: 0, top: 0, right: 2000, bottom: 2000 }, { w: 1000, h: 700 }, { top: 8, right: 8, bottom: 8, left: 8 }, { min: 0.85, max: 1 });
  assert.equal(floored.scale, 0.85);
  assert.equal(C.computeFit({ left: 0, top: 0, right: 1000, bottom: 500 }, { w: 1200, h: 700 }, {}, { min: 0.85, max: 1 }).scale, 1);
  assert.equal(C.computeFit({ left: 0, top: 0, right: 100000, bottom: 10 }, { w: 500, h: 500 }, {}, { max: 1 }).scale, C.MIN_SCALE);
  assert.ok(Number.isFinite(C.computeFit({ left: 5, top: 5, right: 5, bottom: 5 }, { w: 300, h: 300 }).scale));   // empty bounds do not break it
});

test('the signature changes when a project turns inactive, and the detail text keeps the whole receipt', () => {
  const long = '修'.repeat(300);
  const a = C.buildCrewMap({ captain, columns: [col('a', 'A', { project: 'P', state: 'working' })], tasks: [task('t', 'a', 'working', 1)] });
  const b = C.buildCrewMap({ captain, columns: [col('a', 'A', { project: 'P', state: 'done' })], tasks: [task('t', 'a', 'stopped', 1, { receipt: { summary: long } })] });
  assert.notEqual(C.signature(a), C.signature(b));
  assert.equal(b.projects[0].inactive, true);
  assert.ok(b.nodes[0].line.length <= 140);
  assert.equal(b.nodes[0].full, long);
  assert.equal(C.receiptFull({ receipt: { failed: ' 坏了 ' } }), '失败：坏了');
  assert.equal(C.receiptFull(null, { summary: '旧' }), '旧');
});

test('a project box counts only the sessions still on the map, like 队长 box; archived history is left out', () => {
  const archived = [1, 2, 3].map((i) => ({ id: `old${i}`, title: `旧${i}`, captainCrew: true, project: 'p', archivedAt: i }));
  const map = C.buildCrewMap({
    captain,
    columns: [col('a', '干活', { project: 'p', state: 'working' }), col('b', '做完', { project: 'p' })],
    archived,
    tasks: [task('t1', 'a', 'working', 10, { project: 'p' }), task('t2', 'b', 'done', 11, { project: 'p', receipt: { summary: 'ok' } }),
      task('o1', 'old1', 'failed', 1, { project: 'p', receipt: { failed: 'x' } }), task('o2', 'old2', 'done', 2, { project: 'p' }), task('o3', 'old3', 'stopped', 3, { project: 'p' })],
  });
  const p = map.projects.find((x) => x.key === 'p');
  assert.deepEqual(p.counts, { working: 1, done: 1 });
  assert.equal(C.summaryLine(p.counts), '1 干活中 · 1 已完成');
  assert.equal(map.captain.line, C.summaryLine(p.counts), 'same figures as the top box');
  assert.equal(map.archivedCount, 3);
  // showing the archive does not change the tally
  const shown = C.buildCrewMap({ captain, columns: [col('a', '干活', { project: 'p' })], archived, showArchived: true, tasks: [task('t1', 'a', 'working', 10, { project: 'p' }), task('o1', 'old1', 'failed', 1, { project: 'p' })] });
  assert.deepEqual(shown.projects[0].counts, { working: 1 });
  assert.equal(shown.nodes.length, 4);
});

// ---- arrangement: lanes planned for the window ----
const ROOM = { nodeW: 280, nodeH: 172, captainW: 420, captainH: 104, gapX: 24, clusterGap: 32, fanY: 48, gapY: 20, pad: 16, padX: 24, padBottom: 20, rowGap: 20, reviewGap: 40, grid: true, center: true, tray: true };
const crewOf = (spec) => C.buildCrewMap({ captain, tasks: [], columns: Object.entries(spec).flatMap(([p, n]) => Array.from({ length: n }, (_, i) => col(p + i, p + ' ' + i, { project: p, state: 'working' }))) });
// the bounds a plan really takes, the way the map measures them: frames and 队长 with 16px around
function bounds(map, plan) {
  const lay = C.layout(map, { ...ROOM, lanes: plan.lanes, caps: plan.caps });
  const boxes = [lay.captain, ...lay.groups];
  return { w: Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)) + 32, h: Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)) + 32, lay };
}

test('planLanes: project frames stand side by side, small ones stacked beside a big one, for the largest whole view', () => {
  // the shape the user described: one project of ten sessions, then four, two, two and one
  const map = crewOf({ agentdeck: 10, hermes: 4, music: 2, type4me: 2, vps: 1 });
  const wide = C.planLanes(map, { w: 2284, h: 1084 }, { ...ROOM, max: 1.15 });
  assert.equal(wide.fits, true);
  assert.ok(wide.lanes.length >= 2, 'more than one lane across');
  assert.deepEqual(wide.lanes.flat(), ['agentdeck', 'hermes', 'music', 'type4me', 'vps'], 'lanes keep the projects in order');
  assert.deepEqual(wide.lanes[0], ['agentdeck'], 'the big project has a lane to itself');
  assert.ok(wide.lanes.slice(1).some((l) => l.length > 1), 'small projects share a lane');
  // what it promises is what the layout takes
  const b = bounds(map, wide);
  assert.ok(Math.abs(Math.min(2284 / b.w, 1084 / b.h) - wide.scale) < 0.02, `${wide.scale} promised, ${Math.min(2284 / b.w, 1084 / b.h)} taken`);
  assert.ok(wide.scale >= 0.85);
  // far better than the old way (every project full width, one under another)
  const stacked = bounds(map, { lanes: [wide.lanes.flat()], caps: Object.fromEntries(wide.lanes.flat().map((k) => [k, 3])) });
  assert.ok(Math.min(2284 / stacked.w, 1084 / stacked.h) < wide.scale * 0.6);
  // no frame overlaps another and every card is inside its own frame
  b.lay.groups.forEach((g, i) => b.lay.groups.slice(i + 1).forEach((h) => assert.ok(g.x + g.w <= h.x || h.x + h.w <= g.x || g.y + g.h <= h.y || h.y + h.h <= g.y)));
  b.lay.nodes.forEach((n) => { const g = b.lay.groups.find((x) => x.key === n.project); assert.ok(n.x >= g.x && n.x + n.w <= g.x + g.w && n.y >= g.y && n.y + n.h <= g.y + g.h); });
  // every project in a lane is as wide as that lane allows
  wide.lanes.forEach((keys) => assert.equal(new Set(keys.map((k) => wide.caps[k])).size, 1));
});

test('planLanes: a small map and a window too small for the map', () => {
  // one project, three sessions: one row
  const one = C.planLanes(crewOf({ solo: 3 }), { w: 1172, h: 644 }, { ...ROOM, max: 1.15 });
  assert.deepEqual([one.lanes, one.caps, one.fits], [[['solo']], { solo: 3 }, true]);
  // ten sessions in two projects on a laptop window: side by side, whole
  const two = C.planLanes(crewOf({ a: 6, b: 4 }), { w: 1652, h: 824 }, { ...ROOM, max: 1.15 });
  assert.equal(two.fits, true);
  assert.deepEqual(two.lanes, [['a'], ['b']]);
  // too much for one page at readable size: no sideways scrolling, the shortest way down
  const map = crewOf({ agentdeck: 10, hermes: 4, music: 2, type4me: 2, vps: 1 });
  const small = C.planLanes(map, { w: 1172, h: 644 }, { ...ROOM, max: 1.15 });
  assert.equal(small.fits, false);
  const b = bounds(map, small);
  assert.ok(b.w * 0.85 <= 1172 + 1, 'the map is no wider than the window at the smallest readable size');
  for (const other of [{ lanes: [small.lanes.flat()], caps: Object.fromEntries(small.lanes.flat().map((k) => [k, 3])) }, { lanes: [small.lanes.flat()], caps: Object.fromEntries(small.lanes.flat().map((k) => [k, 2])) }]) {
    const o = bounds(map, other);
    assert.ok(o.w * 0.85 > 1172 + 1 || o.h >= b.h, 'no arrangement that fits the width is shorter');
  }
  // a window narrower than one card still gets a plan: one lane, one card wide
  const tiny = C.planLanes(map, { w: 200, h: 300 }, { ...ROOM, max: 1.15 });
  assert.deepEqual([tiny.lanes.length, [...new Set(Object.values(tiny.caps))]], [1, [1]]);
  // nothing on the canvas
  assert.deepEqual(C.planLanes(C.buildCrewMap({ captain, columns: [], tasks: [] }), { w: 800, h: 600 }, ROOM), { lanes: [], caps: {}, fits: true, scale: 1 });
  // tray rules are the layout's: a folded inactive project takes no lane
  const tray = trayMap();
  assert.deepEqual(C.planLanes(tray, { w: 1600, h: 900 }, { ...A_GRID, collapsedProjects: {} }).lanes.flat(), ['agentdeck']);
  assert.deepEqual(C.planLanes(tray, { w: 1600, h: 900 }, { ...A_GRID, collapsedProjects: { 'hermes-quality': false } }).lanes.flat().sort(), ['agentdeck', 'hermes-quality']);
});

test('planLanes keeps the plan in use while it is nearly as good, and follows the user\'s project order', () => {
  const map = crewOf({ a: 6, b: 4, c: 2 });
  const size = { w: 1652, h: 824 };
  const best = C.planLanes(map, size, { ...ROOM, max: 1.15 });
  assert.deepEqual([best.lanes, best.caps], [[['a'], ['b'], ['c']], { a: 2, b: 2, c: 1 }]);
  const scaleOf = (plan) => { const b = bounds(map, plan); return Math.min(size.w / b.w, size.h / b.h); };
  // a card more or less must not reshuffle the map: the plan in use stays while it shows the map
  // whole and within a few percent of the best size
  const inUse = { lanes: [['a'], ['b', 'c']], caps: { a: 2, b: 2, c: 2 } };
  assert.ok(scaleOf(inUse) < best.scale && scaleOf(inUse) >= best.scale * 0.93, 'not the best plan, but close');
  assert.deepEqual(C.planLanes(map, size, { ...ROOM, max: 1.15 }, inUse).lanes, inUse.lanes);
  assert.deepEqual(C.planLanes(map, size, { ...ROOM, max: 1.15 }, inUse).caps, inUse.caps);
  // a plan that would show the map larger than it is ever shown is no reason to move either
  const roomy = { w: 3000, h: 1600 };
  assert.deepEqual(C.planLanes(map, roomy, { ...ROOM, max: 1.15 }, inUse).lanes, inUse.lanes);
  // a plan that no longer shows the map whole when another does is dropped
  const poor = { lanes: [['a', 'b', 'c']], caps: { a: 1, b: 1, c: 1 } };
  assert.ok(scaleOf(poor) < 0.85);
  assert.deepEqual(C.planLanes(map, size, { ...ROOM, max: 1.15 }, poor).lanes, best.lanes);
  // a plan for other projects (one gone, one new, another order) is not kept
  assert.deepEqual(C.planLanes(map, size, { ...ROOM, max: 1.15 }, { lanes: [['a'], ['c', 'b']], caps: { a: 3, b: 2, c: 2 } }).lanes.flat(), ['a', 'b', 'c']);
  // the user's order: named projects first, in that order; lanes still run through it in sequence
  const mine = C.planLanes(map, size, { ...ROOM, max: 1.15, order: ['c', 'a'] });
  assert.deepEqual(mine.lanes.flat(), ['c', 'a', 'b']);
  assert.deepEqual(C.layout(map, { ...ROOM, order: ['c', 'a'], lanes: mine.lanes, caps: mine.caps }).groups.map((g) => g.key), ['c', 'a', 'b']);
});

test('orderByPlace reads the order the frames were left in: column by column, top to bottom', () => {
  const g = (key, x, y, w = 300, h = 200) => ({ key, x, y, w, h });
  // tidy lanes read back as they were laid out
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 240), g('c', 340, 0), g('d', 340, 240)]), ['a', 'b', 'c', 'd']);
  // d dragged up beside a, a little lower and overlapping the first column by less than half: it starts a column
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 240), g('c', 700, 0), g('d', 330, 30)]), ['a', 'b', 'd', 'c']);
  // c dropped roughly over the first column, between a and b
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 400), g('c', 40, 190), g('d', 700, 0)]), ['a', 'c', 'b', 'd']);
  // a narrow frame under a wide one belongs to its column
  assert.deepEqual(C.orderByPlace([g('wide', 0, 0, 900), g('narrow', 500, 240, 300), g('next', 940, 0)]), ['wide', 'narrow', 'next']);
  assert.deepEqual(C.orderByPlace([]), []);
  // read from a real layout, the order is the layout's own
  const map = crewOf({ a: 3, b: 2, c: 2, d: 1 });
  const lay = C.layout(map, { ...ROOM, lanes: [['a', 'b'], ['c', 'd']] });
  assert.deepEqual(C.orderByPlace(lay.groups), ['a', 'b', 'c', 'd']);
  C.translateProject(lay, 'd', -lay.groups.find((x) => x.key === 'd').x + lay.groups[0].x, -400);   // d dragged above the first lane
  assert.deepEqual(C.orderByPlace(lay.groups), ['d', 'a', 'b', 'c']);
});
