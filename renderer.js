const { Terminal } = window;            // from vendor/xterm.js (UMD global)
const FitAddonNS = window.FitAddon;      // from vendor/addon-fit.js
const SearchAddonNS = window.SearchAddon; // from vendor/addon-search.js
const CanvasAddonNS = window.CanvasAddon; // from vendor/addon-canvas.js
const BoardCore = window.BoardCore;

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
  board: S('<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="4" width="6" height="5" rx="1"/><rect x="9" y="15" width="6" height="5" rx="1"/><path d="M6 9v3h12V9M12 12v3"/>'),
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
function newTaskId() { return 't' + Date.now() + Math.floor(Math.random() * 100000); }
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
  return agents.map((a) => ({
    id: newId(), taskId: newTaskId(), title: a.title, cwd: '', cmd: a.cmd,
    width: DEFAULT_WIDTH, role: 'manual', relationship: 'Independent manual terminal',
  }));
}

// Titles the app itself assigned (auto numbers, preset agent names) are fair
// game for auto-naming; anything else counts as a manual rename.
const AUTO_TITLES = new Set(['Agent', 'Antigravity', 'Claude', 'Grok']);
function isManualTitle(t) { return !!t && !/^\d+$/.test(String(t).trim()) && !AUTO_TITLES.has(String(t).trim()); }

let config = {
  theme: 'dark', fitWindow: false, fitCols: DEFAULT_FIT_COLS, navWidth: 184,
  navCollapsed: false, fontSize: 13, activeView: 'terminals', columns: defaultColumns(), links: [],
  boardResponses: {}, boardPositions: {},
};
const saved = window.deck.loadConfig();
if (saved) {
  if (saved.theme) config.theme = saved.theme;
  if (saved.fitWindow !== undefined) config.fitWindow = saved.fitWindow;
  if (FIT_COLS_CHOICES.includes(saved.fitCols)) config.fitCols = saved.fitCols;
  if (saved.navWidth) config.navWidth = saved.navWidth;
  if (saved.navCollapsed !== undefined) config.navCollapsed = saved.navCollapsed;
  if (typeof saved.fontSize === 'number' && saved.fontSize >= 8 && saved.fontSize <= 32) config.fontSize = saved.fontSize;
  if (saved.activeView === 'board') config.activeView = 'board';
  config.boardPositions = BoardCore.normalizeBoardPositions(saved.boardPositions);
  if (saved.boardResponses && typeof saved.boardResponses === 'object' && !Array.isArray(saved.boardResponses)) {
    config.boardResponses = Object.fromEntries(Object.entries(saved.boardResponses).slice(-200));
  }
  if (Array.isArray(saved.links)) {
    config.links = saved.links.map(BoardCore.normalizeLink).filter((link) => link.id && link.fromTaskId && link.toTaskId);
  }
  if (Array.isArray(saved.columns) && saved.columns.length) {
    config.columns = saved.columns.map((c) => BoardCore.normalizeColumn({
      id: c.id || newId(), title: c.title || 'Agent', cwd: c.cwd || '', cmd: c.cmd || '', width: c.width || DEFAULT_WIDTH,
      // Pre-feature configs carry no manualTitle: infer it. Auto-ish titles
      // (pure numbers, preset agent names) stay auto-renamable; anything else
      // was typed by the user and must never be auto-renamed.
      manualTitle: c.manualTitle !== undefined ? !!c.manualTitle : isManualTitle(c.title),
      taskId: c.taskId || newTaskId(),
      role: c.role || 'manual',
      parentTaskId: c.parentTaskId,
      taskTitle: c.taskTitle,
      taskPrompt: c.taskPrompt,
      relationship: c.relationship,
      progress: c.progress,
      result: c.result,
      requestId: c.requestId,
      waitRequestIds: c.waitRequestIds,
      createdByRequestId: c.createdByRequestId,
      taskCompleted: c.taskCompleted,
      initialPromptSent: c.initialPromptSent,
      agentType: c.agentType,
      displayTitle: c.displayTitle || (c.manualTitle ? c.title : ''),
    }));
  }
}
let columns = config.columns;
let activeView = config.activeView;
function saveConfig() { config.columns = columns; window.deck.saveConfig(config); }
function columnLabel(col) { return (col && (col.displayTitle || col.title || col.taskTitle)) || 'Terminal'; }
function columnRelationshipLabel(col) {
  if (!col) return '';
  if (col.role === 'worker' && col.parentTaskId) {
    const parent = columns.find((candidate) => candidate.taskId === col.parentTaskId);
    if (parent) return `Delegated by ${columnLabel(parent)}`;
  }
  return col.relationship || (col.role === 'manual' ? 'Independent manual terminal' : 'Managed task');
}
function uniqueDisplayTitle(value, col) {
  return BoardCore.uniqueDisplayTitle(value || columnLabel(col), columns, col.taskId);
}
function setColumnDisplayTitle(col, value) {
  const requested = BoardCore.cleanText(value, 200);
  if (!requested) {
    showToast('A terminal title cannot be empty.');
    return false;
  }
  const label = uniqueDisplayTitle(requested, col);
  col.displayTitle = label;
  col.manualTitle = true;
  const t = terms.get(col.id);
  if (t && t.titleEl) t.titleEl.textContent = label;
  const nav = navItems.get(col.id);
  if (nav && nav.label) nav.label.textContent = label;
  if (label !== requested) showToast(`Title already used. Renamed to “${label}”.`);
  saveConfig();
  renderBoardGraph();
  return true;
}

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
    setDot(t, 'exited'); syncNav(); syncBoardState();
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

  // Top row = primary actions: collapse, add an independent terminal, board,
  // and broadcast. The plus button always creates a manual terminal; managed
  // terminals are created only through the conductor workflow.
  const collapseBtn = railBtn(ICONS.left, '折叠侧边栏', () => setNavCollapsed(!config.navCollapsed));
  collapseBtn.id = 'navCollapseBtn';
  top.appendChild(collapseBtn);
  top.appendChild(railBtn(ICONS.plus, '新建独立终端 (Cmd+N)', () => addAndFocusColumn(), true));
  const boardBtn = railBtn(ICONS.board, 'Conductor Board (Cmd+Shift+B)', () => showView(activeView === 'board' ? 'terminals' : 'board'));
  boardBtn.id = 'boardViewBtn';
  top.appendChild(boardBtn);
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
    columns.forEach((c) => {
      cancelManagedRequests(c, 'Layout reset by the user.');
      window.deck.ptyKill(c.id);
    });
    columns = defaultColumns();
    config.links = [];
    config.boardPositions = {};
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
const boardViewEl = document.getElementById('boardView');
const boardScrollerEl = document.getElementById('boardScroller');
const boardSurfaceEl = document.getElementById('boardSurface');
const boardEdgesEl = document.getElementById('boardEdges');
const boardNodesEl = document.getElementById('boardNodes');
const boardEmptyEl = document.getElementById('boardEmpty');
const boardInspectorEl = document.getElementById('boardInspector');
const boardTerminalHostEl = document.getElementById('boardTerminalHost');
const boardInspectorEmptyEl = document.getElementById('boardInspectorEmpty');
const boardInspectorTitleEl = document.getElementById('boardInspectorTitle');
const boardInspectorMetaEl = document.getElementById('boardInspectorMeta');
const boardInspectorStateEl = document.getElementById('boardInspectorState');
const boardInspectorSendTaskEl = document.getElementById('boardInspectorSendTask');
let selectedBoardId = null;
let connectSourceTaskId = null;
let boardLinkDrag = null;
const BOARD_NODE_WIDTH = 260;
const BOARD_NODE_HEIGHT = 156;
const BOARD_PADDING = 56;

function restoreBoardTerminal() {
  if (!selectedBoardId) return;
  const entry = terms.get(selectedBoardId);
  if (entry && entry.el && entry.wrap && entry.el.parentElement === boardTerminalHostEl) {
    const resizer = entry.wrap.querySelector('.resizer');
    entry.wrap.insertBefore(entry.el, resizer || null);
    entry.wrap.classList.remove('board-inspected');
  }
}

