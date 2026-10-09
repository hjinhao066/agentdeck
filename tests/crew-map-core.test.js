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

test('a restart\'s own note (重发 / checkpoint) is no news: no receipt line, nothing handed back, the card shows what the session does', () => {
  const resend = { summary: '重发：Claude 无法续上原对话，这是新会话。\n下面重发卡片任务和最后回执，不要当成新派的另一张卡。', files: [], explicit: true, checkpoint: true, source: 'restart' };
  const working = task('t1', 'a', 'working', 10, { receipt: resend });
  assert.equal(C.receiptLine(working, resend), '');
  assert.equal(C.receiptFull(working, resend), '');
  assert.equal(C.returnKind(working, resend), '');
  // a real receipt from before the restart still counts; a failure carried by a checkpoint still shows
  assert.equal(C.receiptLine(working, { summary: '上次做完了第一步' }), '上次做完了第一步');
  assert.equal(C.receiptLine(task('t2', 'a', 'failed', 10, { receipt: { failed: '续接失败：重发仍未送达', checkpoint: true } })), '失败：续接失败：重发仍未送达');
  const map = C.buildCrewMap({ captain, columns: [col('a', '重启后自动续跑', { state: 'working', live: '⏺ 读完上次回执，从第 3 步接着做', lastReceipt: resend })], tasks: [working] });
  const node = map.nodes[0];
  assert.equal(node.line, '');
  assert.equal(node.returned, '');
  assert.deepEqual(C.cardLine(node), { text: '读完上次回执，从第 3 步接着做', kind: 'live' });
  // only the session's own column remembers a checkpoint: it is not taken for a finished receipt
  const kept = C.buildCrewMap({ captain, columns: [col('b', '续跑', { state: 'plain', lastReceipt: resend })], tasks: [] });
  assert.equal(kept.nodes[0].status, 'idle');
});

test('the card\'s one line: live work first, then what the session reported, a question or a failure, what it handed back', () => {
  const node = (status, extra) => ({ kind: 'worker', status, line: '', live: '', progress: '', detail: '', ...extra });
  assert.deepEqual(C.cardLine(node('working', { live: '⏺ 正在跑端到端测试', progress: '写完了一半' })), { text: '正在跑端到端测试', kind: 'live' }, 'the terminal\'s own bullet goes: the card draws its own');
  assert.deepEqual(['  ⎿  Added 12 lines', '✻ Pondering…', '• 只读核对 42 项', '⏺', '-- 3/8'].map((live) => C.cardLine(node('working', { live })).text), ['Added 12 lines', 'Pondering…', '只读核对 42 项', '⏺', '3/8']);
  assert.deepEqual(C.cardLine(node('working', { progress: '写完了一半' })), { text: '写完了一半', kind: 'live' });
  assert.deepEqual(C.cardLine(node('working')), { text: '还没有进展', kind: 'empty' });
  assert.deepEqual(C.cardLine(node('input', { line: '提问：用哪个库？' })), { text: '提问：用哪个库？', kind: 'question' });
  assert.deepEqual(C.cardLine(node('input')), { text: '在终端里等你回答', kind: 'empty' });
  assert.deepEqual(C.cardLine(node('failed', { line: '失败：没权限' })), { text: '失败：没权限', kind: 'failed' });
  assert.deepEqual(C.cardLine(node('done', { line: '修好了' })), { text: '修好了', kind: 'receipt' });
  assert.deepEqual(C.cardLine(node('queued', { detail: '等终端就绪' })), { text: '还没开始', kind: 'empty' });
  assert.deepEqual(C.cardLine({ kind: 'waiting', status: 'queued' }), { text: '会话数满了，有空位就自动开', kind: 'empty' });
  assert.deepEqual(C.cardLine(node('stopped')), { text: '', kind: 'empty' });
  // the session's own progress report rides on the node while it works, and only then
  const tasks = [task('t1', 'a', 'working', 10, { progress: '跑完 3/8 组' }), task('t2', 'b', 'done', 10, { progress: '旧的进展', receipt: { summary: '完成' } })];
  const map = C.buildCrewMap({ captain, columns: [col('a', 'a', { state: 'working' }), col('b', 'b')], tasks });
  assert.deepEqual(map.nodes.map((n) => n.progress), ['跑完 3/8 组', '']);
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
  assert.deepEqual(kept.plan, { lanes: [['A'], ['B', 'C']], caps: { A: 3, B: 2 }, tight: true, page: false });
  assert.equal(C.normalizeSaved({ plan: { lanes: [['A']], caps: { A: 3 }, page: 1 } }).plan.page, true, '智能一页\'s one-page plan stays one');
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

test('rails: every card hangs off a line down the left of its column; no line crosses a title strip or another frame', () => {
  const RAILS = { ...A_GRID, clusterGap: 32, padX: 16, headH: 64, rails: true, railX: 8, collapsedProjects: {} };
  const columns = [...Array.from({ length: 9 }, (_, i) => col('a' + i, 'a' + i, { project: 'A', state: i % 3 ? 'working' : 'done' })), col('ar', 'review', { project: 'A', state: 'working', reviews: ['a0', 'a1'] }),
    ...['B', 'C', 'D', 'E'].flatMap((p, k) => Array.from({ length: k + 1 }, (_, i) => col(p + i, p + i, { project: p, state: 'working' })))];
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  for (const w of [3000, 1500, 1000]) {
    const plan = C.planAcross(map, { w }, { ...RAILS, caps: { A: 2 } });
    const lay = C.layout(map, { ...RAILS, lanes: plan.lanes, caps: plan.caps });
    assert.deepEqual(lay.rails, { x: 8, headH: 64, entry: 20 });
    const routes = C.routes(map, lay, { clusterGap: 32, gapX: RAILS.gapX });
    const dispatch = routes.filter((r) => r.type === 'dispatch');
    assert.equal(dispatch.length, columns.length);
    for (const r of dispatch) {
      const b = lay.nodes.get(r.to);
      assert.deepEqual(r.points.at(-1), [b.x - 2, b.y + 20], `${w} ${r.to}: enters the card's left edge by its status row`);
      assert.deepEqual(r.points.at(-2), [b.x - 8, b.y + 20], `${w} ${r.to}: from the rail of its own column`);
      assert.deepEqual(r.branch.at(-1), r.points.at(-1));
      // inside its frame's title strip only the left rail runs, straight down
      const g = lay.groups.find((x) => x.key === r.project), strip = [g.y + 1, g.y + 64 - 8 - 1];
      r.points.slice(1).forEach(([x2, y2], k) => {
        const [x1, y1] = r.points[k];
        if (Math.max(x1, x2) < g.x || Math.min(x1, x2) > g.x + g.w || Math.max(y1, y2) < strip[0] || Math.min(y1, y2) > strip[1]) return;
        assert.ok(Math.abs(x1 - x2) < 0.5 && x1 <= g.x + 16, `${w} ${r.to}: a line across ${g.key}'s title strip at ${x1},${y1}-${x2},${y2}`);
      });
    }
    staysOutOfOtherFrames(dispatch, lay);
    assert.equal(noSharedStretch(routes), '', `${w}`);
    // a frame two cards wide: one rail per column, joined under its title strip
    const two = [...lay.nodes].filter(([, b]) => b.project === 'A' && b.row === 1).map(([id]) => dispatch.find((r) => r.to === id));
    assert.equal(new Set(two.map((r) => r.points.at(-2)[0])).size, 2);
    const busY = frameOf(lay, 'A').y + 64 - 8, right = two.reduce((m, r) => (r.points.at(-2)[0] > m.points.at(-2)[0] ? r : m));
    assert.ok(right.points.some(([x, y]) => Math.abs(y - busY) < 0.5 && x < right.points.at(-2)[0]), 'the second column is reached along the bus under the title');
  }
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

// the projects of a plan, read from its layout like lines of text (the way they were filled in)
const reading = (map, plan) => C.orderByPlace(C.layout(map, { ...ROOM, lanes: plan.lanes, caps: plan.caps }).groups);
const frameOf = (lay, key) => lay.groups.find((g) => g.key === key);

test('planAcross: each frame as many cards wide as asked (智能一页\'s choice), one when not asked, narrower where the window cannot hold it', () => {
  // (sessions without tasks keep the order of their ids: a, b, c, d)
  const map = crewOf({ a: 15, b: 6, c: 7, d: 1 });
  const plan = C.planAcross(map, { w: 9000 }, { ...ROOM, caps: { a: 3, c: 2 } });
  assert.deepEqual(plan, { lanes: [['a'], ['b'], ['c'], ['d']], caps: { a: 3, b: 1, c: 2, d: 1 } });
  const lay = C.layout(map, { ...ROOM, lanes: plan.lanes, caps: plan.caps });
  const grid = (key) => { const cards = [...lay.nodes.values()].filter((b) => b.project === key); return [new Set(cards.map((b) => b.x)).size, new Set(cards.map((b) => b.y)).size]; };
  assert.deepEqual(grid('a'), [3, 5], 'fifteen sessions three wide: five rows down');
  assert.deepEqual(grid('b'), [1, 6], 'not asked: one wide, six rows down');
  assert.deepEqual(grid('c'), [2, 4]);
  assert.deepEqual(grid('d'), [1, 1]);
  // the projects stand across the top, one lane each, on one line
  assert.equal(new Set(lay.groups.map((g) => g.y)).size, 1);
  assert.deepEqual(C.planAcross(map, { w: 9000 }, ROOM).caps, { a: 1, b: 1, c: 1, d: 1 });
  // a window that cannot hold the frame asked for gets it narrower, never wider than itself
  assert.deepEqual(C.planAcross(crewOf({ big: 9 }), { w: 600 }, { ...ROOM, caps: { big: 2 } }).caps, { big: 1 });
  assert.deepEqual(C.planAcross(crewOf({ big: 9 }), { w: 700 }, { ...ROOM, caps: { big: 2 } }).caps, { big: 2 });
  assert.deepEqual(C.planAcross(crewOf({ big: 9 }), { w: 1000 }, { ...ROOM, caps: { big: 4 } }).caps, { big: 3 });
});

// ---- 智能一页: every project across one row, the widths chosen together for one page ----
// The card, frame and 队长 sizes crew-map.js lays the map out with, and the page in canvas units at the
// map's own 100% for a viewport of vw x vh screen px (the view's fit keeps 8px clear on each side).
const PAGE = { nodeW: 280, nodeH: 110, captainW: 576, captainH: 112, gapX: 24, clusterGap: 32, fanY: 48, gapY: 20, pad: 16, lane: 12, padX: 16, padBottom: 16, rowGap: 12, reviewGap: 36, headH: 68, grid: true, center: true, tray: true };
const viewport = (vw, vh) => ({ w: (vw - 16) / C.BASE_SCALE, h: (vh - 16) / C.BASE_SCALE });
const paged = (spec, vw, vh, opts) => C.planPage(crewOf(spec), viewport(vw, vh), { ...PAGE, ...opts });
// what a plan really takes once laid out, against the page it was made for
function onePage(spec, vw, vh, plan) {
  const lay = C.layout(crewOf(spec), { ...PAGE, lanes: plan.lanes, caps: plan.caps });
  const boxes = [lay.captain, ...lay.groups];
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)) + 32, h = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)) + 32;
  const page = viewport(vw, vh);
  return { scale: Math.min(1, page.w / w, page.h / h), rows: Object.fromEntries(lay.groups.map((g) => [g.key, new Set([...lay.nodes.values()].filter((b) => b.project === g.key).map((b) => b.y)).size])), line: new Set(lay.groups.map((g) => g.y)).size };
}

