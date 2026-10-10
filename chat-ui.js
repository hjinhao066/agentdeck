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

  // ---- what a reply shows ----
  // An agent's column shows the agent's words only: terminal residue is taken
  // out by the phone hub's rules (ChatCore.shownReply). The saved reply is not
  // changed. A plain shell's output is shown as it is.
  const saidOf = new WeakMap();     // turns -> everything the user wrote there
  const shownOf = new WeakMap();    // turn -> its reply as shown
  function saidIn(turns) {
    const hit = saidOf.get(turns);
    if (hit && hit.n === turns.length) return hit.text;
    const text = turns.map((t) => t.user || '').join('\n');
    saidOf.set(turns, { n: turns.length, text });
    return text;
  }
  const isAgentColumn = (col) => !!col && (!!col.isMain || !!col.cmd);
  function shownReply(v, turn, turns) {
    const reply = turn.reply || '';
    if (!reply || !isAgentColumn(columnById(v.id))) return reply;
    const said = saidIn(turns || chatFor(v.id).turns);
    const hit = shownOf.get(turn);
    if (hit && hit.reply === reply && hit.said === said) return hit.text;
    const text = C.shownReply(reply, said, window.HubCore && window.HubCore.cleanReply, turn.user);
    shownOf.set(turn, { reply, said, text });
    return text;
  }
  // A turn AgentDeck started itself (a receipt delivery) that left nothing to read.
  const isSilent = (turn, text) => !!turn.done && !turn.interrupted && !turn.user && !(turn.atts && turn.atts.length) && !text;
  // Who is speaking, over every reply: 队长 with its crest, any other agent by name.
  function whoLabel(v) {
    const col = columnById(v.id) || {};
    const who = el('span', 'reply-who' + (col.isMain ? ' captain' : ''));
    const mark = el('span', 'who-mark');
    mark.setAttribute('aria-hidden', 'true');
    const type = window.BoardCore.inferAgentType(col.cmd);
    mark.innerHTML = col.isMain ? host.ICONS.crown : (window.AgentInfo && window.AgentInfo.PROVIDER_ICONS[type]) || host.ICONS.terminal;
    who.append(mark, el('span', 'who-name', col.isMain ? '队长' : agentName(col)));
    return who;
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
    const route = col.isMain ? buildRoute(col, attach, bar) : null;
    // attachments sit above the text; deleting the text never removes them
    const attBox = el('div', 'cp-atts');
    attBox.hidden = true;
    box.append(attBox, ta, bar);
    if (route) box.prepend(route.note);
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

    const v = { id: col.id, wrap, chat, scroll, newContent, following: true, attn, ta, stop, send, toggle, footer, agent, agentDot, agentLabel, attBox, atts: [], route, footerKey: '', rows: new Map(), hist: -1, live: null, shown: C.RENDER_STEP, showRetired: false, clips: clipWatch() };
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
    syncRoute(v);
    applyMode(col);
    if (col.isMain && window.ChatDeliverables) window.ChatDeliverables.mount(col, wrap, head, chat);

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
  // Which of your messages are cut by the bubble's height: those show the fold control.
  function clipWatch() {
    return new ResizeObserver((entries) => entries.forEach(({ target }) => {
      const user = target.parentNode;
      if (!user || user.classList.contains('expanded')) return;
      const cut = target.scrollHeight > target.clientHeight + 1;
      user.classList.toggle('clipped', cut);
      target.foldControl.hidden = !cut;
    }));
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
      const x = svgButton('att-x', 'close', '移除附件');
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
    // your own messages only: not 队长's cards and notices, not deliveries with no words of yours
    const asked = chatFor(id).turns.filter((t) => !t.kind && t.user).map((t) => t.user).reverse();
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
      // in reading order: findLinks lists URLs before paths
      for (const m of host.findLinks(line).sort((a, b) => a.start - b.start)) {
        if (m.start < last) continue;
        parent.append(line.slice(last, m.start));
        const a = el('a', m.kind === 'url' ? 'chat-link' : 'chat-link path', m.text);
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
  function renderReply(v, turn, text) {
    const box = el('div', 'reply');
    if (!turn.done) {
      box.classList.add('pending');
      box.append(el('span', 'typing'), (v.live = el('span', 'live-line')));
    } else if (text) {
      box.classList.add('md');
      box.innerHTML = C.renderMarkdown(isAgentColumn(columnById(v.id)) ? C.tidyReply(text) : text, { breaks: true });
      linkifyTree(box, v.id);
      decorateCode(box);
      // a short cell (a version, a time, a state) stays on one line; the long ones take the wrapping
      box.querySelectorAll('.md-table td').forEach((td) => td.classList.toggle('short', C.visibleWidth(td.textContent) <= 16));
    } else if (!turn.interrupted) {
      box.classList.add('quiet');
      box.textContent = '这一轮没有文字回复，过程在终端里。';
    }
    if (turn.done && turn.interrupted) {
      box.classList.add('interrupted');
      box.appendChild(el('div', 'reply-note', text
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
  // Which folds a column has open (turn ids), kept across re-renders.
  const opened = (v, key) => v[key] || (v[key] = new Set());
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
    const expanded = opened(v, 'openProc').has(turn.id);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = expanded ? '收起过程' : '展开过程（工具调用、命令）';
    proc.classList.toggle('open', expanded);
    body.hidden = !expanded;
    if (expanded) fillProcess(v, turn, body);
    toggle.addEventListener('click', () => {
      const now = !opened(v, 'openProc').has(turn.id);
      if (now) opened(v, 'openProc').add(turn.id); else opened(v, 'openProc').delete(turn.id);
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
    const all = opened(v, 'allSteps').has(turn.id) || steps.length <= PROC_TAIL;
    if (!all) {
      const more = el('button', 'proc-more');
      more.type = 'button';
      const chev = el('span', 'ico proc-chev');
      chev.innerHTML = host.ICONS.chevRight;
      more.append(`前面 ${steps.length - PROC_TAIL} 条消息`, chev);
      more.title = '展开更早的过程';
      more.addEventListener('click', () => { opened(v, 'allSteps').add(turn.id); fillProcess(v, turn, body); });
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
      // tool lines stay plain: a path there runs into the command's output
      const text = el('span', 'step-text', tool ? step : null);
      if (!tool) linkify(text, step, v.id);
      row.appendChild(text);
      body.appendChild(row);
    });
  }
  function openTerminal(id) {
    host.setFocused(id);
    window.SidePane.show('terminal', true);
  }

  // ---- cards under a reply: web pages it mentions, files it changed ----
  function webCards(v, text) {
    const seen = new Set();
    const urls = [];
    for (const line of text.split('\n')) {
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
    // a malformed escape ("/repos/%s", "/100%") is shown as written: decodeURI throws on it
    let shown = path;
    try { shown = decodeURI(path); } catch (_) {}
    text.append(el('span', 'lc-title', m[1] || url), el('span', 'lc-sub', path ? shown.slice(0, 80) : '网页预览'));
    main.append(ico, text);
    main.addEventListener('click', (e) => window.SidePane.openLink({ kind: 'url', text: url }, e, v.id));
    const pick = svgButton('icon-btn lc-open', 'more', '打开方式');
    pick.setAttribute('aria-haspopup', 'menu');
    pick.setAttribute('aria-expanded', 'false');
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
    const open = opened(v, 'openEdits').has(turn.id);
    list.hidden = !open;
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    head.title = '展开 / 收起改动的文件';
    head.addEventListener('click', () => {
      const now = !opened(v, 'openEdits').has(turn.id);
      if (now) opened(v, 'openEdits').add(turn.id); else opened(v, 'openEdits').delete(turn.id);
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
  // A turn that cannot be drawn shows a short line instead (its saved text is untouched):
  // it never stops the turns and columns after it.
  function turnRows(v, turn, readOnly, turns) {
    try { return buildTurnRows(v, turn, readOnly, turns); } catch (error) {
      console.error('对话回合显示失败：', error);
      const row = el('div', 'turn turn-broken', '这一轮显示不出来，内容仍在对话记录里。');
      row.dataset.turn = turn.id;
      return row;
    }
  }
  function buildTurnRows(v, turn, readOnly, turns) {
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
    // long prompts are clipped; the chevron under one, or a click on it (not a
    // text selection), opens the rest
    const more = svgButton('icon-btn bubble-more', 'chevDown', '展开全文');
    more.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    const unfold = () => {
      const on = user.classList.toggle('expanded');
      more.title = on ? '收起' : '展开全文';
      more.setAttribute('aria-label', more.title);
      more.setAttribute('aria-expanded', String(on));
    };
    more.addEventListener('click', unfold);
    bubble.addEventListener('click', () => { if (!String(window.getSelection())) unfold(); });
    user.appendChild(bubble);
    bubble.foldControl = more;
    v.clips.observe(bubble);
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
    mine.append(more, copyMine, editMine);
    user.appendChild(mine);

    const asst = assistantRow(v, turn, turns);
    wrap.append(user, asst);
    wrap.hidden = isSilent(turn, shownReply(v, turn, turns));
    if (!readOnly) v.rows.set(turn.id, { user, asst, turn, wrap });
    return wrap;
  }
  function assistantRow(v, turn, turns) {
    const asst = el('div', 'msg assistant');
    asst.dataset.turn = turn.id;
    const text = shownReply(v, turn, turns);
    const head = el('div', 'reply-head');
    head.append(whoLabel(v), processRow(v, turn));
    asst.append(head, renderReply(v, turn, text));
    if (!turn.done) return asst;
    webCards(v, text).forEach((card) => asst.appendChild(card));
    const edits = editCard(v, turn);
    if (edits) asst.appendChild(edits);
    const tools = el('div', 'msg-tools');
    const copy = copyButton('复制回复', () => text);
    const share = svgButton('msg-tool', 'share', '分享：把这一轮的问与答复制成 Markdown');
    share.addEventListener('click', () => {
      host.clipboardWrite(`**我：**\n\n${turn.user || ''}\n\n**回复：**\n\n${text}\n`);
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
    if (v.route && v.route.mode) syncRoute(v);
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
    const prepared = await window.deck.prepareLaunch(id, cmd).catch(() => null);
    if (prepared === null || col.id !== id || host.terms.get(id) !== entry || !entry.alive) { launching.delete(id); return; }
    const launch = host.seatLaunchCommand ? host.seatLaunchCommand(col, prepared) : prepared;
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
      const up = alive && !missing && await host.agentInForeground({ ...col, cmd }, false);
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
  // ---- 队长's dispatch cards fold into one line ----
  // The cards 队长 leaves between two messages (work handed out, receipts coming
  // back) are process, not conversation: each run of them sits behind one line
  // that says how many there are and how they stand, and opens on a click.
  // The cards stay direct children of the list; the line is their sibling.
  const RUN_STATES = [['busy', '进行中', ['working', 'queued', 'asking', 'paused']], ['wait', '排队', ['waiting']],
    ['stuck', '卡住', ['input', 'quota']], ['failed', '没做成', ['failed']], ['done', '完成', ['done', 'stopped']]];
  function syncRuns(v, box = v.scroll) {
    const old = new Map([...box.children].filter((n) => n.classList.contains('task-run')).map((n) => [n.dataset.run, n]));
    let run = [];
    const close = () => { if (run.length) paintRun(v, box, run, old); run = []; };
    [...box.children].forEach((n) => {
      if (n.classList.contains('task-turn')) run.push(n);
      // a silent receipt delivery between two cards does not split them
      else if (!n.classList.contains('task-run') && !(n.hidden && n.classList.contains('turn'))) close();
    });
    close();
    old.forEach((n) => n.remove());
  }
  function paintRun(v, box, cards, old) {
    const key = cards[0].dataset.turn;
    let line = old.get(key);
    if (line) old.delete(key);
    else {
      line = el('button', 'task-run');
      line.type = 'button';
      line.dataset.run = key;
      line.addEventListener('click', () => {
        const now = !opened(v, 'openRuns').has(key);
        if (now) opened(v, 'openRuns').add(key); else opened(v, 'openRuns').delete(key);
        syncRuns(v, box);
      });
    }
    if (line.nextSibling !== cards[0]) box.insertBefore(line, cards[0]);
    const open = opened(v, 'openRuns').has(key);
    const counts = RUN_STATES.map(([name, label, states]) => [name, label, cards.filter((c) => states.some((st) => c.querySelector('.task-card.st-' + st))).length]).filter((x) => x[2]);
    const shown = `${open}|${cards.length}|${counts.map((x) => x[0] + x[2]).join(',')}`;
    if (line.dataset.shown !== shown) {
      line.dataset.shown = shown;
      line.textContent = '';
      const chev = el('span', 'ico proc-chev');
      chev.innerHTML = host.ICONS.chevRight;
      line.append(chev, el('span', 'run-label', '派活与回执'), el('span', 'run-count', cards.length + ' 条'));
      counts.forEach(([name, label, n]) => {
        const chip = el('span', 'run-state ' + name);
        chip.append(el('i'), n + ' ' + label);
        line.appendChild(chip);
      });
      line.classList.toggle('open', open);
      line.setAttribute('aria-expanded', String(open));
      line.title = open ? '收起派活与回执' : '展开派活与回执';
    }
    cards.forEach((c) => { c.hidden = !open; });
  }
  // A card search or a jump lands on: its run opens first.
  function showCard(v, card) {
    if (!card || !card.hidden || !card.classList.contains('task-turn')) return;
    let line = card.previousElementSibling;
    while (line && !line.classList.contains('task-run')) line = line.previousElementSibling;
    if (!line) return;
    opened(v, 'openRuns').add(line.dataset.run);
    syncRuns(v, card.parentNode);
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
    v.clips.disconnect();
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
    syncRuns(v);
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
        chat.turns.slice(from).forEach((t) => list.appendChild(turnRows(v, t, true, chat.turns)));
        syncRuns(v, list);
      };
      seg.addEventListener('toggle', () => { if (seg.open && !list.childNodes.length) fill(); });
      seg.appendChild(list);
      box.appendChild(seg);
      // a search hit in this conversation opens it at that turn
      const hit = v.retiredHit && v.retiredHit.chatId === chat.id ? v.retiredHit : null;
      if (!hit) return;
      v.retiredHit = null;
      const at = chat.turns.findIndex((t) => t.id === hit.turnId);
      if (at >= 0) shown = Math.max(shown, chat.turns.length - at);
      seg.open = true;
      fill();
      const rows = [...list.querySelectorAll('[data-turn]')].filter((n) => n.dataset.turn === hit.turnId);
      const row = hit.role === 'reply' ? rows[rows.length - 1] : rows[0];
      if (row) requestAnimationFrame(() => {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1800);
      });
    });
    return box;
  }
  function appendTurn(id, turn) {
    const v = views.get(id);
    if (!v) return;
    v.shown++;
    v.scroll.querySelector('.chat-empty')?.remove();
    v.scroll.appendChild(turnRows(v, turn));
    syncRuns(v);
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
    let fresh;
    try { fresh = assistantRow(v, turn); } catch (error) {
      console.error('对话回合显示失败：', error);
      fresh = el('div', 'msg assistant turn-broken', '这一轮显示不出来，内容仍在对话记录里。');
      fresh.dataset.turn = turn.id;
    }
    row.asst.replaceWith(fresh);
    row.asst = fresh;
    if (row.wrap) row.wrap.hidden = isSilent(turn, shownReply(v, turn));
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
    if (window.ChatDeliverables) window.ChatDeliverables.refresh();
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
    if (entry.sendingPrompt || entry.injecting || entry.state === 'working' || entry.state === 'input' || entry.state === 'quota' || window.MainCore.terminalActivity(text, columnById(id)?.cmd)) return;
    const quiet = Date.now() - (entry.lastOutputAt || 0);
    const sawOutput = (entry.lastOutputAt || 0) - open.startedAt > 600;
    // state done already waited out the status debounce. Cursor blink keeps
    // lastOutputAt fresh and must not hold a finished turn open.
    if ((entry.state === 'done' && sawOutput) || quiet >= 6000) finalizeTurn(id);
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
  // ---- 派给: who takes what is typed into 队长's composer ----
  // 队长 by default. 网页版 ChatGPT sends the text as one public research request
  // through MainSession.dispatchWeb, never into 队长's terminal.
  function buildRoute(col, attach, bar) {
    const W = window.ChatGPTWebCore;
    const options = [{ id: '', label: '队长安排', detail: '照常告诉队长，由它决定派给谁' },
      ...W.MODES.map((m) => ({ id: m.id, label: W.LABEL + ' · ' + m.label, detail: m.detail }))];
    const r = { mode: '', sending: false };
    r.btn = el('button', 'cp-route');
    r.btn.type = 'button';
    r.btn.setAttribute('aria-haspopup', 'menu');
    r.btn.setAttribute('aria-expanded', 'false');
    r.btnLabel = el('span', 'cp-route-label');
    const chev = el('span', 'cp-route-chev');
    chev.innerHTML = host.ICONS.chevDown;
    r.btn.append(r.btnLabel, chev);
    r.menu = el('div', 'cp-menu');
    r.menu.setAttribute('role', 'menu');
    r.menu.setAttribute('aria-label', '派给谁');
    r.menu.hidden = true;
    r.items = options.map((o) => {
      const item = el('button', 'cp-menu-item');
      item.type = 'button';
      item.dataset.route = o.id || 'captain';
      item.setAttribute('role', 'menuitemradio');
      const check = el('span', 'cp-menu-check');
      check.innerHTML = host.ICONS.check;
      const text = el('span', 'cp-menu-text');
      text.append(el('span', 'cp-menu-label', o.label), el('span', 'cp-menu-detail', o.detail));
      item.append(check, text);
      item.addEventListener('click', () => { setRoute(col.id, o.id); closeRouteMenu(r, true); });
      r.menu.appendChild(item);
      return item;
    });
    // the notice sits on top of the composer box for as long as the web route is chosen
    r.note = el('div', 'cp-web-note');
    r.note.setAttribute('role', 'note');
    r.note.hidden = true;
    const icon = el('span', 'cp-web-icon');
    icon.innerHTML = host.ICONS.globe;
    const body = el('div', 'cp-web-body');
    r.busy = el('span', 'cp-web-busy');
    body.append(el('span', 'cp-web-warn', W.PUBLIC_NOTICE), el('span', 'cp-web-why', W.NO_SEAT_NOTE), r.busy);
    const back = svgButton('cp-web-close', 'close', '改回交给队长');
    back.addEventListener('click', () => { setRoute(col.id, ''); views.get(col.id)?.ta.focus(); });
    r.note.append(icon, body, back);
    r.attach = attach;
    bar.insertBefore(r.btn, attach.nextSibling);
    bar.appendChild(r.menu);
    r.btn.addEventListener('click', () => (r.menu.hidden ? openRouteMenu(r) : closeRouteMenu(r, true)));
    r.menu.addEventListener('keydown', (e) => {
      const at = r.items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRouteMenu(r, true); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        r.items[(at + (e.key === 'ArrowDown' ? 1 : r.items.length - 1)) % r.items.length].focus();
      } else if (e.key === 'Tab') closeRouteMenu(r, false);
    });
    document.addEventListener('mousedown', (e) => { if (!r.menu.hidden && !r.menu.contains(e.target) && !r.btn.contains(e.target)) closeRouteMenu(r, false); });
    return r;
  }
  function openRouteMenu(r) {
    r.menu.hidden = false;
    r.btn.setAttribute('aria-expanded', 'true');
    (r.items.find((i) => i.getAttribute('aria-checked') === 'true') || r.items[0]).focus();
  }
  function closeRouteMenu(r, refocus) {
    r.menu.hidden = true;
    r.btn.setAttribute('aria-expanded', 'false');
    if (refocus) r.btn.focus();
  }
  function setRoute(id, mode) {
    const v = views.get(id);
    if (!v || !v.route) return;
    v.route.mode = mode;
    syncRoute(v);
  }
  // Also called when a task card changes, so the 排队 line follows the web queue.
  function syncRoute(v) {
    const r = v.route, W = window.ChatGPTWebCore;
    if (!r) return;
    const web = !!r.mode;
    r.btnLabel.textContent = web ? W.LABEL + ' · ' + W.modeLabel(r.mode) : '派给：队长';
    r.btn.title = web ? '这条会派给' + W.LABEL + '（' + W.modeLabel(r.mode) + '），点这里改' : '选择派给谁：队长，或' + W.LABEL;
    r.btn.setAttribute('aria-label', r.btn.title);
    r.btn.classList.toggle('web', web);
    r.items.forEach((i) => i.setAttribute('aria-checked', String(i.dataset.route === (r.mode || 'captain'))));
    r.note.hidden = !web;
    const busy = web ? W.busyCount(window.MainSession.state()?.tasks, host.columns()) : 0;
    r.busy.textContent = busy ? `现在有 ${busy} 件网页调研在跑，这件会排队，轮到它才发出去。` : '';
    r.busy.hidden = !busy;
    // no files on this route: the page only gets the text of the question
    r.attach.disabled = web;
    r.attach.title = web ? '网页调研只发文字问题，不能带文件' : '添加文件（会插入路径）';
    r.attach.setAttribute('aria-label', r.attach.title);
    v.agent.hidden = web;
    v.send.title = web ? '派给' + W.LABEL + ' (Enter)' : '发送 (Enter)';
    v.send.setAttribute('aria-label', v.send.title);
    v.ta.placeholder = web ? '写下要公开调研的问题，Enter 派给' + W.LABEL + '…' : '告诉队长要做什么，一次说几件也行…';
  }
  function submitWeb(v) {
    const r = v.route, text = v.ta.value.replace(/\s+$/, '');
    if (!text.trim() || r.sending) return;
    if (v.atts.length) { host.showToast('网页调研只发文字问题，先移除附件再派。'); return; }
    r.sending = true;
    window.MainSession.dispatchWeb(text, r.mode).then((done) => {
      host.showToast(done.result);
      if (v.ta.value.replace(/\s+$/, '') === text) { v.ta.value = ''; v.hist = -1; autosize(v.ta); }
      r.mode = '';   // one request per choice: the next message goes to 队长 again
    }, (err) => host.showToast(err && err.message ? err.message : '没有派出去，请再试一次。'))
      .finally(() => { r.sending = false; syncRoute(v); });
  }
  function submit(col) {
    const v = views.get(col.id);
    if (v.route && v.route.mode) { submitWeb(v); return; }
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
  // No length limit: a prompt longer than MainCore.LONG_PROMPT is saved as a .txt
  // file and the agent gets its opening plus "read this file first". Only the
  // Captain briefing passes a larger opts.inlineLimit.
  // A pasted image path is read by the agent before it accepts Enter; a big image takes a few seconds.
  const PASTE_READ_MAX = 30_000;
  // An Enter can be lost while the TUI is busy (a resumed long conversation still drawing): the
  // instruction then sits in the input box and the task reads as finished without a receipt.
  // Look again once the screen is quiet. AgentDeck's own text still in the box gets one more
  // Enter, noted in the diagnostic log without the text. Never a second retry, never into a
  // menu, never while the user is typing.
  const SUBMIT_LOOK = 2500, SUBMIT_QUIET = 1500, SUBMIT_GIVE_UP = 15_000;
  function watchSubmission(col, entry, text) {
    const enterAt = Date.now();
    let seen = null, seenSince = 0;
    const look = () => {
      if (host.terms.get(col.id) !== entry || !entry.alive || entry.state === 'input' || entry.sendingPrompt) return;
      const screen = host.dumpScreen(entry.term, 80);
      if (!C.promptLeftInBox(screen, text)) return;
      // Quiet: no output, or a screen standing still. An idle Claude Code keeps writing a cursor-position
      // query (ESC[?6n) about every 200 ms, which refreshes lastOutputAt; a working one changes its screen.
      if (screen !== seen) { seen = screen; seenSince = Date.now(); }
      if (Date.now() - (entry.lastOutputAt || 0) < SUBMIT_QUIET && (Date.now() - seenSince < SUBMIT_QUIET || entry.state === 'working')) {
        if (Date.now() - enterAt < SUBMIT_GIVE_UP) setTimeout(look, 500);
        return;
      }
      if (host.userComposing(col.id, text)) return;
      window.deck.ptyInput(col.id, '\r');
      window.deck.stateDebug({ id: col.id, prev: 'sent', st: 'enter-again', hasWorked: true, skip: 'instruction still in the input box', title: '' });
    };
    setTimeout(look, SUBMIT_LOOK);
  }
  async function sendPrompt(col, prompt, atts, opts) {
    const o = opts || {};
    if (o.cancelled && o.cancelled()) return false;
    const entry = host.terms.get(col.id);
    if (!entry || !entry.alive) { host.showToast(entry ? '这个终端已经退出了' : '终端还在启动，稍等一下'); return false; }
    if (o.requireIdle && (window.MainCore.workingForSend(entry) || entry.state === 'input' || entry.state === 'quota' || window.MainCore.terminalActivity(entry.lastScreen, col.cmd))) return false;
    if (prompt && prompt.length > (o.inlineLimit || window.MainCore.LONG_PROMPT)) return sendLong(col, prompt, atts, o);
    // No bracketed paste: the terminal reads line by line and the tty drops what a line holds past
    // ~1 KB. A line that long goes out as a file with a one-line pointer, never cut short.
    const lineMode = !(entry.term.modes && entry.term.modes.bracketedPasteMode);
    if (prompt && lineMode && C.longestLineBytes((o.prefix || '') + (atts || []).map(host.shellQuote).join(' ') + ' ' + prompt + (o.suffix || '')) > C.LINE_MODE_BYTES) return sendLong(col, prompt, atts, o);
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
      // Windows: the paste reaches the agent through ConPTY 0.1-0.5s after it is written
      // (measured on Windows 11), so the minimum wait alone can end before the agent has it.
      // Wait until it has drawn something since the paste, within the same 3s.
      const viaConpty = host.platform === 'win32';
      do {
        await new Promise((resolve) => setTimeout(resolve, bracketed ? 50 : 60));
        if (host.terms.get(col.id) !== entry || !entry.alive || (o.cancelled && o.cancelled())) return false;
      } while (bracketed && (Date.now() - pastedAt < minWait || (Date.now() - (entry.lastOutputAt || 0) < 200 && Date.now() - pastedAt < 3000)
        || (viaConpty && (entry.lastOutputAt || 0) <= pastedAt && Date.now() - pastedAt < 3000)
        || (Date.now() - pastedAt < PASTE_READ_MAX && C.pasteBusy(host.dumpScreen(entry.term, 6)))));
      if (!o.silent && window.MainSession) window.MainSession.onContextCommandSent(col, text);
      window.deck.ptyInput(col.id, '\r');
      watchSubmission(col, entry, text);
      host.manualPromptSent(col.id, turn, o.userInitiated === true);
      entry.state = 'working';
      entry.backgroundOnly = false;   // the turn just sent is real work, until the next status tick says otherwise
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
  // A terminal without bracketed paste reads line by line, so there the pointer is one line that fits the tty limit.
  function sendLong(col, prompt, atts, o) {
    return window.deck.saveLongPrompt(prompt).then((file) => {
      if (!file) { host.showToast('长消息存文件失败，没有发送'); return false; }
      const note = `（这条消息共 ${prompt.length} 字，完整内容已存成文件，请先完整读取再照做：${file}）`;
      const opening = prompt.slice(0, 300).replace(/\s+/g, ' ').trim();
      const entry = host.terms.get(col.id);
      let pointer = `${opening}…\n${note}`;
      if (entry && !(entry.term.modes && entry.term.modes.bracketedPasteMode)) {
        // only what shares the pointer's line counts: the end of the prefix and the start of the suffix
        const fixed = String(o.prefix || '').split(/\r?\n|\r/).at(-1) + (atts || []).map(host.shellQuote).join(' ') + String(o.suffix || '').split(/\r?\n|\r/)[0] + note + '… ';
        const fitting = C.clipBytes(opening, C.LINE_MODE_BYTES - C.utf8Length(fixed));
        pointer = (fitting ? fitting + '…' : '') + note;
      }
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
    if (!e.target.closest('.chat-scroll, .chat-attn, .composer, .tui-footer, .view-toggle, .dlv, .dlv-toggle')) focusInput(col.id);
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
    views.get(id)?.clips.disconnect();
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
    views.forEach((v) => v.clips.disconnect());
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
    if (views.get(id)?.route?.mode) syncRoute(views.get(id));
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
      syncRuns(v);
      followOutput(v);
    }
    scheduleSave(id);
    if (window.Pages) window.Pages.refresh();
    if (window.ChatDeliverables) window.ChatDeliverables.refresh();
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
    // the 队长's conversations from before each context clear are searched too
    const retired = captainArchives().map((c) => ({ colId: c.id, title: '清空前的队长对话', turns: c.turns }));
    const retiredIds = new Set(retired.map((c) => c.colId));
    const hits = C.searchChats([...artifactSources(), ...retired], q);
    if (!hits.length) { nav.results.appendChild(el('div', 'nr-empty', '没有匹配的对话')); return; }
    hits.forEach((h) => {
      const item = el('button', 'nr-item');
      item.type = 'button';
      const head = el('div', 'nr-head');
      head.append(el('span', 'nr-title', h.title), el('span', 'nr-role', h.role === 'user' ? '我' : h.role === 'reply' ? '回复' : '标题'));
      if (archivedIds.has(h.colId)) head.appendChild(el('span', 'nr-role', '已归档'));
      if (retiredIds.has(h.colId)) head.appendChild(el('span', 'nr-role', '只读'));
      const body = el('div', 'nr-snippet');
      const mark = el('mark', null, h.match);
      body.append(h.before, mark, h.after);
      item.append(head, body);
      item.addEventListener('click', () => reveal(h.colId, h.turnId, h.role));
      nav.results.appendChild(item);
    });
  }
  // A hit from before a context clear opens in the 队长 column's read-only history.
  function revealRetired(chatId, turnId, role) {
    const col = host.columns().find((c) => c.isMain);
    const v = col && views.get(col.id);
    // they are shown only in the 队长 column: without one, the click says so instead of doing nothing
    if (!v) { host.showToast('这是清空前的队长对话，要在队长那一列里看；现在没有队长，建好队长后再点这条。'); return; }
    host.jumpToColumn(col);
    if (modeOf(col) !== 'chat') setMode(col.id, 'chat');
    v.showRetired = true;
    v.retiredHit = { chatId, turnId, role };
    renderChat(col.id, true);
  }
  function reveal(colId, turnId, role) {
    if (!columnById(colId) && chats.has(colId) && chats.get(colId).captainArchive) { revealRetired(colId, turnId, role); return; }
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
        showCard(v, row.user);
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
    // one column that cannot be drawn leaves the others, the sidebar and Artifacts alone
    views.forEach((v, id) => { try { renderChat(id); } catch (error) { console.error('对话显示失败：', error); } });
    if (nav.input.value.trim()) runSearch();
    if (window.Sidebar) window.Sidebar.render();
    if (window.ChatDeliverables) window.ChatDeliverables.refresh();
  }

  window.ChatUI = {
    init, mountColumn, isChatMode, focusInput, setMode, toggleGlobalMode, onSubmitted, noteSent, sendPrompt,
    onTick, onExit, onColumnMouseDown, onColumnRemoved, onColumnArchived, deleteArchivedChat, onColumnIdChanged, onRender,
    focusSearch, reveal, lastTurnTs, artifactSources, readFooter,
    isLoaded: () => loaded,
    hasDraft: (id) => { const v = views.get(id); return !!v && (!!v.ta.value || v.atts.length > 0); },
    attach: (id, path) => { const v = views.get(id); if (v) addAttachment(v, path); },
    attachmentChip: (path, colId) => attachmentChip(path, colId, null),
    addCard, addNotice, updateCard, retireChat, snapshotForHandoff, turnsOf, captainArchives, captainSnapshot, archiveCaptainSnapshot,

  };
})();
