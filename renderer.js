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
  refresh: S('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>'),
  fit:   S('<polyline points="4 7 4 4 7 4"/><polyline points="20 7 20 4 17 4"/><polyline points="4 17 4 20 7 20"/><polyline points="20 17 20 20 17 20"/>'),
  grip:  '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>',
  send:  S('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  up:    S('<polyline points="18 15 12 9 6 15"/>'),
  down:  S('<polyline points="6 9 12 15 18 9"/>'),
  help:  S('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  inbox: S('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  side:  S('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  flag: S('<path d="M5.5 21V4"/><path d="M5.5 4.6h12l-2.7 4 2.7 4h-12z" fill="currentColor"/>'),
  todo: S('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  tasks: S('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/><path d="M5.5 8h1.5M11 8h2M11 11.5h2M17 8h1.5"/>'),
  board: S('<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="4" width="6" height="5" rx="1"/><rect x="9" y="15" width="6" height="5" rx="1"/><path d="M6 9v3h12V9M12 12v3"/>'),
  newChat: S('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  clock: S('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  artifacts: S('<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>'),
  skills: S('<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2Z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z"/>'),
  folder: S('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderOpen: S('<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
  folderPlus: S('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/>'),
  chevRight: S('<polyline points="9 18 15 12 9 6"/>'),
  chevDown: S('<polyline points="6 9 12 15 18 9"/>'),
  // Standard gear (Lucide "settings"): toothed rim around a hub, not a watch face.
  gear: S('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  more: S('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  archive: S('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  restore: S('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
  trash: S('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  panelLeft: S('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
  freeLayout: S('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v4M12 16v4"/><path d="M7 12h10"/><path d="m9 10-2 2 2 2M15 10l2 2-2 2"/>'),
  battery: S('<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><rect x="4.6" y="9.6" width="4.6" height="4.8" rx=".6" fill="currentColor" stroke="none"/>'),
  gauge: S('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
  panelRight: S('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'),
  arrowUp: S('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  copy: S('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check: S('<polyline points="20 6 9 17 4 12"/>'),
  globe: S('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  image: S('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  chat: S('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>'),
  terminal: S('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  file: S('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  eraser: S('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
  crown: S('<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>'),
  gem: S('<path d="M6 3h12l4 6-10 13L2 9z"/>'),
  ban: S('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
  // A seat row that is not fine: yellow triangle (old numbers, failed read), red circle (cannot work).
  seatWarn: S('<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5m0 2.6v.2"/>'),
  seatBad: S('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5m0 3.2v.2"/>'),
  share: S('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>'),
  diff: S('<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="17" x2="15" y2="17"/>'),
  eye: S('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  settings: S('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/>'),
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
// Collapsing hides it completely (Cursor style); the top bar then shows its toggle.
const NAV_DEFAULT_W = 252, NAV_MIN_W = 200, NAV_MAX_W = 420, CENTER_MIN_W = 360;

const TERM_THEME = {
  dark:  { background: '#141414', foreground: '#e6e6e6', cursor: '#4b9bff', selectionBackground: 'rgba(75,155,255,0.35)' },
  light: { background: '#ffffff', foreground: '#1d1d1f', cursor: '#2f6fde', selectionBackground: 'rgba(47,111,222,0.25)' },
};

function newId() { return 'c' + Date.now() + Math.floor(Math.random() * 1000); }
function newTaskId() { return 't' + Date.now() + Math.floor(Math.random() * 100000); }
// Fresh / reset layout: three agent columns that auto-launch on open.
function defaultColumns() {
  const agents = [
    { title: 'Antigravity', cmd: BoardCore.commandForAgent('agy') },
    { title: 'Claude', cmd: BoardCore.commandForAgent('claude') },
    { title: 'Grok', cmd: BoardCore.commandForAgent('grok') },
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
  theme: 'dark', fitWindow: false, fitCols: DEFAULT_FIT_COLS, navWidth: NAV_DEFAULT_W,
  navCollapsed: false, fontSize: 13, activeView: 'terminals', columns: defaultColumns(), links: [],
  boardResponses: {}, boardPositions: {}, todoDeliveries: {}, todoInbox: {}, globalViewMode: 'term',
  claudeSeats: ClaudeSeatsCore.normalize(), activeClaudeSeatId: 'cn', captainRelayLabel: 'Relay',
  captainRelayCodex: { name: 'ChatGPT', command: ClaudeSeatsCore.CODEX_COMMAND }, captainRelayClaudeCommand: '',
  captainNotifications: NotificationPolicy.normalizeSettings(),
  claudeQuotaAlert: { thresholdPercent: 2 }, barkKeyFile: '',
  barkNotifications: BarkPolicy.settings(),
  perpetualCaptain: PerpetualCaptainCore.normalizeSettings(), perpetualCaptainState: PerpetualCaptainCore.normalizeState(), barkKeyFile: '',
  quotaWarmup: QuotaWarmupCore.normalizeSettings(),

  // sidebar folders, archived sessions (terminal stopped, conversation kept), Schedule
  folders: [], archived: [], schedules: [], navArchivedOpen: false, crewOpen: true, crewModelsCollapsed: [], artifactsCollapsed: [],
  captainTokenSaver: MainCore.tokenSaverSettings(),
  concurrencyCap: MainCore.concurrencyCap(), captainHandoffOverview: MainCore.handoffBudget(),
  batteryMode: BatteryCore.MODE_DEFAULT, batteryConcurrency: BatteryCore.CAP_DEFAULT,
};
const saved = window.deck.loadConfig();
config.sidebarFontSize = SidebarCore.normalizeFontSize(saved?.sidebarFontSize);
config.todoShortcut = TodoShortcutCore.normalize(saved?.todoShortcut);
// Persist only parsed observations, never terminal text or credentials.
config.quotas = saved?.quotas && typeof saved.quotas === 'object' ? saved.quotas : {};
if (saved) {
  if (typeof saved.barkKeyFile === 'string') config.barkKeyFile = saved.barkKeyFile;
  config.barkNotifications = BarkPolicy.settings(saved.barkNotifications);
  if (saved.claudeQuotaAlert && typeof saved.claudeQuotaAlert === 'object') {
    config.claudeQuotaAlert = { thresholdPercent: QuotaCore.percent(saved.claudeQuotaAlert.thresholdPercent) ?? 2 };
  }
  config.claudeSeats = ClaudeSeatsCore.normalize(saved.claudeSeats);
  config.perpetualCaptain = PerpetualCaptainCore.normalizeSettings(saved.perpetualCaptain);
  config.quotaWarmup = QuotaWarmupCore.normalizeSettings(saved.quotaWarmup);
  config.perpetualCaptainState = PerpetualCaptainCore.normalizeState(saved.perpetualCaptainState);
  if (typeof saved.barkKeyFile === 'string') config.barkKeyFile = saved.barkKeyFile;
  config.captainRelayLabel = typeof saved.captainRelayLabel === 'string' ? saved.captainRelayLabel.slice(0, 80) : 'Relay';
  config.activeClaudeSeatId = ClaudeSeatsCore.active({ ...saved, claudeSeats: config.claudeSeats }).id;
  if (saved.captainRelayCodex && typeof saved.captainRelayCodex === 'object') config.captainRelayCodex = {
    name: typeof saved.captainRelayCodex.name === 'string' ? saved.captainRelayCodex.name.slice(0, 80) : 'ChatGPT',
    command: typeof saved.captainRelayCodex.command === 'string' ? BoardCore.upgradeLegacyCommand(saved.captainRelayCodex.command) : ClaudeSeatsCore.CODEX_COMMAND,
  };
  if (typeof saved.captainRelayClaudeCommand === 'string') config.captainRelayClaudeCommand = saved.captainRelayClaudeCommand;
  config.captainNotifications = NotificationPolicy.normalizeSettings(saved.captainNotifications);
  // The last global toggle applies only during this run. Every launch starts
  // in the terminal, even when an older config saved chat mode.
  config.globalViewMode = 'term';
  if (saved.theme) config.theme = saved.theme;
  config.calmMotion = saved.calmMotion === true;
  // The version whose 版本更新 page was last opened; a newer install lights a dot on the version button.
  if (typeof saved.releaseNotesSeen === 'string') config.releaseNotesSeen = saved.releaseNotesSeen;
  if (saved.fitWindow !== undefined) config.fitWindow = saved.fitWindow;
  if (FIT_COLS_CHOICES.includes(saved.fitCols)) config.fitCols = saved.fitCols;
  // widths from the old, narrower sidebar fall back to the new default
  if (saved.navWidth) config.navWidth = saved.navWidth < NAV_MIN_W ? NAV_DEFAULT_W : Math.min(NAV_MAX_W, saved.navWidth);
  config.folders = SidebarCore.normalizeFolders(saved.folders);
  config.archived = SidebarCore.normalizeArchived(saved.archived).map((c) => ({ ...c,
    claudeSeatId: c.claudeSeatId || config.activeClaudeSeatId,
  }));
  if (Array.isArray(saved.schedules)) config.schedules = saved.schedules;
  config.navArchivedOpen = !!saved.navArchivedOpen;
  // crewOpen and crewModelsCollapsed are not restored: the crew list opens fully at every launch.
  config.resumeOnRestart = window.RestartResume.resumeEnabled(saved);
  config.mainSession = saved.mainSession && typeof saved.mainSession === 'object' ? saved.mainSession : null;
  config.captainHistory = Array.isArray(saved.captainHistory) ? saved.captainHistory : [];
  // 待我处理 (attention-ui.js normalizes and migrates it); without this every restart emptied the page.
  if (saved.attention && typeof saved.attention === 'object') config.attention = saved.attention;
  if (saved.todoDeliveries && typeof saved.todoDeliveries === 'object' && !Array.isArray(saved.todoDeliveries)) {
    config.todoDeliveries = Object.fromEntries(Object.entries(saved.todoDeliveries).filter(([id, accepted]) => /^todo-(?:error-)?[a-f0-9]{64}$/.test(id) && accepted === true));
  }
  if (saved.todoInbox && typeof saved.todoInbox === 'object' && !Array.isArray(saved.todoInbox)) config.todoInbox = saved.todoInbox;
  config.captainTokenSaver = MainCore.tokenSaverSettings(saved.captainTokenSaver);
  config.concurrencyCap = MainCore.concurrencyCap(saved.concurrencyCap);
  config.batteryMode = BatteryCore.normalizeMode(saved.batteryMode);
  config.batteryConcurrency = BatteryCore.normalizeCap(saved.batteryConcurrency);
  config.captainHandoffOverview = MainCore.handoffBudget(saved.captainHandoffOverview);
  if (saved.navCollapsed !== undefined) config.navCollapsed = saved.navCollapsed;
  if (typeof saved.fontSize === 'number' && saved.fontSize >= 8 && saved.fontSize <= 32) config.fontSize = saved.fontSize;
  if (['captain', 'gemini'].includes(saved.taskBoard?.dispatcher) || saved.taskBoard?.autoVerify === false) {
    config.taskBoard = { ...(['captain', 'gemini'].includes(saved.taskBoard.dispatcher) ? { dispatcher: saved.taskBoard.dispatcher } : {}), ...(saved.taskBoard.autoVerify === false ? { autoVerify: false } : {}) };
  }
  if (saved.taskBoardView && typeof saved.taskBoardView === 'object') {
    const v = saved.taskBoardView;
    config.taskBoardView = {
      laneOrder: (Array.isArray(v.laneOrder) ? v.laneOrder : []).filter((k) => typeof k === 'string' && k.length <= 120).slice(0, 500),
      collapsed: Object.fromEntries(Object.entries(v.collapsed && typeof v.collapsed === 'object' ? v.collapsed : {}).filter(([k, on]) => k.length <= 120 && on === true).slice(0, 500)),
      doneOpen: v.doneOpen === true,
      completedOpen: v.completedOpen === true,
    };
  }
  if (saved.tokenUsageView?.days === 30) config.tokenUsageView = { days: 30 };
  // Artifacts: the projects the user folded away
  config.artifactsCollapsed = (Array.isArray(saved.artifactsCollapsed) ? saved.artifactsCollapsed : []).filter((k) => typeof k === 'string' && k.length <= 120).slice(0, 500);
  // 队长's 交付文件 panel: folded away or not, its two lists if changed, and the index of what it found (DeliverablesCore)
  if (saved.chatDeliverablesOpen === false) config.chatDeliverablesOpen = false;
  if (saved.deliverableRules && typeof saved.deliverableRules === 'object') config.deliverableRules = DeliverablesCore.normalizeRules(saved.deliverableRules);
  if (saved.chatDeliverables && typeof saved.chatDeliverables === 'object') config.chatDeliverables = DeliverablesCore.normalizeIndex(saved.chatDeliverables, DeliverablesCore.normalizeRules(config.deliverableRules));
  if (saved.activeView === 'board') config.activeView = 'board';
  if (saved.side && typeof saved.side === 'object') config.side = saved.side;
  config.boardPositions = BoardCore.normalizeBoardPositions(saved.boardPositions);
  config.crewMap = CrewMapCore.normalizeSaved(saved.crewMap);
  if (saved.boardResponses && typeof saved.boardResponses === 'object' && !Array.isArray(saved.boardResponses)) {
    config.boardResponses = Object.fromEntries(Object.entries(saved.boardResponses).slice(-200));
  }
  if (Array.isArray(saved.links)) {
    config.links = saved.links.map(BoardCore.normalizeLink).filter((link) => link.id && link.fromTaskId && link.toTaskId);
  }
  if (Array.isArray(saved.columns) && saved.columns.length) {
    config.columns = saved.columns.map((c) => BoardCore.normalizeColumn({
      id: c.id || newId(), title: c.title || 'Agent', cwd: c.cwd || '', cmd: BoardCore.upgradeLegacyCommand(c.cmd || ''), width: c.width || DEFAULT_WIDTH,
      // Pre-feature configs carry no manualTitle: infer it. Auto-ish titles
      // (pure numbers, preset agent names) stay auto-renamable; anything else
      // was typed by the user and must never be auto-renamed.
      manualTitle: c.manualTitle !== undefined ? !!c.manualTitle : isManualTitle(c.title),
      taskId: c.taskId || newTaskId(),
      role: c.role || 'manual',
      reviews: c.reviews,
      parentTaskId: c.parentTaskId,
      taskTitle: c.taskTitle,
      taskPrompt: c.taskPrompt,
      relationship: c.relationship,
      progress: c.progress,
      result: c.result,
      requestId: c.requestId,
      waitRequestIds: c.waitRequestIds,
      createdByRequestId: c.createdByRequestId,
      trustedCwd: typeof c.trustedCwd === 'string' ? c.trustedCwd : '',
      taskCompleted: c.taskCompleted,
      initialPromptSent: c.initialPromptSent,
      agentType: c.agentType,
      agentProvider: c.agentProvider,
      agentModel: c.agentModel,
      agentEffort: c.agentEffort,
      claudeConfigDir: c.claudeConfigDir,
      modelSessionId: c.modelSessionId,
      modelSessionOwner: c.modelSessionOwner,
      modelSessionCwd: c.modelSessionCwd,
      modelSessionSource: c.modelSessionSource,
      captainTaskPrompt: c.captainTaskPrompt,
      sessionWatchSince: Number.isFinite(c.sessionWatchSince) ? c.sessionWatchSince : 0,
      displayTitle: c.displayTitle || (c.manualTitle ? c.title : ''),
      // Relaunch always starts each session in the terminal.
      view: 'term',
      folderId: typeof c.folderId === 'string' ? c.folderId : null,
      isMain: !!c.isMain,
      captainCrew: !!c.captainCrew,
      // 小队长: the sub-captain itself, the sub-captain a child reports to, its folded child list
      ...(c.subCaptain === true ? { subCaptain: true } : {}),
      ...(typeof c.subCaptainId === 'string' && c.subCaptainId ? { subCaptainId: c.subCaptainId } : {}),
      ...(c.subCrewCollapsed === true ? { subCrewCollapsed: true } : {}),
      project: typeof c.project === 'string' ? c.project : '',
      boardId: typeof c.boardId === 'string' ? c.boardId : '',
      boardAttempt: typeof c.boardAttempt === 'string' ? c.boardAttempt : '',
      dispatcherCardId: typeof c.dispatcherCardId === 'string' ? c.dispatcherCardId : '',
      ...(c.important === true ? { important: true } : {}),   // 高优先级, for work handed out without a card

      claudeSeatId: c.claudeSeatId || config.activeClaudeSeatId,
      lastReceipt: c.lastReceipt && typeof c.lastReceipt === 'object' ? c.lastReceipt : null,
    }));
  }
}
// Battery mode: the live cap is the settings cap lowered while on battery (MainSession keeps it current).
const battery = BatteryCore.shared;
let onBatteryPower = false;
try { onBatteryPower = window.deck.powerState()?.onBattery === true; } catch (_) {}
battery.set({ onBattery: onBatteryPower, mode: config.batteryMode, cap: config.batteryConcurrency });
MainCore.MAX_ACTIVE = BatteryCore.effectiveCap(config.concurrencyCap, battery.snapshot()).cap;
window.deck.onPowerChanged((on) => battery.set({ onBattery: on }));
window.deck.onPowerSleep((asleep, at) => window.MainSession.onPower(asleep, at));
function seatLaunchCommand(col, command) {
  const seat = ClaudeSeatsCore.bindColumn(col, config);
  if (!seat.configDir) return ''; // A removed, unbound seat must not launch under another login.
  return ClaudeSeatsCore.launchCommand(command, seat, env.home, env.platform);
}
// Once: sessions 队长 opened before they were marked go under it too.
if (config.mainSession && !config.mainSession.crewMarked) {
  const opened = MainCore.openedByCaptain(config.columns, config.mainSession.tasks);
  config.columns.forEach((c) => { if (opened.has(c.id) && !c.folderId) c.captainCrew = true; });
  config.mainSession.crewMarked = true;
}
// The deck always shows sessions in sidebar order: 队长 and its sessions,
// folders, then loose ones.
config.columns = SidebarCore.orderedColumns(config.columns, config.folders);
let columns = config.columns;
columns.forEach((col) => ClaudeSeatsCore.bindColumn(col, config));
config.archived.forEach((col) => ClaudeSeatsCore.bindColumn(col, config));
let activeView = config.activeView;
// Changes arriving together (a drag, 队长 task updates) are written once:
// the main process writes config.json synchronously, so bursts would stall
// both processes. Leaving or reloading the page writes immediately.
let saveTimer = 0;
function saveConfig() {
  config.columns = columns;
  if (!saveTimer) saveTimer = setTimeout(flushConfig, 150);
}
function flushConfig() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  config.columns = columns;
  window.deck.saveConfig(config);
}
window.addEventListener('pagehide', flushConfig);
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flushConfig(); });
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
  applyNavTitle(nav && nav.label, label);
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
// skipped (OSC/DCS replies such as colour queries too); inside a bracketed paste
// a newline is literal content, not "send".
function makePromptTracker(col) {
  let buf = '', inPaste = false, escape = '', x10Bytes = 0;
  // What the 队长 delivery needs to know: is something typed and not sent yet?
  // draft: the rebuilt line. unknown: a key that can put text in the box
  // without us seeing it (history recall, Tab), until Enter or ^C/^U.
  // lastKeyAt: the user's last real key, never xterm's automatic replies.
  const typing = { draft: '', unknown: false, lastKeyAt: 0 };
  const RECALL = '\t\x07\x10\x0e\x12\x16\x19\x01\x02\x04\x05\x06\x0b\x0f\x14\x17';
  const track = (d) => {
    for (let i = 0; i < d.length; ) {
      const ch = d[i];
      if (x10Bytes) { x10Bytes--; i++; continue; }
      if (escape) {
        escape += ch; i++;
        if (/^\x1b[\]P]/.test(escape)) {
          // OSC/DCS replies (Cursor's TUI asks for the background colour on start):
          // skipped up to BEL or ST, never counted as typed text
          if (ch === '\x07' || escape.endsWith('\x1b\\') || escape.length >= 256) escape = '';
          continue;
        }
        if (escape === '\x1b[' || escape === '\x1bO') continue;
        if (escape.startsWith('\x1b[') && !/[@-~]/.test(ch) && escape.length < 64) continue;
        if (escape === '\x1b[200~') { inPaste = true; typing.lastKeyAt = Date.now(); }
        else if (escape === '\x1b[201~') inPaste = false;
        else if (escape === '\x1b[M') x10Bytes = 3;
        else if (/^\x1b(?:\[|O)(?:[\d;]*)([A-DHF~])$/.test(escape)) {
          // cursor and editing keys (not focus, mouse or query replies)
          typing.lastKeyAt = Date.now();
          typing.unknown = true;   // history or cursor edits make the rebuilt line uncertain
        } else if (/^\x1b[^\[O\]]$/.test(escape)) { typing.lastKeyAt = Date.now(); typing.unknown = true; }   // Alt/Meta combos
        escape = '';
        continue;
      }
      if (ch === '\x1b') { escape = ch; i++; continue; }
      typing.lastKeyAt = Date.now();
      if (ch === '\r' || ch === '\n') {
        if (inPaste) buf += '\n';
        else { const line = buf.trim(); const uncertain = typing.unknown || /[\r\n]/.test(buf); buf = ''; typing.unknown = false; maybeAutoName(col, line); ChatUI.onSubmitted(col, line, uncertain); }
        i++;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); i++; continue; }
      if (ch === '\x03' || ch === '\x15') { buf = ''; typing.unknown = false; i++; continue; }  // ^C / ^U clear the line
      if (ch < ' ') { if (RECALL.includes(ch)) typing.unknown = true; i++; continue; }
      buf += ch;
      if (buf.length > 2000) { buf = buf.slice(-2000); typing.unknown = true; }
      i++;
    }
    typing.draft = buf.trim();
  };
  track.typing = typing;
  return track;
}

// Is the user in the middle of a message in this column's terminal input box?
// Automatic sends (队长's receipts, work it hands out) type into that box and
// press Enter, which would send the half-written words too. True while the
// key tracker holds unsent text (or cannot tell, after a history recall) or
// the user pressed a key within INPUT_QUIET; also when the agent's box on
// screen shows text that someone typed (restored by the agent after an
// interrupt, for instance). A recognised empty box clears a "cannot tell".
const INPUT_QUIET = 5000;
const MASK = '\u0000';
function visibleInputBox(entry) {
  try {
    const b = entry.term.buffer.active;
    const end = b.baseY + entry.term.rows;
    const plain = [], masked = [];
    for (let y = b.baseY; y < end; y++) {   // the whole visible screen: a young session leaves rows empty below its box
      const line = b.getLine(y);
      let p = '', m = '';
      for (let x = 0; line && x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        p += ch;
        m += cell.isDim() || cell.isInverse() || !cell.isFgDefault() ? MASK.repeat(ch.length) : ch;
      }
      plain.push(p); masked.push(m);
    }
    return MainCore.inputBoxText(plain, masked);
  } catch (_) { return null; }
}
// ownText: what AgentDeck itself just typed into this box (ChatUI's check that it was submitted).
// That text still sitting in the box, or its collapsed paste, is not the user's; keys the user
// pressed, a draft, or any other text there still are.
const flatBox = (text) => String(text || '').replace(/[\s│┃]+/g, '');
function userComposing(id, ownText) {
  if (ChatUI.hasDraft(id)) return true;
  const entry = terms.get(id);
  if (!entry || !entry.typing) return false;
  const t = entry.typing;
  if (Date.now() - t.lastKeyAt < INPUT_QUIET || t.draft) return true;
  const box = visibleInputBox(entry);
  if (box && typeof ownText === 'string' && (flatBox(ownText).includes(flatBox(box)) || /^(?:\[Pastedtext#\d+(?:\+\d+lines?)?\])+$/i.test(flatBox(box)))) return t.unknown;
  if (box) return true;
  if (box === '') t.unknown = false;
  return t.unknown;
}

// ---- Terminals ----
const terms = new Map(); // id -> { term, fit, el, wrap, titleEl, dot, alive }
let focusedId = null;    // id of the column whose terminal last had focus
// Sessions 队长 opened run in the background ("backstage"): their columns stay
// built and sized (PTY, status, receipts) but sit outside the deck. Opening one
// (sidebar or task card) shows it after 队长 until focus moves on.
let peekId = null;
function isBackstage(col) {
  return !!col && !!col.captainCrew && !col.isMain && col.id !== peekId && columns.some((c) => c.isMain);
}
function peekColumn(col) {
  if (!isBackstage(col)) return;
  peekId = col.id;
  updateColumnStyles();
}
// The columns you can see and walk through, in deck order.
function deckColumns() { return columns.filter((c) => !isBackstage(c)); }
let zoomedId = null;     // column temporarily maximized to fill the deck (Cmd+Enter / double-click header)

// Chat-mode columns take typing in their composer; terminal-mode ones in xterm.
function focusColumnInput(id) {
  const t = terms.get(id);
  if (!t) return;
  if (focusedId !== id) ChatUI.setMode(id, 'term');
  if (!ChatUI.focusInput(id)) t.term.focus();
}

// Zoom in/out of one column. Focus follows the zoom so typing lands where
// you're looking; while zoomed, moving focus (Cmd+←→/1-9/J) re-zooms onto the
// newly focused column instead of typing into a hidden one.
function toggleZoom(id) {
  if (!id || !terms.has(id)) return;
  zoomedId = zoomedId === id ? null : id;
  updateColumnStyles();
  fitAll();
  const t = terms.get(id);
  if (t) { focusColumnInput(id); focusedId = id; syncNav(); }
}

function writePtyData(id, t, data, at) {
  // a chunk of terminal queries only (an idle Claude asking for the cursor) is not output
  if (MainCore.drawsOutput(data)) t.lastOutputAt = at;
  MainSession.onOutput(id, data); t.term.write(data);
}
window.deck.onPtyData((id, data, sequence) => {
  const t = terms.get(id);
  if (!t) return;
  const at = Date.now();
  if (t.pendingPtyData) t.pendingPtyData.push({ data, sequence, at });
  else writePtyData(id, t, data, at);
});
window.deck.onPtyExit((id, reason) => {
  const t = terms.get(id);
  if (t) {
    t.alive = false; t.state = 'exited';
    t.exitReason = reason || '终端进程已退出';
    // Finalize a running timer so the exited column shows "✓ total", not a
    // frozen mid-count.
    if (t.workStart) { t.workedMs = Date.now() - t.workStart; t.workStart = 0; t.doneAt = Date.now(); }
    t.term.write('\r\n\x1b[2m[已退出 / process exited]\x1b[0m\r\n');
    setDot(t, 'exited'); syncNav(); syncBoardState();
    ChatUI.onExit(id);
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
// Live TUI indicators, not words quoted in an answer or an idle model's
// Thinking: high setting. Gemini/agy uses timed 'esc to cancel' spinners.
const WORKING_RE = /^\s*[│┃|]?\s*(?:[◦●•✻✽✳✶✢✺∴*·\u2800-\u28FF]\s*)?(?:Doing(?:…|\.\.\.)|Working(?:\s*\(|\s*(?:…|\.\.\.)|\s*$)|Running(?:…|\.\.\.|\s*$)|(?:Thinking|Responding|Generating|思考中|正在思考)(?:…|\.\.\.|\s*\(|\s*$)|esc to interrupt\b|ctrl\+c to stop\b|[↑↓]\s*[\d.]+k?\s+tokens)|^\s*[✻✽✳✶✢✺∴*·\u2800-\u28FF]\s+\S[^\n]*(?:…|\.\.\.|esc to interrupt)|^\s*[^\n]*…\s*\([^\n]*esc to cancel\)|^\s*⎿\s+Running\b/im;
// Only structurally dialog-shaped patterns: prose like "Would you like me to
// also…?" at the end of a normal reply must NOT hold a column red forever.
// Claude/Grok permission prompts always render a "❯ 1." option list; y/n
// prompts show "(y/n)"; Antigravity's approval footer is "Enter to confirm".
// Claude's startup menus also come without row numbers (its one-time "Make auto mode your default
// permission mode?" menu, whose "No, keep bypass permissions" row is idle-looking text; the bypass
// warning's "No, exit" / "Yes, I accept"). Such a menu is its two option rows one under the other, each
// row nothing but the option (a box edge aside), the ❯ cursor on one of them. One ❯ row alone is not:
// Claude 2.1 shows the user's earlier prompts with the same ❯ ("❯ No, keep it"), and replies may quote
// the words in any form.
const NEEDS_INPUT_RE = new RegExp([
  /❯\s*\d+\.\s|\(y\/n\)|\[y\/n\]|enter to confirm|trust (?:this|the) (?:folder|workspace|files)|select\s+login\s+method/.source,
  ...[['Yes, set auto mode as my default(?: permission(?: mode)?)?(?:[ \\t│┃]*\\n[ \\t│┃]*(?:permission )?mode)?', 'No, keep [a-z][a-z ]{0,30}?'],
    ['No, exit', 'Yes, I accept']].flatMap(([first, second]) => [
    `^[ \\t│┃]*❯[ \\t]*${first}[ \\t│┃]*\\n[ \\t│┃]*${second}[ \\t│┃]*$`,
    `^[ \\t│┃]*${first}[ \\t│┃]*\\n[ \\t│┃]*❯[ \\t]*${second}[ \\t│┃]*$`,
  ]),
].join('|'), 'im');
const AGENT_IDLE_RE = /bypass permissions|for shortcuts|← for agents|\bBuild anything\b|\bPlan, search, build anything\b|\bAdd a follow-up\b|Antigravity|Claude Code|Composer|OpenAI Codex|Codex|context left|Model:\s+(?:Opus|Sonnet|Haiku|Fable)|Context:\s*\[|^[❯›]\s*$|│\s*❯/im;
// Can this column take a prompt now? Busy beats idle. Cursor's prompt row is
// read by MainCore.cursorActivity, which also copes with a wrapped prompt.
function terminalIdle(col, entry) {
  if (!entry || !entry.alive || entry.state === 'working' || entry.state === 'input' || entry.state === 'quota') return false;
  // The launch line echoed by the shell is not the agent (it can even contain its name).
  if (MainCore.launchEchoOnly(entry.lastScreen)) return false;
  if (MainCore.terminalActivity(entry.lastScreen, col.cmd) || (!col.isMain && MainCore.claudeBackgroundTasks(entry.lastScreen, col.cmd))) return false;
  if (/\bcursor-agent\b/i.test(col.cmd || '')) {
    const live = MainCore.cursorActivity(entry.lastScreen);
    return live === 'idle' || (live !== 'working' && !MainCore.cursorBusy(entry.lastScreen) && AGENT_IDLE_RE.test(entry.lastScreen || ''));
  }
  const screen = MainCore.codexStatusScreen(entry.lastScreen, col.cmd);
  return !WORKING_RE.test(MainCore.claudeStatusRowsBlanked(screen, col.cmd)) && AGENT_IDLE_RE.test(screen);
}
const WEB_QUEUED_TIP = '排队中：前面还有网页调研在跑';
const DOT_TIP = { plain: '未开始', working: '干活中…', quota: '额度用尽/等待', input: '等你回复！', done: '已完成', failed: '没做成', stopped: '已中断', exited: '已退出' };
// withoutBackground: read the screen as if no background shell/monitor were counted.
function classify(text, entry, cmd, isCaptain = false, withoutBackground = false) {
  if (cmd === 'chatgpt-web') return entry?.webExecutorState || 'plain';
  text = MainCore.codexStatusScreen(text, cmd);
  const activity = MainCore.terminalActivity(text, cmd);
  if (activity === 'quota') return activity;
  const lines = text.split('\n');
  if (activity === 'working') return activity;
  // Cursor's prompt is idle only after MainCore has ruled out live activity.
  if (/\bcursor-agent\b/i.test(cmd || '') && MainCore.cursorActivity(text) === 'idle') {
    if (NEEDS_INPUT_RE.test(lines.slice(-20).join('\n'))) return 'input';
    // Cursor briefly paints a ready prompt between tools. Require quiet output
    // before ending an already-running turn, even when no spinner is visible.
    if (entry?.state === 'working' && Date.now() - (entry.lastOutputAt || 0) < 10_000) return 'working';
    return entry?.hasWorked ? 'done' : 'plain';
  }
  if (WORKING_RE.test(MainCore.claudeStatusRowsBlanked(text, cmd)) || (/\bcursor-agent\b/i.test(cmd || '') && MainCore.cursorBusy(text))) return 'working';
  if (NEEDS_INPUT_RE.test(lines.slice(-20).join('\n'))) return 'input';
  // Scrolled up in Claude's fullscreen view: the spinner is off screen, not gone. A working turn
  // stays working until the view is back at the bottom and shows how the turn really stands.
  if (entry?.state === 'working' && MainCore.claudeScrolledUp(text, cmd)) return 'working';
  if (!isCaptain && !withoutBackground && MainCore.claudeBackgroundTasks(text, cmd)) return 'working';
  // After submission, an unrecognised/empty Cursor screen is initialization
  // or work without a ready prompt, never evidence that the turn finished.
  if (/\bcursor-agent\b/i.test(cmd || '') && entry?.hasWorked) return 'working';
  if (AGENT_IDLE_RE.test(text)) return (entry && entry.hasWorked) ? 'done' : 'plain';
  return 'plain';
}
// The turn is over and only a background shell/monitor keeps the dot yellow: the
// prompt takes a tell (MainCore.workingForSend), while the dot and the receipt
// clocks keep waiting for that work.
function backgroundOnlyState(st, isCaptain, text, entry, cmd) {
  return st === 'working' && !isCaptain && MainCore.claudeBackgroundTasks(text, cmd) &&
    classify(text, entry, cmd, false, true) !== 'working';
}
function setDot(entry, state) {
  if (!entry || !entry.dot) return;
  const queued = state === 'working' && entry.webQueued;   // a web request waiting its turn
  entry.dot.className = 'dot ' + state + (queued ? ' web-queued' : '');
  entry.dot.title = queued ? WEB_QUEUED_TIP : DOT_TIP[state] || '';
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

// ---- 动效 ----
// 任务看板 and 终端架构图 hold still when the user turns motion off with the toolbar
// button, or when the system asks for 减少动态效果 (then the button only says so).
const MOTION_ICON = {
  on: S('<path d="M11 4l1.7 4.3L17 10l-4.3 1.7L11 16l-1.7-4.3L5 10l4.3-1.7z"/><path d="M18.5 15v4M16.5 17h4"/>'),
  off: S('<path d="M11 4l1.7 4.3L17 10l-4.3 1.7L11 16l-1.7-4.3L5 10l4.3-1.7z"/><path d="M18.5 15v4M16.5 17h4"/><path d="M4 4l16 16"/>'),
};
const systemCalm = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyMotion(off, redraw) {
  config.calmMotion = !!off;
  // On battery the motion is held still without touching the user's own setting.
  const powerStill = battery.active();
  if (off || powerStill) document.documentElement.setAttribute('data-motion', 'off'); else document.documentElement.removeAttribute('data-motion');
  if (powerStill) document.documentElement.setAttribute('data-power', 'battery'); else document.documentElement.removeAttribute('data-power');
  const still = off || systemCalm.matches || powerStill;
  const locked = systemCalm.matches || powerStill;
  const label = systemCalm.matches ? '系统已开启「减少动态效果」，动效保持关闭' : powerStill ? '电池供电，动效保持关闭（接电后恢复）' : off ? '开启动效（现在是静止的）' : '关闭动效（卡片和连线保持静止）';
  document.querySelectorAll('[data-motion-toggle]').forEach((b) => {
    b.innerHTML = still ? MOTION_ICON.off : MOTION_ICON.on;
    b.title = label; b.setAttribute('aria-label', label);
    if (locked) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
  });
  if (!redraw) return;
  saveConfig();
  TaskBoardUI.redraw(); // the lights on its lines are drawn by script; the map's are all in the stylesheet
}
document.querySelectorAll('[data-motion-toggle]').forEach((b) => b.addEventListener('click', () => { if (!systemCalm.matches && !battery.active()) applyMotion(!config.calmMotion, true); }));
systemCalm.addEventListener('change', () => applyMotion(config.calmMotion, true));

// ---- Text size (Ctrl on Win/Linux, Cmd on Mac; +/- adjust, 0 reset) ----
const FONT_MIN = 8, FONT_MAX = 32, FONT_DEFAULT = 13;
// The chat view follows the same size: it scales with the terminal font.
function applyChatZoom() {
  document.documentElement.style.setProperty('--chat-zoom', String(config.fontSize / FONT_DEFAULT));
}
applyChatZoom();
function setFontSize(size) {
  size = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  if (size === config.fontSize) return;
  config.fontSize = size;
  applyChatZoom();
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
function applySidebarFontSize() {
  document.getElementById('colNav').style.setProperty('--sidebar-scale', String(config.sidebarFontSize / SidebarCore.FONT_DEFAULT));
}
applySidebarFontSize();
let contentFontFocus = false;
// Clicking non-focusable chrome also changes the shortcut's target; tabbing
// back to a terminal/composer changes it back. Native menus share this scope.
for (const event of ['pointerdown', 'focusin']) document.addEventListener(event, (e) => {
  contentFontFocus = !!e.target.closest('.xterm, .composer, .chat-scroll');
}, true);
function adjustTextSize(delta) {
  if (contentFontFocus) {
    setFontSize(delta === 0 ? FONT_DEFAULT : config.fontSize + delta);
  } else {
    config.sidebarFontSize = SidebarCore.normalizeFontSize(delta === 0 ? SidebarCore.FONT_DEFAULT : config.sidebarFontSize + delta);
    applySidebarFontSize();
    saveConfig();
    showToast(`侧边栏字号 ${Math.round(config.sidebarFontSize / SidebarCore.FONT_DEFAULT * 100)}%`);
  }
}
window.deck.onFontSize((delta) => {
  if (delta === -1 || delta === 0 || delta === 1) adjustTextSize(delta);
});

// ---- Window chrome: sidebar head, top bar over the deck, sidebar footer ----
function railBtn(svg, tip, onClick, accent) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rail-btn' + (accent ? ' accent' : '');
  b.innerHTML = svg; b.title = tip; b.onclick = onClick;
  return b;
}
function openNotificationSettings() {
  if (focusedId) ChatUI.setMode(focusedId, 'term');
  const dialog = document.getElementById('notificationSettings');
  const settings = config.captainNotifications;
  document.getElementById('captainNotifyEnabled').checked = settings.enabled;
  document.getElementById('captainSoundEnabled').checked = settings.sound;
  document.getElementById('captainSoundTone').value = settings.tone;
  document.getElementById('captainSoundTone').disabled = env.platform !== 'darwin';
  document.getElementById('barkKeyFile').value = config.barkKeyFile;
  const bark = BarkPolicy.settings(config.barkNotifications);
  document.getElementById('barkCriticalVolume').value = bark.criticalVolume;
  document.getElementById('barkSleepEnabled').checked = bark.sleepEnabled;
  document.getElementById('barkSleepStart').value = bark.sleepStart;
  document.getElementById('barkSleepEnd').value = bark.sleepEnd;
  document.getElementById('barkClassesEnabled').checked = bark.classesEnabled;
  document.getElementById('barkClassCalendarIds').value = bark.classCalendarIds.join('\n');
  document.getElementById('barkClassFilters').value = bark.classFilters.join('\n');
  document.getElementById('barkWeeklyClasses').value = (bark.weeklyClasses || []).map((entry) => `周${'日一二三四五六'[entry.day]} ${entry.start}-${entry.end}`).join('\n');
  updateBarkPolicyStatus();
  MainSession.openSettings();
  updateMobileWebSettings();
  updateAutomationSettings();
  dialog.showModal();
}
async function updateMobileWebSettings(input) {
  const toggle = document.getElementById('mobileWebEnabled');
  toggle.disabled = true;
  try {
    const status = await window.deck.mobileWebSettings(input);
    toggle.checked = status.enabled;
    document.querySelector('.mobile-web-access').hidden = !status.enabled;
    document.getElementById('mobileWebUrl').value = status.url || '';
    document.getElementById('mobileWebOrigin').value = status.publicOrigin || '';
    document.getElementById('mobileWebPublicUrl').value = status.publicUrl || '';
    document.getElementById('mobileWebMachine').hidden = !status.basePath;
    document.getElementById('mobileWebMachineName').value = status.basePath ? `${status.label || ''} · ${status.basePath}` : '';
    document.getElementById('mobileWebGateway').hidden = !status.gatewayPassword;
    document.getElementById('mobileWebGatewayUser').value = status.gatewayUser || '';
    document.getElementById('mobileWebGatewayPassword').value = status.gatewayPassword || '';
    document.getElementById('mobileWebDevices').textContent = `已记住 ${status.deviceCount || 0} 台设备；吊销后所有设备需重新登录。`;
    document.getElementById('mobileWebToken').value = status.token || '';
    document.getElementById('mobileWebStatus').textContent = status.error || status.startupError || (status.enabled ? '已开启，仅监听 127.0.0.1' : '未开启');
  } catch (error) { document.getElementById('mobileWebStatus').textContent = error.message; }
  finally { toggle.disabled = false; }
}
document.getElementById('mobileWebEnabled').addEventListener('change', (event) => updateMobileWebSettings({ enabled: event.target.checked }));
document.getElementById('mobileWebSaveOrigin').addEventListener('click', () => updateMobileWebSettings({ publicOrigin: document.getElementById('mobileWebOrigin').value.trim() }));
document.getElementById('mobileWebRevoke').addEventListener('click', () => {
  if (confirm('吊销所有设备并更换登录 token？已登录的手机需要重新登录，旧 token 将立即失效。')) updateMobileWebSettings({ revoke: true });
});
document.getElementById('mobileWebCopyToken').addEventListener('click', (event) => {
  window.deck.clipboardWrite(document.getElementById('mobileWebToken').value);
  const button = event.currentTarget, original = button.innerHTML;
  button.innerHTML = ICONS.check; button.title = '已复制'; button.setAttribute('aria-label', '已复制');
  setTimeout(() => { button.innerHTML = original; button.title = '复制登录 token'; button.setAttribute('aria-label', '复制登录 token'); }, 1400);
});
document.getElementById('mobileWebCopyGateway').addEventListener('click', (event) => {
  window.deck.clipboardWrite(document.getElementById('mobileWebGatewayPassword').value);
  const button = event.currentTarget, original = button.innerHTML;
  button.innerHTML = ICONS.check; button.title = '已复制'; button.setAttribute('aria-label', '已复制');
  setTimeout(() => { button.innerHTML = original; button.title = '复制入口口令'; button.setAttribute('aria-label', '复制入口口令'); }, 1400);
});
async function updateAutomationSettings(input) {
  const toggle = document.getElementById('automationEnabled');
  toggle.disabled = true;
  try {
    const status = await window.deck.automationSettings(input);
    toggle.checked = status.enabled;
    const last = status.lastUsedAt ? `最近一次：${new Date(status.lastUsedAt).toLocaleString()}，${status.lastSource}（应用启动以来共 ${status.uses} 次）` : '应用启动以来还没有脚本用过';
    document.getElementById('automationStatus').textContent = `${status.enabled ? '已开启，仅本机' : '已停用，脚本发来的自动回执都会被拒绝'}；${last}`;
  } catch (error) { document.getElementById('automationStatus').textContent = error.message; }
  finally { toggle.disabled = false; }
}
document.getElementById('automationEnabled').addEventListener('change', (event) => updateAutomationSettings({ enabled: event.target.checked }));
document.getElementById('automationReset').addEventListener('click', () => {
  if (confirm('重置自动回执令牌？旧令牌立即失效；定时脚本每次运行都会读取新令牌，不用改脚本。')) updateAutomationSettings({ reset: true });
});
async function updateBarkPolicyStatus() {
  const node = document.getElementById('barkPolicyStatus');
  try {
    const status = await window.deck.barkStatus();
    const calendar = status.calendar || {};
    const calendarText = calendar.state === 'disabled' ? '已关闭' : calendar.available ?
      `已缓存（更新于 ${new Date(calendar.fetchedAt).toLocaleString()}）` : calendar.fallback ? '不可用，使用每周固定上课时段' : '不可用，未设置固定上课时段，上课时手机可能响';
    node.textContent = `暂存手机提醒：${status.queuedCount || 0} 条。课程日历：${calendarText}。${status.lastError ? `${status.queuedCount ? '发送失败待重试：' : ''}${status.lastError.replace(/。$/, '')}${status.retryAt ? `（${new Date(status.retryAt).toLocaleTimeString()}后重试）` : ''}。` : ''}`;
  } catch (_) { node.textContent = '课程日历状态暂不可用。'; }
}
function saveNotificationSettings() {
  const weeklyInput = document.getElementById('barkWeeklyClasses');
  let weeklyClasses = [], weeklyValid = true;
  for (const line of weeklyInput.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const match = /^周([日一二三四五六])\s+((?:[01]\d|2[0-3]):[0-5]\d)\s*[-–]\s*((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(line);
    if (!match || match[2] >= match[3]) { weeklyValid = false; break; }
    weeklyClasses.push({ day: '日一二三四五六'.indexOf(match[1]), start: match[2], end: match[3] });
  }
  // A mistyped line keeps the last saved periods; every other setting is still saved and the window can close.
  weeklyInput.setCustomValidity(weeklyValid ? '' : '每行请填写「周二 10:30-12:20」，结束时间要晚于开始时间。');
  if (!weeklyValid) { weeklyClasses = BarkPolicy.settings(config.barkNotifications).weeklyClasses; weeklyInput.reportValidity(); }
  config.captainNotifications = NotificationPolicy.normalizeSettings({
    enabled: document.getElementById('captainNotifyEnabled').checked,
    sound: document.getElementById('captainSoundEnabled').checked,
    tone: document.getElementById('captainSoundTone').value,
  });
  config.barkKeyFile = document.getElementById('barkKeyFile').value.trim();
  config.barkNotifications = BarkPolicy.settings({ ...config.barkNotifications,
    criticalVolume: document.getElementById('barkCriticalVolume').valueAsNumber,
    sleepEnabled: document.getElementById('barkSleepEnabled').checked,
    sleepStart: document.getElementById('barkSleepStart').value,
    sleepEnd: document.getElementById('barkSleepEnd').value,
    classesEnabled: document.getElementById('barkClassesEnabled').checked,
    classCalendarIds: document.getElementById('barkClassCalendarIds').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    classFilters: document.getElementById('barkClassFilters').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    weeklyClasses,
  });
  saveConfig();
  updateBarkPolicyStatus();
  return weeklyValid;
}
function buildChrome() {
  const head = document.getElementById('navHead');
  const tbLeft = document.getElementById('tbLeft');
  const tbSplit = document.getElementById('tbSplit');
  const tbRight = document.getElementById('tbRight');
  const bottom = document.getElementById('navBottom');
  [head, tbLeft, tbSplit, tbRight, bottom].forEach((n) => { n.innerHTML = ''; });

  const collapseBtn = railBtn(ICONS.panelLeft, '收起侧边栏', () => setNavCollapsed(true));
  collapseBtn.id = 'navCollapseBtn';
  collapseBtn.setAttribute('aria-label', collapseBtn.title);

  // Shown only while the sidebar is collapsed.
  const expandBtn = railBtn(ICONS.panelLeft, '展开侧边栏', () => setNavCollapsed(false));
  expandBtn.id = 'navExpandBtn';
  const boardBtn = railBtn(ICONS.board, '终端架构图 (Cmd+Shift+B)', () => showView(activeView === 'board' ? 'terminals' : 'board'));
  boardBtn.id = 'boardViewBtn';
  expandBtn.setAttribute('aria-label', expandBtn.title);
  boardBtn.setAttribute('aria-label', boardBtn.title);
  // The sidebar holds the quota rows; while it is collapsed this icon opens them.
  const quotaBtn = railBtn(ICONS.gauge, '订阅额度', () => toggleQuotaPop());
  quotaBtn.id = 'quotaRailBtn';
  quotaBtn.setAttribute('aria-label', quotaBtn.title);
  quotaBtn.setAttribute('aria-haspopup', 'dialog');
  quotaBtn.setAttribute('aria-expanded', 'false');
  const newChatBtn = railBtn(ICONS.newChat, '新对话 (Cmd+N)', () => addAndFocusColumn());
  newChatBtn.setAttribute('aria-label', newChatBtn.title);
  // Battery mode indicator for the collapsed sidebar; hidden unless battery mode is active.
  const batteryBtn = railBtn(ICONS.battery, '电池模式', () => openBatterySettings());
  batteryBtn.id = 'batteryRailBtn';
  batteryBtn.className = 'rail-btn battery-indicator battery-rail';
  batteryBtn.hidden = true;
  batteryBtn.setAttribute('aria-label', '电池模式已启用，点击调整');
  tbLeft.append(boardBtn, collapseBtn, expandBtn, quotaBtn, batteryBtn, newChatBtn);

  // Column widths: free (each column keeps its own width, drag the edges) or
  // N equal columns filling the deck; more than N keep that width and scroll.
  const free = document.createElement('button');
  free.type = 'button'; free.className = 'split-btn'; free.dataset.cols = '0';
  free.innerHTML = ICONS.freeLayout; free.title = '自由宽度：每列保持自己的宽度，拖列边调整';
  free.setAttribute('aria-label', '自由宽度');
  free.onclick = () => { config.fitWindow = false; applyFit(); };
  tbSplit.appendChild(free);
  FIT_COLS_CHOICES.forEach((n) => {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'split-btn'; item.dataset.cols = String(n);
    item.textContent = String(n); item.title = n + ' 列均分屏幕';
    item.setAttribute('aria-label', item.title);
    item.onclick = () => { config.fitCols = n; config.fitWindow = true; applyFit(); };
    tbSplit.appendChild(item);
  });
  // When the top bar runs out of room only the active choice stays, plus this menu.
  const splitMenu = document.createElement('button');
  splitMenu.type = 'button'; splitMenu.id = 'tbSplitMenu'; splitMenu.className = 'split-btn';
  splitMenu.innerHTML = ICONS.chevDown; splitMenu.title = '列宽：自由或均分';
  splitMenu.setAttribute('aria-label', splitMenu.title); splitMenu.setAttribute('aria-haspopup', 'menu');
  splitMenu.onclick = () => Sidebar.openMenu(splitMenu, [
    { label: '自由宽度', checked: !config.fitWindow, run: () => { config.fitWindow = false; applyFit(); } },
    ...FIT_COLS_CHOICES.map((n) => ({ label: n + ' 列均分', checked: config.fitWindow && fitCols() === n, run: () => { config.fitCols = n; config.fitWindow = true; applyFit(); } })),
  ]);
  tbSplit.appendChild(splitMenu);
  const globalViewBtn = railBtn('', '', () => ChatUI.toggleGlobalMode());
  globalViewBtn.id = 'globalViewToggle';
  tbSplit.after(globalViewBtn);
  applyFit();

  const sideBtn = railBtn(ICONS.panelRight, '右侧栏：预览 / 终端 / 浏览器 (Cmd+\\)', () => SidePane.toggle());
  sideBtn.id = 'sideToggleBtn';
  sideBtn.setAttribute('aria-label', sideBtn.title);
  tbRight.append(sideBtn);

  // The version opens 版本更新: what each version changed and what comes next.
  const brand = document.createElement('button');
  brand.type = 'button';
  brand.id = 'releaseNotesBtn';
  brand.className = 'nav-brand';
  brand.textContent = `V${env.version}`;
  const versionDetails = [`AgentDeck v${env.version}`, env.build].filter(Boolean).join(' · ');
  brand.title = `版本更新：每版改了什么、接下来做什么（${versionDetails}）`;
  brand.setAttribute('aria-label', `版本更新，你在用 AgentDeck ${env.version}`);
  brand.setAttribute('aria-haspopup', 'dialog');
  brand.setAttribute('aria-expanded', 'false');
  brand.classList.toggle('unseen', config.releaseNotesSeen !== env.version);
  brand.onclick = () => {
    if (config.releaseNotesSeen !== env.version) { config.releaseNotesSeen = env.version; brand.classList.remove('unseen'); fitNavBottom(); saveConfig(); }
    ReleaseNotesUI.toggle();
  };
  const themeBtn = railBtn(ICONS.moon, '切换主题', () => applyTheme(config.theme === 'dark' ? 'light' : 'dark'));
  themeBtn.id = 'themeBtn';
  const settingsBtn = railBtn(ICONS.gear, '设置', openNotificationSettings);
  settingsBtn.id = 'settingsBtn'; settingsBtn.setAttribute('aria-label', '设置');
  const broadcastBtn = railBtn(ICONS.send, '广播：同一条输入发给所有对话 (Cmd+B)', () => toggleBroadcast());
  broadcastBtn.id = 'broadcastBtn';
  const hermesBtn = railBtn(ICONS.globe, '打开 Hermes 网页总台（系统浏览器）', () => window.deck.openExternal(SidebarCore.HERMES_HUB_URL));
  hermesBtn.id = 'hermesHubBtn';
  bottom.append(brand, broadcastBtn, hermesBtn, settingsBtn, themeBtn,
    railBtn(ICONS.help, '快捷键与使用提示 (Cmd+/)', () => toggleHelp()),
    railBtn(ICONS.reset, '恢复默认布局', () => {
      if (!confirm('恢复默认布局？现有对话的终端会关闭，对话记录会删掉。已归档的不受影响。')) return;
      columns.forEach((c) => {
        cancelManagedRequests(c, 'Layout reset by the user.');
        window.deck.ptyKill(c.id);
        ChatUI.onColumnRemoved(c.id);
      });
      columns = defaultColumns();
      config.links = [];
      config.boardPositions = {};
      const w = defaultColWidth(); columns.forEach((c) => { c.width = w; }); // equal slices
      saveConfig(); render(true);
    }));
  // Every icon-only button in the sidebar footer gets the tooltip as its accessible name.
  bottom.querySelectorAll('.rail-btn').forEach((b) => { if (!b.hasAttribute('aria-label')) b.setAttribute('aria-label', b.title); });
}
// Compact the layout switch only while the full one would not fit.
function fitTopBar() {
  const bar = document.getElementById('topBar');
  bar.classList.remove('tb-compact');
  if (bar.scrollWidth > bar.clientWidth) bar.classList.add('tb-compact');
}
new ResizeObserver(() => { fitTopBar(); positionQuotaDetails(); }).observe(document.getElementById('topBar'));
// The version takes its own row above the footer icons while both do not fit on one.
function fitNavBottom() {
  const bottom = document.getElementById('navBottom'), brand = document.getElementById('releaseNotesBtn');
  if (!brand || !bottom.clientWidth) return;
  bottom.classList.remove('nb-stack');
  if (brand.scrollWidth > brand.clientWidth || bottom.scrollWidth > bottom.clientWidth) bottom.classList.add('nb-stack');
}
new ResizeObserver(fitNavBottom).observe(document.getElementById('navBottom'));
function positionQuotaPop() {
  const pop = document.getElementById('quotaPop');
  const r = document.getElementById('quotaRailBtn').getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)) + 'px';
}
// Keep one full detail beside the quota panel, including while the window resizes.
function positionQuotaDetails() {
  const pop = document.getElementById('quotaPop');
  if (!pop.hidden) positionQuotaPop();
  const items = [...document.querySelectorAll('#quotaBar .quota-item, #quotaPop .quota-item')];
  const visible = items.filter((item) => item.offsetParent);
  const focused = visible.find((item) => item.contains(document.activeElement)), hovered = visible.find((item) => item.matches(':hover'));
  const held = visible.find((item) => item.classList.contains('tip-hold'));
  // Keyboard focus keeps its detail; the mouse can still look at other rows past a clicked (pinned) one.
  const active = (focused?.matches(':focus-visible, :has(:focus-visible)') && focused) || held || hovered || focused;
  items.forEach((item) => item.classList.toggle('quota-detail-open', item === active));
  if (!active) return;
  const tip = active.querySelector('.quota-tooltip');
  const panel = active.closest('#quotaPop') || document.getElementById('colNav');
  const r = active.getBoundingClientRect();
  const left = panel.getBoundingClientRect().right + 10;
  const width = Math.min(420, window.innerWidth - left - 8);
  tip.classList.toggle('quota-tooltip-compact', width < 340);
  tip.style.maxWidth = width + 'px';
  tip.style.left = (left - r.left) + 'px';
  const height = tip.getBoundingClientRect().height;
  const top = panel === pop ? r.top : r.bottom - height;
  tip.style.top = (Math.max(8, Math.min(top, window.innerHeight - height - 8)) - r.top) + 'px';
  // The row's hover bridge (.quota-detail-open::after) fills the strip up to the detail, at the detail's height.
  active.style.setProperty('--tip-gap', (left - r.right) + 'px');
  active.style.setProperty('--tip-top', tip.style.top);
  active.style.setProperty('--tip-height', height + 'px');
}
window.addEventListener('resize', positionQuotaDetails);
function toggleQuotaPop(open) {
  const pop = document.getElementById('quotaPop');
  const btn = document.getElementById('quotaRailBtn');
  const show = open ?? pop.hidden;
  pop.hidden = !show;
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-expanded', String(show));
  positionQuotaDetails();
}
document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('quotaPop');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#quotaRailBtn')) toggleQuotaPop(false);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.getElementById('quotaPop').hidden) return;
  e.preventDefault(); e.stopPropagation();
  toggleQuotaPop(false); document.getElementById('quotaRailBtn').focus();
}, true);
function applyFit() {
  document.querySelectorAll('#tbSplit .split-btn').forEach((b) => {
    const n = Number(b.dataset.cols);
    b.classList.toggle('active', config.fitWindow ? n === fitCols() : n === 0);
  });
  saveConfig(); updateColumnStyles(); fitAll();
}
function syncChromeState() {
  const viewBtn = document.getElementById('globalViewToggle');
  if (viewBtn) {
    const terminal = config.globalViewMode === 'term';
    viewBtn.innerHTML = terminal ? ICONS.chat : ICONS.terminal;
    viewBtn.title = terminal ? '全部切到对话' : '全部切到终端';
    viewBtn.setAttribute('aria-label', viewBtn.title);
    viewBtn.setAttribute('aria-pressed', String(terminal));
  }
  const side = document.getElementById('sideToggleBtn');
  if (side) side.classList.toggle('on', SidePane.isOpen() && activeView !== 'board');
  const board = document.getElementById('boardViewBtn');
  if (board) board.classList.toggle('on', activeView === 'board' && !TaskBoardUI.isOpen());
  const tasks = document.getElementById('taskBoardBtn');
  if (tasks) {
    tasks.classList.toggle('on', TaskBoardUI.isOpen());
    tasks.setAttribute('aria-pressed', String(TaskBoardUI.isOpen()));
  }
}

// ---- Left panel width + collapse ----
function applyNavWidth() {
  // A wide sidebar never squeezes the deck below the room its top bar needs.
  const w = config.navCollapsed ? 0 : Math.max(NAV_MIN_W, Math.min(config.navWidth || NAV_DEFAULT_W, window.innerWidth - CENTER_MIN_W));
  colNavEl.style.flex = '0 0 ' + w + 'px';
  colNavEl.style.width = w + 'px';
}
function setNavCollapsed(v) {
  config.navCollapsed = v;
  colNavEl.classList.toggle('collapsed', v);
  document.body.classList.toggle('nav-collapsed', v);
  if (!v) toggleQuotaPop(false);
  applyNavWidth();
  saveConfig();
  fitAll(); // deck width changed
  requestAnimationFrame(() => SidePane.syncBounds());
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
      const w = Math.max(NAV_MIN_W, Math.min(NAV_MAX_W, rawW, window.innerWidth - CENTER_MIN_W));
      colNavEl.style.flex = '0 0 ' + w + 'px';
      colNavEl.style.width = w + 'px';
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Dragged well past the minimum → hide the sidebar (same as the collapse
      // button). navWidth keeps its pre-drag value for re-expanding.
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
  TaskBoardUI.close();
  activeView = view === 'board' ? 'board' : 'terminals';
  if (activeView === 'board' && focusedId) ChatUI.setMode(focusedId, 'term');
  config.activeView = activeView;
  SidePane.onViewChange();
  deckEl.hidden = activeView === 'board';
  boardViewEl.hidden = activeView !== 'board';
  syncChromeState();
  if (activeView === 'board') {
    Pages.hide();
    closeSearch();
    closeBroadcast();
    renderBoardGraph();
    CrewMap.render();
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
  if (activeView === 'board' && boardCanvasMode() && columns.length) {
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
    const live = entry && entry.lastScreen ? lastActivityLine(entry.lastScreen) : '';
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
    ChatUI.noteSent(col, col.taskTitle || col.taskPrompt);
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
    const ready = entry && entry.alive && (!col.cmd || terminalIdle(col, entry));
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

function render(isFresh = false) {
  SidePane.restoreTerminal();
  ChatUI.onRender();
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
  columns.forEach((col) => deckEl.appendChild(buildColumn(col, isFresh)));
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
  const all = [...deckEl.querySelectorAll('.column')];
  const byId = new Map(columns.map((c) => [c.id, c]));
  // backstage columns keep one equal slice of width, so their PTY stays a
  // normal size for when they are opened
  const slice = Math.max(MIN_WIDTH, Math.floor((deckEl.clientWidth || DEFAULT_WIDTH * fitCols()) / fitCols()));
  const colEls = all.filter((wrap) => {
    const back = isBackstage(byId.get(wrap.dataset.colId));
    wrap.classList.toggle('backstage', back);
    if (back) { wrap.style.flex = '0 0 auto'; wrap.style.width = slice + 'px'; }
    return !back;
  });
  const n = colEls.length;

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
  colEls.forEach((wrap) => {
    const col = byId.get(wrap.dataset.colId); if (!col) return;
    wrap.style.flex = '0 0 auto';
    wrap.style.width = col.width + 'px';
  });
  // Use 'scroll' (not 'auto') whenever content overflows so the bar stays put
  // and never flickers away while paging between columns.
  deckEl.style.overflowX = deckEl.scrollWidth > deckEl.clientWidth ? 'scroll' : 'auto';
}

// Equal-split widths depend on the deck's width, which changes with the
// sidebar and the right pane, not only with the window.
let lastDeckWidth = 0;
new ResizeObserver(() => {
  const w = deckEl.clientWidth;
  if (!w || w === lastDeckWidth) return;
  lastDeckWidth = w;
  if (config.fitWindow) updateColumnStyles();
}).observe(deckEl);

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
  const badgeEl = document.createElement('span');
  badgeEl.className = 'agent-badge col-badge';
  badgeEl.hidden = true;
  if (window.AgentInfo) {
    const info = window.AgentInfo.resolveAgentInfo(col, null, null);
    window.AgentInfo.renderBadge(badgeEl, info, 'header');
  }
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
  if (col.isMain) {
    wrap.classList.add('is-main');
    title.title = '队长：把活派给各个对话，再把回执带回来';
  }
  secondary.append(
    col.isMain
      ? mkBtn(ICONS.eraser, '清空上下文（只清队长的模型上下文；已派的活、回执和之前的对话都保留）', () => MainSession.clearContext())
      : mkBtn(ICONS.archive, '归档（结束终端，对话保留，可恢复）', () => archiveColumn(col)),
    mkBtn(ICONS.edit, '编辑（标题、目录、启动命令）', () => openDialog(columns.indexOf(col))),
    mkBtn(ICONS.close, '关闭并删除', () => removeCol(col)),
  );
  head.append(badgeEl, grip, dot, title, timerEl, secondary);
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
  ChatUI.mountColumn(col, wrap, head, termEl);

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
      fontSize: config.fontSize, lineHeight: 1.0, cursorBlink: !battery.active(), scrollback: 12000,
      theme: TERM_THEME[config.theme], allowProposedApi: true,
      // Option+click is our "open in editor" gesture on links; don't let xterm
      // also interpret it as click-to-move-cursor (sends arrow keys to the TUI).
      altClickMovesCursor: false, scrollOnUserInput: false,
    });
    const fit = new FitAddonNS.FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddonNS.SearchAddon();
    term.loadAddon(search);
    // FitAddon measures its immediate parent's height, without subtracting
    // that parent's padding. Give it the actual content box inside .term.
    const termContent = document.createElement('div');
    termContent.className = 'term-content';
    termEl.appendChild(termContent);
    term.open(termContent);
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
      term, fit, search, el: termEl, wrap, titleEl: title, badgeEl, dot, timerEl, alive: true, state: 'plain', disposers, webExecutorReady: col.executor === 'chatgpt-web' ? false : undefined,
      // Status-machine memory: hasWorked separates green "just finished" from
      // gray "idle since launch"; idleTicks debounces working→done (~3s);
      // workStart/workedMs drive the header timer; lastDump skips redundant IPC.
      hasWorked: false, idleTicks: 0, workStart: 0, workedMs: 0, doneAt: 0, lastDump: '', pendingPtyData: [],
    });

    const newOutput = document.createElement('button');
    newOutput.className = 'new-content terminal-new-content';
    newOutput.type = 'button';
    newOutput.textContent = '有新内容 ↓';
    newOutput.hidden = true;
    termEl.appendChild(newOutput);
    newOutput.addEventListener('click', () => { term.scrollToBottom(); newOutput.hidden = true; });
    term.onScroll(() => {
      if (term.buffer.active.viewportY >= term.buffer.active.baseY) newOutput.hidden = true;
    });
    term.onWriteParsed(() => {
      if (term.buffer.active.viewportY < term.buffer.active.baseY) newOutput.hidden = false;
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
    const finishReplay = (sequence = 0) => {
      const entry = terms.get(col.id);
      if (!entry || entry.term !== term) return;
      const pending = entry.pendingPtyData;
      entry.pendingPtyData = null;
      replayMuted = false;
      // Output already in the snapshot must not be painted twice. Later
      // redraws are applied only after the old replay has finished parsing.
      for (const chunk of pending) if (!chunk.sequence || chunk.sequence > sequence)
        writePtyData(col.id, entry, chunk.data, chunk.at);
    };
    const reconnect = async () => {
      const alive = await window.deck.ptyIsAlive(col.id);
      if (alive) {
        // Hot-reload path: pty survived, replay its buffered output and resize.
        const snapshot = await window.deck.ptyReplay(col.id, true);
        const replay = snapshot.data;
        if (replay) {
          replayMuted = true;
          term.write(replay, () => {
            updateAgentIdentityBadge(col.id, terms.get(col.id), dumpScreen(term));
            finishReplay(snapshot.sequence);
          });
        } else finishReplay(snapshot.sequence);
        window.deck.ptyResize(col.id, term.cols, term.rows);
        if (col.executor === 'chatgpt-web') terms.get(col.id).webExecutorReady = true;
        MainSession.notePtySurvived(col);
      } else {
        // Fresh spawn. If the previous app run left a saved session for this
        // column, replay it first so the agent's history survives a restart.
        const saved = await window.deck.ptySaved(col.id);
        const choice = MainSession.restartLaunch(col, isFresh);
        if (choice.mode === 'resume' || choice.mode === 'resend') col.restartMode = choice.mode;
        if (choice.mode === 'resend') col.sessionWatchSince = Date.now();
        else if (!col.sessionWatchSince) col.sessionWatchSince = Date.now();
        const provider = window.RestartResume.providerOf(col.cmd);
        const ownsCapturedId = col.modelSessionOwner === col.id && col.modelSessionCwd === (col.cwd || '') &&
          !config.columns.some((other) => other.id !== col.id && window.RestartResume.providerOf(other.cmd) === provider &&
            String(other.modelSessionId || '').toLowerCase() === String(col.modelSessionId || '').toLowerCase());
        const capturedId = !['Codex', 'Cursor', 'Antigravity'].includes(provider) || ownsCapturedId ? col.modelSessionId : null;
        const plan = choice.mode === 'resume'
          ? { launch: choice.launch, sessionId: choice.sessionId, resumedAgent: true, showLegacyWarning: false }
          : choice.mode === 'resend'
            ? { ...window.AgentInfo.planAgentLaunch(choice.launch, null, true, false, () => window.crypto.randomUUID()), resumedAgent: false, showLegacyWarning: true }
            : window.AgentInfo.planAgentLaunch(col.executor === 'chatgpt-web' ? '' : col.cmd || '', capturedId, isFresh, MainSession.skipsResume(col), () => window.crypto.randomUUID());
        const { launch, resumedAgent, showLegacyWarning } = plan;
        if (col.modelSessionId !== plan.sessionId) {
          if (plan.sessionId) {
            col.modelSessionId = plan.sessionId;
            if (!resumedAgent) { col.modelSessionOwner = col.id; col.modelSessionCwd = col.cwd || ''; delete col.modelSessionSource; }
          } else { delete col.modelSessionId; delete col.modelSessionOwner; delete col.modelSessionCwd; delete col.modelSessionSource; }
          saveConfig();
        }

        if (saved) {
          replayMuted = true;
          term.write(saved, () => {
            // Inspect the restored TUI while its alternate screen and footer
            // are still intact; leaving it first can discard Codex's footer.
            updateAgentIdentityBadge(col.id, terms.get(col.id), dumpScreen(term));
            // The replay may end mid-TUI: leave alternate screen, re-show the
            // cursor, drop mouse/bracketed-paste modes, reset colors — then a
            // dim separator before the fresh shell starts below.
            term.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m');
            // Writes are parsed in order: this callback marks the end of replay.
            const replayMsg = resumedAgent
              ? '\r\n\x1b[2m── 上次输出回放，进程已结束（模型上下文将通过 CLI 恢复）──\x1b[0m\r\n'
              : showLegacyWarning
                ? '\r\n\x1b[33m── 上次输出回放；此栏未绑定模型会话，本次将新开对话 ──\x1b[0m\r\n'
                : '\r\n\x1b[2m── 上次输出回放，进程已结束──\x1b[0m\r\n';
            term.write(replayMsg, () => finishReplay());
          });
        } else finishReplay();
        // 队长 gets a control token too; the columns it drives never do, except a 小队长
        // (new --sub-captain), whose token MainSession accepts only for its own children.
        const boundSeat = col.executor === 'chatgpt-web' ? {} : ClaudeSeatsCore.bindColumn(col, config);
        flushConfig();

        window.deck.ptySpawn(col.id, col.cwd || env.home, term.cols, term.rows, col.role !== 'manual' || !!col.isMain || col.subCaptain === true, boundSeat.id, boundSeat.configDir, !!col.captainCrew && !col.isMain);
        if (col.executor === 'chatgpt-web') terms.get(col.id).webExecutorReady = true;

        if (launch && col.executor !== 'chatgpt-web') {
          // Capture the id: if the user edits the column within 700ms,
          // respawnColumn assigns a NEW id and this stale timer must not fire
          // into the fresh pty (whose own timer will run the command).
          const spawnId = col.id;
          terms.get(spawnId).launchPending = true;
          const start = async () => {
            const entry = terms.get(spawnId);
            if (!entry || !entry.alive || col.id !== spawnId) return;
            if (env.platform === 'win32' && !MainCore.isWindowsShellPrompt(entry.lastScreen)) { setTimeout(start, 250); return; }
            // Claude starts only on the seat this column is bound to. A seat that is gone or
            // signed out starts nothing, and no other seat stands in for it.
            const blocked = ClaudeSeatsCore.claudeLaunch(col.cmd) && ClaudeSeatsCore.launchBlock(col, config, await window.deck.claudeSeats().catch(() => []));
            if (col.id !== spawnId || terms.get(spawnId) !== entry || !entry.alive) return;
            if (blocked) {
              entry.seatBlock = blocked;
              entry.launchPending = false;
              entry.term.write(`\r\n\x1b[33m[AgentDeck] ${blocked}，没有启动 Claude，也不会换到别的席位。登录这个席位后（设置 → 席位设置里有复制登录命令的图标），归档再恢复这一列就能接着原对话。\x1b[0m\r\n`);
              MainSession.launchBlocked(col, `${blocked}：会话没有启动，任务没有送达，也没有换到别的席位。请用户先登录这个席位（席位设置里有复制登录命令的图标），再归档、用 tell 恢复它；急的话用 new --task-id … --seat 另一个已登录席位 改派。`);
              return;
            }
            const prepared = await window.deck.prepareLaunch(spawnId, launch).catch(() => null);
            if (col.id !== spawnId || terms.get(spawnId) !== entry || !entry.alive) return;
            if (env.platform === 'win32' && !MainCore.isWindowsShellPrompt(entry.lastScreen)) { setTimeout(start, 250); return; }
            if (prepared !== null) window.deck.ptyInput(spawnId, BoardCore.reportAgentExit(seatLaunchCommand(col, prepared), env.platform) + '\r');
            entry.launchedAt = Date.now();
            entry.launchedSlept = window.SleepResume?.clock.sleptMs() || 0;
            entry.launchPending = false;
          };
          setTimeout(start, 700);
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
        MainSession.noteColdColumn(col, isFresh, resumedAgent);
      }
    };
    reconnect();
    const trackPrompt = makePromptTracker(col);
    const forwardInput = (d) => {
      if (!replayMuted) {
        window.deck.ptyInput(col.id, d); trackPrompt(d);
        // Includes agents launched manually in a blank terminal. Auto-replies
        // contain escape sequences and must never count as a submitted turn.
        if (d === '\r') {
          const entry = terms.get(col.id);
          if (entry) {
            entry.hasWorked = true;
            entry.idleTicks = 0;   // a new turn: the done debounce starts over (see ChatUI.sendPrompt)
            entry.lastOutputAt = Date.now();
            window.deck.notifyCancel({ id: col.id });
          }
        }
      }
    };
    {
      const entry = terms.get(col.id);
      const held = [];
      entry.typing = trackPrompt.typing;
      entry.flushHeld = () => held.splice(0).forEach(forwardInput);
      // While AgentDeck types a receipt or a task into this box (up to 3 s
      // while the agent keeps drawing), your keys wait and follow right after its Enter. The wheel,
      // pointer moves and the terminal's own replies do not wait (ChatCore.passesInputHold).
      term.onData((d) => { if (entry.injecting && !ChatCore.passesInputHold(d)) held.push(d); else forwardInput(d); });
    }
    term.onResize(({ cols, rows }) => window.deck.ptyResize(col.id, cols, rows));
    if (deckEl.firstElementChild === wrap) { if (!ChatUI.focusInput(col.id)) term.focus(); focusedId = col.id; } // focus leftmost on boot

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
      if (focusedId !== col.id && !e.target.closest('.view-toggle')) ChatUI.setMode(col.id, 'term');
      if (!ChatUI.onColumnMouseDown(col, e)) { term.focus(); focusedId = col.id; syncNav(); }
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
    // A wide glyph that did not fit in the last column went on to the next row
    // and left that column blank: no space in the text ("经验 学习" in a path).
    let width = cols;
    const next = buf.getLine(r + 1);
    if (next && next.isWrapped) {
      const head = next.getCell(0), tail = line.getCell(cols - 1);
      if (head && head.getWidth() === 2 && tail && tail.getWidth() === 1 && !(tail.getChars() || ' ').trim()) width = cols - 1;
    }
    for (let x = 0; x < width; x++) {
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
  while (e > s && /[\s.,;:!?)\]}>'"]/.test(text[e - 1])) e--;
  return e;
}
// Characters no path in agent output goes past: Chinese and full-width
// punctuation (，。、；：（）「」…), full-width letters, curly quotes, "…" and "—".
const PATH_STOP = '\\u2014\\u2015\\u2018-\\u201f\\u2026\\u3000-\\u3004\\u3008-\\u303f\\uff01-\\uff60\\uffe0-\\uffe6';
const FILE_EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?$/;
const CJK_WORD = /^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+$/;
// Where an absolute path the pattern took really ends. The pattern lets single
// spaces through for folder names ("Application Support", "My Project"), so it
// also took the prose after a path: "…/renderer.js 里的 findLinks", or
// "…\a.json 和 C", whose "C:" then started no second link. A space stays in a
// folder name. In the last name it ends the path after a word with an extension
// ("README.md 最急的两件" ends at README.md) or before a Chinese word ("My Project
// 里面"); otherwise it stays ("截屏2026-10-09 下午3.04.12.png", a folder at the end
// such as "Application Support"), and English prose after it is settled on click
// by the main process, which opens the longest path that exists. A space after a sentence's own punctuation ("a.md, then")
// ends a path anywhere, and so does Chinese glued to an extension with no dot
// after it ("a.md里面写了"). `sep` is the separator: "/", or "/" and "\" on Windows.
function pathEnd(text, s, e, sep) {
  let p = text.slice(s, e), from = 0;
  for (let i = 0; i <= p.length; i++) {
    if (i < p.length && !sep.test(p[i])) continue;
    const seg = p.slice(from, i), words = seg.split(/(?<!\\) /);   // "\ " is an escaped space, part of the name
    let cut = -1;
    for (let w = 0, at = 0; w < words.length - 1 && cut < 0; w++) {
      at += words[w].length;
      if (/[.,;:!?]$/.test(words[w])) cut = at;
      at++;
    }
    if (cut < 0 && words.length > 1 && FILE_EXT.test(words[0])) cut = words[0].length;
    const cjk = cut < 0 && i === p.length ? words.findIndex((w, k) => k && CJK_WORD.test(w)) : -1;
    if (cjk > 0) cut = words.slice(0, cjk).join(' ').length;
    if (cut >= 0) { p = p.slice(0, from + cut); break; }
    from = i + 1;
  }
  let name = p.length;
  while (name > 0 && !sep.test(p[name - 1])) name--;
  const glued = /^(.*?\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.exec(p.slice(name));
  if (glued && !p.slice(name + glued[1].length).includes('.')) p = p.slice(0, name + glued[1].length);
  return trimTrail(text, s, s + p.length);
}
// The relative file references in one run of [\w.+@%:/-], i.e. the matches of
//   /(?:\.{1,2}\/)?(?:[\w.+@%-]+\/)+[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?
//    |[\w+@%-][\w.+@%-]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/g
// ("dir/…/name.ext[:line[:col]]" or "name.ext:line[:col]"), found in one pass.
// That pattern backtracked across the rest of the run from every position: a
// 20,000-character token with a dot in it (a JWT, a dotted version list) took
// seconds to half a minute.
function relativeLinks(run) {
  const n = run.length, out = [];
  const isDigit = (i) => { const c = run.charCodeAt(i); return c >= 48 && c <= 57; };   // NaN past the end
  const isAlnum = (i) => { const c = run.charCodeAt(i) | 32; return isDigit(i) || (c >= 97 && c <= 122); };
  const isW = (i) => isAlnum(i) || '_.+@%-'.includes(run[i] || ' ');   // [\w.+@%-]
  // From the right: wEnd, the end of the [\w.+@%-] stretch at i; aEnd, the end of
  // the letters and digits at i; dot, the stretch's last "." before a letter or
  // digit, at i or later; name, where the last usable "name.ext" starts among the
  // stretches reachable from i through "stretch/" steps (the regex's greedy
  // directory part settles on the last one).
  const wEnd = new Int32Array(n + 1), aEnd = new Int32Array(n + 1), dot = new Int32Array(n + 1).fill(-1), name = new Int32Array(n + 1).fill(-1);
  wEnd[n] = n; aEnd[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    aEnd[i] = isAlnum(i) ? aEnd[i + 1] : i;
    if (!isW(i)) { wEnd[i] = i; continue; }
    wEnd[i] = wEnd[i + 1];
    dot[i] = dot[i + 1] >= 0 ? dot[i + 1] : run[i] === '.' && isAlnum(i + 1) ? i : -1;
    const next = run[wEnd[i]] === '/' ? name[wEnd[i] + 1] : -1;
    name[i] = next >= 0 ? next : run[i] !== '.' && dot[i] >= 0 ? i : -1;
  }
  const lineSuffix = (p) => {   // (?::\d+(?::\d+)?)?
    if (run[p] !== ':' || !isDigit(p + 1)) return p;
    let e = p + 1;
    while (isDigit(e)) e++;
    if (run[e] === ':' && isDigit(e + 1)) { e++; while (isDigit(e)) e++; }
    return e;
  };
  for (let s = 0; s < n;) {
    let e = -1;
    const q = isW(s) && run[wEnd[s]] === '/' ? name[wEnd[s] + 1] : -1;
    // "dir/…/name.ext": up to 8 letters or digits after the dot, then an optional :line[:col]
    if (q >= 0) e = lineSuffix(dot[q] + 1 + Math.min(aEnd[dot[q] + 1] - dot[q] - 1, 8));
    // "name.ext:line": the extension is all of the stretch after its last dot
    else if (isW(s) && run[s] !== '.' && dot[s] >= 0 && aEnd[dot[s] + 1] === wEnd[s] && wEnd[s] - dot[s] - 1 <= 8 &&
      run[wEnd[s]] === ':' && isDigit(wEnd[s] + 1)) e = lineSuffix(wEnd[s]);
    if (e < 0) { s++; continue; }
    out.push({ index: s, text: run.slice(s, e) });
    s = e;
  }
  return out;
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
  // whitespace/quotes/angle-brackets/pipe or Chinese punctuation (PATH_STOP; this
  // includes "/" so multi-level paths just work); or a single space NOT followed
  // by another space or a slash (stops at double-spaces and at " /" so two paths
  // on one line don't merge). pathEnd then gives back the prose after the path,
  // and the search goes on from there: the rest of the line may hold the next one.
  // No path is longer than 1024 characters (macOS's PATH_MAX); the cap keeps a
  // long line of short paths with prose between them from being read to its end
  // once per path. What remains ambiguous is settled in the main process, which
  // resolves the longest path that actually exists on disk.
  const sep = env.platform === 'win32' ? /[\\/]/ : /\//;
  const fileRe = new RegExp('(?:file:\\/\\/)?(?:~\\/|\\/)(?:\\\\ |[^\\s"\'`<>|' + PATH_STOP + ']| (?![\\s/])){1,1024}', 'gu');
  while ((m = fileRe.exec(text))) {
    const raw = m[0], s = m.index;
    if (/^https?:/.test(raw) || raw.length < 4) continue;
    // the tail of something else: "src/lib/a.js" and "./x" are relative (relativeLinks
    // below), "C:/Users/…" is a Windows path (winRe), "x.com/a/b" a URL's
    if (s > 0 && /[\w.~/\\-]/.test(text[s - 1]) || /(?:^|[^A-Za-z])[A-Za-z]:$/.test(text.slice(Math.max(0, s - 3), s))) continue;
    const e = pathEnd(text, s, trimTrail(text, s, s + raw.length), sep);
    fileRe.lastIndex = Math.max(e, s + 1);
    const slashes = (text.slice(s, e).match(/\//g) || []).length;
    if (!raw.startsWith('~') && slashes < 2) continue; // noise guard for bare /a/b
    if (out.some((o) => s < o.end && e > o.start)) continue; // overlaps a URL
    out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
  }
  // Windows absolute paths: "C:\Users\jinhao\proj\file.js:12" or "C:/…". Only
  // matched on Windows so a stray "C:\" in prose can't hijack macOS output.
  if (env.platform === 'win32') {
    const winRe = new RegExp('\\b[A-Za-z]:[\\\\/](?:[^\\s"\'`<>|:*?' + PATH_STOP + ']| (?![\\s\\\\/])){1,1024}(?::\\d+(?::\\d+)?)?', 'gu');
    while ((m = winRe.exec(text))) {
      const s = m.index, e = pathEnd(text, s, trimTrail(text, s, s + m[0].length), sep);
      winRe.lastIndex = Math.max(e, s + 1);
      if (out.some((o) => s < o.end && e > o.start)) continue;
      out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
    }
  }
  // Relative references the agents print constantly: "src/renderer.js:406",
  // "main.js:128". To stay quiet on ordinary prose ("and/or", "Node.js"), a
  // candidate needs either a slash-path ending in a dotted filename, or a bare
  // filename with a :line suffix (relativeLinks has the exact rules). The main
  // process anchors these to the column's live shell cwd before resolving.
  // A match lies inside one run of the characters it can contain and holds a
  // ".ext": search each such run on its own and skip runs without one, or runs
  // a URL or absolute path already covers (every match there would overlap it).
  const runRe = /[\w.+@%:/-]+/g;
  let run;
  while ((run = runRe.exec(text))) {
    if (!/\.[A-Za-z0-9]/.test(run[0])) continue;
    if (out.some((o) => run.index >= o.start && run.index + run[0].length <= o.end)) continue;
    for (const rel of relativeLinks(run[0])) {
      const s = run.index + rel.index, e = trimTrail(text, s, s + rel.text.length);
      if (s > 0 && /[\w/~.\\-]/.test(text[s - 1])) continue; // mid-token or tail of an absolute path
      if (out.some((o) => s < o.end && e > o.start)) continue; // overlaps a URL or absolute path
      out.push({ start: s, end: e, text: text.slice(s, e), kind: 'file' });
    }
  }
  return out;
}
function openLink(m, event, colId, cont) {
  // Plain click previews in the right pane; Cmd/Ctrl click opens the system
  // browser or Finder, Option click the editor (see side-pane.js).
  SidePane.openLink(m, event, colId, cont);
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

// ---- Remove / archive / add ----
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
  const descendants = managedSubtree(col, false);
  const active = [col, ...descendants].some((candidate) => {
    const entry = terms.get(candidate.id);
    return entry && entry.alive && (entry.state === 'working' || entry.state === 'input');
  });
  if (active && !confirm('This terminal or one of its managed descendants is active. Close it and release descendants as independent terminals?')) return;
  if (descendants.length) {
    releaseManagedSubtree(col, false, `Parent task "${columnLabel(col)}" was removed.`);
  }
  cancelManagedRequests(col, `Task "${columnLabel(col)}" was removed.`);
  ChatUI.onColumnRemoved(col.id);
  if (col.isMain) config.mainSession = null;
  detachColumn(col, false);
  // A 小队长's children keep running and go back to the 队长.
  if (col.subCaptain) window.MainSession?.releaseSubCrew?.(col, '关掉');
  saveConfig();
  renderColNav();
  renderBoardGraph();
}
// Take a column off the deck: its terminal, pty and board relationships.
// keepReplay saves the terminal's output first (archive) so a restore replays it.
function detachColumn(col, keepReplay) {
  const t = terms.get(col.id);
  const idx = columns.indexOf(col);
  // Its place in the deck the user sees: 队长's background sessions are in `columns` but not there.
  const deckIdx = deckColumns().indexOf(col);
  if (selectedBoardId === col.id) {
    restoreBoardTerminal();
    selectedBoardId = null;
  }
  if (SidePane.holdsTerminalOf(col.id)) SidePane.restoreTerminal();
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); t.wrap.remove(); terms.delete(col.id);
  }
  window.deck.ptyKill(col.id, keepReplay);
  if (idx >= 0) columns.splice(idx, 1);
  config.links = (config.links || []).filter((link) => link.fromTaskId !== col.taskId && link.toTaskId !== col.taskId);
  delete config.boardPositions[col.taskId];
  if (zoomedId === col.id) { zoomedId = null; updateColumnStyles(); fitAll(); }
  // Don't leave focusedId pointing at the removed column: every focusedId-based
  // shortcut (Cmd+W, Cmd+arrows, search, broadcast) would silently no-op until
  // the user happens to click another column.
  if (focusedId === col.id) {
    focusedId = null;
    if (columns.length) focusColumnByIndex(deckIdx >= 0 ? deckIdx : Math.min(Math.max(idx, 0), columns.length - 1));
  }
  updateColumnStyles();
}

// Archive: the terminal stops, the conversation and last output are kept, and
// the session waits in the sidebar's 已归档 section until restored.
function archiveColumn(col, opts) {
  if (!columns.includes(col)) return;
  if (col.isMain) { showToast('队长不能归档；不想要了可以关掉它'); return; }
  const descendants = managedSubtree(col, false);
  const busy = [col, ...descendants].some((candidate) => {
    const entry = terms.get(candidate.id);
    if (!entry?.alive) return false;
    const live = classify(statusScreen(entry.term), entry, candidate.cmd);
    return ['working', 'quota', 'input'].includes(entry.state) || ['working', 'quota', 'input'].includes(live) ||
      entry.sendingPrompt || entry.injecting || userComposing(candidate.id) || ChatUI.hasDraft(candidate.id) ||
      ChatUI.turnsOf(candidate.id).some((turn) => turn.kind !== 'task' && !turn.done) ||
      Date.now() - (entry.lastOutputAt || 0) < 60_000;
  });
  // Archiving ends the terminal, so a session that is working or waiting on an
  // answer is protected from click/automatic archive; the Captain's explicit
  // archive command ends it without confirmation.
  if (busy && !(opts && opts.captain)) {
    if (!(opts && opts.quiet)) showToast(`「${columnLabel(col)}」还在干活，先不归档；做完再归档`);
    return;
  }
  if (descendants.length) releaseManagedSubtree(col, false, `Parent task "${columnLabel(col)}" was archived.`);
  cancelManagedRequests(col, `Task "${columnLabel(col)}" was archived.`);
  ChatUI.onColumnArchived(col.id);
  detachColumn(col, true);
  const snapshot = { ...col, role: 'manual', relationship: 'Independent manual terminal', archivedAt: Date.now() };
  config.archived = [snapshot, ...(config.archived || []).filter((a) => a.id !== col.id)];
  // A 小队长's children keep running and go back to the 队长.
  if (col.subCaptain) window.MainSession?.releaseSubCrew?.(col, '归档');
  saveConfig();
  if (!(opts && opts.worktreeHandled)) {
    try { window.MainSession?.settleArchivedWorktree?.(snapshot); } catch (_) {}
  }
  renderColNav();
  renderBoardGraph();
  if (!(opts && opts.quiet)) showToast(`已归档「${columnLabel(col)}」，在左侧「已归档」里可以恢复`);
}
// quiet: 队长 bringing back a background session; your view stays as it is.
function restoreArchived(id, focus, quiet) {
  const a = (config.archived || []).find((x) => x.id === id);
  if (!a) return null;
  config.archived = config.archived.filter((x) => x !== a);
  const { archivedAt, ...rest } = a;
  const col = BoardCore.normalizeColumn({ ...rest, role: 'manual', relationship: 'Independent manual terminal', view: 'term' });
  if (col.folderId && !config.folders.some((f) => f.id === col.folderId)) col.folderId = null;
  if (!quiet) {
    if (zoomedId) { zoomedId = null; updateColumnStyles(); }
    Pages.hide();
  }
  insertColumn(col, false); // not fresh: replays its saved output and resumes Claude
  if (!quiet) showToast(`已恢复「${columnLabel(col)}」`);
  if (focus) whenMounted(col, () => jumpToColumn(col));
  return col;
}
function deleteArchived(id) {
  config.archived = (config.archived || []).filter((x) => x.id !== id);
  ChatUI.deleteArchivedChat(id);
  saveConfig();
  renderColNav();
}
// Put a column into the deck at its sidebar position and build its terminal.
function insertColumn(col, isFresh) {
  columns.push(col);
  columns = SidebarCore.orderedColumns(columns, config.folders);
  const next = columns[columns.indexOf(col) + 1];
  const nextWrap = next && terms.get(next.id) && terms.get(next.id).wrap;
  deckEl.insertBefore(buildColumn(col, isFresh), nextWrap && nextWrap.parentElement === deckEl ? nextWrap : null);
  updateColumnStyles();
  saveConfig();
  renderColNav();
  renderBoardGraph();
}
// The terminal is created on the next frame; run fn once it exists.
function whenMounted(col, fn, tries = 0) {
  if (!columns.includes(col)) return;
  if (terms.has(col.id)) { fn(); return; }
  if (tries < 60) setTimeout(() => whenMounted(col, fn, tries + 1), 50);
}
// Reorder the live column nodes to match `columns` (no terminal reloads).
function reflowDeck() {
  columns.forEach((c) => { const w = terms.get(c.id) && terms.get(c.id).wrap; if (w) deckEl.appendChild(w); });
  updateColumnStyles();
}
function moveSession(id, target) {
  columns = SidebarCore.moveColumn(columns, config.folders, id, target);
  reflowDeck();
  saveConfig();
  renderColNav();
}
function removeFolder(folderId) {
  config.folders = SidebarCore.removeFolder(columns, config.folders, folderId);
  (config.archived || []).forEach((a) => { if (a.folderId === folderId) a.folderId = null; });
  columns = SidebarCore.orderedColumns(columns, config.folders);
  reflowDeck();
  saveConfig();
  renderColNav();
}
// Automatic sends must never land in a bare shell: it would run every line of
// the text as a command. They go out only while something other than the
// shell is in the column's foreground (an agent). Windows' ConPTY cannot tell
// us the foreground process, so there the agent's own screen must be visible.
// allowShell: the column is a plain shell on purpose (a Schedule target).
async function agentInForeground(col, allowShell) {
  if (allowShell && !col.cmd) return true;
  const entry = terms.get(col.id);
  if (entry?.launchPending) return false;
  if (env.platform === 'win32') {
    if (BoardCore.codexProgram(col.cmd, 'win32')) return !!entry && MainCore.windowsCodexReady(entry.lastScreen);
    return !!entry && AGENT_IDLE_RE.test(MainCore.windowsAgentOutput(entry.lastScreen));
  }
  try {
    return !MainCore.isShellProcess(await window.deck.ptyForeground(col.id));
  } catch (_) { return false; }
}

// Schedule and 队长: wait until the session can take a prompt (agent at its
// idle prompt, not busy or asking something), then send it like the composer
// does. opts are passed to ChatUI.sendPrompt, plus timeout/onSent/onGiveUp
// and allowShell (see agentInForeground). keepWaiting turns timeout into a
// one-time reminder; only an exited or removed terminal ends that queue.
function sendWhenReady(col, text, opts) {
  const o = opts || {};
  const started = Date.now();
  const startedSlept = window.SleepResume?.clock.sleptMs() || 0;
  const id = col.id;
  let reminded = false;
  const check = async () => {
    if (o.cancelled && o.cancelled()) return;
    if (!columns.includes(col) || col.id !== id) {
      if (o.keepWaiting) o.onGiveUp?.('这个会话已经关闭、归档或被替换');
      return;
    }
    const entry = terms.get(col.id);
    if (o.keepWaiting && entry && !entry.alive) {
      o.onGiveUp?.(entry.exitReason || '这个会话的终端已经退出');
      return;
    }
    // Its Claude never started (its seat is gone or signed out): there is nothing to type into.
    if (entry?.seatBlock) {
      if (o.onGiveUp) o.onGiveUp(entry.seatBlock);
      else showToast(`没发出去：「${columnLabel(col)}」${entry.seatBlock}`);
      return;
    }
    if (entry && entry.alive) {
      // overLoginError: MainSession's one 「接着做」 after a login blip on a signed-in seat. The error
      // row it answers would otherwise hold the column as a resource wait; any other wait still does.
      const loginRowOnly = !!o.overLoginError && MainCore.resourceKind(entry.lastScreen, col.cmd) === 'auth';
      const idle = !entry.sendingPrompt && entry.state !== 'input' && !MainCore.workingForSend(entry) &&
        (loginRowOnly || entry.state !== 'quota' && !MainCore.terminalActivity(entry.lastScreen, col.cmd));
      const quiet = Date.now() - (entry.lastOutputAt || 0);
      const isCursor = (window.BoardCore && window.BoardCore.inferAgentType(col.cmd) === 'Cursor') || /cursor-agent\b/i.test(col.cmd || '');
      // Cursor CLI initializes its TUI asynchronously and enables bracketed paste mode (?2004h)
      // once interactive. Never inject before bracketedPasteMode is enabled on the terminal,
      // and do not fall back to quiet inference for known Cursor CLI.
      const cursorReady = isCursor && terminalIdle(col, entry) && !!(entry.term && entry.term.modes && entry.term.modes.bracketedPasteMode);
      // unknown agents never show a recognizable idle footer: settle for quiet output (known Cursor waits for real readiness)
      // A finished turn (state done, or only a background shell still running) with a
      // prompt row is ready even when the row still shows Claude's suggestion and
      // cursor blink keeps lastOutputAt fresh.
      const ready = isCursor ? cursorReady : (!col.cmd || AGENT_IDLE_RE.test(entry.lastScreen || '') || ((entry.state === 'done' || entry.backgroundOnly) && MainCore.promptRowIdle(entry.lastScreen)) || (Date.now() - started > 15000 && quiet > 3000));
      // ConPTY can show a fresh TUI before its startup input has settled.
      // Typing immediately can lose the prompt's leading bytes before the CLI reads them.
      const settled = env.platform !== 'win32' || entry.hasWorked || quiet >= 500;
      // A launched command line that has drawn nothing (stuck on a system dialog, hung) is not
      // an agent, however quiet it is: the text would land in the tty's line buffer, cut at
      // 1000 bytes. Never type into it; a caller that can report it is told once the limit
      // for a silent start has passed (see MainCore.startupLimit).
      const silent = MainCore.launchEchoOnly(entry.lastScreen);
      // outputSince: what was sent before has to have reached the agent, shown by anything it
      // drew after that time; after a minute without that, send anyway.
      const caughtUp = !o.outputSince || (entry.lastOutputAt || 0) > o.outputSince || Date.now() - o.outputSince > 60_000;
      if (silent && o.onStartupFailed) {
        // Awake time only: a computer asleep through the first seconds of a start must not read as
        // a hang. This loop wakes up first after a sleep, so let the clock see the gap before reading it.
        const sleepClock = window.SleepResume?.clock;
        sleepClock?.beat();
        const sleptSince = entry.launchedAt ? (entry.launchedSlept ?? startedSlept) : startedSlept;
        const waited = Date.now() - (entry.launchedAt || started) - Math.max(0, (sleepClock?.sleptMs() || 0) - sleptSince);
        if (waited >=MainCore.startupLimit(col.cmd)) {
          o.onStartupFailed(MainCore.startupFailure({ screen: entry.lastScreen, cmd: col.cmd, waitedMs: waited }));
          return;
        }
      }
      if (!silent && idle && ready && settled && caughtUp && await agentInForeground(col, o.allowShell) && columns.includes(col) && col.id === id) {
        if (o.cancelled && o.cancelled()) return;
        // A draft blocks this attempt, but must not skip the timeout below.
        if (!(o.guardUserInput && userComposing(col.id))) {
          const sent = await ChatUI.sendPrompt(col, typeof text === 'function' ? text() : text, o.atts || null, o);   // a long prompt goes out as a file
          if (sent && o.onSent) o.onSent(sent === true ? null : sent);
          if (sent) return;
          if (o.onDeferred) o.onDeferred();
        }
      }
    }
    if (Date.now() - started > (o.timeout || 120_000)) {
      if (o.keepWaiting) {
        if (!reminded) {
          reminded = true;
          const nowEntry = terms.get(col.id);
          const reason = MainCore.tellWaitReason({
            entry: nowEntry, composing: !!(o.guardUserInput && userComposing(col.id)),
            screen: nowEntry?.lastScreen, cmd: col.cmd,
          }) || '会话还没准备好接收指令';
          o.onWaiting?.(reason);
        }
      } else {
        if (o.onGiveUp) o.onGiveUp();
        else showToast(`没发出去：「${columnLabel(col)}」一直没准备好`);
        return;
      }
    }
    setTimeout(check, 500);
  };
  check();
}
function addColumn(c) {
  const col = BoardCore.normalizeColumn({
    id: newId(), taskId: newTaskId(), width: defaultColWidth(), cwd: '',
    role: 'manual', relationship: 'Independent manual terminal', claudeSeatId: config.activeClaudeSeatId, ...c,
    view: 'term',
  });
  insertColumn(col, true); // brand-new column: never auto-resume
  return col;
}
// Smallest unused positive integer, so new columns read 1,2,3… and fill gaps.
function nextTitle() {
  const used = new Set(columns.map((c) => parseInt(c.title, 10)).filter((n) => !isNaN(n)));
  let n = 1; while (used.has(n)) n++;
  return String(n);
}
// New column with no dialog: auto-numbered title, default (global) cwd, focused.
function addAndFocusColumn(opts) {
  const stayOnBoard = activeView === 'board';
  if (zoomedId) { zoomedId = null; updateColumnStyles(); } // new column must be visible
  Pages.hide();
  const col = addColumn({ title: nextTitle(), role: 'manual', folderId: (opts && opts.folderId) || null });
  if (stayOnBoard) setTimeout(() => selectBoardNode(col.id, true), 100);
  else whenMounted(col, () => jumpToColumn(col)); // wait for its terminal
  return col;
}
// A session opened by Schedule or 队长; background runs don't steal focus.
function createSession(c, background) {
  const col = addColumn({ ...c, title: c.title || nextTitle(), cmd: c.cmd || '', cwd: c.cwd || '', role: 'manual' });
  if (!background) whenMounted(col, () => jumpToColumn(col));
  return col;
}
// 队长: always the first column; opens in terminal view.
function createMain(c) {
  if (zoomedId) { zoomedId = null; updateColumnStyles(); }
  Pages.hide();
  const col = addColumn({ title: '队长', displayTitle: '队长', manualTitle: true, cmd: c.cmd || '', cwd: c.cwd || '', role: 'manual', isMain: true });
  whenMounted(col, () => jumpToColumn(col));
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
// A failed reattach needs a new PTY but keeps the card, column id and chat.
// Dispose old listeners before killing so its exit cannot settle the new run.
function restartWorker(col) {
  const entry = terms.get(col.id);
  if (entry) {
    (entry.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    entry.term.dispose();
    terms.delete(col.id);
  }
  window.deck.ptyKill(col.id);
  const fresh = buildColumn(col, true);
  if (entry) entry.wrap.replaceWith(fresh);
  else deckEl.appendChild(fresh);
  saveConfig();
  updateColumnStyles();
}
// cwd change needs a fresh shell with a new id, so old exit events cannot bleed in.
// opts.freshChat keeps the retired conversation under the old id.
function respawnColumn(col, opts) {
  const t = terms.get(col.id);
  const wasBoardSelected = selectedBoardId === col.id;
  if (wasBoardSelected) restoreBoardTerminal();
  window.deck.ptyKill(col.id);
  if (SidePane.holdsTerminalOf(col.id)) SidePane.restoreTerminal();
  if (t) {
    (t.disposers || []).forEach((fn) => { try { fn(); } catch (_) {} });
    t.term.dispose(); terms.delete(col.id);
  }
  const oldId = col.id;
  col.id = newId();
  // A 小队长's children, records and untaken receipts point at its id.
  if (col.subCaptain === true) MainSession.subCaptainIdChanged(oldId, col.id);
  delete col.modelSessionId;
  if (!(opts && opts.freshChat)) ChatUI.onColumnIdChanged(oldId, col.id);
  if (focusedId === oldId) focusedId = col.id;
  if (zoomedId === oldId) zoomedId = col.id; // stay zoomed across a respawn
  if (wasBoardSelected) selectedBoardId = col.id;
  const fresh = buildColumn(col, true); // cwd/cmd just changed: start fresh, no auto-resume
  if (t) t.wrap.replaceWith(fresh);
  else {
    const next = columns[columns.indexOf(col) + 1];
    const nextWrap = next && terms.get(next.id) && terms.get(next.id).wrap;
    deckEl.insertBefore(fresh, nextWrap && nextWrap.parentElement === deckEl ? nextWrap : null);
  }
  saveConfig();
  updateColumnStyles();
  renderColNav();
  renderBoardGraph();
  return col;
}

// ---- Column sidebar (list of columns: click to jump, double-click to rename) ----
// One source of truth for a column's name so the header title and the sidebar
// entry never drift: rename in either place flows through here.
function applyNavTitle(labelEl, text) {
  if (!labelEl) return;
  if (labelEl.textContent !== text) labelEl.textContent = text;
  if (labelEl.title !== text) labelEl.title = text;
  if (labelEl.getAttribute('aria-label') !== text) labelEl.setAttribute('aria-label', text);
}

function setColumnTitle(col, title) {
  col.title = title;
  const t = terms.get(col.id);
  const label = columnLabel(col);
  if (t && t.titleEl && t.titleEl.textContent !== label) t.titleEl.textContent = label;
  const nav = navItems.get(col.id);
  applyNavTitle(nav && nav.label, label);
  saveConfig();
  renderBoardGraph();
}

const colNavEl = document.getElementById('colNav');
const navItems = new Map(); // id -> { el, dot, label, sub, meta } (filled by sidebar.js)

// The sidebar (folders, sessions, archive) lives in sidebar.js. Cheap plain
// DOM, so it is simply rebuilt on every structural change.
function renderColNav() { Sidebar.render(); }

// Mirror each entry's status dot and mark the focused column as active — both
// in the sidebar and on the deck column itself (accent bar via .focused).
// A collapsed folder shows the most urgent state of what's inside it.
const NAV_RANK = { input: 3, quota: 3, working: 2, done: 1 };
function syncNav() {
  if (peekId && focusedId && focusedId !== peekId && columns.some((c) => c.id === focusedId)) {
    peekId = null;
    updateColumnStyles();
  }
  const folderState = new Map();
  document.querySelectorAll('.nav-folder-head.has-focus').forEach((h) => h.classList.remove('has-focus'));
  navItems.forEach((nav, id) => {
    const entry = terms.get(id);
    const state = (entry && entry.state) || 'plain';
    if (!nav.el) {
      if (!nav.folderHead) return;
      if ((NAV_RANK[state] || 0) > (NAV_RANK[folderState.get(nav.folderHead)] || 0)) folderState.set(nav.folderHead, state);
      if (id === focusedId) nav.folderHead.classList.add('has-focus');
      return;
    }
    const queued = state === 'working' && entry.webQueued;
    nav.dot.className = 'cn-dot ' + state + (queued ? ' web-queued' : '');
    nav.dot.title = queued ? WEB_QUEUED_TIP : DOT_TIP[state] || '';
    nav.el.classList.toggle('active', id === focusedId);
    nav.el.classList.toggle('live', state === 'working' || state === 'input');
  });
  document.querySelectorAll('.nav-folder-head').forEach((h) => { h.dataset.state = folderState.get(h) || ''; });
  terms.forEach((t, id) => { if (t.wrap) t.wrap.classList.toggle('focused', id === focusedId); });
  Sidebar.refreshCrew();
  SidePane.onFocusChange();
}

function scrollColumnInDeck(wrap, center = false) {
  if (env.platform !== 'win32') {
    wrap.scrollIntoView(center ? { behavior: 'instant', inline: 'center', block: 'nearest' } : { inline: 'nearest', block: 'nearest' });
    return;
  }
  const deck = deckEl.getBoundingClientRect();
  const column = wrap.getBoundingClientRect();
  // scrollIntoView also scrolls hidden ancestors (including the document),
  // which can pull the sidebar outside the window on Windows.
  let delta = 0;
  if (center) delta = column.left - deck.left + (column.width - deckEl.clientWidth) / 2;
  else if (column.left < deck.left && column.right > deck.right) return;
  else if (column.left < deck.left) delta = column.width <= deckEl.clientWidth ? column.left - deck.left : column.right - deck.right;
  else if (column.right > deck.right) delta = column.width <= deckEl.clientWidth ? column.right - deck.right : column.left - deck.left;
  deckEl.scrollLeft += delta;
}

function jumpToColumn(col) {
  const t = terms.get(col.id);
  if (!t) return;
  if (activeView === 'board' && boardCanvasMode()) {
    selectBoardNode(col.id, true);
    return;
  }
  if (activeView === 'board') showView('terminals');
  Pages.hide(); // a Schedule/Artifacts page would cover the column
  TaskBoardUI.close(); // so would the task board
  peekColumn(col);
  // While zoomed, jumping re-zooms onto the target instead of focusing a hidden column.
  if (zoomedId && zoomedId !== col.id) { zoomedId = col.id; updateColumnStyles(); fitAll(); }
  // Explicit navigation must bypass the IME drift guard. Focus only after
  // scrolling, otherwise focusin arms that guard and snaps the deck back.
  ChatUI.setMode(col.id, 'term');
  isUserScrollingDeck = true;
  clearTimeout(userScrollTimeout);
  scrollColumnInDeck(t.wrap, true);
  lastValidDeckScrollLeft = deckEl.scrollLeft;
  focusColumnInput(col.id); focusedId = col.id;
  userScrollTimeout = setTimeout(() => { isUserScrollingDeck = false; }, 350);
  syncNav();
}

// Native notification / external focus request: reveal the exact column.
// Stale IDs leave the current column unchanged.
window.deck.onFocusColumn((id) => {
  const col = columns.find((c) => c.id === id);
  if (!col) {
    showToast('这个终端已关闭，通知已失效。');
    return;
  }
  // A modal dialog traps focus; close it before selecting the input target.
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  if (activeView === 'board') showView('terminals');
  let tries = 0;
  const jump = () => {
    if (!columns.some((candidate) => candidate.id === id)) return;
    if (!terms.has(id) && tries++ < 30) { setTimeout(jump, 50); return; }
    jumpToColumn(col);
  };
  jump();
});

// ---- Help dialog (shortcuts & tips) ----
const helpDlg = document.getElementById('helpDialog');
function toggleHelp() {
  if (helpDlg.open) helpDlg.close();
  else helpDlg.showModal();
}
document.getElementById('helpClose').onclick = () => helpDlg.close();
document.getElementById('helpX').innerHTML = ICONS.close;
document.getElementById('helpX').onclick = () => helpDlg.close();

// ---- Add / edit dialog ----
const dlg = document.getElementById('colDialog');
const titleInput = document.getElementById('titleInput');
const cwdInput = document.getElementById('cwdInput');
const cmdInput = document.getElementById('cmdInput');
const dlgTitle = document.getElementById('dlgTitle');
const cmdLockedHint = document.getElementById('cmdLockedHint');
// The column itself, not its position: 队长 opens and archives sessions while the dialog is open.
let editColumn = null;

function openDialog(idx) {
  if (typeof idx === 'number' && !columns[idx]) return;   // that column is already gone
  editColumn = typeof idx === 'number' ? columns[idx] : null;
  dlgTitle.textContent = editColumn === null ? '添加列' : '编辑列';
  titleInput.value = editColumn === null ? '' : columnLabel(editColumn);
  cwdInput.value = editColumn === null ? '' : (editColumn.cwd || '');
  cmdInput.value = editColumn === null ? '' : (editColumn.cmd || '');
  // A 网页版 ChatGPT session has no launch command to change.
  const web = editColumn !== null && editColumn.executor === 'chatgpt-web';
  cmdInput.disabled = web;
  dlg.querySelectorAll('.preset').forEach((b) => { b.disabled = web; });
  cmdLockedHint.hidden = !web;
  cmdLockedHint.textContent = web ? ChatGPTWebCore.LABEL + '：' + ChatGPTWebCore.NO_SEAT_NOTE : '';
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
  if (editColumn === null) {
    addColumn({ title, displayTitle: titleInput.value.trim() ? title : '', cwd, cmd, manualTitle: titleInput.value.trim() !== '' });
    dlg.close();
    return;
  }
  const col = editColumn;
  if (!columns.includes(col)) {
    showToast(`「${columnLabel(col)}」已经关闭或归档，修改没有保存`);
    dlg.close();
    return;
  }
  const needsRespawn = (col.cwd || '') !== cwd || (col.cmd || '') !== cmd;
  const titleChanged = title !== columnLabel(col);
  if ((col.cmd || '') !== cmd) {
    col.agentProvider = null;
    col.agentModel = null;
    col.agentEffort = null;
  }
  col.cwd = cwd;
  col.cmd = cmd;
  if (needsRespawn) delete col.modelSessionId;
  if (titleChanged) setColumnDisplayTitle(col, title); // keep auto-title behavior when only cwd/cmd changed
  saveConfig();
  if (needsRespawn) {
    if (col.isMain) MainSession.clearContext({ command: cmd, fromEdit: true });
    else respawnColumn(col); // a cwd or startup-command change restarts the shell
  }
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
    ChatUI.noteSent(target, text);
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

function respondBoard(requestId, payload, verbatim = false) {
  const id = BoardCore.cleanText(requestId, 200);
  if (!id) return;
  const response = {
    done: !!payload.done,
    result: verbatim && typeof payload.result === 'string' ? payload.result : BoardCore.cleanText(payload.result, 12000),
    error: BoardCore.cleanText(payload.error, 2000),
    childId: BoardCore.cleanText(payload.childId, 160),
    visible: typeof payload.visible === 'boolean' ? payload.visible : undefined,
    turnId: typeof payload.turnId === 'string' ? payload.turnId.slice(0, 120) : undefined,
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

// Phone messages queued for the Captain, by the key the phone server hands over (oldest first,
// a day and at most 1000): a retry of one main gave up on is not queued again.
const mobileSentKeys = new Map();
window.deck.onMobileRequest(async ({ id, op, input }) => {
  try {
    let result;
    if (op === 'sessions') {
      result = columns.map((col) => {
        const entry = terms.get(col.id), info = AgentInfo.resolveAgentInfo(col, entry);
        const task = [...(MainSession.state()?.tasks || [])].reverse().find((t) => t.colId === col.id);
        const active = entry?.alive && (entry.state === 'working' || entry.sendingPrompt || task?.status === 'working');
        const failed = !active && (task?.status === 'failed' || col.lastReceipt?.failed || entry && !entry.alive);
        const status = entry?.alive && ['input', 'quota'].includes(entry.state) ? entry.state
          : active ? 'working' : failed ? 'failed'
          : ['queued', 'waiting', 'asking', 'done'].includes(task?.status) ? task.status : 'idle';
        return { id: col.id, title: columnLabel(col), model: info.model || info.provider || '未知模型',
          status, isMain: !!col.isMain, project: String(col.project || '').slice(0, 120),
          receipt: String(col.lastReceipt?.summary || col.lastReceipt?.failed || '').slice(0, 1000) };
      });
    } else if (op === 'output') {
      const col = columns.find((c) => c.id === input?.id && !c.isMain);
      const entry = col && terms.get(col.id);
      result = col ? { id: col.id, title: columnLabel(col), text: entry?.term ? dumpScreen(entry.term, 100).slice(-16000) : '' } : null;
    } else if (op === 'captain-history') {
      const col = columns.find((c) => c.isMain);
      const entry = col && terms.get(col.id);
      result = col ? { id: col.id, title: columnLabel(col), status: entry?.state || 'idle',
        turns: ChatUI.turnsOf(col.id).slice(-80).map((turn) => ({ id: turn.id, ts: turn.ts,
          // Dispatch cards and notices are process, not messages: send their facts, not a fake "user" text.
          ...(turn.kind === 'task' && turn.task ? { kind: 'task', task: { title: String(turn.task.title || '').slice(0, 120), status: turn.task.status || '',
            summary: String(turn.task.receipt?.failed || turn.task.receipt?.summary || '').slice(0, 400), failed: !!turn.task.receipt?.failed } } : {}),
          ...(turn.kind === 'notice' ? { kind: 'notice' } : {}),
          ...(Array.isArray(turn.steps) && turn.steps.length ? { steps: turn.steps.slice(-30).map((x) => String(x).slice(0, 240)) } : {}),
          // A long message is stored clipped, with the full text in a file; main swaps it back in.
          ...(/（全文 \d+ 字，见附件）$/.test(String(turn.user || '')) && /prompt-[\w-]+\.txt$/.test(String((turn.atts || []).slice(-1)[0] || '')) ? { longFile: turn.atts.slice(-1)[0] } : {}),
          user: turn.kind === 'task' || turn.kind === 'notice' ? '' : String(turn.user || '').slice(0, 20000), reply: String(turn.reply || '').slice(-16000),
          // Only images the phone uploaded, by server id; other attachment paths stay private.
          images: (turn.atts || []).map((p) => /[\\/]mobile-uploads[\\/]([a-f0-9]{32}\.(?:jpg|png|gif|webp))$/.exec(p)?.[1]).filter(Boolean),
          done: !!turn.done, interrupted: !!turn.interrupted })) } : { turns: [], status: 'unavailable' };
    } else if (op === 'quota') {
      // The same store and summaries as the sidebar quota rows; nothing is sampled for the phone.
      result = { version: env.version, rows: QuotaCore.mobile(config.quotas, Date.now(), ClaudeSeats.described(config.claudeSeats), claudeCaptainSeatId(),
        columns.find((c) => c.id === config.mainSession?.colId)?.agentProvider) };
    } else if (op === 'captain') {
      // A phone message main gave up on (5 s) may already be queued here: its retry carries the same key.
      const key = typeof input?.deduplicationKey === 'string' && /^[0-9a-f]{64}$/.test(input.deduplicationKey) ? input.deduplicationKey : '';
      if (!key || !mobileSentKeys.has(key)) {
        MainSession.sendMessage(input?.message, input?.images);
        if (key) {
          mobileSentKeys.set(key, Date.now());
          for (const [old, at] of mobileSentKeys) { if (mobileSentKeys.size <= 1000 && Date.now() - at <= 86_400_000) break; mobileSentKeys.delete(old); }
        }
      }
      result = { queued: true };
    } else if (op === 'attention') {
      result = AttentionUI.mobileView();
    } else if (op === 'attention-write') {
      result = await AttentionUI.mobileWrite(input);
    } else if (op === 'battery') {
      result = MainSession.batteryReadout();
    } else if (op === 'battery-set') {
      result = MainSession.setBattery(input);
    } else if (op === 'relay') {
      result = ClaudeSeats.mobileState();
    } else if (op === 'relay-switch') {
      result = ClaudeSeats.mobileSwitch(input);
    } else throw new Error('未知网页操作。');
    window.deck.mobileRespond({ requestId: id, result });
  } catch (error) { window.deck.mobileRespond({ requestId: id, error: error.message }); }
});

window.deck.onBoardCommand(async (message) => {
  const cached = config.boardResponses[message.id];
  if (cached) {
    window.deck.boardRespond({ requestId: message.id, ...cached });
    return;
  }
  if (message.action === 'create-child' || message.action === 'spawn-child') {
    // A 小队长's child is a 队长 session: MainSession answers a repeated request for it.
    const existingChild = columns.find((col) => col.createdByRequestId === message.id && !col.captainCrew);
    if (existingChild) {
      respondBoard(message.id, existingChild.taskCompleted
        ? { done: true, childId: existingChild.taskId, result: existingChild.result }
        : message.action === 'create-child'
          ? { done: false, childId: existingChild.taskId }
          : { done: true, childId: existingChild.taskId, result: existingChild.taskId });
      return;
    }
  }
  // 自动回执入口: main.js built this command itself from an authenticated automation token. It has no calling session.
  if (message.automation && String(message.action || '').startsWith('automation-')) {
    Promise.resolve().then(() => MainSession.automation(message)).then(
      (response) => respondBoard(message.id, response),
      (error) => respondBoard(message.id, { done: true, error: error.message }));
    return;
  }
  const caller = columns.find((col) => col.id === message.callerId);
  if (['complete', 'ask', 'progress', 'session-exit'].includes(message.action) && caller) {
    try {
      const response = await MainSession.submit(message, caller);
      if (response) { respondBoard(message.id, response); return; }
      if (message.action === 'session-exit') { respondBoard(message.id, { done: true }); return; }
    } catch (error) { respondBoard(message.id, { done: true, error: error.message }); return; }
  }
  if (message.action === 'main-todo-delivery' || message.action === 'main-todo-error') {
    Promise.resolve().then(() => MainSession.handle(message, caller)).then(
      (response) => window.deck.boardRespond({ requestId: message.id, ...response }),
      (error) => window.deck.boardRespond({ requestId: message.id, done: true, error: error.message }));
    return;
  }
  // 队长's commands: only its own column may use them. A 小队长 reaches a few of them, and
  // create-child, on its own children (MainSession checks which).
  if (String(message.action || '').startsWith('main-') || message.action === 'seat-auth-alert' ||
      (message.action === 'create-child' && caller?.subCaptain === true && !caller.isMain && !message.submitOnly)) {
    Promise.resolve().then(() => MainSession.handle(message, caller)).then(
      (response) => {
        // A peek is ephemeral; empty watcher polls have no side effects and
        // must not rewrite config or evict cached task responses every second.
        if (message.action === 'main-receipt-listener-status' || message.action === 'main-peek' || message.action === 'main-quota' || message.action === 'main-briefing' || message.action === 'main-handoff' || message.action === 'main-receipts-snapshot' || (message.action === 'main-receipts' && message.wait && !response.result)) window.deck.boardRespond({ requestId: message.id, ...response });
        else respondBoard(message.id, response, message.action === 'main-receipts' || message.action === 'main-receipts-ack' || message.action === 'main-task' || message.action === 'main-queue' || message.action === 'main-read' || message.action === 'main-inbox');
      },
      (error) => {
        const response = { done: true, error: error.message };
        if (message.action === 'seat-auth-alert' || message.action === 'main-receipt-listener-status' || message.action === 'main-peek' || message.action === 'main-quota' || message.action === 'main-briefing' || message.action === 'main-handoff') window.deck.boardRespond({ requestId: message.id, ...response });
        else respondBoard(message.id, response);
      });
    return;
  }
  if (!caller || caller.role === 'manual' || (message.submitOnly && !['complete', 'ask', 'progress'].includes(message.action))) {
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
document.getElementById('notificationSettingsClose').innerHTML = ICONS.close;
document.getElementById('batteryBoostCancel').innerHTML = ICONS.close;
const closeNotificationSettings = () => {
  if (!saveNotificationSettings()) showToast('上课时段有一行格式不对，这一项没改；其他设置已保存。');
  flushConfig();
};
document.getElementById('notificationSettingsClose').onclick = () => {
  closeNotificationSettings();
  document.getElementById('notificationSettings').close();
};
document.getElementById('notificationSettings').addEventListener('cancel', closeNotificationSettings);
document.getElementById('barkCalendarRefresh').innerHTML = ICONS.refresh;
document.getElementById('barkCalendarRefresh').addEventListener('click', async (event) => {
  saveNotificationSettings();
  flushConfig();
  const button = event.currentTarget;
  button.disabled = true;
  try { await window.deck.refreshBarkCalendar(); await updateBarkPolicyStatus(); }
  catch (_) { document.getElementById('barkPolicyStatus').textContent = '刷新失败，请稍后重试。'; }
  finally { button.disabled = false; }
});
['captainNotifyEnabled', 'captainSoundEnabled', 'captainSoundTone', 'barkKeyFile', 'barkCriticalVolume', 'barkSleepEnabled', 'barkSleepStart', 'barkSleepEnd', 'barkClassesEnabled', 'barkClassCalendarIds', 'barkClassFilters', 'barkWeeklyClasses'].forEach((id) => {
  document.getElementById(id).addEventListener('change', saveNotificationSettings);
});
buildChrome();
setNavCollapsed(config.navCollapsed); // sets class + width
attachNavResize(document.getElementById('navResizer'));
applyTheme(config.theme);
applyMotion(config.calmMotion);
// Battery mode on the page: still motion, no cursor blink, and a small indicator that says what is limited.
function renderBatteryIndicator() {
  const snap = battery.snapshot();
  const tip = [...BatteryCore.describe(snap, config.concurrencyCap), '点击调整'].join('\n');
  document.querySelectorAll('.battery-indicator').forEach((b) => {
    b.hidden = !snap.active;
    b.title = tip;
    b.setAttribute('aria-label', snap.boost ? '电池模式已临时拉满，点击调整' : '电池模式已启用，点击调整');
    b.classList.toggle('boosted', snap.boost === true);
  });
}
function openBatterySettings() {
  openNotificationSettings();
  const select = document.getElementById('batteryMode');
  select.scrollIntoView({ block: 'center' });
  select.focus();
}
document.getElementById('batteryIndicator').addEventListener('click', openBatterySettings);
function applyBattery() {
  applyMotion(config.calmMotion, false);
  TaskBoardUI.redraw();
  terms.forEach((entry) => { try { entry.term.options.cursorBlink = !battery.active(); } catch (_) {} });
  renderBatteryIndicator();
}
battery.onChange(applyBattery);
renderBatteryIndicator();
const deckHost = {
  columns: () => columns, terms, config, saveConfig, flushConfig, columnLabel, findLinks, lastActivityLine, maybeAutoName, seatLaunchCommand,
  shellQuote, showToast, jumpToColumn, setNavCollapsed, ICONS, navItems, syncNav,
  onCapChanged: renderBatteryIndicator, // the tooltip names the live cap
  clipboardWrite: (text) => window.deck.clipboardWrite(text),
  platform: env.platform, home: env.home, version: env.version,
  focusedId: () => focusedId,
  setFocused: (id) => { focusedId = id; syncNav(); },
  layout: () => { updateColumnStyles(); fitAll(); syncChromeState(); },
  activeView: () => activeView,
  isNavCollapsed: () => config.navCollapsed,
  isChatMode: (id) => ChatUI.isChatMode(id),
  setMode: (id, mode) => ChatUI.setMode(id, mode),
  // sidebar
  folders: () => config.folders,
  archived: () => config.archived || [],
  addAndFocusColumn, removeCol, archiveColumn, restoreArchived, deleteArchived, moveSession, removeFolder,
  renameSession: (col, title) => setColumnDisplayTitle(col, title),
  lastTurnTs: (id) => ChatUI.lastTurnTs(id),
  togglePage: (name) => {
    if (activeView === 'board') showView('terminals');
    TaskBoardUI.close();
    if (focusedId) ChatUI.setMode(focusedId, 'term');
    Pages.toggle(name);
  },
  toggleTaskBoard: () => TaskBoardUI.toggle(),
  showSideTerminal: () => SidePane.show('terminal', true),
  // Schedule
  createSession, sendWhenReady,
  sendPrompt: (col, text) => ChatUI.sendPrompt(col, text),
  // 队长
  createMain, respawnColumn, restartWorker, agentInForeground, isBackstage, userComposing, dumpScreen, ptyBackgroundWork,
  screenState: (text, entry, cmd) => classify(text, entry, cmd),
  menuOnScreen,
  // How the terminal stands right now, read again instead of taken from the last status tick.
  liveState: (col) => { const e = terms.get(col.id); return e?.alive ? classify(liveStatusText(e.term), e, col.cmd, !!col.isMain) : 'exited'; },
  quotaText: () => QuotaCore.text(config.quotas, Date.now(), ClaudeSeats.described(config.claudeSeats), claudeCaptainSeatId()),
  captainTurnStarted, captainTurnDone, captainColumnVisible,
  manualPromptSent, manualTurnDone,
};
SidePane.init(deckHost);
Sidebar.init(deckHost);
// The Captain's crew list opens fully at launch and again the first time the window is
// used on a new day; a fold made in between holds until then.
let crewFoldDay = SidebarCore.localDay(Date.now());
function openCrewOnNewDay() {
  const today = SidebarCore.localDay(Date.now());
  if (today === crewFoldDay) return;
  crewFoldDay = today;
  if (config.crewOpen && !config.crewModelsCollapsed.length) return;
  config.crewOpen = true;
  config.crewModelsCollapsed = [];
  Sidebar.render();
}
window.addEventListener('focus', openCrewOnNewDay);
document.addEventListener('visibilitychange', () => { if (!document.hidden) openCrewOnNewDay(); });
AttentionUI.init(deckHost);
MainSession.init(deckHost);
window.deck.onParkForRestart(async (sessions) => {
  try { await MainSession.parkForRestart(sessions); }
  finally { window.deck.parkForRestartDone(); }
});
ClaudeSeats.init(deckHost);
ChatUI.init(deckHost);
Pages.init(deckHost);
ChatDeliverables.init(deckHost);
ReleaseNotesUI.init(deckHost);
TodoUI.init(deckHost);
render(!(Array.isArray(saved && saved.columns) && saved.columns.length));
renderQuotaBar();
function applyQuotaSamples(samples) {
  let changed = false;
  for (const sample of samples) changed = QuotaCore.observe(config.quotas, sample) || changed;
  if (changed) saveConfig();
  renderQuotaBar();
}
async function readQuotaCache() { applyQuotaSamples(await window.deck.quotaLocal()); }
async function refreshQuota(seatId) { applyQuotaSamples(await window.deck.quotaRefresh(seatId)); }
window.deck.onQuotaUpdated(applyQuotaSamples);
window.addEventListener('claude-seat-changed', (e) => {
  if (e.detail?.seatId !== 'chatgpt') refreshQuota(e.detail?.seatId).catch(() => {});
});
document.getElementById('quotaRefresh').addEventListener('click', async (e) => {
  const button = e.currentTarget; button.disabled = true; button.classList.add('spinning');
  try { await refreshQuota(); } catch (_) { showToast('额度查询暂不可用，保留上次采样'); }
  finally { button.disabled = false; button.classList.remove('spinning'); }
});
window.addEventListener('claude-seat-usage', () => readQuotaCache().catch(() => {}));
window.addEventListener('claude-seat-accounts', () => renderQuotaBar());
readQuotaCache().catch(() => {});
battery.every('quotaCache', () => readQuotaCache().catch(() => {}));
syncChromeState();
window.addEventListener('resize', () => {
  applyNavWidth();
  if (activeView === 'board') renderBoardGraph();
  else { updateColumnStyles(); fitAll(); }
});
// A file dropped anywhere but a terminal would otherwise make the window
// navigate to file://… — swallow those so the app never reloads.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Read terminal screens for status, reply extraction and Captain readiness.
function dumpScreen(term, count = 40) {
  const buf = term.buffer.active;
  // Fresh/tall terminals have many blank rows below the cursor. Starting at
  // buffer.length used to discard all actual output in the first few rows.
  let end = buf.length;
  const floor = Math.max(0, end - Math.max(term.rows, count));
  while (end > floor) {
    const line = buf.getLine(end - 1);
    if (line && line.translateToString(true).trim()) break;
    end--;
  }
  const lines = [];
  for (let i = Math.max(0, end - count); i < end; i++) {
    const ln = buf.getLine(i);
    lines.push(ln ? ln.translateToString(true) : '');
  }
  return lines.join('\n');
}
// Status must inspect the entire live screen, independent of viewport/focus.
// dumpScreen's bounded tail is for reply/history extraction: it can miss a busy
// row above a tall input/footer, or retain an obsolete spinner in scrollback.
function statusScreen(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    const line = buf.getLine(y);
    // (as wide as the terminal is: a full-screen TUI's row keeps its old length when the terminal narrows)
    const text = line ? line.translateToString(false, 0, term.cols) : '';
    if (line?.isWrapped && lines.length && !chromeRowBreak(buf.getLine(y - 1)?.translateToString(false, 0, term.cols) || '', text)) {
      // a wide character (中文) that did not fit at the end of the row above went down whole: the cell it left
      // there (empty in xterm, a space from the Windows console between two wide characters) is no space in the
      // text; nor are the blank cells after it once the window has grown since (the console paints spaces to the
      // new last column, xterm leaves them empty)
      const above = buf.getLine(y - 1), last = above?.getCell?.(term.cols - 1);
      const blank = (c) => !!c && c.getWidth() === 1 && (c.getChars() === '' || c.getChars() === ' ');
      let x = term.cols - 1;
      while (x > 0 && blank(above?.getCell?.(x))) x--;
      const run = term.cols - 1 - x;
      if (run && above?.getCell?.(x)?.getWidth() === 0 && line.getCell?.(0)?.getWidth() === 2) {
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, -run);
      } else if (last && last.getWidth() === 1 && last.getChars() === '') {
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
      }
      lines[lines.length - 1] += text;
    } else lines.push(text);
  }
  let text = lines.map((line) => line.trimEnd()).join('\n');
  const sep = Math.max(text.lastIndexOf('以上为上次会话的输出'), text.lastIndexOf('上次输出回放'));
  if (sep >= 0) {
    const nl = text.indexOf('\n', sep);
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text.trimEnd();
}
// The Windows console (ConPTY) sends some full-screen TUI rows as a soft wrap of the row above:
// a box rule that fills the width and the "❯ " row under it, or a padded row and Claude's spinner
// row ("✽ Skedaddling… (4s)"). Joined, the rule swallows the prompt and the spinner sits mid-line,
// so nothing anchored at a row's start sees them and a working Claude reads as done. Text really
// wraps at its last cell; a rule above, or a row that ended in blank cells above TUI chrome, did not.
function chromeRowBreak(above, row) {
  // Claude's spinner row ("✶ Metamorphosing… (3m 11s · …") is never the tail of a sentence, whatever stands above it.
  return /^\s*[─━═]{3,}\s*$/.test(above) || /^\s*[─━═]{3,}\s*$/.test(row) || /^\s*[✻✽✳✶✢✺∴·*]\s+\S+…\s*\(/.test(row) ||
    (/\s{2,}$/.test(above) && /^\s*(?:[✻✽✳✶✢✺∴·*]\s+\S|[❯›](?:\s|$)|⎿\s|⏺\s|⏵⏵)/.test(row));
}
// A menu or confirmation is on the terminal right now (its own reading, not the last status tick).
// Rows that are the text just pasted (shown in the input box) are not the agent asking anything.
function menuOnScreen(term, sent = '') {
  const flat = String(sent).replace(/\s+/g, ' ');
  const rows = statusScreen(term).split('\n').slice(-20).filter((row) => {
    const t = row.replace(/^\s*[│┃]?\s*❯\s?/, '').replace(/\s*[│┃]\s*$/, '').trim().replace(/\s+/g, ' ');
    return !(t.length >= 3 && flat.includes(t));
  });
  return NEEDS_INPUT_RE.test(rows.join('\n'));
}
// The screen the status light reads. On Windows nothing names the foreground process: a PowerShell
// prompt at the bottom means the agent has exited, and a menu it was showing when it died still
// stands above that prompt. It is history, not a question waiting for an answer.
function liveStatusText(term) {
  if (env.platform !== 'win32') return statusScreen(term);
  const text = MainCore.afterReplay(statusScreen(term), env.platform);
  return MainCore.isWindowsShellPrompt(text) ? MainCore.windowsAgentOutput(text) : text;
}
// Background shell commands under a column's terminal, for the automatic archive
// (pty-work.js in the main process). An answer is used for PTY_WORK_MS, a busy one
// for PTY_WORK_BUSY_MS (on Windows each listing starts PowerShell, and a background
// job can run for hours); until a fresh one arrives the column reads undefined
// (unknown), null when the main process could not list processes.
const PTY_WORK_MS = 10_000;
const PTY_WORK_BUSY_MS = 60_000;
const ptyWorkAnswers = new Map();
function ptyBackgroundWork(col) {
  const known = ptyWorkAnswers.get(col.id);
  if (known && !known.pending && Date.now() - known.at < (known.busy === true ? PTY_WORK_BUSY_MS : PTY_WORK_MS)) return known.busy;
  if (!known?.pending) {
    ptyWorkAnswers.set(col.id, { pending: true });
    const answer = (busy) => ptyWorkAnswers.set(col.id, { at: Date.now(), busy: typeof busy === 'boolean' ? busy : null });
    Promise.resolve().then(() => window.deck.ptyBackgroundWork(col.id)).then(answer, () => answer(null));
  }
  return undefined;
}
// Format elapsed ms compactly: 42s → 3m 12s → 1h 05m.
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}
const DONE_TIMER_LINGER = 5 * 60_000; // keep "✓ 2m 14s" visible this long after finishing

function lastActivityLine(text) {
  return SidebarCore.activityLine(ChatCore.cutInputBox(text.split('\n')));
}

function updateAgentIdentityBadge(id, entry, screenText) {
  if (!window.AgentInfo || !entry) return;
  const col = columns.find((candidate) => candidate.id === id);
  if (!col) return;
  let footer = entry.footerLines;
  if (!ChatUI.isChatMode(id)) {
    try { footer = ChatUI.readFooter(entry.term); } catch (_) { footer = null; }
  }
  entry.footerLines = footer;
  const history = ChatUI.turnsOf(id);
  const lastTurn = history && history.length ? history[history.length - 1] : null;
  const historyKey = lastTurn ? `${history.length}:${lastTurn.id}:${(lastTurn.reply || '').length}:${lastTurn.done ? 1 : 0}` : '';
  const replies = historyKey && historyKey !== entry.identityHistoryKey && (!col.agentProvider || !col.agentModel)
    ? history.map((turn) => turn.reply || '')
    : null;
  if (replies) entry.identityHistoryKey = historyKey;
  const info = window.AgentInfo.resolveAgentInfo(col, entry, screenText, footer, replies);
  if (entry.badgeEl) window.AgentInfo.renderBadge(entry.badgeEl, info, 'header');
  const nav = navItems.get(id);
  if (nav && nav.badge) window.AgentInfo.renderBadge(nav.badge, info, 'sidebar', ClaudeSeats.described(config.claudeSeats));
  if (info.provider && (col.agentProvider !== info.provider ||
      (info.rawModel && col.agentModel !== info.rawModel) ||
      (info.effort && col.agentEffort !== info.effort))) {
    col.agentProvider = info.provider;
    if (info.rawModel) col.agentModel = info.rawModel;
    if (info.effort) col.agentEffort = info.effort;
    if (col.boardId && info.rawModel) window.deck.taskBoard('identity', {
      id: col.boardId, session_id: col.id, attempt_id: col.boardAttempt,
      agent: BoardCore.inferAgentType(col.cmd), model: info.rawModel,
    }).catch((error) => showToast('看板模型信息未更新：' + error.message));
    saveConfig();
  }
}

// Alerts use real chat turns, with a quiet-output guard against pauses during tools.
// These ids live only in this renderer: restored history/output never arms them.
function manualPromptSent(id, turn, userInitiated) {
  const entry = terms.get(id);
  const col = columns.find((c) => c.id === id);
  if (!entry || !NotificationPolicy.isManualColumn(col)) return;
  entry.manualTurnId = userInitiated && turn ? turn.id : null;
  entry.captainAlert = null;
  window.deck.notifyCancel({ id });
}
function manualTurnDone(id, turn) {
  const entry = terms.get(id);
  if (!entry || entry.manualTurnId !== turn.id || !entry.alive || turn.interrupted) return;
  entry.captainAlert = { turnId: turn.id, reply: turn.reply.trim() || '本轮输出已停止。', since: Date.now() };
}
function captainTurnStarted(id, turn) {
  const entry = terms.get(id);
  if (!entry) return;
  entry.captainTurnId = turn.id;
  entry.captainAlert = null;
  window.deck.notifyCancel({ id });
}
function captainTurnDone(id, turn) {
  const entry = terms.get(id);
  if (!entry || !entry.alive || turn.interrupted || !turn.reply.trim()) return;
  entry.captainAlert = { turnId: turn.id, reply: turn.reply, since: Date.now() };
}
function captainColumnVisible(id) {
  const wrap = terms.get(id)?.wrap;
  if (!wrap || deckEl.hidden || !document.getElementById('pageView').hidden || getComputedStyle(wrap).display === 'none') return false;
  const r = wrap.getBoundingClientRect(), d = deckEl.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > d.left && r.left < d.right && r.bottom > d.top && r.top < d.bottom;
}
function maybeNotifyState(id, entry, st) {
  const col = columns.find((c) => c.id === id);
  const manual = NotificationPolicy.isManualColumn(col) && !!entry.manualTurnId;
  if (!col?.isMain && !manual) { window.deck.notifyCancel({ id }); return; }
  const turnId = manual ? entry.manualTurnId : entry.captainTurnId;
  const previous = entry.captainNotifyState;
  entry.captainNotifyState = st;
  if (['working', 'quota', 'plain', 'exited'].includes(st)) {
    entry.captainAlert = null;
    window.deck.notifyCancel({ id });
    return;
  }
  if (st === 'done' && previous !== 'done' && !entry.captainAlert && turnId) {
    const turn = ChatUI.turnsOf(id).find((t) => t.id === turnId);
    if (turn?.done && !turn.interrupted) {
      const reply = ChatCore.extractReply((entry.lastScreen || '').split('\n'), turn.user, entry.term.cols);
      if (reply.trim() || manual) entry.captainAlert = { turnId: turn.id, reply: reply.trim() || '本轮输出已停止。', since: Date.now() };
    }
  }
  let alert = null;
  if (!manual && st === 'input' && previous !== 'input' && turnId) {
    const turn = ChatUI.turnsOf(id).findLast((t) => t.kind !== 'task');
    const reply = ChatCore.extractReply((entry.lastScreen || '').split('\n'), turn?.user || '', entry.term.cols);
    alert = { turnId, reply: reply || '队长需要你确认。' };
  } else if (st === 'done' && entry.captainAlert &&
      Date.now() - Math.max(entry.captainAlert.since, entry.lastOutputAt || 0) >= NotificationPolicy.QUIET_MS) {
    alert = entry.captainAlert;
    entry.captainAlert = null;
  }
  if (alert) window.deck.notifyState({ id, state: st, ...alert, userInitiated: manual, visible: captainColumnVisible(id) });
}
let lastAttnCount = -1;
function claudeCaptainSeatId() {
  const captain = columns.find((c) => c.id === config.mainSession?.colId);
  if (!captain || (captain.agentProvider !== 'Claude' && !/\bclaude\b/i.test(captain.cmd || ''))) return null;
  return QuotaCore.seatForColumn(captain, QuotaCore.claudeSeats(config.claudeSeats))?.id || null;
}
// Quota rows live at the bottom of the sidebar (#quotaBar) and, for the
// collapsed sidebar, in the popover under the top-bar gauge (#quotaPopList).
function renderQuotaBar() {
  // Seat rows go by the account signed in behind each directory, not by the seat's fixed name.
  const items = QuotaCore.items(ClaudeSeats.described(config.claudeSeats));
  const captainSeatId = claudeCaptainSeatId();
  const captainProvider = columns.find((c) => c.id === config.mainSession?.colId)?.agentProvider;
  const now = Date.now();
  const summaries = items.map(({ provider, seat }) => QuotaCore.summary(config.quotas, provider, now, seat, captainSeatId));
  const pad = (v) => String(v).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (d) => '周' + '日一二三四五六'[d.getDay()];
  // Row: HH:MM inside the next 24 hours, then the weekday, then MM-DD past a week.
  const shortReset = (t) => {
    const d = new Date(t), gap = t - now;
    return gap <= 86400000 ? hm(d) : gap < 6 * 86400000 ? day(d) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  // Tooltip: the exact time plus how long that is from now; past a day it also names the date.
  const longResetParts = (t) => {
    const d = new Date(t), mins = Math.max(1, Math.round((t - now) / 60000));
    const left = mins < 60 ? `${mins} 分钟` : mins < 1440 ? `${Math.floor(mins / 60)} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}` : `${Math.floor(mins / 1440)} 天`;
    return [`${t - now <= 86400000 ? '' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${day(d)} `}${hm(d)}`, `（${left}后）`];
  };
  const longReset = (t) => longResetParts(t).join('');
  const level = (c) => c.out ? 'out' : c.remaining <= 10 ? 'danger' : c.remaining <= 20 ? 'low' : 'ok';
  // Whole percents keep the columns aligned.
  const pct = (c) => c.out ? '用尽' : c.remaining < 1 ? '<1%' : `${Math.round(c.remaining)}%`;
  const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  // Unchanged content keeps its nodes: the periodic re-render must not disturb a hovered row.
  const fill = (box, nodes) => { const next = el('span', ''); next.append(...nodes); if (next.innerHTML !== box.innerHTML) box.replaceChildren(...next.childNodes); };
  // The exact time and "（N 后）重置" each stay whole, so a narrow detail breaks only between them.
  const resetText = (cls, lead, t, verb) => { const [at, left] = longResetParts(t), n = el('span', cls, lead); n.append(el('span', 'qt-at', at), el('span', 'qt-at', left + verb)); return n; };
  const meter = (c) => { const m = el('span', 'quota-meter'); m.setAttribute('aria-hidden', 'true'); m.style.setProperty('--pct', `${!c || c.out ? 0 : Math.max(2, Math.min(100, c.remaining))}%`); return m; };
  const NAMES = { Claude: 'Claude', Codex: 'ChatGPT', Cursor: 'Grok 4.7', Antigravity: 'Gemini' };
  for (const [bar, prefix] of [[document.getElementById('quotaBar'), 'quota-tip'], [document.getElementById('quotaPopList'), 'quota-pop-tip']]) {
    // "5h / 7d" are named once, in a header row that shares the rows' columns.
    if (!bar.querySelector('.quota-cols')) {
      const cols = el('span', 'quota-cols'); cols.setAttribute('aria-hidden', 'true');
      // Named once for every row: the numbers below are what is left, not what is used.
      cols.append(el('span', ''), el('span', 'quota-col', '5h 剩余'), el('span', 'quota-col', '7d 剩余'));
      bar.prepend(cols);
    }
    for (const item of [...bar.querySelectorAll('.quota-item')]) if (!items.some((q) => q.key === item.dataset.quotaKey)) item.remove();
    for (const [index, { provider, seat, key }] of items.entries()) {
      let item = bar.querySelector(`[data-quota-key="${key}"]`);
      if (!item) {
        item = document.createElement('span');
        item.className = 'quota-item'; item.dataset.provider = provider;
        item.dataset.quotaKey = key;
        if (seat) item.dataset.seatId = seat.id;
        item.setAttribute('role', 'group');
        item.tabIndex = 0; // keyboard users can inspect the same tooltip; a click focuses and so pins it
        for (const event of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) item.addEventListener(event, (e) => {
          if (e.type === 'focusout' && item.contains(e.relatedTarget)) return;
          positionQuotaDetails();
        });
        const label = document.createElement('span'); label.className = 'quota-label'; label.setAttribute('aria-hidden', 'true');
        const icon = document.createElement('span'); icon.className = 'quota-icon';
        icon.innerHTML = AgentInfo.PROVIDER_ICONS[provider === 'Cursor' ? 'Grok' : provider];
        const name = document.createElement('span'); name.className = 'quota-name';
        label.append(icon, name);
        const values = document.createElement('span'); values.className = 'quota-values'; values.setAttribute('aria-hidden', 'true');
        const tip = document.createElement('span'); tip.className = 'quota-tooltip'; tip.id = `${prefix}-${provider}-${seat?.id || ''}`; tip.setAttribute('role', 'tooltip');
        item.setAttribute('aria-describedby', tip.id);
        item.append(label, values, tip); bar.append(item);
        item.addEventListener('click', (event) => {
          const button = event.target.closest('.quota-login-copy');
          if (!button || !item.dataset.loginCommand) return;
          event.stopPropagation();
          try {
            window.deck.clipboardWrite(item.dataset.loginCommand);
            item.dataset.loginCopiedUntil = String(Date.now() + 1400);
            renderQuotaBar();
            // A mouse click focused the button, which would pin the detail open: let go once the tick is over.
            const byMouse = event.detail > 0;
            setTimeout(() => {
              renderQuotaBar();
              const active = document.activeElement;
              if (byMouse && active?.classList.contains('quota-login-copy') && item.contains(active)) active.blur();
            }, 1450);
          } catch (_) { showToast('登录命令复制失败，请重试。'); }
        });
        // Leaving the row on the way to the copy button keeps the detail for a moment (see .tip-hold).
        item.addEventListener('mouseleave', () => {
          if (!item.dataset.loginCommand) return;
          item.classList.add('tip-hold'); clearTimeout(item.tipHoldTimer);
          positionQuotaDetails();
          item.tipHoldTimer = setTimeout(() => { item.classList.remove('tip-hold'); positionQuotaDetails(); }, 300);
        });
        item.addEventListener('mouseenter', () => { clearTimeout(item.tipHoldTimer); item.classList.remove('tip-hold'); });
      }
      const q = summaries[index];
      const captain = seat ? seat.id === captainSeatId : !!captainProvider && captainProvider === provider;
      const name = item.querySelector('.quota-name');
      // The row 队长 is on leads with the crown instead of the provider mark, so the name keeps its width.
      // The Max plan is a small gem on the corner of that icon: it follows the account, whichever
      // directory it is signed in to, and takes no width from the name. The row's detail says 套餐.
      const lead = item.querySelector('.quota-icon'), paid = !!(seat && q.planMark), leadKey = `${captain}:${paid}`;
      if (lead.dataset.lead !== leadKey) {
        lead.dataset.lead = leadKey;
        lead.classList.toggle('quota-captain', captain);
        lead.innerHTML = (captain ? ICONS.crown : AgentInfo.PROVIDER_ICONS[provider === 'Cursor' ? 'Grok' : provider]) + (paid ? `<span class="quota-plan">${ICONS.gem}</span>` : '');
      }
      // Not fine: the name takes the colour (CSS, data-health) and a mark follows it, whose shape
      // (triangle / circle) tells yellow from red without colour. A used-up row already has its shape,
      // the ⊘ in its cells, and keeps the name's width. A fine row is left as it was.
      const health = q.health;
      const mark = () => { const m = el('span', 'quota-health'); m.innerHTML = health.level === 'bad' ? ICONS.seatBad : ICONS.seatWarn; return m; };
      fill(name, [...(seat ? [AgentInfo.accountLabel(q.accountLabel)] : [NAMES[provider]]), ...(health.level === 'ok' || health.kind === 'exhausted' ? [] : [mark()])]);
      const state = q.authStatus === 'logged-out' ? 'danger' : q.out ? 'exhausted' : q.state;
      // Signed in to an account other than the one this seat is set to hold.
      const wrong = seat && ClaudeSeats.accountCheck(seat.id)?.state === 'mismatch' ? ClaudeSeats.accountCheck(seat.id).text : '';
      const recovery = q.recoveryAt > now ? q.recoveryAt : null;
      // Always a 5h and a 7d cell: % + reset time over a thin bar. Used up = ⊘ + reset time;
      // No numeric windows: show the row status in 5h. Account-wide blocks with a reset keep their recovery time.
      const blockedOnly = q.authStatus !== 'logged-out' && q.out && !q.cells.some((c) => c.out);
      const row = ['5h', '7d'].map((key) => {
        const c = q.cells.find((v) => v.key === key) || (key === '5h' && blockedOnly ? { key, out: true, resetAt: recovery } : null);
        const cell = el('span', 'quota-cell'); cell.dataset.window = key; cell.dataset.level = c ? level(c) : 'none';
        const line = el('span', 'quota-line');
        if (key === '5h' && !q.cells.length && !recovery) line.append(el('span', 'quota-none', q.shortText));
        else if (!c) line.append(el('span', 'quota-none', '—'));
        else if (c.out) { const ban = el('span', 'quota-ban'); ban.innerHTML = ICONS.ban; line.append(ban); }
        else line.append(el('span', 'quota-pct', pct(c)));
        if (c?.resetAt > now) line.append(el('span', 'quota-reset', shortReset(c.resetAt)));
        cell.append(line, meter(c));
        return cell;
      });
      fill(item.querySelector('.quota-values'), row);
      // Hover / focus: everything the row leaves out — account, seat, both windows with exact
      // reset times, source, sample time and confidence. Diagnostics stay in data-detail.
      const tip = item.querySelector('.quota-tooltip');
      const head = el('span', 'qt-head');
      head.append(el('span', 'qt-name', seat ? q.accountLabel : NAMES[provider]));
      if (captain) { const who = el('span', 'qt-captain'); who.innerHTML = ICONS.crown; who.append('队长在用'); head.append(who); }
      const badge = el('span', 'qt-badge', health.level === 'ok' ? q.statusText : health.label);
      badge.dataset.state = health.level === 'bad' ? 'danger' : health.level === 'warn' ? 'warning' : state; head.append(badge);
      const lines = q.cells.map((c) => {
        const line = el('span', 'qt-window'); line.dataset.level = level(c);
        line.append(el('span', 'qt-key', c.key === '5h' ? '5 小时' : '每周'), el('span', 'qt-pct', c.out ? '已用尽' : `剩余 ${pct(c)}`), meter(c),
          c.resetAt > now ? resetText('qt-reset', '', c.resetAt, '重置') : el('span', 'qt-reset', '重置时间未知'));
        return line;
      });
      // A login to redo, whether a confirmed logout or found by the seat list's credential check:
      // the seat's login command, ready to copy.
      const relogin = q.authStatus === 'logged-out' || health.level === 'bad' && health.kind !== 'exhausted';
      const loginCommand = q.loginCommand || (relogin && seat ? ClaudeSeats.loginCommand(seat.id) : '');
      if (relogin) {
        if (loginCommand) {
          const login = el('span', 'qt-login'), command = el('code', 'qt-login-command', loginCommand);
          const copy = el('button', 'rail-btn quota-login-copy'); copy.type = 'button';
          const copied = Number(item.dataset.loginCopiedUntil) > now;
          copy.innerHTML = copied ? ICONS.check : ICONS.copy;
          copy.title = copied ? '已复制' : '复制登录命令'; copy.setAttribute('aria-label', copy.title);
          login.append(command, copy); lines.push(login);
          const expected = seat && config.claudeSeats.find((s) => s.id === seat.id)?.email;
          if (expected) lines.push(el('span', 'qt-note', `授权页右上角的账号要是 ${expected}`));
        }
      }
      else if (blockedOnly) lines.unshift(recovery ? resetText('qt-note out', '已用尽，预计 ', recovery, '恢复') : el('span', 'qt-note out', '已用尽，恢复时间未知'));
      else if (!q.cells.length) lines.push(el('span', 'qt-note', state === 'normal' ? '未见用尽，此来源不提供百分比' : '暂无额度数据，等待下次采样'));
      if (wrong) lines.unshift(el('span', 'qt-note out', wrong));
      // What is wrong, what was found, and what to do: first in the detail, under the name.
      if (health.level !== 'ok') {
        const what = el('span', `qt-health ${health.level}`);
        what.append(mark(), el('span', 'qt-health-text', `${health.label}：${health.reason}`));
        lines.unshift(what, el('span', `qt-note${health.level === 'bad' ? ' out' : ''}`, `要做：${health.action}`));
      }
      const warm = seat ? ClaudeSeats.warmupDetail(seat.id) : '';
      if (seat) {
        // warmupDetail = optional warm-up line + the rotation plan, whose first part repeats who is in use.
        const parts = warm.split('\n').filter(Boolean), plan = parts.pop().split(' · ').slice(1);
        if (plan.length) lines.push(el('span', 'qt-plan', `自动切换：${plan.join('；')}`));
        if (parts.length) lines.push(el('span', 'qt-plan', parts.join('；')));
      }
      const sampled = q.sampledAt ? `采样 ${Math.abs(q.sampledAt - now) > 86400000 ? `${pad(new Date(q.sampledAt).getMonth() + 1)}-${pad(new Date(q.sampledAt).getDate())} ` : ''}${hm(new Date(q.sampledAt))}${q.stale ? '（数据已旧）' : ''}` : '暂无采样';
      const meta = el('span', `qt-meta${q.stale ? ' stale' : ''}`);
      const planValue = el('span', 'qt-v', q.plan);
      if (q.planMark) { const gem = el('span', 'qt-plan-mark'); gem.innerHTML = ICONS.gem; planValue.prepend(gem); }   // what the gem on the row means
      for (const [k, v] of [['账号', q.account || '未识别'], q.plan && ['套餐', planValue], seat && ['席位', `${q.seatCode}${captain ? '（队长在用）' : ''}`],
        seat && ['目录', seat.configDir], ['来源', [q.source || '暂无', sampled].join(' · ')], ['可信度', q.confidence || '未知']].filter(Boolean)) meta.append(el('span', 'qt-k', k), typeof v === 'string' ? el('span', 'qt-v', v) : v);
      const copyFocused = document.activeElement?.classList.contains('quota-login-copy') && tip.contains(document.activeElement);
      fill(tip, [head, ...lines, meta]);
      if (copyFocused) {
        // Replacing the button removes :focus-within and hides the tooltip.
        // Focus its row first so the replacement can receive keyboard focus.
        item.focus({ preventScroll: true });
        tip.querySelector('.quota-login-copy')?.focus({ preventScroll: true });
      }
      const brief = [q.out && q.authStatus !== 'logged-out' && (recovery ? `${longReset(recovery)}恢复` : '恢复时间未知'),
        ...q.cells.map((c) => `${c.key === '5h' ? '5 小时' : '每周'}剩余 ${c.remaining}%${c.resetAt > now ? `（${shortReset(c.resetAt)} 重置）` : ''}`)].filter(Boolean).join('，');
      item.dataset.state = state;
      item.dataset.health = health.level;
      item.dataset.healthKind = health.kind;
      item.dataset.authStatus = q.authStatus || '';
      item.dataset.account = wrong ? 'mismatch' : '';
      item.dataset.loginCommand = loginCommand || '';
      tip.dataset.loginCommand = loginCommand ? 'true' : '';
      // A used-up row already says 已用尽 and when it comes back.
      const spokenHealth = health.level === 'ok' || health.kind === 'exhausted' ? '' : `${health.label}，${health.action}，`;
      item.setAttribute('aria-label', `${seat ? q.accountLabel + (q.planMark ? ` ${q.plan}` : '') : NAMES[provider]}${captain ? '（队长）' : ''}：${wrong ? wrong + '，' : ''}${spokenHealth}${q.statusText}${brief ? '，' + brief : ''}；${sampled}`);
      // Model and the full evidence line: kept for diagnosis, never shown on hover.
      item.dataset.detail = `状态：${q.statusText} · ${sampled}\n` + q.detail + warm;
      if (bar.children[index + 1] !== item) bar.insertBefore(item, bar.children[index + 1] || null);
    }

  }
  // The collapsed-sidebar gauge takes the colour of the provider closest to running out.
  const rank = { warning: 1, danger: 2, exhausted: 2 };
  const worst = summaries.map((q) => q.out ? 'exhausted' : q.state).reduce((w, st) => (rank[st] || 0) > (rank[w] || 0) ? st : w, 'normal');
  const rail = document.getElementById('quotaRailBtn');
  if (rail) rail.dataset.state = worst;
  positionQuotaDetails();
}
battery.every('statusTick', () => {
  let attn = 0;
  terms.forEach((entry, id) => {
    let text = dumpScreen(entry.term);
    const identityText = text;
    // A restored session replays the PREVIOUS run's output above a separator.
    // That old text can contain working/permission-prompt chrome; only what's
    // below the separator is live, so classification must not
    // see the replayed part. Once real output scrolls the separator out of the
    // 40-line window this is a no-op.
    text = MainCore.afterReplay(text, env.platform);
    const cmd = columns.find((c) => c.id === id)?.cmd;
    const liveText = liveStatusText(entry.term);
    // Cursor activity/readiness must share the live screen with its status dot;
    // the bounded reply tail can reach into old scrollback after a TUI clear.
    const cursorScreen = /\bcursor-agent\b/i.test(cmd || '') ? liveText : text;
    entry.lastScreen = cursorScreen;
    entry.liveScreen = liveText;   // the live screen with wrapped rows joined back: the crew map's line of news reads whole lines
    if (entry.alive) {
      const isMainCol = !!columns.find((c) => c.id === id)?.isMain;
      let st = classify(liveText, entry, cmd, isMainCol);
      if (st === 'working' || st === 'input' || st === 'quota') {
        entry.hasWorked = true;
        entry.idleTicks = 0;
        if (st === 'quota') entry.workStart = 0;
        else if (!entry.workStart) { entry.workStart = Date.now(); entry.workedMs = 0; }
      } else if (st === 'failed' || st === 'stopped') {
        entry.idleTicks = 0;
        entry.workStart = 0;
        entry.workedMs = 0;
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
      entry.backgroundOnly = backgroundOnlyState(st, isMainCol, liveText, entry, cmd);
      setDot(entry, st);
      maybeNotifyState(id, entry, st);
      if (st === 'input' && columns.find((c) => c.id === id)?.isMain) attn++;

      // Header timer: live count-up while working / waiting, "✓ total" when done.
      if (entry.timerEl) {
        let label = '';
        if (entry.workStart) label = fmtElapsed(Date.now() - entry.workStart);
        else if (entry.workedMs && entry.doneAt && Date.now() - entry.doneAt < DONE_TIMER_LINGER) label = '✓ ' + fmtElapsed(entry.workedMs);
        if (entry.timerEl.textContent !== label) entry.timerEl.textContent = label;
        entry.timerEl.classList.toggle('done', !entry.workStart && !!label);
      }
    }

    ChatUI.onTick(id, entry, cursorScreen);
    MainSession.onTick(id, entry); // heartbeat for work 队长 handed out

    // A restarted terminal replays the PREVIOUS run's output above a
    // separator. It is excluded from status classification, but remains the
    // best source for recovering the last provider/model before a fresh shell.
    updateAgentIdentityBadge(id, entry, identityText);
    if (entry.alive && entry.lastOutputAt && cursorScreen !== entry.lastQuotaScreen) {
      entry.lastQuotaScreen = cursorScreen;
      const col = columns.find((c) => c.id === id);
      const provider = AgentInfo.inferProvider(col?.cmd, text) || entry.detectedProvider;
      const footer = (entry.footerLines || []).map((line) => line.map((s) => s.text).join(''));
      const model = AgentInfo.extractModel(MainCore.afterContract(text), '', footer) || col?.agentModel || AgentInfo.extractModel('', col?.cmd);
      let sample = QuotaCore.screen(provider, MainCore.afterContract(cursorScreen), footer, entry.lastOutputAt, model);
      if (sample && provider === 'Claude') {
        const seat = QuotaCore.seatForColumn(col, QuotaCore.claudeSeats(config.claudeSeats));
        sample = seat ? { ...sample, seatId: seat.id, configDir: seat.configDir, sourceColumnId: id } : null;
      }
      const signature = sample && JSON.stringify([provider, sample.seatId, sample.model, sample.windows.map((w) => [w.label, w.remaining, w.resetText]), sample.exhausted, sample.resumed, sample.resetText]);
      // Redrawing unrelated text must not move a relative reset forward or
      // make an unchanged percentage appear freshly sampled.
      if (signature !== entry.lastQuotaObservation) {
        entry.lastQuotaObservation = signature;
        if (QuotaCore.observe(config.quotas, sample)) saveConfig();
        if (sample?.provider === 'Claude' && sample.exhausted) refreshQuota(sample.seatId).catch(() => {});
      }
    }

    ClaudeSeats.onTick(id, entry, text);

    // Sidebar live activity line (skipped while the sidebar is collapsed).
    const nav = navItems.get(id);
    if (nav && nav.sub && !config.navCollapsed) {
      const line = entry.alive ? (entry.state === 'quota' ? '额度用尽/等待' : lastActivityLine(text)) : '已退出';
      if (nav.sub.textContent !== line) nav.sub.textContent = line;
      if (nav.syncTip) nav.syncTip(line);
    }
  });
  syncNav(); // mirror status dots + active highlight into the sidebar
  renderQuotaBar();
  Sidebar.refreshTimes();
  syncBoardState();
  CrewMap.refresh();

  // Dock badge: how many agents are blocked waiting on the human.
  if (attn !== lastAttnCount) {
    lastAttnCount = attn;
    try { window.deck.setAttnCount(attn); } catch (_) {}
  }
});

// ---- Keyboard shortcuts ----
// Focus the column at index, scrolling it into view. Captured before xterm.
function focusColumnByIndex(idx) {
  const shown = deckColumns();
  const col = shown[Math.max(0, Math.min(idx, shown.length - 1))];
  if (!col) return;
  TaskBoardUI.close();
  if (activeView === 'board') {
    selectBoardNode(col.id, true);
    return;
  }
  const t = terms.get(col.id);
  if (!t) return;
  Pages.hide();
  if (zoomedId && zoomedId !== col.id) { zoomedId = col.id; updateColumnStyles(); fitAll(); }
  focusColumnInput(col.id); focusedId = col.id; scrollColumnInDeck(t.wrap); syncNav();
}
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey) return; // only plain Cmd combos
  if (e.target.closest && e.target.closest('.tbv-answer')) return; // 需要你 answer box: Cmd+Enter sends the answer
  const k = e.key;
  let handled = true;
  if (k === 'n' || k === 'N') {
    addAndFocusColumn();
  } else if (k === 'w' || k === 'W') {
    const idx = columns.findIndex((c) => c.id === focusedId);
    const deckIdx = deckColumns().findIndex((c) => c.id === focusedId);   // background sessions are not in the deck
    if (idx >= 0) { removeCol(columns[idx]); focusColumnByIndex(deckIdx >= 0 ? deckIdx : idx); }
  } else if (k === 'f' || k === 'F') {
    if (ChatUI.isChatMode(focusedId)) ChatUI.focusSearch(); else openSearch();
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
    const cur = deckColumns().findIndex((c) => c.id === focusedId);
    focusColumnByIndex((cur < 0 ? 0 : cur) + (k === 'ArrowRight' ? 1 : -1));
  } else {
    handled = false;
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);
// Text size works everywhere, including inside a terminal: capture phase runs
// before xterm's own handlers, so Ctrl+- never reaches the pty as ^_.
document.addEventListener('keydown', (e) => {
  const zd = fontSizeDelta(e);
  if (zd === null) return;
  adjustTextSize(zd);
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
  focusColumnInput(focusedId);
}
function sendBroadcast() {
  const text = bcastInput.value;
  if (!text.trim()) return;
  // Send the text and the CR as separate writes: Ink-based TUIs (Claude Code)
  // treat text+\r arriving in one chunk as a paste and insert a newline into
  // the input box instead of submitting.
  terms.forEach((t, id) => { if (t.alive) window.deck.ptyInput(id, text); });
  setTimeout(() => { terms.forEach((t, id) => { if (t.alive) window.deck.ptyInput(id, '\r'); }); }, 60);
  columns.forEach((col) => { const t = terms.get(col.id); if (t && t.alive) ChatUI.noteSent(col, text, true); });
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

// The board view opens on the 终端架构图; the old free canvas is its second tab.
function boardCanvasMode() { return CrewMap.mode() === 'canvas'; }
const crewMapHost = {
  config, terms, columnLabel, findColumn: (id) => columns.find((c) => c.id === id) || (config.archived || []).find((a) => a.id === id),
  columns: () => columns,
  mainCol: () => MainSession.mainCol(),
  mainState: () => MainSession.state(),
  isPriority: (col) => MainSession.isPriority(col),
  isHigh: (item) => MainSession.isHigh(item),
  activityLine: lastActivityLine,
  agentInfo: (col, entry) => window.AgentInfo.resolveAgentInfo(col, entry || null, null),
  renderBadge: (badgeEl, col) => window.AgentInfo.renderBadge(badgeEl, window.AgentInfo.resolveAgentInfo(col, terms.get(col.id) || null, null), 'sidebar', ClaudeSeats.described(config.claudeSeats)),
  visible: () => activeView === 'board',
  save: saveConfig,
  enterCanvas: () => { if (activeView === 'board') renderBoardGraph(); },
  leaveCanvas: () => restoreBoardTerminal(),
  // a node opens its real column; an archived one is restored first
  open: (node) => {
    if (node.kind === 'waiting') return;
    let col = columns.find((c) => c.id === node.id);
    if (!col && node.archived) col = restoreArchived(node.id, false);
    if (!col) return;
    showView('terminals');
    whenMounted(col, () => setTimeout(() => jumpToColumn(col), 40));
  },
};
// init draws the map for the first time. A throw there (2.0.2: an empty map on the hidden board view) must not stop
// this script before 任务看板, its tabs and the saved view below are set up.
try { CrewMap.init(crewMapHost); } catch (error) { console.error('终端架构图首次绘制失败：', error); }
// 任务看板 covers whichever view is showing; opening it hides any page. The
// crew map's 架构图 / 自由画布 / 任务看板 tabs and the board's own tabs switch
// between the two: the map shows the sessions running now, the board every task.
function openTaskSession(id) {
  let col = columns.find((c) => c.id === id);
  if (!col && (config.archived || []).some((a) => a.id === id)) col = restoreArchived(id, false);
  if (!col) return;
  TaskBoardUI.close();
  showView('terminals');
  whenMounted(col, () => setTimeout(() => jumpToColumn(col), 40));
}
TaskBoardUI.init({
  showToast,
  session: (id) => {
    const col = columns.find((c) => c.id === id);
    const files = (c) => (c.lastReceipt && Array.isArray(c.lastReceipt.files) ? c.lastReceipt.files : []);
    if (col) return { label: columnLabel(col), col, state: (terms.get(id) || {}).state || '', files: files(col) };
    const archived = (config.archived || []).find((a) => a.id === id);
    return archived ? { label: columnLabel(archived), col: null, state: '', files: files(archived) } : null;
  },
  prefs: () => config.taskBoardView,
  savePrefs: (prefs) => { config.taskBoardView = prefs; saveConfig(); },
  tokenPrefs: () => config.tokenUsageView,
  saveTokenPrefs: (prefs) => { config.tokenUsageView = { days: prefs.days === 30 ? 30 : 7 }; saveConfig(); },
  copy: (text) => window.deck.clipboardWrite(text),
  renderBadge: (badgeEl, col) => window.AgentInfo.renderBadge(badgeEl, window.AgentInfo.resolveAgentInfo(col, terms.get(col.id) || null, null), 'sidebar', ClaudeSeats.described(config.claudeSeats)),
  openSession: openTaskSession,
  showBoard: (mode) => {
    TaskBoardUI.close();
    if (activeView !== 'board') showView('board');
    if (CrewMap.mode() !== mode) CrewMap.setMode(mode);
  },
  onToggle: (isOpen) => {
    if (isOpen) Pages.hide();
    Sidebar.markPage(isOpen ? 'tasks' : null);
    syncChromeState();
  },
  focusToggle: () => { const b = document.getElementById('taskBoardBtn'); if (b) b.focus(); },
});
document.getElementById('boardTasksTab').addEventListener('click', () => TaskBoardUI.open());
document.getElementById('boardTokensTab').addEventListener('click', () => TaskBoardUI.open('tokens'));
// View restoration comes last because showView() closes the search/broadcast
// overlays, whose DOM bindings are initialized just above.
showView(config.activeView);
