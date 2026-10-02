// Chat view for each column: your prompts and the agent's final reply as
// bubbles, a composer that types into the column's real terminal, saved
// history, and the left-hand search over all of it. The terminal itself is
// never replaced: it stays alive (and hidden) under the chat, which is what
// keeps status dots, notifications and the Board working.
(function () {
  'use strict';
  const C = window.ChatCore;
  let host = null;
  const chats = new Map();     // column id -> { turns }
  const views = new Map();     // column id -> dom handles
  const pending = new Map();   // column id -> { turn, marker, startedAt }
  const saveTimers = new Map();
  let loaded = false;
  let nav = null;              // left-hand search handles

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const columnById = (id) => host.columns().find((c) => c.id === id);
  function chatFor(id) {
    if (!chats.has(id)) chats.set(id, C.emptyChat(id));
    return chats.get(id);
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // ---- view mode ----
  // Agent columns open as chat; a bare shell stays a terminal until you flip it.
  function modeOf(col) {
    if (col.view === 'chat' || col.view === 'term') return col.view;
    return col.cmd || (col.role && col.role !== 'manual') ? 'chat' : 'term';
  }
  const isChatMode = (id) => { const col = columnById(id); return !!col && modeOf(col) === 'chat' && views.has(id); };

  function applyMode(col) {
    const v = views.get(col.id);
    if (!v) return;
    const chat = modeOf(col) === 'chat';
    v.wrap.classList.toggle('chat-mode', chat);
    v.toggle.textContent = chat ? '终端' : '对话';
    v.toggle.title = chat ? '切到原始终端' : '切到对话视图';
  }
  function setMode(id, mode) {
    const col = columnById(id);
    const v = views.get(id);
    if (!col || !v) return;
    if (mode === 'term' && window.SidePane.holdsTerminalOf(id)) window.SidePane.restoreTerminal();
    col.view = mode;
    applyMode(col);
    host.saveConfig();
    host.layout();
    if (mode === 'chat') { renderChat(id); focusInput(id); window.SidePane.syncTerminal(); }
    else { const t = host.terms.get(id); if (t) t.term.focus(); }
  }

  // ---- building a column's chat ----
  function mountColumn(col, wrap, head, termEl) {
    const chat = el('div', 'chat');
    const scroll = el('div', 'chat-scroll');
    const attn = el('div', 'chat-attn');
    attn.hidden = true;
    const form = el('form', 'composer');
    const ta = el('textarea');
    ta.rows = 1; ta.spellcheck = false; ta.placeholder = '输入消息，Enter 发送，Shift+Enter 换行';
    const stop = el('button', 'cp-btn stop', '■');
    stop.type = 'button'; stop.title = '中断（发送 Esc）'; stop.hidden = true;
    const send = el('button', 'cp-btn send', '↑');
    send.type = 'submit'; send.title = '发送 (Enter)';
    form.append(ta, stop, send);
    chat.append(scroll, attn, form);
    wrap.insertBefore(chat, termEl);

    const toggle = el('button', 'view-toggle');
    toggle.type = 'button';
    head.insertBefore(toggle, head.querySelector('.secondary'));

    const v = { id: col.id, wrap, chat, scroll, attn, ta, stop, send, toggle, rows: new Map(), hist: -1, live: null };
    views.set(col.id, v);
    applyMode(col);

    toggle.addEventListener('click', () => setMode(col.id, modeOf(col) === 'chat' ? 'term' : 'chat'));
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(col); });
    stop.addEventListener('click', () => window.deck.ptyInput(col.id, '\x1b'));
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(col); return; }
      if (e.key === 'ArrowUp' && !ta.value && !e.isComposing) { recallHistory(v, col.id, 1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' && v.hist >= 0 && !e.isComposing) { recallHistory(v, col.id, -1); e.preventDefault(); }
    });
    // Same conveniences the terminal has: pasted screenshots and dropped files become paths.
    ta.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      if (!items.some((it) => it.kind === 'file' && /^image\//.test(it.type))) return;
      e.preventDefault();
      window.deck.pasteImageSave().then((p) => { if (p) insertAtCaret(ta, host.shellQuote(p) + ' '); }).catch(() => {});
    });
    chat.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    chat.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files || []).map((f) => window.deck.getPathForFile(f)).filter(Boolean);
      if (paths.length) { insertAtCaret(ta, paths.map(host.shellQuote).join(' ') + ' '); ta.focus(); }
    });
    // Typing while a bubble is selected should still land in the composer.
    chat.addEventListener('keydown', (e) => {
      if (e.target === ta || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      ta.focus();
    });

    if (loaded) renderChat(col.id);
  }
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }
  function insertAtCaret(ta, text) {
    const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    autosize(ta);
  }
  function recallHistory(v, id, dir) {
    const asked = chatFor(id).turns.map((t) => t.user).reverse();
    if (!asked.length) return;
    v.hist = Math.max(-1, Math.min(asked.length - 1, v.hist + dir));
    v.ta.value = v.hist < 0 ? '' : asked[v.hist];
    autosize(v.ta);
  }

  // ---- rendering ----
  function linkify(parent, text, colId) {
    text.split('\n').forEach((line, i) => {
      if (i) parent.appendChild(document.createTextNode('\n'));
      let last = 0;
      for (const m of host.findLinks(line)) {
        if (m.start < last) continue;
        parent.append(line.slice(last, m.start));
        const a = el('a', 'chat-link', m.text);
        a.addEventListener('click', (e) => { e.preventDefault(); window.SidePane.openLink(m, e, colId); });
        parent.append(a);
        last = m.end;
      }
      parent.append(line.slice(last));
    });
  }
  function renderReply(v, turn) {
    const box = el('div', 'reply');
    if (!turn.done) {
      box.classList.add('pending');
      box.append(el('span', 'typing'), (v.live = el('span', 'live-line')));
    } else if (turn.reply) {
      linkify(box, turn.reply, v.id);
    } else {
      box.classList.add('quiet');
      box.textContent = '这一轮没有文字回复，过程在终端里。';
    }
    return box;
  }
  function turnRows(v, turn) {
    const user = el('div', 'msg user');
    user.dataset.turn = turn.id;
    const bubble = el('div', 'bubble');
    bubble.textContent = turn.user;
    const when = el('span', 'msg-time', fmtTime(turn.ts));
    user.append(when, bubble);

    const asst = el('div', 'msg assistant');
    asst.dataset.turn = turn.id;
    const body = renderReply(v, turn);
    const tools = el('div', 'msg-tools');
    const copy = el('button', 'msg-tool', '复制');
    copy.type = 'button';
    copy.addEventListener('click', () => { window.deck.clipboardWrite(turn.reply || ''); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1200); });
    tools.appendChild(copy);
    asst.append(body, tools);
    v.rows.set(turn.id, { user, asst, turn });
    return [user, asst];
  }
  const nearBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight < 90;

  function renderChat(id) {
    const v = views.get(id);
    if (!v) return;
    v.scroll.textContent = '';
    v.rows.clear();
    v.live = null;
    const turns = chatFor(id).turns;
    if (!turns.length) {
      const empty = el('div', 'chat-empty');
      empty.append(el('strong', null, '还没有对话'), el('span', null, '在下面输入内容，会发给这个终端里的 agent。它的最终回复会出现在这里，过程在右侧栏的终端里。'));
      v.scroll.appendChild(empty);
      return;
    }
    turns.forEach((t) => v.scroll.append(...turnRows(v, t)));
    requestAnimationFrame(() => { v.scroll.scrollTop = v.scroll.scrollHeight; });
  }
  function appendTurn(id, turn) {
    const v = views.get(id);
    if (!v) return;
    const stick = nearBottom(v.scroll) || v.rows.size === 0;
    v.scroll.querySelector('.chat-empty')?.remove();
    v.scroll.append(...turnRows(v, turn));
    if (stick) v.scroll.scrollTop = v.scroll.scrollHeight;
  }
  function refreshTurn(id, turn) {
    const v = views.get(id);
    const row = v && v.rows.get(turn.id);
    if (!row) return;
    const stick = nearBottom(v.scroll);
    const fresh = renderReply(v, turn);
    row.asst.replaceChild(fresh, row.asst.querySelector('.reply'));
    if (turn.done) v.live = null;
    if (stick) v.scroll.scrollTop = v.scroll.scrollHeight;
  }

  // ---- turns ----
  function recording(col) { return loaded && modeOf(col) === 'chat' && views.has(col.id); }

  function beginTurn(col, text) {
    if (!recording(col)) return;
    const entry = host.terms.get(col.id);
    if (!entry) return;
    if (pending.has(col.id)) finalizeTurn(col.id);
    const turn = C.addTurn(chatFor(col.id), {
      id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      ts: Date.now(), user: String(text).slice(0, 20000), reply: '', done: false,
    });
    let marker = null;
    try { marker = entry.term.registerMarker(0); } catch (_) {}
    pending.set(col.id, { turn, marker, startedAt: Date.now() });
    appendTurn(col.id, turn);
    scheduleSave(col.id);
  }

  // Rows of the terminal from where the turn started, soft-wrapped rows glued back.
  function readLines(term, marker) {
    const buf = term.buffer.active;
    let from;
    if (buf.type === 'normal' && marker && !marker.isDisposed && marker.line >= 0) from = marker.line;
    else from = Math.max(0, buf.length - term.rows * 3);
    from = Math.max(from, buf.length - 2500);
    const lines = [];
    for (let i = from; i < buf.length; i++) {
      const ln = buf.getLine(i);
      if (!ln) continue;
      const text = ln.translateToString(true);
      if (ln.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    return lines;
  }

  function finalizeTurn(id) {
    const open = pending.get(id);
    if (!open) return;
    pending.delete(id);
    const entry = host.terms.get(id);
    if (entry) {
      try { open.turn.reply = C.extractReply(readLines(entry.term, open.marker), open.turn.user, entry.term.cols); } catch (_) { open.turn.reply = ''; }
    }
    try { if (open.marker) open.marker.dispose(); } catch (_) {}
    open.turn.done = true;
    refreshTurn(id, open.turn);
    scheduleSave(id);
    if (nav && nav.input.value.trim()) runSearch();
  }

  // Called from the 1.5s status loop with the column's screen text.
  function onTick(id, entry, text) {
    const v = views.get(id);
    if (!v || !isChatMode(id)) return;
    v.stop.hidden = entry.state !== 'working';
    setAttention(v, id, entry.state === 'input' ? text : null);
    const open = pending.get(id);
    if (!open) return;
    if (v.live) v.live.textContent = entry.state === 'working' ? host.lastActivityLine(text) : '';
    if (!entry.alive) { finalizeTurn(id); return; }
    if (entry.state === 'working' || entry.state === 'input') return;
    const quiet = Date.now() - (entry.lastOutputAt || 0);
    const sawOutput = (entry.lastOutputAt || 0) - open.startedAt > 600;
    if ((entry.state === 'done' && quiet >= 2000 && sawOutput) || quiet >= 6000) finalizeTurn(id);
  }
  function onExit(id) { finalizeTurn(id); }

  // The agent is waiting on a menu or y/n: show what it asked and the usual answers.
  function setAttention(v, id, text) {
    if (text === null) {
      if (!v.attn.hidden) { v.attn.hidden = true; v.attn.textContent = ''; }
      return;
    }
    const shown = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-12).join('\n');
    if (v.attn.dataset.shown === shown && !v.attn.hidden) return;
    v.attn.dataset.shown = shown;
    v.attn.hidden = false;
    v.attn.textContent = '';
    v.attn.append(el('div', 'attn-title', '需要你回复'), el('pre', 'attn-screen', shown));
    const keys = el('div', 'attn-keys');
    [['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']].forEach(([label, key]) => {
      keys.appendChild(attnButton(label, () => { window.deck.ptyInput(id, key); setTimeout(() => window.deck.ptyInput(id, '\r'), 60); }));
    });
    keys.appendChild(attnButton('Enter', () => window.deck.ptyInput(id, '\r')));
    keys.appendChild(attnButton('Esc', () => window.deck.ptyInput(id, '\x1b')));
    keys.appendChild(attnButton('在终端里回复', () => { host.setFocused(id); window.SidePane.show('terminal', true); }));
    v.attn.appendChild(keys);
  }
  function attnButton(label, onClick) {
    const b = el('button', 'attn-key', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- sending ----
  function submit(col) {
    const v = views.get(col.id);
    const text = v.ta.value.replace(/\s+$/, '');
    if (!text.trim()) return;
    const entry = host.terms.get(col.id);
    if (!entry || !entry.alive) { host.showToast(entry ? '这个终端已经退出了' : '终端还在启动，稍等一下'); return; }
    v.ta.value = ''; v.hist = -1; autosize(v.ta);
    beginTurn(col, text);
    // bracketed paste keeps multi-line text one prompt; the CR goes separately so
    // Ink-based TUIs submit instead of inserting a newline
    const bracketed = entry.term.modes && entry.term.modes.bracketedPasteMode;
    window.deck.ptyInput(col.id, bracketed ? '\x1b[200~' + text + '\x1b[201~' : text.replace(/\r?\n/g, '\r'));
    setTimeout(() => { if (host.terms.has(col.id)) window.deck.ptyInput(col.id, '\r'); }, 60);
    entry.hasWorked = true;
    entry.lastOutputAt = Date.now();
    entry.notificationState = { state: 'working', notified: null, since: null };
    window.deck.notifyCancel({ id: col.id });
    host.maybeAutoName(col, text.split('\n')[0].trim());
  }

  // A line submitted straight in the terminal (typed, or via the side pane).
  function onSubmitted(col, line) {
    const entry = host.terms.get(col.id);
    if (!entry || entry.state === 'input' || C.isPromptAnswer(line)) return;
    beginTurn(col, line);
  }
  // Text sent on the column's behalf (broadcast, board messages).
  function noteSent(col, text) {
    if (!text || C.isPromptAnswer(text)) return;
    beginTurn(col, String(text).slice(0, 4000));
  }

  // ---- focus ----
  function focusInput(id) {
    if (!isChatMode(id)) return false;
    // callers scroll the deck themselves; focusing must not move it again
    views.get(id).ta.focus({ preventScroll: true });
    return true;
  }
  // Mouse down inside a chat column: keep text selectable, only focus the composer from empty space.
  function onColumnMouseDown(col, e) {
    if (!isChatMode(col.id)) return false;
    host.setFocused(col.id);
    if (!e.target.closest('.chat-scroll, .chat-attn, .composer, .view-toggle')) focusInput(col.id);
    return true;
  }

  // ---- storage ----
  function scheduleSave(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => { saveTimers.delete(id); window.deck.chatSave(id, chatFor(id)); }, 1500));
  }
  function flushSaves() {
    saveTimers.forEach((timer, id) => { clearTimeout(timer); window.deck.chatSave(id, chatFor(id)); });
    saveTimers.clear();
  }
  function onColumnRemoved(id) {
    const open = pending.get(id);
    try { if (open && open.marker) open.marker.dispose(); } catch (_) {}
    pending.delete(id);
    clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
    views.delete(id); chats.delete(id);
    window.deck.chatDelete(id);
  }
  function onColumnIdChanged(oldId, newId) {
    const chat = chats.get(oldId);
    pending.delete(oldId);
    views.delete(oldId);
    if (chat) {
      chat.id = newId;
      chats.delete(oldId); chats.set(newId, chat);
      window.deck.chatDelete(oldId);
      scheduleSave(newId);
    }
  }
  function onRender() {
    pending.clear();
    views.clear();
  }

  // ---- search over prompts and final replies ----
  function initNav() {
    const wrap = el('div', 'nav-search');
    const input = el('input');
    input.id = 'navSearch'; input.type = 'text'; input.placeholder = '搜索对话  ⌘K';
    input.autocomplete = 'off'; input.spellcheck = false;
    const clear = el('button', 'ns-clear', '✕');
    clear.type = 'button'; clear.hidden = true; clear.title = '清除 (Esc)';
    wrap.append(input, clear);
    document.getElementById('navTop').after(wrap);

    const results = el('div', 'nav-results');
    results.id = 'navResults'; results.hidden = true;
    document.getElementById('navList').after(results);

    const rail = el('button', 'rail-btn nav-search-rail');
    rail.type = 'button'; rail.title = '搜索对话 (Cmd+K)';
    rail.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    rail.addEventListener('click', () => focusSearch());
    document.getElementById('navTop').appendChild(rail);

    nav = { wrap, input, clear, results, active: -1, timer: null };
    input.addEventListener('input', () => { clearTimeout(nav.timer); nav.timer = setTimeout(runSearch, 120); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const items = [...results.querySelectorAll('.nr-item')];
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        nav.active = (nav.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((it, i) => it.classList.toggle('active', i === nav.active));
        items[nav.active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        (items[Math.max(0, nav.active)] || items[0])?.click();
      }
    });
    clear.addEventListener('click', () => closeSearch());
  }
  function focusSearch() {
    if (host.isNavCollapsed()) host.setNavCollapsed(false);
    nav.input.focus();
    nav.input.select();
  }
  function closeSearch() {
    nav.input.value = '';
    nav.clear.hidden = true;
    nav.results.hidden = true;
    document.getElementById('navList').hidden = false;
    document.getElementById('navCaption').hidden = false;
    nav.input.blur();
    const id = host.focusedId();
    if (id) focusInput(id);
  }
  function runSearch() {
    const q = nav.input.value.trim();
    nav.clear.hidden = !nav.input.value;
    const list = document.getElementById('navList');
    const caption = document.getElementById('navCaption');
    nav.results.textContent = '';
    nav.active = -1;
    if (!q) { nav.results.hidden = true; list.hidden = false; caption.hidden = false; return; }
    list.hidden = true; caption.hidden = true; nav.results.hidden = false;
    const source = host.columns().map((col) => ({ colId: col.id, title: host.columnLabel(col), turns: chatFor(col.id).turns }));
    const hits = C.searchChats(source, q);
    if (!hits.length) { nav.results.appendChild(el('div', 'nr-empty', '没有匹配的对话')); return; }
    hits.forEach((h) => {
      const item = el('button', 'nr-item');
      item.type = 'button';
      const head = el('div', 'nr-head');
      head.append(el('span', 'nr-title', h.title), el('span', 'nr-role', h.role === 'user' ? '我' : h.role === 'reply' ? '回复' : '标题'));
      const body = el('div', 'nr-snippet');
      const mark = el('mark', null, h.match);
      body.append(h.before, mark, h.after);
      item.append(head, body);
      item.addEventListener('click', () => reveal(h.colId, h.turnId, h.role));
      nav.results.appendChild(item);
    });
  }
  function reveal(colId, turnId, role) {
    const col = columnById(colId);
    if (!col) return;
    host.jumpToColumn(col);
    if (!turnId) return;
    if (modeOf(col) !== 'chat') setMode(colId, 'chat');
    requestAnimationFrame(() => {
      const v = views.get(colId);
      const row = v && v.rows.get(turnId);
      if (!row) return;
      const target = role === 'reply' ? row.asst : row.user;
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1800);
    });
  }

  // ---- keyboard ----
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === 'k' || e.key === 'K') { focusSearch(); }
      else if (e.key === '\\') { window.SidePane.toggle(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
  }

  // ---- startup ----
  async function init(h) {
    host = h;
    initNav();
    initKeys();
    window.addEventListener('pagehide', flushSaves);
    try {
      const saved = await window.deck.chatLoadAll();
      (saved || []).forEach((chat) => {
        chat.turns.forEach((t) => { t.done = true; });   // a turn open at shutdown will never get its reply
        chats.set(chat.id, chat);
      });
    } catch (_) {}
    loaded = true;
    views.forEach((v, id) => renderChat(id));
    if (nav.input.value.trim()) runSearch();
  }

  window.ChatUI = {
    init, mountColumn, isChatMode, focusInput, setMode, onSubmitted, noteSent,
    onTick, onExit, onColumnMouseDown, onColumnRemoved, onColumnIdChanged, onRender, focusSearch,
  };
})();
