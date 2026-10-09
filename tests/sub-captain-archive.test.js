'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('archive handling: child sessions transfer back to main captain', () => {
  // Setup state
  const mainState = {
    pending: [
      { receiptId: 'r1', colId: 'main', taskId: 'main-task-1' },
      { receiptId: 'r2', colId: 'sub-cap', taskId: 'sub-captain-task' },
      { receiptId: 'r3', colId: 'child1', taskId: 'child-task-1', parentColId: 'sub-cap' },
      { receiptId: 'r4', colId: 'child2', taskId: 'child-task-2', parentColId: 'sub-cap' },
    ],
  };

  const columns = [
    { id: 'main', isMain: true, taskId: 'main-task', cmd: 'claude' },
    { id: 'sub-cap', parentTaskId: 'main-task', taskId: 'sub-task', subCaptain: true, cmd: 'claude' },
    { id: 'child1', parentTaskId: 'sub-task', taskId: 'child-task-1', cmd: 'claude' },
    { id: 'child2', parentTaskId: 'sub-task', taskId: 'child-task-2', cmd: 'claude' },
  ];

  const id = 'sub-cap';
  const col = columns.find((c) => c.id === id);

  const childSessions = col && col.subCaptain
    ? columns.filter((c) => c.parentTaskId === col.taskId)
    : [];

  const childReceipts = mainState.pending.filter((p) => {
    const session = columns.find((c) => c.id === p.colId);
    return session && session.parentTaskId === col.taskId;
  });

  // Apply the corrected archive logic
  const s = { pending: [...mainState.pending] };
  const childReceiptIds = new Set(childReceipts.map((r) => r.receiptId));
  s.pending = s.pending.filter((p) => p.colId !== id && !childReceiptIds.has(p.receiptId));

  assert.equal(s.pending.length, 1, 'After filtering: only main receipt remains');

  // Create new receipt objects for children without parentColId
  const transferredReceipts = childReceipts.map((r) => {
    const { parentColId, ...rest } = r;
    return rest;
  });

  // Add transferred receipts back
  s.pending.push(...transferredReceipts);

  assert.equal(s.pending.length, 3, 'After adding transferred: 1 main + 2 child');

  // Add handoff notification
  s.pending.push({
    taskId: 'sub-captain-handoff-' + Date.now(),
    colId: 'main',
    title: '小队长已结束',
    summary: `「项目小队长」已结束，下属 ${childSessions.length} 个工作线条已转移回你；「子任务1」、「子任务2」。`,
    source: 'captain-handoff'
  });

  assert.equal(s.pending.length, 4, 'After adding handoff notification: 1 main + 2 child + 1 handoff');

  // Verify no receipts have parentColId
  const withParent = s.pending.filter((r) => r.parentColId !== undefined);
  assert.equal(withParent.length, 0, 'No receipts should have parentColId');

  // Verify main captain can see these receipts (no parentColId filtering)
  const mainCanSee = s.pending.filter((r) => !r.parentColId);
  assert.equal(mainCanSee.length, 4, 'Main captain should see all 4 receipts');
});