function selectBoardNode(columnId, focusTerminal) {
  const col = columns.find((candidate) => candidate.id === columnId);
  if (!col) return;
  if (selectedBoardId && selectedBoardId !== columnId) restoreBoardTerminal();
  selectedBoardId = columnId;
  boardNodesEl.querySelectorAll('.board-node').forEach((card) => {
    card.classList.toggle('selected', card.dataset.columnId === columnId);
  });
  const entry = terms.get(columnId);
  boardInspectorTitleEl.textContent = columnLabel(col);
  boardInspectorMetaEl.textContent = `${col.role === 'conductor' ? 'Conductor' : col.role === 'worker' ? 'Worker' : 'Manual'} · ${col.agentType || BoardCore.inferAgentType(col.cmd)} · ${columnRelationshipLabel(col)}`;
  boardInspectorEmptyEl.hidden = !!entry;
  boardTerminalHostEl.hidden = !entry;
  if (!entry) {
    setTimeout(() => {
      if (activeView === 'board' && selectedBoardId === columnId) selectBoardNode(columnId, focusTerminal);
    }, 100);
    return;
  }
  if (entry.el.parentElement !== boardTerminalHostEl) {
    boardTerminalHostEl.innerHTML = '';
    boardTerminalHostEl.appendChild(entry.el);
    entry.wrap.classList.add('board-inspected');
  }
  focusedId = columnId;
  requestAnimationFrame(() => {
    try { entry.fit.fit(); } catch (_) {}
    if (focusTerminal) entry.term.focus();
  });
  syncNav();
  syncBoardState();
}

function showView(view) {
  activeView = view === 'board' ? 'board' : 'terminals';
  config.activeView = activeView;
  deckEl.hidden = activeView === 'board';
  boardViewEl.hidden = activeView !== 'board';
  const button = document.getElementById('boardViewBtn');
  if (button) button.classList.toggle('accent', activeView === 'board');
  if (activeView === 'board') {
    closeSearch();
    closeBroadcast();
    renderBoardGraph();
  } else {
    restoreBoardTerminal();
    requestAnimationFrame(() => { updateColumnStyles(); fitAll(); });
  }
  saveConfig();
}

function inspectColumn(columnId) {
  const col = columns.find((c) => c.id === columnId);
  if (!col) return;
  showView('terminals');
  setTimeout(() => jumpToColumn(col), 40);
}

function boardStateFor(col) {
  const entry = terms.get(col.id);
  return entry ? entry.state : 'plain';
}

function boardStatusLabel(col, state) {
  const terminalLabel = BoardCore.stateLabel(state, false);
  return col.taskCompleted ? `Task completed · Terminal ${terminalLabel}` : terminalLabel;
}

function allBoardLinks() {
  const validTaskIds = new Set(columns.map((col) => col.taskId));
  const byTaskId = new Map(columns.map((col) => [col.taskId, col]));
  const links = (config.links || []).map(BoardCore.normalizeLink)
    .filter((link) => validTaskIds.has(link.fromTaskId) && validTaskIds.has(link.toTaskId))
    .map((link) => ({
      ...link,
      // The ownership tree is the ACL source of truth. Never claim that an
      // edge grants control unless the target actually belongs to that parent.
      grantedControl: link.type === 'delegation' &&
        byTaskId.get(link.toTaskId).parentTaskId === link.fromTaskId,
    }));
  columns.filter((col) => col.parentTaskId && validTaskIds.has(col.parentTaskId)).forEach((col) => {
    const exists = links.some((link) =>
      link.type === 'delegation' && link.fromTaskId === col.parentTaskId && link.toTaskId === col.taskId);
    if (!exists) {
      links.push({
        id: `managed:${col.parentTaskId}:${col.taskId}`,
        fromTaskId: col.parentTaskId,
        toTaskId: col.taskId,
        type: 'delegation',
        message: col.taskPrompt || '',
        grantedControl: true,
        synthetic: true,
      });
    }
  });
  return links;
}

function beginBoardRename(titleEl, col) {
  if (!titleEl || !col) return;
  titleEl.contentEditable = 'true';
  titleEl.spellcheck = false;
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  let cancelled = false;
  const onKey = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); titleEl.blur(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelled = true; titleEl.blur(); }
  };
  titleEl.addEventListener('keydown', onKey);
  titleEl.addEventListener('blur', () => {
    titleEl.removeEventListener('keydown', onKey);
    titleEl.contentEditable = 'false';
    selection.removeAllRanges();
    if (!cancelled) {
      if (!setColumnDisplayTitle(col, titleEl.textContent)) titleEl.textContent = columnLabel(col);
    } else titleEl.textContent = columnLabel(col);
  }, { once: true });
}

function baseBoardLayout() {
  return BoardCore.graphLayout(columns, {
    nodeWidth: BOARD_NODE_WIDTH,
    nodeHeight: BOARD_NODE_HEIGHT,
    gapX: 94,
    gapY: 44,
    padding: BOARD_PADDING,
  });
}

function autoArrangeBoard() {
  const layout = baseBoardLayout();
  config.boardPositions = Object.fromEntries(layout.nodes.map((node) => [
    node.taskId,
    { x: Math.round(node.x), y: Math.round(node.y) },
  ]));
  saveConfig();
  renderBoardGraph();
  showToast('Board arranged.');
}

function boardCanvasPoint(clientX, clientY) {
  const rect = boardScrollerEl.getBoundingClientRect();
  return {
    x: clientX - rect.left + boardScrollerEl.scrollLeft,
    y: clientY - rect.top + boardScrollerEl.scrollTop,
  };
}

function boardNodeGeometry(taskId) {
  const card = boardNodesEl.querySelector(`.board-node[data-task-id="${CSS.escape(taskId)}"]`);
  if (!card) return null;
  return {
    x: parseFloat(card.style.left) || 0,
    y: parseFloat(card.style.top) || 0,
    width: card.offsetWidth || BOARD_NODE_WIDTH,
    height: card.offsetHeight || BOARD_NODE_HEIGHT,
  };
}

function boardEdgeGeometry(from, to) {
  let x1, y1, x2, y2, path;
  if (Math.abs(from.x - to.x) < 40) {
    const forward = from.y <= to.y;
    x1 = from.x + from.width / 2;
    y1 = forward ? from.y + from.height : from.y;
    x2 = to.x + to.width / 2;
    y2 = forward ? to.y : to.y + to.height;
    const side = Math.max(from.x, to.x) + Math.max(from.width, to.width) + 36;
    path = `M ${x1} ${y1} C ${side} ${y1}, ${side} ${y2}, ${x2} ${y2}`;
  } else {
    const forward = from.x < to.x;
    x1 = forward ? from.x + from.width : from.x;
    y1 = from.y + from.height / 2;
    x2 = forward ? to.x : to.x + to.width;
    y2 = to.y + to.height / 2;
    const bend = Math.max(42, Math.abs(x2 - x1) / 2);
    path = `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 + (forward ? -bend : bend)} ${y2}, ${x2} ${y2}`;
  }
  return { x1, y1, x2, y2, path };
}

