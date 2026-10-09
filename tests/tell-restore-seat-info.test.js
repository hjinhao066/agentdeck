'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');

/**
 * This test reproduces the real issue:
 * 1. User creates session with --seat us2
 * 2. Session gets archived with seat info in config.archived
 * 3. User tells the session (tell --to <id>)
 * 4. Session should be restored on us2, but gets cn instead
 *
 * The issue: when tell triggers restoreArchived, the restored session
 * might not have claudeSeatId set on the column object that gets passed
 * to buildColumn -> ptySpawn
 */

test('restoreArchived preserves seat info from archived config', () => {
  // Simulate a session that was created with --seat us2
  const archivedSnapshot = {
    id: 'test-session-1',
    displayTitle: 'Work Session',
    cmd: 'claude --model opus',
    claudeSeatId: 'us2',  // This was set when session was created with --seat us2
    claudeConfigDir: '/Users/test/.claude-us2',
    role: 'manual',
    relationship: 'Independent manual terminal',
    cwd: '/Users/test/work',
    archivedAt: Date.now(),
  };

  console.log('\n=== REAL PROBLEM SCENARIO ===');
  console.log('1. User created session with: new --seat us2');
  console.log('   Config should have: claudeSeatId="us2", claudeConfigDir="/Users/test/.claude-us2"');
  console.log(`   Archived has: claudeSeatId="${archivedSnapshot.claudeSeatId}", claudeConfigDir="${archivedSnapshot.claudeConfigDir}"`);

  // Simulate config with this archived session
  const config = {
    archived: [archivedSnapshot],
    claudeSeats: [
      { id: 'us2', configDir: '/Users/test/.claude-us2', name: '美国账户2' },
      { id: 'cn', configDir: '/Users/test/.claude', name: '中国账户' },
    ],
    activeClaudeSeatId: 'cn',  // Current active seat is cn
  };

  console.log('\n2. User issues: tell --to test-session-1 "做点什么"');
  console.log('   tell triggers restoreArchived');

  // Simulate restoreArchived
  const a = config.archived[0];
  const { archivedAt, ...rest } = a;

  // This is where the problem might be: normalizeColumn might not preserve seat info
  const restoredCol = BoardCore.normalizeColumn({
    ...rest,
    role: 'manual',
    relationship: 'Independent manual terminal',
    view: 'term',
  });

  console.log('\n3. After restoreArchived:');
  console.log(`   restoreArchived returns col with:`);
  console.log(`   claudeSeatId="${restoredCol.claudeSeatId}"`);
  console.log(`   claudeConfigDir="${restoredCol.claudeConfigDir}"`);

  // Now simulate buildColumn calling bindColumn
  // This is where the seat gets selected for ptySpawn
  const ClaudeSeatsCore = require('../claude-seats-core');
  const boundSeat = ClaudeSeatsCore.bindColumn(restoredCol, config);

  console.log('\n4. When buildColumn calls bindColumn, seat becomes:');
  console.log(`   id="${boundSeat.id}"`);
  console.log(`   configDir="${boundSeat.configDir}"`);

  console.log('\n5. spawnPty will use this seat to set CLAUDE_CONFIG_DIR');
  if (boundSeat.id === 'us2' && boundSeat.configDir === '/Users/test/.claude-us2') {
    console.log('   ✓ CORRECT: will use us2 seat as original');
  } else if (boundSeat.id === 'cn') {
    console.log('   ✗ PROBLEM: will use cn seat instead of us2!');
    console.log('   If cn is not logged in, will report "Not logged in"');
    throw new Error('Session restored on wrong seat! This is the real problem.');
  }

  assert.equal(restoredCol.claudeSeatId, 'us2', 'Restored column should keep us2 seat ID');
  assert.equal(restoredCol.claudeConfigDir, '/Users/test/.claude-us2', 'Restored column should keep us2 config dir');
  assert.equal(boundSeat.id, 'us2', 'ptySpawn should receive us2 seat ID');
  assert.equal(boundSeat.configDir, '/Users/test/.claude-us2', 'ptySpawn should receive us2 config dir');

  console.log('\n✓ Test passes - seat info preserved through restore');
});

test('the problem: when createSession does not preserve metadata', () => {
  // This might be the real issue: when createSession is called in renderer,
  // the metadata might not be properly passed through to the column creation

  console.log('\n\n=== POTENTIAL PROBLEM: createSession in renderer.js ===');
  console.log('When tell -> restoreArchived -> createSession?');
  console.log('Need to check if claudeSeatId is passed through the complete flow');
  console.log('to buildColumn -> bindColumn -> ptySpawn');
});