test('智能一页: the user\'s 2.0.0 map (11 / 3 / 1 cards) gets agentdeck three cards wide, the others one, on one page at 100%', () => {
  // a 14-inch MacBook with the window full: the map's page is about 1260 x 780
  const spec = { agentdeck: 11, 秋招: 3, skills: 1 };
  const plan = paged(spec, 1260, 780);
  assert.deepEqual(plan.caps, { agentdeck: 3, 秋招: 1, skills: 1 });
  assert.deepEqual(plan.lanes, [['agentdeck'], ['skills'], ['秋招']], 'one row, in the map\'s own order (sessions without tasks sort by id)');
  assert.equal(plan.fits, true);
  assert.equal(plan.scale, 1);
  // two wide would leave agentdeck six rows long beside 秋招's three; four wide would not fit at 100%
  const laid = onePage(spec, 1260, 780, plan);
  assert.deepEqual(laid.rows, { agentdeck: 4, 秋招: 3, skills: 1 });
  assert.equal(laid.line, 1);
  assert.equal(laid.scale, 1, 'laid out, it really fits at 100%');
});

test('智能一页: projects of one or two cards each stay one card wide, narrow or wide', () => {
  const spec = { a: 2, b: 1, c: 2, d: 1, e: 1, f: 2 };
  for (const [vw, vh] of [[1668, 912], [2308, 1250], [1188, 732]]) {
    assert.deepEqual(paged(spec, vw, vh).caps, { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 }, `${vw}`);
  }
  // a project of two beside ones of one is not "too long": it is not split to even them out
  assert.deepEqual(paged({ solo: 2 }, 1188, 732).caps, { solo: 1 });
  assert.deepEqual(paged({ two: 2, one: 1 }, 2308, 1250).caps, { two: 1, one: 1 });
});

