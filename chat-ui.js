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
  const unsaved = new Set();   // saves asked for before the saved chats were loaded
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
    b.setAttribute('aria-label', title);
    return b;
  }
  // Copy buttons turn into a check for a moment once the text is on the clipboard.
  function copyButton(title, text, cls) {
    const b = svgButton(cls || 'msg-tool', 'copy', title);
    b.addEventListener('click', () => {
      host.clipboardWrite(typeof text === 'function' ? text() : text);
      flashCheck(b, 'copy');
    });
    return b;
  }
  function flashCheck(b, icon) {
    b.innerHTML = host.ICONS.check;
    b.classList.add('done');
    clearTimeout(b.checkTimer);
    b.checkTimer = setTimeout(() => { b.innerHTML = host.ICONS[icon]; b.classList.remove('done'); }, 1200);
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
  // The per-column mode overrides the current global choice.
  function modeOf(col) {
    return C.normalizeViewMode(col.view || host.config.globalViewMode);
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

  function toggleGlobalMode() {
    window.SidePane.restoreTerminal();
    C.toggleGlobalView(host.config, host.columns());
    host.columns().forEach((col) => {
      applyMode(col);
      if (modeOf(col) === 'chat' && views.has(col.id)) renderChat(col.id);
    });
    host.saveConfig();
    host.layout();
    const id = host.focusedId();
    if (id && !focusInput(id)) host.terms.get(id)?.term.focus();
    window.SidePane.syncTerminal();
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
    const agentLabel = el('span', null, agentName(col));
    agent.append(agentDot, agentLabel);
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
    const newContent = el('button', 'new-content chat-new-content', '有新内容 ↓');
    newContent.type = 'button';
    newContent.hidden = true;
    chat.append(scroll, newContent, attn, form, footer);
    wrap.insertBefore(chat, termEl);

    const toggle = el('button', 'view-toggle');
    toggle.type = 'button';
    head.insertBefore(toggle, head.querySelector('.secondary'));

    const v = { id: col.id, wrap, chat, scroll, newContent, following: true, attn, ta, stop, send, toggle, footer, agent, agentDot, agentLabel, attBox, atts: [], footerKey: '', rows: new Map(), hist: -1, live: null, shown: C.RENDER_STEP, showRetired: false, openProc: new Set(), allSteps: new Set(), openEdits: new Set() };
    scroll.addEventListener('scroll', () => {
      v.following = nearBottom(scroll);
      if (v.following) newContent.hidden = true;
    });
    newContent.addEventListener('click', () => {
      v.following = true;
      scroll.scrollTop = scroll.scrollHeight;
      newContent.hidden = true;
    });
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
      decorateCode(box);
    } else if (!turn.interrupted) {
      box.classList.add('quiet');
      box.textContent = '这一轮没有文字回复，过程在终端里。';
    }
    if (turn.done && turn.interrupted) {
      box.classList.add('interrupted');
      box.appendChild(el('div', 'reply-note', turn.reply
        ? '这一轮还没结束，终端就关掉了（退出 AgentDeck 或终端重启）。上面是关掉前已经看到的部分。'
        : '这一轮还没结束，终端就关掉了（退出 AgentDeck 或终端重启），没来得及收到回复。'));
    }
    return box;
  }
  // Code blocks get a bar with their language and a copy icon.
  function decorateCode(box) {
    box.querySelectorAll('pre.md-code').forEach((pre) => {
      const code = pre.querySelector('code');
      const block = el('div', 'code-block');
      const bar = el('div', 'code-bar');
      const lang = el('span', 'code-lang');
      lang.innerHTML = host.ICONS.terminal;
      lang.append((code && code.dataset.lang) || '文本');
      bar.append(lang, copyButton('复制代码', () => (code ? code.textContent : ''), 'icon-btn code-copy'));
      pre.replaceWith(block);
      block.append(bar, pre);
    });
  }

  // ---- the work before a reply: "处理了 18分43秒 ›", folded by default ----
  const PROC_TAIL = 8;
  function processRow(v, turn) {
    const open = pending.get(v.id);
    if (!turn.done) {
      const live = el('div', 'proc live');
      const label = el('span', 'proc-label');
      v.liveElapsed = label;
      label.textContent = '处理中 ' + C.fmtDuration(Date.now() - ((open && open.turn === turn && open.startedAt) || turn.ts));
      live.appendChild(label);
      return live;
    }
    const steps = turn.steps || [];
    const proc = el('div', 'proc');
    const toggle = el('button', 'proc-toggle');
    toggle.type = 'button';
    const label = turn.end && turn.ts ? '处理了 ' + C.fmtDuration(turn.end - turn.ts)
      : steps.length ? steps.length + ' 条过程消息' : '过程';
    const chev = el('span', 'ico proc-chev');
    chev.innerHTML = host.ICONS.chevRight;
    toggle.append(el('span', 'proc-label', label), chev);
    const body = el('div', 'proc-body');
    const expanded = v.openProc.has(turn.id);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = expanded ? '收起过程' : '展开过程（工具调用、命令）';
    proc.classList.toggle('open', expanded);
    body.hidden = !expanded;
    if (expanded) fillProcess(v, turn, body);
    toggle.addEventListener('click', () => {
      const now = !v.openProc.has(turn.id);
      if (now) v.openProc.add(turn.id); else v.openProc.delete(turn.id);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.title = now ? '收起过程' : '展开过程（工具调用、命令）';
      proc.classList.toggle('open', now);
      body.hidden = !now;
      if (now) fillProcess(v, turn, body);
    });
    proc.append(toggle, body);
    return proc;
  }
  function fillProcess(v, turn, body) {
    body.textContent = '';
    const steps = turn.steps || [];
    if (!steps.length) {
      const note = el('div', 'proc-empty', turn.end ? '这一轮没有记下工具调用。' : '这一轮的过程没有保存（更早的记录）。');
      const term = svgButton('icon-btn', 'terminal', '在终端里查看');
      term.addEventListener('click', () => openTerminal(v.id));
      note.appendChild(term);
      body.appendChild(note);
      return;
    }
    const all = v.allSteps.has(turn.id) || steps.length <= PROC_TAIL;
    if (!all) {
      const more = el('button', 'proc-more');
      more.type = 'button';
      const chev = el('span', 'ico proc-chev');
      chev.innerHTML = host.ICONS.chevRight;
      more.append(`前面 ${steps.length - PROC_TAIL} 条消息`, chev);
      more.title = '展开更早的过程';
      more.addEventListener('click', () => { v.allSteps.add(turn.id); fillProcess(v, turn, body); });
      body.appendChild(more);
    }
    (all ? steps : steps.slice(-PROC_TAIL)).forEach((step) => {
      const tool = C.isToolStep(step);
      const row = el('div', tool ? 'step tool' : 'step note');
      if (tool) {
        const ico = el('span', 'ico');
        ico.innerHTML = host.ICONS.terminal;
        row.appendChild(ico);
      }
      const text = el('span', 'step-text');
      linkify(text, step, v.id);
      row.appendChild(text);
      body.appendChild(row);
    });
  }
  function openTerminal(id) {
    host.setFocused(id);
    window.SidePane.show('terminal', true);
  }

  // ---- cards under a reply: web pages it mentions, files it changed ----
  function webCards(v, turn) {
    const seen = new Set();
    const urls = [];
    for (const line of (turn.reply || '').split('\n')) {
      for (const m of host.findLinks(line)) {
        if (m.kind === 'url' && !seen.has(m.text) && urls.length < 3) { seen.add(m.text); urls.push(m.text); }
      }
    }
    return urls.map((url) => webCard(v, url));
  }
  function webCard(v, url) {
    const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url) || [];
    const card = el('div', 'link-card');
    const main = el('button', 'lc-main');
    main.type = 'button';
    main.title = '在侧栏打开 ' + url;
    const ico = el('span', 'lc-icon');
    ico.innerHTML = host.ICONS.globe;
    const text = el('span', 'lc-text');
    const path = (m[2] || '').replace(/\/+$/, '');
    text.append(el('span', 'lc-title', m[1] || url), el('span', 'lc-sub', path ? decodeURI(path).slice(0, 80) : '网页预览'));
    main.append(ico, text);
    main.addEventListener('click', (e) => window.SidePane.openLink({ kind: 'url', text: url }, e, v.id));
    const pick = el('button', 'lc-open');
    pick.type = 'button';
    pick.setAttribute('aria-haspopup', 'menu');
    pick.setAttribute('aria-expanded', 'false');
    const chev = el('span', 'ico');
    chev.innerHTML = host.ICONS.chevDown;
    pick.append('打开方式', chev);
    pick.addEventListener('click', (e) => { e.stopPropagation(); openMenu(pick, [
      ['侧栏打开', 'side', () => window.SidePane.openLink({ kind: 'url', text: url }, null, v.id)],
      ['系统浏览器打开', 'globe', () => window.deck.openExternal(url)],
      ['复制链接', 'copy', () => host.clipboardWrite(url)],
    ]); });
    card.append(main, pick);
    return card;
  }
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.anchor.setAttribute('aria-expanded', 'false');
    menu.node.remove();
    document.removeEventListener('mousedown', menu.away, true);
    menu = null;
  }
  function openMenu(anchor, items) {
    const again = menu && menu.anchor === anchor;
    closeMenu();
    if (again) return;
    const node = el('div', 'lc-menu');
    node.setAttribute('role', 'menu');
    items.forEach(([label, icon, run]) => {
      const it = el('button', 'lc-item');
      it.type = 'button';
      it.setAttribute('role', 'menuitem');
      const ico = el('span', 'ico');
      ico.innerHTML = host.ICONS[icon] || '';
      it.append(ico, label);
      it.addEventListener('click', () => { closeMenu(); run(); anchor.focus(); });
      node.appendChild(it);
    });
    node.addEventListener('keydown', (e) => {
      const list = [...node.querySelectorAll('.lc-item')];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
    });
    anchor.parentNode.appendChild(node);
    const away = (e) => { if (!node.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
    document.addEventListener('mousedown', away, true);
    menu = { node, anchor, away };
    anchor.setAttribute('aria-expanded', 'true');
    node.querySelector('.lc-item').focus();
  }
  function editCard(v, turn) {
    const files = C.editsFromSteps(turn.steps);
    if (!files.length) return null;
    const card = el('div', 'edit-card');
    const head = el('button', 'ec-head');
    head.type = 'button';
    const ico = el('span', 'lc-icon');
    ico.innerHTML = host.ICONS.diff;
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const text = el('span', 'lc-text');
    const counts = el('span', 'ec-counts');
    counts.append(el('span', 'ec-add', '+' + add), el('span', 'ec-del', '−' + del));
    text.append(el('span', 'lc-title', `改了 ${files.length} 个文件`), counts);
    const chev = el('span', 'ico proc-chev');
    chev.innerHTML = host.ICONS.chevRight;
    head.append(ico, text, chev);
    const list = el('div', 'ec-list');
    const open = v.openEdits.has(turn.id);
    list.hidden = !open;
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    head.title = '展开 / 收起改动的文件';
    head.addEventListener('click', () => {
      const now = !v.openEdits.has(turn.id);
      if (now) v.openEdits.add(turn.id); else v.openEdits.delete(turn.id);
      list.hidden = !now;
      card.classList.toggle('open', now);
      head.setAttribute('aria-expanded', String(now));
    });
    files.forEach((f) => {
      const row = el('button', 'ec-file');
      row.type = 'button';
      row.title = '在侧栏预览 ' + f.path;
      const cut = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\')) + 1;
      const name = el('span', 'ec-name');
      name.append(el('span', 'ec-dir', f.path.slice(0, cut)), f.path.slice(cut));
      const n = el('span', 'ec-counts');
      n.append(el('span', 'ec-add', '+' + f.add), el('span', 'ec-del', '−' + f.del));
      row.append(name, n);
      row.addEventListener('click', (e) => window.SidePane.openLink({ kind: 'file', text: f.path }, e, v.id));
      list.appendChild(row);
    });
    card.append(head, list);
    return card;
  }

  // readOnly: a turn from a retired 队长 conversation; it is not tracked in
  // v.rows, so live updates of the current chat never touch it.
  function turnRows(v, turn, readOnly) {
    if (turn.kind === 'notice') {
      const notice = el('div', 'captain-relay-notice', turn.reply);
      notice.dataset.turn = turn.id; notice.setAttribute('role', 'status');
      return notice;
    }
    if (turn.kind === 'task') {
      const wrap = el('div', 'turn task-turn');
      wrap.dataset.turn = turn.id;
      wrap.appendChild(window.MainSession.renderCard({ id: turn.id, ...turn.task }, v.id));
      if (!readOnly) v.rows.set(turn.id, { user: wrap, asst: wrap, turn });
      return wrap;
    }
    const wrap = el('div', 'turn');
    // you on the right in a bubble, the agent on the left as plain text
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
    if (!user.hidden && turn.ts) wrap.appendChild(el('div', 'turn-time', C.turnTimeLabel(turn.ts)));
    bubble.title = '点击展开 / 收起';
    // long prompts are clipped; a click (not a text selection) expands them
    bubble.addEventListener('click', () => { if (!String(window.getSelection())) user.classList.toggle('expanded'); });
    user.appendChild(bubble);
    // your own message: copy it, or put it (and its attachments) back to edit
    const mine = el('div', 'msg-tools user-tools');
    const copyMine = copyButton('复制这条消息', () => turn.user || '');
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

    const asst = assistantRow(v, turn);
    wrap.append(user, asst);
    if (!readOnly) v.rows.set(turn.id, { user, asst, turn });
    return wrap;
  }
  function assistantRow(v, turn) {
    const asst = el('div', 'msg assistant');
    asst.dataset.turn = turn.id;
    asst.appendChild(processRow(v, turn));
    asst.appendChild(renderReply(v, turn));
    if (!turn.done) return asst;
    webCards(v, turn).forEach((card) => asst.appendChild(card));
    const edits = editCard(v, turn);
    if (edits) asst.appendChild(edits);
    const tools = el('div', 'msg-tools');
    const copy = copyButton('复制回复', () => turn.reply || '');
    const share = svgButton('msg-tool', 'share', '分享：把这一轮的问与答复制成 Markdown');
    share.addEventListener('click', () => {
      host.clipboardWrite(`**我：**\n\n${turn.user || ''}\n\n**回复：**\n\n${turn.reply || ''}\n`);
      flashCheck(share, 'share');
    });
    const term = svgButton('msg-tool', 'terminal', '在终端里查看');
    term.addEventListener('click', () => openTerminal(v.id));
    tools.append(copy, share, term);
    asst.appendChild(tools);
    return asst;
  }
  const nearBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight <= 2;

  function emptyState(v, col) {
    const empty = el('div', 'chat-empty');
    if (col.isMain) {
      empty.append(el('strong', null, '队长在这里'),
        el('span', null, '说要做什么，队长会把活派给各个对话：新事新开一列，补充发回原来那一列。做完的回执会以卡片出现在这里，点标题跳过去。'));
      if (window.MainSession && window.MainSession.history().length) {
        empty.appendChild(el('span', null, '模型上下文清空过，之前的对话还存在本机，没有删除。问起以前的事，队长会按需读取，不会整段带进新的上下文。'));
      }
      v.scroll.appendChild(empty);
      return;
    }
    if (needsLauncher(col) && !v.agentUp) {
      empty.append(el('strong', null, '用哪个 agent？'),
        el('span', null, '点一个，就在这个对话里启动它，然后在下面发消息。也可以在下面直接输入终端命令。'),
        launcherRow(v, col));
      v.scroll.appendChild(empty);
      return;
    }
    empty.append(el('strong', null, '要做点什么？'),
      el('span', null, '在下面发消息给 ' + agentName(col) + '。最终回复会出现在这里，过程在右侧栏的「终端」里。'));
    v.scroll.appendChild(empty);
  }

  // ---- starting an agent in a blank session ----
  // A session without a launch command is a bare shell. Its empty page offers
  // the agents: a click types the launch command into this same shell (its
  // history stays) and, once the agent really is in the foreground, saves it as
  // the session's command so a restart runs it again. The buttons go away as
  // soon as any agent runs there, including one started by hand in the terminal.
  const launching = new Set();
  const needsLauncher = (col) => !!col && !col.cmd && !col.isMain && col.role === 'manual' && !chatFor(col.id).turns.length;
  function launcherRow(v, col) {
    const row = el('div', 'launcher');
    const busy = launching.has(col.id);
    window.BoardCore.LAUNCHERS.forEach((l) => {
      const b = el('button', 'launch-btn', l.label);
      b.type = 'button';
      b.dataset.agent = l.key;
      b.dataset.cmd = l.cmd;
      b.title = l.cmd;
      b.disabled = busy;
      b.addEventListener('click', () => launch(col, b.dataset.cmd, l.label));
      row.appendChild(b);
    });
    v.launchNote = el('div', 'launch-note');
    v.launchNote.hidden = true;
    row.appendChild(v.launchNote);
    return row;
  }
  function launchNote(id, text, failed) {
    const v = views.get(id);
    if (!v || !v.launchNote || !v.launchNote.isConnected) return;
    v.launchNote.textContent = text;
    v.launchNote.hidden = !text;
    v.launchNote.classList.toggle('failed', !!failed);
    v.scroll.querySelectorAll('.launch-btn').forEach((b) => { b.disabled = launching.has(id); });
  }
  function refreshAgent(col) {
    const v = views.get(col.id);
    if (!v) return;
    v.agentLabel.textContent = agentName(col);
    v.agent.title = col.cmd ? '这个对话里运行的是：' + col.cmd : '普通终端';
    v.ta.placeholder = '发消息给 ' + agentName(col) + '…  Enter 发送，Shift+Enter 换行';
  }
  async function launch(col, cmd, label) {
    const id = col.id;
    const entry = host.terms.get(id);
    cmd = String(cmd || '').trim();
    if (!cmd || col.cmd || launching.has(id)) return;
    if (!entry || !entry.alive) { host.showToast(entry ? '这个终端已经退出了' : '终端还在启动，稍等一下'); return; }
    launching.add(id);
    // something already runs in front of the shell: never start a second agent
    if (await host.agentInForeground(col, false)) {
      launching.delete(id);
      const v = views.get(id);
      if (v) { v.agentUp = true; renderChat(id); }
      host.showToast('这个对话里已经有程序在运行，没有再启动');
      return;
    }
    if (host.platform === 'win32' && !window.MainCore.isWindowsShellPrompt(entry.lastScreen)) {
      launching.delete(id);
      host.showToast('还没确认终端回到 PowerShell 提示符，先去「终端」里检查。');
      return;
    }
    launchNote(id, `正在启动 ${label}…`, false);
    const before = window.BoardCore.launchErrors(entry.lastScreen, cmd);
    const launch = host.seatLaunchCommand ? host.seatLaunchCommand(col, window.BoardCore.shellLaunchCommand(cmd, host.platform)) : window.BoardCore.shellLaunchCommand(cmd, host.platform);
    window.deck.ptyInput(id, (host.platform === 'win32' ? '\x1b[1;5F\x1b[1;5H' : '\x15') + window.BoardCore.reportAgentExit(launch, host.platform) + '\r');
    const started = Date.now();
    const finish = (ok, note) => {
      launching.delete(id);
      if (ok) {
        col.cmd = cmd;
        host.saveConfig();
        refreshAgent(col);
        const v = views.get(id);
        if (v) v.agentUp = true;
        renderChat(id);
        if (host.focusedId() === id) focusInput(id);
      } else {
        launchNote(id, note, true);
      }
    };
    const check = async () => {
      if (!host.columns().includes(col) || col.id !== id) { launching.delete(id); return; }
      const now = host.terms.get(id);
      const alive = !!now && now.alive;
      const missing = alive && window.BoardCore.launchErrors(now.lastScreen, cmd) > before;
      const up = alive && !missing && await host.agentInForeground(col, false);
      const verdict = window.BoardCore.launchVerdict({ alive, missing, up, waited: Date.now() - started, platform: host.platform });
      if (verdict === 'waiting') { setTimeout(check, 500); return; }
      if (verdict === 'up') { finish(true); return; }
      finish(false, {
        exited: '终端已经退出，没有启动起来。',
        missing: `没找到 ${cmd.split(/\s+/)[0]}：它没有安装，或者不在终端的 PATH 里。装好后再点一次。`,
        unknown: `没认出 ${label} 有没有起来（Windows 上看不到前台程序）。去「终端」里看看：没起来就再点一次；已经起来了就别再点，直接在下面发消息。`,
        failed: `${label} 没有启动起来，去「终端」里看看输出。`,
      }[verdict]);
    };
    setTimeout(check, 500);
  }
  // Every turn stays saved; a long chat renders its latest C.RENDER_STEP turns
  // and loads older ones a step at a time.
  function earlierButton(hidden, onClick) {
    const b = el('button', 'chat-earlier', `显示更早的 ${Math.min(hidden, C.RENDER_STEP)} 轮（前面还有 ${hidden} 轮）`);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  // Content inserted above stays out of the way: what you were reading does not move.
  function keepScroll(scroll, change) {
    const fromBottom = scroll.scrollHeight - scroll.scrollTop;
    change();
    scroll.scrollTop = scroll.scrollHeight - fromBottom;
  }
  function renderChat(id, keepPosition) {
    const v = views.get(id);
    if (!v) return;
    const top = v.scroll.scrollTop;
    v.scroll.textContent = '';
    v.rows.clear();
    v.live = null;
    v.liveElapsed = null;
    const col = columnById(id) || {};
    const retired = col.isMain ? retiredHistory(v) : null;
    if (retired) v.scroll.appendChild(retired);
    const turns = chatFor(id).turns;
    if (!turns.length) { emptyState(v, col); return; }
    const from = C.windowStart(turns.length, v.shown);
    if (from > 0) {
      v.scroll.appendChild(earlierButton(from, () => keepScroll(v.scroll, () => { v.shown += C.RENDER_STEP; renderChat(id, true); })));
    }
    turns.slice(from).forEach((t) => v.scroll.appendChild(turnRows(v, t)));
    if (!keepPosition) {
      v.scroll.scrollTop = v.following ? v.scroll.scrollHeight : top;
      requestAnimationFrame(() => { if (v.following) v.scroll.scrollTop = v.scroll.scrollHeight; });
    }
  }
  // 队长's conversations from before each context clear, read-only, from the
  // chats already loaded (nothing new is read from disk, no terminal restarts).
  function retiredHistory(v) {
    const first = (c) => (c.turns[0] && c.turns[0].ts) || 0;
    const old = captainArchives().filter((c) => c.turns.length).sort((a, b) => first(a) - first(b));
    if (!old.length) return null;
    const box = el('div', 'retired');
    const total = old.reduce((n, c) => n + c.turns.length, 0);
    const toggle = el('button', 'chat-earlier retired-toggle', v.showRetired ? '收起清空上下文前的对话' : `查看清空上下文前的队长对话（${old.length} 段，共 ${total} 轮）`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => keepScroll(v.scroll, () => { v.showRetired = !v.showRetired; renderChat(v.id, true); }));
    box.appendChild(toggle);
    if (!v.showRetired) return box;
    old.forEach((chat) => {
      const seg = el('details', 'retired-chat');
      seg.dataset.chatId = chat.id;
      const last = chat.turns[chat.turns.length - 1].ts || 0;
      seg.appendChild(el('summary', 'retired-head', `清空前的队长对话 · ${fmtTime(first(chat))} – ${fmtTime(last)} · ${chat.turns.length} 轮 · 只读`));
      const list = el('div', 'retired-turns');
      let shown = C.RENDER_STEP;
      const fill = () => {
        list.textContent = '';
        const from = C.windowStart(chat.turns.length, shown);
        if (from > 0) list.appendChild(earlierButton(from, () => keepScroll(v.scroll, () => { shown += C.RENDER_STEP; fill(); })));
        chat.turns.slice(from).forEach((t) => list.appendChild(turnRows(v, t, true)));
      };
      seg.addEventListener('toggle', () => { if (seg.open && !list.childNodes.length) fill(); });
      seg.appendChild(list);
      box.appendChild(seg);
    });
    return box;
  }
  function appendTurn(id, turn) {
    const v = views.get(id);
    if (!v) return;
    v.shown++;
    v.scroll.querySelector('.chat-empty')?.remove();
    v.scroll.appendChild(turnRows(v, turn));
    followOutput(v);
  }
  function followOutput(v) {
    if (v.following) v.scroll.scrollTop = v.scroll.scrollHeight;
    else v.newContent.hidden = false;
  }
  function refreshTurn(id, turn) {
    const v = views.get(id);
    const row = v && v.rows.get(turn.id);
    if (!row) return;
    const fresh = assistantRow(v, turn);
    row.asst.replaceWith(fresh);
    row.asst = fresh;
    if (turn.done) { v.live = null; v.liveElapsed = null; }
    followOutput(v);
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
    entry.footerLines = lines;
    const key = lines ? JSON.stringify(lines) : '';
    if (key === v.footerKey) return;
    v.footerKey = key;
    v.footer.textContent = '';
    v.footer.hidden = !lines;
    if (!lines) return;
    lines.forEach((segs) => {
      const row = el('div', 'tf-row tui-footer-line');
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
  // Recorded in either view: a prompt typed in the raw terminal is history too.
  // Turns started before the saved chats finish loading are merged after them.
  function beginTurn(col, text, atts, sent) {
    if (!views.has(col.id)) return null;
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
    if (window.MainSession) window.MainSession.onTurnStarted(col.id, turn);
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
      let lines = [];
      try { lines = readLines(entry.term, open.marker); } catch (_) {}
      try { open.turn.reply = C.extractReply(lines, open.sent, entry.term.cols); } catch (_) { open.turn.reply = ''; }
      keepSteps(open.turn, lines, open.sent);
    }
    try { if (open.marker) open.marker.dispose(); } catch (_) {}
    open.turn.done = true;
    open.turn.end = Date.now();
    delete open.turn.interrupted;
    refreshTurn(id, open.turn);
    scheduleSave(id);
    if (window.MainSession) window.MainSession.onTurnDone(id, open.turn);
    host.manualTurnDone(id, open.turn);
    if (nav && nav.input.value.trim()) runSearch();
    if (window.Pages) window.Pages.refresh();
  }

  // The work before the reply, saved with the turn (bounded by ChatCore).
  function keepSteps(turn, lines, sent) {
    let steps = [];
    try { steps = C.extractSteps(lines, sent); } catch (_) {}
    if (steps.length) turn.steps = steps; else delete turn.steps;
  }

  // Called from the 1.5s status loop with the column's screen text.
  // The chat furniture updates only in chat view; open turns end in either view.
  function onTick(id, entry, text) {
    const v = views.get(id);
    if (!v) return;
    const chatMode = isChatMode(id);
    if (chatMode) {
      v.stop.hidden = entry.state !== 'working';
      v.agentDot.className = 'cp-agent-dot ' + (entry.alive ? entry.state || 'plain' : 'exited');
      v.agentDot.title = window.MainCore.statusLabel(entry.alive ? entry.state : 'exited');
      renderFooter(v, entry);
      setAttention(v, id, entry.state === 'input' ? text : null);
      const col = columnById(id);
      if (needsLauncher(col) && entry.alive && !launching.has(id) && !v.checkingAgent) {
        v.checkingAgent = true;
        host.agentInForeground(col, false).then((up) => {
          v.checkingAgent = false;
          if (up === !!v.agentUp || views.get(id) !== v) return;
          v.agentUp = up;
          if (needsLauncher(col)) renderChat(id);
        }, () => { v.checkingAgent = false; });
      }
    }
    const open = pending.get(id);
    if (!open) return;
    if (v.liveElapsed && chatMode && v.liveElapsed.isConnected) v.liveElapsed.textContent = '处理中 ' + C.fmtDuration(Date.now() - open.startedAt);
    if (v.live && chatMode) {
      const line = entry.state === 'working' ? host.lastActivityLine(text) : '';
      if (v.live.textContent !== line) { v.live.textContent = line; followOutput(v); }
    }
    if (!entry.alive) { finalizeTurn(id); return; }
    if (entry.state === 'working' || entry.state === 'input' || entry.state === 'quota' || window.MainCore.terminalActivity(text)) return;
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
    // until the agent is up the shell is in front and would run the message as commands
    if (launching.has(col.id)) { host.showToast('agent 还在启动，等它起来再发'); return; }
    if (host.terms.get(col.id)?.sendingPrompt) return;
    const prefix = window.MainSession ? window.MainSession.outgoingPrefix(col) : '';
    const atts = v.atts.slice();
    // a long prompt resolves once its file is written; keep the text until then
    Promise.resolve(sendPrompt(col, text, atts, { prefix, userInitiated: true })).then((sent) => {
      if (!sent || v.ta.value.replace(/\s+$/, '') !== text) return;
      v.ta.value = ''; v.hist = -1; autosize(v.ta);
      v.atts = v.atts.filter((p) => !atts.includes(p)); renderAttachments(v);
    });
  }
  // Type a prompt into the column's terminal as if sent from the composer.
  // Attachments go first, as paths the agent can open. Used by the composer,
  // Schedule and 队长. opts: prefix/suffix go to the terminal but
  // not into the bubble; silent sends no bubble at all. Every other send is
  // recorded as a turn in either view (force is accepted for older callers).
  // Returns the recorded turn, true when sent without one, or false.
  // No length limit: a prompt longer than this is saved as a .txt file and the
  // agent gets its opening plus "read this file first".
  const LONG_PROMPT = 8000;
  async function sendPrompt(col, prompt, atts, opts) {
    const o = opts || {};
    if (o.cancelled && o.cancelled()) return false;
    const entry = host.terms.get(col.id);
    if (!entry || !entry.alive) { host.showToast(entry ? '这个终端已经退出了' : '终端还在启动，稍等一下'); return false; }
    if (o.requireIdle && (entry.state === 'working' || entry.state === 'input' || entry.state === 'quota' || window.MainCore.terminalActivity(entry.lastScreen))) return false;
    if (prompt && prompt.length > LONG_PROMPT) return sendLong(col, prompt, atts, o);
    if (entry.sendingPrompt) return false;
    // guardUserInput (receipts, 队长's work for others): never into an input box
    // the user is typing in, because the Enter below would send their words
    // too. The check and the lock are in the same tick; keys the user presses
    // until the Enter is out are held and replayed after it (see renderer).
    if (o.guardUserInput) {
      if (host.userComposing(col.id)) return false;
      entry.injecting = true;
    }
    entry.sendingPrompt = true;
    try {
      const paths = (atts || []).map(host.shellQuote).join(' ');
      const body = paths ? paths + (prompt ? ' ' + prompt : '') : prompt;
      const text = (o.prefix || '') + body + (o.suffix || '');
      // Automatic work replaces any manual notification eligibility, even for
      // silent sends. Arm a user turn only after its Enter actually goes out.
      host.manualPromptSent(col.id, null, false);
      if (!o.silent && window.MainSession) window.MainSession.onContextCommand(col, text, false);
      // display/displayAtts: what the bubble shows when it differs from what is typed
      const turn = o.silent ? null : beginTurn(col, o.display != null ? o.display : prompt, o.displayAtts || atts, text);
      // bracketed paste keeps multi-line text one prompt; the CR goes separately so
      // Ink-based TUIs submit instead of inserting a newline
      const bracketed = entry.term.modes && entry.term.modes.bracketedPasteMode;
      window.deck.ptyInput(col.id, bracketed ? '\x1b[200~' + text + '\x1b[201~' : text.replace(/\r?\n/g, '\r'));
      // Cursor and other TUIs buffer paste input asynchronously. An Enter only
      // 60ms later can be swallowed by their paste detector. Wait for the paste
      // redraw to settle, then submit once; never retry into a changed terminal.
      const pastedAt = Date.now();
      const isCursor = (window.BoardCore && window.BoardCore.inferAgentType(col.cmd) === 'Cursor') || /cursor-agent\b/i.test(col.cmd || '');
      const minWait = isCursor ? 700 : (bracketed ? 500 : 80);
      do {
        await new Promise((resolve) => setTimeout(resolve, bracketed ? 50 : 60));
        if (host.terms.get(col.id) !== entry || !entry.alive || (o.cancelled && o.cancelled())) return false;
      } while (bracketed && (Date.now() - pastedAt < minWait || (Date.now() - (entry.lastOutputAt || 0) < 200 && Date.now() - pastedAt < 3000)));
      if (!o.silent && window.MainSession) window.MainSession.onContextCommandSent(col, text);
      window.deck.ptyInput(col.id, '\r');
      host.manualPromptSent(col.id, turn, o.userInitiated === true);
      entry.state = 'working';
      entry.hasWorked = true;
      entry.lastOutputAt = Date.now();
      if (isCursor) {
        // Double-check Cursor submission: if the first Enter hit an input debounce/aggregation
        // window, the terminal shows no reaction at all after 600ms, so deliver a follow-up Enter.
        const submittedAt = entry.lastOutputAt;
        setTimeout(() => {
          if (host.terms.get(col.id) === entry && entry.alive && entry.state !== 'input' && entry.lastOutputAt === submittedAt) {
            window.deck.ptyInput(col.id, '\r');
          }
        }, 600);
      }
      window.deck.notifyCancel({ id: col.id });
      const nameFrom = o.display || prompt;
      if (nameFrom && !o.silent) host.maybeAutoName(col, nameFrom.split('\n')[0].trim());
      return turn || true;
    } finally {
      entry.sendingPrompt = false;
      if (entry.injecting) { entry.injecting = false; if (entry.flushHeld) entry.flushHeld(); }
    }
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
  function onSubmitted(col, line, uncertain = false) {
    const entry = host.terms.get(col.id);
    if (!entry || entry.state === 'input' || C.isPromptAnswer(line)) return;
    if (C.isSecretPrompt(cursorRow(entry.term))) return;
    if (window.MainSession) window.MainSession.onContextCommand(col, uncertain ? '' : line);
    const turn = beginTurn(col, line);
    host.manualPromptSent(col.id, turn, true);
  }
  function cursorRow(term) {
    try {
      const buf = term.buffer.active;
      const ln = buf.getLine(buf.baseY + buf.cursorY);
      return ln ? ln.translateToString(true) : '';
    } catch (_) { return ''; }
  }
  // Text sent on the column's behalf (broadcast, board messages).
  function noteSent(col, text, userInitiated = false) {
    host.manualPromptSent(col.id, null, false);
    if (!text || C.isPromptAnswer(text)) return;
    const turn = beginTurn(col, String(text).slice(0, 4000));
    host.manualPromptSent(col.id, turn, userInitiated);
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
  // Nothing is written before the saved chats are loaded: an early save would
  // replace the file on disk with only the turns of this launch.
  function saveNow(id) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    if (!loaded) { unsaved.add(id); return; }
    if (chats.has(id)) window.deck.chatSave(id, chats.get(id));
  }
  function scheduleSave(id) {
    if (!loaded) { unsaved.add(id); return; }
    clearTimeout(saveTimers.get(id));
    saveTimers.set(id, setTimeout(() => saveNow(id), 1500));
  }
  function flushSaves() {
    [...saveTimers.keys()].forEach(saveNow);
  }
  // Leaving the page (quit, reload): a turn still running keeps the reply seen
  // so far and is marked unfinished, instead of being saved with no reply.
  function onLeave() {
    pending.forEach((open, id) => {
      const entry = host.terms.get(id);
      if (entry) {
        try {
          const lines = readLines(entry.term, open.marker);
          const seen = C.extractReply(lines, open.sent, entry.term.cols);
          if (seen) open.turn.reply = seen;
          keepSteps(open.turn, lines, open.sent);
        } catch (_) {}
      }
      open.turn.interrupted = true;
      saveNow(id);
    });
    flushSaves();
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
    saveNow(id);
  }
  function deleteArchivedChat(id) {
    chats.delete(id);
    window.deck.chatDelete(id);
  }
  // The terminal was replaced under a new id (its old one is already gone):
  // an open turn stays, marked unfinished, and the chat is written under the
  // new id before the old file is removed.
  function onColumnIdChanged(oldId, newId) {
    const open = pending.get(oldId);
    if (open) { open.turn.done = true; open.turn.interrupted = true; }
    forget(oldId);
    const chat = chats.get(oldId);
    if (chat) {
      chat.id = newId;
      chats.delete(oldId); chats.set(newId, chat);
      saveNow(newId);
      if (loaded) window.deck.chatDelete(oldId);
    }
  }
  // All terminals are rebuilt while their shells keep running: open turns stay
  // open and are read from the new terminal when they end.
  function onRender() {
    pending.forEach((open) => {
      try { if (open.marker) open.marker.dispose(); } catch (_) {}
      open.marker = null;
    });
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
  function addNotice(id, text, ts = Date.now()) {
    const turn = C.addTurn(chatFor(id), { kind: 'notice', ts, user: '永动机', reply: text, done: true, atts: [] });
    appendTurn(id, turn); saveNow(id);
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
      const fresh = turnRows(v, chat.turns[at]);
      row.user.replaceWith(fresh);
      followOutput(v);
    }
    scheduleSave(id);
    if (window.Pages) window.Pages.refresh();
  }
  // 队长's context is cleared: its conversation stays saved under the old id
  // (readable with `read --id`), the respawned column starts an empty one.
  // Call before the terminal goes away so an open turn keeps what it has.
  function snapshotForHandoff(id) {
    const chat = JSON.parse(JSON.stringify(chatFor(id)));
    const open = pending.get(id), entry = host.terms.get(id);
    if (open) {
      const turn = chat.turns.find((t) => t.id === open.turn.id);
      if (turn) {
        if (entry) turn.reply = C.extractReply(readLines(entry.term, open.marker), open.sent, entry.term.cols);
        turn.interrupted = true;
      }
    }
    chat.captainArchive = true;
    return chat;
  }
  function retireChat(id, options) {
    if (options?.interrupted && pending.has(id)) {
      chats.set(id, snapshotForHandoff(id));
    } else finalizeTurn(id);
    forget(id);
    const chat = chats.get(id);
    if (!chat || (!chat.turns.length && !options?.interrupted)) { chats.delete(id); window.deck.chatDelete(id); return null; }
    chat.captainArchive = true;
    saveNow(id);
    return { turns: chat.turns.length, from: chat.turns[0]?.ts || 0, to: chat.turns[chat.turns.length - 1]?.ts || 0 };
  }
  const turnsOf = (id) => (chats.get(id) || { turns: [] }).turns;
  const captainArchives = () => [...chats.values()].filter((c) => c.captainArchive);
  function captainSnapshot(id) {
    finalizeTurn(id);
    return JSON.parse(JSON.stringify(chatFor(id).turns));
  }
  // Split the saved conversation without replacing its live column or PTY.
  // Keep task cards and any messages submitted after the reset boundary.
  function archiveCaptainSnapshot(id, snapshot) {
    if (!snapshot?.length) return null;
    const archiveId = 'captain-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const chat = { ...C.emptyChat(archiveId), captainArchive: true, turns: snapshot };
    chats.set(archiveId, chat);
    saveNow(archiveId);
    const retired = new Set(snapshot.filter((t) => t.kind !== 'task').map((t) => t.id));
    chatFor(id).turns = chatFor(id).turns.filter((t) => !retired.has(t.id));
    saveNow(id);
    renderChat(id, true);
    return { id: archiveId, turns: snapshot.length, from: snapshot[0].ts || 0, to: snapshot.at(-1).ts || 0 };
  }

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
        if (!v) return;
        let row = v.rows.get(turnId);
        if (!row) {
          // an older turn outside the rendered window
          const turns = chatFor(colId).turns;
          const at = turns.findIndex((t) => t.id === turnId);
          if (at < 0) return;
          v.shown = Math.max(v.shown, turns.length - at);
          renderChat(colId, true);
          row = v.rows.get(turnId);
        }
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
    window.addEventListener('pagehide', onLeave);
    try {
      const saved = await window.deck.chatLoadAll();
      (saved || []).forEach((chat) => {
        C.closeOpenTurns(chat);
        chats.set(chat.id, C.mergeChats(chat, chats.get(chat.id)));
      });
    } catch (_) {}
    loaded = true;
    unsaved.forEach((id) => scheduleSave(id));
    unsaved.clear();
    views.forEach((v, id) => renderChat(id));
    if (nav.input.value.trim()) runSearch();
    if (window.Sidebar) window.Sidebar.render();
  }

  window.ChatUI = {
    init, mountColumn, isChatMode, focusInput, setMode, toggleGlobalMode, onSubmitted, noteSent, sendPrompt,
    onTick, onExit, onColumnMouseDown, onColumnRemoved, onColumnArchived, deleteArchivedChat, onColumnIdChanged, onRender,
    focusSearch, reveal, lastTurnTs, artifactSources, readFooter,
    hasDraft: (id) => { const v = views.get(id); return !!v && (!!v.ta.value || v.atts.length > 0); },
    attach: (id, path) => { const v = views.get(id); if (v) addAttachment(v, path); },
    attachmentChip: (path, colId) => attachmentChip(path, colId, null),
    addCard, addNotice, updateCard, retireChat, snapshotForHandoff, turnsOf, captainArchives, captainSnapshot, archiveCaptainSnapshot,

  };
})();
