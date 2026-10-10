'use strict';
// Shared fleet store: one process, one file, the authority for device presence,
// task cards and captain history. The HTTP server is the only writer. Git is
// not this store. Tokens are never accepted or written here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEASE_MS = 45_000;
const TRAIL_CAP = 100;
// A retried operation is answered from its receipt for this long; a client
// offline longer resends work whose answer it never got, and that is applied again.
const RECEIPT_KEEP_MS = 30 * 24 * 60 * 60_000;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/;
// Fields a client may try to change. `updated` is omitted on purpose: every
// edit touches it, so treating it as a user field would turn every disjoint
// edit into a false conflict.
const MUTABLE_KEYS = ['project', 'title', 'detail', 'status', 'flag', 'order', 'depends_on', 'assignee', 'session_id', 'latest_receipt', 'verify', 'rework_count', 'archived', 'consecutive_failures', 'important', 'attempt_id', 'attempt_closed', 'review_session', 'review_verdict', 'last_event', 'last_failure_attempt', 'dispatch_session_id', 'dispatch_claim', 'start_previous_status', 'created', 'session_host', 'session_bound_at', 'dispatch_host', 'dispatch_bound_at', 'dispatch_wait', 'resource_failure', 'user_question', 'needs_user_entry', 'review_round', 'exec_receipt', 'review_claim', 'review_block', 'review_reject'];
const SECRET_KEY = /^(token|api[_-]?key|password|secret|authorization|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i;

function isDeviceId(value) { return typeof value === 'string' && DEVICE_ID.test(value); }
function isSessionId(value) { return typeof value === 'string' && SESSION_ID.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function clone(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
function clip(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  return text.length > max ? text.slice(0, max) : text;
}
function reject(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

function emptyData() {
  return { version: 1, seq: 0, devices: Object.create(null), cards: Object.create(null), ops: Object.create(null), history: Object.create(null) };
}

// Drop credential-shaped keys anywhere in a captain transcript. The prose of
// the turn stays; this only removes fields whose names are secrets.
function stripSecrets(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return null;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(item, depth + 1);
  }
  return out;
}

// moving: a dispatch card's state (doing, review, done) is updated in place as its
// worker runs. That is the same turn moving on, not a divergent save to keep a copy of.
function turnExtends(next, previous, moving = false) {
  if (!next || !previous) return same(next, previous);
  return Object.entries(previous).every(([key, value]) => {
    if (key === 'reply' && typeof value === 'string' && typeof next[key] === 'string') return next[key].startsWith(value);
    if (key === 'done' && value === false && next[key] === true) return true;
    if (key === 'end' && value == null) return true;
    if (moving && key === 'task') return true;
    return same(next[key], value);
  });
}
// An earlier version a save rewrote: its identity, its length and only the turns
// that save rewrote or dropped, each with its index. (A whole copy per rewrite of a
// long captain chat grew the hub by the whole chat each time.)
function rewrittenVersion(previous, laterTurns) {
  const { turns, alternatives, ...head } = previous;
  const later = Array.isArray(laterTurns) ? laterTurns : [];
  const changed = [];
  turns.forEach((turn, index) => { if (!turnExtends(later[index], turn, true)) changed.push({ index, turn }); });
  return { ...head, turnCount: turns.length, changed };
}
// What an older hub kept as whole copies: a copy kept only because card states
// moved is dropped (the version after it carries it on); one a later save rewrote
// keeps only the turns that save rewrote. Already-reduced versions stay as they are.
function compactHistory(record) {
  const alternatives = Array.isArray(record.alternatives) ? record.alternatives : [];
  if (!alternatives.some((alt) => alt && Array.isArray(alt.turns))) return record;
  const chain = [...alternatives, record];
  const kept = [];
  alternatives.forEach((alt, i) => {
    if (!alt || !Array.isArray(alt.turns)) { kept.push(alt); return; }
    const later = (chain.slice(i + 1).find((version) => Array.isArray(version && version.turns)) || {}).turns || [];
    if (alt.turns.every((turn, j) => turnExtends(later[j], turn, true))) return;
    kept.push(rewrittenVersion(alt, later));
  });
  return { ...record, alternatives: kept };
}

// The answer kept for a replayed transcript upload names the record, it does not
// copy it: a copy per save of a growing chat made the file grow with the square of
// its saves (608 MB on the live hub, 2026-10-09).
function historyReceipt(record, duplicate) {
  return { sessionId: record.sessionId, deviceId: record.deviceId, contentHash: record.contentHash, updatedAt: record.updatedAt || null, duplicate: !!duplicate };
}
// A receipt as this hub keeps it, from one an older hub kept (a whole transcript or
// a whole card) or from a new answer: a card answer keeps the card's id; a replay
// answers with the card as it is then (_replay). Undated receipts take `at`.
function compactReceipt(saved, at) {
  if (!saved || typeof saved !== 'object') return saved;
  const body = saved.body;
  if (body && body.record && typeof body.record === 'object') saved.body = historyReceipt(body.record, body.duplicate);
  else if (body && body.card && typeof body.card === 'object' && typeof body.card.id === 'string') {
    const { card, ...rest } = body;
    saved.body = { cardId: card.id, ...rest };
  }
  if (typeof saved.at !== 'string') saved.at = at;
  return saved;
}

function publicCard(card) {
  const { trail, ...rest } = card;
  return clone(rest);
}

function checkValue(key, value) {
  if (value === null && !['project', 'title', 'detail', 'status', 'order', 'depends_on', 'verify', 'archived', 'important', 'rework_count', 'consecutive_failures', 'created', 'latest_receipt'].includes(key)) return;
  if (key === 'project') {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(value)) throw reject(400, 'Invalid project.');
  } else if (key === 'title') {
    if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000) throw reject(400, 'Invalid title.');
  } else if (key === 'detail' || key === 'latest_receipt') {
    if (typeof value !== 'string' || value.length > 2_000_000) throw reject(400, 'Invalid ' + key + '.');
  } else if (key === 'status' || key === 'start_previous_status') {
    if (!['todo', 'doing', 'review', 'needs_user', 'done'].includes(value)) throw reject(400, 'Invalid status.');
  } else if (key === 'flag') {
    if (![null, 'failed', 'blocked', 'held', 'quota'].includes(value)) throw reject(400, 'Invalid flag.');
  } else if (key === 'order') {
    if (!Number.isFinite(value) || value < 0) throw reject(400, 'Invalid order.');
  } else if (key === 'depends_on') {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) throw reject(400, 'Invalid dependencies.');
  } else if (['verify', 'archived', 'important', 'attempt_closed', 'review_session', 'review_verdict'].includes(key)) {
    if (typeof value !== 'boolean') throw reject(400, 'Invalid boolean field.');
  } else if (key === 'rework_count' || key === 'consecutive_failures') {
    if (!Number.isInteger(value) || value < 0) throw reject(400, 'Invalid counter.');
  } else if (['session_id', 'attempt_id', 'dispatch_session_id'].includes(key)) {
    if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) throw reject(400, 'Invalid session id.');
  } else if (key === 'assignee') {
    if (value !== null && (!value || typeof value !== 'object' || typeof value.agent !== 'string' || typeof value.model !== 'string')) throw reject(400, 'Invalid assignee.');
  } else if (key === 'created') {
    if (typeof value !== 'string' || value.length > 40) throw reject(400, 'Invalid created time.');
  }
}

