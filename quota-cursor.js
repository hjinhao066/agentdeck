'use strict';
// Read-only Cursor plan usage. The access token stays in this process and is
// sent only to the fixed DashboardService origin below. It is never logged,
// returned, written, or used to refresh/login/logout.
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const INTERVAL_MS = 10 * 60 * 1000;
const ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const MAX_BYTES = 64 * 1024;

function databasePath(home = os.homedir(), platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}
function sqliteUri(file) {
  const abs = path.resolve(file);
  return `file:${abs.split(path.sep).map((part) => encodeURIComponent(part)).join('/')}?mode=ro`;
}
// Same integer the Cursor settings page shows: (0,1) becomes 1, otherwise clamp and round.
function shownUsed(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  const clamped = raw > 0 && raw < 1 ? 1 : Math.min(raw, 100);
  return Math.round(clamped);
}
function cycleEnd(value, now) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{10,13}$/.test(value)) n = Number(value);
  else if (typeof value === 'string') n = Date.parse(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  if (ms < now - 40 * 86400000 || ms > now + 400 * 86400000) return null;
  return ms;
}
function officialUsage(data, at = Date.now()) {
  const plan = data && data.planUsage;
  const auto = shownUsed(plan && plan.autoPercentUsed);
  const api = shownUsed(plan && plan.apiPercentUsed);
  const resetAt = cycleEnd(data && data.billingCycleEnd, at);
  if (auto === null || api === null || !resetAt) return null;
  const windowFor = (key, label, used) => ({
    key, label, used, remaining: 100 - used, exhausted: used === 100, resetAt, resetText: new Date(resetAt).toISOString(),
  });
  // Cursor's own settings map auto → "Cursor Models" (Grok / Composer) and api → "Other Models".
  return {
    provider: 'Cursor', scope: 'grok-4.7', at, source: '官方用量接口', confidence: '高（官方采样）', official: true, failures: 0,
    windows: [windowFor('cursorModels', 'Grok', auto), windowFor('otherModels', '其他', api)],
  };
}
function readAccessToken(file = databasePath(), exec = execFile) {
  return new Promise((resolve) => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (_) { return resolve(null); }
    if (!stat.isFile() || stat.isSymbolicLink()) return resolve(null);
    const bin = process.platform === 'win32' ? 'sqlite3' : '/usr/bin/sqlite3';
    exec(bin, [sqliteUri(file), "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"],
      { timeout: 3000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        if (error) return resolve(null);
        const token = String(stdout || '').trim();
        resolve(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? token : null);
      });
  });
}
function requestUsage(token, requestImpl = https.request, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let request, response, bytes = 0, body = '', done = false;
    const finish = (value = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      response?.destroy(); request?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      request = requestImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', Accept: 'application/json' },
        timeout: timeoutMs,
      }, (res) => {
        response = res;
        res.on('error', () => finish());
        if (done) { res.destroy(); return; }
        if (res.statusCode !== 200) { res.resume(); return finish(); }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) return finish();
          body += chunk;
        });
        res.on('end', () => { try { finish(JSON.parse(body)); } catch (_) { finish(); } });
      });
      request.on('error', () => finish());
      request.on('timeout', () => finish());
      request.end('{}');
    } catch (_) { finish(); }
  });
}
function createCursorUsageReader({ readToken = readAccessToken, fetchUsage = requestUsage, now = Date.now, enabled = true } = {}) {
  let checkedAt = 0, pending = null, result = null, failures = 0;
  function read() {
    if (!enabled) return Promise.resolve(null);
    if (pending) return pending;
    if (checkedAt && now() - checkedAt < INTERVAL_MS) return Promise.resolve(result);
    checkedAt = now();
    pending = (async () => {
      let reason = 'network';
      try {
        reason = 'credential-unavailable';
        const token = await readToken();
        if (!token) throw new Error('unavailable');
        reason = 'network';
        const data = await fetchUsage(token);
        reason = 'invalid-usage';
        const sample = officialUsage(data, now());
        if (!sample) throw new Error('invalid');
        failures = 0;
        result = sample;
      } catch (_) {
        failures += 1;
        const reasons = {
          'credential-unavailable': '无法读取本机 Cursor 登录令牌',
          network: '网络查询失败',
          'invalid-usage': '接口未返回两个用量池',
        };
        result = {
          provider: 'Cursor', scope: 'grok-4.7', at: now(), failureOnly: true, official: true,
          failures, checkedAt: now(), failure: reasons[reason] || '用量接口暂不可用',
        };
      }
      return result;
    })();
    return pending.finally(() => { pending = null; });
  }
  return { read, INTERVAL_MS };
}
module.exports = { INTERVAL_MS, ENDPOINT, databasePath, shownUsed, cycleEnd, officialUsage, readAccessToken, requestUsage, createCursorUsageReader };
