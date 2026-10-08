'use strict';
// Reads this machine's own CLI logs for token usage: Claude Code session JSONL
// (every seat directory, a shared directory once), claude-ds on DeepSeek,
// Codex rollout JSONL, Antigravity conversation databases and Cursor's
// official usage CSV exports. Only counts, model names and times leave a log
// line; prompts and replies are never kept. Runs in its own process
// (token-usage-worker.js) so the app's main process is never busy with it.
//
// Incremental: a JSONL file is read from where the last scan stopped (an
// appended log only costs its new lines); a database or CSV is read again only
// when its size or time changes. What each file held is kept in a cache, so
// a log deleted later (Claude Code prunes old sessions) still counts.
const fs = require('fs');
const path = require('path');
const C = require('./token-usage-core');

const CACHE_VERSION = 1;
const KEEP_DAYS = 62;          // the view shows 30 days; a little more is kept
const CHUNK = 8 * 1024 * 1024;

function statOf(file) { try { return fs.statSync(file); } catch (_) { return null; } }
function realDir(dir) { try { return fs.realpathSync(dir); } catch (_) { return null; } }
function listFiles(dir, test, out = [], depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 8) listFiles(p, test, out, depth + 1); } else if (e.isFile() && test(e.name)) out.push(p);
  }
  return out;
}

// Where each source keeps its logs, relative to the home folder. Claude seat
// directories AgentDeck knows about are added by the caller; two names for one
// directory (~/.claude-us links to ~/.claude/projects) are read once.
function sourceDirs(home, extraClaude = []) {
  const claude = ['.claude', '.claude-us', '.claude-us2', ...extraClaude]
    .map((d) => (path.isAbsolute(d) ? d : path.join(home, d)))
    .map((d) => path.join(d, 'projects'));
  return {
    claude,
    deepseek: [path.join(home, '.local', 'claude-deepseek', 'config', 'projects')],
    codex: [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')],
    antigravity: ['antigravity-cli', 'antigravity', 'antigravity-ide', 'antigravity-backup'].map((n) => path.join(home, '.gemini', n, 'conversations')),
    cursor: [path.join(home, 'Downloads')],
    geminiCli: [path.join(home, '.gemini', 'tmp')],
  };
}

function loadCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.version === CACHE_VERSION && c.files && typeof c.files === 'object') return c;
  } catch (_) {}
  return { version: CACHE_VERSION, files: {} };
}
function saveCache(file, cache) {
  if (!file) return;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

const pack = (r) => [r.key, r.ts, r.model, r.input, r.output, r.cacheRead, r.cacheWrite];
const unpack = (a, source) => ({ source, key: a[0], ts: a[1], model: a[2], input: a[3], output: a[4], cacheRead: a[5], cacheWrite: a[6] });

// Feed every complete line after `offset` to onLine(buffer); returns the new
// offset (the end of the last complete line). A line still being written stays
// for the next scan.
function readLines(file, offset, size, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = offset, carry = null;
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(len);
      const got = fs.readSync(fd, buf, 0, len, pos);
      if (got <= 0) break;
      pos += got;
      let data = buf.subarray(0, got);
      if (carry) { data = Buffer.concat([carry, data]); carry = null; }
      let start = 0, nl;
      while ((nl = data.indexOf(10, start)) >= 0) {
        if (nl > start) onLine(data.subarray(start, nl));
        start = nl + 1;
      }
      if (start < data.length) carry = Buffer.from(data.subarray(start));
    }
    return pos - (carry ? carry.length : 0);
  } finally { fs.closeSync(fd); }
}
const parse = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; } };

