// The right-hand pane: file/link preview, the column's real terminal, and an
// embedded browser. Plain script, no module system, so it can sit next to
// renderer.js; everything it needs from the deck comes in through init().
(function () {
  'use strict';
  const C = window.ChatCore;
  const Themes = window.PreviewThemes;
  let host = null;
  const side = { open: false, tab: 'preview', width: 460, mdTheme: Themes.DEFAULT };
  let pane, tabsEl, pages, pvHead, pvBody, stTitle, stBody, sbUrl, sbView, sbEmpty, sbBack, sbFwd, sbReload;
  let preview = null;        // last preview result
  let mdSource = false;      // markdown or a web page shown as source instead of rendered
  let pageOpen = false;      // a previewed web page is running in its own view
  let pageAlone = false;     // … and was given only its own file (it lies in a catch-all folder)
  let renderSeq = 0;         // pictures of an older render must not land in a newer one
  let themeMenu = null;
  let previewColId = null;
  let termId = null;         // column whose terminal currently lives in the pane
  let loading = false;

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, title, onClick, cls) {
    const b = el('button', cls || 'pv-btn', label);
    b.type = 'button'; b.title = title || ''; b.addEventListener('click', onClick);
    return b;
  }
  function iconButton(icon, title, onClick) {
    const b = button('', title, onClick, 'icon-btn');
    b.innerHTML = host.ICONS[icon]; b.setAttribute('aria-label', title);
    return b;
  }

  function init(h) {
    host = h;
    pane = $('sidePane'); tabsEl = $('sideTabs');
    pages = { preview: $('sidePreview'), terminal: $('sideTerminal'), browser: $('sideBrowser') };
    pvHead = $('pvHead'); pvBody = $('pvBody'); stTitle = $('stTitle'); stBody = $('stBody');
    sbUrl = $('sbUrl'); sbView = $('sbView'); sbEmpty = $('sbEmpty');
    sbBack = $('sbBack'); sbFwd = $('sbFwd'); sbReload = $('sbReload');

    const saved = host.config.side || {};
    if (saved.tab && pages[saved.tab]) side.tab = saved.tab;
    if (Number.isFinite(saved.width)) side.width = Math.max(300, Math.min(900, saved.width));
    side.open = !!saved.open;
    side.mdTheme = Themes.normalize(saved.mdTheme);
    // the themes' colours, one rule per theme for the light deck and one for the dark
    const colours = el('style'); colours.id = 'pvThemeColours'; colours.textContent = Themes.sheet();
    document.head.appendChild(colours);

    const tabIcons = { preview: 'eye', terminal: 'terminal', browser: 'globe' };
    tabsEl.querySelectorAll('.side-tab').forEach((t) => {
      const ico = el('span', 'ico');
      ico.innerHTML = host.ICONS[tabIcons[t.dataset.tab]] || '';
      t.prepend(ico);
    });
    $('sideClose').innerHTML = host.ICONS.panelRight;
    $('sideClose').title = '收起右侧栏 (⌘\\)';
    $('sideClose').setAttribute('aria-label', $('sideClose').title);
    sbBack.innerHTML = host.ICONS.left;
    sbFwd.innerHTML = host.ICONS.right;

    tabsEl.addEventListener('click', (e) => {
      const tab = e.target.closest('.side-tab');
      if (tab) show(tab.dataset.tab, true);
    });
    $('sideClose').addEventListener('click', () => hide());
    attachResize($('sideResizer'));

    sbBack.addEventListener('click', () => window.deck.sideBrowserAction('back'));
    sbFwd.addEventListener('click', () => window.deck.sideBrowserAction('forward'));
    sbReload.addEventListener('click', () => window.deck.sideBrowserAction(loading ? 'stop' : 'reload'));
    $('sbExternal').addEventListener('click', () => { if (/^https?:/i.test(sbUrl.value)) window.deck.openExternal(sbUrl.value); });
    sbUrl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const url = normalizeUrl(sbUrl.value);
      if (url) openBrowser(url);
    });
    window.deck.onBrowserState((s) => {
      loading = !!s.loading;
      if (document.activeElement !== sbUrl && s.url) sbUrl.value = s.url;
      sbBack.disabled = !s.canGoBack; sbFwd.disabled = !s.canGoForward;
      sbReload.textContent = loading ? '✕' : '⟳';
      sbReload.title = loading ? '停止加载' : '刷新'; sbReload.setAttribute('aria-label', sbReload.title);
      sbEmpty.hidden = !!s.url;
    });

    // The native browser view floats above the page, so it has to follow the
    // placeholder's rectangle and step aside whenever a dialog is open.
    new ResizeObserver(() => syncBounds()).observe(sbView);
    new ResizeObserver(() => syncBounds()).observe(pvBody);
    // a web link clicked inside a previewed page opens in the browser tab
    window.deck.onPreviewLink((m) => { if (pageOpen && m && /^https?:/i.test(m.url)) openBrowser(m.url); });
    window.deck.onPreviewState((m) => {
      pageAlone = !!(m && m.alone);
      const note = pvBody.querySelector('.pv-web-note');
      if (note) { note.hidden = !pageAlone; requestAnimationFrame(syncBounds); }
    });
    document.addEventListener('mousedown', (e) => { if (themeMenu && !e.target.closest('.pv-theme')) closeThemeMenu(); });
    // its size can stay the same while it moves (sidebar collapse, page zoom)
    new ResizeObserver(() => syncBounds()).observe(document.getElementById('center'));
    window.addEventListener('resize', () => syncBounds());
    new MutationObserver(() => syncBounds()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    apply(false);
  }

  function normalizeUrl(value) {
    const v = value.trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return v;
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(v)) return 'http://' + v;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v)) return 'https://' + v;
    return 'https://www.google.com/search?q=' + encodeURIComponent(v);
  }

  // ---- open / close ----
  function persist() {
    host.config.side = { open: side.open, tab: side.tab, width: side.width, mdTheme: side.mdTheme };
    host.saveConfig();
  }
  function apply(relayout = true) {
    const visible = side.open && host.activeView() !== 'board';
    pane.hidden = !visible;
    pane.style.flex = '0 0 ' + side.width + 'px';
    pane.style.width = side.width + 'px';
    tabsEl.querySelectorAll('.side-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === side.tab));
    Object.entries(pages).forEach(([name, page]) => { page.hidden = name !== side.tab; });
    syncTerminal();
    requestAnimationFrame(syncBounds);
    if (relayout) host.layout();
  }
  function show(tab, focusTerminal) {
    side.open = true;
    if (tab) side.tab = tab;
    persist(); apply();
    if (tab === 'terminal' && focusTerminal) focusSideTerminal();
  }
  function hide() { side.open = false; persist(); apply(); }
  function toggle() { if (side.open) hide(); else show(); }

  function attachResize(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = side.width;
      document.body.classList.add('resizing');
      window.deck.sideBrowserBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
      window.deck.sidePreviewBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
      const move = (ev) => {
        side.width = Math.max(300, Math.min(Math.floor(window.innerWidth * 0.7), startW - (ev.clientX - startX)));
        pane.style.flex = '0 0 ' + side.width + 'px';
        pane.style.width = side.width + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('resizing');
        persist(); host.layout(); syncBounds();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ---- browser tab ----
  function syncBounds() {
    if (!host) return;
    const shown = side.open && host.activeView() !== 'board' && !document.querySelector('dialog[open]');
    const r = sbView.getBoundingClientRect();
    window.deck.sideBrowserBounds({ x: r.left, y: r.top, width: r.width, height: r.height, visible: shown && side.tab === 'browser' });
    const web = pageOpen && pvBody.querySelector('.pv-web');
    if (!web) return;
    const w = web.getBoundingClientRect();
    window.deck.sidePreviewBounds({ x: w.left, y: w.top, width: w.width, height: w.height, visible: shown && side.tab === 'preview' });
  }
  function openBrowser(url) {
    show('browser');
    sbUrl.value = url;
    window.deck.sideBrowserOpen(url);
    requestAnimationFrame(syncBounds);
  }

  // ---- links from terminal output and chat bubbles ----
  // Plain click previews on the right; Cmd/Ctrl click, Option click keep the
  // old behaviours (system browser, Finder, editor).
  function openLink(m, event, colId, cont) {
    const mod = event && (event.metaKey || event.ctrlKey);
    if (m.kind === 'url') {
      if (mod) window.deck.openExternal(m.text); else openBrowser(m.text);
      return;
    }
    if (event && event.altKey) { window.deck.openInEditor(m.text, colId, cont); return; }
    if (mod) { window.deck.revealPath(m.text, colId, cont); return; }
    openPreview(m.text, colId, cont);
  }

  async function openPreview(raw, colId, cont) {
    let res;
    try { res = await window.deck.previewRead(raw, colId, cont); } catch (_) { res = { ok: false, error: '无法读取该文件' }; }
    if (!res || !res.ok) { host.showToast((res && res.error) || '无法预览'); return; }
    previewColId = colId || null;
    if (res.kind === 'pdf') {
      window.deck.sideBrowserPdf(raw, colId, cont);
      show('browser');
      sbUrl.value = res.path;
      return;
    }
    preview = res; mdSource = false;
    renderPreview();
    show('preview');
  }

  // ---- preview tab ----
  function joinPath(dir, name) {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  function parentPath(p) {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return cut > 0 ? p.slice(0, cut) : p;
  }
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // The page view is ended whenever something else takes the preview's place.
  function closePage() {
    if (!pageOpen) return;
    pageOpen = false; pageAlone = false;
    window.deck.sidePreviewAction('close');
  }
  function renderPreview() {
    closeThemeMenu();
    pvHead.textContent = ''; pvBody.textContent = '';
    pvBody.classList.remove('pv-web-mode');
    renderSeq++;
    const r = preview;
    const asPage = !!r && r.kind === 'html' && !mdSource;
    if (!asPage) closePage();
    if (!r) { pvBody.appendChild(el('div', 'pv-empty', '点聊天里的文件路径或链接，会在这里预览。')); return; }
    const title = el('div', 'pv-title');
    title.append(el('strong', null, r.name || r.path), el('span', 'pv-path', '\u200e' + r.path + '\u200e'));
    title.title = r.path;
    pvHead.appendChild(title);
    const actions = el('div', 'pv-actions');
    if (r.kind === 'markdown' || r.kind === 'html') {
      const shown = r.kind === 'html' ? '网页' : '排版';
      const flip = iconButton(mdSource ? 'eye' : 'code', mdSource ? '看' + shown : '看源码', () => { mdSource = !mdSource; renderPreview(); });
      flip.classList.add('pv-flip');
      actions.appendChild(flip);
    }
    if (asPage) actions.appendChild(iconButton('refresh', '重新加载网页', () => window.deck.sidePreviewAction('reload')));
    if (r.kind === 'markdown' && !mdSource) actions.appendChild(themePicker());
    const copy = iconButton('copy', '复制路径', () => {
      try { host.clipboardWrite(r.path); } catch (_) { host.showToast('没能复制到剪贴板'); return; }
      copy.innerHTML = host.ICONS.check; copy.classList.add('done');
      clearTimeout(copy.checkTimer);
      copy.checkTimer = setTimeout(() => { copy.innerHTML = host.ICONS.copy; copy.classList.remove('done'); }, 1200);
    });
    actions.appendChild(copy);
    actions.appendChild(iconButton('folderOpen', host.platform === 'win32' ? '在资源管理器中显示' : host.platform === 'darwin' ? '在访达中显示' : '在文件管理器中显示', () => window.deck.revealPath(r.path, previewColId)));
    if (r.kind !== 'dir') actions.appendChild(iconButton('edit', '用编辑器打开', () => window.deck.openInEditor(r.line ? r.path + ':' + r.line : r.path, previewColId)));
    pvHead.appendChild(actions);

    if (r.kind === 'dir') {
      const list = el('div', 'pv-dir');
      if (parentPath(r.path) !== r.path) list.appendChild(dirRow('..', true, parentPath(r.path)));
      r.entries.forEach((e) => list.appendChild(dirRow(e.name, e.dir, joinPath(r.path, e.name))));
      pvBody.appendChild(list);
    } else if (r.kind === 'image') {
      const img = el('img', 'pv-image');
      img.src = r.dataUrl; img.alt = r.name;
      img.addEventListener('click', () => img.classList.toggle('actual'));
      pvBody.appendChild(img);
    } else if (asPage) {
      // The page itself is drawn by a separate sandboxed view that the main
      // process lays over this placeholder; nothing of it is in this document.
      pvBody.classList.add('pv-web-mode');
      pageAlone = false;      // the main process says so again for this page
      const note = el('div', 'pv-note pv-web-note', '这个网页放在一个什么都有的文件夹里（比如桌面、下载、主目录），为了安全只加载了它自己，旁边的图片和脚本没有加载。把它放进单独的文件夹就能完整显示。');
      note.hidden = !pageAlone;
      const web = el('div', 'pv-web');
      web.setAttribute('aria-label', '网页预览：' + r.name);
      pvBody.append(note, web);
      pageOpen = true;
      window.deck.sidePreviewHtml(r.path, previewColId);
      requestAnimationFrame(syncBounds);
    } else if (r.kind === 'markdown' && !mdSource) {
      pvBody.appendChild(markdownView(r));
    } else if (r.kind === 'text' || r.kind === 'markdown' || r.kind === 'html') {
      pvBody.appendChild(codeView(r));
    } else {
      const why = r.kind === 'toolarge' ? '文件太大，不在这里预览。' : '这是二进制文件，不能预览。';
      pvBody.appendChild(el('div', 'pv-empty', why + (r.size ? ' (' + formatSize(r.size) + ')' : '')));
    }
    if (r.truncated && !asPage) pvBody.appendChild(el('div', 'pv-note', '文件较大，只显示了前 1 MB。'));
  }

  // ---- Markdown reading view ----
  const MAX_PICTURES = 30;
  function markdownView(r) {
    const md = el('div', 'pv-md');
    md.dataset.mdTheme = side.mdTheme;
    md.innerHTML = C.renderMarkdown(r.text, { rich: true, links: true });
    const folder = parentPath(r.path);
    md.addEventListener('click', (e) => {
      const note = e.target.closest('.md-fn');
      if (note) {
        const target = md.querySelector('.md-footnotes li[data-fn="' + note.dataset.fn + '"]');
        if (!target) return;
        md.querySelectorAll('.md-fn-hit').forEach((n) => n.classList.remove('md-fn-hit'));
        target.classList.add('md-fn-hit');
        target.scrollIntoView({ block: 'center' });
        return;
      }
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.hasAttribute('data-ext')) { openBrowser(a.getAttribute('href')); return; }
      const file = a.getAttribute('data-file');
      if (!file) return;
      // a link written relative to the note is read against the note's folder
      const target = a.hasAttribute('data-rel') ? window.HubCore.resolvePath(folder, decoded(file)) : file;
      if (target) openPreview(a.dataset.line ? target + ':' + a.dataset.line : target, previewColId);
    });
    loadPictures(md, folder);
    return md;
  }
  function decoded(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }
  // Pictures lying next to the note. Each one is read by the main process like
  // any clicked path, a few at a time, and only for the render still on screen.
  async function loadPictures(md, folder) {
    const seq = renderSeq;
    const imgs = [...md.querySelectorAll('img.md-img[data-src]')];
    imgs.slice(MAX_PICTURES).forEach((img) => { img.dataset.missing = '1'; });
    for (const img of imgs.slice(0, MAX_PICTURES)) {
      const target = window.HubCore.resolvePath(folder, decoded(img.dataset.src));
      let res = null;
      try { res = target ? await window.deck.previewRead(target, previewColId) : null; } catch (_) {}
      if (seq !== renderSeq) return;
      if (res && res.ok && res.kind === 'image' && res.dataUrl) img.src = res.dataUrl; else img.dataset.missing = '1';
    }
  }

  // ---- theme picker ----
  function themePicker() {
    const wrap = el('div', 'pv-theme');
    const btn = iconButton('palette', '换阅读主题', () => { if (themeMenu) closeThemeMenu(); else openThemeMenu(wrap, btn); });
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.classList.add('pv-theme-btn');
    wrap.appendChild(btn);
    return wrap;
  }
  function openThemeMenu(wrap, btn) {
    const mode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const menu = el('div', 'pv-theme-menu');
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '阅读主题');
    Themes.THEMES.forEach((t) => {
      const c = t[mode];
      const item = el('button', 'pv-theme-item');
      item.type = 'button'; item.dataset.theme = t.id; item.title = t.hint;
      item.setAttribute('role', 'menuitemradio');
      const swatch = el('span', 'pv-theme-swatch');
      swatch.style.background = c.bg; swatch.style.borderColor = c.border;
      [c.h1, c.h2, c.h3, c.link, c.code].forEach((colour) => { const dot = el('i'); dot.style.background = colour; swatch.appendChild(dot); });
      const tick = el('span', 'pv-theme-tick'); tick.innerHTML = host.ICONS.check;
      item.append(swatch, el('span', 'pv-theme-name', t.name), tick);
      item.addEventListener('click', () => setTheme(t.id));
      menu.appendChild(item);
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.pv-theme-item')], at = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeThemeMenu(); btn.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    });
    wrap.appendChild(menu);
    themeMenu = menu;
    btn.setAttribute('aria-expanded', 'true');
    markTheme();
    (menu.querySelector('[aria-checked="true"]') || menu.firstChild).focus();
  }
  function closeThemeMenu() {
    if (!themeMenu) return;
    const btn = themeMenu.parentElement && themeMenu.parentElement.querySelector('.pv-theme-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    themeMenu.remove(); themeMenu = null;
  }
  function markTheme() {
    if (themeMenu) themeMenu.querySelectorAll('.pv-theme-item').forEach((item) => item.setAttribute('aria-checked', String(item.dataset.theme === side.mdTheme)));
  }
  // One click changes the note on screen and is remembered; the list stays open to try the next one.
  function setTheme(id) {
    side.mdTheme = Themes.normalize(id);
    const md = pvBody.querySelector('.pv-md');
    if (md) md.dataset.mdTheme = side.mdTheme;
    markTheme();
    persist();
  }
  function dirRow(name, isDir, target) {
    const row = el('button', 'pv-dir-row');
    row.type = 'button';
    row.append(el('span', 'pv-dir-icon', isDir ? '▸' : '·'), el('span', null, isDir && name !== '..' ? name + '/' : name));
    row.addEventListener('click', () => openPreview(target, previewColId));
    return row;
  }
  function codeView(r) {
    const wrap = el('div', 'pv-code');
    const total = r.text.split('\n').length;
    const gutter = el('pre', 'pv-gutter', Array.from({ length: total }, (_, i) => i + 1).join('\n'));
    const src = el('pre', 'pv-src');
    src.innerHTML = C.highlightCode(r.text, r.kind === 'markdown' ? 'plain' : r.lang);
    wrap.append(gutter, src);
    if (r.line > 0 && r.line <= total) {
      const hl = el('div', 'pv-hl');
      hl.style.top = 'calc(var(--pv-pad) + ' + (r.line - 1) + ' * var(--pv-lh))';
      wrap.appendChild(hl);
      requestAnimationFrame(() => { pvBody.scrollTop = Math.max(0, (r.line - 6) * 18); });
    }
    return wrap;
  }

  // ---- terminal tab ----
  function restoreTerminal() {
    if (!termId) return;
    const entry = host.terms.get(termId);
    if (entry && entry.wrap && entry.wrap.isConnected && entry.el.parentElement === stBody) {
      entry.wrap.insertBefore(entry.el, entry.wrap.querySelector('.resizer') || null);
      requestAnimationFrame(() => { try { entry.fit.fit(); } catch (_) {} });
    }
    termId = null;
  }
  function terminalHint(text, withButton) {
    // called on every tick: rebuild only when the message actually changes
    const key = text + (withButton ? host.focusedId() : '');
    if (stBody.dataset.hint === key) return;
    stBody.dataset.hint = key;
    stTitle.textContent = '';
    stBody.textContent = '';
    const box = el('div', 'pv-empty', text);
    if (withButton) {
      const id = host.focusedId();
      box.appendChild(el('br'));
      box.appendChild(button('切到对话视图', '', () => { host.setMode(id, 'chat'); syncTerminal(); }, 'pv-btn solid'));
    }
    stBody.appendChild(box);
  }
  function syncTerminal() {
    if (!host) return;
    if (!(side.open && side.tab === 'terminal') || host.activeView() === 'board') { restoreTerminal(); return; }
    const id = host.focusedId();
    const entry = id && host.terms.get(id);
    const col = id && host.columns().find((c) => c.id === id);
    if (!entry || !col) { restoreTerminal(); terminalHint('点一下左边的对话，这里就会显示它的终端。'); return; }
    if (!host.isChatMode(id)) { restoreTerminal(); terminalHint('这一列现在就是终端视图，终端在列里。', true); return; }
    if (termId === id && entry.el.parentElement === stBody) return;
    restoreTerminal();
    stTitle.textContent = host.columnLabel(col) + ' · 终端';
    delete stBody.dataset.hint;
    stBody.textContent = '';
    stBody.appendChild(entry.el);
    termId = id;
    requestAnimationFrame(() => { try { entry.fit.fit(); } catch (_) {} });
  }
  function focusSideTerminal() {
    const entry = termId && host.terms.get(termId);
    if (entry) entry.term.focus();
  }

  window.SidePane = {
    init, show, hide, toggle, openLink, openPreview, openBrowser,
    syncTerminal, restoreTerminal, syncBounds,
    onFocusChange: () => syncTerminal(),
    onViewChange: () => { if (!host) return; restoreTerminal(); apply(); },
    isOpen: () => side.open,
    holdsTerminalOf: (id) => termId === id,
  };
})();
