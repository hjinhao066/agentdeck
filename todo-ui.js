// 随手记待办 on the desktop: the 待办 page (one of the pages that cover the
// deck, opened from the sidebar) and the quick-capture bar (⌘T on a Mac,
// Ctrl+Shift+T on Windows) that records one line without leaving the terminal.
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
  let quick = null;               // quick-capture bar elements
  let quickReturn = null;         // element to give focus back to

  const TEXT_MAX = 500;
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(name) { return host.ICONS[name] || ''; }
  function iconButton(name, label, onClick, cls) {
    const b = el('button', 'todo-ibtn' + (cls ? ' ' + cls : ''));
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = svg(name);
    b.addEventListener('click', onClick);
    return b;
  }
  // The sidebar asks for the shortcut's name before init, so fall back to the browser's own answer.
  const isMac = () => (host ? host.platform === 'darwin' : /^Mac/.test(navigator.platform));
  const shortcutLabel = () => isMac() ? '⌘T' : 'Ctrl+Shift+T';
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
    const body = frame('待办', `脑子里冒出来的事，先记在这里。在 AgentDeck 里任何地方按 ${shortcutLabel()} 都能速记一条；手机总台也能记、能勾。`);
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
  async function toggleDone(t, li) {
    if (li.classList.contains('is-leaving')) return;
    const done = !t.done;
    li.classList.toggle('is-done', done);
    li.classList.add('is-leaving');
    li.querySelector('.todo-check').setAttribute('aria-checked', String(done));
    try {
      await write('update', { id: t.id, done });
      // Let the tick show before the row moves to the other list.
      setTimeout(() => { if (!editing) drawList(); else pendingRender = true; }, 380);
    } catch (err) { li.classList.remove('is-leaving'); li.classList.toggle('is-done', t.done); showError(friendly(err)); }
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

  // ---- quick capture (⌘T / Ctrl+Shift+T) ----
  function buildQuick() {
    const wrap = el('div', 'todo-quick');
    wrap.id = 'todoQuick';
    wrap.hidden = true;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', '速记一条待办');
    const form = el('form', 'todo-quick-form');
    const ico = el('span', 'todo-quick-ico');
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = svg('todo');
    const input = el('input', 'todo-quick-input');
    input.type = 'text'; input.maxLength = TEXT_MAX; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = '速记一条待办，回车存下';
    input.setAttribute('aria-label', '速记一条待办');
    const hint = el('span', 'todo-quick-hint');
    hint.append(el('kbd', null, '↵'), ' 存下  ', el('kbd', null, 'Esc'), ' 取消');
    const status = el('p', 'todo-quick-status');
    status.setAttribute('role', 'status');
    form.append(ico, input, hint);
    wrap.append(form, status);
    document.body.appendChild(wrap);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && composing(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = ''; closeQuick(); }
    });
    input.addEventListener('input', () => { status.textContent = ''; wrap.classList.remove('is-error'); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim() || wrap.classList.contains('is-saving')) return;
      wrap.classList.add('is-saving');
      try {
        await write('add', { text: input.value });
        input.value = '';
        wrap.classList.add('is-saved');
        status.textContent = '已记下';
        redraw();
        setTimeout(closeQuick, 650);
      } catch (err) { wrap.classList.add('is-error'); status.textContent = friendly(err); }
      finally { wrap.classList.remove('is-saving'); }
    });
    // Clicking anywhere else only puts the bar away: the draft waits for the next shortcut. Esc throws it away.
    document.addEventListener('pointerdown', (e) => { if (!wrap.hidden && !wrap.contains(e.target)) closeQuick(true); }, true);
    quick = { wrap, input, status };
  }
  function openQuick() {
    // The page is open: its own input is the quickest place.
    if (visible()) { page.input.focus(); page.input.select(); return; }
    if (!quick) buildQuick();
    if (!quick.wrap.hidden) { quick.input.focus(); return; }
    quickReturn = document.activeElement;
    quick.wrap.classList.remove('is-saved', 'is-error');
    quick.status.textContent = '';
    quick.wrap.hidden = false;
    quick.input.focus();
  }
  function closeQuick(byPointer) {
    if (!quick || quick.wrap.hidden) return;
    quick.wrap.hidden = true;
    quick.wrap.classList.remove('is-saved');
    const back = quickReturn;
    quickReturn = null;
    if (!byPointer && back && back.isConnected && typeof back.focus === 'function') back.focus();
  }
  function isShortcut(e) {
    if (e.type !== 'keydown' || e.altKey || e.repeat) return false;
    if (!(e.key === 't' || e.key === 'T' || e.code === 'KeyT')) return false;
    return isMac() ? (e.metaKey && !e.ctrlKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey && !e.metaKey);
  }

  function init(h) {
    host = h;
    // Capture phase, before a terminal or composer sees the keys.
    document.addEventListener('keydown', (e) => {
      if (!isShortcut(e) || document.querySelector('dialog[open]')) return;
      e.preventDefault(); e.stopPropagation();
      openQuick();
    }, true);
    window.deck.onTodosChanged(() => refresh());
    window.addEventListener('focus', () => { if (visible()) refresh(); });
    refresh();
  }

  window.TodoUI = { init, render, refresh, openQuick, closeQuick, shortcutLabel: () => shortcutLabel(), count: openCount };
})();
