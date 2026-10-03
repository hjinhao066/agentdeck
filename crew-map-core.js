// Pure helpers behind the 终端架构图 (crew map): 队长 at the top, a line down
// to every session it handed work to, review sessions below the sessions they
// review. Built from the same data as the ledger (config.mainSession.tasks,
// the live columns, config.archived). No DOM: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CrewMapCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUS_LABEL = { working: '干活中', input: '待补充', queued: '排队', done: '已完成', failed: '失败', stopped: '已停下', idle: '空闲' };
  const ACTIVE = ['working', 'input', 'queued'];
  // A session whose title (or the work it was given) reads as a review.
  const REVIEW_RE = /审查|审核|复核|复查|评审|核查|验收|review|audit/i;
  const MAX_LINE = 140;

  const oneLine = (s, max = MAX_LINE) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };

  // Map a 队长 task (+ the live terminal, when there is one) to one of the
  // map's states. A terminal at work or at a prompt wins over an older task.
  function nodeStatus(task, term) {
    if (term && term.alive && term.state === 'working') return { status: 'working', detail: '' };
    if (term && term.alive && term.state === 'input') return { status: 'input', detail: '停在确认' };
    if (!task) return { status: term && term.state === 'done' ? 'done' : 'idle', detail: '' };
    switch (task.status) {
      case 'waiting': return { status: 'queued', detail: '等空位' };
      case 'queued': return { status: 'queued', detail: '等终端就绪' };
      case 'working': return { status: 'working', detail: '' };
      case 'input': return { status: 'input', detail: '停在确认' };
      case 'asking': return { status: 'input', detail: '在问队长' };
      case 'done': return { status: 'done', detail: '' };
      case 'failed': return { status: 'failed', detail: '' };
      case 'stopped': return { status: 'stopped', detail: '没写回执' };
      default: return { status: 'idle', detail: '' };
    }
  }

  // The one line under a node: its newest receipt (question / failure / summary).
  function receiptLine(task, lastReceipt) {
    const r = (task && task.receipt) || null;
    if (r && r.question) return '提问：' + oneLine(r.question);
    if (r && r.failed) return '失败：' + oneLine(r.failed);
    if (r && r.summary) return oneLine(r.summary);
    if (lastReceipt && lastReceipt.summary) return oneLine(lastReceipt.summary);
    return '';
  }

  // What came back to 队长 from a session: '' (nothing yet), 'ok', 'question', 'failed'.
  function returnKind(task, lastReceipt) {
    const r = (task && task.receipt) || null;
    if (r && r.question) return 'question';
    if ((r && r.failed) || (task && task.status === 'failed')) return 'failed';
    if (r || (task && ['done', 'stopped'].includes(task.status)) || (!task && lastReceipt)) return 'ok';
    return '';
  }

  // Review links: a session reads as a review (REVIEW_RE on its title or the
  // work it was given), and that work names other sessions by id, by title or
  // by a file from their receipt. Only sessions that got work earlier count.
  function detectReviews(nodes, prompts) {
    const edges = [];
    const reviewers = new Set();
    nodes.forEach((n) => {
      const text = String(prompts[n.id] || '');
      if (!REVIEW_RE.test(n.title) && !REVIEW_RE.test(text)) return;
      const targets = nodes.filter((o) => {
        if (o.id === n.id || !(o.firstSentAt <= n.lastSentAt)) return false;
        if (o.id.length >= 6 && new RegExp('(^|[^A-Za-z0-9_-])' + o.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_-])').test(text)) return true;
        if (o.title.length >= 4 && text.includes(o.title)) return true;
        return o.files.some((f) => f.length > 4 && text.includes(f));
      });
      if (REVIEW_RE.test(n.title) || targets.length) reviewers.add(n.id);
      targets.forEach((o) => edges.push({ from: o.id, to: n.id, type: 'review' }));
    });
    return { edges, reviewers };
  }

  // input: {
  //   captain: { id, title, alive, state, provider, model } | null,
  //   columns: [{ id, title, alive, state, live, provider, model, lastReceipt, captainCrew }],
  //   archived: [{ id, title, provider, model, lastReceipt, captainCrew, archivedAt }],
  //   tasks: config.mainSession.tasks, prompts: { colId: text it was given }, showArchived
  // }
  function buildCrewMap(input) {
    const tasks = (Array.isArray(input.tasks) ? input.tasks : []).filter((t) => t && typeof t === 'object');
    const live = new Map((input.columns || []).map((c) => [c.id, c]));
    const archived = new Map((input.archived || []).map((a) => [a.id, a]));
    const byCol = new Map();
    tasks.forEach((t) => {
      if (!t.colId) return;
      if (!byCol.has(t.colId)) byCol.set(t.colId, []);
      byCol.get(t.colId).push(t);
    });
    // sessions 队长 opened keep their place even after their task cards are pruned
    (input.columns || []).forEach((c) => { if (c.captainCrew && !byCol.has(c.id)) byCol.set(c.id, []); });

    const all = [];
    byCol.forEach((list, colId) => {
      const col = live.get(colId) || archived.get(colId);
      if (!col) return;   // closed for good
      const isArchived = !live.has(colId);
      const latest = list[list.length - 1] || null;
      const term = isArchived ? null : col;
      const { status, detail } = nodeStatus(latest, term);
      const sent = list.map((t) => t.sentAt || 0);
      all.push({
        id: colId, kind: 'worker', title: oneLine(col.title, 120) || 'Terminal',
        provider: col.provider || '', model: col.model || '',
        status, statusLabel: STATUS_LABEL[status], detail,
        line: receiptLine(latest, col.lastReceipt),
        live: !isArchived && status === 'working' ? oneLine(col.live, 90) : '',
        archived: isArchived, review: false, taskCount: list.length,
        firstSentAt: sent.length ? Math.min(...sent) : 0,
        lastSentAt: sent.length ? Math.max(...sent) : 0,
        ts: Math.max(latest ? latest.doneAt || latest.startedAt || latest.sentAt || 0 : 0, col.archivedAt || 0),
        files: latest && latest.receipt && Array.isArray(latest.receipt.files) ? latest.receipt.files.map(String) : [],
        returned: returnKind(latest, col.lastReceipt),
      });
    });
    // work waiting for a free slot has no terminal yet
    tasks.filter((t) => !t.colId && t.status === 'waiting').forEach((t) => {
      all.push({
        id: 'wait:' + t.id, kind: 'waiting', title: oneLine(t.title, 120) || '排队中的活',
        provider: '', model: '', status: 'queued', statusLabel: STATUS_LABEL.queued, detail: '等空位',
        line: '', live: '', archived: false, review: false, taskCount: 1,
        firstSentAt: t.sentAt || 0, lastSentAt: t.sentAt || 0, ts: t.sentAt || 0, files: [], returned: '',
      });
    });
    all.sort((a, b) => a.firstSentAt - b.firstSentAt || (a.id < b.id ? -1 : 1));

    const reviews = detectReviews(all.filter((n) => n.kind === 'worker'), input.prompts || {});
    all.forEach((n) => { n.review = reviews.reviewers.has(n.id); });

    // An archived session a visible review still links to stays (faded): the chain stays whole.
    const current = new Set(all.filter((n) => !n.archived).map((n) => n.id));
    const linked = new Set(reviews.edges.filter((e) => current.has(e.from) || current.has(e.to)).flatMap((e) => [e.from, e.to]));
    const visible = all.filter((n) => input.showArchived || !n.archived || linked.has(n.id));
    const shown = new Set(visible.map((n) => n.id));
    const captainId = input.captain ? input.captain.id : '';
    const review = reviews.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
    // Results flow back to 队长. A reviewed session's result goes on through
    // its review; only a question or a failure from it goes straight back.
    const reviewed = new Set(review.map((e) => e.from));
    const edges = [
      ...visible.map((n) => ({ from: captainId, to: n.id, type: 'dispatch' })),
      ...review,
      ...(captainId ? visible.filter((n) => n.returned && (!reviewed.has(n.id) || n.returned !== 'ok'))
        .map((n) => ({ from: n.id, to: captainId, type: 'return', kind: n.returned })) : []),
    ];
    const counts = {};
    all.filter((n) => !n.archived).forEach((n) => { counts[n.status] = (counts[n.status] || 0) + 1; });
    let captain = null;
    if (input.captain) {
      const c = input.captain;
      const st = c.alive === false ? 'idle' : c.state === 'working' ? 'working' : c.state === 'input' ? 'input' : 'idle';
      captain = {
        id: c.id, kind: 'captain', title: oneLine(c.title, 60) || '队长', provider: c.provider || '', model: c.model || '',
        status: st, statusLabel: st === 'idle' ? (c.alive === false ? '已退出' : '待命') : STATUS_LABEL[st], detail: '',
        line: summaryLine(counts), live: '', archived: false, review: false,
      };
    }
    return {
      captain, nodes: visible, edges, counts,
      archivedCount: all.filter((n) => n.archived).length,
      hiddenArchived: all.length - visible.length,
    };
  }

  // 「2 干活中 · 1 待补充 · 3 已完成」 for the 队长 card.
  function summaryLine(counts) {
    const order = ['working', 'input', 'queued', 'failed', 'done', 'stopped', 'idle'];
    return order.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABEL[s]}`).join(' · ') || '还没有派出去的活';
  }

  // Where a session sits, left to right: work waiting on something
  // (排队 / 待补充), then work in progress, then finished work set apart.
  const ZONE = { queued: 0, input: 0, working: 1 };
  // Sessions joined by review links stay together as one cluster: the
  // reviewed sessions on a row, each review one row below what it reviews.
  function clusters(map) {
    const parent = new Map(map.nodes.map((n) => [n.id, n.id]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    map.edges.filter((e) => e.type === 'review' && parent.has(e.from) && parent.has(e.to)).forEach((e) => parent.set(find(e.from), find(e.to)));
    const groups = new Map();
    map.nodes.forEach((n, i) => {
      const k = find(n.id);
      if (!groups.has(k)) groups.set(k, { nodes: [], first: i });
      groups.get(k).nodes.push(n);
    });
    return [...groups.values()].map((g) => ({
      nodes: g.nodes, first: g.first,
      zone: Math.min(2, ...g.nodes.map((n) => (n.archived ? 2 : ZONE[n.status] ?? 2))),
    })).sort((a, b) => a.zone - b.zone || a.first - b.first);
  }

  function layout(map, opts) {
    const o = { nodeW: 220, nodeH: 122, captainW: 300, captainH: 96, gapX: 24, clusterGap: 52, zoneGap: 88, fanY: 100, gapY: 80, pad: 40, fold: false, ...opts };
    const reviewOf = new Map();
    map.edges.filter((e) => e.type === 'review').forEach((e) => {
      if (!reviewOf.has(e.to)) reviewOf.set(e.to, []);
      reviewOf.get(e.to).push(e.from);
    });
    const depth = new Map();
    const depthOf = (id, seen) => {
      if (depth.has(id)) return depth.get(id);
      if (seen.has(id)) return 1;   // a review cycle: stop at the first level
      seen.add(id);
      const targets = reviewOf.get(id) || [];
      const d = targets.length ? 1 + Math.max(...targets.map((t) => depthOf(t, seen))) : 1;
      depth.set(id, d);
      return d;
    };
    map.nodes.forEach((n) => depthOf(n.id, new Set()));
    const rowY = (r) => o.pad + (r === 0 ? 0 : o.captainH + o.fanY + (r - 1) * (o.nodeH + o.gapY));
    const step = o.nodeW + o.gapX;
    const pos = new Map();
    const groups = clusters(map);
    let x = o.pad;
    let prevZone = null;
    let rows = 1;
    const boxes = [];
    groups.forEach((g) => {
      if (prevZone !== null) x += g.zone !== prevZone ? o.zoneGap : o.clusterGap;
      prevZone = g.zone;
      const x0 = x;
      let right = x0;
      g.nodes.filter((n) => depth.get(n.id) === 1).forEach((n, i) => {
        pos.set(n.id, { x: x0 + i * step, y: rowY(1), w: o.nodeW, h: o.nodeH, row: 1, zone: g.zone });
        right = Math.max(right, x0 + i * step + o.nodeW);
      });
      const maxD = Math.max(...g.nodes.map((n) => depth.get(n.id)));
      for (let d = 2; d <= maxD; d++) {
        let nextFree = x0;
        g.nodes.filter((n) => depth.get(n.id) === d).forEach((n) => {
          const xs = (reviewOf.get(n.id) || []).map((t) => pos.get(t)).filter(Boolean).map((p) => p.x + p.w / 2);
          const want = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 - o.nodeW / 2 : nextFree;
          const nx = Math.max(nextFree, want);
          pos.set(n.id, { x: nx, y: rowY(d), w: o.nodeW, h: o.nodeH, row: d, zone: g.zone });
          nextFree = nx + step;
          right = Math.max(right, nx + o.nodeW);
        });
        rows = Math.max(rows, d);
      }
      boxes.push({ x0, x1: right, zone: g.zone });
      x = right;
    });
    let fold = null;
    if (o.fold) {
      if (boxes.length) x += prevZone === 2 ? o.clusterGap : o.zoneGap;
      fold = { x, y: rowY(1) + o.nodeH / 2 - 16, w: 150, h: 32 };
      x += fold.w;
    }
    // 队长 centers over the work still open; over everything when all is finished
    const open = boxes.filter((b) => b.zone < 2);
    const span = open.length ? [open[0].x0, open[open.length - 1].x1] : boxes.length ? [boxes[0].x0, boxes[boxes.length - 1].x1] : [o.pad, o.pad + o.captainW];
    const captain = map.captain ? { x: Math.max(o.pad, (span[0] + span[1]) / 2 - o.captainW / 2), y: rowY(0), w: o.captainW, h: o.captainH, row: 0 } : null;
    return { captain, nodes: pos, fold, rows, rowY, openSpan: open.length ? [open[0].x0, open[open.length - 1].x1] : null, width: Math.max(x, captain ? captain.x + captain.w : 0) + o.pad, height: rowY(rows) + o.nodeH + o.pad };
  }

  // Saved node positions ({ id: { x, y } }, 队长 under its own id) win over the layout.
  function applyPositions(lay, positions, captainId) {
    const p = positions || {};
    const ok = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y);
    lay.nodes.forEach((box, id) => { if (ok(p[id])) Object.assign(box, { x: p[id].x, y: p[id].y, moved: true }); });
    if (lay.captain && captainId && ok(p[captainId])) Object.assign(lay.captain, { x: p[captainId].x, y: p[captainId].y, moved: true });
    return lay;
  }

  // Lines from a node's port, ranked so their horizontal runs nest instead of
  // crossing: lines heading left turn earlier the farther left they go, lines
  // heading right likewise. items: [{ sx, hx }] -> rank per item.
  function nestRanks(items) {
    const ranks = new Array(items.length).fill(0);
    const left = items.map((it, i) => ({ ...it, i })).filter((it) => it.hx < it.sx - 0.5).sort((a, b) => a.hx - b.hx);
    const right = items.map((it, i) => ({ ...it, i })).filter((it) => it.hx > it.sx + 0.5).sort((a, b) => b.hx - a.hx);
    left.forEach((it, r) => { ranks[it.i] = r; });
    right.forEach((it, r) => { ranks[it.i] = r; });
    return { ranks, levels: Math.max(left.length, right.length, 1) };
  }
  const spread = (center, n, k, width) => (n > 1 ? center + (k / (n - 1) - 0.5) * width : center);

  // Every line as orthogonal points. 派出 (dispatch) leaves the bottom of 队长
  // and enters a session's top (a review session's left side); 审查 runs from
  // the bottom of a reviewed session down into its review; 收回 (return)
  // leaves a session's bottom-right corner, runs under everything and up the
  // right edge into 队长's right side, so out and back never share a stretch.
  function routes(map, lay, opts) {
    const o = { clusterGap: 64, lane: 7, ...opts };
    const cap = lay.captain;
    const out = [];
    if (!cap) return out;
    const box = (id) => lay.nodes.get(id);
    const status = new Map(map.nodes.map((n) => [n.id, n]));
    const reviewOf = new Map();
    map.edges.filter((e) => e.type === 'review' && box(e.from) && box(e.to)).forEach((e) => {
      if (!reviewOf.has(e.to)) reviewOf.set(e.to, []);
      reviewOf.get(e.to).push(e.from);
    });
    const all = [...lay.nodes.values()];
    // ---- 派出 ----
    const dispatch = map.edges.filter((e) => e.type === 'dispatch' && box(e.to)).map((e) => {
      const b = box(e.to);
      const side = reviewOf.has(e.to);
      // a review session is entered from the left, down the gap left of what it reviews
      const targets = side ? reviewOf.get(e.to).map(box) : [];
      const lx = side ? Math.min(b.x, ...targets.map((t) => t.x)) - o.clusterGap / 2 : 0;
      return { e, b, side, lx, hx: side ? lx : b.x + b.w / 2 };
    }).sort((a, b) => a.hx - b.hx);
    const fanW = Math.min(cap.w - 48, Math.max(0, dispatch.length - 1) * 18);
    const sy = cap.y + cap.h;
    dispatch.forEach((d, k) => { d.sx = spread(cap.x + cap.w / 2, dispatch.length, k, fanW); });
    const top = Math.min(...dispatch.map((d) => (d.side ? Infinity : d.b.y)), ...all.map((b) => b.y));
    const dn = nestRanks(dispatch);
    const band = Math.max(16, top - sy);
    const stepD = Math.min(o.lane + 3, (band - 24) / Math.max(1, dn.levels - 1));
    // lanes down a gap: one per review session sharing it
    const laneUse = new Map();
    dispatch.forEach((d, k) => {
      const y = sy + 12 + dn.ranks[k] * stepD;
      const n = status.get(d.e.to);
      const cls = `dispatch st-${n.status}${n.archived ? ' archived' : ''}`;
      if (!d.side) {
        const tx = d.b.x + d.b.w / 2;
        const pts = Math.abs(tx - d.sx) < 1 ? [[d.sx, sy], [tx, d.b.y - 2]] : [[d.sx, sy], [d.sx, y], [tx, y], [tx, d.b.y - 2]];
        out.push({ type: 'dispatch', from: d.e.from, to: d.e.to, cls, points: pts });
        return;
      }
      const used = laneUse.get(Math.round(d.lx)) || 0;
      laneUse.set(Math.round(d.lx), used + 1);
      const lx = d.lx - used * o.lane;
      const ry = d.b.y + d.b.h / 2 - 14;
      out.push({ type: 'dispatch', from: d.e.from, to: d.e.to, cls, points: [[d.sx, sy], [d.sx, y], [lx, y], [lx, ry], [d.b.x - 2, ry]] });
    });
    // ---- 审查 ----
    let ri = 0;
    reviewOf.forEach((targets, id) => {
      const r = box(id);
      const ts = targets.map((t) => ({ t, b: box(t) })).sort((a, b) => a.b.x - b.b.x);
      const width = Math.min(r.w - 48, Math.max(0, ts.length - 1) * 30);
      const items = ts.map((x, k) => ({ sx: x.b.x + x.b.w / 2, hx: spread(r.x + r.w / 2, ts.length, k, width), b: x.b, t: x.t }));
      const nr = nestRanks(items);
      const bottom = Math.max(...items.map((it) => it.b.y + it.b.h));
      const gap = Math.max(16, r.y - bottom);
      const stepR = Math.min(o.lane + 3, (gap - 24) / Math.max(1, nr.levels - 1 + ri));
      items.forEach((it, k) => {
        const y = bottom + 12 + (nr.ranks[k] + ri) * stepR;
        const pts = Math.abs(it.hx - it.sx) < 1 ? [[it.sx, it.b.y + it.b.h], [it.hx, r.y - 2]]
          : [[it.sx, it.b.y + it.b.h], [it.sx, y], [it.hx, y], [it.hx, r.y - 2]];
        const n = status.get(id);
        out.push({ type: 'review', from: it.t, to: id, cls: `review${n.archived ? ' archived' : ''}`, points: pts });
      });
      ri++;
    });
    // ---- 收回 ----
    const ret = map.edges.filter((e) => e.type === 'return' && box(e.from)).map((e) => {
      const b = box(e.from);
      return { e, b, sx: b.x + b.w - 30, sy: b.y + b.h };
    }).sort((a, b) => b.sx - a.sx);   // the rightmost takes the innermost lane
    const floor = Math.max(...all.map((b) => b.y + b.h), cap.y + cap.h, lay.fold ? lay.fold.y + lay.fold.h : 0) + 30;
    const wall = Math.max(...all.map((b) => b.x + b.w), cap.x + cap.w, lay.fold ? lay.fold.x + lay.fold.w : 0) + 34;
    const n = ret.length;
    const stepE = Math.min(o.lane + 3, (cap.h - 40) / Math.max(1, n - 1));
    ret.forEach((r, k) => {
      const busY = floor + k * o.lane;
      const X = wall + k * o.lane;
      const yE = cap.y + 20 + (n - 1 - k) * stepE;   // the outermost enters highest
      const node = status.get(r.e.from);
      out.push({
        type: 'return', from: r.e.from, to: r.e.to, kind: r.e.kind,
        cls: `return ${r.e.kind}${node.archived ? ' archived' : ''}`,
        points: [[r.sx, r.sy], [r.sx, busY], [X, busY], [X, yE], [cap.x + cap.w + 2, yE]],
      });
    });
    return out;
  }

  // Saved state of the map: { mode, positions: { id: {x,y} }, view: { x, y, scale } }.
  function normalizeSaved(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const positions = {};
    if (s.positions && typeof s.positions === 'object') {
      Object.entries(s.positions).slice(0, 500).forEach(([id, p]) => {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && id.length <= 80) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
      });
    }
    const v = s.view && typeof s.view === 'object' ? s.view : null;
    const view = v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.scale)
      ? { x: v.x, y: v.y, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale)) } : null;
    return { mode: s.mode === 'canvas' ? 'canvas' : 'crew', positions, view };
  }
  const MIN_SCALE = 0.3, MAX_SCALE = 1.6;

  // A change in anything but the live activity line rebuilds the map.
  function signature(map) {
    const n = (x) => [x.id, x.status, x.detail, x.title, x.provider, x.model, x.line, x.archived ? 1 : 0, x.review ? 1 : 0].join('\u0001');
    return [map.captain ? n(map.captain) : '', ...map.nodes.map(n), ...map.edges.map((e) => `${e.type}:${e.from}>${e.to}:${e.kind || ''}`), map.hiddenArchived].join('\u0002');
  }

  return { STATUS_LABEL, ACTIVE, REVIEW_RE, MIN_SCALE, MAX_SCALE, nodeStatus, receiptLine, returnKind, detectReviews, buildCrewMap, clusters, layout, applyPositions, routes, nestRanks, normalizeSaved, signature, summaryLine };
});
