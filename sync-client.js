'use strict';
// Each AgentDeck pushes heartbeats and field patches to one sync server and
// pulls a snapshot back. The token stays in a local file; it is not written
// into the outbox, the error text, or the task JSON.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { MUTABLE_KEYS, isDeviceId, isSessionId, stripSecrets, LEASE_MS } = require('./shared-store');

const SYNC_MS = 10_000;
const HEARTBEAT_MS = 15_000;

function clip(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function pick(card) {
  const out = {};
  for (const key of MUTABLE_KEYS) if (card && Object.prototype.hasOwnProperty.call(card, key) && card[key] !== undefined) out[key] = card[key];
  return out;
}
function diff(base, next) {
  const set = {};
  const from = base || {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(from[key]) !== JSON.stringify(next[key])) set[key] = next[key];
  }
  return set;
}
function readToken(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('同步失败：没有配置令牌文件');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (_) { throw new Error('同步失败：令牌文件无法读取'); }
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text || text.length > 4096 || /[\r\n]/.test(text)) throw new Error('同步失败：令牌文件无法读取');
  return text;
}
function clampMs(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 50 && n <= 60_000 ? n : fallback;
}
function readFleetSettings({ env = {}, fleetFile } = {}) {
  let file = null;
  if (fleetFile && fs.existsSync(fleetFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fleetFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '两机同步配置无法读取' };
      file = parsed;
    } catch (_) { return { error: '两机同步配置无法读取' }; }
  }
  const baseUrl = String((env.AGENTDECK_FLEET_URL || (file && file.baseUrl) || '')).trim();
  const tokenFile = String((env.AGENTDECK_FLEET_TOKEN_FILE || (file && file.tokenFile) || '')).trim();
  if (!baseUrl && !tokenFile) return file ? { error: '两机同步配置不完整：需要服务地址和令牌文件路径' } : null;
  if (!baseUrl || !tokenFile) return { error: '两机同步配置不完整：需要服务地址和令牌文件路径' };
  let url;
  try { url = new URL(baseUrl); }
  catch (_) { return { error: '两机同步地址无效' }; }
  if (url.username || url.password) return { error: '两机同步地址不能带令牌' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: '两机同步地址无效' };
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return { baseUrl: url.origin + pathname, tokenFile, syncMs: clampMs(env.AGENTDECK_FLEET_SYNC_MS, SYNC_MS) };
}
function loadDevice(file) {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isDeviceId(current.id)) return { id: current.id, name: clip(current.name, 80) || '这台电脑', platform: current.platform || process.platform };
  } catch (_) {}
  const device = { id: 'dev-' + crypto.randomUUID(), name: clip(os.hostname(), 80) || '这台电脑', platform: process.platform, createdAt: new Date().toISOString() };
  atomicWrite(file, JSON.stringify(device) + '\n');
  return device;
}
function summaryOf(turns) {
  const first = Array.isArray(turns) ? turns[0] || {} : {};
  const text = first.prompt || first.user || first.text || first.content || '';
  return clip(typeof text === 'string' ? text : '', 200);
}

