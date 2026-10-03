// 终端架构图 (crew map): the default face of the board view. 队长 sits on top
// with a line down to every session it handed work to; review sessions hang
// below what they review. A projection only: drawing it never touches a
// terminal, clicking a node opens that real column. CrewMapCore does the math.
(function () {
  'use strict';
  const C = window.CrewMapCore;
  const SVG = 'http://www.w3.org/2000/svg';
  const NODE = { nodeW: 232, nodeH: 122, captainW: 300, gapX: 28, gapY: 62, pad: 32 };
  const MIN_SCALE = 0.62;
  let host = null;
  let rootEl, canvasEl, edgesEl, nodesEl, emptyEl, archBtn, viewEl;
  let mode = 'crew';
  let showArchived = false;
  let lastSig = '';
  let lastMap = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

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
        provider: i.provider || '', model: i.shortModel || '', lastReceipt: c.lastReceipt || null, captainCrew: !!c.captainCrew,
      };
    });
    const archived = (host.config.archived || []).map((a) => {
      const i = info(a);
      return { id: a.id, title: host.columnLabel(a), provider: i.provider || '', model: i.shortModel || '', lastReceipt: a.lastReceipt || null, captainCrew: !!a.captainCrew, archivedAt: a.archivedAt || 0 };
    });
    const tasks = (s && s.tasks) || [];
    // what each session was told, for spotting review work (its own prompts only)
    const prompts = {};
    new Set(tasks.map((t) => t.colId).filter(Boolean)).forEach((id) => {
      prompts[id] = host.turnsOf(id).filter((t) => t.kind !== 'task').map((t) => t.user || '').join('\n').slice(0, 40000);
    });
    let captain = null;
    if (main) {
      const entry = terms.get(main.id);
      const i = info(main);
      captain = { id: main.id, title: host.columnLabel(main), alive: !!(entry && entry.alive), state: entry ? entry.state : 'plain', provider: i.provider || '', model: i.shortModel || '' };
    }
    return C.buildCrewMap({ captain, columns, archived, tasks, prompts, showArchived });
  }

  function badge(node) {
    const b = el('span', 'cm-agent');
    if (!node.provider && !node.model) { b.textContent = 'shell'; return b; }
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
    Object.assign(n.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
    const top = el('div', 'cm-top');
    const st = el('span', 'cm-status');
    st.append(el('i', 'cm-dot'), el('span', 'cm-status-text', node.statusLabel + (node.detail ? ' · ' + node.detail : '')));
    top.append(st);
    if (node.kind === 'captain') top.prepend(el('span', 'cm-role', '队长'));
    if (node.review) top.append(el('span', 'cm-role review', '审查'));
    if (node.archived) top.append(el('span', 'cm-role', '已归档'));
    top.append(badge(node));
    const title = el('div', 'cm-title', node.title);
    const line = el('div', 'cm-line', node.line || (node.kind === 'waiting' ? '同时干活的会话满了，有空位就自动开' : node.status === 'working' ? '干活中，还没有回执' : '还没有回执'));
    line.classList.toggle('empty', !node.line);
    const liveLine = el('div', 'cm-live', node.live ? '▸ ' + node.live : '');
    liveLine.hidden = !node.live;
    const foot = el('div', 'cm-foot', node.kind === 'captain' ? '点击打开队长' : node.kind === 'waiting' ? '等空位' : [node.taskCount > 1 ? `派过 ${node.taskCount} 次活` : '', ago(node.ts)].filter(Boolean).join(' · '));
    n.append(top, title, line, liveLine, foot);
    n.title = node.kind === 'waiting' ? node.title
      : `${node.title}\n${node.line || ''}\n${node.archived ? '点击：恢复这个会话并打开它的终端' : '点击：打开这个会话的终端列'}`.trim();
    n.disabled = node.kind === 'waiting';
    n.addEventListener('click', () => host.open(node));
    return n;
  }

  function path(cls, d, marker) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', d);
    if (marker) p.setAttribute('marker-end', `url(#${marker})`);
    edgesEl.appendChild(p);
    return p;
  }
  // Orthogonal route with rounded corners through the given points.
  function rounded(points, r = 12) {
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

  const nearest = (list, x) => list.reduce((best, g) => (Math.abs(g - x) < Math.abs(best - x) ? g : best), list[0]);

  function drawEdges(map, lay) {
    edgesEl.innerHTML = '<defs>' +
      '<marker id="cmArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>' +
      '<marker id="cmArrowReview" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>' +
      '</defs>';
    const cap = lay.captain;
    if (!cap) return;
    const status = new Map(map.nodes.map((n) => [n.id, n.status]));
    const dispatch = map.edges.filter((e) => e.type === 'dispatch' && lay.nodes.has(e.to));
    // row 1 fans out along the bottom of the 队长 card; later rows run down a gap
    const row1 = dispatch.filter((e) => lay.nodes.get(e.to).row === 1);
    const fanW = Math.min(cap.w - 60, row1.length * 22);
    dispatch.forEach((e) => {
      const b = lay.nodes.get(e.to);
      const cls = `cm-edge dispatch st-${status.get(e.to)}`;
      const tx = b.x + b.w / 2, ty = b.y - 2;
      const k = row1.indexOf(e);
      const sx = cap.x + cap.w / 2 + (k >= 0 && row1.length > 1 ? (k / (row1.length - 1) - 0.5) * fanW : 0);
      const sy = cap.y + cap.h;
      if (k >= 0) {
        const my = (sy + ty) / 2;
        path(cls, `M ${sx} ${sy} C ${sx} ${my} ${tx} ${my} ${tx} ${ty}`, 'cmArrow');
        return;
      }
      const gx = nearest(lay.gaps, tx);
      const lane = lay.laneY(b.row);
      path(cls + ' routed', rounded([[sx, sy], [sx, lay.laneY(1)], [gx, lay.laneY(1)], [gx, lane], [tx, lane], [tx, ty]]), 'cmArrow');
    });
    // review: from each reviewed card into the reviewer, one chip per reviewer
    const byReviewer = new Map();
    map.edges.filter((e) => e.type === 'review').forEach((e) => {
      const a = lay.nodes.get(e.from), b = lay.nodes.get(e.to);
      if (!a || !b) return;
      const sx = a.x + a.w / 2, sy = a.y + a.h, tx = b.x + b.w / 2, ty = b.y - 2;
      if (b.row === a.row + 1) {
        const my = sy + Math.max(24, (ty - sy) * 0.55);
        path('cm-edge review', `M ${sx} ${sy} C ${sx} ${my} ${tx} ${sy + 8} ${tx} ${ty}`, 'cmArrowReview');
      } else {
        const gx = nearest(lay.gaps, sx) + 6;
        const out = lay.laneY(a.row + 1) + 8, into = lay.laneY(b.row) + 8;
        path('cm-edge review', rounded([[sx, sy], [sx, out], [gx, out], [gx, into], [tx, into], [tx, ty]]), 'cmArrowReview');
      }
      byReviewer.set(e.to, (byReviewer.get(e.to) || 0) + 1);
    });
    byReviewer.forEach((count, id) => {
      const b = lay.nodes.get(id);
      const chip = el('span', 'cm-review-chip', `审查 ${count} 个会话的产出`);
      chip.style.left = (b.x + b.w / 2) + 'px';
      chip.style.top = (b.y - 12) + 'px';
      nodesEl.appendChild(chip);
    });
  }

  function render() {
    if (!rootEl || mode !== 'crew' || !host.visible()) return;
    const map = collect();
    lastMap = map;
    lastSig = C.signature(map) + '|' + showArchived;
    archBtn.hidden = !map.archivedCount;
    archBtn.textContent = showArchived ? `收起已归档（${map.archivedCount}）` : `显示已归档（${map.archivedCount}）`;
    nodesEl.innerHTML = '';
    emptyEl.hidden = !!map.captain;
    const stage = canvasEl.parentElement;
    if (!map.captain) {
      stage.style.width = stage.style.height = '';
      edgesEl.innerHTML = '';
      return;
    }
    const avail = Math.max(320, rootEl.querySelector('.cm-scroller').clientWidth - 8);
    const perRow = Math.max(2, Math.floor((avail - 2 * NODE.pad + NODE.gapX) / (NODE.nodeW + NODE.gapX)));
    const lay = C.layout(map, { ...NODE, perRow, fold: map.hiddenArchived > 0 });
    // only a window too narrow for two cards shrinks the map
    const scale = Math.max(MIN_SCALE, Math.min(1, avail / lay.width));
    canvasEl.style.width = lay.width + 'px';
    canvasEl.style.height = lay.height + 'px';
    canvasEl.style.transform = scale < 1 ? `scale(${scale})` : '';
    stage.style.width = Math.ceil(lay.width * scale) + 'px';
    stage.style.height = Math.ceil(lay.height * scale) + 'px';
    edgesEl.setAttribute('width', lay.width);
    edgesEl.setAttribute('height', lay.height);
    edgesEl.setAttribute('viewBox', `0 0 ${lay.width} ${lay.height}`);
    drawEdges(map, lay);
    nodesEl.appendChild(card(map.captain, lay.captain));
    map.nodes.forEach((n) => nodesEl.appendChild(card(n, lay.nodes.get(n.id))));
    if (lay.fold) {
      const fold = el('button', 'cm-fold', `+ ${map.hiddenArchived} 个已归档`);
      fold.type = 'button';
      fold.title = '已归档的会话默认折起来；点开淡显出来';
      Object.assign(fold.style, { left: lay.fold.x + 'px', top: (lay.fold.y + lay.fold.h / 2 - 16) + 'px' });
      fold.addEventListener('click', () => setShowArchived(true));
      nodesEl.appendChild(fold);
    }
  }

  // Every status tick: a structural change rebuilds, the rest updates text in place.
  function refresh() {
    if (!rootEl || mode !== 'crew' || !host.visible()) return;
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

  function setMode(next) {
    mode = next === 'canvas' ? 'canvas' : 'crew';
    host.config.boardMode = mode;
    viewEl.dataset.mode = mode;
    viewEl.querySelectorAll('.board-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    viewEl.querySelector('.board-kicker').textContent = mode === 'crew' ? '队长 · 实时' : 'Live orchestration';
    viewEl.querySelector('.board-toolbar h1').textContent = mode === 'crew' ? '终端架构图' : 'Conductor Board';
    host.save();
    if (mode === 'crew') { host.leaveCanvas(); render(); } else host.enterCanvas();
  }

  function init(h) {
    host = h;
    viewEl = document.getElementById('boardView');
    rootEl = document.getElementById('crewMap');
    canvasEl = rootEl.querySelector('.cm-canvas');
    edgesEl = rootEl.querySelector('.cm-edges');
    nodesEl = rootEl.querySelector('.cm-nodes');
    emptyEl = rootEl.querySelector('.cm-empty');
    archBtn = document.getElementById('crewMapArchived');
    archBtn.addEventListener('click', () => setShowArchived(!showArchived));
    viewEl.querySelectorAll('.board-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    mode = host.config.boardMode === 'canvas' ? 'canvas' : 'crew';
    viewEl.dataset.mode = mode;
    setMode(mode);
    window.addEventListener('resize', () => { if (mode === 'crew' && host.visible()) render(); });
  }

  window.CrewMap = { init, render, refresh, mode: () => mode, setMode, setShowArchived, lastMap: () => lastMap };
})();
