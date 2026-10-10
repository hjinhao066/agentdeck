'use strict';

// 队伍 map, 3.1 (星河流光): what the user approved in the mockups and keeps — inside a frame, what still runs or waits
// on the user on top and what has ended below on a row of its own; a working card dated by its latest progress report;
// every project a fixed colour slot it keeps; the leftmost column's line running down the frame's own left edge.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../crew-map-core');

const captain = { id: 'cap', title: '队长', alive: true, state: 'done', provider: 'Claude', model: 'Opus 5.5' };
const col = (id, title, extra) => ({ id, title, alive: true, state: 'done', live: '', provider: 'Claude', model: 'Opus 5.5', lastReceipt: null, captainCrew: true, ...extra });
const task = (id, colId, status, sentAt, extra) => ({ id, colId, title: id, status, sentAt, receipt: null, ...extra });
const RAILS = { nodeW: 280, nodeH: 110, captainW: 440, captainH: 112, gapX: 24, clusterGap: 32, fanY: 48, gapY: 20, pad: 16, padX: 16, padBottom: 16, rowGap: 12, reviewGap: 36, headH: 68, grid: true, center: true, tray: true, rails: true, railX: 8, entryTop: 20, collapsedProjects: {} };

test('a working card is dated by its latest progress report; before any, by its start, then by when it was sent', () => {
  const columns = ['a', 'b', 'c'].map((id) => col(id, id, { project: 'P', state: 'working' }));
  const tasks = [task('ta', 'a', 'working', 100, { startedAt: 200, progressAt: 900 }), task('tb', 'b', 'working', 100, { startedAt: 300 }), task('tc', 'c', 'working', 400)];
  const map = C.buildCrewMap({ captain, columns, tasks });
  assert.deepEqual(['a', 'b', 'c'].map((id) => map.nodes.find((n) => n.id === id).activity), [900, 300, 400]);
});

// one project, every state; the order the frame stands them in, top to bottom (one card wide)
function oneFrame(caps) {
  const now = 10_000_000;
  const rows = [
    ['done-old', 'done', { doneAt: now - 9000 }], ['work-old', 'working', { startedAt: now - 8000, progressAt: now - 7000 }],
    ['failed', 'failed', { doneAt: now - 6000 }], ['asking', 'asking', {}], ['queued', 'queued', {}],
    ['work-high', 'working', { startedAt: now - 9500, progressAt: now - 9000 }], ['work-new', 'working', { startedAt: now - 5000, progressAt: now - 100 }],
    ['done-new', 'done', { doneAt: now - 1000 }],
  ];
  const columns = rows.map(([id, st]) => col(id, id, { project: 'P', state: st === 'working' ? 'working' : st === 'asking' ? 'input' : st === 'queued' ? 'plain' : 'done', important: id === 'work-high' }));
  const tasks = rows.map(([id, st, extra], i) => task('t-' + id, id, st, now - 20000 + i, extra));
  const map = C.buildCrewMap({ captain, columns, tasks, isPriority: (c) => !!c.important });
  const lay = C.layout(map, { ...RAILS, caps: { P: caps } });
  const g = lay.groups.find((x) => x.key === 'P');
  const order = [...lay.nodes].filter(([, b]) => b.project === 'P').sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([id]) => id);
  return { lay, g, order };
}

test('inside a frame: waiting on an answer, working (高优 first, then the latest progress), queued, failed — then what has ended, newest first', () => {
  const { order } = oneFrame(1);
  assert.deepEqual(order, ['asking', 'work-high', 'work-new', 'work-old', 'queued', 'failed', 'done-new', 'done-old']);
});

