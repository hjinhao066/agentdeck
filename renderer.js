const { Terminal } = window;            // from vendor/xterm.js (UMD global)
const FitAddonNS = window.FitAddon;      // from vendor/addon-fit.js
const SearchAddonNS = window.SearchAddon; // from vendor/addon-search.js
const WebglAddonNS = window.WebglAddon;   // from vendor/addon-webgl.js

if (/Mac/.test(navigator.userAgent)) document.body.classList.add('is-mac');

const env = window.deck.envInfo();       // { tmux, platform, home }

// ---- Inline SVG icons (Lucide-style) ----
const S = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  left:  S('<polyline points="15 18 9 12 15 6"/>'),
  right: S('<polyline points="9 18 15 12 9 6"/>'),
  edit:  S('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  close: S('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  plus:  S('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  sun:   S('<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>'),
  moon:  S('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  reset: S('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  fit:   S('<polyline points="4 7 4 4 7 4"/><polyline points="20 7 20 4 17 4"/><polyline points="4 17 4 20 7 20"/><polyline points="20 17 20 20 17 20"/>'),
  grip:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>',
  send:  S('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
};

// ---- Config / state ----
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 260;
const MAX_WIDTH = 1100;

const TERM_THEME = {
  dark:  { background: '#000000', foreground: '#e7e9ea', cursor: '#1d9bf0', selectionBackground: 'rgba(29,155,240,0.35)' },
  light: { background: '#ffffff', foreground: '#0f1419', cursor: '#1d9bf0', selectionBackground: 'rgba(29,155,240,0.25)' },
};

function newId() { return 'c' + Date.now() + Math.floor(Math.random() * 1000); }
// Fresh / reset layout: three agent columns that auto-launch on open.
function defaultColumns() {
  const agents = [
    { title: 'Antigravity', cmd: 'agy' },
    { title: 'Claude', cmd: 'claude --dangerously-skip-permissions' },
    { title: 'Grok', cmd: 'grok' },
  ];
  return agents.map((a) => ({ id: newId(), title: a.title, cwd: '', cmd: a.cmd, width: DEFAULT_WIDTH }));
}

let config = { theme: 'dark', fitWindow: false, columns: defaultColumns() };
const saved = window.deck.loadConfig();
if (saved) {
  if (saved.theme) config.theme = saved.theme;
  if (saved.fitWindow !== undefined) config.fitWindow = saved.fitWindow;
  if (Array.isArray(saved.columns) && saved.columns.length) {
    config.columns = saved.columns.map((c) => ({
      id: c.id || newId(), title: c.title || 'Agent', cwd: c.cwd || '', cmd: c.cmd || '', width: c.width || DEFAULT_WIDTH,
    }));
  }
}
let columns = config.columns;
function saveConfig() { config.columns = columns; window.deck.saveConfig(config); }

// ---- Terminals ----
const terms = new Map(); // id -> { term, fit, el, wrap, titleEl, dot, alive }
let focusedId = null;    // id of the column whose terminal last had focus

window.deck.onPtyData((id, data) => { const t = terms.get(id); if (t) t.term.write(data); });
window.deck.onPtyExit((id) => {
  const t = terms.get(id);
  if (t) { t.alive = false; t.term.write('\r\n\x1b[2m[已退出 / process exited]\x1b[0m\r\n'); setDot(t, 'exited'); }
});

// Per-column status dot: blue=working, green=idle/done, gray=plain shell, dim=exited.
const DOT = { working: '#1d9bf0', idle: '#00ba7c', plain: '#536471', exited: '#5c6670' };
const WORKING_RE = /esc to interrupt|Running\.\.\.|\(\d+s\s*·|[↑↓]\s*[\d.]+k?\s+tokens|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;
const AGENT_RE = /bypass permissions|for shortcuts|Build anything|Antigravity|Claude Code|❯/;
function classify(text) {
  const tail = text.split('\n').slice(-15).join('\n');
  if (WORKING_RE.test(tail)) return 'working';
  if (AGENT_RE.test(text)) return 'idle';
  return 'plain';
}
function setDot(entry, state) {
  if (!entry || !entry.dot) return;
  entry.dot.style.background = DOT[state];
  entry.dot.style.boxShadow = state === 'working' ? '0 0 6px #1d9bf0' : 'none';
}

// ---- Theme ----
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  config.theme = theme;
  const btn = document.getElementById('themeBtn');
  if (btn) { btn.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon; btn.title = theme === 'dark' ? '切换浅色' : '切换深色'; }
  terms.forEach(({ term }) => { term.options.theme = TERM_THEME[theme]; });
  saveConfig();
}

// ---- Left rail ----
function railBtn(svg, tip, onClick, accent) {
  const b = document.createElement('button');
  b.className = 'rail-btn' + (accent ? ' accent' : '');
  b.innerHTML = svg; b.title = tip; b.onclick = onClick;
  return b;
}
function buildRail() {
  const rail = document.getElementById('rail');
  rail.innerHTML = '';
  const logo = document.createElement('div');
  logo.className = 'logo'; logo.textContent = 'A';
  rail.appendChild(logo);

  rail.appendChild(railBtn(ICONS.plus, '添加列', () => addAndFocusColumn(), true));

  const fitBtn = railBtn(ICONS.fit, '等比例适应窗口 / 横向滚动', () => {
    config.fitWindow = !config.fitWindow;
    fitBtn.classList.toggle('accent', config.fitWindow);
    saveConfig(); updateColumnStyles(); fitAll();
  });
  fitBtn.id = 'fitBtn';
  if (config.fitWindow) fitBtn.classList.add('accent');
  rail.appendChild(fitBtn);

  rail.appendChild(railBtn(ICONS.send, '广播：同一条输入发给所有列 (Cmd+B)', () => toggleBroadcast()));

  const spacer = document.createElement('div'); spacer.className = 'rail-spacer'; rail.appendChild(spacer);

  const themeBtn = railBtn(ICONS.moon, '切换主题', () => applyTheme(config.theme === 'dark' ? 'light' : 'dark'));
  themeBtn.id = 'themeBtn';
  rail.appendChild(themeBtn);

  rail.appendChild(railBtn(ICONS.reset, '恢复默认布局', () => {
    if (!confirm('恢复默认列布局？现有列的终端会关闭。')) return;
    columns.forEach((c) => window.deck.ptyKill(c.id));
    columns = defaultColumns(); saveConfig(); render();
  }));
}

// ---- Render ----
const deckEl = document.getElementById('deck');

// Two-finger horizontal swipe should always page between columns, even over an
// empty terminal. xterm's viewport otherwise swallows wheel events (and only
// once it has scrollback), which is why the swipe felt hit-or-miss. Intercept
// horizontal-dominant wheels in the capture phase, before they reach xterm, and
// drive the deck ourselves. Vertical scrolls fall through to the terminal.
let isUserScrollingDeck = false;
let userScrollTimeout;
deckEl.addEventListener('wheel', (e) => {
  isUserScrollingDeck = true;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(() => { isUserScrollingDeck = false; }, 500);

  if (config.fitWindow && columns.length <= FIT_MAX) return; // nothing to scroll
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    deckEl.scrollLeft += e.deltaX;
    e.preventDefault();
    e.stopPropagation();
  }
}, { capture: true, passive: false });

let lastValidDeckScrollLeft = deckEl.scrollLeft;
deckEl.addEventListener('scroll', () => {
  if (!isUserScrollingDeck && document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')) {
    deckEl.scrollLeft = lastValidDeckScrollLeft;
  } else {
    lastValidDeckScrollLeft = deckEl.scrollLeft;
  }
});

function render() {
  // tear down existing terminals; pty processes keep running until killed
  terms.forEach(({ term }) => term.dispose());
  terms.clear();
  deckEl.innerHTML = '';
  columns.forEach((col) => deckEl.appendChild(buildColumn(col)));
  updateColumnStyles();
}

// Max columns the "fit window" mode will squeeze onto one screen. Beyond this,
// the leftmost FIT_MAX fill the screen and the rest overflow into a scroll.
const FIT_MAX = 4;

function updateColumnStyles() {
  const colEls = deckEl.querySelectorAll('.column');
  const n = columns.length;

  if (config.fitWindow && n <= FIT_MAX) {
    // Few enough columns: spread them across the whole viewport, proportional
    // to each column's stored width. No horizontal scroll needed.
    deckEl.style.overflowX = 'hidden';
    colEls.forEach((wrap, i) => {
      const col = columns[i]; if (!col) return;
      wrap.style.flex = `${col.width} ${col.width} 0%`;
      wrap.style.width = '';
    });
    return;
  }

  if (config.fitWindow) {
    // More than FIT_MAX columns: scale every column by one factor so the first
    // FIT_MAX exactly fill the screen; the rest keep the same scale and scroll.
    const W = deckEl.clientWidth;
    const firstSum = columns.slice(0, FIT_MAX).reduce((s, c) => s + c.width, 0) || 1;
    const k = W / firstSum;
    colEls.forEach((wrap, i) => {
      const col = columns[i]; if (!col) return;
      wrap.style.flex = '0 0 auto';
      wrap.style.width = Math.round(col.width * k) + 'px';
    });
    deckEl.style.overflowX = 'scroll';
    return;
  }

  // Normal mode: fixed per-column widths, horizontal scroll.
  colEls.forEach((wrap, i) => {
    const col = columns[i]; if (!col) return;
    wrap.style.flex = '0 0 auto';
    wrap.style.width = col.width + 'px';
  });
  // Use 'scroll' (not 'auto') whenever content overflows so the bar stays put
  // and never flickers away while paging between columns.
  deckEl.style.overflowX = deckEl.scrollWidth > deckEl.clientWidth ? 'scroll' : 'auto';
}

function fitAll() {
  requestAnimationFrame(() => terms.forEach(({ fit }) => { try { fit.fit(); } catch (_) {} }));
}

// Rebuild once fonts finish loading: the first atlas can be built from metrics
// measured before "SF Mono"/"PingFang SC" were ready, which also misplaces CJK.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    terms.forEach(({ term, fit }) => { try { fit.fit(); term.clearTextureAtlas(); } catch (_) {} });
  });
}

