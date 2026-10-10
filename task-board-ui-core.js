// Pure helpers behind the 任务看板 view: project groups (one per project,
// case-insensitive, in the user's order) crossed with the five status columns,
// the project overview, the finished-projects area, the 需要你 reminder, the
// 高优先级 mark and its place at the top of a column, a card's activity line, drag/drop targets, dependency/parallel marks, the
// dependency lines and their routes, and the progress meter. Cards come
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

  // 高优先级 is the card's `important` flag: the user named it as urgent. One
  // level above ordinary; a card without the field is ordinary. An unfinished
  // one is `urgent`: it leads its column (in task order among its own kind) and
  // carries the full mark. A finished one keeps a quiet mark and its place.
  function isHigh(card) { return !!card && card.important === true; }
  function isUrgent(card) { return isHigh(card) && card.status !== 'done' && !card.archived; }
  // 下一个做 (排到最前): the one 待办 card 队长 sends out next. It leads its column,
  // ahead of the other 高优先级 cards.
  function isNextUp(card) { return !!card && !!card.next_up && card.status === 'todo' && !card.archived; }
  function urgentFirst(items, cardOf = (x) => x) {
    const rank = (x) => (isNextUp(cardOf(x)) ? 0 : isUrgent(cardOf(x)) ? 1 : 2);
    return [0, 1, 2].flatMap((r) => items.filter((x) => rank(x) === r));
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

  // The latest receipt in the user's words (internal wording translated) and a flag's tag are
  // the phone hub's rules (mobile-web/hub/core.js): one set of words for both boards. Looked
  // up when called, so the load order of the two files does not matter.
  const hub = () => (typeof module === 'object' && module.exports ? require('./mobile-web/hub/core.js') : globalThis.HubCore);
  const receiptText = (card) => hub().cardReceipt(card);
  // What a 需要你 card asks the user, whole, or '' (the board then says so).
  const userQuestion = (card) => hub().cardQuestion(card);
  const flagText = (card) => hub().cardFlag(card);
  // 马上派人做: '已交给队长 · 等派人' while the request waits for a worker, else ''.
  const dispatchNote = (card) => hub().dispatchNote(card);

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
    const lanes = new Map(names.map((p) => [p.key, { key: p.key, name: p.name, total: 0, open: 0, urgent: 0, counts: Object.fromEntries(COLUMNS.map((c) => [c.key, 0])), columns: COLUMNS.map((c) => ({ ...c, cards: [] })) }]));
    sortCards(live).forEach((card) => {
      const lane = lanes.get(projectKey(card.project));
      const waits = waitsOn(card, index);
      const status = columnOf(card);
      lane.columns.find((c) => c.key === status).cards.push({ card, waits, waitLabel: waitLabel(waits), parallel: canRunParallel(card, waits), question: userQuestion(card), high: isHigh(card), urgent: isUrgent(card), next: isNextUp(card) });
      lane.counts[status]++; lane.total++;
      if (status !== 'done') lane.open++;
      if (isUrgent(card)) lane.urgent++;
    });
    lanes.forEach((lane) => lane.columns.forEach((col) => { col.cards = urgentFirst(col.cards, (item) => item.card); }));
    const all = orderLanes([...lanes.values()], opts.laneOrder);
    const laneList = project ? all.filter((l) => l.key === project) : all;
    const columns = COLUMNS.map((c) => ({ ...c, count: laneList.reduce((n, l) => n + l.counts[c.key], 0) }));
    const total = laneList.reduce((n, l) => n + l.total, 0);
    // A project with nothing left to do goes to the folded 已完成的 Agent group
    // (unless the user picked it by name).
    const finished = project ? [] : laneList.filter((l) => l.total > 0 && l.open === 0);
    const active = laneList.filter((l) => !finished.includes(l));
    const alerts = laneList.flatMap((l) => l.columns.find((c) => c.key === 'needs_user').cards.map((item) => ({ card: item.card, question: item.question, lane: l.key, name: l.name })));
    return { columns, lanes: laneList, active, finished, finishedDone: finished.reduce((n, l) => n + l.counts.done, 0), alerts, links: dependencyLinks(laneList, index), projects: all.map((l) => ({ key: l.key, name: l.name, total: l.total, open: l.open, urgent: l.urgent, counts: l.counts })), project, total, open: total - columns.find((c) => c.key === 'done').count };
  }

  // The lines the board draws between cards: one per shown card and each
  // unfinished prerequisite that is still a live card (an archived or unknown
  // one has nowhere to be drawn from). `tone` says how the prerequisite is
  // doing: 'stuck' (failed, out of quota, or waiting on the user), 'flow'
  // (being worked on or reviewed), else 'idle' (not started, or held).
  function dependencyLinks(lanes, index) {
    const links = [];
    lanes.forEach((lane) => lane.columns.forEach((col) => col.cards.forEach((item) => item.waits.forEach((w) => {
      const dep = index.get(w.id);
      if (!dep || dep.archived) return;
      const status = columnOf(dep);
      const tone = dep.flag === 'failed' || dep.flag === 'quota' || status === 'needs_user' ? 'stuck'
        : dep.flag !== 'held' && (status === 'doing' || status === 'review') ? 'flow' : 'idle';
      links.push({ from: dep.id, to: item.card.id, lane: projectKey(dep.project), status, tone });
    }))));
    return links;
  }

  // The way a dependency line runs from the prerequisite (rect `a`) to the card
  // waiting on it (rect `b`), both {x, y, w, h} in one coordinate space: out of
  // a's side, along the gap beside a's column, into b's side. Cards in one
  // column are joined by a bracket in the gap on their left. `slot` fans out
  // lines sharing a gap so they read as a bundle, not as one line.
  function linkRoute(a, b, gap = 10, slot = 0) {
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    const fan = Math.min(2, Math.max(0, slot)) * 1.5;
    const sameColumn = a.x < b.x + b.w && b.x < a.x + a.w;
    let points;
    if (sameColumn) {
      const cx = Math.min(a.x, b.x) - gap / 2 - fan;
      points = [[a.x, ay], [cx, ay], [cx, by], [b.x, by]];
    } else if (a.x > b.x) {
      const cx = a.x - gap / 2 - fan;
      points = [[a.x, ay], [cx, ay], [cx, by], [b.x + b.w, by]];
    } else {
      const cx = a.x + a.w + gap / 2 + fan;
      points = [[a.x + a.w, ay], [cx, ay], [cx, by], [b.x, by]];
    }
    if (Math.abs(ay - by) < 1) points = [points[0], points[3]];
    const round = (n) => Math.round(n * 10) / 10;
    points = points.map(([x, y]) => [round(x), round(y)]);
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.abs(points[i][0] - points[i - 1][0]) + Math.abs(points[i][1] - points[i - 1][1]);
    return { points, length: round(length), d: roundedPath(points, 7) };
  }
  // An SVG path through right-angled points with every corner rounded (the
  // radius shrinks to fit a short segment).
  function roundedPath(points, radius) {
    const n = (v) => String(Math.round(v * 10) / 10);
    let d = `M${n(points[0][0])} ${n(points[0][1])}`;
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      if (i === points.length - 1) { d += ` L${n(x)} ${n(y)}`; break; }
      const [px, py] = points[i - 1], [nx, ny] = points[i + 1];
      const before = Math.hypot(x - px, y - py), after = Math.hypot(nx - x, ny - y);
      const r = Math.min(radius, before / 2, after / 2);
      if (r < 0.5) { d += ` L${n(x)} ${n(y)}`; continue; }
      d += ` L${n(x - (x - px) / before * r)} ${n(y - (y - py) / before * r)} Q${n(x)} ${n(y)} ${n(x + (nx - x) / after * r)} ${n(y + (ny - y) / after * r)}`;
    }
    return d;
  }

  // How far the shown cards are: the share that is done, and one segment per
  // status for the spectrum bar (finished work first, then what is moving).
  const METER_ORDER = ['done', 'review', 'doing', 'needs_user', 'todo'];
  function progress(columns) {
    const count = (key) => { const c = columns.find((x) => x.key === key); return c ? c.count : 0; };
    const total = columns.reduce((n, c) => n + c.count, 0);
    const done = count('done');
    return { total, done, percent: total ? Math.floor(done / total * 100) : 0, segments: METER_ORDER.map((key) => ({ key, label: labelOf(key), count: count(key) })).filter((s) => s.count > 0) };
  }

  // The one line of recent news a card shows under its title: why it failed,
  // that it is held, what it waits on, the latest receipt, else (for a 进行中
  // card) whether anyone is really on it, else the first line of its brief.
  function activity(card, waitText, runLabel) {
    const firstLine = (t) => String(t || '').trim().split(/\r?\n/)[0].trim();
    // the user's 马上派人做 is the newest thing on the card until a worker takes it
    const asked = dispatchNote(card);
    if (asked) return { text: asked, tone: 'wait' };
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

  return { COLUMNS, ALL, projectKey, columnOf, projects, filterProject, sortCards, isHigh, isUrgent, isNextUp, urgentFirst, waitsOn, canRunParallel, waitLabel, buildBoard, dependencyLinks, linkRoute, roundedPath, progress, userQuestion, receiptText, flagText, dispatchNote, filePaths, activity, moreLabel, orderLanes, moveLane, dropAnchor, stepStatus, labelOf, formatUpdated, ownerLabel, modelLabel };
});