function updateBoardSurfaceSize() {
  const cards = Array.from(boardNodesEl.querySelectorAll('.board-node'));
  const maxRight = Math.max(0, ...cards.map((card) =>
    (parseFloat(card.style.left) || 0) + (card.offsetWidth || BOARD_NODE_WIDTH)));
  const maxBottom = Math.max(0, ...cards.map((card) =>
    (parseFloat(card.style.top) || 0) + (card.offsetHeight || BOARD_NODE_HEIGHT)));
  const width = Math.max(boardScrollerEl.clientWidth - 16, maxRight + 180, 720);
  const height = Math.max(boardScrollerEl.clientHeight - 16, maxBottom + 140, 520);
  boardSurfaceEl.style.width = `${width}px`;
  boardSurfaceEl.style.height = `${height}px`;
  boardEdgesEl.setAttribute('width', String(width));
  boardEdgesEl.setAttribute('height', String(height));
  boardEdgesEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function updateRenderedBoardLinks() {
  allBoardLinks().forEach((link) => {
    const from = boardNodeGeometry(link.fromTaskId);
    const to = boardNodeGeometry(link.toTaskId);
    if (!from || !to) return;
    const geometry = boardEdgeGeometry(from, to);
    const path = boardEdgesEl.querySelector(`.board-edge[data-link-id="${CSS.escape(link.id)}"]`);
    if (path) path.setAttribute('d', geometry.path);
    const chip = boardNodesEl.querySelector(`.board-link-chip[data-link-id="${CSS.escape(link.id)}"]`);
    if (chip) {
      chip.style.left = `${(geometry.x1 + geometry.x2) / 2}px`;
      chip.style.top = `${(geometry.y1 + geometry.y2) / 2}px`;
    }
  });
}

function maybeAutoScrollBoard(clientX, clientY) {
  const rect = boardScrollerEl.getBoundingClientRect();
  const edge = 42;
  let dx = 0, dy = 0;
  if (clientX < rect.left + edge) dx = -16;
  else if (clientX > rect.right - edge) dx = 16;
  if (clientY < rect.top + edge) dy = -16;
  else if (clientY > rect.bottom - edge) dy = 16;
  if (dx || dy) boardScrollerEl.scrollBy(dx, dy);
}

function attachBoardNodeDrag(card, col) {
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, h2, [contenteditable="true"]')) return;
    const startPoint = boardCanvasPoint(event.clientX, event.clientY);
    const startX = parseFloat(card.style.left) || 0;
    const startY = parseFloat(card.style.top) || 0;
    let dragging = false;
    card.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      const point = boardCanvasPoint(moveEvent.clientX, moveEvent.clientY);
      if (!dragging && Math.hypot(point.x - startPoint.x, point.y - startPoint.y) < 4) return;
      dragging = true;
      card.classList.add('dragging');
      maybeAutoScrollBoard(moveEvent.clientX, moveEvent.clientY);
      const current = boardCanvasPoint(moveEvent.clientX, moveEvent.clientY);
      card.style.left = `${Math.max(16, Math.round(startX + current.x - startPoint.x))}px`;
      card.style.top = `${Math.max(16, Math.round(startY + current.y - startPoint.y))}px`;
      updateBoardSurfaceSize();
      updateRenderedBoardLinks();
      moveEvent.preventDefault();
    };
    const onUp = () => {
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);
      card.classList.remove('dragging');
      if (!dragging) return;
      card.dataset.justDragged = 'true';
      setTimeout(() => { delete card.dataset.justDragged; }, 0);
      config.boardPositions[col.taskId] = {
        x: Math.round(parseFloat(card.style.left) || 16),
        y: Math.round(parseFloat(card.style.top) || 16),
      };
      saveConfig();
      updateBoardSurfaceSize();
      updateRenderedBoardLinks();
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  });
}

function clearBoardLinkDrag() {
  document.body.classList.remove('linking-board');
  boardNodesEl.querySelectorAll('.board-node.link-target').forEach((card) => card.classList.remove('link-target'));
  const preview = boardEdgesEl.querySelector('.board-edge-preview');
  if (preview) preview.remove();
  boardLinkDrag = null;
}

function boardLinkTargetAt(clientX, clientY, sourceTaskId) {
  const candidates = Array.from(boardNodesEl.querySelectorAll('.board-node'))
    .filter((card) => card.dataset.taskId !== sourceTaskId)
    .map((card) => {
      const rect = card.getBoundingClientRect();
      const inside = clientX >= rect.left - 10 && clientX <= rect.right + 10 &&
        clientY >= rect.top - 10 && clientY <= rect.bottom + 10;
      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      return { card, inside, distance: Math.hypot(dx, dy) };
    })
    .filter((candidate) => candidate.inside)
    .sort((a, b) => a.distance - b.distance);
  const card = candidates[0] && candidates[0].card;
  return card ? {
    card,
    column: columns.find((col) => col.taskId === card.dataset.taskId),
  } : null;
}

function attachBoardLinkDrag(port, source) {
  port.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    clearBoardLinkDrag();
    const sourceCard = port.closest('.board-node');
    const start = boardNodeGeometry(source.taskId);
    if (!sourceCard || !start) return;
    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    preview.setAttribute('class', 'board-edge-preview');
    preview.setAttribute('marker-end', 'url(#boardArrowPreview)');
    boardEdgesEl.appendChild(preview);
    boardLinkDrag = { source, target: null, moved: false, preview, startClientX: event.clientX, startClientY: event.clientY };
    document.body.classList.add('linking-board');
    port.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      if (!boardLinkDrag) return;
      maybeAutoScrollBoard(moveEvent.clientX, moveEvent.clientY);
      const point = boardCanvasPoint(moveEvent.clientX, moveEvent.clientY);
      if (Math.hypot(moveEvent.clientX - boardLinkDrag.startClientX, moveEvent.clientY - boardLinkDrag.startClientY) > 4) {
        boardLinkDrag.moved = true;
      }
      const hit = boardLinkTargetAt(moveEvent.clientX, moveEvent.clientY, source.taskId);
      const targetCard = hit && hit.card;
      const target = hit && hit.column;
      boardNodesEl.querySelectorAll('.board-node.link-target').forEach((card) =>
        card.classList.toggle('link-target', card === targetCard && !!target));
      boardLinkDrag.target = target;
      const from = boardNodeGeometry(source.taskId);
      const targetGeometry = target ? boardNodeGeometry(target.taskId) : null;
      if (from) {
        const x1 = from.x + from.width;
        const y1 = from.y + from.height / 2;
        const x2 = targetGeometry ? targetGeometry.x : point.x;
        const y2 = targetGeometry ? targetGeometry.y + targetGeometry.height / 2 : point.y;
        const direction = x2 >= x1 ? 1 : -1;
        const bend = Math.max(56, Math.abs(x2 - x1) / 2);
        preview.setAttribute('d', `M ${x1} ${y1} C ${x1 + direction * bend} ${y1}, ${x2 - direction * bend} ${y2}, ${x2} ${y2}`);
      }
    };
    const onUp = (upEvent) => {
      port.removeEventListener('pointermove', onMove);
      port.removeEventListener('pointerup', onUp);
      port.removeEventListener('pointercancel', onUp);
      const drag = boardLinkDrag;
      const finalHit = drag && boardLinkTargetAt(upEvent.clientX, upEvent.clientY, source.taskId);
      const target = (finalHit && finalHit.column) || (drag && drag.target);
      const moved = drag && drag.moved;
      clearBoardLinkDrag();
      if (moved && target) {
        port.dataset.suppressClick = 'true';
        setTimeout(() => { delete port.dataset.suppressClick; }, 0);
        openLinkDialog(null, source, target);
      }
    };
    port.addEventListener('pointermove', onMove);
    port.addEventListener('pointerup', onUp);
    port.addEventListener('pointercancel', onUp);
  });
  port.addEventListener('click', (event) => {
    event.stopPropagation();
    if (port.dataset.suppressClick === 'true') {
      delete port.dataset.suppressClick;
      return;
    }
    startBoardConnect(source);
  });
}

