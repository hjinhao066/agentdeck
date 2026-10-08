// Find the conversation id a running CLI already wrote to disk, so a restart
// can resume THAT conversation. No match, or two matches, means we do not
// guess: the caller opens a new session and resends the task.
// Test profiles pass no roots and therefore never read the real home directory.
'use strict';

const fs = require('fs');
const path = require('path');

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_FILES = 400;

function sameCwd(a, b, platform) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
  const left = norm(a), right = norm(b);
  if (platform === 'linux') return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function walk(dir, accept, since, out) {
  if (out.seen >= MAX_FILES) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (out.seen >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (stat.isDirectory()) { walk(full, accept, since, out); continue; }
    if (!accept(entry.name) || stat.mtimeMs < since) continue;
    out.seen += 1;
    out.files.push({ full, at: stat.mtimeMs });
  }
}

function listCursor(root, since) {
  const out = { seen: 0, files: [] };
  walk(root, (name) => name === 'meta.json', since || 0, out);
  const records = [];
  for (const file of out.files) {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(file.full, 'utf8')); } catch (_) { continue; }
    const id = path.basename(path.dirname(file.full));
    if (!UUID.test(id) || !meta || typeof meta.cwd !== 'string') continue;
    records.push({ provider: 'Cursor', id, cwd: meta.cwd, at: Number(meta.updatedAtMs) || file.at });
  }
  return records;
}

// A session_meta line includes base instructions and can be much larger than
// one read buffer. Read through the first newline, with a cap for damaged files.
function firstLine(file) {
  const limit = 8 * 1024 * 1024;
  const chunks = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    for (let at = 0; at < limit;) {
      const buf = Buffer.alloc(Math.min(16384, limit - at));
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      if (!n) return Buffer.concat(chunks).toString('utf8');
      const end = buf.subarray(0, n).indexOf(10);
      chunks.push(buf.subarray(0, end < 0 ? n : end));
      if (end >= 0) return Buffer.concat(chunks).toString('utf8');
      at += n;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return '';
}

function listCodex(root, since) {
  const out = { seen: 0, files: [] };
  walk(root, (name) => name.endsWith('.jsonl'), since || 0, out);
  const records = [];
  for (const file of out.files) {
    let row = null;
    try { row = JSON.parse(firstLine(file.full)); } catch (_) { continue; }
    const payload = row && row.type === 'session_meta' && row.payload;
    const id = payload && (payload.session_id || payload.id);
    if (!UUID.test(id) || !payload || typeof payload.cwd !== 'string') continue;
    records.push({ provider: 'Codex', id, cwd: payload.cwd, at: file.at });
  }
  return records;
}

function listAgy() {
  // Arbitrary file:// strings in a conversation database include referenced
  // files and other workspaces. They cannot certify the conversation's cwd.
  return [];
}

function cwdMatches(record, cwd, platform) {
  const paths = Array.isArray(record.cwd) ? record.cwd : [record.cwd];
  return paths.some((item) => sameCwd(item, cwd, platform));
}

// columns: { id, provider, cwd, sessionId, owner }
// Only an identity captured for this column at launch can be retained. A file
// for the same cwd, even a unique file, may belong to an external terminal.
function assignSessions(columns, records, platform) {
  const list = Array.isArray(records) ? records : [];
  const cols = (Array.isArray(columns) ? columns : []).filter((col) => col && col.id);
  const owners = new Map();
  for (const col of cols) {
    if (!UUID.test(col.sessionId || '')) continue;
    const key = col.provider + ':' + col.sessionId.toLowerCase();
    owners.set(key, (owners.get(key) || 0) + 1);
  }
  const out = {};
  for (const col of cols) {
    out[col.id] = null;
    if (col.owner !== col.id || !UUID.test(col.sessionId || '')) continue;
    const key = col.provider + ':' + col.sessionId.toLowerCase();
    if (owners.get(key) !== 1) continue;
    // An authenticated command from this exact column carried the provider's
    // shell-tool id. This also works after a crash and with newer stores that
    // no longer write meta.json / legacy rollout files.
    if (col.source === 'agent-env' && typeof col.capturedCwd === 'string' &&
        (col.capturedCwd === col.cwd || sameCwd(col.capturedCwd, col.cwd, platform))) {
      out[col.id] = col.sessionId;
      continue;
    }
    const matches = list.filter((record) => record.provider === col.provider &&
      String(record.id).toLowerCase() === col.sessionId.toLowerCase());
    if (matches.length === 1 && cwdMatches(matches[0], col.cwd, platform)) out[col.id] = col.sessionId;
  }
  return out;
}

function clearInheritedSessionIds(env) {
  const clean = { ...env };
  for (const key of ['CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID', 'ANTIGRAVITY_CONVERSATION_ID']) delete clean[key];
  return clean;
}

// A session the 队长 opened is driven by typed tells, so Claude Code's gray
// "next step" suggestion in its input box only gets in the way. Claude Code
// reads this variable ("0", "false", "no", "off" turn suggestions off); the
// user's own settings and their manual terminals are left alone.
function crewEnvironment(env, crew) {
  return crew ? { ...env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0' } : env;
}

function defaultRoots(home) {
  const base = home || '';
  return {
    cursor: path.join(base, '.cursor', 'chats'),
    codex: path.join(base, '.codex', 'sessions'),
    agy: path.join(base, '.gemini', 'antigravity-cli', 'conversations'),
  };
}

function resolveSessions(columns, options) {
  const opts = options || {};
  if (!opts.roots) return {};
  const since = opts.since != null ? opts.since : (opts.lookbackMs ? Date.now() - opts.lookbackMs : 0);
  let records = [];
  try { records = records.concat(listCursor(opts.roots.cursor, since)); } catch (_) {}
  try { records = records.concat(listCodex(opts.roots.codex, since)); } catch (_) {}
  try { records = records.concat(listAgy(opts.roots.agy, since)); } catch (_) {}
  return assignSessions(columns, records, opts.platform || process.platform);
}

module.exports = {
  sameCwd, clearInheritedSessionIds, crewEnvironment, listCursor, listCodex, listAgy, assignSessions, defaultRoots, resolveSessions,
};