test('智能一页: one project of twenty beside a few small ones goes wide (up to four) and the page still holds it', () => {
  const spec = { big: 20, s1: 2, s2: 1, s3: 3 };
  const wide = paged(spec, 1668, 912);
  assert.deepEqual(wide.caps, { big: 4, s1: 1, s2: 1, s3: 1 });
  assert.equal(wide.fits, true);
  assert.deepEqual(onePage(spec, 1668, 912, wide).rows, { big: 5, s1: 2, s2: 1, s3: 3 });
  // a smaller window: three wide, shown a little smaller to keep it all on one page
  const smaller = paged(spec, 1188, 732);
  assert.deepEqual(smaller.caps, { big: 3, s1: 1, s2: 1, s3: 1 });
  assert.equal(smaller.fits, true);
  assert.ok(smaller.scale < 1 && smaller.scale >= C.PAGE_MIN_SCALE, String(smaller.scale));
  assert.ok(onePage(spec, 1188, 732, smaller).scale >= C.PAGE_MIN_SCALE - 0.01);
  // never more than four cards wide, nor wider than a frame has cards
  assert.deepEqual(paged({ huge: 40 }, 4000, 2400).caps, { huge: C.PAGE_COLUMNS });
  assert.ok(paged({ three: 3 }, 4000, 2400).caps.three <= 3);
});

test('智能一页: a narrow window takes fewer columns, and a map too big for one page says so (it goes in lanes at 100%)', () => {
  const spec = { agentdeck: 11, 秋招: 3, skills: 1 };
  // 900 x 700: agentdeck two wide at a little under 100% is the way onto one page
  const narrow = paged(spec, 900, 700);
  assert.deepEqual(narrow.caps, { agentdeck: 2, 秋招: 1, skills: 1 });
  assert.equal(narrow.fits, true);
  assert.ok(narrow.scale >= C.PAGE_MIN_SCALE && narrow.scale < 1, String(narrow.scale));
  // 750 x 640: nothing shows it on one page readably; the best columns still come back, for the lanes
  const tooSmall = paged(spec, 750, 640);
  assert.equal(tooSmall.fits, false);
  assert.ok(tooSmall.scale < C.PAGE_MIN_SCALE);
  assert.deepEqual(tooSmall.caps, { agentdeck: 2, 秋招: 1, skills: 1 });
  assert.deepEqual(C.planAcross(crewOf(spec), viewport(750, 640), { ...PAGE, caps: tooSmall.caps }).caps, tooSmall.caps);
  // six projects and twenty-four cards at 1440 x 900 do not fit one page either
  assert.equal(paged({ agentdeck: 15, 秋招: 3, kenke: 2, fuqing: 2, daily: 1, other: 1 }, 1188, 732).fits, false);
});

test('智能一页: a wide screen fills its page, with the fewest columns that keep the frames even', () => {
  // the same 11 / 3 / 1 on a 27-inch screen: four wide would fit as well, three is as even with fewer columns
  assert.deepEqual(paged({ agentdeck: 11, 秋招: 3, skills: 1 }, 2308, 1250).caps, { agentdeck: 3, 秋招: 1, skills: 1 });
  // the screenshots' 24 sessions in six projects: one page at 1920 x 1080, agentdeck three wide, a little under 100%
  const spec = { agentdeck: 15, 秋招: 3, kenke: 2, fuqing: 2, daily: 1, other: 1 };
  const plan = paged(spec, 1668, 912);
  assert.deepEqual(plan.caps, { agentdeck: 3, 秋招: 1, kenke: 1, fuqing: 1, daily: 1, other: 1 });
  assert.equal(plan.fits, true);
  assert.ok(plan.scale > 0.85 && plan.scale < 0.9, String(plan.scale));
  const laid = onePage(spec, 1668, 912, plan);
  assert.equal(laid.line, 1, 'all six on one line');
  assert.ok(Math.abs(laid.scale - plan.scale) < 0.01, `${laid.scale} vs ${plan.scale}`);
  // the window's height counts too: a short wide window takes more columns to keep the frames low
  assert.deepEqual(paged({ big: 20 }, 2308, 560).caps, { big: 4 });
});

test('智能一页: the plan in use stays while it is nearly as good, so frames do not jump back and forth', () => {
  const spec = { agentdeck: 11, 秋招: 3, skills: 1 };
  const plan = paged(spec, 1260, 780);
  // a little wider, a card more: the same plan
  assert.deepEqual(paged(spec, 1420, 780, { keep: plan }).caps, plan.caps);
  assert.deepEqual(paged({ agentdeck: 12, 秋招: 3, skills: 1 }, 1260, 780, { keep: plan }).caps, plan.caps);
  // a plan that no longer fits is dropped, and so is one made for other projects
  assert.deepEqual(paged(spec, 900, 700, { keep: plan }).caps, { agentdeck: 2, 秋招: 1, skills: 1 });
  assert.equal(paged({ agentdeck: 11, 秋招: 3, skills: 1, more: 1 }, 1660, 780, { keep: plan }).lanes.length, 4);
  // nothing on the canvas
  assert.deepEqual(C.planPage(C.buildCrewMap({ captain, columns: [], tasks: [] }), viewport(1200, 800), PAGE), { lanes: [], caps: {}, scale: 1, fits: true });
});

test('智能一页 is quick: six projects of up to four widths each, every combination scored', () => {
  const t0 = process.hrtime.bigint();
  const plan = C.planPage(crewOf({ a: 9, b: 8, c: 7, d: 6, e: 5, f: 4 }), viewport(1668, 912), PAGE);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `${ms} ms`);
  assert.equal(Object.keys(plan.caps).length, 6);
  // more projects than can all be tried: still a plan, widened a step at a time
  const many = C.planPage(crewOf(Object.fromEntries('abcdefghij'.split('').map((k, i) => [k, i + 2]))), viewport(4000, 2400), PAGE);
  assert.equal(Object.keys(many.caps).length, 10);
  assert.ok(Object.values(many.caps).every((c) => c >= 1 && c <= C.PAGE_COLUMNS));
});

