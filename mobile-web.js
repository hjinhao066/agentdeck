'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const QuotaCore = require('./quota-core');
const FilePreview = require('./file-preview-core');
const fsSync = require('node:fs');

const DEFAULT_PORT = 43121;
const COOKIE = 'agentdeck_mobile';
const REMOTE_COOKIE = '__Host-agentdeck_mobile';
const MACHINE_COOKIE_PREFIX = '__Secure-agentdeck_';
const BASE_PATH = /^\/[a-z0-9][a-z0-9-]{0,31}\/$/;
// Letters, digits, punctuation and inner spaces only: no control, format
// (zero-width, bidirectional), line/paragraph separator, quote or angle-bracket
// characters, and no leading/trailing space. Length counts code points.
const LABEL = /^(?!\s)(?!.*\s$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>\uFF1C\uFF1E"'`\u00AB\u00BB\u2018-\u201F]{1,32}$/u;
const TOKEN = /^[^\s\x00-\x1f\x7f]{1,128}$/;
const GENERIC_LABEL = 'AgentDeck';
const API_VERSION = 2;
const LOGIN_ITEM_PLATFORMS = ['darwin', 'win32'];
const DEVICE_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const LOGIN_LIMITS = { perIp: 5, global: 30, windowMs: 10 * 60 * 1000, banMs: 15 * 60 * 1000 };
// Uploaded images: one per request, re-checked by file signature. The id is
// the server-generated file name, so a request can never name a path.
// The directory as a whole is capped too: past the cap, images older than a
// day make room (oldest first); if that is not enough the upload is refused.
const IMAGE_LIMITS = { bytes: 4 * 1024 * 1024, perMessage: 6, keepMs: 30 * 24 * 60 * 60 * 1000,
  maxFiles: 200, maxTotalBytes: 200 * 1024 * 1024, evictAfterMs: 24 * 60 * 60 * 1000 };
const IMAGE_ID = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;
// A message's deduplicationKey: made once on the phone, reused by its retries.
const SEND_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const SEND_KEYS = { keepMs: 24 * 60 * 60 * 1000, max: 1000 };
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
// core.js is the hub's rule module: both pages group the conversation and clean replies the same way.
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/core.js': ['hub/core.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

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

// Quota rows are rebuilt field by field: whatever the desktop hands over, the
// phone gets display values only, and an account is always h***@example.com.
const QUOTA_STATUS = ['out', 'stale', 'normal', 'warning', 'danger', 'nodigits', 'expired', 'unknown'];
// A seat's name is its account name, the part before the @: a whole address never goes to the phone.
const nameOnly = (value) => value.replace(/@[^\s，；（）()]*/g, '');
// The row's colour (QuotaCore.seatHealth): known values only, else none and the phone falls back to the status.
function quotaHealth(value, text) {
  if (!value || !QuotaCore.HEALTH_LEVELS.includes(value.level) || !QuotaCore.HEALTH_KINDS.includes(value.kind)) return null;
  return { level: value.level, kind: value.kind, label: text(value.label, 20), reason: text(value.reason, 160), action: text(value.action, 120) };
}
function quotaView(data, now) {
  const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
  const text = (value, max) => typeof value === 'string' ? nameOnly(value.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, max) : '';
  const rows = (Array.isArray(data?.rows) ? data.rows : []).slice(0, 16).filter((row) => row && typeof row === 'object').map((row) => ({
    key: text(row.key, 60), provider: text(row.provider, 20), name: text(row.name, 100), short: text(row.short, 40), flag: text(row.flag, 8),
    captain: row.captain === true,
    // An unrecognized status is never shown as usable.
    status: QUOTA_STATUS.includes(row.status) ? row.status : 'unknown', failed: row.failed === true,
    cells: (Array.isArray(row.cells) ? row.cells : []).filter((cell) => cell && ['5h', '7d'].includes(cell.key) && QuotaCore.percent(cell.remaining) !== null).slice(0, 2)
      .map((cell) => ({ key: cell.key, remaining: cell.remaining, out: cell.out === true, resetAt: time(cell.resetAt) })),
    recoveryAt: time(row.recoveryAt), sampledAt: time(row.sampledAt), account: QuotaCore.maskAccount(row.account), source: text(row.source, 60),
    ...(quotaHealth(row.health, text) ? { health: quotaHealth(row.health, text) } : {}),
  }));
  return { rows, version: /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(data?.version || '') ? data.version : '', now };
}

// The Captain's account switch, rebuilt field by field like the quota rows:
// ids, display names, a masked account, why a seat cannot be picked, and the
// last switch the phone asked for. No paths, commands or credentials.
const SEAT_ID = /^[a-zA-Z0-9_-]{1,40}$/;
// 随手记待办 from the phone: record one, or tick/untick one. Nothing else.
const TODO_ID = /^td-[A-Za-z0-9-]{8,64}$/;
// textUpdated names the content version the phone saw. api/todos lists these
// keys, so the phone sends an older build only the fields it accepts.
const TODO_BASE_KEYS = ['text', 'done', 'doneAt', 'created', 'updated', 'textUpdated'];
function todoRequest(body) {
  const keys = Object.keys(body);
  if (body.op === 'add') {
    if (keys.some((key) => key !== 'op' && key !== 'text') || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) return null;
    return { op: 'add', text: body.text };
  }
  if (body.op !== 'update' || keys.some((key) => !['op', 'id', 'done', 'base'].includes(key)) || typeof body.id !== 'string' || !TODO_ID.test(body.id) || typeof body.done !== 'boolean') return null;
  const base = body.base;
  if (base !== undefined) {
    if (!base || typeof base !== 'object' || Array.isArray(base) || Object.keys(base).some((key) => !TODO_BASE_KEYS.includes(key))) return null;
    if (typeof base.text !== 'string' || base.text.length > 2000 || typeof base.updated !== 'string' || base.updated.length > 40) return null;
    if (base.done !== undefined && typeof base.done !== 'boolean') return null;
    if (['doneAt', 'created', 'textUpdated'].some((key) => base[key] !== undefined && base[key] !== null && (typeof base[key] !== 'string' || base[key].length > 40))) return null;
  }
  return { op: 'update', id: body.id, done: body.done, ...(base ? { base } : {}) };
}
const RELAY_REASONS = ['', 'current', 'login', 'onboarding', 'exhausted', 'low', 'unknown'];
// The battery setting as the phone may see it: fixed fields only.
function batteryView(data) {
  const int = (v, min, max, fallback) => Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return {
    mode: data?.mode === 'off' ? 'off' : 'auto',
    cap: int(data?.cap, 1, 10, 3), capMin: 1, capMax: 10,
    onBattery: data?.onBattery === true, active: data?.active === true,
    boost: data?.boost === true, boostUntil: Number.isSafeInteger(data?.boostUntil) && data.boostUntil > 0 ? data.boostUntil : null,
    baseCap: int(data?.baseCap, 1, 1000, 30), effectiveCap: int(data?.effectiveCap, 1, 1000, 30),
    ...(Number.isInteger(data?.working) && data.working >= 0 ? { working: Math.min(data.working, 1000) } : {}),
  };
}

function relayView(data, now) {
  const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
  const text = (value, max) => typeof value === 'string' ? nameOnly(value.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, max) : '';
  const id = (value) => typeof value === 'string' && SEAT_ID.test(value) ? value : '';
  const seats = (Array.isArray(data?.seats) ? data.seats : []).slice(0, 12).filter((seat) => seat && id(seat.id)).map((seat) => {
    const reason = RELAY_REASONS.includes(seat.reason) ? seat.reason : 'unknown';
    return { id: seat.id, name: text(seat.name, 80), provider: seat.provider === 'Codex' ? 'Codex' : 'Claude', account: QuotaCore.maskAccount(seat.account),
      current: seat.current === true,
      // Only a seat the desktop positively offers is selectable; an unrecognized reason never is.
      selectable: seat.selectable === true && seat.current !== true && RELAY_REASONS.includes(seat.reason) && ['', 'unknown'].includes(seat.reason),
      reason, weekly: seat.weekly === true, recoveryAt: time(seat.recoveryAt),
      cells: (Array.isArray(seat.cells) ? seat.cells : []).filter((cell) => cell && ['5h', '7d'].includes(cell.key) && QuotaCore.percent(cell.remaining) !== null).slice(0, 2)
        .map((cell) => ({ key: cell.key, remaining: cell.remaining, out: cell.out === true, resetAt: time(cell.resetAt) })) };
  });
  const job = data?.job && typeof data.job === 'object' && /^[a-z0-9]{1,40}$/.test(data.job.id || '') && ['switching', 'done', 'failed'].includes(data.job.status)
    ? { id: data.job.id, status: data.job.status, fromId: id(data.job.fromId), fromName: text(data.job.fromName, 80), targetId: id(data.job.targetId), targetName: text(data.job.targetName, 80),
      startedAt: time(data.job.startedAt), finishedAt: time(data.job.finishedAt), error: text(data.job.error, 200) } : null;
  return { captainId: text(data?.captainId, 256), currentId: id(data?.currentId), switching: data?.switching === true || job?.status === 'switching', seats, job, now };
}

// 待我处理 items, rebuilt field by field: display text the desktop prepared,
// times and flags. No receipt ids, commands or credentials. Line breaks stay
// in the longer texts; other control characters go.
const ATTENTION_ID = /^at-[a-z0-9-]{4,40}$/;
function attentionView(data, now) {
  const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, max) : '';
  const line = (value, max) => text(value, max).replace(/\s+/g, ' ').trim();
  const items = (Array.isArray(data?.items) ? data.items : []).slice(0, 300)
    .filter((item) => item && typeof item.id === 'string' && ATTENTION_ID.test(item.id) && ['need', 'report'].includes(item.kind) && line(item.title, 300))
    .map((item) => ({
      id: item.id, kind: item.kind, label: line(item.label, 20) || (item.kind === 'need' ? '要你处理' : '结果汇报'),
      title: line(item.title, 300), ask: line(item.ask, 1000), detail: text(item.detail, 4000),
      options: item.kind === 'need' ? [...new Set((Array.isArray(item.options) ? item.options : []).map((o) => line(o, 24)).filter(Boolean))].slice(0, 6) : [],
      files: (Array.isArray(item.files) ? item.files : []).map((f) => line(f, 1024)).filter(Boolean).slice(0, 10),
      project: line(item.project, 120), cardTitle: line(item.cardTitle, 300), sessionTitle: line(item.sessionTitle, 300),
      source: ['captain', 'notify', 'card', 'automation', 'todo'].includes(item.source) ? item.source : 'captain',
      // The 队长 chat turn a report was said in (an id the captain history already shows).
      turn: item.kind === 'report' && typeof item.turn === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(item.turn) ? item.turn : '',
      automation: item.source === 'automation' ? line(item.automation, 40) : '',
      created: time(item.created), readAt: time(item.readAt), done: item.done === true, doneAt: item.done === true ? time(item.doneAt) : 0,
      doneText: item.done === true ? line(item.doneText, 200) : '',
      doneBy: item.done === true && ['user', 'reply', 'captain', 'card', 'session', 'seen', 'chat', 'todo'].includes(item.doneBy) ? item.doneBy : '',
      replies: (Array.isArray(item.replies) ? item.replies : []).slice(-3).filter((r) => r && typeof r.text === 'string')
        .map((r) => ({ text: text(r.text, 1000), at: time(r.at), from: r.from === 'phone' ? 'phone' : 'desktop', seen: r.seen === true })),
    }));
  const open = items.filter((item) => !item.done);
  const need = open.filter((item) => item.kind === 'need').length;
  const unreadReports = open.filter((item) => item.kind === 'report' && !item.readAt).length;
  return { items, counts: { need, reports: open.length - need, unreadReports, badge: need }, now };
}
// What the phone may do to an item: mark some read (via 'chat': their 队长
// reply was seen in the conversation), reply, tick, put back.
function attentionRequest(body) {
  const keys = Object.keys(body);
  if (body.op === 'read') {
    if (keys.some((key) => !['op', 'ids', 'via'].includes(key)) || !Array.isArray(body.ids) || body.ids.length > 100 || body.ids.some((id) => typeof id !== 'string' || !ATTENTION_ID.test(id))) return null;
    if (body.via !== undefined && body.via !== 'chat') return null;
    return { op: 'read', ids: [...new Set(body.ids)], ...(body.via ? { via: body.via } : {}) };
  }
  if (typeof body.id !== 'string' || !ATTENTION_ID.test(body.id)) return null;
  if (body.op === 'reply') {
    if (keys.some((key) => !['op', 'id', 'text'].includes(key)) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000 || /\x00/.test(body.text)) return null;
    return { op: 'reply', id: body.id, text: body.text };
  }
  if (!['done', 'reopen'].includes(body.op) || keys.some((key) => key !== 'op' && key !== 'id')) return null;
  return { op: body.op, id: body.id };
}