class FleetClient {
  constructor({ baseUrl, tokenFile, device, taskStore, historyDir, stateFile, sessions = () => [], version = '', syncMs = SYNC_MS, fetchImpl = globalThis.fetch, onChange = () => {} } = {}) {
    if (!baseUrl || !tokenFile || !device || !isDeviceId(device.id) || !taskStore || !historyDir || !stateFile) throw new Error('Fleet client is missing its data directories.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.tokenFile = tokenFile;
    this.device = { id: device.id, name: clip(device.name, 80) || device.id, platform: device.platform || 'unknown' };
    this.taskStore = taskStore;
    this.historyDir = historyDir;
    this.stateFile = stateFile;
    this.sessions = sessions;
    this.version = clip(version, 40);
    this.syncMs = syncMs;
    this.fetchImpl = fetchImpl;
    this.onChange = onChange;
    this.bases = new Map();
    this.taskOutbox = new Map();
    this.historyOutbox = new Map();
    this.devices = [];
    this.history = [];
    this.error = null;
    this.lastSyncAt = null;
    this.timer = null;
    this._load();
    this._seedTasks();
  }
  _load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [id, base] of saved.bases || []) this.bases.set(id, base);
      for (const item of saved.taskOutbox || []) if (item && item.cardId) this.taskOutbox.set(item.cardId, item);
      for (const item of saved.historyOutbox || []) if (item && item.sessionId) this.historyOutbox.set(item.sessionId, item);
      this.lastSyncAt = typeof saved.lastSyncAt === 'string' ? saved.lastSyncAt : null;
      this.devices = Array.isArray(saved.devices) ? saved.devices : [];
      this.history = Array.isArray(saved.history) ? saved.history : [];
    } catch (_) {}
  }
  _persist() {
    atomicWrite(this.stateFile, JSON.stringify({
      bases: [...this.bases],
      taskOutbox: [...this.taskOutbox.values()],
      historyOutbox: [...this.historyOutbox.values()],
      devices: this.devices,
      history: this.history,
      lastSyncAt: this.lastSyncAt,
    }));
  }
  _seedTasks() {
    let cards = [];
    try { cards = this.taskStore.list({ archived: true }); }
    catch (_) { this.error = '同步失败：本地任务看板读不出来'; return; }
    for (const card of cards) {
      const base = this.bases.get(card.id);
      if (base) {
        if (Object.keys(diff(base.fields, pick(card))).length) this.noteCard(card);
      } else if (Number.isInteger(card.revision) && card.revision > 0) {
        this.bases.set(card.id, { revision: card.revision, fields: pick(card) });
      } else this.noteCard(card);
    }
  }
  noteCard(card) {
    if (!card || typeof card.id !== 'string') return;
    const fields = pick(card);
    const base = this.bases.get(card.id);
    const set = base ? diff(base.fields, fields) : fields;
    if (!Object.keys(set).length) { this.taskOutbox.delete(card.id); this._persist(); return; }
    const previous = this.taskOutbox.get(card.id);
    this.taskOutbox.set(card.id, {
      opId: previous?.opId || ('op-' + crypto.randomUUID()),
      cardId: card.id,
      expectedRevision: base ? base.revision : 0,
      set,
    });
    this._persist();
  }
  noteResult(result) {
    if (!result) return;
    if (result.card) this.noteCard(result.card);
    if (Array.isArray(result.cards)) for (const card of result.cards) this.noteCard(card);
  }
  noteCaptain(sessionId, chat) {
    if (!isSessionId(sessionId) || !chat || typeof chat !== 'object') return;
    const turns = stripSecrets(Array.isArray(chat.turns) ? chat.turns : []);
    if (!turns.length) return;
    const contentHash = crypto.createHash('sha256').update(JSON.stringify(turns)).digest('hex');
    const previous = this.historyOutbox.get(sessionId);
    if (previous?.contentHash === contentHash) return;
    const times = turns.map((turn) => Date.parse(turn.ts || turn.at || '')).filter(Number.isFinite);
    this.historyOutbox.set(sessionId, {
      opId: 'op-' + crypto.randomUUID(),
      sessionId, contentHash, turns,
      summary: summaryOf(turns),
      startedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      endedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    });
    this._persist();
  }
  _safeError(err, token) {
    let message = err && err.message ? String(err.message) : '同步失败';
    if (!message.startsWith('同步失败')) message = '同步失败：' + message;
    if (token) message = message.split(token).join('');
    return message.slice(0, 300);
  }
  async _send(token, method, pathname, body) {
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + pathname, {
        method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (_) { throw new Error('同步失败：连不上同步服务'); }
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { throw new Error('同步失败：服务返回了无法识别的内容'); }
    }
    if (response.status === 401) throw new Error('同步失败：同步服务拒绝了本机（检查令牌文件）');
    if (response.status === 409) {
      if (!payload.card) throw new Error('同步失败：冲突结果不完整');
      return { status: 409, body: payload };
    }
    if (!response.ok) throw new Error('同步失败：服务状态 ' + response.status);
    return { status: response.status, body: payload };
  }
  _accept(card) {
    this.bases.set(card.id, { revision: card.revision || 0, fields: pick(card) });
    this.taskStore.upsertSynced(card);
  }
  async _flushTasks(token) {
    for (const item of [...this.taskOutbox.values()]) {
      const result = await this._send(token, 'POST', '/v1/tasks', { ...item, deviceId: this.device.id });
      this._accept(result.body.card);
      this.taskOutbox.delete(item.cardId);
    }
  }
  async _flushHistory(token) {
    for (const item of [...this.historyOutbox.values()]) {
      await this._send(token, 'POST', '/v1/history', { ...item, deviceId: this.device.id });
      this.historyOutbox.delete(item.sessionId);
    }
  }
  _writeHistory(records) {
    fs.mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    const keep = new Set();
    const summaries = [];
    for (const record of records) {
      if (!record || !isSessionId(record.sessionId) || !isDeviceId(record.deviceId)) continue;
      const name = record.sessionId + '--' + record.deviceId + '.json';
      keep.add(name);
      atomicWrite(path.join(this.historyDir, name), JSON.stringify(stripSecrets(record)) + '\n');
      summaries.push({ sessionId: record.sessionId, deviceId: record.deviceId, summary: clip(record.summary, 200), updatedAt: record.updatedAt || null, startedAt: record.startedAt || null, endedAt: record.endedAt || null });
    }
    for (const name of fs.readdirSync(this.historyDir)) {
      if (!keep.has(name) && name.endsWith('.json')) fs.unlinkSync(path.join(this.historyDir, name));
    }
    this.history = summaries;
  }
  async _pull(token) {
    const result = await this._send(token, 'GET', '/v1/snapshot');
    const snap = result.body || {};
    this.devices = Array.isArray(snap.devices) ? snap.devices : [];
    const keep = [...this.taskOutbox.keys()];
    this.taskStore.replaceSynced(Array.isArray(snap.cards) ? snap.cards : [], keep);
    for (const card of snap.cards || []) {
      if (!this.taskOutbox.has(card.id)) this.bases.set(card.id, { revision: card.revision || 0, fields: pick(card) });
    }
    this._writeHistory(Array.isArray(snap.history) ? snap.history : []);
  }
  async syncOnce() {
    const run = (this.tail || Promise.resolve()).then(() => this._syncBody());
    this.tail = run.then(() => {}, () => {});
    return run;
  }
  async _syncBody() {
    let token = '';
    try {
      token = readToken(this.tokenFile);
      const sessions = (this.sessions() || []).filter((item) => item && isSessionId(item.id)).slice(0, 100).map((item) => ({
        id: item.id, role: item.role === 'captain' ? 'captain' : 'session', title: clip(item.title, 200), deviceId: this.device.id,
      }));
      const captain = sessions.find((item) => item.role === 'captain');
      const beat = await this._send(token, 'POST', '/v1/heartbeat', {
        id: this.device.id, name: this.device.name, platform: this.device.platform, version: this.version,
        captainSessionId: captain ? captain.id : null, sessions,
      });
      this.devices = beat.body.devices || this.devices;
      await this._flushTasks(token);
      await this._flushHistory(token);
      await this._pull(token);
      this.error = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.error = this._safeError(err, token);
    }
    this._persist();
    try { this.onChange(); } catch (_) {}
    return this.snapshot();
  }
  start() {
    if (this.timer) return;
    const tick = () => { this.syncOnce().catch((err) => { this.error = this._safeError(err, ''); this._persist(); }); };
    this.timer = setInterval(tick, this.syncMs);
    if (this.timer.unref) this.timer.unref();
    return tick();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  snapshot() {
    let conflictCount = 0;
    try {
      for (const card of this.taskStore.list({ archived: true })) if (Array.isArray(card.conflicts) && card.conflicts.length) conflictCount += card.conflicts.length;
    } catch (_) {}
    return { configured: true, selfId: this.device.id, devices: this.devices, error: this.error, lastSyncAt: this.lastSyncAt, history: this.history, conflictCount };
  }
}

module.exports = { FleetClient, readFleetSettings, loadDevice, readToken, SYNC_MS, HEARTBEAT_MS, LEASE_MS };