function renderBoardGraph() {
  if (!boardSurfaceEl) return;
  clearBoardLinkDrag();
  const layout = BoardCore.applyBoardPositions(baseBoardLayout(), config.boardPositions);
  const managedCount = columns.filter((c) => c.role !== 'manual').length;
  const surfaceW = Math.max(layout.width, boardScrollerEl.clientWidth - 16, 720);
  const surfaceH = Math.max(layout.height, boardViewEl.clientHeight - 132, 520);
  boardSurfaceEl.style.width = surfaceW + 'px';
  boardSurfaceEl.style.height = surfaceH + 'px';
  boardEdgesEl.setAttribute('width', String(surfaceW));
  boardEdgesEl.setAttribute('height', String(surfaceH));
  boardEdgesEl.setAttribute('viewBox', `0 0 ${surfaceW} ${surfaceH}`);
  boardEdgesEl.innerHTML = '<defs>' +
    '<marker id="boardArrowDelegation" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>' +
    '<marker id="boardArrowDependency" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>' +
    '<marker id="boardArrowHandoff" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>' +
    '<marker id="boardArrowPreview" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path></marker>' +
    '</defs>';
  boardNodesEl.innerHTML = '';
  boardEmptyEl.hidden = managedCount > 0;

  const nodeByTaskId = new Map(layout.nodes.map((node) => [node.taskId, node]));
  const stateByTaskId = Object.fromEntries(columns.map((col) => [col.taskId, boardStateFor(col)]));
  allBoardLinks().forEach((link) => {
    const from = nodeByTaskId.get(link.fromTaskId);
    const to = nodeByTaskId.get(link.toTaskId);
    if (!from || !to) return;
    const geometry = boardEdgeGeometry(from, to);
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('class', `board-edge ${link.type}`);
    pathEl.dataset.linkId = link.id;
    pathEl.setAttribute('d', geometry.path);
    const marker = link.type === 'delegation' ? 'Delegation' : link.type === 'handoff' ? 'Handoff' : 'Dependency';
    pathEl.setAttribute('marker-end', `url(#boardArrow${marker})`);
    boardEdgesEl.appendChild(pathEl);
    const chip = document.createElement('button');
    const linkState = BoardCore.linkState(link, columns, stateByTaskId);
    chip.className = `board-link-chip ${link.type}${linkState === 'Blocked' ? ' blocked' : ''}`;
    chip.dataset.linkId = link.id;
    chip.dataset.linkState = linkState;
    chip.style.left = `${(geometry.x1 + geometry.x2) / 2}px`;
    chip.style.top = `${(geometry.y1 + geometry.y2) / 2}px`;
    chip.textContent = `${BoardCore.linkLabel(link.type)} · ${linkState}`;
    chip.title = 'Edit or remove this relationship';
    chip.onclick = (event) => { event.stopPropagation(); openLinkDialog(link); };
    boardNodesEl.appendChild(chip);
  });

  layout.nodes.forEach((node) => {
    const col = columns.find((candidate) => candidate.id === node.id);
    if (!col) return;
    const card = document.createElement('article');
    card.className = `board-node ${col.role || 'manual'}${selectedBoardId === col.id ? ' selected' : ''}`;
    card.dataset.columnId = col.id;
    card.dataset.taskId = col.taskId;
    card.dataset.state = boardStateFor(col);
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
    card.style.width = node.width + 'px';
    card.style.height = node.height + 'px';

    const top = document.createElement('div');
    top.className = 'board-node-top';
    const role = document.createElement('span');
    role.className = 'board-role';
    role.textContent = col.role === 'conductor' ? 'Conductor' : col.role === 'worker' ? 'Worker' : 'Manual';
    const agent = document.createElement('span');
    agent.className = 'board-agent';
    agent.textContent = col.agentType || BoardCore.inferAgentType(col.cmd);
    top.append(role, agent);

    const title = document.createElement('h2');
    title.className = 'board-title-bar';
    title.textContent = columnLabel(col);
    title.tabIndex = 0;
    title.title = 'Double-click, press Enter, or press F2 to rename';
    title.addEventListener('dblclick', (event) => { event.stopPropagation(); beginBoardRename(title, col); });
    title.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === 'F2') && title.contentEditable !== 'true') {
        event.preventDefault();
        event.stopPropagation();
        beginBoardRename(title, col);
      }
    });
    const status = document.createElement('div');
    status.className = 'board-node-status';
    const statusDot = document.createElement('i');
    statusDot.className = 'legend-dot';
    const statusText = document.createElement('span');
    statusText.className = 'board-status-text';
    status.append(statusDot, statusText);
    const relation = document.createElement('p');
    relation.className = 'board-relation';
    relation.textContent = columnRelationshipLabel(col);
    const progress = document.createElement('p');
    progress.className = 'board-progress';
    progress.textContent = col.result || col.progress || '';
    progress.title = progress.textContent;
    const actions = document.createElement('div');
    actions.className = 'board-node-actions';
    const inspect = document.createElement('button');
    inspect.className = 'board-inspect';
    inspect.textContent = 'Inspect here';
    inspect.onclick = (event) => { event.stopPropagation(); selectBoardNode(col.id, true); };
    actions.append(inspect);
    const inPort = document.createElement('span');
    inPort.className = 'board-port in';
    inPort.setAttribute('aria-hidden', 'true');
    const outPort = document.createElement('button');
    outPort.className = 'board-port out';
    outPort.type = 'button';
    outPort.title = `Drag to link from ${columnLabel(col)}; click for keyboard connect mode`;
    outPort.setAttribute('aria-label', `Connect from ${columnLabel(col)}`);
    card.append(inPort, outPort, top, title, status, relation, progress, actions);
    attachBoardNodeDrag(card, col);
    attachBoardLinkDrag(outPort, col);
    card.addEventListener('click', (event) => {
      if (card.dataset.justDragged === 'true') {
        delete card.dataset.justDragged;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.target.closest('button') || event.target.closest('[contenteditable="true"]')) return;
      if (connectSourceTaskId && connectSourceTaskId !== col.taskId) {
        const source = columns.find((candidate) => candidate.taskId === connectSourceTaskId);
        if (source) openLinkDialog(null, source, col);
      } else {
        selectBoardNode(col.id, true);
      }
    });
    boardNodesEl.appendChild(card);
  });
  updateBoardSurfaceSize();
  updateRenderedBoardLinks();
  syncBoardState();
  if (activeView === 'board' && columns.length) {
    const selected = columns.find((col) => col.id === selectedBoardId) ||
      columns.find((col) => col.role === 'conductor') || columns[0];
    setTimeout(() => selectBoardNode(selected.id, false), 0);
  }
}

function syncBoardState() {
  if (!boardNodesEl) return;
  boardNodesEl.querySelectorAll('.board-node').forEach((card) => {
    const col = columns.find((candidate) => candidate.id === card.dataset.columnId);
    if (!col) return;
    const state = boardStateFor(col);
    card.dataset.state = state;
    const statusText = card.querySelector('.board-status-text');
    if (statusText) statusText.textContent = boardStatusLabel(col, state);
    const progress = card.querySelector('.board-progress');
    const entry = terms.get(col.id);
    const live = entry && entry.lastDump ? lastActivityLine(entry.lastDump) : '';
    const text = col.result || col.progress || live;
    if (progress && progress.textContent !== text) {
      progress.textContent = text;
      progress.title = text;
    }
  });
  const selected = columns.find((col) => col.id === selectedBoardId);
  if (selected) {
    const state = boardStateFor(selected);
    boardInspectorTitleEl.textContent = columnLabel(selected);
    boardInspectorStateEl.textContent = `${boardStatusLabel(selected, state)}${selected.progress ? ` · ${selected.progress}` : ''}`;
    boardInspectorStateEl.dataset.state = state;
    boardInspectorSendTaskEl.hidden = selected.role === 'manual' || selected.taskCompleted || !selected.taskPrompt;
    boardInspectorSendTaskEl.textContent = selected.initialPromptSent ? 'Resend task' : 'Send task';
  }
  const stateByTaskId = Object.fromEntries(columns.map((col) => [col.taskId, boardStateFor(col)]));
  allBoardLinks().forEach((link) => {
    const chip = boardNodesEl.querySelector(`.board-link-chip[data-link-id="${CSS.escape(link.id)}"]`);
    if (!chip) return;
    const state = BoardCore.linkState(link, columns, stateByTaskId);
    chip.dataset.linkState = state;
    chip.classList.toggle('blocked', state === 'Blocked');
    chip.textContent = `${BoardCore.linkLabel(link.type)} · ${state}`;
  });
}

function boardCliCommand() {
  return env.platform === 'win32'
    ? 'node "$env:AGENTDECK_BOARD_CLI"'
    : 'node "$AGENTDECK_BOARD_CLI"';
}

function managedTaskPrompt(col) {
  const cli = boardCliCommand();
  const common =
    `\n\nAgentDeck managed-terminal protocol:\n` +
    `- Report useful progress with: ${cli} progress --message "what changed"\n` +
    `- Delegate a real child terminal with: ${cli} create-child --title "subtask" --task "full instructions" --agent claude\n` +
    `- For parallel work, use spawn-child with the same arguments, record the returned task id, then run: ${cli} wait --task "task-id"\n` +
    `- Send a follow-up or answer with: ${cli} send --task "task-id" --message "message"\n` +
    `- Managed workers may delegate downstream workers the same way. create-child waits and prints the worker's result.\n` +
    `- Finish by running: ${cli} complete --result "concise result, files changed, and validation"\n` +
    `- Never control or send input to manual terminals. They are intentionally isolated.\n`;
  if (col.role === 'conductor') {
    return `You are the conductor for this AgentDeck task.\n\nTask: ${col.taskTitle}\n\n${col.taskPrompt}` +
      `\n\nPlan and execute the parent task. Delegate bounded subtasks when useful, collect their returned results, integrate them, validate the whole outcome, and then complete the parent task.` + common;
  }
  return `You are a managed AgentDeck worker.\n\nDelegated task: ${col.taskTitle}\n\n${col.taskPrompt}` +
    `\n\nDo the work in this terminal. You may create downstream workers when useful. Return a concrete result to your parent.` + common;
}