// Login-item registration is shared by the platforms whose Electron
// `openAtLogin` can restore the private web service after a user login.
function supportsLoginItem(platform) { return LOGIN_ITEM_PLATFORMS.includes(platform); }

// endpoint.json is the only source of the path prefix and name: they are taken
// from it on every (re)configure and never kept in config.json. Absent keys mean
// the legacy unprefixed mode; a malformed value is passed on so configure refuses
// to start instead of silently falling back.
function withEndpoint(settings, endpoint) {
  const { basePath, label, ...rest } = settings;
  if (endpoint === null || typeof endpoint !== 'object') endpoint = {};
  if (!rest.publicOrigin && typeof endpoint.publicOrigin === 'string') rest.publicOrigin = endpoint.publicOrigin;
  if (endpoint.basePath !== undefined) rest.basePath = endpoint.basePath;
  if (endpoint.label !== undefined) rest.label = endpoint.label;
  return rest;
}
function readEndpoint(file) {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
function persistable(settings) {
  const { basePath, label, ...rest } = settings;
  return rest;
}

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
  constructor({ getSessions, getTasks, getOutput, getCaptain, getQuota, sendCaptain, getRelay, switchRelay, saveSettings, getBoardVersion, getTodos, writeTodos, getProgress, machine = {}, uploadDir = '', now = Date.now, preview = null }) {
    this.sources = { getSessions, getTasks, getOutput, getCaptain, getQuota, sendCaptain, getRelay, switchRelay, saveSettings, getBoardVersion, getTodos, writeTodos, getProgress };
    this.machine = { platform: machine.platform || process.platform, hostname: machine.hostname || '', appVersion: machine.appVersion || '' };
    this.uploadDir = uploadDir ? path.resolve(uploadDir) : '';
    this.uploading = Promise.resolve();
    // File previews: { home, roots, denied } for file-preview-core, or null for none.
    this.preview = preview;
    this.previewTexts = { at: 0, texts: [] };
    // 待我处理: the list, and the user's read / reply / tick from the phone.
    const { getAttention, writeAttention, getBattery, setBattery } = arguments[0] || {};
    Object.assign(this.sources, { getAttention, writeAttention, getBattery, setBattery });
    this.settings = { enabled: false, token: '', port: DEFAULT_PORT, publicOrigin: '', devices: [] };
    this.server = null;
    this.error = '';
    this.warning = '';
    this.pending = Promise.resolve();
    this.storage = Promise.resolve();
    this.now = now;
    // Keys of messages already handed to the Captain, oldest first (see sendOnce).
    this.sentKeys = new Map();
    this.csrfSecret = crypto.randomBytes(32);
    this.failures = new Map();
    this.globalFailures = { count: 0, since: 0, bannedUntil: 0 };
  }
  status() {
    const port = this.server?.address()?.port || this.settings.port;
    const enabled = !!this.server?.listening;
    return { enabled, url: enabled ? `http://127.0.0.1:${port}` : '', publicUrl: enabled ? this.settings.publicOrigin : '', publicOrigin: this.settings.publicOrigin,
      token: this.settings.token, port, deviceCount: this.settings.devices.filter((device) => device.expiresAt > this.now()).length, error: this.error,
      ...(this.warning ? { warning: this.warning } : {}),
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
    this.warning = '';
    const next = { ...this.settings, ...value };
    const port = next.port;
    const origin = publicOrigin(next.publicOrigin);
    const token = typeof next.token === 'string' ? next.token : (typeof next.token === 'number' ? String(next.token) : '');
    // Prefix and label come only from this call, never from the previous
    // settings, so removing them from endpoint.json returns to the legacy mode
    // without restarting the app. Only undefined/'' mean "none"; null, false, 0
    // and every other non-string are invalid and refuse to start.
    const basePath = value.basePath === undefined || value.basePath === '' ? '' : value.basePath;
    let label = value.label === undefined || value.label === '' ? '' : value.label;
    const validBase = basePath === '' || (typeof basePath === 'string' && BASE_PATH.test(basePath));
    const validLabel = label === '' || (typeof label === 'string' && LABEL.test(label));
    // Without a prefix the label is meaningless. Ignore it so a rollback that
    // removes only basePath still lets the local login start, and say so.
    if (basePath === '' && label !== '') { label = ''; this.warning = 'Machine label ignored without a base path.'; console.warn('[mobile-web] ' + this.warning); }
    if (token !== this.settings.token) this.csrfSecret = crypto.randomBytes(32);
    this.settings = { enabled: next.enabled === true, token, port, publicOrigin: origin || '',
      ...(basePath && validBase ? { basePath } : {}),
      ...(basePath && label && validLabel ? { label } : {}),
      devices: (!this.settings.token || token === this.settings.token) && Array.isArray(next.devices) ? next.devices.filter((device) => device && /^[a-f0-9]{64}$/.test(device.hash) && Number.isSafeInteger(device.expiresAt) && device.expiresAt > this.now()).slice(-20).map((device) => ({ hash: device.hash, expiresAt: device.expiresAt })) : [] };
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      this.error = 'Invalid local port.';
      return this.status();
    }
    if (origin === null) { this.error = 'Public origin must be an HTTPS origin without a path.'; return this.status(); }
    if (!validBase) { this.error = 'Invalid base path.'; return this.status(); }
    if (basePath && !validLabel) { this.error = 'Invalid machine label.'; return this.status(); }
    if (token && !TOKEN.test(token)) { this.error = 'Invalid login token.'; return this.status(); }
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
  // A retry of a message the Captain already got (same phone, same key) gets the
  // first answer back and is never typed in again; one still being queued is
  // waited for. A key whose send failed is forgotten, so its retry goes through.
  // Kept in memory for a day: a restart of the app forgets them.
  sendOnce(id, words, send) {
    const now = this.now();
    for (const [old, entry] of this.sentKeys) { if (now - entry.at <= SEND_KEYS.keepMs) break; this.sentKeys.delete(old); }
    const seen = this.sentKeys.get(id);
    if (seen) return seen.words === words ? seen.done : Promise.resolve(null);
    const done = Promise.resolve().then(send).then(() => ({ queued: true }));
    this.sentKeys.set(id, { at: now, words, done });
    if (this.sentKeys.size > SEND_KEYS.max) this.sentKeys.delete(this.sentKeys.keys().next().value);
    done.catch(() => { if (this.sentKeys.get(id)?.done === done) this.sentKeys.delete(id); });
    return done;
  }
  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  machineLabel() {
    if (this.settings.label) return this.settings.label;
    return this.machine.platform === 'darwin' ? 'Mac' : this.machine.platform === 'win32' ? 'Windows' : GENERIC_LABEL;
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
    // Extra cookies of the same name can be planted next to the real one (for example through a Set-Cookie
    // smuggled past the entry proxy), so a request is not refused just for carrying them. It is accepted only
    // when exactly one of them is a registered, unexpired device cookie; none, or more than one, is no credential.
    const registered = String(req.headers.cookie || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(name + '='))
      .map((s) => s.slice(name.length + 1)).filter((value) => /^[a-f0-9]{64}$/.test(value))
      .map((value) => { const digest = hash(value); return this.settings.devices.find((device) => device.expiresAt > this.now() && matches(digest, device.hash)); })
      .filter(Boolean);
    return registered.length === 1 ? registered[0] : null;
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
  // Uploads older than a month are stale: the conversation only shows the
  // latest turns, and images the user removed before sending are never used.
  // Runs at start and before every upload. Returns whether `incoming` more
  // bytes fit under the directory caps after the clean-up.
  async sweepUploads(incoming = 0) {
    if (!this.uploadDir) return false;
    let kept = [];
    try {
      for (const name of await fs.readdir(this.uploadDir)) {
        if (!IMAGE_ID.test(name)) continue;
        const file = path.join(this.uploadDir, name), stat = await fs.lstat(file);
        if (this.now() - stat.mtimeMs > IMAGE_LIMITS.keepMs) await fs.unlink(file);
        else kept.push({ file, size: stat.size, time: stat.mtimeMs });
      }
    } catch (_) { /* Nothing uploaded yet. */ }
    const over = () => kept.length + (incoming ? 1 : 0) > IMAGE_LIMITS.maxFiles || kept.reduce((sum, entry) => sum + entry.size, incoming) > IMAGE_LIMITS.maxTotalBytes;
    kept.sort((a, b) => a.time - b.time);
    while (over() && kept.length && this.now() - kept[0].time > IMAGE_LIMITS.evictAfterMs) {
      try { await fs.unlink(kept[0].file); } catch (_) { /* Already gone. */ }
      kept = kept.slice(1);
    }
    return !over();
  }
  async storeUpload(data, kind) {
    if (!await this.sweepUploads(data.length)) return null;
    const id = crypto.randomBytes(16).toString('hex') + '.' + kind;
    await fs.mkdir(this.uploadDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.uploadDir, id), data, { mode: 0o600, flag: 'wx' });
    return id;
  }
  // Only a server-generated name that is a regular file directly inside the
  // upload directory resolves; anything else (paths, links, other files) is null.
  async imageFile(id) {
    if (!this.uploadDir || typeof id !== 'string' || !IMAGE_ID.test(id)) return null;
    const file = path.join(this.uploadDir, id);
    try { return (await fs.lstat(file)).isFile() ? file : null; } catch (_) { return null; }
  }
  // What the Captain, the receipts and 待我处理 said: only a path named there
  // (or one inside the report folders) can be previewed. What the user typed
  // on the phone is left out, so writing a path into a message opens nothing.
  // Kept for a few seconds: a PDF arrives in many pieces.
  async namedTexts() {
    if (this.now() - this.previewTexts.at < 3000 && this.previewTexts.at <= this.now()) return this.previewTexts.texts;
    const texts = [], add = (value) => { if (typeof value === 'string' && value) texts.push(value); };
    const safe = async (read) => { try { return read ? await read() : null; } catch (_) { return null; } };
    const [captain, sessions, cards, attention] = await Promise.all([safe(this.sources.getCaptain), safe(this.sources.getSessions), safe(this.sources.getTasks), safe(this.sources.getAttention)]);
    for (const turn of Array.isArray(captain?.turns) ? captain.turns : []) add(turn?.reply);
    for (const session of Array.isArray(sessions) ? sessions : []) add(session?.receipt);
    for (const card of Array.isArray(cards) ? cards : []) add(card?.latest_receipt);
    for (const item of attentionView(attention, this.now()).items) { add(item.title); add(item.ask); add(item.detail); item.files.forEach(add); }
    this.previewTexts = { at: this.now(), texts };
    return texts;
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
    // Unauthenticated capability probe so the phone can tell a current machine
    // that needs a login from an older build, which answers 401 to every path.
    // Fixed, non-sensitive fields only; no hostname, exact app version, token,
    // device or app data.
    if (req.method === 'GET' && route === '/api/info') {
      return this.json(res, 200, { app: 'agentdeck', apiVersion: API_VERSION, capabilities: ['snapshot', 'basePath', 'send-dedupe', ...(this.sources.getTodos && this.sources.writeTodos ? ['todos'] : []), ...(this.preview ? ['files'] : []), ...(this.sources.getBattery && this.sources.setBattery ? ['battery'] : []), ...(this.sources.getProgress ? ['progress'] : [])],
        machine: { id: this.settings.basePath ? this.settings.basePath.slice(1, -1) : 'local', label: this.machineLabel(), platform: this.machine.platform } });
    }
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
    if (req.method === 'GET' && route === '/api/quota') return this.json(res, 200, quotaView(this.sources.getQuota ? await this.sources.getQuota() : null, this.now()));
    if (req.method === 'GET' && route === '/api/sessions') return this.json(res, 200, { sessions: await this.sources.getSessions() });
    if (req.method === 'GET' && route === '/api/tasks') return this.json(res, 200, { cards: await this.sources.getTasks() });
    // 每日进展 for the hub's 版本更新 page: counts only, cleaned again by the page.
    if (req.method === 'GET' && route === '/api/progress') return this.json(res, 200, this.sources.getProgress ? await this.sources.getProgress() : { days: [] });
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
      const images = body.images === undefined ? [] : body.images;
      if (!Array.isArray(images) || images.length > IMAGE_LIMITS.perMessage || new Set(images).size !== images.length || images.some((id) => typeof id !== 'string' || !IMAGE_ID.test(id))) return this.json(res, 400, { error: `Images must be at most ${IMAGE_LIMITS.perMessage} uploaded image ids.` });
      if (Object.keys(body).some((key) => !['message', 'images', 'deduplicationKey'].includes(key)) || typeof body.message !== 'string' || !(body.message.trim() || images.length) || body.message.length > 8000 || /\x00/.test(body.message)) return this.json(res, 400, { error: 'Message required (maximum 8000 characters).' });
      const key = body.deduplicationKey;
      if (key !== undefined && (typeof key !== 'string' || !SEND_KEY.test(key))) return this.json(res, 400, { error: 'Invalid deduplicationKey.' });
      const files = await Promise.all(images.map((id) => this.imageFile(id)));
      if (files.includes(null)) return this.json(res, 400, { error: 'Image not found. Upload it again.' });
      // Body uploads can outlive desktop revocation. Resolve the current device
      // and CSRF secret again immediately before queuing a command.
      const current = this.writeCredential(req, res, prefixed);
      if (!current) return;
      try {
        if (key === undefined) { await this.sources.sendCaptain(body.message, files); return this.json(res, 200, { queued: true }); }
        // The desktop gets a key of its own for this phone's key: main may give up on a slow renderer
        // (5 s) that still queues the message later, and only the renderer can tell the retry of it.
        const result = await this.sendOnce(current.hash + ':' + key, hash(JSON.stringify([body.message, images])), () => this.sources.sendCaptain(body.message, files, hash('desktop:' + current.hash + ':' + key)));
        return result ? this.json(res, 200, result) : this.json(res, 409, { error: 'This deduplicationKey was used for a different message.' });
      } catch (err) {
        // No 队长 running on this computer (MainSession.sendMessage): the phone shows why. Anything else stays a 500.
        if (!/^请先在 AgentDeck 创建并启动队长/.test(String(err?.message || ''))) throw err;
        return this.json(res, 409, { error: '请先在 AgentDeck 创建并启动队长。' });
      }
    }
    // 待我处理: the same login, Origin, Fetch Metadata and CSRF checks as a
    // message to the Captain, re-checked after the body is read. A reply goes
    // to this computer's Captain only.
    if (req.method === 'GET' && route === '/api/attention' && this.sources.getAttention) return this.json(res, 200, attentionView(await this.sources.getAttention(), this.now()));
    if (req.method === 'POST' && route === '/api/attention' && this.sources.writeAttention) {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      const input = attentionRequest(body);
      if (!input) return this.json(res, 400, { error: 'Invalid request.' });
      if (!this.writeCredential(req, res, prefixed)) return;
      let result;
      try { result = await this.sources.writeAttention(input); }
      catch (err) { return this.json(res, 409, { error: String(err?.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || '没有成功。' }); }
      const view = result?.item ? attentionView({ items: [result.item] }, this.now()).items[0] || null : null;
      return this.json(res, 200, { ok: true, item: view });
    }
    // Moving the Captain to another account. Each machine answers only for its
    // own Captain, under its own prefix, cookie and CSRF token. The switch runs
    // on the desktop; this call only starts it and the phone polls GET for the outcome.
    if (req.method === 'GET' && route === '/api/relay' && this.sources.getRelay) return this.json(res, 200, relayView(await this.sources.getRelay(), this.now()));
    if (req.method === 'POST' && route === '/api/relay' && this.sources.switchRelay) {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      if (Object.keys(body).some((key) => key !== 'seatId' && key !== 'expectCurrent') || typeof body.seatId !== 'string' || !SEAT_ID.test(body.seatId)
        || (body.expectCurrent !== undefined && (typeof body.expectCurrent !== 'string' || !SEAT_ID.test(body.expectCurrent)))) return this.json(res, 400, { error: 'Seat id required.' });
      if (!this.writeCredential(req, res, prefixed)) return;
      let started;
      // A refusal (seat used up, not logged in, already switching) is an answer, not a fault: the Captain stays where it is.
      try { started = await this.sources.switchRelay({ seatId: body.seatId, ...(body.expectCurrent ? { expectCurrent: body.expectCurrent } : {}) }); }
      catch (err) { return this.json(res, 409, { started: false, error: String(err?.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) || '没有切换。' }); }
      if (!started || started.started !== true || !/^[a-z0-9]{1,40}$/.test(started.id || '')) return this.json(res, 409, { started: false, error: '没有切换。' });
      return this.json(res, 200, { started: true, id: started.id });
    }
    // 电池模式: this computer's own battery setting, read and changed from the phone. The change takes
    // effect on the desktop at once (queue limit, saved config); only mode and cap exist, both validated there.
    if (req.method === 'GET' && route === '/api/battery' && this.sources.getBattery) {
      const view = await this.sources.getBattery();
      return view ? this.json(res, 200, batteryView(view)) : this.json(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'POST' && route === '/api/battery' && this.sources.setBattery) {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      if (Object.keys(body).some((key) => !['mode', 'cap', 'boost', 'boostMinutes'].includes(key)) || (body.mode === undefined && body.cap === undefined && body.boost === undefined)) return this.json(res, 400, { error: 'Invalid request.' });
      if (!this.writeCredential(req, res, prefixed)) return;
      let view;
      try { view = await this.sources.setBattery(body); }
      catch (err) { return this.json(res, 400, { error: String(err?.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || '没有改成。' }); }
      return this.json(res, 200, batteryView(view));
    }
    // 随手记待办: the same login, Origin, Fetch Metadata and CSRF checks as a
    // message to the Captain, re-checked after the body is read.
    if (req.method === 'GET' && route === '/api/todos' && this.sources.getTodos) {
      const data = await this.sources.getTodos();
      return this.json(res, 200, { items: Array.isArray(data?.items) ? data.items : [], baseKeys: TODO_BASE_KEYS });
    }
    if (req.method === 'POST' && route === '/api/todos' && this.sources.writeTodos) {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      const input = todoRequest(body);
      if (!input) return this.json(res, 400, { error: 'Invalid to-do request.' });
      if (!this.writeCredential(req, res, prefixed)) return;
      let item;
      try { item = await this.sources.writeTodos(input); }
      catch (err) { return this.json(res, 400, { error: String(err?.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) || '没有记下。' }); }
      return this.json(res, 200, { item });
    }
    // Previewing a file the conversation named. A POST, so the path travels in
    // the body (never a URL) and the request carries the device's CSRF token.
    // Read only; file-preview-core decides what may be read and how much.
    // The answer is JSON (pictures and PDFs as base64 pieces): the entry proxy lets nothing else through.
    if (req.method === 'POST' && route === '/api/file' && this.preview) {
      let body;
      try { body = await this.body(req); } catch (err) { return this.json(res, err.status || 400, { error: 'Invalid request.' }); }
      const offset = body.offset === undefined ? 0 : body.offset;
      if (Object.keys(body).some((key) => key !== 'path' && key !== 'offset') || typeof body.path !== 'string' || !Number.isSafeInteger(offset) || offset < 0) return this.json(res, 400, { error: 'Invalid request.', code: 'invalid' });
      if (!this.writeCredential(req, res, prefixed)) return;
      let result;
      try { result = await FilePreview.readPreview(body.path, { ...this.preview, texts: await this.namedTexts(), offset }); }
      catch (_) { result = { ok: false, code: 'denied' }; }
      if (result.ok) return this.json(res, 200, result);
      return this.json(res, result.code === 'invalid' ? 400 : result.code === 'missing' ? 404 : 403, { error: result.code === 'missing' ? 'File not found.' : result.code === 'invalid' ? 'Invalid request.' : 'This file cannot be previewed.', code: result.code });
    }
    if (req.method === 'POST' && route === '/api/upload' && this.uploadDir) {
      let data;
      try { data = await this.read(req, /^application\/octet-stream$/i, IMAGE_LIMITS.bytes); } catch (err) { return this.json(res, err.status || 400, { error: err.status === 413 ? 'Image too large.' : 'Invalid request.' }); }
      const kind = imageKind(data);
      if (!kind) return this.json(res, 415, { error: 'Only JPEG, PNG, GIF or WebP images are accepted.' });
      if (!this.writeCredential(req, res, prefixed)) return;
      // One upload at a time checks and fills the directory, so parallel
      // requests cannot pass the cap together.
      const turn = this.uploading.then(() => this.storeUpload(data, kind));
      this.uploading = turn.catch(() => {});
      const id = await turn;
      if (!id) return this.json(res, 507, { error: 'Image storage is full. Try again tomorrow.' });
      return this.json(res, 200, { id });
    }
    if (req.method === 'GET' && route === '/api/image') {
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

module.exports = { MobileWebServer, batteryView, quotaView, relayView, attentionView, attentionRequest, todoRequest, TODO_BASE_KEYS, DEFAULT_PORT, LOGIN_LIMITS, IMAGE_LIMITS, boardVersionOf, supportsLoginItem, withEndpoint, readEndpoint, persistable, TOKEN };
