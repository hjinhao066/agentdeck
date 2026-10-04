'use strict';
// Subscription metadata only. Credentials never leave this main-process module
// except as authentication to the fixed Anthropic HTTPS origin below.
const fs = require('fs/promises');
const https = require('https');
const { execFile } = require('child_process');
const S = require('./claude-seats-core');
const M = require('./claude-seats-main');
const Q = require('./quota-core');
const INTERVAL_MS = 15 * 60_000;
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
      exec('/usr/bin/security', ['find-generic-password', '-s', loc.keychainService, '-w'],
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
            const windows = [['five_hour', 'fiveHour'], ['seven_day', 'weekly']].map(([field, key]) => {
              const w = data?.[field];
              if (Q.percent(w?.utilization) === null) return null;
              const absolute = typeof w.resets_at === 'number' || typeof w.resets_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(w.resets_at);
              const resetAt = absolute ? Q.resetTime(w.resets_at, at) : null;
              return { key, remaining: 100 - w.utilization,
                resetText: resetAt ? new Date(resetAt).toISOString() : '' };
            }).filter(Boolean);
            finish(windows.length ? { at, source: Q.CLAUDE_OAUTH_SOURCE, windows } : null);
          } catch (_) { finish(); }
        });
      });
      request.on('error', () => finish());
    } catch (_) { finish(); }
  });
}
async function readSeat(seat, home) {
  try {
    const token = await readCredentials(seat, home);
    return token ? await requestUsage(token) : null;
  } catch (_) { return null; }
}
function createRefresh({ home, getSeats, read = readSeat, write = M.writeUsage, now = Date.now }) {
  const entries = new Map();
  let stopped = false;
  function sync() {
    const seats = S.normalize(getSeats());
    for (const [id, entry] of entries) if (!seats.some((s) => s.id === id && s.configDir === entry.seat.configDir)) entries.delete(id);
    for (const seat of seats) if (!entries.has(seat.id)) entries.set(seat.id, { seat, due: 0,
      usage: { at: now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: [] } });
    return entries;
  }
  async function tick() {
    if (stopped) return;
    await Promise.all([...sync().values()].map(async (entry) => {
      if (entry.busy || now() < entry.due) return;
      entry.busy = true; entry.due = now() + INTERVAL_MS;
      let value = null;
      try { value = await read(entry.seat, home); } catch (_) {}
      if (!stopped && entries.get(entry.seat.id) === entry) {
        // Whitelist again before persistence/IPC; a failed seat is explicitly
        // unknown and cannot resurrect its old cache or exhaustion latch.
        try { entry.usage = M.sanitizeUsage({ ...value, at: now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: value?.windows || [] }); }
        catch (_) { entry.usage = { at: now(), source: Q.CLAUDE_OAUTH_SOURCE, windows: [] }; }
        try { write(entry.seat, home, entry.usage); } catch (_) {}
      }
      entry.busy = false;
    }));
  }
  return { tick, samples: () => stopped ? [] : [...sync().values()].map(({ seat, usage }) => ({ ...Q.cacheClaude(usage, usage.at), seatId: seat.id, configDir: seat.configDir })),
    dispose: () => { stopped = true; entries.clear(); } };
}
module.exports = { INTERVAL_MS, readCredentials, requestUsage, readSeat, createRefresh };
