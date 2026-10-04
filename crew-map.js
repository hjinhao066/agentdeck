// 终端架构图 (crew map): the default face of the board view. A canvas: drag
// the background to pan, Cmd/Ctrl+wheel (or pinch) to zoom, drag a card to
// move it; positions and the view are kept in config.crewMap. 队长 sends work
// down (派出), reviews run down from what they review (审查), results run
// back around into 队长's side (收回). A projection only: drawing it never
// touches a terminal; clicking a card opens that real column.
(function () {
  'use strict';
  const C = window.CrewMapCore;
  const SVG = 'http://www.w3.org/2000/svg';
  const NODE = { nodeW: 240, nodeH: 176, captainW: 420, captainH: 96, gapX: 24, clusterGap: 52, fanY: 64, gapY: 64, pad: 40 };
  const DRAG_PX = 4;
  let host = null;
  let viewEl, rootEl, vpEl, canvasEl, edgesEl, zonesEl, nodesEl, emptyEl, zoomLabel, archBtn, returnBtn;
  let mode = 'crew';
  let showArchived = false;
  let showReturn = false;
  let lastSig = '';
  let lastMap = null;
  let lay = null;
  let view = null;          // { x, y, scale }
  let drag = null;          // a card or the canvas being dragged

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
      };
    });
    const archived = (host.config.archived || []).map((a) => {
      const i = info(a);
      return { id: a.id, title: host.columnLabel(a), provider: i.provider || '', model: i.shortModel || '', lastReceipt: a.lastReceipt || null, captainCrew: !!a.captainCrew, project: a.project, reviews: a.reviews, archivedAt: a.archivedAt || 0 };
    });
    const tasks = (s && s.tasks) || [];
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
    const n = el('button', `cm-node st-${node.status} kind-${node.kind}${node.archived ? ' archived' : ''}${node.review ? ' review' : ''}`);
    n.type = 'button';
    n.dataset.nodeId = node.id;
    n.dataset.status = node.status;
    place(n, box);
    const top = el('div', 'cm-top');
    const st = el('span', 'cm-status');
    st.append(el('i', 'cm-dot'), el('span', 'cm-status-text', node.statusLabel + (node.detail ? ' · ' + node.detail : '')));
    top.append(st, badge(node));
    const title = el('div', 'cm-title', node.title);
    const line = el('div', 'cm-line', node.line || (node.kind === 'waiting' ? '同时干活的会话满了，有空位就自动开' : node.status === 'working' ? '干活中，还没有回执' : node.kind === 'captain' ? '' : '还没有回执'));
    line.classList.toggle('empty', !node.line);
    const liveLine = el('div', 'cm-live', node.live ? '▸ ' + node.live : '');
    liveLine.hidden = !node.live;
    const foot = el('div', 'cm-foot', node.kind === 'captain' || node.kind === 'waiting' ? '' : ago(node.ts));
    foot.hidden = node.kind === 'captain' || node.kind === 'waiting';
    if (node.returned) {
      const returned = el('span', 'cm-returned', '✓ 已交回');
      returned.title = '结果已交回队长';
      foot.appendChild(returned);
    }
    n.append(top, title, line, liveLine, foot);
    n.title = node.kind === 'waiting' ? node.title
      : `${node.title}\n${node.line || ''}\n${node.archived ? '点击：恢复这个会话并打开它的终端' : '点击：打开这个会话的终端列'}\n拖动：移动卡片`.trim();
    n.addEventListener('pointerdown', (e) => startCardDrag(e, n, node, box));
    n.addEventListener('click', (e) => {
      if (n.dataset.dragged) { delete n.dataset.dragged; e.preventDefault(); return; }
      if (node.kind !== 'waiting') host.open(node);
    });
    return n;
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
  function setShowReturn(v) { showReturn = !!v; saved().showReturn = showReturn; returnBtn.setAttribute('aria-pressed', String(showReturn)); returnBtn.classList.toggle('on', showReturn); host.save(); redrawEdges(); fit(); }
  function drawEdges() {
    edgesEl.innerHTML = '<defs>' + Object.values(MARK).filter((v, i, a) => a.indexOf(v) === i).map((id) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>`).join('') + '</defs>';
    const list = C.routes(lastMap, lay, NODE);
    const layer = (cls) => svg('g', { class: cls });
    const returns = layer('cm-returns'), reviews = layer('cm-reviews');
    const halos = layer('cm-halos'), lines = layer('cm-lines'), pulses = layer('cm-pulses'), core = layer('cm-spine'), dots = layer('cm-dots');
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
      svg('circle', { class: 'cm-socket ' + r.cls, cx: x, cy: y, r: 2.6, style }, dots);
    });
    // trunk and main bus once, in the core colour, over the bundled lines
    const sp = C.spine(list);
    if (!sp) return;
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
    svg('circle', { class: 'cm-hub' + (sp.active ? ' active' : ''), cx: sp.hub[0], cy: sp.hub[1], r: 4 }, dots);
  }
  function redrawEdges() { if (lay) drawEdges(); }
  function drawGroups() {
    zonesEl.innerHTML = '';
    lay.groups.forEach((g) => {
      const group = el('section', 'cm-project' + (g.collapsed ? ' collapsed' : ''));
      group.dataset.project = g.key;
      group.style.setProperty('--project-hue', String(C.projectHue(g.key)));
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
        render();
      });
      head.append(toggle, el('span', 'cm-project-name', g.name), el('span', 'cm-project-summary', C.summaryLine(g.counts)));
      head.title = '拖动：移动项目和其中的卡片';
      group.addEventListener('pointerdown', (e) => startProjectDrag(e, group, g));
      group.appendChild(head);
      zonesEl.appendChild(group);
    });
  }

  // ---- canvas view ----
  function applyView() {
    canvasEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomLabel.textContent = Math.round(view.scale * 100) + '%';
  }
  function saveView() { saved().view = { ...view }; host.save(); }
  // Fit actual bounds, including manual moves, gap-routed lines and optional return cables.
  function fit() {
    if (!lay) return;
    const boxes = [lay.captain, ...lay.groups, ...lay.nodes.values(), lay.fold].filter(Boolean);
    const points = C.routes(lastMap, lay, NODE).filter((r) => r.type !== 'return' || showReturn).flatMap((r) => r.points);
    const left = Math.min(...boxes.map((b) => b.x), ...points.map((p) => p[0])) - 24;
    const top = Math.min(...boxes.map((b) => b.y), ...points.map((p) => p[1])) - 24;
    const right = Math.max(...boxes.map((b) => b.x + b.w), ...points.map((p) => p[0])) + 24;
    const bottom = Math.max(...boxes.map((b) => b.y + b.h), ...points.map((p) => p[1])) + 24;
    const w = vpEl.clientWidth, h = vpEl.clientHeight - 60;
    const scale = Math.min(1, w / (right - left), h / (bottom - top));
    view = { scale, x: (w - (right - left) * scale) / 2 - left * scale, y: (h - (bottom - top) * scale) / 2 - top * scale };
    applyView();
    saveView();
  }

  // Choose the grid which displays the largest cards in this viewport. Both
  // project shelves and session rows participate (including an ungrouped crew).
  function autoLayout(map) {
    let best, score = -1;
    const count = Math.max(1, ...map.projects.map((p) => p.nodes.length));
    for (let cols = 1; cols <= count; cols++) for (const targetScale of [1, 0.85, 0.7, 0.55]) {
      const candidate = C.layout(map, { ...NODE, fold: map.hiddenArchived > 0, collapsedProjects: saved().collapsedProjects, columnsPerProject: cols, maxWidth: (vpEl.clientWidth - 48) / targetScale });
      const scale = Math.min(1, vpEl.clientWidth / candidate.width, (vpEl.clientHeight - 60) / candidate.height);
      const quality = scale - candidate.width * candidate.height * 1e-10;
      if (quality > score) { score = quality; best = candidate; }
    }
    return best;
  }
  function zoomAt(cx, cy, factor) {
    const scale = Math.min(C.MAX_SCALE, Math.max(C.MIN_SCALE, view.scale * factor));
    const k = scale / view.scale;
    view = { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
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
    if (e.button !== 0 || e.target.closest('.cm-node, .cm-fold, .cm-controls, .cm-project-toggle')) return;
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
      applyView();
      return;
    }
    if (drag.kind === 'project') {
      const dxNext = Math.round(dx / view.scale), dyNext = Math.round(dy / view.scale);
      C.translateProject(lay, drag.group.key, dxNext - drag.dx, dyNext - drag.dy);
      drag.dx = dxNext; drag.dy = dyNext;
      place(drag.n, drag.group);
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
    if (d.kind === 'pan') { saveView(); return; }
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
    if (mode !== 'crew' || !view) return;
    e.preventDefault();
    const r = vpEl.getBoundingClientRect();
    // a pinch on a trackpad arrives as ctrl+wheel
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
    else {
      view = { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY };
      applyView();
      clearTimeout(onWheel.t);
      onWheel.t = setTimeout(saveView, 250);
    }
  }

  function render() {
    if (!rootEl || mode !== 'crew' || !host.visible() || drag) return;
    const map = collect();
    lastMap = map;
    lastSig = C.signature(map) + '|' + showArchived;
    archBtn.hidden = !map.archivedCount;
    archBtn.classList.toggle('on', showArchived);
    archBtn.setAttribute('aria-pressed', String(showArchived));
    archBtn.title = showArchived ? `收起已归档（${map.archivedCount}）` : `显示已归档（${map.archivedCount}）`;
    archBtn.setAttribute('aria-label', archBtn.title);
    returnBtn.classList.toggle('on', showReturn);
    nodesEl.innerHTML = '';
    emptyEl.hidden = !!map.captain;
    if (!map.captain) { edgesEl.innerHTML = ''; zonesEl.innerHTML = ''; lay = null; return; }
    lay = C.applyPositions(autoLayout(map), saved().positions, map.captain.id, saved().projectPositions);
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
    fit();
  }

  // Every status tick: a structural change rebuilds, the rest updates text in place.
  function refresh() {
    if (!rootEl || mode !== 'crew' || !host.visible() || drag) return;
    const map = collect();
    if (C.signature(map) + '|' + showArchived !== lastSig) { render(); return; }
    lastMap = map;
    map.nodes.forEach((n) => {
      const node = nodesEl.querySelector(`.cm-node[data-node-id="${CSS.escape(n.id)}"]`);
      const live = node && node.querySelector('.cm-live');
      if (!live) return;
      const text = n.live ? '▸ ' + n.live : '';
      if (live.textContent !== text) live.textContent = text;
      live.hidden = !n.live;
    });
  }

  function setShowArchived(v) { showArchived = !!v; render(); }
  function relayout() { saved().positions = {}; saved().projectPositions = {}; host.save(); render(); }

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
    edgesEl = rootEl.querySelector('.cm-edges');
    nodesEl = rootEl.querySelector('.cm-nodes');
    emptyEl = rootEl.querySelector('.cm-empty');
    zoomLabel = rootEl.querySelector('[data-cm="zoom"]');
    archBtn = rootEl.querySelector('[data-cm="archived"]');
    returnBtn = rootEl.querySelector('[data-cm="return"]');
    returnBtn.setAttribute('aria-pressed', String(showReturn));
    const on = (name, fn) => rootEl.querySelector(`[data-cm="${name}"]`).addEventListener('click', fn);
    on('archived', () => setShowArchived(!showArchived));
    on('out', () => view && zoomCenter(1 / 1.2));
    on('in', () => view && zoomCenter(1.2));
    on('reset', () => view && zoomCenter(1 / view.scale));
    on('fit', fit);
    on('relayout', relayout);
    on('return', () => setShowReturn(!showReturn));
    returnBtn.classList.toggle('on', showReturn);
    vpEl.addEventListener('pointerdown', (e) => { if (view) startPan(e); });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    vpEl.addEventListener('wheel', onWheel, { passive: false });
    viewEl.querySelectorAll('.board-mode button[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    new ResizeObserver(() => { if (host.visible() && vpEl.clientWidth && !drag) render(); }).observe(vpEl);
    setMode(host.config.crewMap.mode);
  }

  window.CrewMap = { init, render, refresh, fit, relayout, mode: () => mode, setMode, setShowArchived, setShowReturn, lastMap: () => lastMap, view: () => view && { ...view }, layout: () => lay };
})();
