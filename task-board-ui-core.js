// Pure helpers behind the 任务看板 view: which column a card sits in, project
// filter, the two sort orders, dependency/parallel marks and the archive call.
// Cards come from TaskBoard.list (docs/task-board-api.md). No DOM: runs in the
// page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskBoardUICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The data layer's five statuses, plus 失败 for cards flagged failed (a failed
  // card stays doing/review in the file; the board pulls it out so it is seen).
  const COLUMNS = [
    { key: 'todo', label: '待办' },
    { key: 'doing', label: '进行中' },
    { key: 'review', label: '待验收' },
    { key: 'needs_user', label: '等用户' },
    { key: 'done', label: '已完成' },
    { key: 'failed', label: '失败' },
  ];
  const SORTS = ['updated', 'order'];
  const ALL = '';

  const time = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

  function columnOf(card) {
    if (card.flag === 'failed') return 'failed';
    return COLUMNS.some((c) => c.key === card.status) ? card.status : 'todo';
  }

  // Projects that have at least one visible card, in name order.
  function projects(cards) {
    return [...new Set(cards.filter((c) => !c.archived).map((c) => c.project))].sort((a, b) => a.localeCompare(b));
  }

  function filterProject(cards, project) {
    return project ? cards.filter((c) => c.project === project) : cards.slice();
  }

  // 'order' is the data layer's task order (project/order/id); 'updated' is
  // newest first, ties falling back to task order.
  function byOrder(a, b) {
    return a.project.localeCompare(b.project) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id));
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
  // project, split into the columns above, each sorted, each card decorated.
  function buildBoard(allCards, opts = {}) {
    const sort = SORTS.includes(opts.sort) ? opts.sort : 'updated';
    const index = new Map(allCards.map((c) => [c.id, c]));
    const live = allCards.filter((c) => !c.archived);
    const shown = sortCards(filterProject(live, opts.project || ALL), sort);
    const columns = COLUMNS.map((c) => ({ ...c, cards: [] }));
    const byKey = new Map(columns.map((c) => [c.key, c]));
    shown.forEach((card) => {
      const waits = waitsOn(card, index);
      byKey.get(columnOf(card)).cards.push({ card, waits, waitLabel: waitLabel(waits), parallel: canRunParallel(card, waits) });
    });
    return { columns, projects: projects(allCards), total: shown.length };
  }

  // 「已完成」一键归档: the data layer's archiveDone, scoped to the filtered
  // project (all projects when the filter is 全部). Never writes files itself.
  function archiveDone(api, project) {
    return project ? api.archiveDone(project) : api.archiveDone();
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
  // has it, else the assignee agent, else 未派活.
  function ownerLabel(card, sessionLabel) {
    if (card.session_id) return (sessionLabel && sessionLabel(card.session_id)) || '会话 ' + card.session_id;
    if (card.assignee && card.assignee.agent) return card.assignee.agent + (card.assignee.model && card.assignee.model !== 'default' ? ' · ' + card.assignee.model : '');
    return '未派活';
  }

  return { COLUMNS, SORTS, ALL, columnOf, projects, filterProject, sortCards, waitsOn, canRunParallel, waitLabel, buildBoard, archiveDone, formatUpdated, ownerLabel };
});