function sanitizeSessions(list, deviceId) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 100)) {
    if (!item || !isSessionId(item.id)) continue;
    const role = item.role === 'captain' ? 'captain' : 'session';
    out.push({ id: item.id, deviceId, role, title: clip(item.title || '', 200) });
  }
  return out;
}

class SharedStore {
  constructor({ file, leaseMs = LEASE_MS, now = () => Date.now() } = {}) {
    if (!file) throw new Error('Shared store needs a data file.');
    this.file = path.resolve(file);
    this.leaseMs = leaseMs;
    this.now = now;
    this.data = this._load();
  }
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') return emptyData();
      throw reject(500, 'Sync store is unreadable.');
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { throw reject(500, 'Sync store is not valid JSON. Refusing to overwrite it.'); }
    if (!data || data.version !== 1 || !data.devices || !data.cards || !data.history) {
      throw reject(500, 'Sync store schema is not version 1. Refusing to overwrite it.');
    }
    data.ops = data.ops || {};
    // IDs are untrusted keys, including __proto__ and inherited method names.
    // JSON.parse restores ordinary objects, so rebuild every index on load too.
    for (const key of ['devices', 'cards', 'ops', 'history']) data[key] = Object.assign(Object.create(null), data[key]);
    // Older hubs kept the whole transcript or card in each receipt, and no time.
    const at = new Date(this.now()).toISOString();
    for (const saved of Object.values(data.ops)) compactReceipt(saved, at);
    for (const [key, record] of Object.entries(data.history)) if (record && typeof record === 'object') data.history[key] = compactHistory(record);
    data.seq = Number.isInteger(data.seq) ? data.seq : 0;
    return data;
  }
  _save() {
    this.data.seq += 1;
    atomicWrite(this.file, JSON.stringify(this.data));
  }
  _remember(opId, status, body) {
    const now = this.now();
    if (now - (this.prunedAt || 0) >= 60 * 60_000) {
      this.prunedAt = now;
      for (const [id, saved] of Object.entries(this.data.ops)) {
        if (!(now - Date.parse(saved && saved.at) < RECEIPT_KEEP_MS)) delete this.data.ops[id];
      }
    }
    this.data.ops[opId] = compactReceipt({ status, body: clone(body) }, new Date(now).toISOString());
    return { status, body: clone(body) };
  }
  // The answer to an operation already applied: its outcome, with the card as the
  // hub has it now (what the client takes as its base).
  _replay(opId) {
    const saved = this.data.ops[opId];
    const { cardId, ...rest } = (saved && saved.body) || {};
    if (typeof cardId !== 'string') return { status: saved.status, body: clone(saved.body) };
    const card = this.data.cards[cardId];
    return { status: saved.status, body: { card: card ? publicCard(card) : null, ...clone(rest) } };
  }
  devices() {
    const now = this.now();
    return Object.values(this.data.devices).map((device) => {
      const seen = Date.parse(device.lastSeenAt);
      const age = Number.isFinite(seen) ? now - seen : Infinity;
      return {
        id: device.id, name: device.name, platform: device.platform, version: device.version || '',
        captainSessionId: device.captainSessionId || null, sessions: device.sessions || [],
        lastSeenAt: device.lastSeenAt, online: age <= this.leaseMs,
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  heartbeat(input) {
    if (!input || !isDeviceId(input.id)) throw reject(400, 'Invalid device id.');
    const platform = ['darwin', 'win32', 'linux'].includes(input.platform) ? input.platform : 'unknown';
    const sessions = sanitizeSessions(input.sessions, input.id);
    this.data.devices[input.id] = {
      id: input.id,
      name: clip(input.name, 80) || input.id,
      platform,
      version: clip(input.version, 40),
      captainSessionId: isSessionId(input.captainSessionId) ? input.captainSessionId : null,
      sessions,
      lastSeenAt: new Date(this.now()).toISOString(),
    };
    this._save();
    return { devices: this.devices() };
  }
  _changedSince(card, expectedRevision) {
    const trail = Array.isArray(card.trail) ? card.trail : [];
    if (!trail.length) return new Set(Object.keys(card).filter((key) => MUTABLE_KEYS.includes(key)));
    const oldest = trail.reduce((min, item) => Math.min(min, item.revision), card.revision);
    const changed = new Set();
    if (expectedRevision < oldest - 1) {
      // The trail no longer reaches the client's base. Treat every difference
      // as already changed so an old writer cannot overwrite blindly.
      for (const key of MUTABLE_KEYS) changed.add(key);
      return changed;
    }
    for (const item of trail) {
      if (item.revision > expectedRevision) for (const key of item.keys || []) changed.add(key);
    }
    return changed;
  }
  pushTask({ opId, cardId, expectedRevision, deviceId, set }) {
    if (!isDeviceId(opId) && !(typeof opId === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(opId))) throw reject(400, 'Invalid opId.');
    if (typeof cardId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(cardId)) throw reject(400, 'Invalid card id.');
    if (!isDeviceId(deviceId)) throw reject(400, 'Invalid device id.');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw reject(400, 'Invalid revision.');
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw reject(400, 'Invalid field set.');
    if (this.data.ops[opId]) return this._replay(opId);
    const clean = {};
    for (const key of MUTABLE_KEYS) if (key in set) clean[key] = clone(set[key]);
    for (const [key, value] of Object.entries(clean)) checkValue(key, value);
    let card = this.data.cards[cardId];
    if (!card) {
      if (expectedRevision !== 0) throw reject(409, 'Card does not exist at that revision.');
      if (typeof clean.title !== 'string' || !clean.title.trim()) throw reject(400, 'New card needs a title.');
      if (typeof clean.project !== 'string' || !clean.project.trim()) throw reject(400, 'New card needs a project.');
      card = {
        ...clean, id: cardId, revision: 1, deviceId, updatedByDevice: deviceId, conflicts: [],
        updated: new Date(this.now()).toISOString(),
        trail: [{ revision: 1, keys: Object.keys(clean) }],
      };
      this.data.cards[cardId] = card;
      const saved = this._remember(opId, 200, { card: publicCard(card), merged: false, conflict: false });
      this._save();
      return saved;
    }
    if (expectedRevision > card.revision) throw reject(409, 'Revision is ahead of the server.');
    const changed = expectedRevision === card.revision ? new Set() : this._changedSince(card, expectedRevision);
    const applied = {};
    const conflicts = {};
    for (const [key, value] of Object.entries(clean)) {
      if (same(card[key], value)) continue;
      if (changed.has(key)) conflicts[key] = { kept: clone(card[key]), other: clone(value) };
      else { applied[key] = value; card[key] = value; }
    }
    let conflict = null;
    if (Object.keys(conflicts).length) {
      conflict = {
        id: 'cf-' + crypto.randomUUID(), at: new Date(this.now()).toISOString(), deviceId,
        baseRevision: expectedRevision, fields: conflicts,
      };
      card.conflicts = [...(card.conflicts || []), conflict];
    }
    const touched = [...new Set([...Object.keys(applied), ...Object.keys(conflicts)])];
    if (touched.length) {
      card.revision += 1;
      card.updatedByDevice = deviceId;
      card.updated = new Date(this.now()).toISOString();
      card.trail = [...(card.trail || []), { revision: card.revision, keys: touched }].slice(-TRAIL_CAP);
    }
    const status = conflict ? 409 : 200;
    const saved = this._remember(opId, status, {
      card: publicCard(card), merged: Object.keys(applied).length > 0 && !!conflict, conflict: !!conflict,
    });
    this._save();
    return saved;
  }
  pushHistory({ opId, sessionId, deviceId, contentHash, startedAt, endedAt, summary, turns }) {
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(opId)) throw reject(400, 'Invalid opId.');
    if (!isSessionId(sessionId) || !isDeviceId(deviceId)) throw reject(400, 'Invalid history identity.');
    if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) throw reject(400, 'Invalid history hash.');
    if (this.data.ops[opId]) return this._replay(opId);
    const key = sessionId + '@' + deviceId;
    const existing = this.data.history[key];
    if (existing && existing.contentHash === contentHash) {
      const saved = this._remember(opId, 200, historyReceipt(existing, true));
      this._save();
      return saved;
    }
    const cleanTurns = stripSecrets(Array.isArray(turns) ? turns : []);
    // A delayed older save cannot shorten history already accepted by the hub.
    if (existing && cleanTurns.length <= existing.turns.length && cleanTurns.every((turn, i) => turnExtends(existing.turns[i], turn))) {
      const saved = this._remember(opId, 200, historyReceipt(existing, true));
      this._save();
      return saved;
    }
    const record = {
      sessionId, deviceId, contentHash,
      startedAt: typeof startedAt === 'string' ? startedAt : null,
      endedAt: typeof endedAt === 'string' ? endedAt : null,
      summary: clip(summary || '', 200),
      turns: cleanTurns,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (existing) {
      record.alternatives = existing.alternatives || [];
      if (!existing.turns.every((turn, i) => turnExtends(cleanTurns[i], turn, true))) {
        record.alternatives = [...record.alternatives, rewrittenVersion(existing, cleanTurns)];
      }
    }
    this.data.history[key] = record;
    const saved = this._remember(opId, 200, historyReceipt(record, false));
    this._save();
    return saved;
  }
  // hashesOnly: each transcript is named by its hash and time, without its turns;
  // a client fetches only the ones that changed (record()) instead of every
  // transcript every round.
  snapshot({ hashesOnly = false } = {}) {
    return {
      cursor: this.data.seq,
      devices: this.devices(),
      cards: Object.values(this.data.cards).map(publicCard),
      history: Object.values(this.data.history).map((record) => {
        if (!hashesOnly) return clone(record);
        const { turns, alternatives, ...head } = record;
        return clone(head);
      }),
    };
  }
  record(sessionId, deviceId) {
    if (!isSessionId(sessionId) || !isDeviceId(deviceId)) return null;
    const record = this.data.history[sessionId + '@' + deviceId];
    return record ? clone(record) : null;
  }
}

module.exports = { SharedStore, LEASE_MS, MUTABLE_KEYS, isDeviceId, isSessionId, stripSecrets, publicCard, compactReceipt, compactHistory };
