'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const S = require('../claude-seats-core');
const M = require('../claude-seats-main');
const { ttyFromPty } = require('../board-credentials');
// Execute the production PTY creation function with a stand-in native process.
// This verifies environment at shell birth and seat-change replacement without Electron.
function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-relay-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claudeSeats: S.normalize(), activeClaudeSeatId: 'us' }));
  const ptys = new Map(), ptySeats = new Map(), launched = [], killed = [], credentials = [];
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const body = source.slice(source.indexOf('function spawnPty('), source.indexOf('\nfunction send('));
  const context = vm.createContext({ fs, path, HOME: home, tudArg: false, app: { getPath: () => home },
    quotaWarmup: null, validId: () => true, ptys, ptySeats, ENV: { CLAUDE_CONFIG_DIR: '/inherited', CLAUDE_CODE_OAUTH_TOKEN: 'override' },
    ClaudeSeatsCore: S, credentialLocation: M.credentialLocation, initializeOnboarding: M.initializeOnboarding, seatEnvironment: M.seatEnvironment,
    ttyFromPty, writeCredentials: (...args) => credentials.push(args), removeCredentials: () => {}, crypto: require('crypto'), managedSessions: new Map(), receiptSessions: new Map(), notifications: null,
    spoolPath: () => path.join(home, 'unused'), boardControlDir: home, boardCliPath: '/fake/board.js',
    shellFile: () => '/bin/zsh', shellArgs: () => [], send: () => {}, bufferAppend: () => {}, writeSession: () => {}, ptyBuffers: new Map(),
    killPty: id => { killed.push(id); ptys.delete(id); ptySeats.delete(id); },
    pty: { spawn: (file, args, options) => { const p = { ptsName: '/dev/ttys333', onData: () => {}, onExit: () => {} }; launched.push({ file, args, options }); return p; } } });
  vm.runInContext(body, context);
  return { context, launched, killed, home, ptySeats, credentials };
}
test('Relay shell birth carries US config; CN removes inherited login overrides', t => {
  const h = harness(t);
  h.context.spawnPty('captain', h.home, 80, 24, true, 'us');
  assert.equal(h.launched[0].options.env.CLAUDE_CONFIG_DIR, path.join(h.home, '.claude-us'));
  assert.equal(h.launched[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  h.context.spawnPty('captain', h.home, 80, 24, true, 'us');
  assert.equal(h.launched.length, 1);
  h.context.spawnPty('captain', h.home, 80, 24, true, 'cn');
  assert.deepEqual(h.killed, ['captain']);
  assert.equal(h.launched[1].options.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(h.ptySeats.get('captain'), 'Claude Code-credentials');
  assert.equal(h.credentials.length, 2);
  assert.equal(h.credentials.at(-1)[1], 'captain');
  assert.equal(h.credentials.at(-1)[4], '/dev/ttys333');
});
test('legacy spawn without seat id uses the selected seat, never a default daemon', t => {
  const h = harness(t);
  h.context.spawnPty('legacy', h.home, 80, 24, false);
  assert.equal(h.launched[0].options.env.CLAUDE_CONFIG_DIR, path.join(h.home, '.claude-us'));
  assert.notEqual(h.ptySeats.get('legacy'), 'Claude Code-credentials');
});
test('reloading a legacy unbound process replaces it before using another seat', t => {
  const h = harness(t);
  h.context.ptys.set('old', {});
  h.context.spawnPty('old', h.home, 80, 24, true, 'us');
  assert.deepEqual(h.killed, ['old']);
  assert.equal(h.launched[0].options.env.CLAUDE_CONFIG_DIR, path.join(h.home, '.claude-us'));
});