function queueInitialPrompt(col, delay) {
  if (!col || col.role === 'manual' || col.initialPromptSent || !col.taskPrompt) return;
  if (!col.cmd) {
    // A raw shell has no conversational prompt. Keep the task visible on the
    // Board and the managed CLI available, but never execute prose as shell code.
    col.initialPromptSent = true;
    col.progress = 'Task ready in managed shell';
    saveConfig();
    syncBoardState();
    return;
  }
  const id = col.id;
  whenTerminalReady(col, () => {
    if (!columns.includes(col) || col.id !== id || col.role === 'manual' ||
        col.taskCompleted || col.initialPromptSent) return;
    const entry = terms.get(id);
    if (!entry) return;
    // xterm paste uses bracketed-paste mode when the agent supports it, so the
    // multi-line instructions arrive as one prompt instead of separate shell commands.
    entry.term.paste(managedTaskPrompt(col));
    setTimeout(() => window.deck.ptyInput(id, '\r'), 40);
    col.initialPromptSent = true;
    col.progress = 'Task assigned';
    saveConfig();
    syncBoardState();
  }, 'Waiting for agent prompt', delay || 0);
}

const promptQueueIds = new Set();
function whenTerminalReady(col, callback, waitingLabel, initialDelay) {
  if (!col) return;
  const originalId = col.id;
  const queueId = `${originalId}:${waitingLabel || 'terminal'}`;
  if (promptQueueIds.has(queueId)) return;
  const startedAt = Date.now();
  promptQueueIds.add(queueId);
  const check = () => {
    if (!columns.includes(col) || col.id !== originalId) {
      promptQueueIds.delete(queueId);
      return;
    }
    const entry = terms.get(originalId);
    // A raw shell is ready as soon as its PTY exists. Agent TUIs must expose a
    // recognizable idle prompt; permission/trust input never receives a task.
    const ready = entry && entry.alive && (!col.cmd ||
      (entry.state !== 'input' && AGENT_IDLE_RE.test(entry.lastDump || '')));
    if (ready) {
      promptQueueIds.delete(queueId);
      callback();
      return;
    }
    const nextProgress = entry && entry.state === 'input'
      ? 'Agent needs startup input before task delivery'
      : (waitingLabel || 'Waiting for terminal prompt');
    if (col.progress !== nextProgress) {
      col.progress = nextProgress;
      saveConfig();
      syncBoardState();
    }
    if (Date.now() - startedAt >= 120_000) {
      promptQueueIds.delete(queueId);
      col.progress = 'Task delivery paused: use Send task after the agent is ready';
      saveConfig();
      syncBoardState();
      return;
    }
    setTimeout(check, 500);
  };
  setTimeout(check, Math.max(0, Number(initialDelay) || 0));
}

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
  restoreBoardTerminal();
  boardTerminalHostEl.innerHTML = '';
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
  renderBoardGraph();
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
  const title = document.createElement('span'); title.className = 'title'; title.textContent = columnLabel(col);
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
        window.deck.ptySpawn(col.id, col.cwd || env.home, term.cols, term.rows, col.role !== 'manual');
        let resumedAgent = false;
        if (col.cmd) {
          let launch = col.cmd;
          // Restoring a Claude column → continue its previous conversation.
          if (!isFresh && isClaudeCmd(col.cmd) && await window.deck.claudeHasSession(col.cwd || env.home)) {
            launch = withClaudeResume(col.cmd);
            resumedAgent = true;
          }
          // Capture the id: if the user edits the column within 700ms,
          // respawnColumn assigns a NEW id and this stale timer must not fire
          // into the fresh pty (whose own timer will run the command).
          const spawnId = col.id;
          setTimeout(() => { if (terms.has(spawnId)) window.deck.ptyInput(spawnId, launch + '\r'); }, 700);
        }
        if (!isFresh && col.role !== 'manual' && !col.taskCompleted) {
          // A cold restart killed the old CLI caller. Re-deliver managed
          // instructions unless this exact Claude conversation can resume.
          col.requestId = null;
          col.waitRequestIds = [];
          if (!resumedAgent) {
            col.initialPromptSent = false;
            col.progress = 'Restoring managed task';
          }
          saveConfig();
        }
        queueInitialPrompt(col, col.cmd ? 700 : 0);
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
      if (activeView === 'board' && termEl.parentElement !== boardTerminalHostEl) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fit.fit();
          if (activeView === 'board' && term.rows > 0) term.refresh(0, term.rows - 1);
        } catch (_) {}
      });
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
function managedSubtree(root, includeRoot) {
  if (!root || root.role === 'manual') return [];
  return columns.filter((candidate) =>
    (includeRoot && candidate.taskId === root.taskId) || isManagedDescendant(root, candidate));
}

function releaseManagedSubtree(root, includeRoot, reason) {
  const targets = managedSubtree(root, includeRoot);
  const targetTaskIds = new Set(targets.map((target) => target.taskId));
  config.links = (config.links || []).map((link) =>
    targetTaskIds.has(link.toTaskId) && link.grantedControl ? { ...link, grantedControl: false } : link);
  targets.sort((a, b) => taskDepth(b) - taskDepth(a)).forEach((target) => {
    cancelManagedRequests(target, reason);
    target.role = 'manual';
    target.parentTaskId = null;
    target.relationship = 'Independent manual terminal';
    target.taskPrompt = '';
    target.progress = 'Independent terminal';
    target.taskCompleted = false;
    target.initialPromptSent = false;
    target.createdByRequestId = null;
    respawnColumn(target);
  });
  return targets;
}

// Surgical add/remove so touching one column never blanks the others' live output.
function removeCol(col) {
  const t = terms.get(col.id);
  const descendants = managedSubtree(col, false);
  const active = [col, ...descendants].some((candidate) => {
    const entry = terms.get(candidate.id);
    return entry && entry.alive && (entry.state === 'working' || entry.state === 'input');
  });
  if (active && !confirm('This terminal or one of its managed descendants is active. Close it and release descendants as independent terminals?')) return;
  const idx = columns.indexOf(col);
  if (descendants.length) {
    releaseManagedSubtree(col, false, `Parent task "${columnLabel(col)}" was removed.`);
  }
  cancelManagedRequests(col, `Task "${columnLabel(col)}" was removed.`);
  if (selectedBoardId === col.id) {
    restoreBoardTerminal();
    selectedBoardId = null;
  }
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); t.wrap.remove(); terms.delete(col.id);
  }
  window.deck.ptyKill(col.id);
  columns.splice(idx, 1);
  config.links = (config.links || []).filter((link) => link.fromTaskId !== col.taskId && link.toTaskId !== col.taskId);
  delete config.boardPositions[col.taskId];
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
  renderBoardGraph();
}
function addColumn(c) {
  const col = BoardCore.normalizeColumn({
    id: newId(), taskId: newTaskId(), width: defaultColWidth(), cwd: '',
    role: 'manual', relationship: 'Independent manual terminal', ...c,
  });
  columns.push(col);
  saveConfig();
  deckEl.appendChild(buildColumn(col, true)); // brand-new column: never auto-resume
  updateColumnStyles();
  renderColNav();
  renderBoardGraph();
  return col;
}
// Smallest unused positive integer, so new columns read 1,2,3… and fill gaps.
function nextTitle() {
  const used = new Set(columns.map((c) => parseInt(c.title, 10)).filter((n) => !isNaN(n)));
  let n = 1; while (used.has(n)) n++;
  return String(n);
}
// New column with no dialog: auto-numbered title, default (global) cwd, focused.
function addAndFocusColumn() {
  const stayOnBoard = activeView === 'board';
  if (zoomedId) { zoomedId = null; updateColumnStyles(); } // new column must be visible
  const col = addColumn({ title: nextTitle(), role: 'manual' });
  if (stayOnBoard) setTimeout(() => selectBoardNode(col.id, true), 100);
  else setTimeout(() => focusColumnByIndex(columns.length - 1), 80); // wait for its terminal
  return col;
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
      if (!cancelled && v) setColumnDisplayTitle(col, v);
      else titleEl.textContent = columnLabel(col); // normalize (drop stray newlines / restore on cancel)
    }, { once: true });
  });
}
// cwd change needs a fresh shell; rebuild just this column (new id so the old
// pty's exit event can't bleed into the new terminal).
function respawnColumn(col) {
  const t = terms.get(col.id);
  const wasBoardSelected = selectedBoardId === col.id;
  if (wasBoardSelected) restoreBoardTerminal();
  window.deck.ptyKill(col.id);
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); terms.delete(col.id);
  }
  const oldId = col.id;
  col.id = newId();
  if (focusedId === oldId) focusedId = col.id;
  if (zoomedId === oldId) zoomedId = col.id; // stay zoomed across a respawn
  if (wasBoardSelected) selectedBoardId = col.id;
  const fresh = buildColumn(col, true); // cwd/cmd just changed: start fresh, no auto-resume
  if (t) t.wrap.replaceWith(fresh); else render();
  saveConfig();
  updateColumnStyles();
  renderColNav();
  renderBoardGraph();
}

