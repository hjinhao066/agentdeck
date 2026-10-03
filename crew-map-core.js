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
      });
    });
    // work waiting for a free slot has no terminal yet
    tasks.filter((t) => !t.colId && t.status === 'waiting').forEach((t) => {
      all.push({
        id: 'wait:' + t.id, kind: 'waiting', title: oneLine(t.title, 120) || '排队中的活',
        provider: '', model: '', status: 'queued', statusLabel: STATUS_LABEL.queued, detail: '等空位',
        line: '', live: '', archived: false, review: false, taskCount: 1,
        firstSentAt: t.sentAt || 0, lastSentAt: t.sentAt || 0, ts: t.sentAt || 0, files: [],
      });
    });
    all.sort((a, b) => a.firstSentAt - b.firstSentAt || (a.id < b.id ? -1 : 1));

    const reviews = detectReviews(all.filter((n) => n.kind === 'worker'), input.prompts || {});
    all.forEach((n) => { n.review = reviews.reviewers.has(n.id); });

    const visible = all.filter((n) => input.showArchived || !n.archived);
    const shown = new Set(visible.map((n) => n.id));
    const captainId = input.captain ? input.captain.id : '';
    const edges = [
      ...visible.map((n) => ({ from: captainId, to: n.id, type: 'dispatch' })),
      ...reviews.edges.filter((e) => shown.has(e.from) && shown.has(e.to)),
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
      hiddenArchived: input.showArchived ? 0 : all.filter((n) => n.archived).length,
    };
  }

  // 「2 干活中 · 1 待补充 · 3 已完成」 for the 队长 card.
  function summaryLine(counts) {
    const order = ['working', 'input', 'queued', 'failed', 'done', 'stopped', 'idle'];
    return order.filter((s) => counts[s]).map((s) => `${counts[s]} ${STATUS_LABEL[s]}`).join(' · ') || '还没有派出去的活';
  }

  // Rows: 队长 on row 0; the sessions it handed work to fill the next rows,
  // perRow to a row on a shared column grid (oldest work first), so lines to
  // a later row run down the gaps between cards. A review session sits one
  // row below the deepest session it reviews, as close to their middle as it
  // can. opts.fold reserves one more slot after the last session (the pill
  // standing for archived sessions).
  function layout(map, opts) {
    const o = { nodeW: 232, nodeH: 132, captainW: 300, gapX: 28, gapY: 76, pad: 40, perRow: Infinity, fold: false, ...opts };
    const perRow = Math.max(1, Math.floor(o.perRow) || 1);
    const ids = new Set(map.nodes.map((n) => n.id));
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
      const targets = (reviewOf.get(id) || []).filter((t) => ids.has(t));
      const d = targets.length ? 1 + Math.max(...targets.map((t) => depthOf(t, seen))) : 1;
      depth.set(id, d);
      return d;
    };
    map.nodes.forEach((n) => depthOf(n.id, new Set()));
    const step = o.nodeW + o.gapX;
    const rowY = (r) => o.pad + (r === 0 ? 0 : o.nodeH + o.gapY + (r - 1) * (o.nodeH + o.gapY));
    const pos = new Map();
    const first = map.nodes.filter((n) => depth.get(n.id) === 1);
    const slots = first.length + (o.fold ? 1 : 0);
    const cols = Math.max(1, Math.min(perRow, slots));
    const gridRows = Math.max(1, Math.ceil(slots / cols));
    first.forEach((n, i) => pos.set(n.id, { x: o.pad + (i % cols) * step, y: rowY(1 + Math.floor(i / cols)), w: o.nodeW, h: o.nodeH, row: 1 + Math.floor(i / cols) }));
    const fold = o.fold ? { x: o.pad + (first.length % cols) * step, y: rowY(1 + Math.floor(first.length / cols)), w: o.nodeW, h: o.nodeH, row: 1 + Math.floor(first.length / cols) } : null;
    const maxDepth = Math.max(1, ...[...depth.values()]);
    let lastRow = gridRows;
    for (let d = 2; d <= maxDepth; d++) {
      const row = gridRows + d - 1;
      let nextFree = o.pad;
      map.nodes.filter((n) => depth.get(n.id) === d).forEach((n) => {
        const xs = (reviewOf.get(n.id) || []).map((t) => pos.get(t)).filter(Boolean).map((p) => p.x + p.w / 2);
        const want = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 - o.nodeW / 2 : nextFree;
        const x = Math.max(nextFree, want);
        pos.set(n.id, { x, y: rowY(row), w: o.nodeW, h: o.nodeH, row });
        nextFree = x + step;
        lastRow = row;
      });
    }
    let right = o.pad + Math.max(o.captainW, cols * step - o.gapX);
    pos.forEach((p) => { right = Math.max(right, p.x + p.w); });
    const contentW = right - o.pad;
    const captain = map.captain
      ? { x: o.pad + Math.max(0, (Math.min(contentW, cols * step - o.gapX) - o.captainW) / 2), y: rowY(0), w: o.captainW, h: o.nodeH, row: 0 }
      : null;
    // the gaps between grid columns: where lines to later rows run down
    const gaps = Array.from({ length: cols + 1 }, (_, i) => o.pad + i * step - o.gapX / 2);
    return {
      captain, nodes: pos, fold, rows: lastRow, cols,
      width: right + o.pad, height: rowY(lastRow) + o.nodeH + o.pad,
      rowY, laneY: (r) => rowY(r) - o.gapY / 2, gaps,
    };
  }

  // A change in anything but the live activity line rebuilds the map.
  function signature(map) {
    const n = (x) => [x.id, x.status, x.detail, x.title, x.provider, x.model, x.line, x.archived ? 1 : 0, x.review ? 1 : 0].join('\u0001');
    return [map.captain ? n(map.captain) : '', ...map.nodes.map(n), ...map.edges.map((e) => `${e.type}:${e.from}>${e.to}`), map.hiddenArchived].join('\u0002');
  }

  return { STATUS_LABEL, ACTIVE, REVIEW_RE, nodeStatus, receiptLine, detectReviews, buildCrewMap, layout, signature, summaryLine };
});
