'use strict';

const fs = require('fs');
const path = require('path');
const { validId } = require('./security');

function credentialsDir(controlDir) {
  return path.join(controlDir, 'credentials');
}

function clearCredentials(controlDir) {
  const dir = credentialsDir(controlDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
}

function removeCredentials(controlDir, id) {
  if (!controlDir || !validId(id)) return;
  for (const suffix of ['.json', '.json.tmp']) {
    try { fs.unlinkSync(path.join(credentialsDir(controlDir), id + suffix)); } catch (_) {}
  }
}

function writeCredentials(controlDir, id, receiptToken, controlToken) {
  if (!validId(id)) throw new Error('Invalid terminal identifier');
  const dir = credentialsDir(controlDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${id}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ terminalId: id, receiptToken, controlToken }), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readCredentials(controlDir, id) {
  if (!controlDir || !validId(id)) return null;
  let fd;
  try {
    const file = path.join(credentialsDir(controlDir), `${id}.json`);
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) return null;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.terminalId !== id || typeof value.receiptToken !== 'string' || !value.receiptToken ||
        typeof value.controlToken !== 'string') return null;
    return value;
  } catch (_) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { clearCredentials, removeCredentials, writeCredentials, readCredentials };