function mkBtn(svg, tip, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn'; b.innerHTML = svg; b.title = tip; b.onclick = onClick;
  return b;
}

function buildColumn(col) {
  const wrap = document.createElement('div');
  wrap.className = 'column';
  wrap.dataset.colId = col.id; // lets drag-reorder map a DOM column back to its id
  if (config.fitWindow) wrap.style.flex = `${col.width} ${col.width} 0%`;
  else { wrap.style.flex = '0 0 auto'; wrap.style.width = (col.width || DEFAULT_WIDTH) + 'px'; }

  const head = document.createElement('div');
  head.className = 'col-head';
  const grip = document.createElement('span');
  grip.className = 'grip'; grip.innerHTML = ICONS.grip; grip.title = '拖拽排序';
  attachReorder(grip, col);
  const dot = document.createElement('span'); dot.className = 'dot';
  const title = document.createElement('span'); title.className = 'title'; title.textContent = col.title;
  title.title = '双击重命名';
  attachRename(title, col);

  const secondary = document.createElement('span');
  secondary.className = 'secondary';
  secondary.append(
    mkBtn(ICONS.left, '左移', () => move(col, -1)),
    mkBtn(ICONS.right, '右移', () => move(col, 1)),
    mkBtn(ICONS.edit, '编辑', () => openDialog(columns.indexOf(col))),
    mkBtn(ICONS.close, '删除该列', () => removeCol(col)),
  );
  head.append(grip, dot, title, secondary);

  const termEl = document.createElement('div');
  termEl.className = 'term';

  const resizer = document.createElement('div');
  resizer.className = 'resizer';
  attachResize(resizer, wrap, col);

  wrap.append(head, termEl, resizer);

  // Create the terminal once the element is in the DOM (next frame).
  requestAnimationFrame(() => {
    const term = new Terminal({
      // "PingFang SC" gives CJK output a consistent face (xterm already lays CJK
      // out as double-width cells, so columns still line up).
      fontFamily: 'SFMono-Regular, "SF Mono", Menlo, Monaco, "PingFang SC", "Courier New", monospace',
      fontSize: 13, lineHeight: 1.0, cursorBlink: true, scrollback: 12000,
      theme: TERM_THEME[config.theme], allowProposedApi: true,
      // Option+click is our "open in editor" gesture on links; don't let xterm
      // also interpret it as click-to-move-cursor (sends arrow keys to the TUI).
      altClickMovesCursor: false,
    });
    const fit = new FitAddonNS.FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddonNS.SearchAddon();
    term.loadAddon(search);
    term.open(termEl);
    // GPU-accelerated rendering: far lower CPU and smoother scrolling when
    // several agent TUIs repaint at once. Must load after open() (needs the
    // canvas). If the WebGL context is lost (driver hiccup, too many contexts),
    // dispose it so xterm transparently falls back to the DOM renderer.
    let webgl = null;
    const attachWebgl = () => {
      if (!(WebglAddonNS && WebglAddonNS.WebglAddon)) return;
      try {
        if (webgl) { try { webgl.dispose(); } catch (_) {} }
        webgl = new WebglAddonNS.WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch (_) {} webgl = null; });
        term.loadAddon(webgl);
      } catch (_) { webgl = null; }
    };
    attachWebgl();
    try { fit.fit(); } catch (_) {}

    // --- IME / voice-input scroll-drift fix ---
    // During composition (e.g. voice dictation, Chinese IME), xterm moves its
    // helper textarea and composition-view overlay to the cursor position. The
    // overlay can grow wider than the column, causing the deck to scroll right
    // and the terminal to appear blank. Pin the scroll position of both the
    // deck and the xterm viewport so composition cannot push them sideways.
    const xtermViewport = termEl.querySelector('.xterm-viewport');
    let composing = false;
    let savedDeckScroll = 0;
    let savedViewportScroll = 0;
    const pinScroll = () => {
      deckEl.scrollLeft = savedDeckScroll;
      if (xtermViewport) xtermViewport.scrollLeft = 0;
      termEl.scrollLeft = 0;
      termEl.scrollTop = 0;
    };
    let lastCompositionTs = 0;
    termEl.addEventListener('compositionstart', () => {
      composing = true;
      lastCompositionTs = Date.now();
      savedDeckScroll = deckEl.scrollLeft;
      savedViewportScroll = xtermViewport ? xtermViewport.scrollLeft : 0;
    }, true);
    termEl.addEventListener('compositionupdate', () => {
      lastCompositionTs = Date.now();
      if (composing) requestAnimationFrame(pinScroll);
    }, true);
    termEl.addEventListener('compositionend', () => {
      composing = false;
      pinScroll();
    }, true);
    // Voice dictation can end a composition session WITHOUT firing
    // compositionend (e.g. focus moves to another column mid-dictation). A
    // stuck composing=true would lock the whole deck's scrolling forever via
    // onDeckScroll below, so treat losing focus as end-of-composition.
    termEl.addEventListener('focusout', () => { composing = false; }, true);
    // Belt-and-suspenders: if a scroll event fires during composition, revert it.
    // Named + tracked so removeCol/respawnColumn can unbind it: this listener
    // lives on the shared deckEl, so unlike the termEl listeners above it does
    // NOT die with the column's DOM and would otherwise pile up one per
    // (re)created column.
    const onDeckScroll = () => {
      if (!composing) return;
      // Composition cannot outlive focus; a stale flag must not pin the deck.
      if (!termEl.contains(document.activeElement)) { composing = false; return; }
      // Drift only happens while the preedit text is actively changing (the
      // browser auto-scrolls the textarea into view on each update). During a
      // dictation pause let the user scroll the deck freely instead of
      // snapping back — voice IMEs keep one composition open for minutes.
      if (Date.now() - lastCompositionTs > 2000) return;
      pinScroll();
    };
    deckEl.addEventListener('scroll', onDeckScroll, { passive: false });
    const disposers = [() => deckEl.removeEventListener('scroll', onDeckScroll)];

    // Prevent any scroll drift inside termEl for non-composition or voice inputs
    termEl.addEventListener('scroll', (e) => {
      if (e.target === termEl) {
        termEl.scrollLeft = 0;
        termEl.scrollTop = 0;
      } else if (e.target.classList && e.target.classList.contains('xterm-viewport')) {
        e.target.scrollLeft = 0;
      } else {
        try { e.target.scrollLeft = 0; } catch (_) {}
      }
    }, { capture: true, passive: true });
    terms.set(col.id, { term, fit, search, el: termEl, wrap, titleEl: title, dot, alive: true, state: 'plain', disposers });

    // Cmd+C copies the selection (paste is handled natively by xterm).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        let text = term.getSelection();
        try {
          const bytes = new Uint8Array(text.length);
          let isLatin1 = true;
          for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code > 255) { isLatin1 = false; break; }
            bytes[i] = code;
          }
          if (isLatin1) {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            text = decoded;
          }
        } catch (_) {}
        window.deck.clipboardWrite(text);
        return false;
      }
      return true;
    });

    // --- Connect to pty: reconnect if alive (hot reload), or spawn fresh ---
    // While replayed output is being parsed, xterm auto-ANSWERS any terminal
    // queries it contains (cursor-position ESC[6n, device-attributes ESC[c, …
    // agent TUIs emit these constantly). Those answers fire onData like
    // keystrokes — without the mute they get typed into the fresh shell as
    // garbage like `1;2c56;3R54;3R54;…`, which the shell echoes, which gets
    // SAVED on quit and replayed again next launch, snowballing every restart.
    let replayMuted = false;
    const reconnect = async () => {
      const alive = await window.deck.ptyIsAlive(col.id);
      if (alive) {
        // Hot-reload path: pty survived, replay its buffered output and resize.
        const replay = await window.deck.ptyReplay(col.id);
        if (replay) {
          replayMuted = true;
          term.write(replay, () => { replayMuted = false; });
        }
        window.deck.ptyResize(col.id, term.cols, term.rows);
      } else {
        // Fresh spawn. If the previous app run left a saved session for this
        // column, replay it first so the agent's history survives a restart.
        const saved = await window.deck.ptySaved(col.id);
        if (saved) {
          replayMuted = true;
          term.write(saved);
          // The replay may end mid-TUI: leave alternate screen, re-show the
          // cursor, drop mouse/bracketed-paste modes, reset colors — then a
          // dim separator before the fresh shell starts below.
          term.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m');
          // Writes are parsed in order: this callback marks the end of replay.
          term.write('\r\n\x1b[2m── 以上为上次会话的输出（已恢复）──\x1b[0m\r\n', () => { replayMuted = false; });
        }
        window.deck.ptySpawn(col.id, col.cwd || env.home, term.cols, term.rows);
        if (col.cmd) setTimeout(() => window.deck.ptyInput(col.id, col.cmd + '\r'), 700);
      }
    };
    reconnect();
    term.onData((d) => { if (!replayMuted) window.deck.ptyInput(col.id, d); });
    term.onResize(({ cols, rows }) => window.deck.ptyResize(col.id, cols, rows));
    if (deckEl.firstElementChild === wrap) { term.focus(); focusedId = col.id; } // focus leftmost on boot

    // Re-fit on any size change of this column (drag-resize, window resize, fit toggle).
    let raf;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { try { fit.fit(); } catch (_) {} });
    });
    ro.observe(termEl);
    disposers.push(() => ro.disconnect()); // observers outlive detached nodes and pin them in memory
    termEl.addEventListener('mousedown', () => { term.focus(); focusedId = col.id; });

    // Renderer self-heal on focus: the WebGL renderer occasionally corrupts
    // after heavy CJK output. Mild form = shifted/overlapped hanzi (a glyph
    // atlas rebuild fixes it); severe form = the ENTIRE screen turns into
    // identical garbage tiles, ASCII included, and clearTextureAtlas() does
    // NOT recover it — the WebGL context itself is trashed without ever
    // firing onContextLoss. So on focus we rebuild the whole addon (new
    // context + new atlas), which heals both forms and also revives columns
    // that fell back to the DOM renderer after a real context loss. Throttled
    // so rapid column-hopping can't churn GPU contexts (Chromium caps ~16 and
    // silently kills the oldest, which would corrupt OTHER columns).
    let lastWebglReset = 0;
    termEl.addEventListener('focusin', () => {
      const now = Date.now();
      if (now - lastWebglReset > 15000) { lastWebglReset = now; attachWebgl(); }
      else try { term.clearTextureAtlas(); } catch (_) {}
    });

    // Drag a file from Finder onto a column → insert its (shell-quoted) path,
    // just like dragging onto a native terminal. Without this, Electron's
    // default kicks in and the window navigates to the file.
    termEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    termEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files || [])
        .map((f) => window.deck.getPathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      term.focus();
      window.deck.ptyInput(col.id, paths.map(shellQuote).join(' ') + ' ');
    });

    // Make URLs and local file paths in the output clickable. Cmd+click a URL
    // opens it in the browser; click a file path to reveal it in Finder.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const buf = term.buffer.active;
        const { str, colOf, rowOf, widthOf, endRow } = wrappedLineToCells(buf, y - 1, term.cols);
        if (!str) { callback(undefined); return; }
        const found = findLinks(str);
        if (!found.length) { callback(undefined); return; }
        callback(found.map((m) => {
          const last = m.end - 1;
          // A file path that runs to the very end of its logical line may have
          // been hard-wrapped by the agent's TUI (real newline, so it's a
          // different logical line). Hand the next two logical lines to the
          // main process, which only uses a join if the joined path exists.
          let cont;
          if (m.kind === 'file' && !str.slice(m.end).trim()) {
            cont = [];
            let row = endRow + 1;
            for (let i = 0; i < 2 && row < buf.length; i++) {
              const nl = wrappedLineToCells(buf, row, term.cols);
              const t = nl.str.trim();
              if (!t) break;
              cont.push(t);
              row = nl.endRow + 1;
            }
          }
          return {
            text: m.text,
            // 1-based, inclusive cells; start/end may sit on different rows when
            // a long path soft-wraps, so the range spans both.
            range: {
              start: { x: colOf[m.start] + 1, y: rowOf[m.start] },
              end:   { x: colOf[last] + widthOf[last], y: rowOf[last] },
            },
            activate: (event) => openLink(m, event, col.id, cont),
            decorations: { pointerCursor: true, underline: true },
          };
        }));
      },
    });
  });

  return wrap;
}

