// Pure helpers behind the 任务看板 view: project groups (one per project,
// case-insensitive, in the user's order) crossed with the five status columns,
// the project overview, the finished-projects area, the 需要你 reminder, a
// card's activity line, drag/drop targets and dependency/parallel marks. Cards come
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

  // Cards always show in the data layer's task order (project/order/id): that
  // is the order the user arranges by dragging, so it must not jump around.
  function byOrder(a, b) {
    return projectKey(a.project).localeCompare(projectKey(b.project)) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id));
  }
  function sortCards(cards) { return cards.slice().sort(byOrder); }

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

  // What the user is being asked, as one sentence, or '' when a card sits in
  // 需要你 without a real question (a session that ended without a receipt, a
  // dispatcher that gave up, a card moved there by hand with only an old
  // result on it). The board then says so instead of showing internal wording.
  const NOT_A_QUESTION = [/^已结束，未提交回执/, /^调度已结束/];
  function userQuestion(card) {
    if (!card || card.status !== 'needs_user') return '';
    if (typeof card.user_question === 'string' && card.user_question.trim()) return card.user_question.trim();
    const text = String(card.latest_receipt || '').trim();
    if (!text || NOT_A_QUESTION.some((re) => re.test(text))) return '';
    if (/:(?:complete|failed|fallback):/.test(card.last_event || '')) return '';
    return text;
  }
  // The latest receipt in the user's words; internal wording is translated.
  function receiptText(card) {
    const text = String((card && card.latest_receipt) || '').trim();
    if (/^已结束，未提交回执/.test(text)) return '队员停下了，但没有交结果。';
    if (/^调度已结束/.test(text)) return '这件事还没有派给队员。';
    return text;
  }

  // Absolute / home-relative file paths mentioned in a text, in first-seen order.
  function filePaths(...texts) {
    const found = [];
    const re = /(?<![\w:/.\\-])(?:~|[A-Za-z]:)?[\\/](?:[^\s"'`<>|，。；、！？（）()\[\]{}:]+[\\/])+[^\s"'`<>|，。；、！？（）()\[\]{}:]*[^\s"'`<>|，。；、！？（）()\[\]{}:.,;]/g;
    texts.forEach((text) => {
      (Array.isArray(text) ? text : String(text || '').match(re) || []).forEach((p) => { if (typeof p === 'string' && p && !found.includes(p)) found.push(p); });
    });
    return found.slice(0, 20);
  }

  // Lanes in the user's own order (dragged), unknown projects after them by name.
  function orderLanes(lanes, laneOrder) {
    const rank = new Map((Array.isArray(laneOrder) ? laneOrder : []).map((k, i) => [projectKey(k), i]));
    return lanes.slice().sort((a, b) => (rank.has(a.key) ? rank.get(a.key) : Infinity) - (rank.has(b.key) ? rank.get(b.key) : Infinity) || a.name.localeCompare(b.name));
  }
  // The lane order after dropping `key` before `beforeKey` (null = last).
  function moveLane(keys, key, beforeKey) {
    const rest = keys.filter((k) => k !== key);
    const at = beforeKey == null ? -1 : rest.indexOf(beforeKey);
    rest.splice(at < 0 ? rest.length : at, 0, key);
    return rest;
  }
  // Where a card dropped at `index` among a cell's cards goes, as the anchor
  // TaskBoard.reorder takes. null: the cell holds no other card, or the card
  // is already there, so there is nothing to reorder.
  function dropAnchor(ids, id, index) {
    const rest = ids.filter((x) => x !== id);
    const at = Math.max(0, Math.min(rest.length, index));
    if (!rest.length || ids.indexOf(id) === at && ids.length === rest.length + 1) return null;
    return at < rest.length ? { before: rest[at] } : { after: rest[rest.length - 1] };
  }
  function stepStatus(status, dir) {
    const i = COLUMNS.findIndex((c) => c.key === status) + dir;
    return i >= 0 && i < COLUMNS.length ? COLUMNS[i].key : null;
  }
  function labelOf(status) { const c = COLUMNS.find((x) => x.key === status); return c ? c.label : ''; }

  // The whole board for one render: every project as one lane (the user's lane
  // order), each lane split into the five columns in task order, each card
  // decorated. `projects` is the overview strip (always every project, with
  // per-status counts); `lanes` are the ones shown for the chosen project,
  // split into `active` and `finished`; `alerts` are the 需要你 cards.
  function buildBoard(allCards, opts = {}) {
    const index = new Map(allCards.map((c) => [c.id, c]));
    const live = allCards.filter((c) => !c.archived);
    const names = projects(allCards);
    const requestedProject = projectKey(opts.project);
    const project = names.some((p) => p.key === requestedProject) ? requestedProject : ALL;
    const lanes = new Map(names.map((p) => [p.key, { key: p.key, name: p.name, total: 0, open: 0, counts: Object.fromEntries(COLUMNS.map((c) => [c.key, 0])), columns: COLUMNS.map((c) => ({ ...c, cards: [] })) }]));
    sortCards(live).forEach((card) => {
      const lane = lanes.get(projectKey(card.project));
      const waits = waitsOn(card, index);
      const status = columnOf(card);
      lane.columns.find((c) => c.key === status).cards.push({ card, waits, waitLabel: waitLabel(waits), parallel: canRunParallel(card, waits), question: userQuestion(card) });
      lane.counts[status]++; lane.total++;
      if (status !== 'done') lane.open++;
    });
    const all = orderLanes([...lanes.values()], opts.laneOrder);
    const laneList = project ? all.filter((l) => l.key === project) : all;
    const columns = COLUMNS.map((c) => ({ ...c, count: laneList.reduce((n, l) => n + l.counts[c.key], 0) }));
    const total = laneList.reduce((n, l) => n + l.total, 0);
    // A project with nothing left to do goes to the folded 已完成的 Agent group
    // (unless the user picked it by name).
    const finished = project ? [] : laneList.filter((l) => l.total > 0 && l.open === 0);
    const active = laneList.filter((l) => !finished.includes(l));
    const alerts = laneList.flatMap((l) => l.columns.find((c) => c.key === 'needs_user').cards.map((item) => ({ card: item.card, question: item.question, lane: l.key, name: l.name })));
    return { columns, lanes: laneList, active, finished, finishedDone: finished.reduce((n, l) => n + l.counts.done, 0), alerts, projects: all.map((l) => ({ key: l.key, name: l.name, total: l.total, open: l.open, counts: l.counts })), project, total, open: total - columns.find((c) => c.key === 'done').count };
  }

  // The one line of recent news a card shows under its title: why it failed,
  // that it is held, what it waits on, the latest receipt, else (for a 进行中
  // card) whether anyone is really on it, else the first line of its brief.
  function activity(card, waitText, runLabel) {
    const firstLine = (t) => String(t || '').trim().split(/\r?\n/)[0].trim();
    if (card.flag === 'failed' || card.flag === 'quota') return { text: firstLine(receiptText(card)) || (card.flag === 'quota' ? '额度、登录或限流问题' : '执行失败，没有写明原因'), tone: 'failed' };
    if (card.flag === 'held') return { text: '已挂起，等队长放行', tone: 'wait' };
    // An automatic review that could not be started says why and that 队长 has it.
    if (card.status === 'review' && card.review_block && card.review_block.round === card.review_round && card.review_block.reason) return { text: '待验收，需队长处理：' + firstLine(card.review_block.reason), tone: 'wait' };
    if (waitText) return { text: waitText, tone: 'wait' };
    const receipt = firstLine(receiptText(card));
    if (receipt) return { text: receipt, tone: '' };
    if (runLabel) return { text: runLabel, tone: 'quiet' };
    return { text: firstLine(card.detail), tone: 'quiet' };
  }
  // The fold button's wording: how many cards are still hidden.
  function moreLabel(hidden) { return `展开剩余 ${hidden} 项`; }

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

  return { COLUMNS, ALL, projectKey, columnOf, projects, filterProject, sortCards, waitsOn, canRunParallel, waitLabel, buildBoard, userQuestion, receiptText, filePaths, activity, moreLabel, orderLanes, moveLane, dropAnchor, stepStatus, labelOf, formatUpdated, ownerLabel, modelLabel };
});
