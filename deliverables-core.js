// The 交付文件 panel beside 队长's conversation: the result files (documents,
// reports, pictures, videos) that came up in 队长's replies and in the crew's
// receipts, newest first, one row per path. Process files (scripts, data, logs,
// anything under node_modules or a scratch folder) are left out by three lists
// the user can change. What has been found is kept, all of it, as an index in
// config.json (`chatDeliverables`), so the conversations from before a context
// clear are read once and never again. No DOM, no Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./chat-core.js') : root.ChatCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DeliverablesCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  // types: the file types a path 队长 merely mentions must have to count.
  // process: types that never count, not even when a receipt hands them in
  // (code, data dumps, logs, databases). skip: folder names (or a run of them,
  // "var/folders") whose files never count. A file a receipt lists is a result
  // the worker handed in on purpose: only process and skip leave it out.
  const DEFAULT_RULES = Object.freeze({
    types: Object.freeze(['md', 'markdown', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'key', 'xls', 'xlsx', 'numbers', 'pages',
      'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'mp4', 'mov', 'm4v', 'webm', 'mp3', 'm4a', 'wav']),
    skip: Object.freeze(['node_modules', '.git', 'scratchpad', 'tmp', 'temp', 'var/folders', '.cache', 'caches', '__pycache__',
      '.venv', 'venv', 'site-packages', 'test-results', 'playwright-report', '.next', 'dist']),
    process: Object.freeze(['py', 'pyc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonl', 'log', 'sqlite', 'sqlite3', 'db',
      'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'lock', 'map', 'css', 'scss', 'yml', 'yaml', 'toml', 'ini', 'env', 'tmp', 'bak', 'swp', 'pid']),
  });
  const MAX_RULES = 200;

  // "md, .PDF  docx" -> ['md', 'pdf', 'docx']
  function parseList(text, folders) {
    const out = [];
    for (let item of String(text == null ? '' : text).split(/[\s,，、;；]+/)) {
      item = item.trim().toLowerCase().replace(/\\/g, '/');
      item = folders ? item.replace(/^\/+|\/+$/g, '') : item.replace(/^\*?\.+/, '');
      if (item && item.length <= 80 && !out.includes(item)) out.push(item);
    }
    return out.slice(0, MAX_RULES);
  }
  // Saved rules, or the defaults for a list that was never changed.
  function normalizeRules(saved) {
    const s = saved && typeof saved === 'object' ? saved : {};
    return {
      types: Array.isArray(s.types) ? parseList(s.types.join(' ')) : [...DEFAULT_RULES.types],
      skip: Array.isArray(s.skip) ? parseList(s.skip.join(' '), true) : [...DEFAULT_RULES.skip],
      process: Array.isArray(s.process) ? parseList(s.process.join(' ')) : [...DEFAULT_RULES.process],
    };
  }
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const isDefault = (rules) => ['types', 'skip', 'process'].every((k) => sameList(rules[k], DEFAULT_RULES[k]));
  const rulesKey = (rules) => JSON.stringify([rules.types, rules.skip, rules.process]);

  function segments(path) {
    return String(path).replace(/^file:\/\//, '').replace(/:\d+(?::\d+)?$/, '').split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  }
  // A result file: not a process type, no folder on its way skipped, and, unless
  // a receipt handed it in (delivered), of a result type.
  function isDeliverable(path, rules, delivered) {
    const parts = segments(path);
    if (parts.length < 2) return false;
    const name = parts[parts.length - 1];
    const ext = C.extOf(name);
    if (ext && rules.process.includes(ext)) return false;
    if (!delivered && (!ext || !rules.types.includes(ext))) return false;
    const folders = parts.slice(0, -1);
    return !rules.skip.some((rule) => {
      const run = rule.split('/').filter(Boolean);
      for (let i = 0; i + run.length <= folders.length; i++) {
        if (run.every((r, k) => folders[i + k] === r)) return true;
      }
      return false;
    });
  }

  // A file 队长 mentioned has no project of its own: take the project whose
  // name is one of its folders, or starts one ("agentdeck-chat-redesign").
  function guessProject(path, projects) {
    const parts = segments(path).slice(0, -1);
    let best = '';
    for (const project of projects || []) {
      const p = String(project || '').trim();
      const k = p.toLowerCase();
      if (!k || k.length <= best.length) continue;
      if (parts.some((s) => s === k || (s.startsWith(k) && /^[-_. ]/.test(s.slice(k.length))))) best = p;
    }
    return best;
  }

  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const ABS_PATH = /^(?:file:\/\/)?(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;

  // A path in prose may run on into the sentence ("…/plan.md 里最后三项"): the
  // link finder leaves that to the disk. Here the path ends at the first space
  // that follows a result file's name; "My Project/plan.md" keeps its space.
  function trimProse(path, rules) {
    for (let at = path.indexOf(' '); at > 0; at = path.indexOf(' ', at + 1)) {
      const head = path.slice(0, at).replace(/[.,;:!?)\]}>'"，。；：！？）】」]+$/, '');
      if (isDeliverable(head, rules)) return head;
    }
    return isDeliverable(path, rules) ? path : '';
  }

  // The files 队长 mentioned in one conversation.
  //   turns: the chat's turns; text(turn): the reply as the chat view shows it
  //   findLinks(line) -> [{ kind, text }]
  //   where: { colId, chatId, old } (old: a conversation from before a clear)
  function fromReplies(turns, { text, findLinks, rules, colId, chatId, old }) {
    const out = [];
    for (const turn of turns || []) {
      if (!turn || turn.kind === 'task' || !turn.reply) continue;
      const reply = text ? text(turn) : turn.reply;
      if (!reply) continue;
      for (const line of reply.split('\n')) {
        for (const found of findLinks(line)) {
          const path = trimProse(String(found.text || '').trim(), rules);
          if (found.kind !== 'file' || !path || !ABS_PATH.test(path)) continue;
          out.push({ path, ts: Number(turn.ts) || 0, from: 'reply', colId: colId || '', chatId: chatId || '', turnId: String(turn.id || ''), old: !!old });
        }
      }
    }
    return out;
  }
  // The files the crew handed in: ChatCore.deliveryReceipts' list.
  function fromReceipts(receipts, rules) {
    const out = [];
    for (const r of receipts || []) {
      for (const raw of r.files || []) {
        const path = String(raw).trim();
        if (!isDeliverable(path, rules, true)) continue;
        out.push({ path, ts: Number(r.ts) || 0, from: 'receipt', colId: r.colId || '', session: r.session || '', project: r.project || '', task: r.task || '', gone: !!r.gone, archived: !!r.archived });
      }
    }
    return out;
  }

  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || typeof raw.key !== 'string') return null;
    const item = {
      key: raw.key.slice(0, 1024), path: raw.path.slice(0, 1024), ts: Number.isFinite(raw.ts) ? raw.ts : 0,
      from: raw.from === 'receipt' ? 'receipt' : 'reply',
      project: clip(raw.project, 120), colId: clip(raw.colId, 160), session: clip(raw.session, 120), task: clip(raw.task, 200),
      chatId: clip(raw.chatId, 160), turnId: clip(raw.turnId, 160),
    };
    if (raw.old === true) item.old = true;
    if (raw.gone === true) item.gone = true;
    if (raw.archived === true) item.archived = true;
    return item;
  }
  // config.chatDeliverables -> { v, rules, scanned, items }. Kept items that the
  // current rules leave out are dropped; changed rules read every conversation again.
  function normalizeIndex(saved, rules) {
    const s = saved && typeof saved === 'object' ? saved : {};
    const key = rulesKey(rules);
    const same = s.rules === key;
    const items = (Array.isArray(s.items) ? s.items : []).map(normalizeItem).filter((i) => i && isDeliverable(i.path, rules, i.from === 'receipt'));
    const scanned = same && Array.isArray(s.scanned) ? s.scanned.filter((id) => typeof id === 'string' && id.length <= 160) : [];
    return { v: 1, rules: key, scanned: [...new Set(scanned)], items };
  }

  // Fold what was just found into the index: one item per path (Windows paths
  // ignore case and slash direction), the latest mention wins; a receipt wins a
  // tie and lends its project to a later mention that has none. Nothing is ever
  // dropped for room: the panel shows the newest and pages through the rest.
  function mergeIndex(index, entries, { home, projects } = {}) {
    const byKey = new Map(index.items.map((i) => [i.key, i]));
    for (const e of entries) {
      const key = C.pathKey(e.path, home);
      if (!key) continue;
      const prev = byKey.get(key);
      const item = normalizeItem({ ...e, key });
      if (!item) continue;
      if (!item.project) item.project = guessProject(item.path, projects);
      if (prev) {
        const newer = item.ts > prev.ts || (item.ts === prev.ts && item.from === 'receipt' && prev.from !== 'receipt');
        const winner = newer ? item : prev, other = newer ? prev : item;
        if (!winner.project && other.project) winner.project = other.project;
        if (!newer) continue;
      }
      byKey.set(key, item);
    }
    const items = [...byKey.values()].sort((a, b) => b.ts - a.ts || a.path.localeCompare(b.path));
    return { ...index, items };
  }

  // Newest first, one group per day: 今天, 昨天, then 10月6日 周二.
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayLabel(ts, now) {
    if (!ts) return '时间未知';
    const d = new Date(ts), n = new Date(now);
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86_400_000);
    if (diff === 0) return '今天';
    if (diff === -1) return '昨天';
    const date = (d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '年') + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return date + ' ' + WEEK[d.getDay()];
  }
  function byDay(items, now) {
    const groups = [];
    for (const item of items) {
      const key = item.ts ? dayKey(item.ts) : '';
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) groups.push(g = { key, label: dayLabel(item.ts, now), items: [] });
      g.items.push(item);
    }
    return groups;
  }

  return {
    DEFAULT_RULES, parseList, normalizeRules, isDefault, rulesKey, isDeliverable, guessProject, trimProse,
    fromReplies, fromReceipts, normalizeIndex, mergeIndex, dayLabel, byDay,
  };
});