// ---- Clickable links (URLs + local file paths) ----
// Reconstruct the whole logical line at buffer row `row` and, per string index,
// record its column, 1-based buffer row, and cell width. Two things make this
// non-trivial: (1) a CJK glyph is one JS char but two columns, so string offsets
// and column offsets diverge; (2) a long path soft-wraps across rows (the
// continuation rows have isWrapped=true). Walking the whole wrapped group lets a
// wrapped path be matched and clicked as one path instead of a per-row fragment,
// and the row map lets the link range land on the right cells across rows.
function wrappedLineToCells(buf, row, cols) {
  // Walk up to the first row of this wrapped group.
  let start = row;
  while (start > 0) {
    const ln = buf.getLine(start);
    if (ln && ln.isWrapped) start--; else break;
  }
  let str = '';
  const colOf = [], rowOf = [], widthOf = [];
  let cell;
  let endRow = start; // last buffer row of this wrapped group
  for (let r = start; r < buf.length; r++) {
    const line = buf.getLine(r);
    if (!line) break;
    if (r > start && !line.isWrapped) break; // next logical line begins
    endRow = r;
    for (let x = 0; x < cols; x++) {
      cell = line.getCell(x, cell);
      if (!cell) continue;
      const w = cell.getWidth();
      if (w === 0) continue; // spacer cell trailing a wide glyph — no string content
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) { colOf.push(x); rowOf.push(r + 1); widthOf.push(w); }
      str += chars;
    }
  }
  return { str, colOf, rowOf, widthOf, endRow };
}
function trimTrail(text, s, e) {
  while (e > s && /[.,;:!?)\]}>'"]/.test(text[e - 1])) e--;
  return e;
}
function findLinks(text) {
  const out = [];
  let m;
  const urlRe = /\bhttps?:\/\/[^\s'"<>`]+/g;
  while ((m = urlRe.exec(text))) {
    const e = trimTrail(text, m.index, m.index + m[0].length);
    out.push({ start: m.index, end: e, text: text.slice(m.index, e), kind: 'url' });
  }
  // Match file:// URIs, ~/... and /... absolute paths. Real macOS paths often
  // contain UNESCAPED spaces ("Application Support", "My Project"), so a path
  // segment accepts: a backslash-escaped space ("\ "); any char that isn't
  // whitespace/quotes/angle-brackets/pipe or CJK punctuation (this includes "/"
  // so multi-level paths just work); or a single space NOT followed by another
  // space or a slash (stops at double-spaces and at " /" so two paths on one line
  // don't merge). Over-capture of trailing prose is corrected in the main process
  // by resolving the longest path that actually exists on disk.
  const fileRe = /(?:file:\/\/)?(?:~\/|\/)(?:\\ |[^\s"'`<>|，。、；：！？（）【】「」]| (?![\s/]))+/gu;
  while ((m = fileRe.exec(text))) {
    const raw = m[0];
    if (/^https?:/.test(raw) || raw.length < 4) continue;
    if (m.index > 0 && text[m.index - 1] === '.') continue; // "./x" is relative — relRe below handles it
    const slashes = (raw.match(/\//g) || []).length;
    if (!raw.startsWith('~') && slashes < 2) continue; // noise guard for bare /a/b
    const s = m.index, e = trimTrail(text, s, s + raw.length);
    if (out.some((o) => s < o.end && e > o.start)) continue; // overlaps a URL
    out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
  }
  // Relative references the agents print constantly: "src/renderer.js:406",
  // "main.js:128". To stay quiet on ordinary prose ("and/or", "Node.js"), a
  // candidate needs either a slash-path ending in a dotted filename, or a bare
  // filename with a :line suffix. The main process anchors these to the
  // column's live shell cwd before resolving.
  const relRe = /(?:\.{1,2}\/)?(?:[\w.+@%-]+\/)+[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/g;
  while ((m = relRe.exec(text))) {
    const s = m.index, e = trimTrail(text, s, s + m[0].length);
    if (s > 0 && /[\w/~.\\-]/.test(text[s - 1])) continue; // mid-token or tail of an absolute path
    if (out.some((o) => s < o.end && e > o.start)) continue; // overlaps a URL or absolute path
    out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
  }
  return out;
}
function openLink(m, event, colId, cont) {
  if (m.kind === 'url') {
    // Cmd+click opens in browser (like native Terminal.app);
    // plain click also opens URLs for convenience.
    window.deck.openExternal(m.text);
    return;
  }
  // Option+click opens the file in the editor (VS Code/Cursor) at its :line.
  if (event && event.altKey) { window.deck.openInEditor(m.text, colId, cont); return; }
  // Plain click reveals in Finder. Normalization (file:// prefix, ~ expansion,
  // unescaping "\ ", trimming trailing prose, stripping :line suffixes, and
  // anchoring relative paths to the column's shell cwd) is done in the main
  // process, which resolves the longest path that actually exists — so deep
  // paths with spaces land on the real file instead of a shallow parent.
  window.deck.revealPath(m.text, colId, cont);
}

// Quote a path for the shell: leave simple paths bare, single-quote anything
// with spaces or special characters (escaping embedded single quotes).
function shellQuote(p) {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(p)) return p;
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

// ---- Resize handle ----
function attachResize(handle, wrap, col) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wrap.getBoundingClientRect().width;
    document.body.classList.add('resizing');

    const isFit = config.fitWindow;
    const cols = Array.from(deckEl.querySelectorAll('.column'));
    if (isFit) cols.forEach((c) => { c.style.flex = 'none'; c.style.width = c.getBoundingClientRect().width + 'px'; });

    const onMove = (ev) => {
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (ev.clientX - startX)));
      wrap.style.width = w + 'px';
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      col.width = Math.round(wrap.getBoundingClientRect().width);
      if (isFit) cols.forEach((c, idx) => { if (columns[idx]) columns[idx].width = Math.round(c.getBoundingClientRect().width); });
      saveConfig();
      if (isFit) updateColumnStyles();
      fitAll();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---- Drag-to-reorder (pointer-based, like the resizer) ----
// Hold the grip and drag across columns; the dragged column slots in live.
// The left/right buttons still work for one-step moves.
function attachReorder(grip, col) {
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const srcId = col.id;
    const srcWrap = terms.get(srcId) && terms.get(srcId).wrap;
    if (!srcWrap) return;
    document.body.classList.add('reordering');
    srcWrap.classList.add('dragging');
    const onMove = (ev) => {
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const overWrap = overEl && overEl.closest('.column');
      const overId = overWrap && overWrap.dataset.colId;
      if (!overId || overId === srcId) return;
      const from = columns.findIndex((c) => c.id === srcId);
      const to = columns.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = columns.splice(from, 1);
      columns.splice(to, 0, moved);
      // Reflow DOM to match the array — appendChild moves live nodes, no reload.
      columns.forEach((c) => { const w = terms.get(c.id) && terms.get(c.id).wrap; if (w) deckEl.appendChild(w); });
      updateColumnStyles();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('reordering');
      srcWrap.classList.remove('dragging');
      saveConfig();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---- Reorder / remove / add ----
function move(col, dir) {
  const idx = columns.indexOf(col);
  const j = idx + dir;
  if (j < 0 || j >= columns.length) return;
  [columns[idx], columns[j]] = [columns[j], columns[idx]];
  saveConfig();
  // Reorder DOM nodes only — keep the live terminals so nothing reloads.
  const nodes = deckEl.children;
  if (dir === 1) deckEl.insertBefore(nodes[j], nodes[idx]);
  else deckEl.insertBefore(nodes[idx], nodes[j]);
  updateColumnStyles();
}
// Surgical add/remove so touching one column never blanks the others' live output.
function removeCol(col) {
  const t = terms.get(col.id);
  if (t && t.alive && t.state === 'working' && !confirm('该列有任务正在运行，确认关闭该列？')) return;
  const idx = columns.indexOf(col);
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); t.wrap.remove(); terms.delete(col.id);
  }
  window.deck.ptyKill(col.id);
  columns.splice(idx, 1);
  // Don't leave focusedId pointing at the removed column: every focusedId-based
  // shortcut (Cmd+W, Cmd+arrows, search, broadcast) would silently no-op until
  // the user happens to click another column.
  if (focusedId === col.id) {
    focusedId = null;
    if (columns.length) focusColumnByIndex(Math.min(idx, columns.length - 1));
  }
  saveConfig();
}
function addColumn(c) {
  const col = { id: newId(), width: DEFAULT_WIDTH, cwd: '', ...c };
  columns.push(col);
  saveConfig();
  deckEl.appendChild(buildColumn(col));
  updateColumnStyles();
}
// Smallest unused positive integer, so new columns read 1,2,3… and fill gaps.
function nextTitle() {
  const used = new Set(columns.map((c) => parseInt(c.title, 10)).filter((n) => !isNaN(n)));
  let n = 1; while (used.has(n)) n++;
  return String(n);
}
// New column with no dialog: auto-numbered title, default (global) cwd, focused.
function addAndFocusColumn() {
  addColumn({ title: nextTitle() });
  setTimeout(() => focusColumnByIndex(columns.length - 1), 80); // wait for its terminal
}
// Double-click the title to rename it inline (Enter commits, Esc cancels). Uses
// the same span (contentEditable) so terms.titleEl stays valid.
function attachRename(titleEl, col) {
  titleEl.addEventListener('dblclick', (e) => {
    e.preventDefault(); e.stopPropagation();
    titleEl.contentEditable = 'true';
    titleEl.spellcheck = false;
    titleEl.focus();
    const range = document.createRange(); range.selectNodeContents(titleEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    let cancelled = false;
    const onKey = (ev) => {
      ev.stopPropagation(); // don't leak into terminal or Cmd shortcuts
      if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; titleEl.blur(); }
    };
    titleEl.addEventListener('keydown', onKey);
    titleEl.addEventListener('blur', () => {
      titleEl.removeEventListener('keydown', onKey);
      titleEl.contentEditable = 'false';
      window.getSelection().removeAllRanges();
      const v = titleEl.textContent.trim();
      if (!cancelled && v) col.title = v;
      titleEl.textContent = col.title; // normalize (drop stray newlines / restore on cancel)
      saveConfig();
    }, { once: true });
  });
}
// cwd change needs a fresh shell; rebuild just this column (new id so the old
// pty's exit event can't bleed into the new terminal).
function respawnColumn(col) {
  const t = terms.get(col.id);
  window.deck.ptyKill(col.id);
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); terms.delete(col.id);
  }
  const oldId = col.id;
  col.id = newId();
  if (focusedId === oldId) focusedId = col.id;
  const fresh = buildColumn(col);
  if (t) t.wrap.replaceWith(fresh); else render();
  saveConfig();
  updateColumnStyles();
}

// ---- Add / edit dialog ----
const dlg = document.getElementById('colDialog');
const titleInput = document.getElementById('titleInput');
const cwdInput = document.getElementById('cwdInput');
const cmdInput = document.getElementById('cmdInput');
const dlgTitle = document.getElementById('dlgTitle');
let editIndex = null;

function openDialog(idx) {
  editIndex = (typeof idx === 'number') ? idx : null;
  dlgTitle.textContent = editIndex === null ? '添加列' : '编辑列';
  titleInput.value = editIndex === null ? '' : (columns[editIndex].title || '');
  cwdInput.value = editIndex === null ? '' : (columns[editIndex].cwd || '');
  cmdInput.value = editIndex === null ? '' : (columns[editIndex].cmd || '');
  dlg.showModal();
  setTimeout(() => titleInput.focus(), 50);
}
// Preset buttons fill the startup command field.
document.querySelectorAll('.preset').forEach((b) => {
  b.onclick = () => { cmdInput.value = b.dataset.cmd; cmdInput.focus(); };
});
document.getElementById('dlgCancel').onclick = () => dlg.close();
document.getElementById('dlgSave').onclick = () => {
  const title = titleInput.value.trim() || 'Agent';
  const cwd = cwdInput.value.trim();
  const cmd = cmdInput.value.trim();
  if (editIndex === null) { addColumn({ title, cwd, cmd }); dlg.close(); return; }
  const col = columns[editIndex];
  const needsRespawn = (col.cwd || '') !== cwd || (col.cmd || '') !== cmd;
  col.title = title;
  col.cwd = cwd;
  col.cmd = cmd;
  const t = terms.get(col.id);
  if (t) t.titleEl.textContent = title; // title updates live, shell untouched
  saveConfig();
  if (needsRespawn) respawnColumn(col); // a cwd or startup-command change restarts the shell
  dlg.close();
};
// Enter saves from any field of the dialog, not just the title.
[titleInput, cwdInput, cmdInput].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('dlgSave').click(); }
  });
});

