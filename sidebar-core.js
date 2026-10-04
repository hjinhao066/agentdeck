// Pure helpers behind the left sidebar: folders, the order sessions appear in,
// and archived sessions. The deck always shows sessions in the same order as
// the sidebar (队长 and the sessions it opened, folders top to bottom, then
// loose sessions), so swiping left and right walks the list you see. No DOM, no Electron: runs in the page and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidebarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FOLDERS = 100;
  const MAX_ARCHIVED = 500;
  const FONT_DEFAULT = 13;
  function normalizeFontSize(size) {
    return typeof size === 'number' && Number.isFinite(size) ? Math.max(10, Math.min(20, size)) : FONT_DEFAULT;
  }
  // same shape the main process accepts for terminal ids (security.js)
  const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;

  const clean = (value, max) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);

  // Terminal controls/settings are not progress, even without a ruled input box.
  const ACTIVITY_NOISE = /for agents|for shortcuts|bypass permissions|shift\+tab|esc to (?:interrupt|cancel)|press (?:up|esc|enter)|ctrl\+[a-z]|auto-accept|context left|⏵⏵|^Thinking:\s*(?:low|medium|high|xhigh|max)\b|^(?:Context|Session|Model|Weekly Reset):|^(?:Claude Code|OpenAI Codex)\s*$/i;
  function activityLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text || ACTIVITY_NOISE.test(text) || /^[>❯›]/.test(text) ||
          /^[\s│⎿─━╌═╭╮╰╯┌┐└┘\-—·.]*$/.test(text) ||
          /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s*$/.test(text)) continue;
      return text.length > 60 ? text.slice(0, 59) + '…' : text;
    }
    return '';
  }

  function newFolderId() { return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }

  function normalizeFolders(raw) {
    const out = [];
    const seen = new Set();
    for (const f of Array.isArray(raw) ? raw : []) {
      if (!f || !validId(f.id) || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, name: clean(f.name, 80) || '文件夹', collapsed: !!f.collapsed });
      if (out.length >= MAX_FOLDERS) break;
    }
    return out;
  }

  // A session's folder, or null when it has none or the folder is gone.
  function folderOf(col, folders) {
    const id = col && col.folderId;
    return id && folders.some((f) => f.id === id) ? id : null;
  }

  // Sessions 队长 opened (captainCrew) sit right under it until the user files
  // them elsewhere; with no 队长 they are ordinary sessions again.
  const CREW = '\u0000crew';
  function groupKey(col, folders, hasMain) {
    if (hasMain && col.captainCrew) return CREW;
    return folderOf(col, folders) || '';
  }

  // 队长's sessions, folders in their order (each with its sessions in deck
  // order), then loose sessions. 队长 (the main session) is not part of any
  // group: the sidebar pins it as its own protected row above the folders
  // (captainOf), with its sessions listed under it.
  function groupSessions(columns, folders) {
    const hasMain = columns.some((c) => c.isMain);
    const groups = folders.map((folder) => ({ folder, items: [] }));
    const byId = new Map(groups.map((g) => [g.folder.id, g]));
    const crew = [];
    const loose = [];
    for (const col of columns) {
      if (col.isMain) continue;
      const key = groupKey(col, folders, hasMain);
      if (key === CREW) crew.push(col);
      else if (key) byId.get(key).items.push(col);
      else loose.push(col);
    }
    return { crew, groups, loose };
  }

  // 队长 is always the first column of the deck, and the first sidebar row;
  // the sessions it opened follow it.
  function orderedColumns(columns, folders) {
    const { crew, groups, loose } = groupSessions(columns, folders);
    return [...columns.filter((c) => c.isMain), ...crew, ...groups.flatMap((g) => g.items), ...loose];
  }
  function captainOf(columns) {
    return columns.find((c) => c.isMain) || null;
  }

  // Move a session under 队长 (target.crew), into a folder, or loose (no
  // folderId), optionally before another session of that group. Returns the
  // new deck order. 队长 never moves.
  function moveColumn(columns, folders, id, target) {
    const col = columns.find((c) => c.id === id);
    if (!col) return columns.slice();
    if (col.isMain) return orderedColumns(columns, folders);
    const hasMain = columns.some((c) => c.isMain);
    const crew = !!(target && target.crew) && hasMain;
    const folderId = !crew && target && target.folderId && folders.some((f) => f.id === target.folderId) ? target.folderId : null;
    col.captainCrew = crew;
    col.folderId = folderId;
    const key = groupKey(col, folders, hasMain);
    const rest = columns.filter((c) => c !== col);
    const beforeId = target && target.beforeId;
    let at = -1;
    if (beforeId && beforeId !== id) {
      const before = rest.findIndex((c) => c.id === beforeId && !c.isMain && groupKey(c, folders, hasMain) === key);
      if (before >= 0) at = before;
    }
    if (at < 0) {
      // end of its group
      let last = -1;
      rest.forEach((c, i) => { if (!c.isMain && groupKey(c, folders, hasMain) === key) last = i; });
      at = last + 1;
      if (last < 0) at = rest.length;
    }
    rest.splice(at, 0, col);
    return orderedColumns(rest, folders);
  }

  function nextFolderName(folders, base = '新文件夹') {
    const used = new Set(folders.map((f) => f.name));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  // Deleting a folder keeps its sessions; they just become loose.
  function removeFolder(columns, folders, folderId) {
    columns.forEach((c) => { if (c.folderId === folderId) c.folderId = null; });
    return folders.filter((f) => f.id !== folderId);
  }

  function normalizeArchived(raw) {
    const out = [];
    const seen = new Set();
    for (const a of Array.isArray(raw) ? raw : []) {
      if (!a || typeof a !== 'object' || !validId(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, archivedAt: Number.isFinite(a.archivedAt) ? a.archivedAt : 0 });
    }
    out.sort((a, b) => b.archivedAt - a.archivedAt);
    return out.slice(0, MAX_ARCHIVED);
  }

  return {
    MAX_FOLDERS, FONT_DEFAULT, normalizeFontSize, validId, activityLine, newFolderId, normalizeFolders, folderOf, groupSessions,
    orderedColumns, captainOf, moveColumn, nextFolderName, removeFolder, normalizeArchived,
  };
});
