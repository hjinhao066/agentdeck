// Left sidebar, Cursor style: New chat / Search / Schedule / Artifacts on top,
// then the pinned 队长 row (once it exists) with a folding arrow and counts for the
// sessions it runs in the background, folders, loose sessions and the archive. Every session is a live
// terminal column; the deck shows them in exactly this order, so dragging a
// session into a folder also moves its column. Plain script; everything it
// needs from the deck comes in through init().
(function () {
  'use strict';
  const SC = window.SidebarCore;
  let host = null;
  let topEl, listEl;
  let menu = null;
  let lastTimesAt = 0;
  let captainRow = null;       // the 队长 entry at the top
  let crewHead = null;         // 队长's sessions: { counts, ids, open, shown }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconEl(name, cls) {
    const s = el('span', 'ico' + (cls ? ' ' + cls : ''));
    s.innerHTML = host.ICONS[name] || '';
    return s;
  }
  function iconButton(name, title, onClick, cls) {
    const b = el('button', 'nav-ibtn' + (cls ? ' ' + cls : ''));
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.innerHTML = host.ICONS[name] || '';
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天';
    if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + ' 个月';
    return Math.floor(s / 86400 / 365) + ' 年';
  }

  // ---- top: primary entries ----
  function navRow(key, iconName, label, hint, onClick) {
    const b = el('button', 'nav-row');
    b.type = 'button'; b.dataset.nav = key;
    b.append(iconEl(iconName), el('span', 'nav-row-label', label));
    if (hint) b.appendChild(el('span', 'nav-row-hint', hint));
    b.addEventListener('click', onClick);
    return b;
  }
  function buildTop() {
    topEl.textContent = '';
    const slot = el('div', 'nav-search-slot');
    slot.id = 'navSearchSlot';
    const captain = navRow('captain', 'crown', '队长', '', () => window.MainSession.open());
    captain.title = '队长（Captain）：你说要做什么，它把活派给各个对话，再把回执带回来';
    const dot = el('span', 'cn-dot');
    captain.insertBefore(dot, captain.querySelector('.nav-row-label').nextSibling);
    captainRow = { el: captain, dot };
    topEl.append(
      navRow('new', 'newChat', '新对话', '⌘N', () => host.addAndFocusColumn()),
      captain,
      slot,
      navRow('schedule', 'clock', 'Schedule', '', () => host.togglePage('schedule')),
      navRow('artifacts', 'artifacts', 'Artifacts', '', () => host.togglePage('artifacts')),
      navRow('skills', 'skills', 'Skills', '', () => host.togglePage('skills')),
    );
  }
  function markPage(name) {
    topEl.querySelectorAll('.nav-row[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  }

  // ---- list ----
  function sectionHead(key, label, count, actions, onToggle, open) {
    const head = el('div', 'nav-section');
    head.dataset.section = key;
    if (onToggle) {
      head.classList.add('toggle');
      head.appendChild(iconEl(open ? 'chevDown' : 'chevRight', 'nav-chev'));
      head.addEventListener('click', onToggle);
    }
    head.appendChild(el('span', 'nav-section-label', label));
    if (count != null) head.appendChild(el('span', 'nav-section-count', String(count)));
    head.appendChild(el('span', 'nav-section-spacer'));
    (actions || []).forEach((a) => head.appendChild(a));
    return head;
  }

  function render() {
    if (!host) return;
    closeMenu();
    const navItems = host.navItems;
    navItems.clear();
    listEl.textContent = '';
    captainMirror.disconnect();
    const main = window.MainSession && window.MainSession.mainCol();
    captainRow.dot.hidden = !main;
    const folders = host.folders();
    const cols = host.columns();
    const { crew, groups, loose } = SC.groupSessions(cols, folders);
    crewHead = null;
    if (main) {
      const waiting = (window.MainSession.state()?.waitlist || []).length;
      const captain = captainListRow(main, !!(crew.length || waiting));
      listEl.appendChild(captain);
      if (crew.length || waiting) listEl.appendChild(crewBlock(crew, captain.querySelector('.crew-counts')));
    }

    listEl.appendChild(sectionHead('folders', '文件夹', null, [iconButton('folderPlus', '新建文件夹', () => createFolder(true))]));
    groups.forEach((g) => listEl.appendChild(folderBlock(g)));

    listEl.appendChild(sectionHead('loose', '对话', loose.length || null, [iconButton('plus', '新对话 (⌘N)', () => host.addAndFocusColumn())]));
    const looseBox = el('div', 'nav-group');
    looseBox.dataset.group = '';
    loose.forEach((col) => looseBox.appendChild(sessionRow(col)));
    if (!loose.length) {
      looseBox.appendChild(el('div', 'nav-empty', cols.length ? '拖到这里可以移出文件夹' : '还没有对话，点「新对话」开始'));
    }
    listEl.appendChild(looseBox);

    const archived = host.archived();
    const open = !!host.config.navArchivedOpen;
    if (archived.length) {
      listEl.appendChild(sectionHead('archived', '已归档', archived.length, null, () => {
        host.config.navArchivedOpen = !open;
        host.saveConfig();
        render();
      }, open));
      if (open) {
        const box = el('div', 'nav-archived');
        archived.forEach((a) => box.appendChild(archivedRow(a)));
        listEl.appendChild(box);
      }
    } else {
      // still a drop target, so a session can be archived by dragging it here
      const head = sectionHead('archived', '已归档', null);
      head.classList.add('empty');
      listEl.appendChild(head);
    }
    host.syncNav();
  }

  // 队长's own row, pinned first like its column in the deck. It cannot be
  // dragged, filed into a folder, archived or deleted from the list; the top
  // 队长 entry still creates it and its dot mirrors this row's.
  const captainMirror = new MutationObserver((records) => {
    records.forEach((r) => { captainRow.dot.className = r.target.className; });
  });
  function captainListRow(col, hasCrew) {
    const item = el('div', 'colnav-item captain-item');
    item.dataset.colId = col.id;
    item.dataset.captain = '1';
    item.title = '队长：固定在最前面，不能拖进文件夹或归档';
    const badge = el('span', 'agent-badge cn-badge');
    badge.hidden = true;
    const dot = el('span', 'cn-dot');
    const text = el('span', 'cn-text');
    const label = el('span', 'cn-label', host.columnLabel(col));
    const sub = el('span', 'cn-sub');
    text.append(label, sub);
    const meta = el('span', 'cn-meta', ago(host.lastTurnTs(col.id)));
    const open = !!host.config.crewOpen;
    const fold = iconButton(open ? 'chevDown' : 'chevRight', hasCrew ? (open ? '收起队员列表' : '展开队员列表') : '暂无队员会话', () => {
      host.config.crewOpen = !open;
      host.saveConfig();
      render();
    }, 'captain-fold');
    fold.disabled = !hasCrew;
    fold.setAttribute('aria-expanded', String(open && hasCrew));
    if (hasCrew) fold.setAttribute('aria-controls', 'captainCrewList');
    const counts = el('span', 'crew-counts');
    counts.hidden = !hasCrew;
    counts.setAttribute('aria-live', 'polite');
    item.append(fold, badge, iconEl('crown', 'cn-crown'), dot, text, meta, counts);
    if (window.ClaudeSeats) item.appendChild(window.ClaudeSeats.rotationButton(col));
    item.addEventListener('click', () => selectCaptain(col));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: '打开对话', run: () => selectCaptain(col) },
        { label: '打开终端', run: () => { host.jumpToColumn(col); host.showSideTerminal(); } },
      ]);
    });
    host.navItems.set(col.id, { el: item, dot, label, sub, meta, badge });
    if (window.AgentInfo) {
      const entry = host.terms && host.terms.get(col.id);
      window.AgentInfo.renderBadge(badge, window.AgentInfo.resolveAgentInfo(col, entry), 'sidebar');
    }
    captainMirror.observe(dot, { attributes: true, attributeFilter: ['class'] });
    return item;
  }
  // Indented sessions, folded by the Captain's arrow; counts stay on its row.
  function crewBlock(crew, counts) {
    const open = !!host.config.crewOpen;
    const box = el('div', 'nav-group nav-crew');
    box.dataset.group = '';
    box.dataset.crew = '1';
    box.id = 'captainCrewList';
    box.hidden = !open;
    const order = crewOrder(crew);
    if (open) {
      const byId = new Map(crew.map((c) => [c.id, c]));
      order.running.forEach((id) => box.appendChild(sessionRow(byId.get(id))));
      // work 队长 handed out that waits for a free slot (no session yet)
      waitlist().forEach((w) => {
        const item = el('div', 'colnav-item crew-waiting');
        item.title = '同时干活的会话满了，有空位就自动开';
        item.append(el('span', 'cn-dot plain'), el('span', 'cn-text', null), el('span', 'cn-meta', '等空位'));
        item.querySelector('.cn-text').appendChild(el('span', 'cn-label', w.title));
        box.appendChild(item);
      });
      order.finished.forEach((id) => box.appendChild(sessionRow(byId.get(id))));
    } else {
      crew.forEach((col) => host.navItems.set(col.id, { el: null, dot: null, label: null, sub: null, meta: null }));
    }
    crewHead = { counts, ids: crew.map((c) => c.id), open, shown: orderKey(order) };
    refreshCrew();
    return box;
  }
  const waitlist = () => window.MainSession.state()?.waitlist || [];
  function crewOrder(crew) {
    const items = crew.map((c) => ({ id: c.id, state: host.terms.get(c.id)?.state, lastActive: host.lastTurnTs(c.id) }));
    return window.MainCore.crewOrder(items, window.MainSession.state()?.tasks);
  }
  const orderKey = (order) => [...order.running, '|' + waitlist().length, ...order.finished].join(',');
  // 「3 干活中 · 1 停在确认 · 2 完成 · 1 排队」, from the 1.5s status loop.
  function refreshCrew() {
    if (!crewHead) return;
    const n = { working: 0, quota: 0, input: 0, done: 0, failed: 0 };
    const tasks = window.MainSession.state()?.tasks || [];
    const latest = new Map(tasks.map((t) => [t.colId, t]));
    crewHead.ids.forEach((id) => {
      const st = host.terms.get(id)?.state;
      if (latest.get(id)?.status === 'failed' && !['working', 'quota', 'input'].includes(st)) n.failed++;
      else if (n[st] !== undefined) n[st]++;
    });
    const waiting = waitlist().length;
    const supplement = tasks.filter((t) => t.status === 'queued' && crewHead.ids.includes(t.colId)).length;
    // an unfolded list follows the work: re-sort when something starts or finishes
    // (not in the middle of a drag or a rename)
    if (crewHead.open && !document.body.classList.contains('reordering') && !listEl.querySelector('[contenteditable="true"]')) {
      const cols = crewHead.ids.map((id) => host.columns().find((c) => c.id === id)).filter(Boolean);
      if (orderKey(crewOrder(cols)) !== crewHead.shown) { render(); return; }
    }
    const text = [n.working && `${n.working} 干活中`, n.quota && `${n.quota} 额度用尽/等待`, n.input && `${n.input} 停在确认`, n.done && `${n.done} 完成`, n.failed && `${n.failed} 失败`, supplement && `${supplement} 待补充`, waiting && `${waiting} 排队`]
      .filter(Boolean).join(' · ') || `${crewHead.ids.length} 个`;
    if (crewHead.counts.textContent !== text) crewHead.counts.textContent = text;
  }
  // Selecting it shows its saved conversation.
  function selectCaptain(col) {
    host.jumpToColumn(col);
    if (!host.isChatMode(col.id)) host.setMode(col.id, 'chat');
  }

  function folderBlock(g) {
    const f = g.folder;
    const box = el('div', 'nav-folder');
    box.dataset.group = f.id;
    const head = el('div', 'nav-folder-head');
    head.dataset.folderId = f.id;
    const label = el('span', 'nav-folder-name', f.name);
    head.append(
      iconEl(f.collapsed ? 'chevRight' : 'chevDown', 'nav-chev'),
      iconEl(f.collapsed ? 'folder' : 'folderOpen', 'nav-folder-ico'),
      label,
      el('span', 'nav-folder-count', g.items.length ? String(g.items.length) : ''),
      iconButton('more', '更多', (e) => folderMenu(f, label, e.currentTarget), 'nav-more'),
    );
    head.addEventListener('click', () => {
      if (label.isContentEditable) return;
      f.collapsed = !f.collapsed;
      host.saveConfig();
      render();
    });
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      inlineEdit(label, f.name, (v) => { f.name = v; host.saveConfig(); render(); });
    });
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(f, label, { x: e.clientX, y: e.clientY }); });
    box.appendChild(head);
    if (!f.collapsed) {
      g.items.forEach((col) => box.appendChild(sessionRow(col)));
      if (!g.items.length) box.appendChild(el('div', 'nav-empty in-folder', '把对话拖到这里'));
    } else {
      // collapsed folders still reflect live state of what's inside
      g.items.forEach((col) => host.navItems.set(col.id, { el: null, dot: null, label: null, sub: null, meta: null, folderHead: head }));
    }
    return box;
  }

  function sessionRow(col) {
    const item = el('div', 'colnav-item');
    item.dataset.colId = col.id;
    const badge = el('span', 'agent-badge cn-badge');
    badge.hidden = true;
    const dot = el('span', 'cn-dot');
    const text = el('span', 'cn-text');
    const label = el('span', 'cn-label', host.columnLabel(col));
    label.title = '双击重命名';
    // live activity line, only shown while the agent works or waits on you
    const sub = el('span', 'cn-sub');
    text.append(label, sub);
    const meta = el('span', 'cn-meta', ago(host.lastTurnTs(col.id)));
    const actions = el('span', 'cn-actions');
    actions.append(
      iconButton('archive', '归档', () => host.archiveColumn(col)),
      iconButton('more', '更多', (e) => sessionMenu(col, label, e.currentTarget), 'nav-more'),
    );
    item.append(badge, dot, text, meta, actions);
    attachDrag(item, col);
    label.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      inlineEdit(label, host.columnLabel(col), (v) => host.renameSession(col, v));
    });
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); sessionMenu(col, label, { x: e.clientX, y: e.clientY }); });
    host.navItems.set(col.id, { el: item, dot, label, sub, meta, badge });
    if (window.AgentInfo) {
      const entry = host.terms && host.terms.get ? host.terms.get(col.id) : null;
      const info = window.AgentInfo.resolveAgentInfo(col, entry, entry?.lastScreen);
      window.AgentInfo.renderBadge(badge, info, 'sidebar');
    }
    return item;
  }

  function archivedRow(a) {
    const item = el('div', 'nav-archived-item');
    item.dataset.archivedId = a.id;
    item.title = '点击恢复到对话列表';
    item.append(
      iconEl('archive', 'nav-archived-ico'),
      el('span', 'cn-label', host.columnLabel(a)),
      el('span', 'cn-meta', ago(a.archivedAt)),
    );
    const actions = el('span', 'cn-actions');
    actions.append(
      iconButton('restore', '恢复', () => host.restoreArchived(a.id, true), 'nav-restore'),
      iconButton('trash', '永久删除', () => deleteArchived(a)),
    );
    item.appendChild(actions);
    item.addEventListener('click', () => host.restoreArchived(a.id, true));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: '恢复', run: () => host.restoreArchived(a.id, true) },
        '-',
        { label: '永久删除', danger: true, run: () => deleteArchived(a) },
      ]);
    });
    return item;
  }
  function deleteArchived(a) {
    if (!confirm(`永久删除「${host.columnLabel(a)}」？对话记录会一起删掉，不能恢复。`)) return;
    host.deleteArchived(a.id);
  }

  // ---- live bits, called from the 1.5s status loop ----
  function refreshTimes() {
    if (Date.now() - lastTimesAt < 30_000) return;
    lastTimesAt = Date.now();
    host.navItems.forEach((nav, id) => {
      if (!nav.meta) return;
      const t = ago(host.lastTurnTs(id));
      if (nav.meta.textContent !== t) nav.meta.textContent = t;
    });
  }
  function touchTime(id) {
    const nav = host.navItems.get(id);
    if (nav && nav.meta) nav.meta.textContent = ago(host.lastTurnTs(id));
  }

  // ---- folders ----
  function createFolder(rename, thenMove) {
    const folders = host.folders();
    const folder = { id: SC.newFolderId(), name: SC.nextFolderName(folders), collapsed: false };
    folders.push(folder);
    if (thenMove) host.moveSession(thenMove.id, { folderId: folder.id });
    host.saveConfig();
    render();
    if (rename) {
      const label = listEl.querySelector(`.nav-folder-head[data-folder-id="${folder.id}"] .nav-folder-name`);
      if (label) inlineEdit(label, folder.name, (v) => { folder.name = v; host.saveConfig(); render(); });
    }
    return folder;
  }
  function deleteFolder(f) {
    host.removeFolder(f.id);
  }

  // ---- menus ----
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }
  function openMenu(anchor, items) {
    closeMenu();
    menu = el('div', 'ctx-menu');
    menu.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it === '-') { menu.appendChild(el('div', 'ctx-sep')); return; }
      if (it.header) { menu.appendChild(el('div', 'ctx-head', it.header)); return; }
      const b = el('button', 'ctx-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.append(el('span', 'ctx-check', it.checked ? '✓' : ''), el('span', null, it.label));
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.run(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    let x, y;
    if (anchor instanceof Element) {
      const r = anchor.getBoundingClientRect();
      x = r.left; y = r.bottom + 4;
    } else { x = anchor.x; y = anchor.y; }
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + 'px';
    menu.style.top = (y + mh > innerHeight - 8 ? Math.max(8, y - mh - 8) : y) + 'px';
  }
  function sessionMenu(col, label, anchor) {
    const folders = host.folders();
    const crew = !!col.captainCrew && !!(window.MainSession && window.MainSession.mainCol());
    const current = crew ? null : SC.folderOf(col, folders);
    const items = [
      { label: '重命名', run: () => inlineEdit(label, host.columnLabel(col), (v) => host.renameSession(col, v)) },
      { label: '打开终端', run: () => { host.jumpToColumn(col); host.showSideTerminal(); } },
      ...(crew ? [{ label: '拉到前台（变成普通对话）', run: () => host.moveSession(col.id, { folderId: null }) }] : []),
      '-',
      { header: '移到文件夹' },
      ...(window.MainSession && window.MainSession.mainCol()
        ? [{ label: '交给队长后台', checked: crew, run: () => host.moveSession(col.id, { crew: true }) }] : []),
      ...folders.map((f) => ({ label: f.name, checked: f.id === current, run: () => host.moveSession(col.id, { folderId: f.id }) })),
      { label: '不放文件夹', checked: !crew && !current, run: () => host.moveSession(col.id, { folderId: null }) },
      { label: '新建文件夹并移入', run: () => createFolder(true, col) },
      '-',
      { label: '归档', run: () => host.archiveColumn(col) },
      { label: '关闭并删除', danger: true, run: () => {
        if (confirm(`关闭「${host.columnLabel(col)}」？终端会结束，对话记录也会删掉。只想先收起来可以用「归档」。`)) host.removeCol(col, true);
      } },
    ];
    openMenu(anchor, items);
  }
  function folderMenu(f, label, anchor) {
    openMenu(anchor, [
      { label: '重命名', run: () => inlineEdit(label, f.name, (v) => { f.name = v; host.saveConfig(); render(); }) },
      { label: '在这里新建对话', run: () => host.addAndFocusColumn({ folderId: f.id }) },
      '-',
      { label: '删除文件夹（对话会保留）', danger: true, run: () => deleteFolder(f) },
    ]);
  }

  // ---- inline rename ----
  function inlineEdit(labelEl, current, commit) {
    if (labelEl.isContentEditable) return;
    labelEl.contentEditable = 'true';
    labelEl.spellcheck = false;
    labelEl.textContent = current;
    labelEl.focus();
    const range = document.createRange(); range.selectNodeContents(labelEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    let cancelled = false;
    const onKey = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); labelEl.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; labelEl.blur(); }
    };
    const stop = (ev) => ev.stopPropagation();
    labelEl.addEventListener('keydown', onKey);
    labelEl.addEventListener('mousedown', stop);
    labelEl.addEventListener('click', stop);
    labelEl.addEventListener('blur', () => {
      labelEl.removeEventListener('keydown', onKey);
      labelEl.removeEventListener('mousedown', stop);
      labelEl.removeEventListener('click', stop);
      labelEl.contentEditable = 'false';
      window.getSelection().removeAllRanges();
      const v = labelEl.textContent.replace(/\s+/g, ' ').trim();
      if (!cancelled && v && v !== current) commit(v);
      else labelEl.textContent = current;
    }, { once: true });
  }

  // ---- drag: reorder, into folders, out of folders, onto the archive ----
  function clearDrop() {
    listEl.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }
  function rowsOf(group) { return [...group.querySelectorAll(':scope > .colnav-item')]; }
  function dropTargetAt(x, y, srcId) {
    const over = document.elementFromPoint(x, y);
    if (!over || !listEl.contains(over)) return null;
    const row = over.closest('.colnav-item');
    if (row) {
      if (row.dataset.colId === srcId) return { kind: 'noop' };
      // dropped on 队长's row: goes to the end of 队长's sessions
      if (row.dataset.captain) return { kind: 'move', crew: true, beforeId: null, el: row, cls: 'drop-into' };
      const group = row.closest('[data-group]');
      const crew = !!(group && group.dataset.crew);
      const folderId = group && !crew ? group.dataset.group || null : null;
      const r = row.getBoundingClientRect();
      const after = y > r.top + r.height / 2;
      let beforeId = row.dataset.colId;
      if (after) {
        const rows = rowsOf(group);
        const next = rows[rows.indexOf(row) + 1];
        beforeId = next ? next.dataset.colId : null;
      }
      if (beforeId === srcId) return { kind: 'noop' };
      return { kind: 'move', crew, folderId, beforeId, el: row, cls: after ? 'drop-after' : 'drop-before' };
    }
    const fhead = over.closest('.nav-folder-head');
    if (fhead) return { kind: 'move', folderId: fhead.dataset.folderId, beforeId: null, el: fhead, cls: 'drop-into' };
    const section = over.closest('.nav-section');
    if (section && section.dataset.section === 'archived') return { kind: 'archive', el: section, cls: 'drop-into' };
    if (section && section.dataset.section === 'loose') return { kind: 'move', folderId: null, beforeId: null, el: section, cls: 'drop-into' };
    const group = over.closest('[data-group]');
    if (group) {
      const crew = !!group.dataset.crew;
      const target = crew ? listEl.querySelector('.captain-item') : (group.dataset.group ? group.querySelector('.nav-folder-head') : group);
      return { kind: 'move', crew, folderId: crew ? null : group.dataset.group || null, beforeId: null, el: target, cls: 'drop-into' };
    }
    return null;
  }
  function attachDrag(item, col) {
    item.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const label = item.querySelector('.cn-label');
      if (label && label.isContentEditable) return;
      e.preventDefault();
      closeMenu();
      const startX = e.clientX, startY = e.clientY;
      let dragging = false;
      let drop = null;
      const onMove = (ev) => {
        if (!dragging) {
          if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
          dragging = true;
          document.body.classList.add('reordering');
          item.classList.add('cn-dragging');
        }
        clearDrop();
        drop = dropTargetAt(ev.clientX, ev.clientY, col.id);
        if (drop && drop.el) drop.el.classList.add(drop.cls);
        // let a long list scroll while dragging near its edges
        const r = listEl.getBoundingClientRect();
        if (ev.clientY < r.top + 24) listEl.scrollTop -= 12;
        else if (ev.clientY > r.bottom - 24) listEl.scrollTop += 12;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('reordering');
        item.classList.remove('cn-dragging');
        clearDrop();
        if (!dragging) { host.jumpToColumn(col); return; }
        // the click that ends a drag must not toggle the (re-rendered) folder under it
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        listEl.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => listEl.removeEventListener('click', swallow, { capture: true }), 0);
        if (!drop || drop.kind === 'noop') return;
        if (drop.kind === 'archive') host.archiveColumn(col);
        else host.moveSession(col.id, { crew: drop.crew, folderId: drop.folderId, beforeId: drop.beforeId });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function init(h) {
    host = h;
    topEl = document.getElementById('navTop');
    listEl = document.getElementById('navList');
    buildTop();
    document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    listEl.addEventListener('scroll', closeMenu, { passive: true });
  }

  window.Sidebar = { init, render, markPage, refreshTimes, touchTime, createFolder, closeMenu, openMenu, ago, refreshCrew };
})();
