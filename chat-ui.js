// Chat view for each column, Cursor style: your prompt in a box that stays
// pinned while you read its answer, the agent's final reply rendered below, a
// composer that types into the column's real terminal, and under it the
// agent's own status lines (context, session, cost, resets…) read live from
// that terminal. The terminal itself is never replaced: it stays alive (and
// hidden) under the chat, which is what keeps status dots, notifications and
// the Board working.
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
  function svgButton(cls, iconName, title) {
    const b = el('button', cls);
    b.type = 'button'; b.title = title; b.innerHTML = host.ICONS[iconName] || '';
    return b;
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
  function agentName(col) {
    const t = window.BoardCore.inferAgentType(col.cmd);
    return t === 'Custom agent' ? (String(col.cmd || '').trim().split(/\s+/)[0] || 'Agent') : t === 'Shell' ? '终端' : t;
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
    const box = el('div', 'composer-box');
    const ta = el('textarea');
    ta.rows = 1; ta.spellcheck = false;
    ta.placeholder = col.isMain ? '告诉队长要做什么，一次说几件也行…' : '发消息给 ' + agentName(col) + '…  Enter 发送，Shift+Enter 换行';
    const bar = el('div', 'composer-bar');
    const attach = svgButton('cp-icon attach', 'plus', '添加文件（会插入路径）');
    const agent = el('span', 'cp-agent');
    const agentDot = el('i', 'cp-agent-dot');
    agent.append(agentDot, el('span', null, agentName(col)));
    agent.title = col.cmd ? '这个对话里运行的是：' + col.cmd : '普通终端';
    const spacer = el('span', 'cp-spacer');
    const stop = svgButton('cp-btn stop', 'stop', '中断（发送 Esc）');
    stop.hidden = true;
    const send = svgButton('cp-btn send', 'arrowUp', '发送 (Enter)');
    send.type = 'submit';
    bar.append(attach, spacer, agent, stop, send);
    // attachments sit above the text; deleting the text never removes them
    const attBox = el('div', 'cp-atts');
    attBox.hidden = true;
    box.append(attBox, ta, bar);
    form.appendChild(box);
    // the agent's own status lines, read from the hidden terminal
    const footer = el('div', 'tui-footer');
    footer.hidden = true;
    chat.append(scroll, attn, form, footer);
    wrap.insertBefore(chat, termEl);

    const toggle = el('button', 'view-toggle');
    toggle.type = 'button';
    head.insertBefore(toggle, head.querySelector('.secondary'));

    const v = { id: col.id, wrap, chat, scroll, attn, ta, stop, send, toggle, footer, agentDot, attBox, atts: [], footerKey: '', rows: new Map(), hist: -1, live: null };
    views.set(col.id, v);
    applyMode(col);

    toggle.addEventListener('click', () => setMode(col.id, modeOf(col) === 'chat' ? 'term' : 'chat'));
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(col); });
    stop.addEventListener('click', () => window.deck.ptyInput(col.id, '\x1b'));
    attach.addEventListener('click', () => {
      window.deck.pickFiles().then((paths) => {
        (paths || []).forEach((p) => addAttachment(v, p));
        ta.focus();
      }).catch(() => {});
    });
    box.addEventListener('mousedown', (e) => { if (e.target === box || e.target === bar || e.target === spacer) { e.preventDefault(); ta.focus(); } });
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(col); return; }
      if (e.key === 'ArrowUp' && !ta.value && !e.isComposing) { recallHistory(v, col.id, 1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' && v.hist >= 0 && !e.isComposing) { recallHistory(v, col.id, -1); e.preventDefault(); }
    });
    // Pasted screenshots and dropped files become attachments (sent as paths).
    ta.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      if (!items.some((it) => it.kind === 'file' && /^image\//.test(it.type))) return;
      e.preventDefault();
      window.deck.pasteImageSave().then((p) => { if (p) addAttachment(v, p); }).catch(() => {});
    });
    chat.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    chat.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files || []).map((f) => window.deck.getPathForFile(f)).filter(Boolean);
      paths.forEach((p) => addAttachment(v, p));
      if (paths.length) ta.focus();
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
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }
  function insertAtCaret(ta, text) {
    const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    autosize(ta);
  }
  // ---- attachments ----
  const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const isImage = (p) => C.fileKind(baseName(p)) === 'image';
  // Images get a real thumbnail (read through the same capped preview path).
  // Chats re-render often (view switches, restores); keep the last few images
  // instead of reading and base64-encoding the file again each time.
  const thumbs = new Map();   // path -> data URL, most recent last
  function loadThumb(img, path, colId) {
    const missing = () => img.closest('.att-thumb')?.classList.add('missing');
    if (thumbs.has(path)) {
      const url = thumbs.get(path);
      thumbs.delete(path); thumbs.set(path, url);
      img.src = url;
      return;
    }
    window.deck.previewRead(path, colId).then((r) => {
      if (!(r && r.ok && r.kind === 'image' && r.dataUrl)) { missing(); return; }
      thumbs.set(path, r.dataUrl);
      if (thumbs.size > 24) thumbs.delete(thumbs.keys().next().value);
      img.src = r.dataUrl;
    }).catch(missing);
  }
  function attachmentChip(path, colId, onRemove) {
    const chip = el('div', isImage(path) ? 'att att-thumb' : 'att att-file');
    chip.title = path;
    if (isImage(path)) {
      const img = el('img');
      img.alt = baseName(path);
      loadThumb(img, path, colId);
      chip.appendChild(img);
    } else {
      const ico = el('span', 'ico');
      ico.innerHTML = host.ICONS.file;
      chip.append(ico, el('span', 'att-name', baseName(path)));
    }
    chip.addEventListener('click', (e) => { if (!e.target.closest('.att-x')) window.SidePane.openPreview(path, colId); });
    if (onRemove) {
      const x = el('button', 'att-x', '✕');
      x.type = 'button'; x.title = '移除';
      x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
      chip.appendChild(x);
    }
    return chip;
  }
  function renderAttachments(v) {
    v.attBox.textContent = '';
    v.attBox.hidden = !v.atts.length;
    v.atts.forEach((p, i) => v.attBox.appendChild(attachmentChip(p, v.id, () => {
      v.atts.splice(i, 1);
      renderAttachments(v);
      v.ta.focus();
    })));
  }
  function addAttachment(v, path) {
    if (!path || v.atts.includes(path) || v.atts.length >= 20) return;
    v.atts.push(path);
    renderAttachments(v);
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
  // Markdown is rendered (escaped) first; file paths and URLs in its text then
  // become links that preview in the right pane.
  function linkifyTree(root, colId) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      if (!host.findLinks(text).length) return;
      const frag = document.createDocumentFragment();
      linkify(frag, text, colId);
      node.replaceWith(frag);
    });
    root.querySelectorAll('a[data-ext]').forEach((a) => {
      a.classList.add('chat-link');
      a.addEventListener('click', (e) => { e.preventDefault(); window.SidePane.openLink({ kind: 'url', text: a.getAttribute('href') }, e, colId); });
    });
  }
  function renderReply(v, turn) {
    const box = el('div', 'reply');
    if (!turn.done) {
      box.classList.add('pending');
      box.append(el('span', 'typing'), (v.live = el('span', 'live-line')));
    } else if (turn.reply) {
      box.classList.add('md');
      box.innerHTML = C.renderMarkdown(turn.reply, { breaks: true });
      linkifyTree(box, v.id);
    } else {
      box.classList.add('quiet');
      box.textContent = '这一轮没有文字回复，过程在终端里。';
    }
    return box;
  }
  function turnRows(v, turn) {
    if (turn.kind === 'task') {
      const wrap = el('div', 'turn task-turn');
      wrap.dataset.turn = turn.id;
      wrap.appendChild(window.MainSession.renderCard({ id: turn.id, ...turn.task }, v.id));
      v.rows.set(turn.id, { user: wrap, asst: wrap, turn });
      return wrap;
    }
    const wrap = el('div', 'turn');
    const user = el('div', 'msg user');
    user.dataset.turn = turn.id;
    const bubble = el('div', 'bubble');
    if (turn.atts && turn.atts.length) {
      const atts = el('div', 'bubble-atts');
      turn.atts.forEach((p) => atts.appendChild(attachmentChip(p, v.id, null)));
      user.appendChild(atts);
    }
    bubble.textContent = turn.user;
    bubble.hidden = !turn.user;
    // 队长's automatic receipt deliveries have no prompt of yours to show
    user.hidden = !turn.user && !(turn.atts && turn.atts.length);
    // your own message: copy it, or put it (and its attachments) back to edit
    const mine = el('div', 'msg-tools user-tools');
    const copyMine = svgButton('msg-tool', 'copy', '复制这条消息');
    copyMine.addEventListener('click', () => {
      window.deck.clipboardWrite(turn.user || '');
      copyMine.innerHTML = host.ICONS.check;
      setTimeout(() => { copyMine.innerHTML = host.ICONS.copy; }, 1200);
    });
    const editMine = svgButton('msg-tool', 'edit', '编辑：放回输入框，改完再发');
    editMine.addEventListener('click', () => {
      v.ta.value = turn.user || '';
      (turn.atts || []).forEach((p) => addAttachment(v, p));
      autosize(v.ta);
      v.ta.focus();
      v.ta.setSelectionRange(v.ta.value.length, v.ta.value.length);
    });
    mine.append(copyMine, editMine);
    user.appendChild(mine);
    bubble.title = '点击展开 / 收起';
    // long prompts are clipped; a click (not a text selection) expands them
    bubble.addEventListener('click', () => { if (!String(window.getSelection())) user.classList.toggle('expanded'); });
    user.appendChild(bubble);

    const asst = el('div', 'msg assistant');
    asst.dataset.turn = turn.id;
    const body = renderReply(v, turn);
    const tools = el('div', 'msg-tools');
    const copy = svgButton('msg-tool', 'copy', '复制回复');
    copy.addEventListener('click', () => {
      window.deck.clipboardWrite(turn.reply || '');
      copy.innerHTML = host.ICONS.check;
      setTimeout(() => { copy.innerHTML = host.ICONS.copy; }, 1200);
    });
    tools.append(copy, el('span', 'msg-time', fmtTime(turn.ts)));
    asst.append(body, tools);
    wrap.append(user, asst);
    v.rows.set(turn.id, { user, asst, turn });
    return wrap;
  }
  const nearBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight < 90;

  function emptyState(v, col) {
    const empty = el('div', 'chat-empty');
    if (col.isMain) {
      empty.append(el('strong', null, '队长在这里'),
        el('span', null, '说要做什么，队长会把活派给各个对话：新事新开一列，补充发回原来那一列。做完的回执会以卡片出现在这里，点标题跳过去。'));
      v.scroll.appendChild(empty);
      return;
    }
    empty.append(el('strong', null, '要做点什么？'),
      el('span', null, '在下面发消息给 ' + agentName(col) + '。最终回复会出现在这里，过程在右侧栏的「终端」里。'));
    v.scroll.appendChild(empty);
  }
  function renderChat(id) {
    const v = views.get(id);
    if (!v) return;
    v.scroll.textContent = '';
    v.rows.clear();
    v.live = null;
    const turns = chatFor(id).turns;
    if (!turns.length) { emptyState(v, columnById(id) || {}); return; }
    turns.forEach((t) => v.scroll.appendChild(turnRows(v, t)));
    requestAnimationFrame(() => { v.scroll.scrollTop = v.scroll.scrollHeight; });
  }
  function appendTurn(id, turn) {
    const v = views.get(id);
    if (!v) return;
    v.scroll.querySelector('.chat-empty')?.remove();
    v.scroll.appendChild(turnRows(v, turn));
    v.scroll.scrollTop = v.scroll.scrollHeight;
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

  // ---- the agent's status lines under the composer ----
  // Claude Code (and similar TUIs) draw their input box between two rules and
  // print model, context, cost and limits below it. Those rows are read from
  // the live terminal with their colors, so they look like they do there.
  const ANSI = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
  function paletteColor(n) {
    if (n < 16) return ANSI[n];
    if (n < 232) {
      const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
      return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
    }
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  function cellColor(cell) {
    if (cell.isFgDefault()) return '';
    const c = cell.getFgColor();
    if (cell.isFgRGB()) return '#' + c.toString(16).padStart(6, '0');
    if (cell.isFgPalette()) return paletteColor(c);
    return '';
  }
  const RULE = /^[╰└╭┌]?[─━]{6,}[╯┘╮┐]?$/;
  function readFooter(term) {
    const buf = term.buffer.active;
    const top = buf.baseY;
    const rows = [];
    for (let r = 0; r < term.rows; r++) rows.push(buf.getLine(top + r));
    const text = rows.map((ln) => (ln ? ln.translateToString(true) : ''));
    let end = text.length - 1;
    while (end >= 0 && !text[end].trim()) end--;
    let rule = -1;
    for (let r = end; r >= Math.max(0, end - 10); r--) {
      if (RULE.test(text[r].trim())) { rule = r; break; }
    }
    if (rule < 0 || rule === end) return null;
    const out = [];
    let cell;
    for (let r = rule + 1; r <= end && out.length < 8; r++) {
      const ln = rows[r];
      if (!ln) continue;
      // a soft-wrapped row continues the previous one; the footer shows it on one line
      const segs = ln.isWrapped && out.length ? out.pop() : [];
      for (let x = 0; x < ln.length; x++) {
        cell = ln.getCell(x, cell);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        const color = cellColor(cell);
        const bold = !!cell.isBold(), dim = !!cell.isDim();
        const last = segs[segs.length - 1];
        if (last && last.color === color && last.bold === bold && last.dim === dim) last.text += ch;
        else segs.push({ text: ch, color, bold, dim });
      }
      out.push(segs);
    }
    // trim only once rows are complete: a wrapped row's last cell may be a real space
    out.forEach((segs) => {
      while (segs.length && !segs[segs.length - 1].text.trim()) segs.pop();
      if (segs.length) segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
    });
    return out.some((segs) => segs.length) ? out : null;
  }
  function renderFooter(v, entry) {
    let lines = null;
    try { lines = readFooter(entry.term); } catch (_) { lines = null; }
    const key = lines ? JSON.stringify(lines) : '';
    if (key === v.footerKey) return;
    v.footerKey = key;
    v.footer.textContent = '';
    v.footer.hidden = !lines;
    if (!lines) return;
    lines.forEach((segs) => {
      const row = el('div', 'tf-row');
      segs.forEach((s) => {
        const span = el('span', null, s.text);
        if (s.color) span.style.color = s.color;
        if (s.bold) span.style.fontWeight = '700';
        if (s.dim) span.style.opacity = '0.6';
        row.appendChild(span);
      });
      v.footer.appendChild(row);
    });
  }

  // ---- turns ----
  function recording(col) { return loaded && modeOf(col) === 'chat' && views.has(col.id); }

  function beginTurn(col, text, atts, sent, force) {
    if (!(force ? loaded && views.has(col.id) : recording(col))) return null;
    const entry = host.terms.get(col.id);
    if (!entry) return null;
    if (pending.has(col.id)) finalizeTurn(col.id);
    const turn = C.addTurn(chatFor(col.id), {
      id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      ts: Date.now(), user: String(text).slice(0, 20000), reply: '', done: false, atts: atts || [],
    });
    let marker = null;
    try { marker = entry.term.registerMarker(0); } catch (_) {}
    pending.set(col.id, { turn, marker, startedAt: Date.now(), sent: sent || turn.user });
    appendTurn(col.id, turn);
    scheduleSave(col.id);
    if (window.Sidebar) window.Sidebar.touchTime(col.id);
    return turn;
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
      try { open.turn.reply = C.extractReply(readLines(entry.term, open.marker), open.sent, entry.term.cols); } catch (_) { open.turn.reply = ''; }
    }
    try { if (open.marker) open.marker.dispose(); } catch (_) {}
    open.turn.done = true;
    refreshTurn(id, open.turn);
    scheduleSave(id);
    if (window.MainSession) window.MainSession.onTurnDone(id, open.turn);
    if (nav && nav.input.value.trim()) runSearch();
    if (window.Pages) window.Pages.refresh();
  }

  // Called from the 1.5s status loop with the column's screen text.
  function onTick(id, entry, text) {
    const v = views.get(id);
    if (!v || !isChatMode(id)) return;
    v.stop.hidden = entry.state !== 'working';
    v.agentDot.className = 'cp-agent-dot ' + (entry.alive ? entry.state || 'plain' : 'exited');
    renderFooter(v, entry);
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
    if (!text.trim() && !v.atts.length) return;
    const prefix = window.MainSession ? window.MainSession.outgoingPrefix(col) : '';
    const atts = v.atts.slice();
    // a long prompt resolves once its file is written; keep the text until then
    Promise.resolve(sendPrompt(col, text, atts, { prefix })).then((sent) => {
      if (!sent || v.ta.value.replace(/\s+$/, '') !== text) return;
      v.ta.value = ''; v.hist = -1; autosize(v.ta);
      v.atts = v.atts.filter((p) => !atts.includes(p)); renderAttachments(v);
    });
  }
  // Type a prompt into the column's terminal as if sent from the composer.
  // Attachments go first, as paths the agent can open. Used by the composer,
  // Schedule and 队长. opts: prefix/suffix go to the terminal but
  // not into the bubble; silent sends no bubble at all; force records a turn
  // even in terminal view (so a receipt can be read back).
  // Returns the recorded turn, true when sent without one, or false.
  // No length limit: a prompt longer than this is saved as a .txt file and the
  // agent gets its opening plus "read this file first".
  const LONG_PROMPT = 8000;
  function sendPrompt(col, prompt, atts, opts) {
    const o = opts || {};
    const entry = host.terms.get(col.id);
    if (!entry || !entry.alive) { host.showToast(entry ? '这个终端已经退出了' : '终端还在启动，稍等一下'); return false; }
    if (prompt && prompt.length > LONG_PROMPT) return sendLong(col, prompt, atts, o);
    const paths = (atts || []).map(host.shellQuote).join(' ');
    const body = paths ? paths + (prompt ? ' ' + prompt : '') : prompt;
    const text = (o.prefix || '') + body + (o.suffix || '');
    // display/displayAtts: what the bubble shows when it differs from what is typed
    const turn = o.silent ? null : beginTurn(col, o.display != null ? o.display : prompt, o.displayAtts || atts, text, o.force);
    // bracketed paste keeps multi-line text one prompt; the CR goes separately so
    // Ink-based TUIs submit instead of inserting a newline
    const bracketed = entry.term.modes && entry.term.modes.bracketedPasteMode;
    window.deck.ptyInput(col.id, bracketed ? '\x1b[200~' + text + '\x1b[201~' : text.replace(/\r?\n/g, '\r'));
    setTimeout(() => { if (host.terms.has(col.id)) window.deck.ptyInput(col.id, '\r'); }, 60);
    entry.hasWorked = true;
    entry.lastOutputAt = Date.now();
    entry.notificationState = { state: 'working', notified: null, since: null };
    window.deck.notifyCancel({ id: col.id });
    const nameFrom = o.display || prompt;
    if (nameFrom && !o.silent) host.maybeAutoName(col, nameFrom.split('\n')[0].trim());
    return turn || true;
  }

  // Resolves to the turn (or true) once the file is written and the pointer sent.
  function sendLong(col, prompt, atts, o) {
    return window.deck.saveLongPrompt(prompt).then((file) => {
      if (!file) { host.showToast('长消息存文件失败，没有发送'); return false; }
      const opening = prompt.slice(0, 300).replace(/\s+/g, ' ').trim();
      const pointer = `${opening}…\n（这条消息共 ${prompt.length} 字，完整内容已存成文件，请先完整读取再照做：${file}）`;
      // the bubble keeps the opening and the file; the full text is in the file
      const shown = prompt.slice(0, 2000) + `\n…（全文 ${prompt.length} 字，见附件）`;
      return sendPrompt(col, '', atts, { ...o, prefix: (o.prefix || '') + pointer + ' ', display: shown, displayAtts: [...(atts || []), file] });
    }, () => { host.showToast('长消息存文件失败，没有发送'); return false; });
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
    if (!e.target.closest('.chat-scroll, .chat-attn, .composer, .tui-footer, .view-toggle')) focusInput(col.id);
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
  function forget(id) {
    const open = pending.get(id);
    try { if (open && open.marker) open.marker.dispose(); } catch (_) {}
    pending.delete(id);
    clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
    views.delete(id);
  }
  function onColumnRemoved(id) {
    forget(id);
    chats.delete(id);
    window.deck.chatDelete(id);
  }
  // Archiving keeps the conversation: close any open turn and save it now.
  function onColumnArchived(id) {
    finalizeTurn(id);
    forget(id);
    if (chats.has(id)) window.deck.chatSave(id, chatFor(id));
  }
  function deleteArchivedChat(id) {
    chats.delete(id);
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
  // ---- 队长 (main session) cards ----
  function cardTurn(task) {
    const r = task.receipt;
    return {
      kind: 'task', id: task.id, ts: task.sentAt || Date.now(), user: task.title, done: true, atts: [],
      reply: r ? [r.failed, r.summary, ...(r.files || [])].filter(Boolean).join('\n') : '',
      task: C.normalizeChat({ turns: [{ user: '', kind: 'task', task }] }, 'x').turns[0].task,
    };
  }
  function addCard(id, task) {
    const turn = C.addTurn(chatFor(id), cardTurn(task));
    appendTurn(id, turn);
    scheduleSave(id);
  }
  function updateCard(id, task) {
    const chat = chats.get(id);
    if (!chat) return;
    const at = chat.turns.findIndex((t) => t.id === task.id);
    if (at < 0) return;
    chat.turns[at] = cardTurn(task);
    const v = views.get(id);
    const row = v && v.rows.get(task.id);
    if (row) {
      const stick = nearBottom(v.scroll);
      const fresh = turnRows(v, chat.turns[at]);
      row.user.replaceWith(fresh);
      if (stick) v.scroll.scrollTop = v.scroll.scrollHeight;
    }
    scheduleSave(id);
    if (window.Pages) window.Pages.refresh();
  }
  function clearChat(id) {
    const open = pending.get(id);
    try { if (open && open.marker) open.marker.dispose(); } catch (_) {}
    pending.delete(id);
    chats.set(id, C.emptyChat(id));
    clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
    window.deck.chatSave(id, chatFor(id));
    renderChat(id);
  }
  const turnsOf = (id) => (chats.get(id) || { turns: [] }).turns;

  function lastTurnTs(id) {
    const turns = (chats.get(id) || { turns: [] }).turns;
    return turns.length ? turns[turns.length - 1].ts : 0;
  }
  function artifactSources() {
    return [
      ...host.columns().map((c) => ({ colId: c.id, title: host.columnLabel(c), turns: chatFor(c.id).turns })),
      ...host.archived().map((a) => ({ colId: a.id, title: host.columnLabel(a), archived: true, turns: (chats.get(a.id) || { turns: [] }).turns })),
    ];
  }

  // ---- search over prompts and final replies ----
  function initNav() {
    const wrap = el('label', 'nav-search');
    const ico = el('span', 'ico');
    ico.innerHTML = host.ICONS.search;
    const input = el('input');
    input.id = 'navSearch'; input.type = 'text'; input.placeholder = '搜索';
    input.autocomplete = 'off'; input.spellcheck = false;
    const hint = el('span', 'nav-row-hint', '⌘K');
    const clear = el('button', 'ns-clear', '✕');
    clear.type = 'button'; clear.hidden = true; clear.title = '清除 (Esc)';
    wrap.append(ico, input, hint, clear);
    (document.getElementById('navSearchSlot') || document.getElementById('navTop')).appendChild(wrap);

    const results = el('div', 'nav-results');
    results.id = 'navResults'; results.hidden = true;
    document.getElementById('navList').after(results);

    nav = { wrap, input, clear, hint, results, active: -1, timer: null };
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
    clear.addEventListener('click', (e) => { e.preventDefault(); closeSearch(); });
  }
  function focusSearch() {
    if (host.isNavCollapsed()) host.setNavCollapsed(false);
    nav.input.focus();
    nav.input.select();
  }
  function closeSearch() {
    nav.input.value = '';
    nav.clear.hidden = true;
    nav.hint.hidden = false;
    nav.results.hidden = true;
    document.getElementById('navList').hidden = false;
    nav.input.blur();
    const id = host.focusedId();
    if (id) focusInput(id);
  }
  function runSearch() {
    const q = nav.input.value.trim();
    nav.clear.hidden = !nav.input.value;
    nav.hint.hidden = !!nav.input.value;
    const list = document.getElementById('navList');
    nav.results.textContent = '';
    nav.active = -1;
    if (!q) { nav.results.hidden = true; list.hidden = false; return; }
    list.hidden = true; nav.results.hidden = false;
    const archivedIds = new Set(host.archived().map((a) => a.id));
    const hits = C.searchChats(artifactSources(), q);
    if (!hits.length) { nav.results.appendChild(el('div', 'nr-empty', '没有匹配的对话')); return; }
    hits.forEach((h) => {
      const item = el('button', 'nr-item');
      item.type = 'button';
      const head = el('div', 'nr-head');
      head.append(el('span', 'nr-title', h.title), el('span', 'nr-role', h.role === 'user' ? '我' : h.role === 'reply' ? '回复' : '标题'));
      if (archivedIds.has(h.colId)) head.appendChild(el('span', 'nr-role', '已归档'));
      const body = el('div', 'nr-snippet');
      const mark = el('mark', null, h.match);
      body.append(h.before, mark, h.after);
      item.append(head, body);
      item.addEventListener('click', () => reveal(h.colId, h.turnId, h.role));
      nav.results.appendChild(item);
    });
  }
  function reveal(colId, turnId, role) {
    if (!columnById(colId)) {
      // an archived conversation comes back first
      if (!host.archived().some((a) => a.id === colId) || !host.restoreArchived(colId, false)) return;
    }
    const col = columnById(colId);
    let tries = 0;
    const go = () => {
      if (!host.terms.has(colId) && tries++ < 40) { setTimeout(go, 50); return; }
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
    };
    go();
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
    if (window.Sidebar) window.Sidebar.render();
  }

  window.ChatUI = {
    init, mountColumn, isChatMode, focusInput, setMode, onSubmitted, noteSent, sendPrompt,
    onTick, onExit, onColumnMouseDown, onColumnRemoved, onColumnArchived, deleteArchivedChat, onColumnIdChanged, onRender,
    focusSearch, reveal, lastTurnTs, artifactSources,
    attach: (id, path) => { const v = views.get(id); if (v) addAttachment(v, path); },
    attachmentChip: (path, colId) => attachmentChip(path, colId, null),
    addCard, updateCard, clearChat, turnsOf,
  };
})();
