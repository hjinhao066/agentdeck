'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { validId } = require('./security');

const TTY_NAME = /^(?:ttys[0-9]+|tty[0-9]+|pts\/[0-9]+)$/;

function credentialsDir(controlDir) {
  return path.join(controlDir, 'credentials');
}

function isTtyPath(tty) {
  return typeof tty === 'string' && /^\/dev\/(?:ttys[0-9]+|tty[0-9]+|pts\/[0-9]+)$/.test(tty);
}

function ttyKey(tty) {
  return isTtyPath(tty) ? Buffer.from(tty, 'utf8').toString('base64url') : '';
}

function ttyFromPid(pid) {
  if (process.platform === 'win32' || !pid) return '';
  try {
    const name = execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return TTY_NAME.test(name) ? `/dev/${name}` : '';
  } catch (_) { return ''; }
}

function controllingTerminal() {
  return ttyFromPid(process.pid);
}

// node-pty knows the slave path as soon as spawn returns. ps still prints ??
// for a moment, so a lookup that only uses the pid would store an unbound file.
function ttyFromPty(pty) {
  const name = pty && typeof pty.ptsName === 'string' ? pty.ptsName : '';
  return isTtyPath(name) ? name : ttyFromPid(pty && pty.pid);
}

function isManagedCopy(filename) {
  return path.basename(filename || '') === 'agentdeck-board.js' && path.basename(path.dirname(filename)) === 'tools';
}

function defaultControlDir(home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'agentdeck', 'board-control') : '';
  }
  const base = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : path.join(home, '.config');
  return path.join(base, 'agentdeck', 'board-control');
}

function clearCredentials(controlDir) {
  const dir = credentialsDir(controlDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch (_) {}
}

function removeCredentials(controlDir, id) {
  if (!controlDir || !validId(id)) return;
  const existing = readCredentials(controlDir, id);
  if (existing && existing.tty) unlinkQuiet(path.join(credentialsDir(controlDir), 'by-tty', `${ttyKey(existing.tty)}.json`));
  for (const suffix of ['.json', '.json.tmp']) unlinkQuiet(path.join(credentialsDir(controlDir), id + suffix));
}

function writeJsonPrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readJsonPrivate(file) {
  let fd;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (_) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeCredentials(controlDir, id, receiptToken, controlToken, tty) {
  if (!validId(id)) throw new Error('Invalid terminal identifier');
  if (typeof receiptToken !== 'string' || !receiptToken || typeof controlToken !== 'string') throw new Error('Invalid credential');
  const bound = isTtyPath(tty) ? tty : '';
  const previous = readCredentials(controlDir, id);
  const dir = credentialsDir(controlDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const value = { terminalId: id, receiptToken, controlToken, tty: bound };
  writeJsonPrivate(path.join(dir, `${id}.json`), value);
  if (previous && previous.tty && previous.tty !== bound) {
    unlinkQuiet(path.join(dir, 'by-tty', `${ttyKey(previous.tty)}.json`));
  }
  if (bound) writeJsonPrivate(path.join(dir, 'by-tty', `${ttyKey(bound)}.json`), { terminalId: id, tty: bound });
}

function readCredentials(controlDir, id) {
  if (!controlDir || !validId(id)) return null;
  const value = readJsonPrivate(path.join(credentialsDir(controlDir), `${id}.json`));
  if (!value || value.terminalId !== id || typeof value.receiptToken !== 'string' || !value.receiptToken
    || typeof value.controlToken !== 'string' || typeof value.tty !== 'string'
    || (value.tty && !isTtyPath(value.tty))) return null;
  return value;
}

function readCredentialsByTty(controlDir, tty) {
  const key = ttyKey(tty);
  if (!controlDir || !key) return null;
  const index = readJsonPrivate(path.join(credentialsDir(controlDir), 'by-tty', `${key}.json`));
  if (!index || index.tty !== tty || !validId(index.terminalId)) return null;
  const value = readCredentials(controlDir, index.terminalId);
  if (!value || value.tty !== tty) return null;
  return value;
}

// Receipt/control env tokens are the normal path. When this process's
// controlling terminal has a private file, that file wins: a shared Codex
// daemon keeps a stale AGENTDECK_TERMINAL_ID and must not select another
// column, or reuse a token sitting in the daemon's own environment.
// main-new stays available to a submission-only dispatcher, same as env auth.
function capabilityToken(action, receiptToken, controlToken) {
  const submission = action === 'complete' || action === 'ask' || action === 'progress' || action === 'session-exit';
  return (submission && receiptToken) || controlToken || (action === 'main-new' && receiptToken) || '';
}

function resolveBoardAuth({ env, tty, filename, action, home, platform }) {
  let controlDir = '';
  if (typeof env.AGENTDECK_CONTROL_DIR === 'string') controlDir = env.AGENTDECK_CONTROL_DIR;
  else if (isManagedCopy(filename)) controlDir = path.dirname(path.dirname(filename));
  else controlDir = defaultControlDir(home, platform);
  const file = readCredentialsByTty(controlDir, tty);
  if (file) {
    return { controlDir, token: capabilityToken(action, file.receiptToken, file.controlToken), source: 'tty' };
  }
  const envToken = capabilityToken(action, env.AGENTDECK_RECEIPT_TOKEN, env.AGENTDECK_CONTROL_TOKEN);
  if (envToken && controlDir) return { controlDir, token: envToken, source: 'env' };
  return { controlDir: controlDir || '', token: '', source: '' };
}

module.exports = {
  clearCredentials, removeCredentials, writeCredentials, readCredentials, readCredentialsByTty,
  resolveBoardAuth, controllingTerminal, ttyFromPid, ttyFromPty, isTtyPath, defaultControlDir,
  readJsonPrivate, writeJsonPrivate,
};
