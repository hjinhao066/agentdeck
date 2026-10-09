'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');

test('receipt routing: child session receipts route to parent before Captain', () => {
  // Setup: main captain, sub-captain with parentTaskId, and child of sub-captain
  const mainCaptain = { id: 'captain', isMain: true, taskId: 'main-task' };
  const subCaptain = { id: 'sub-captain-col', parentTaskId: 'main-task', taskId: 'sub-task', subCaptain: true };
  const childSession = { id: 'child-col', parentTaskId: 'sub-task', taskId: 'child-task' };

  const columns = [mainCaptain, subCaptain, childSession];

  // Verify parent relationships are set correctly
  assert.equal(subCaptain.parentTaskId, mainCaptain.taskId, 'Sub-captain should have main as parent');
  assert.equal(childSession.parentTaskId, subCaptain.taskId, 'Child should have sub-captain as parent');

  // Test: find parent session for a given session
  function findParentSession(col, cols) {
    if (!col.parentTaskId) return null;
    return cols.find((c) => c.taskId === col.parentTaskId);
  }

  const childParent = findParentSession(childSession, columns);
  assert.ok(childParent, 'Child should have a parent');
  assert.equal(childParent.taskId, subCaptain.taskId, 'Child parent should be sub-captain');

  const subCaptainParent = findParentSession(subCaptain, columns);
  assert.ok(subCaptainParent, 'Sub-captain should have a parent');
  assert.equal(subCaptainParent.taskId, mainCaptain.taskId, 'Sub-captain parent should be main');

  const mainParent = findParentSession(mainCaptain, columns);
  assert.equal(mainParent, null, 'Main captain should have no parent');

  // Test: receipt routing function
  function receiptRoutingTarget(col, cols) {
    // If col has a parent, receipt goes to parent first
    if (col.parentTaskId) {
      const parent = cols.find((c) => c.taskId === col.parentTaskId);
      if (parent) return parent;
    }
    // Otherwise goes to main captain
    return cols.find((c) => c.isMain);
  }

  const childTarget = receiptRoutingTarget(childSession, columns);
  assert.equal(childTarget.id, subCaptain.id, 'Child receipts should route to sub-captain');

  const subCaptainTarget = receiptRoutingTarget(subCaptain, columns);
  assert.equal(subCaptainTarget.id, mainCaptain.id, 'Sub-captain receipts should route to main');

  const mainTarget = receiptRoutingTarget(mainCaptain, columns);
  assert.equal(mainTarget.id, mainCaptain.id, 'Main receipts should stay with main');
});

test('ledger display: child sessions nested under parent', () => {
  const sessions = [
    { id: 'main', isMain: true, taskId: 'main-task', title: '队长' },
    { id: 'sub-capt', parentTaskId: 'main-task', taskId: 'sub-task', title: '项目小队长' },
    { id: 'child-1', parentTaskId: 'sub-task', taskId: 'child-task-1', title: '子任务1' },
    { id: 'child-2', parentTaskId: 'sub-task', taskId: 'child-task-2', title: '子任务2' },
  ];

  function buildHierarchy(sessions) {
    const byTaskId = new Map(sessions.map((s) => [s.taskId, s]));
    const roots = sessions.filter((s) => !s.parentTaskId || !byTaskId.has(s.parentTaskId));

    function nest(session, depth = 0) {
      const children = sessions.filter((s) => s.parentTaskId === session.taskId);
      return {
        ...session,
        depth,
        children: children.map((c) => nest(c, depth + 1)),
      };
    }

    return roots.map((r) => nest(r));
  }

  const hierarchy = buildHierarchy(sessions);
  assert.equal(hierarchy.length, 1, 'Should have one root');
  assert.equal(hierarchy[0].id, 'main', 'Root should be main');
  assert.equal(hierarchy[0].children.length, 1, 'Main should have one child');
  assert.equal(hierarchy[0].children[0].id, 'sub-capt', 'Sub-captain should be under main');
  assert.equal(hierarchy[0].children[0].children.length, 2, 'Sub-captain should have two children');
  assert.deepEqual(
    hierarchy[0].children[0].children.map((c) => c.id),
    ['child-1', 'child-2'],
    'Children should be nested correctly'
  );
});