// ---- Boot ----
buildRail();
applyTheme(config.theme);
render();
window.addEventListener('resize', () => { updateColumnStyles(); fitAll(); });
// A file dropped anywhere but a terminal would otherwise make the window
// navigate to file://… — swallow those so the app never reloads.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Periodically mirror each column's rendered screen to the watch-ai daemon so
// it can notify when an agent running inside AgentDeck goes idle.
function dumpScreen(term) {
  const buf = term.buffer.active;
  const end = buf.length;
  const lines = [];
  for (let i = Math.max(0, end - 40); i < end; i++) {
    const ln = buf.getLine(i);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  return lines.join('\n');
}
setInterval(() => {
  terms.forEach((entry, id) => {
    const text = dumpScreen(entry.term);
    try { window.deck.agentdeckDump(id, entry.titleEl ? entry.titleEl.textContent : '', text); } catch (_) {}
    if (entry.alive) { entry.state = classify(text); setDot(entry, entry.state); } // exited dots stay dim
  });
}, 1500);

// ---- Keyboard shortcuts ----
// Focus the column at index, scrolling it into view. Captured before xterm.
function focusColumnByIndex(idx) {
  const col = columns[Math.max(0, Math.min(idx, columns.length - 1))];
  if (!col) return;
  const t = terms.get(col.id);
  if (t) { t.term.focus(); focusedId = col.id; t.wrap.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }
}
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey) return; // only plain Cmd combos
  const k = e.key;
  let handled = true;
  if (k === 'n' || k === 'N') {
    addAndFocusColumn();
  } else if (k === 'w' || k === 'W') {
    const idx = columns.findIndex((c) => c.id === focusedId);
    if (idx >= 0) { removeCol(columns[idx]); focusColumnByIndex(idx); }
  } else if (k === 'f' || k === 'F') {
    openSearch();
  } else if (k === 'b' || k === 'B') {
    toggleBroadcast();
  } else if (e.shiftKey && (k === 'r' || k === 'R')) {
    // Hot reload: reload renderer only, pty processes stay alive.
    window.deck.reloadRenderer();
  } else if (/^[1-9]$/.test(k)) {
    focusColumnByIndex(Number(k) - 1);
  } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const cur = columns.findIndex((c) => c.id === focusedId);
    focusColumnByIndex((cur < 0 ? 0 : cur) + (k === 'ArrowRight' ? 1 : -1));
  } else {
    handled = false;
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ---- Toast: transient feedback for link clicks ----
// Tells the user *why* a click didn't land where expected (the path doesn't
// exist on disk / only an ancestor exists) instead of failing silently.
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);
let toastTimer;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}
window.deck.onToast(showToast);

