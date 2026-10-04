'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 43121;
const COOKIE = 'agentdeck_mobile';
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The 401 page is the only unauthenticated document. No app data or token is
// embedded here; a successful login reloads the authenticated page.
function loginPage(nonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentDeck 登录</title><style nonce="${nonce}">
  :root{color-scheme:light dark;font:16px system-ui}body{margin:0;padding:24px;background:light-dark(#f5f6fa,#141820);color:light-dark(#202637,#edf0f6)}main{max-width:360px;margin:16vh auto}h1{font-size:28px}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:12px;font:inherit}input{border:1px solid #7b8392}button{margin-top:16px;background:#4064d9;color:white;border:0;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #87a7ff;outline-offset:3px}p{line-height:1.6}#error{color:light-dark(#a22323,#ffb4b4);min-height:24px}
  </style><main><h1>AgentDeck</h1><p>在桌面设置中开启手机网页端，并复制登录 token。</p><form id="login"><label for="token">登录 token</label><input id="token" type="password" autocomplete="current-password" required spellcheck="false"><button type="submit">登录</button><p id="error" role="alert"></p></form></main><script nonce="${nonce}">
  document.getElementById('login').addEventListener('submit',async(e)=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value})});if(r.ok)location.reload();else document.getElementById('error').textContent=r.status===401?'token 不正确，请重试。':'暂时无法登录，请重试。';}catch(_){document.getElementById('error').textContent='无法连接，请重试。';}finally{button.disabled=false;}});
  </script></html>`;
}

class MobileWebServer {
  constructor({ getSessions, getTasks, getOutput, sendCaptain, saveSettings }) {
    this.sources = { getSessions, getTasks, getOutput, sendCaptain, saveSettings };
    this.settings = { enabled: false, token: '', port: DEFAULT_PORT };
    this.server = null;
    this.cookie = '';
    this.error = '';
    this.pending = Promise.resolve();
  }
  status() {
    const port = this.server?.address()?.port || this.settings.port;
    return { enabled: !!this.server?.listening, url: this.server?.listening ? `http://127.0.0.1:${port}` : '', token: this.settings.token, port, error: this.error };
  }
  configure(settings = {}) {
    this.pending = this.pending.then(() => this.applySettings(settings));
    return this.pending;
  }
  async applySettings(value) {
    await this.close();
    this.error = '';
    const next = { ...this.settings, ...value };
    const port = next.port;
    this.settings = { enabled: next.enabled === true, token: typeof next.token === 'string' ? next.token : '', port };
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.error = 'Invalid local port.';
      return this.status();
    }
    try {
      if (this.settings.enabled && !this.settings.token) this.settings.token = crypto.randomBytes(32).toString('hex');
      await this.sources.saveSettings({ ...this.settings });
      if (!this.settings.enabled) return this.status();
      // A separate credential avoids exposing the login token through cookie
      // storage while remembering the device across app restarts.
      this.cookie = crypto.createHmac('sha256', this.settings.token).update('agentdeck-mobile-cookie-v1').digest('hex');
      const server = http.createServer((req, res) => { this.handle(req, res).catch(() => { if (!res.headersSent) this.json(res, 500, { error: 'Local service unavailable.' }); else res.end(); }); });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      this.server = server;
    } catch (err) {
      this.cookie = '';
      this.error = err.code === 'EADDRINUSE' ? 'Local port is already in use.' : 'Could not start local web service.';
    }
    return this.status();
  }
  async close() {
    const server = this.server;
    this.server = null;
    this.cookie = '';
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  authenticated(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization);
      return !!match && matches(match[1], this.settings.token);
    }
    const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
    return !!cookie && matches(cookie.slice(COOKIE.length + 1), this.cookie);
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
    const port = this.server?.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return this.json(res, 403, { error: 'Local host required.' });
    // An explicit wrong credential must never fall back to a valid cookie.
    if (req.headers.authorization !== undefined && !this.authenticated(req)) return this.json(res, 401, { error: 'Unauthorized.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return this.json(res, 403, { error: 'Same origin required.' });
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return this.json(res, 403, { error: 'Same origin required.' });
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch (_) { return this.json(res, 400, { error: 'Invalid URL.' }); }
    if (url.origin !== `http://${req.headers.host}`) return this.json(res, 400, { error: 'Invalid URL.' });
    if (url.pathname === '/login' && req.method === 'POST') {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      if (!matches(body.token, this.settings.token)) return this.json(res, 401, { error: 'Unauthorized.' });
      res.setHeader('Set-Cookie', `${COOKIE}=${this.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
      return this.json(res, 200, { authenticated: true });
    }
    if (!this.authenticated(req)) {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(nonce));
      }
      return this.json(res, 401, { error: 'Unauthorized.' });
    }
    if (req.method === 'GET' && ASSETS[url.pathname]) {
      const [file, type] = ASSETS[url.pathname];
      const data = await fs.readFile(path.join(__dirname, 'mobile-web', file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    }
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
      if (Object.keys(body).some((key) => key !== 'message') || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 8000 || /\x00/.test(body.message)) return this.json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      await this.sources.sendCaptain(body.message);
      return this.json(res, 200, { queued: true });
    }
    return this.json(res, 404, { error: 'Not found.' });
  }
}

module.exports = { MobileWebServer, DEFAULT_PORT };
