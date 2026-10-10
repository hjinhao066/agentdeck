'use strict';
// Conversations that fell out of the archive. Before 2.0.4 the archive kept only its newest
// 500 sessions: an older one left config.archived at a launch, its saved terminal output was
// deleted at the next, and userData/chats/<id>.json stayed on disk with nothing pointing at
// it. At launch (main.js, before the replay prune) each such conversation goes back into
// config.archived: from the record an older copy of config.json still holds when there is
// one (command, folder, card, worktree as they were), otherwise from the chat file itself
// (it can be read and searched; restoring it opens a plain shell).
// Only conversations the user spoke in are taken. Nothing is deleted and no chat file is
// written; the archive file is copied aside before it is rewritten. Main process and CLI only.
//
// The archive itself (closed sessions kept for restore; no cap) is userData/archived.json,
// { v: 1, archived: [...] }, beside config.json and not in it: config.json is rewritten on every
// save, about 8 times a minute, and the archive was most of it while it changes a few times an
// hour. migrate moves an archive still in config.json there at launch; createArchiveWriter is
// the main process's config writer, which writes archived.json only when the archive changed.
const fs = require('node:fs');
const path = require('node:path');
const { validId } = require('./security');
const ChatCore = require('./chat-core');
const SidebarCore = require('./sidebar-core');

const TITLE_MAX = 40;
const idOk = (id) => validId(id) && SidebarCore.validId(id);
// What the user (or 队长, for a session it ran) said: not a notice, not a dispatch card.
const said = (chat) => chat.turns.filter((t) => t.kind !== 'notice' && t.kind !== 'task' && t.user.trim());
const titleOf = (text) => {
  const line = text.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  return [...line].slice(0, TITLE_MAX).join('');
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };

// ---- the archive file ----
const ARCHIVE_FILE = 'archived.json';
const archivePathFor = (configPath) => path.join(path.dirname(configPath), ARCHIVE_FILE);
// The list archived.json holds; null when there is no such file or it cannot be read.
function readArchive(archivePath) {
  const data = readJson(archivePath);
  return data && Array.isArray(data.archived) ? data.archived : null;
}
const archiveText = (listText) => '{"v":1,"archived":' + listText + '}';
function atomicWrite(file, text) {
  fs.writeFileSync(file + '.tmp', text, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file + '.tmp', 0o600);
  fs.renameSync(file + '.tmp', file);
}
const hasId = (a) => !!a && typeof a === 'object' && typeof a.id === 'string';
// One list from two: `primary` (config.json's, written by whatever ran last) wins a tie with
// `secondary` (archived.json's). A session open as a column is not also in the archive: a crash
// between the two writes of one save can leave it in both, and the open column is the live one.
// Entries without an id are kept as they are.
function mergeArchive(primary, secondary, columns) {
  const list = (v) => (Array.isArray(v) ? v : []);
  const open = new Set(list(columns).filter(hasId).map((c) => c.id));
  const first = new Map(list(primary).filter(hasId).map((a) => [a.id, a]));
  const out = [], seen = new Set();
  for (const a of [...list(secondary).map((a) => (hasId(a) && first.get(a.id)) || a), ...list(primary)]) {
    if (!hasId(a)) { if (!out.includes(a)) out.push(a); continue; }
    if (seen.has(a.id) || open.has(a.id)) continue;
    seen.add(a.id); out.push(a);
  }
  return out;
}
// The config the page and the main process work with: config.json plus archived.json's list
// (merged with config.json's if it still has one). The config passed in is not changed.
function withArchive(config, archivePath, read = readArchive) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const stored = read(archivePath);
  if (stored === null) return config;
  return { ...config, archived: mergeArchive(config.archived, stored, config.columns) };
}

