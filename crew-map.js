// 终端架构图 (crew map): the default face of the board view. A canvas: drag
// the background to pan, Cmd/Ctrl+wheel (or pinch) to zoom, drag a card to
// move it; positions and the view are kept in config.crewMap. 队长 sends work
// down (派出), reviews run down from what they review (审查), results run
// back around into 队长's side (收回). A projection only: drawing it never
// touches a terminal; clicking a card opens that real column.
//
// Arrangement and view are one system with two layers:
// - Where things stand. Untouched, the map arranges itself for the window:
//   project frames side by side in lanes, the plan that shows everything
//   largest (CrewMapCore.planLanes). Once the user drags a card or a frame,
//   that plan is kept under their moves until they tidy, so a window resize
//   never pulls the ground from under a hand-placed map.
// - How it is seen. Untouched, the view fits the map to the window, never
//   below FIT_MIN; once the user pans or zooms, it is theirs.
// 一键整理 puts every frame and card back on the grid in the order the frames
// were left in, and leaves a hand-set zoom alone. 智能一页 hands both layers
// back: arrangement, order and zoom are worked out again for this window.
// Either can be undone until the next move by hand.
(function () {
  'use strict';
  const C = window.CrewMapCore;
  const SVG = 'http://www.w3.org/2000/svg';
  const NODE = { nodeW: 280, nodeH: 172, captainW: 420, captainH: 104, gapX: 24, clusterGap: 32, fanY: 48, gapY: 20, pad: 16, lane: 12 };
  const GRID = { padX: 24, padBottom: 20, rowGap: 20, reviewGap: 40 };   // card grid inside a project
  // Auto-fit never shrinks below this: card body text (13px) stays at 11px or more on screen.
  // What does not fit at this scale is reached by panning (drag, wheel, trackpad).
  const FIT_MIN = 0.85;
  // A small map grows a little to fill its page, never more than this.
  const FIT_MAX = 1.15;
  const MOVE_MS = 280;    // frames and cards gliding to a new place (shorter than the view's own glide)
  // Spacing given up when the roomy map just misses the window at FIT_MIN and this brings all of it in.
  const TIGHT = { captainH: 92, fanY: 40, rowGap: 12, padBottom: 12 };
  const DRAG_PX = 4;
  let host = null;
  let viewEl, rootEl, vpEl, canvasEl, edgesEl, zonesEl, projectsEl, nodesEl, emptyEl, zoomLabel, archBtn, returnBtn, undoBtn, hintEl, trayEl, popEl;
  let mode = 'crew';
  let showArchived = false;
  let showReturn = false;
  let lastSig = '';
  let lastMap = null;
  let lay = null;
  let dims = NODE;          // NODE with 队长's width (and height, when its tally wraps) for the current tally
  let capWrap = false;      // 队长's tally stands on two rows (a narrow window)
  const CAP_ROW = 46;       // what the second row adds to 队长's height
  let view = null;          // { x, y, scale }
  let drag = null;          // a card or the canvas being dragged
  let userView = false;     // the user panned or zoomed: live updates leave the view alone
  let prevActive = null;    // active session ids per project at the last render (reopenOnActivity)
  let routeList = [];       // the lines last drawn, for the hover highlight
  let hoverId = null;
  let popId = null;         // the session whose detail popover is open
  let smoothT = 0;
  let plan = null;          // the arrangement in use: { lanes, caps, tight }
  let pageFits = true;      // the whole map shows at FIT_MIN or better in this window
  let undo = null;          // what 一键整理 / 智能一页 replaced, until the next move by hand
  let hintT = 0;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const saved = () => host.config.crewMap;

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  // The ledger's own sources: 队长's task list, the live columns, the archive.
  function collect() {
    const main = host.mainCol();
    const s = host.mainState();
    const terms = host.terms;
    const info = (col) => host.agentInfo(col, terms.get(col.id)) || {};
    const columns = host.columns().filter((c) => !c.isMain).map((c) => {
      const entry = terms.get(c.id);
      const i = info(c);
      return {
        id: c.id, title: host.columnLabel(c), alive: !!(entry && entry.alive), state: entry ? entry.state || 'plain' : 'plain',
        live: entry && entry.lastScreen ? host.activityLine(entry.lastScreen) : '',
        provider: i.provider || '', model: i.shortModel || '', lastReceipt: c.lastReceipt || null, captainCrew: !!c.captainCrew, project: c.project, reviews: c.reviews,
        important: host.isPriority(c),
      };
    });
    const archived = (host.config.archived || []).map((a) => {
      const i = info(a);
      return { id: a.id, title: host.columnLabel(a), provider: i.provider || '', model: i.shortModel || '', lastReceipt: a.lastReceipt || null, captainCrew: !!a.captainCrew, project: a.project, reviews: a.reviews, archivedAt: a.archivedAt || 0 };
    });
    // work still waiting for a slot has no column: its own record (or its card) says whether it is 高优先级
    const tasks = ((s && s.tasks) || []).map((t) => (t && t.status === 'waiting' && !t.colId && host.isHigh(t) ? { ...t, important: true } : t));
    let captain = null;
    if (main) {
      const entry = terms.get(main.id);
      const i = info(main);
      captain = { id: main.id, title: host.columnLabel(main), alive: !!(entry && entry.alive), state: entry ? entry.state : 'plain', provider: i.provider || '', model: i.shortModel || '' };
    }
    return C.buildCrewMap({ captain, columns, archived, tasks, showArchived });
  }

  function badge(node) {
    const b = el('span', 'cm-agent');
    if (!node.provider && !node.model) return b;
    const col = host.findColumn(node.id);
    if (col) {
      const inner = el('span');
      host.renderBadge(inner, col);
      if (!inner.hidden && inner.childNodes.length) { b.appendChild(inner); return b; }
    }
    b.textContent = [node.provider, node.model].filter(Boolean).join(' · ');
    return b;
  }

  function card(node, box) {
    const captain = node.kind === 'captain', waiting = node.kind === 'waiting';
    const n = el('div', `cm-node st-${node.status} kind-${node.kind}${node.archived ? ' archived' : ''}${node.review ? ' review' : ''}`);
    n.setAttribute('role', 'button');
    n.tabIndex = 0;
    n.dataset.nodeId = node.id;
    n.dataset.status = node.status;
    place(n, box);
    const top = el('div', 'cm-top');
    const st = el('span', 'cm-status');
    // A card has room for one short status beside the model badge: the precise half (等终端就绪) when there is one.
    // The icon and colour still say which kind it is; the tooltip and the detail popover carry both halves.
    st.append(icon(node.status, 'cm-dot'), el('span', 'cm-status-text', node.detail || node.statusLabel));
    st.title = node.statusLabel + (node.detail ? ' · ' + node.detail : '');
    top.append(st, badge(node));
    const title = el('div', 'cm-title', node.title);
    if (node.important) {
      // 高优先级: a solid flag chip in its own colour, leading the title; the top row keeps the status and the model.
      const flag = el('span', 'cm-prio');
      flag.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 21V4"/><path d="M5.5 4.6h12l-2.7 4 2.7 4h-12z" fill="currentColor"/></svg>';
      flag.append(el('span', '', '高优'));
      flag.setAttribute('role', 'img');
      flag.title = '高优先级：你点名要优先做的事';
      flag.setAttribute('aria-label', '高优先级');
      title.prepend(flag);
      n.classList.add('prio');
    }
    const line = el('div', 'cm-line', node.line || (waiting ? '同时干活的会话满了，有空位就自动开' : node.status === 'working' ? '干活中，还没有回执' : captain ? '' : '还没有回执'));
    line.classList.toggle('empty', !node.line);
    const liveLine = el('div', 'cm-live', node.live ? '▸ ' + node.live : '');
    liveLine.hidden = !node.live;
    const foot = el('div', 'cm-foot');
    foot.hidden = captain || waiting;
    if (!foot.hidden) {
      const clock = el('span', 'cm-time');
      clock.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.7V8l2.2 1.5"/></svg>';
      clock.append(el('span', '', ago(node.ts)));
      foot.append(clock);
      if (node.returned) {
        const returned = el('span', 'cm-returned', '✓ 已交回');
        returned.title = '结果已交回队长';
        foot.appendChild(returned);
      }
      if (node.status === 'failed') {
        const look = el('button', 'cm-view', '查看');
        look.type = 'button';
        look.title = `查看失败详情：${node.title}`;
        look.setAttribute('aria-label', look.title);
        look.innerHTML += '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
        guard(look, () => togglePop(node.id));
        foot.appendChild(look);
      }
    }
    n.append(top, title, line, liveLine, foot);
    if (captain) {
      tally(line, node.line);
      const crest = el('i', 'cm-crest');
      crest.setAttribute('aria-hidden', 'true');
      crest.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8 4.2 3.6L12 5l4.3 6.6L20.5 8l-1.7 9.5H5.2z"/><path d="M6 20.5h12"/></svg>';
      n.prepend(crest);
    }
    if (!captain && !waiting) {
      const more = el('button', 'cm-more');
      more.type = 'button';
      more.title = '详情';
      more.setAttribute('aria-label', `查看详情：${node.title}`);
      more.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3.2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.8" cy="8" r="1.4"/></svg>';
      guard(more, () => togglePop(node.id));
      n.appendChild(more);
    }
    n.title = (node.important ? '【高优先级】' : '') + (waiting ? node.title : `${node.title}\n${node.archived ? '点击：恢复这个会话并打开它的终端' : '点击：打开这个会话的终端列'}\n拖动：移动卡片`);
    n.addEventListener('pointerdown', (e) => startCardDrag(e, n, node, box));
    n.addEventListener('click', (e) => {
      if (n.dataset.dragged) { delete n.dataset.dragged; e.preventDefault(); return; }
      if (!waiting) host.open(node);
    });
    n.addEventListener('keydown', (e) => {
      if (e.target === n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (!waiting) host.open(node); }
    });
    if (!captain) {
      n.addEventListener('pointerenter', () => hover(node.id));
      n.addEventListener('pointerleave', () => hover(null));
      n.addEventListener('focusin', () => hover(node.id));
      n.addEventListener('focusout', () => hover(null));
    }
    return n;
  }
  // A button inside a card: it neither drags nor opens the column; it does its own thing.
  function guard(btn, fn) {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('keydown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn(); });
  }
  // One icon per status, used on cards, in 队长's tally, the project counts and the legend.
  // 干活中 is a spinner: it turns for as long as the work runs.
  const ICON = {
    working: '<circle cx="8" cy="8" r="5.6" opacity=".25"/><path d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6"/>',
    input: '<path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.6v3M8 11.2v.1"/>',
    queued: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>',
    done: '<circle cx="8" cy="8" r="5.6"/><path d="m5.4 8.2 1.8 1.8 3.4-3.6"/>',
    failed: '<circle cx="8" cy="8" r="5.6"/><path d="m6 6 4 4m0-4-4 4"/>',
    stopped: '<circle cx="8" cy="8" r="5.6"/><path d="M6.4 6v4M9.6 6v4"/>',
    idle: '<circle cx="8" cy="8" r="5.6" opacity=".35"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/>',
  };
  function icon(status, cls) {
    const i = el('i', `cm-ico st-${status}${cls ? ' ' + cls : ''}`);
    i.setAttribute('aria-hidden', 'true');
    i.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[status] || ICON.idle}</svg>`;
    return i;
  }
  // 「7 干活中 · 2 排队」 as icon + number + label chips. The text stays exactly C.summaryLine's.
  const STATUS_OF = Object.fromEntries(Object.entries(C.STATUS_LABEL).map(([k, v]) => [v, k]));
  const tallyParts = (text) => { const parts = String(text || '').split(' · ').map((p) => /^(\d+) (.+)$/.exec(p)); return parts.every((m) => m && STATUS_OF[m[2]]) ? parts : null; };
  function tally(host, text) {
    const parts = tallyParts(text);
    if (!parts) return;
    host.textContent = '';
    host.classList.add('cm-tally');
    parts.forEach((m, i) => {
      if (i) host.append(el('span', 'cm-count-sep', ' · '));
      const st = STATUS_OF[m[2]], item = el('span', 'cm-count st-' + st);
      item.title = m[0];
      item.append(icon(st), el('b', '', m[1]), el('span', 'cm-count-label', ' ' + m[2]));
      host.append(item);
    });
  }
  // 队长 grows with its tally, so every count keeps its label.
  function captainWidth(map) {
    const parts = map.captain && tallyParts(map.captain.line);
    if (!parts) return NODE.captainW;
    return Math.max(NODE.captainW, 104 + parts.reduce((w, m) => w + 62 + m[1].length * 13 + m[2].length * 13.5, 0) + (parts.length - 1) * 8);
  }
  function place(n, box) { Object.assign(n.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' }); }

  // ---- lines ----
  function rounded(points, r = 10) {
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
      const r1 = Math.min(r, Math.hypot(x - px, y - py) / 2), r2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
      const a = [x - Math.sign(x - px) * r1, y - Math.sign(y - py) * r1];
      const b = [x + Math.sign(nx - x) * r2, y + Math.sign(ny - y) * r2];
      d += ` L ${a[0]} ${a[1]} Q ${x} ${y} ${b[0]} ${b[1]}`;
    }
    const last = points[points.length - 1];
    return d + ` L ${last[0]} ${last[1]}`;
  }
  function svg(tag, attrs, parent) {
    const n = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    (parent || edgesEl).appendChild(n);
    return n;
  }
  // Direction marks along a long line: a small chevron mid-way on each long stretch.
  function chevrons(points, cls, parent) {
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      if (Math.hypot(x2 - x1, y2 - y1) < 140) continue;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      svg('path', { class: 'cm-chevron ' + cls, d: 'M -5 -5 L 2 0 L -5 5', transform: `translate(${mx} ${my}) rotate(${ang})` }, parent);
    }
  }
  const MARK = { review: 'cmArrowReview', ok: 'cmArrowBack', question: 'cmArrowBackBad', failed: 'cmArrowBackBad' };
  // finished lines underneath, live ones on top: a shared bus shows its busiest state
  const RANK = { done: 0, stopped: 0, failed: 0, idle: 0, queued: 1, input: 2, working: 3 };
  const stOf = (r) => (/\bst-(\w+)/.exec(r.cls) || [])[1] || 'idle';
  function setShowReturn(v) { showReturn = !!v; saved().showReturn = showReturn; returnBtn.setAttribute('aria-pressed', String(showReturn)); returnBtn.classList.toggle('on', showReturn); host.save(); redrawEdges(); if (!userView) fit(true); }
  function drawEdges() {
    edgesEl.innerHTML = '<defs>' + Object.values(MARK).filter((v, i, a) => a.indexOf(v) === i).map((id) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>`).join('') + '</defs>';
    const list = routeList = C.routes(lastMap, lay, dims);
    const layer = (cls) => svg('g', { class: cls });
    const returns = layer('cm-returns'), reviews = layer('cm-reviews');
    const halos = layer('cm-halos'), lines = layer('cm-lines'), pulses = layer('cm-pulses'), core = layer('cm-spine'), dots = layer('cm-dots');
    layer('cm-lit');   // the hovered card's own path, on top of everything else
    list.filter((r) => r.type === 'return').forEach((r) => {
      svg('path', { class: 'cm-edge ' + r.cls + (showReturn ? ' show' : ''), d: rounded(r.points), 'marker-end': `url(#${MARK[r.kind]})`, 'data-from': r.from, 'data-to': r.to }, returns);
      if (showReturn) chevrons(r.points, r.cls, returns);
    });
    list.filter((r) => r.type === 'review').forEach((r) => {
      svg('path', { class: 'cm-edge ' + r.cls, d: rounded(r.points), 'marker-end': `url(#${MARK.review})`, 'data-from': r.from, 'data-to': r.to }, reviews);
    });
    list.filter((r) => r.type === 'dispatch').sort((a, b) => RANK[stOf(a)] - RANK[stOf(b)]).forEach((r) => {
      const d = rounded(r.branch), style = `--project-hue: ${C.projectHue(r.project)}`;
      const live = stOf(r) === 'working' && !/\barchived\b/.test(r.cls);
      if (live) svg('path', { class: 'cm-halo', d, style }, halos);
      svg('path', { class: 'cm-edge ' + r.cls, d, style, 'data-from': r.from, 'data-to': r.to }, lines);
      if (live) svg('path', { class: 'cm-pulse', d, style }, pulses);
      const [x, y] = r.points[r.points.length - 1];
      svg('circle', { class: 'cm-socket ' + r.cls, cx: x, cy: y, r: 3, style }, dots);
    });
    // trunk and main bus once, in the core colour, over the bundled lines
    const sp = C.spine(list);
    if (!sp) { hover(hoverId); return; }
    const bus = (pts, cls, active) => {
      const d = rounded(pts);
      if (active) svg('path', { class: 'cm-halo core', d }, halos);
      svg('path', { class: `cm-bus ${cls}${active ? ' active' : ''}`, d }, core);
      if (active) svg('path', { class: 'cm-pulse core', d }, core);
    };
    bus(sp.trunk, 'trunk', sp.active);
    if (sp.left) bus(sp.left.points, 'arm', sp.left.active);
    if (sp.right) bus(sp.right.points, 'arm', sp.right.active);
    sp.takeoffs.forEach(([x, y]) => svg('circle', { class: 'cm-joint', cx: x, cy: y, r: 2.6 }, dots));
    svg('circle', { class: 'cm-hub-ring' + (sp.active ? ' active' : ''), cx: sp.hub[0], cy: sp.hub[1], r: 9 }, dots);
    svg('circle', { class: 'cm-hub' + (sp.active ? ' active' : ''), cx: sp.hub[0], cy: sp.hub[1], r: 4.5 }, dots);
    hover(hoverId);
  }
  // Hovering a card lights its own path and dims the rest of the wiring.
  function hover(id) {
    hoverId = id || null;
    const lit = edgesEl.querySelector('.cm-lit');
    edgesEl.querySelectorAll('.hl').forEach((p) => p.classList.remove('hl'));
    if (lit) lit.innerHTML = '';
    edgesEl.classList.toggle('cm-hovering', !!hoverId && !!lit);
    if (!hoverId || !lit) return;
    const mine = routeList.filter((r) => (r.from === hoverId || r.to === hoverId) && (r.type !== 'return' || showReturn));
    mine.forEach((r) => svg('path', { class: 'cm-hl-path ' + r.type, d: rounded(r.points) }, lit));
    edgesEl.querySelectorAll('.cm-edge').forEach((p) => { if (p.dataset.from === hoverId || p.dataset.to === hoverId) p.classList.add('hl'); });
  }
  function redrawEdges() { if (lay) drawEdges(); }
  // Two layers per project: the tinted pane under the wiring (zones) and a
  // transparent frame over it (projects) that carries the title strip, so a line
  // passing the strip goes behind the labels instead of through them.
  function drawGroups() {
    zonesEl.innerHTML = '';
    projectsEl.innerHTML = '';
    lay.groups.forEach((g) => {
      const hue = String(C.projectHue(g.key));
      const pane = el('div', 'cm-pane' + (g.collapsed ? ' collapsed' : ''));
      pane.dataset.project = g.key;
      pane.style.setProperty('--project-hue', hue);
      place(pane, g);
      zonesEl.appendChild(pane);
      const group = el('section', 'cm-project' + (g.collapsed ? ' collapsed' : ''));
      group.dataset.project = g.key;
      group.style.setProperty('--project-hue', hue);
      group.setAttribute('aria-label', g.name);
      place(group, g);
      const head = el('div', 'cm-project-head');
      const toggle = el('button', 'cm-project-toggle');
      toggle.type = 'button';
      const action = g.collapsed ? '展开' : '折叠';
      toggle.title = `${action}项目：${g.name}`;
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(!g.collapsed));
      toggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${g.collapsed ? 'm9 5 7 7-7 7' : 'm5 9 7 7 7-7'}"/></svg>`;
      toggle.addEventListener('click', () => {
        saved().collapsedProjects = { ...saved().collapsedProjects, [g.key]: !g.collapsed };
        host.save();
        render({ smooth: true });
      });
      const summary = el('span', 'cm-project-summary', C.summaryLine(g.counts));
      summary.title = summary.textContent;
      tally(summary, summary.textContent);
      const name = el('span', 'cm-project-name', g.name);
      name.title = g.name;
      head.append(toggle, name, summary);
      head.title = '拖动：移动项目和其中的卡片';
      group.addEventListener('pointerdown', (e) => startProjectDrag(e, group, g));
      group.appendChild(head);
      projectsEl.appendChild(group);
      // the full tally does not fit beside the whole name: the tally drops its labels (the frame was laid out wide enough for that)
      if (summary.scrollWidth > summary.clientWidth || name.scrollWidth > name.clientWidth) head.classList.add('compact');
    });
  }

  // ---- canvas view ----
  function applyView() {
    canvasEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    const pct = Math.round(view.scale * 100) + '%';
    zoomLabel.textContent = pct;
    zoomLabel.setAttribute('aria-label', `回到 100%（当前 ${pct}）`);
    placePop();
  }
  function saveView() { saved().view = { ...view }; host.save(); }
  // A short glide for the moves the user asked for (适应画布, 整理, a project
  // opened from the tray); first arrival and window resizes land at once.
  function glide(on) {
    clearTimeout(smoothT);
    canvasEl.classList.toggle('cm-smooth', !!on);
    if (on) smoothT = setTimeout(() => canvasEl.classList.remove('cm-smooth'), 400);
  }
  // Where the window's bottom edge (the tray, the legend row) cuts a map too tall for it:
  // a card shows whole with 16px to spare above the edge, or is plainly cut (24px or more
  // of it out of sight), never flush against the edge. The 16px kept above 队长 gives way
  // for the first; the map slides down for the second.
  function cutShift(v) {
    const clear = 16 * v.scale, cut = 24 * v.scale;
    const gaps = [...lay.nodes.values()].map((b) => vpEl.clientHeight - (v.y + (b.y + b.h) * v.scale)).filter((g) => g > -cut && g < clear);
    if (!gaps.length) return 0;
    const whole = gaps.filter((g) => g >= 0);
    return whole.length ? Math.min(...whole) - clear : cut + Math.max(...gaps);
  }
  // Actual bounds of a layout, including manual moves, gap-routed lines and optional return cables.
  const FIT_INSET = { top: 8, right: 8, bottom: 8, left: 8 };
  function fitBounds(l) {
    const boxes = [l.captain, ...l.groups, ...l.nodes.values(), l.fold].filter(Boolean);
    const points = C.routes(lastMap, l, dims).filter((r) => r.type !== 'return' || showReturn).flatMap((r) => r.points);
    return {
      left: Math.min(...boxes.map((b) => b.x), ...points.map((p) => p[0])) - 16,
      top: Math.min(...boxes.map((b) => b.y), ...points.map((p) => p[1])) - 16,
      right: Math.max(...boxes.map((b) => b.x + b.w), ...points.map((p) => p[0])) + 16,
      bottom: Math.max(...boxes.map((b) => b.y + b.h), ...points.map((p) => p[1])) + 16,
    };
  }
  function fit(smooth) {
    if (!lay) return;
    const bounds = fitBounds(lay), inset = FIT_INSET;
    view = C.computeFit(bounds, { w: vpEl.clientWidth, h: vpEl.clientHeight }, inset, { min: FIT_MIN, max: FIT_MAX });
    // held at the floor and still too tall: start at the top (队长 and the first rows), not mid-map
    if ((bounds.bottom - bounds.top) * view.scale > vpEl.clientHeight - inset.top - inset.bottom) {
      view.y = inset.top - bounds.top * view.scale;
      view.y += cutShift(view);
    }
    userView = false;
    glide(smooth === true);
    applyView();
    saveView();
  }

  // What each project's header needs to show its whole name beside its tally in the short form
  // (icons and numbers). The layout keeps every frame at least that wide, so a name is cut only
  // when it alone is longer than HEAD_MAX.
  const HEAD_MAX = 2 * NODE.nodeW + NODE.gapX + 2 * GRID.padX;
  function headNeeds(map) {
    const probes = map.projects.map((p) => {
      const head = el('div', 'cm-project-head compact cm-probe');
      const text = C.summaryLine(p.counts), summary = el('span', 'cm-project-summary', text);
      tally(summary, text);
      head.append(el('button', 'cm-project-toggle'), el('span', 'cm-project-name', p.name), summary);
      projectsEl.appendChild(head);
      return [p.key, head];
    });
    const out = {};
    probes.forEach(([key, head]) => { out[key] = Math.min(HEAD_MAX, head.offsetWidth + 2); });
    probes.forEach(([, head]) => head.remove());
    return out;
  }

  const hasManual = () => Object.keys(saved().positions).length > 0 || Object.keys(saved().projectPositions).length > 0;
  // The layout for this render. Nothing hand-placed: the plan that shows the whole map
  // largest in this window (the plan in use is kept while it is nearly as good). Something
  // hand-placed: the plan those moves were made on, whatever the window is now.
  function arrange(map) {
    const vw = vpEl.clientWidth, vh = vpEl.clientHeight;
    const base = { ...dims, ...GRID, fold: map.hiddenArchived > 0, collapsedProjects: saved().collapsedProjects, order: saved().projectOrder, grid: true, center: true, tray: true, headW: headNeeds(map) };
    const tightly = { ...TIGHT, captainH: TIGHT.captainH + (capWrap ? CAP_ROW : 0) };
    const build = (p) => C.layout(map, { ...base, ...(p.tight ? tightly : {}), lanes: p.lanes, caps: p.caps });
    const whole = (l) => C.computeFit(fitBounds(l), { w: vw, h: vh }, FIT_INSET, { min: 0, max: 1 }).scale >= FIT_MIN;
    const pinned = hasManual() ? saved().plan : null;
    if (pinned) {
      const l = build(pinned), keys = new Set(pinned.lanes.flat());
      // still the same projects on the canvas: the hand-placed map keeps its ground
      if (l.groups.length === keys.size && l.groups.every((g) => keys.has(g.key))) { plan = pinned; pageFits = whole(l); return l; }
    }
    if (!hasManual() && saved().plan) { saved().plan = null; host.save(); }   // nothing hand-placed is left to stand on it
    const size = { w: vw - FIT_INSET.left - FIT_INSET.right, h: vh - FIT_INSET.top - FIT_INSET.bottom };
    const pick = (tight) => {
      const p = C.planLanes(map, size, { ...base, ...(tight ? tightly : {}), floor: FIT_MIN, max: FIT_MAX }, plan && !!plan.tight === tight ? plan : null);
      const next = { lanes: p.lanes, caps: p.caps, tight };
      return { plan: next, lay: build(next) };
    };
    // Roomy while the whole map shows at FIT_MIN or better; tight when only that brings
    // it all in; a map too tall either way stays roomy and is panned.
    let chosen = pick(false);
    pageFits = whole(chosen.lay);
    if (!pageFits) { const tight = pick(true); if (whole(tight.lay)) { chosen = tight; pageFits = true; } }
    plan = chosen.plan;
    if (hasManual()) { saved().plan = plan; host.save(); }
    return chosen.lay;
  }
  function zoomAt(cx, cy, factor) {
    const scale = Math.min(C.MAX_SCALE, Math.max(C.MIN_SCALE, view.scale * factor));
    const k = scale / view.scale;
    view = { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
    userView = true;
    glide(false);
    applyView();
    saveView();
  }
  function zoomCenter(factor) { zoomAt(vpEl.clientWidth / 2, vpEl.clientHeight / 2, factor); }

  function startCardDrag(e, n, node, box) {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag = { kind: 'card', n, node, box, sx: e.clientX, sy: e.clientY, x0: box.x, y0: box.y, moved: false, id: e.pointerId };
    n.setPointerCapture(e.pointerId);
  }
  function startProjectDrag(e, n, group) {
    if (e.button !== 0 || e.target.closest('.cm-project-toggle')) return;
    e.stopPropagation();
    drag = { kind: 'project', n, group, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, id: e.pointerId };
    n.setPointerCapture(e.pointerId);
  }
  function startPan(e) {
    if (e.button !== 0 || e.target.closest('.cm-node, .cm-fold, .cm-pop, .cm-project-toggle')) return;
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, x0: view.x, y0: view.y, moved: false, id: e.pointerId };
    vpEl.setPointerCapture(e.pointerId);
    vpEl.classList.add('panning');
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    drag.moved = true;
    if (drag.kind === 'pan') {
      view = { ...view, x: drag.x0 + dx, y: drag.y0 + dy };
      glide(false);
      applyView();
      return;
    }
    if (drag.kind === 'project') {
      const dxNext = Math.round(dx / view.scale), dyNext = Math.round(dy / view.scale);
      C.translateProject(lay, drag.group.key, dxNext - drag.dx, dyNext - drag.dy);
      drag.dx = dxNext; drag.dy = dyNext;
      place(drag.n, drag.group);
      place(zonesEl.querySelector(`.cm-pane[data-project="${CSS.escape(drag.group.key)}"]`), drag.group);
      lay.nodes.forEach((b, id) => { if (b.project === drag.group.key) place(nodesEl.querySelector(`[data-node-id="${CSS.escape(id)}"]`), b); });
      if (lay.fold && lay.fold.project === drag.group.key) place(nodesEl.querySelector('.cm-fold'), lay.fold);
      drawEdges();
      return;
    }
    drag.n.classList.add('dragging');
    Object.assign(drag.box, C.constrainPosition(lay, drag.box, { x: Math.round(drag.x0 + dx / view.scale), y: Math.round(drag.y0 + dy / view.scale) }));
    place(drag.n, drag.box);
    drawEdges();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    vpEl.classList.remove('panning');
    if (!d.moved) return;
    if (d.kind === 'pan') { userView = true; saveView(); return; }
    // a move by hand: the arrangement it was made on stays under it, and what 整理 replaced is gone
    if (!saved().plan && plan) saved().plan = plan;
    setUndo(null);
    if (d.kind === 'project') {
      const old = saved().projectPositions[d.group.key] || { x: 0, y: 0 };
      saved().projectPositions[d.group.key] = { x: old.x + d.dx, y: old.y + d.dy };
      lay.nodes.forEach((b, id) => { if (b.project === d.group.key && saved().positions[id]) saved().positions[id] = { x: b.x, y: b.y }; });
      host.save();
      return;
    }
    d.n.classList.remove('dragging');
    d.n.dataset.dragged = '1';   // the click that ends a drag does not open the column
    setTimeout(() => { delete d.n.dataset.dragged; }, 0);
    saved().positions[d.node.id] = { x: d.box.x, y: d.box.y };
    host.save();
  }
  function onWheel(e) {
    if (mode !== 'crew' || !view || e.target.closest('.cm-pop')) return;
    e.preventDefault();
    const r = vpEl.getBoundingClientRect();
    // a pinch on a trackpad arrives as ctrl+wheel
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
    else {
      view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
      userView = true;
      glide(false);
      applyView();
      clearTimeout(onWheel.t);
      onWheel.t = setTimeout(saveView, 250);
    }
  }

  // ---- bottom tray: projects with nothing running ----
  function setProjectOpen(key, open) {
    saved().collapsedProjects = { ...saved().collapsedProjects, [key]: !open };
    host.save();
  }
  function drawTray(map) {
    const list = C.trayProjects(map, saved().collapsedProjects);
    trayEl.hidden = !list.length;
    trayEl.textContent = '';
    if (!list.length) return;
    const allOpen = list.every((p) => p.expanded);
    const arrow = el('button', 'cm-tray-arrow');
    arrow.type = 'button';
    arrow.title = allOpen ? '全部收起到底部' : '全部展开到画布';
    arrow.setAttribute('aria-label', arrow.title);
    arrow.setAttribute('aria-expanded', String(allOpen));
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    arrow.addEventListener('click', () => { list.forEach((p) => setProjectOpen(p.key, !allOpen)); userView = false; render({ smooth: true }); });
    const label = el('span', 'cm-tray-title');
    label.append(el('b', '', '非活跃项目'), el('span', 'cm-tray-sum', C.traySummary(list)));
    const chips = el('div', 'cm-tray-chips');
    list.forEach((p) => {
      const chip = el('button', 'cm-chip' + (p.failed ? ' failed' : ''));
      chip.type = 'button';
      chip.dataset.project = p.key;
      chip.style.setProperty('--project-hue', String(C.projectHue(p.key)));
      chip.setAttribute('aria-pressed', String(p.expanded));
      chip.title = p.expanded ? `收回到底部：${p.name}` : `展开到画布：${p.name}`;
      chip.setAttribute('aria-label', chip.title);
      chip.append(el('i', 'cm-cube'), el('span', 'cm-chip-name', p.name));
      if (p.failed) { const bad = el('span', 'cm-chip-fail', '✕ ' + p.failed); bad.title = `${p.failed} 个失败`; chip.append(bad); }
      chip.addEventListener('click', () => { setProjectOpen(p.key, !p.expanded); userView = false; render({ smooth: true }); });
      chips.append(chip);
    });
    trayEl.append(arrow, label, chips);
  }

  // ---- detail popover: lives in the viewport, so it never zooms with the canvas ----
  function togglePop(id) { if (popId === id) closePop(); else { popId = id; fillPop(); placePop(); const x = popEl.querySelector('.cm-pop-x'); if (x) x.focus({ preventScroll: true }); } }
  function closePop() {
    if (!popId) return;
    const was = popId;
    popId = null;
    popEl.hidden = true;
    popEl.textContent = '';
    const opener = nodesEl.querySelector(`.cm-node[data-node-id="${CSS.escape(was)}"] .cm-more`);
    if (opener && popEl.contains(document.activeElement)) opener.focus({ preventScroll: true });
  }
  function fillPop() {
    const node = lastMap && lastMap.nodes.find((n) => n.id === popId);
    if (!node || node.kind === 'waiting') { closePop(); return; }
    const hadScroll = popEl.querySelector('.cm-pop-body');
    const scroll = hadScroll ? hadScroll.scrollTop : 0;
    popEl.hidden = false;
    popEl.textContent = '';
    popEl.className = `cm-pop st-${node.status}`;
    popEl.setAttribute('aria-label', `会话详情：${node.title}`);
    const head = el('div', 'cm-pop-head');
    const st = el('span', 'cm-status');
    st.append(icon(node.status), el('span', 'cm-status-text', node.statusLabel + (node.detail ? ' · ' + node.detail : '')));
    const x = el('button', 'cm-pop-x');
    x.type = 'button';
    x.title = '关闭 (Esc)';
    x.setAttribute('aria-label', '关闭详情');
    x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    x.addEventListener('click', closePop);
    head.append(st, badge(node), x);
    const body = el('div', 'cm-pop-body');
    body.append(el('h3', 'cm-pop-title', node.title));
    const receipt = el('div', 'cm-pop-receipt' + (node.full ? '' : ' empty'), node.full || '还没有回执');
    body.append(receipt);
    if (node.live) body.append(el('div', 'cm-pop-live', '▸ ' + node.live));
    if (node.files && node.files.length) {
      const files = el('ul', 'cm-pop-files');
      node.files.slice(0, 12).forEach((f) => { const li = el('li', '', f.split(/[\\/]/).pop() || f); li.title = f; files.append(li); });
      body.append(files);
    }
    const foot = el('div', 'cm-pop-foot');
    foot.append(el('span', 'cm-time', ago(node.ts)));
    const open = el('button', 'cm-pop-open', node.archived ? '恢复并打开终端' : '打开终端');
    open.type = 'button';
    open.addEventListener('click', () => { closePop(); host.open(node); });
    foot.append(open);
    popEl.append(head, body, foot);
    body.scrollTop = scroll;
  }
  // beside the card, clamped into the viewport
  function placePop() {
    if (!popId || popEl.hidden) return;
    const box = lay && lay.nodes.get(popId);
    if (!box || !view) return;
    const s = view.scale, vw = vpEl.clientWidth, vh = vpEl.clientHeight;
    const left = view.x + box.x * s, right = left + box.w * s, topY = view.y + box.y * s;
    const W = popEl.offsetWidth, H = popEl.offsetHeight;
    let x = right + 10;
    if (x + W > vw - 8) x = left - W - 10;
    if (x < 8) x = Math.min(Math.max(8, left + (right - left) / 2 - W / 2), vw - W - 8);
    popEl.style.left = Math.max(8, x) + 'px';
    popEl.style.top = Math.max(8, Math.min(vh - H - 8, topY)) + 'px';
  }

  function render(opts) {
    if (!rootEl || mode !== 'crew' || !host.visible() || drag) return;
    const map = collect();
    lastMap = map;
    lastSig = C.signature(map) + '|' + showArchived;
    // new activity in a folded project brings it back; the view is not touched
    const re = C.reopenOnActivity(prevActive, map.projects, saved().collapsedProjects);
    prevActive = re.active;
    if (JSON.stringify(re.overrides) !== JSON.stringify(saved().collapsedProjects)) { saved().collapsedProjects = re.overrides; host.save(); }
    archBtn.hidden = !map.archivedCount;
    archBtn.classList.toggle('on', showArchived);
    archBtn.setAttribute('aria-pressed', String(showArchived));
    archBtn.title = showArchived ? `收起已归档（${map.archivedCount}）` : `显示已归档（${map.archivedCount}）`;
    archBtn.setAttribute('aria-label', archBtn.title);
    returnBtn.classList.toggle('on', showReturn);
    drawTray(map);
    hoverId = null;
    const before = opts && opts.smooth && lay && !reduceMotion() ? places() : null;
    nodesEl.innerHTML = '';
    emptyEl.hidden = !!map.captain;
    if (!map.captain) { edgesEl.innerHTML = ''; zonesEl.innerHTML = ''; projectsEl.innerHTML = ''; lay = null; closePop(); return; }
    // A window narrower than 队长's one-row tally at the smallest readable size: the card takes the
    // width there is and its tally wraps to a second row, so no count is cut and nothing scrolls sideways.
    const natural = Math.round(captainWidth(map));
    const room = Math.floor((vpEl.clientWidth - FIT_INSET.left - FIT_INSET.right) / FIT_MIN - 2 * NODE.pad);
    capWrap = natural > room && room >= NODE.captainW;
    rootEl.classList.toggle('cm-cap-wrap', capWrap);
    dims = { ...NODE, captainW: capWrap ? room : natural, captainH: NODE.captainH + (capWrap ? CAP_ROW : 0) };
    lay = C.applyPositions(arrange(map), saved().positions, map.captain.id, saved().projectPositions);
    canvasEl.style.width = lay.width + 'px';
    canvasEl.style.height = lay.height + 'px';
    drawGroups();
    drawEdges();
    nodesEl.appendChild(card(map.captain, lay.captain));
    map.nodes.forEach((n) => { if (lay.nodes.has(n.id)) nodesEl.appendChild(card(n, lay.nodes.get(n.id))); });
    if (lay.fold) {
      const fold = el('button', 'cm-fold', `+ ${map.hiddenArchived} 个已归档`);
      fold.type = 'button';
      fold.title = '已归档的会话默认折起来；点开淡显出来';
      place(fold, lay.fold);
      fold.addEventListener('click', () => setShowArchived(true));
      nodesEl.appendChild(fold);
    }
    // fit on arrival and while the user has not moved the view; after that it stays put
    if (!view || !userView) fit(!!(opts && opts.smooth)); else applyView();
    if (before) settle(before);
    if (popId) { fillPop(); placePop(); }
  }

  // ---- 一键整理, 智能一页, 撤销 ----
  const reduceMotion = () => document.documentElement.dataset.motion === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Where every frame and card stands (canvas coordinates), to glide from after a redraw.
  function places() {
    const at = new Map();
    if (lay.captain && lastMap.captain) at.set('node:' + lastMap.captain.id, { x: lay.captain.x, y: lay.captain.y });
    lay.nodes.forEach((b, id) => at.set('node:' + id, { x: b.x, y: b.y }));
    lay.groups.forEach((g) => at.set('group:' + g.key, { x: g.x, y: g.y }));
    return at;
  }
  // Frames and cards glide from where they stood to where they stand now; the lines fade back in
  // once they have landed. A card that was not on the map fades in.
  function settle(before) {
    const ease = 'cubic-bezier(.2, .8, .2, 1)';
    const move = (n, key, box) => {
      const was = before.get(key);
      if (!was) { n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOVE_MS, easing: 'ease-out' }); return 0; }
      const dx = was.x - box.x, dy = was.y - box.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return 0;
      n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: ease });
      return 1;
    };
    let moved = 0;
    nodesEl.querySelectorAll('.cm-node').forEach((n) => { const id = n.dataset.nodeId; moved += move(n, 'node:' + id, lay.nodes.get(id) || lay.captain); });
    lay.groups.forEach((g) => [zonesEl.querySelector(`.cm-pane[data-project="${CSS.escape(g.key)}"]`), projectsEl.querySelector(`.cm-project[data-project="${CSS.escape(g.key)}"]`)]
      .forEach((n) => { if (n) moved += move(n, 'group:' + g.key, g); }));
    if (moved) edgesEl.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: MOVE_MS + 60, easing: 'ease-out' });
  }
  function setUndo(snap) {
    undo = snap || null;
    undoBtn.hidden = !undo;
  }
  const snapshot = () => ({ positions: { ...saved().positions }, projectPositions: { ...saved().projectPositions }, projectOrder: saved().projectOrder.slice(), plan: saved().plan, view: view && { ...view }, userView });
  function say(text) {
    clearTimeout(hintT);
    hintEl.textContent = text || '';
    hintEl.hidden = !text;
    if (text) hintT = setTimeout(() => { hintEl.hidden = true; }, 6000);
  }
  // 一键整理: every frame and card back on the grid, in the order the frames stand in now.
  // The zoom is left alone when the user has set one.
  function tidy() {
    if (!lay) return;
    const snap = hasManual() ? snapshot() : null;
    // the order the map would use by itself needs no remembering
    const order = C.orderByPlace(lay.groups), usual = lastMap.projects.map((p) => p.key).filter((key) => order.includes(key));
    Object.assign(saved(), { positions: {}, projectPositions: {}, plan: null, projectOrder: order.join('\u0001') === usual.join('\u0001') ? [] : order });
    host.save();
    render({ smooth: true });
    setUndo(snap);
    say('');
  }
  // 智能一页: arrangement, order and zoom worked out again for this window, so the whole map
  // fills one page. When it cannot at readable size, it stays readable and says so.
  function page() {
    if (!lay) return;
    const snap = hasManual() || saved().projectOrder.length || userView ? snapshot() : null;
    Object.assign(saved(), { positions: {}, projectPositions: {}, plan: null, projectOrder: [] });
    plan = null;
    userView = false;
    host.save();
    render({ smooth: true });
    setUndo(snap);
    say(pageFits ? '' : `一页放不下：文字保持在最小可读大小（${Math.round(FIT_MIN * 100)}%），其余部分滚动查看`);
  }
  function undoArrange() {
    const u = undo;
    if (!u) return;
    Object.assign(saved(), { positions: u.positions, projectPositions: u.projectPositions, projectOrder: u.projectOrder, plan: u.plan });
    plan = u.plan;
    userView = u.userView;
    host.save();
    render({ smooth: true });
    if (u.userView && u.view) { view = { ...u.view }; glide(true); applyView(); saveView(); }
    setUndo(null);
    say('');
  }

  // Every status tick: a structural change rebuilds, the rest updates text in place.
  function refresh() {
    if (!rootEl || mode !== 'crew' || !host.visible() || drag) return;
    const map = collect();
    if (C.signature(map) + '|' + showArchived !== lastSig) { render({ smooth: true }); return; }
    lastMap = map;
    map.nodes.forEach((n) => {
      const node = nodesEl.querySelector(`.cm-node[data-node-id="${CSS.escape(n.id)}"]`);
      const live = node && node.querySelector('.cm-live');
      if (!live) return;
      const text = n.live ? '▸ ' + n.live : '';
      if (live.textContent !== text) live.textContent = text;
      live.hidden = !n.live;
    });
    if (popId) { fillPop(); placePop(); }
  }

  function setShowArchived(v) { showArchived = !!v; render(); }

  function setMode(next) {
    mode = next === 'canvas' ? 'canvas' : 'crew';
    saved().mode = mode;
    viewEl.dataset.mode = mode;
    viewEl.querySelectorAll('.board-mode button[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    viewEl.querySelector('.board-kicker').textContent = mode === 'crew' ? '队长 · 实时' : 'Live orchestration';
    viewEl.querySelector('.board-toolbar h1').textContent = mode === 'crew' ? '终端架构图' : 'Conductor Board';
    host.save();
    if (mode === 'crew') { host.leaveCanvas(); render(); } else host.enterCanvas();
  }

  function init(h) {
    host = h;
    host.config.crewMap = C.normalizeSaved(host.config.crewMap);
    showReturn = host.config.crewMap.showReturn || false;
    viewEl = document.getElementById('boardView');
    rootEl = document.getElementById('crewMap');
    vpEl = rootEl.querySelector('.cm-viewport');
    canvasEl = rootEl.querySelector('.cm-canvas');
    zonesEl = rootEl.querySelector('.cm-zones');
    projectsEl = el('div', 'cm-projects');
    rootEl.querySelector('.cm-canvas').insertBefore(projectsEl, rootEl.querySelector('.cm-nodes'));
    edgesEl = rootEl.querySelector('.cm-edges');
    nodesEl = rootEl.querySelector('.cm-nodes');
    emptyEl = rootEl.querySelector('.cm-empty');
    zoomLabel = rootEl.querySelector('[data-cm="reset"]');
    archBtn = rootEl.querySelector('[data-cm="archived"]');
    returnBtn = rootEl.querySelector('[data-cm="return"]');
    undoBtn = rootEl.querySelector('[data-cm="undo"]');
    hintEl = rootEl.querySelector('.cm-hint');
    trayEl = rootEl.querySelector('.cm-tray');
    popEl = rootEl.querySelector('.cm-pop');
    returnBtn.setAttribute('aria-pressed', String(showReturn));
    const on = (name, fn) => rootEl.querySelector(`[data-cm="${name}"]`).addEventListener('click', fn);
    on('archived', () => setShowArchived(!showArchived));
    on('out', () => view && zoomCenter(1 / 1.2));
    on('in', () => view && zoomCenter(1.2));
    on('reset', () => view && zoomCenter(1 / view.scale));
    on('fit', page);
    on('relayout', tidy);
    on('undo', undoArrange);
    on('return', () => setShowReturn(!showReturn));
    returnBtn.classList.toggle('on', showReturn);
    rootEl.querySelectorAll('.cm-legend .cm-key').forEach((k) => k.replaceWith(icon((/st-(\w+)/.exec(k.className) || [])[1])));
    vpEl.addEventListener('pointerdown', (e) => { if (view) startPan(e); });
    // a click anywhere but the popover (or what opens it) and Esc close the popover
    document.addEventListener('pointerdown', (e) => { if (popId && !e.target.closest('.cm-pop, .cm-more, .cm-view')) closePop(); }, true);
    document.addEventListener('keydown', (e) => { if (popId && e.key === 'Escape') { e.stopPropagation(); closePop(); } }, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    vpEl.addEventListener('wheel', onWheel, { passive: false });
    viewEl.querySelectorAll('.board-mode button[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    new ResizeObserver(() => { if (host.visible() && vpEl.clientWidth && !drag) render(); }).observe(vpEl);
    setMode(host.config.crewMap.mode);
  }

  window.CrewMap = { init, render, refresh, fit, relayout: tidy, tidy, page, undo: undoArrange, plan: () => plan && { lanes: plan.lanes.map((l) => l.slice()), caps: { ...plan.caps }, tight: !!plan.tight }, pageFits: () => pageFits, canUndo: () => !!undo, mode: () => mode, setMode, setShowArchived, setShowReturn, lastMap: () => lastMap, view: () => view && { ...view }, userMoved: () => userView, layout: () => lay };
})();
