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

function listCodex(root, since) {
  const out = { seen: 0, files: [] };
  walk(root, (name) => name.endsWith('.jsonl'), since || 0, out);
  const records = [];
  for (const file of out.files) {
    let line = '';
    try {
      const fd = fs.openSync(file.full, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      line = buf.slice(0, n).toString('utf8').split('\n')[0];
    } catch (_) { continue; }
    let row = null;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const payload = row && row.payload;
    const id = payload && (payload.session_id || payload.id);
    if (!UUID.test(id) || !payload || typeof payload.cwd !== 'string') continue;
    records.push({ provider: 'Codex', id, cwd: payload.cwd, at: file.at });
  }
  return records;
}

function listAgy(root, since) {
  const out = { seen: 0, files: [] };
  walk(root, (name) => name.endsWith('.db'), since || 0, out);
  const records = [];
  for (const file of out.files) {
    const id = path.basename(file.full, '.db');
    if (!UUID.test(id)) continue;
    let text = '';
    try { text = fs.readFileSync(file.full).toString('utf8'); } catch (_) { continue; }
    const cwds = [];
    for (const match of text.matchAll(/file:\/\/[^\u0000-\u001f\s"\\]+/g)) {
      try { cwds.push(decodeURIComponent(match[0].slice('file://'.length))); } catch (_) {}
    }
    if (!cwds.length) continue;
    records.push({ provider: 'Antigravity', id, cwd: cwds, at: file.at });
  }
  return records;
}

function cwdMatches(record, cwd, platform) {
  const paths = Array.isArray(record.cwd) ? record.cwd : [record.cwd];
  return paths.some((item) => sameCwd(item, cwd, platform));
}

// columns: { id, provider, cwd, since, sessionId }
// A stored id is kept when that conversation file is still there. Otherwise
// exactly one unused file for the same cwd counts; two files do not.
function assignSessions(columns, records, platform) {
  const list = Array.isArray(records) ? records : [];
  const used = new Set();
  const out = {};
  for (const col of Array.isArray(columns) ? columns : []) {
    if (!col || !col.id) continue;
    out[col.id] = null;
    if (!UUID.test(col.sessionId || '')) continue;
    const found = list.some((record) => record.provider === col.provider && record.id === col.sessionId);
    if (found) { out[col.id] = col.sessionId; used.add(col.sessionId); }
  }
  for (const col of Array.isArray(columns) ? columns : []) {
    if (!col || out[col.id]) continue;
    const matches = list.filter((record) => record.provider === col.provider && !used.has(record.id) &&
      record.at >= (col.since || 0) && cwdMatches(record, col.cwd, platform));
    if (matches.length === 1) { out[col.id] = matches[0].id; used.add(matches[0].id); }
  }
  return out;
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
  sameCwd, listCursor, listCodex, listAgy, assignSessions, defaultRoots, resolveSessions,
};
