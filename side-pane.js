// The right-hand pane: file/link preview, the column's real terminal, and an
// embedded browser. Plain script, no module system, so it can sit next to
// renderer.js; everything it needs from the deck comes in through init().
(function () {
  'use strict';
  const C = window.ChatCore;
  let host = null;
  const side = { open: false, tab: 'preview', width: 460 };
  let pane, tabsEl, pages, pvHead, pvBody, stTitle, stBody, sbUrl, sbView, sbEmpty, sbBack, sbFwd, sbReload;
  let preview = null;        // last preview result
  let mdSource = false;      // markdown shown as source instead of rendered
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
      sbEmpty.hidden = !!s.url;
    });

    // The native browser view floats above the page, so it has to follow the
    // placeholder's rectangle and step aside whenever a dialog is open.
    new ResizeObserver(() => syncBounds()).observe(sbView);
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
    host.config.side = { open: side.open, tab: side.tab, width: side.width };
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
    const visible = side.open && side.tab === 'browser' && host.activeView() !== 'board' && !document.querySelector('dialog[open]');
    const r = sbView.getBoundingClientRect();
    window.deck.sideBrowserBounds({ x: r.left, y: r.top, width: r.width, height: r.height, visible });
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

  function renderPreview() {
    pvHead.textContent = ''; pvBody.textContent = '';
    const r = preview;
    if (!r) { pvBody.appendChild(el('div', 'pv-empty', '点聊天里的文件路径或链接，会在这里预览。')); return; }
    const title = el('div', 'pv-title');
    title.append(el('strong', null, r.name || r.path), el('span', 'pv-path', r.path));
    title.title = r.path;
    pvHead.appendChild(title);
    const actions = el('div', 'pv-actions');
    if (r.kind === 'markdown') actions.appendChild(button(mdSource ? '渲染' : '源码', '切换 Markdown 渲染和源码', () => { mdSource = !mdSource; renderPreview(); }));
    actions.appendChild(button('在访达中显示', '', () => window.deck.revealPath(r.path, previewColId)));
    if (r.kind !== 'dir') actions.appendChild(button('编辑器打开', '', () => window.deck.openInEditor(r.line ? r.path + ':' + r.line : r.path, previewColId)));
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
    } else if (r.kind === 'markdown' && !mdSource) {
      const md = el('div', 'pv-md');
      md.innerHTML = C.renderMarkdown(r.text);
      md.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-ext]');
        if (!a) return;
        e.preventDefault();
        openBrowser(a.getAttribute('href'));
      });
      pvBody.appendChild(md);
    } else if (r.kind === 'text' || r.kind === 'markdown') {
      pvBody.appendChild(codeView(r));
    } else {
      const why = r.kind === 'toolarge' ? '文件太大，不在这里预览。' : '这是二进制文件，不能预览。';
      pvBody.appendChild(el('div', 'pv-empty', why + (r.size ? ' (' + formatSize(r.size) + ')' : '')));
    }
    if (r.truncated) pvBody.appendChild(el('div', 'pv-note', '文件较大，只显示了前 1 MB。'));
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
