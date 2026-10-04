'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { clearCredentials, removeCredentials, writeCredentials, readCredentials } = require('../board-credentials');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-credentials-'));
  clearCredentials(dir);
  const tools = path.join(dir, 'tools');
  fs.mkdirSync(tools);
  for (const file of ['board-cli.js', 'board-credentials.js', 'security.js']) {
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(tools, file === 'board-cli.js' ? 'agentdeck-board.js' : file));
  }
  const cli = path.join(tools, 'agentdeck-board.js');
  return { dir, cli, file: path.join(dir, 'credentials', 'worker.json') };
}

function run(cli, env, args = ['session-exit', '--code', '7']) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
  return spawnSync(process.execPath, [cli, ...args], { env: { ...clean, ...env }, encoding: 'utf8', timeout: 3000 });
}

test('private credentials rotate and are revoked on removal and app startup', () => {
  const { dir, file } = fixture();
  try {
    writeCredentials(dir, 'worker', 'first', '');
    assert.deepEqual(readCredentials(dir, 'worker'), { terminalId: 'worker', receiptToken: 'first', controlToken: '' });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    writeCredentials(dir, 'worker', 'second', '');
    assert.equal(readCredentials(dir, 'worker').receiptToken, 'second');
    removeCredentials(dir, 'worker');
    assert.equal(readCredentials(dir, 'worker'), null);
    writeCredentials(dir, 'worker', 'third', '');
    clearCredentials(dir);
    assert.equal(readCredentials(dir, 'worker'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('copied CLI uses only the identified terminal file when bridge tokens and directory are filtered', () => {
  const { dir, cli } = fixture();
  try {
    writeCredentials(dir, 'worker', 'own-receipt', '');
    writeCredentials(dir, 'captain', 'captain-receipt', 'captain-control');
    assert.equal(run(cli, { AGENTDECK_TERMINAL_ID: 'worker' }).status, 0);
    const requests = path.join(dir, 'requests');
    const file = fs.readdirSync(requests)[0];
    const request = JSON.parse(fs.readFileSync(path.join(requests, file), 'utf8'));
    assert.equal(request.token, 'own-receipt');
    assert.equal(request.code, 7);
    for (const id of ['', 'missing', '../captain', '/captain', 'worker/../../captain', 'CON']) {
      const result = run(cli, { AGENTDECK_TERMINAL_ID: id });
      assert.equal(result.status, 1, id);
      assert.match(result.stderr, /This terminal is independent/);
    }
    assert.equal(run(cli, { AGENTDECK_TERMINAL_ID: 'worker' }, ['ledger']).status, 1);
    assert.equal(fs.readdirSync(requests).length, 1, 'denied commands create no request');
    removeCredentials(dir, 'worker');
    assert.equal(run(cli, { AGENTDECK_TERMINAL_ID: 'worker' }).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('environment capabilities take precedence over file fallback, including stale values', () => {
  const { dir, cli } = fixture();
  try {
    writeCredentials(dir, 'worker', 'file-receipt', 'file-control');
    for (const env of [{ AGENTDECK_RECEIPT_TOKEN: 'env-receipt' }, { AGENTDECK_CONTROL_TOKEN: 'env-control' }]) {
      assert.equal(run(cli, { AGENTDECK_TERMINAL_ID: 'worker', AGENTDECK_CONTROL_DIR: dir, ...env }).status, 0);
    }
    const tokens = fs.readdirSync(path.join(dir, 'requests')).map((file) => JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8')).token);
    assert.deepEqual(tokens.sort(), ['env-control', 'env-receipt']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fallback refuses mismatched identities, malformed files, links and non-private files', () => {
  const { dir, file } = fixture();
  try {
    for (const value of ['{', '{}', 'null', JSON.stringify({ terminalId: 'captain', receiptToken: 'other', controlToken: 'control' }),
      JSON.stringify({ terminalId: 'worker', receiptToken: [], controlToken: '' }), 'x'.repeat(4097)]) {
      fs.writeFileSync(file, value, { mode: 0o600 });
      assert.equal(readCredentials(dir, 'worker'), null);
    }
    writeCredentials(dir, 'worker', 'own', '');
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      assert.equal(readCredentials(dir, 'worker'), null);
      fs.unlinkSync(file);
      writeCredentials(dir, 'captain', 'other', 'control');
      fs.symlinkSync(path.join(dir, 'credentials', 'captain.json'), file);
      assert.equal(readCredentials(dir, 'worker'), null);
    }
    assert.throws(() => writeCredentials(dir, '../captain', 'bad', 'bad'), /Invalid terminal/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