// ---- Column sidebar (list of columns: click to jump, double-click to rename) ----
// One source of truth for a column's name so the header title and the sidebar
// entry never drift: rename in either place flows through here.
function setColumnTitle(col, title) {
  col.title = title;
  const t = terms.get(col.id);
  const label = columnLabel(col);
  if (t && t.titleEl && t.titleEl.textContent !== label) t.titleEl.textContent = label;
  const nav = navItems.get(col.id);
  if (nav && nav.label.textContent !== label) nav.label.textContent = label;
  saveConfig();
  renderBoardGraph();
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
    label.textContent = columnLabel(col); label.title = '双击重命名';
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
  if (activeView === 'board') {
    selectBoardNode(col.id, true);
    return;
  }
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
      if (!cancelled && v) setColumnDisplayTitle(col, v);
      else labelEl.textContent = columnLabel(col);
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
  titleInput.value = editIndex === null ? '' : columnLabel(columns[editIndex]);
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
  if (editIndex === null) {
    addColumn({ title, displayTitle: titleInput.value.trim() ? title : '', cwd, cmd, manualTitle: titleInput.value.trim() !== '' });
    dlg.close();
    return;
  }
  const col = columns[editIndex];
  const needsRespawn = (col.cwd || '') !== cwd || (col.cmd || '') !== cmd;
  const titleChanged = title !== columnLabel(col);
  col.cwd = cwd;
  col.cmd = cmd;
  if (titleChanged) setColumnDisplayTitle(col, title); // keep auto-title behavior when only cwd/cmd changed
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

// ---- User-created board relationships ----
const connectNoticeEl = document.getElementById('boardConnectNotice');
const connectNoticeTextEl = document.getElementById('boardConnectNoticeText');
const linkDlg = document.getElementById('boardLinkDialog');
const linkDlgTitle = document.getElementById('boardLinkDialogTitle');
const linkSourceLabel = document.getElementById('linkSourceLabel');
const linkTargetLabel = document.getElementById('linkTargetLabel');
const linkTypeInput = document.getElementById('linkTypeInput');
const linkMessageInput = document.getElementById('linkMessageInput');
const linkGrantControl = document.getElementById('linkGrantControl');
const linkControlOption = document.getElementById('linkControlOption');
const linkRemoveBtn = document.getElementById('linkRemove');
let editingBoardLink = null;
let linkDialogSource = null;
let linkDialogTarget = null;

function cancelBoardConnect() {
  connectSourceTaskId = null;
  connectNoticeEl.hidden = true;
  boardNodesEl.querySelectorAll('.board-node').forEach((card) => card.classList.remove('connect-source'));
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (boardLinkDrag) clearBoardLinkDrag();
  if (connectSourceTaskId) cancelBoardConnect();
});

function startBoardConnect(col) {
  connectSourceTaskId = col.taskId;
  connectNoticeTextEl.textContent = `Linking from “${columnLabel(col)}”. Click a target card, or cancel.`;
  connectNoticeEl.hidden = false;
  boardNodesEl.querySelectorAll('.board-node').forEach((card) => {
    const candidate = columns.find((item) => item.id === card.dataset.columnId);
    card.classList.toggle('connect-source', candidate && candidate.taskId === col.taskId);
  });
}

function updateLinkControlOption() {
  const delegation = linkTypeInput.value === 'delegation';
  linkControlOption.hidden = !delegation;
  if (!delegation) linkGrantControl.checked = false;
  const canGrant = linkDialogSource && linkDialogSource.role !== 'manual';
  linkGrantControl.disabled = !canGrant;
  if (delegation && !canGrant) {
    linkControlOption.title = 'Only an existing managed conductor/worker can receive control capability.';
  } else {
    linkControlOption.title = '';
  }
}

function openLinkDialog(link, source, target) {
  editingBoardLink = link ? { ...link } : null;
  linkDialogSource = source || columns.find((col) => col.taskId === link.fromTaskId);
  linkDialogTarget = target || columns.find((col) => col.taskId === link.toTaskId);
  if (!linkDialogSource || !linkDialogTarget || linkDialogSource === linkDialogTarget) {
    showToast('Choose two different terminals to connect.');
    return;
  }
  linkDlgTitle.textContent = link ? 'Edit relationship' : 'Connect terminals';
  linkSourceLabel.textContent = columnLabel(linkDialogSource);
  linkTargetLabel.textContent = columnLabel(linkDialogTarget);
  linkTypeInput.value = (link && link.type) || (linkDialogSource.role === 'manual' ? 'handoff' : 'delegation');
  linkMessageInput.value = (link && link.message) || '';
  linkGrantControl.checked = !!(link && link.grantedControl);
  linkRemoveBtn.hidden = !link;
  updateLinkControlOption();
  cancelBoardConnect();
  linkDlg.showModal();
  setTimeout(() => linkTypeInput.focus(), 30);
}

function sendExplicitBoardMessage(target, message, delay) {
  const text = BoardCore.cleanText(message, 12000);
  if (!text) return;
  whenTerminalReady(target, () => {
    const entry = terms.get(target.id);
    if (!entry || !entry.alive) {
      showToast(`Relationship saved, but “${columnLabel(target)}” is not available for input.`);
      return;
    }
    entry.term.paste(text);
    setTimeout(() => window.deck.ptyInput(target.id, '\r'), 40);
  }, 'Waiting to deliver relationship message', delay || 0);
}

function hasActiveTerminal(targets) {
  return targets.some((target) => {
    const entry = terms.get(target.id);
    return entry && entry.alive && (entry.state === 'working' || entry.state === 'input');
  });
}

function revokeRelationshipControl(source, target) {
  if (!source || !target) return false;
  if (target.role === 'worker' && target.parentTaskId === source.taskId) {
    const subtree = managedSubtree(target, true);
    if (hasActiveTerminal(subtree) &&
        !confirm('Revoking control restarts this managed terminal and releases its descendants as independent terminals. Continue?')) {
      return false;
    }
    releaseManagedSubtree(target, true, `Control from "${columnLabel(source)}" was revoked.`);
    return true;
  }
  return false;
}

function grantRelationshipControl(source, target, message) {
  const grantError = BoardCore.controlGrantError(columns, source, target, MAX_TASK_DEPTH);
  if (grantError) throw new Error(grantError);
  const alreadyGranted = target.role === 'worker' && target.parentTaskId === source.taskId;
  if (!alreadyGranted && hasActiveTerminal([target]) &&
      !confirm('Granting control restarts this terminal with a managed capability. Continue?')) {
    return false;
  }
  if (!alreadyGranted) {
    cancelManagedRequests(target, `Terminal was reassigned to "${columnLabel(source)}".`);
    config.links = (config.links || []).map((link) =>
      link.toTaskId === target.taskId && link.grantedControl ? { ...link, grantedControl: false } : link);
  }
  target.role = 'worker';
  target.parentTaskId = source.taskId;
  target.relationship = `Explicitly delegated by ${columnLabel(source)}`;
  target.taskTitle = target.taskTitle || target.title;
  target.taskPrompt = BoardCore.cleanText(message, 20000) ||
    `Continue the work in this terminal under conductor "${columnLabel(source)}".`;
  target.requestId = null;
  target.waitRequestIds = [];
  target.createdByRequestId = null;
  target.taskCompleted = false;
  // First grant always delivers the complete managed protocol after the real
  // agent prompt is ready. No terminal history or hidden context is copied.
  if (!alreadyGranted) target.initialPromptSent = false;
  if (!alreadyGranted) respawnColumn(target);
  return !alreadyGranted;
}

