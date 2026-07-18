const { Terminal } = window;            // from vendor/xterm.js (UMD global)
const FitAddonNS = window.FitAddon;      // from vendor/addon-fit.js
const SearchAddonNS = window.SearchAddon; // from vendor/addon-search.js
const CanvasAddonNS = window.CanvasAddon; // from vendor/addon-canvas.js

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
  up:    S('<polyline points="18 15 12 9 6 15"/>'),
  down:  S('<polyline points="6 9 12 15 18 9"/>'),
  help:  S('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
};

// ---- Config / state ----
const DEFAULT_WIDTH = 460; // fallback ~⅓ of a typical Mac deck before layout is known
const MIN_WIDTH = 260;
const MAX_WIDTH = 1100;
// "Fit window" splits the deck area (screen minus sidebar) into this many EQUAL
// columns. Was a fixed constant; now a saved, user-pickable value (2–5) via the
// fit button's hover menu. Default 3 on macOS, 4 on Windows (wide displays).
const DEFAULT_FIT_COLS = env.platform === 'win32' ? 4 : 3;
const FIT_COLS_CHOICES = [2, 3, 4, 5];
// Left panel (toolbar + column list): draggable width + collapse-to-icons.
const NAV_DEFAULT_W = 184, NAV_MIN_W = 90, NAV_MAX_W = 360, NAV_COLLAPSED_W = 56;

const TERM_THEME = {
  dark:  { background: '#000000', foreground: '#e7e9ea', cursor: '#1d9bf0', selectionBackground: 'rgba(29,155,240,0.35)' },
  light: { background: '#ffffff', foreground: '#0f1419', cursor: '#1d9bf0', selectionBackground: 'rgba(29,155,240,0.25)' },
};

function newId() { return 'c' + Date.now() + Math.floor(Math.random() * 1000); }
// A column whose startup command is Claude Code. On RESTORE (app restart) we
// resume the prior conversation with `claude --continue` instead of launching a
// brand-new session — but only when one already exists for the cwd.
function isClaudeCmd(cmd) { return /^\s*claude(\s|$)/.test(cmd || ''); }
function withClaudeResume(cmd) {
  const t = (cmd || '').trim();
  if (/(^|\s)(--continue|-c|--resume|-r)(\s|$)/.test(t)) return cmd; // already resuming
  return t.replace(/^claude/, 'claude --continue');
}
// Fresh / reset layout: three agent columns that auto-launch on open.
function defaultColumns() {
  const agents = [
    { title: 'Antigravity', cmd: 'agy' },
    { title: 'Claude', cmd: 'claude --dangerously-skip-permissions' },
    { title: 'Grok', cmd: 'grok' },
  ];
  return agents.map((a) => ({ id: newId(), title: a.title, cwd: '', cmd: a.cmd, width: DEFAULT_WIDTH }));
}

// Titles the app itself assigned (auto numbers, preset agent names) are fair
// game for auto-naming; anything else counts as a manual rename.
const AUTO_TITLES = new Set(['Agent', 'Antigravity', 'Claude', 'Grok']);
function isManualTitle(t) { return !!t && !/^\d+$/.test(String(t).trim()) && !AUTO_TITLES.has(String(t).trim()); }

let config = { theme: 'dark', fitWindow: false, fitCols: DEFAULT_FIT_COLS, navWidth: 184, navCollapsed: false, fontSize: 13, columns: defaultColumns() };
const saved = window.deck.loadConfig();
if (saved) {
  if (saved.theme) config.theme = saved.theme;
  if (saved.fitWindow !== undefined) config.fitWindow = saved.fitWindow;
  if (FIT_COLS_CHOICES.includes(saved.fitCols)) config.fitCols = saved.fitCols;
  if (saved.navWidth) config.navWidth = saved.navWidth;
  if (saved.navCollapsed !== undefined) config.navCollapsed = saved.navCollapsed;
  if (typeof saved.fontSize === 'number' && saved.fontSize >= 8 && saved.fontSize <= 32) config.fontSize = saved.fontSize;
  if (Array.isArray(saved.columns) && saved.columns.length) {
    config.columns = saved.columns.map((c) => ({
      id: c.id || newId(), title: c.title || 'Agent', cwd: c.cwd || '', cmd: c.cmd || '', width: c.width || DEFAULT_WIDTH,
      // Pre-feature configs carry no manualTitle: infer it. Auto-ish titles
      // (pure numbers, preset agent names) stay auto-renamable; anything else
      // was typed by the user and must never be auto-renamed.
      manualTitle: c.manualTitle !== undefined ? !!c.manualTitle : isManualTitle(c.title),
    }));
  }
}
let columns = config.columns;
function saveConfig() { config.columns = columns; window.deck.saveConfig(config); }

// ---- Auto column naming ----
// Each prompt the user submits to a column gets summarized (main process:
// OpenRouter → `claude -p` → keyword truncation) into a ≤10-char label for the
// header, so the deck reads as tasks ("修登录bug") instead of "1 2 3". A manual
// rename (double-click header/sidebar, edit dialog) locks the column for good.
const autoNameSeq = new Map();   // col.id → latest request seq (stale replies dropped)
const autoNameLast = new Map();  // col.id → last prompt already summarized
const AUTONAME_SKIP = /^(好的?|谢谢|继续|可以|行|嗯+|没问题|开始吧?|开干|test|hi|hello|go( ahead)?|ok(ay)?|yes|no|q|exit|quit|clear|cls|pwd|ls( -[a-z]+)?)$/i;