test('planAcross: projects stand left to right, as many abreast as the width holds, the rest under the lane that ends highest', () => {
  // eight small projects: no cap of four lanes; a narrower window drops a lane at a time and never plans wider than itself
  const keys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], small = crewOf(Object.fromEntries(keys.map((k) => [k, 1])));
  const seen = [];
  for (const w of [3000, 2600, 1500, 1300, 1100, 900, 760, 500, 200]) {
    const plan = C.planAcross(small, { w }, ROOM), K = plan.lanes.length;
    seen.push(K);
    assert.deepEqual(reading(small, plan), keys, `${w}: read like text, the projects are in order`);
    assert.deepEqual(plan.lanes.map((lane) => lane[0]), keys.slice(0, K), `${w}: the first ${K} across the top`);
    if (K > 1) assert.ok(bounds(small, plan).w <= w + 1, `${w}: ${bounds(small, plan).w} wide`);
  }
  assert.deepEqual(seen, [8, 7, 4, 3, 3, 2, 2, 1, 1]);
  // what does not fit across goes under the lane that ends highest, not round the lanes in turn
  const mixed = crewOf({ a: 5, b: 1, c: 3, d: 1, e: 2 });
  const three = C.planAcross(mixed, { w: 1100 }, ROOM);
  assert.deepEqual(three.lanes, [['a'], ['b', 'd', 'e'], ['c']]);
  const lay = bounds(mixed, three).lay;
  assert.equal(frameOf(lay, 'd').y, frameOf(lay, 'b').y + frameOf(lay, 'b').h + ROOM.clusterGap, 'close under the frame above');
  assert.equal(frameOf(lay, 'e').y, frameOf(lay, 'd').y + frameOf(lay, 'd').h + ROOM.clusterGap);
  assert.deepEqual(reading(mixed, three), ['a', 'b', 'c', 'd', 'e']);
  // a big project grows down in its own frame and pushes nobody under it: the small ones stand beside it
  const lopsided = crewOf({ big: 15, s1: 1, s2: 1, s3: 1, s4: 1, s5: 1 });
  const beside = C.planAcross(lopsided, { w: 1800 }, { ...ROOM, caps: { big: 2 } });
  assert.deepEqual(beside.lanes, [['big'], ['s1', 's4'], ['s2', 's5'], ['s3']]);
  const b = bounds(lopsided, beside);
  assert.ok(b.w <= 1800 + 1);
  const big = frameOf(b.lay, 'big');
  for (const key of ['s1', 's2', 's3', 's4', 's5']) assert.ok(frameOf(b.lay, key).y + frameOf(b.lay, key).h < big.y + big.h, `${key} stands beside the big frame, not under it`);
  // the whole set across one line when the window holds it
  assert.equal(C.planAcross(lopsided, { w: 2600 }, { ...ROOM, caps: { big: 2 } }).lanes.length, 6);
  // a frame two cards wide left over where only one-card lanes stand across: it goes under one of them, still inside the window
  const late = crewOf({ a: 1, b: 1, c: 1, d: 8 });
  const under = C.planAcross(late, { w: 1500 }, { ...ROOM, caps: { d: 2 } });
  assert.deepEqual(under, { lanes: [['a', 'd'], ['b'], ['c']], caps: { a: 1, b: 1, c: 1, d: 2 } });
  assert.ok(bounds(late, under).w <= 1500 + 1);
  // frames of the same height across the top: what is left fills in from the left
  assert.deepEqual(C.planAcross(crewOf({ a: 2, b: 2, c: 2, d: 1, e: 1, f: 1 }), { w: 1100 }, ROOM).lanes, [['a', 'd'], ['b', 'e'], ['c', 'f']]);
  // the window's height is not asked: one width, one plan
  assert.deepEqual(C.planAcross(mixed, { w: 1100, h: 300 }, ROOM), C.planAcross(mixed, { w: 1100, h: 3000 }, ROOM));
  // nothing planned is ever wider than the window, whatever the mix; and the order read back from it
  // (what 一键整理 remembers) plans the very same map, so tidying an untouched map moves nothing
  const mix = crewOf({ a: 3, b: 9, c: 1, d: 7, e: 2, f: 1, g: 12, h: 1 }), wideOnes = { b: 2, d: 2, g: 2 };
  for (const w of [3400, 2400, 1800, 1300, 1000, 700]) {
    const plan = C.planAcross(mix, { w }, { ...ROOM, caps: wideOnes });
    if (plan.lanes.length > 1) assert.ok(bounds(mix, plan).w <= w + 1, `${w}: ${bounds(mix, plan).w}`);
    assert.deepEqual(C.planAcross(mix, { w }, { ...ROOM, caps: wideOnes, order: reading(mix, plan) }), plan, `${w}: read back, the same plan`);
  }
});

test('planAcross: a card more or less keeps every frame in its lane; a new order or a frame changing width plans afresh', () => {
  const before = crewOf({ a: 2, b: 1, c: 3, d: 1, e: 1 });
  const plan = C.planAcross(before, { w: 1100 }, ROOM);
  assert.deepEqual(plan.lanes, [['a', 'e'], ['b', 'd'], ['c']]);
  // b gets two more sessions: afresh, d and e would change lanes; kept, nothing moves
  const grown = crewOf({ a: 2, b: 3, c: 3, d: 1, e: 1 });
  assert.notDeepEqual(C.planAcross(grown, { w: 1100 }, ROOM).lanes, plan.lanes);
  assert.deepEqual(C.planAcross(grown, { w: 1100 }, { ...ROOM, keep: plan }).lanes, plan.lanes);
  // a kept plan that has grown far taller than a fresh one is given up
  const lopsided = crewOf({ a: 2, b: 6, c: 3, d: 1, e: 1 });
  assert.notDeepEqual(C.planAcross(lopsided, { w: 1100 }, { ...ROOM, keep: plan }).lanes, plan.lanes);
  // the user's own order, a new project, or a frame turning two cards wide: afresh
  assert.notDeepEqual(C.planAcross(before, { w: 1100 }, { ...ROOM, keep: plan, order: ['c'] }).lanes, plan.lanes);
  assert.deepEqual(C.planAcross(crewOf({ a: 2, b: 1, c: 3, d: 1, e: 1, f: 1 }), { w: 1100 }, { ...ROOM, keep: plan }).lanes.flat().length, 6);
  assert.deepEqual(C.planAcross(crewOf({ a: 7, b: 1, c: 3, d: 1, e: 1 }), { w: 1100 }, { ...ROOM, keep: plan, caps: { a: 2 } }).caps.a, 2);
  // a kept plan wider than the window now is given up too
  assert.equal(C.planAcross(before, { w: 900 }, { ...ROOM, keep: plan }).lanes.length, 2);
});

test('planAcross: nothing on the canvas, the tray, and the user\'s own project order', () => {
  assert.deepEqual(C.planAcross(C.buildCrewMap({ captain, columns: [], tasks: [] }), { w: 800 }, ROOM), { lanes: [], caps: {} });
  // tray rules are the layout's: a folded inactive project takes no lane
  const tray = trayMap();
  assert.deepEqual(C.planAcross(tray, { w: 1600 }, { ...A_GRID, collapsedProjects: {} }).lanes.flat(), ['agentdeck']);
  assert.deepEqual(C.planAcross(tray, { w: 1600 }, { ...A_GRID, collapsedProjects: { 'hermes-quality': false } }).lanes.flat().sort(), ['agentdeck', 'hermes-quality']);
  // the user's order: named projects first, in that order, across the top
  const map = crewOf({ a: 6, b: 4, c: 2 });
  const mine = C.planAcross(map, { w: 2400 }, { ...ROOM, order: ['c', 'a'] });
  assert.deepEqual(mine.lanes, [['c'], ['a'], ['b']]);
  assert.deepEqual(C.layout(map, { ...ROOM, order: ['c', 'a'], lanes: mine.lanes, caps: mine.caps }).groups.map((g) => g.key), ['c', 'a', 'b']);
});