// At launch, before the recovery below and the replay prune: an archive still in config.json
// (the first launch of this version, or a config an older version wrote after a rollback) moves
// to archived.json, merged with what is there. config.json is copied aside first, archived.json
// is written and read back, and only then is the archive taken out of config.json: a failure at
// any step leaves it where it was (in both files at worst, which the next launch merges). An
// archived.json that cannot be read is copied aside, not written over. Never throws.
function migrate({ configPath, archivePath = archivePathFor(configPath), now }) {
  try {
    if (!fs.existsSync(configPath)) return { moved: 0 };
    const text = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.archived)) return { moved: 0 };
    const stamp = (now || Date.now)();
    let stored = null;
    if (fs.existsSync(archivePath)) {
      stored = readArchive(archivePath);
      if (stored === null) fs.copyFileSync(archivePath, `${archivePath}.unreadable-${stamp}`);
    }
    const listText = JSON.stringify(mergeArchive(config.archived, stored, config.columns));
    const backup = `${configPath}.before-archive-split-${stamp}`;
    fs.writeFileSync(backup, text, { encoding: 'utf8', mode: 0o600 });
    atomicWrite(archivePath, archiveText(listText));
    const back = readArchive(archivePath);
    if (!back || JSON.stringify(back) !== listText) return { moved: 0, backup };
    delete config.archived;
    atomicWrite(configPath, JSON.stringify(config, null, 2));
    return { moved: back.length, backup };
  } catch (_) { return { moved: 0 }; }
}

// The main process's config writer (save-config / save-config-sync). The page sends the archive
// only when it changed, as `archivedText` (the list as JSON); a whole config (saveConfigSync)
// carries it as `archived`. config.json is written without it, archived.json only when the list
// differs from what the file holds. A save that takes a session out of the archive (a restore,
// a delete) writes config.json first, any other archived.json first, so a crash between the two
// leaves a session in both files, never in neither. When archived.json cannot be written the
// archive goes into config.json instead, and the next save tries the file again.
function createArchiveWriter({ configPath, archivePath = archivePathFor(configPath) }) {
  const idsOf = (list) => new Set(list.filter(hasId).map((a) => a.id));
  let disk = null; // { text, ids } of what archived.json holds, read at the first save
  let pending = null; // { text, list } not written to archived.json yet
  const writeConfig = (cfg) => atomicWrite(configPath, JSON.stringify(cfg, null, 2));
  return {
    save(cfg) {
      let text = null;
      if (typeof cfg.archivedText === 'string') text = cfg.archivedText;
      else if (Array.isArray(cfg.archived)) text = JSON.stringify(cfg.archived);
      delete cfg.archivedText;
      delete cfg.archived;
      if (!disk) {
        const stored = readArchive(archivePath);
        disk = stored ? { text: JSON.stringify(stored), ids: idsOf(stored) } : { text: null, ids: new Set() };
      }
      if (text !== null && text !== disk.text && text !== pending?.text) {
        let list = null;
        try { list = JSON.parse(text); } catch (_) {}
        if (Array.isArray(list)) pending = { text, list };
      }
      if (!pending) { writeConfig(cfg); return; }
      const next = idsOf(pending.list);
      const removes = [...disk.ids].some((id) => !next.has(id));
      const writeArchive = () => {
        try { atomicWrite(archivePath, archiveText(pending.text)); } catch (_) { return false; }
        disk = { text: pending.text, ids: next };
        pending = null;
        return true;
      };
      if (removes) writeConfig(cfg);
      if (writeArchive()) { if (!removes) writeConfig(cfg); return; }
      writeConfig({ ...cfg, archived: pending.list });
    },
  };
}

// Older copies of config.json, newest first: the ones left beside it (config.json.bak-…,
// earlier recoveries) and the userData copy inside each install backup.
function oldConfigs(configPath, backups) {
  const out = [];
  const add = (file) => { try { const s = fs.statSync(file); if (s.isFile()) out.push({ file, at: s.mtimeMs }); } catch (_) {} };
  const dir = path.dirname(configPath), name = path.basename(configPath);
  let beside = [];
  try { beside = fs.readdirSync(dir); } catch (_) {}
  for (const f of beside) if (f.startsWith(name + '.') && !f.endsWith('.tmp')) add(path.join(dir, f));
  for (const root of Array.isArray(backups) ? backups : []) {
    let made = [];
    try { made = fs.readdirSync(root); } catch (_) {}
    for (const d of made) add(path.join(root, d, 'userData', name));
  }
  return out.sort((a, b) => b.at - a.at).map((x) => x.file);
}

