'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_PORT = 43121;
const COOKIE = 'agentdeck_mobile';
const REMOTE_COOKIE = '__Host-agentdeck_mobile';
const DEVICE_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const LOGIN_LIMITS = { perIp: 5, global: 30, windowMs: 10 * 60 * 1000, banMs: 15 * 60 * 1000 };
// Uploaded images: one per request, re-checked by file signature. The id is
// the server-generated file name, so a request can never name a path.
const IMAGE_LIMITS = { bytes: 4 * 1024 * 1024, perMessage: 6, keepMs: 30 * 24 * 60 * 60 * 1000 };
const IMAGE_ID = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The real type comes from the leading bytes; the client's file name and
// Content-Type are never consulted.
function imageKind(data) {
  const starts = (bytes, offset = 0) => data.length >= offset + bytes.length && bytes.every((byte, i) => data[offset + i] === byte);
  if (starts([0xff, 0xd8, 0xff])) return 'jpg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts([0x47, 0x49, 0x46, 0x38]) && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) return 'gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
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
  constructor({ getSessions, getTasks, getOutput, getCaptain, sendCaptain, saveSettings, uploadDir = '', now = Date.now }) {
    this.sources = { getSessions, getTasks, getOutput, getCaptain, sendCaptain, saveSettings };
    this.uploadDir = uploadDir ? path.resolve(uploadDir) : '';
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
      token: this.settings.token, port, deviceCount: this.settings.devices.filter((device) => device.expiresAt > this.now()).length, error: this.error };
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
    if (token !== this.settings.token) this.csrfSecret = crypto.randomBytes(32);
    this.settings = { enabled: next.enabled === true, token, port, publicOrigin: origin || '',
      devices: (!this.settings.token || token === this.settings.token) && Array.isArray(next.devices) ? next.devices.filter((device) => device && /^[a-f0-9]{64}$/.test(device.hash) && Number.isSafeInteger(device.expiresAt) && device.expiresAt > this.now()).slice(-20).map((device) => ({ hash: device.hash, expiresAt: device.expiresAt })) : [] };
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.error = 'Invalid local port.';
      return this.status();
    }
    if (origin === null) { this.error = 'Public origin must be an HTTPS origin without a path.'; return this.status(); }
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
      this.sweepUploads();
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
  credential(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization);
      return match && matches(match[1], this.settings.token) ? { hash: hash(this.settings.token), bearer: true } : null;
    }
    const name = this.settings.publicOrigin ? REMOTE_COOKIE : COOKIE;
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
  writeCredential(req, res) {
    const credential = this.credential(req);
    if (!credential) { this.json(res, 401, { error: 'Unauthorized.' }); return null; }
    if (!matches(req.headers['x-csrf-token'], this.csrfToken(credential))) { this.json(res, 403, { error: 'CSRF token required.' }); return null; }
    return credential;
  }
  cookie(value, maxAge = DEVICE_LIFETIME / 1000) {
    const remote = !!this.settings.publicOrigin;
    return `${remote ? REMOTE_COOKIE : COOKIE}=${value}; HttpOnly; ${remote ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${maxAge}`;
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
    if ([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return { origin: `http://${req.headers.host}`, ip: address };
    if (!this.settings.publicOrigin || req.headers.host !== new URL(this.settings.publicOrigin).host || req.headers['x-forwarded-proto'] !== 'https' || !net.isIP(req.headers['x-forwarded-for'] || '')) return null;
    // Only the configured HTTPS host through the loopback tunnel may supply
    // client IPs. Caddy must replace these headers, never append client input.
    return { origin: this.settings.publicOrigin, ip: req.headers['x-forwarded-for'] };
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
  // Uploads older than a month are stale: the conversation only shows the
  // latest turns, and images the user removed before sending are never used.
  async sweepUploads() {
    if (!this.uploadDir) return;
    try {
      for (const name of await fs.readdir(this.uploadDir)) {
        if (!IMAGE_ID.test(name)) continue;
        const file = path.join(this.uploadDir, name);
        if (this.now() - (await fs.lstat(file)).mtimeMs > IMAGE_LIMITS.keepMs) await fs.unlink(file);
      }
    } catch (_) { /* Nothing uploaded yet. */ }
  }
  // Only a server-generated name that is a regular file directly inside the
  // upload directory resolves; anything else (paths, links, other files) is null.
  async imageFile(id) {
    if (!this.uploadDir || typeof id !== 'string' || !IMAGE_ID.test(id)) return null;
    const file = path.join(this.uploadDir, id);
    try { return (await fs.lstat(file)).isFile() ? file : null; } catch (_) { return null; }
  }
  async read(req, type, limit) {
    if (!type.test(req.headers['content-type'] || '')) throw { status: 415 };
    const chunks = await new Promise((resolve, reject) => {
      let size = 0, oversized = false;
      const parts = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) { oversized = true; parts.length = 0; }
        else if (!oversized) parts.push(chunk);
      });
      req.once('end', () => oversized ? reject({ status: 413 }) : resolve(parts));
      req.once('error', () => reject({ status: 400 }));
    });
    return Buffer.concat(chunks);
  }
  async body(req) {
    const data = await this.read(req, /^application\/json(?:\s*;|$)/i, 65_536);
    try {
      const value = JSON.parse(data.toString('utf8'));
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
    const credential = this.credential(req);
    // An explicit wrong credential must never fall back to a valid cookie.
    if (req.headers.authorization !== undefined && !credential) return this.unauthorized(res, this.loginBan(context.ip) || this.failedLogin(context.ip));
    if (url.pathname === '/login' && req.method === 'POST') {
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
      res.setHeader('Set-Cookie', this.cookie(value));
      return this.json(res, 200, { authenticated: true });
    }
    if (!credential) {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(nonce));
      }
      return this.json(res, 401, { error: 'Unauthorized.' });
    }
    if (req.method === 'POST' && !matches(req.headers['x-csrf-token'], this.csrfToken(credential))) return this.json(res, 403, { error: 'CSRF token required.' });
    if (req.method === 'GET' && ASSETS[url.pathname]) {
      const [file, type] = ASSETS[url.pathname];
      const data = await fs.readFile(path.join(__dirname, 'mobile-web', file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname === '/api/auth') return this.json(res, 200, { authenticated: true, csrfToken: this.csrfToken(credential) });
    if (req.method === 'POST' && url.pathname === '/logout') {
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
        let body;
        try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
        if (Object.keys(body).length) return this.json(res, 400, { error: 'Invalid request.' });
      }
      const current = this.writeCredential(req, res);
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
      res.setHeader('Set-Cookie', this.cookie('', 0));
      return this.json(res, 200, { authenticated: false });
    }
    if (req.method === 'GET' && url.pathname === '/api/captain') return this.json(res, 200, this.sources.getCaptain ? await this.sources.getCaptain() : { turns: [], status: 'unavailable' });
    if (req.method === 'GET' && url.pathname === '/api/sessions') return this.json(res, 200, { sessions: await this.sources.getSessions() });
    if (req.method === 'GET' && url.pathname === '/api/tasks') return this.json(res, 200, { cards: await this.sources.getTasks() });
    if (req.method === 'GET' && url.pathname === '/api/output') {
      const id = url.searchParams.get('id');
      if (!id || id.length > 256 || /[\x00-\x1f]/.test(id)) return this.json(res, 400, { error: 'Session id required.' });
      const output = await this.sources.getOutput(id);
      if (!output) return this.json(res, 404, { error: 'Session not found.' });
      return this.json(res, 200, { id: output.id, title: output.title, text: String(output.text || '').slice(-64_000) });
    }
    if (req.method === 'POST' && url.pathname === '/api/captain') {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      const images = body.images === undefined ? [] : body.images;
      if (!Array.isArray(images) || images.length > IMAGE_LIMITS.perMessage || new Set(images).size !== images.length || images.some((id) => typeof id !== 'string' || !IMAGE_ID.test(id))) return this.json(res, 400, { error: `Images must be at most ${IMAGE_LIMITS.perMessage} uploaded image ids.` });
      if (Object.keys(body).some((key) => key !== 'message' && key !== 'images') || typeof body.message !== 'string' || !(body.message.trim() || images.length) || body.message.length > 8000 || /\x00/.test(body.message)) return this.json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      const files = await Promise.all(images.map((id) => this.imageFile(id)));
      if (files.includes(null)) return this.json(res, 400, { error: 'Image not found. Upload it again.' });
      // Body uploads can outlive desktop revocation. Resolve the current device
      // and CSRF secret again immediately before queuing a command.
      if (!this.writeCredential(req, res)) return;
      await this.sources.sendCaptain(body.message, files);
      return this.json(res, 200, { queued: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/upload' && this.uploadDir) {
      let data;
      try { data = await this.read(req, /^application\/octet-stream$/i, IMAGE_LIMITS.bytes); } catch (err) { return this.json(res, err.status || 400, { error: err.status === 413 ? 'Image too large.' : 'Invalid request.' }); }
      const kind = imageKind(data);
      if (!kind) return this.json(res, 415, { error: 'Only JPEG, PNG, GIF or WebP images are accepted.' });
      if (!this.writeCredential(req, res)) return;
      const id = crypto.randomBytes(16).toString('hex') + '.' + kind;
      await fs.mkdir(this.uploadDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(this.uploadDir, id), data, { mode: 0o600, flag: 'wx' });
      return this.json(res, 200, { id });
    }
    if (req.method === 'GET' && url.pathname === '/api/image') {
      const id = url.searchParams.get('id'), file = await this.imageFile(id);
      if (!file) return this.json(res, IMAGE_ID.test(id || '') ? 404 : 400, { error: 'Image not found.' });
      const data = await fs.readFile(file);
      // Ids are random and their content never changes, so the device may keep them.
      res.writeHead(200, { 'Content-Type': IMAGE_TYPES[IMAGE_ID.exec(id)[1]], 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=86400, immutable' });
      return res.end(data);
    }
    return this.json(res, 404, { error: 'Not found.' });
  }
}

module.exports = { MobileWebServer, DEFAULT_PORT, LOGIN_LIMITS, IMAGE_LIMITS };
