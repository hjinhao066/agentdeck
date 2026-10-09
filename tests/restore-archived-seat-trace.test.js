'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');
const ClaudeSeatsCore = require('../claude-seats-core');

test('trace: seat info through archive and restore flow', () => {
  // Step 1: Simulate creating a column with us2 seat
  const originalColumn = {
    id: 'test-col-1',
    displayTitle: 'Test Session',
    cmd: 'claude --model opus',
    claudeSeatId: 'us2',
    claudeConfigDir: '/Users/test/.claude-us2',
    role: 'manual',
    relationship: 'Independent manual terminal',
  };

  console.log('Step 1 - Original column:');
  console.log(`  claudeSeatId: ${originalColumn.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${originalColumn.claudeConfigDir}`);

  // Step 2: Archive the column (simulating archiveColumn)
  const snapshot = {
    ...originalColumn,
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  console.log('\nStep 2 - Archived snapshot:');
  console.log(`  claudeSeatId: ${snapshot.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${snapshot.claudeConfigDir}`);

  // Step 3: Restore the column (simulating restoreArchived)
  const { archivedAt, ...rest } = snapshot;
  const restoredColumn = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  console.log('\nStep 3 - After normalizeColumn:');
  console.log(`  claudeSeatId: ${restoredColumn.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${restoredColumn.claudeConfigDir}`);

  // Step 4: Bind the column to a seat (simulating buildColumn's ptySpawn)
  const config = {
    claudeSeats: [
      { id: 'us2', configDir: '/Users/test/.claude-us2' },
      { id: 'cn', configDir: '/Users/test/.claude' },
    ],
    activeClaudeSeatId: 'cn', // Active seat is cn, not us2
  };

  const boundSeat = ClaudeSeatsCore.bindColumn(restoredColumn, config);

  console.log('\nStep 4 - After bindColumn:');
  console.log(`  boundSeat.id: ${boundSeat.id}`);
  console.log(`  boundSeat.configDir: ${boundSeat.configDir}`);

  // Verify the flow
  assert.equal(restoredColumn.claudeSeatId, 'us2', 'After restore, should have us2 seat id');
  assert.equal(restoredColumn.claudeConfigDir, '/Users/test/.claude-us2', 'After restore, should have us2 config dir');
  assert.equal(boundSeat.id, 'us2', 'ptySpawn should receive us2 seat id');
  assert.equal(boundSeat.configDir, '/Users/test/.claude-us2', 'ptySpawn should receive us2 config dir');

  console.log('\n✓ All values preserved through the flow');
});

test('trace: seat info loss when column has no claudeSeatId initially', () => {
  // This simulates a column that wasn't originally created with explicit seat info
  const archiveSnapshot = {
    id: 'test-col-2',
    displayTitle: 'Old Session',
    cmd: 'claude --model opus',
    // Note: no claudeSeatId or claudeConfigDir!
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  console.log('\nOld column without explicit seat info:');
  console.log(`  claudeSeatId: ${archiveSnapshot.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${archiveSnapshot.claudeConfigDir}`);

  // After restore
  const { archivedAt, ...rest } = archiveSnapshot;
  const restoredColumn = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  console.log('\nAfter normalizeColumn:');
  console.log(`  claudeSeatId: ${restoredColumn.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${restoredColumn.claudeConfigDir}`);

  // After bindColumn with active seat being 'cn'
  const config = {
    claudeSeats: [
      { id: 'us2', configDir: '/Users/test/.claude-us2' },
      { id: 'cn', configDir: '/Users/test/.claude' },
    ],
    activeClaudeSeatId: 'cn',
  };

  const boundSeat = ClaudeSeatsCore.bindColumn(restoredColumn, config);

  console.log('\nAfter bindColumn (will use active seat cn):');
  console.log(`  boundSeat.id: ${boundSeat.id}`);
  console.log(`  boundSeat.configDir: ${boundSeat.configDir}`);

  assert.equal(boundSeat.id, 'cn', 'Will bind to active seat cn');
  assert.equal(boundSeat.configDir, '/Users/test/.claude', 'Will use cn config dir');

  console.log('\n✓ Without explicit seat info, falls back to active seat (this is the problem)');
});
