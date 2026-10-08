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
function leasePrefix(token) { return crypto.createHash('sha256').update(token).digest('hex') + '.'; }
function leasePath(dir, token, lease) {
  return path.join(dir, 'receipt-listeners', leasePrefix(token) + lease.id + '.json');
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
  return !!value && value.id === lease.id && value.pid === lease.pid && value.instanceId === lease.instanceId && value.ownerPid === lease.ownerPid;
}
function releasePath(file, lease) { return file + '.' + lease.id + '.released'; }
function released(file, lease) { return sameLease(read(releasePath(file, lease)), lease); }
function removeLease(file, lease) {
  // Called only by the application, the sole writer that removes lease paths.
  // Each CLI owns a nonce path; an old release never removes a newer listener.
  if (sameLease(read(file), lease)) { try { fs.unlinkSync(file); } catch (_) {} }
  try { fs.unlinkSync(releasePath(file, lease)); } catch (_) {}
  try { fs.unlinkSync(file + '.superseded'); } catch (_) {}
  try { fs.unlinkSync(file + '.expired'); } catch (_) {}
}

// The lock belongs to a capability generation, never to a reusable column id.
// No process is signalled: an old CLI detects its revoked lease and exits itself.
const SUPERSEDED_NOTICE = '【AgentDeck 监听】已有更新的回执监听在运行，这个旧监听已自动退出。不要为它重挂。';
const EXPIRED_NOTICE = '【AgentDeck 监听】这个回执监听超过 30 秒没被 AgentDeck 收到轮询（常见原因：电脑睡眠或 AgentDeck 卡住），登记已过期，监听已退出。请重新挂一个 receipts --wait。';
function claim(dir, token, ownerPid = 0) {
  const instance = read(instancePath(dir));
  if (!instance || !alive(instance.pid)) throw new Error('AgentDeck receipt listener host is not running.');
  const lease = { id: crypto.randomBytes(16).toString('hex'), pid: process.pid, instanceId: instance.id, ...(ownerPid ? { ownerPid } : {}) };
  const file = leasePath(dir, token, lease), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
  let locallyReleased = false;
  try {
    // Publish a complete independent candidate. Only the authenticated host's
    // first registration decides its order; process clocks and claim timing do not.
    fs.linkSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  const generationAlive = () => {
    const current = read(instancePath(dir));
    return !locallyReleased && current?.id === instance.id && current?.pid === instance.pid && alive(instance.pid)
      && (!ownerPid || alive(ownerPid)) && sameLease(read(file), lease);
  };
  return {
    lease,
    superseded: () => generationAlive() && sameLease(read(file + '.superseded'), lease),
    // The host stopped hearing from this listener (see createRegistry): it leaves and says so.
    expired: () => generationAlive() && sameLease(read(file + '.expired'), lease),
    valid: () => generationAlive() && !sameLease(read(file + '.superseded'), lease) && !sameLease(read(file + '.expired'), lease),
    release: () => {
      if (locallyReleased) return;
      locallyReleased = true;
      if (!sameLease(read(file), lease)) return;
      try { fs.writeFileSync(releasePath(file, lease), JSON.stringify(lease), { flag: 'wx', mode: 0o600 }); } catch (_) {}
    },
  };
}

function createRegistry(dir, instance, onStatus, now = Date.now, pidAlive = alive) {
  const listeners = new Map(), statuses = new Map(), registered = new Map();
  let sequence = 0;
  function owns(entry) {
    return entry && entry.lease.instanceId === instance.id && pidAlive(entry.lease.pid)
      && (!entry.lease.ownerPid || pidAlive(entry.lease.ownerPid))
      && !released(entry.file, entry.lease)
      && !sameLease(read(entry.file + '.superseded'), entry.lease)
      && sameLease(read(entry.file), entry.lease) && now() - entry.seenAt < 30_000;
  }
  // Only the age is wrong: process, host, release and supersession are all fine.
  function stale(entry) {
    return entry && entry.lease.instanceId === instance.id && pidAlive(entry.lease.pid)
      && (!entry.lease.ownerPid || pidAlive(entry.lease.ownerPid))
      && !released(entry.file, entry.lease)
      && !sameLease(read(entry.file + '.superseded'), entry.lease)
      && sameLease(read(entry.file), entry.lease) && now() - entry.seenAt >= 30_000;
  }
  function candidates(token) {
    return fs.readdirSync(path.join(dir, 'receipt-listeners'))
      .filter((name) => name.startsWith(leasePrefix(token)) && name.endsWith('.json'))
      .map((name) => path.join(dir, 'receipt-listeners', name));
  }
  function remove(id, token) {
    const entry = listeners.get(id);
    const capability = token || entry?.token;
    if (capability) for (const file of candidates(capability)) {
      const lease = read(file);
      if (lease) removeLease(file, lease);
    }
    listeners.delete(id); statuses.delete(id);
  }
  return {
    reap(tokens) {
      // Also covers a CLI that dies before its first authenticated poll.
      for (const token of tokens) for (const file of candidates(token)) {
        const lease = read(file);
        if (!lease) { try { fs.unlinkSync(file); } catch (_) {} }
        else if (lease.instanceId !== instance.id || !pidAlive(lease.pid) || lease.ownerPid && !pidAlive(lease.ownerPid) || released(file, lease)) removeLease(file, lease);
      }
      for (const name of fs.readdirSync(path.join(dir, 'receipt-listeners'))) {
        if (!name.endsWith('.released') && !name.endsWith('.superseded') && !name.endsWith('.expired')) continue;
        const marker = path.join(dir, 'receipt-listeners', name);
        const file = marker.replace(/(?:\.[a-f0-9]{32}\.released|\.superseded|\.expired)$/, '');
        if (!sameLease(read(marker), read(file) || {})) { try { fs.unlinkSync(marker); } catch (_) {} }
      }
    },
    register(id, token, lease) {
      if (!lease || typeof lease.id !== 'string' || !/^[a-f0-9]{32}$/.test(lease.id) || !Number.isSafeInteger(lease.pid)) return false;
      const entry = { file: leasePath(dir, token, lease), token, lease, seenAt: now() };
      if (!owns(entry)) return false;
      let seq = registered.get(entry.file);
      if (seq === undefined) registered.set(entry.file, seq = ++sequence);
      entry.seq = seq;
      const current = listeners.get(id);
      if (current && current.lease.id !== lease.id && owns(current)) {
        if (current.seq > seq) return false;
        fs.writeFileSync(current.file + '.superseded', JSON.stringify(current.lease), { mode: 0o600 });
      }
      listeners.set(id, entry);
      return true;
    },
    isCurrent(id, lease) {
      const entry = listeners.get(id);
      return sameLease(entry?.lease, lease) && owns(entry);
    },
    tick(captains) {
      const ids = new Set(captains);
      for (const id of listeners.keys()) if (!ids.has(id)) remove(id);
      for (const id of statuses.keys()) if (!ids.has(id)) statuses.delete(id);
      for (const id of ids) {
        const entry = listeners.get(id), live = !!owns(entry);
        if (entry && !live) {
          // A listener that merely went quiet is told why: its lease stays, marked, until it releases.
          if (stale(entry)) fs.writeFileSync(entry.file + '.expired', JSON.stringify(entry.lease), { mode: 0o600 });
          else removeLease(entry.file, entry.lease);
          listeners.delete(id);
        }
        const previous = statuses.get(id);
        if (!previous || previous.alive !== live || now() - previous.at >= 10_000) {
          statuses.set(id, { alive: live, at: now() });
          onStatus(id, live);
        }
      }
    },
    remove,
    // The machine slept: no listener could have polled meanwhile, so none counts as abandoned.
    wake() { const t = now(); for (const entry of listeners.values()) entry.seenAt = t; },
    dispose() {
      for (const id of listeners.keys()) remove(id);
      try { fs.unlinkSync(instancePath(dir)); } catch (_) {}
      fs.rmSync(path.join(dir, 'receipt-listeners'), { recursive: true, force: true });
    },
  };
}

module.exports = { initialize, claim, createRegistry, alive, agentOwnerPid, SUPERSEDED_NOTICE, EXPIRED_NOTICE };
