'use strict';
// Local stand-in for the VPS: runs a temporary Caddy (admin API off, loopback only) built from the
// shipped deploy/vps/Caddyfile.agentdeck plus two fake AgentDeck backends. Never touches a real Caddy or VPS.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SNIPPET = path.join(REPO, 'deploy', 'vps', 'Caddyfile.agentdeck');
const PROD_DOMAIN = 'agentdeck.18-139-28-180.sslip.io';
const AUTH_USER = 'phone';
const AUTH_PASS = crypto.randomBytes(9).toString('hex');

function findCaddy() {
  if (process.platform === 'win32') return null; // these deploy tests are POSIX only
  const candidates = [process.env.CADDY_BIN, 'caddy'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return { bin, version: r.stdout.trim().split(/\s+/)[0] };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// A fake machine. Echoes what it received and mimics the AgentDeck per-machine cookie contract.
class FakeMachine {
  constructor(name, cookieName, cookiePath) {
    this.name = name; this.cookieName = cookieName; this.cookiePath = cookiePath;
    this.requests = []; this.mode = 'ok'; this.sockets = new Set(); this.server = null; this.port = 0;
  }
  async start(port = this.port) {
    this.port = port || await freePort();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolve); });
  }
  stop() {
    for (const s of this.sockets) s.destroy();
    const server = this.server; this.server = null;
    return server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
  }
  handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks).toString('utf8') };
      this.requests.push(record);
      if (this.mode === 'hang') return; // accept, never answer (half-open tunnel after sleep)
      if (this.scripted) {
        const scripted = this.scripted;
        this.scripted = null;
        res.writeHead(scripted.status || 200, scripted.headers || {});
        res.end(scripted.body == null ? '' : scripted.body);
        return;
      }
      // Hostile headers on purpose: Caddy must overwrite them. charset matches AgentDeck's json().
      const send = (status, body, extra = {}) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
          'X-Content-Type-Options': 'sniff',
          ...extra,
        });
        res.end(JSON.stringify(body));
      };
      const pathOnly = req.url.split('?')[0];
      if (pathOnly === `${this.cookiePath}api/info`) {
        if (req.method !== 'GET') return send(401, { error: 'Unauthorized.' });
        const label = this.name === 'mac' ? 'Mac' : 'Windows';
        const platform = this.name === 'mac' ? 'darwin' : 'win32';
        return send(200, { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath'], machine: { id: this.name, label, platform } });
      }
      if (req.url.startsWith(`${this.cookiePath}login`)) {
        const value = crypto.randomBytes(8).toString('hex');
        return send(200, { machine: this.name, loggedIn: true },
          { 'Set-Cookie': `${this.cookieName}=${value}; Path=${this.cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
      }
      if (req.url.startsWith(`${this.cookiePath}api/status/`)) return send(Number(req.url.split('/').pop()) || 500, { machine: this.name, backendSays: 'own error body' });
      if (!req.url.startsWith(this.cookiePath)) return send(404, { machine: this.name, error: 'wrong prefix' });
      send(200, { machine: this.name, url: req.url, host: req.headers.host, cookie: req.headers.cookie || '' });
    });
  }
}

function substitute(text, { siteAddress, authFile, gateFile, logFile, hubRoot, macPort, winPort }) {
  const replaced = text
    .replace(`${PROD_DOMAIN} {`, `${siteAddress} {`)
    .replaceAll('/etc/caddy/agentdeck-basicauth.caddy', authFile)
    .replaceAll('/etc/caddy/agentdeck-gate.caddy', gateFile)
    .replaceAll('/var/log/caddy/agentdeck-access.log', logFile)
    .replaceAll('/srv/agentdeck-hub', hubRoot)
    .replaceAll('127.0.0.1:43122 {', `127.0.0.1:${macPort} {`)
    .replaceAll('127.0.0.1:43123 {', `127.0.0.1:${winPort} {`);
  for (const needle of [siteAddress, authFile, gateFile, logFile, hubRoot, `127.0.0.1:${macPort} {`, `127.0.0.1:${winPort} {`]) {
    if (!replaced.includes(needle)) throw new Error(`test substitution failed for ${needle}`);
  }
  return replaced;
}

async function startStack(caddy, { hubDir, https = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-vps-'));
  const mac = new FakeMachine('mac', '__Secure-agentdeck_mac', '/mac/');
  const win = new FakeMachine('win', '__Secure-agentdeck_win', '/win/');
  await mac.start(); await win.start();
  const port = await freePort();
  const hubRoot = path.join(dir, 'hub');
  fs.cpSync(hubDir || path.join(__dirname, 'hub'), hubRoot, { recursive: true });
  // The real login page, so the tests run what ships.
  fs.cpSync(path.join(REPO, 'mobile-web', 'hub', 'gate'), path.join(hubRoot, 'gate'), { recursive: true });
  const authFile = path.join(dir, 'agentdeck-basicauth.caddy');
  const hash = execFileSync(caddy.bin, ['hash-password', '--plaintext', AUTH_PASS], { encoding: 'utf8' }).trim();
  fs.writeFileSync(authFile, `basicauth {\n\t${AUTH_USER} ${hash}\n}\n`);
  const gateFile = path.join(dir, 'agentdeck-gate.caddy');
  const gateSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(gateFile, `vars gate_secret ${gateSecret}\n`);
  const logFile = path.join(dir, 'access.log');
  // localhost (not a custom name) so a real browser treats Secure cookies as allowed on plain HTTP.
  // https: Caddy's own internal certificate (nothing is added to any trust store); WebKit only stores Secure cookies over https.
  const siteAddress = `${https ? 'https' : 'http'}://localhost:${port}`;
  const body = substitute(fs.readFileSync(SNIPPET, 'utf8'), { siteAddress, authFile, gateFile, logFile, hubRoot, macPort: mac.port, winPort: win.port });
  const caddyfile = path.join(dir, 'Caddyfile');
  fs.writeFileSync(caddyfile, https ? `{\n\tadmin off\n\tskip_install_trust\n\tlocal_certs\n}\n${body}` : `{\n\tadmin off\n\tauto_https off\n}\n${body}`);
  const validate = spawnSync(caddy.bin, ['validate', '--config', caddyfile, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  if (validate.status !== 0) {
    await mac.stop(); await win.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`caddy validate failed: ${validate.stderr}`);
  }
  const child = spawn(caddy.bin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, XDG_DATA_HOME: path.join(dir, 'caddy-data'), XDG_CONFIG_HOME: path.join(dir, 'caddy-config') } });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  await waitForPort(port);
  const stack = {
    dir, port, mac, win, hubRoot, logFile, gateSecret, gateFile, caddyfile, siteAddress,
    get stderr() { return stderr; },
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      await mac.stop(); await win.stop();
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return stack;
}

async function waitForPort(port, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} never opened`);
}

// Raw request: the path is sent exactly as given (no client-side normalisation).
function request(port, rawPath, { method = 'GET', headers = {}, body, auth = true, gate = null, timeout = 8000 } = {}) {
  const h = { ...headers };
  if (auth === true) h.Authorization = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  else if (typeof auth === 'string') h.Authorization = auth;
  if (gate) h.Cookie = `__Host-agentdeck_gate=${gate}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: { Host: `localhost:${port}`, ...h }, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, text, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { REPO, SNIPPET, PROD_DOMAIN, AUTH_USER, AUTH_PASS, findCaddy, freePort, FakeMachine, startStack, request, waitForPort };
