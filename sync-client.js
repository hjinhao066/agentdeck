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
// The window comes first: the first round starts this long after launch.
const START_DELAY_MS = 15_000;
// Task uploads are marked attempted, saved and accepted this many at a time.
const FLUSH_BATCH = 50;

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
  for (const key of new Set([...Object.keys(from), ...Object.keys(next)])) {
    const value = next[key] === undefined ? null : next[key];
    if (JSON.stringify(from[key] ?? null) !== JSON.stringify(value)) set[key] = value;
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
  const delay = Number(env.AGENTDECK_FLEET_START_DELAY_MS);
  const startDelayMs = env.AGENTDECK_FLEET_START_DELAY_MS !== undefined && Number.isInteger(delay) && delay >= 0 && delay <= 600_000 ? delay : START_DELAY_MS;
  return { baseUrl: url.origin + pathname, tokenFile, syncMs: clampMs(env.AGENTDECK_FLEET_SYNC_MS, SYNC_MS), startDelayMs };
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
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
    this.dirty = false;
    this.writtenHistory = new Map();
    this.historyStamps = new Map();
    // Transcripts an older build left in the state file, kept one file each
    // until the hub has them. Ones that could not be written stay in the state file.
    this.outboxDir = path.join(path.dirname(stateFile), path.basename(stateFile, '.json') + '-history-outbox');
    this.keptHistory = new Set();
    this.unmigrated = [];
    this.savedSyncAt = null;
    this._load();
    this._seedTasks();
  }
  _load() {
    let legacy = [];
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [id, base] of saved.bases || []) this.bases.set(id, base);
      for (const item of saved.taskOutbox || []) if (item && item.cardId) this.taskOutbox.set(item.cardId, item);
      legacy = saved.historyOutbox;
      this.lastSyncAt = typeof saved.lastSyncAt === 'string' ? saved.lastSyncAt : null;
      this.savedSyncAt = this.lastSyncAt;
      this.devices = Array.isArray(saved.devices) ? saved.devices : [];
      this.history = Array.isArray(saved.history) ? saved.history : [];
    } catch (_) {}
    this._migrateHistory(legacy);
  }
  _outboxFile(sessionId) {
    return path.join(this.outboxDir, crypto.createHash('sha256').update(sessionId).digest('hex') + '.json');
  }
  // Older builds kept whole transcripts in the state file. Each goes to its own
  // file first; the state file drops it only on a save after that file is on
  // disk, and the file goes once the hub has it, so a crash loses none.
  _migrateHistory(legacy) {
    let names = [];
    try { names = fs.readdirSync(this.outboxDir).filter((name) => name.endsWith('.json')); } catch (_) {}
    for (const name of names) {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(this.outboxDir, name), 'utf8'));
        if (item && isSessionId(item.sessionId) && Array.isArray(item.turns)) { this.historyOutbox.set(item.sessionId, item); this.keptHistory.add(item.sessionId); }
      } catch (_) {}
    }
    for (const item of Array.isArray(legacy) ? legacy : []) {
      if (!item || !isSessionId(item.sessionId) || !Array.isArray(item.turns)) continue;
      this.historyOutbox.set(item.sessionId, item);
      try {
        atomicWrite(this._outboxFile(item.sessionId), JSON.stringify(item));
        this.keptHistory.add(item.sessionId);
      } catch (_) { this.unmigrated.push(item); }
      this.dirty = true;
    }
  }
  _delivered(sessionId) {
    if (this.keptHistory.delete(sessionId)) {
      try { fs.unlinkSync(this._outboxFile(sessionId)); } catch (_) {}
    }
    const left = this.unmigrated.filter((item) => item.sessionId !== sessionId);
    if (left.length !== this.unmigrated.length) { this.unmigrated = left; this.dirty = true; }
  }
  // Captain transcripts noted by this build are not saved here: main.js notes
  // every captain chat again at launch from userData/chats.
  _persist() {
    atomicWrite(this.stateFile, JSON.stringify({
      bases: [...this.bases],
      taskOutbox: [...this.taskOutbox.values()],
      ...(this.unmigrated.length ? { historyOutbox: this.unmigrated } : {}),
      devices: this.devices,
      history: this.history,
      lastSyncAt: this.lastSyncAt,
    }));
    this.dirty = false;
    this.savedSyncAt = this.lastSyncAt;
  }
  _setBase(id, card) {
    const base = { revision: card.revision || 0, fields: pick(card) };
    if (!same(this.bases.get(id), base)) { this.bases.set(id, base); this.dirty = true; }
  }
  // Queues every local card the hub has not seen; writes nothing. Unsent
  // operations are rebuilt from the board and bases on the next launch, so only
  // an attempted operation has to reach disk (before its request goes out).
  _seedTasks() {
    let cards = [];
    try { cards = this.taskStore.list({ archived: true }); }
    catch (_) { this.error = '同步失败：本地任务看板读不出来'; return null; }
    for (const card of cards) {
      const base = this.bases.get(card.id);
      if (base) {
        if (Object.keys(diff(base.fields, pick(card))).length) this.noteCard(card);
      } else if (!this.taskOutbox.has(card.id) && Number.isInteger(card.revision) && card.revision > 0) {
        this._setBase(card.id, card);
      } else this.noteCard(card);
    }
    return cards;
  }
  noteCard(card) {
    if (!card || typeof card.id !== 'string') return;
    const fields = pick(card);
    const base = this.bases.get(card.id);
    const set = base ? diff(base.fields, fields) : fields;
    const previous = this.taskOutbox.get(card.id);
    // An attempted operation is immutable: the server may already have applied
    // it even if its response was lost. Save later edits separately until ack.
    if (previous?.attempted) {
      const nextSet = diff({ ...(base?.fields || {}), ...previous.set }, fields);
      if (!same(previous.nextSet || {}, nextSet)) { previous.nextSet = nextSet; this.dirty = true; }
      return;
    }
    if (!Object.keys(set).length) { if (this.taskOutbox.delete(card.id)) this.dirty = true; return; }
    // A Git-restored older cache is not a fresh edit on our newer base.
    const expectedRevision = base ? Math.min(base.revision, Number.isInteger(card.revision) ? card.revision : base.revision) : 0;
    // The same unsent change keeps its operation ID.
    if (previous && previous.expectedRevision === expectedRevision && same(previous.set, set)) return;
    this.taskOutbox.set(card.id, { opId: 'op-' + crypto.randomUUID(), cardId: card.id, expectedRevision, set });
    this.dirty = true;
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
        signal: AbortSignal.timeout(10_000),
      });
    } catch (_) { throw new Error('同步失败：连不上同步服务'); }
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); }
      catch (_) { throw new Error('同步失败：服务返回了无法识别的内容'); }
    }
    if (response.status === 401) throw new Error('同步失败：同步服务拒绝了本机（检查令牌文件）');
    if (response.status === 409 && pathname === '/v1/tasks') {
      return { status: 409, body: payload };
    }
    if (!response.ok) throw new Error('同步失败：服务状态 ' + response.status);
    return { status: response.status, body: payload };
  }
  async _flushTasks(token) {
    let failure = null;
    const queue = [...this.taskOutbox.values()];
    for (let start = 0; start < queue.length; start += FLUSH_BATCH) {
      const batch = queue.slice(start, start + FLUSH_BATCH).filter((item) => this.taskOutbox.get(item.cardId) === item);
      // The server may apply a request whose answer never arrives, so the
      // whole batch is saved as attempted once, before the first one goes out.
      const fresh = batch.filter((item) => !item.attempted);
      if (fresh.length) {
        for (const item of fresh) item.attempted = true;
        try { this._persist(); } catch (err) { for (const item of fresh) delete item.attempted; return failure || err; }
      }
      const answered = [];
      for (const item of batch) {
        try {
          answered.push({ item, result: await this._send(token, 'POST', '/v1/tasks', {
            opId: item.opId, cardId: item.cardId, expectedRevision: item.expectedRevision, set: item.set, deviceId: this.device.id,
          }) });
        } catch (err) { failure = failure || err; }
      }
      // Edits made while the requests were out become each card's nextSet.
      const local = new Map((this._seedTasks() || []).map((card) => [card.id, card]));
      const accepted = [];
      for (const { item, result } of answered) {
        if (result.status === 409 && !result.body.card) {
          // The hub lost this card or rolled back behind our base. The rejected
          // operation cannot be rebased; queue the latest complete local copy
          // with a new ID, preserving edits made while the request was in flight.
          if (!local.has(item.cardId)) { failure = failure || new Error('同步失败：待补传的本地任务不存在'); continue; }
          this.bases.delete(item.cardId);
          this.taskOutbox.delete(item.cardId);
          this.dirty = true;
          this.noteCard(local.get(item.cardId));
          continue;
        }
        const nextSet = item.nextSet || {};
        accepted.push({ item, card: result.body.card, next: Object.keys(nextSet).length ? { ...result.body.card, ...nextSet } : null });
      }
      if (accepted.length) {
        let written = accepted;
        try { this.taskStore.upsertSyncedMany(accepted.map(({ card, next }) => next || card)); }
        catch (_) {
          // One card the board refuses must not hold back the rest of the batch.
          written = accepted.filter(({ card, next }) => {
            try { this.taskStore.upsertSynced(next || card); return true; }
            catch (err) { failure = failure || err; return false; }
          });
        }
        for (const { item, card, next } of written) {
          this._setBase(card.id, card);
          this.taskOutbox.delete(item.cardId);
          this.dirty = true;
          if (next) this.noteCard(next);
        }
      }
      await yieldLoop();
    }
    return failure;
  }
  async _flushHistory(token) {
    let failure = null;
    for (const item of [...this.historyOutbox.values()]) {
      try {
        await this._send(token, 'POST', '/v1/history', { ...item, deviceId: this.device.id });
        if (this.historyOutbox.get(item.sessionId)?.opId === item.opId) this.historyOutbox.delete(item.sessionId);
        this._delivered(item.sessionId);
      } catch (err) { failure = failure || err; }
    }
    return failure;
  }
  // A transcript the hub names by hash and time: the local copy stands while both
  // match; it is fetched again only when they changed.
  async _fetchedRecord(token, head, name) {
    const stamp = head.contentHash + '|' + (head.updatedAt || '');
    if (this.historyStamps.get(name) === stamp) return null;
    try {
      const local = JSON.parse(fs.readFileSync(path.join(this.historyDir, name), 'utf8'));
      if (local.contentHash + '|' + (local.updatedAt || '') === stamp) { this.historyStamps.set(name, stamp); return null; }
    } catch (_) {}
    const query = new URLSearchParams({ sessionId: head.sessionId, deviceId: head.deviceId });
    const record = (await this._send(token, 'GET', '/v1/history?' + query)).body.record;
    return record && record.sessionId === head.sessionId && record.deviceId === head.deviceId ? record : null;
  }
  async _writeHistory(records, token) {
    fs.mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    const keep = new Set();
    const summaries = [];
    for (let record of records) {
      if (!record || !isSessionId(record.sessionId) || !isDeviceId(record.deviceId)) continue;
      const name = record.sessionId + '--' + record.deviceId + '.json';
      keep.add(name);
      const head = record;
      if (!Array.isArray(head.turns)) {
        record = await this._fetchedRecord(token, head, name);
        if (!record) {
          summaries.push({ sessionId: head.sessionId, deviceId: head.deviceId, summary: clip(head.summary, 200), updatedAt: head.updatedAt || null, startedAt: head.startedAt || null, endedAt: head.endedAt || null });
          continue;
        }
      }
      // Each round brings every transcript again; only changed ones are written.
      const text = JSON.stringify(stripSecrets(record)) + '\n';
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      if (this.writtenHistory.get(name) !== hash) {
        const file = path.join(this.historyDir, name);
        let current = null;
        try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
        if (current !== text) atomicWrite(file, text);
        this.writtenHistory.set(name, hash);
        if (current !== text) await yieldLoop();
      }
      if (head !== record) this.historyStamps.set(name, head.contentHash + '|' + (head.updatedAt || ''));
      summaries.push({ sessionId: record.sessionId, deviceId: record.deviceId, summary: clip(record.summary, 200), updatedAt: record.updatedAt || null, startedAt: record.startedAt || null, endedAt: record.endedAt || null });
    }
    for (const name of fs.readdirSync(this.historyDir)) {
      if (!keep.has(name) && name.endsWith('.json')) { fs.unlinkSync(path.join(this.historyDir, name)); this.writtenHistory.delete(name); this.historyStamps.delete(name); }
    }
    if (!same(this.history, summaries)) { this.history = summaries; this.dirty = true; }
  }
  async _pull(token) {
    // Transcripts come named by hash; only changed ones are fetched (an older hub
    // ignores the query and sends them whole, which is read as before).
    const result = await this._send(token, 'GET', '/v1/snapshot?history=hash');
    const snap = result.body || {};
    this.devices = Array.isArray(snap.devices) ? snap.devices : [];
    // Local writers (including the board heartbeat) can edit while HTTP waits.
    this._seedTasks();
    const remoteIds = new Set((snap.cards || []).map((card) => card.id));
    for (const card of this.taskStore.list({ archived: true })) {
      if (!remoteIds.has(card.id) && !this.taskOutbox.has(card.id)) {
        // A restored cache can outlive its client state or an empty hub.
        if (this.bases.delete(card.id)) this.dirty = true;
        this.noteCard(card);
      }
    }
    const keep = [...this.taskOutbox.keys()];
    this.taskStore.replaceSynced(Array.isArray(snap.cards) ? snap.cards : [], keep);
    for (const card of snap.cards || []) {
      if (!this.taskOutbox.has(card.id)) this._setBase(card.id, card);
    }
    await yieldLoop();
    await this._writeHistory(Array.isArray(snap.history) ? snap.history : [], token);
  }
  async syncOnce() {
    const run = (this.tail || Promise.resolve()).then(() => this._syncBody());
    this.tail = run.then(() => {}, () => {});
    return run;
  }
  async _syncBody() {
    let token = '';
    try {
      this._seedTasks();
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
      const taskFailure = await this._flushTasks(token);
      const historyFailure = await this._flushHistory(token);
      await this._pull(token);
      const failure = taskFailure || historyFailure;
      this.error = failure ? this._safeError(failure, token) : null;
      if (!failure) this.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.error = this._safeError(err, token);
    }
    // One save per round, and none when nothing that must survive changed.
    if (this.dirty) {
      try { this._persist(); } catch (err) { this.error = this._safeError(err, token); }
    }
    try { this.onChange(); } catch (_) {}
    return this.snapshot();
  }
  start() {
    if (this.timer) return;
    const tick = () => { this.syncOnce().catch((err) => { this.error = this._safeError(err, ''); }); };
    this.timer = setInterval(tick, this.syncMs);
    if (this.timer.unref) this.timer.unref();
    return tick();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Idle rounds skip the save, so the latest sync time is kept here.
    // It never recreates a data folder that has been removed.
    if ((this.dirty || this.lastSyncAt !== this.savedSyncAt) && fs.existsSync(path.dirname(this.stateFile))) {
      try { this._persist(); } catch (_) {}
    }
  }
  snapshot() {
    let conflictCount = 0;
    try {
      for (const card of this.taskStore.list({ archived: true })) if (Array.isArray(card.conflicts) && card.conflicts.length) conflictCount += card.conflicts.length;
    } catch (_) {}
    return { configured: true, selfId: this.device.id, devices: this.devices, error: this.error, lastSyncAt: this.lastSyncAt, history: this.history, conflictCount };
  }
}

module.exports = { FleetClient, readFleetSettings, loadDevice, readToken, SYNC_MS, HEARTBEAT_MS, LEASE_MS, START_DELAY_MS };
