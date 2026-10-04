'use strict';
// Subscription metadata only. Credentials never leave this main-process module
// except as authentication to the fixed Anthropic HTTPS origin below.
const fs = require('fs/promises');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');
const { createHash } = require('crypto');
const S = require('./claude-seats-core');
const M = require('./claude-seats-main');
const Q = require('./quota-core');
const INTERVAL_MS = 5 * 60_000;
const MAX_BYTES = 64 * 1024;
async function readCredentials(seat, home, platform = process.platform, exec = execFile) {
  const loc = M.credentialLocation(seat, home);
  // Even the default seat must not borrow another directory's credentials.
  for (const file of [loc.dir, loc.metadataPath, loc.credentialsPath]) {
    try { if ((await fs.lstat(file)).isSymbolicLink()) return null; }
    catch (e) { if (e.code !== 'ENOENT') return null; }
  }
  let raw;
  if (platform === 'darwin') {
    raw = await new Promise((resolve) => {
      // Capture stdout in memory; never use a shell, log stderr or return errors.
      const account = /^[a-zA-Z0-9._-]+$/.test(os.userInfo().username) ? os.userInfo().username : 'claude-code-user';
      exec('/usr/bin/security', ['find-generic-password', '-a', account, '-s', loc.keychainService, '-w'],
        { timeout: 2000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout));
    });
  }
  if (!raw) {
    const handle = await fs.open(loc.credentialsPath, 'r');
    try {
      if ((await handle.stat()).size > MAX_BYTES) return null;
      raw = await handle.readFile('utf8');
    } finally { await handle.close(); }
  }
  const auth = JSON.parse(raw)?.claudeAiOauth;
  if (typeof auth?.accessToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(auth.accessToken) ||
      !Array.isArray(auth.scopes) || !auth.scopes.includes('user:profile') ||
      !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()) return null;
  return auth.accessToken;
}
function officialUsage(data, seat, service, at) {
  const windows = [['fiveHour', '5 小时', data?.five_hour], ['weekly', '每周', data?.seven_day]].map(([key, label, w]) => {
    const absolute = typeof w?.resets_at === 'number' || typeof w?.resets_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(w.resets_at);
    const resetAt = absolute ? Q.resetTime(w.resets_at, at) : null;
    if (Q.percent(w?.utilization) === null || !resetAt) throw new Error('invalid-usage');
    return { key, label, used: w.utilization, remaining: Math.round((100 - w.utilization) * 10) / 10,
      exhausted: w.utilization === 100, resetAt, resetText: new Date(resetAt).toISOString() };
  });
  return { provider: 'Claude', scope: 'claude', seatId: seat.id, configDir: seat.configDir,
    credentialKey: createHash('sha256').update(service).digest('hex').slice(0, 16),
    at, source: Q.CLAUDE_OAUTH_SOURCE, confidence: '高（官方采样）', official: true, windows };
}
function requestUsage(token, get = https.get, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let request, response, bytes = 0, body = '', done = false;
    const finish = (value = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      response?.destroy(); request?.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      // No redirects, proxy/env URL overrides, retries or token refresh. No
      // inference endpoint or messages payload can be reached from this path.
      request = get('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        agent: false,
      }, (res) => {
        response = res;
        res.on('error', () => finish());
        if (done) { res.destroy(); return; }
        if (res.statusCode !== 200) return finish();
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) return finish();
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body), at = Date.now();
            const windows = officialUsage(data, { id: 'default' }, '', at).windows.map((w) => ({ key: w.key, remaining: 100 - w.used, resetText: w.resetText }));
            finish({ at, source: Q.CLAUDE_OAUTH_SOURCE, windows });
          } catch (_) { finish(); }
        });
      });
      request.on('error', () => finish());
    } catch (_) { finish(); }
  });
}
async function readSeat(seat, home, credentials = readCredentials, usage = requestUsage) {
  try {
    const loc = M.credentialLocation(seat, home), accountKey = M.usageAccountKey(loc);
    if (!accountKey) return null;
    const token = await credentials(seat, home);
    const value = token ? await usage(token) : null;
    const current = M.credentialLocation(seat, home);
    if (!value || current.dir !== loc.dir || accountKey !== M.usageAccountKey(current)) return null;
    return { ...value, accountKey, configDir: loc.dir };
  } catch (_) { return null; }
}
function boundUsage(seat, home, value) {
  if (!value?.accountKey) return null;
  try {
    const loc = M.credentialLocation(seat, home);
    if (value.accountKey !== M.usageAccountKey(loc) || (value.configDir !== loc.dir && value.configDir !== seat.configDir)) return null;
    return { ...M.sanitizeUsage(value), accountKey: value.accountKey, configDir: loc.dir };
  } catch (_) { return null; }
}
function createRefresh({ home, getSeats, read = readSeat, write = M.writeUsage, now = Date.now }) {
  const entries = new Map();
  let stopped = false;
  function sync() {
    const services = new Set();
    const seats = S.normalize(getSeats()).filter((seat) => {
      try {
        const service = M.credentialLocation(seat, home).keychainService;
        if (services.has(service)) return false;
        services.add(service); return true;
      } catch (_) { return false; }
    });
    for (const [id, entry] of entries) if (!seats.some((s) => s.id === id && s.configDir === entry.seat.configDir)) entries.delete(id);
    for (const seat of seats) if (!entries.has(seat.id)) entries.set(seat.id, { seat, due: 0, usage: M.readUsage(seat, home), failures: 0 });
    return entries;
  }
  async function tick({ force = false, seatId } = {}) {
    if (stopped) return;
    await Promise.all([...sync().values()].filter((entry) => !seatId || entry.seat.id === seatId).map((entry) => {
      if (entry.pending) return entry.pending;
      if (!force && now() < entry.due) return;
      entry.due = now() + INTERVAL_MS;
      entry.pending = (async () => {
        let value = null;
        try { value = await read(entry.seat, home); } catch (_) {}
        if (!stopped && entries.get(entry.seat.id) === entry) {
          const usage = boundUsage(entry.seat, home, value && { ...value, at: now(), source: Q.CLAUDE_OAUTH_SOURCE });
          if (usage) {
            entry.usage = usage; entry.failures = 0; entry.failure = null;
            try { write(entry.seat, home, usage); } catch (_) {}
          } else {
            entry.failures++;
            entry.failure = { provider: 'Claude', scope: 'claude', seatId: entry.seat.id, configDir: entry.seat.configDir,
              at: now(), failureOnly: true, failures: entry.failures, checkedAt: now(), failure: '用量查询失败，等待 Claude 刷新凭据或网络恢复' };
          }
        }
      })().finally(() => { entry.pending = null; });
      return entry.pending;
    }));
  }
  return { tick, samples: () => stopped ? [] : [...sync().values()].flatMap(({ seat, usage, failure }) => {
    if (failure) return [failure];
    const bound = boundUsage(seat, home, usage);
    return bound ? [{ ...Q.cacheClaude(bound, bound.at), seatId: seat.id, configDir: seat.configDir, accountKey: bound.accountKey,
      credentialKey: createHash('sha256').update(M.credentialLocation(seat, home).keychainService).digest('hex').slice(0, 16), accountBound: true, official: true }] : [];
  }),
    dispose: () => { stopped = true; entries.clear(); } };
}
module.exports = { INTERVAL_MS, officialUsage, readCredentials, requestUsage, readSeat, createRefresh };
