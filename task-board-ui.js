// 任务看板 view (read-only): every shared task card from window.TaskBoard,
// one swimlane per project (case-insensitive) across the five status columns,
// filtered by project and sorted by update time or task order. A card with a
// session opens that session; there are no task write operations. It covers
// the deck and the board view like the
// Schedule/Artifacts pages; closing it leaves everything underneath as it was.
// Project colours come from the crew map's palette (CrewMapCore.projectHue).
(function () {
  'use strict';
  const U = window.TaskBoardUICore;
  let host = null;
  let viewEl, projectSel, sortGroup, headsEl, lanesEl, statusEl, summaryEl, emptyEl, refreshBtn;
  let open = false;
  let cards = [];
  let filter = { project: U.ALL, sort: 'updated' };
  let unsubscribe = null;
  let seq = 0;              // only the newest list() result is drawn

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const api = () => window.TaskBoard;
  const hue = (project) => String(window.CrewMapCore.projectHue(project));

  function setStatus(text) { statusEl.textContent = text || ''; statusEl.hidden = !text; }

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

  function renderProjects(projects) {
    projectSel.innerHTML = '';
    const all = el('option', null, '全部项目'); all.value = U.ALL;
    projectSel.append(all, ...projects.map((p) => { const o = el('option', null, p.name); o.value = p.key; return o; }));
    projectSel.value = filter.project;
    projectSel.classList.toggle('tbv-tinted', !!filter.project);
    if (filter.project) projectSel.style.setProperty('--project-hue', hue(filter.project)); else projectSel.style.removeProperty('--project-hue');
  }

  // Who runs the card and on which model: the live session's agent badge (the
  // same one the sidebar and crew map show), else the recorded assignee.
  function ownerRow(c) {
    const row = el('div', 'tbv-owner');
    const session = c.session_id ? host.session(c.session_id) : null;
    let hasModel = false;
    if (session && session.col) {
      const badge = el('span');
      host.renderBadge(badge, session.col);
      if (!badge.hidden) { row.append(badge); hasModel = true; }
    }
    const model = U.modelLabel(c);
    if (!hasModel && model) row.append(el('span', 'tbv-model', model));
    const name = el('span', 'tbv-owner-name', session ? session.label : U.ownerLabel(c, null));
    if (!session && !(c.assignee && c.assignee.agent)) name.classList.add('none');
    row.append(name);
    return row;
  }

  function renderCard(item) {
    const c = item.card;
    const node = el('article', 'tbv-card');
    node.dataset.cardId = c.id;
    node.dataset.status = c.status;
    if (c.flag) node.dataset.flag = c.flag;
    node.append(el('h3', 'tbv-title', c.title));
    node.append(ownerRow(c));
    if (c.latest_receipt) {
      const r = el('p', 'tbv-receipt', c.latest_receipt);
      r.title = c.latest_receipt;
      node.append(r);
    }
    const foot = el('div', 'tbv-foot');
    const tags = el('div', 'tbv-tags');
    if (c.flag === 'failed') tags.append(el('span', 'tbv-tag failed', '失败'));
    if (item.waitLabel) { const w = el('span', 'tbv-tag wait', item.waitLabel); w.title = item.waitLabel; tags.append(w); }
    if (item.parallel) tags.append(el('span', 'tbv-tag parallel', '可并行'));
    if (c.flag === 'held') tags.append(el('span', 'tbv-tag held', '挂起'));
    if (c.rework_count > 0) tags.append(el('span', 'tbv-tag', `返工 ${c.rework_count}`));
    foot.append(tags);
    const when = el('time', 'tbv-time', U.formatUpdated(c.updated));
    if (c.updated) { when.dateTime = c.updated; when.title = '更新于 ' + new Date(c.updated).toLocaleString(); }
    foot.append(when);
    node.append(foot);
    const session = c.session_id && host.session(c.session_id);
    if (session) {
      node.classList.add('linked');
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `${c.title}，打开会话「${session.label}」`);
      node.title = `打开会话「${session.label}」`;
      const go = () => host.openSession(c.session_id);
      node.addEventListener('click', go);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    } else {
      node.title = c.session_id ? '对应会话已不存在' : '还没有派给会话';
    }
    return node;
  }

  function renderHeads(columns) {
    headsEl.innerHTML = '';
    columns.forEach((col) => {
      const head = el('div', 'tbv-head');
      head.dataset.status = col.key;
      head.setAttribute('role', 'columnheader');
      head.append(el('span', 'tbv-head-dot'), el('span', 'tbv-head-label', col.label), el('span', 'tbv-count', String(col.count)));
      headsEl.append(head);
    });
  }

  function render() {
    if (!open) return;
    const board = U.buildBoard(cards, filter);
    filter.project = board.project;
    renderProjects(board.projects);
    sortGroup.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.sort === filter.sort;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    renderHeads(board.columns);
    lanesEl.innerHTML = '';
    board.lanes.forEach((lane) => {
      const section = el('section', 'tbv-lane');
      section.dataset.project = lane.key;
      section.style.setProperty('--project-hue', hue(lane.key));
      section.setAttribute('aria-label', `${lane.name}，${lane.total} 项`);
      const head = el('header', 'tbv-lane-head');
      head.append(el('span', 'tbv-dot'), el('h2', 'tbv-lane-name', lane.name), el('span', 'tbv-lane-count', `${lane.total} 项`));
      const cells = el('div', 'tbv-cells');
      lane.columns.forEach((col) => {
        const cell = el('div', 'tbv-cell');
        cell.dataset.status = col.key;
        cell.setAttribute('aria-label', `${lane.name} · ${col.label}，${col.cards.length} 张`);
        col.cards.forEach((item) => cell.append(renderCard(item)));
        cells.append(cell);
      });
      section.append(head, cells);
      lanesEl.append(section);
    });
    const projectCount = board.lanes.length;
    summaryEl.textContent = board.total ? `${board.total} 项 · ${projectCount} 个项目` : '';
    emptyEl.hidden = board.total > 0;
    headsEl.parentElement.hidden = board.total === 0;
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    viewEl.hidden = !open;
    if (open) {
      // subscribe first, then list (docs/task-board-api.md)
      if (api() && api().onChange) unsubscribe = api().onChange(() => refresh());
      render();
      refresh();
    } else {
      if (unsubscribe) { try { unsubscribe(); } catch (_) {} }
      unsubscribe = null;
      seq++;
      refreshBtn.classList.remove('busy');
    }
    host.onToggle(open);
    if (open) projectSel.focus({ preventScroll: true });
  }

  function init(h) {
    host = h;
    viewEl = document.getElementById('taskBoardView');
    projectSel = viewEl.querySelector('#tbvProject');
    sortGroup = viewEl.querySelector('.tbv-sort');
    headsEl = viewEl.querySelector('.tbv-heads');
    lanesEl = viewEl.querySelector('.tbv-lanes');
    statusEl = viewEl.querySelector('.tbv-status');
    summaryEl = viewEl.querySelector('.tbv-summary');
    emptyEl = viewEl.querySelector('.tbv-empty-board');
    refreshBtn = viewEl.querySelector('.tbv-refresh');
    projectSel.onchange = () => { filter.project = projectSel.value; render(); };
    sortGroup.querySelectorAll('button').forEach((b) => { b.onclick = () => { filter.sort = b.dataset.sort; render(); }; });
    refreshBtn.onclick = () => refresh();
    viewEl.querySelector('.tbv-close').onclick = () => { setOpen(false); host.focusToggle(); };
    // 架构图 / 自由画布 leave the board for the board view in that mode.
    viewEl.querySelectorAll('.board-mode button[data-view]').forEach((b) => {
      if (b.dataset.view !== 'tasks') b.onclick = () => host.showBoard(b.dataset.view);
    });
    viewEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); host.focusToggle(); } });
  }

  window.TaskBoardUI = {
    init,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
})();