test('a frame is at least as wide as its header needs, its cards centred; a narrow window stands the frames in one lane', () => {
  const map = crewOf({ agentdeck: 10, 'hermes-savings': 4, 'type4me-windows': 2, 'vps-ops': 1 });
  // what each header measured: the whole name and its short tally
  const headW = { agentdeck: 352, 'hermes-savings': 357, 'type4me-windows': 342.4, 'vps-ops': 230 };
  const one = Object.fromEntries(Object.keys(headW).map((k) => [k, 1]));
  const lay = C.layout(map, { ...ROOM, headW, lanes: [['agentdeck'], ['hermes-savings', 'type4me-windows', 'vps-ops']], caps: one });
  // one card wide is 328: a header that needs more widens its frame, one that needs less changes nothing
  assert.deepEqual(lay.groups.map((g) => g.w), [352, 357, 343, 328]);
  lay.groups.forEach((g, i) => lay.groups.slice(i + 1).forEach((h) => assert.ok(g.x + g.w <= h.x || h.x + h.w <= g.x || g.y + g.h <= h.y || h.y + h.h <= g.y, `${g.key}/${h.key} overlap`)));
  lay.nodes.forEach((n) => {
    const g = lay.groups.find((x) => x.key === n.project);
    assert.ok(n.x - g.x >= 24 && Math.abs((n.x - g.x) - (g.x + g.w - n.x - n.w)) <= 1, `${n.project}: its one column of cards stands centred`);
  });
  // the lanes are as wide as their widest frame: nothing of the second lane lies over the first
  assert.ok(lay.groups[1].x >= lay.groups[0].x + lay.groups[0].w + 32);
  // without header widths nothing moves
  assert.deepEqual(C.layout(map, { ...ROOM, lanes: [['agentdeck'], ['hermes-savings', 'type4me-windows', 'vps-ops']], caps: one }).groups.map((g) => g.w), [328, 328, 328, 328]);
  // several cards wide: the header rarely asks for more, and the cards keep the frame's padding
  const wide = C.layout(map, { ...ROOM, headW, lanes: [Object.keys(headW)], caps: Object.fromEntries(Object.keys(headW).map((k) => [k, 2])) });
  assert.deepEqual(wide.groups.map((g) => g.w), [632, 632, 632, 328]);

  // the plan counts the widened frames: what it lays out is no wider than the window
  for (const w of [2400, 1674, 1017, 617]) {   // 1920, 1440, 980 and 700 wide windows at 100%
    const plan = C.planAcross(map, { w }, { ...ROOM, headW });
    const lay = C.layout(map, { ...ROOM, headW, lanes: plan.lanes, caps: plan.caps });
    if (plan.lanes.length > 1) assert.ok(Math.max(...lay.groups.map((g) => g.x + g.w)) - Math.min(...lay.groups.map((g) => g.x)) + 32 <= w + 1, `${w}: the lanes fit`);
  }
  assert.equal(C.planAcross(map, { w: 617 }, { ...ROOM, headW }).lanes.length, 1);
  assert.deepEqual(C.planAcross(map, { w: 2400 }, { ...ROOM, headW }).lanes, [['agentdeck'], ['hermes-savings'], ['type4me-windows'], ['vps-ops']]);
});

test('orderByPlace reads the order the frames were left in like lines of text: tops level within a band read from the left, then the next line', () => {
  const g = (key, x, y, w = 300, h = 200) => ({ key, x, y, w, h });
  // two columns of two read across, then down
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 240), g('c', 340, 0), g('d', 340, 240)]), ['a', 'c', 'b', 'd']);
  // d dragged up beside a, a little lower and overlapping the first column by less than half: it starts a column
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 240), g('c', 700, 0), g('d', 330, 30)]), ['a', 'd', 'c', 'b']);
  // c dropped roughly over the first column, between a and b
  assert.deepEqual(C.orderByPlace([g('a', 0, 0), g('b', 0, 400), g('c', 40, 190), g('d', 700, 0)]), ['a', 'd', 'c', 'b']);
  // a narrow frame under a wide one belongs to its column
  assert.deepEqual(C.orderByPlace([g('wide', 0, 0, 900), g('narrow', 500, 240, 300), g('next', 940, 0)]), ['wide', 'next', 'narrow']);
  // a small frame dropped half over the top left of a big one stands beside it, not above it: it reads first, the big one next
  assert.deepEqual(C.orderByPlace([g('big', 400, 100, 936, 820), g('small', 280, 70, 328, 244), g('c', 1400, 100), g('d', 1760, 100)]), ['small', 'big', 'c', 'd']);
  assert.deepEqual(C.orderByPlace([]), []);
  // read from what planAcross laid out, the order is the map's own, at every number of lanes
  // (frames of one card wide: whatever comes later stands lower, or level and further right)
  const map = crewOf({ a: 3, b: 2, c: 2, d: 1, e: 4, f: 1, g: 2 });
  for (const w of [3000, 1500, 1100, 760, 300]) {
    const plan = C.planAcross(map, { w }, ROOM);
    assert.deepEqual(C.orderByPlace(C.layout(map, { ...ROOM, lanes: plan.lanes, caps: plan.caps }).groups), ['a', 'b', 'c', 'd', 'e', 'f', 'g'], `${w}: ${plan.lanes.length} lanes`);
  }
  const lay = C.layout(crewOf({ a: 3, b: 2, c: 2, d: 1 }), { ...ROOM, lanes: [['a', 'c'], ['b', 'd']] });
  assert.deepEqual(C.orderByPlace(lay.groups), ['a', 'b', 'c', 'd']);
  C.translateProject(lay, 'd', -lay.groups.find((x) => x.key === 'd').x + lay.groups[0].x, -900);   // d dragged above the first lane: a line of its own, read first
  assert.deepEqual(C.orderByPlace(lay.groups), ['d', 'a', 'b', 'c']);
});

