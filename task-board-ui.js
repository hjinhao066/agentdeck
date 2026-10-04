// 任务看板 view (v1, read-only): the shared task cards from window.TaskBoard
// in status columns, filtered by project and sorted by update time or task
// order. The only write is 已完成 → 归档 through TaskBoard.archiveDone. It
// covers the deck like the Schedule/Artifacts pages; closing it leaves the
// terminals exactly as they were. Project colours come from the crew map's
// palette (CrewMapCore.projectHue) so both views agree.
(function () {
  'use strict';
  const U = window.TaskBoardUICore;
  let host = null;
  let viewEl, projectSel, sortGroup, colsEl, statusEl;
  let open = false;
  let cards = [];
  let filter = { project: U.ALL, sort: 'updated' };
  let unsubscribe = null;
  let seq = 0;              // only the newest list() result is drawn
  let archiving = false;

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
    if (!api()) { cards = []; setStatus('任务看板接口不可用'); render(); return; }
    try {
      const list = await api().list({ archived: true }); // archived cards resolve dependency names
      if (mine !== seq || !open) return;
      cards = Array.isArray(list) ? list : [];
      setStatus('');
    } catch (err) {
      if (mine !== seq || !open) return;
      setStatus('读取任务失败：' + ((err && err.message) || err));
    }
    render();
  }

  function renderProjects(projects) {
    if (filter.project && !projects.includes(filter.project)) filter.project = U.ALL;
    projectSel.innerHTML = '';
    const all = el('option', null, '全部项目'); all.value = U.ALL;
    projectSel.append(all, ...projects.map((p) => { const o = el('option', null, p); o.value = p; return o; }));
    projectSel.value = filter.project;
    const shown = filter.project ? hue(filter.project) : '';
    projectSel.classList.toggle('tbv-tinted', !!shown);
    if (shown) projectSel.style.setProperty('--project-hue', shown); else projectSel.style.removeProperty('--project-hue');
  }

  function renderCard(item) {
    const c = item.card;
    const node = el('article', 'tbv-card');
    node.style.setProperty('--project-hue', hue(c.project));
    node.dataset.cardId = c.id;
    node.title = c.title;
    node.append(el('h3', 'tbv-title', c.title));
    const proj = el('div', 'tbv-project');
    proj.append(el('span', 'tbv-dot'), el('span', null, c.project));
    node.append(proj);
    const meta = el('div', 'tbv-meta');
    meta.append(el('span', 'tbv-owner', U.ownerLabel(c, host.sessionLabel)));
    const when = el('time', 'tbv-time', U.formatUpdated(c.updated));
    if (c.updated) { when.dateTime = c.updated; when.title = new Date(c.updated).toLocaleString(); }
    meta.append(when);
    node.append(meta);
    const tags = el('div', 'tbv-tags');
    if (item.waitLabel) tags.append(el('span', 'tbv-tag wait', item.waitLabel));
    if (item.parallel) tags.append(el('span', 'tbv-tag parallel', '可并行'));
    if (c.flag === 'held') tags.append(el('span', 'tbv-tag held', '挂起'));
    if (c.flag === 'failed' && c.latest_receipt) tags.append(el('span', 'tbv-tag failed', c.latest_receipt));
    if (tags.childNodes.length) node.append(tags);
    return node;
  }

  function render() {
    if (!open) return;
    const board = U.buildBoard(cards, filter);
    renderProjects(board.projects);
    sortGroup.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.sort === filter.sort;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    colsEl.innerHTML = '';
    board.columns.forEach((col) => {
      const section = el('section', 'tbv-col');
      section.dataset.status = col.key;
      section.setAttribute('aria-label', `${col.label}，${col.cards.length} 张`);
      const head = el('header', 'tbv-col-head');
      head.append(el('h2', null, col.label), el('span', 'tbv-count', String(col.cards.length)));
      if (col.key === 'done') {
        const btn = el('button', 'btn tbv-archive', '归档');
        btn.type = 'button';
        btn.title = filter.project ? `归档「${filter.project}」的已完成卡片` : '归档全部项目的已完成卡片';
        btn.setAttribute('aria-label', btn.title);
        btn.disabled = archiving || !col.cards.length;
        btn.onclick = archive;
        head.append(btn);
      }
      const list = el('div', 'tbv-list');
      if (col.cards.length) col.cards.forEach((item) => list.append(renderCard(item)));
      else list.append(el('div', 'tbv-empty', '暂无'));
      section.append(head, list);
      colsEl.append(section);
    });
  }

  async function archive() {
    if (archiving || !api()) return;
    archiving = true; render();
    try {
      const res = await U.archiveDone(api(), filter.project);
      const n = res && Array.isArray(res.cards) ? res.cards.length : 0;
      host.showToast(n ? `已归档 ${n} 张卡片` : '没有可归档的已完成卡片');
    } catch (err) {
      host.showToast('归档失败：' + ((err && err.message) || err));
    } finally {
      archiving = false;
    }
    await refresh();
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
    }
    host.onToggle(open);
  }

  function init(h) {
    host = h;
    viewEl = document.getElementById('taskBoardView');
    projectSel = viewEl.querySelector('#tbvProject');
    sortGroup = viewEl.querySelector('.tbv-sort');
    colsEl = viewEl.querySelector('.tbv-cols');
    statusEl = viewEl.querySelector('.tbv-status');
    projectSel.onchange = () => { filter.project = projectSel.value; render(); };
    sortGroup.querySelectorAll('button').forEach((b) => { b.onclick = () => { filter.sort = b.dataset.sort; render(); }; });
    viewEl.querySelector('.tbv-close').onclick = () => setOpen(false);
    viewEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); host.focusToggle(); } });
  }

  window.TaskBoardUI = {
    init,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
})();
