// Pure helpers behind the 版本进度 drawer: which version is being worked
// toward, which task cards belong to it, and how to group them.
// The version is the smallest one mentioned on an active AgentDeck card that
// is newer than the running app; with nothing newer it is the app's own version.
//
// A card belongs to that version (纳入规则) when:
//   1. 点名  an AgentDeck card names it: the optional `version` field, or the
//            title or detail mentions it ("1.1.4 发版", "…再进 1.1.4");
//   2. 在做  an unfinished AgentDeck card is in progress (进行中 / 待验收 /
//            等你) and names no later version: work under way now ships next;
//   3. 已纳入 the drawer showed it for this version before (`remembered`), so a
//            在做 card that finishes stays ticked instead of dropping out;
//   4. 前置  any card a member depends on (`depends_on`, followed through
//            chains, any project): the release waits for it.
// Archived cards count only when done. Rules 2 and 3 skip cards that name a
// later version, and rule 2 only applies while the target is newer than the app.
// No DOM, no Electron: runs in the page and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VersionProgressCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROJECT = 'agentdeck';
  // 1.1.3 but not 1.1.30, 1.1.3.4 or 21.1.3; a trailing sentence period is fine.
  const VERSION_RE = /(?<![\d.])v?(\d+\.\d+\.\d+)(?!\.?\d)/gi;
  const STATUS_LABEL = { todo: '待办', doing: '进行中', review: '待验收', needs_user: '等你', done: '完成' };
  const ACTIVE = new Set(['doing', 'review', 'needs_user']);
  const REASON_LABEL = { named: '点名', active: '在做', kept: '已纳入', dependency: '前置' };
  // Drawer sections, top to bottom: what needs a hand first, finished work last.
  const GROUPS = [
    { key: 'attention', label: '需要处理' },
    { key: 'doing', label: '进行中' },
    { key: 'review', label: '待验收' },
    { key: 'todo', label: '待办' },
    { key: 'done', label: '已完成' },
  ];

  function parse(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
  }
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  function versionsIn(text) {
    return [...String(text || '').matchAll(VERSION_RE)].map((m) => m[1]);
  }
  function versionsOf(card) {
    const own = parse(card.version) ? [parse(card.version).join('.')] : [];
    return [...new Set([...own, ...versionsIn(card.title), ...versionsIn(card.detail)])];
  }
  const ownCards = (cards) => (cards || []).filter((c) => String(c.project || '').toLowerCase() === PROJECT);

  function targetVersion(cards, appVersion) {
    const active = ownCards(cards).filter((c) => !c.archived);
    const all = [...new Set(active.flatMap(versionsOf))].sort(compare);
    if (parse(appVersion)) return all.find((v) => compare(v, appVersion) > 0) || parse(appVersion).join('.');
    // No app version: the oldest version that still has unfinished work.
    return all.find((v) => active.some((c) => c.status !== 'done' && versionsOf(c).includes(v))) || all[all.length - 1] || null;
  }

  function groupOf(card) {
    if (card.status === 'done') return 'done';
    if (card.flag === 'failed' || card.status === 'needs_user') return 'attention';
    return GROUPS.some((g) => g.key === card.status) ? card.status : 'todo';
  }
  function statusLabel(card) {
    if (card.status !== 'done' && card.flag === 'failed') return '失败';
    if (card.status !== 'done' && card.flag === 'held') return '挂起';
    return STATUS_LABEL[card.status] || card.status;
  }
  const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

  // { version, items, groups, done, total, percent, counts }. `remembered` is
  // the ids the drawer listed for this same version earlier.
  function progress(cards, appVersion, { remembered = [] } = {}) {
    const version = targetVersion(cards, appVersion);
    const empty = { version, items: [], groups: [], done: 0, total: 0, percent: 0, counts: {} };
    if (!version) return empty;
    const all = cards || [];
    const index = new Map(all.map((c) => [c.id, c]));
    const counted = (c) => !c.archived || c.status === 'done';
    const later = (c) => versionsOf(c).some((v) => compare(v, version) > 0);
    const reason = new Map();
    const own = ownCards(all).filter(counted);
    own.filter((c) => versionsOf(c).includes(version)).forEach((c) => reason.set(c.id, 'named'));
    if (!parse(appVersion) || compare(version, appVersion) > 0) {
      own.filter((c) => !c.archived && ACTIVE.has(c.status) && !later(c) && !reason.has(c.id)).forEach((c) => reason.set(c.id, 'active'));
    }
    (remembered || []).forEach((id) => {
      const c = index.get(id);
      if (c && counted(c) && !later(c) && !reason.has(id)) reason.set(id, 'kept');
    });
    const queue = [...reason.keys()];
    while (queue.length) {
      (index.get(queue.shift()).depends_on || []).forEach((id) => {
        const dep = index.get(id);
        if (!dep || reason.has(id) || !counted(dep)) return;
        reason.set(id, 'dependency');
        queue.push(id);
      });
    }
    // A member another member waits on reads as 前置 even when it is also in progress.
    [...reason.keys()].forEach((id) => (index.get(id).depends_on || []).forEach((dep) => {
      if (reason.has(dep) && reason.get(dep) !== 'named') reason.set(dep, 'dependency');
    }));
    const items = [...reason].map(([id, why]) => {
      const c = index.get(id);
      const waits = (c.depends_on || []).map((d) => index.get(d)).filter((d) => d && d.status !== 'done').map((d) => d.title);
      return {
        id, title: c.title, project: c.project, status: c.status, flag: c.flag || null, done: c.status === 'done',
        group: groupOf(c), label: statusLabel(c), reason: why, reasonLabel: REASON_LABEL[why],
        agent: (c.assignee && c.assignee.agent) || '', model: (c.assignee && c.assignee.model) || '',
        receipt: String(c.latest_receipt || '').replace(/\s+/g, ' ').trim(),
        created: c.created || '', updated: c.updated || '', waits,
      };
    });
    // Most recent activity first inside each section.
    items.sort((a, b) => time(b.updated) - time(a.updated) || String(a.id).localeCompare(String(b.id)));
    const groups = GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) })).filter((g) => g.items.length);
    const counts = Object.fromEntries(groups.map((g) => [g.key, g.items.length]));
    const done = counts.done || 0;
    return { version, items: groups.flatMap((g) => g.items), groups, done, total: items.length,
      percent: items.length ? Math.round(done * 100 / items.length) : 0, counts };
  }

  // 耗时 counted from when the card was created: until its last update once
  // done, until now while open. Todo cards have not started, so ''.
  function elapsed(item, now = Date.now()) {
    if (item.status === 'todo') return '';
    const from = time(item.created), to = item.done ? time(item.updated) : now;
    if (!from || !to || to < from) return '';
    const min = Math.floor((to - from) / 60000);
    if (min < 1) return '<1 分';
    if (min < 60) return min + ' 分';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 时' + (min % 60 ? ' ' + (min % 60) + ' 分' : '');
    return Math.floor(h / 24) + ' 天' + (h % 24 ? ' ' + (h % 24) + ' 时' : '');
  }

  return { PROJECT, GROUPS, REASON_LABEL, parse, compare, versionsIn, versionsOf, targetVersion, groupOf, progress, elapsed };
});
