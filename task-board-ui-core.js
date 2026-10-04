// Pure helpers behind the 任务看板 view: project columns, status labels,
// project filter, the two sort orders and dependency/parallel marks.
// Cards come from TaskBoard.list (docs/task-board-api.md). No DOM: runs in the
// page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskBoardUICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The data layer's five statuses, plus 失败 for cards flagged failed (a failed
  // card stays doing/review in the file; its label makes the failure visible).
  const STATUSES = [
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

  function statusOf(card) {
    if (card.flag === 'failed') return 'failed';
    return STATUSES.some((c) => c.key === card.status) ? card.status : 'todo';
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
  // project, split into project columns, each sorted, each card decorated.
  function buildBoard(allCards, opts = {}) {
    const sort = SORTS.includes(opts.sort) ? opts.sort : 'updated';
    const index = new Map(allCards.map((c) => [c.id, c]));
    const live = allCards.filter((c) => !c.archived);
    const projectNames = projects(live);
    const project = projectNames.includes(opts.project) ? opts.project : ALL;
    const shown = sortCards(filterProject(live, project), sort);
    const columns = projectNames.filter((p) => !project || p === project).map((p) => ({ key: p, label: p, cards: [] }));
    const byKey = new Map(columns.map((c) => [c.key, c]));
    shown.forEach((card) => {
      const waits = waitsOn(card, index);
      const status = statusOf(card);
      const statusLabel = STATUSES.find((s) => s.key === status).label;
      byKey.get(card.project).cards.push({ card, status, statusLabel, waits, waitLabel: waitLabel(waits), parallel: canRunParallel(card, waits) });
    });
    return { columns, projects: projectNames, project, total: shown.length };
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

  return { STATUSES, SORTS, ALL, statusOf, projects, filterProject, sortCards, waitsOn, canRunParallel, waitLabel, buildBoard, formatUpdated, ownerLabel };
});
