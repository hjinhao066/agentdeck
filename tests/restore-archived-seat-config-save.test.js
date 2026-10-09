'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('seat info persists through saveConfig/loadConfig cycle for archived columns', () => {
  // Simulate a column with seat info
  const col = {
    id: 'test-col-1',
    displayTitle: 'Test Session',
    cmd: 'claude --model opus',
    claudeSeatId: 'us2',
    claudeConfigDir: '/Users/test/.claude-us2',
    role: 'manual',
    relationship: 'Independent manual terminal',
    cwd: '/Users/test/project',
  };

  console.log('Original column:');
  console.log(`  claudeSeatId: ${col.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${col.claudeConfigDir}`);

  // Simulate archiveColumn saving to config.archived
  const snapshot = {
    ...col,
    role: 'manual',
    relationship: 'Independent manual terminal',
    archivedAt: Date.now(),
  };

  // Simulate config object
  const config = {
    archived: [snapshot],
    columns: [],
    folders: [],
    claudeSeats: [
      { id: 'us2', configDir: '/Users/test/.claude-us2' },
      { id: 'cn', configDir: '/Users/test/.claude' },
    ],
    activeClaudeSeatId: 'cn',
  };

  console.log('\nArchived in config:');
  const archived = config.archived[0];
  console.log(`  claudeSeatId: ${archived.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${archived.claudeConfigDir}`);

  // Simulate saveConfig/loadConfig (JSON serialization round-trip)
  const jsonString = JSON.stringify(config);
  const loadedConfig = JSON.parse(jsonString);

  console.log('\nAfter JSON round-trip:');
  const archivedAfterLoad = loadedConfig.archived[0];
  console.log(`  claudeSeatId: ${archivedAfterLoad.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${archivedAfterLoad.claudeConfigDir}`);

  // Verify that seat info survives
  assert.equal(archivedAfterLoad.claudeSeatId, 'us2', 'Seat ID should be preserved through JSON');
  assert.equal(archivedAfterLoad.claudeConfigDir, '/Users/test/.claude-us2', 'Config dir should be preserved through JSON');
  assert.equal(archivedAfterLoad.activeClaudeSeatId, undefined, 'activeClaudeSeatId should not exist in archived item');

  console.log('\n✓ Seat info preserved through config save/load cycle');
});

test('problem scenario: column created without explicit seat info gets default on restore', () => {
  // This simulates an old column that was created before seat support was added
  const oldColumn = {
    id: 'test-col-2',
    displayTitle: 'Old Session',
    cmd: 'claude --model opus',
    // No claudeSeatId or claudeConfigDir!
    role: 'manual',
    relationship: 'Independent manual terminal',
    cwd: '/Users/test/project',
  };

  console.log('\n\nOld column (no explicit seat):');
  console.log(`  claudeSeatId: ${oldColumn.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${oldColumn.claudeConfigDir}`);

  // When archived
  const snapshot = {
    ...oldColumn,
    archivedAt: Date.now(),
  };

  const config = {
    archived: [snapshot],
    claudeSeats: [
      { id: 'us2', configDir: '/Users/test/.claude-us2' },
      { id: 'cn', configDir: '/Users/test/.claude' },
    ],
    activeClaudeSeatId: 'cn',
  };

  // After JSON round-trip and restore
  const loadedConfig = JSON.parse(JSON.stringify(config));
  const archivedCol = loadedConfig.archived[0];

  console.log('\nRestored column:');
  console.log(`  claudeSeatId: ${archivedCol.claudeSeatId}`);
  console.log(`  claudeConfigDir: ${archivedCol.claudeConfigDir}`);

  // This is the problem: when bindColumn is called, it will use activeClaudeSeatId as default
  assert.equal(archivedCol.claudeSeatId, undefined, 'Old columns have no seat info');
  assert.equal(archivedCol.claudeConfigDir, undefined, 'Old columns have no config dir');

  console.log('\n✓ Old columns without seat info will use active seat (cn) when restored - THIS IS THE PROBLEM');
  console.log('  If cn was not logged in, it will report "Not logged in"');
});

test('the real problem: session might run in wrong seat if config was modified', () => {
  // Start: user creates column with --seat us2 at some point
  // Somehow, the column's claudeSeatId doesn't get saved to config
  // Later: user tells it, it gets restored without seat info, uses active seat instead

  console.log('\n\nREAL SCENARIO:');
  console.log('1. User starts: claude --seat us2 session');
  console.log('2. Column is created. Question: is claudeSeatId saved to config?');
  console.log('3. User archives the session');
  console.log('4. Config is saved. Question: does it include claudeSeatId?');
  console.log('5. User tells the session with: tell --to <id> ...');
  console.log('6. Session is restored from config. Question: is claudeSeatId there?');
  console.log('7. If no, ptySpawn receives active seat (cn) instead of us2');
  console.log('8. If cn is not logged in, process reports "Not logged in"');

  console.log('\nConclusion: Need to trace where claudeSeatId is set when column is created');
});