document.getElementById('boardConnectCancel').onclick = cancelBoardConnect;
linkTypeInput.onchange = updateLinkControlOption;
document.getElementById('linkCancel').onclick = () => { linkDlg.close(); editingBoardLink = null; };
document.getElementById('linkUseSourceResult').onclick = () => {
  if (!linkDialogSource) return;
  linkMessageInput.value = linkDialogSource.result || linkDialogSource.progress || '';
  linkMessageInput.focus();
};
document.getElementById('linkSave').onclick = () => {
  if (!linkDialogSource || !linkDialogTarget) return;
  try {
    const type = linkTypeInput.value;
    const message = BoardCore.cleanText(linkMessageInput.value, 12000);
    const grant = type === 'delegation' && linkGrantControl.checked;
    const old = editingBoardLink;
    const existing = (config.links || []).find((candidate) =>
      candidate.fromTaskId === linkDialogSource.taskId &&
      candidate.toTaskId === linkDialogTarget.taskId &&
      candidate.type === (old ? old.type : type));
    let restarted = false;
    if (!grant && (type === 'delegation' || (old && old.grantedControl)) &&
        linkDialogTarget.parentTaskId === linkDialogSource.taskId) {
      const revoked = revokeRelationshipControl(linkDialogSource, linkDialogTarget);
      if (!revoked && linkDialogTarget.parentTaskId === linkDialogSource.taskId) return;
      restarted = revoked;
    } else if (grant) {
      restarted = grantRelationshipControl(linkDialogSource, linkDialogTarget, message);
      if (!restarted && !(linkDialogTarget.role === 'worker' &&
          linkDialogTarget.parentTaskId === linkDialogSource.taskId)) return;
    }
    const normalized = BoardCore.normalizeLink({
      id: old && !old.synthetic ? old.id : `link-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      fromTaskId: linkDialogSource.taskId,
      toTaskId: linkDialogTarget.taskId,
      type,
      message,
      grantedControl: grant,
      createdAt: old && old.createdAt,
    });
    const duplicateIndex = (config.links || []).findIndex((candidate) =>
      candidate.id === normalized.id ||
      (!old && candidate.fromTaskId === normalized.fromTaskId &&
       candidate.toTaskId === normalized.toTaskId && candidate.type === normalized.type));
    if (duplicateIndex >= 0) config.links[duplicateIndex] = normalized;
    else config.links.push(normalized);
    saveConfig();
    renderBoardGraph();
    linkDlg.close();
    // A first-time grant includes the exact message inside the managed task
    // prompt. Existing grants and non-control relationships send only the
    // user-selected message, never arbitrary terminal history.
    if (message && !(grant && restarted) && (!old || old.message !== message || !existing)) {
      sendExplicitBoardMessage(linkDialogTarget, message, 0);
    }
    showToast(`${BoardCore.linkLabel(type)} saved.`);
  } catch (err) {
    showToast(err && err.message ? err.message : String(err));
  }
};
linkRemoveBtn.onclick = () => {
  if (!editingBoardLink || !linkDialogSource || !linkDialogTarget) return;
  if (editingBoardLink.grantedControl &&
      linkDialogTarget.parentTaskId === linkDialogSource.taskId &&
      !revokeRelationshipControl(linkDialogSource, linkDialogTarget)) return;
  config.links = (config.links || []).filter((link) => link.id !== editingBoardLink.id);
  if (editingBoardLink.synthetic && linkDialogTarget.parentTaskId === linkDialogSource.taskId) {
    linkDialogTarget.parentTaskId = null;
    linkDialogTarget.relationship = linkDialogTarget.role === 'manual' ? 'Independent manual terminal' : 'Unlinked managed task';
  }
  saveConfig();
  renderBoardGraph();
  linkDlg.close();
  showToast('Relationship removed.');
};

document.getElementById('boardInspectorOpenPage').onclick = () => {
  if (selectedBoardId) inspectColumn(selectedBoardId);
};
document.getElementById('boardInspectorRename').onclick = () => {
  const col = columns.find((candidate) => candidate.id === selectedBoardId);
  if (!col) return;
  const value = prompt('Terminal display title', columnLabel(col));
  if (value !== null) setColumnDisplayTitle(col, value);
};
boardInspectorSendTaskEl.onclick = () => {
  const col = columns.find((candidate) => candidate.id === selectedBoardId);
  if (!col || col.role === 'manual' || col.taskCompleted || !col.taskPrompt) return;
  col.initialPromptSent = false;
  col.progress = 'Task delivery requested';
  saveConfig();
  syncBoardState();
  queueInitialPrompt(col, 0);
};

// ---- Conductor Board control plane ----
// The main process authenticates each command with a per-PTY capability token.
// Renderer ownership checks are the second boundary: a managed terminal can
// create descendants and message only its own descendant tasks. Manual
// terminals have neither a token nor a place in this ownership tree.
const MAX_MANAGED_TASKS = 48;
const MAX_TASK_DEPTH = 8;

function respondBoard(requestId, payload) {
  const id = BoardCore.cleanText(requestId, 200);
  if (!id) return;
  const response = {
    done: !!payload.done,
    result: BoardCore.cleanText(payload.result, 12000),
    error: BoardCore.cleanText(payload.error, 2000),
    childId: BoardCore.cleanText(payload.childId, 160),
    snapshot: payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : undefined,
    updatedAt: Date.now(),
  };
  config.boardResponses[id] = response;
  const ids = Object.keys(config.boardResponses);
  if (ids.length > 200) {
    ids.sort((a, b) => (config.boardResponses[a].updatedAt || 0) - (config.boardResponses[b].updatedAt || 0))
      .slice(0, ids.length - 200).forEach((oldId) => delete config.boardResponses[oldId]);
  }
  saveConfig();
  window.deck.boardRespond({ requestId: id, ...response });
}

function cancelManagedRequests(col, reason) {
  if (!col || col.role === 'manual') return;
  const requestIds = Array.from(new Set([col.requestId, ...(col.waitRequestIds || [])].filter(Boolean)));
  requestIds.forEach((requestId) => respondBoard(requestId, {
    done: true,
    error: reason || 'Managed task was cancelled.',
    childId: col.taskId,
  }));
  col.requestId = null;
  col.waitRequestIds = [];
}

function taskDepth(col) {
  return BoardCore.taskDepth(columns, col);
}

function isManagedDescendant(parent, target) {
  return BoardCore.isManagedDescendant(columns, parent, target);
}

function taskSnapshot(caller) {
  const visible = columns.filter((col) =>
    col.taskId === caller.taskId || isManagedDescendant(caller, col));
  return {
    updatedAt: new Date().toISOString(),
    tasks: visible.map((col) => ({
      taskId: col.taskId,
      parentTaskId: col.parentTaskId || null,
      terminalId: col.id,
      title: columnLabel(col),
      role: col.role || 'manual',
      agentType: col.agentType || BoardCore.inferAgentType(col.cmd),
      terminalState: (terms.get(col.id) && terms.get(col.id).state) || 'plain',
      taskState: col.taskCompleted ? 'completed' : 'active',
      progress: col.progress || '',
      result: col.result || '',
    })),
  };
}

function finishManagedTask(col, result) {
  if (!col || col.role === 'manual' || col.taskCompleted) return;
  col.taskCompleted = true;
  col.result = BoardCore.cleanText(result, 12000) || 'Completed';
  col.progress = 'Completed';
  if (col.requestId) {
    respondBoard(col.requestId, { done: true, result: col.result, childId: col.taskId });
    col.requestId = null;
  }
  (col.waitRequestIds || []).forEach((requestId) =>
    respondBoard(requestId, { done: true, result: col.result, childId: col.taskId }));
  col.waitRequestIds = [];
  saveConfig();
  syncBoardState();
}

function createManagedChild(message, caller) {
  const title = BoardCore.cleanText(message.title, 200);
  const task = BoardCore.cleanText(message.task, 20000);
  if (!title || !task) throw new Error('A child task needs both a title and instructions.');
  if (columns.filter((col) => col.role !== 'manual').length >= MAX_MANAGED_TASKS) {
    throw new Error(`Managed task limit reached (${MAX_MANAGED_TASKS}). Complete or remove tasks before delegating more.`);
  }
  if (taskDepth(caller) + 1 > MAX_TASK_DEPTH) {
    throw new Error(`Maximum delegation depth reached (${MAX_TASK_DEPTH}).`);
  }
  const agent = BoardCore.cleanText(message.agent, 80) || 'claude';
  const child = addColumn({
    title,
    taskTitle: title,
    taskPrompt: task,
    role: 'worker',
    parentTaskId: caller.taskId,
    relationship: BoardCore.cleanText(message.relationship, 200) || `Delegated by ${columnLabel(caller)}`,
    agentType: BoardCore.inferAgentType(BoardCore.commandForAgent(agent, message.command)),
    cmd: BoardCore.commandForAgent(agent, message.command),
    cwd: BoardCore.cleanText(message.cwd, 1000) || caller.cwd || '',
    requestId: message.action === 'create-child' ? message.id : null,
    createdByRequestId: message.id,
    waitRequestIds: [],
    progress: 'Queued by parent',
    initialPromptSent: false,
  });
  config.links.push(BoardCore.normalizeLink({
    id: `link-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    fromTaskId: caller.taskId,
    toTaskId: child.taskId,
    type: 'delegation',
    message: task,
    grantedControl: true,
  }));
  saveConfig();
  renderBoardGraph();
  if (message.action === 'create-child') {
    respondBoard(message.id, { done: false, childId: child.taskId });
  } else {
    respondBoard(message.id, { done: true, childId: child.taskId, result: child.taskId });
  }
  return child;
}

