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
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/machines.json': ['machines.json', 'application/json; charset=utf-8'], '/release.json': ['release.json', 'application/json; charset=utf-8'] };
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
// every prefixed path answers 401 because it does not know the prefix) | 'redirect'
// (a hostile machine: every answer is a 307 to machine.redirectTo, e.g. a path on the other machine).
// todos: this machine's answer to api/todos, as the phone view mobile-web.js sends
// (live items plus bare deletion marks); null is an older build without the route.
async function fakeMachine({ id, label, platform, hostname, appVersion = '1.2.0', sessions = [], turns = [], cards = [], outputs = {}, captain = true, quota = [], relay = null, todos = [], plainCookie = false }) {
  // plainCookie: WebKit refuses Secure cookies over http, even on localhost.
  const base = `/${id}/`, cookieName = plainCookie ? `agentdeck_${id}` : `__Secure-agentdeck_${id}`;
  const csrfSecret = crypto.randomBytes(32);
  const machine = { id, label, mode: 'online', token: crypto.randomBytes(32).toString('hex'), devices: new Set(), failures: 0, bannedUntil: 0,
    requests: [], messages: [], sessions, cards, outputs, quota, boardVersion: 'b1', todos: todos ? todos.map((t) => ({ ...t })) : null, todoWrites: [], todoRefuse: '', busy: false, queued: [],
    releaseQueued() { machine.busy = false; machine.captain.turns.push(...machine.queued.splice(0)); },
    captain: captain ? { id: `${id}-captain`, title: '队长', status: (sessions.find((s) => s.isMain) || { status: 'idle' }).status, turns } : null,
    setMode(mode) { machine.mode = mode; },
    setCards(next) { machine.cards = next; machine.boardVersion = crypto.randomBytes(4).toString('hex'); },
    posts(route) { return machine.requests.filter((r) => r.method === 'POST' && r.url === base + route); },
    // The Captain's accounts (null: an older build without api/relay). A switch
    // stays "switching" until the test ends it with finishRelay, like the desktop
    // which answers at once and reports the outcome later.
    relay: relay ? { currentId: relay.currentId, seats: relay.seats.map((seat) => ({ ...seat })), job: null, refuse: '' } : null, switches: [],
    finishRelay(ok, error = '') {
      const job = machine.relay.job;
      job.status = ok ? 'done' : 'failed'; job.error = ok ? '' : error; job.finishedAt = Date.now();
      if (!ok) return;
      machine.relay.currentId = job.targetId;
      // A new Captain: new id, new conversation.
      const captainId = `${id}-captain-${machine.switches.length + 1}`;
      machine.sessions = machine.sessions.map((s) => s.isMain ? { ...s, id: captainId, status: 'working' } : s);
      machine.captain = { id: captainId, title: '队长', status: 'working', turns: [{ id: captainId + '-t1', ts: Date.now(), user: '', reply: `${label} 新队长测试回复：已读存档，用 ${job.targetName} 接着干。`, done: true, interrupted: false }] };
    },
    // AgentDeck restarted on the way: the job is forgotten, the account says what happened.
    forgetRelay() { machine.relay.job = null; },
  };
  const relayState = () => {
    const state = machine.relay;
    return { captainId: machine.captain ? machine.captain.id : '', currentId: state.currentId, switching: !!state.job && state.job.status === 'switching', job: state.job, now: Date.now(),
      seats: state.seats.map((seat) => seat.id === state.currentId ? { ...seat, current: true, selectable: false, reason: 'current' } : { ...seat, current: false }) };
  };
  const device = (req) => {
    const values = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(cookieName + '='));
    return values.length === 1 && machine.devices.has(values[0].slice(cookieName.length + 1)) ? values[0].slice(cookieName.length + 1) : null;
  };
  const csrf = (value) => crypto.createHmac('sha256', csrfSecret).update(value).digest('hex');
  const cookie = (value, maxAge) => `${cookieName}=${value}; HttpOnly; ${plainCookie ? '' : 'Secure; '}SameSite=Strict; Path=${base}; Max-Age=${maxAge}`;
  // 待我处理: the phone view of this machine's items (null: a build without api/attention).
  machine.attention = null; machine.attentionWrites = [];
  const server = http.createServer(async (req, res) => {
    machine.requests.push({ method: req.method, url: req.url });
    if (machine.mode === 'hang') return;
    if (machine.mode === 'redirect') { res.writeHead(307, { Location: machine.redirectTo }); return res.end(); }
    // A machine only answers under its own prefix, whatever the proxy sends it.
    if (!req.url.startsWith(base)) return json(res, 404, { error: 'Not found.' });
    const url = new URL(req.url.slice(base.length - 1), 'http://machine');
    if (machine.mode === 'legacy') return json(res, 401, { error: 'Unauthorized.' });
    if (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Same origin required.' });
    // Unauthenticated capability probe; fixed, non-sensitive fields only.
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { app: 'agentdeck', apiVersion: 2, capabilities: ['snapshot', 'basePath', ...(machine.todos ? ['todos'] : [])], machine: { id, label, platform }, appVersion });
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
    // Display values only, like quotaView() in mobile-web.js; the account is already masked.
    if (req.method === 'GET' && url.pathname === '/api/quota') return json(res, 200, { rows: machine.quota, version: appVersion, now: Date.now() });
    // 待我处理, like mobile-web.js: read, reply, tick or put back one item.
    if (req.method === 'GET' && url.pathname === '/api/attention' && machine.attention) return json(res, 200, { items: machine.attention, now: Date.now() });
    if (req.method === 'POST' && url.pathname === '/api/attention' && machine.attention) {
      const body = await readJson(req);
      machine.attentionWrites.push(body);
      if (machine.attentionRefuse) return json(res, 409, { error: machine.attentionRefuse });
      if (body && body.op === 'read' && Array.isArray(body.ids)) { machine.attention.forEach((i) => { if (body.ids.includes(i.id) && !i.readAt) i.readAt = Date.now(); }); return json(res, 200, { ok: true, item: null }); }
      const item = body && machine.attention.find((i) => i.id === body.id);
      if (!item) return json(res, 400, { error: 'Invalid request.' });
      const now = Date.now();
      if (body.op === 'reply' && typeof body.text === 'string' && body.text.trim()) Object.assign(item, { done: true, doneAt: now, doneText: '你已回复', readAt: item.readAt || now, replies: [...(item.replies || []), { text: body.text.trim(), at: now, from: 'phone', seen: false }] });
      else if (body.op === 'done') Object.assign(item, { done: true, doneAt: now, doneText: item.kind === 'report' ? '你看过了' : '你标记已处理', readAt: item.readAt || now });
      else if (body.op === 'reopen') Object.assign(item, { done: false, doneAt: 0, doneText: '' });
      else return json(res, 400, { error: 'Invalid request.' });
      return json(res, 200, { ok: true, item });
    }
    if (req.method === 'GET' && url.pathname === '/api/relay' && machine.relay) return json(res, 200, relayState());
    if (req.method === 'POST' && url.pathname === '/api/relay' && machine.relay) {
      const body = await readJson(req);
      if (!body || Object.keys(body).some((key) => key !== 'seatId' && key !== 'expectCurrent') || typeof body.seatId !== 'string') return json(res, 400, { error: 'Seat id required.' });
      machine.switches.push(body);
      const state = relayState(), seat = state.seats.find((s) => s.id === body.seatId);
      if (machine.relay.refuse) return json(res, 409, { started: false, error: machine.relay.refuse });
      if (state.switching) return json(res, 409, { started: false, error: '电脑正在切换队长，等它结束再试' });
      if (body.expectCurrent && body.expectCurrent !== state.currentId) return json(res, 409, { started: false, error: '队长已经不在你看到的那个账号上了，请看最新状态后再选' });
      if (!seat || !seat.selectable) return json(res, 409, { started: false, error: '这个账号现在不能用' });
      const name = (s) => s.provider === 'Codex' ? s.name : s.name;
      machine.relay.job = { id: crypto.randomBytes(6).toString('hex'), status: 'switching', fromId: state.currentId, fromName: name(state.seats.find((s) => s.current) || { name: '' }),
        targetId: seat.id, targetName: name(seat), startedAt: Date.now(), finishedAt: null, error: '' };
      return json(res, 200, { started: true, id: machine.relay.job.id });
    }
    // 随手记待办, like mobile-web.js: record one or tick one; the base stands in for an item not synced here yet.
    if (req.method === 'GET' && url.pathname === '/api/todos' && machine.todos) return json(res, 200, { items: machine.todos });
    if (req.method === 'POST' && url.pathname === '/api/todos' && machine.todos) {
      const body = await readJson(req);
      machine.todoWrites.push(body);
      if (machine.todoRefuse) return json(res, 400, { error: machine.todoRefuse });
      const now = new Date(Math.max(Date.now(), ...machine.todos.map((t) => Date.parse(t.updated) + 1))).toISOString();
      if (body && body.op === 'add' && typeof body.text === 'string' && body.text.trim() && Object.keys(body).length === 2) {
        const item = { id: 'td-' + crypto.randomUUID(), text: body.text.replace(/\s+/g, ' ').trim(), done: false, doneAt: null, created: now, updated: now };
        machine.todos.push(item);
        return json(res, 200, { item });
      }
      if (body && body.op === 'update' && typeof body.id === 'string' && typeof body.done === 'boolean') {
        let item = machine.todos.find((t) => t.id === body.id && !t.deleted);
        if (!item && body.base) { item = { id: body.id, text: body.base.text, done: !!body.base.done, doneAt: body.base.doneAt || null, created: body.base.created, updated: body.base.updated }; machine.todos.push(item); }
        if (!item) return json(res, 400, { error: '这条待办已经不在了，刷新一下。' });
        Object.assign(item, { done: body.done, doneAt: body.done ? now : null, updated: now });
        return json(res, 200, { item });
      }
      return json(res, 400, { error: 'Invalid to-do request.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/output') {
      const session = machine.sessions.find((s) => s.id === url.searchParams.get('id') && !s.isMain);
      return session ? json(res, 200, { id: session.id, title: session.title, text: machine.outputs[session.id] || '' }) : json(res, 404, { error: 'Session not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      await new Promise((resolve) => req.on('end', resolve));
      const data = Buffer.concat(parts);
      const starts = (bytes, offset = 0) => data.length >= offset + bytes.length && bytes.every((byte, i) => data[offset + i] === byte);
      const isImage = starts([0xff, 0xd8, 0xff]) || starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
        (starts([0x47, 0x49, 0x46, 0x38]) && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) ||
        (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8));
      if (!isImage) return json(res, 415, { error: 'Only JPEG, PNG, GIF or WebP images are accepted.' });
      const id = crypto.randomBytes(16).toString('hex') + '.png';
      machine.uploads = machine.uploads || [];
      machine.uploads.push({ id, bytes: data.length });
      return json(res, 200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/api/captain') {
      const body = await readJson(req);
      const images = Array.isArray(body?.images) ? body.images : [];
      if (!body || Object.keys(body).some((key) => key !== 'message' && key !== 'images') || typeof body.message !== 'string' || !(body.message.trim() || images.length) || body.message.length > 8000) return json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      if (!machine.captain) return json(res, 500, { error: 'Local service unavailable.' });
      machine.messages.push(body.message);
      // A busy Captain (machine.busy): the desktop accepts the message and types it in only once the Captain is idle (releaseQueued).
      const turn = { id: 'turn-' + machine.messages.length, ts: Date.now(), user: body.message, images, reply: '', done: false, interrupted: false };
      if (machine.busy) machine.queued.push(turn); else machine.captain.turns.push(turn);
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
  const at = (minutes) => Date.now() + minutes * 60000, ago = (minutes) => Date.now() - minutes * 60000;
  const cell = (key, remaining, resetMinutes, extra = {}) => ({ key, remaining, out: false, resetAt: at(resetMinutes), ...extra });
  const seat = (key, provider, name, short, flag, cells, extra = {}) => ({ key, provider, name, short, flag, captain: false, status: 'normal', failed: false, cells,
    recoveryAt: null, sampledAt: ago(3), account: 'h***@example.com', source: 'test fixture', ...extra });
  return [
    { id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Jinhao-MacBook.local',
      quota: [
        seat('claude-1', 'Claude', 'Claude Max · h***@example.com', 'Max', '🇺🇸', [cell('5h', 72, 95), cell('7d', 41, 3000)], { captain: true }),
        seat('codex-1', 'Codex', 'Codex Pro · h***@example.com', 'Pro', '🇺🇸', [cell('5h', 8, 40), cell('7d', 63, 5000)], { status: 'danger' }),
        seat('codex-2', 'Codex', 'Codex Plus · w***@example.com', 'Plus', '🇨🇳', [cell('5h', 0, 70, { out: true }), cell('7d', 12, 4000)], { status: 'out', recoveryAt: at(70) }),
      ],
      sessions: [
        { id: 'mac-captain', title: '队长', model: 'claude-opus', status: 'working', isMain: true, receipt: '' },
        { id: 'mac-hub', title: '三端方案 · 手机总台', model: 'claude-opus', status: 'working', isMain: false, receipt: '总览和派活界面已完成，正在补截图。' },
        { id: 'mac-docs', title: '文档 · 双机说明', model: 'gemini-pro', status: 'done', isMain: false, receipt: '双机登录说明已写好，等待验收。' },
      ],
      // One message, then everything the desktop injected on the way: dispatch cards, a notice, two receipts and the reply.
      // The reply is as the desktop reads it off the terminal: the echoed prompt, a tool summary and a notice ride along.
      turns: [{ id: 'mac-t1', ts: Date.now() - 600000, user: '出门前看一下三端方案的进度。', reply: '', done: true, interrupted: false },
        { id: 'mac-t2', ts: Date.now() - 590000, kind: 'task', task: { title: '手机总台前端', status: 'doing', summary: '', failed: false }, user: '', reply: '', done: true, interrupted: false },
        { id: 'mac-t3', ts: Date.now() - 580000, kind: 'task', task: { title: '双机说明文档', status: 'review', summary: '后来又给这个会话发了新指令，结果看后面的卡片。', failed: false }, user: '', reply: '', done: true, interrupted: false },
        { id: 'mac-t4', ts: Date.now() - 570000, kind: 'notice', user: '', reply: '队员回执已送达', done: true, interrupted: false },
        { id: 'mac-t5', ts: Date.now() - 560000, user: '', reply: '❯ 出门前看一下三端方案的进度。\n\nRead 1 file, ran 2 shell commands\n\nBackground command "Background listener for crew\n\nreceipts" completed (exit code 0)\n\nMac 队长测试回复：手机总台在做界面，文档已提交回执。\n<script>window.hubInjected=true</script>', steps: ['Bash(git status)', '派发两张卡'], done: true, interrupted: false }],
      outputs: { 'mac-hub': 'Mac 队员测试输出：\n✓ 总览卡片\n✓ 派活目标切换\n<img src=x onerror="window.hubInjected=true">', 'mac-docs': 'Mac 文档测试输出。' },
      // Mac synced a newer copy of win-tunnel than Windows has seen.
      cards: [...shared.filter((c) => c.id !== 'win-tunnel'), card('win-tunnel', 'AgentDeck 三端', 'Windows 隧道和开机自启', 'doing', 5, { dispatch_claim: { key: 'k2', owner: 'OWENJH', delivered: true }, assignee: { agent: 'codex', model: 'gpt' } })] },
    { id: 'win', label: 'Windows', platform: 'win32', hostname: 'OWENJH',
      quota: [seat('codex-w', 'Codex', 'Codex Pro · o***@example.com', 'Pro', '🇺🇸', [cell('5h', 55, 120), cell('7d', 30, 4000)], { captain: true })],
      sessions: [
        { id: 'win-captain', title: '队长', model: 'codex', status: 'idle', isMain: true, receipt: '' },
        { id: 'win-tunnel', title: '隧道守护脚本', model: 'codex', status: 'failed', isMain: false, receipt: 'Windows 测试回执：计划任务 dry-run 未通过，等待重试。' },
      ],
      turns: [{ id: 'win-t1', ts: Date.now() - 900000, user: '检查隧道守护脚本。', reply: 'Windows 队长测试回复：守护脚本 dry-run 失败，已安排重试。', done: true, interrupted: false }],
      outputs: { 'win-tunnel': 'Windows 队员测试输出：dry-run 失败。' },
      cards: [...shared, card('win-only', 'Hermes', '清理旧的定时任务日志', 'review', 40, { dispatch_claim: { key: 'k3', owner: 'OWENJH', delivered: true } })] },
  ];
}

// Accounts for the switch tests: one in use and nearly empty, one healthy, one
// of unknown quota, one used up, one never logged in, and ChatGPT.
function relayFixture(currentId = 'us') {
  const at = (minutes) => Date.now() + minutes * 60000;
  const cell = (key, remaining, resetMinutes, out = false) => ({ key, remaining, out, resetAt: at(resetMinutes) });
  const seat = (id, name, cells, extra = {}) => ({ id, name, provider: 'Claude', account: id[0] + '***@example.com', current: false, selectable: true, reason: '', weekly: false, recoveryAt: null, cells, ...extra });
  return { currentId, seats: [
    seat('us', 'US', [cell('5h', 4, 95), cell('7d', 41, 3000)]),
    seat('cn', 'CN', [cell('5h', 72, 180), cell('7d', 63, 5000)]),
    seat('us2', 'US2', [], { reason: 'unknown' }),
    seat('eu', 'EU', [cell('5h', 0, 70, true), cell('7d', 12, 4000)], { selectable: false, reason: 'exhausted', recoveryAt: at(70) }),
    seat('jp', 'JP', [], { selectable: false, reason: 'login', account: '' }),
    seat('chatgpt', 'ChatGPT', [cell('5h', 55, 120), cell('7d', 30, 4000)], { provider: 'Codex', account: 'o***@example.com' }),
  ] };
}
// 待我处理 items as each computer's api/attention sends them: Mac has a decision,
// a login and two reports (one about a card), Windows a held card and an older finished one.
function attentionFixture() {
  const ago = (minutes) => Date.now() - minutes * 60000;
  const item = (id, kind, label, title, minutes, extra = {}) => ({ id, kind, label, title, ask: '', detail: '', files: [], project: '', cardTitle: '', sessionTitle: '', source: 'captain',
    created: ago(minutes), readAt: 0, done: false, doneAt: 0, doneText: '', replies: [], ...extra });
  return {
    mac: [
      item('at-m1-decide', 'need', '等你拍板', '网页端登录改成「1」能做，但谁都能控制两台电脑', 12, { ask: '回复「仍要 1」，或者「改成登录一次长期有效」', project: 'agentdeck', cardTitle: '网页端登录改成 1',
        detail: '取证结论：网页端在公网 VPS 上，登录后能给队长发指令。\n设成 1 等于任何人猜一次就能操控 Mac 和 Windows。\n更稳的做法：登录一次记住 1 年，或手机一键登录。', files: ['/Users/jinhao/reports/agentdeck-login/facts.md'] }),
      item('at-m2-login', 'need', '等你登录或授权', '小红书要你在 Mac 的 Chrome 里登录一次', 40, { ask: '登录后点「已处理」，抓取会自己接着跑', project: 'xhs-harvest' }),
      item('at-m3-report', 'report', '结果汇报', '小福助手排查报告回来了：结论是完全正常，但这个结论我还不认，已让它补查两件', 25, { project: '小福助手',
        detail: '补查一：用妹妹那份真实 Excel 走一遍上传→识别→写入。\n补查二：识别失败时有没有提示。', files: ['/Users/jinhao/reports/xiaofu/check.md', '/Users/jinhao/reports/xiaofu/recheck-plan.md'], cardTitle: '小福助手 Excel 识别' }),
      item('at-m4-report', 'report', '结果汇报', '「登录改成 1」的会话卡在确认窗口，我已替它点了「是」', 70, { project: 'agentdeck', readAt: ago(60), sessionTitle: '登录取证' }),
    ],
    win: [
      item('at-w1-held', 'need', '验收卡住了', '「Muse 冒烟测试」验收没过 2 次，已经停下', 95, { ask: '决定还做不做、要不要换个做法（回复会交给队长）。', project: 'muse', source: 'card', cardTitle: 'Muse 冒烟测试' }),
      item('at-w2-done', 'report', '结果汇报', 'Windows 隧道守护脚本 dry-run 通过了', 300, { readAt: ago(290), done: true, doneAt: ago(280), doneText: '你已回复', replies: [{ text: '好，开机自启也一起配上', at: ago(280), from: 'phone', seen: true }] }),
      item('at-w3-other', 'need', '要你处理', 'Windows 的 Bark 推送要你在手机上点一次允许', 420, { readAt: ago(410), done: true, doneAt: ago(400), doneText: '你标记已处理' }),
    ],
  };
}
// The default two computers, each with its own Captain accounts.
function withRelay() {
  const [mac, win] = defaults();
  return [{ ...mac, relay: relayFixture('us') }, { ...win, relay: relayFixture('chatgpt') }];
}

async function startHub({ port = 0, machines = defaults(), directory = HUB, plainCookie = false } = {}) {
  const fakes = {};
  for (const options of machines) fakes[options.id] = await fakeMachine({ ...options, plainCookie });
  const proxy = http.createServer((req, res) => {
    const fake = Object.values(fakes).find((m) => req.url.startsWith(`/${m.id}/`));
    if (!fake) {
      const asset = req.method === 'GET' && STATIC[req.url.split('?')[0]];
      if (!asset) { res.writeHead(404, HUB_HEADERS); return res.end(); }
      const file = path.join(directory, asset[0]);
      if (!fs.existsSync(file)) { res.writeHead(404, HUB_HEADERS); return res.end(); }
      res.writeHead(200, { ...HUB_HEADERS, 'Content-Type': asset[1] });
      return res.end(fs.readFileSync(file));
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

module.exports = { startHub, fakeMachine, HUB_HEADERS, relayFixture, withRelay, attentionFixture };

// node tests/fixtures/hub-proxy.js → a local hub to click through by hand.
if (require.main === module) startHub({ port: Number(process.env.PORT) || 0, machines: withRelay() }).then((hub) => {
  console.log(hub.url);
  for (const fake of Object.values(hub.machines)) console.log(`${fake.label} test token: ${fake.token}`);
});
