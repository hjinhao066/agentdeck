'use strict';

// Local stand-in for the phone entry: a tiny "Caddy" that serves the static hub
// at / and forwards /mac/* and /win/* (prefix kept) to two fake AgentDeck
// machines implementing the v2 machine API from the three-ends design (§2.2).
// Test only: no real tokens, no real boards, nothing leaves loopback.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HUB = path.join(__dirname, '..', '..', 'mobile-web', 'hub');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/core.js': ['core.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/machines.json': ['machines.json', 'application/json; charset=utf-8'] };
// The headers the VPS adds to the static hub (design §3.5); the hub must work under them.
const HUB_HEADERS = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
function readJson(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (_) { resolve(null); } });
  });
}

// mode: 'online' | 'down' (proxy answers 502 {"offline":true}) | 'hang' (never
// answers, like a half-open tunnel) | 'legacy' (an old build: no api/info, and
// every prefixed path answers 401 because it does not know the prefix).
async function fakeMachine({ id, label, platform, hostname, appVersion = '1.2.0', sessions = [], turns = [], cards = [], outputs = {}, captain = true }) {
  const base = `/${id}/`, cookieName = `__Secure-agentdeck_${id}`;
  const csrfSecret = crypto.randomBytes(32);
  const machine = { id, label, mode: 'online', token: crypto.randomBytes(32).toString('hex'), devices: new Set(), failures: 0, bannedUntil: 0,
    requests: [], messages: [], sessions, cards, outputs, boardVersion: 'b1',
    captain: captain ? { id: `${id}-captain`, title: '队长', status: (sessions.find((s) => s.isMain) || { status: 'idle' }).status, turns } : null,
    setMode(mode) { machine.mode = mode; },
    setCards(next) { machine.cards = next; machine.boardVersion = crypto.randomBytes(4).toString('hex'); },
    posts(route) { return machine.requests.filter((r) => r.method === 'POST' && r.url === base + route); },
  };
  const device = (req) => {
    const values = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(cookieName + '='));
    return values.length === 1 && machine.devices.has(values[0].slice(cookieName.length + 1)) ? values[0].slice(cookieName.length + 1) : null;
  };
  const csrf = (value) => crypto.createHmac('sha256', csrfSecret).update(value).digest('hex');
  const cookie = (value, maxAge) => `${cookieName}=${value}; HttpOnly; Secure; SameSite=Strict; Path=${base}; Max-Age=${maxAge}`;
  const server = http.createServer(async (req, res) => {
    machine.requests.push({ method: req.method, url: req.url });
    if (machine.mode === 'hang') return;
    // A machine only answers under its own prefix, whatever the proxy sends it.
    if (!req.url.startsWith(base)) return json(res, 404, { error: 'Not found.' });
    const url = new URL(req.url.slice(base.length - 1), 'http://machine');
    if (machine.mode === 'legacy') return json(res, 401, { error: 'Unauthorized.' });
    if (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Same origin required.' });
    // Unauthenticated capability probe; fixed, non-sensitive fields only.
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath'], machine: { id, label, platform }, appVersion });
    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readJson(req);
      const ban = Math.ceil((machine.bannedUntil - Date.now()) / 1000);
      if (ban > 0) return json(res, 429, { error: 'Too many login attempts. Try again later.' }, { 'Retry-After': String(ban) });
      if (!body || body.token !== machine.token) {
        if (++machine.failures >= 5) { machine.bannedUntil = Date.now() + 15 * 60 * 1000; return json(res, 429, { error: 'Too many login attempts. Try again later.' }, { 'Retry-After': '900' }); }
        return json(res, 401, { error: 'Unauthorized.' });
      }
      const value = crypto.randomBytes(32).toString('hex');
      machine.devices.add(value); machine.failures = 0;
      return json(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(value, 30 * 24 * 60 * 60) });
    }
    const current = device(req);
    if (!current) return json(res, 401, { error: 'Unauthorized.' });
    if (req.method === 'POST' && req.headers['x-csrf-token'] !== csrf(current)) return json(res, 403, { error: 'CSRF token required.' });
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      return json(res, 200, { apiVersion: 2, machine: { id, label, platform, hostname, appVersion }, now: Date.now(), csrfToken: csrf(current),
        captain: machine.captain || { turns: [], status: 'unavailable' }, sessions: machine.sessions, boardVersion: machine.boardVersion });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth') return json(res, 200, { authenticated: true, csrfToken: csrf(current) });
    if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { sessions: machine.sessions });
    if (req.method === 'GET' && url.pathname === '/api/captain') return json(res, 200, machine.captain || { turns: [], status: 'unavailable' });
    if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, { cards: machine.cards });
    if (req.method === 'GET' && url.pathname === '/api/output') {
      const session = machine.sessions.find((s) => s.id === url.searchParams.get('id') && !s.isMain);
      return session ? json(res, 200, { id: session.id, title: session.title, text: machine.outputs[session.id] || '' }) : json(res, 404, { error: 'Session not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/captain') {
      const body = await readJson(req);
      if (!body || Object.keys(body).some((key) => key !== 'message') || typeof body.message !== 'string' || !body.message.trim()) return json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      if (!machine.captain) return json(res, 500, { error: 'Local service unavailable.' });
      machine.messages.push(body.message);
      machine.captain.turns.push({ id: 'turn-' + machine.messages.length, ts: Date.now(), user: body.message, reply: '', done: false, interrupted: false });
      return json(res, 200, { queued: true });
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      machine.devices.delete(current);
      return json(res, 200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
    }
    return json(res, 404, { error: 'Not found.' });
  });
  await listen(server);
  machine.port = server.address().port;
  machine.close = () => close(server);
  return machine;
}

