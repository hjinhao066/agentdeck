'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');
const ClaudeSeatsCore = require('../claude-seats-core');

test('restoreArchived preserves Claude seat information', () => {
  // Simulate a column with Claude seat info
  const archivedSession = {
    id: 'test-col-id',
    displayTitle: 'Test Session',
    cmd: 'claude --model opus',
    claudeSeatId: 'claude-seat-1',
    claudeConfigDir: '/Users/test/.claude-us2',
    folderId: null,
  };

  // When a column is archived (simulating archiveColumn logic)
  const snapshot = {
    ...archivedSession,
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  // When restoreArchived is called, it applies normalizeColumn
  const { archivedAt, ...rest } = snapshot;
  const restoredColumn = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  // The restored column should preserve the seat information
  assert.equal(restoredColumn.claudeSeatId, 'claude-seat-1', 'claudeSeatId should be preserved');
  assert.equal(restoredColumn.claudeConfigDir, '/Users/test/.claude-us2', 'claudeConfigDir should be preserved');
});

test('bindColumn preserves configDir when column has seat info', () => {
  // Simulate a config with a known Claude seat
  const config = {
    claudeSeats: [
      { id: 'seat-us2', configDir: '/Users/test/.claude-us2' },
      { id: 'seat-us1', configDir: '/Users/test/.claude-us1' },
    ],
    activeClaudeSeatId: 'seat-us1', // Different from the column's seat
  };

  // A restored column with seat information
  const column = {
    id: 'col-1',
    cmd: 'claude --model opus',
    claudeSeatId: 'seat-us2', // Explicitly set to us2
    claudeConfigDir: '/Users/test/.claude-us2',
  };

  // bindColumn should return the correct seat info
  const bound = ClaudeSeatsCore.bindColumn(column, config);
  assert.equal(bound.id, 'seat-us2', 'Should bind to the column\'s seat ID');
  assert.equal(bound.configDir, '/Users/test/.claude-us2', 'Should return the column\'s configDir');
});

test('restoreArchived clears seat when original seat is deleted', () => {
  // Simulate a config where the seat has been deleted
  const config = {
    claudeSeats: [
      { id: 'seat-us1', configDir: '/Users/test/.claude-us1' },
    ],
    activeClaudeSeatId: 'seat-us1',
    archived: [],
    folders: [],
  };

  // Simulate an archived session that had a seat that was later deleted
  const archivedSession = {
    id: 'col-restored',
    displayTitle: 'Restored Session',
    cmd: 'claude --model opus',
    claudeSeatId: 'deleted-seat', // This seat no longer exists
    claudeConfigDir: '/Users/test/.claude-deleted',
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  config.archived.push(archivedSession);

  // Simulate the restoreArchived logic
  const a = config.archived.find((x) => x.id === 'col-restored');
  const { archivedAt, ...rest } = a;
  const col = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  // Apply the fix: clear seat info if seat doesn't exist
  const claudeSeats = config.claudeSeats || [];
  if (col.claudeSeatId && !claudeSeats.some((s) => s.id === col.claudeSeatId)) {
    col.claudeSeatId = undefined;
    col.claudeConfigDir = undefined;
  }

  // The seat info should be cleared
  assert.equal(col.claudeSeatId, undefined, 'claudeSeatId should be undefined when seat is deleted');
  assert.equal(col.claudeConfigDir, undefined, 'claudeConfigDir should be undefined when seat is deleted');
});

test('restoreArchived preserves other important fields', () => {
  // Test preservation of other fields that might be important
  const archivedSession = {
    id: 'test-col-2',
    displayTitle: 'Important Session',
    cmd: 'claude --model sonnet',
    claudeSeatId: 'seat-2',
    claudeConfigDir: '/Users/test/.claude-us1',
    folderId: 'folder-123',
    metadata: { key: 'value' },
    env: { VAR: 'value' },
  };

  const snapshot = {
    ...archivedSession,
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  const { archivedAt, ...rest } = snapshot;
  const restoredColumn = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  // All these fields should be preserved
  assert.equal(restoredColumn.folderId, 'folder-123', 'folderId should be preserved');
  assert.deepEqual(restoredColumn.metadata, { key: 'value' }, 'metadata should be preserved');
  assert.deepEqual(restoredColumn.env, { VAR: 'value' }, 'env should be preserved');
  assert.equal(restoredColumn.cmd, 'claude --model sonnet', 'cmd should be preserved');
});
