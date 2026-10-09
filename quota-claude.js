'use strict';
// Subscription metadata only. Credentials never leave this main-process module
// except as authentication to the fixed usage and token origins below.
const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { createHash, randomBytes } = require('crypto');
const S = require('./claude-seats-core');
const M = require('./claude-seats-main');
const Q = require('./quota-core');
const INTERVAL_MS = 5 * 60_000;
const MAX_BYTES = 64 * 1024;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Public Claude Code OAuth client id, the same value shipped in the CLI.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;
const SCOPE_RE = /^[a-z0-9:_-]{1,80}$/i;
const refreshedCredentials = new Map();
function clearCredentialCache() { refreshedCredentials.clear(); }
function credentialAccount() {
  const name = os.userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}
function accessUsable(auth, now) {
  return typeof auth?.accessToken === 'string' && TOKEN_RE.test(auth.accessToken) &&
    Array.isArray(auth.scopes) && auth.scopes.includes('user:profile') &&
    Number.isFinite(auth.expiresAt) && auth.expiresAt > now;
}
function newerAuth(left, right) {
  if (!left?.refreshToken) return right;
  if (!right?.refreshToken) return left;
  const leftRefresh = Number.isFinite(left.refreshTokenExpiresAt) ? left.refreshTokenExpiresAt : 0;
  const rightRefresh = Number.isFinite(right.refreshTokenExpiresAt) ? right.refreshTokenExpiresAt : 0;
  if (leftRefresh !== rightRefresh) return leftRefresh > rightRefresh ? left : right;
  return (left.expiresAt || 0) >= (right.expiresAt || 0) ? left : right;
}
function postRefresh(body, request = https.request, timeoutMs = 8000) {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req, res, bytes = 0, raw = '', done = false;
    const finish = (value = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      res?.destroy(); req?.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      // Pinned origin, no redirects, proxy override, or retry. The body is the
      // only place the refresh token goes.
      req = request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        agent: false,
      }, (incoming) => {
        res = incoming;
        incoming.on('error', () => finish());
        if (done) { incoming.destroy(); return; }
        if (incoming.statusCode === 401) return finish({ authStatus: 'logged-out' });
        if (![200, 400].includes(incoming.statusCode)) return finish();
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) return finish();
          raw += chunk;
        });
        incoming.on('end', () => {
          try {
            const value = JSON.parse(raw);
            finish(incoming.statusCode === 200 ? value : value?.error === 'invalid_grant' ? { authStatus: 'logged-out' } : null);
          } catch (_) { finish(); }
        });
      });
      req.on('error', () => finish());
      req.end(payload);
    } catch (_) { finish(); }
  });
}
async function refreshOauth(auth, now, post = postRefresh, expectedUuid = null) {
  const refreshToken = auth?.refreshToken;
  if (typeof refreshToken !== 'string' || !TOKEN_RE.test(refreshToken)) return null;
  if (Number.isFinite(auth.refreshTokenExpiresAt) && auth.refreshTokenExpiresAt <= now) return null;
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.filter((scope) => typeof scope === 'string' && SCOPE_RE.test(scope)) : [];
  if (!scopes.includes('user:profile')) return null;
  let response;
  try {
    response = await post({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID, scope: scopes.join(' ') });
  } catch (_) { return null; }
  if (!response || typeof response !== 'object') return null;
  if (response.authStatus === 'logged-out') return { authStatus: 'logged-out' };
  if (expectedUuid && response.account && typeof response.account.uuid === 'string' && response.account.uuid !== expectedUuid) return null;
  if (typeof response.access_token !== 'string' || !TOKEN_RE.test(response.access_token)) return null;
  const expiresIn = Number(response.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 30 * 24 * 3600) return null;
  const nextRefresh = typeof response.refresh_token === 'string' && TOKEN_RE.test(response.refresh_token) ? response.refresh_token : refreshToken;
  let refreshTokenExpiresAt = auth.refreshTokenExpiresAt;
  const refreshIn = Number(response.refresh_token_expires_in);
  if (Number.isFinite(refreshIn) && refreshIn > 0 && refreshIn <= 400 * 24 * 3600) refreshTokenExpiresAt = now + refreshIn * 1000;
  let nextScopes = scopes;
  if (typeof response.scope === 'string') {
    const parsed = response.scope.split(/\s+/).filter((scope) => SCOPE_RE.test(scope));
    if (parsed.includes('user:profile')) nextScopes = parsed;
  }
  return { ...auth, accessToken: response.access_token, refreshToken: nextRefresh, expiresAt: now + expiresIn * 1000, refreshTokenExpiresAt, scopes: nextScopes };
}
// `security add-generic-password … -w` reads the secret at a password prompt that keeps only its first
// 128 bytes and still exits 0, and a credential is several hundred: the item was left unparseable. The
// add command goes to `security -i` on stdin instead, the secret hex-encoded (-X): never in argv, never
// at that prompt. `security -i` reads a line into a 4 KB buffer and stores part of a longer one, so a
// line that may not fit is never sent ('' here), and a renewal whose result may not fit is not started.
const KEYCHAIN_LINE_MAX = 4000, RENEWAL_ROOM = 256;
function keychainLine(service, account, payload) {
  if (!/^[\w .-]+$/.test(service) || !/^[\w.-]+$/.test(account)) return '';
  const line = `add-generic-password -U -a ${account} -s "${service}" -X ${Buffer.from(payload, 'utf8').toString('hex')}\n`;
  return line.length <= KEYCHAIN_LINE_MAX ? line : '';
}
function persistKeychain(service, account, payload, spawnImpl = spawn) {
  if (typeof payload !== 'string' || /[\r\n]/.test(payload) || Buffer.byteLength(payload) > MAX_BYTES) return Promise.resolve(false);
  const line = keychainLine(service, account, payload);
  if (!line) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child, done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch (_) {} finish(false); }, 5000);
    try {
      child = spawnImpl('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (_) { return finish(false); }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    try { child.stdin.write(line); child.stdin.end(); }
    catch (_) { try { child.kill('SIGKILL'); } catch (_) {} finish(false); }
  });
}
async function persistFile(file, payload) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_BYTES) return false;
  const tmp = `${file}.agentdeck-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    const current = await fs.lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (current && (current.isSymbolicLink() || !current.isFile())) return false;
    if ((await fs.lstat(path.dirname(file))).isSymbolicLink()) return false;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(payload); } finally { await handle.close(); }
    await fs.rename(tmp, file);
    return true;
  } catch (_) {
    try { await fs.unlink(tmp); } catch (_) {}
    return false;
  }
}
async function loadCredential(seat, home, platform, exec) {
  const loc = M.credentialLocation(seat, home);
  for (const file of [loc.dir, loc.metadataPath, loc.credentialsPath]) {
    try { if ((await fs.lstat(file)).isSymbolicLink()) return { loc, blocked: true }; }
    catch (e) { if (e.code !== 'ENOENT') return { loc, blocked: true }; }
  }
  const account = credentialAccount();
  let raw = null, source = null, keychainUnknown = false;
  if (platform === 'darwin') {
    raw = await new Promise((resolve) => {
      // Capture stdout in memory; never use a shell, log stderr or return errors.
      exec('/usr/bin/security', ['find-generic-password', '-a', account, '-s', loc.keychainService, '-w'],
        { timeout: 2000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
          keychainUnknown = !!error && error.code !== 44;
          resolve(error ? null : stdout);
        });
    });
    if (raw) source = 'keychain';
  }
  if (!raw) {
    try {
      const handle = await fs.open(loc.credentialsPath, 'r');
      try {
        if ((await handle.stat()).size > MAX_BYTES) return { loc, account, blocked: true };
        raw = await handle.readFile('utf8');
        source = 'file';
      } finally { await handle.close(); }
    } catch (e) { if (e.code !== 'ENOENT') return { loc, account, blocked: true }; }
  }
  return { loc, account, raw, source, blocked: !raw && keychainUnknown };
}
// A Claude CLI on the seat renews its own token, and a second writer racing it for the seat's
// Keychain item can sign it out. So an expired token is renewed only through deps.exclusive (the
// seat gate: no Claude runs on the seat, and AgentDeck starts none until the renewal is written),
// and the credential is read again inside it. Without the gate, or with a Claude running, it is
// only read: the seat's usage stays unknown until a session on it renews the token.
async function readCredentials(seat, home, platform = process.platform, exec = execFile, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const loaded = await loadCredential(seat, home, platform, exec);
  if (loaded.blocked) return null;
  if (!loaded.raw) { deps.onAuth?.('logged-out'); return null; }
  let stored;
  try { stored = JSON.parse(loaded.raw); } catch (_) { return null; }
  const auth = stored?.claudeAiOauth;
  if (!auth || typeof auth !== 'object') { deps.onAuth?.('logged-out'); return null; }
  if (accessUsable(auth, now)) {
    refreshedCredentials.delete(loaded.loc.keychainService);
    return auth.accessToken;
  }
  const cached = refreshedCredentials.get(loaded.loc.keychainService);
  const persist = deps.persist || ((source, body) => source === 'keychain'
    ? persistKeychain(loaded.loc.keychainService, loaded.account, body, deps.spawn)
    : persistFile(loaded.loc.credentialsPath, body));
  if (accessUsable(cached?.auth, now)) {
    // A rotated refresh token must reach the seat store before this process exits.
    if (!cached.persisted && cached.payload) {
      try { cached.persisted = await persist(cached.source, cached.payload) === true; } catch (_) {}
    }
    return cached.auth.accessToken;
  }
  const base = newerAuth(cached?.auth, auth);
  if (!base?.refreshToken || Number.isFinite(base.refreshTokenExpiresAt) && base.refreshTokenExpiresAt <= now) {
    if (Number.isFinite(base?.expiresAt) && base.expiresAt <= now) deps.onAuth?.('logged-out');
    return null;
  }
  // Renewing rotates the refresh token on the server: never start one whose result this Keychain item cannot take.
  if (loaded.source === 'keychain' && !deps.persist && !keychainLine(loaded.loc.keychainService, loaded.account, loaded.raw.trim() + ' '.repeat(RENEWAL_ROOM))) return null;
  if (!deps.inGate) {
    if (typeof deps.exclusive !== 'function') return null;
    return (await deps.exclusive(() => readCredentials(seat, home, platform, exec, { ...deps, exclusive: null, inGate: true }))) ?? null;
  }
  let expectedUuid = null;
  try {
    const account = JSON.parse(await fs.readFile(loaded.loc.metadataPath, 'utf8')).oauthAccount;
    if (typeof account?.accountUuid === 'string' && account.accountUuid) expectedUuid = account.accountUuid;
  } catch (_) {}
  const next = deps.refresh ? await deps.refresh(base, now) : await refreshOauth(base, now, deps.post || postRefresh, expectedUuid);
  if (next?.authStatus === 'logged-out') deps.onAuth?.('logged-out');
  if (!accessUsable(next, now)) return null;
  const payload = JSON.stringify({ ...stored, claudeAiOauth: next });
  if (payload.includes('\n') || Buffer.byteLength(payload) > MAX_BYTES) return null;
  let persisted = false;
  try { persisted = await persist(loaded.source, payload) === true; } catch (_) {}
  refreshedCredentials.set(loaded.loc.keychainService, { auth: next, source: loaded.source, payload, persisted });
  return next.accessToken;
}
// One renewal, or one Claude AgentDeck starts, at a time per seat. renew(seat, fn) runs fn only when
// occupied(seat) says no Claude is on the seat (checked inside the queue, after whatever went before),
// else resolves to null. launch(seatId, fn) runs fn after any renewal in progress on that seat.
function createSeatGate({ occupied }) {
  const tails = new Map();
  function queue(key, fn) {
    const run = (tails.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  return {
    renew: (seat, fn) => queue(seat.id, async () => (await occupied(seat)) ? null : fn()),
    launch: (seatId, fn) => queue(seatId, fn),
  };
}
function officialUsage(data, seat, service, at) {
  if (!data || typeof data !== 'object' || !['five_hour', 'seven_day'].some((key) => key in data)) throw new Error('invalid-usage');
  const windows = [['fiveHour', '5 小时', data.five_hour], ['weekly', '每周', data.seven_day]].map(([key, label, w]) => {
    // An account nobody has used since its last reset has no running window: the answer
    // then carries no reset time (or no window at all). It is still a signed-in answer,
    // and whatever windows it does give are shown.
    if (w == null || (w.utilization == null && w.resets_at == null)) return null;
    const absolute = typeof w.resets_at === 'number' || typeof w.resets_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(w.resets_at);
    const resetAt = absolute ? Q.resetTime(w.resets_at, at) : null;
    if (Q.percent(w.utilization) === null || (w.resets_at != null && !resetAt)) throw new Error('invalid-usage');
    return { key, label, used: w.utilization, remaining: Math.round((100 - w.utilization) * 10) / 10,
      exhausted: w.utilization === 100, resetAt, resetText: resetAt ? new Date(resetAt).toISOString() : '' };
  }).filter(Boolean);
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
        if (res.statusCode === 401) return finish({ at: Date.now(), source: Q.CLAUDE_OAUTH_SOURCE, authStatus: 'logged-out' });
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
            finish({ at, source: Q.CLAUDE_OAUTH_SOURCE, windows, authStatus: 'logged-in',
              extraUsageEnabled: typeof data?.extra_usage?.is_enabled === 'boolean' ? data.extra_usage.is_enabled : null });
          } catch (_) { finish(); }
        });
      });
      request.on('error', () => finish());
    } catch (_) { finish(); }
  });
}
async function readSeat(seat, home, credentials = readCredentials, usage = requestUsage) {
  try {
    const loc = M.credentialLocation(seat, home);
    let accountKey = null, authStatus;
    try { accountKey = M.usageAccountKey(loc); } catch (_) {}
    const token = await credentials(seat, home, undefined, undefined, { onAuth: (value) => { authStatus = value; } });
    if (!accountKey && authStatus !== 'logged-out') return null;
    const value = token ? await usage(token) : null;
    const current = M.credentialLocation(seat, home);
    if (current.dir !== loc.dir) return null;
    if (authStatus === 'logged-out' || value?.authStatus === 'logged-out') return {
      at: Date.now(), source: Q.CLAUDE_OAUTH_SOURCE, configDir: loc.dir, authStatus: 'logged-out',
    };
    if (!value || !accountKey || accountKey !== M.usageAccountKey(current)) return null;
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
function createRefresh({ home, getSeats, read = readSeat, write = M.writeUsage, now = Date.now, intervalMs = () => INTERVAL_MS, onSample = () => {} }) {
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
      entry.due = now() + intervalMs();
      entry.pending = (async () => {
        let value = null;
        try { value = await read(entry.seat, home); } catch (_) {}
        if (!stopped && entries.get(entry.seat.id) === entry) {
          const usage = boundUsage(entry.seat, home, value && { ...value, at: now(), source: Q.CLAUDE_OAUTH_SOURCE });
          // The usage service accepted this seat's own token: signed in, even when it gave no number to show.
          let answered = false;
          try { answered = !usage && value?.authStatus === 'logged-in' && value.configDir === M.credentialLocation(entry.seat, home).dir; } catch (_) {}
          if (usage) {
            entry.usage = usage; entry.failures = 0; entry.failure = null;
            try { write(entry.seat, home, usage); } catch (_) {}
          } else {
            entry.failures++;
            const loggedOut = value?.authStatus === 'logged-out' && value.configDir === M.credentialLocation(entry.seat, home).dir;
            entry.failure = { provider: 'Claude', scope: 'claude', seatId: entry.seat.id, configDir: entry.seat.configDir,
              at: now(), failureOnly: true, failures: entry.failures, checkedAt: now(),
              ...(loggedOut ? { authStatus: 'logged-out' } : {}),
              failure: answered ? '已登录，这个账号暂时没有额度数字（还没开始用）' : '用量查询失败，等待 Claude 刷新凭据或网络恢复' };
          }
          // Only actual polls are evidence; cached samples exposed by samples()
          // must never advance a logout confirmation or manufacture a recovery.
          try { onSample(usage || answered ? { provider: 'Claude', scope: 'claude', seatId: entry.seat.id, configDir: entry.seat.configDir,
            at: now(), checkedAt: now(), authStatus: 'logged-in' } : entry.failure); } catch (_) {}
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
module.exports = { INTERVAL_MS, officialUsage, readCredentials, requestUsage, readSeat, createRefresh, createSeatGate, refreshOauth, postRefresh, clearCredentialCache };