// ---- Broadcast input (Cmd+B): send one prompt to every column ----
const bcastBar = document.getElementById('bcastBar');
const bcastInput = document.getElementById('bcastInput');
function toggleBroadcast() {
  if (bcastBar.hidden) { bcastBar.hidden = false; bcastInput.focus(); bcastInput.select(); }
  else closeBroadcast();
}
function closeBroadcast() {
  bcastBar.hidden = true;
  const t = terms.get(focusedId);
  if (t) t.term.focus();
}
function sendBroadcast() {
  const text = bcastInput.value;
  if (!text.trim()) return;
  terms.forEach((t, id) => { if (t.alive) window.deck.ptyInput(id, text + '\r'); });
  bcastInput.value = '';
}
bcastInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); sendBroadcast(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeBroadcast(); }
});
document.getElementById('bcastSend').onclick = () => sendBroadcast();
document.getElementById('bcastClose').onclick = () => closeBroadcast();

// ---- In-column search (Cmd+F) ----
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
const searchInfo = document.getElementById('searchInfo');
let searchColId = null;
const SEARCH_DECOR = {
  decorations: {
    matchBackground: '#5a3a00', activeMatchBackground: '#1d9bf0',
    matchOverviewRuler: '#8a6d3b', activeMatchColorOverviewRuler: '#1d9bf0',
  },
};