test('the map\'s own zoom: 100% is 70% of the drawn size, the buttons step by tenths of it, old saved views keep their size', () => {
  assert.equal(C.BASE_SCALE, 0.7);
  // what the control reads: what used to read 70% is 100%
  assert.deepEqual([0.7, 0.49, 1, 0.85, 1.4].map(C.zoomPercent), [100, 70, 143, 121, 200]);
  assert.deepEqual([C.zoomPercent(C.MIN_SCALE), C.zoomPercent(C.MAX_SCALE)], [40, 250]);
  // 放大 / 缩小 land on whole tenths of 100%
  const pct = (scale, dir) => C.zoomPercent(C.zoomStep(scale, dir));
  assert.deepEqual([pct(0.7, 1), pct(0.7, -1)], [110, 90]);
  assert.deepEqual([pct(0.85, 1), pct(0.85, -1)], [130, 120], 'from between two steps to the next one, not a step and a bit');
  assert.deepEqual([pct(0.5, 1), pct(0.5, -1)], [80, 70]);
  let s = C.BASE_SCALE;
  for (let i = 0; i < 5; i++) s = C.zoomStep(s, 1);
  assert.equal(C.zoomPercent(s), 150);
  for (let i = 0; i < 5; i++) s = C.zoomStep(s, -1);
  assert.ok(Math.abs(s - C.BASE_SCALE) < 1e-9, 'five steps in and five out come back to 100%');
  // the limits hold
  assert.equal(C.zoomStep(C.MAX_SCALE, 1), C.MAX_SCALE);
  assert.equal(C.zoomStep(C.MIN_SCALE, -1), C.MIN_SCALE);
  for (let i = 0; i < 40; i++) s = C.zoomStep(s, 1);
  assert.equal(s, C.MAX_SCALE);
  for (let i = 0; i < 40; i++) s = C.zoomStep(s, -1);
  assert.equal(s, C.MIN_SCALE);
  // a view saved by 1.3 or earlier (scale in drawn units, 0.3 to 1.6) is kept as it is: same size on screen, a new reading
  for (const old of [0.3, 0.49, 0.7, 0.85, 1, 1.15, 1.6]) assert.equal(C.normalizeSaved({ view: { x: 3, y: 4, scale: old } }).view.scale, old);
  assert.equal(C.zoomPercent(C.normalizeSaved({ view: { x: 0, y: 0, scale: 0.7 } }).view.scale), 100);
  assert.equal(C.normalizeSaved({ view: { x: 0, y: 0, scale: 0.01 } }).view.scale, C.MIN_SCALE);
  assert.equal(C.normalizeSaved({ view: { x: 0, y: 0, scale: 99 } }).view.scale, C.MAX_SCALE);
});

test('a web request waiting its turn is 排队 even though its terminal reads working', () => {
  const queued = { colId: 'w', title: 'q', status: 'working', webPhase: 'queued' };
  assert.deepEqual(C.nodeStatus(queued, { alive: true, state: 'working' }), { status: 'queued', detail: '等网页空出来' });
  assert.equal(C.nodeStatus({ ...queued, webPhase: 'running' }, { alive: true, state: 'working' }).status, 'working');
  assert.equal(C.nodeStatus({ ...queued, status: 'done' }, { alive: true, state: 'done' }).status, 'done');
});

// ---- 小队长分层: a session that handed work on (create-child) leads its crew, which stands under it ----
// The records create-child leaves: the child's parentTaskId is its 小队长's taskId; the child has no
// 队长 task card and no project of its own; what it hands back stays on it (taskCompleted, result).
const squadInput = (extra = {}) => ({
  captain,
  columns: [
    col('lead', '2.0.2 发版小队长', { project: 'agentdeck', taskId: 'T-lead', state: 'working' }),
    col('w1', '侧栏额度深色修正', { project: 'agentdeck', taskId: 'T-w1', state: 'working' }),
    col('k1', '打包 macOS', { captainCrew: false, taskId: 'T-k1', parentTaskId: 'T-lead', state: 'working' }),
    col('g1', '签名公证', { captainCrew: false, taskId: 'T-g1', parentTaskId: 'T-k1', state: 'working' }),
    col('k2', '打包 Windows', { captainCrew: false, taskId: 'T-k2', parentTaskId: 'T-lead', state: 'done', taskCompleted: true, result: 'Windows 安装包已签名，SHA 写进 release-notes。' }),
    col('k3', '写更新说明', { captainCrew: false, taskId: 'T-k3', parentTaskId: 'T-lead', state: 'input' }),
    // a hand-opened session's own helper: its parent is not on the map, so neither is it
    col('m0', '自己开的会话', { captainCrew: false, taskId: 'T-m0' }),
    col('m1', '它的帮手', { captainCrew: false, taskId: 'T-m1', parentTaskId: 'T-m0' }),
  ],
  tasks: [task('t-lead', 'lead', 'working', 10, { project: 'agentdeck' }), task('t-w1', 'w1', 'working', 20, { project: 'agentdeck' })],
  ...extra,
});

test('小队长分层: a 小队长\'s crew is on the map under it, in its project, however deep; 队长\'s lines go to the 小队长, the 小队长\'s to its crew', () => {
  const map = C.buildCrewMap(squadInput());
  const node = (id) => map.nodes.find((n) => n.id === id);
  assert.deepEqual(map.nodes.map((n) => n.id).sort(), ['g1', 'k1', 'k2', 'k3', 'lead', 'w1']);
  // no card from 队长, no project of their own: they stand in their 小队长's
  assert.deepEqual(['k1', 'k2', 'k3', 'g1'].map((id) => node(id).project), ['agentdeck', 'agentdeck', 'agentdeck', 'agentdeck']);
  assert.deepEqual(map.projects.map((p) => p.key), ['agentdeck']);
  assert.deepEqual(['lead', 'w1', 'k1', 'g1', 'k2'].map((id) => [node(id).parent, node(id).depth]), [['', 0], ['', 0], ['lead', 1], ['k1', 2], ['lead', 1]]);
  assert.deepEqual(['lead', 'k1', 'w1', 'g1'].map((id) => [node(id).leader, node(id).crew]), [[true, 3], [true, 1], [false, 0], [false, 0]]);
  // 队长 → the 小队长 and the other session it sent; the 小队长 → its crew; a crew member's crew from it
  const of = (type) => map.edges.filter((e) => e.type === type).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(of('dispatch'), ['cap>lead', 'cap>w1']);
  assert.deepEqual(of('squad'), ['k1>g1', 'lead>k1', 'lead>k2', 'lead>k3']);
  // what a crew member hands back goes to its 小队长: no line back to 队长 from it
  assert.equal(node('k2').status, 'done');
  assert.equal(node('k2').line, 'Windows 安装包已签名，SHA 写进 release-notes。');
  assert.equal(node('k2').returned, 'ok');
  assert.deepEqual(of('return'), []);
  assert.equal(node('k3').status, 'input');
  // 队长's tally counts the whole crew, 小队长s' crews too
  assert.deepEqual(map.counts, { working: 4, done: 1, input: 1 });
  // a session flagged 小队长 that has no crew yet is still one
  const flagged = C.buildCrewMap({ captain, columns: [col('s', '秋招小队长', { project: '秋招', taskId: 'T-s', subCaptain: true, state: 'working' })], tasks: [] });
  assert.deepEqual([flagged.nodes[0].leader, flagged.nodes[0].crew], [true, 0]);
});