function defaults() {
  const stamp = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const card = (id, project, title, status, updated, extra = {}) => ({ id, project, title, detail: '', status, flag: null, order: 0, assignee: null, latest_receipt: '', archived: false, updated: stamp(updated), ...extra });
  const shared = [
    card('hub-ui', 'AgentDeck 三端', '手机总台前端', 'doing', 20, { assignee: { agent: 'claude', model: 'opus' }, dispatch_claim: { key: 'k1', owner: 'Jinhao-MacBook.local', delivered: true }, latest_receipt: '总览和派活界面已完成，正在补截图。' }),
    card('win-tunnel', 'AgentDeck 三端', 'Windows 隧道和开机自启', 'todo', 90),
    card('weekly', '资料整理', '整理本周周报素材', 'done', 300, { latest_receipt: '素材已归档到周报目录。' }),
  ];
  return [
    { id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Jinhao-MacBook.local',
      sessions: [
        { id: 'mac-captain', title: '队长', model: 'claude-opus', status: 'working', isMain: true, receipt: '' },
        { id: 'mac-hub', title: '三端方案 · 手机总台', model: 'claude-opus', status: 'working', isMain: false, receipt: '总览和派活界面已完成，正在补截图。' },
        { id: 'mac-docs', title: '文档 · 双机说明', model: 'gemini-pro', status: 'done', isMain: false, receipt: '双机登录说明已写好，等待验收。' },
      ],
      turns: [{ id: 'mac-t1', ts: Date.now() - 600000, user: '出门前看一下三端方案的进度。', reply: 'Mac 队长测试回复：手机总台在做界面，文档已提交回执。\n<script>window.hubInjected=true</script>', done: true, interrupted: false }],
      outputs: { 'mac-hub': 'Mac 队员测试输出：\n✓ 总览卡片\n✓ 派活目标切换\n<img src=x onerror="window.hubInjected=true">', 'mac-docs': 'Mac 文档测试输出。' },
      // Mac synced a newer copy of win-tunnel than Windows has seen.
      cards: [...shared.filter((c) => c.id !== 'win-tunnel'), card('win-tunnel', 'AgentDeck 三端', 'Windows 隧道和开机自启', 'doing', 5, { dispatch_claim: { key: 'k2', owner: 'OWENJH', delivered: true }, assignee: { agent: 'codex', model: 'gpt' } })] },
    { id: 'win', label: 'Windows', platform: 'win32', hostname: 'OWENJH',
      sessions: [
        { id: 'win-captain', title: '队长', model: 'codex', status: 'idle', isMain: true, receipt: '' },
        { id: 'win-tunnel', title: '隧道守护脚本', model: 'codex', status: 'failed', isMain: false, receipt: 'Windows 测试回执：计划任务 dry-run 未通过，等待重试。' },
      ],
      turns: [{ id: 'win-t1', ts: Date.now() - 900000, user: '检查隧道守护脚本。', reply: 'Windows 队长测试回复：守护脚本 dry-run 失败，已安排重试。', done: true, interrupted: false }],
      outputs: { 'win-tunnel': 'Windows 队员测试输出：dry-run 失败。' },
      cards: [...shared, card('win-only', 'Hermes', '清理旧的定时任务日志', 'review', 40, { dispatch_claim: { key: 'k3', owner: 'OWENJH', delivered: true } })] },
  ];
}

async function startHub({ port = 0, machines = defaults() } = {}) {
  const fakes = {};
  for (const options of machines) fakes[options.id] = await fakeMachine(options);
  const proxy = http.createServer((req, res) => {
    const fake = Object.values(fakes).find((m) => req.url.startsWith(`/${m.id}/`));
    if (!fake) {
      const asset = req.method === 'GET' && STATIC[req.url.split('?')[0]];
      if (!asset) { res.writeHead(404, HUB_HEADERS); return res.end(); }
      res.writeHead(200, { ...HUB_HEADERS, 'Content-Type': asset[1] });
      return res.end(fs.readFileSync(path.join(HUB, asset[0])));
    }
    const offline = () => { if (!res.headersSent) json(res, 502, { offline: true }); else res.end(); };
    if (fake.mode === 'down') return offline();
    // Like the VPS: keep the prefix, replace forwarding headers, drop Authorization.
    const headers = { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress };
    delete headers.authorization;
    const upstream = http.request({ host: '127.0.0.1', port: fake.port, method: req.method, path: req.url, headers }, (answer) => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
    upstream.on('error', offline);
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await listen(proxy, port);
  // localhost (not 127.0.0.1) so the browser accepts the Secure cookies over http.
  return { url: `http://localhost:${proxy.address().port}`, machines: fakes,
    async close() { await close(proxy); for (const fake of Object.values(fakes)) await fake.close(); } };
}

module.exports = { startHub, fakeMachine, HUB_HEADERS };

// node tests/fixtures/hub-proxy.js → a local hub to click through by hand.
if (require.main === module) startHub({ port: Number(process.env.PORT) || 0 }).then((hub) => {
  console.log(hub.url);
  for (const fake of Object.values(hub.machines)) console.log(`${fake.label} test token: ${fake.token}`);
});