function maybeAutoName(col, line) {
  if (!line || col.manualTitle) return;
  if (line.length < 4) return;
  if (!/[一-鿿]/.test(line) && line.length < 6) return;   // short ASCII: "y", "ls", …
  if (/^[\d\s.,]+$/.test(line)) return;                    // menu selections ("1", "2 3")
  if (line.startsWith('/') || line.startsWith('!')) return; // slash/bang commands, not tasks
  if (AUTONAME_SKIP.test(line)) return;
  if (line === (col.cmd || '').trim()) return;             // re-typed launch command
  if (autoNameLast.get(col.id) === line) return;
  autoNameLast.set(col.id, line);
  const seq = (autoNameSeq.get(col.id) || 0) + 1;
  autoNameSeq.set(col.id, seq);
  window.deck.summarizeTitle(line).then((label) => {
    if (!label || col.manualTitle) return;
    if (autoNameSeq.get(col.id) !== seq) return;  // a newer prompt won
    if (!columns.includes(col)) return;           // column removed meanwhile
    setColumnTitle(col, label);
  }).catch(() => {});
}

// Rebuild the line being typed from raw pty input so the submitted prompt can
// be caught. Printables append, backspace deletes, Enter submits. Escape
// sequences (arrow keys, and xterm's auto-replies to terminal queries) are
// skipped; inside a bracketed paste a newline is literal content, not "send".
function makePromptTracker(col) {
  let buf = '', inPaste = false;
  return (d) => {
    for (let i = 0; i < d.length; ) {
      const ch = d[i];
      if (ch === '\x1b') {
        if (d.startsWith('[200~', i + 1)) { inPaste = true; i += 6; continue; }
        if (d.startsWith('[201~', i + 1)) { inPaste = false; i += 6; continue; }
        const m = /^\x1b(\[[0-9;?]*[@-~]|O.|.)/.exec(d.slice(i, i + 24));
        i += m ? m[0].length : 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (inPaste) buf += ' ';
        else { const line = buf.trim(); buf = ''; maybeAutoName(col, line); }
        i++;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); i++; continue; }
      if (ch === '\x03' || ch === '\x15') { buf = ''; i++; continue; }  // ^C / ^U clear the line
      if (ch < ' ') { i++; continue; }
      buf += ch;
      if (buf.length > 2000) buf = buf.slice(-2000);
      i++;
    }
  };
}

// ---- Terminals ----
const terms = new Map(); // id -> { term, fit, el, wrap, titleEl, dot, alive }
let focusedId = null;    // id of the column whose terminal last had focus
let zoomedId = null;     // column temporarily maximized to fill the deck (Cmd+Enter / double-click header)

// Zoom in/out of one column. Focus follows the zoom so typing lands where
// you're looking; while zoomed, moving focus (Cmd+←→/1-9/J) re-zooms onto the
// newly focused column instead of typing into a hidden one.
function toggleZoom(id) {
  if (!id || !terms.has(id)) return;
  zoomedId = zoomedId === id ? null : id;
  updateColumnStyles();
  fitAll();
  const t = terms.get(id);
  if (t) { t.term.focus(); focusedId = id; syncNav(); }
}

window.deck.onPtyData((id, data) => { const t = terms.get(id); if (t) t.term.write(data); });
window.deck.onPtyExit((id) => {
  const t = terms.get(id);
  if (t) {
    t.alive = false; t.state = 'exited';
    // Finalize a running timer so the exited column shows "✓ total", not a
    // frozen mid-count.
    if (t.workStart) { t.workedMs = Date.now() - t.workStart; t.workStart = 0; t.doneAt = Date.now(); }
    t.term.write('\r\n\x1b[2m[已退出 / process exited]\x1b[0m\r\n');
    setDot(t, 'exited'); syncNav();
  }
});

