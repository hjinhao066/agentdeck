// 交付文件: a panel on the right of 队长's conversation listing the result files
// that came up in it (队长's replies, the crew's receipts, the conversations from
// before a context clear), newest first by day. The rules and the saved index are
// in deliverables-core.js; the receipts are the ones Artifacts › 回执交付 reads
// (ChatCore.deliveryReceipts). A wide column docks the panel beside the chat, a
// narrow one slides it over the chat on request. Clicking a file previews it in
// the side pane, as everywhere else.
(function () {
  'use strict';
  const C = window.ChatCore, D = window.DeliverablesCore;
  const DOCK_MIN = 1100;          // a column at least this wide docks the panel
  const PAGE = 200;               // rows shown at first, and added by each 「显示更早的」
  let host = null;
  let panel = null;               // the 队长 column's panel (there is only one 队长)
  let timer = null;
  let diskRun = 0;
  const onDisk = new Map();       // path key -> 0 gone, 1 file, 2 folder

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // Icon-only actions: the title is both the tooltip and the accessible name.
  function iconButton(cls, iconName, title, onClick) {
    const b = el('button', 'icon-btn ' + cls);
    b.type = 'button';
    b.innerHTML = host.ICONS[iconName] || '';
    label(b, title);
    if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e, b); });
    return b;
  }
  function label(b, title) { b.title = title; b.setAttribute('aria-label', title); }

  const mainColumn = () => host.columns().find((c) => c.isMain) || null;
  const isOpen = () => !!panel && (panel.docked ? host.config.chatDeliverablesOpen !== false : panel.overlayOpen);
  const revealTitle = () => (host.platform === 'darwin' ? '在访达中显示' : host.platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示');
  const shortPath = (p) => (host.home && p.startsWith(host.home) && /^[\\/]/.test(p.slice(host.home.length)) ? '~' + p.slice(host.home.length) : p);
  const hm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ---- building ----
  function mount(col, wrap, head, chat) {
    if (panel && panel.wrap.isConnected && panel.colId !== col.id) unmount();
    const aside = el('aside', 'dlv');
    aside.setAttribute('aria-label', '交付文件');
    const top = el('div', 'dlv-head');
    const title = el('h2', 'dlv-title', '交付文件');
    const count = el('span', 'dlv-count', '0');
    const rulesBtn = iconButton('dlv-tool', 'gear', '筛选规则', () => toggleRules());
    rulesBtn.setAttribute('aria-expanded', 'false');
    const close = iconButton('dlv-tool', 'panelRight', '收起交付文件', () => setOpen(false, true));
    top.append(title, count, el('span', 'dlv-spacer'), rulesBtn, close);
    const rules = el('form', 'dlv-rules');
    rules.hidden = true;
    const body = el('div', 'dlv-body');
    aside.append(top, rules, body);
    chat.appendChild(aside);

    const toggle = iconButton('dlv-toggle', 'artifacts', '交付文件', () => setOpen(!isOpen(), true));
    const badge = el('span', 'dlv-badge', '');
    badge.hidden = true;
    toggle.appendChild(badge);
    head.insertBefore(toggle, head.querySelector('.view-toggle') || head.querySelector('.secondary'));

    panel = { colId: col.id, wrap, chat, aside, body, count, rules, rulesBtn, toggle, badge, docked: false, overlayOpen: false, items: [], limit: PAGE };
    // Typing in the panel stays in the panel (the chat sends stray keys to the composer).
    aside.addEventListener('keydown', (e) => {
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.stopPropagation(); return; }
      if (e.key !== 'Escape' || (rules.hidden && panel.docked)) return;
      e.stopPropagation();
      e.preventDefault();
      if (!rules.hidden) { toggleRules(false); rulesBtn.focus(); return; }
      setOpen(false, true);
      toggle.focus();
    });
    new ResizeObserver(() => layout()).observe(wrap);
    layout();
    refresh();
  }
  function unmount() {
    if (!panel) return;
    panel.aside.remove(); panel.toggle.remove();
    panel = null;
  }

  // Docked beside the chat in a wide column, over it in a narrow one. The
  // panel's width is a share of the column, between 280 and 340px.
  function layout() {
    if (!panel || !panel.wrap.isConnected) return;
    const width = panel.wrap.getBoundingClientRect().width;
    if (!width) return;
    const docked = width >= DOCK_MIN;
    if (docked !== panel.docked) { panel.docked = docked; panel.overlayOpen = false; }
    panel.chat.style.setProperty('--dlv-w', Math.round(Math.max(280, Math.min(340, width * 0.24))) + 'px');
    sync();
  }
  function sync() {
    if (!panel) return;
    const open = isOpen();
    panel.chat.classList.toggle('dlv-open', open);
    panel.chat.classList.toggle('dlv-docked', panel.docked);
    panel.aside.classList.toggle('overlay', !panel.docked);
    // The number on the button: files that came in while the panel was away.
    const index = host.config.chatDeliverables;
    if (open && index) {
      const next = D.markSeen(index);
      if (next !== index) { host.config.chatDeliverables = next; host.saveConfig(); }
    }
    const fresh = index ? D.unseenCount(host.config.chatDeliverables) : 0;
    panel.badge.textContent = fresh > 99 ? '99+' : String(fresh);
    panel.badge.hidden = !fresh;
    label(panel.toggle, open ? '收起交付文件' : '交付文件' + (fresh ? `（${fresh} 个新的）` : ''));
    panel.toggle.setAttribute('aria-pressed', String(open));
    panel.toggle.setAttribute('aria-expanded', String(open));
  }
  function setOpen(open, byUser) {
    if (!panel) return;
    if (panel.docked) {
      host.config.chatDeliverablesOpen = !!open;
      if (byUser) host.saveConfig();
    } else panel.overlayOpen = !!open;
    sync();
    if (open) { checkDisk(); if (byUser && !panel.docked) requestAnimationFrame(() => panel.aside.querySelector('.dlv-main, .dlv-tool')?.focus()); }
    else if (!panel.rules.hidden) toggleRules(false);
  }

  // ---- the list ----
  function projectNames() {
    const main = host.config.mainSession;
    return [...host.columns(), ...host.archived(), ...(main && Array.isArray(main.tasks) ? main.tasks : [])].map((c) => c.project).filter(Boolean);
  }
  // The receipts Artifacts › 回执交付 reads: each session's last receipt, 队长's
  // task list and the task cards in 队长's conversations.
  function receipts(main) {
    const session = (c, archived) => ({ id: c.id, title: host.columnLabel(c), project: c.project, archived, lastReceipt: c.lastReceipt });
    const tasks = host.config.mainSession && Array.isArray(host.config.mainSession.tasks) ? host.config.mainSession.tasks : [];
    return C.deliveryReceipts({
      sessions: [...host.columns().map((c) => session(c, false)), ...host.archived().map((a) => session(a, true))],
      tasks,
      chats: [...(main ? [{ colId: main.id, turns: window.ChatUI.turnsOf(main.id) }] : []), ...window.ChatUI.captainArchives()],
    });
  }
  // A reply as the chat view shows it (terminal residue taken out).
  function shownText(turns) {
    const said = turns.map((t) => t.user || '').join('\n');
    return (turn) => C.shownReply(turn.reply, said, window.HubCore && window.HubCore.cleanReply, turn.user);
  }
  // Fold what 队长's conversations hold into the saved index and return its items.
  function collect() {
    const rules = D.normalizeRules(host.config.deliverableRules);
    const index = D.normalizeIndex(host.config.chatDeliverables, rules);
    const main = mainColumn();
    const found = [];
    const read = new Set(index.scanned);
    // the conversations from before a clear never change: each is read once
    for (const chat of window.ChatUI.captainArchives()) {
      if (read.has(chat.id) || (main && chat.id === main.id)) continue;
      found.push(...D.fromReplies(chat.turns, { text: shownText(chat.turns), findLinks: host.findLinks, rules, colId: chat.id, chatId: chat.id, old: true }));
      index.scanned.push(chat.id);
    }
    if (main) {
      const turns = window.ChatUI.turnsOf(main.id);
      found.push(...D.fromReplies(turns, { text: shownText(turns), findLinks: host.findLinks, rules, colId: main.id, chatId: main.id }));
    }
    found.push(...D.fromReceipts(receipts(main), rules));
    let next = D.mergeIndex(index, found, { home: host.home, projects: projectNames() });
    if (!next.seen) next = D.markSeen(next);   // the first count: what is already there is not new
    if (JSON.stringify(next) !== JSON.stringify(host.config.chatDeliverables)) {
      host.config.chatDeliverables = next;
      host.saveConfig();
    }
    return next.items;
  }

  // Later turns and receipts come in bursts: one refresh for a burst.
  function refresh() {
    clearTimeout(timer);
    timer = null;
    if (!panel || !panel.wrap.isConnected) return;
    // nothing is read or saved before the saved chats are in (their load refreshes the panel)
    if (!window.ChatUI.isLoaded()) return;
    let items;
    try { items = collect(); } catch (_) { return; }
    panel.items = items;
    render();
    sync();
    if (isOpen()) checkDisk();
  }
  function refreshSoon() {
    if (!timer) timer = setTimeout(refresh, 300);
  }

  function render() {
    const { body, items } = panel;
    const at = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.fk : '';
    const top = body.scrollTop;
    panel.count.textContent = String(items.length);
    body.textContent = '';
    if (!items.length) {
      const empty = el('div', 'dlv-empty');
      empty.append(el('strong', null, '还没有交付文件'),
        el('span', null, '队长回复和队员回执里给出的文档、报告、图片和视频会自动收在这里，新的在上面。'));
      body.appendChild(empty);
      return;
    }
    const now = Date.now();
    const main = mainColumn();
    const live = new Set(main ? window.ChatUI.turnsOf(main.id).map((t) => t.id) : []);
    const shown = items.slice(0, panel.limit);
    for (const day of D.byDay(shown, now)) {
      const sec = el('section', 'dlv-group');
      sec.appendChild(el('h3', 'dlv-day', day.label));
      const list = el('div', 'dlv-rows');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', day.label);
      day.items.forEach((item) => list.appendChild(fileRow(item, live, main)));
      sec.appendChild(list);
      body.appendChild(sec);
    }
    if (shown.length < items.length) {
      const left = items.length - shown.length;
      const more = el('button', 'dlv-more', left > PAGE ? `显示更早的 ${PAGE} 个（还有 ${left} 个）` : `显示更早的 ${left} 个`);
      more.type = 'button'; more.dataset.fk = 'more';
      more.addEventListener('click', () => { panel.limit += PAGE; render(); checkDisk(); });
      body.appendChild(more);
    }
    body.scrollTop = top;
    const back = at && [...body.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === at);
    if (back) back.focus();
  }

  function tile(item, state) {
    const kind = state === 2 ? 'dir' : C.fileKind(item.name);
    const ext = C.extOf(item.name);
    const video = /^(?:mp4|mov|m4v|webm)$/.test(ext), audio = /^(?:mp3|m4a|wav)$/.test(ext);
    const t = el('span', 'art-tile dlv-tile t-' + (video ? 'video' : audio ? 'audio' : kind));
    t.setAttribute('aria-hidden', 'true');
    if (kind === 'image') t.innerHTML = host.ICONS.image;
    else if (kind === 'dir') t.innerHTML = host.ICONS.folder;
    else t.textContent = (kind === 'markdown' ? 'MD' : ext.toUpperCase()).slice(0, 4);
    return t;
  }
  function source(item, live, main) {
    if (item.from === 'reply') {
      const old = !main || item.chatId !== main.id || !live.has(item.turnId);
      return { text: old ? '清空前的队长对话' : '队长回复', old };
    }
    const col = host.columns().find((c) => c.id === item.colId) || host.archived().find((a) => a.id === item.colId);
    return { text: col ? host.columnLabel(col) : item.session || item.task || '已删除的会话', session: col || null };
  }
  function fileRow(item, live, main) {
    const name = String(item.path).replace(/:\d+(?::\d+)?$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    item = { ...item, name };
    const state = onDisk.get(item.key);
    const gone = state === 0;
    const from = source(item, live, main);
    const row = el('div', 'dlv-row' + (gone ? ' gone' : ''));
    row.setAttribute('role', 'listitem');
    row.dataset.path = item.path;

    const open = el('button', 'dlv-main');
    open.type = 'button'; open.dataset.fk = 'file:' + item.key;
    const text = el('span', 'dlv-text');
    const meta = el('span', 'dlv-meta');
    if (item.project) {
      const dot = el('i', 'dlv-dot');
      if (window.CrewMapCore) dot.style.setProperty('--project-hue', window.CrewMapCore.projectHue(item.project.toLowerCase()));
      meta.append(dot, el('span', 'dlv-project', item.project), el('span', 'dlv-sep', '·'));
    }
    meta.appendChild(el('span', 'dlv-from', from.text));
    text.append(el('span', 'dlv-name', name), meta);
    const time = el('time', 'dlv-time', item.ts ? hm(item.ts) : '');
    if (item.ts) time.dateTime = new Date(item.ts).toISOString();
    open.append(tile(item, state), text, time);
    const goneWhy = '这个文件已经不在磁盘上（被移走、改名或删除了），不能预览。路径还可以复制。';
    open.title = [gone ? goneWhy : shortPath(item.path), item.project && '项目：' + item.project,
      '来自：' + (item.from === 'reply' ? from.text : '回执 · ' + from.text + (item.task && item.task !== from.text ? ' · ' + item.task : '')),
      item.ts && '时间：' + new Date(item.ts).toLocaleString()].filter(Boolean).join('\n');
    if (gone) open.setAttribute('aria-disabled', 'true');
    open.addEventListener('click', (e) => {
      if (gone) { host.showToast(goneWhy); return; }
      window.SidePane.openLink({ kind: 'file', text: item.path }, e, from.session ? from.session.id : (main && main.id) || '');
    });

    const actions = el('span', 'dlv-actions');
    const copy = iconButton('dlv-tool', 'copy', '复制路径', (_e, b) => {
      try { host.clipboardWrite(item.path); } catch (_) { host.showToast('没能复制到剪贴板'); return; }
      b.innerHTML = host.ICONS.check; b.classList.add('done'); label(b, '已复制');
      clearTimeout(b.checkTimer);
      b.checkTimer = setTimeout(() => { b.innerHTML = host.ICONS.copy; b.classList.remove('done'); label(b, '复制路径'); }, 1200);
    });
    const reveal = iconButton('dlv-tool', 'folderOpen', gone ? '打开它原来所在的文件夹' : revealTitle(), () => window.deck.revealPath(item.path, main ? main.id : ''));
    let jump;
    if (item.from === 'reply') {
      jump = iconButton('dlv-tool', 'chat', from.old ? '清空前的对话在队长对话最上面展开查看' : '跳到提到它的回复', () => {
        if (from.old) { host.showToast('这段对话在清空上下文之前，在队长对话最上面「查看清空上下文前的队长对话」里能找到。'); return; }
        window.ChatUI.reveal(main.id, item.turnId, 'reply');
      });
      if (from.old) jump.setAttribute('aria-disabled', 'true');
    } else {
      jump = iconButton('dlv-tool', 'chat', from.session ? '跳到交付它的会话' : '交付它的会话已经删除', () => {
        if (!from.session) { host.showToast('交付这个文件的会话已经删除了，文件记录还留在这里。'); return; }
        if (!panel.docked) setOpen(false);
        window.ChatUI.reveal(from.session.id);
      });
      if (!from.session) jump.setAttribute('aria-disabled', 'true');
    }
    copy.dataset.fk = 'copy:' + item.key; reveal.dataset.fk = 'reveal:' + item.key; jump.dataset.fk = 'jump:' + item.key;
    actions.append(copy, reveal, jump);
    row.append(open, actions);
    return row;
  }

  // Files get moved and deleted behind the panel's back: ask the disk when it
  // opens, when the list changes and when the window comes back to the front.
  async function checkDisk() {
    if (!panel || !isOpen() || !panel.items.length) return;
    const run = ++diskRun;
    const items = panel.items.slice(0, panel.limit);
    let changed = false;
    for (let at = 0; at < items.length; at += 1000) {
      const part = items.slice(at, at + 1000);
      let res;
      try { res = await window.deck.artifactsStat(part.map((i) => i.path)); } catch (_) { return; }
      if (run !== diskRun || !panel || !Array.isArray(res)) return;
      part.forEach((item, i) => {
        if (res[i] === undefined || onDisk.get(item.key) === res[i]) return;
        onDisk.set(item.key, res[i]);
        changed = true;
      });
    }
    if (changed) render();
  }

  // ---- the two lists, editable ----
  function toggleRules(force) {
    const form = panel.rules;
    const show = force === undefined ? form.hidden : force;
    panel.rulesBtn.setAttribute('aria-expanded', String(show));
    panel.rulesBtn.classList.toggle('active', show);
    if (!show) { form.hidden = true; return; }
    const rules = D.normalizeRules(host.config.deliverableRules);
    form.textContent = '';
    const field = (labelText, value, hint) => {
      const id = 'dlv-' + Math.random().toString(36).slice(2, 8);
      const wrap = el('div', 'dlv-field');
      const lab = el('label', null, labelText);
      lab.htmlFor = id;
      const input = el('textarea');
      input.id = id; input.rows = 3; input.spellcheck = false; input.value = value.join(', ');
      input.setAttribute('aria-describedby', id + '-hint');
      const note = el('div', 'dlv-hint', hint);
      note.id = id + '-hint';
      wrap.append(lab, input, note);
      form.appendChild(wrap);
      return input;
    };
    const types = field('算作交付的文件类型', rules.types, '队长回复里提到的文件要是这些类型才列出；队员回执里明确交付的文件不受这条限制。扩展名用逗号或空格隔开。');
    const process = field('从不算交付的文件类型', rules.process, '脚本、数据、日志这类过程文件，回执里交了也不列。');
    const skip = field('跳过这些文件夹里的文件', rules.skip, '文件夹名，路径里出现就不列，例如 node_modules、tmp。');
    const bar = el('div', 'dlv-form-bar');
    const reset = el('button', 'btn dlv-reset', '恢复默认');
    reset.type = 'button';
    const save = el('button', 'btn primary', '保存');
    save.type = 'submit';
    bar.append(reset, el('span', 'dlv-spacer'), save);
    form.appendChild(bar);
    const apply = (next) => {
      if (next && !D.isDefault(next)) host.config.deliverableRules = { types: next.types, skip: next.skip, process: next.process };
      else delete host.config.deliverableRules;
      host.saveConfig();
      toggleRules(false);
      panel.rulesBtn.focus();
      refresh();
    };
    reset.addEventListener('click', () => apply(null));
    form.onsubmit = (e) => { e.preventDefault(); apply({ types: D.parseList(types.value), skip: D.parseList(skip.value, true), process: D.parseList(process.value) }); };
    form.hidden = false;
    types.focus();
  }

  function init(h) {
    host = h;
    window.addEventListener('focus', () => { if (panel && isOpen()) checkDisk(); });
  }

  window.ChatDeliverables = {
    init, mount, refresh: refreshSoon, layout,
    refreshNow: refresh,
    isOpen: () => isOpen(),
  };
})();
