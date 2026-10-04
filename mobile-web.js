'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const fsSync = require('node:fs');

const DEFAULT_PORT = 43121;
const COOKIE = 'agentdeck_mobile';
const REMOTE_COOKIE = '__Host-agentdeck_mobile';
const MACHINE_COOKIE_PREFIX = '__Secure-agentdeck_';
const BASE_PATH = /^\/[a-z0-9][a-z0-9-]{0,31}\/$/;
const LABEL = /^[^\x00-\x1f\x7f<>]{1,32}$/;
const API_VERSION = 2;
const LOGIN_ITEM_PLATFORMS = ['darwin', 'win32'];
const DEVICE_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const LOGIN_LIMITS = { perIp: 5, global: 30, windowMs: 10 * 60 * 1000, banMs: 15 * 60 * 1000 };
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Login-item registration is shared by the platforms whose Electron
// `openAtLogin` can restore the private web service after a user login.
function supportsLoginItem(platform) { return LOGIN_ITEM_PLATFORMS.includes(platform); }

// A short digest of board file names, sizes and mtimes; never any card text.
function boardVersionOf(dir) {
  try {
    const parts = fsSync.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const stat = fsSync.statSync(path.join(dir, name));
      return `${name}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    });
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  } catch (_) { return ''; }
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function publicOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch (_) { /* Invalid origin is reported by configure. */ }
  return null;
}

// The 401 page is the only unauthenticated document. No app data or token is
// embedded here; a successful login reloads the authenticated page.
function loginPage(nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentDeck 登录</title><style nonce="${nonce}">
  :root{color-scheme:light dark;font:16px system-ui}body{margin:0;padding:24px;background:light-dark(#f5f6fa,#141820);color:light-dark(#202637,#edf0f6)}main{max-width:360px;margin:16vh auto}h1{font-size:28px}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:12px;font:inherit}input{border:1px solid #7b8392}button{margin-top:16px;background:#4064d9;color:white;border:0;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #87a7ff;outline-offset:3px}p{line-height:1.6}#error{color:light-dark(#a22323,#ffb4b4);min-height:24px}
  </style><main><h1>AgentDeck</h1><p>在桌面设置中开启手机网页端，并复制登录 token。</p><form id="login"><label for="token">登录 token</label><input id="token" type="password" autocomplete="current-password" required spellcheck="false"><button type="submit">登录</button><p id="error" role="alert"></p></form></main><script nonce="${nonce}">
  document.getElementById('login').addEventListener('submit',async(e)=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value})});if(r.ok){document.getElementById('token').value='';location.reload();}else document.getElementById('error').textContent=r.status===401?'token 不正确，请重试。':r.status===429?'登录尝试过多，请 15 分钟后再试。':'暂时无法登录，请重试。';}catch(_){document.getElementById('error').textContent='无法连接，请重试。';}finally{button.disabled=false;}});
  </script></html>`;
}

class MobileWebServer {
  constructor({ getSessions, getTasks, getOutput, getCaptain, sendCaptain, saveSettings, getBoardVersion, machine = {}, now = Date.now }) {
    this.sources = { getSessions, getTasks, getOutput, getCaptain, sendCaptain, saveSettings, getBoardVersion };
    this.machine = { platform: machine.platform || process.platform, hostname: machine.hostname || '', appVersion: machine.appVersion || '' };
    this.settings = { enabled: false, token: '', port: DEFAULT_PORT, publicOrigin: '', devices: [] };
    this.server = null;
    this.error = '';
    this.pending = Promise.resolve();
    this.storage = Promise.resolve();
    this.now = now;
    this.csrfSecret = crypto.randomBytes(32);
    this.failures = new Map();
    this.globalFailures = { count: 0, since: 0, bannedUntil: 0 };
  }
  status() {
    const port = this.server?.address()?.port || this.settings.port;
    const enabled = !!this.server?.listening;
    return { enabled, url: enabled ? `http://127.0.0.1:${port}` : '', publicUrl: enabled ? this.settings.publicOrigin : '', publicOrigin: this.settings.publicOrigin,
      token: this.settings.token, port, deviceCount: this.settings.devices.filter((device) => device.expiresAt > this.now()).length, error: this.error,
      ...(this.settings.basePath ? { basePath: this.settings.basePath, label: this.machineLabel() } : {}) };
  }
  configure(settings = {}) {
    this.pending = this.pending.then(() => this.applySettings(settings));
    return this.pending;
  }
  revokeDevices() {
    this.pending = this.pending.then(async () => {
      this.settings = { ...this.settings, token: crypto.randomBytes(32).toString('hex'), devices: [] };
      this.csrfSecret = crypto.randomBytes(32);
      try { await this.persist(); } catch (_) { await this.close(); this.error = 'Could not save device revocation.'; }
      return this.status();
    });
    return this.pending;
  }
  persist() {
    const settings = { ...this.settings, devices: this.settings.devices.map((device) => ({ ...device })) };
    this.storage = this.storage.then(() => this.sources.saveSettings(settings), () => this.sources.saveSettings(settings));
    return this.storage;
  }
  async applySettings(value) {
    await this.close();
    this.error = '';
    const next = { ...this.settings, ...value };
    const port = next.port;
    const origin = publicOrigin(next.publicOrigin);
    const token = typeof next.token === 'string' ? next.token : '';
    const basePath = next.basePath === undefined || next.basePath === '' ? '' : next.basePath;
    const label = next.label === undefined || next.label === '' ? '' : next.label;
    if (token !== this.settings.token) this.csrfSecret = crypto.randomBytes(32);
    this.settings = { enabled: next.enabled === true, token, port, publicOrigin: origin || '',
      ...(typeof basePath === 'string' && BASE_PATH.test(basePath) ? { basePath } : {}),
      ...(basePath && typeof label === 'string' && LABEL.test(label) ? { label } : {}),
      devices: (!this.settings.token || token === this.settings.token) && Array.isArray(next.devices) ? next.devices.filter((device) => device && /^[a-f0-9]{64}$/.test(device.hash) && Number.isSafeInteger(device.expiresAt) && device.expiresAt > this.now()).slice(-20).map((device) => ({ hash: device.hash, expiresAt: device.expiresAt })) : [] };
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.error = 'Invalid local port.';
      return this.status();
    }
    if (origin === null) { this.error = 'Public origin must be an HTTPS origin without a path.'; return this.status(); }
    if (basePath && (typeof basePath !== 'string' || !BASE_PATH.test(basePath))) { this.error = 'Invalid base path.'; return this.status(); }
    if (label && (!basePath || typeof label !== 'string' || !LABEL.test(label))) { this.error = 'Invalid machine label.'; return this.status(); }
    if (token && !/^[a-f0-9]{64}$/.test(token)) { this.error = 'Invalid login token.'; return this.status(); }
    try {
      if (this.settings.enabled && !this.settings.token) this.settings.token = crypto.randomBytes(32).toString('hex');
      await this.persist();
      if (!this.settings.enabled) return this.status();
      const server = http.createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) this.json(res, 500, { error: 'Local service unavailable.' }); else res.end(); }); });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      this.server = server;
    } catch (err) {
      this.error = err.code === 'EADDRINUSE' ? 'Local port is already in use.' : 'Could not start local web service.';
    }
    return this.status();
  }
  async close() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  machineLabel() {
    if (this.settings.label) return this.settings.label;
    return this.machine.platform === 'darwin' ? 'Mac' : this.machine.platform === 'win32' ? 'Windows' : this.machine.hostname;
  }
  // Public requests through a machine prefix get a per-machine cookie name and
  // Path, so the browser never sends one machine's device cookie to another.
  // Everything else keeps the original cookie scheme byte for byte.
  cookieName(prefixed) {
    if (prefixed) return MACHINE_COOKIE_PREFIX + this.settings.basePath.slice(1, -1);
    return this.settings.publicOrigin ? REMOTE_COOKIE : COOKIE;
  }
  credential(req, prefixed = false) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization);
      return match && matches(match[1], this.settings.token) ? { hash: hash(this.settings.token), bearer: true } : null;
    }
    const name = this.cookieName(prefixed);
    const cookies = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(name + '='));
    if (cookies.length !== 1) return null;
    const value = cookies[0].slice(name.length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    const digest = hash(value);
    return this.settings.devices.find((device) => device.expiresAt > this.now() && matches(digest, device.hash)) || null;
  }
  csrfToken(credential) {
    return crypto.createHmac('sha256', this.csrfSecret).update(`${credential.bearer ? 'bearer' : 'device'}:${credential.hash}`).digest('hex');
  }
  writeCredential(req, res, prefixed = false) {
    const credential = this.credential(req, prefixed);
    if (!credential) { this.json(res, 401, { error: 'Unauthorized.' }); return null; }
    if (!matches(req.headers['x-csrf-token'], this.csrfToken(credential))) { this.json(res, 403, { error: 'CSRF token required.' }); return null; }
    return credential;
  }
  cookie(value, maxAge = DEVICE_LIFETIME / 1000, prefixed = false) {
    const remote = !!this.settings.publicOrigin;
    return `${this.cookieName(prefixed)}=${value}; HttpOnly; ${remote ? 'Secure; ' : ''}SameSite=Strict; Path=${prefixed ? this.settings.basePath : '/'}; Max-Age=${maxAge}`;
  }
  requestContext(req) {
    const critical = new Set(['host', 'origin', 'authorization', 'x-forwarded-for', 'x-forwarded-proto', 'x-csrf-token', 'sec-fetch-site']);
    const seen = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (critical.has(name) && seen.has(name)) return null;
      seen.add(name);
    }
    const address = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return null;
    const port = this.server?.address()?.port;
    if ([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return { origin: `http://${req.headers.host}`, ip: address, public: false };
    if (!this.settings.publicOrigin || req.headers.host !== new URL(this.settings.publicOrigin).host || req.headers['x-forwarded-proto'] !== 'https' || !net.isIP(req.headers['x-forwarded-for'] || '')) return null;
    // Only the configured HTTPS host through the loopback tunnel may supply
    // client IPs. Caddy must replace these headers, never append client input.
    return { origin: this.settings.publicOrigin, ip: req.headers['x-forwarded-for'], public: true };
  }
  loginBan(ip) {
    const now = this.now();
    for (const [key, value] of this.failures) if (value.bannedUntil <= now && now - value.since >= LOGIN_LIMITS.windowMs) this.failures.delete(key);
    return Math.max(0, (this.failures.get(ip)?.bannedUntil || 0) - now, this.globalFailures.bannedUntil - now);
  }
  failedLogin(ip) {
    const now = this.now();
    const record = (value) => {
      if (now - value.since >= LOGIN_LIMITS.windowMs) { value.count = 0; value.since = now; }
      value.count++;
      if (value.count >= (value === this.globalFailures ? LOGIN_LIMITS.global : LOGIN_LIMITS.perIp)) value.bannedUntil = now + LOGIN_LIMITS.banMs;
    };
    if (!this.failures.has(ip)) this.failures.set(ip, { count: 0, since: now, bannedUntil: 0 });
    record(this.failures.get(ip));
    record(this.globalFailures);
    return this.loginBan(ip);
  }
  unauthorized(res, ban = 0) {
    if (ban) res.setHeader('Retry-After', Math.ceil(ban / 1000));
    return this.json(res, ban ? 429 : 401, { error: ban ? 'Too many login attempts. Try again later.' : 'Unauthorized.' });
  }
  async body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw { status: 415 };
    const chunks = await new Promise((resolve, reject) => {
      let size = 0, oversized = false;
      const parts = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65_536) { oversized = true; parts.length = 0; }
        else if (!oversized) parts.push(chunk);
      });
      req.once('end', () => oversized ? reject({ status: 413 }) : resolve(parts));
      req.once('error', () => reject({ status: 400 }));
    });
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
      return value;
    } catch (_) { throw { status: 400 }; }
  }
  async handle(req, res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    const context = this.requestContext(req);
    if (!context) return this.json(res, 403, { error: 'Allowed host and proxy required.' });
    if ((req.method === 'POST' || req.headers.origin !== undefined) && req.headers.origin !== context.origin) return this.json(res, 403, { error: 'Same origin required.' });
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return this.json(res, 403, { error: 'Same origin required.' });
    let url;
    try { url = new URL(req.url, context.origin); } catch (_) { return this.json(res, 400, { error: 'Invalid URL.' }); }
    if (url.origin !== context.origin || url.username || url.password || [...url.searchParams.keys()].some((key) => /(?:^|_)(?:token|password|secret)(?:$|_)/i.test(key))) return this.json(res, 400, { error: 'Invalid URL.' });
    // With a base path configured, a request from the public host must carry it;
    // anything else is not this machine's route and never reaches auth. Direct
    // loopback clients keep the unprefixed legacy routes.
    const prefixed = context.public && !!this.settings.basePath;
    let route = url.pathname;
    if (prefixed) {
      if (!route.startsWith(this.settings.basePath)) return this.json(res, 404, { error: 'Not found.' });
      route = route.slice(this.settings.basePath.length - 1);
    }
    const credential = this.credential(req, prefixed);
    // An explicit wrong credential must never fall back to a valid cookie.
    if (req.headers.authorization !== undefined && !credential) return this.unauthorized(res, this.loginBan(context.ip) || this.failedLogin(context.ip));
    if (route === '/login' && req.method === 'POST') {
      const ban = this.loginBan(context.ip);
      if (ban) return this.unauthorized(res, ban);
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      const currentBan = this.loginBan(context.ip);
      if (currentBan) return this.unauthorized(res, currentBan);
      if (Object.keys(body).some((key) => key !== 'token') || !matches(body.token, this.settings.token)) return this.unauthorized(res, this.failedLogin(context.ip));
      const value = crypto.randomBytes(32).toString('hex');
      const device = { hash: hash(value), expiresAt: this.now() + DEVICE_LIFETIME };
      this.settings.devices = this.settings.devices.filter((entry) => entry.expiresAt > this.now() && (!credential || credential.hash !== entry.hash)).slice(-19).concat(device);
      try { await this.persist(); } catch (_) { this.settings.devices = this.settings.devices.filter((entry) => entry.hash !== device.hash); return this.json(res, 500, { error: 'Could not remember this device.' }); }
      this.failures.delete(context.ip);
      res.setHeader('Set-Cookie', this.cookie(value, undefined, prefixed));
      return this.json(res, 200, { authenticated: true });
    }
    if (!credential) {
      if (!prefixed && req.method === 'GET' && route === '/') {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(nonce));
      }
      return this.json(res, 401, { error: 'Unauthorized.' });
    }
    if (req.method === 'POST' && !matches(req.headers['x-csrf-token'], this.csrfToken(credential))) return this.json(res, 403, { error: 'CSRF token required.' });
    // The bundled single-machine page uses absolute URLs, so it is not served under a prefix.
    if (!prefixed && req.method === 'GET' && ASSETS[route]) {
      const [file, type] = ASSETS[route];
      const data = await fs.readFile(path.join(__dirname, 'mobile-web', file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }
    if (req.method === 'GET' && route === '/api/auth') return this.json(res, 200, { authenticated: true, csrfToken: this.csrfToken(credential) });
    if (req.method === 'POST' && route === '/logout') {
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
        let body;
        try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
        if (Object.keys(body).length) return this.json(res, 400, { error: 'Invalid request.' });
      }
      const current = this.writeCredential(req, res, prefixed);
      if (!current) return;
      if (current.bearer) return this.json(res, 400, { error: 'Device cookie required.' });
      this.settings.devices = this.settings.devices.filter((device) => device.hash !== current.hash);
      try { await this.persist(); } catch (_) {
        this.settings.token = crypto.randomBytes(32).toString('hex');
        this.settings.devices = [];
        this.csrfSecret = crypto.randomBytes(32);
        this.error = 'Could not save device logout.';
        res.once('finish', () => this.close());
        return this.json(res, 500, { error: 'Could not save device logout.' });
      }
      res.setHeader('Set-Cookie', this.cookie('', 0, prefixed));
      return this.json(res, 200, { authenticated: false });
    }
    if (req.method === 'GET' && route === '/api/snapshot') {
      const [captain, sessions] = await Promise.all([this.sources.getCaptain ? this.sources.getCaptain() : null, this.sources.getSessions()]);
      let boardVersion = '';
      try { boardVersion = String(this.sources.getBoardVersion ? await this.sources.getBoardVersion() : ''); } catch (_) { /* Version is advisory; the phone refetches on ''. */ }
      const str = (value) => typeof value === 'string' ? value : '';
      return this.json(res, 200, { apiVersion: API_VERSION,
        machine: { id: this.settings.basePath ? this.settings.basePath.slice(1, -1) : 'local', label: this.machineLabel(), platform: this.machine.platform, hostname: this.machine.hostname, appVersion: this.machine.appVersion },
        now: this.now(), csrfToken: this.csrfToken(credential),
        captain: { id: str(captain?.id), title: str(captain?.title), status: str(captain?.status) || 'unavailable', turns: Array.isArray(captain?.turns) ? captain.turns : [] },
        sessions, boardVersion });
    }
    if (req.method === 'GET' && route === '/api/captain') return this.json(res, 200, this.sources.getCaptain ? await this.sources.getCaptain() : { turns: [], status: 'unavailable' });
    if (req.method === 'GET' && route === '/api/sessions') return this.json(res, 200, { sessions: await this.sources.getSessions() });
    if (req.method === 'GET' && route === '/api/tasks') return this.json(res, 200, { cards: await this.sources.getTasks() });
    if (req.method === 'GET' && route === '/api/output') {
      const id = url.searchParams.get('id');
      if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) return this.json(res, 400, { error: 'Session id required.' });
      const output = await this.sources.getOutput(id);
      if (!output) return this.json(res, 404, { error: 'Session not found.' });
      return this.json(res, 200, { id: output.id, title: output.title, text: String(output.text || '').slice(-64_000) });
    }
    if (req.method === 'POST' && route === '/api/captain') {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      if (Object.keys(body).some((key) => key !== 'message') || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000 || /\x00/.test(body.message)) return this.json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      // Body uploads can outlive desktop revocation. Resolve the current device
      // and CSRF secret again immediately before queuing a command.
      if (!this.writeCredential(req, res, prefixed)) return;
      await this.sources.sendCaptain(body.message);
      return this.json(res, 200, { queued: true });
    }
    return this.json(res, 404, { error: 'Not found.' });
  }
}

module.exports = { MobileWebServer, DEFAULT_PORT, LOGIN_LIMITS, boardVersionOf, supportsLoginItem };
