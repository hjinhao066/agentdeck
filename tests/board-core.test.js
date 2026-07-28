'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');

test('normalizes manual terminals as isolated', () => {
  const column = BoardCore.normalizeColumn({ id: 'm1', title: 'Scratch', role: 'something', parentId: 'c1' });
  assert.equal(column.role, 'manual');
  assert.equal(column.managed, false);
  assert.equal(column.parentTaskId, null);
  assert.equal(column.relationship, 'Independent manual terminal');
});

test('infers known agents and resolves commands', () => {
  assert.equal(BoardCore.inferAgentType('claude --continue'), 'Claude');
  assert.equal(BoardCore.inferAgentType('agy'), 'Antigravity');
  assert.equal(BoardCore.inferAgentType('grok -i'), 'Grok');
  assert.equal(BoardCore.commandForAgent('claude'), 'claude --dangerously-skip-permissions');
  assert.equal(BoardCore.commandForAgent('grok', 'custom-agent'), 'custom-agent');
});

test('lays out a downstream dependency graph and keeps manual terminals separate', () => {
  const layout = BoardCore.graphLayout([
    { id: 'c', taskId: 'task-c', role: 'conductor', title: 'Parent' },
    { id: 'w1', taskId: 'task-w1', role: 'worker', parentTaskId: 'task-c', title: 'Worker' },
    { id: 'w2', taskId: 'task-w2', role: 'worker', parentTaskId: 'task-w1', title: 'Downstream' },
    { id: 'm', role: 'manual', title: 'Manual' },
  ]);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('c').depth, 0);
  assert.equal(byId.get('w1').depth, 1);
  assert.equal(byId.get('w2').depth, 2);
  assert.equal(byId.get('m').lane, 'manual');
  assert.ok(byId.get('m').x > byId.get('w2').x);
  assert.deepEqual(layout.edges.map((edge) => [edge.from, edge.to]), [['task-c', 'task-w1'], ['task-w1', 'task-w2']]);
});

test('breaks malformed parent cycles instead of recursing forever', () => {
  const layout = BoardCore.graphLayout([
    { id: 'a', role: 'worker', parentId: 'b' },
    { id: 'b', role: 'worker', parentId: 'a' },
  ]);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
  assert.ok(layout.width > 0);
});

test('managed ownership permits descendants but never manual or sibling roots', () => {
  const columns = [
    { id: 'c1', taskId: 'root-1', role: 'conductor' },
    { id: 'w1', taskId: 'worker-1', role: 'worker', parentTaskId: 'root-1' },
    { id: 'w2', taskId: 'worker-2', role: 'worker', parentTaskId: 'worker-1' },
    { id: 'c2', taskId: 'root-2', role: 'conductor' },
    { id: 'm1', taskId: 'manual-1', role: 'manual' },
  ];
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[2]), true);
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[3]), false);
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[4]), false);
  assert.equal(BoardCore.taskDepth(columns, columns[2]), 2);
  assert.match(BoardCore.controlGrantError(columns, columns[2], columns[0], 8), /cycle/);
  assert.match(BoardCore.controlGrantError(columns, columns[4], columns[1], 8), /manual source/);
  assert.equal(BoardCore.controlGrantError(columns, columns[0], columns[3], 8), '');
});

test('relationship types have explicit visible state without granting implicit control', () => {
  const columns = [
    { id: 'a', taskId: 'a', role: 'manual', title: 'A' },
    { id: 'b', taskId: 'b', role: 'manual', title: 'B' },
  ];
  const dependency = BoardCore.normalizeLink({ id: 'l1', fromTaskId: 'a', toTaskId: 'b', type: 'dependency' });
  assert.equal(BoardCore.linkState(dependency, columns, { a: 'working' }), 'Blocked');
  assert.equal(BoardCore.linkState(dependency, columns, { a: 'done' }), 'Ready');
  const handoff = BoardCore.normalizeLink({ id: 'l2', fromTaskId: 'a', toTaskId: 'b', type: 'handoff', grantedControl: true });
  assert.equal(handoff.grantedControl, false);
  assert.equal(BoardCore.linkState(handoff, columns, {}), 'Channel active');
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[1]), false);
});

test('display titles remain separate from internal titles and duplicates get a clear suffix', () => {
  const columns = [
    { id: 'a', taskId: 'a', role: 'manual', title: 'auto-1', displayTitle: 'API worker' },
    { id: 'b', taskId: 'b', role: 'manual', title: 'auto-2' },
  ];
  assert.equal(BoardCore.uniqueDisplayTitle('API worker', columns, 'b'), 'API worker (2)');
  const normalized = BoardCore.normalizeColumn(columns[0]);
  assert.equal(normalized.title, 'auto-1');
  assert.equal(normalized.displayTitle, 'API worker');
});

test('managed request ownership persists while manual terminals discard it', () => {
  const managed = BoardCore.normalizeColumn({
    id: 'w',
    taskId: 'w',
    role: 'worker',
    parentTaskId: 'root',
    requestId: 'create-1',
    waitRequestIds: ['wait-1', 'wait-1', 'wait-2'],
    createdByRequestId: 'spawn-1',
  });
  assert.equal(managed.requestId, 'create-1');
  assert.deepEqual(managed.waitRequestIds, ['wait-1', 'wait-2']);
  assert.equal(managed.createdByRequestId, 'spawn-1');
  const manual = BoardCore.normalizeColumn({ ...managed, role: 'manual' });
  assert.equal(manual.requestId, null);
  assert.deepEqual(manual.waitRequestIds, []);
  assert.equal(manual.createdByRequestId, null);
});