test('小队长分层: a crew whose 小队长 is archived out of sight stands on its own under 队长; a loop in the records is cut', () => {
  const map = C.buildCrewMap({
    captain,
    columns: [col('k1', '打包 macOS', { captainCrew: false, taskId: 'T-k1', parentTaskId: 'T-lead', state: 'working' })],
    archived: [{ id: 'lead', title: '发版小队长', provider: 'Claude', model: 'Opus 5.5', captainCrew: true, project: 'agentdeck', taskId: 'T-lead', archivedAt: 5, lastReceipt: { summary: '交接给队长', explicit: true } }],
    tasks: [],
  });
  assert.deepEqual(map.nodes.map((n) => [n.id, n.parent, n.depth, n.project]), [['k1', '', 0, 'agentdeck']]);
  assert.deepEqual(map.edges.filter((e) => e.type === 'dispatch').map((e) => e.to), ['k1']);
  // shown with the archive, it is back under its 小队长
  const all = C.buildCrewMap({ ...squadInput(), showArchived: true, columns: [col('k1', '打包 macOS', { captainCrew: false, taskId: 'T-k1', parentTaskId: 'T-lead', state: 'working' })],
    archived: [{ id: 'lead', title: '发版小队长', captainCrew: true, project: 'agentdeck', taskId: 'T-lead', archivedAt: 5 }], tasks: [] });
  assert.equal(all.nodes.find((n) => n.id === 'k1').parent, 'lead');
  // two records naming each other: neither hangs under the other forever
  const loop = C.buildCrewMap({ captain, tasks: [], columns: [
    col('a', 'A', { project: 'p', taskId: 'T-a', parentTaskId: 'T-b', state: 'working' }), col('b', 'B', { project: 'p', taskId: 'T-b', parentTaskId: 'T-a', state: 'working' })] });
  assert.equal(loop.nodes.filter((n) => !n.parent).length, 1);
  assert.ok(C.layout(loop, { ...ROOM, caps: { p: 2 } }).nodes.size === 2);
});

test('小队长分层 layout: the 小队长 heads its column, its crew a step in under it (theirs a step more), the rest beside; a pocket under each 小队长, a line down its step to each of its crew', () => {
  const map = C.buildCrewMap(squadInput());
  const opts = { ...ROOM, rails: true, railX: 8, entryTop: 20, headH: 68 };
  const lay = C.layout(map, { ...opts, caps: { agentdeck: 2 } });
  const b = (id) => lay.nodes.get(id);
  const step = ROOM.nodeH + ROOM.rowGap;
  // the 小队长's block fills column one, depth first: 小队长, 打包 macOS, its 签名公证, 打包 Windows, 写更新说明
  assert.deepEqual(['lead', 'k1', 'g1', 'k2', 'k3'].map((id) => (b(id).y - b('lead').y) / step), [0, 1, 2, 3, 4]);
  assert.deepEqual(['lead', 'k1', 'g1', 'k2', 'k3'].map((id) => b(id).x - b('lead').x), [0, 24, 48, 24, 24]);
  assert.deepEqual(['lead', 'k1', 'g1'].map((id) => b(id).w), [ROOM.nodeW, ROOM.nodeW - 32, ROOM.nodeW - 64]);
  // the other session stands in the next column, level with the 小队长
  assert.equal(b('w1').y, b('lead').y);
  assert.equal(b('w1').x, b('lead').x + ROOM.nodeW + ROOM.gapX);
  const g = lay.groups[0];
  assert.equal(g.h, opts.headH + 4 * step + ROOM.nodeH + ROOM.padBottom, 'five rows: the 小队长 and its four');
  // pockets: the 小队长's from halfway down its card to under its last one, and 打包 macOS's inside it
  assert.deepEqual(C.pockets(lay).map((p) => [p.id, p.depth, p.x, p.y, p.w, p.h]), [
    ['lead', 0, b('lead').x, b('lead').y + ROOM.nodeH / 2, ROOM.nodeW, b('k3').y + ROOM.nodeH + 6 - (b('lead').y + ROOM.nodeH / 2)],
    ['k1', 1, b('k1').x, b('k1').y + ROOM.nodeH / 2, b('k1').w, b('g1').y + ROOM.nodeH + 6 - (b('k1').y + ROOM.nodeH / 2)],
  ]);
  const routes = C.routes(map, lay, opts);
  const squad = routes.filter((r) => r.type === 'squad');
  assert.deepEqual(squad.map((r) => `${r.from}>${r.to}`).sort(), ['k1>g1', 'lead>k1', 'lead>k2', 'lead>k3']);
  squad.forEach((r) => {
    const l = b(r.from), c = b(r.to);
    assert.deepEqual(r.points[0], [l.x + 12, l.y + l.h], 'out of the bottom of the 小队长, in the middle of the step');
    assert.deepEqual(r.points[r.points.length - 1], [c.x - 2, c.y + 20], 'into the side of its crew member, where every card is entered');
    assert.ok(r.points.every(([x]) => x >= l.x && x <= l.x + l.w), 'inside the 小队长\'s own column');
  });
  assert.match(squad.find((r) => r.to === 'k3').cls, /\bst-input\b/);
  assert.deepEqual(routes.filter((r) => r.type === 'dispatch').map((r) => r.to).sort(), ['lead', 'w1']);
  // one column: the same block, the other session under it
  const one = C.layout(map, { ...opts, caps: { agentdeck: 1 } });
  assert.deepEqual(['lead', 'k1', 'g1', 'k2', 'k3', 'w1'].map((id) => (one.nodes.get(id).y - one.nodes.get('lead').y) / step), [0, 1, 2, 3, 4, 5]);
});

test('小队长分层 and 智能一页: a 小队长\'s block is one column, so a project of one 小队长 and its crew stays one card wide', () => {
  const map = C.buildCrewMap({ captain, tasks: [], columns: [
    col('lead', '秋招小队长', { project: '秋招', taskId: 'T-lead', state: 'working' }),
    ...[1, 2, 3].map((i) => col('k' + i, '投递 ' + i, { captainCrew: false, taskId: 'T-k' + i, parentTaskId: 'T-lead', state: 'working' })),
    ...[1, 2].map((i) => col('o' + i, '其他 ' + i, { project: 'other', state: 'working' })),
  ] });
  const plan = C.planPage(map, { w: 4000, h: 2400 }, PAGE);
  assert.deepEqual(plan.caps, { 秋招: 1, other: 1 });
  const lay = C.layout(map, { ...PAGE, lanes: plan.lanes, caps: plan.caps });
  assert.equal(new Set(['lead', 'k1', 'k2', 'k3'].map((id) => lay.nodes.get(id).y)).size, 4, 'four rows: the 小队长 and its three');
});

