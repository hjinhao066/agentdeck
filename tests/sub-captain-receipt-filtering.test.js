'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('receipt filtering: sub-captain only sees child receipts', () => {
  // Setup: receipts are routed based on parentColId
  // - If parentColId is not set: goes to main captain (owner is root)
  // - If parentColId is set: goes to that parent's captain (owner has a parent)
  const mainCaptainState = {
    pending: [
      // Receipt from main captain's direct task (no parentColId)
      { receiptId: 'r1', colId: 'main', taskId: 'main-task-1', title: 'Main task 1' },
      // Receipt from sub-captain's direct work (no parentColId because sub-cap IS the parent for its children)
      { receiptId: 'r2', colId: 'sub-cap', taskId: 'sub-captain-task', title: 'Sub-captain work' },
      // Receipt from child of sub-captain (has parentColId pointing to sub-cap)
      { receiptId: 'r3', colId: 'child1', taskId: 'child-task-1', title: 'Child 1', parentColId: 'sub-cap' },
      // Another receipt from child of sub-captain
      { receiptId: 'r4', colId: 'child2', taskId: 'child-task-2', title: 'Child 2', parentColId: 'sub-cap' },
      // Receipt from another sub-captain's child (has different parentColId)
      { receiptId: 'r5', colId: 'child3', taskId: 'child-task-3', title: 'Child 3 (other sub)', parentColId: 'other-sub' },
    ],
  };

  const columns = [
    { id: 'main', isMain: true, taskId: 'main-task', cmd: 'claude' },
    { id: 'sub-cap', parentTaskId: 'main-task', taskId: 'sub-task', subCaptain: true, cmd: 'claude' },
    { id: 'child1', parentTaskId: 'sub-task', taskId: 'child-task-1', cmd: 'claude' },
    { id: 'child2', parentTaskId: 'sub-task', taskId: 'child-task-2', cmd: 'claude' },
    { id: 'other-sub', parentTaskId: 'main-task', taskId: 'other-sub-task', subCaptain: true, cmd: 'claude' },
    { id: 'child3', parentTaskId: 'other-sub-task', taskId: 'child-task-3', cmd: 'claude' },
  ];

  // Filter receipts for a given column
  function filterReceiptsForColumn(callerCol, receipts) {
    // If caller is a sub-captain: only see receipts where parentColId === callerId (child receipts)
    if (callerCol.parentTaskId) {
      return receipts.filter((r) => r.parentColId === callerCol.id);
    }
    // If caller is the main captain: only see receipts with NO parentColId (root receipts)
    return receipts.filter((r) => !r.parentColId);
  }

  // Main captain sees: receipts with no parentColId (r1, r2)
  const mainReceipts = filterReceiptsForColumn(
    { id: 'main', isMain: true },
    mainCaptainState.pending
  );
  assert.deepEqual(
    mainReceipts.map((r) => r.receiptId).sort(),
    ['r1', 'r2'],
    'Main captain should see: receipts with no parentColId (r1=own, r2=sub-captain direct work)'
  );

  // Sub-captain sees: receipts where parentColId === 'sub-cap' (r3, r4)
  const subCapReceipts = filterReceiptsForColumn(
    { id: 'sub-cap', parentTaskId: 'main-task' },
    mainCaptainState.pending
  );
  assert.deepEqual(
    subCapReceipts.map((r) => r.receiptId).sort(),
    ['r3', 'r4'],
    'Sub-captain should see: child receipts with parentColId=sub-cap (r3, r4)'
  );

  // Other sub-captain sees: receipts where parentColId === 'other-sub' (r5)
  const otherSubReceipts = filterReceiptsForColumn(
    { id: 'other-sub', parentTaskId: 'main-task' },
    mainCaptainState.pending
  );
  assert.deepEqual(
    otherSubReceipts.map((r) => r.receiptId),
    ['r5'],
    'Other sub-captain should see: child receipt with parentColId=other-sub (r5)'
  );

  // Child should NOT see any receipts (children don't receive them, they generate them)
  const childReceipts = filterReceiptsForColumn(
    { id: 'child1', parentTaskId: 'sub-task' },
    mainCaptainState.pending
  );
  assert.deepEqual(
    childReceipts.map((r) => r.receiptId),
    [],
    'Child should not see any receipts'
  );
});
