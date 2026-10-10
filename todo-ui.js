// 随手记待办 on the desktop: the 待办 page (one of the pages that cover the
// deck, opened from the sidebar) and the quick-capture box (⌘⇧N on a Mac,
// Ctrl+Shift+N on Windows, changeable in 设置) that records a line from anywhere.
// Data lives in the main process (todo-store.js); this file only asks for it
// through the fixed `deck.todos` bridge.
(function () {
  'use strict';
  let host = null;
  let items = [];                 // live items, open first (newest first), then finished
  let loaded = false;
  let page = null;                // { input, error, list } while the page is open
  let editing = null;             // id of the item whose text is being edited
  let doneOpen = false;
  let undo = null;                // { item, timer } after a delete
  let pendingRender = false;
  let quick = null;               // quick-capture box elements
  let quickReturn = null;         // element to give focus back to

  const TEXT_MAX = 500;
  const FRESH_MS = 1600;
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(name) { return host.ICONS[name] || ''; }
  // The check on a 复制路径 button belongs to the key, not to the clicked node: the list redraws
  // while the write runs, and the new button must show it (copy-mark.js).
  const copied = window.CopyMark.create({
    find: (key) => document.querySelectorAll(`[data-focus-key="${(window.CSS && CSS.escape ? CSS.escape(key) : key)}"]`),
    show: (b) => { b.innerHTML = svg('check'); b.title = '已复制'; b.setAttribute('aria-label', '已复制'); b.classList.add('done'); },
    hide: (b) => { b.innerHTML = svg('copy'); b.title = '复制路径'; b.setAttribute('aria-label', '复制路径'); b.classList.remove('done'); },
  });
  function iconButton(name, label, onClick, cls) {
    const b = el('button', 'todo-ibtn' + (cls ? ' ' + cls : ''));
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = svg(name);
    b.addEventListener('click', onClick);
    return b;
  }
  // The sidebar asks for the shortcut's name before init, so fall back to the browser's own answer.
  const isMac = () => (host ? host.platform === 'darwin' : /^Mac/.test(navigator.platform));
  const shortcutLabel = () => window.TodoShortcutCore.label(host && host.config.todoShortcut, isMac());
  const subtitle = () => `脑子里冒出来的事，先记在这里。在 AgentDeck 里任何地方按 ${shortcutLabel()} 都能速记一条；手机总台也能记、能勾。句子里写 @ai 就交给 AI 去办，结果回到「待我处理」。`;
  // Enter while an input method is still composing picks a candidate; it never saves.
  const composing = (e) => e.isComposing || e.keyCode === 229;
  const openCount = () => items.filter((t) => !t.done).length;

  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
    const d = new Date(iso);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function fullTime(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '';
  }

  // ---- data ----
  async function refresh() {
    try {
      const answer = await window.deck.todos('list');
      items = Array.isArray(answer && answer.items) ? answer.items : [];
      loaded = true;
    } catch (_) { /* Keep what is shown; the next change or page open asks again. */ }
    window.Sidebar.setTodoCount(openCount());
    redraw();
    drawQuick();
  }
  async function write(op, input) {
    const answer = await window.deck.todos(op, input);
    const item = answer && answer.item;
    if (item) {
      const at = items.findIndex((t) => t.id === item.id);
      if (item.deleted) { if (at >= 0) items.splice(at, 1); }
      else if (at >= 0) items[at] = item; else items.unshift(item);
      items = order(items);
      window.Sidebar.setTodoCount(openCount());
    }
    return item;
  }
  function order(list) {
    const open = list.filter((t) => !t.done).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    const done = list.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || b.updated) - Date.parse(a.doneAt || a.updated));
    return [...open, ...done];
  }
  function friendly(err) {
    const text = String(err && err.message || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    return /[一-鿿]/.test(text) ? text : '没有存上，再试一次。';
  }

  // ---- page ----
  function render(frame, h) {
    host = h || host;
    const body = frame('待办', subtitle());
    body.parentElement.classList.add('page-todo');
    const form = el('form', 'todo-add');
    form.setAttribute('aria-label', '记一条待办');
    const ring = el('span', 'todo-add-ring');
    ring.setAttribute('aria-hidden', 'true');
    const input = el('input', 'todo-add-input');
    input.type = 'text'; input.maxLength = TEXT_MAX; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = '记一件事，回车存下';
    input.setAttribute('aria-label', '新待办');
    const add = iconButton('plus', '记下这条待办（回车）', () => form.requestSubmit(), 'todo-add-btn');
    add.type = 'submit';
    form.append(ring, input, add);
    const error = el('p', 'todo-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const list = el('div', 'todo-lists');
    const toast = el('div', 'todo-undo');
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    body.append(form, error, list, toast);
    page = { input, error, list, toast, add };
    input.addEventListener('input', () => { error.hidden = true; add.disabled = !input.value.trim(); });
    add.disabled = true;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      add.disabled = true;
      try {
        await write('add', { text });
        input.value = '';
        error.hidden = true;
        drawList();
      } catch (err) { showError(friendly(err)); add.disabled = false; }
      input.focus();
    });
    drawList();
    if (!loaded) refresh();
    requestAnimationFrame(() => { if (page && page.input === input && !editing) input.focus(); });
  }
  function showError(text) { if (!page) return; page.error.textContent = text; page.error.hidden = false; }
  function visible() { return !!(page && page.list.isConnected); }
  function redraw() {
    if (!visible()) { page = null; return; }
    if (editing) { pendingRender = true; return; }
    drawList();
  }
  function drawList() {
    if (!visible()) return;
    pendingRender = false;
    const { list } = page;
    const keep = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    list.textContent = '';
    const open = items.filter((t) => !t.done), done = items.filter((t) => t.done);
    if (!loaded) {
      list.appendChild(el('p', 'todo-loading', '正在读取…'));
      return;
    }
    if (!open.length) list.appendChild(empty(done.length));
    else {
      const head = el('div', 'todo-section');
      head.append(el('span', 'todo-section-label', '未完成'), el('span', 'todo-section-count', String(open.length)));
      const ul = el('ul', 'todo-list');
      ul.setAttribute('aria-label', '未完成的待办');
      open.forEach((t) => ul.appendChild(row(t)));
      list.append(head, ul);
    }
    if (done.length) {
      const toggle = el('button', 'todo-section todo-done-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(doneOpen));
      toggle.dataset.focusKey = 'done-toggle';
      const chev = el('span', 'todo-chev');
      chev.innerHTML = svg(doneOpen ? 'chevDown' : 'chevRight');
      toggle.append(chev, el('span', 'todo-section-label', '已完成'), el('span', 'todo-section-count', String(done.length)));
      toggle.title = doneOpen ? '收起已完成' : '展开已完成';
      toggle.addEventListener('click', () => { doneOpen = !doneOpen; drawList(); });
      list.appendChild(toggle);
      if (doneOpen) {
        const ul = el('ul', 'todo-list todo-list-done');
        ul.setAttribute('aria-label', '已完成的待办');
        done.forEach((t) => ul.appendChild(row(t)));
        list.appendChild(ul);
      }
    }
    if (keep) { const again = list.querySelector(`[data-focus-key="${CSS.escape(keep)}"]`); if (again) again.focus(); }
  }
  function empty(doneCount) {
    const box = el('div', 'todo-empty');
    const art = el('div', 'todo-empty-art');
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = svg(doneCount ? 'check' : 'todo');
    const title = el('strong', null, doneCount ? '都做完了' : '清单还是空的');
    const note = el('p', null, doneCount ? '新冒出来的事，直接在上面记一条。' : '买东西、回邮件、别忘了的小事——打一句话，回车就存好。');
    const keys = el('p', 'todo-empty-keys');
    const kbd = el('kbd', null, shortcutLabel());
    keys.append('在 AgentDeck 任何地方按 ', kbd, ' 随手记');
    box.append(art, title, note, keys);
    return box;
  }
  function row(t) {
    const li = el('li', 'todo-row' + (t.done ? ' is-done' : ''));
    li.dataset.id = t.id;
    const check = el('button', 'todo-check');
    check.type = 'button';
    check.dataset.focusKey = 'check:' + t.id;
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(!!t.done));
    const name = t.done ? '标为未完成' : '勾掉（标为完成）';
    check.title = name; check.setAttribute('aria-label', `${name}：${t.text}`);
    check.innerHTML = svg('check');
    check.addEventListener('click', () => toggleDone(t, li));
    const main = el('div', 'todo-main');
    if (editing === t.id) main.appendChild(editor(t));
    else {
      const text = el('span', 'todo-text', t.text);
      text.addEventListener('dblclick', () => startEdit(t.id));
      main.appendChild(text);
      if (t.ai) main.appendChild(aiLine(t));
    }
    const when = el('time', 'todo-when', t.done ? '完成于 ' + ago(t.doneAt || t.updated) : ago(t.created));
    when.dateTime = t.done ? (t.doneAt || t.updated) : t.created;
    when.title = (t.done ? '完成于 ' + fullTime(t.doneAt || t.updated) + ' · ' : '') + '记于 ' + fullTime(t.created);
    const actions = el('div', 'todo-actions');
    if (!t.done && editing !== t.id) {
      const edit = iconButton('edit', '编辑', () => startEdit(t.id));
      edit.setAttribute('aria-label', `编辑：${t.text}`);
      edit.dataset.focusKey = 'edit:' + t.id;
      actions.appendChild(edit);
    }
    const del = iconButton('trash', '删除', () => remove(t), 'todo-del');
    del.setAttribute('aria-label', `删除：${t.text}`);
    del.dataset.focusKey = 'del:' + t.id;
    actions.appendChild(del);
    li.append(check, main, when, actions);
    return li;
  }
  // A 待办 handed to AI (@ai): what 队长 wrote back, on every computer (it syncs with the item).
  const AI_LABEL = { working: 'AI 正在办', needs_user: 'AI 在等你', done: 'AI 办完了', failed: 'AI 没办成' };
  function aiLine(t) {
    const ai = t.ai;
    const status = AI_LABEL[ai.status] ? ai.status : 'queued';
    const box = el('div', 'todo-ai is-' + status);
    box.append(el('span', 'todo-ai-chip', AI_LABEL[status] || (ai.deliveredAt ? '已交给 AI · 队长已收到' : '已交给 AI · 等队长接收')));
    if (ai.message && status !== 'queued') box.append(el('span', 'todo-ai-msg', ai.message));
    const files = status === 'done' && Array.isArray(ai.files) ? ai.files.filter((p) => typeof p === 'string') : [];
    if (files.length) {
      const list = el('ul', 'todo-ai-files');
      list.setAttribute('aria-label', 'AI 交回的文件');
      files.forEach((p, i) => {
        const name = String(p).split(/[\\/]/).filter(Boolean).pop() || p;
        const row = el('li', 'todo-ai-file');
        const open = el('button', 'todo-ai-open', name);
        open.type = 'button'; open.title = p; open.dataset.focusKey = `aifile:${t.id}:${i}`;
        open.addEventListener('click', (e) => window.SidePane.openLink({ kind: 'file', text: p }, e));
        const copyKey = `aicopy:${t.id}:${i}`;
        const copy = iconButton('copy', '复制路径', async () => {
          try { await host.clipboardWrite(p); } catch (_) { host.showToast('没能复制到剪贴板，请再试一次'); return; }
          copied.done(copyKey);
        }, 'todo-ai-tool');
        copy.dataset.focusKey = copyKey;
        copied.adopt(copyKey, copy);
        const reveal = host.platform === 'darwin' ? '在访达中显示' : host.platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示';
        const show = iconButton('folderOpen', reveal, () => window.deck.revealPath(p), 'todo-ai-tool');
        show.dataset.focusKey = `aireveal:${t.id}:${i}`;
        row.append(open, copy, show);
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    return box;
  }
  // Used by the page and the quick-capture box alike.
  async function toggleDone(t, li) {
    if (li.classList.contains('is-leaving')) return;
    const done = !t.done;
    li.classList.toggle('is-done', done);
    li.classList.add('is-leaving');
    li.querySelector('.todo-check').setAttribute('aria-checked', String(done));
    try {
      await write('update', { id: t.id, done });
      // Let the tick show before the row moves to the other list.
      setTimeout(() => { if (!editing) drawList(); else pendingRender = true; drawQuick(); }, 380);
    } catch (err) {
      li.classList.remove('is-leaving'); li.classList.toggle('is-done', t.done);
      if (quick && quick.list.contains(li)) quick.status.textContent = friendly(err); else showError(friendly(err));
    }
  }
  function editor(t) {
    const input = el('input', 'todo-edit');
    input.type = 'text'; input.maxLength = TEXT_MAX; input.value = t.text; input.spellcheck = false;
    input.setAttribute('aria-label', '修改待办，回车保存，Esc 取消');
    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const text = input.value;
      if (save && text.trim() && text.trim() !== t.text) {
        try { await write('update', { id: t.id, text }); } catch (err) { showError(friendly(err)); }
      }
      editing = null;
      drawList();
      const back = page && page.list.querySelector(`[data-focus-key="edit:${CSS.escape(t.id)}"]`);
      if (back) back.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
    return input;
  }
  function startEdit(id) {
    if (editing === id) return;
    editing = id;
    drawList();
  }
  async function remove(t) {
    try { await write('remove', { id: t.id }); } catch (err) { showError(friendly(err)); return; }
    drawList();
    showUndo(t);
    if (page) page.input.focus();
  }
  function showUndo(t) {
    if (!visible()) return;
    const { toast } = page;
    clearTimeout(undo && undo.timer);
    toast.textContent = '';
    const label = el('span', 'todo-undo-text');
    label.append('已删除「', el('b', null, t.text.length > 24 ? t.text.slice(0, 24) + '…' : t.text), '」');
    const back = el('button', 'todo-undo-btn', '撤销');
    back.type = 'button';
    back.addEventListener('click', async () => {
      clearTimeout(undo && undo.timer);
      toast.hidden = true;
      try { await write('update', { id: t.id, deleted: false }); } catch (err) { showError(friendly(err)); }
      drawList();
    });
    toast.append(label, back);
    toast.hidden = false;
    undo = { timer: setTimeout(() => { toast.hidden = true; }, 6000) };
  }

  // ---- quick capture (⌘⇧N / Ctrl+Shift+N, changeable in 设置) ----
  // A modal in the middle of the window: the input takes the cursor, Enter saves
  // and stays open for the next line (the new row lands on top of the list
  // underneath), and Esc, × or a click outside closes it.
  function buildQuick() {
    const dlg = el('dialog', 'todo-quick');
    dlg.id = 'todoQuick';
    dlg.setAttribute('aria-labelledby', 'todoQuickTitle');
    const panel = el('div', 'todo-quick-panel');
    const head = el('div', 'todo-quick-head');
    const title = el('h2', 'todo-quick-title', '速记待办');
    title.id = 'todoQuickTitle';
    const hint = el('span', 'todo-quick-hint');
    hint.append(el('kbd', null, '↵'), ' 记下', el('kbd', null, 'Esc'), ' 关闭');
    const close = iconButton('close', '关闭（Esc）', () => closeQuick(true), 'todo-quick-close');
    close.setAttribute('aria-label', '关闭速记');
    head.append(title, hint, close);
    const form = el('form', 'todo-quick-form');
    form.setAttribute('aria-label', '速记一条待办');
    const ring = el('span', 'todo-add-ring');
    ring.setAttribute('aria-hidden', 'true');
    const input = el('input', 'todo-quick-input');
    input.type = 'text'; input.maxLength = TEXT_MAX; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = '记一件事，回车存下';
    input.setAttribute('aria-label', '速记一条待办');
    const add = iconButton('plus', '记下这条待办（回车）', () => form.requestSubmit(), 'todo-quick-add');
    add.type = 'submit';
    add.disabled = true;
    form.append(ring, input, add);
    const status = el('p', 'todo-quick-status');
    status.setAttribute('role', 'status');
    const list = el('div', 'todo-quick-list');
    panel.append(head, form, status, list);
    dlg.appendChild(panel);
    document.body.appendChild(dlg);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); });
    input.addEventListener('input', () => { status.textContent = ''; add.disabled = !input.value.trim(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim() || dlg.classList.contains('is-saving')) return;
      dlg.classList.add('is-saving');
      add.disabled = true;
      try {
        const item = await write('add', { text: input.value });
        input.value = '';
        status.textContent = '';
        quick.fresh = item ? { id: item.id, at: Date.now() } : null;
        redraw();
        drawQuick();
      } catch (err) { status.textContent = friendly(err); add.disabled = false; }
      finally { dlg.classList.remove('is-saving'); input.focus(); }
    });
    // Esc (the dialog's own cancel) throws the draft away, like ×.
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeQuick(true); });
    // The panel fills the dialog box, so a click that lands on the dialog itself is on the dimmed outside.
    // It only puts the box away: the words wait for the next shortcut. Closing on the click (pressed and
    // released outside) keeps that click from reaching whatever sits underneath, and a text selection
    // dragged out of the input does not count.
    let downOutside = false;
    dlg.addEventListener('pointerdown', (e) => { downOutside = e.target === dlg; if (downOutside) e.preventDefault(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && downOutside) closeQuick(false); downOutside = false; });
    quick = { dlg, input, add, status, list, fresh: null };
  }
  function quickOpen() { return !!(quick && quick.dlg.open); }
  function drawQuick() {
    if (!quickOpen()) return;
    const { list } = quick;
    const keep = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    list.textContent = '';
    if (!loaded) { list.appendChild(el('p', 'todo-quick-empty', '正在读取…')); return; }
    const open = items.filter((t) => !t.done), done = items.filter((t) => t.done);
    if (!open.length && !done.length) { list.appendChild(el('p', 'todo-quick-empty', '还没有待办，记下第一条吧。')); return; }
    for (const [name, group] of [['未完成', open], ['已完成', done]]) {
      if (!group.length) continue;
      const head = el('div', 'todo-section');
      head.append(el('span', 'todo-section-label', name), el('span', 'todo-section-count', String(group.length)));
      const ul = el('ul', 'todo-list' + (name === '已完成' ? ' todo-list-done' : ''));
      ul.setAttribute('aria-label', name + '的待办');
      group.forEach((t) => ul.appendChild(quickRow(t)));
      list.append(head, ul);
    }
    if (keep) { const again = list.querySelector(`[data-focus-key="${CSS.escape(keep)}"]`); if (again) again.focus(); }
  }
  function quickRow(t) {
    const li = el('li', 'todo-row' + (t.done ? ' is-done' : ''));
    li.dataset.id = t.id;
    // The line just saved glows once; a redraw meanwhile (the change echoing back) picks the glow up where it was.
    const age = quick.fresh && quick.fresh.id === t.id ? Date.now() - quick.fresh.at : Infinity;
    if (age < FRESH_MS) { li.classList.add('is-new'); li.style.animationDelay = -age + 'ms'; }
    const check = el('button', 'todo-check');
    check.type = 'button';
    check.dataset.focusKey = 'check:' + t.id;
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(!!t.done));
    const name = t.done ? '标为未完成' : '勾掉（标为完成）';
    check.title = name; check.setAttribute('aria-label', `${name}：${t.text}`);
    check.innerHTML = svg('check');
    check.addEventListener('click', () => toggleDone(t, li));
    const main = el('div', 'todo-main');
    main.appendChild(el('span', 'todo-text', t.text));
    const when = el('time', 'todo-when', t.done ? '完成于 ' + ago(t.doneAt || t.updated) : ago(t.created));
    when.dateTime = t.done ? (t.doneAt || t.updated) : t.created;
    when.title = (t.done ? '完成于 ' + fullTime(t.doneAt || t.updated) + ' · ' : '') + '记于 ' + fullTime(t.created);
    li.append(check, main, when);
    return li;
  }
  function openQuick() {
    if (!quick) buildQuick();
    if (quickOpen()) { quick.input.focus(); return; }
    quickReturn = document.activeElement;
    quick.status.textContent = '';
    quick.add.disabled = !quick.input.value.trim();
    quick.dlg.showModal();
    drawQuick();
    quick.input.focus();
    if (!loaded) refresh();
  }
  // `discard` (Esc, ×) throws the draft away; a click outside keeps it for next time.
  function closeQuick(discard) {
    if (!quickOpen()) return;
    if (discard) quick.input.value = '';
    quick.dlg.close();
    quick.list.textContent = '';
    const back = quickReturn;
    quickReturn = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  }

  // ---- the shortcut and its row in 设置 ----
  const combo = () => window.TodoShortcutCore.normalize(host && host.config.todoShortcut);
  function applyShortcut() {
    const label = shortcutLabel();
    const help = document.getElementById('helpTodoKey');
    if (help) help.textContent = label;
    const nav = document.getElementById('todoBtn');
    if (nav) nav.title = window.Sidebar.todoTitle();
    if (page && page.list.isConnected) {
      const sub = page.list.closest('.page-todo') && page.list.closest('.page-todo').querySelector('.page-titles p');
      if (sub) sub.textContent = subtitle();
      page.list.querySelectorAll('.todo-empty kbd').forEach((k) => { k.textContent = label; });
    }
    const btn = document.getElementById('todoShortcutBtn');
    if (btn && !recording) btn.textContent = label;
    const reset = document.getElementById('todoShortcutReset');
    if (reset) reset.hidden = combo() === window.TodoShortcutCore.DEFAULT;
  }
  let recording = null;            // the window keydown listener while 设置 waits for new keys
  function shortcutNote(text, warn) {
    const note = document.getElementById('todoShortcutNote');
    if (!note) return;
    note.textContent = text || defaultNote();
    note.classList.toggle('is-warn', !!warn);
  }
  function defaultNote() {
    return isMac()
      ? '点一下，再按想用的组合键（带 ⌘）。按了没反应，多半是别的软件占了这个键（比如 Topit 占了 ⌘T），换一个就好。'
      : '点一下，再按想用的组合键（Ctrl 加 Shift 或 Alt，再加一个字母或数字）。';
  }
  function stopRecording() {
    if (!recording) return;
    window.removeEventListener('keydown', recording, true);
    recording = null;
    const btn = document.getElementById('todoShortcutBtn');
    btn.classList.remove('is-recording');
    btn.setAttribute('aria-pressed', 'false');
    applyShortcut();
  }
  function setShortcut(next) {
    host.config.todoShortcut = window.TodoShortcutCore.normalize(next);
    host.saveConfig();
    stopRecording();
    applyShortcut();
  }
  function startRecording() {
    const C = window.TodoShortcutCore;
    const btn = document.getElementById('todoShortcutBtn');
    if (recording) { stopRecording(); shortcutNote(); return; }
    btn.classList.add('is-recording');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '请按新的组合键…';
    shortcutNote(isMac() ? '按住 ⌘（可再加 ⇧ 或 ⌥），再按一个字母或数字；Esc 取消。' : '按住 Ctrl 加 Shift 或 Alt，再按一个字母或数字；Esc 取消。');
    // Window capture: ahead of AgentDeck's own ⌘ shortcuts, so ⌘N here never opens a new 对话.
    recording = (e) => {
      if (['Meta', 'Control', 'Shift', 'Alt', 'CapsLock'].includes(e.key)) return;
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) { stopRecording(); shortcutNote(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) { stopRecording(); shortcutNote(); return; }
      const next = C.fromEvent(e, isMac());
      const why = C.problem(next, isMac());
      if (why) { shortcutNote(why, true); return; }
      setShortcut(next);
      shortcutNote(`已改成 ${shortcutLabel()}，在 AgentDeck 里任何地方按它就能速记。`);
    };
    window.addEventListener('keydown', recording, true);
  }
  function initSettings() {
    const btn = document.getElementById('todoShortcutBtn');
    if (!btn) return;
    btn.addEventListener('click', startRecording);
    btn.addEventListener('blur', () => { if (recording) { stopRecording(); shortcutNote(); } });
    const reset = document.getElementById('todoShortcutReset');
    reset.innerHTML = svg('reset');
    const name = `恢复默认（${window.TodoShortcutCore.label(window.TodoShortcutCore.DEFAULT, isMac())}）`;
    reset.title = name; reset.setAttribute('aria-label', name);
    reset.addEventListener('click', () => { setShortcut(window.TodoShortcutCore.DEFAULT); shortcutNote(`已恢复成 ${shortcutLabel()}。`); btn.focus(); });
    document.getElementById('notificationSettings').addEventListener('close', () => { stopRecording(); shortcutNote(); });
    shortcutNote();
  }

  function init(h) {
    host = h;
    // Window capture: before a terminal, a composer or AgentDeck's own ⌘ keys
    // (⌘⇧N would otherwise also count as ⌘N, 新对话) see the keys.
    window.addEventListener('keydown', (e) => {
      if (recording || !window.TodoShortcutCore.matches(e, combo(), isMac())) return;
      e.preventDefault(); e.stopImmediatePropagation();
      // Another dialog is up: the keys are used up here, so they never count as anything else.
      if (!quickOpen() && document.querySelector('dialog[open]')) return;
      openQuick();
    }, true);
    window.deck.onTodosChanged(() => refresh());
    window.addEventListener('focus', () => { if (visible() || quickOpen()) refresh(); });
    initSettings();
    applyShortcut();
    refresh();
  }

  window.TodoUI = { init, render, refresh, openQuick, closeQuick, shortcutLabel: () => shortcutLabel(), count: openCount };
})();