test('智能一页 shows a map that fits as large as its page holds it: up to 140% of its own 100%, down to 80%, centred', () => {
  const FIT = C.BASE_SCALE, limits = { min: FIT * C.PAGE_MIN_SCALE, max: FIT * C.PAGE_MAX_SCALE }, inset = { top: 8, right: 8, bottom: 8, left: 8 };
  assert.equal(C.PAGE_MAX_SCALE, 1.4);
  // the user's 2.0.0 map (about 1640 x 752 at the drawn size) on a 14-inch MacBook's page (1260 x 814): it fills the
  // page across, a little past 100%, with the room to spare split above and below
  const wide = C.computeFit({ left: 0, top: 0, right: 1640, bottom: 752 }, { w: 1260, h: 814 }, inset, limits);
  assert.ok(Math.abs(wide.scale * 1640 - (1260 - 16)) < 1e-6, String(wide.scale));
  assert.ok(wide.scale > FIT && wide.scale < FIT * 1.4);
  assert.ok(Math.abs((wide.y - 8) - (814 - 8 - (wide.y + 752 * wide.scale))) < 1e-6, 'centred down');
  // a small map stops at 140%; one a little too big for the page comes down to 80% and no further
  assert.equal(C.computeFit({ left: 0, top: 0, right: 400, bottom: 300 }, { w: 1260, h: 814 }, inset, limits).scale, FIT * 1.4);
  assert.equal(C.computeFit({ left: 0, top: 0, right: 3000, bottom: 752 }, { w: 1260, h: 814 }, inset, limits).scale, FIT * 0.8);
});

// The 小队长 fields as the 小队长 branch writes them (agentdeck/t-24f65178 @5289170): the 小队长's column has
// subCaptain: true; each session it opens has subCaptainId = its column id, deleted when that session is handed
// back to 队长. Otherwise they are 队长's crew like any other: a card in 队长's list, the 小队长's project.
const official = (extra = {}) => ({
  captain,
  columns: [
    col('sub', '秋招小队长', { project: '秋招', subCaptain: true, state: 'working' }),
    col('k1', 'Lenovo GFLP 简历改写', { project: '秋招', subCaptainId: 'sub', state: 'working' }),
    col('k2', 'JD 抓取：AI PM 岗位 40 条', { project: '秋招', subCaptainId: 'sub', state: 'done' }),
    col('k3', '面试准备包：STAR 故事库', { project: '秋招', subCaptainId: 'sub', state: 'done' }),
    col('w1', '投递记录表', { project: '秋招', state: 'working' }),
  ],
  tasks: [
    task('t-sub', 'sub', 'working', 10), task('t-k1', 'k1', 'working', 20),
    task('t-k2', 'k2', 'done', 30, { receipt: { summary: '40 条 JD 已去重，表格交给小队长。', files: [], explicit: true } }),
    task('t-k3', 'k3', 'asking', 40, { receipt: { question: '自我介绍要中英双语各一版吗？', files: [] } }),
    task('t-w1', 'w1', 'working', 50),
  ],
  ...extra,
});

test('小队长 (its own fields): subCaptainId names the live 小队长 a session reports to; its crew hang under it, ask it and hand back to it', () => {
  const map = C.buildCrewMap(official());
  const node = (id) => map.nodes.find((n) => n.id === id);
  assert.deepEqual(['k1', 'k2', 'k3', 'w1'].map((id) => [node(id).parent, node(id).depth]), [['sub', 1], ['sub', 1], ['sub', 1], ['', 0]]);
  assert.deepEqual([node('sub').leader, node('sub').crew, node('w1').leader], [true, 3, false]);
  const of = (type) => map.edges.filter((e) => e.type === type).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(of('dispatch'), ['cap>sub', 'cap>w1']);
  assert.deepEqual(of('squad'), ['sub>k1', 'sub>k2', 'sub>k3']);
  // what they hand back or ask goes to the 小队长: no line back to 队长, and the question is the 小队长's to answer
  assert.deepEqual(of('return'), []);
  assert.equal(node('k2').line, '40 条 JD 已去重，表格交给小队长。');
  assert.deepEqual([node('k3').status, node('k3').detail, node('k3').line], ['input', '在问小队长', '提问：自我介绍要中英双语各一版吗？']);
  // laid out like any 小队长: its block heads the frame, its crew a step in under it
  const lay = C.layout(map, { ...ROOM, caps: { 秋招: 2 } }), b = (id) => lay.nodes.get(id);
  assert.deepEqual(['k1', 'k2', 'k3'].map((id) => [b(id).x - b('sub').x, b(id).y > b('sub').y]), [[24, true], [24, true], [24, true]]);
  assert.equal(C.pockets(lay).length, 1);
});

test('小队长 (its own fields): only a live column marked subCaptain leads: unmarked, archived, gone, itself or handed back, the session stands under 队长', () => {
  const columns = official().columns;
  const flat = (map) => map.nodes.every((n) => !n.parent) && !map.edges.some((e) => e.type === 'squad');
  // the flag is what makes a 小队长
  assert.ok(flat(C.buildCrewMap(official({ columns: columns.map((c) => (c.id === 'sub' ? { ...c, subCaptain: false } : c)) }))));
  // archived (its column is no longer live; the app hands its crew back to 队长 then), or gone
  const sub = columns.find((c) => c.id === 'sub');
  assert.ok(flat(C.buildCrewMap(official({ columns: columns.filter((c) => c !== sub), archived: [{ ...sub, archivedAt: 5 }], showArchived: true }))));
  assert.ok(flat(C.buildCrewMap(official({ columns: columns.filter((c) => c !== sub) }))));
  // a 小队长 naming itself leads nobody
  assert.equal(C.buildCrewMap({ captain, tasks: [], columns: [col('x', 'X', { project: 'p', subCaptain: true, subCaptainId: 'x', state: 'working' })] }).nodes[0].parent, '');
  // handed back (subCaptainId deleted): under 队长 again, and the 小队长 leads one fewer
  const back = C.buildCrewMap(official({ columns: columns.map((c) => (c.id === 'k1' ? { ...c, subCaptainId: undefined } : c)) }));
  assert.deepEqual([back.nodes.find((n) => n.id === 'k1').parent, back.nodes.find((n) => n.id === 'sub').crew], ['', 2]);
  assert.ok(back.edges.some((e) => e.type === 'dispatch' && e.to === 'k1'));
  // create-child's records still count alongside (parentTaskId)
  const both = C.buildCrewMap(official({ columns: [...columns, col('g1', '签名公证', { captainCrew: false, taskId: 'T-g1', parentTaskId: 'T-k1', state: 'working' }), ...[]].map((c) => (c.id === 'k1' ? { ...c, taskId: 'T-k1' } : c)) }));
  assert.deepEqual([both.nodes.find((n) => n.id === 'g1').parent, both.nodes.find((n) => n.id === 'g1').depth, both.nodes.find((n) => n.id === 'g1').project], ['k1', 2, '秋招']);
});