// Per-column status: 5 states matching the owner's mental model —
//   plain   gray   = not started (plain shell, or agent launched but never given work)
//   working yellow = AI is running a turn (breathing pulse)
//   input   red    = agent stopped to ASK the user something (permission / y-n / options)
//   done    green  = agent finished: idle at its prompt AFTER having worked
//   exited  ring   = pty process died
// "done" vs "plain" can't be told apart from screen text alone (both are an idle
// prompt), so each column remembers hasWorked; idleTicks debounces the working→done
// flip (~3s) so the dot doesn't flash green in the gaps between tool calls.
// Regexes largely borrowed from watch-ai's battle-tested ACTIVE_PATTERNS/idle sets.
const WORKING_RE = /esc to interrupt|Running(?:\.\.\.|…)|⎿\s+Running|\(\d+s\s*·|…\s*\(\d+s|[↑↓]\s*[\d.]+k?\s+tokens|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;
// Only structurally dialog-shaped patterns: prose like "Would you like me to
// also…?" at the end of a normal reply must NOT hold a column red forever.
// Claude/Grok permission prompts always render a "❯ 1." option list; y/n
// prompts show "(y/n)"; Antigravity's approval footer is "Enter to confirm".
const NEEDS_INPUT_RE = /❯\s*\d+\.\s|\(y\/n\)|\[y\/n\]|enter to confirm|trust (?:this|the) (?:folder|workspace|files)|waiting for (?:your |user )?(?:input|confirmation|approval|permission)/im;
const AGENT_IDLE_RE = /bypass permissions|for shortcuts|← for agents|Build anything|Antigravity|Claude Code|Composer|Model:\s+(?:Opus|Sonnet|Haiku|Fable)|Context:\s*\[|^❯\s*$|│\s*❯/im;
const DOT_TIP = { plain: '未开始', working: '干活中…', input: '等你回复！', done: '已完成', exited: '已退出' };
function classify(text, entry) {
  const lines = text.split('\n');
  if (NEEDS_INPUT_RE.test(lines.slice(-20).join('\n'))) return 'input';
  if (WORKING_RE.test(lines.slice(-15).join('\n'))) return 'working';
  if (AGENT_IDLE_RE.test(text)) return (entry && entry.hasWorked) ? 'done' : 'plain';
  return 'plain';
}
function setDot(entry, state) {
  if (!entry || !entry.dot) return;
  entry.dot.className = 'dot ' + state;
  entry.dot.title = DOT_TIP[state] || '';
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

// ---- Terminal font size (Ctrl on Win/Linux, Cmd on Mac; +/- adjust, 0 reset) ----
const FONT_MIN = 8, FONT_MAX = 32, FONT_DEFAULT = 13;
function setFontSize(size) {
  size = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  if (size === config.fontSize) return;
  config.fontSize = size;
  terms.forEach(({ term }) => { term.options.fontSize = size; });
  fitAll();
  saveConfig();
  showToast(`字体大小 ${size}px`);
}
// Returns +1/-1 for a font-size keydown, 0 for reset, null otherwise.
function fontSizeDelta(e) {
  if (e.type !== 'keydown' || e.altKey) return null;
  if (!(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey)) return null;
  const k = e.key;
  if (k === '+' || k === '=') return 1;
  if (k === '-' || k === '_') return -1;
  if (k === '0') return 0;
  return null;
}

// ---- Left panel toolbar (add / broadcast / fit / theme / reset / collapse) ----
function railBtn(svg, tip, onClick, accent) {
  const b = document.createElement('button');
  b.className = 'rail-btn' + (accent ? ' accent' : '');
  b.innerHTML = svg; b.title = tip; b.onclick = onClick;
  return b;
}
function buildRail() {
  const top = document.getElementById('navTop');
  const bottom = document.getElementById('navBottom');
  top.innerHTML = ''; bottom.innerHTML = '';

  // Top row = primary actions: collapse the panel, add a column, broadcast.
  const collapseBtn = railBtn(ICONS.left, '折叠侧边栏', () => setNavCollapsed(!config.navCollapsed));
  collapseBtn.id = 'navCollapseBtn';
  top.appendChild(collapseBtn);
  top.appendChild(railBtn(ICONS.plus, '添加列 (Cmd+N)', () => addAndFocusColumn(), true));
  top.appendChild(railBtn(ICONS.send, '广播：同一条输入发给所有列 (Cmd+B)', () => toggleBroadcast()));

  // Bottom row = utilities, pinned under the list.
  // Fit button: a CLICK toggles equal-fit on/off (keeps the current column
  // count); HOVERING reveals a menu to pick how many EQUAL columns fill the
  // screen (2–5). Picking a number turns fit on. Overflow columns past that
  // count keep the same slice width and scroll.
  const fitWrap = document.createElement('div');
  fitWrap.className = 'fit-wrap';

  const fitBtn = railBtn(ICONS.fit, '等比例适应窗口（悬停选择列数）/ 横向滚动', () => {
    config.fitWindow = !config.fitWindow;
    applyFit();
  });
  fitBtn.id = 'fitBtn';

  const fitMenu = document.createElement('div');
  fitMenu.className = 'fit-menu';
  FIT_COLS_CHOICES.forEach((n) => {
    const item = document.createElement('button');
    item.className = 'fit-menu-item';
    item.textContent = String(n);
    item.title = n + ' 列均分';
    item.dataset.cols = String(n);
    item.onclick = (e) => {
      e.stopPropagation();
      config.fitCols = n;
      config.fitWindow = true;
      applyFit();
    };
    fitMenu.appendChild(item);
  });

  function applyFit() {
    fitBtn.classList.toggle('accent', config.fitWindow);
    fitMenu.querySelectorAll('.fit-menu-item').forEach((el) => {
      el.classList.toggle('active', config.fitWindow && Number(el.dataset.cols) === fitCols());
    });
    saveConfig(); updateColumnStyles(); fitAll();
  }
  applyFit();

  fitWrap.appendChild(fitBtn);
  fitWrap.appendChild(fitMenu);
  bottom.appendChild(fitWrap);

  const themeBtn = railBtn(ICONS.moon, '切换主题', () => applyTheme(config.theme === 'dark' ? 'light' : 'dark'));
  themeBtn.id = 'themeBtn';
  bottom.appendChild(themeBtn);

  bottom.appendChild(railBtn(ICONS.help, '快捷键与使用提示 (Cmd+/)', () => toggleHelp()));

  bottom.appendChild(railBtn(ICONS.reset, '恢复默认布局', () => {
    if (!confirm('恢复默认列布局？现有列的终端会关闭。')) return;
    columns.forEach((c) => window.deck.ptyKill(c.id));
    columns = defaultColumns();
    const w = defaultColWidth(); columns.forEach((c) => { c.width = w; }); // equal slices
    saveConfig(); render();
  }));
}

// ---- Left panel width + collapse ----
function applyNavWidth() {
  const w = config.navCollapsed ? NAV_COLLAPSED_W : (config.navWidth || NAV_DEFAULT_W);
  colNavEl.style.flex = '0 0 ' + w + 'px';
  colNavEl.style.width = w + 'px';
}
function setNavCollapsed(v) {
  config.navCollapsed = v;
  colNavEl.classList.toggle('collapsed', v);
  const btn = document.getElementById('navCollapseBtn');
  if (btn) { btn.innerHTML = v ? ICONS.right : ICONS.left; btn.title = v ? '展开侧边栏' : '折叠侧边栏'; }
  applyNavWidth();
  saveConfig();
  fitAll(); // deck width changed
}
function attachNavResize(handle) {
  handle.addEventListener('mousedown', (e) => {
    if (config.navCollapsed) return; // no resizing while collapsed
    e.preventDefault();
    const startX = e.clientX;
    const startW = colNavEl.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    let rawW = startW; // where the pointer actually wants the edge, unclamped
    const onMove = (ev) => {
      rawW = startW + (ev.clientX - startX);
      const w = Math.max(NAV_MIN_W, Math.min(NAV_MAX_W, rawW));
      colNavEl.style.flex = '0 0 ' + w + 'px';
      colNavEl.style.width = w + 'px';
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Dragged well past the minimum → collapse to the icon rail (same as the
      // collapse button). navWidth keeps its pre-drag value for re-expanding.
      if (rawW < NAV_MIN_W - 30) {
        colNavEl.style.flex = ''; colNavEl.style.width = '';
        setNavCollapsed(true);
        return;
      }
      config.navWidth = Math.round(colNavEl.getBoundingClientRect().width);
      saveConfig(); fitAll();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
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

  if (config.fitWindow && columns.length <= fitCols()) return; // nothing to scroll
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    deckEl.scrollLeft += e.deltaX;
    e.preventDefault();
    e.stopPropagation();
  }
}, { capture: true, passive: false });

// The drift-guard below must fire only for STRAY auto-scrolls (the browser
// pulling the focused xterm textarea back into view after it moves during IME /
// typing), never for a deliberate drag of the bottom scrollbar. A scrollbar drag
// fires no 'wheel' event, so isUserScrollingDeck stays false and the textarea is
// still focused: the old guard snapped every drag frame back, so the bar smeared
// (残影) and could not be dragged. Stray auto-scrolls happen within a frame or
// two of textarea input/focus, so we only arm the guard for a short window after
// that activity; outside it, scrollbar drags are honored normally.
let lastTextareaActivityTs = 0;
const markTextareaActivity = (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('xterm-helper-textarea')) {
    lastTextareaActivityTs = Date.now();
  }
};
['input', 'compositionstart', 'compositionupdate', 'compositionend', 'focusin']
  .forEach((type) => deckEl.addEventListener(type, markTextareaActivity, true));

let lastValidDeckScrollLeft = deckEl.scrollLeft;
deckEl.addEventListener('scroll', () => {
  const driftLikely = Date.now() - lastTextareaActivityTs < 300;
  if (!isUserScrollingDeck && driftLikely &&
      document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')) {
    deckEl.scrollLeft = lastValidDeckScrollLeft;
  } else {
    lastValidDeckScrollLeft = deckEl.scrollLeft;
  }
});

function render() {
  // tear down existing terminals; pty processes keep running until killed.
  // Run each entry's disposers too — the deckEl scroll listener and the
  // ResizeObserver live outside the column's DOM and would leak per column
  // on every full re-render (e.g. 恢复默认布局) otherwise.
  terms.forEach((t) => {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose();
  });
  terms.clear();
  zoomedId = null;
  deckEl.innerHTML = '';
  columns.forEach((col) => deckEl.appendChild(buildColumn(col)));
  updateColumnStyles();
  renderColNav();
}

// "Fit window" divides the deck area (screen minus the sidebar) into fitCols()
// EQUAL columns: that many fill the screen exactly, more keep the same width and
// scroll. The divisor is user-pickable (2–5) via the fit button's hover menu and
// also sets a new column's default width (deckWidth / fitCols()).
function fitCols() { return config.fitCols || DEFAULT_FIT_COLS; }

// Default width for a freshly added column: one equal slice of the current deck
// area. Falls back to a fixed width before the deck has been laid out.
function defaultColWidth() {
  const W = deckEl ? deckEl.clientWidth : 0;
  if (!W) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(W / fitCols())));
}

function updateColumnStyles() {
  const colEls = deckEl.querySelectorAll('.column');
  const n = columns.length;

  // Zoom mode: one column fills the whole deck, the rest are hidden. Transient
  // (never persisted) — a restart always comes back unzoomed.
  if (zoomedId && terms.has(zoomedId)) {
    colEls.forEach((wrap) => {
      const is = wrap.dataset.colId === zoomedId;
      wrap.style.display = is ? 'flex' : 'none';
      wrap.classList.toggle('zoomed', is);
      if (is) { wrap.style.flex = '1 1 0'; wrap.style.width = ''; }
    });
    deckEl.style.overflowX = 'hidden';
    return;
  }
  colEls.forEach((wrap) => { wrap.style.display = ''; wrap.classList.remove('zoomed'); });

  if (config.fitWindow) {
    const cols = fitCols();
    if (n <= cols) {
      // Up to fitCols() columns: flex them to equal widths filling the screen,
      // no scroll, no rounding gap.
      deckEl.style.overflowX = 'hidden';
      colEls.forEach((wrap) => { wrap.style.flex = '1 1 0'; wrap.style.width = ''; });
    } else {
      // More: pin every column to one equal slice so the first fitCols() fill
      // the screen and the rest scroll, all the same width.
      const w = Math.floor(deckEl.clientWidth / cols);
      colEls.forEach((wrap) => { wrap.style.flex = '0 0 auto'; wrap.style.width = w + 'px'; });
      deckEl.style.overflowX = 'scroll';
    }
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

function buildColumn(col, isFresh) {
  const wrap = document.createElement('div');
  wrap.className = 'column';
  wrap.dataset.colId = col.id; // lets drag-reorder map a DOM column back to its id
  // updateColumnStyles() runs right after and is the source of truth for sizing;
  // this just avoids a first-frame flash before it does.
  if (config.fitWindow) wrap.style.flex = '1 1 0';
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

  // Live elapsed-time readout: counts up while the agent works, then freezes
  // as "✓ 2m 14s" for a few minutes after it finishes.
  const timerEl = document.createElement('span');
  timerEl.className = 'work-timer';

  const secondary = document.createElement('span');
  secondary.className = 'secondary';
  secondary.append(
    mkBtn(ICONS.left, '左移', () => move(col, -1)),
    mkBtn(ICONS.right, '右移', () => move(col, 1)),
    mkBtn(ICONS.edit, '编辑', () => openDialog(columns.indexOf(col))),
    mkBtn(ICONS.close, '删除该列', () => removeCol(col)),
  );
  head.append(grip, dot, title, timerEl, secondary);
  // Double-click an empty part of the header to zoom the column (the title
  // owns double-click for rename; buttons/grip own their clicks).
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('.title') || e.target.closest('.icon-btn') || e.target.closest('.grip')) return;
    toggleZoom(col.id);
  });

  const termEl = document.createElement('div');
  termEl.className = 'term';

  const resizer = document.createElement('div');
  resizer.className = 'resizer';
  attachResize(resizer, wrap, col);

  wrap.append(head, termEl, resizer);

  // Create the terminal once the element is in the DOM (next frame).
  requestAnimationFrame(() => {
    const term = new Terminal({
      // Platform-aware stack: the mac list is all-macOS fonts, so on Windows it
      // used to fall through to Courier New + the browser's default CJK (SimSun).
      // "PingFang SC"/"Microsoft YaHei" give CJK output a consistent face (xterm
      // already lays CJK out as double-width cells, so columns still line up).
      fontFamily: env.platform === 'win32'
        ? '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace'
        : 'SFMono-Regular, "SF Mono", Menlo, Monaco, "PingFang SC", "Courier New", monospace',
      fontSize: config.fontSize, lineHeight: 1.0, cursorBlink: true, scrollback: 12000,
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
    // Renderer: the Canvas addon (2D canvas), NOT WebGL. Each WebGL terminal
    // holds its own GPU context, and Chromium hard-caps live WebGL contexts
    // (~16) and silently EVICTS the oldest when a new one is created — including
    // on focus, where the old code rebuilt the context per column. That eviction
    // (and GPU texture purges of un-focused terminals, which WebGL never
    // repaints) is exactly why switching to one column turned the others into
    // garbage tiles, and why clicking a garbled one "fixed" it (it forced that
    // one to repaint). The Canvas renderer has no such context cap or eviction,
    // so the corruption can't happen — at a small CPU cost vs WebGL. Must load
    // after open() (needs the canvas element).
    try { if (CanvasAddonNS && CanvasAddonNS.CanvasAddon) term.loadAddon(new CanvasAddonNS.CanvasAddon()); } catch (_) {}
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
    terms.set(col.id, {
      term, fit, search, el: termEl, wrap, titleEl: title, dot, timerEl, alive: true, state: 'plain', disposers,
      // Status-machine memory: hasWorked separates green "just finished" from
      // gray "idle since launch"; idleTicks debounces working→done (~3s);
      // workStart/workedMs drive the header timer; lastDump skips redundant IPC.
      hasWorked: false, idleTicks: 0, workStart: 0, workedMs: 0, doneAt: 0, lastDump: '',
    });

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
      // Ctrl+V pastes the clipboard (macOS Cmd+V already pastes natively).
      // A terminal normally sends Ctrl+V to the pty as a literal ^V AND cancels
      // the browser's native paste, so a synthesized Ctrl+V from a voice tool
      // (闪电说) never lands — only Ctrl+Shift+V did, because xterm leaves that
      // one alone. Intercept plain Ctrl+V, suppress the default ^V, and paste
      // explicitly via xterm so bracketed-paste-aware apps (Claude, vim, …)
      // still receive it correctly. Shift/Alt are excluded so Ctrl+Shift+V and
      // any future bindings keep their behavior.
      if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
          (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
        const text = window.deck.clipboardRead();
        if (text) term.paste(text);
        else pasteImageAsPath(); // clipboard holds an image (screenshot) → paste its temp-file path
        e.preventDefault();
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
        if (col.cmd) {
          let launch = col.cmd;
          // Restoring a Claude column → continue its previous conversation.
          if (!isFresh && isClaudeCmd(col.cmd) && await window.deck.claudeHasSession(col.cwd || env.home)) {
            launch = withClaudeResume(col.cmd);
          }
          // Capture the id: if the user edits the column within 700ms,
          // respawnColumn assigns a NEW id and this stale timer must not fire
          // into the fresh pty (whose own timer will run the command).
          const spawnId = col.id;
          setTimeout(() => { if (terms.has(spawnId)) window.deck.ptyInput(spawnId, launch + '\r'); }, 700);
        }
      }
    };
    reconnect();
    const trackPrompt = makePromptTracker(col);
    term.onData((d) => { if (!replayMuted) { window.deck.ptyInput(col.id, d); trackPrompt(d); } });
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
    // Clicking anywhere in the column (incl. its header) makes it the focused
    // column — otherwise Cmd+W etc. silently act on the previously focused one.
    // Buttons/grip/inline-rename keep their own behavior.
    wrap.addEventListener('mousedown', (e) => {
      if (e.target.closest('.icon-btn') || e.target.closest('.grip') || e.target.closest('[contenteditable="true"]')) return;
      term.focus(); focusedId = col.id; syncNav();
    });

    // Paste an IMAGE (e.g. a fresh screenshot on the clipboard) → main saves
    // it to a temp PNG and we type its shell-quoted path, mirroring the
    // drag-drop-a-file behavior. Text pastes fall through to xterm's native
    // handling. (The Ctrl+V key handler below covers the same for Windows,
    // where the DOM paste event is suppressed.)
    const pasteImageAsPath = () => window.deck.pasteImageSave().then((p) => {
      if (p) { term.focus(); window.deck.ptyInput(col.id, shellQuote(p) + ' '); }
      return !!p;
    }).catch(() => false);
    termEl.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      if (!items.some((it) => it.kind === 'file' && /^image\//.test(it.type))) return;
      e.preventDefault(); e.stopPropagation();
      pasteImageAsPath();
    }, true);

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
  // Windows absolute paths: "C:\Users\jinhao\proj\file.js:12" or "C:/…". Only
  // matched on Windows so a stray "C:\" in prose can't hijack macOS output.
  if (env.platform === 'win32') {
    const winRe = /\b[A-Za-z]:[\\/](?:[^\s"'`<>|:*?，。、；：！？（）【】「」]| (?![\s\\/]))+(?::\d+(?::\d+)?)?/gu;
    while ((m = winRe.exec(text))) {
      const s = m.index, e = trimTrail(text, s, s + m[0].length);
      if (out.some((o) => s < o.end && e > o.start)) continue;
      out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
    }
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
    if (zoomedId) return; // zoomed: hidden columns would snapshot width 0
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
      // Clamp saved widths and never persist a 0 from a hidden/collapsed column.
      const clampW = (w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
      col.width = clampW(wrap.getBoundingClientRect().width);
      if (isFit) cols.forEach((c, idx) => {
        const r = c.getBoundingClientRect().width;
        if (columns[idx] && r > 0) columns[idx].width = clampW(r);
      });
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
      renderColNav();
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
  renderColNav();
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
  if (zoomedId === col.id) { zoomedId = null; updateColumnStyles(); fitAll(); }
  // Don't leave focusedId pointing at the removed column: every focusedId-based
  // shortcut (Cmd+W, Cmd+arrows, search, broadcast) would silently no-op until
  // the user happens to click another column.
  if (focusedId === col.id) {
    focusedId = null;
    if (columns.length) focusColumnByIndex(Math.min(idx, columns.length - 1));
  }
  saveConfig();
  renderColNav();
}
function addColumn(c) {
  const col = { id: newId(), width: defaultColWidth(), cwd: '', ...c };
  columns.push(col);
  saveConfig();
  deckEl.appendChild(buildColumn(col, true)); // brand-new column: never auto-resume
  updateColumnStyles();
  renderColNav();
}
// Smallest unused positive integer, so new columns read 1,2,3… and fill gaps.
function nextTitle() {
  const used = new Set(columns.map((c) => parseInt(c.title, 10)).filter((n) => !isNaN(n)));
  let n = 1; while (used.has(n)) n++;
  return String(n);
}
// New column with no dialog: auto-numbered title, default (global) cwd, focused.
function addAndFocusColumn() {
  if (zoomedId) { zoomedId = null; updateColumnStyles(); } // new column must be visible
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
      if (!cancelled && v) { col.manualTitle = true; setColumnTitle(col, v); } // syncs header + sidebar + saves; locks out auto-naming
      else titleEl.textContent = col.title; // normalize (drop stray newlines / restore on cancel)
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
  if (zoomedId === oldId) zoomedId = col.id; // stay zoomed across a respawn
  const fresh = buildColumn(col, true); // cwd/cmd just changed: start fresh, no auto-resume
  if (t) t.wrap.replaceWith(fresh); else render();
  saveConfig();
  updateColumnStyles();
  renderColNav();
}

// ---- Column sidebar (list of columns: click to jump, double-click to rename) ----
// One source of truth for a column's name so the header title and the sidebar
// entry never drift: rename in either place flows through here.
function setColumnTitle(col, title) {
  col.title = title;
  const t = terms.get(col.id);
  if (t && t.titleEl && t.titleEl.textContent !== title) t.titleEl.textContent = title;
  const nav = navItems.get(col.id);
  if (nav && nav.label.textContent !== title) nav.label.textContent = title;
  saveConfig();
}

const colNavEl = document.getElementById('colNav');
const navListEl = document.getElementById('navList');
const navItems = new Map(); // id -> { el, dot, label }

// Rebuild the whole list from `columns`. Cheap (plain DOM, no terminals), so we
// just call it on every structural change (add/remove/reorder/respawn).
function renderColNav() {
  if (!navListEl) return;
  navItems.clear();
  navListEl.innerHTML = '';
  columns.forEach((col, i) => {
    const item = document.createElement('div');
    item.className = 'colnav-item';
    item.dataset.colId = col.id;
    const dot = document.createElement('span'); dot.className = 'cn-dot';
    const text = document.createElement('span'); text.className = 'cn-text';
    const label = document.createElement('span'); label.className = 'cn-label';
    label.textContent = col.title; label.title = '双击重命名';
    // Live activity line: the column's last terminal line, mission-control style.
    const sub = document.createElement('span'); sub.className = 'cn-sub';
    text.append(label, sub);
    // Right slot: the Cmd+number hint for the first 9 columns, swapped for a
    // delete ✕ on hover.
    const right = document.createElement('span'); right.className = 'cn-right';
    const idx = document.createElement('span'); idx.className = 'cn-index';
    idx.textContent = i < 9 ? String(i + 1) : '';
    const del = document.createElement('button');
    del.className = 'cn-del'; del.innerHTML = ICONS.close; del.title = '删除该列';
    del.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a drag
    del.addEventListener('click', (e) => { e.stopPropagation(); removeCol(col); });
    right.append(idx, del);
    item.append(dot, text, right);
    // Drag reorders (deck follows); a plain click jumps; double click renames.
    attachNavReorder(item, col);
    attachNavRename(label, col);
    navListEl.appendChild(item);
    navItems.set(col.id, { el: item, dot, label, sub });
  });
  const countEl = document.getElementById('navCount');
  if (countEl) countEl.textContent = String(columns.length);
  syncNav();
}

// Mirror each entry's status dot and mark the focused column as active — both
// in the sidebar and on the deck column itself (accent bar via .focused).
function syncNav() {
  navItems.forEach((nav, id) => {
    const entry = terms.get(id);
    const state = (entry && entry.state) || 'plain';
    nav.dot.className = 'cn-dot ' + state;
    nav.dot.title = DOT_TIP[state] || '';
    nav.el.classList.toggle('active', id === focusedId);
  });
  terms.forEach((t, id) => { if (t.wrap) t.wrap.classList.toggle('focused', id === focusedId); });
}

function jumpToColumn(col) {
  const t = terms.get(col.id);
  if (!t) return;
  // While zoomed, jumping re-zooms onto the target instead of focusing a hidden column.
  if (zoomedId && zoomedId !== col.id) { zoomedId = col.id; updateColumnStyles(); fitAll(); }
  t.term.focus(); focusedId = col.id;
  t.wrap.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  syncNav();
}

// Popup-notification click: jump straight to the column whose agent fired the
// event (id = that pty's AGENTDECK_COL_ID). Stale id — the column respawned
// since — falls back to a column waiting for input, then to a just-done one.
window.deck.onFocusColumn((id) => {
  let col = columns.find((c) => c.id === id);
  if (!col) {
    const byState = (s) => columns.find((c) => { const t = terms.get(c.id); return t && t.state === s; });
    col = byState('input') || byState('done');
  }
  if (col) jumpToColumn(col);
});

// Drag a sidebar entry to reorder; the deck columns reflow to match live (no
// reload). Below the move threshold it's a plain click → jump to that column.
function attachNavReorder(item, col) {
  item.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const label = item.querySelector('.cn-label');
    if (label && label.isContentEditable) return; // renaming, not dragging
    e.preventDefault(); // don't text-select the label while pressing
    const srcId = col.id;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        document.body.classList.add('reordering');
      }
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const overItem = overEl && overEl.closest('.colnav-item');
      const overId = overItem && overItem.dataset.colId;
      if (!overId || overId === srcId) return;
      const from = columns.findIndex((c) => c.id === srcId);
      const to = columns.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = columns.splice(from, 1);
      columns.splice(to, 0, moved);
      // Reflow the deck to match the array — appendChild moves live nodes.
      columns.forEach((c) => { const w = terms.get(c.id) && terms.get(c.id).wrap; if (w) deckEl.appendChild(w); });
      updateColumnStyles();
      renderColNav(); // rebuild the sidebar in the new order (replaces nodes)
      const fresh = navItems.get(srcId); // re-mark the moved entry as dragging
      if (fresh) fresh.el.classList.add('cn-dragging');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('reordering');
      if (dragging) {
        const fresh = navItems.get(srcId);
        if (fresh) fresh.el.classList.remove('cn-dragging');
        saveConfig();
      } else {
        jumpToColumn(col); // it was a click, not a drag
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Inline rename on the sidebar entry, mirrored back to the column header.
function attachNavRename(labelEl, col) {
  labelEl.addEventListener('dblclick', (e) => {
    e.preventDefault(); e.stopPropagation();
    labelEl.contentEditable = 'true'; labelEl.spellcheck = false; labelEl.focus();
    const range = document.createRange(); range.selectNodeContents(labelEl);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    let cancelled = false;
    const onKey = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); labelEl.blur(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; labelEl.blur(); }
    };
    labelEl.addEventListener('keydown', onKey);
    labelEl.addEventListener('blur', () => {
      labelEl.removeEventListener('keydown', onKey);
      labelEl.contentEditable = 'false';
      window.getSelection().removeAllRanges();
      const v = labelEl.textContent.trim();
      if (!cancelled && v) { col.manualTitle = true; setColumnTitle(col, v); }
      else labelEl.textContent = col.title;
    }, { once: true });
  });
}

// ---- Help dialog (shortcuts & tips) ----
const helpDlg = document.getElementById('helpDialog');
function toggleHelp() {
  if (helpDlg.open) helpDlg.close();
  else helpDlg.showModal();
}
document.getElementById('helpClose').onclick = () => helpDlg.close();

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
  if (editIndex === null) { addColumn({ title, cwd, cmd, manualTitle: titleInput.value.trim() !== '' }); dlg.close(); return; }
  const col = columns[editIndex];
  const needsRespawn = (col.cwd || '') !== cwd || (col.cmd || '') !== cmd;
  if (title !== col.title) col.manualTitle = true; // typed a new name here = manual rename
  col.title = title;
  col.cwd = cwd;
  col.cmd = cmd;
  setColumnTitle(col, title); // title updates live in header + sidebar; shell untouched
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
// The search/broadcast bars use the app's SVG icon set (the raw Unicode glyphs
// in index.html render at inconsistent optical sizes).
document.getElementById('searchPrev').innerHTML = ICONS.up;
document.getElementById('searchNext').innerHTML = ICONS.down;
document.getElementById('searchClose').innerHTML = ICONS.close;
document.getElementById('bcastSend').innerHTML = ICONS.send;
document.getElementById('bcastClose').innerHTML = ICONS.close;
buildRail();
setNavCollapsed(config.navCollapsed); // sets class + width + collapse-button icon
attachNavResize(document.getElementById('navResizer'));
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
// Format elapsed ms compactly: 42s → 3m 12s → 1h 05m.
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}
const DONE_TIMER_LINGER = 5 * 60_000; // keep "✓ 2m 14s" visible this long after finishing

// A screen line that's just chrome (prompt, separators, spinner) isn't "activity".
const SUB_NOISE_RE = /^[❯>\s│⎿─╌═\-—·.]*$|^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s*$/;
function lastActivityLine(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t && !SUB_NOISE_RE.test(t)) return t.length > 60 ? t.slice(0, 59) + '…' : t;
  }
  return '';
}

// Popup notifications for NON-Claude agents (Antigravity/Grok/anything). The
// Claude popup hook only covers Claude Code — hooks are a Claude feature — so
// those columns are skipped here to avoid double popups. Everything else rides
// the same screen-based state machine as the dots: fire once per transition to
// green (done, after real work) or red (input), and only while the deck window
// is unfocused (if he's already looking at it, the dots are enough).
function maybeNotifyState(id, entry, st) {
  const prev = entry.lastNotifyState;
  entry.lastNotifyState = st;
  if (prev === undefined || prev === st) return; // boot tick / no transition
  if (st !== 'input' && st !== 'done') return;
  if (st === 'done' && !entry.hasWorked) return;
  if (document.hasFocus()) return;
  const col = columns.find((c) => c.id === id);
  if (!col || isClaudeCmd(col.cmd)) return;
  try { window.deck.notifyState({ id, title: col.title, state: st }); } catch (_) {}
}

let lastAttnCount = -1;
setInterval(() => {
  let attn = 0;
  terms.forEach((entry, id) => {
    let text = dumpScreen(entry.term);
    // A restored session replays the PREVIOUS run's output above a separator.
    // That old text can contain working/permission-prompt chrome; only what's
    // below the separator is live, so classification (and watch-ai) must not
    // see the replayed part. Once real output scrolls the separator out of the
    // 40-line window this is a no-op.
    const sep = text.lastIndexOf('以上为上次会话的输出');
    if (sep >= 0) {
      const nl = text.indexOf('\n', sep);
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    // Skip the full disk write when nothing changed on screen — with several
    // idle columns that was multiple synchronous writes/sec. But watch-ai
    // treats a spool file older than 8s as a dead column, so the mtime must
    // still be bumped: send a cheap "touch" instead of the text.
    if (text !== entry.lastDump) {
      entry.lastDump = text;
      try { window.deck.agentdeckDump(id, entry.titleEl ? entry.titleEl.textContent : '', text); } catch (_) {}
    } else {
      try { window.deck.agentdeckTouch(id); } catch (_) {}
    }

    if (entry.alive) {
      let st = classify(text, entry);
      if (st === 'working' || st === 'input') {
        entry.hasWorked = true;
        entry.idleTicks = 0;
        if (!entry.workStart) { entry.workStart = Date.now(); entry.workedMs = 0; }
      } else if (st === 'done') {
        // Debounce: hold yellow through the short gaps between tool calls so
        // the dot never flickers green mid-task (~3s ≈ watch-ai's stability window).
        entry.idleTicks++;
        if (entry.idleTicks < 2) {
          st = 'working';
        } else if (entry.workStart) {
          entry.workedMs = Date.now() - entry.workStart;
          entry.workStart = 0;
          entry.doneAt = Date.now();
        }
      } else {
        // 'plain' after working (e.g. a spinner in a bare shell finished, or an
        // agent whose idle footer we don't recognize): finalize the timer with
        // the same 2-tick debounce so it doesn't count up forever next to a
        // gray dot — and give hasWorked columns their green.
        entry.idleTicks++;
        if (entry.idleTicks >= 2) {
          if (entry.workStart) {
            entry.workedMs = Date.now() - entry.workStart;
            entry.workStart = 0;
            entry.doneAt = Date.now();
          }
          if (entry.hasWorked) st = 'done';
        } else if (entry.workStart) {
          st = 'working';
        }
      }
      entry.state = st;
      setDot(entry, st);
      maybeNotifyState(id, entry, st);
      if (st === 'input') attn++;

      // Header timer: live count-up while working / waiting, "✓ total" when done.
      if (entry.timerEl) {
        let label = '';
        if (entry.workStart) label = fmtElapsed(Date.now() - entry.workStart);
        else if (entry.workedMs && entry.doneAt && Date.now() - entry.doneAt < DONE_TIMER_LINGER) label = '✓ ' + fmtElapsed(entry.workedMs);
        if (entry.timerEl.textContent !== label) entry.timerEl.textContent = label;
        entry.timerEl.classList.toggle('done', !entry.workStart && !!label);
      }
    }

    // Sidebar live activity line (skipped while the sidebar is collapsed).
    const nav = navItems.get(id);
    if (nav && nav.sub && !config.navCollapsed) {
      const line = entry.alive ? lastActivityLine(text) : '已退出';
      if (nav.sub.textContent !== line) nav.sub.textContent = line;
    }
  });
  syncNav(); // mirror status dots + active highlight into the sidebar

  // Dock badge: how many agents are blocked waiting on the human.
  if (attn !== lastAttnCount) {
    lastAttnCount = attn;
    try { window.deck.setAttnCount(attn); } catch (_) {}
  }
}, 1500);

// ---- Keyboard shortcuts ----
// Focus the column at index, scrolling it into view. Captured before xterm.
function focusColumnByIndex(idx) {
  const col = columns[Math.max(0, Math.min(idx, columns.length - 1))];
  if (!col) return;
  const t = terms.get(col.id);
  if (!t) return;
  if (zoomedId && zoomedId !== col.id) { zoomedId = col.id; updateColumnStyles(); fitAll(); }
  t.term.focus(); focusedId = col.id; t.wrap.scrollIntoView({ inline: 'nearest', block: 'nearest' }); syncNav();
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
  } else if (k === '/') {
    toggleHelp();
  } else if (k === 'Enter') {
    toggleZoom(focusedId || (columns[0] && columns[0].id));
  } else if (k === 'j' || k === 'J') {
    // Jump to the (next) column waiting on the user; cycle on repeat presses.
    const waiting = columns.filter((c) => { const t = terms.get(c.id); return t && t.state === 'input'; });
    if (!waiting.length) { showToast('没有等待回复的列'); }
    else {
      const cur = waiting.findIndex((c) => c.id === focusedId);
      jumpToColumn(waiting[(cur + 1) % waiting.length]);
    }
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
// Font size works everywhere, including inside a terminal: capture phase runs
// before xterm's own handlers, so Ctrl+- never reaches the pty as ^_.
document.addEventListener('keydown', (e) => {
  const zd = fontSizeDelta(e);
  if (zd === null) return;
  setFontSize(zd === 0 ? FONT_DEFAULT : config.fontSize + zd);
  e.preventDefault();
  e.stopPropagation();
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
  // Send the text and the CR as separate writes: Ink-based TUIs (Claude Code)
  // treat text+\r arriving in one chunk as a paste and insert a newline into
  // the input box instead of submitting.
  terms.forEach((t, id) => { if (t.alive) window.deck.ptyInput(id, text); });
  setTimeout(() => { terms.forEach((t, id) => { if (t.alive) window.deck.ptyInput(id, '\r'); }); }, 60);
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

// Keep the floating bar glued to its column across deck scrolls and resizes.
function positionSearchBar() {
  const t = terms.get(searchColId);
  if (!t) return;
  const r = t.wrap.getBoundingClientRect();
  searchBar.style.top = Math.round(r.top + 8) + 'px';
  searchBar.style.left = Math.round(Math.max(8, r.right - 312)) + 'px';
}
deckEl.addEventListener('scroll', () => { if (!searchBar.hidden) positionSearchBar(); });
window.addEventListener('resize', () => { if (!searchBar.hidden) positionSearchBar(); });

function openSearch() {
  const col = columns.find((c) => c.id === focusedId) || columns[0];
  if (!col) return;
  const t = terms.get(col.id);
  if (!t || !t.search) return;
  searchColId = col.id;
  positionSearchBar();
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
