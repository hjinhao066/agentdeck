// Pure helpers behind the 任务看板 view: project swimlanes (one per project,
// case-insensitive) crossed with the five status columns, project filter, the
// two sort orders, dependency/parallel marks and the archive call. Cards come
// from TaskBoard.list (docs/task-board-api.md). No DOM: runs in the page and
// in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskBoardUICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The data layer's five statuses. A failed card stays in its own status
  // column (the file keeps doing/review); the card itself is marked 失败.
  const COLUMNS = [
    { key: 'todo', label: '待办' },
    { key: 'doing', label: '进行中' },
    { key: 'review', label: '待验收' },
    { key: 'needs_user', label: '需要你' },
    { key: 'done', label: '完成' },
  ];
  const SORTS = ['updated', 'order'];
  const ALL = '';

  const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

  // 「AgentDeck」和「agentdeck」是同一个项目: one lane, one colour.
  function projectKey(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
  }

  function columnOf(card) {
    return COLUMNS.some((c) => c.key === card.status) ? card.status : 'todo';
  }

  // Projects that have at least one visible card, in name order. The shown
  // name is the spelling most cards use (ties: the first in name order).
  function projects(cards) {
    const seen = new Map();
    cards.filter((c) => !c.archived).forEach((c) => {
      const key = projectKey(c.project);
      if (!seen.has(key)) seen.set(key, new Map());
      const names = seen.get(key);
      names.set(c.project, (names.get(c.project) || 0) + 1);
    });
    return [...seen].map(([key, names]) => {
      const name = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      return { key, name: name || '其他' };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function filterProject(cards, project) {
    const key = projectKey(project);
    return key ? cards.filter((c) => projectKey(c.project) === key) : cards.slice();
  }

  // 'order' is the data layer's task order (project/order/id); 'updated' is
  // newest first, ties falling back to task order.
  function byOrder(a, b) {
    return projectKey(a.project).localeCompare(projectKey(b.project)) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id));
  }
  function sortCards(cards, sort) {
    const list = cards.slice();
    if (sort === 'updated') return list.sort((a, b) => time(b.updated) - time(a.updated) || byOrder(a, b));
    return list.sort(byOrder);
  }

  // Unfinished prerequisites, resolved against every card we can see (archived
  // ones included, since dependencies may point at archived done cards). A
  // missing prerequisite shows its id so the wait is never silently dropped.
  function waitsOn(card, index) {
    return (card.depends_on || []).map((id) => {
      const dep = index.get(id);
      if (dep && dep.status === 'done') return null;
      return { id, title: dep ? dep.title : id };
    }).filter(Boolean);
  }
  // 可并行: a todo card free to start alongside others (nothing it waits on,
  // not held).
  function canRunParallel(card, waits) {
    return card.status === 'todo' && card.flag !== 'failed' && card.flag !== 'held' && !waits.length;
  }

  function waitLabel(waits) {
    if (!waits.length) return '';
    const names = waits.map((w) => `「${w.title}」`);
    return '等' + (names.length > 2 ? names.slice(0, 2).join('、') + ` 等 ${names.length} 项` : names.join('、')) + '完成';
  }

  // The whole board for one render: visible (non-archived) cards of the chosen
  // project as one lane per project, each lane split into the five columns,
  // each cell sorted, each card decorated. `columns` carries the totals.
  function buildBoard(allCards, opts = {}) {
    const sort = SORTS.includes(opts.sort) ? opts.sort : 'updated';
    const index = new Map(allCards.map((c) => [c.id, c]));
    const live = allCards.filter((c) => !c.archived);
    const shown = sortCards(filterProject(live, opts.project || ALL), sort);
    const all = projects(allCards);
    const names = new Map(all.map((p) => [p.key, p.name]));
    const lanes = new Map();
    shown.forEach((card) => {
      const key = projectKey(card.project);
      if (!lanes.has(key)) lanes.set(key, { key, name: names.get(key) || card.project || '其他', total: 0, columns: COLUMNS.map((c) => ({ ...c, cards: [] })) });
      const lane = lanes.get(key);
      const waits = waitsOn(card, index);
      lane.columns.find((c) => c.key === columnOf(card)).cards.push({ card, waits, waitLabel: waitLabel(waits), parallel: canRunParallel(card, waits) });
      lane.total++;
    });
    const laneList = [...lanes.values()].sort((a, b) => a.name.localeCompare(b.name));
    const columns = COLUMNS.map((c) => ({ ...c, count: laneList.reduce((n, l) => n + l.columns.find((x) => x.key === c.key).cards.length, 0) }));
    return { columns, lanes: laneList, projects: all, total: shown.length };
  }

  // 「完成」一键归档: the data layer's archiveDone for every spelling of the
  // filtered project (all projects when the filter is 全部). Never writes files
  // itself.
  function archiveDone(api, project, cards = []) {
    const key = projectKey(project);
    if (!key) return api.archiveDone();
    const spellings = [...new Set(cards.filter((c) => !c.archived && projectKey(c.project) === key).map((c) => c.project))];
    if (!spellings.length) spellings.push(project);
    return Promise.all(spellings.map((p) => api.archiveDone(p))).then((results) => ({
      cards: results.flatMap((r) => (r && Array.isArray(r.cards) ? r.cards : [])),
      notices: results.flatMap((r) => (r && Array.isArray(r.notices) ? r.notices : [])),
    }));
  }

  function formatUpdated(iso, now = Date.now()) {
    const t = time(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 7 * 86400) return Math.floor(s / 86400) + ' 天前';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Who works the card: the bound session's column label when the page still
  // has it, else the assignee agent, else 会话已关闭 / 未派活.
  function ownerLabel(card, sessionLabel) {
    const label = card.session_id && sessionLabel && sessionLabel(card.session_id);
    if (label) return label;
    if (card.assignee && card.assignee.agent) return card.assignee.agent;
    return card.session_id ? '会话已关闭' : '未派活';
  }
  // The model the card records ('' when unknown or still 'default').
  function modelLabel(card) {
    const m = card.assignee && card.assignee.model;
    return m && m !== 'default' ? String(m) : '';
  }

  return { COLUMNS, SORTS, ALL, projectKey, columnOf, projects, filterProject, sortCards, waitsOn, canRunParallel, waitLabel, buildBoard, archiveDone, formatUpdated, ownerLabel, modelLabel };
});
