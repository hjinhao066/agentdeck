// Pure helpers behind 队伍 (the crew map): 队长 at the top, a line down
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
    // a web request behind another one has not been sent yet, whatever its terminal says
    if (task && task.status === 'working' && task.webPhase === 'queued') return { status: 'queued', detail: '等网页空出来' };
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

  // A restart's own bookkeeping (「重发：… 无法续上原对话」, the checkpoint note) is not news
  // from the session: on the map it counts as no receipt at all.
  const real = (r) => (r && !(r.checkpoint && !r.question && !r.failed) ? r : null);

  // The one line under a node: its newest receipt (question / failure / summary).
  function receiptLine(task, lastReceipt) {
    const r = real(task && task.receipt), last = real(lastReceipt);
    if (r && r.question) return '提问：' + oneLine(r.question);
    if (r && r.failed) return '失败：' + oneLine(r.failed);
    if (r && r.summary) return oneLine(r.summary);
    if (last && last.summary) return oneLine(last.summary);
    return '';
  }

  // The same receipt, whole, for the detail popover.
  function receiptFull(task, lastReceipt) {
    const r = real(task && task.receipt), last = real(lastReceipt);
    const full = (s) => String(s == null ? '' : s).trim().slice(0, 4000);
    if (r && r.question) return '提问：' + full(r.question);
    if (r && r.failed) return '失败：' + full(r.failed);
    if (r && r.summary) return full(r.summary);
    return last && last.summary ? full(last.summary) : '';
  }

  // What came back to 队长 from a session: '' (nothing yet), 'ok', 'question', 'failed'.
  function returnKind(task, lastReceipt) {
    const r = real(task && task.receipt);
    lastReceipt = real(lastReceipt);
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
  //   columns: [{ id, title, alive, state, live, provider, model, lastReceipt, captainCrew, subCaptain, subCaptainId, taskId, parentTaskId, taskCompleted, result }],
  //   archived: [{ id, title, provider, model, lastReceipt, captainCrew, archivedAt, subCaptain, subCaptainId, taskId, parentTaskId, taskCompleted, result }],
  //   tasks: config.mainSession.tasks, showArchived
  // }
  // 小队长: a session 队长 opened with `new --sub-captain` (column.subCaptain) leads the sessions it opens
  // (their column.subCaptainId is its column id, until they are handed back to 队长), but only while it is
  // still a live column marked subCaptain. The older create-child records count too (the child's
  // parentTaskId is its parent's taskId). Its crew stands under it in its project (node.parent,
  // node.depth), its lines come from it ('squad' edges), and what they hand back or ask goes to it, not
  // to 队长. node.crew: how many it leads on the map; node.leader: it is a 小队长.
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
    // A 小队长's crew comes with it, however deep, though 队长 never handed them a card.
    const sessions = [...(input.columns || []), ...(input.archived || [])];
    const leaders = new Set((input.columns || []).filter((c) => c.subCaptain === true).map((c) => c.id));
    const byTask = new Map(sessions.filter((c) => c.taskId).map((c) => [c.taskId, c.id]));
    const parentOf = (c) => {
      if (c.subCaptainId && c.subCaptainId !== c.id && leaders.has(c.subCaptainId)) return c.subCaptainId;
      const id = c.parentTaskId ? byTask.get(c.parentTaskId) : '';
      return id && id !== c.id ? id : '';
    };
    for (let grew = true; grew;) {
      grew = false;
      sessions.forEach((c) => { if (!byCol.has(c.id) && byCol.has(parentOf(c))) { byCol.set(c.id, []); grew = true; } });
    }

    const all = [];
    byCol.forEach((list, colId) => {
      const col = live.get(colId) || archived.get(colId);
      if (!col) return;   // closed for good
      const isArchived = !live.has(colId);
      const latest = list[list.length - 1] || null;
      const term = isArchived ? null : col;
      // (a crew member's result went to its 小队长: create-child keeps it on the session itself)
      const kept = real(col.lastReceipt) || (col.taskCompleted && col.result ? { summary: String(col.result), explicit: true } : null);
      const remembered = !latest && kept ? { status: kept.failed ? 'failed' : kept.explicit ? 'done' : 'stopped', receipt: kept } : null;
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
        // what the session last said about its own progress (board-cli progress), while it works
        progress: !isArchived && status === 'working' && latest && typeof latest.progress === 'string' ? oneLine(latest.progress, 120) : '',
        archived: isArchived, review: false, taskCount: list.length,
        // 高优先级: the user named this work as urgent (a live session only).
        important: !isArchived && col.important === true,
        firstSentAt: sent.length ? Math.min(...sent) : 0,
        lastSentAt: sent.length ? Math.max(...sent) : 0,
        ts: Math.max(latest ? latest.doneAt || latest.startedAt || latest.sentAt || 0 : 0, col.archivedAt || 0),
        files: latest && latest.receipt && Array.isArray(latest.receipt.files) ? latest.receipt.files.map(String) : [],
        returned: returnKind(latest || remembered, col.lastReceipt),
        parent: parentOf(col), subCaptain: col.subCaptain === true,
      });
    });
    // work waiting for a free slot has no terminal yet
    tasks.filter((t) => !t.colId && t.status === 'waiting').forEach((t) => {
      all.push({
        id: 'wait:' + t.id, kind: 'waiting', title: oneLine(t.title, 120) || '排队中的活',
        project: oneLine(t.project, 120), reviews: Array.isArray(t.reviews) ? t.reviews : [],
        provider: '', model: '', status: 'queued', statusLabel: STATUS_LABEL.queued, detail: '等空位',
        line: '', full: '', live: '', progress: '', archived: false, review: false, taskCount: 1, important: t.important === true,
        firstSentAt: t.sentAt || 0, lastSentAt: t.sentAt || 0, ts: t.sentAt || 0, files: [], returned: '', parent: '', subCaptain: false,
      });
    });
    all.sort((a, b) => a.firstSentAt - b.firstSentAt || (a.id < b.id ? -1 : 1));

    // A crew member stands in its 小队长's project, whatever its own record says. (A loop in the
    // records is cut where it closes.)
    const byId = new Map(all.map((n) => [n.id, n]));
    all.forEach((n) => { if (!byId.has(n.parent)) n.parent = ''; });
    all.forEach((n) => {
      const seen = new Set([n.id]);
      for (let p = n.parent; p; p = byId.get(p).parent) { if (seen.has(p)) { n.parent = ''; break; } seen.add(p); }
    });
    const rootOf = (n) => { let r = n; while (r.parent) r = byId.get(r.parent); return r; };
    all.forEach((n) => { if (n.parent) n.project = rootOf(n).project; });

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
    // a crew member whose 小队长 is not shown (archived) stands on its own, under 队长
    visible.forEach((n) => { if (n.parent && !shown.has(n.parent)) n.parent = ''; });
    const crew = new Map();
    visible.forEach((n) => { if (n.parent) crew.set(n.parent, (crew.get(n.parent) || 0) + 1); });
    visible.forEach((n) => {
      n.crew = crew.get(n.id) || 0;
      n.leader = n.crew > 0 || n.subCaptain;
      n.depth = 0;
      for (let p = n.parent; p; p = byId.get(p).parent) n.depth++;
      // a crew member asks its 小队长
      if (n.parent && n.detail === '在问队长') n.detail = '在问小队长';
    });
    const captainId = input.captain ? input.captain.id : '';
    const review = reviews.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
    // Results flow back to 队长 (a crew member's to its 小队长). A reviewed session's result goes on
    // through its review; only a question or a failure from it goes straight back.
    const reviewed = new Set(review.map((e) => e.from));
    const edges = [
      ...visible.filter((n) => !n.parent).map((n) => ({ from: captainId, to: n.id, type: 'dispatch' })),
      ...visible.filter((n) => n.parent).map((n) => ({ from: n.parent, to: n.id, type: 'squad' })),
      ...review,
      ...(captainId ? visible.filter((n) => !n.parent && n.returned && (!reviewed.has(n.id) || n.returned !== 'ok'))
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

  // The one line a card shows under its title: what the session is doing now (its terminal's
  // newest line, else what it last reported), what it asks, why it failed, or what it handed back.
  // kind: live | question | failed | receipt | empty (a quiet word, or nothing, where the status says it all).
  // (a terminal's own bullet in front of a live line, ⏺ ⎿ ✻ …, goes: the card draws its own)
  const bare = (s) => { const t = String(s || '').trim(); return t.replace(/^[\s⏺●•◦▸▹▪■◆◇✻✶✳✢⎿⏵*·>›❯–—-]+/u, '').trim() || t; };
  function cardLine(node) {
    if (!node) return { text: '', kind: 'empty' };
    if (node.kind === 'waiting') return { text: '会话数满了，有空位就自动开', kind: 'empty' };
    if (node.status === 'working') {
      if (node.live || node.progress) return { text: bare(node.live || node.progress), kind: 'live' };
      return node.line ? { text: node.line, kind: 'receipt' } : { text: '还没有进展', kind: 'empty' };
    }
    if (node.line) return { text: node.line, kind: /^提问：/.test(node.line) ? 'question' : /^失败：/.test(node.line) ? 'failed' : 'receipt' };
    if (node.status === 'input') return { text: '在终端里等你回答', kind: 'empty' };
    if (node.status === 'queued') return { text: '还没开始', kind: 'empty' };
    return { text: '', kind: 'empty' };
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

  // One project's frame when its cards sit at most `cap` wide: workers first,
  // review sessions on their own rows below. A 小队长 heads a block of its own: its crew under it
  // in its column, a step in (theirs a step more), a row each. Blocks fill the columns shortest
  // first, so a frame without a crew fills row by row; 小队长s' blocks come first. slots: where each
  // card stands, [{ n, col, row, depth }] (n null: the fold). null when it takes no room on the
  // canvas (tray: a folded inactive project, or one with nothing to show).
  function frame(p, o, shown, cap) {
    const collapsed = isCollapsed(p, o.collapsedProjects, o.tray);
    const nodes = p.nodes.filter((n) => shown.has(n.id));
    const crews = new Map();
    nodes.forEach((n) => { if (n.parent) { if (!crews.has(n.parent)) crews.set(n.parent, []); crews.get(n.parent).push(n); } });
    const heads = nodes.filter((n) => !n.parent);
    // (a review session with a crew of its own stands with the workers, its crew under it)
    let workers = heads.filter((n) => !n.review || crews.has(n.id));
    const reviewers = heads.filter((n) => n.review && !crews.has(n.id)), hasFold = !!o.fold && !p.key;
    if (o.tray && ((collapsed && p.inactive) || (!nodes.length && !hasFold))) return null;
    const count = Math.max(workers.length + (hasFold ? 1 : 0), reviewers.length, 1);
    const cols = Math.max(1, Math.min(count, cap));
    // Reviewed outputs sit next to the review row, avoiding cables through
    // intervening cards when the worker grid wraps.
    if (workers.length > cols && reviewers.length) {
      const targets = new Set(reviewers.flatMap((n) => n.reviews));
      workers = [...workers.filter((n) => !targets.has(n.id)), ...workers.filter((n) => targets.has(n.id))];
    }
    workers = [...workers.filter((n) => crews.has(n.id)), ...workers.filter((n) => !crews.has(n.id))];
    const slots = [], height = new Array(cols).fill(0);
    const put = (n, col, depth) => {
      slots.push({ n, col, row: height[col]++, depth });
      if (n) (crews.get(n.id) || []).forEach((k) => put(k, col, depth + 1));
    };
    [...workers, ...(hasFold ? [null] : [])].forEach((n) => put(n, height.indexOf(Math.min(...height)), 0));
    const workRows = Math.max(...height);
    reviewers.forEach((n, i) => slots.push({ n, col: i % cols, row: workRows + Math.floor(i / cols), depth: 0 }));
    const rowGap = Number.isFinite(o.rowGap) ? o.rowGap : o.gapY, reviewGap = Number.isFinite(o.reviewGap) ? o.reviewGap : o.gapY;
    // a review row sits a little lower: the review lines turn in that gap
    const rows = [];
    let top = 0;
    for (let r = 0; r < workRows + Math.ceil(reviewers.length / cols); r++) {
      if (r) top += o.nodeH + (r >= workRows ? reviewGap : rowGap);
      rows.push({ top, review: r >= workRows });
    }
    // A frame is never narrower than its own header (o.headW: what the project's whole name and its
    // tally need); the cards then stand centred in it, `inset` in from where they would start.
    const cardsW = cols * o.nodeW + (cols - 1) * o.gapX + 2 * o.padX;
    const w = Math.max(collapsed ? 320 : cardsW, Math.ceil((o.headW && o.headW[p.key]) || 0));
    return { p, collapsed, cols, count, rows, slots, w, inset: collapsed ? 0 : Math.round((w - cardsW) / 2), h: collapsed ? o.headH + 4 : o.headH + top + o.nodeH + o.padBottom };
  }
  // frame() kept in sized (a Map, for one map and one set of options): the many arrangements tried for one window share them
  const sizedFrame = (sized, p, o, shown, cap) => { const k = cap + '\u0001' + p.key; if (!sized.has(k)) sized.set(k, frame(p, o, shown, cap)); return sized.get(k); };
  // headH: the frame's title strip, above its first row of cards; crewIn: how far a crew stands in
  // from its 小队长 (its line runs down the middle of that step), crewPad: and in from its right edge
  const LAYOUT = { nodeW: 220, nodeH: 122, captainW: 300, captainH: 96, gapX: 24, clusterGap: 52, fanY: 100, gapY: 80, padX: 44, padBottom: 28, pad: 40, headH: 52, fold: false, collapsedProjects: {}, columnsPerProject: Infinity, grid: false, center: false, tray: false, lane: 7, crewIn: 24, crewPad: 8 };
  // Projects in the user's own order (the keys in `order` first, in that order), the rest as the map lists them.
  function ordered(projects, order) {
    if (!Array.isArray(order) || !order.length) return projects;
    const rank = new Map(order.map((key, i) => [key, i]));
    return projects.map((p, i) => ({ p, i })).sort((a, b) => (rank.has(a.p.key) ? rank.get(a.p.key) : Infinity) - (rank.has(b.p.key) ? rank.get(b.p.key) : Infinity) || a.i - b.i).map((x) => x.p);
  }
  // The gap between two lanes: room for the lines that run down it to the frames below each lane's first.
  const laneGap = (o, below) => Math.max(o.clusterGap, 20 + o.lane * below);

  // Frames stand in lanes: side by side across the map, and one under another
  // inside a lane, so a big project and several small ones fill the width
  // without a hole. Sessions wrap inside their frame, review sessions on rows of
  // their own; every coordinate is the canvas's. opts.lanes: [[project key, …], …]
  // (default: every project in a lane of its own), opts.caps: { key: cards wide }
  // (default: columnsPerProject), opts.order: the user's project order,
  // opts.headW: { key: the least width that frame's header needs }.
  // grid: rows keep to one column grid (a shared line channel left of each
  // column); center: the lanes are centred under 队长; tray: inactive folded
  // projects and projects with nothing to show take no room on the canvas.
  // lay.feeds says where the line to each frame below its lane's first comes
  // down (the gap beside the lane) and turns in (the gap above the frame).
  function layout(map, opts) {
    const o = { ...LAYOUT, ...opts };
    const pos = new Map(), groups = [], feeds = new Map();
    const shown = new Set(map.nodes.map((n) => n.id));
    const caps = o.caps || {};
    const frames = new Map();
    ordered(map.projects, o.order).forEach((p) => {
      const cap = Number.isFinite(caps[p.key]) ? caps[p.key] : o.columnsPerProject, f = o.sized ? sizedFrame(o.sized, p, o, shown, cap) : frame(p, o, shown, cap);
      if (f) frames.set(p.key, f);
    });
    const used = new Set();
    const lanes = (Array.isArray(o.lanes) ? o.lanes : []).map((keys) => keys.filter((key) => frames.has(key) && !used.has(key) && used.add(key)).map((key) => frames.get(key))).filter((l) => l.length);
    frames.forEach((f, key) => { if (!used.has(key)) lanes.push([f]); });   // a project no lane names stands in its own
    const widths = lanes.map((l) => Math.max(...l.map((f) => f.w)));
    const gaps = lanes.slice(1).map((l, i) => laneGap(o, lanes[i].length - 1 + l.length - 1));
    // one lane with frames under its first: their lines come down outside its left edge
    const outer = lanes.length === 1 && lanes[0].length > 1 ? o.clusterGap / 2 + o.lane * (lanes[0].length - 2) : 0;
    const lanesW = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    const returnCount = map.edges.filter((e) => e.type === 'return').length;
    const inner = Math.max(o.captainW, lanesW + outer);
    const width = inner + 2 * o.pad + returnCount * 7;
    const captain = map.captain ? { x: o.center ? o.pad + (inner - o.captainW) / 2 : (width - o.captainW) / 2, y: o.pad, w: o.captainW, h: o.captainH, row: 0 } : null;
    const top = o.pad + o.captainH + o.fanY;
    let fold = null, x = o.pad + outer + (o.center ? Math.round((inner - outer - lanesW) / 2) : 0);
    const lefts = [];
    lanes.forEach((lane, li) => {
      lefts.push(x);
      let y = top;
      lane.forEach((f) => {
        const g = { ...f.p, x, y, w: f.w, h: f.h, collapsed: f.collapsed, lane: li };
        groups.push(g);
        if (!f.collapsed) {
          // (off the grid a row stands centred in its frame; a frame with a crew keeps to its columns)
          const inRow = new Map();
          f.slots.forEach((s) => inRow.set(s.row, (inRow.get(s.row) || 0) + 1));
          const centred = !o.grid && f.slots.every((s) => !s.depth);
          f.slots.forEach((s) => {
            const k = inRow.get(s.row), d = Math.min(s.depth, 2);
            const start = centred ? x + (f.w - k * o.nodeW - Math.max(0, k - 1) * o.gapX) / 2 : x + o.padX + f.inset;
            const bx = start + s.col * (o.nodeW + o.gapX) + d * o.crewIn, by = y + o.headH + f.rows[s.row].top;
            if (s.n) pos.set(s.n.id, { x: bx, y: by, anchorY: by, w: o.nodeW - d * (o.crewIn + o.crewPad), h: o.nodeH, row: s.row + 1, project: f.p.key, depth: s.depth, parent: s.n.parent || '' });
            else fold = { x: bx, y: by + o.nodeH / 2 - 16, w: 150, h: 32, project: f.p.key };
          });
        }
        y += f.h + o.clusterGap;
      });
      x += widths[li] + (gaps[li] || 0);
    });
    // The lines to the frames under a lane's first: down the gap on the lane's side nearer 队长,
    // bundled in the middle of that gap, the lowest frame's line farthest from its lane so no
    // line crosses another.
    const cx = captain ? captain.x + captain.w / 2 : width / 2;
    const side = lanes.map((lane, li) => (lanes.length === 1 ? -1 : li === 0 ? 1 : li === lanes.length - 1 ? -1 : lefts[li] + widths[li] / 2 <= cx ? 1 : -1));
    const below = (li) => groups.filter((g) => g.lane === li).slice(1).reverse();   // lowest first
    for (let c = -1; c < lanes.length - 1; c++) {
      // corridor c lies between lane c and lane c + 1 (c = -1: outside the first lane)
      const left = c >= 0 && side[c] === 1 ? below(c) : [], right = side[c + 1] === -1 ? below(c + 1) : [];
      if (!left.length && !right.length) continue;
      const mid = c < 0 ? lefts[0] - o.clusterGap / 2 - o.lane * (right.length - 1) / 2 : lefts[c] + widths[c] + gaps[c] / 2;
      const slot = (t) => mid + o.lane * (t - (left.length + right.length - 1) / 2);
      left.forEach((g, s) => feeds.set(g.key, { x: slot(left.length - 1 - s), y: g.y - o.clusterGap / 2 }));
      right.forEach((g, s) => feeds.set(g.key, { x: slot(left.length + s), y: g.y - o.clusterGap / 2 }));
    }
    // rails: every card hangs off a line down the left of its column (see routes)
    const rails = o.grid && o.rails ? { x: Number.isFinite(o.railX) ? o.railX : o.gapX / 2, headH: o.headH, entry: Number.isFinite(o.entryTop) ? o.entryTop : 20 } : null;
    return { captain, nodes: pos, groups, fold, feeds, grid: !!o.grid, rails, crewIn: o.crewIn, width, height: Math.max(o.pad + o.captainH, ...groups.map((g) => g.y + g.h)) + o.pad + returnCount * 7 };
  }

  // The ground each 小队长's crew stands on: under the 小队长, as wide, from halfway down its card to
  // just under the last of its crew (theirs nested inside it). Outermost first. [{ id, project, depth, x, y, w, h }]
  function pockets(lay) {
    const end = new Map();
    lay.nodes.forEach((b) => {
      const seen = new Set();
      for (let p = b.parent; p && lay.nodes.has(p) && !seen.has(p); p = lay.nodes.get(p).parent) { seen.add(p); end.set(p, Math.max(end.get(p) || 0, b.y + b.h)); }
    });
    return [...end].map(([id, bottom]) => {
      const l = lay.nodes.get(id), top = l.y + l.h / 2;
      return { id, project: l.project, depth: l.depth || 0, x: l.x, y: top, w: l.w, h: bottom + 6 - top };
    }).sort((a, b) => a.depth - b.depth);
  }

  // Which lane each project stands in, for a window size.w wide (in the canvas's own units, at the
  // scale the map is shown at), when the map is taller than a page (智能一页 could not fit it: see
  // planPage). Each frame is as many cards wide as opts.caps asks (planPage's choice; one when it does
  // not say), fewer when the window cannot hold that frame. The projects
  // stand across the top in their order, as many abreast as the width holds, one lane each. Every
  // project after them goes under the lane that ends highest (of lanes ending within BAND of the
  // highest, the leftmost): the width is used before the height, and a big project grows down in
  // its own frame instead of pushing the others under it. Nothing is planned wider than the window,
  // so the map never scrolls sideways: when what is left over fits under no lane, fewer stand
  // across the top. opts.keep (the plan in use) stays while it still holds the same frames in the
  // same order, fits the width and is no more than LANE_KEEP times as tall as a fresh one, so a card
  // more or less does not move frames from lane to lane. The window's height is never asked.
  // opts.count: exactly that many lanes; opts.exact: the plan given, as it stands (both null when the frames cannot
  // stand so). Returns { lanes, caps }.
  const BAND = 48, LANE_KEEP = 1.15;
  function planAcross(map, size, opts) {
    const o = { ...LAYOUT, ...opts };
    const shown = new Set(map.nodes.map((n) => n.id));
    const sized = o.sized || new Map();
    const at = (p, c) => sizedFrame(sized, p, o, shown, c);
    const projects = ordered(map.projects, o.order).filter((p) => at(p, 1));
    const n = projects.length;
    if (!n) return { lanes: [], caps: {} };
    const availW = Math.max(1, size.w) - 2 * o.pad;
    // as wide as asked, narrower where the window cannot hold that frame
    const caps = new Map(projects.map((p) => { let c = Math.max(1, Math.floor((o.caps && o.caps[p.key]) || 1)); while (c > 1 && at(p, c).w > availW) c--; return [p.key, c]; }));
    const fr = (p) => at(p, caps.get(p.key));
    const height = (lane) => lane.reduce((h, p) => h + fr(p).h, 0) + (lane.length - 1) * o.clusterGap;
    // the lanes' width the way layout() lays them
    const across = (lanes) => {
      let w = 0;
      lanes.forEach((lane, l) => { w += Math.max(...lane.map((p) => fr(p).w)) + (l ? laneGap(o, lanes[l - 1].length - 1 + lane.length - 1) : 0); });
      return w + (lanes.length === 1 && lanes[0].length > 1 ? o.clusterGap / 2 + o.lane * (lanes[0].length - 2) : 0);
    };
    const fits = (lanes) => lanes.length === 1 || across(lanes) <= availW + 0.5;
    // one lane always stands, but no wider than the window: its line channel stands left of it, so its widest
    // frames give up columns until the two fit (or every frame is one card wide)
    const roomy = (lanes) => lanes.length > 1 || across(lanes) <= availW + 0.5 || lanes[0].every((p) => caps.get(p.key) === 1);
    const narrow = (lanes) => {
      while (!roomy(lanes)) { const p = lanes[0].filter((q) => caps.get(q.key) > 1).sort((a, b) => fr(b).w - fr(a).w)[0]; caps.set(p.key, caps.get(p.key) - 1); }
      return lanes;
    };
    const out = (lanes) => ({ lanes: lanes.map((lane) => lane.map((p) => p.key)), caps: Object.fromEntries(projects.map((p) => [p.key, caps.get(p.key)])) });
    // the plan given, as it stands (opts.exact): null when it no longer holds these frames in this order or fits
    const rank = new Map(projects.map((p, i) => [p.key, i]));
    const held = (plan) => {
      if (!plan || !Array.isArray(plan.lanes) || plan.lanes.flat().length !== n || !plan.lanes.flat().every((key) => rank.has(key)) || !projects.every((p) => plan.caps && plan.caps[p.key] === caps.get(p.key))) return null;
      const lanes = plan.lanes.map((lane) => lane.map((key) => projects[rank.get(key)]));
      const tops = lanes.map((lane) => rank.get(lane[0].key));
      const inOrder = lanes.every((lane) => lane.length) && tops.every((r, i) => r === i) && lanes.every((lane) => lane.every((p, k) => !k || rank.get(p.key) > rank.get(lane[k - 1].key)));
      return inOrder && fits(lanes) && roomy(lanes) ? lanes : null;
    };
    if (o.exact) { const lanes = held(o.exact); return lanes ? out(lanes) : null; }
    // opts.count: that many lanes and no other (null when the frames cannot stand so)
    let fresh = null;
    const most = o.count ? Math.min(n, o.count) : n, least = o.count ? most : 1;
    // opts.retry: how many more places it may try when a frame put under the first lane that takes it leaves none for a
    // frame after it (that frame goes under the next lane in the same order instead); none, the default: the first
    // lane that takes each frame, or the lanes do not stand.
    let spare = Number.isFinite(o.retry) ? o.retry : 0;
    for (let K = most; K >= least && !fresh; K--) {
      const lanes = projects.slice(0, K).map((p) => [p]);
      if (!fits(lanes)) continue;
      const rest = projects.slice(K);
      const place = (k) => {
        if (k === rest.length) return true;
        const p = rest[k], ends = lanes.map(height), low = Math.min(...ends), level = (i) => ends[i] <= low + BAND;
        const order = lanes.map((_, i) => i).sort((a, b) => (level(b) - level(a)) || (level(a) ? a - b : ends[a] - ends[b] || a - b));
        for (const j of order) {
          lanes[j].push(p);
          if (fits(lanes)) {
            if (place(k + 1)) return true;
            if (spare-- <= 0) { lanes[j].pop(); return false; }
          }
          lanes[j].pop();
        }
        return false;
      };
      if (place(0)) fresh = narrow(lanes);
    }
    if (!fresh) return null;
    // the plan in use, if it is still a plan for these frames in this order
    const kept = o.keep ? held(o.keep) : null;
    if (kept && Math.max(...kept.map(height)) <= Math.max(...fresh.map(height)) * LANE_KEEP + 0.5) return out(kept);
    return out(fresh);
  }

  // 智能一页: every project across one row, each frame 1 to PAGE_COLUMNS cards wide (never more than it
  // has cards), all the widths chosen together so the whole map shows on one page, as large as it can.
  // Every combination is scored and the best one wins:
  //   - it must fit the page at s of the map's own 100% (s = min(page width / map width, page height /
  //     map height, 1)); below PAGE_MIN_SCALE the cards are too small to read and it does not fit;
  //   - the larger s, the better: bigger cards, the page better filled;
  //   - no frame much taller than the rest: every row the tallest frame runs beyond the next tallest,
  //     past one, costs PAGE_ROW_COST of s (a frame of two cards beside frames of one is not too long);
  //   - with nothing else between them, fewer columns (PAGE_COLUMN_COST each).
  // opts.keep (the plan in use) stays while it still fits and scores within PAGE_KEEP of the best, or the
  // best fits with less than WRAP_KEEP's room to spare, so a card more or less, or a window a little
  // wider, does not send frames back and forth.
  // size: { w, h }, the page in the canvas's units at the map's own 100% (no h: as tall as needed).
  // Returns { lanes (one per project, in order), caps, scale (s), fits }. fits is false when no
  // combination shows the map on one page at PAGE_MIN_SCALE: the best one's columns then serve
  // planAcross, which stacks the frames in lanes at 100%. (The columns are chosen at 100% at most;
  // a map that shows whole is then shown as large as the page holds it, up to PAGE_MAX_SCALE: the
  // cards and their type grow with it, so the page is filled across or down.)
  const PAGE_COLUMNS = 4, PAGE_MIN_SCALE = 0.8, PAGE_MAX_SCALE = 1.4, PAGE_ROW_COST = 0.05, PAGE_COLUMN_COST = 0.002, PAGE_KEEP = 0.03, PAGE_COMBOS = 50000;
  function planPage(map, size, opts) {
    const o = { ...LAYOUT, ...opts };
    const shown = new Set(map.nodes.map((n) => n.id));
    const projects = ordered(map.projects, o.order).filter((p) => frame(p, o, shown, 1));
    if (!projects.length) return { lanes: [], caps: {}, scale: 1, fits: true };
    const W = Math.max(1, size.w), H = Number.isFinite(size.h) ? Math.max(1, size.h) : Infinity;
    const minScale = Number.isFinite(o.minScale) ? o.minScale : PAGE_MIN_SCALE, cap = Math.max(1, minScale);
    // every project's frame at each width it can take (a folded frame has one)
    const choices = projects.map((p) => {
      const one = frame(p, o, shown, 1);
      if (one.collapsed) return [one];
      return [one, ...Array.from({ length: Math.min(PAGE_COLUMNS, one.count) - 1 }, (_, i) => frame(p, o, shown, i + 2))];
    });
    // the map's size the way layout() and the view's fit measure it: the frames one lane each side by
    // side, 队长 above them, the 16px the map keeps round itself
    const gap = laneGap(o, 0), edge = 32;
    const score = (pick) => {
      const width = Math.max(o.captainW, pick.reduce((a, f) => a + f.w, 0) + (pick.length - 1) * gap) + edge;
      const height = o.captainH + o.fanY + Math.max(...pick.map((f) => f.h)) + edge;
      const room = Math.min(W / width, H / height), s = Math.min(cap, room);
      const rows = pick.map((f) => (f.collapsed ? 0 : f.rows.length)).sort((a, b) => b - a);
      const excess = Math.max(0, rows[0] - Math.max(1, rows[1] || 0) - 1);
      const extra = pick.reduce((a, f) => a + (f.collapsed ? 0 : f.cols - 1), 0);
      return { s, room, fits: s >= minScale - 1e-9, value: s - PAGE_ROW_COST * excess - PAGE_COLUMN_COST * extra };
    };
    const better = (a, b) => !b || (a.fits !== b.fits ? a.fits : a.value > b.value + 1e-9);
    const pickOf = (idx) => idx.map((i, k) => choices[k][i]);
    let best = null;
    const total = choices.reduce((a, c) => a * c.length, 1);
    if (total <= PAGE_COMBOS) {
      // every combination, as a mixed-radix count
      const idx = choices.map(() => 0);
      for (let n = 0; n < total; n++) {
        const r = score(pickOf(idx));
        if (better(r, best)) best = { ...r, idx: idx.slice() };
        for (let k = idx.length - 1; k >= 0; k--) { if (++idx[k] < choices[k].length) break; idx[k] = 0; }
      }
    } else {
      // too many projects to try every one: from one card wide each, widen whichever frame helps most
      let idx = choices.map(() => 0);
      best = { ...score(pickOf(idx)), idx };
      for (;;) {
        let step = null;
        choices.forEach((c, k) => { if (idx[k] + 1 >= c.length) return; const next = idx.slice(); next[k]++; const r = score(pickOf(next)); if (better(r, step || best)) step = { ...r, idx: next }; });
        if (!step) break;
        best = step; idx = step.idx;
      }
    }
    // the plan in use, while it is still a plan for these frames and nearly as good
    const keep = o.keep && o.keep.caps && Array.isArray(o.keep.lanes) && o.keep.lanes.length === projects.length && o.keep.lanes.every((lane, k) => lane.length === 1 && lane[0] === projects[k].key) ? o.keep : null;
    if (keep && best.fits) {
      const idx = projects.map((p, k) => choices[k].findIndex((f) => f.cols === (choices[k].length === 1 ? choices[k][0].cols : keep.caps[p.key])));
      // (the best takes over only fitting with WRAP_KEEP's room to spare, so a few pixels back and forth over the
      // width where it just fits do not flip the columns)
      if (idx.every((i) => i >= 0)) { const r = score(pickOf(idx)); if (r.fits && (r.value >= best.value - PAGE_KEEP || best.room < minScale * WRAP_KEEP - 1e-9)) best = { ...r, idx }; }
    }
    return { lanes: projects.map((p) => [p.key]), caps: Object.fromEntries(projects.map((p, k) => [p.key, choices[k][best.idx[k]].cols])), scale: best.s, fits: best.fits };
  }

  // ---- 智能一页 for a window ----
  // WRAP_GAIN: one row of frames gives way to lanes when they show the whole map at least this much larger (off any
  // N/(N-1): six one-card frames against five lanes is exactly 6/5). WRAP_KEEP: every change of arrangement (a
  // frame's columns, how many lanes and which frames stand in them, one row or wrapped) waits until another shows the
  // map that much larger than the one in use (or as much shorter, where both scroll) and holds it with that much
  // room to spare, so dragging the window back and forth over a width never flips it.
  const WRAP_GAIN = 1.22, WRAP_KEEP = 1.03;
  // The smallest text on the map (a card's model, account, time and chips: 11.5 on the canvas, nothing smaller) is
  // never shown under READABLE_PX device pixels: readableScale is the scale (drawn units) that asks for on a screen
  // of that density.
  const SMALLEST_TEXT = 11.5, READABLE_PX = 10;
  const readableScale = (dpr) => READABLE_PX / (SMALLEST_TEXT * Math.max(0.5, Number(dpr) || 1));
  // The least a map is shown at: on one page, PAGE_MIN_SCALE of its own 100% or what keeps that text readable, the
  // larger; in lanes (what a map too big for one page falls back to), 100% or that. 1x screen: 124% for both.
  // zoom: the zoom the user set (drawn units, like the view's scale): that, whatever the screen (fixed: true). A zoom
  // that puts the smallest text under READABLE_PX is theirs to set; the map says so, it never changes it.
  function scalesFor(dpr, zoom) {
    if (Number.isFinite(zoom) && zoom > 0) { const z = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom)); return { floor: z, lanes: z, max: z, fixed: true }; }
    const FIT = BASE_SCALE, max = FIT * PAGE_MAX_SCALE, readable = readableScale(dpr);
    return { floor: Math.min(max, Math.max(FIT * PAGE_MIN_SCALE, readable)), lanes: Math.min(max, Math.max(FIT, readable)), max };
  }
  // the least and most the view shows an arrangement r ({ plan, pageFits }) at, on a screen of that density (at a zoom
  // the user set: exactly that)
  function fitLimits(r, dpr, zoom) {
    const s = scalesFor(dpr, zoom);
    if (s.fixed) return { min: s.max, max: s.max };
    return r.pageFits ? { min: r.plan && r.plan.page ? s.floor : s.lanes, max: s.max } : { min: s.lanes, max: s.lanes };
  }
  // Everything a layout takes on the canvas, the way the view fits it: frames, cards, 队长, the fold and every line
  // (the return lines only when shown), with 16 around.
  function fitBounds(map, lay, opts, returns) {
    const boxes = [lay.captain, ...lay.groups, ...lay.nodes.values(), lay.fold].filter(Boolean);
    const points = routes(map, lay, opts).filter((r) => r.type !== 'return' || returns).flatMap((r) => r.points);
    return {
      left: Math.min(...boxes.map((b) => b.x), ...points.map((p) => p[0])) - 16,
      top: Math.min(...boxes.map((b) => b.y), ...points.map((p) => p[1])) - 16,
      right: Math.max(...boxes.map((b) => b.x + b.w), ...points.map((p) => p[0])) + 16,
      bottom: Math.max(...boxes.map((b) => b.y + b.h), ...points.map((p) => p[1])) + 16,
    };
  }
  // 智能一页 at a zoom the user set, when one row does not show the whole map there: lanes, with every frame's columns
  // chosen again for them (a frame made wide to keep one row low can stand narrower in a lane, with another beside it).
  // Every combination of columns (1 to PAGE_COLUMNS each, no more than a frame has cards; past LANE_COMBOS combinations,
  // the row's columns and every frame at most 1, 2, 3 or 4 wide) in K lanes as planAcross fills them (K = 1 to the
  // number of frames; a frame that leaves the next one nowhere to go tries the next lane, LANE_RETRY times at most:
  // otherwise a window a few pixels narrower can hold a shorter map than this one), roomy, or tight where only that
  // brings the map onto the page, is measured by the canvas layout()
  // gives it (what the view fits, but the return lines while they are hidden) against size, the page in canvas units
  // at that zoom, and ranked:
  //   - whole on the page first;
  //   - on the page: no frame much taller than the rest (planPage's measure), fewer columns, the shape nearest the
  //     page's (the room left as even across as down), fewer lanes;
  //   - off the page: the shortest, the least to scroll down (wider than the window only if nothing stands across it);
  //     of those within WRAP_KEEP of the shortest, the most even, fewer columns, the shorter, fewer lanes.
  // Returns [{ plan: { lanes, caps, tight }, fits }], the best first.
  const LANE_COMBOS = 256, LANE_RETRY = 24;
  function planLanes(map, size, o, rowCaps) {
    const shown = new Set(map.nodes.map((n) => n.id));
    const [roomy, tightly] = [o, { ...o, ...o.tightly }].map((v) => ({ ...LAYOUT, ...v, sized: new Map() }));
    const projects = ordered(map.projects, o.order).filter((p) => sizedFrame(roomy.sized, p, roomy, shown, 1));
    if (!projects.length) return [];
    const most = projects.map((p) => { const one = sizedFrame(roomy.sized, p, roomy, shown, 1); return one.collapsed ? 1 : Math.min(PAGE_COLUMNS, one.count); });
    const vectors = [], total = most.reduce((a, m) => a * m, 1);
    if (total <= LANE_COMBOS) {
      const idx = most.map(() => 1);
      for (let n = 0; n < total; n++) {
        vectors.push(idx.slice());
        for (let k = idx.length - 1; k >= 0; k--) { if (++idx[k] <= most[k]) break; idx[k] = 1; }
      }
    } else {
      for (let c = 1; c <= PAGE_COLUMNS; c++) vectors.push(most.map((m) => Math.min(c, m)));
      if (rowCaps) vectors.push(projects.map((p, k) => Math.max(1, Math.min(most[k], rowCaps[p.key] || 1))));
    }
    const W = Math.max(1, size.w), H = Math.max(1, size.h), hidden = o.returns ? 0 : map.edges.filter((e) => e.type === 'return').length * 7;
    const seen = new Set(), all = [];
    const measure = (v, a, tight) => {
      const key = JSON.stringify([a.lanes, a.caps, tight]);
      if (seen.has(key)) return null;
      seen.add(key);
      const lay = layout(map, { ...v, lanes: a.lanes, caps: a.caps }), w = lay.width - hidden, h = lay.height - hidden;
      const frames = projects.map((p) => sizedFrame(v.sized, p, v, shown, a.caps[p.key]));
      const rows = frames.map((f) => (f.collapsed ? 0 : f.rows.length)).sort((x, y) => y - x);
      return { plan: { lanes: a.lanes, caps: a.caps, tight }, fits: w <= W + 0.5 && h <= H + 0.5, w, h, shape: Math.min(W / w, H / h),
        excess: Math.max(0, rows[0] - Math.max(1, rows[1] || 0) - 1), extra: frames.reduce((x, f) => x + (f.collapsed ? 0 : f.cols - 1), 0), lanes: a.lanes.length };
    };
    vectors.forEach((vec) => {
      const caps = Object.fromEntries(projects.map((p, k) => [p.key, vec[k]]));
      for (let K = 1; K <= projects.length; K++) {
        const a = planAcross(map, size, { ...roomy, caps, count: K, retry: LANE_RETRY });
        if (!a) continue;
        const m = measure(roomy, a, false);
        if (m) all.push(m);
        if (!m || m.fits) continue;
        const t = planAcross(map, size, { ...tightly, caps, count: K, retry: LANE_RETRY }), mt = t && measure(tightly, t, true);
        if (mt && mt.fits) all.push(mt);
      }
    });
    const near = (d) => (Math.abs(d) < 1e-6 ? 0 : d);
    const fitting = all.filter((c) => c.fits).sort((a, b) => (a.excess - b.excess) || (a.extra - b.extra) || near(b.shape - a.shape) || (a.lanes - b.lanes));
    const off = all.filter((c) => !c.fits && !c.plan.tight), across = off.filter((c) => c.w <= W + 0.5), pool = across.length ? across : off;
    const low = Math.min(...pool.map((c) => c.h));
    const close = pool.filter((c) => c.h <= low * WRAP_KEEP + 0.5).sort((a, b) => (a.excess - b.excess) || (a.extra - b.extra) || near(a.h - b.h) || (a.lanes - b.lanes));
    return [...fitting, ...close].map((c) => ({ plan: c.plan, fits: c.fits }));
  }

  // The arrangement 智能一页 makes for a window, untouched by hand: every project across one row (planPage), or the
  // same columns in lanes (planAcross), roomy or tight. view: { w, h }, the viewport in screen px; o: the layout
  // options, with o.tightly (what the tight lanes change), o.inset (the fit's inset), o.returns (the return lines
  // are shown) and o.dpr (the screen's density); current: { plan, dpr }, the arrangement in use and the density it
  // was made for (kept only on the same screen: another is arranged afresh). o.zoom: the zoom the user set (drawn units),
  // a constant: the arrangement is chosen for it and shows at it (see below).
  // Afresh, one row stands unless the lanes with the most frames across show the map WRAP_GAIN larger; lanes are
  // then as many as show the map largest (the whole map on the page first; of those that scroll, the shortest;
  // fewer lanes where it is all the same). The arrangement in use stays while it still holds the map (a row that no
  // longer shows whole scrolls, while its frames still stand across the window), until the one 智能一页 would make
  // now, with WRAP_KEEP's room to spare, is better by WRAP_KEEP: whole on the page where it is not, that much larger
  // (lanes take over from a row only at WRAP_GAIN times that), that much shorter where both scroll. Any change of
  // arrangement goes through this: a frame's columns (planPage keeps them by PAGE_KEEP), the lanes and the frames in
  // them, one row or wrapped. A window made wider so never shows the map smaller, unless that brings all of it onto
  // the page or gives its frames columns that score better.
  // At a zoom the user set the map shows at that zoom whatever its arrangement: one row (its columns chosen by planPage
  // for the page at that zoom) while it shows the whole map there, else lanes with their columns chosen with them
  // (planLanes): whole on the page where any are, the most compact where none is. The one in use stays the same way,
  // until another holds the map with WRAP_KEEP's room to spare and is whole where it is not, one row where it is lanes,
  // lanes shaped WRAP_KEEP nearer the page, or WRAP_KEEP shorter where both scroll.
  // Returns { plan, lay, pageFits }: the whole map shows.
  const LANE_TRIES = 8;
  function arrangePage(map, view, o, current = {}) {
    const density = (d) => Number(d) || 1, sc = scalesFor(o.dpr, o.zoom);
    const FIT = BASE_SCALE, inset = { top: 0, right: 0, bottom: 0, left: 0, ...o.inset }, plan = current.plan && density(current.dpr) === density(o.dpr) ? current.plan : null;
    const build = (p) => layout(map, { ...o, ...(p.tight ? o.tightly : {}), lanes: p.lanes, caps: p.caps });
    const page = (k) => ({ w: (view.w - inset.left - inset.right) / k, h: (view.h - inset.top - inset.bottom) / k });
    // An arrangement as the view shows it: whole on the page at least at its least scale (fits), how large (as large
    // as the page holds it, up to PAGE_MAX_SCALE; one that does not show whole stands at the lanes' scale and
    // scrolls), how tall; whole (the scale that shows all of it) and least, to ask it for room to spare.
    const judge = (p) => {
      const lay = build(p), bounds = fitBounds(map, lay, o, o.returns), least = p.page ? sc.floor : sc.lanes;
      const whole = computeFit(bounds, view, inset, { min: 0, max: sc.fixed ? Infinity : 1 }).scale, fits = whole >= least - 1e-9;
      return { plan: p, lay, fits, whole, least, scale: fits ? Math.min(whole, sc.max) : sc.lanes, height: bounds.bottom - bounds.top, row: !!p.page };
    };
    // one row, its columns kept while they score within PAGE_KEEP of the best (planPage): chosen at 100% (then shown as
    // large as the page holds it), or for the page at the zoom the user set
    const onePage = sc.fixed ? planPage(map, page(sc.max), { ...o, minScale: 1, keep: plan && plan.page ? plan : null })
      : planPage(map, page(FIT), { ...o, minScale: sc.floor / FIT, keep: plan && plan.page ? plan : null });
    const rowPlan = onePage.fits ? { lanes: onePage.lanes, caps: onePage.caps, tight: false, page: true } : null;
    const row = rowPlan ? judge(rowPlan) : null;
    // the arrangement in use, as it stands in this window (a row no longer whole scrolls while its frames still stand
    // across the window at the lanes' scale), or gone
    const holds = (p, k) => planAcross(map, page(sc.lanes * k), { ...o, ...(p.tight ? o.tightly : {}), caps: p.caps, exact: p });
    let cur = null;
    if (plan && plan.page && row && row.fits) cur = row;
    else if (plan) { const held = holds(plan, 1); if (held) cur = judge({ ...held, tight: !!plan.tight, ...(plan.page ? { page: true } : {}) }); }
    // afresh: the same columns in K lanes (K = 1, 2, ...), roomy while the whole map shows, tight when only that
    // brings it in; one row unless the lanes with the most frames across show the map WRAP_GAIN larger, else the
    // lanes that show it largest
    const afresh = () => {
      const lanes = [];
      for (let K = 1; K <= onePage.lanes.length; K++) {
        let best = null;
        for (const tight of [false, true]) {
          const a = planAcross(map, page(sc.lanes), { ...o, ...(tight ? o.tightly : {}), caps: onePage.caps, count: K });
          if (!a) break;
          const c = judge({ lanes: a.lanes, caps: a.caps, tight });
          if (!best || (c.fits && !best.fits)) best = c;
          if (best.fits) break;
        }
        if (best) lanes.push(best);
      }
      const near = (d) => (Math.abs(d) < 1e-9 ? 0 : d);
      const largest = lanes.slice().sort((a, b) => (b.fits - a.fits) || (a.fits ? near(b.scale - a.scale) : near(a.height - b.height)) || (a.plan.lanes.length - b.plan.lanes.length))[0];
      const most = lanes[lanes.length - 1];
      // (no project on the map: no lanes to weigh, the row, 队长 alone, stands)
      return row && (!most || (row.fits && !(most.fits && most.scale >= row.scale * WRAP_GAIN))) ? row : largest;
    };
    // at a zoom the user set: one row while it shows the whole map there, else planLanes' best (the first of its few best
    // that is whole on the page as the view measures it, or the first that is not when none is)
    const atZoom = () => {
      if (row && row.fits) return row;
      const tries = planLanes(map, page(sc.lanes), o, onePage.caps).slice(0, LANE_TRIES);
      for (const t of tries) { const j = judge(t.plan); if (j.fits || !t.fits) return j; }
      return tries.length ? judge(tries[0].plan) : row;
    };
    const fresh = sc.fixed ? atZoom() : afresh();
    const same = (a, b) => JSON.stringify([a.lanes, a.caps, !!a.tight, !!a.page]) === JSON.stringify([b.lanes, b.caps, !!b.tight, !!b.page]);
    // It takes over from the one in use only holding the map with WRAP_KEEP's room to spare (whole on the page, and
    // its lanes across the window) and better by WRAP_KEEP: whole where the one in use scrolls; that much larger
    // (lanes over a row: WRAP_GAIN times that); that much shorter where both scroll. (At a zoom the user set both show
    // at that zoom: one row over lanes, lanes over lanes shaped that much nearer the page.)
    const takesOver = () => {
      const fits = fresh.whole >= fresh.least * WRAP_KEEP - 1e-9;
      if (!fresh.row && !holds(fresh.plan, WRAP_KEEP)) return false;
      if (fits !== cur.fits) return fits;
      if (!fits) return !fresh.fits && fresh.height * WRAP_KEEP <= cur.height;
      if (sc.fixed) return !cur.row && (fresh.row || fresh.whole >= cur.whole * WRAP_KEEP);
      return fresh.scale >= cur.scale * (cur.row && !fresh.row ? WRAP_GAIN : 1) * WRAP_KEEP;
    };
    const pick = cur && (same(fresh.plan, cur.plan) || !takesOver()) ? cur : fresh;
    return { plan: pick.plan, lay: pick.lay, pageFits: pick.fits };
  }

  // The order the user has put the project frames in, read from where they stand now the way
  // planAcross fills them in, like lines of text: frames whose tops are within BAND of each other
  // make one line, read from the left; the lines are read from the top.
  function orderByPlace(groups) {
    const lines = [];
    groups.slice().sort((a, b) => a.y - b.y || a.x - b.x).forEach((g) => {
      const line = lines[lines.length - 1];
      if (line && g.y <= line.top + BAND) line.items.push(g);
      else lines.push({ top: g.y, items: [g] });
    });
    return lines.flatMap((line) => line.items.sort((a, b) => a.x - b.x || a.y - b.y).map((g) => g.key));
  }

  // A dragged card stays inside its own frame, clear of the frame's edge, and near its own row.
  function constrainPosition(lay, box, p) {
    const g = lay.groups.find((g) => g.key === box.project);
    if (!g) return p;
    const edge = Math.min(20, Math.max(0, (g.w - box.w) / 2 - 4));
    return { x: Math.max(g.x + edge, Math.min(g.x + g.w - box.w - edge, p.x)), y: Math.max(box.anchorY - 12, Math.min(box.anchorY + 12, p.y)) };
  }

  function translateProject(lay, key, dx, dy) {
    const g = lay.groups.find((g) => g.key === key);
    if (!g) return;
    g.x += dx; g.y += dy;
    if (lay.feeds && (dx || dy)) lay.feeds.clear();   // hand-placed frames: the lines find their own way round
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
    const rails = lay.rails;
    const items = map.edges.filter((e) => e.type === 'dispatch' && box(e.to)).map((e) => {
      const b = box(e.to);
      const n = status.get(e.to);
      // with rails every card is entered from the line down the left of its column, the first row too
      if (rails) return { e, b, n, side: true, rail: true, lx: b.x - rails.x, hx: b.x - rails.x };
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
      if (rails) {
        // the project's own line comes down its left rail into the frame, then runs under the
        // title strip to the rails of its other columns: no line crosses the title
        p.rail = Math.min(...xs);
        p.ideal = p.rail;
        p.busY = (p.g ? p.g.y + rails.headH : Math.min(...p.items.map((d) => d.b.y))) - 8;
      }
      p.fx = p.ideal;
      // a frame under another in its lane: the layout has said which gap its line comes down
      const feed = lay.feeds && lay.feeds.get(p.key);
      if (feed) { p.fx = feed.x; p.yL = feed.y; return; }
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
      // with rails: straight down the left rail when the feeder is there, else across above the frame to it first
      const tail = d.rail
        ? [...(Math.abs(p.fx - p.rail) < 0.5 ? [] : [[p.fx, p.yL], [p.rail, p.yL]]), [p.rail, p.busY], [d.lx, p.busY], [d.lx, d.b.y + rails.entry], [d.b.x - 2, d.b.y + rails.entry]]
        : d.side
          ? [[d.lx, p.yL], [d.lx, d.b.y + d.b.h / 2 - 14], [d.b.x - 2, d.b.y + d.b.h / 2 - 14]]
          : [[d.hx, p.yL], [d.hx, d.b.y - 2]];
      // the outermost feeders turn off the end of the main bus; others branch off it
      const end = Math.abs(p.fx - cx) > 0.5 && (Math.abs(p.fx - minX) < 0.5 || Math.abs(p.fx - maxX) < 0.5);
      const cls = `dispatch st-${d.n.status}${d.n.archived ? ' archived' : ''}`;
      out.push({
        type: 'dispatch', from: d.e.from, to: d.e.to, cls, project: p.key,
        hub: [cx, yMain], feederX: p.fx,
        points: tidy([[cx, sy], [cx, yMain], [p.fx, yMain], ...(d.rail ? [] : [[p.fx, p.yL]]), ...tail]),
        branch: tidy([[p.fx, yMain + (end ? Math.min(R, Math.abs(p.fx - cx) / 2) : 0)], ...(d.rail ? [] : [[p.fx, p.yL]]), ...tail]),
      });
    }));
    // ---- 小队长 → its crew ----
    // out of the bottom of the 小队长, down the step its crew stands in, a stop on the side of each
    const step = (lay.crewIn || 24) / 2;
    map.edges.filter((e) => e.type === 'squad' && box(e.from) && box(e.to)).forEach((e) => {
      const l = box(e.from), b = box(e.to), n = status.get(e.to);
      const x = l.x + step, y = rails ? b.y + rails.entry : b.y + b.h / 2 - 14;
      const points = tidy([[x, l.y + l.h], [x, y], [b.x - 2, y]]);
      out.push({ type: 'squad', from: e.from, to: e.to, cls: `squad st-${n.status}${n.archived ? ' archived' : ''}`, project: b.project, points, branch: points });
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

  // Saved state of the map (a `mode` saved before 2.0.5 named the free canvas, since removed, and is dropped): { positions: { id: {x,y} }, projectPositions, view: { x, y, scale }, showReturn,
  // collapsedProjects, projectOrder: [key], plan: { lanes, caps, tight } | null, zoom: the zoom the user set (drawn
  // units, like the view's scale) | null (none: 智能一页 picks the zoom) }.
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
    const key = (k) => typeof k === 'string' && k.length <= 120;
    const projectOrder = Array.isArray(s.projectOrder) ? [...new Set(s.projectOrder.filter(key))].slice(0, 500) : [];
    // the arrangement in use when the user last placed something by hand (null: arranged for the window every time)
    const pl = s.plan && typeof s.plan === 'object' && Array.isArray(s.plan.lanes) ? s.plan : null;
    const plan = pl && pl.lanes.length <= 50 && pl.lanes.every((l) => Array.isArray(l) && l.length <= 500 && l.every(key))
      ? { lanes: pl.lanes.map((l) => l.slice()), caps: Object.fromEntries(Object.entries(pl.caps || {}).filter(([k, v]) => key(k) && Number.isInteger(v) && v >= 1 && v <= 12)), tight: !!pl.tight, page: !!pl.page } : null;
    const zoom = Number.isFinite(s.zoom) && s.zoom > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.zoom)) : null;
    return { projectPositions, positions, view, collapsedProjects, showReturn: !!s.showReturn, projectOrder, plan, zoom };
  }
  // The map's own zoom. Its 100% is BASE_SCALE of the canvas's drawn size (cards are drawn 280px wide
  // and shown 196px wide at 100%); the canvas, the saved view and every position stay in drawn units,
  // so a view saved by an older version keeps the size it had on screen and only reads differently
  // (what was 70% is 100%). The buttons step by a tenth of 100%, landing on whole tenths.
  const BASE_SCALE = 0.7, ZOOM_STEP = 0.1;
  const MIN_SCALE = BASE_SCALE * 0.4, MAX_SCALE = BASE_SCALE * 2.5;
  const zoomOf = (scale) => scale / BASE_SCALE;
  const zoomPercent = (scale) => Math.round(zoomOf(scale) * 100);
  // The scale one press of 放大 (dir 1) or 缩小 (dir -1) goes to.
  function zoomStep(scale, dir) {
    const z = zoomOf(scale) / ZOOM_STEP;
    const next = dir > 0 ? Math.floor(z + 1e-6) + 1 : Math.ceil(z - 1e-6) - 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next * ZOOM_STEP * BASE_SCALE));
  }

  // A change in anything but the live activity line rebuilds the map.
  function signature(map) {
    const n = (x) => [x.id, x.status, x.detail, x.title, x.provider, x.model, x.line, x.archived ? 1 : 0, x.review ? 1 : 0, x.project || '', (x.reviews || []).join(','), x.important ? 1 : 0, x.leader ? 1 : 0].join('\u0001');
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

  return { STATUS_LABEL, ACTIVE, PAGE_COLUMNS, PAGE_MIN_SCALE, PAGE_MAX_SCALE, MIN_SCALE, MAX_SCALE, BASE_SCALE, zoomPercent, zoomStep, projectHue, nodeStatus, receiptLine, receiptFull, cardLine, isCollapsed, trayProjects, traySummary, reopenOnActivity, computeFit, returnKind, detectReviews, buildCrewMap, layout, pockets, planPage, planAcross, arrangePage, fitBounds, fitLimits, readableScale, scalesFor, WRAP_GAIN, WRAP_KEEP, orderByPlace, constrainPosition, translateProject, applyPositions, routes, spine, tidy, nestRanks, normalizeSaved, signature, summaryLine };
});