window.deck.onBoardCommand((message) => {
  const cached = config.boardResponses[message.id];
  if (cached) {
    window.deck.boardRespond({ requestId: message.id, ...cached });
    return;
  }
  if (message.action === 'create-child' || message.action === 'spawn-child') {
    const existingChild = columns.find((col) => col.createdByRequestId === message.id);
    if (existingChild) {
      respondBoard(message.id, existingChild.taskCompleted
        ? { done: true, childId: existingChild.taskId, result: existingChild.result }
        : message.action === 'create-child'
          ? { done: false, childId: existingChild.taskId }
          : { done: true, childId: existingChild.taskId, result: existingChild.taskId });
      return;
    }
  }
  const caller = columns.find((col) => col.id === message.callerId);
  if (!caller || caller.role === 'manual') {
    respondBoard(message.id, { done: true, error: 'Managed caller terminal no longer exists.' });
    return;
  }
  try {
    if (message.action === 'create-child' || message.action === 'spawn-child') {
      createManagedChild(message, caller);
      return;
    }
    if (message.action === 'progress') {
      caller.progress = BoardCore.cleanText(message.message, 1000);
      saveConfig();
      syncBoardState();
      respondBoard(message.id, { done: true, result: 'Progress recorded.' });
      return;
    }
    if (message.action === 'complete') {
      const result = BoardCore.cleanText(message.result, 12000);
      if (!result) throw new Error('Completion requires a useful result.');
      finishManagedTask(caller, result);
      respondBoard(message.id, { done: true, result: 'Result delivered.' });
      return;
    }
    if (message.action === 'wait') {
      const target = columns.find((col) => col.taskId === message.taskId);
      if (!target || !isManagedDescendant(caller, target)) {
        throw new Error('wait target is not a managed descendant of this terminal.');
      }
      if (target.taskCompleted) {
        respondBoard(message.id, { done: true, result: target.result, childId: target.taskId });
      } else {
        target.waitRequestIds = Array.from(new Set([...(target.waitRequestIds || []), message.id]));
        respondBoard(message.id, { done: false, childId: target.taskId });
      }
      return;
    }
    if (message.action === 'send') {
      const target = columns.find((col) => col.taskId === message.taskId);
      if (!target || !isManagedDescendant(caller, target)) {
        throw new Error('send target is not a managed descendant of this terminal.');
      }
      const text = BoardCore.cleanText(message.message, 12000);
      const entry = terms.get(target.id);
      if (!text || !entry || !entry.alive) throw new Error('Target terminal is not available for input.');
      entry.term.paste(text);
      setTimeout(() => window.deck.ptyInput(target.id, '\r'), 40);
      respondBoard(message.id, { done: true, result: 'Message sent.' });
      return;
    }
    if (message.action === 'status') {
      respondBoard(message.id, { done: true, snapshot: taskSnapshot(caller) });
      return;
    }
    throw new Error(`Unsupported board action: ${message.action}`);
  } catch (err) {
    respondBoard(message.id, { done: true, error: err && err.message ? err.message : String(err) });
  }
});
window.deck.boardReady();

// ---- Assign top-level conductor task dialog ----
const taskDlg = document.getElementById('taskDialog');
const taskTitleInput = document.getElementById('taskTitleInput');
const taskPromptInput = document.getElementById('taskPromptInput');
const taskAgentInput = document.getElementById('taskAgentInput');
const taskCwdInput = document.getElementById('taskCwdInput');

function openTaskDialog() {
  taskTitleInput.value = '';
  taskPromptInput.value = '';
  taskCwdInput.value = '';
  taskDlg.showModal();
  setTimeout(() => taskTitleInput.focus(), 40);
}

document.getElementById('boardToTerminals').onclick = () => showView('terminals');
document.getElementById('boardAutoArrange').onclick = autoArrangeBoard;
document.getElementById('boardNewTerminal').onclick = () => addAndFocusColumn();
document.getElementById('boardNewTask').onclick = openTaskDialog;
document.getElementById('taskCancel').onclick = () => taskDlg.close();
document.getElementById('taskCreate').onclick = () => {
  const title = BoardCore.cleanText(taskTitleInput.value, 200);
  const taskPrompt = BoardCore.cleanText(taskPromptInput.value, 20000);
  if (!title || !taskPrompt) {
    showToast('Add a task title and instructions.');
    return;
  }
  const cmd = BoardCore.commandForAgent(taskAgentInput.value);
  const col = addColumn({
    title,
    taskTitle: title,
    taskPrompt,
    role: 'conductor',
    relationship: 'Top-level task',
    agentType: BoardCore.inferAgentType(cmd),
    cmd,
    cwd: BoardCore.cleanText(taskCwdInput.value, 1000),
    progress: 'Task assigned',
    initialPromptSent: false,
    manualTitle: true,
  });
  taskDlg.close();
  if (activeView === 'board') {
    renderBoardGraph();
    setTimeout(() => selectBoardNode(col.id, true), 100);
  }
  else setTimeout(() => jumpToColumn(col), 100);
};

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
window.addEventListener('resize', () => {
  if (activeView === 'board') renderBoardGraph();
  else { updateColumnStyles(); fitAll(); }
});
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
// the same screen-based state machine as the dots. Fires regardless of window
// focus so the behavior matches the Claude hook popups exactly.
//
// 'input' pops on the transition edge — a permission prompt mid-task IS the
// moment to fetch the user. 'done' must NOT pop on the edge: mid-task the
// screen can look idle for several seconds (tool execution, redraws between
// steps), which false-fired "跑完了" popups. So done waits for the state to
// hold NOTIFY_STABLE_TICKS consecutive ticks (~12s), and if the column goes
// back to working anyway, the already-shown popup is retracted (notifyCancel).
const NOTIFY_STABLE_TICKS = 8; // × ~1.5s tick ≈ 12s of quiet screen
function maybeNotifyState(id, entry, st) {
  const prev = entry.lastNotifyState;
  entry.lastNotifyState = st;
  const col = columns.find((c) => c.id === id);
  if (prev !== undefined && prev !== st) {
    let skip = '';
    if (st !== 'input' && st !== 'done') skip = 'state';
    else if (st === 'done' && !entry.hasWorked) skip = 'noWork';
    else if (!col) skip = 'noCol';
    else if (col && isClaudeCmd(col.cmd)) skip = 'claude';
    else if (st === 'done') skip = 'await-stable';
    try { window.deck.stateDebug({ id, title: col ? columnLabel(col) : '?', prev, st, hasWorked: entry.hasWorked, skip }); } catch (_) {}
  }
  if (!col) return;
  if (st === 'working') {
    // Resumed (or never really finished): a shown "跑完了" popup was premature.
    if (entry.doneNotified) { try { window.deck.notifyCancel({ id }); } catch (_) {} }
    entry.doneNotified = false;
    return;
  }
  if (isClaudeCmd(col.cmd)) return;
  if (st === 'input') {
    entry.doneNotified = false;
    if (prev !== undefined && prev !== st) {
      try { window.deck.notifyState({ id, title: columnLabel(col), state: st }); } catch (_) {}
    }
    return;
  }
  if (st === 'done') {
    if (prev === undefined) { entry.doneNotified = true; return; } // already idle at boot — nothing finished
    if (!entry.hasWorked || entry.doneNotified) return;
    if (entry.idleTicks < NOTIFY_STABLE_TICKS) return; // not stable yet
    entry.doneNotified = true;
    try { window.deck.stateDebug({ id, title: columnLabel(col), prev, st: 'done-stable', hasWorked: true, skip: '' }); } catch (_) {}
    try { window.deck.notifyState({ id, title: columnLabel(col), state: 'done' }); } catch (_) {}
  }
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
  syncBoardState();

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
  if (activeView === 'board') {
    selectBoardNode(col.id, true);
    return;
  }
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
  } else if (e.shiftKey && (k === 'b' || k === 'B')) {
    showView(activeView === 'board' ? 'terminals' : 'board');
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
  const anchor = activeView === 'board' && t.el.parentElement === boardTerminalHostEl ? t.el : t.wrap;
  const r = anchor.getBoundingClientRect();
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

// View restoration comes last because showView() closes the search/broadcast
// overlays, whose DOM bindings are initialized just above.
showView(config.activeView);
