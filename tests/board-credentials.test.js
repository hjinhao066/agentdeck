'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  clearCredentials, removeCredentials, writeCredentials, readCredentials, resolveBoardAuth, ttyFromPty,
} = require('../board-credentials');

const repoCli = path.resolve(__dirname, '../board-cli.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-credentials-'));
  clearCredentials(dir);
  const tools = path.join(dir, 'tools');
  fs.mkdirSync(tools);
  for (const file of ['board-cli.js', 'board-credentials.js', 'security.js']) {
    fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(tools, file === 'board-cli.js' ? 'agentdeck-board.js' : file));
  }
  return { dir, cli: path.join(tools, 'agentdeck-board.js'), file: path.join(dir, 'credentials', 'worker.json') };
}

function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
  return { ...env, ...extra };
}

test('private credentials rotate, stay bound to one tty, and are revoked on removal', () => {
  const { dir, file } = fixture();
  try {
    writeCredentials(dir, 'worker', 'first', '', '/dev/ttys11');
    assert.deepEqual(readCredentials(dir, 'worker'), { terminalId: 'worker', receiptToken: 'first', controlToken: '', tty: '/dev/ttys11' });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    writeCredentials(dir, 'worker', 'second', '', '/dev/ttys12');
    assert.equal(readCredentials(dir, 'worker').tty, '/dev/ttys12');
    assert.equal(resolveBoardAuth({ env: { AGENTDECK_CONTROL_DIR: dir }, tty: '/dev/ttys11', filename: repoCli, action: 'complete' }).token, '');
    assert.equal(resolveBoardAuth({ env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'stolen' }, tty: '/dev/ttys12', filename: repoCli, action: 'complete' }).token, 'second');
    assert.equal(resolveBoardAuth({ env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'stolen' }, tty: '/dev/ttys12', filename: repoCli, action: 'main-new' }).token, 'second');
    removeCredentials(dir, 'worker');
    assert.equal(readCredentials(dir, 'worker'), null);
    assert.equal(resolveBoardAuth({ env: { AGENTDECK_CONTROL_DIR: dir }, tty: '/dev/ttys12', filename: repoCli, action: 'complete' }).token, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a terminal id in the environment cannot select another session, and an empty control dir does not search the home profile', () => {
  const { dir } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-home-'));
  try {
    writeCredentials(dir, 'worker', 'own-receipt', '', '/dev/ttys20');
    writeCredentials(dir, 'other', 'other-receipt', 'other-control', '/dev/ttys21');
    const stale = resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_TERMINAL_ID: 'other' },
      tty: '/dev/ttys20', filename: repoCli, action: 'complete',
    });
    assert.equal(stale.token, 'own-receipt');
    assert.equal(stale.source, 'tty');
    const missingTty = resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_TERMINAL_ID: 'other' },
      tty: '', filename: repoCli, action: 'complete',
    });
    assert.equal(missingTty.token, '');
    const workerControl = resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'stolen-captain' },
      tty: '/dev/ttys20', filename: repoCli, action: 'ledger',
    });
    assert.equal(workerControl.token, '');
    const captain = resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir }, tty: '/dev/ttys21', filename: repoCli, action: 'ledger',
    });
    assert.equal(captain.token, 'other-control');
    const live = path.join(home, 'Library', 'Application Support', 'agentdeck', 'board-control');
    writeCredentials(live, 'worker', 'home-receipt', '', '/dev/ttys20');
    assert.equal(resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: '' }, tty: '/dev/ttys20', filename: repoCli, action: 'complete', home, platform: 'darwin',
    }).token, '');
    assert.equal(resolveBoardAuth({
      env: {}, tty: '/dev/ttys20', filename: repoCli, action: 'complete', home, platform: 'darwin',
    }).token, 'home-receipt');
    const managed = path.join(dir, 'tools', 'agentdeck-board.js');
    assert.equal(resolveBoardAuth({
      env: {}, tty: '/dev/ttys20', filename: managed, action: 'complete', home, platform: 'darwin',
    }).token, 'own-receipt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('environment capabilities still work when this tty has no credential file', () => {
  const { dir } = fixture();
  try {
    writeCredentials(dir, 'worker', 'file-receipt', '', '/dev/ttys30');
    assert.equal(resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'env-receipt' },
      tty: '', filename: repoCli, action: 'complete',
    }).token, 'env-receipt');
    assert.equal(resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'env-control' },
      tty: '/dev/ttys99', filename: repoCli, action: 'ledger',
    }).token, 'env-control');
    assert.equal(resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'env-receipt' },
      tty: '', filename: repoCli, action: 'main-new',
    }).token, 'env-receipt');
    assert.equal(resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_RECEIPT_TOKEN: 'env-receipt' },
      tty: '', filename: repoCli, action: 'ledger',
    }).token, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fallback refuses mismatched identities, malformed files, links and non-private files', () => {
  const { dir, file } = fixture();
  try {
    for (const value of ['{', '{}', 'null', JSON.stringify({ terminalId: 'captain', receiptToken: 'other', controlToken: 'control', tty: '' }),
      JSON.stringify({ terminalId: 'worker', receiptToken: [], controlToken: '', tty: '' }),
      JSON.stringify({ terminalId: 'worker', receiptToken: 'own', controlToken: '', tty: '/tmp/not-a-tty' }),
      'x'.repeat(4097)]) {
      fs.writeFileSync(file, value, { mode: 0o600 });
      assert.equal(readCredentials(dir, 'worker'), null);
    }
    writeCredentials(dir, 'worker', 'own', '', '/dev/ttys40');
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      assert.equal(readCredentials(dir, 'worker'), null);
      fs.unlinkSync(file);
      writeCredentials(dir, 'captain', 'other', 'control', '/dev/ttys41');
      fs.symlinkSync(path.join(dir, 'credentials', 'captain.json'), file);
      assert.equal(readCredentials(dir, 'worker'), null);
    }
    assert.throws(() => writeCredentials(dir, '../captain', 'bad', 'bad', ''), /Invalid terminal/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PTY child uses its own tty file and ignores a stale terminal id and a stolen env token', { skip: process.platform === 'win32' }, () => {
  const { dir, cli } = fixture();
  const script = path.join(dir, 'inside-pty.js');
  fs.writeFileSync(script, `
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const { writeCredentials, controllingTerminal } = require(${JSON.stringify(path.resolve(__dirname, '../board-credentials.js'))});
    const dir = process.argv[2];
    const cli = process.argv[3];
    const tty = controllingTerminal();
    if (!tty) { process.stderr.write('no tty\\n'); process.exit(2); }
    writeCredentials(dir, 'worker', 'own-receipt', '', tty);
    writeCredentials(dir, 'other', 'other-receipt', 'other-control', '/dev/ttys1');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
    env.AGENTDECK_CONTROL_DIR = dir;
    env.AGENTDECK_TERMINAL_ID = 'other';
    env.AGENTDECK_RECEIPT_TOKEN = 'stolen';
    execFileSync(process.execPath, [cli, 'session-exit', '--code', '7'], { env, stdio: 'ignore' });
    const name = fs.readdirSync(path.join(dir, 'requests')).find((file) => file.endsWith('.json'));
    const request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', name), 'utf8'));
    if (request.token !== 'own-receipt' || request.code !== 7) {
      process.stderr.write(JSON.stringify(request) + '\\n');
      process.exit(1);
    }
    process.stdout.write('pty-ok ' + tty + '\\n');
  `);
  const py = `
import os, pty, sys
script, control, cli = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", script, control, cli])
out = b""
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
sys.stdout.buffer.write(out)
`;
  try {
    const result = spawnSync('python3', ['-c', py, script, dir, cli], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /pty-ok \/dev\/(?:ttys\d+|pts\/\d+)/);
    removeCredentials(dir, 'worker');
    const denied = resolveBoardAuth({
      env: { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_TERMINAL_ID: 'other', AGENTDECK_RECEIPT_TOKEN: '' },
      tty: '/dev/ttys1', filename: repoCli, action: 'complete',
    });
    assert.equal(denied.token, 'other-receipt');
    assert.equal(resolveBoardAuth({
      env: cleanEnv({ AGENTDECK_CONTROL_DIR: dir, AGENTDECK_TERMINAL_ID: 'other' }),
      tty: '', filename: repoCli, action: 'complete',
    }).token, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new pty is bound by its slave path before ps reports a controlling terminal', { skip: process.platform === 'win32' }, () => {
  const pty = require('node-pty');
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-c', 'sleep 1'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env,
  });
  try {
    assert.equal(ttyFromPty({ ptsName: p.ptsName, pid: p.pid }), p.ptsName);
    assert.match(ttyFromPty(p), /^\/dev\/(?:ttys\d+|pts\/\d+)$/);
    assert.equal(ttyFromPty({ ptsName: 'not-a-tty', pid: 0 }), '');
  } finally { try { p.kill(); } catch (_) {} }
});