function openSearch() {
  const col = columns.find((c) => c.id === focusedId) || columns[0];
  if (!col) return;
  const t = terms.get(col.id);
  if (!t || !t.search) return;
  searchColId = col.id;
  const r = t.wrap.getBoundingClientRect();
  searchBar.style.top = Math.round(r.top + 8) + 'px';
  searchBar.style.left = Math.round(Math.max(8, r.right - 312)) + 'px';
  searchBar.hidden = false;
  searchInput.focus(); searchInput.select();
  if (searchInput.value) doSearch(1);
}
function doSearch(dir) {
  const t = terms.get(searchColId);
  if (!t || !t.search) return;
  const q = searchInput.value;
  searchInfo.textContent = '';
  if (!q) { try { t.search.clearDecorations(); } catch (_) {} return; }
  try {
    const fn = dir < 0 ? t.search.findPrevious : t.search.findNext;
    fn.call(t.search, q, SEARCH_DECOR);
  } catch (_) {}
}
function closeSearch() {
  searchBar.hidden = true;
  const t = terms.get(searchColId);
  if (t) { try { t.search.clearDecorations(); } catch (_) {} t.term.focus(); }
  searchColId = null;
}
searchInput.addEventListener('input', () => doSearch(1));
searchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
document.getElementById('searchNext').onclick = () => doSearch(1);
document.getElementById('searchPrev').onclick = () => doSearch(-1);
document.getElementById('searchClose').onclick = () => closeSearch();
