'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Capture only process ids and executable names, never terminal command lines.
// The Bash shell can outlive its agent, so monitoring only process.ppid is insufficient.
function agentOwnerPid() {
  try {
    let entries;
    if (process.platform === 'win32') {
      entries = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
        .map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name }));
    } else {
      entries = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')
        .map((line) => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return match && { pid: Number(match[1]), parent: Number(match[2]), name: match[3] }; }).filter(Boolean);
    }
    const processes = new Map(entries.map((p) => [p.pid, p]));
    let pid = process.ppid;
    for (let count = 0; pid > 1 && count < 20; count++) {
      const entry = processes.get(pid);
      if (!entry) break;
      if (/^(?:claude|codex|cursor-agent|gemini|grok)(?:\.exe)?$/i.test(path.basename(entry.name))) return pid;
      pid = entry.parent;
    }
  } catch (_) {}
  return 0;
}

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function leasePath(dir, token) {
  return path.join(dir, 'receipt-listeners', crypto.createHash('sha256').update(token).digest('hex') + '.json');
}
function instancePath(dir) { return path.join(dir, 'receipt-listener-instance.json'); }
function initialize(dir) {
  fs.rmSync(path.join(dir, 'receipt-listeners'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'receipt-listeners'), { recursive: true, mode: 0o700 });
  const instance = { id: crypto.randomBytes(16).toString('hex'), pid: process.pid };
  const file = instancePath(dir), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(instance), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return instance;
}
function sameLease(value, lease) {
  return value && value.id === lease.id && value.pid === lease.pid && value.instanceId === lease.instanceId && value.ownerPid === lease.ownerPid;
}
function releasePath(file, lease) { return file + '.' + lease.id + '.released'; }
function released(file, lease) { return sameLease(read(releasePath(file, lease)), lease); }
function removeLease(file, lease) {
  // Called only by the application, the sole writer that removes lease paths.
  // CLI processes can publish an absent path, but never unlink/replace one.
  if (sameLease(read(file), lease)) { try { fs.unlinkSync(file); } catch (_) {} }
  try { fs.unlinkSync(releasePath(file, lease)); } catch (_) {}
}

// The lock belongs to a capability generation, never to a reusable column id.
// No process is signalled: an old CLI detects its revoked lease and exits itself.
function claim(dir, token, ownerPid = 0) {
  const instance = read(instancePath(dir));
  if (!instance || !alive(instance.pid)) throw new Error('AgentDeck receipt listener host is not running.');
  const file = leasePath(dir, token);
  const lease = { id: crypto.randomBytes(16).toString('hex'), pid: process.pid, instanceId: instance.id, ...(ownerPid ? { ownerPid } : {}) };
  const tmp = file + '.' + lease.id + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  let locallyReleased = false;
  try {
    // Publish a fully written lease atomically: concurrent claimers cannot
    // mistake an empty/partial write for a stale lock.
    fs.linkSync(tmp, file);
    return {
      lease,
      valid: () => {
        const current = read(instancePath(dir));
        return !locallyReleased && current?.id === instance.id && current?.pid === instance.pid && alive(instance.pid)
          && (!ownerPid || alive(ownerPid)) && sameLease(read(file), lease);
      },
      release: () => {
        if (locallyReleased) return;
        locallyReleased = true;
        if (!sameLease(read(file), lease)) return;
        // A nonce-specific tombstone cannot remove a replacement lease.
        try { fs.writeFileSync(releasePath(file, lease), JSON.stringify(lease), { flag: 'wx', mode: 0o600 }); } catch (_) {}
      },
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

function retiring(dir, token) {
  const file = leasePath(dir, token), lease = read(file);
  if (!lease) return true; // The app may have reaped it just after claim returned EEXIST.
  return released(file, lease) || !alive(lease.pid) || lease.ownerPid && !alive(lease.ownerPid);
}

function createRegistry(dir, instance, onStatus, now = Date.now, pidAlive = alive) {
  const listeners = new Map(), statuses = new Map();
  function owns(entry) {
    return entry && entry.lease.instanceId === instance.id && pidAlive(entry.lease.pid)
      && (!entry.lease.ownerPid || pidAlive(entry.lease.ownerPid))
      && !released(entry.file, entry.lease)
      && sameLease(read(entry.file), entry.lease) && now() - entry.seenAt < 30_000;
  }
  function remove(id) {
    const entry = listeners.get(id);
    if (entry) removeLease(entry.file, entry.lease);
    listeners.delete(id); statuses.delete(id);
  }
  return {
    reap(tokens) {
      // Also covers a CLI that dies before its first authenticated poll.
      for (const token of tokens) {
        const file = leasePath(dir, token), existed = fs.existsSync(file), lease = read(file);
        if (!lease) { if (existed) { try { fs.unlinkSync(file); } catch (_) {} } }
        else if (lease.instanceId !== instance.id || !pidAlive(lease.pid) || lease.ownerPid && !pidAlive(lease.ownerPid) || released(file, lease)) removeLease(file, lease);
        // A delayed old release can only leave its own nonce marker behind.
        const current = read(file), prefix = path.basename(file) + '.';
        for (const name of fs.readdirSync(path.dirname(file))) {
          if (!name.startsWith(prefix) || !name.endsWith('.released')) continue;
          const marker = path.join(path.dirname(file), name);
          if (!sameLease(read(marker), current || {})) { try { fs.unlinkSync(marker); } catch (_) {} }
        }
      }
    },
    register(id, token, lease) {
      if (!lease || typeof lease.id !== 'string' || !/^[a-f0-9]{32}$/.test(lease.id) || !Number.isSafeInteger(lease.pid)) return false;
      const entry = { file: leasePath(dir, token), lease, seenAt: now() };
      if (!owns(entry)) return false;
      const current = listeners.get(id);
      if (current && current.lease.id !== lease.id && owns(current)) return false;
      listeners.set(id, entry);
      return true;
    },
    tick(captains) {
      const ids = new Set(captains);
      for (const id of listeners.keys()) if (!ids.has(id)) remove(id);
      for (const id of statuses.keys()) if (!ids.has(id)) statuses.delete(id);
      for (const id of ids) {
        const entry = listeners.get(id), live = !!owns(entry);
        if (entry && !live) { removeLease(entry.file, entry.lease); listeners.delete(id); }
        const previous = statuses.get(id);
        if (!previous || previous.alive !== live || now() - previous.at >= 10_000) {
          statuses.set(id, { alive: live, at: now() });
          onStatus(id, live);
        }
      }
    },
    remove,
    dispose() {
      for (const id of listeners.keys()) remove(id);
      try { fs.unlinkSync(instancePath(dir)); } catch (_) {}
      fs.rmSync(path.join(dir, 'receipt-listeners'), { recursive: true, force: true });
    },
  };
}

module.exports = { initialize, claim, createRegistry, alive, agentOwnerPid, retiring };