function readClaudeFile(file, entry, st) {
  entry.recs = entry.recs || [];
  entry.offset = readLines(file, entry.offset || 0, st.size, (line) => {
    if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) return;
    for (const r of C.claudeRecords(parse(line))) entry.recs.push(pack(r));
  });
}
function readCodexFile(file, entry, st) {
  entry.recs = entry.recs || [];
  const state = entry.state || (entry.state = C.codexState());
  const hadRecords = state.records;
  entry.offset = readLines(file, entry.offset || 0, st.size, (line) => {
    if (line.indexOf('token_usage_record') < 0 && line.indexOf('"token_count"') < 0 && line.indexOf('"turn_context"') < 0) return;
    const r = C.codexLine(state, parse(line));
    if (!r) return;
    if (r.fromEvent) r.key = `ev:${path.basename(file)}#${state.events}`;
    entry.recs.push(pack(r));
  });
  // A file that turned out to carry per-response records drops what its
  // token_count events had counted.
  if (state.records && !hadRecords) entry.recs = entry.recs.filter((a) => !String(a[0]).startsWith('ev:'));
}

let Sqlite = null;
function sqlite() {
  if (Sqlite === null) {
    try {
      const warn = process.emitWarning;
      process.emitWarning = () => {};          // node:sqlite announces itself as experimental
      try { Sqlite = require('node:sqlite').DatabaseSync; } finally { process.emitWarning = warn; }
    } catch (_) { Sqlite = false; }
  }
  return Sqlite;
}
function readAntigravityDb(file, entry) {
  const Db = sqlite();
  if (!Db) throw new Error('sqlite unavailable');
  const db = new Db(file, { readOnly: true });
  try {
    const recs = [];
    const rows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').all();
    for (const row of rows) {
      const r = C.antigravityStep(row.metadata instanceof Uint8Array ? row.metadata : new Uint8Array(row.metadata));
      if (!r) continue;
      if (!r.key) r.key = `${path.basename(file)}#${row.idx}`;
      recs.push(pack(r));
    }
    entry.recs = recs;
  } finally { db.close(); }
}
function readCursorCsv(file, entry) {
  const parsed = C.cursorCsv(fs.readFileSync(file, 'utf8'));
  entry.recs = parsed.ok ? parsed.records.map(pack) : [];
  entry.missing = parsed.missing;
  entry.csv = parsed.ok;
}

