'use strict';
// Only quota/model fields and masked account identity leave this module.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const Q = require('./quota-core');
const { accountIdentity } = require('./quota-codex');
async function tail(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, limit), start = stat.size - size;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, start);
    const text = buf.toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') + 1) : text, at: stat.mtimeMs };
  } finally { await handle.close(); }
}
async function readLocal(home, codexHome = path.join(home, '.codex'), now = Date.now(), seatConfig) {
  const observations = [];
  for (const seat of Q.claudeSeats(seatConfig)) {
    const dir = seat.configDir.startsWith('~/') ? path.join(home, seat.configDir.slice(2)) : seat.configDir;
    if (!path.isAbsolute(dir)) continue;
    const seatInfo = { seatId: seat.id, configDir: seat.configDir };
    let identity = {};
    const profile = path.resolve(dir) === path.join(home, '.claude') ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
    try {
      if ((await fs.stat(profile)).size <= 2 * 1024 * 1024) {
        const account = JSON.parse(await fs.readFile(profile, 'utf8')).oauthAccount;
        identity = accountIdentity(account?.emailAddress);
        if (typeof account?.accountUuid === 'string' && account.accountUuid) {
          identity.legacyAccountKey = identity.accountKey;
          identity.accountKey = crypto.createHash('sha256').update(account.accountUuid).digest('hex').slice(0, 16);
        }
        if (identity.account) observations.push({ provider: 'Claude', scope: 'claude', at: now, identityOnly: true, ...seatInfo, ...identity });
      }
    } catch (_) {}
    let latest = null;
    const caches = ['agentdeck-usage.json', 'usage-cache.json', 'usage.json', path.join('.cache', 'ccstatusline', 'usage.json')].map((name) => path.join(dir, name));
    // Backward compatibility applies only to the unconfigured single seat.
    if (seat.id === 'default') caches.push(path.join(home, '.cache', 'ccstatusline', 'usage.json'));
    for (const file of caches) {
      try {
        if (seat.id !== 'default') {
          const real = await fs.realpath(file), root = await fs.realpath(dir);
          if (!real.startsWith(root + path.sep)) continue; // Never follow a cache linked to another seat.
        }
        const data = await tail(file, 16384), parsed = JSON.parse(data.text);
        // Directory locality alone is insufficient after /login replaces the
        // account in that directory. Unbound legacy caches remain unknown.
        if (seat.id !== 'default' && (!identity.accountKey || parsed.accountKey !== identity.accountKey || path.resolve(parsed.configDir || '.') !== path.resolve(dir))) continue;
        // feat/claude-seats records /usage with the original observation time.
        // Copying/touching that cache must not refresh an old percentage/reset.
        const at = Array.isArray(parsed.windows) ? parsed.at : data.at;
        const q = Number.isFinite(at) ? Q.cacheClaude(parsed, at) : null;
        if (q && now - q.at <= Q.FRESH_MS && (!latest || q.at > latest.at)) latest = { ...q, ...seatInfo, ...identity, accountBound: seat.id !== 'default', source: seat.id === 'default' && file === caches.at(-1) ? q.source : 'Claude 席位本地用量缓存' };
      } catch (_) {}
    }
    if (latest) observations.push(latest);
  }
  // These profile metadata fields contain no credentials. Tokens and all other
  // fields are discarded; neither settings nor raw JSON leave this reader.
  for (const [provider, file, field, emailKey] of [
    ['Cursor', path.join(home, '.cursor', 'cli-config.json'), 'authInfo', 'email'],
  ]) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) continue;
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      const identity = accountIdentity(data[field]?.[emailKey]);
      if (identity.account) observations.push({ provider, scope: Q.SCOPES[provider], at: now, identityOnly: true, ...identity });
    } catch (_) {}
  }
  try {
    const data = await tail(path.join(home, '.gemini', 'antigravity-cli', 'agy_statusline_debug.json'), 65536);
    const parsed = JSON.parse(data.text);
    const q = Q.cacheAntigravity(parsed, data.at);
    if (q) Object.assign(q, accountIdentity(parsed.email));
    if (q && now - q.at <= Q.FRESH_MS) observations.push(q);
  } catch (_) {}
  // Recent daily folders only, at most 8 logs and 1 MB from each. This is a
  // bounded asynchronous read, not a recursive scan of conversation history.
  const files = [];
  for (let day = 0; day < 2; day++) {
    const d = new Date(now - day * 86400000);
    const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).slice(-256)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry.name), stat = await fs.stat(file);
        if (now - stat.mtimeMs <= Q.FRESH_MS) files.push({ file, at: stat.mtimeMs });
      }
    } catch (_) {}
  }
  let latest = null;
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(0, 8)) {
    try {
      const data = await tail(file, 1024 * 1024);
      for (const line of data.text.split('\n').reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let q;
        try { q = Q.cacheCodex(JSON.parse(line)); } catch (_) { continue; }
        if (q && now - q.at <= Q.FRESH_MS && (!latest || q.at > latest.at)) latest = q;
        if (q) break;
      }
    } catch (_) {}
  }
  if (latest) observations.push(latest);
  return observations;
}
module.exports = { readLocal };
