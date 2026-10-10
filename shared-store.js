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
// A transcript too big for one request comes in pieces (stageHistoryPart), held in
// memory until pushHistoryText puts them together. Pieces of an upload that is never
// finished go after this long; all pieces held at once stay under STAGED_MAX characters.
const UPLOAD_TTL_MS = 10 * 60_000;
const STAGED_MAX = 256 * 1024 * 1024;
const PARTS_MAX = 4096;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,160}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/;
// Fields a client may try to change. `updated` is omitted on purpose: every
// edit touches it, so treating it as a user field would turn every disjoint
// edit into a false conflict.
const MUTABLE_KEYS = ['project', 'title', 'detail', 'status', 'flag', 'order', 'depends_on', 'assignee', 'session_id', 'latest_receipt', 'verify', 'rework_count', 'archived', 'consecutive_failures', 'important', 'attempt_id', 'attempt_closed', 'review_session', 'review_verdict', 'last_event', 'last_failure_attempt', 'dispatch_session_id', 'dispatch_claim', 'start_previous_status', 'created', 'session_host', 'session_bound_at', 'dispatch_host', 'dispatch_bound_at', 'dispatch_wait', 'resource_failure', 'user_question', 'needs_user_entry', 'review_round', 'exec_receipt', 'review_claim', 'review_block', 'review_reject'];
const SECRET_KEY = /^(token|api[_-]?key|password|secret|authorization|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i;

// A card's last_event reads `<attempt>:<type>:<source>:<sha256 of the message>`. A
// `complete` that came from the agent's own `complete` command is the authoritative
// result; `fallback` (the process ended with no receipt) and automatic failures are
// guesses made by whichever machine noticed the exit first.
function eventOf(event) {
  const match = /:([a-z]+):([^:]*):[0-9a-f]+$/.exec(typeof event === 'string' ? event : '');
  return match ? { type: match[1], source: match[2] } : null;
}
function isCommandComplete(event) {
  const parsed = eventOf(event);
  return !!parsed && parsed.type === 'complete' && parsed.source === 'command';
}
function isCommandVerdict(event) {
  const parsed = eventOf(event);
  return !!parsed && parsed.source === 'command' && (parsed.type === 'complete' || parsed.type === 'failed');
}
// What one attempt writes on a card. A writer whose base is older than the card's
// authoritative completion cannot change any of it: that attempt began without
// knowing the card was finished.
const ATTEMPT_KEYS = new Set(['status', 'flag', 'session_id', 'attempt_id', 'attempt_closed', 'last_event', 'last_failure_attempt', 'latest_receipt', 'start_previous_status', 'session_host', 'session_bound_at', 'dispatch_session_id', 'dispatch_claim', 'dispatch_host', 'dispatch_bound_at', 'dispatch_wait', 'resource_failure', 'user_question', 'needs_user_entry', 'consecutive_failures', 'review_session', 'review_verdict', 'review_claim', 'review_block', 'review_reject', 'review_round', 'exec_receipt']);
// These only ever start another delivery, so a finished card takes no new value for them.
const DISPATCH_KEYS = ['dispatch_claim', 'dispatch_session_id', 'dispatch_host', 'dispatch_bound_at', 'dispatch_wait'];
// What the attempt an authoritative completion replaces leaves behind.
const CLEARED_BY_COMPLETE = ['flag', 'resource_failure', 'user_question', 'needs_user_entry', ...DISPATCH_KEYS];
const COMPLETE_SEEN_CAP = 20;

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
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    // A write that failed (a full disk) leaves no empty temp file behind either.
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

// A save the disk refused: 507 when it is full, 500 otherwise; `code` is kept for the log.
function storageError(err) {
  const full = err && (err.code === 'ENOSPC' || err.code === 'EDQUOT');
  return Object.assign(reject(full ? 507 : 500, full ? 'storage-full' : 'Sync store could not be written.'), { code: err && err.code });
}

// IDs are untrusted keys, including __proto__ and inherited method names.
// JSON.parse restores ordinary objects, so every index is rebuilt after parsing.
function indexed(data) {
  data.ops = data.ops || {};
  for (const key of ['devices', 'cards', 'ops', 'history']) data[key] = Object.assign(Object.create(null), data[key]);
  return data;
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
  const { trail, sealed, completeSeen, ...rest } = card;
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
    // What the file holds: a save the disk refuses puts the store back to it.
    this.saved = JSON.stringify(this.data);
    this.uploads = new Map();
    this.staged = 0;
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
    indexed(data);
    // Older hubs kept the whole transcript or card in each receipt, and no time.
    const at = new Date(this.now()).toISOString();
    for (const saved of Object.values(data.ops)) compactReceipt(saved, at);
    for (const [key, record] of Object.entries(data.history)) if (record && typeof record === 'object') data.history[key] = compactHistory(record);
    data.seq = Number.isInteger(data.seq) ? data.seq : 0;
    return data;
  }
  // Every change is saved before it is answered. A save the disk refuses undoes the
  // change (the store goes back to what its file holds) and the request fails, so
  // a retry is applied again instead of answered from a receipt the disk never had.
  _save() {
    this.data.seq += 1;
    const text = JSON.stringify(this.data);
    try { atomicWrite(this.file, text); }
    catch (err) {
      this.data = indexed(JSON.parse(this.saved));
      throw storageError(err);
    }
    this.saved = text;
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
  // The revision at which the card took the authoritative completion it holds, or null.
  _sealedAt(card) {
    if (!isCommandComplete(card.last_event)) return null;
    if (card.sealed && card.sealed.event === card.last_event) return card.sealed.revision;
    // A card completed before the hub kept this: the latest revision that touched last_event.
    let at = null;
    for (const item of card.trail || []) if ((item.keys || []).includes('last_event')) at = Math.max(at === null ? 0 : at, item.revision);
    return at === null ? card.revision : at;
  }
  _noteSeal(card, at = card.revision) {
    if (!isCommandComplete(card.last_event) || (card.sealed && card.sealed.event === card.last_event)) return;
    card.sealed = { revision: at, event: card.last_event };
    card.completeSeen = [...(card.completeSeen || []).filter((event) => event !== card.last_event), card.last_event].slice(-COMPLETE_SEEN_CAP);
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
      this._noteSeal(card);
      const saved = this._remember(opId, 200, { card: publicCard(card), merged: false, conflict: false });
      this._save();
      return saved;
    }
    if (expectedRevision > card.revision) throw reject(409, 'Revision is ahead of the server.');
    const changed = expectedRevision === card.revision ? new Set() : this._changedSince(card, expectedRevision);
    const incoming = clean.last_event;
    // The agent's own `complete` is the authoritative result. When it reaches the hub late,
    // after another machine has already written a guess over the same card (a fallback
    // for an exit with no receipt, an automatic failure, the next attempt's start), the
    // completion wins field by field; the guess is kept in the conflict record. It needs the
    // other machine to have written a run event since the writer's base: a card a person
    // moved by hand (which writes no event) is not taken back by a late completion.
    const authoritative = isCommandComplete(incoming) && changed.has('last_event') && !same(card.last_event, incoming)
      && !isCommandVerdict(card.last_event) && !(card.completeSeen || []).includes(incoming);
    // A writer based before the card was completed started its attempt without knowing
    // that: it cannot change what an attempt writes.
    const sealedAt = this._sealedAt(card);
    const stale = sealedAt !== null && expectedRevision < sealedAt;
    const prior = {};
    for (const key of DISPATCH_KEYS) if (key in card) prior[key] = clone(card[key]);
    const applied = {};
    const conflicts = {};
    for (const [key, value] of Object.entries(clean)) {
      if (same(card[key], value)) continue;
      if (changed.has(key) && authoritative) {
        conflicts[key] = { kept: clone(value), other: clone(card[key]), reason: 'complete-over-guess' };
        applied[key] = value; card[key] = value;
      } else if (changed.has(key)) conflicts[key] = { kept: clone(card[key]), other: clone(value) };
      else if (stale && ATTEMPT_KEYS.has(key)) conflicts[key] = { kept: clone(card[key]), other: clone(value), reason: 'stale-after-complete' };
      else { applied[key] = value; card[key] = value; }
    }
    if (authoritative) {
      for (const key of CLEARED_BY_COMPLETE) {
        if (card[key] == null || key in clean) continue;
        conflicts[key] = { kept: null, other: clone(card[key]), reason: 'complete-over-guess' };
        if (key === 'user_question' || key === 'needs_user_entry') delete card[key]; else card[key] = null;
        applied[key] = null;
      }
    }
    // A finished card is not claimed or handed to a session again.
    if (card.status === 'done') {
      for (const key of DISPATCH_KEYS) {
        if (!(key in applied) || applied[key] == null) continue;
        conflicts[key] = { kept: key in prior ? prior[key] : null, other: clone(applied[key]), reason: 'claim-on-done' };
        if (key in prior) card[key] = prior[key]; else delete card[key];
        delete applied[key];
      }
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
      this._noteSeal(card, 'last_event' in applied || sealedAt === null ? card.revision : sealedAt);
    }
    const status = conflict ? 409 : 200;
    const saved = this._remember(opId, status, {
      card: publicCard(card), merged: Object.keys(applied).length > 0 && !!conflict, conflict: !!conflict,
    });
    this._save();
    return saved;
  }
  _checkHistory({ opId, sessionId, deviceId, contentHash }) {
    if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(opId)) throw reject(400, 'Invalid opId.');
    if (!isSessionId(sessionId) || !isDeviceId(deviceId)) throw reject(400, 'Invalid history identity.');
    if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) throw reject(400, 'Invalid history hash.');
  }
  _dropUpload(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    this.staged -= upload.size;
    this.uploads.delete(uploadId);
  }
  // One piece of a transcript's text. Pieces are not written to the file: a hub
  // that restarts loses them and the client sends the transcript again.
  stageHistoryPart({ uploadId, index, count, text }) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) throw reject(400, 'Invalid upload id.');
    if (!Number.isInteger(count) || count < 1 || count > PARTS_MAX || !Number.isInteger(index) || index < 0 || index >= count) throw reject(400, 'Invalid upload part.');
    if (typeof text !== 'string') throw reject(400, 'Invalid upload part.');
    const now = this.now();
    for (const [id, item] of this.uploads) if (now - item.at > UPLOAD_TTL_MS) this._dropUpload(id);
    let upload = this.uploads.get(uploadId);
    if (upload && upload.count !== count) throw reject(400, 'Upload part count changed.');
    const before = upload && upload.parts[index] !== null ? upload.parts[index].length : 0;
    if (this.staged - before + text.length > STAGED_MAX) throw reject(413, 'Too much upload staged.');
    if (!upload) { upload = { count, parts: Array.from({ length: count }, () => null), size: 0, at: now }; this.uploads.set(uploadId, upload); }
    upload.parts[index] = text;
    upload.size += text.length - before;
    this.staged += text.length - before;
    upload.at = now;
    return { status: 200, body: { uploadId, index, received: upload.parts.filter((part) => part !== null).length } };
  }
  // A transcript sent as JSON text: inline (`text`) or as staged pieces (`uploadId`,
  // `parts`), whole or (with `base`) only the turns from `base.from` on, laid over the
  // version the hub has when its hash is `base.contentHash`. The result must hash to
  // `contentHash`; it is then saved like any other upload. 409 answers are not kept
  // as receipts: `parts-missing` is sent again, `base-mismatch` is sent whole.
  pushHistoryText({ opId, sessionId, deviceId, contentHash, startedAt, endedAt, summary, text, uploadId, parts, base }) {
    this._checkHistory({ opId, sessionId, deviceId, contentHash });
    if (this.data.ops[opId]) { this._dropUpload(uploadId); return this._replay(opId); }
    let body = text;
    if (typeof body !== 'string') {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.count !== parts || upload.parts.includes(null)) return { status: 409, body: { error: 'parts-missing' } };
      body = upload.parts.join('');
      this._dropUpload(uploadId);
    }
    let turns;
    try { turns = JSON.parse(body); } catch (_) { throw reject(400, 'Invalid history text.'); }
    if (!Array.isArray(turns)) throw reject(400, 'Invalid history text.');
    if (base !== undefined && base !== null) {
      const existing = this.data.history[sessionId + '@' + deviceId];
      if (!existing || !base || existing.contentHash !== base.contentHash || !Number.isInteger(base.from) || base.from < 0 || base.from > existing.turns.length) {
        return { status: 409, body: { error: 'base-mismatch' } };
      }
      turns = existing.turns.slice(0, base.from).concat(turns);
    }
    if (crypto.createHash('sha256').update(JSON.stringify(stripSecrets(turns))).digest('hex') !== contentHash) {
      return { status: 409, body: { error: 'hash-mismatch' } };
    }
    return this.pushHistory({ opId, sessionId, deviceId, contentHash, startedAt, endedAt, summary, turns });
  }
  pushHistory({ opId, sessionId, deviceId, contentHash, startedAt, endedAt, summary, turns }) {
    this._checkHistory({ opId, sessionId, deviceId, contentHash });
    if (this.data.ops[opId]) return this._replay(opId);
    const key = sessionId + '@' + deviceId;
    const existing = this.data.history[key];
    if (existing && existing.contentHash === contentHash) {
      // Sent again with the times the hub's copy lacks (clients before 2.0.5 sent none
      // for saved chats): they are filled in; the turns and their hash stay.
      const times = {};
      for (const [name, value] of [['startedAt', startedAt], ['endedAt', endedAt]]) {
        if (!existing[name] && typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))) times[name] = value;
      }
      if (Object.keys(times).length) this.data.history[key] = { ...existing, ...times };
      const saved = this._remember(opId, 200, historyReceipt(this.data.history[key], true));
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
