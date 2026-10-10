// The right-hand pane: file/link preview, the column's real terminal, and an
// embedded browser. Plain script, no module system, so it can sit next to
// renderer.js; everything it needs from the deck comes in through init().
(function () {
  'use strict';
  const C = window.ChatCore;
  const Themes = window.PreviewThemes;
  const R = window.PreviewReader;
  let host = null;
  const side = { open: false, tab: 'preview', width: 460, mdTheme: Themes.DEFAULT, outline: true };
  let pane, tabsEl, pages, pvHead, pvBody, pvMain, pvOutline, pvFind, stTitle, stBody, sbUrl, sbView, sbEmpty, sbBack, sbFwd, sbReload;
  let preview = null;        // last preview result
  let asked = null;          // { raw, colId, cont }: how it was opened, to read it again when it changes
  let watchId = 0;           // the main process's number for the file being watched
  let gone = false;          // the file could not be read again: the last text stays, the head says so
  let mdSource = false;      // markdown or a web page shown as source instead of rendered
  let pageOpen = false;      // a previewed web page is running in its own view
  let pageAlone = false;     // … and was given only its own file (it lies in a catch-all folder)
  let renderSeq = 0;         // pictures of an older render must not land in a newer one
  let themeMenu = null;
  let previewColId = null;
  let termId = null;         // column whose terminal currently lives in the pane
  let loading = false;
  let inPreview = false;     // the pointer or the keyboard was last in the preview: ⌘F searches it

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
    pvHead = $('pvHead'); pvBody = $('pvBody'); pvMain = $('pvMain'); pvOutline = $('pvOutline'); pvFind = $('pvFind');
    stTitle = $('stTitle'); stBody = $('stBody');
    sbUrl = $('sbUrl'); sbView = $('sbView'); sbEmpty = $('sbEmpty');
    sbBack = $('sbBack'); sbFwd = $('sbFwd'); sbReload = $('sbReload');

    const saved = host.config.side || {};
    if (saved.tab && pages[saved.tab]) side.tab = saved.tab;
    if (Number.isFinite(saved.width)) side.width = Math.max(300, Math.min(900, saved.width));
    side.open = !!saved.open;
    side.mdTheme = Themes.normalize(saved.mdTheme);
    side.outline = saved.outline !== false;
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
    $('sideClose').title = `收起右侧栏 (${window.AppShortcutsCore.label('sidePane', host.platform === 'darwin')})`;
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
      // the main process did not open this page: say why where it would have been
      if (m && m.refused) {
        const web = pvBody.querySelector('.pv-web');
        if (!web || !pageOpen || !preview || preview.path !== m.path) return;
        pageOpen = false; pageAlone = false;
        web.replaceWith(el('div', 'pv-empty', m.refused === 'big'
          ? '这个网页超过 64 MB，不在这里显示。点上面的源码按钮可以看它的开头。'
          : '这个网页的文件名以 . 开头或带冒号，不能当网址打开，不在这里显示。点上面的源码按钮可以看源码。'));
        return;
      }
      pageAlone = !!(m && m.alone);
      const note = pvBody.querySelector('.pv-web-note');
      if (note) { note.hidden = !pageAlone; requestAnimationFrame(syncBounds); }
    });
    document.addEventListener('mousedown', (e) => {
      if (themeMenu && !e.target.closest('.pv-theme')) closeThemeMenu();
      if (outlinePeek && !e.target.closest('#pvOutline, .pv-outline-btn')) { outlinePeek = false; syncOutline(); }
    });
    // the file on screen changed on disk; ⌘F inside a previewed page; that page's find count
    window.deck.onPreviewChanged((m) => { if (m && m.watch && m.watch === watchId) refreshPreview(); });
    window.deck.onPreviewFindKey(() => { if (pageOpen && side.open && side.tab === 'preview') openFind(); });
    window.deck.onPreviewFound((m) => { if (pageOpen && finder) showCount(Math.max(0, (m.active || 0) - 1), m.total || 0, false, !findInput.value); });
    for (const event of ['pointerdown', 'focusin']) document.addEventListener(event, (e) => { inPreview = !!(e.target.closest && e.target.closest('#sidePreview')); }, true);
    // ahead of the deck's own ⌘F (the conversation or terminal search): the window sees the key first
    window.addEventListener('keydown', (e) => {
      const mod = host.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return;
      const t = e.target;
      if (!(t && t.closest && t.closest('#sidePreview')) && !(inPreview && (t === document.body || t === document.documentElement))) return;
      if (!openFind()) return;
      e.preventDefault(); e.stopPropagation();
    }, true);
    buildFind();
    pvBody.addEventListener('scroll', () => { if (!spyQueued) { spyQueued = true; requestAnimationFrame(() => { spyQueued = false; spy(); }); } }, { passive: true });
    new ResizeObserver(() => syncOutline()).observe(pvMain);
    pvOutline.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !outlinePeek) return;
      e.preventDefault(); e.stopPropagation();
      outlinePeek = false; syncOutline();
      const btn = pvHead.querySelector('.pv-outline-btn');
      if (btn) btn.focus();
    });
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
    host.config.side = { open: side.open, tab: side.tab, width: side.width, mdTheme: side.mdTheme, outline: side.outline };
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
    preview = res; mdSource = false; gone = false;
    const req = asked = { raw, colId: colId || null, cont };
    watchId = 0;
    renderPreview();
    show('preview');
    let id = 0;
    try { id = await window.deck.previewWatch(raw, colId, cont); } catch (_) {}
    if (req === asked) watchId = id;
  }

  // ---- the file changed on disk: show it again where the reader is ----
  let refreshing = null, refreshAgain = false;
  async function refreshPreview() {
    if (refreshing) { refreshAgain = true; return; }
    const req = asked;
    refreshing = (async () => {
      let res = null;
      try { res = await window.deck.previewRead(req.raw, req.colId, req.cont); } catch (_) {}
      if (req !== asked || !preview) return;
      if (!res || !res.ok || res.kind === 'pdf') { setGone(true); return; }
      const wasGone = gone;
      gone = false;
      if (res.kind === 'html' && preview.kind === 'html' && pageOpen) {
        // the page reloads in its own view; the browser keeps its scroll position
        preview = res;
        window.deck.sidePreviewAction('reload');
        setGone(false, wasGone);
        flashFresh();
        return;
      }
      const restore = holdPlace();
      preview = res;
      renderPreview();
      restore();
      flashFresh();
    })();
    try { await refreshing; } finally {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; refreshPreview(); }
    }
  }
  function setGone(value, force) {
    if (gone === value && !force) return;
    gone = value;
    const title = pvHead.querySelector('.pv-title');
    if (!title || !preview) return;
    const line = title.querySelector('.pv-path');
    if (line) line.replaceWith(pathLine(preview));
  }
  function pathLine(r) {
    if (gone) return el('span', 'pv-path pv-gone', '读不到这个文件了（可能被删除或移走），显示的是上次的内容');
    return el('span', 'pv-path', '\u200e' + r.path + '\u200e');
  }
  let freshTimer = 0;
  function flashFresh() {
    const name = pvHead.querySelector('.pv-name');
    if (!name) return;
    let mark = name.querySelector('.pv-fresh');
    if (!mark) { mark = el('span', 'pv-fresh', '已更新'); mark.setAttribute('role', 'status'); name.appendChild(mark); }
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => mark.remove(), 2600);
  }
  // Where the reader is, so a fresh render can be put back there: a note by the block at the top
  // of the view (found again by its text), a code file by its first line in view.
  const lineHeight = () => parseFloat(getComputedStyle(pvBody.querySelector('.pv-code') || pvBody).getPropertyValue('--pv-lh')) || 18;
  const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, pre, tr, blockquote, .md-callout, .md-props, img, hr';
  const blocksIn = (md) => [...md.querySelectorAll(BLOCKS)].filter((n) => n.getClientRects().length);
  const blockKey = (n) => n.tagName + ':' + (n.textContent || n.getAttribute('alt') || '').slice(0, 120);
  function holdPlace() {
    const left = pvBody.scrollLeft, top = pvBody.scrollTop;
    const md = pvBody.querySelector('.pv-md');
    const code = !md && pvBody.querySelector('.pv-code');
    const back = () => { pvBody.scrollTop = top; pvBody.scrollLeft = left; };
    if (md) {
      const view = pvBody.getBoundingClientRect().top;
      const blocks = blocksIn(md), keys = blocks.map(blockKey);
      let at = blocks.findIndex((n) => n.getBoundingClientRect().top >= view - 1);
      // one block reaching from above the view far into it (a long paragraph) is the place itself
      for (let i = (at < 0 ? blocks.length : at) - 1; i >= 0; i--) {
        if (at >= 0 && blocks[at].getBoundingClientRect().top - view < pvBody.clientHeight / 3) break;
        if (blocks[i].getBoundingClientRect().bottom > view) { at = i; break; }
      }
      if (at < 0) return back;
      const offset = blocks[at].getBoundingClientRect().top - view;
      const unfolded = [...md.querySelectorAll('details')].map((d) => d.open);
      const put = () => {
        const fresh = pvBody.querySelector('.pv-md');
        if (!fresh) return back();
        // callouts the reader unfolded stay unfolded
        const folds = fresh.querySelectorAll('details');
        if (folds.length === unfolded.length) folds.forEach((d, i) => { d.open = unfolded[i]; });
        const now = blocksIn(fresh), k = R.relocate(keys, at, now.map(blockKey));
        if (k < 0) return back();
        pvBody.scrollTop += now[k].getBoundingClientRect().top - pvBody.getBoundingClientRect().top - offset;
        pvBody.scrollLeft = left;
      };
      // pictures arrive a moment later and push text down: put it back once more if the reader has not moved
      return () => { put(); const was = pvBody.scrollTop; pictureWait.then(() => { if (pvBody.scrollTop === was) put(); }); };
    }
    if (code && preview && typeof preview.text === 'string') {
      const lh = lineHeight(), at = Math.floor(top / lh), lines = preview.text.split('\n');
      return () => {
        if (!preview || typeof preview.text !== 'string' || !pvBody.querySelector('.pv-code')) return back();
        const k = R.relocate(lines, Math.min(at, lines.length - 1), preview.text.split('\n'));
        pvBody.scrollTop = k < 0 ? top : k * lh + (top - at * lh);
        pvBody.scrollLeft = left;
      };
    }
    return back;
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
    outlineHeads = []; outlinePeek = false;
    const r = preview;
    const asPage = !!r && r.kind === 'html' && !mdSource;
    if (!asPage) closePage();
    const reading = !!r && r.kind === 'markdown' && !mdSource;
    if (reading) pvMain.dataset.mdTheme = side.mdTheme; else delete pvMain.dataset.mdTheme;
    if (!r) { pvBody.appendChild(el('div', 'pv-empty', '点聊天里的文件路径或链接，会在这里预览。')); syncOutline(); return; }
    const title = el('div', 'pv-title');
    const name = el('div', 'pv-name');
    name.appendChild(el('strong', null, r.name || r.path));
    title.append(name, pathLine(r));
    title.title = r.path;
    pvHead.appendChild(title);
    const note = reading ? markdownView(r) : null;
    if (note) buildOutline(note);
    const actions = el('div', 'pv-actions');
    if (r.kind === 'markdown' || r.kind === 'html') {
      const shown = r.kind === 'html' ? '网页' : '排版';
      const flip = iconButton(mdSource ? 'eye' : 'code', mdSource ? '看' + shown : '看源码', () => { mdSource = !mdSource; renderPreview(); });
      flip.classList.add('pv-flip');
      actions.appendChild(flip);
    }
    if (outlineHeads.length) {
      const toc = iconButton('outline', '目录', () => toggleOutline());
      toc.classList.add('pv-outline-btn');
      actions.appendChild(toc);
    }
    if (asPage) actions.appendChild(iconButton('refresh', '重新加载网页', () => window.deck.sidePreviewAction('reload')));
    if (r.kind === 'markdown' && !mdSource) actions.appendChild(themePicker());
    const copy = iconButton('copy', '复制路径', async () => {
      try { await host.clipboardWrite(r.path); } catch (_) { host.showToast('没能复制到剪贴板，请再试一次'); return; }
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
      pictureOpens(img);
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
    } else if (note) {
      pvBody.appendChild(note);
    } else if (r.kind === 'text' || r.kind === 'markdown' || r.kind === 'html') {
      pvBody.appendChild(codeView(r));
    } else {
      const why = r.kind === 'toolarge' ? '文件太大，不在这里预览。' : '这是二进制文件，不能预览。';
      pvBody.appendChild(el('div', 'pv-empty', why + (r.size ? ' (' + formatSize(r.size) + ')' : '')));
    }
    if (r.truncated && !asPage) pvBody.appendChild(el('div', 'pv-note', '文件较大，只显示了前 1 MB。'));
    syncOutline();
    if (finder) runFind(true);
  }

  // ---- Markdown reading view ----
  const MAX_PICTURES = 30;
  function markdownView(r) {
    const md = el('div', 'pv-md');
    md.dataset.mdTheme = side.mdTheme;
    md.innerHTML = C.renderMarkdown(r.text, { rich: true, links: true });
    md.querySelectorAll('.md-copy').forEach((b) => { b.innerHTML = host.ICONS.copy; });
    const folder = parentPath(r.path);
    md.addEventListener('click', (e) => {
      const copy = e.target.closest('.md-copy');
      if (copy) { copyCode(copy); return; }
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
  async function copyCode(btn) {
    const code = btn.closest('.md-pre') && btn.closest('.md-pre').querySelector('pre code');
    if (!code) return;
    try { await host.clipboardWrite(code.textContent); } catch (_) { host.showToast('没能复制到剪贴板，请再试一次'); return; }
    const label = (text) => { btn.setAttribute('aria-label', text); btn.title = text; };
    btn.innerHTML = host.ICONS.check; btn.classList.add('done'); label('已复制');
    clearTimeout(btn.checkTimer);
    btn.checkTimer = setTimeout(() => { btn.innerHTML = host.ICONS.copy; btn.classList.remove('done'); label('复制代码'); }, 1500);
  }
  // Pictures lying next to the note. Each one is read by the main process like
  // any clicked path, a few at a time, and only for the render still on screen.
  // A picture seen before keeps its size while it loads again, so a fresh render
  // of a changed note does not jump.
  const pictureSizes = new Map();
  let pictureWait = Promise.resolve();
  function loadPictures(md, folder) {
    const seq = renderSeq;
    const imgs = [...md.querySelectorAll('img.md-img[data-src]')];
    imgs.slice(MAX_PICTURES).forEach((img) => { img.dataset.missing = '1'; });
    const wanted = imgs.slice(0, MAX_PICTURES).map((img) => ({ img, target: window.HubCore.resolvePath(folder, decoded(img.dataset.src)) }));
    for (const { img, target } of wanted) {
      const size = target && pictureSizes.get(target);
      if (size) { img.width = size[0]; img.height = size[1]; }
    }
    pictureWait = (async () => {
      for (const { img, target } of wanted) {
        let res = null;
        try { res = target ? await window.deck.previewRead(target, previewColId) : null; } catch (_) {}
        if (seq !== renderSeq) return;
        if (!(res && res.ok && res.kind === 'image' && res.dataUrl)) { img.dataset.missing = '1'; img.removeAttribute('width'); img.removeAttribute('height'); continue; }
        img.src = res.dataUrl;
        try { await img.decode(); } catch (_) {}
        if (seq !== renderSeq) return;
        if (img.naturalWidth) pictureSizes.set(target, [img.naturalWidth, img.naturalHeight]);
        pictureOpens(img);
      }
    })();
  }

  // ---- outline ----
  // The note's headings, beside it when the pane has room for both and the reader keeps it open
  // (remembered). In a narrow pane it floats over the note when asked for and goes after a jump.
  const OUTLINE_ROOM = 600;
  let outlineHeads = [], outlinePeek = false, spyQueued = false;
  function buildOutline(md) {
    pvOutline.textContent = '';
    const heads = [...md.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')];
    if (heads.length < 2) return;
    outlineHeads = heads;
    pvOutline.appendChild(el('div', 'pv-ol-title', '目录'));
    R.outline(heads.map((h) => ({ level: Number(h.tagName[1]), text: h.textContent }))).forEach((item, i) => {
      const b = el('button', 'pv-ol-item', item.text);
      b.type = 'button'; b.title = item.text; b.dataset.depth = String(Math.min(item.depth, 5));
      b.addEventListener('click', () => jumpTo(i));
      pvOutline.appendChild(b);
    });
  }
  const narrowPane = () => pvMain.clientWidth < OUTLINE_ROOM;
  function syncOutline() {
    if (!pvMain) return;
    const narrow = narrowPane();
    if (!narrow) outlinePeek = false;
    const shown = outlineHeads.length > 0 && (narrow ? outlinePeek : side.outline);
    pvOutline.hidden = !shown;
    pvMain.classList.toggle('ol-float', shown && narrow);
    const btn = pvHead.querySelector('.pv-outline-btn');
    if (btn) btn.setAttribute('aria-pressed', String(shown));
    if (shown) spy();
  }
  function toggleOutline() {
    if (!narrowPane()) { side.outline = !side.outline; persist(); syncOutline(); return; }
    outlinePeek = !outlinePeek;
    syncOutline();
    if (outlinePeek) (pvOutline.querySelector('[aria-current="location"]') || pvOutline.querySelector('.pv-ol-item')).focus();
  }
  function jumpTo(i) {
    const h = outlineHeads[i];
    if (!h || !h.isConnected) return;
    pvBody.scrollTop += h.getBoundingClientRect().top - pvBody.getBoundingClientRect().top - 12;
    if (outlinePeek) { outlinePeek = false; syncOutline(); pvBody.focus({ preventScroll: true }); }
    spy();
  }
  // the section being read is marked as the note scrolls, and kept in sight in a long outline
  function spy() {
    if (pvOutline.hidden || !outlineHeads.length) return;
    const box = pvBody.getBoundingClientRect();
    const tops = outlineHeads.map((h) => h.getBoundingClientRect().top - box.top);
    const atEnd = pvBody.scrollTop + pvBody.clientHeight >= pvBody.scrollHeight - 2;
    const at = R.currentHeading(tops, 24, atEnd, pvBody.clientHeight);
    const items = pvOutline.querySelectorAll('.pv-ol-item');
    items.forEach((item, k) => { if (k === at) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); });
    const now = items[at];
    if (!now) return;
    if (now.offsetTop < pvOutline.scrollTop) pvOutline.scrollTop = now.offsetTop - 30;
    else if (now.offsetTop + now.offsetHeight > pvOutline.scrollTop + pvOutline.clientHeight) pvOutline.scrollTop = now.offsetTop + now.offsetHeight - pvOutline.clientHeight + 8;
  }

  // ---- find (⌘F, Ctrl+F off the Mac) ----
  // In a note, a code file or a folder list the words are marked with highlight ranges (nothing is
  // written into the text); in a previewed web page Chromium's own find runs inside its view.
  let finder = null;         // while the bar is open: { ranges, at, more }
  let findInput, findCount, findTimer = 0;
  function buildFind() {
    const icon = el('span', 'pv-find-icon');
    icon.innerHTML = host.ICONS.search; icon.setAttribute('aria-hidden', 'true');
    findInput = el('input', 'pv-find-input');
    findInput.type = 'text'; findInput.placeholder = '查找'; findInput.spellcheck = false; findInput.autocomplete = 'off';
    findInput.setAttribute('aria-label', '在预览里查找');
    findCount = el('span', 'pv-find-count');
    findCount.setAttribute('aria-live', 'polite');
    const tool = (icon, label, tip, fn) => { const b = iconButton(icon, label, fn); b.title = tip; return b; };
    pvFind.append(icon, findInput, findCount,
      tool('up', '上一个', '上一个（Shift+Enter）', () => { flushFind(); stepFind(-1); }),
      tool('down', '下一个', '下一个（Enter）', () => { flushFind(); stepFind(1); }),
      tool('close', '关闭查找', '关闭查找（Esc）', () => closeFind(true)));
    findInput.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(false), 120); });
    findInput.addEventListener('keydown', (e) => {
      const again = (e.key === 'g' || e.key === 'G') && (host.platform === 'darwin' ? e.metaKey : e.ctrlKey);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(true); }
      else if ((e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) || again) { e.preventDefault(); flushFind(); stepFind(e.shiftKey ? -1 : 1); }
    });
  }
  const findRoot = () => pvBody.querySelector('.pv-md, .pv-code .pv-src, .pv-dir');
  function openFind() {
    if (!(side.open && side.tab === 'preview') || (!pageOpen && !findRoot())) return false;
    const fresh = !finder;
    pvFind.hidden = false;
    findInput.focus(); findInput.select();
    if (fresh) { finder = { ranges: [], at: 0, more: false }; runFind(false); }
    requestAnimationFrame(syncBounds);
    return true;
  }
  function closeFind(refocus) {
    if (!finder) return;
    clearTimeout(findTimer); findTimer = 0;
    pvFind.hidden = true;
    finder = null;
    clearMarks();
    if (pageOpen) window.deck.sidePreviewFindStop();
    if (refocus) pvBody.focus({ preventScroll: true });
    requestAnimationFrame(syncBounds);
  }
  const clearMarks = () => { CSS.highlights.delete('pv-find'); CSS.highlights.delete('pv-find-now'); };
  function showCount(at, total, more, blank) {
    findCount.textContent = blank ? '' : R.findCount(at, total, more);
    findCount.classList.toggle('none', !blank && !total);
  }
  function flushFind() { if (findTimer) { clearTimeout(findTimer); runFind(false); } }
  const FIND_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, summary, .md-callout-title, .md-props, .pv-dir-row, section';
  const notSearched = { acceptNode: (n) => (n.parentElement.closest('.md-code-bar, button:not(.pv-dir-row), .pv-gutter') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  // keep: the same file drawn again (it changed): stay on the same match, do not scroll
  function runFind(keep) {
    findTimer = 0;
    if (!finder) return;
    const q = findInput.value;
    clearMarks();
    if (pageOpen) {
      window.deck.sidePreviewFind(q, false, true);
      if (!q) showCount(0, 0, false, true);
      return;
    }
    const was = finder.at;
    finder.ranges = []; finder.at = 0; finder.more = false;
    const root = findRoot();
    if (!root || !q.trim()) { showCount(0, 0, false, !q.trim()); return; }
    const nodes = [], pieces = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, notSearched);
    let block = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const b = n.parentElement.closest(FIND_BLOCK) || root;
      pieces.push({ text: n.nodeValue, cut: b !== block });
      nodes.push(n); block = b;
    }
    const found = R.findRanges(pieces, q);
    finder.more = found.more;
    finder.ranges = found.ranges.map((f) => { const r = new Range(); r.setStart(nodes[f.from[0]], f.from[1]); r.setEnd(nodes[f.to[0]], f.to[1]); return r; });
    if (!finder.ranges.length) { showCount(0, 0, false); return; }
    CSS.highlights.set('pv-find', new Highlight(...finder.ranges));
    finder.at = keep ? Math.min(was, finder.ranges.length - 1) : 0;
    showCurrent(!keep);
  }
  function showCurrent(scroll) {
    const r = finder && finder.ranges[finder.at];
    if (!r) return;
    const now = new Highlight(r);
    now.priority = 1;
    CSS.highlights.set('pv-find-now', now);
    showCount(finder.at, finder.ranges.length, finder.more);
    if (!scroll) return;
    // a word inside a folded callout: unfold it
    for (let n = r.startContainer.parentElement; n && n !== pvBody; n = n.parentElement) if (n.tagName === 'DETAILS' && !n.open) n.open = true;
    const box = r.getBoundingClientRect(), view = pvBody.getBoundingClientRect();
    if (box.top < view.top + 8 || box.bottom > view.bottom - 8) pvBody.scrollTop += box.top - view.top - pvBody.clientHeight / 3;
    const gutter = pvBody.querySelector('.pv-gutter');
    const left = view.left + (gutter ? gutter.offsetWidth : 0);
    if (box.left < left + 8 || box.right > view.right - 8) pvBody.scrollLeft += box.left - left - 40;
  }
  function stepFind(dir) {
    if (!finder) return;
    if (pageOpen) { if (findInput.value) window.deck.sidePreviewFind(findInput.value, true, dir > 0); return; }
    const n = finder.ranges.length;
    if (!n) return;
    finder.at = (finder.at + dir + n) % n;
    showCurrent(true);
  }

  // ---- a picture full screen ----
  // Fitted to the window to start with (never blown up past its own size); the wheel and a
  // trackpad pinch zoom about the pointer, a drag moves it, a double click goes to its own size and
  // back; + - 0 1 and Esc on the keyboard. A click beside the picture closes it.
  let lightbox = null;
  function pictureOpens(img) {
    if (img.dataset.zoomable) return;
    img.dataset.zoomable = '1';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', '放大查看：' + (img.alt || '图片'));
    img.addEventListener('click', () => openPicture(img));
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicture(img); } });
  }
  function openPicture(img) {
    if (!img.src || !img.naturalWidth) return;
    const lb = lightbox || (lightbox = buildLightbox());
    lb.opener = img;
    lb.dialog.dataset.mdTheme = side.mdTheme;
    lb.img.src = img.src; lb.img.alt = img.alt || '';
    lb.name.textContent = img.alt || '';
    lb.w = img.naturalWidth; lb.h = img.naturalHeight;
    lb.dialog.showModal();
    fitPicture();
  }
  function buildLightbox() {
    const dialog = el('dialog', 'pv-lightbox');
    dialog.setAttribute('aria-label', '看图');
    const bar = el('div', 'pv-lb-bar');
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '看图工具');
    const name = el('span', 'pv-lb-name'), zoom = el('span', 'pv-lb-zoom');
    const tool = (icon, label, tip, fn) => { const b = iconButton(icon, label, fn); b.title = tip; return b; };
    bar.append(name,
      tool('zoomOut', '缩小', '缩小（-）', () => zoomBy(1 / 1.25)), zoom,
      tool('zoomIn', '放大', '放大（+）', () => zoomBy(1.25)),
      tool('fit', '适合屏幕', '适合屏幕（0）', () => fitPicture()),
      tool('actualSize', '原始大小', '原始大小（1）', () => zoomTo(1)),
      tool('close', '关闭', '关闭（Esc）', () => dialog.close()));
    const stage = el('div', 'pv-lb-stage');
    const img = el('img', 'pv-lb-img');
    img.draggable = false;
    stage.appendChild(img);
    dialog.append(bar, stage);
    document.body.appendChild(dialog);
    const lb = { dialog, stage, img, name, zoom, view: { scale: 1, x: 0, y: 0 }, fitted: true, w: 1, h: 1, opener: null };
    const at = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), ...at(e)); }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: { ...lb.view }, moved: false, onPicture: e.target === img };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const s = stageBox();
      lb.view = R.settle({ scale: drag.from.scale, x: drag.from.x + dx, y: drag.from.y + dy }, lb.w, lb.h, s.w, s.h);
      lb.fitted = false;
      applyView();
    });
    const drop = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const closeIt = !drag.moved && !drag.onPicture && e.type === 'pointerup';
      drag = null;
      stage.classList.remove('dragging');
      if (closeIt) dialog.close();
    };
    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);
    // the stage holds the pointer while it is down, so the double click comes to it (one beside the picture closed it already)
    stage.addEventListener('dblclick', (e) => { if (Math.abs(lb.view.scale - 1) < 0.005) fitPicture(); else zoomTo(1, ...at(e)); });
    dialog.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const act = { '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(1 / 1.25), _: () => zoomBy(1 / 1.25), 0: () => fitPicture(), 1: () => zoomTo(1) }[e.key];
      if (!act) return;
      e.preventDefault(); e.stopPropagation();
      act();
    });
    dialog.addEventListener('close', () => { if (lb.opener && lb.opener.isConnected) lb.opener.focus(); });
    new ResizeObserver(() => { if (!dialog.open) return; if (lb.fitted) fitPicture(); else zoomTo(lb.view.scale); }).observe(stage);
    return lb;
  }
  const stageBox = () => ({ w: lightbox.stage.clientWidth, h: lightbox.stage.clientHeight });
  function applyView() {
    const lb = lightbox, v = lb.view;
    Object.assign(lb.img.style, { width: lb.w * v.scale + 'px', height: lb.h * v.scale + 'px', transform: `translate(${v.x}px, ${v.y}px)` });
    lb.zoom.textContent = Math.round(v.scale * 100) + '%';
  }
  function fitPicture() {
    const lb = lightbox, s = stageBox();
    lb.view = R.settle({ scale: R.fitScale(lb.w, lb.h, Math.max(40, s.w - 48), Math.max(40, s.h - 48)), x: 0, y: 0 }, lb.w, lb.h, s.w, s.h);
    lb.fitted = true;
    applyView();
  }
  function zoomTo(scale, px, py) {
    const lb = lightbox, s = stageBox();
    lb.view = R.settle(R.zoomAt(lb.view, scale, px == null ? s.w / 2 : px, py == null ? s.h / 2 : py), lb.w, lb.h, s.w, s.h);
    lb.fitted = false;
    applyView();
  }
  const zoomBy = (factor, px, py) => zoomTo(lightbox.view.scale * factor, px, py);

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
    if (md) { md.dataset.mdTheme = side.mdTheme; pvMain.dataset.mdTheme = side.mdTheme; }
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
    init, show, hide, toggle, openLink, openPreview, openBrowser, setTheme,
    syncTerminal, restoreTerminal, syncBounds,
    onFocusChange: () => syncTerminal(),
    onViewChange: () => { if (!host) return; restoreTerminal(); apply(); },
    isOpen: () => side.open,
    holdsTerminalOf: (id) => termId === id,
  };
})();
