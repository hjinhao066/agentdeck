// Pure helpers behind the left sidebar: folders, the order sessions appear in,
// and archived sessions. The deck always shows sessions in the same order as
// the sidebar (队长 and the sessions it opened, folders top to bottom, then
// loose sessions), so swiping left and right walks the list you see. No DOM, no Electron: runs in the page and tests.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./claude-seats-core') : root.ClaudeSeatsCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SidebarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  'use strict';

  const MAX_FOLDERS = 100;
  // The archive is never cut: the sidebar shows this many rows and one more page on request.
  const ARCHIVED_PAGE = 100;
  const FONT_DEFAULT = 13;
  // Hermes web console (private, owner-only); opened in the system browser.
  const HERMES_HUB_URL = 'https://hub.18-139-28-180.sslip.io/';
  function normalizeFontSize(size) {
    return typeof size === 'number' && Number.isFinite(size) ? Math.max(10, Math.min(20, size)) : FONT_DEFAULT;
  }
  // same shape the main process accepts for terminal ids (security.js)
  const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/;

  const clean = (value, max) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);

  // Terminal controls/settings are not progress, even without a ruled input box.
  const ACTIVITY_NOISE = /for agents|for shortcuts|bypass permissions|shift\+tab|esc to (?:interrupt|cancel)|press (?:up|esc|enter)|ctrl\+[a-z]|auto-accept|context left|⏵⏵|^Thinking:\s*(?:low|medium|high|xhigh|max)\b|^(?:Context|Session|Model|Weekly Reset):|^(?:Claude Code|OpenAI Codex)(?:\s+\(?v?\d[\w.-]*\)?)?\s*$/i;
  // Nor is a CLI's own update notice, or AgentDeck's own words echoed back from a prompt it typed
  // (a restart's 重发 / 真续接 note and the receipt contract under every dispatched task).
  const UPDATE_NOTICE = /\bupdate available\b|\bbrew upgrade\b|\bnpm (?:i|install) (?:-g|--global)\b|\bauto-?update failed\b|\bclaude doctor\b|release notes:\s*https?:/i;
  const AGENTDECK_ECHO = /^(?:重发|真续接|续接失败)：|^下面重发卡片任务|不要当成新派的另一张卡|^AgentDeck (?:刚重启|即将重启)|^(?:卡片任务|最后回执|重启前还没送达的指令)：|^这是同一次续接的再次送达|（AgentDeck 约定）|"\$AGENTDECK_BOARD_CLI"|\$env:AGENTDECK_BOARD_CLI|AGENTDECK_ 开头的变量|改用仓库里的 board-cli|AgentDeck 提供的 board-cli|回执必须通过命令提交|回执里不要贴文件正文/;
  function activityLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text || ACTIVITY_NOISE.test(text) || UPDATE_NOTICE.test(text) || AGENTDECK_ECHO.test(text) || /^[>❯›]/.test(text) ||
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

  // Crew under 队长, one group per visible model (and Claude seat, when pinned).
  // Groups with more people working come first; inside a group, 高优先级 sessions
  // (member.urgent) lead, then recent activity first.
  function crewModelGroups(members, seats) {
    const configured = S.normalize(seats);
    const map = new Map();
    for (const raw of Array.isArray(members) ? members : []) {
      if (!raw || raw.id == null) continue;
      const label = String(raw.label || '').trim() || '未识别';
      const metadata = configured.find((s) => s.id === raw.seat);
      const seat = metadata?.id || '';
      // The group is named by the account signed in behind the seat (seats carry `info`).
      const shown = metadata ? S.seatDisplay(metadata, (Array.isArray(seats) ? seats : []).find((s) => s && s.id === seat)?.info) : null;
      const key = label + '\u001f' + seat;
      let group = map.get(key);
      if (!group) {
        group = {
          key, label, seat, seatName: metadata?.name || '', flag: metadata?.icon || '',
          account: shown?.label || '', accountTitle: shown?.title || '',
          iconProvider: raw.iconProvider || '',
          working: 0, lastActive: 0, members: [],
        };
        map.set(key, group);
      }
      if (!group.iconProvider && raw.iconProvider) group.iconProvider = raw.iconProvider;
      const lastActive = Number(raw.lastActive) || 0;
      group.members.push({ id: raw.id, lastActive, urgent: raw.urgent === true });
      if (raw.working) group.working += 1;
      if (lastActive > group.lastActive) group.lastActive = lastActive;
    }
    const byRecent = (a, b) => b.urgent - a.urgent || b.lastActive - a.lastActive || String(a.id).localeCompare(String(b.id));
    const groups = [...map.values()];
    for (const group of groups) {
      group.members.sort(byRecent);
      group.ids = group.members.map((member) => member.id);
      group.urgent = group.members.filter((member) => member.urgent).length;
      delete group.members;
    }
    groups.sort((a, b) => b.working - a.working || b.lastActive - a.lastActive || a.label.localeCompare(b.label) || a.seat.localeCompare(b.seat));
    return groups;
  }

  function normalizeCollapsedModels(raw) {
    const out = [];
    const seen = new Set();
    for (const key of Array.isArray(raw) ? raw : []) {
      if (typeof key !== 'string') continue;
      const cleanKey = key.replace(/[\u0000-\u001e\u007f]/g, '').trim();
      if (!cleanKey || cleanKey.length > 160 || seen.has(cleanKey)) continue;
      seen.add(cleanKey);
      out.push(cleanKey);
      if (out.length >= 40) break;
    }
    return out;
  }

  // The crew list starts open. A fold the user makes lasts for this run and the rest of
  // that day; the first time the window is used on a later day it opens again.
  function localDay(when) {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }

  function normalizeArchived(raw) {
    const out = [];
    const seen = new Set();
    for (const a of Array.isArray(raw) ? raw : []) {
      if (!a || typeof a !== 'object' || !validId(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, archivedAt: Number.isFinite(a.archivedAt) ? a.archivedAt : 0 });
    }
    // Every archived session is kept: one dropped here is gone from the sidebar at the next
    // launch, and the launch after that main.js deletes its saved output (AGENTS.md: ids
    // survive relaunch). A long archive is shown a page at a time instead (archivedPage).
    out.sort((a, b) => b.archivedAt - a.archivedAt);
    return out;
  }
  // The newest `shown` archived sessions and how many older ones wait behind 显示更早的.
  function archivedPage(list, shown) {
    const all = Array.isArray(list) ? list : [];
    const n = Math.max(ARCHIVED_PAGE, Math.floor(Number(shown)) || 0);
    return { rows: all.slice(0, n), more: Math.max(0, all.length - n) };
  }

  return {
    MAX_FOLDERS, ARCHIVED_PAGE, FONT_DEFAULT, HERMES_HUB_URL, normalizeFontSize, validId, activityLine, newFolderId, normalizeFolders, folderOf, groupSessions,
    orderedColumns, captainOf, moveColumn, nextFolderName, removeFolder, crewModelGroups, normalizeCollapsedModels, localDay, normalizeArchived, archivedPage,
  };
});
