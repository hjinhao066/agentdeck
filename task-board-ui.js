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
// The look is a star chart: a still night (or dawn) sky, glass cards lit from
// the top in their status colour, and glowing lines from a waiting card to the
// card it waits on. A 高优先级 card (the user named it urgent) carries a solid
// flag mark and leads its column; the drawer's flag button sets or clears it.
// Only running work moves, and nothing moves under the
// system's reduce-motion setting. The page's fourth tab, Token 用量, swaps the
// board for the usage chart (token-usage-ui.js) under the same toolbar.
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
    flag: svg('<path d="M5.5 21V4"/><path d="M5.5 4.6h12l-2.7 4 2.7 4h-12z" fill="currentColor"/>'),
  };
  // The 高优先级 mark: a flag with its own colour, never a status colour. An
  // unfinished card wears it solid with a short label; a finished one keeps a quiet outline.
  const PRIORITY_TIP = '高优先级：你点名要优先做的事，排在同一栏最前面';
  const priorityMark = (cls, urgent, text) => {
    const m = el('span', cls + (urgent ? '' : ' quiet'));
    m.innerHTML = ICON.flag;
    if (text) m.append(el('span', 'tbv-prio-text', text));
    m.setAttribute('role', 'img');
    m.title = urgent ? PRIORITY_TIP : '高优先级（已完成）';
    m.setAttribute('aria-label', urgent ? '高优先级' : '高优先级，已完成');
    return m;
  };
  // One glyph per status: column heads, group tallies, the drawer's 移到 row.
  const STATUS_ICON = {
    todo: svg('<circle cx="12" cy="12" r="8.5" stroke-dasharray="3.1 3.6"/>'),
    doing: svg('<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>'),
    review: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.3"/>'),
    needs_user: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5.2M12 16.3v.1"/>'),
    done: svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.4 2.6 2.6 5-5.5"/>'),
  };
  const statusIcon = (key, cls) => { const i = el('i', cls); i.innerHTML = STATUS_ICON[key] || ''; i.setAttribute('aria-hidden', 'true'); return i; };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';
  const MAX_SPARKS = 14;      // travelling lights on the dependency lines
  const MAX_GLIDES = 24;      // cards animated to a new place in one redraw
  const reduceMotion = () => document.documentElement.dataset.motion === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let host = null;
  let alertEl, viewEl, projectsEl, gridEl, headsEl, lanesEl, linksEl, meterEl, scrollEl, statusEl, summaryEl, emptyEl, refreshBtn, detailEl, liveEl;
  let open = false;
  let mode = 'tasks';         // 'tasks' (the board) or 'tokens' (Token 用量)
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
  let glideNext = false;      // the next redraw follows new data: moved cards glide
  let stillUntil = 0;         // the user has just dropped a card by hand: nothing glides until then
  let hotId = null;           // the card whose dependency lines are lit
  let lit = 0;                // moving cards drawn so far this redraw: staggers their rhythm
  let linksQueued = false;

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
      glideNext = true;
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
      head.append(statusIcon(col.key, 'tbv-head-dot'), el('span', 'tbv-head-label', col.label), el('span', 'tbv-count', String(col.count)));
      if (done) {
        head.type = 'button';
        const label = prefs.doneOpen ? '收起完成列，只显示数量' : '展开完成列';
        head.title = label; head.setAttribute('aria-label', `完成 ${col.count} 张，${label}`);
        head.setAttribute('aria-expanded', String(!!prefs.doneOpen));
        const chev = el('span', 'tbv-chev'); chev.innerHTML = ICON.chevron; head.append(chev);
        head.onclick = toggleDone;
      }
      if (col.key === 'needs_user' && col.count) head.classList.add('alert');
      if (!col.count) head.classList.add('zero');
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
    if (c.status === 'doing') { const dot = el('i', 'tbv-state ' + state); dot.title = stateLabel; row.append(dot); node.dataset.run = state; }
    if (item.high) { row.append(priorityMark('tbv-prio', item.urgent, item.urgent ? '高优' : '')); if (item.urgent) node.dataset.priority = 'high'; }
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
    // Running work is the only thing that moves: its rim breathes and a light travels along its top
    // edge. A 需要你 card carries a beacon. Neighbours are kept out of step.
    const mark = (cls) => { const i = el('i', cls); i.setAttribute('aria-hidden', 'true'); node.append(i); node.style.setProperty('--tbv-i', String(lit++ % 7)); };
    if (node.dataset.run === 'working') mark('tbv-flow');
    if (c.status === 'needs_user') mark('tbv-beacon');
    const session = c.session_id ? host.session(c.session_id) : null;
    const who = session ? session.label : U.ownerLabel(c, null);
    node.title = [c.title, item.urgent ? '高优先级' : '', news !== item.waitLabel ? news : '', item.waitLabel, `${who}${U.modelLabel(c) ? ' · ' + U.modelLabel(c) : ''}`, c.updated ? '更新于 ' + new Date(c.updated).toLocaleString() : '', '点开看详情；拖动或 Alt+方向键 移动'].filter(Boolean).join('\n');
    node.setAttribute('aria-label', `${c.title}，${item.urgent ? '高优先级，' : ''}${U.labelOf(c.status)}${c.flag === 'failed' ? '，失败' : ''}${c.status === 'needs_user' ? '，' + (item.question || '队长还没把问题整理出来') : ''}。回车看详情，Alt 加方向键移动`);
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
    section.style.setProperty('--tbv-done', (lane.total ? lane.counts.done / lane.total : 0).toFixed(3));
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
      const n = el(asks ? 'button' : 'span', 'tbv-lane-n');
      n.dataset.status = c.key; n.append(statusIcon(c.key, 'tbv-n-ico'), `${c.label} `, el('b', null, String(lane.counts[c.key])));
      if (asks) {
        const first = lane.columns.find((x) => x.key === 'needs_user').cards[0].card;
        n.type = 'button'; n.title = `${lane.name} 有 ${lane.counts[c.key]} 件需要你，点开「${first.title}」`; n.setAttribute('aria-label', n.title);
        n.onclick = (e) => { e.stopPropagation(); openDetail(first.id); };
      }
      counts.append(n);
    });
    const left = el('span', 'tbv-lane-open', lane.open ? `${lane.open} 件待完成` : '都做完了');
    head.append(toggle, el('span', 'tbv-dot'), el('h2', 'tbv-lane-name', lane.name), left);
    // Seen on a folded group too: how many 高优先级 cards are still open in it.
    if (lane.urgent) {
      const n = priorityMark('tbv-lane-prio', true, String(lane.urgent));
      n.title = `${lane.name} 有 ${lane.urgent} 件高优先级还没做完`; n.setAttribute('aria-label', n.title);
      head.append(n);
    }
    head.append(counts);
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
    const n = el('span', 'tbv-lane-n'); n.dataset.status = 'done'; n.append(statusIcon('done', 'tbv-n-ico'), '已完成 ', el('b', null, String(board.finishedDone))); counts.append(n);
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
    const before = glideNext && !reduceMotion() && Date.now() >= stillUntil ? placesOf() : null;
    glideNext = false;
    board = U.buildBoard(cards, { project: filter.project, laneOrder: prefs.laneOrder });
    filter.project = board.project;
    renderProjects();
    renderHeads();
    renderMeter();
    gridEl.style.setProperty('--tbv-cols', gridTemplate());
    lanesEl.innerHTML = '';
    lit = 0;
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
    drawLinks();
    if (before && before.size) glide(before);
    const target = focusAfter ? viewEl.querySelector(focusAfter) : keepCard ? cardNode(keepCard) : null;
    focusAfter = null;
    if (target) target.focus({ preventScroll: true });
  }

  // ---- progress meter (toolbar) ----
  // The share of the shown cards that is done, with one lit segment per status.
  function renderMeter() {
    const p = U.progress(board.columns);
    meterEl.hidden = !p.total;
    if (!p.total) return;
    meterEl.querySelector('.tbv-meter-pct').textContent = String(p.percent);
    meterEl.querySelector('.tbv-meter-frac').textContent = `${p.done} / ${p.total}`;
    const bar = meterEl.querySelector('.tbv-meter-bar');
    bar.innerHTML = '';
    p.segments.forEach((seg) => {
      const part = el('i'); part.dataset.status = seg.key; part.style.flexGrow = String(seg.count); part.title = `${seg.label} ${seg.count}`;
      bar.append(part);
    });
    meterEl.setAttribute('aria-label', `完成进度 ${p.percent}%：${p.total} 张里完成 ${p.done} 张。${p.segments.map((x) => `${x.label} ${x.count}`).join('，')}`);
    meterEl.title = `完成 ${p.done} / ${p.total}`;
  }

  // ---- dependency lines ----
  // A line runs from every shown card to each card it still waits on, under
  // the cards, in the gaps between columns. A prerequisite folded away (behind
  // 展开剩余, or in a folded group) is reached at that fold. Hovering, focusing
  // or opening a card lights its own lines. A light travels along a line only
  // while the prerequisite is really being worked on.
  function anchorOf(link) {
    const node = cardNode(link.from);
    if (node) return node;
    const lane = lanesEl.querySelector(`.tbv-lane[data-project="${escapeId(link.lane)}"]`);
    if (!lane) return null;
    if (lane.classList.contains('collapsed')) return lane.querySelector('.tbv-lane-head .tbv-dot');
    return lane.querySelector(`.tbv-cell[data-status="${link.status}"] .tbv-more`);
  }
  function drawLinks() {
    linksEl.innerHTML = '';
    if (!open || mode === 'tokens' || !board || !board.links.length || gridEl.hidden) return;
    const origin = gridEl.getBoundingClientRect();
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }; };
    // stacked (narrow) cells leave the lines only the board's left margin; side by side they share the column gap
    const gap = getComputedStyle(headsEl).display === 'none' ? 18 : parseFloat(getComputedStyle(gridEl).getPropertyValue('--tbv-gap')) || 10;
    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('class', 'tbv-links-svg');
    const shape = (tag, cls, attrs) => { const n = document.createElementNS(SVG_NS, tag); n.setAttribute('class', cls); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v))); return n; };
    const bundles = new Map(); // gap -> the cards it leads to, so lines to different cards fan out
    const still = reduceMotion();
    const routes = [];
    board.links.forEach((link) => {
      const to = cardNode(link.to), from = anchorOf(link);
      if (!to || !from) return;
      const a = rect(from), b = rect(to);
      if (!a.w || !b.w) return;
      let route = U.linkRoute(a, b, gap, 0);
      if (route.points.length > 2) {
        const key = Math.round(route.points[1][0]);
        const seen = bundles.get(key) || new Map();
        if (!seen.has(link.to)) seen.set(link.to, seen.size);
        bundles.set(key, seen);
        if (seen.get(link.to)) route = U.linkRoute(a, b, gap, seen.get(link.to));
      }
      const card = cards.find((c) => c.id === link.from);
      const live = link.tone === 'flow' && !!card && dotState(card)[0] === 'working';
      const g = shape('g', 'tbv-link' + (live ? ' live' : ''), { 'data-from': link.from, 'data-to': link.to, 'data-tone': link.tone });
      const start = route.points[0], end = route.points[route.points.length - 1];
      g.append(shape('path', 'tbv-link-halo', { d: route.d }), shape('path', 'tbv-link-line', { d: route.d }),
        shape('circle', 'tbv-link-from', { cx: start[0], cy: start[1], r: 2.6 }), shape('circle', 'tbv-link-to', { cx: end[0], cy: end[1], r: 3.2 }));
      svgEl.append(g);
      if (live && !still) routes.push(route);
    });
    linksEl.append(svgEl);
    routes.slice(0, MAX_SPARKS).forEach((route, i) => {
      const dot = el('i', 'tbv-spark');
      linksEl.append(dot);
      let run = 0;
      const frames = route.points.map(([x, y], k) => {
        if (k) run += Math.abs(x - route.points[k - 1][0]) + Math.abs(y - route.points[k - 1][1]);
        return { transform: `translate(${x}px, ${y}px)`, offset: route.length ? Math.min(1, run / route.length) : k ? 1 : 0 };
      });
      const timing = { duration: Math.max(2200, route.length * 16), iterations: Infinity, delay: -i * 610 };
      dot.animate(frames, timing);
      dot.animate([{ opacity: 0 }, { opacity: 1, offset: 0.14 }, { opacity: 1, offset: 0.82 }, { opacity: 0 }], timing);
    });
    lightLinks();
  }
  function queueLinks() {
    if (linksQueued) return;
    linksQueued = true;
    requestAnimationFrame(() => { linksQueued = false; if (open && !drag) drawLinks(); });
  }
  // The lines of the hovered / focused card, else of the card open in the drawer.
  function lightLinks() {
    const id = hotId || detailId;
    let any = false;
    lanesEl.querySelectorAll('.tbv-card.linked').forEach((n) => n.classList.remove('linked'));
    linksEl.querySelectorAll('.tbv-link').forEach((g) => {
      const on = !!id && (g.dataset.from === id || g.dataset.to === id);
      g.classList.toggle('on', on);
      if (!on) return;
      any = true;
      const other = cardNode(g.dataset.from === id ? g.dataset.to : g.dataset.from);
      if (other) other.classList.add('linked');
    });
    linksEl.classList.toggle('hot', any);
  }
  function setHot(id) { if (id === hotId) return; hotId = id; lightLinks(); }

  // ---- motion ----
  // After new data a card that changed place glides there, a card whose status
  // changed is lit once in its new colour, and a new card fades in. Folding,
  // filtering and resizing redraw at once, and so does a card the user has just
  // dropped somewhere by hand (it is already there).
  function placesOf() {
    const map = new Map();
    lanesEl.querySelectorAll('.tbv-card').forEach((n) => { const r = n.getBoundingClientRect(); map.set(n.dataset.cardId, { x: r.left, y: r.top, mark: n.dataset.status + '/' + (n.dataset.flag || '') }); });
    return map;
  }
  function glide(before) {
    const moved = [];
    lanesEl.querySelectorAll('.tbv-card').forEach((n) => {
      const was = before.get(n.dataset.cardId);
      if (!was) { n.animate([{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE }); return; }
      const r = n.getBoundingClientRect();
      const dx = was.x - r.left, dy = was.y - r.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved.push([n, dx, dy]);
      if (was.mark !== n.dataset.status + '/' + (n.dataset.flag || '')) {
        const flash = el('i', 'tbv-flash'); flash.setAttribute('aria-hidden', 'true');
        n.append(flash);
        flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.18 }, { opacity: 0 }], { duration: 1100, easing: 'ease-out' }).onfinish = () => flash.remove();
      }
    });
    if (moved.length > MAX_GLIDES) return;
    moved.forEach(([n, dx, dy]) => {
      n.classList.add('gliding');
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 380, easing: EASE }).onfinish = () => n.classList.remove('gliding');
    });
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
      // 高优先级 cards lead the column: a drop on the other side of that line keeps the card's own place.
      const other = anchor && cards.find((c) => c.id === (anchor.before != null ? anchor.before : anchor.after));
      const mine = U.isHigh(card) && status !== 'done';
      const crosses = !!other && U.isUrgent(other) !== mine && (mine ? anchor.after != null : anchor.before != null);
      if (crosses && status === card.status) host.showToast('高优先级的卡片固定排在这一栏最前面');
      else if (anchor && !crosses) { await api().reorder(card.id, anchor); if (status === card.status) announce(`「${card.title}」已调整先后`); }
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
    // 高优先级 cards lead the column: a card cannot be moved across that line.
    const column = lane.columns.find((col) => col.key === c.status).cards;
    if (column[at].urgent !== item.urgent) { focusAfter = null; announce('高优先级的卡片固定排在这一栏最前面'); return; }
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
      // the card is already where the hand put it: it and the cards it pushed aside land at once
      stillUntil = Date.now() + 1500;
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
  function openDetail(id) { detailId = id; detailKey = ''; renderDetail(); lightLinks(); const first = detailEl.querySelector('textarea') || detailEl.querySelector('.tbv-d-close'); if (first) first.focus({ preventScroll: true }); }
  function closeDetail(refocus) {
    const id = detailId;
    detailId = null; detailKey = '';
    detailEl.hidden = true; detailEl.innerHTML = '';
    viewEl.classList.remove('has-detail');
    lanesEl.querySelectorAll('.tbv-card.selected').forEach((n) => n.classList.remove('selected'));
    lightLinks();
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
  async function setPriority(card, high) {
    try {
      await api().setPriority(card.id, high ? 'high' : 'normal');
      announce(high ? `「${card.title}」已标为高优先级` : `「${card.title}」已改回普通优先级`);
      const told = high && card.status === 'todo' && window.MainSession && window.MainSession.exists();
      host.showToast(high ? (told ? '已标为高优先级，并告诉队长立刻安排' : '已标为高优先级') : '已改回普通优先级');
    } catch (error) {
      host.showToast('没改成：' + friendly(error));
    }
    detailKey = '';   // redraw the drawer either way: the button comes back enabled
    focusAfter = '.tbv-d-prio';
    await refresh();
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
    const high = U.isHigh(c);
    if (high) crumb.append(priorityMark('tbv-prio', U.isUrgent(c), '高优先级'));
    // One click sets or clears the mark; the flag is lit while it is set.
    const prio = iconButton('tbv-d-prio', ICON.flag, high ? '取消高优先级' : '标为高优先级（排到最前，队长优先安排）');
    prio.setAttribute('aria-pressed', String(high));
    prio.onclick = () => { prio.disabled = true; setPriority(c, !high); };
    const close = iconButton('tbv-d-close', ICON.close, '关闭详情 (Esc)');
    close.onclick = () => closeDetail(true);
    top.append(crumb, prio, close);
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
      send.type = 'button'; send.title = `把答案发给队长 (${window.AppShortcutsCore.mod(host.platform === 'darwin')}Enter)`;
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
      const b = el('button');
      b.type = 'button'; b.dataset.status = col.key; b.append(statusIcon(col.key, 'tbv-n-ico'), col.label);
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

  // The board or Token 用量 under one toolbar: the tab, the title and what the page holds.
  const MODES = { tasks: { kicker: '全部任务', title: '任务看板' }, tokens: { kicker: '本机各模型', title: 'Token 用量' } };
  function setMode(next) {
    if (!MODES[next]) next = 'tasks';
    const changed = next !== mode;
    mode = next;
    viewEl.dataset.mode = mode;
    viewEl.setAttribute('aria-label', MODES[mode].title);
    viewEl.querySelector('.tbv-kicker').textContent = MODES[mode].kicker;
    viewEl.querySelector('.tbv-heading h1').textContent = MODES[mode].title;
    viewEl.querySelectorAll('.board-mode button[data-view]').forEach((b) => {
      if (b.dataset.view !== 'tasks' && b.dataset.view !== 'tokens') return;
      const on = b.dataset.view === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (!open) return;
    if (mode === 'tokens') { closeDetail(false); hotId = null; linksEl.innerHTML = ''; window.TokenUsageUI.show(); }
    else { window.TokenUsageUI.hide(); if (changed) render(); }
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
      if (mode === 'tokens') window.TokenUsageUI.show();
      if (!reduceMotion()) scrollEl.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE });
    } else {
      if (unsubscribe) { try { unsubscribe(); } catch (_) {} }
      unsubscribe = null;
      seq++;
      hotId = null;
      closeDetail(false);
      linksEl.innerHTML = '';
      refreshBtn.classList.remove('busy');
      window.TokenUsageUI.hide();
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
    linksEl = viewEl.querySelector('.tbv-links');
    meterEl = viewEl.querySelector('.tbv-meter');
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
    // the chips' first row keeps clear of the tally and tools, which stand over its right end (style.css)
    const toolsEl = viewEl.querySelector('.tbv-tools');
    new ResizeObserver(() => viewEl.querySelector('.tbv-filters').style.setProperty('--tbv-tools-w', toolsEl.getBoundingClientRect().width + 'px')).observe(toolsEl);
    const cardAt = (e) => { const n = e.target.closest && e.target.closest('.tbv-card'); return n ? n.dataset.cardId : null; };
    lanesEl.addEventListener('pointerover', (e) => { if (!drag) setHot(cardAt(e)); });
    lanesEl.addEventListener('pointerleave', () => setHot(null));
    lanesEl.addEventListener('focusin', (e) => setHot(cardAt(e)));
    lanesEl.addEventListener('focusout', () => setHot(null));
    // the lines follow the cards whenever the board is laid out again (window, drawer, zoom)
    new ResizeObserver(queueLinks).observe(lanesEl);
    viewEl.querySelector('.tbv-close').onclick = () => { setOpen(false); host.focusToggle(); };
    // 架构图 / 自由画布 leave the board for the board view in that mode; 任务看板 / Token 用量 switch in place.
    viewEl.querySelectorAll('.board-mode button[data-view]').forEach((b) => {
      b.onclick = () => (MODES[b.dataset.view] ? setMode(b.dataset.view) : host.showBoard(b.dataset.view));
    });
    window.TokenUsageUI.init({ prefs: () => host.tokenPrefs(), savePrefs: (p) => host.saveTokenPrefs(p), announce });
    viewEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (detailId) closeDetail(true); else { setOpen(false); host.focusToggle(); }
    });
  }

  window.TaskBoardUI = {
    init,
    isOpen: () => open,
    // open() shows the board; open('tokens') shows Token 用量.
    open: (which) => { setMode(which === 'tokens' ? 'tokens' : 'tasks'); setOpen(true); },
    mode: () => mode,
    close: () => setOpen(false),
    // the sidebar's 任务看板 entry: closes the board, or brings it back from Token 用量
    toggle: () => { if (open && mode === 'tasks') setOpen(false); else { setMode('tasks'); setOpen(true); } },
    redraw: () => { if (open) render(); },
  };
})();