test('the ended group starts on a row of its own, a hairline between the groups, and the frame grows by that gap only', () => {
  const two = oneFrame(2);
  const rowOf = (id) => two.lay.nodes.get(id).y;
  // six open cards in two columns fill three rows; the two ended ones start a fourth
  assert.ok(rowOf('done-new') > rowOf('failed') && rowOf('done-new') > rowOf('queued'));
  assert.equal(rowOf('done-new'), rowOf('done-old'));
  assert.ok(two.g.split > 0, 'the frame says where the hairline goes');
  const lastOpen = Math.max(...['asking', 'work-high', 'work-new', 'work-old', 'queued', 'failed'].map(rowOf));
  const splitY = two.g.y + two.g.split;
  assert.ok(splitY > lastOpen + RAILS.nodeH && splitY < rowOf('done-new'), 'the hairline sits in the gap between the groups');
  // a frame with nothing ended has no hairline
  const columns = ['a', 'b'].map((id) => col(id, id, { project: 'Q', state: 'working' }));
  const map = C.buildCrewMap({ captain, columns, tasks: [task('ta', 'a', 'working', 1), task('tb', 'b', 'working', 2)] });
  assert.equal(C.layout(map, RAILS).groups.find((x) => x.key === 'Q').split, 0);
});

test('colour slots: handed out smallest first, kept by each project, a free slot preferred over one another project remembers', () => {
  const s1 = C.assignSlots(['agentdeck', 'health', '秋招'], {});
  assert.deepEqual(s1, { agentdeck: 1, health: 2, '秋招': 3 });
  // agentdeck left the map: its slot stays remembered, the newcomer takes a free one
  const s2 = C.assignSlots(['health', '秋招', 'hermes'], s1);
  assert.equal(s2.hermes, 4);
  assert.equal(s2.agentdeck, 1, 'a project off the map keeps its colour for when it comes back');
  assert.deepEqual(C.assignSlots(['agentdeck', 'health'], s2), { ...s2 });
  // case and spaces do not split a project
  assert.equal(C.assignSlots([' AgentDeck '], s1).agentdeck, 1);
  // every slot remembered by someone off the map: the newcomer takes the smallest, and that memory is let go
  const full = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
  const s3 = C.assignSlots(['g'], full);
  assert.equal(s3.g, 1);
  assert.equal(s3.a, undefined);
  // seven at once: the seventh gets slot 7, which wears the first colour again
  const s4 = C.assignSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g'], {});
  assert.equal(s4.g, 7);
  assert.equal(C.projectColor('g', s4), 'var(--pc-1)');
  assert.equal(C.projectColor('c', s4), 'var(--pc-3)');
  assert.equal(C.projectColor('nobody', s4), 'var(--pc-0)');
});

test('the remembered table stays small: at most 24 projects, the longest-unseen let go first', () => {
  let table = {};
  for (let i = 0; i < 40; i++) table = C.assignSlots(['p' + i], table);
  assert.ok(Object.keys(table).length <= 24);
  assert.ok('p39' in table && !('p0' in table));
});

test('rails: the leftmost column hangs off a line down the frame\'s own left edge; the other columns keep their lines in the gaps', () => {
  const columns = [...Array.from({ length: 4 }, (_, i) => col('a' + i, 'a' + i, { project: 'A', state: 'working' })), col('b0', 'b0', { project: 'B', state: 'working' })];
  const map = C.buildCrewMap({ captain, columns, tasks: [] });
  const lay = C.layout(map, { ...RAILS, caps: { A: 2 } });
  const routes = C.routes(map, lay, { clusterGap: 32, gapX: RAILS.gapX });
  for (const r of routes.filter((x) => x.type === 'dispatch')) {
    const b = lay.nodes.get(r.to), g = lay.groups.find((x) => x.key === r.project);
    const leftmost = [...lay.nodes.values()].filter((n) => n.project === r.project).every((n) => n.x >= b.x - 0.5);
    assert.deepEqual(r.points.at(-1), [b.x - 2, b.y + 20], `${r.to}: enters the card's left edge by its status row`);
    assert.equal(r.points.at(-2)[0], leftmost ? g.x + C.RAIL_EDGE : b.x - 8, `${r.to}: ${leftmost ? 'the frame edge' : 'its own column\'s rail'}`);
  }
});

test('the colour slots are saved with the map and checked on load', () => {
  const saved = C.normalizeSaved({ projectSlots: { agentdeck: 1, health: 2, bad: 0, worse: 'x', ['x'.repeat(200)]: 3 } });
  assert.deepEqual(saved.projectSlots, { agentdeck: 1, health: 2 });
  assert.deepEqual(C.normalizeSaved({}).projectSlots, {});
});