// One scan: refresh the cache from the logs, then sum every day from KEEP_DAYS
// ago to today. Each source reports how it went (sources[]), so a CLI that
// leaves no token records is shown as 无数据, never as 0.
async function scan({ home, cacheFile, now = Date.now(), extraClaude = [] } = {}) {
  const started = Date.now();
  const cache = loadCache(cacheFile);
  const today = C.dayKey(now);
  const from = C.addDays(today, -(KEEP_DAYS - 1));
  const fromMs = C.dayStart(from);
  const dirs = sourceDirs(home, extraClaude);
  const report = {};
  const note = (id, patch) => { report[id] = { files: 0, errors: 0, ...(report[id] || {}), ...patch }; };
  const touched = new Set();
  const visit = (source, file, read, append) => {
    const st = statOf(file);
    if (!st || st.mtimeMs < fromMs) return;
    report[source].files++;
    touched.add(file);
    let entry = cache.files[file];
    const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (entry && entry.source !== source) entry = null;
    if (append) {
      // An appended log keeps its start; a shorter or replaced file is read
      // from the top. What the old file held still counts: records with an
      // identity of their own are kept (reading them again merges by that
      // identity), only token_count positions (ev:) are dropped.
      if (entry && (st.size < (entry.offset || 0) || (entry.ino && st.ino && entry.ino !== st.ino))) {
        entry = { source, offset: 0, recs: (entry.recs || []).filter((a) => a[1] >= fromMs && !String(a[0]).startsWith('ev:')) };
      }
      if (entry && entry.offset && entry.size === st.size) return;
    } else if (entry && entry.sig === sig) return;
    entry = entry || { source, offset: 0, recs: [] };
    try {
      read(file, entry, st);
      entry.size = st.size; entry.sig = sig; entry.ino = st.ino || 0;
      cache.files[file] = entry;
    } catch (_) { report[source].errors++; }
  };

  // Claude Code and claude-ds: each real directory once.
  for (const [source, roots] of [['claude', dirs.claude], ['deepseek', dirs.deepseek]]) {
    note(source, { dirs: 0 });
    const done = new Set();
    for (const root of roots) {
      const real = realDir(root);
      if (!real || done.has(real)) continue;
      done.add(real);
      report[source].dirs++;
      for (const f of listFiles(real, (n) => n.endsWith('.jsonl'))) visit(source, f, readClaudeFile, true);
    }
  }
  note('codex', { dirs: 0 });
  for (const root of dirs.codex) {
    if (!statOf(root)) continue;
    report.codex.dirs++;
    for (const f of listFiles(root, (n) => n.endsWith('.jsonl'))) visit('codex', f, readCodexFile, true);
  }
  note('antigravity', { dirs: 0 });
  for (const root of dirs.antigravity) {
    if (!statOf(root)) continue;
    report.antigravity.dirs++;
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => n.endsWith('.db')); } catch (_) {}
    for (const n of names) {
      const file = path.join(root, n);
      const wal = statOf(file + '-wal');
      // A conversation still being written changes in its -wal file first.
      const walSig = wal ? `${wal.size}:${Math.round(wal.mtimeMs)}` : '';
      const entry = cache.files[file];
      if (entry && entry.walSig !== walSig) entry.sig = '';
      visit('antigravity', file, (f, e) => { readAntigravityDb(f, e); e.walSig = walSig; }, false);
    }
  }
  note('cursor', { dirs: 0, missing: 0 });
  for (const root of dirs.cursor) {
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => /^usage-events.*\.csv$/i.test(n)); } catch (_) {}
    for (const n of names) visit('cursor', path.join(root, n), readCursorCsv, false);
  }
  // Gemini CLI keeps chats under ~/.gemini/tmp/<project>/chats; none here means 无数据.
  const geminiChats = listFiles(dirs.geminiCli[0], (n) => /^session-.*\.json$/.test(n)).length;

  // Forget files whose every record is older than the window and which are gone or untouched.
  for (const [file, entry] of Object.entries(cache.files)) {
    if (touched.has(file)) continue;
    const recent = (entry.recs || []).some((a) => a[1] >= fromMs);
    if (!recent) delete cache.files[file];
  }
  const all = [];
  const perSource = {};
  for (const entry of Object.values(cache.files)) {
    for (const a of entry.recs || []) if (a[1] >= fromMs) all.push(unpack(a, entry.source));
    if (entry.source === 'cursor') report.cursor.missing += entry.missing || 0;
  }
  const merged = C.mergeRecords(all);
  for (const r of merged) {
    const s = perSource[r.source] || (perSource[r.source] = { records: 0, lastTs: 0 });
    s.records++;
    if (r.ts > s.lastTs) s.lastTs = r.ts;
  }
  const days = C.dailySums(merged, from, today);
  try { saveCache(cacheFile, cache); } catch (_) {}

  const sources = [];
  const add = (id, name, extra) => {
    const r = report[id] || { files: 0, errors: 0 };
    const s = perSource[id] || { records: 0, lastTs: 0 };
    let state = s.records ? 'ok' : 'none';
    if (!s.records && r.errors) state = 'error';
    sources.push({ id, name, state, files: r.files, records: s.records, errors: r.errors, lastDay: s.lastTs ? C.dayKey(s.lastTs) : '', ...extra });
  };
  add('claude', 'Claude Code');
  add('codex', 'Codex');
  add('antigravity', 'Antigravity');
  add('deepseek', 'DeepSeek 兜底');
  add('cursor', 'Cursor', { export: true, missing: report.cursor.missing });
  sources.push({ id: 'gemini-cli', name: 'Gemini CLI', state: geminiChats ? 'unsupported' : 'none', files: geminiChats, records: 0, errors: 0, lastDay: '' });
  sources.push({ id: 'chatgpt-web', name: 'ChatGPT 网页', state: 'none', files: 0, records: 0, errors: 0, lastDay: '', web: true });
  return { version: CACHE_VERSION, today, from, generatedAt: now, tookMs: Date.now() - started, days, sources };
}

module.exports = { scan, sourceDirs, readLines, KEEP_DAYS, CACHE_VERSION };
