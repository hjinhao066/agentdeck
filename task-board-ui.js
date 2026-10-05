// 任务看板 view: every shared task card from window.TaskBoard, one foldable
// group per project (case-insensitive, in the user's own order) over one shared
// grid of the five status columns. Built to be read at a glance: a full-width
// bar per group with its counts, cards led by their title, the 完成 column
// folded to a count, long cells folded to 展开剩余 N 项, finished projects
// gathered in one folded area, a 需要你 reminder bar and a project overview
// strip on top. Cards drag (or Alt+arrows)
// inside a column to reorder and across columns to change status; a card
// dragged into 进行中 follows the configured dispatcher, the same path as an explicit start. A
// card opens a detail drawer; a 需要你 card shows its question there with an
// answer box whose text goes to 队长. It covers the deck and the board view like
// the Schedule/Artifacts pages; closing it leaves everything underneath as it
// was. Project colours come from the crew map's palette (CrewMapCore.projectHue).
(function () {
  'use strict';
  const U = window.TaskBoardUICore;
  const CELL_LIMIT = 3;       // cards a cell shows before folding the rest
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    chevron: svg('<path d="m6 9 6 6 6-6"/>'),
    alert: svg('<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    check: svg('<path d="m5 12 5 5 9-10"/>'),
  };
  let host = null;
  let alertEl, viewEl, projectsEl, gridEl, headsEl, lanesEl, scrollEl, statusEl, summaryEl, emptyEl, refreshBtn, detailEl, liveEl;
  let open = false;
  let cards = [];
  let board = null;
  let filter = { project: U.ALL };
  let prefs = { laneOrder: [], collapsed: {}, doneOpen: false, completedOpen: false };
  const expanded = new Set(); // "lane/status" cells showing every card
  let detailId = null;
  let detailKey = '';
  const drafts = new Map();   // unsent answers by card id
  let drag = null;            // the drag in progress (card or lane)
  let renderQueued = false;
  let suppressClick = false;
  let focusAfter = null;      // selector to focus after the next render
  let unsubscribe = null;
  let seq = 0;                // only the newest list() result is drawn

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Tool actions are icon buttons: tooltip, accessible name, 32px target.
  const iconButton = (cls, icon, label) => {
    const b = el('button', 'tbv-icon ' + cls);
    b.type = 'button'; b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label);
    return b;
  };
  const api = () => window.TaskBoard;
  const hue = (project) => String(window.CrewMapCore.projectHue(project));
  const escapeId = (id) => (window.CSS && CSS.escape ? CSS.escape(id) : id);
  const cardNode = (id) => lanesEl.querySelector(`.tbv-card[data-card-id="${escapeId(id)}"]`);

  function setStatus(text) { statusEl.textContent = text || ''; statusEl.hidden = !text; }
  function announce(text) { liveEl.textContent = ''; liveEl.textContent = text; }
  function savePrefs() { host.savePrefs({ laneOrder: prefs.laneOrder.slice(), collapsed: { ...prefs.collapsed }, doneOpen: !!prefs.doneOpen, completedOpen: !!prefs.completedOpen }); }
  function friendly(error) {
    const m = String((error && error.message) || error || '');
    if (/Predecessor cards/.test(m)) return '它前面的任务还没做完';
    if (/changed since it was read/.test(m)) return '卡片刚刚被更新了，请再试一次';
    if (/archived, held or done/.test(m)) return '这张卡已挂起或已完成，要先由队长放行';
    if (/already being executed|already has an active/.test(m)) return '这张卡已经有队员在做';
    if (/being written by another/.test(m)) return '看板正在被写入，请稍后再试';
    return m;
  }

  async function refresh() {
    if (!open) return;
    const mine = ++seq;
    refreshBtn.classList.add('busy');
    if (!api()) { cards = []; setStatus('任务看板接口不可用'); refreshBtn.classList.remove('busy'); render(); return; }
    try {
      const list = await api().list({ archived: true }); // archived cards resolve dependency names
      if (mine !== seq || !open) return;
      cards = Array.isArray(list) ? list : [];
      setStatus('');
    } catch (err) {
      if (mine !== seq || !open) return;
      setStatus('读取任务失败：' + ((err && err.message) || err));
    } finally {
      if (mine === seq) refreshBtn.classList.remove('busy');
    }
    render();
  }

  // ---- overview strip ----
  function renderProjects() {
    projectsEl.innerHTML = '';
    const chip = (key, name, title) => {
      const b = el('button', 'tbv-chip');
      b.type = 'button'; b.dataset.project = key; b.title = title;
      const on = filter.project === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      if (key) { b.style.setProperty('--project-hue', hue(key)); b.append(el('span', 'tbv-dot')); }
      b.append(el('span', 'tbv-chip-name', name));
      b.onclick = () => { filter.project = on ? U.ALL : key; focusAfter = `.tbv-chip[data-project="${escapeId(filter.project)}"]`; render(); };
      return b;
    };
    projectsEl.append(chip(U.ALL, '全部', '看全部项目'));
    board.projects.forEach((p) => {
      const b = chip(p.key, p.name, `只看 ${p.name}：进行中 ${p.counts.doing}，需要你 ${p.counts.needs_user}，${p.open} 件待完成`);
      if (p.counts.doing) { const n = el('span', 'tbv-chip-n doing', String(p.counts.doing)); n.title = `进行中 ${p.counts.doing}`; b.append(n); }
      if (p.counts.needs_user) { const n = el('span', 'tbv-chip-n needs', String(p.counts.needs_user)); n.title = `需要你 ${p.counts.needs_user}`; b.append(n); }
      if (!p.open) b.classList.add('quiet');
      projectsEl.append(b);
    });
  }

  function renderHeads() {
    headsEl.innerHTML = '';
    board.columns.forEach((col) => {
      const done = col.key === 'done';
      const head = el(done ? 'button' : 'div', 'tbv-head');
      head.dataset.status = col.key;
      head.setAttribute('role', 'columnheader');
      head.append(el('span', 'tbv-head-dot'), el('span', 'tbv-head-label', col.label), el('span', 'tbv-count', String(col.count)));
      if (done) {
        head.type = 'button';
        const label = prefs.doneOpen ? '收起完成列，只显示数量' : '展开完成列';
        head.title = label; head.setAttribute('aria-label', `完成 ${col.count} 张，${label}`);
        head.setAttribute('aria-expanded', String(!!prefs.doneOpen));
        const chev = el('span', 'tbv-chev'); chev.innerHTML = ICON.chevron; head.append(chev);
        head.onclick = toggleDone;
      }
      if (col.key === 'needs_user' && col.count) head.classList.add('alert');
      headsEl.append(head);
    });
  }
  function toggleDone() { prefs.doneOpen = !prefs.doneOpen; savePrefs(); focusAfter = '.tbv-head[data-status="done"]'; render(); }

  // Every group shares one column grid; the folded 完成 column is only a count.
  function gridTemplate() {
    return board.columns.map((c) => c.key === 'done' && !prefs.doneOpen ? '92px' : 'minmax(140px, 1fr)').join(' ');
  }

  // ---- cards ----
  function dotState(c) {
    if (c.flag === 'quota') return ['failed', '额度 / 登录 / 限流'];
    if (c.flag === 'failed') return ['failed', '失败'];
    if (c.flag === 'held') return ['held', '已挂起，等队长放行'];
    const session = c.session_id ? host.session(c.session_id) : null;
    if (c.status === 'doing') {
      if (session && session.state === 'working') return ['working', '队员正在干活'];
      if (session && session.col) return ['live', '已派给队员'];
      return ['open', '还没有队员在做'];
    }
    return [c.status, U.labelOf(c.status)];
  }

  function renderCard(item, lane) {
    const c = item.card;
    const node = el('article', 'tbv-card');
    node.dataset.cardId = c.id;
    node.dataset.status = c.status;
    if (c.flag) node.dataset.flag = c.flag;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-keyshortcuts', 'Enter Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
    const row = el('div', 'tbv-row');
    const [state, stateLabel] = dotState(c);
    // The dot only tells whether a doing card is really being worked on; the column already names every other status.
    if (c.status === 'doing') { const dot = el('i', 'tbv-state ' + state); dot.title = stateLabel; row.append(dot); }
    row.append(el('h3', 'tbv-title', c.title));
    if (c.flag === 'quota') row.append(el('span', 'tbv-tag failed', { auth: '登录', rate_limit: '限流' }[c.resource_failure] || '额度'));
    if (c.flag === 'failed') row.append(el('span', 'tbv-tag failed', '失败'));
    if (c.flag === 'held') row.append(el('span', 'tbv-tag held', '挂起'));
    const conflict = window.FleetUI && window.FleetUI.conflictText(c);
    if (conflict) { const tag = el('span', 'tbv-tag conflict', '冲突'); tag.title = conflict; row.append(tag); }
    node.append(row);
    // Second line: the question (需要你) or the latest news, with the update time at its end.
    const sub = el('div', 'tbv-sub');
    let news = '';
    if (c.status === 'needs_user') {
      const q = el('p', 'tbv-question', item.question || '队长还没把问题整理出来');
      if (!item.question) q.classList.add('none');
      sub.append(q);
      news = q.textContent;
    } else {
      const act = U.activity(c, item.waitLabel, c.status === 'doing' ? stateLabel : '');
      news = act.text;
      sub.append(el('p', 'tbv-activity' + (act.tone ? ' ' + act.tone : ''), act.text));
    }
    const when = el('time', 'tbv-time', U.formatUpdated(c.updated));
    if (c.updated) when.dateTime = c.updated;
    sub.append(when);
    node.append(sub);
    const session = c.session_id ? host.session(c.session_id) : null;
    const who = session ? session.label : U.ownerLabel(c, null);
    node.title = [c.title, news !== item.waitLabel ? news : '', item.waitLabel, `${who}${U.modelLabel(c) ? ' · ' + U.modelLabel(c) : ''}`, c.updated ? '更新于 ' + new Date(c.updated).toLocaleString() : '', '点开看详情；拖动或 Alt+方向键 移动'].filter(Boolean).join('\n');
    node.setAttribute('aria-label', `${c.title}，${U.labelOf(c.status)}${c.flag === 'failed' ? '，失败' : ''}${c.status === 'needs_user' ? '，' + (item.question || '队长还没把问题整理出来') : ''}。回车看详情，Alt 加方向键移动`);
    node.addEventListener('click', () => { if (suppressClick) return; openDetail(c.id); });
    node.addEventListener('keydown', (e) => cardKey(e, item, lane));
    node.addEventListener('pointerdown', (e) => startCardDrag(e, node, item, lane));
    return node;
  }

  function renderCell(lane, col) {
    const cell = el('div', 'tbv-cell');
    cell.dataset.status = col.key;
    cell.dataset.lane = lane.key;
    cell.dataset.label = col.label;
    cell.setAttribute('aria-label', `${lane.name} · ${col.label}，${col.cards.length} 张`);
    if (col.key === 'done' && !prefs.doneOpen) {
      cell.classList.add('folded');
      if (col.cards.length) {
        const b = el('button', 'tbv-done-count', String(col.cards.length));
        b.type = 'button'; b.title = `${lane.name} 已完成 ${col.cards.length} 张，点开看`; b.setAttribute('aria-label', b.title);
        b.onclick = toggleDone;
        cell.append(b);
      }
      return cell;
    }
    const key = lane.key + '/' + col.key;
    const all = filter.project || expanded.has(key) || col.cards.length <= CELL_LIMIT;
    (all ? col.cards : col.cards.slice(0, CELL_LIMIT)).forEach((item) => cell.append(renderCard(item, lane)));
    if (!filter.project && col.cards.length > CELL_LIMIT) {
      const more = el('button', 'tbv-more');
      more.type = 'button'; more.dataset.cell = key;
      more.setAttribute('aria-expanded', String(all));
      const chev = el('span', 'tbv-chev'); chev.innerHTML = ICON.chevron;
      if (all) { more.title = '收起'; more.setAttribute('aria-label', `收起 ${lane.name} · ${col.label}`); more.classList.add('open'); more.append(chev); }
      else more.append(el('span', null, U.moreLabel(col.cards.length - CELL_LIMIT)), chev);
      more.onclick = () => { if (all) expanded.delete(key); else expanded.add(key); focusAfter = `.tbv-more[data-cell="${escapeId(key)}"]`; render(); };
      cell.append(more);
    }
    return cell;
  }

  function toggleLane(lane, collapsed) {
    if (collapsed) delete prefs.collapsed[lane.key]; else prefs.collapsed[lane.key] = true;
    savePrefs(); focusAfter = `.tbv-lane[data-project="${escapeId(lane.key)}"] .tbv-lane-toggle`; render();
  }
  // The group bar spans the board: arrow, colour dot, name, unfinished count on
  // the left, per-status counts (需要你 in red) on the right. A click folds it.
  function renderLane(lane, finished) {
    const collapsed = !filter.project && !!prefs.collapsed[lane.key];
    const section = el('section', 'tbv-lane' + (collapsed ? ' collapsed' : '') + (finished ? ' finished' : ''));
    section.dataset.project = lane.key;
    section.style.setProperty('--project-hue', hue(lane.key));
    section.setAttribute('aria-label', `${lane.name}，${lane.total} 项`);
    const head = el('header', 'tbv-lane-head');
    const toggle = iconButton('tbv-lane-toggle', ICON.chevron, `${collapsed ? '展开' : '收起'} ${lane.name}${finished ? '' : '（Alt+↑/↓ 调整项目先后）'}`);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.disabled = !!filter.project;
    if (!finished) toggle.addEventListener('keydown', (e) => laneKey(e, lane));
    const counts = el('div', 'tbv-lane-counts');
    U.COLUMNS.filter((c) => lane.counts[c.key]).forEach((c) => {
      // The red 需要你 count opens the group's first question.
      const asks = c.key === 'needs_user';
      const n = el(asks ? 'button' : 'span', 'tbv-lane-n', `${c.label} `);
      n.dataset.status = c.key; n.append(el('b', null, String(lane.counts[c.key])));
      if (asks) {
        const first = lane.columns.find((x) => x.key === 'needs_user').cards[0].card;
        n.type = 'button'; n.title = `${lane.name} 有 ${lane.counts[c.key]} 件需要你，点开「${first.title}」`; n.setAttribute('aria-label', n.title);
        n.onclick = (e) => { e.stopPropagation(); openDetail(first.id); };
      }
      counts.append(n);
    });
    const left = el('span', 'tbv-lane-open', lane.open ? `${lane.open} 件待完成` : '都做完了');
    head.append(toggle, el('span', 'tbv-dot'), el('h2', 'tbv-lane-name', lane.name), left, counts);
    head.title = filter.project ? lane.name : `${lane.name}：点一下${collapsed ? '展开' : '收起'}${finished ? '' : '，拖动可调整项目先后'}`;
    if (!filter.project) head.addEventListener('click', () => { if (suppressClick) return; toggleLane(lane, collapsed); });
    if (!finished) head.addEventListener('pointerdown', (e) => startLaneDrag(e, section, lane));
    section.append(head);
    if (!collapsed) {
      const cells = el('div', 'tbv-cells');
      lane.columns.forEach((col) => cells.append(renderCell(lane, col)));
      section.append(cells);
    }
    return section;
  }

  // 已完成的 Agent: projects with nothing left to do, one folded bar.
  function renderFinished() {
    const open = !!prefs.completedOpen;
    const bar = el('button', 'tbv-lane-head tbv-finished');
    bar.type = 'button'; bar.setAttribute('aria-expanded', String(open));
    bar.title = open ? '收起已完成的 Agent' : '展开已完成的 Agent';
    const chev = el('span', 'tbv-lane-toggle tbv-fold'); chev.innerHTML = ICON.chevron;
    const counts = el('div', 'tbv-lane-counts');
    const n = el('span', 'tbv-lane-n', '已完成 '); n.dataset.status = 'done'; n.append(el('b', null, String(board.finishedDone))); counts.append(n);
    bar.append(chev, el('span', 'tbv-dot done'), el('h2', 'tbv-lane-name', '已完成的 Agent'), el('span', 'tbv-lane-open', `${board.finished.length} 个 · ${open ? '收起' : '展开查看'}`), counts);
    bar.onclick = () => { prefs.completedOpen = !open; savePrefs(); focusAfter = '.tbv-finished'; render(); };
    return bar;
  }

  // The 需要你 reminder: one slim bar above the board. Every waiting card is
  // named and opens its own detail; 处理 opens the first.
  function renderAlert() {
    const items = board.alerts;
    alertEl.hidden = !items.length;
    alertEl.innerHTML = '';
    if (!items.length) return;
    const dot = el('span', 'tbv-alert-dot'); dot.innerHTML = ICON.alert;
    const list = el('div', 'tbv-alert-list');
    items.forEach((a) => {
      const question = a.question || '队长还没把问题整理出来';
      const b = el('button', 'tbv-alert-item');
      b.type = 'button'; b.dataset.cardId = a.card.id;
      b.append(el('span', 'tbv-alert-title', `${a.name} · ${a.card.title}`));
      if (items.length === 1) b.append(el('span', 'tbv-alert-q', question));
      b.title = `${a.name} · ${a.card.title}\n${question}`;
      b.setAttribute('aria-label', `${a.name}，${a.card.title}：${question}。点开处理`);
      b.onclick = () => openDetail(a.card.id);
      list.append(b);
    });
    const go = el('button', 'tbv-alert-go', '处理');
    go.type = 'button'; go.title = `处理「${items[0].card.title}」`; go.setAttribute('aria-label', go.title);
    const chev = el('span', 'tbv-chev'); chev.innerHTML = ICON.chevron; go.append(chev);
    go.onclick = () => openDetail(items[0].card.id);
    alertEl.append(dot, el('strong', 'tbv-alert-n', `${items.length} 件需要你`), list, go);
  }

  function setAll(open) {
    board.projects.forEach((p) => { if (open) delete prefs.collapsed[p.key]; else prefs.collapsed[p.key] = true; });
    prefs.completedOpen = open;
    savePrefs(); announce(open ? '已展开全部分组' : '已收起全部分组'); render();
  }

  function render() {
    if (!open) return;
    if (drag) { renderQueued = true; return; }
    const active = document.activeElement;
    const keepCard = !focusAfter && active && active.classList && active.classList.contains('tbv-card') ? active.dataset.cardId : null;
    if (!focusAfter && active && alertEl.contains(active)) focusAfter = active.dataset.cardId ? `.tbv-alert-item[data-card-id="${escapeId(active.dataset.cardId)}"]` : '.tbv-alert-go';
    board = U.buildBoard(cards, { project: filter.project, laneOrder: prefs.laneOrder });
    filter.project = board.project;
    renderProjects();
    renderHeads();
    gridEl.style.setProperty('--tbv-cols', gridTemplate());
    lanesEl.innerHTML = '';
    board.active.forEach((lane) => lanesEl.append(renderLane(lane)));
    if (board.finished.length) {
      lanesEl.append(renderFinished());
      if (prefs.completedOpen) board.finished.forEach((lane) => lanesEl.append(renderLane(lane, true)));
    }
    renderAlert();
    const needs = board.columns.find((c) => c.key === 'needs_user').count;
    summaryEl.textContent = board.total ? `${board.open} 件待完成${needs ? ` · ${needs} 件需要你` : ''}` : '';
    emptyEl.hidden = board.total > 0;
    gridEl.hidden = board.total === 0;
    renderDetail();
    const target = focusAfter ? viewEl.querySelector(focusAfter) : keepCard ? cardNode(keepCard) : null;
    focusAfter = null;
    if (target) target.focus({ preventScroll: true });
  }

  // ---- moving cards ----
  function find(id) {
    for (const lane of board ? board.lanes : []) for (const col of lane.columns) {
      const item = col.cards.find((x) => x.card.id === id);
      if (item) return { item, lane, col };
    }
    return null;
  }
  // One move = an optional status change through the data layer's own
  // transitions, then an optional reorder. Starts follow the configured dispatcher.
  async function applyMove(card, status, anchor) {
    card = cards.find((c) => c.id === card.id) || card; // the newest copy, so its `updated` is current
    try {
      if (status !== card.status) {
        if (status === 'doing' && (card.status === 'todo' || card.status === 'needs_user')) {
          const result = await api().requestStart(card.id);
          host.showToast(result && result.ignored ? result.occupied ? '这张卡仍有关联的未归档会话，请队长检查并安排' : '这张卡的派活请求已经处理，请队长检查并安排'
            : result && result.queued ? `「${card.title}」已排队，稍后自动调度`
            : result && result.dispatcher === 'gemini' ? `已开始调度「${card.title}」` : `已通知队长安排「${card.title}」`);
          if (result && result.ignored) { await refresh(); return; }
        } else await api().move(card.id, status, card.updated);
        announce(`「${card.title}」已移到${U.labelOf(status)}`);
      }
      if (anchor) { await api().reorder(card.id, anchor); if (status === card.status) announce(`「${card.title}」已调整先后`); }
    } catch (error) {
      host.showToast('没移成：' + friendly(error));
    }
    await refresh();
  }
  function cardKey(e, item, lane) {
    const c = item.card;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(c.id); return; }
    if (!e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    focusAfter = `.tbv-card[data-card-id="${escapeId(c.id)}"]`;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const status = U.stepStatus(c.status, e.key === 'ArrowLeft' ? -1 : 1);
      if (!status) { focusAfter = null; return; }
      if (status === 'done' && !prefs.doneOpen) { prefs.doneOpen = true; savePrefs(); }
      applyMove(c, status, null);
      return;
    }
    const ids = lane.columns.find((col) => col.key === c.status).cards.map((x) => x.card.id);
    const at = ids.indexOf(c.id) + (e.key === 'ArrowUp' ? -1 : 1);
    if (at < 0 || at >= ids.length) { focusAfter = null; return; }
    if (at >= CELL_LIMIT) expanded.add(lane.key + '/' + c.status);
    applyMove(c, c.status, e.key === 'ArrowUp' ? { before: ids[at] } : { after: ids[at] });
  }
  // Only unfinished groups are reordered; the finished ones keep their place after them.
  const withFinished = (keys) => keys.concat(board.finished.map((l) => l.key));
  function laneKey(e, lane) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || filter.project) return;
    e.preventDefault(); e.stopPropagation();
    const keys = board.active.map((l) => l.key);
    const at = keys.indexOf(lane.key), to = at + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= keys.length) return;
    keys.splice(at, 1); keys.splice(to, 0, lane.key);
    prefs.laneOrder = withFinished(keys); savePrefs();
    focusAfter = `.tbv-lane[data-project="${escapeId(lane.key)}"] .tbv-lane-toggle`;
    announce(`${lane.name} 已移到第 ${to + 1} 个`);
    render();
  }

  // ---- pointer drag (cards and lanes) ----
  // Pointer events rather than HTML5 drag: the ghost, the drop line and the
  // scroll-at-the-edge behave the same on macOS and Windows.
  function trackDrag(e, begin, move, finish) {
    if (e.button !== 0 || drag) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    const onMove = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        // the board may have been redrawn since the press: begin() looks the node up again
        if (begin(ev) === false) { end(false); return; }
        started = true;
        viewEl.classList.add('tbv-dragging');
      }
      ev.preventDefault();
      const r = scrollEl.getBoundingClientRect();
      if (ev.clientY < r.top + 44) scrollEl.scrollTop -= 14; else if (ev.clientY > r.bottom - 44) scrollEl.scrollTop += 14;
      move(ev);
    };
    const end = (commit) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      if (!started) return;
      viewEl.classList.remove('tbv-dragging');
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      const d = drag; drag = null;
      viewEl.querySelectorAll('.tbv-ghost, .tbv-drop, .tbv-lane-drop').forEach((n) => n.remove());
      viewEl.querySelectorAll('.dragging, .drop-target, .drag-lane').forEach((n) => n.classList.remove('dragging', 'drop-target', 'drag-lane'));
      const again = renderQueued; renderQueued = false;
      if (commit && d) finish(d);
      if (again && !(d && d.acted)) render();
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  }
  function ghostOf(node, e) {
    const r = node.getBoundingClientRect();
    const ghost = node.cloneNode(true);
    ghost.classList.add('tbv-ghost');
    ghost.removeAttribute('tabindex');
    Object.assign(ghost.style, { width: r.width + 'px', left: r.left + 'px', top: r.top + 'px' });
    ghost.style.setProperty('--project-hue', hue(node.closest('.tbv-lane').dataset.project));
    viewEl.append(ghost);
    return { ghost, dx: e.clientX - r.left, dy: e.clientY - r.top };
  }

  function startCardDrag(e, node, item, lane) {
    trackDrag(e, (ev) => {
      const live = cardNode(item.card.id);
      if (!live) return false;
      const section = live.closest('.tbv-lane');
      drag = { kind: 'card', item, lane, section, target: null, ...ghostOf(live, ev) };
      live.classList.add('dragging');
      section.classList.add('drag-lane');
    }, (ev) => {
      const d = drag;
      d.ghost.style.left = ev.clientX - d.dx + 'px'; d.ghost.style.top = ev.clientY - d.dy + 'px';
      viewEl.querySelectorAll('.tbv-drop').forEach((n) => n.remove());
      viewEl.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      d.target = null;
      // A card stays in its project: only its own lane's cells take it.
      const lr = d.section.getBoundingClientRect();
      if (ev.clientY < lr.top - 24 || ev.clientY > lr.bottom + 24) return;
      const cell = [...d.section.querySelectorAll('.tbv-cell')].find((c) => { const r = c.getBoundingClientRect(); return ev.clientX >= r.left - 5 && ev.clientX <= r.right + 5; });
      if (!cell) return;
      const others = [...cell.querySelectorAll('.tbv-card:not(.dragging)')];
      const index = others.filter((n) => { const r = n.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; }).length;
      cell.classList.add('drop-target');
      if (!cell.classList.contains('folded')) {
        const line = el('div', 'tbv-drop');
        if (others[index]) cell.insertBefore(line, others[index]); else if (others.length) others[others.length - 1].after(line); else cell.prepend(line);
      }
      d.target = { status: cell.dataset.status, index, ids: [...cell.querySelectorAll('.tbv-card')].map((n) => n.dataset.cardId) };
    }, (d) => {
      if (!d.target) return;
      const c = d.item.card;
      const anchor = U.dropAnchor(d.target.ids, c.id, d.target.index);
      if (d.target.status === c.status && !anchor) return;
      d.acted = true;
      focusAfter = `.tbv-card[data-card-id="${escapeId(c.id)}"]`;
      applyMove(c, d.target.status, anchor);
    });
  }

  function startLaneDrag(e, section, lane) {
    if (filter.project || e.target.closest('button')) return;
    trackDrag(e, (ev) => {
      const live = lanesEl.querySelector(`.tbv-lane[data-project="${escapeId(lane.key)}"]`);
      if (!live) return false;
      drag = { kind: 'lane', lane, before: undefined, ...ghostOf(live.querySelector('.tbv-lane-head'), ev) };
      live.classList.add('dragging');
    }, (ev) => {
      const d = drag;
      d.ghost.style.left = ev.clientX - d.dx + 'px'; d.ghost.style.top = ev.clientY - d.dy + 'px';
      viewEl.querySelectorAll('.tbv-lane-drop').forEach((n) => n.remove());
      const lanes = [...lanesEl.querySelectorAll('.tbv-lane:not(.finished)')];
      const next = lanes.find((n) => { const r = n.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      d.before = next ? next.dataset.project : null;
      const line = el('div', 'tbv-lane-drop');
      if (next) lanesEl.insertBefore(line, next); else lanes[lanes.length - 1].after(line);
    }, (d) => {
      if (d.before === undefined || d.before === lane.key) return;
      const keys = board.active.map((l) => l.key);
      const order = U.moveLane(keys, lane.key, d.before);
      if (order.join('\n') === keys.join('\n')) return;
      d.acted = true;
      prefs.laneOrder = withFinished(order); savePrefs();
      announce(`${lane.name} 已移到第 ${order.indexOf(lane.key) + 1} 个`);
      render();
    });
  }

  // ---- detail drawer ----
  function openDetail(id) { detailId = id; detailKey = ''; renderDetail(); const first = detailEl.querySelector('textarea') || detailEl.querySelector('.tbv-d-close'); if (first) first.focus({ preventScroll: true }); }
  function closeDetail(refocus) {
    const id = detailId;
    detailId = null; detailKey = '';
    detailEl.hidden = true; detailEl.innerHTML = '';
    viewEl.classList.remove('has-detail');
    lanesEl.querySelectorAll('.tbv-card.selected').forEach((n) => n.classList.remove('selected'));
    if (refocus && id) { const n = cardNode(id); if (n) n.focus({ preventScroll: true }); }
  }
  function section(title, ...children) {
    const s = el('section', 'tbv-d-section');
    s.append(el('h3', 'tbv-d-label', title), ...children);
    return s;
  }
  function copyButton(text, label) {
    const b = iconButton('tbv-copy', ICON.copy, label);
    b.onclick = () => {
      host.copy(text);
      b.innerHTML = ICON.check; b.classList.add('ok');
      setTimeout(() => { b.innerHTML = ICON.copy; b.classList.remove('ok'); }, 1200);
    };
    return b;
  }
  async function sendAnswer(card, box, button) {
    const text = box.value.trim();
    if (!text) { box.focus(); return; }
    button.disabled = true;
    try {
      const result = await api().answer(card.id, text);
      drafts.delete(card.id);
      host.showToast(result && result.stayed ? '答案已发给队长；卡片暂时留在原处：' + friendly(result.stayed) : '答案已发给队长');
      announce(`答案已发给队长，「${card.title}」回到进行中`);
      detailKey = '';
    } catch (error) {
      button.disabled = false;
      host.showToast('没发出去：' + friendly(error));
      return;
    }
    await refresh();
  }

  function renderDetail() {
    lanesEl.querySelectorAll('.tbv-card.selected').forEach((n) => n.classList.remove('selected'));
    if (!detailId) return;
    const found = find(detailId) || (() => { const card = cards.find((c) => c.id === detailId && !c.archived); return card ? { item: { card, waits: [], waitLabel: '', question: U.userQuestion(card) }, lane: { key: U.projectKey(card.project), name: card.project } } : null; })();
    if (!found) { closeDetail(false); return; }
    const { item, lane } = found;
    const c = item.card;
    const node = cardNode(c.id); if (node) node.classList.add('selected');
    const session = c.session_id ? host.session(c.session_id) : null;
    const key = JSON.stringify([c, session && session.label, session && !!session.col, session && session.files, item.waitLabel]);
    if (key === detailKey) return;
    const hadFocus = detailEl.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
    detailKey = key;
    detailEl.innerHTML = '';
    detailEl.hidden = false;
    viewEl.classList.add('has-detail');
    detailEl.style.setProperty('--project-hue', hue(lane.key));
    detailEl.dataset.cardId = c.id;
    detailEl.dataset.status = c.status;

    const top = el('header', 'tbv-d-top');
    const crumb = el('div', 'tbv-d-crumb');
    crumb.append(el('span', 'tbv-dot'), el('span', 'tbv-d-project', lane.name), el('span', 'tbv-d-status', U.labelOf(c.status)));
    if (c.flag === 'quota') crumb.append(el('span', 'tbv-tag failed', { auth: '登录', rate_limit: '限流' }[c.resource_failure] || '额度'));
    if (c.flag === 'failed') crumb.append(el('span', 'tbv-tag failed', '失败'));
    if (c.flag === 'held') crumb.append(el('span', 'tbv-tag held', '挂起'));
    const close = iconButton('tbv-d-close', ICON.close, '关闭详情 (Esc)');
    close.onclick = () => closeDetail(true);
    top.append(crumb, close);
    const body = el('div', 'tbv-d-body');
    body.append(el('h2', 'tbv-d-title', c.title));

    if (c.status === 'needs_user') {
      const ask = el('section', 'tbv-ask');
      ask.append(el('h3', 'tbv-ask-label', '需要你决定'));
      if (item.question) ask.append(el('p', 'tbv-ask-question', item.question));
      else ask.append(el('p', 'tbv-ask-question none', '队长还没把问题整理出来'), el('p', 'tbv-ask-hint', '你可以直接在下面告诉队长这件事怎么办，或者让他先把问题说清楚。'));
      const box = el('textarea', 'tbv-answer');
      box.rows = 3; box.placeholder = '写下你的答案…'; box.setAttribute('aria-label', '你的答案');
      box.value = drafts.get(c.id) || '';
      const send = el('button', 'tbv-send', '发送答案');
      send.type = 'button'; send.title = '把答案发给队长 (⌘/Ctrl+Enter)';
      box.oninput = () => { drafts.set(c.id, box.value); };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAnswer(c, box, send); } });
      send.onclick = () => sendAnswer(c, box, send);
      const foot = el('div', 'tbv-ask-foot');
      foot.append(el('span', 'tbv-ask-tip', '答案会发给队长，卡片回到进行中'), send);
      ask.append(box, foot);
      body.append(ask);
    }

    const who = el('div', 'tbv-d-who');
    if (session && session.col) { const badge = el('span'); host.renderBadge(badge, session.col); if (!badge.hidden) who.append(badge); }
    else if (U.modelLabel(c)) who.append(el('span', 'tbv-model', U.modelLabel(c)));
    who.append(el('span', 'tbv-d-who-name', session ? session.label : U.ownerLabel(c, null)));
    if (session) {
      const go = iconButton('tbv-d-open', ICON.terminal, `打开「${session.label}」的终端`);
      go.onclick = () => host.openSession(c.session_id);
      who.append(go);
    }
    body.append(section('谁在做', who));

    const receipt = U.receiptText(c);
    if (receipt && receipt !== item.question) body.append(section('最近回执', el('p', 'tbv-d-text', receipt)));
    else if (c.status !== 'needs_user') body.append(section('最近回执', el('p', 'tbv-d-text none', '还没有回执')));
    if (item.waitLabel) body.append(section('在等', el('p', 'tbv-d-text', item.waitLabel)));
    body.append(section('说明', el('p', 'tbv-d-text' + (c.detail.trim() ? '' : ' none'), c.detail.trim() || '没有写说明')));

    const files = U.filePaths((session && session.files) || [], c.latest_receipt, c.detail);
    if (files.length) {
      const list = el('ul', 'tbv-d-files');
      files.forEach((p) => { const li = el('li'); const name = el('span', 'tbv-d-file', p); name.title = p; li.append(name, copyButton(p, '复制路径')); list.append(li); });
      body.append(section('相关文件', list));
    }

    const moves = el('div', 'tbv-d-moves'); moves.setAttribute('role', 'group'); moves.setAttribute('aria-label', '移到');
    U.COLUMNS.forEach((col) => {
      const b = el('button', null, col.label);
      b.type = 'button'; b.dataset.status = col.key;
      const on = col.key === c.status;
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
      b.onclick = () => { if (!on) applyMove(c, col.key, null); };
      moves.append(b);
    });
    body.append(section('移到', moves));

    const meta = el('div', 'tbv-d-meta');
    meta.append(el('span', null, [c.updated ? '更新于 ' + new Date(c.updated).toLocaleString() : '', c.rework_count > 0 ? `返工 ${c.rework_count} 次` : '', '编号 ' + c.id].filter(Boolean).join(' · ')), copyButton(c.id, '复制卡片编号'));
    body.append(meta);
    detailEl.append(top, body);
    if (hadFocus) { const box = detailEl.querySelector('textarea'); if (box) box.focus({ preventScroll: true }); }
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    viewEl.hidden = !open;
    if (open) {
      const saved = host.prefs() || {};
      prefs = { laneOrder: Array.isArray(saved.laneOrder) ? saved.laneOrder.slice() : [], collapsed: { ...(saved.collapsed || {}) }, doneOpen: !!saved.doneOpen, completedOpen: !!saved.completedOpen };
      // subscribe first, then list (docs/task-board-api.md)
      if (api() && api().onChange) unsubscribe = api().onChange(() => refresh());
      render();
      refresh();
    } else {
      if (unsubscribe) { try { unsubscribe(); } catch (_) {} }
      unsubscribe = null;
      seq++;
      closeDetail(false);
      refreshBtn.classList.remove('busy');
    }
    host.onToggle(open);
    if (open) viewEl.focus({ preventScroll: true });
  }

  function init(h) {
    host = h;
    viewEl = document.getElementById('taskBoardView');
    projectsEl = viewEl.querySelector('.tbv-projects');
    gridEl = viewEl.querySelector('.tbv-grid');
    headsEl = viewEl.querySelector('.tbv-heads');
    lanesEl = viewEl.querySelector('.tbv-lanes');
    scrollEl = viewEl.querySelector('.tbv-scroll');
    statusEl = viewEl.querySelector('.tbv-status');
    summaryEl = viewEl.querySelector('.tbv-summary');
    emptyEl = viewEl.querySelector('.tbv-empty-board');
    refreshBtn = viewEl.querySelector('.tbv-refresh');
    alertEl = viewEl.querySelector('.tbv-alert');
    viewEl.querySelector('.tbv-expand-all').onclick = () => { if (board) setAll(true); };
    viewEl.querySelector('.tbv-collapse-all').onclick = () => { if (board) setAll(false); };
    detailEl = viewEl.querySelector('.tbv-detail');
    liveEl = viewEl.querySelector('.tbv-live');
    refreshBtn.onclick = () => refresh();
    viewEl.querySelector('.tbv-close').onclick = () => { setOpen(false); host.focusToggle(); };
    // 架构图 / 自由画布 leave the board for the board view in that mode.
    viewEl.querySelectorAll('.board-mode button[data-view]').forEach((b) => {
      if (b.dataset.view !== 'tasks') b.onclick = () => host.showBoard(b.dataset.view);
    });
    viewEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (detailId) closeDetail(true); else { setOpen(false); host.focusToggle(); }
    });
  }

  window.TaskBoardUI = {
    init,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
})();