// The archive entry each wanted id had, from the newest copy that lists it. An entry that
// claims to be 队长 is never taken: there is exactly one 队长 column.
function recordsFrom(sources, wanted) {
  const found = new Map();
  for (const file of sources) {
    if (found.size === wanted.size) break;
    const old = readJson(file);
    for (const a of old && Array.isArray(old.archived) ? old.archived : []) {
      if (a && typeof a === 'object' && wanted.has(a.id) && !found.has(a.id) && a.isMain !== true) found.set(a.id, a);
    }
  }
  return found;
}

// Read-only. `sources` are older config copies (oldConfigs); they are opened only when a
// conversation needs its record.
function scan({ config, chatDir, sources }) {
  const cfg = config && typeof config === 'object' ? config : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  // 队长's cleared chats are listed in captainHistory and flagged in their own file
  const known = new Set([...list(cfg.columns), ...list(cfg.archived), ...list(cfg.captainHistory)].map((c) => c && c.id));
  const lost = [];
  let silent = 0;
  let files = [];
  try { files = fs.readdirSync(chatDir); } catch (_) {}
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (id === f || !idOk(id) || known.has(id)) continue;
    const raw = readJson(path.join(chatDir, f));
    if (!raw || raw.captainArchive === true) continue;
    const chat = ChatCore.normalizeChat(raw, id);
    const spoken = said(chat);
    if (!spoken.length) { silent++; continue; }
    lost.push({ id, turns: chat.turns.length, lastAt: Math.max(0, ...chat.turns.map((t) => t.end || t.ts)), title: titleOf(spoken[0].user) });
  }
  const records = lost.length ? recordsFrom(list(sources), new Set(lost.map((l) => l.id))) : new Map();
  const entries = lost.map((l) => {
    const record = records.get(l.id);
    if (record) return { ...record, archivedAt: Number.isFinite(record.archivedAt) ? record.archivedAt : l.lastAt, recovered: true };
    return {
      id: l.id, title: l.title || '找回的对话', manualTitle: true, cmd: '', cwd: '',
      role: 'manual', relationship: 'Independent manual terminal', archivedAt: l.lastAt, recovered: true,
    };
  });
  return { lost, entries, silent, withRecord: records.size };
}

// At launch, after migrate and before the page reads config.json. With `archivePath` the archive
// is read from archived.json and the entries go there (copied aside first, if it exists); an
// archive still in config.json (migrate could not move it) is extended where it is. Never throws:
// on any failure the files stay as they were.
function recover({ configPath, archivePath, chatDir, backups, now }) {
  try {
    if (!fs.existsSync(configPath)) return { added: 0 };
    const text = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { added: 0 };
    const stored = archivePath ? readArchive(archivePath) : null;
    const inFile = !!archivePath && (stored !== null || (!Array.isArray(config.archived) && !fs.existsSync(archivePath)));
    const found = scan({ config: withArchive(config, archivePath, () => stored), chatDir, sources: oldConfigs(configPath, backups) });
    if (!found.entries.length) return { added: 0, silent: found.silent };
    if (inFile) {
      let backup;
      if (stored !== null) {
        backup = `${archivePath}.before-archive-recovery-${(now || Date.now)()}`;
        fs.copyFileSync(archivePath, backup);
        fs.chmodSync(backup, 0o600);
      }
      atomicWrite(archivePath, archiveText(JSON.stringify([...(stored || []), ...found.entries])));
      return { added: found.entries.length, withRecord: found.withRecord, silent: found.silent, backup };
    }
    const backup = `${configPath}.before-archive-recovery-${(now || Date.now)()}`;
    fs.writeFileSync(backup, text, { encoding: 'utf8', mode: 0o600 });
    config.archived = [...(Array.isArray(config.archived) ? config.archived : []), ...found.entries];
    fs.writeFileSync(configPath + '.tmp', JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(configPath + '.tmp', 0o600);
    fs.renameSync(configPath + '.tmp', configPath);
    return { added: found.entries.length, withRecord: found.withRecord, silent: found.silent, backup };
  } catch (_) { return { added: 0 }; }
}

module.exports = { scan, recover, oldConfigs, recordsFrom, ARCHIVE_FILE, archivePathFor, readArchive, mergeArchive, withArchive, migrate, createArchiveWriter };
