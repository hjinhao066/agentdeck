'use strict';
// Conversations that fell out of the archive. Before 2.0.4 the archive kept only its newest
// 500 sessions: an older one left config.archived at a launch, its saved terminal output was
// deleted at the next, and userData/chats/<id>.json stayed on disk with nothing pointing at
// it. At launch (main.js, before the replay prune) each such conversation goes back into
// config.archived: from the record an older copy of config.json still holds when there is
// one (command, folder, card, worktree as they were), otherwise from the chat file itself
// (it can be read and searched; restoring it opens a plain shell).
// Only conversations the user spoke in are taken. Nothing is deleted and no chat file is
// written; config.json is copied aside before it is rewritten. Main process and CLI only.
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

// At launch, before the page reads config.json. Never throws: on any failure the config
// stays as it was.
function recover({ configPath, chatDir, backups, now }) {
  try {
    if (!fs.existsSync(configPath)) return { added: 0 };
    const text = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { added: 0 };
    const found = scan({ config, chatDir, sources: oldConfigs(configPath, backups) });
    if (!found.entries.length) return { added: 0, silent: found.silent };
    const backup = `${configPath}.before-archive-recovery-${(now || Date.now)()}`;
    fs.writeFileSync(backup, text, { encoding: 'utf8', mode: 0o600 });
    config.archived = [...(Array.isArray(config.archived) ? config.archived : []), ...found.entries];
    fs.writeFileSync(configPath + '.tmp', JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(configPath + '.tmp', 0o600);
    fs.renameSync(configPath + '.tmp', configPath);
    return { added: found.entries.length, withRecord: found.withRecord, silent: found.silent, backup };
  } catch (_) { return { added: 0 }; }
}

module.exports = { scan, recover, oldConfigs, recordsFrom };
