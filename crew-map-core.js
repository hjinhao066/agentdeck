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

  // The same receipt, whole, for the detail popover.
  function receiptFull(task, lastReceipt) {
    const r = (task && task.receipt) || null;
    const full = (s) => String(s == null ? '' : s).trim().slice(0, 4000);
    if (r && r.question) return '提问：' + full(r.question);
    if (r && r.failed) return '失败：' + full(r.failed);
    if (r && r.summary) return full(r.summary);
    return lastReceipt && lastReceipt.summary ? full(lastReceipt.summary) : '';
  }

  // What came back to 队长 from a session: '' (nothing yet), 'ok', 'question', 'failed'.
  function returnKind(task, lastReceipt) {
    const r = (task && task.receipt) || null;
    if (r && r.question) return 'question';
    if ((r && r.failed) || (task && task.status === 'failed')) return 'failed';
    if (r || (task && ['done', 'stopped'].includes(task.status)) || (!task && lastReceipt)) return 'ok';
    return '';
  }

  // Only declared session ids make review links; prose and titles never do.
  function detectReviews(nodes) {
    const ids = new Set(nodes.map((n) => n.id));
    const edges = [], reviewers = new Set();
    nodes.forEach((n) => {
      if (!n.reviews.length) return;
      reviewers.add(n.id);
      [...new Set(n.reviews)].forEach((id) => {
        if (id !== n.id && ids.has(id)) edges.push({ from: id, to: n.id, type: 'review' });
      });
    });
    return { edges, reviewers };
  }

  // input: {
  //   captain: { id, title, alive, state, provider, model } | null,
  //   columns: [{ id, title, alive, state, live, provider, model, lastReceipt, captainCrew }],
  //   archived: [{ id, title, provider, model, lastReceipt, captainCrew, archivedAt }],
  //   tasks: config.mainSession.tasks, showArchived
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
    [...(input.columns || []), ...(input.archived || [])].forEach((c) => { if (c.captainCrew && !byCol.has(c.id)) byCol.set(c.id, []); });
    // Explicit review targets can also be user-opened sessions without task cards.
    [...(input.columns || []), ...(input.archived || []), ...tasks].forEach((c) => {
      (Array.isArray(c.reviews) ? c.reviews : []).forEach((id) => {
        if ((live.has(id) || archived.has(id)) && !byCol.has(id)) byCol.set(id, []);
      });
    });

    const all = [];
    byCol.forEach((list, colId) => {
      const col = live.get(colId) || archived.get(colId);
      if (!col) return;   // closed for good
      const isArchived = !live.has(colId);
      const latest = list[list.length - 1] || null;
      const term = isArchived ? null : col;
      const remembered = !latest && col.lastReceipt ? { status: col.lastReceipt.failed ? 'failed' : col.lastReceipt.explicit ? 'done' : 'stopped', receipt: col.lastReceipt } : null;
      const { status, detail } = nodeStatus(latest || remembered, term);
      const sent = list.map((t) => t.sentAt || 0);
      all.push({
        id: colId, kind: 'worker', title: oneLine(col.title, 120) || 'Terminal',
        project: oneLine(col.project ?? (latest && latest.project), 120),
        reviews: Array.isArray(col.reviews) ? col.reviews : (latest && Array.isArray(latest.reviews) ? latest.reviews : []),
        provider: col.provider || '', model: col.model || '',
        status, statusLabel: STATUS_LABEL[status], detail,
        line: receiptLine(latest || remembered, col.lastReceipt),
        full: receiptFull(latest || remembered, col.lastReceipt),
        live: !isArchived && status === 'working' ? oneLine(col.live, 90) : '',
        archived: isArchived, review: false, taskCount: list.length,
        firstSentAt: sent.length ? Math.min(...sent) : 0,
        lastSentAt: sent.length ? Math.max(...sent) : 0,
        ts: Math.max(latest ? latest.doneAt || latest.startedAt || latest.sentAt || 0 : 0, col.archivedAt || 0),
        files: latest && latest.receipt && Array.isArray(latest.receipt.files) ? latest.receipt.files.map(String) : [],
        returned: returnKind(latest || remembered, col.lastReceipt),
      });
    });
    // work waiting for a free slot has no terminal yet
    tasks.filter((t) => !t.colId && t.status === 'waiting').forEach((t) => {
      all.push({
        id: 'wait:' + t.id, kind: 'waiting', title: oneLine(t.title, 120) || '排队中的活',
        project: oneLine(t.project, 120), reviews: Array.isArray(t.reviews) ? t.reviews : [],
        provider: '', model: '', status: 'queued', statusLabel: STATUS_LABEL.queued, detail: '等空位',
        line: '', full: '', live: '', archived: false, review: false, taskCount: 1,
        firstSentAt: t.sentAt || 0, lastSentAt: t.sentAt || 0, ts: t.sentAt || 0, files: [], returned: '',
      });
    });
    all.sort((a, b) => a.firstSentAt - b.firstSentAt || (a.id < b.id ? -1 : 1));

    // AgentDeck and agentdeck are one project; the spelling shown is the one the
    // earliest session used. Stored names are never rewritten.
    const spelling = new Map();
    all.forEach((n) => {
      const key = n.project.toLowerCase();
      if (!spelling.has(key)) spelling.set(key, n.project);
      n.project = spelling.get(key);
    });

    const reviews = detectReviews(all);
    all.forEach((n) => { n.review = reviews.reviewers.has(n.id); });

    const projects = new Map();
    all.forEach((n) => {
      if (!projects.has(n.project)) projects.set(n.project, { key: n.project, name: n.project || '其他', nodes: [], counts: {} });
      const p = projects.get(n.project);
      p.nodes.push(n);
      // the same tally as 队长's box: sessions still on the map, not archived history
      if (!n.archived) p.counts[n.status] = (p.counts[n.status] || 0) + 1;
    });
    // inactive: nothing in it is running, waiting on an answer or queued
    projects.forEach((p) => { p.completed = p.nodes.every((n) => n.status === 'done'); p.inactive = !p.nodes.some((n) => ACTIVE.includes(n.status)); });
    // A project with nothing left to do (every session on the map is done) leaves
    // the map; a new session brings it back. A failed, stopped or idle one still
    // needs 队长, so it stays. The archive view shows every project.
    const gone = new Set();
    if (!input.showArchived) projects.forEach((p, key) => { if (!p.nodes.some((n) => !n.archived && n.status !== 'done')) gone.add(key); });
    gone.forEach((key) => projects.delete(key));
    const onMap = all.filter((n) => !gone.has(n.project));

    // An archived session a visible review still links to stays (faded): the chain stays whole.
    const current = new Set(onMap.filter((n) => !n.archived).map((n) => n.id));
    const linked = new Set(reviews.edges.filter((e) => current.has(e.from) || current.has(e.to)).flatMap((e) => [e.from, e.to]));
    const visible = onMap.filter((n) => input.showArchived || !n.archived || linked.has(n.id));
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
    onMap.filter((n) => !n.archived).forEach((n) => { counts[n.status] = (counts[n.status] || 0) + 1; });
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
      captain, nodes: visible, edges, counts, projects: [...projects.values()].sort((a, b) => !a.key - !b.key),
      archivedCount: all.filter((n) => n.archived).length,
      hiddenArchived: all.length - visible.length,
    };
  }

  // 「2 干活中 · 1 待补充 · 3 已完成」 for the 队长 card.
  function summaryLine(counts) {
    const order = ['working', 'input', 'queued', 'failed', 'done', 'stopped', 'idle'];
    return order.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABEL[s]}`).join(' · ') || '还没有派出去的活';
  }

  // Is this project folded? A saved choice wins; otherwise finished projects
  // fold (tray mode: every project with nothing active in it).
  function isCollapsed(p, overrides, tray) {
    const v = overrides && overrides[p.key];
    return typeof v === 'boolean' ? v : !!(tray ? p.inactive : p.completed);
  }

  // The bottom tray: every inactive project that has something to show, whether
  // it is tucked away (the default) or opened onto the canvas by the user.
  function trayProjects(map, overrides) {
    const shown = new Set(map.nodes.map((n) => n.id));
    return map.projects.filter((p) => p.inactive && p.nodes.some((n) => shown.has(n.id))).map((p) => ({
      key: p.key, name: p.name, counts: p.counts, failed: p.counts.failed || 0, expanded: !isCollapsed(p, overrides, true),
    }));
  }
  // 「4 个项目（3 个已完成 · 1 个失败）」
  function traySummary(list) {
    const failed = list.filter((p) => p.failed).length, done = list.filter((p) => !p.failed && !p.counts.stopped).length, other = list.length - failed - done;
    const parts = [done && `${done} 个已完成`, failed && `${failed} 个失败`, other && `${other} 个已停下`].filter(Boolean);
    return `${list.length} 个项目` + (parts.length ? `（${parts.join(' · ')}）` : '');
  }

  // New activity brings a folded project back. prev: { key: [active node ids] }
  // from the last render (null on the first one, which only records). A saved
  // "folded" is dropped when a session in that project starts or resumes work;
  // a saved "open" is dropped once the project is active, so it tucks itself
  // away again when it finishes.
  function reopenOnActivity(prev, projects, overrides) {
    const active = {}, out = { ...(overrides || {}) }, reopened = [];
    projects.forEach((p) => {
      const ids = p.nodes.filter((n) => ACTIVE.includes(n.status)).map((n) => n.id);
      active[p.key] = ids;
      if (!prev) return;
      const before = prev[p.key] || [];
      if (out[p.key] === true && ids.some((id) => !before.includes(id))) { delete out[p.key]; reopened.push(p.key); }
      else if (out[p.key] === false && ids.length) delete out[p.key];
    });
    return { active, overrides: out, reopened };
  }

  // Scale and offset that show `bounds` whole and centred in a w×h viewport,
  // clear of `insets` (toolbars, margins). Never zooms past limits.max.
  function computeFit(bounds, size, insets, limits) {
    const i = { top: 0, right: 0, bottom: 0, left: 0, ...insets }, l = { min: MIN_SCALE, max: 1, ...limits };
    const bw = Math.max(1, bounds.right - bounds.left), bh = Math.max(1, bounds.bottom - bounds.top);
    const w = Math.max(1, size.w - i.left - i.right), h = Math.max(1, size.h - i.top - i.bottom);
    const scale = Math.max(l.min, Math.min(l.max, w / bw, h / bh));
    return { scale, x: i.left + (w - bw * scale) / 2 - bounds.left * scale, y: i.top + (h - bh * scale) / 2 - bounds.top * scale };
  }

  // Pack projects into shelves and wrap sessions within each project. Review
  // sessions get their own rows below workers; every coordinate is group-local.
  // grid: rows keep to one column grid (a shared line channel left of each
  // column); center: each shelf is centred under 队长; tray: inactive folded
  // projects and projects with nothing to show take no room on the canvas.
  function layout(map, opts) {
    const o = { nodeW: 220, nodeH: 122, captainW: 300, captainH: 96, gapX: 24, clusterGap: 52, fanY: 100, gapY: 80, padX: 44, padBottom: 28, pad: 40, fold: false, collapsedProjects: {}, maxWidth: 0, columnsPerProject: Infinity, grid: false, center: false, tray: false, ...opts };
    const rowGap = Number.isFinite(o.rowGap) ? o.rowGap : o.gapY, reviewGap = Number.isFinite(o.reviewGap) ? o.reviewGap : o.gapY;
    const pos = new Map(), groups = [], shelves = [];
    const shown = new Set(map.nodes.map((n) => n.id));
    let x = o.pad, y = o.pad + o.captainH + o.fanY, shelfH = 0, fold = null, shelf = null;
    map.projects.forEach((p) => {
      const collapsed = isCollapsed(p, o.collapsedProjects, o.tray);
      const nodes = p.nodes.filter((n) => shown.has(n.id));
      let workers = nodes.filter((n) => !n.review);
      const reviewers = nodes.filter((n) => n.review), hasFold = o.fold && !p.key;
      if (o.tray && ((collapsed && p.inactive) || (!nodes.length && !hasFold))) return;
      const count = Math.max(workers.length + (hasFold ? 1 : 0), reviewers.length, 1);
      const cols = Math.max(1, Math.min(count, o.columnsPerProject, o.maxWidth ? Math.floor((o.maxWidth - 2 * o.padX + o.gapX) / (o.nodeW + o.gapX)) : count));
      // Reviewed outputs sit next to the review row, avoiding cables through
      // intervening cards when the worker grid wraps.
      if (workers.length > cols && reviewers.length) {
        const targets = new Set(reviewers.flatMap((n) => n.reviews));
        workers = [...workers.filter((n) => !targets.has(n.id)), ...workers.filter((n) => targets.has(n.id))];
      }
      const rows = [];
      const chunk = (list, review) => { for (let i = 0; i < list.length; i += cols) rows.push({ items: list.slice(i, i + cols), review }); };
      chunk([...workers, ...(hasFold ? [null] : [])], false);
      chunk(reviewers, true);
      // a review row sits a little lower: the review lines turn in that gap
      let top = 0;
      rows.forEach((row, r) => { if (r) top += o.nodeH + (row.review ? reviewGap : rowGap); row.top = top; });
      const w = collapsed ? 320 : cols * o.nodeW + (cols - 1) * o.gapX + 2 * o.padX;
      const h = collapsed ? 56 : 52 + top + o.nodeH + o.padBottom;
      if (o.maxWidth && x > o.pad && x + w > o.pad + o.maxWidth) {
        x = o.pad;
        y += shelfH + o.clusterGap;
        shelfH = 0;
        shelf = null;
      }
      const g = { ...p, x, y, w, h, collapsed };
      groups.push(g);
      if (!shelf) shelves.push(shelf = { keys: [], right: 0 });
      shelf.keys.push(p.key);
      shelf.right = x + w;
      if (!collapsed) rows.forEach((row, r) => {
        const start = o.grid ? x + o.padX : x + (w - row.items.length * o.nodeW - Math.max(0, row.items.length - 1) * o.gapX) / 2;
        row.items.forEach((n, i) => {
          const bx = start + i * (o.nodeW + o.gapX), by = y + 52 + row.top;
          if (n) pos.set(n.id, { x: bx, y: by, anchorY: by, w: o.nodeW, h: o.nodeH, row: r + 1, project: p.key });
          else fold = { x: bx, y: by + o.nodeH / 2 - 16, w: 150, h: 32, project: p.key };
        });
      });
      x += w + o.clusterGap;
      shelfH = Math.max(shelfH, h);
    });
    const right = Math.max(o.pad, ...shelves.map((s) => s.right));
    const returnCount = map.edges.filter((e) => e.type === 'return').length;
    const width = Math.max(o.pad + o.captainW, right) + o.pad + returnCount * 7;
    const captain = map.captain ? { x: (width - o.captainW) / 2, y: o.pad, w: o.captainW, h: o.captainH, row: 0 } : null;
    const lay = { captain, nodes: pos, groups, fold, grid: !!o.grid, width, height: Math.max(o.pad + o.captainH, ...groups.map((g) => g.y + g.h)) + o.pad + returnCount * 7 };
    if (o.center) {
      const mid = captain ? captain.x + captain.w / 2 : width / 2;
      shelves.forEach((s) => { const dx = Math.round(mid - (o.pad + s.right) / 2); if (dx) s.keys.forEach((key) => translateProject(lay, key, dx, 0)); });
      // a shelf wider than 队长 is the canvas width; a narrower one never leaves it
      const left = Math.min(o.pad, ...groups.map((g) => g.x));
      if (left < o.pad) { groups.forEach((g) => translateProject(lay, g.key, o.pad - left, 0)); if (captain) captain.x += o.pad - left; lay.width += o.pad - left; }
    }
    return lay;
  }

  function constrainPosition(lay, box, p) {
    const g = lay.groups.find((g) => g.key === box.project);
    if (!g) return p;
    return { x: Math.max(g.x + 20, Math.min(g.x + g.w - box.w - 20, p.x)), y: Math.max(box.anchorY - 12, Math.min(box.anchorY + 12, p.y)) };
  }

  function translateProject(lay, key, dx, dy) {
    const g = lay.groups.find((g) => g.key === key);
    if (!g) return;
    g.x += dx; g.y += dy;
    lay.nodes.forEach((b) => { if (b.project === key) { b.x += dx; b.y += dy; b.anchorY += dy; } });
    if (lay.fold && lay.fold.project === key) { lay.fold.x += dx; lay.fold.y += dy; }
  }

  // Manual project offsets and card positions survive refresh/reopen until 整理.
  function applyPositions(lay, positions, captainId, projectPositions = {}) {
    const p = positions || {};
    const ok = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y);
    lay.groups.forEach((g) => { if (ok(projectPositions[g.key])) translateProject(lay, g.key, projectPositions[g.key].x, projectPositions[g.key].y); });
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

  // Drop repeated points and the middle of straight runs (rounded corners need real turns).
  function tidy(points) {
    const out = [];
    points.forEach((p) => {
      const a = out[out.length - 1];
      if (a && Math.abs(a[0] - p[0]) < 0.5 && Math.abs(a[1] - p[1]) < 0.5) return;
      const b = out[out.length - 2];
      if (a && b && ((Math.abs(b[0] - a[0]) < 0.5 && Math.abs(a[0] - p[0]) < 0.5) || (Math.abs(b[1] - a[1]) < 0.5 && Math.abs(a[1] - p[1]) < 0.5))) out.pop();
      out.push(p);
    });
    return out;
  }

  // The shared part of the dispatch tree, drawn once: the trunk out of 队长,
  // and the main bus to each side of the hub up to where the outermost
  // feeder turns down. takeoffs: feeders that branch off mid-bus.
  function spine(list) {
    const d = list.filter((r) => r.type === 'dispatch' && r.hub);
    if (!d.length) return null;
    const [cx, sy] = d[0].points[0], [, y] = d[0].hub;
    const xs = [...new Set(d.map((r) => r.feederX))];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const work = (pick) => d.some((r) => pick(r.feederX) && /\bst-working\b/.test(r.cls) && !/\barchived\b/.test(r.cls));
    const arm = (x) => [[cx, y], [x, y], [x, y + Math.min(10, Math.abs(x - cx) / 2)]];
    return {
      hub: [cx, y], trunk: [[cx, sy], [cx, y]], active: work(() => true),
      left: minX < cx - 0.5 ? { points: arm(minX), active: work((x) => x < cx - 0.5) } : null,
      right: maxX > cx + 0.5 ? { points: arm(maxX), active: work((x) => x > cx + 0.5) } : null,
      takeoffs: xs.filter((x) => x > minX + 0.5 && x < maxX - 0.5 && Math.abs(x - cx) > 0.5).map((x) => [x, y]),
    };
  }

  // Every line as orthogonal points. 派出 (dispatch) leaves the bottom of 队长
  // and enters a session's top (a review session's left side); 审查 runs from
  // the bottom of a reviewed session down into its review; 收回 (return)
  // leaves a session's bottom-right corner, runs under everything and up the
  // right edge into 队长's right side, so out and back never share a stretch.
  function routes(map, lay, opts) {
    const o = { clusterGap: 64, gapX: 24, lane: 7, ...opts };
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
    // One tree, like a circuit board: a trunk from 队长's bottom centre to a
    // hub on the main bus, one feeder per project dropping from the bus to
    // that project's own bus just above its box (through a gap between other
    // projects when one is in the way), and each card hanging off its
    // project's bus. Lines of a tree share their trunk and buses on purpose.
    const laneUse = new Map();
    const items = map.edges.filter((e) => e.type === 'dispatch' && box(e.to)).map((e) => {
      const b = box(e.to);
      const n = status.get(e.to);
      const side = n.review || b.row > 1;
      // a review session is entered from the left, down the gap left of what it reviews
      const targets = n.review ? (reviewOf.get(e.to) || []).map(box) : [];
      // on a grid every column has one channel on its left, shared by the rows below the first
      let lx = side ? (lay.grid ? b.x : Math.min(b.x, ...targets.map((t) => t.x))) - (n.review && !lay.grid ? o.clusterGap : o.gapX) / 2 : 0;
      if (side && !lay.grid) {
        // lanes down a gap: one per session entered from it
        const used = laneUse.get(Math.round(lx)) || 0;
        laneUse.set(Math.round(lx), used + 1);
        lx -= used * o.lane;
      }
      return { e, b, n, side, lx, hx: side ? lx : b.x + b.w / 2 };
    });
    const cx = cap.x + cap.w / 2, sy = cap.y + cap.h;
    const projects = new Map();
    items.forEach((d) => {
      if (!projects.has(d.b.project)) projects.set(d.b.project, { key: d.b.project, g: lay.groups.find((g) => g.key === d.b.project), items: [] });
      projects.get(d.b.project).items.push(d);
    });
    const tops = [...projects.values()].map((p) => (p.g ? p.g.y : Math.min(...p.items.map((d) => d.b.y))));
    const yMain = Math.round(sy + Math.max(8, Math.min(22, (Math.min(...tops) - sy) / 3)));
    const half = o.clusterGap / 2;
    const blocked = (x, y1, y2, own) => lay.groups.some((g) => g !== own && x > g.x - 6 && x < g.x + g.w + 6 && y2 > g.y && y1 < g.y + g.h);
    const gutters = new Map();
    projects.forEach((p) => {
      const xs = p.items.map((d) => d.hx);
      p.yL = Math.max(yMain + 20, (p.g ? p.g.y : Math.min(...p.items.map((d) => d.b.y))) - 16);
      p.ideal = Math.min(Math.max(...xs), Math.max(Math.min(...xs), cx));
      p.fx = p.ideal;
      if (!blocked(p.ideal, yMain, p.yL, p.g)) return;
      // the nearest gap beside a project in the way
      const between = lay.groups.filter((g) => g !== p.g && g.y < p.yL && g.y + g.h > yMain);
      const gaps = between.flatMap((g) => [g.x - half, g.x + g.w + half]).filter((x) => x >= 0 && !blocked(x, yMain, p.yL, p.g));
      if (!gaps.length) return;
      const gx = gaps.reduce((a, b) => (Math.abs(b - p.ideal) < Math.abs(a - p.ideal) ? b : a));
      const dir = p.ideal >= gx ? 1 : -1;
      const key = Math.round(gx) + ':' + dir;
      if (!gutters.has(key)) gutters.set(key, []);
      gutters.get(key).push(p);
      p.gx = gx; p.dir = dir;
    });
    // projects sharing a gap: the nearest takes the gap's middle, farther ones
    // step inward and higher so no feeder crosses another
    gutters.forEach((list) => list.sort((a, b) => Math.abs(a.ideal - a.gx) - Math.abs(b.ideal - b.gx)).forEach((p, k) => {
      p.fx = p.gx + p.dir * k * o.lane;
      p.yL -= k * o.lane;
    }));
    const feeders = [...projects.values()].map((p) => p.fx);
    const minX = Math.min(cx, ...feeders), maxX = Math.max(cx, ...feeders);
    const R = 10;
    projects.forEach((p) => p.items.forEach((d) => {
      const tail = d.side
        ? [[d.lx, p.yL], [d.lx, d.b.y + d.b.h / 2 - 14], [d.b.x - 2, d.b.y + d.b.h / 2 - 14]]
        : [[d.hx, p.yL], [d.hx, d.b.y - 2]];
      // the outermost feeders turn off the end of the main bus; others branch off it
      const end = Math.abs(p.fx - cx) > 0.5 && (Math.abs(p.fx - minX) < 0.5 || Math.abs(p.fx - maxX) < 0.5);
      const cls = `dispatch st-${d.n.status}${d.n.archived ? ' archived' : ''}`;
      out.push({
        type: 'dispatch', from: d.e.from, to: d.e.to, cls, project: p.key,
        hub: [cx, yMain], feederX: p.fx,
        points: tidy([[cx, sy], [cx, yMain], [p.fx, yMain], [p.fx, p.yL], ...tail]),
        branch: tidy([[p.fx, yMain + (end ? Math.min(R, Math.abs(p.fx - cx) / 2) : 0)], [p.fx, p.yL], ...tail]),
      });
    }));
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
        out.push({ type: 'review', from: it.t, to: id, cls: `review st-${n.status}${n.archived ? ' archived' : ''}`, points: pts });
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

  // Saved state of the map: { mode, positions: { id: {x,y} }, view: { x, y, scale }, showReturn, collapsedProjects }.
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
    const collapsedProjects = Object.fromEntries(Object.entries(s.collapsedProjects || {}).slice(0, 500).filter(([key, value]) => key.length <= 120 && typeof value === 'boolean'));
    const projectPositions = Object.fromEntries(Object.entries(s.projectPositions || {}).slice(0, 500).filter(([key, p]) => key.length <= 120 && p && Number.isFinite(p.x) && Number.isFinite(p.y)).map(([key, p]) => [key, { x: Math.round(p.x), y: Math.round(p.y) }]));
    return { projectPositions, mode: s.mode === 'canvas' ? 'canvas' : 'crew', positions, view, collapsedProjects, showReturn: !!s.showReturn };
  }
  const MIN_SCALE = 0.3, MAX_SCALE = 1.6;

  // A change in anything but the live activity line rebuilds the map.
  function signature(map) {
    const n = (x) => [x.id, x.status, x.detail, x.title, x.provider, x.model, x.line, x.archived ? 1 : 0, x.review ? 1 : 0, x.project || '', (x.reviews || []).join(',')].join('\u0001');
    return [map.captain ? n(map.captain) : '', ...map.nodes.map(n), ...map.edges.map((e) => `${e.type}:${e.from}>${e.to}:${e.kind || ''}`), map.hiddenArchived, ...map.projects.map((p) => `${p.key}:${p.completed}:${p.inactive}:${summaryLine(p.counts)}`)].join('\u0002');
  }

  // The project palette shared by the crew map and the task board: a golden-angle
  // step keyed by the project name, so one project keeps one colour in every
  // view no matter which other projects are on screen. Case and surrounding
  // spaces do not count (AgentDeck = agentdeck). '' (其他) is the base hue.
  function projectHue(key) {
    const name = String(key == null ? '' : key).trim().toLowerCase();
    if (!name) return 210;
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return Math.round(((210 + (1 + h % 1009) * 137.508) % 360) * 10) / 10;
  }

  return { STATUS_LABEL, ACTIVE, MIN_SCALE, MAX_SCALE, projectHue, nodeStatus, receiptLine, receiptFull, isCollapsed, trayProjects, traySummary, reopenOnActivity, computeFit, returnKind, detectReviews, buildCrewMap, layout, constrainPosition, translateProject, applyPositions, routes, spine, tidy, nestRanks, normalizeSaved, signature, summaryLine };
});
