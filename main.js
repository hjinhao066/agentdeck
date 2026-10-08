const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, dialog, clipboard, session, Notification, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { validId, trustedSender, privateFile, boundedAppend } = require('./security');
const { clearCredentials, removeCredentials, writeCredentials, ttyFromPty } = require('./board-credentials');
const { createNotifications } = require('./notifications');
const { createBarkSender, createNotifyUser } = require('./notify-user');
const { createResultMonitor } = require('./install-result');
const { createNeedsUserBark, barkEnabled, barkReady } = require('./needs-user-bark');
const { createQuotaLowBark } = require('./quota-low-bark');
const { createSeatAuthMonitor, authFailure } = require('./seat-auth-alert');
const BarkPolicy = require('./bark-policy');
const { createFileBarkDelivery } = require('./bark-delivery');
const { createCalendarCache } = require('./bark-calendar');
const { registerSideIpc, loadAllChats } = require('./side-main');
const { registerSkillsIpc } = require('./skills-core');
const { registerScheduleFeedIpc } = require('./schedule-feed');
const BoardCore = require('./board-core');
const { createCodexLauncher } = require('./codex-launch');
const ClaudeSeatsCore = require('./claude-seats-core');
const QuotaCore = require('./quota-core');
const PerpetualCaptainCore = require('./perpetual-captain-core');
const { seatEnvironment, credentialLocation, initializeOnboarding, trustWorktree: trustClaudeWorktree, registerSeatsIpc, seatInfo, readUsage } = require('./claude-seats-main');
const { createWarmupService } = require('./quota-warmup-service');
const { createQuotaWarmupRunner } = require('./quota-warmup-main');
const { occupied: occupiedClaudeSeats } = require('./quota-warmup-occupancy');

const { readLocal: readLocalQuota } = require('./quota-local');
const { readCodex: readCodexQuota } = require('./quota-codex');
const { TaskStore, localSessions } = require('./task-board');
const { TodoStore } = require('./todo-store');
const Worktree = require('./worktree-core');
const { prepareWorkspaceTrust } = require('./workspace-trust-main');
const { FleetClient, readFleetSettings, loadDevice } = require('./sync-client');
const { TaskHeartbeat } = require('./task-heartbeat');
const { createRefresh: createClaudeQuotaRefresh } = require('./quota-claude');
const { MobileWebServer, boardVersionOf, supportsLoginItem, readEndpoint, withEndpoint: withEndpointSettings, persistable } = require('./mobile-web');
const { createMemoryPressure } = require('./memory-pressure');
const Battery = require('./battery-core');
const RestartResume = require('./restart-resume');
const AgentSessions = require('./agent-sessions');
const { createExecutor: createChatGPTWebExecutor } = require('./chatgpt-web-executor');
const ReceiptListener = require('./receipt-listener-core');
let receiptListeners = null;
let chatgptWebExecutor = null;
let mainWindow = null;
let notifications = null;
let notifyUser = null;
let sidePane = null;
let claudeQuotaRefresh = null, claudeQuotaTimer = null;
let quotaWarmup = null, quotaWarmupRunner = null, quotaWarmupTimer = null;
let seatAuth = null;
const seatAuthChecks = new Map();
let barkCalendar = null, barkDelivery = null, barkPumpTimer = null;

let pendingFocusColumn = null;
let mobileWeb = null;
const mobileRequests = new Map();
function requestMobile(op, input) {
  if (!mainWindow || mainWindow.isDestroyed() || !boardRendererReady) return Promise.reject(new Error('AgentDeck 尚未准备好，请稍后刷新。'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { mobileRequests.delete(id); reject(new Error('AgentDeck 响应超时，请稍后重试。')); }, 5000);
    mobileRequests.set(id, { resolve, reject, timer });
    send('mobile-web:request', { id, op, input });
  });
}

// Isolated test instance: `AgentDeck.exe --test-user-data=<absdir>` runs with
// its own userData (own config/sessions AND own single-instance lock), so an
// end-to-end test deck can run alongside the real one without touching it.
const tudArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--test-user-data='));
if (tudArg) app.setPath('userData', tudArg.slice('--test-user-data='.length));
// Test profiles must never write the user's shared board.
function readLocalConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
const taskStore = new TaskStore(tudArg ? path.join(app.getPath('userData'), 'tasks') : undefined, { sessions: () => localSessions(readLocalConfig()) });
// 随手记待办: ~/.agents/boards/todos (each computer writes only its own file);
// a test profile keeps its own copy inside the profile.
const todoStore = new TodoStore(tudArg ? path.join(app.getPath('userData'), 'todos') : undefined);
let todoWatch = null, todoWatchTimer = null;
function todosChanged() { send('todos:changed', {}); }
// The other computer's file arrives through git; tell the page so an open list refreshes.
function watchTodos() {
  if (todoWatch) return;
  try {
    fs.mkdirSync(todoStore.dir, { recursive: true });
    todoWatch = fs.watch(todoStore.dir, () => { clearTimeout(todoWatchTimer); todoWatchTimer = setTimeout(todosChanged, 300); });
    todoWatch.on('error', () => { try { todoWatch.close(); } catch (_) {} todoWatch = null; });
  } catch (_) { todoWatch = null; }
}
handleMain('todos:request', (_event, payload) => {
  if (!payload || !['list', 'add', 'update', 'remove'].includes(payload.op)) throw new Error('Invalid to-do operation.');
  const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
  if (payload.op === 'list') return { items: todoStore.list() };
  // The desktop page never writes on the phone's behalf, and never touches the AI flag.
  const item = payload.op === 'add' ? todoStore.add({ text: input.text })
    : payload.op === 'remove' ? todoStore.remove({ id: input.id })
      : todoStore.update({ id: input.id, ...(input.text !== undefined ? { text: input.text } : {}), ...(input.done !== undefined ? { done: input.done } : {}), ...(input.deleted !== undefined ? { deleted: input.deleted } : {}) });
  todosChanged();
  return { item };
});
let fleetClient = null;
let notifyNeedsUserCards = () => {};
handleMain('task-board:request', (_event, payload) => {
  if (!payload || !['list', 'add', 'move', 'archive', 'update', 'priority', 'reorder', 'bind', 'event', 'dispatch', 'claim', 'dispatched', 'dispatchWait', 'dispatcherReceipt', 'identity', 'resumeNote', 'reviewDispatched', 'reviewBlocked', 'reworkDispatched', 'noteWorktree'].includes(payload.op)) throw new Error('Invalid task board operation.');
  const result = taskStore[payload.op](payload.input || {});
  if (fleetClient && payload.op !== 'list') fleetClient.noteResult(result);
  return result;
});
handleMain('worktree:prepare', async (_event, payload) => {
  if (!payload || typeof payload !== 'object' || typeof payload.repo !== 'string') throw new Error('Invalid worktree request.');
  const prepared = Worktree.prepare({
    repo: payload.repo,
    base: typeof payload.base === 'string' ? payload.base : '',
    branch: typeof payload.branch === 'string' ? payload.branch : '',
    taskId: typeof payload.taskId === 'string' ? payload.taskId : '',
  });
  // A Claude session in the new copy would stop on "trust this folder" (default row: No, exit).
  // Record the answer for this one directory in the seat that will run it, before the session opens.
  if (typeof payload.seatId === 'string' && typeof payload.configDir === 'string' && payload.configDir) {
    const seatHome = tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME;
    const trust = await trustClaudeWorktree({ id: payload.seatId, configDir: payload.configDir }, seatHome, prepared.path, { root: Worktree.defaultRoot(HOME), platform: process.platform });
    if (!trust.ok) nlog(`worktree trust not recorded: ${trust.reason}`);
    return { ...prepared, trust: { ok: trust.ok, reason: trust.reason || '' } };
  }
  return prepared;
});
handleMain('worktree:reclaim', (_event, payload) => {
  const record = payload && payload.record;
  if (!record || typeof record !== 'object') throw new Error('Invalid worktree record.');
  return Worktree.reclaim(record);
});
handleMain('fleet:state', () => fleetClient ? fleetClient.snapshot() : { configured: false, devices: [], history: [], error: null, conflictCount: 0, selfId: null, lastSyncAt: null });

// Every privileged channel belongs exclusively to the local deck main frame.
// Native notifications are created here, never in a page.
const mainPage = path.join(__dirname, 'index.html');
function validMessage(payload) {
  if (payload && typeof payload === 'object') {
    if ('id' in payload && !validId(payload.id)) return false;
    if ('data' in payload && (typeof payload.data !== 'string' || payload.data.length > 1000000)) return false;
    if ('cols' in payload && (!Number.isInteger(payload.cols) || payload.cols < 1 || payload.cols > 1000)) return false;
    if ('rows' in payload && (!Number.isInteger(payload.rows) || payload.rows < 1 || payload.rows > 1000)) return false;
  }
  return true;
}
function onMain(channel, handler) {
  ipcMain.on(channel, (event, payload) => {
    if (!trustedSender(event, mainWindow, mainPage) || !validMessage(payload)) {
      event.returnValue = null;
      return;
    }
    try { handler(event, payload); } catch (error) { nlog(`IPC ${channel}: ${error.message}`); event.returnValue = null; }
  });
}
function handleMain(channel, handler) {
  ipcMain.handle(channel, (event, payload) => {
    if (!trustedSender(event, mainWindow, mainPage) || !validMessage(payload)) throw new Error('Rejected IPC');
    return handler(event, payload);
  });
}
const memoryPressure = createMemoryPressure({ platform: process.platform, execFile });
handleMain('memory-pressure', () => memoryPressure.read());

// Battery mode: the page decides what to limit; main only needs the power source and the
// setting to pace its own timers (`power.every`) and to tell the page when the source changes.
// Test instances start on AC unless AGENTDECK_TEST_POWER=battery, and take on-battery /
// on-ac from powerMonitor like a real one, so a test can emit them.
const power = Battery.create();
function initPower() {
  let onBattery = false;
  try { onBattery = tudArg ? process.env.AGENTDECK_TEST_POWER === 'battery' : powerMonitor.isOnBatteryPower(); } catch (_) {}
  power.set({ onBattery });
  const changed = (on) => { if (power.set({ onBattery: on })) send('power:changed', { onBattery: on }); };
  powerMonitor.on('on-battery', () => changed(true));
  powerMonitor.on('on-ac', () => changed(false));
  // A plug/unplug while asleep can come without an event: ask again on wake (one local query).
  // A failed read counts as plugged in. Test instances keep the state their events set.
  const recheck = () => { if (tudArg) return; let on = false; try { on = powerMonitor.isOnBatteryPower() === true; } catch (_) {} changed(on); };
  powerMonitor.on('resume', recheck);
  powerMonitor.on('unlock-screen', recheck);
  // Sleep and wake, stamped here because the page is frozen while the machine sleeps
  // and only hears of them afterwards. A waiting `receipts --wait` must not look
  // abandoned just because the clock jumped.
  powerMonitor.on('suspend', () => send('power:sleep', { asleep: true, at: Date.now() }));
  powerMonitor.on('resume', () => { receiptListeners?.wake(); send('power:sleep', { asleep: false, at: Date.now() }); });
}
onMain('power-state', (e) => { e.returnValue = { onBattery: power.snapshot().onBattery }; });

// node-pty is a native module compiled against a specific Electron/Node ABI.
// After an Electron upgrade without a rebuild, requiring it throws and the app
// would otherwise just show a blank window. Surface a clear, actionable error.
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  dialog.showErrorBox(
    'AgentDeck 启动失败：node-pty 需要重新编译',
    '原生模块 node-pty 与当前 Electron 版本不匹配（通常是 Electron 升级后没重建）。\n\n' +
    '修复：在项目目录运行\n  cd ~/agentdeck && npm run rebuild\n\n' +
    '错误详情：\n' + (err && err.message ? err.message : String(err)),
  );
  app.exit(1);
}

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const HOME = os.homedir();

// Retired watch-ai spool directory, kept only to remove old column dumps.
const WATCH_SPOOL = path.join(HOME, '.local', 'share', 'watch-ai', 'agentdeck');
const spoolPath = (id) => privateFile(WATCH_SPOOL, id);

// Notification-chain diagnostic log (%TEMP%\agentdeck-notify.log): every column
// state transition the renderer sees + every popup spawn attempt. The popup
// path is invisible when it fails (try/catch everywhere), so this is the only
// way to tell "classify never flipped" from "spawn silently died".
const NOTIFY_LOG = path.join(os.tmpdir(), 'agentdeck-notify.log');
function nlog(m) {
  try {
    const st = fs.existsSync(NOTIFY_LOG) && fs.statSync(NOTIFY_LOG);
    if (st && st.size > 512 * 1024) fs.unlinkSync(NOTIFY_LOG);
  } catch (_) {}
  try { fs.appendFileSync(NOTIFY_LOG, new Date().toISOString().slice(11, 19) + ' ' + m + '\n'); } catch (_) {}
}

// When launched from Finder the GUI PATH is minimal, so tmux/claude/etc. aren't
// found. Prepend the usual homebrew + user bin dirs so columns can run them.
function buildEnv() {
  const env = { ...process.env };
  // Prepend the usual Unix bin dirs only on macOS/Linux. On Windows PATH uses
  // ';' separators and entries like "C:\…" contain ':', so splitting on ':'
  // would shred it — and the GUI PATH there already finds node/claude/etc.
  if (!isWin) {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), '/usr/bin', '/bin'];
    const cur = (env.PATH || '').split(':');
    env.PATH = [...extra, ...cur].filter((p, i, a) => p && a.indexOf(p) === i).join(':');
  }
  env.TERM = 'xterm-256color';

  // GUI apps launched from Finder/Dock don't inherit the shell's locale, so the
  // pty starts in the C locale and any Chinese the programs emit is decoded as
  // mojibake — both on screen and when copied. Force a UTF-8 locale (matching
  // the user's shell) so multibyte text round-trips. LC_CTYPE governs character
  // encoding; we also set LANG but leave LC_ALL alone so it doesn't stomp other
  // locale categories the user may have set.
  const UTF8 = 'en_US.UTF-8';
  env.LANG = UTF8;
  env.LC_CTYPE = UTF8;

  // Color-capable env, forced. GUI apps — and apps relaunched from a tool shell
  // (e.g. an agent terminal that exports NO_COLOR=1 / FORCE_COLOR=0 / TERM=dumb
  // to keep its own output clean) — can inherit color-killing vars. Passed into
  // a pty, those make every CLI (claude, grok, …) render monochrome. Strip them
  // and force colors on so the agents' TUIs keep their colors no matter how
  // AgentDeck was launched. (TERM is already set to xterm-256color above.)
  delete env.NO_COLOR;
  env.FORCE_COLOR = '1';
  env.CLICOLOR = '1';
  env.COLORTERM = 'truecolor';

  // When AgentDeck itself was launched from a terminal (`open` during dev),
  // Apple Terminal's session vars leak through. /etc/zshrc_Apple_Terminal sees
  // TERM_SESSION_ID and runs its session-restore inside every column's shell,
  // printing `rm: ~/.zsh_sessions/...: No such file or directory` on startup.
  delete env.TERM_SESSION_ID;
  delete env.SHELL_SESSION_ID;
  delete env.ITERM_SESSION_ID;

  // Deck columns are independent user sessions, even if an agent launched the
  // app. Child-session flags would disable the CLI's own transcript/history.
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDE_CODE_SKIP_PROMPT_HISTORY;

  // The chat footer uses a smaller font than xterm. Let ccstatusline emit the
  // whole line instead of replacing its suffix with dots at the PTY width;
  // xterm wraps it and the footer joins wrapped rows, then clips at its edge.
  env.CCSTATUSLINE_WIDTH = '4096';

  return env;
}
const ENV = buildEnv();

// Each column is just an independent shell process. One dying never touches the
// others — close it and open a fresh one. (No tmux: kept deliberately simple.)
// Windows columns run PowerShell, NOT cmd.exe: the agent launchers are
// PowerShell-flavored (`claude` is a .ps1) and the user drives columns with
// PowerShell syntax (Set-Location, ';'). cmd.exe chokes on both. Resolve the
// always-present Windows PowerShell 5.1 by absolute path so we never depend on
// COMSPEC (which points at cmd.exe) or PATH.
function shellFile() {
  if (isWin) {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(ps) ? ps : 'powershell.exe';
  }
  return ENV.SHELL || '/bin/zsh';
}

// One-letter launchers, injected into every Windows PowerShell column so an
// agent starts by typing a single letter + Enter:
//   c → Claude (in the playground repo)   a → Antigravity   g → Grok
// Defined at global scope so they survive into the interactive session, and
// shipped via -EncodedCommand (base64 of UTF-16LE) so no shell-quoting can
// mangle the braces/quotes/semicolons. -NoExit keeps the prompt afterwards;
// the profile still loads (no -NoProfile), then these override anything.
function shellArgs() {
  if (!isWin) return [];
  const init = [
    `function global:c { Set-Location 'D:\\aiproject\\playground'; ${BoardCore.commandForAgent('claude')} }`,
    `function global:a { ${BoardCore.commandForAgent('agy')} }`,
    `function global:g { ${BoardCore.commandForAgent('grok')} }`,
    "Write-Host 'AgentDeck shortcuts:  c = Claude   a = Antigravity   g = Grok' -ForegroundColor DarkGray",
  ].join('; ');
  const b64 = Buffer.from(init, 'utf16le').toString('base64');
  return ['-NoLogo', '-NoExit', '-EncodedCommand', b64];
}

const codexLauncher = createCodexLauncher({ shell: shellFile(), env: ENV });
const ptyLaunchDirs = new Map();
handleMain('pty:prepare-launch', async (_event, { id, command }) => {
  if (!ptys.has(id) || typeof command !== 'string' || command.length > 1000 || /[\x00-\x1f\x7f]/.test(command)) throw new Error('Invalid launch command');
  const cwd = ptyLaunchDirs.get(id);
  const column = readLocalConfig().columns?.find((c) => c.id === id);
  const trustHome = tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME;
  const prepared = prepareWorkspaceTrust(command, column, cwd, trustHome);
  if (prepared.warning) send('toast', { text: prepared.warning });
  return codexLauncher.prepare(prepared.command, cwd);
});

const ptySeats = new Map();
const ptys = new Map(); // columnId -> pty process
const managedSessions = new Map(); // columnId -> unguessable board-control token
const receiptSessions = new Map(); // every column: submission only, never control
let boardControlDir = '';
let boardCliPath = '';
let boardRendererReady = false;
const pendingBoardCommands = new Map(); // requestId -> { command, delivered }

// --- Hot-reload support: buffer recent pty output so the renderer can replay
// it after a webContents.reload() without losing visible terminal content. ---
const ptyBuffers = new Map(); // columnId -> { chunks: string[], totalSize: number }
const PTY_BUFFER_MAX = 200_000; // ~200 KB per pty (plenty for a full screen)

function bufferAppend(id, data) {
  let buf = ptyBuffers.get(id);
  if (!buf) { buf = { chunks: [], totalSize: 0, sequence: 0 }; ptyBuffers.set(id, buf); }
  boundedAppend(buf, data, PTY_BUFFER_MAX);
  return ++buf.sequence;
}

function spawnPty(id, cwd, cols, rows, managed, seatId, configDir) {
  if (!validId(id) || ptys.size >= 100) return;
  // Captain notifications replace legacy watch-ai spools, avoiding double
  // alerts and persistent plaintext terminal output in a shared directory.
  try { fs.unlinkSync(spoolPath(id)); } catch (_) {}
  const seatHome = tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME;
  let selectedSeat, binding;
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    selectedSeat = configDir ? { id: seatId, configDir } : ClaudeSeatsCore.normalize(cfg.claudeSeats).find((s) => s.id === (seatId || cfg.activeClaudeSeatId || 'cn'));
    if (!selectedSeat) throw new Error('席位不存在');
    binding = credentialLocation(selectedSeat, seatHome).keychainService;
  } catch (_) {
    send('pty:data', { id, data: '\r\n[AgentDeck] 席位配置无效，请检查席位设置。\r\n' });
    send('pty:exit', { id }); return;
  }
  if (ptys.has(id)) {
    if (ptySeats.get(id) === binding) return;
    killPty(id, true);
  }
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  if (selectedSeat && !credentialLocation(selectedSeat, seatHome).isDefault) initializeOnboarding(selectedSeat, seatHome, dir);
  if (selectedSeat) quotaWarmup?.cancel(selectedSeat.id);

  const token = managed ? crypto.randomBytes(24).toString('hex') : '';
  const receiptToken = crypto.randomBytes(24).toString('hex');
  receiptSessions.set(id, receiptToken);
  if (token) managedSessions.set(id, token);
  else managedSessions.delete(id);
  let terminalEnv = { ...AgentSessions.clearInheritedSessionIds(ENV), AGENTDECK_COL_ID: id, AGENTDECK_TERMINAL_ID: id };
  terminalEnv = seatEnvironment(terminalEnv, selectedSeat, seatHome);

  // Never inherit an outer deck's managed capability into an independent shell.
  for (const key of ['AGENTDECK_MANAGED', 'AGENTDECK_CONTROL_TOKEN', 'AGENTDECK_RECEIPT_TOKEN', 'AGENTDECK_CONTROL_DIR', 'AGENTDECK_BOARD_CLI']) delete terminalEnv[key];
  terminalEnv.AGENTDECK_RECEIPT_TOKEN = receiptToken;
  terminalEnv.AGENTDECK_CONTROL_DIR = boardControlDir;
  terminalEnv.AGENTDECK_BOARD_CLI = boardCliPath;
  terminalEnv.AGENTDECK_NATIVE_NOTIFICATIONS = '1';
  if (token) {
    terminalEnv.AGENTDECK_MANAGED = '1';
    terminalEnv.AGENTDECK_CONTROL_TOKEN = token;
    terminalEnv.AGENTDECK_CONTROL_DIR = boardControlDir;
    terminalEnv.AGENTDECK_BOARD_CLI = boardCliPath;
  }
  let p;
  try {
    p = pty.spawn(shellFile(), shellArgs(), {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: dir,
      // AGENTDECK_COL_ID rides down to whatever runs in the column (agents,
      // their hooks, …) so an external notifier can say "jump to THIS column"
      // by relaunching us with --focus-column=<id> (see second-instance).
      env: terminalEnv,
    });
  } catch (err) {
    managedSessions.delete(id);
    receiptSessions.delete(id);
    removeCredentials(boardControlDir, id);
    // Spawn can fail (fd exhaustion, bad shell). Surface it in the column
    // instead of throwing inside the IPC handler and crashing the main process.
    send('pty:data', { id, data: `\r\n[AgentDeck] shell 启动失败: ${err.message}\r\n` });
    send('pty:exit', { id, reason: `shell 启动失败: ${err.message}` });
    return;
  }
  // A bad cwd exits before the next turn of the event loop. Listen first;
  // writing the tty credential does disk I/O and would miss that exit.
  const tty = ttyFromPty(p);
  ptys.set(id, p);
  ptyLaunchDirs.set(id, dir);
  ptySeats.set(id, binding);
  p.onData((data) => { const sequence = bufferAppend(id, data); send('pty:data', { id, data, sequence }); });
  p.onExit(({ exitCode, signal }) => {
    // Ignore a late exit from an older PTY generation. This matters if a
    // column is respawned quickly with the same id.
    if (ptys.get(id) === p) {
      chatgptWebExecutor?.cancel(id);
      writeSession(id, ptyBuffers.get(id));
      ptys.delete(id);
      ptyLaunchDirs.delete(id);
      ptySeats.delete(id);
      managedSessions.delete(id);
      receiptListeners?.remove(id);
      receiptSessions.delete(id);
      removeCredentials(boardControlDir, id);
      if (notifications) notifications.cancel(id);
      // Keep the frozen buffer until the column is explicitly removed. It lets
      // a renderer reload still show an exited terminal's useful final output.
      send('pty:exit', { id, reason: `终端进程退出（exit ${exitCode}${signal ? `，signal ${signal}` : ''}）` });
    }
  });
  try { writeCredentials(boardControlDir, id, receiptToken, token, tty); }
  catch (_) { removeCredentials(boardControlDir, id); }
}

function send(channel, payload) {
  const w = mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function killPty(id, keepReplay) {
  chatgptWebExecutor?.cancel(id);
  if (notifications) notifications.cancel(id);
  // Archived sessions keep their last output so restoring replays it.
  if (keepReplay) writeSession(id, ptyBuffers.get(id));
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); }
  ptyLaunchDirs.delete(id);
  ptyBuffers.delete(id);
  ptySeats.delete(id);
  managedSessions.delete(id);
  receiptListeners?.remove(id);
  receiptSessions.delete(id);
  removeCredentials(boardControlDir, id);
  try { fs.unlinkSync(spoolPath(id)); } catch (_) {} // drop its watch-ai spool
}

function boardResponsePath(requestId) {
  if (!validId(requestId)) return null;
  return path.join(boardControlDir, 'responses', `${requestId}.json`);
}

function writeBoardResponse(requestId, payload) {
  const file = boardResponsePath(requestId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    // Windows rename does not replace an existing file. A long-running
    // create-child request is first written as done:false, then done:true.
    try { fs.unlinkSync(file); } catch (_) {}
    fs.renameSync(tmp, file);
  } catch (_) {}
}

let processingBoardRequests = false;
function dispatchPendingBoardCommands() {
  for (const [id, pending] of pendingBoardCommands) {
    if (pending.listenerLease && !receiptListeners?.isCurrent(pending.command.callerId, pending.listenerLease)) {
      pendingBoardCommands.delete(id);
      writeBoardResponse(id, { done: true, result: '', listenerStopped: true });
      continue;
    }
    if (pending.command.action === 'main-receipts' && pending.command.wait && Date.now() >= pending.command.expiresAt) {
      pendingBoardCommands.delete(id);
      continue;
    }
    if (!boardRendererReady || pending.delivered) continue;
    pending.delivered = true;
    send('board:command', pending.command);
  }
}

// A long silence between two passes means the machine slept. Every listener was frozen
// with it, so none may look abandoned when this pass runs the registry's expiry check.
let lastBoardPassAt = 0;
function processBoardRequests() {
  if (processingBoardRequests || !boardControlDir) return;
  processingBoardRequests = true;
  const passAt = Date.now();
  if (lastBoardPassAt && passAt - lastBoardPassAt > 20_000) receiptListeners?.wake();
  lastBoardPassAt = passAt;
  try {
    const dir = path.join(boardControlDir, 'requests');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir).slice(0, 64)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      let request;
      try {
        const stat = fs.lstatSync(file);
        // 2 MB: room for long tasks 队长 hands out (they become files further on)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid request file');
        request = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!request || typeof request !== 'object' || !validId(request.id) || name !== `${request.id}.json`) throw new Error('Invalid request');
      }
      catch (_) { try { fs.unlinkSync(file); } catch (_) {} continue; }
      try { fs.unlinkSync(file); } catch (_) {}
      const action = String(request.action || '');
      const submitOnly = Array.from(receiptSessions.entries()).find(([, token]) => token === request.token);
      const caller = Array.from(managedSessions.entries()).find(([, token]) => token === request.token) || submitOnly;
      if (!caller) {
        writeBoardResponse(request.id, { done: true, error: 'Control request rejected: terminal is not conductor-managed.' });
        continue;
      }
      let dispatchCard;
      try { dispatchCard = action === 'main-new' && submitOnly && taskStore.list().find((c) => c.dispatch_session_id === caller[0] && c.id === request.boardId); }
      catch (error) { writeBoardResponse(request.id, { done: true, error: error.message }); continue; }
      if (submitOnly && !dispatchCard && !['complete', 'ask', 'progress', 'session-exit'].includes(action)) {
        writeBoardResponse(request.id, { done: true, error: 'Receipt capability allows only complete, ask and progress; it cannot control other sessions.' });
        continue;
      }
      if (action === 'session-exit' && Number.isInteger(request.code)) receiptListeners?.remove(caller[0], managedSessions.get(caller[0]));
      if (action === 'main-receipts' && request.wait && !receiptListeners?.register(caller[0], request.token, request.listener)) {
        writeBoardResponse(request.id, { done: true, result: '', listenerStopped: true });
        continue;
      }
      // main-* actions are honored only for the 队长 (main session) column; the renderer
      // checks the caller before doing anything.
      if (!['create-child', 'spawn-child', 'wait', 'send', 'progress', 'complete', 'ask', 'session-exit', 'status',
        'main-ledger', 'main-quota', 'main-briefing', 'main-handoff', 'main-task', 'main-queue', 'main-new', 'main-tell', 'main-read', 'main-peek', 'main-receipts', 'main-receipts-snapshot', 'main-receipts-ack', 'main-answer', 'main-stop', 'main-archive', 'main-notify-user', 'main-discuss-receipt', 'main-inbox'].includes(action)) {
        writeBoardResponse(request.id, { done: true, error: `Unsupported board action: ${action}` });
        continue;
      }
      const listenerLease = action === 'main-receipts' && request.wait ? request.listener : null;
      delete request.token;
      delete request.listener; // Listener process identity stays in the main process.
      delete request.nativeSeatAuth; // This marker is set only by the main process.
      if (pendingBoardCommands.size >= 256) {
        writeBoardResponse(request.id, { done: true, error: 'Board request queue is full. Retry later.' });
        continue;
      }
      const command = { ...request, callerId: caller[0], submitOnly: !!submitOnly, dispatcherCardId: dispatchCard ? dispatchCard.id : '' };
      // Do not discard an authenticated request while the renderer is loading.
      // It stays here until the renderer acknowledges it with board:response;
      // board:ready replays pending commands after a hot reload.
      if (!pendingBoardCommands.has(command.id)) {
        pendingBoardCommands.set(command.id, { command, delivered: false, ...(listenerLease ? { listenerLease } : {}) });
      }
    }
    dispatchPendingBoardCommands();
  } catch (_) {
  } finally {
    processingBoardRequests = false;
    receiptListeners?.reap(managedSessions.values());
    receiptListeners?.tick(managedSessions.keys());
  }
}

function setupBoardControl() {
  boardControlDir = path.join(app.getPath('userData'), 'board-control');
  const requestDir = path.join(boardControlDir, 'requests');
  const responseDir = path.join(boardControlDir, 'responses');
  const toolsDir = path.join(boardControlDir, 'tools');
  try {
    fs.mkdirSync(boardControlDir, { recursive: true, mode: 0o700 });
    if (!isWin) fs.chmodSync(boardControlDir, 0o700);
    fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(responseDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
    // Requests cannot survive an app restart because their caller PTY and
    // in-memory capability token cannot survive it either.
    for (const dir of [requestDir, responseDir]) {
      for (const file of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch (_) {}
      }
    }
    clearCredentials(boardControlDir);
    const listenerInstance = ReceiptListener.initialize(boardControlDir);
    receiptListeners = ReceiptListener.createRegistry(boardControlDir, listenerInstance, (callerId, alive) => {
      // At most one undelivered status per Captain while the renderer reloads.
      for (const [id, pending] of pendingBoardCommands) {
        if (pending.command.action === 'main-receipt-listener-status' && pending.command.callerId === callerId) pendingBoardCommands.delete(id);
      }
      const id = 'listener-status-' + crypto.randomBytes(12).toString('hex');
      pendingBoardCommands.set(id, { command: { id, callerId, action: 'main-receipt-listener-status', alive, nativeWeb: true }, delivered: false });
      dispatchPendingBoardCommands();
    });
    for (const file of ['board-credentials.js', 'security.js', 'chatgpt-web-core.js', 'chatgpt-web-executor.js', 'receipt-listener-core.js', 'worktree-core.js',
      'discussion-command.js', 'discussion-runner.js', 'discussion-core.js', 'discussion-store.js', 'discussion-privacy.js', 'discussion-participants.js',
      'claude-seats-core.js', 'claude-seats-main.js', 'quota-claude.js', 'quota-core.js', 'quota-codex.js', 'relay-handoff-core.js',
      'side-main.js', 'chat-core.js', 'main-core.js', 'auto-verify-core.js']) fs.copyFileSync(path.join(__dirname, file), path.join(toolsDir, file));
    // chat-core.js reads its Markdown and file-kind rules from the phone hub's rule file, at this relative path.
    fs.mkdirSync(path.join(toolsDir, 'mobile-web', 'hub'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'mobile-web', 'hub', 'core.js'), path.join(toolsDir, 'mobile-web', 'hub', 'core.js'));
    fs.copyFileSync(path.join(__dirname, 'docs', 'discuss.md'), path.join(toolsDir, 'discuss.md'));
    boardCliPath = path.join(toolsDir, 'agentdeck-board.js');
    fs.copyFileSync(path.join(__dirname, 'board-cli.js'), boardCliPath);
    fs.copyFileSync(path.join(__dirname, 'codex-captain-driver.js'), path.join(toolsDir, 'codex-captain-driver.js'));
    fs.copyFileSync(path.join(__dirname, 'scripts', 'codex-captain-host.js'), path.join(toolsDir, 'codex-captain-host.js'));
  } catch (err) {
    nlog(`board-control setup failed: ${err.message}`);
  }
  power.every('boardRequests', processBoardRequests);
  const heartbeat = new TaskHeartbeat(taskStore, { log: nlog, onStart: (input) => {
    if (!boardRendererReady) return false;
    send('task-board:start', input);
    return false; // Renderer acknowledges through the durable dispatched marker.
  }, onChange: () => { send('task-board:changed', {}); notifyNeedsUserCards(); },
  // Automatic verification: the renderer opens the reviewer / sends the rework,
  // then marks the durable claim delivered. Off when the local setting says so.
  onReview: (input) => { if (!boardRendererReady) return false; send('task-board:review', input); return false; },
  onRework: (input) => { if (!boardRendererReady) return false; send('task-board:rework', input); return false; },
  autoVerify: () => readLocalConfig().taskBoard?.autoVerify !== false });
  heartbeat.start();
  app.once('before-quit', () => heartbeat.close());
}

// Session replays: each column's recent output is saved here and written back
// into the terminal on next launch, above a separator line. Saved continuously
// (not just on quit) so an ABNORMAL exit — crash, force-quit, power loss, where
// `before-quit` never fires — still has the last seen output to replay.
let SESS_DIR;

function writeSession(id, buf) {
  if (!buf) return;
  try {
    fs.mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 });
    const file = privateFile(SESS_DIR, id);
    fs.writeFileSync(file + '.tmp', buf.chunks.join(''), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    buf.dirty = false;
  } catch (_) {}
}
// Periodically persist any column whose output changed since the last flush.
function flushSessions() {
  for (const [id, buf] of ptyBuffers) { if (buf && buf.dirty) writeSession(id, buf); }
}
setInterval(flushSessions, 3000);

// Editor CLI for Option+click "open at line". Prefer VS Code, then Cursor;
// resolved against the GUI-fixed PATH. Cached after first lookup.
let editorCliCache;
function editorCli() {
  if (editorCliCache !== undefined) return editorCliCache;
  editorCliCache = null;
  // Windows resolves CLIs via extensions (code.cmd, cursor.cmd) and splits PATH
  // on ';'. Use the platform's delimiter and try the right suffixes.
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const name of ['code', 'cursor']) {
    for (const dir of (ENV.PATH || '').split(path.delimiter)) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try { fs.accessSync(p, fs.constants.X_OK); editorCliCache = p; return p; } catch (_) {}
      }
    }
  }
  return editorCliCache;
}

// Live cwd of a column's shell (the user may have cd'd since spawn). macOS has
// no /proc, so ask lsof; only runs on a link click, so the spawn cost is fine.
function ptyCwd(id) {
  const p = id && ptys.get(id);
  if (!p || isWin) return null;
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf-8', timeout: 1500, maxBuffer: 65536 });
    const m = out.match(/^n(\/.*)$/m);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// Resolve the longest path that actually exists on disk from a best-effort
// candidate string. Clicking a path printed in terminal output is ambiguous when
// the path contains spaces: the link matcher may also capture trailing prose
// (e.g. "…/settings.json 这里") or an English connector ("…/a and …/b"). Rather
// than guess where the path ends from text alone, use the filesystem as the
// source of truth — try the whole string, then drop one space-separated token
// from the end at a time, returning the first candidate that exists. This lets
// the click land on the deepest real file/dir even with spaces + trailing text.
// Agents reference code as "file.js:406" (line) or "file.js:406:12" (line:col);
// strip that suffix when testing existence so the click lands on the file.
function stripLine(s) { return s.replace(/:\d+(?::\d+)?$/, ''); }
function tryExists(cand) {
  if (cand.length >= 2 && fs.existsSync(cand)) return cand;
  const noLine = stripLine(cand);
  if (noLine !== cand && noLine.length >= 2 && fs.existsSync(noLine)) return noLine;
  return null;
}
function resolveLongestExisting(raw, allowAncestor = true) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/^file:\/\//, '');
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  // Un-escape "\ " only on Unix — in Windows paths a backslash is the separator.
  if (!isWin) s = s.replace(/\\ /g, ' ');
  s = s.replace(/\s+$/, '');
  if (!path.isAbsolute(s)) return null; // accepts "/…" and Windows "C:\…"

  const whole = tryExists(s);
  if (whole) return whole;

  const tokens = s.split(' ');
  for (let n = tokens.length; n >= 1; n--) {
    const cand = tokens.slice(0, n).join(' ')
      .replace(/[.,;:!?)\]}>'"，。、；：！？）】」]+$/u, '');
    const hit = tryExists(cand);
    if (hit) return hit;
  }
  // A path glued to trailing CJK prose ("/path/file.js这个文件") has no space to
  // split on. Back off at each CJK character, longest prefix first, so paths
  // that themselves contain Chinese filenames still resolve to the deepest
  // real file instead of falling through to an ancestor directory.
  for (let i = s.length - 1; i > 0; i--) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(s[i])) {
      const hit = tryExists(s.slice(0, i).replace(/\s+$/, ''));
      if (hit) return hit;
    }
  }
  if (!allowAncestor) return null;
  // Nothing matched exactly — fall back to the nearest existing ancestor so the
  // click still lands somewhere sensible.
  let dir = path.dirname(stripLine(s));
  while (dir && dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
  return (dir && fs.existsSync(dir)) ? dir : null;
}

// Resolve a clicked link to a real path. Narrow columns make agent TUIs
// hard-wrap long paths across lines (real newlines, not xterm soft-wrap), so
// the matcher only ever sees the first fragment. The renderer sends up to two
// follow-up lines as `cont`; try every join (the wrap may or may not have
// consumed a space) and keep whichever candidate resolves deepest. A join only
// wins if the joined path actually exists, so unrelated next lines are inert.
function resolveClick(msg, allowAncestor) {
  const raw = (msg && msg.raw) || '';
  const isAbs = /^(file:\/\/|\/|~|[A-Za-z]:[\\/])/.test(raw);
  if (!isAbs && !(msg && msg.id)) return null;
  const anchor = (r) => (isAbs ? r : path.join(ptyCwd(msg.id) || HOME, r));
  const cont = (Array.isArray(msg && msg.cont) ? msg.cont : [])
    .slice(0, 2)
    .map((c) => String(c).replace(/^[\s│⎿>]+/u, '').slice(0, 300))
    .filter(Boolean);
  const cands = [raw];
  if (cont[0]) {
    for (const a of [raw + cont[0], raw + ' ' + cont[0]]) {
      cands.push(a);
      if (cont[1]) cands.push(a + cont[1], a + ' ' + cont[1]);
    }
  }
  // Resolve every candidate and keep the deepest hit, tracking exact hits and
  // ancestor fallbacks separately so the renderer can tell the user when the
  // clicked path itself doesn't exist (agents fabricate example paths a lot).
  // Per-candidate ancestor fallback matters: a joined path that only partially
  // exists ("…/Chrome/Default/Cache" where Cache is missing) still lands on
  // its deepest real ancestor, while nonsense joins resolve shallow and lose.
  let exact = null, anc = null;
  for (const c of cands) {
    const e = resolveLongestExisting(anchor(c), false);
    if (e && (!exact || e.length > exact.length)) exact = e;
    if (isAbs && allowAncestor) {
      const a = resolveLongestExisting(anchor(c), true);
      if (a && (!anc || a.length > anc.length)) anc = a;
    }
  }
  if (anc && (!exact || anc.length > exact.length)) return { target: anc, fallback: true };
  return exact ? { target: exact, fallback: false } : null;
}

// Open a plain directory so the user can see inside it. Judge the real path:
// a directory whose last segment has an extension (.app, .bundle, .workflow —
// any dot followed by a letter, not an allow-list) is a package and is only
// selected, as is a symlink that lands on one. A numeric tail such as
// agentdeck-1.1.9 is a version, not an extension. Files, and any realpath or
// stat failure, are selected too.
function revealOpens(target) {
  try {
    const real = fs.realpathSync(target);
    if (!fs.statSync(real).isDirectory()) return false;
    return !/^\.[A-Za-z]/.test(path.extname(path.basename(real)));
  } catch (_) {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 640,
    minHeight: 480,
    title: 'AgentDeck',
    // Tests need a visible layout, but must never activate over the user's app.
    show: !tudArg,
    focusable: !tudArg,
    backgroundColor: '#000000',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  // Tests drive the page over the DevTools protocol, not the screen: the window
  // keeps rendering but is transparent and click-through, so a test run never
  // covers the user's apps or catches their clicks.
  if (tudArg) win.once('ready-to-show', () => { hideTestWindow(win); win.showInactive(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.on('closed', () => {
    if (sidePane) sidePane.dispose();
    if (mainWindow === win) mainWindow = null;
    if (!isMac) app.quit();
  });
  win.webContents.on('did-start-loading', () => { boardRendererReady = false; });
  win.webContents.on('destroyed', () => { boardRendererReady = false; });
  win.loadFile(mainPage);
}

function hideTestWindow(win) {
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  // Set before the first show, so the invisible window never sits above the user's windows.
  if (isMac) win.setAlwaysOnTop(true, 'normal', -1);
}

function focusColumn(id) {
  if (!validId(id)) return;
  pendingFocusColumn = id;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow;
  if (win.isMinimized()) win.restore();
  if (!tudArg) {
    win.setAlwaysOnTop(true);
    win.show();
    app.focus({ steal: true });
    win.focus();
    win.setAlwaysOnTop(false);
  } else {
    win.showInactive();
  }
  if (boardRendererReady) {
    send('focus-column', { id });
    pendingFocusColumn = null;
  }
}

SESS_DIR = path.join(app.getPath('userData'), 'sessions');
const CHAT_DIR = path.join(app.getPath('userData'), 'chats');

// Two instances sharing one userData dir fight over the GPU disk cache and one
// dies with 0xc0000409 (seen on Windows, 2026-07-17). Focus the existing window
// instead of racing it.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv) => {
    const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--focus-column='));
    if (arg) focusColumn(arg.slice('--focus-column='.length));
    else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (isWin) app.setAppUserModelId('com.jinhao.agentdeck');
  if (tudArg && isMac) app.setActivationPolicy('accessory');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  initPower();
  setupBoardControl();
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try { power.set({ mode: JSON.parse(fs.readFileSync(configPath, 'utf8')).batteryMode }); } catch (_) {}
  sidePane = registerSideIpc({
    onMain, handleMain, send, session, WebContentsView,
    getWindow: () => mainWindow, resolveClick, chatDir: () => CHAT_DIR, home: HOME,
    onChatSaved: (id, chat) => {
      if (!fleetClient || typeof fleetClient.noteCaptain !== 'function') return;
      let captain = false;
      try { captain = JSON.parse(fs.readFileSync(configPath, 'utf8')).mainSession?.colId === id; } catch (_) {}
      if (captain || chat?.captainArchive === true) fleetClient.noteCaptain(id, chat);
    },
  });
  // A test profile must never list or edit the real user's skills.
  registerSkillsIpc({ handleMain, home: tudArg ? path.join(app.getPath('userData'), 'skills-home') : HOME });
  // Likewise the tasks Schedule watches: a test profile reads only its own descriptions.
  const feedHome = tudArg ? path.join(app.getPath('userData'), 'schedule-home') : HOME;
  registerScheduleFeedIpc({ handleMain, dir: path.join(feedHome, '.agents', 'schedules'), home: feedHome, userData: app.getPath('userData'), env: ENV });
  const seatHome = tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME;
  const seatConfig = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } };
  let quotaRead = null, quotaReadAt = 0, codexQuotaRead = null, codexQuotaAt = 0, quotaSeatsKey = '';
  registerSeatsIpc({ handleMain, home: seatHome, platform: tudArg ? 'test' : process.platform, env: ENV, userData: app.getPath('userData'),
    getSeats: () => seatConfig().claudeSeats, getCaptainId: () => seatConfig().mainSession?.colId,
    getColumn: (id) => seatConfig().columns?.find((c) => c.id === id),
    onUsageRecorded: () => { quotaRead = null; },
    // The Relay handoff reads the same board the heartbeat does, done and archived cards included.
    handoffOptions: { discussionsRoot: tudArg ? path.join(app.getPath('userData'), 'discussions') : undefined, cards: () => taskStore.list({ archived: true }), tasksDir: taskStore.dir, boardVersion: () => boardVersionOf(taskStore.dir),
      machine: { platform: process.platform, hostname: os.hostname(), appVersion: app.getVersion() } } });
  let quotaSeatConfig;
  let notificationConfig = {};
  try { notificationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  let mobileSettings = notificationConfig.mobileWeb || { enabled: false };
  // The tunnel installer supplies only the public origin and this machine's
  // phone-entry name and path prefix, never login secrets. The prefix and name
  // come from endpoint.json on every (re)configure and are never kept in
  // config.json, so a rollback is one edit to endpoint.json. A malformed prefix
  // is passed on as-is so the service refuses to start rather than ignoring it.
  const endpointFile = path.join(HOME, '.config', 'agentdeck-remote', 'endpoint.json');
  const withEndpoint = (settings) => tudArg ? settings : withEndpointSettings(settings, readEndpoint(endpointFile));
  mobileSettings = withEndpoint(mobileSettings);
  const loginItemMessage = process.platform === 'win32' ? '请在 Windows 设置的「启动」应用中允许 AgentDeck 自动启动。' : '请在 macOS 登录项中允许 AgentDeck 自动启动。';
  let mobileInitializing = true;
  let mobileStartupError = '';
  mobileWeb = new MobileWebServer({
    getSessions: () => requestMobile('sessions'),
    getTasks: () => taskStore.list(),
    // The phone records, reads and ticks to-dos; it never edits text or deletes.
    getTodos: () => todoStore.phone(),
    writeTodos: (input) => {
      const item = input.op === 'add' ? todoStore.add({ text: input.text, source: 'phone' })
        : todoStore.update({ id: input.id, done: input.done, ...(input.base ? { base: input.base } : {}), source: 'phone' });
      todosChanged();
      return { id: item.id, text: item.text, done: item.done, doneAt: item.doneAt, created: item.created, updated: item.updated };
    },
    getOutput: (id) => requestMobile('output', { id }),
    getCaptain: async () => {
      const data = await requestMobile('captain-history');
      for (const turn of data.turns || []) {
        const file = turn.longFile; delete turn.longFile;
        // Only a file this app saved itself; the clipped text stays if it is gone.
        if (!file || path.dirname(path.resolve(String(file))) !== path.join(app.getPath('userData'), 'long-prompts')) continue;
        try { turn.user = fs.readFileSync(file, 'utf8').slice(0, 20000); } catch (_) {}
      }
      return data;
    },
    getQuota: () => requestMobile('quota'),
    sendCaptain: (message, images) => requestMobile('captain', { message, images }),
    // Which account the Captain is on, and moving it to another: the desktop's own manual switch.
    getRelay: () => requestMobile('relay'),
    switchRelay: (input) => requestMobile('relay-switch', input),
    // 待我处理: the same list and actions as the desktop page.
    getAttention: () => requestMobile('attention'),
    writeAttention: (input) => requestMobile('attention-write', input),
    // Like pasted screenshots, phone images reach the Captain as file paths.
    uploadDir: path.join(app.getPath('userData'), 'mobile-uploads'),
    // Files the phone may preview: what the conversation named, plus the report folders; this app's own data never.
    // A test profile's report folder is inside the profile.
    preview: tudArg ? { home: HOME, roots: [path.join(app.getPath('userData'), 'reports')] } : { home: HOME, denied: [app.getPath('userData')] },
    getBoardVersion: () => boardVersionOf(taskStore.dir),
    machine: { platform: process.platform, hostname: os.hostname(), appVersion: app.getVersion() },
    saveSettings: (settings) => {
      mobileSettings = settings;
      if (mobileInitializing && !settings.enabled) return;
      notificationConfig = { ...seatConfig(), mobileWeb: persistable(settings) };
      fs.writeFileSync(configPath + '.tmp', JSON.stringify(notificationConfig, null, 2), { mode: 0o600 });
      fs.chmodSync(configPath + '.tmp', 0o600);
      fs.renameSync(configPath + '.tmp', configPath);
      // Restore the private web service after a Mac or Windows login. Isolated
      // tests must never change the real app's login item.
      if (!tudArg && app.isPackaged && supportsLoginItem(process.platform) && settings.enabled && settings.publicOrigin) {
        try { app.setLoginItemSettings({ openAtLogin: true }); mobileStartupError = ''; }
        catch (_) { mobileStartupError = loginItemMessage; }
      }
    },
  });
  await mobileWeb.configure(mobileSettings);
  mobileInitializing = false;
  // Only the trusted desktop settings page can enable the listener. The web
  // page has fixed read/send operations and never sees an Electron IPC bridge.
  handleMain('mobile-web:settings', async (_event, input) => {
    if (input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw new Error('Invalid mobile web setting.');
      if (typeof input.enabled === 'boolean') await mobileWeb.configure(withEndpoint({ ...mobileSettings, enabled: input.enabled }));
      else if (typeof input.publicOrigin === 'string') await mobileWeb.configure(withEndpoint({ ...mobileSettings, publicOrigin: input.publicOrigin }));
      else if (input.revoke === true) await mobileWeb.revokeDevices();
      else throw new Error('Invalid mobile web setting.');
    }
    const status = mobileWeb.status();
    status.startupError = mobileStartupError;
    if (!tudArg && app.isPackaged && supportsLoginItem(process.platform) && status.enabled && status.publicOrigin) {
      try {
        const login = app.getLoginItemSettings();
        if (!login.openAtLogin || login.status === 'requires-approval') status.startupError = loginItemMessage;
      } catch (_) { status.startupError = loginItemMessage; }
    }
    if (!tudArg && status.publicOrigin) {
      try {
        const access = JSON.parse(fs.readFileSync(path.join(HOME, '.config', 'agentdeck-remote', 'vps-access.json'), 'utf8'));
        status.gatewayUser = typeof access.username === 'string' ? access.username : '';
        status.gatewayPassword = typeof access.password === 'string' ? access.password : '';
      } catch (_) {}
    }
    return status;
  });
  onMain('mobile-web:response', (_event, payload) => {
    const pending = mobileRequests.get(payload?.requestId);
    if (!pending) return;
    mobileRequests.delete(payload.requestId); clearTimeout(pending.timer);
    if (typeof payload.error === 'string' && payload.error) pending.reject(new Error(payload.error));
    else pending.resolve(payload.result);
  });
  const barkTestClock = tudArg && process.argv.find((arg) => arg.startsWith('--test-bark-now='));
  if (barkTestClock && Number.isFinite(Number(barkTestClock.split('=')[1]))) app.testBarkNow = Number(barkTestClock.split('=')[1]);
  const barkNow = () => tudArg && Number.isFinite(app.testBarkNow) ? app.testBarkNow : Date.now();
  const barkQueuePath = path.join(app.getPath('userData'), 'bark-pending.json');
  barkCalendar = createCalendarCache({ file: path.join(app.getPath('userData'), 'bark-calendar.json'),
    getSettings: () => BarkPolicy.settings(notificationConfig.barkNotifications), now: barkNow, env: ENV,
    ...(tudArg ? { execFileImpl: (_command, _args, _options, done) => done({ code: 'ENOENT' }) } : {}) });
  if (tudArg) app.testBarkDigests = [];
  const sendBarkDigest = createBarkSender({ getConfig: () => notificationConfig,
    ...(tudArg ? { keyHome: app.getPath('userData') } : {}),
    ...(tudArg ? { fetchImpl: async (_url, options) => {
      const { device_key, ...payload } = JSON.parse(options.body);
      app.testBarkDigests.push(payload);
      return { ok: true, status: 200, json: async () => ({ code: 200 }) };
    } } : {}) });
  barkDelivery = createFileBarkDelivery({ file: barkQueuePath, now: barkNow, prepare: () => barkCalendar.refresh(),
    getSettings: () => BarkPolicy.settings(notificationConfig.barkNotifications), getClasses: (at) => barkCalendar.ranges(at),
    sendNow: sendBarkDigest, onFailure: ({ message, keys }) => {
      send('toast', { text: message });
      // A damaged/locked outbox may fail before its keys can be read. Still
      // tell the Captain that its confirmed offline seats cannot reach Bark.
      const affected = keys.length ? keys : (seatAuth?.samples() || []).filter((s) => s.authStatus === 'logged-out')
        .map((s) => `seat-auth:${s.provider}:${s.seatId}`);
      for (const key of affected) if (seatAuth?.recordDeliveryFailure(key, message)) queueAuthReceipts();
    } });
  const pumpBark = async () => {
    await barkCalendar.refresh();
    // Also retry a recovery cancellation that previously failed to write.
    for (const sample of seatAuth?.samples() || []) if (sample.authStatus === 'logged-in') {
      await barkDelivery.cancel(`seat-auth:${sample.provider}:${sample.seatId}`, () => seatAuth.samples().some((s) =>
        s.provider === sample.provider && s.seatId === sample.seatId && s.authStatus === 'logged-in'));
    }
    return barkDelivery.flush();
  };
  pumpBark().catch(() => {});
  barkPumpTimer = setInterval(() => pumpBark().catch(() => {}), 30_000); barkPumpTimer.unref();
  handleMain('bark:status', () => ({ ...barkDelivery.status(), calendar: barkCalendar.status() }));
  handleMain('bark:refresh', async () => {
    await barkCalendar.refresh(true);
    await pumpBark();
    await barkDelivery.retry();
    return { ...barkDelivery.status(), calendar: barkCalendar.status() };
  });
  if (tudArg) app.testBarkFlush = pumpBark;
  const quotaAlertPath = path.join(app.getPath('userData'), 'quota-bark-state.json');
  let quotaAlertState = {};
  try {
    if (fs.statSync(quotaAlertPath).size <= 65536) {
      const value = JSON.parse(fs.readFileSync(quotaAlertPath, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) quotaAlertState = value;
    }
  } catch (_) {}
  if (tudArg) app.testQuotaAlerts = [];
  const sendQuotaBark = createBarkSender({ getConfig: () => notificationConfig, delivery: barkDelivery,
    ...(tudArg ? { keyHome: app.getPath('userData') } : {}),
    ...(tudArg ? { fetchImpl: async (_url, options) => {
      // Test profiles never contact Bark or retain even a stand-in device key.
      const { device_key, ...payload } = JSON.parse(options.body);
      app.testQuotaAlerts.push(payload);
      return { ok: true, status: 200, json: async () => ({ code: 200 }) };
    } } : {}) });
  const quotaLowBark = createQuotaLowBark({ state: quotaAlertState, sendBark: sendQuotaBark,
    saveState: (value) => {
      fs.writeFileSync(quotaAlertPath + '.tmp', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(quotaAlertPath + '.tmp', quotaAlertPath);
    } });
  const checkQuotaBark = () => {
    try {
      quotaLowBark(notificationConfig).then((results) => {
        for (const result of results) if (!result.ok) send('toast', { text: result.message });
      }).catch(() => send('toast', { text: '额度 Bark 提醒失败，请检查本机配置。' }));
    } catch (_) { send('toast', { text: '额度 Bark 去重记录无法保存，未发送提醒。' }); }
  };
  const authStatePath = path.join(app.getPath('userData'), 'seat-auth-state.json');
  let authState = {};
  try {
    if (fs.statSync(authStatePath).size <= 1024 * 1024) {
      const value = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) authState = value;
    }
  } catch (_) {}
  const codexSeat = { id: 'codex', name: 'Codex', configDir: ENV.CODEX_HOME || '~/.codex' };
  const configuredAuthSeat = (sample) => sample.provider === 'Claude'
    ? ClaudeSeatsCore.normalize(seatConfig().claudeSeats).find((s) => s.id === sample.seatId && s.configDir === sample.configDir)
    : sample.provider === 'Codex' && sample.configDir === codexSeat.configDir ? codexSeat : null;
  const authSamples = () => seatAuth.samples().filter((s) => configuredAuthSeat(s));
  const queueAuthReceipts = () => {
    const captain = seatConfig().columns?.find((c) => c.isMain);
    if (!captain || !boardRendererReady) return;
    for (const alert of seatAuth.pendingReceipts()) {
      if (pendingBoardCommands.has(alert.id)) continue;
      pendingBoardCommands.set(alert.id, { command: { id: alert.id, callerId: captain.id, action: 'seat-auth-alert',
        nativeSeatAuth: true, alertId: alert.id, provider: alert.provider, seatId: alert.seatId, message: alert.message }, delivered: false });
    }
    dispatchPendingBoardCommands();
  };
  seatAuth = createSeatAuthMonitor({ home: HOME, state: authState,
    saveState: (value) => {
      fs.writeFileSync(authStatePath + '.tmp', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(authStatePath + '.tmp', authStatePath);
    },
    onStatus: (sample) => send('quota:updated', [sample]),
    onRecovery: (recovery) => {
      const key = `seat-auth:${recovery.provider}:${recovery.seatId}`;
      Promise.resolve().then(() => barkDelivery.cancel(key, () => seatAuth.samples().some((s) =>
        s.provider === recovery.provider && s.seatId === recovery.seatId && s.authStatus === 'logged-in'))).then((result) => {
        if (!result?.ok || result.cancelled !== true) throw new Error('Reminder cancellation not saved');
      }).catch(() => {
        const message = '席位已恢复，但旧手机提醒撤销失败，请介入检查通知队列。';
        send('toast', { text: message });
        try { seatAuth.recordDeliveryFailure(key, message, 'cancel'); queueAuthReceipts(); } catch (_) {
          send('toast', { text: '提醒撤销异常未能保存，请介入检查磁盘和通知队列。' });
        }
      });
    },
    onAlert: (alert) => {
      queueAuthReceipts();
      // Critical Bark uses the notify-user --urgent sender immediately. The
      // native reminder follows the renderer acknowledgement's visibility so
      // a focused Captain remains locally silent and never loses focus.
      const delivery = sendQuotaBark({ message: alert.message, title: 'AgentDeck · 席位掉登录', level: 'critical', dedupeKey: `seat-auth:${alert.provider}:${alert.seatId}` });
      send('toast', { text: alert.message });
      Promise.resolve(delivery).then((result) => {
        if (!result.ok) {
          const message = result.message || '手机通知发送失败，请介入检查本机 Bark 配置和通知队列。';
          send('toast', { text: message });
          try { seatAuth.recordDeliveryFailure(alert.id, message); queueAuthReceipts(); } catch (_) {
            send('toast', { text: '手机通知异常未能保存，请介入检查磁盘和通知设置。' });
          }
        }
      }).catch(() => {
        const message = '席位掉登录：手机通知发送失败，未保留，请介入检查本机 Bark 配置和通知队列。';
        send('toast', { text: message });
        try { seatAuth.recordDeliveryFailure(alert.id, message); queueAuthReceipts(); } catch (_) {
          send('toast', { text: '手机通知异常未能保存，请介入检查磁盘和通知设置。' });
        }
      });
    },
  });
  // On upgrade, a fresh, seat-bound successful quota is a prior login baseline.
  // Afterwards actual sampler proofs (and the persisted state) own recovery.
  for (const { provider, seat, key } of QuotaCore.items(seatConfig().claudeSeats)) {
    if (!['Claude', 'Codex'].includes(provider) || authState[key]) continue;
    const entry = seatConfig().quotas?.[key], sample = entry?.sample;
    if (!sample || Date.now() - sample.at > QuotaCore.freshMs(sample) || sample.at > Date.now()) continue;
    if (provider === 'Claude' && (!sample.accountBound || !sample.accountKey || sample.accountKey !== entry.accountKey || sample.configDir !== seat.configDir)) continue;
    if (provider === 'Codex' && !entry.accountKey) continue;
    seatAuth.observe(seat || codexSeat, { provider, at: sample.at, authStatus: 'logged-in' });
  }
  async function checkAuthSeat(seat, provider) {
    if (tudArg) {
      app.testSeatAuthChecks.push({ provider, seatId: seat.id });
      const sample = app.testSeatAuthProofs.shift();
      if (sample) observeAuth({ ...sample, provider, seatId: seat.id, configDir: seat.configDir });
      return;
    }
    if (provider === 'Claude') {
      await claudeQuotaRefresh?.tick({ force: true, seatId: seat.id });
      send('quota:updated', [...(claudeQuotaRefresh?.samples() || []), ...authSamples()]);
    } else await sampleCodex(true);
  }
  const observeAuth = (sample) => {
    const seat = configuredAuthSeat(sample);
    if (!seat) return;
    try {
      seatAuth.observe(seat, sample);
      const key = sample.provider === 'Claude' ? QuotaCore.seatKey(seat.id) : sample.provider;
      if (!seatAuth.needsConfirmation(seat, sample.provider)) {
        clearTimeout(seatAuthChecks.get(key)); seatAuthChecks.delete(key);
      } else if (!tudArg && !seatAuthChecks.has(key)) {
        const timer = setTimeout(() => {
          seatAuthChecks.delete(key);
          if (!configuredAuthSeat(sample)) return;
          checkAuthSeat(seat, sample.provider).catch(() => observeAuth({ provider: sample.provider,
            seatId: seat.id, configDir: seat.configDir, at: Date.now() }));
        }, seatAuth.recheckDelay(seat, sample.provider, Date.now()));
        timer.unref(); seatAuthChecks.set(key, timer);
      }
    } catch (_) { send('toast', { text: '席位登录状态记录无法保存，请检查磁盘。' }); }
  };
  async function sampleCodex(force = false) {
    if (!force && codexQuotaRead && Date.now() - codexQuotaAt < 60000) return codexQuotaRead;
    if (sampleCodex.pending) return sampleCodex.pending;
    codexQuotaAt = Date.now();
    codexQuotaRead = sampleCodex.pending = readCodexQuota(ENV).then((sample) => {
      observeAuth({ ...(sample || { provider: 'Codex', at: Date.now() }), configDir: codexSeat.configDir });
      send('quota:updated', [...(sample ? [sample] : []), ...authSamples()]);
      return sample;
    }).finally(() => { sampleCodex.pending = null; });
    return codexQuotaRead;
  }
  handleMain('seat-auth:failure', (_event, payload) => {
    if (!payload || !validId(payload.colId) || typeof payload.message !== 'string' || payload.message.length > 2 * 1024 * 1024) throw new Error('Invalid authentication failure signal.');
    if (!authFailure(payload.message)) return false;
    const column = seatConfig().columns?.find((c) => c.id === payload.colId);
    const provider = column && BoardCore.inferAgentType(column.cmd);
    const seat = provider === 'Claude' ? QuotaCore.seatForColumn(column, ClaudeSeatsCore.normalize(seatConfig().claudeSeats)) : provider === 'Codex' ? codexSeat : null;
    if (!seat) return false;
    // Receipt text can describe GitHub, a browser or even a failing test. It is
    // only a reason to query the provider; it never counts as a logout proof.
    checkAuthSeat(seat, provider).catch(() => {});
    return true;
  });
  if (tudArg) {
    app.testSeatAuthObserve = observeAuth;
    app.testSeatAuthChecks = []; app.testSeatAuthProofs = [];
    app.testSeatAuthNeedsCheck = (sample) => {
      const seat = configuredAuthSeat(sample);
      return !!seat && seatAuth.needsConfirmation(seat, sample.provider);
    };
  }
  checkQuotaBark(); // A fresh low sample at launch alerts once, across relaunches too.
  let warmupCaptain = { id: '', idle: false, at: 0, seatId: '' };
  const idleCaptainId = () => warmupCaptain.idle && Date.now() - warmupCaptain.at <= 5000 &&
    warmupCaptain.id === seatConfig().mainSession?.colId ? warmupCaptain.id : '';
  quotaWarmupRunner = createQuotaWarmupRunner({ home: seatHome, env: ENV });
  if (tudArg) { app.testWarmupRuns = []; app.testWarmupResults = []; }
  quotaWarmup = createWarmupService({
    stateFile: path.join(app.getPath('userData'), 'quota-warmup-state.json'),
    logFile: path.join(app.getPath('userData'), 'quota-warmup.log'),
    getSettings: () => seatConfig().quotaWarmup,
    getThreshold: () => PerpetualCaptainCore.normalizeSettings(seatConfig().perpetualCaptain).threshold,
    getSeats: () => ClaudeSeatsCore.normalize(seatConfig().claudeSeats),
    readSeat: async (seat) => ({ ...await seatInfo(seat, seatHome, tudArg ? 'test' : process.platform),
      quota: seatConfig().quotas?.[QuotaCore.seatKey(seat.id)], usage: readUsage(seat, seatHome) }),
    occupied: (seats) => occupiedClaudeSeats({ seats, columns: seatConfig().columns || [], ptys, home: seatHome, idleCaptainId: idleCaptainId() },
      tudArg ? async () => [] : undefined),
    run: tudArg ? async (seat) => {
      // Isolated UI tests can supply deterministic results from the Electron
      // harness; no test profile is allowed to call a real account.
      app.testWarmupRuns.push({ seatId: seat.id, configDir: seat.configDir });
      return app.testWarmupResults.shift() || { ok: false, status: 'test-disabled' };
    } : (seat, options) => quotaWarmupRunner.run(seat, options),
  });
  handleMain('seats:warmup-status', () => quotaWarmup.snapshot());
  // Reported on every status tick: parse config.json again only when the file changed.
  let warmupIdleConfig = { key: '', cfg: {} };
  handleMain('seats:warmup-idle', (_e, { colId, idle }) => {
    let key = '';
    try { const stat = fs.statSync(configPath); key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch (_) {}
    if (!key || key !== warmupIdleConfig.key) warmupIdleConfig = { key, cfg: seatConfig() };
    const cfg = warmupIdleConfig.cfg, col = cfg.columns?.find((c) => c.id === colId);
    if (!validId(colId) || colId !== cfg.mainSession?.colId || !col?.isMain || !ptys.has(colId) || typeof idle !== 'boolean') return false;
    const changed = warmupCaptain.id !== colId || warmupCaptain.idle !== idle;
    // The seat is kept here (reported every status tick) so a keystroke never rereads config.json.
    warmupCaptain = { id: colId, idle, at: Date.now(), seatId: col.claudeSeatId || cfg.activeClaudeSeatId };
    if (!idle) quotaWarmup.cancel(warmupCaptain.seatId);
    else if (changed) quotaWarmup.tick().catch(() => {});
    return true;
  });
  if (tudArg) app.testQuotaWarmup = quotaWarmup;
  quotaWarmupTimer = setInterval(() => quotaWarmup.tick().catch(() => {}), 30_000);
  quotaWarmupTimer.unref();
  if (tudArg) app.testRelayAlerts = [];
  const sendRelayBark = createBarkSender({ getConfig: () => notificationConfig, delivery: barkDelivery,
    ...(tudArg ? { keyHome: app.getPath('userData') } : {}),
    ...(tudArg ? { fetchImpl: async (_url, options) => {
      const { device_key, ...payload } = JSON.parse(options.body);
      app.testRelayAlerts.push(payload);
      return { ok: true, status: 200, json: async () => ({ code: 200 }) };
    } } : {}) });
  handleMain('captain:relay-notify', async (_e, { colId, message, urgent = false }) => {
    if (colId !== notificationConfig.mainSession?.colId || !notificationConfig.columns?.some((c) => c.id === colId && c.isMain) ||
      typeof message !== 'string' || !message.trim() || message.length > 1000 || typeof urgent !== 'boolean') throw new Error('无效队长轮换提醒');
    if (urgent) {
      // The same local + critical Bark route as notify-user --urgent, even
      // when no Captain process is able to run the board command.
      const result = await notifyUser({ callerId: colId, id: 'relay-stopped-' + colId, message, urgent: true }, false);
      return { ok: true, message: result };
    }
    return sendRelayBark({ message, title: 'AgentDeck · 永动机', level: 'active' });
  });
  const needsUserBarkPath = path.join(app.getPath('userData'), 'needs-user-bark-state.json');
  let needsUserBarkState = { entries: {} };
  let needsUserBarkStateLoaded = false;
  try {
    if (fs.statSync(needsUserBarkPath).size <= 65536) {
      const value = JSON.parse(fs.readFileSync(needsUserBarkPath, 'utf8'));
      if (value && typeof value.entries === 'object' && !Array.isArray(value.entries)) {
        const entries = {};
        for (const [id, entry] of Object.entries(value.entries)) {
          if (/^[A-Za-z0-9_-]{1,160}$/.test(id) && typeof entry === 'string' && entry.length <= 200) entries[id] = entry;
        }
        needsUserBarkState = { entries };
        needsUserBarkStateLoaded = true;
      }
    }
  } catch (_) {}
  if (tudArg) app.testNeedsUserAlerts = [];
  const sendNeedsUserBark = createBarkSender({ getConfig: () => notificationConfig, delivery: barkDelivery,
    ...(tudArg ? { keyHome: app.getPath('userData') } : {}),
    ...(tudArg ? { fetchImpl: async (_url, options) => {
      const { device_key, ...payload } = JSON.parse(options.body);
      app.testNeedsUserAlerts.push(payload);
      return { ok: true, status: 200, json: async () => ({ code: 200 }) };
    } } : {}) });
  const observeNeedsUser = createNeedsUserBark({ state: needsUserBarkState, sendBark: sendNeedsUserBark,
    suppressInitial: !needsUserBarkStateLoaded,
    onError: (message) => send('toast', { text: message }),
    saveState: (value) => {
      fs.writeFileSync(needsUserBarkPath + '.tmp', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(needsUserBarkPath + '.tmp', needsUserBarkPath);
    } });
  notifyNeedsUserCards = () => {
    try {
      observeNeedsUser(taskStore.list(), { enabled: barkEnabled(notificationConfig), ready: barkReady(notificationConfig) });
    } catch (_) { send('toast', { text: '需要你的手机提醒没能记下，未发送。' }); }
  };
  notifyNeedsUserCards();

  onMain('load-config-sync', (e) => {
    try { e.returnValue = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : null; quotaSeatConfig = e.returnValue?.claudeSeats; }
    catch (_) { e.returnValue = null; }
  });
  const writeConfig = (cfg) => {
    cfg.mobileWeb = persistable(mobileSettings);
    quotaSeatConfig = cfg?.claudeSeats;
    notificationConfig = cfg;
    notificationConfig.barkNotifications = BarkPolicy.settings(cfg.barkNotifications);
    power.set({ mode: cfg?.batteryMode });
    if (cfg.quotaWarmup?.enabled === false) for (const seat of ClaudeSeatsCore.normalize(cfg.claudeSeats)) quotaWarmup.cancel(seat.id);
    if (notifications && cfg.captainNotifications?.enabled === false) notifications.dispose();
    // Atomic write: a crash mid-write must not corrupt config.json (which would
    // silently reset the whole deck layout to defaults on next launch).
    fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(configPath + '.tmp', 0o600);
    fs.renameSync(configPath + '.tmp', configPath);
    checkQuotaBark();
    queueAuthReceipts();
    pumpBark().catch(() => {});
    notifyNeedsUserCards();
  };
  onMain('save-config', (_e, cfg) => { try { writeConfig(cfg); } catch (_) {} });
  onMain('save-config-sync', (e, cfg) => { try { writeConfig(cfg); e.returnValue = true; } catch (_) { e.returnValue = false; } });
  const manifestPath = path.join(app.getPath('userData'), 'restart-resume.json');
  onMain('restart-manifest-load', (e) => {
    try { e.returnValue = RestartResume.parseManifest(fs.readFileSync(manifestPath, 'utf8')); }
    catch (_) { e.returnValue = RestartResume.emptyManifest(); }
  });
  onMain('restart-manifest-save', (e, doc) => {
    try {
      const clean = RestartResume.parseManifest(JSON.stringify(doc));
      fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(clean), { encoding: 'utf-8', mode: 0o600 });
      fs.chmodSync(manifestPath + '.tmp', 0o600);
      fs.renameSync(manifestPath + '.tmp', manifestPath);
      e.returnValue = true;
    } catch (_) { e.returnValue = false; }
  });
  // The deck page has no clipboard module of its own. Test profiles get a
  // private clipboard: a test run never reads or replaces what the user copied.
  let testClipboard = '';
  onMain('clipboard:write-sync', (e, text) => {
    if (typeof text !== 'string') { e.returnValue = null; return; }
    if (tudArg) testClipboard = text; else clipboard.writeText(text);
    e.returnValue = true;
  });
  onMain('clipboard:read-sync', (e) => { e.returnValue = tudArg ? testClipboard : clipboard.readText(); });
  onMain('env-info-sync', (e) => { e.returnValue = {
    platform: process.platform, home: HOME, version: app.getVersion(),
    build: [process.versions.electron && `Electron ${process.versions.electron}`, process.platform, process.arch].filter(Boolean).join(' · '),
  }; });

  // Test profiles never read the user's quota caches or conversation logs.
  handleMain('quota:local', async () => {
    if (tudArg) return [...await readLocalQuota(seatHome, path.join(seatHome, '.codex'), Date.now(), quotaSeatConfig), ...authSamples()];
    await claudeQuotaRefresh?.tick();

    const seatsKey = JSON.stringify(quotaSeatConfig || null);
    if (!quotaRead || Date.now() - quotaReadAt >= 30000 || seatsKey !== quotaSeatsKey) {
      quotaSeatsKey = seatsKey;
      quotaReadAt = Date.now();
      await sampleCodex();
      quotaRead = Promise.all([readLocalQuota(os.homedir(), process.env.CODEX_HOME, Date.now(), quotaSeatConfig), codexQuotaRead])
        .then(([local, codex]) => codex ? [...local, codex] : local).catch(() => []);
    }
    return quotaRead.then((samples) => [...samples, ...(claudeQuotaRefresh?.samples() || []), ...authSamples()]);
  });
  handleMain('quota:refresh', async (_e, { seatId } = {}) => {
    if (tudArg) return [];
    if (seatId && !ClaudeSeatsCore.normalize(seatConfig().claudeSeats).some((s) => s.id === seatId)) throw new Error('席位不存在');
    await claudeQuotaRefresh.tick({ force: true, seatId });
    quotaRead = null;
    return [...claudeQuotaRefresh.samples(), ...authSamples()].filter((s) => !seatId || s.seatId === seatId);
  });
  onMain('pty:spawn', (_e, { id, cwd, cols, rows, managed, seatId, configDir }) => spawnPty(id, cwd, cols, rows, !!managed, seatId, configDir));
  // Only the trusted deck main frame can submit a native worker. No browser
  // credentials or Captain capability are passed into the skill subprocess.
  chatgptWebExecutor = createChatGPTWebExecutor({
    ...(tudArg ? {
      cliPath: process.env.AGENTDECK_TEST_CHATGPT_WEB_CLI || path.join(app.getPath('userData'), 'missing-web-cli.mjs'),
      stateDir: path.join(app.getPath('userData'), 'web-state'),
      reportsDir: path.join(app.getPath('userData'), 'web-reports'),
      cooldownMs: Number(process.env.AGENTDECK_TEST_CHATGPT_WEB_COOLDOWN_MS || 60000),
      env: { ...process.env, CHATGPT_WEB_TEST_EVENTS_DIR: process.env.AGENTDECK_TEST_CHATGPT_WEB_EVENTS_DIR || '' },
    } : {}),
    emit: (event) => {
      const id = crypto.randomUUID();
      const command = { ...event, id, submitOnly: true, nativeWeb: true };
      pendingBoardCommands.set(id, { command, delivered: false });
      dispatchPendingBoardCommands();
      const text = event.action === 'progress' ? event.message : event.failed || '完整报告已保存，结果已提交队长。';
      const data = `\r\n[网页版 ChatGPT 6 Pro] ${text}\r\n`;
      bufferAppend(event.callerId, data); send('pty:data', { id: event.callerId, data });
    },
  });
  handleMain('chatgpt-web:run', (_e, input) => {
    if (!input || !validId(input.id) || !validId(input.taskId) || !ptys.has(input.id) || !receiptSessions.has(input.id) || managedSessions.has(input.id)) throw new Error('网页队员会话不存在或不是队员。');
    return chatgptWebExecutor.submit(input);
  });
  handleMain('chatgpt-web:cancel', (_e, { id }) => chatgptWebExecutor.cancel(id));
  handleMain('chatgpt-web:status', (_e, { id }) => chatgptWebExecutor.status(id));
  onMain('pty:input', (_e, { id, data }) => {
    if (id === warmupCaptain.id) {
      warmupCaptain.idle = false;
      quotaWarmup.cancel(warmupCaptain.seatId);
    }
    const p = ptys.get(id); if (p) p.write(data);
  });

  onMain('pty:resize', (_e, { id, cols, rows }) => {
    const p = ptys.get(id);
    if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
  });
  onMain('pty:kill', (_e, { id, keepReplay }) => killPty(id, !!keepReplay));

  onMain('board:response', async (_e, { requestId, done, result, error, childId, snapshot, visible, turnId }) => {
    const pending = pendingBoardCommands.get(requestId);
    const action = pending?.command.action;
    if (action === 'main-notify-user' && !error) {
      // Duplicate renderer acknowledgements share a single local/Bark delivery.
      pending.notifyPromise ||= notifyUser(pending.command, visible === true, turnId);
      try { result = await pending.notifyPromise; }
      catch (err) { error = err.message; }
    }
    // 待我处理: a newly filed need item alerts the user the same way notify-user does.
    if (action === 'main-inbox' && pending.command.op === 'need' && turnId && !error) {
      const input = pending.command.input || {};
      const message = [input.title, input.ask].filter((v) => typeof v === 'string' && v.trim()).join('\n').slice(0, 4000);
      pending.notifyPromise ||= notifyUser({ callerId: pending.command.callerId, id: pending.command.id, message, urgent: input.urgent === true }, visible === true, turnId);
      try { result = (typeof result === 'string' ? result + '\n' : '') + await pending.notifyPromise; }
      catch (err) { result = (typeof result === 'string' ? result + '\n' : '') + '本机提醒没发出：' + err.message; }
    }
    const verbatim = action === 'main-briefing' || action === 'main-handoff' || action === 'main-quota' || action === 'main-peek' || action === 'main-receipts' || action === 'main-receipts-snapshot' || action === 'main-receipts-ack' || action === 'main-task' || action === 'main-queue' || action === 'main-read' || action === 'main-inbox';
    pendingBoardCommands.delete(requestId);
    if (action === 'seat-auth-alert' && pending?.command.nativeSeatAuth === true) {
      if (!error) {
        try { seatAuth.acknowledge(pending.command.alertId); }
        catch (_) { send('toast', { text: '席位异常回执确认无法保存，稍后会重试。' }); }
        if (notifyUser) notifyUser({ ...pending.command, urgent: false }, visible === true).catch(() => {});
      }
      return;
    }
    if (pending?.installResolve) {
      if (error) pending.installReject(new Error(error)); else pending.installResolve();
      return;
    }
    if (pending?.command.nativeWeb) return;
    if (action === 'session-exit') return; // internal one-way exit notification
    writeBoardResponse(requestId, {
      done: !!done,
      result: typeof result === 'string' ? (verbatim ? result : result.slice(0, 12000)) : '',
      error: typeof error === 'string' ? error.slice(0, 2000) : '',
      childId: typeof childId === 'string' ? childId : '',
      snapshot: snapshot && typeof snapshot === 'object' ? snapshot : undefined,
    });
  });
  onMain('board:ready', () => {
    boardRendererReady = true;
    for (const pending of pendingBoardCommands.values()) pending.delivered = false;
    dispatchPendingBoardCommands();
    queueAuthReceipts();
    if (pendingFocusColumn) {
      send('focus-column', { id: pendingFocusColumn });
      pendingFocusColumn = null;
    }
  });

  // --- Hot-reload IPC ---
  // Check whether a pty is still running (used by renderer after reload).
  handleMain('pty:is-alive', (_e, { id }) => ptys.has(id));
  // Name of the foreground process (e.g. "zsh" or "node"), so automatic sends
  // never type prose into a bare shell. Only the name, never the command line.
  handleMain('pty:foreground', (_e, { id }) => {
    const p = ptys.get(id);
    try { return p ? String(p.process || '').slice(0, 64) : ''; } catch (_) { return ''; }
  });
  // Return all buffered output for a pty so the renderer can replay it.
  handleMain('pty:replay', (_e, { id, snapshot }) => {
    const buf = ptyBuffers.get(id), data = buf ? buf.chunks.join('') : null;
    return snapshot ? { data, sequence: buf?.sequence || 0 } : data;
  });
  // Saved session replay from the previous app run: read once, then delete so
  // a hot reload (where the pty is still alive) can never double-replay it.
  handleMain('pty:saved', (_e, { id }) => {
    const f = privateFile(SESS_DIR, id);
    let text = null;
    try { text = fs.readFileSync(f, 'utf-8'); fs.unlinkSync(f); }
    catch (_) {
      const buf = ptyBuffers.get(id);
      if (buf) text = buf.chunks.join('');
    }
    // A fresh spawn must start a fresh in-memory replay generation; otherwise
    // old output is appended again and duplicated on the next reload.
    ptyBuffers.delete(id);
    return text;
  });
  // Prune replays for columns that no longer exist in the saved layout.
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const ids = new Set([...((cfg && cfg.columns) || []), ...((cfg && cfg.archived) || [])].map((c) => c && c.id));
    for (const f of fs.readdirSync(SESS_DIR)) {
      if (!ids.has(f.replace(/\.txt$/, ''))) fs.unlinkSync(path.join(SESS_DIR, f));
    }
  } catch (_) {}

  // Does Claude Code have a resumable session in this cwd? Claude stores each
  // session at ~/.claude/projects/<cwd-with-nonalnum-turned-to-dash>/<id>.jsonl,
  // so a non-empty matching project dir means `claude --continue` will resume
  // the real conversation instead of erroring on a fresh directory.
  handleMain('claude:has-session', (_e, { cwd }) => {
    try {
      const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
      const enc = dir.replace(/[^a-zA-Z0-9]/g, '-');
      const projDir = path.join(HOME, '.claude', 'projects', enc);
      return fs.existsSync(projDir) && fs.readdirSync(projDir).some((f) => f.endsWith('.jsonl'));
    } catch (_) { return false; }
  });

  // ---- Auto column naming ----
  // The renderer sends the line the user just submitted to an agent; compress
  // it into a short label for the column header. Three tiers, each falling
  // through to the next on any failure: OpenRouter (needs ~/.openrouter_key,
  // fast + cheap) → local `claude -p` (present on both machines, slow but free
  // with the subscription) → plain keyword truncation (always works, offline).
  const TITLE_PROMPT = (text) =>
    '下面是用户发给终端里 AI agent 的一条指令。请用不超过10个字概括这个任务，作为终端列的标签。' +
    '中文优先；若指令是纯英文，标签可用不超过3个英文单词。只输出标签本身，不要标点、引号或任何解释。\n\n指令：' + text;

  // Strip characters that can only be transport damage — lone surrogates and
  // U+FFFD — so a mojibake input line can never become a mojibake column title
  // (seen 2026-07-17: a title of GBK-mangled hanzi with dangling \udcXX tails).
  // Array.from iterates by code point, so real astral chars survive intact.
  function stripBadChars(s) {
    return Array.from(String(s)).filter((c) => c !== '�' && !(c.length === 1 && c >= '\uD800' && c <= '\uDFFF')).join('');
  }

  function cleanTitle(raw) {
    if (!raw) return null;
    let t = stripBadChars(raw).replace(/\x1b\[[0-9;]*m/g, '');
    t = (t.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '');
    t = t.replace(/^(标签|label)\s*[:：]\s*/i, '');
    t = t.replace(/^["'「『【\[]+/, '').replace(/["'」』】\]。.！!？?，,]+$/, '').trim();
    if (!t) return null;
    if (/[一-鿿]/.test(t)) return Array.from(t).slice(0, 12).join('');
    return t.length > 20 ? t.slice(0, 20).trim() : t;
  }

  async function titleViaOpenRouter(text) {
    let key;
    try { key = fs.readFileSync(path.join(HOME, '.openrouter_key'), 'utf8').trim(); } catch (_) { return null; }
    if (!key) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash-lite',
          models: ['google/gemini-2.5-flash-lite', 'anthropic/claude-haiku-4.5'],
          messages: [{ role: 'user', content: TITLE_PROMPT(text) }],
          max_tokens: 2000,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const j = await res.json();
      return cleanTitle(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
    } catch (_) { return null; } finally { clearTimeout(timer); }
  }

  // `claude -p` calls are serialized: several columns naming at once would
  // otherwise each boot a full CLI. Prompt goes via stdin (no quoting issues).
  let claudeCliChain = Promise.resolve();
  function titleViaClaudeCli(text) {
    const run = () => new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = spawn('claude', ['-p', '--model', 'haiku'], { shell: true, windowsHide: true, cwd: HOME, env: buildEnv() });
      } catch (_) { return finish(null); }
      const timer = setTimeout(() => {
        // shell:true wraps the CLI in cmd.exe on Windows: kill the whole tree.
        if (isWin) { try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (_) {} }
        else { try { child.kill('SIGKILL'); } catch (_) {} }
        finish(null);
      }, 60000);
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 8000) out += d.toString().slice(0, 8000 - out.length); });
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); finish(null); });
      child.on('close', () => { clearTimeout(timer); finish(cleanTitle(out)); });
      child.stdin.on('error', () => {});
      child.stdin.end(TITLE_PROMPT(text));
    });
    const p = claudeCliChain.then(run, run);
    claudeCliChain = p.then(() => {}, () => {});
    return p;
  }

  function titleHeuristic(text) {
    let t = String(text).replace(/\s+/g, ' ').trim();
    const fillers = /^(请你?|帮我|帮忙|麻烦你?|你|给我|我想要?|我要|我需要|需要|能不能|可不可以|可以)/;
    for (let i = 0; i < 5 && fillers.test(t); i++) t = t.replace(fillers, '').trim();
    t = t.replace(/(一下|吧|呢|啊|哈|谢谢|thanks|please)[。.!！?？\s]*$/i, '').trim();
    const strip = (s) => s.replace(/[，。,.!！?？、；;：:\s]+$/, '');
    if (/[一-鿿]/.test(t)) return strip(t.slice(0, 10)) || null;
    const words = t.split(' ').slice(0, 3).join(' ');
    return strip(words.length > 20 ? words.slice(0, 20) : words) || null;
  }

  const titleCache = new Map(); // prompt → label; re-submits of the same line are free
  let pendingTitles = 0;
  handleMain('title:summarize', async (_e, { text }) => {
    const t = Array.from(stripBadChars(text || '')).slice(0, 400).join('').trim();
    if (!t) return null;
    if (tudArg) return titleHeuristic(t);
    if (titleCache.has(t)) return titleCache.get(t);
    if (pendingTitles >= 4) return titleHeuristic(t);
    // Prompts may contain secrets. Never record them in diagnostic logs.
    pendingTitles++;
    let label;
    try { label = (await titleViaOpenRouter(t)) || (await titleViaClaudeCli(t)) || titleHeuristic(t); }
    finally { pendingTitles--; }
    if (titleCache.size >= 100) titleCache.delete(titleCache.keys().next().value);
    if (label) titleCache.set(t, label);
    return label;
  });

  // Pasting an image into a column: the renderer sends the PNG bytes; save to a
  // temp file and return the path, which gets typed into the pty (mirrors the
  // drag-drop-a-file flow, but for screenshots on the clipboard).
  const PASTE_DIR = path.join(os.tmpdir(), 'agentdeck-paste');
  // Prompts too long to paste into a terminal are saved as a private text file
  // the agent is asked to read. Kept in userData; files older than 60 days go.
  const LONG_DIR = path.join(app.getPath('userData'), 'long-prompts');
  try {
    for (const f of fs.readdirSync(LONG_DIR)) {
      const file = path.join(LONG_DIR, f);
      if (Date.now() - fs.statSync(file).mtimeMs > 60 * 86_400_000) fs.unlinkSync(file);
    }
  } catch (_) {}
  handleMain('prompt:save-long', (_e, { text }) => {
    if (typeof text !== 'string' || !text || text.length > 50_000_000) return null;
    try {
      fs.mkdirSync(LONG_DIR, { recursive: true, mode: 0o700 });
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' +
        String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
      const file = path.join(LONG_DIR, `prompt-${stamp}-${crypto.randomBytes(3).toString('hex')}.txt`);
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      return file;
    } catch (_) { return null; }
  });
  // Startup sweep: pasted screenshots older than 24h are stale (Windows %TEMP%
  // is never auto-cleaned, so without this the dir grows without bound).
  try {
    for (const f of fs.readdirSync(PASTE_DIR)) {
      const p = path.join(PASTE_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(p);
    }
  } catch (_) {}
  handleMain('paste-image:save', () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      fs.mkdirSync(PASTE_DIR, { recursive: true });
      const f = path.join(PASTE_DIR, 'paste-' + Date.now() + '.png');
      fs.writeFileSync(f, img.toPNG());
      return f;
    } catch (_) { return null; }
  });

  // Composer "+": the user picks files in a native dialog; only the paths
  // they chose go back to the page.
  handleMain('pick-files', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths.slice(0, 50);
  });

  // Test profiles record native delivery and playback without desktop side effects.
  let NativeNotification = Notification;
  if (tudArg) {
    app.testCaptainAlerts = [];
    NativeNotification = class extends require('events').EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); this.options = options; }
      show() { app.testCaptainAlerts.push({ type: 'notification', ...this.options }); app.testCaptainNotification = this; }
      close() { app.testCaptainAlerts.push({ type: 'cancel' }); }
    };
  }
  notifications = createNotifications({ Notification: NativeNotification, focusColumn,
    getMainWindow: () => mainWindow, getConfig: () => notificationConfig,
    playSound: (tone) => {
      if (tudArg) { app.testCaptainAlerts.push({ type: 'sound', tone }); return; }
      execFile('/usr/bin/afplay', ['-v', '0.35', '-t', '1', `/System/Library/Sounds/${tone}.aiff`],
        { timeout: 2000 }, () => {});
    } });
  notifyUser = createNotifyUser({ getConfig: () => notificationConfig, notifications, delivery: barkDelivery,
    ...(tudArg ? { keyHome: app.getPath('userData') } : {}),
    ...(tudArg ? { fetchImpl: async (_url, options) => {
      // Test profiles never contact Bark or retain the stand-in key.
      const { device_key, ...payload } = JSON.parse(options.body);
      app.testCaptainAlerts.push({ type: 'bark', ...payload });
      return { ok: true, status: 200, json: async () => ({ code: 200 }) };
    } } : {}) });
  if (!tudArg) {
    claudeQuotaRefresh = createClaudeQuotaRefresh({ home: seatHome, getSeats: () => seatConfig().claudeSeats,
      intervalMs: () => Battery.pollMs('claudeQuotaSample', power.active()), onSample: observeAuth });
    const refresh = async () => {
      await Promise.all([claudeQuotaRefresh.tick(), sampleCodex()]);
      send('quota:updated', [...claudeQuotaRefresh.samples(), ...authSamples()]);
      queueAuthReceipts();
    };
    refresh().catch(() => {});
    claudeQuotaTimer = power.every('claudeQuotaTick', () => refresh().catch(() => {}));
  }
  const pollInstallResult = createResultMonitor({
    file: path.join(app.getPath('userData'), 'install-result.json'),
    runtime: () => ({ execPath: process.execPath, version: app.getVersion() }),
    getConfig: readLocalConfig,
    deliver: (command) => new Promise((resolve, reject) => {
      if (!boardRendererReady) { reject(new Error('Renderer not ready')); return; }
      const timer = setTimeout(() => { pendingBoardCommands.delete(command.id); reject(new Error('Installation receipt acknowledgement timed out')); }, 15000);
      pendingBoardCommands.set(command.id, { command, delivered: false,
        installResolve: () => { clearTimeout(timer); resolve(); },
        installReject: (error) => { clearTimeout(timer); reject(error); } });
      dispatchPendingBoardCommands();
    }),
    notify: async (command) => {
      if (!notifyUser) return false;
      return notifyUser(command, false, command.id, true);
    },
  });
  const installResultTimer = setInterval(() => pollInstallResult().catch(() => {}), 1000);
  installResultTimer.unref();
  pollInstallResult().catch(() => {});
  onMain('notify-state', (_event, payload) => {
    if (payload && ptys.has(payload.id)) notifications.show(payload);
  });
  onMain('notify-cancel', (_event, { id }) => notifications.cancel(id));
  // Renderer-side state transitions (see maybeNotifyState) land here purely
  // for the diagnostic log.
  onMain('state-debug', (_e, p) => {
    nlog(`transition col=${p.id} ${p.prev}->${p.st} hasWorked=${p.hasWorked}${p.skip ? ' SKIP=' + p.skip : ''} title=${p.title}`);
  });

  // Dock badge (macOS): number of columns blocked waiting for the user.
  onMain('attn:count', (_e, n) => {
    if (isMac && app.dock) { try { app.dock.setBadge(n > 0 ? String(n) : ''); } catch (_) {} }
  });

  // Renderer asks us to reload itself (Cmd+Shift+R). Pty processes stay alive.
  onMain('reload-renderer', () => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) w.webContents.reload();
  });

  // Legacy watch-ai spools must never bypass Captain-only alerts.
  onMain('agentdeck:dump', (_e, { id }) => { try { fs.unlinkSync(spoolPath(id)); } catch (_) {} });
  onMain('agentdeck:touch', (_e, { id }) => { try { fs.unlinkSync(spoolPath(id)); } catch (_) {} });

  // Open URLs in the browser / reveal local paths in Finder (clicked links).
  onMain('open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
  // Option+click: open the file in the editor, jumping to the :line the agent
  // printed. No ancestor fallback — a miss in the editor is worse than a no-op.
  const shortText = (s) => { s = String(s || ''); return s.length > 64 ? s.slice(0, 61) + '…' : s; };

  onMain('open-in-editor', (_e, msg) => {
    const r = resolveClick(msg, false); // a miss must not open some ancestor in the editor
    if (!r) { send('toast', { text: '路径不存在：' + shortText(msg && msg.raw) }); return; }
    const editor = editorCli();
    if (!editor) { shell.openPath(r.target); return; }
    // recover ":406" / ":406:12" from the clicked text or its wrapped tail
    const lm = ((msg.raw || '') + ' ' + (Array.isArray(msg.cont) ? msg.cont[0] || '' : '')).match(/:(\d+(?::\d+)?)(?!\d)/);
    const args = ['-g', lm ? `${r.target}:${lm[1]}` : r.target];
    const onError = (error) => { if (error) send('toast', { text: '无法启动编辑器：' + error.message }); };
    // Windows cannot execFile a .cmd shim. Pass single-quoted literals through
    // an encoded PowerShell command; filenames never become shell syntax.
    if (isWin && /\.(cmd|bat)$/i.test(editor)) {
      const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
      const command = '& ' + [editor, ...args].map(quote).join(' ');
      execFile(shellFile(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 }, onError);
    } else execFile(editor, args, { timeout: 10000 }, onError);
  });

  onMain('reveal-path', (_e, msg) => {
    // Ancestor fallback only for absolute paths; a relative miss should be a
    // no-op, not a Finder window on some unrelated folder.
    const r = resolveClick(msg, true);
    if (!r) { send('toast', { text: '路径不存在：' + shortText(msg && msg.raw) }); return; }
    const open = revealOpens(r.target);
    if (r.fallback) send('toast', { text: '该路径不完整存在，已' + (open ? '打开' : '定位到') + '最深的真实一层：' + r.target });
    if (open) shell.openPath(r.target);
    else shell.showItemInFolder(r.target);
  });

  // Electron's default View accelerators zoom the entire page before the
  // renderer can handle them. Route only those three items to the shared text
  // size control, preserving the other native menu items.
  const textZoom = { resetzoom: 0, zoomin: 1, zoomout: -1 };
  const fontMenu = (menu) => menu.items.map((item) => {
    if (Object.hasOwn(textZoom, item.role)) return {
      id: `text-${item.role}`, label: item.label, accelerator: item.accelerator,
      click: () => send('font-size', { delta: textZoom[item.role] }),
    };
    return item.submenu ? { label: item.label, role: item.role, submenu: fontMenu(item.submenu) } : item;
  });
  const nativeMenu = Menu.getApplicationMenu();
  if (nativeMenu) Menu.setApplicationMenu(Menu.buildFromTemplate(fontMenu(nativeMenu)));

  startFleet(configPath);
  createWindow();
  const initialFocus = process.argv.find((arg) => arg.startsWith('--focus-column='));
  if (initialFocus && validId(initialFocus.slice(15))) pendingFocusColumn = initialFocus.slice(15);
  app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });
});

function fleetSessions(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const captain = cfg.mainSession && cfg.mainSession.colId;
    return [...(cfg.columns || []), ...(cfg.archived || [])].filter((col) => col && typeof col.id === 'string').map((col) => ({
      id: col.id, role: col.id === captain || col.isMain ? 'captain' : 'session',
      title: typeof (col.displayTitle || col.title) === 'string' ? (col.displayTitle || col.title) : '',
    }));
  } catch (_) { return []; }
}
function startFleet(configPath) {
  const userData = app.getPath('userData');
  const device = loadDevice(path.join(userData, 'device.json'));
  taskStore.deviceId = device.id;
  todoStore.deviceId = device.id;
  watchTodos();
  const settings = readFleetSettings({ env: process.env, fleetFile: path.join(userData, 'fleet.json') });
  if (!settings) return;
  if (settings.error) {
    fleetClient = {
      snapshot: () => ({ configured: true, devices: [], history: [], error: settings.error, conflictCount: 0, selfId: device.id, lastSyncAt: null }),
      stop() {}, noteResult() {}, noteCaptain() {},
    };
    return;
  }
  let version = '';
  try { version = require('./package.json').version; } catch (_) {}
  fleetClient = new FleetClient({
    baseUrl: settings.baseUrl, tokenFile: settings.tokenFile, device, taskStore,
    historyDir: path.join(userData, 'fleet-history'), stateFile: path.join(userData, 'fleet-state.json'),
    sessions: () => fleetSessions(configPath), version, syncMs: settings.syncMs,
    onChange: () => send('task-board:changed', {}),
  });
  try {
    const captain = fleetSessions(configPath).find((item) => item.role === 'captain');
    for (const chat of loadAllChats(CHAT_DIR)) {
      if (chat && (chat.captainArchive === true || chat.id === captain?.id)) fleetClient.noteCaptain(chat.id, chat);
    }
  } catch (_) {}
  fleetClient.start();
}

// Ask the page to record in-flight crew, then quit on a later turn. A nested
// app.quit() inside this handler is a no-op, and a timer that gives up once
// the page has answered never reaches the real exit. The timeout always
// schedules the same quit as the page's ack.
let quitGate = null;
let quitWatchdog = null;
// Electron maps process.exit to app.exit; neither can break stuck native
// teardown or a blocked main loop. A separate Node-mode process owns the hard
// deadline. On POSIX, reparenting proves the process exited; Electron can close
// stdin before native teardown finishes, so EOF alone must not cancel it.
function armQuitWatchdog() {
  if (quitWatchdog) return;
  const deadlineMs = 5000;
  const script = `
    const target = Number(process.argv[1]);
    if (target !== process.ppid || !Number.isSafeInteger(target) || target < 1) process.exit(1);
    const timer = setTimeout(() => {
      if (process.ppid !== target) return process.exit(0);
      try { process.kill(target, 'SIGKILL'); } catch (_) {}
      process.exit(0);
    }, ${deadlineMs});
    process.stdin.on('end', () => {
      if (process.platform === 'win32' || process.ppid !== target) {
        clearTimeout(timer); process.exit(0);
      }
    });
    process.stdin.resume();
  `;
  quitWatchdog = spawn(process.execPath, ['-e', script, String(process.pid)], {
    env: { ELECTRON_RUN_AS_NODE: '1', ...(isWin ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
  });
  quitWatchdog.on('error', () => {});
  quitWatchdog.stdin.on('error', () => {});
  quitWatchdog.unref();
  quitWatchdog.stdin.unref();
  // Also cover a watchdog spawn failure while the main loop is responsive.
  setTimeout(() => { try { process.kill(process.pid, 'SIGKILL'); } catch (_) {} }, deadlineMs).unref();
}
app.prependListener('before-quit', armQuitWatchdog);
function readResumeEnabled() {
  try { return RestartResume.resumeEnabled(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))); }
  catch (_) { return true; }
}
function parkedSessions() {
  if (tudArg) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    const lookback = 14 * 24 * 3600 * 1000;
    const columns = (cfg.columns || []).filter((col) => col && !col.isMain && col.captainCrew).map((col) => ({
      id: col.id, provider: RestartResume.providerOf(col.cmd), cwd: col.cwd || '',
      since: Number(col.sessionWatchSince) || Date.now() - lookback, sessionId: col.modelSessionId || '', owner: col.modelSessionOwner || '',
      source: col.modelSessionSource || '', capturedCwd: col.modelSessionCwd || '',
    })).filter((col) => ['Cursor', 'Codex', 'Antigravity'].includes(col.provider));
    return AgentSessions.resolveSessions(columns, { roots: AgentSessions.defaultRoots(os.homedir()), lookbackMs: lookback });
  } catch (_) { return {}; }
}
quitGate = RestartResume.createQuitGate({
  timeoutMs: 1500,
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  later: (fn) => { setImmediate(fn); },
  onPark: () => { send('park-for-restart', { sessions: parkedSessions() }); },
  quit: () => {
    app.quit();
    // Try normal Electron teardown first; the OS watchdog remains armed if
    // either Electron exit path returns without ending the real process.
    setTimeout(() => { try { app.exit(0); } catch (_) {} }, 1000);
  },
});
onMain('park-for-restart-done', () => { if (quitGate) quitGate.acked(); });
app.on('before-quit', (event) => {
  if (quitGate.beforeQuit(event, readResumeEnabled()) !== 'cleanup') return;
  if (fleetClient && fleetClient.stop) fleetClient.stop();
  claudeQuotaTimer?.stop();
  claudeQuotaRefresh?.dispose();
  if (mobileWeb) mobileWeb.close();
  for (const pending of mobileRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error('AgentDeck 已关闭。')); }
  mobileRequests.clear();
  clearInterval(quotaWarmupTimer);
  quotaWarmup?.dispose(); quotaWarmupRunner?.dispose();
  for (const timer of seatAuthChecks.values()) clearTimeout(timer);
  seatAuthChecks.clear();
  clearInterval(barkPumpTimer);
  chatgptWebExecutor?.dispose();
  receiptListeners?.dispose(); receiptListeners = null;

  if (notifications) notifications.dispose();
  if (isMac && app.dock) { try { app.dock.setBadge(''); } catch (_) {} }
  // Final flush of each column's recent output so the next launch can replay it
  // (the periodic flush already covers crashes that skip this handler).
  for (const [id, buf] of ptyBuffers) writeSession(id, buf);
  for (const [id, p] of ptys) {
    // kill() only signals the shell. The master fd stays open and keeps
    // the process alive after will-quit, so Playwright never sees the exit.
    try { p.kill(); } catch (_) {}
    // Windows destroy() calls kill() again; closing one ConPTY twice corrupts
    // the native heap. POSIX still needs destroy() to release its master fd.
    try { if (!isWin && typeof p.destroy === 'function') p.destroy(); } catch (_) {}

    removeCredentials(boardControlDir, id);
    try { fs.unlinkSync(spoolPath(id)); } catch (_) {} // clear watch-ai spools on exit
  }
  ptys.clear();
});
// before-quit already removed credentials and closed PTY masters. Exit
// immediately so inspector sockets cannot keep quit waiting. The independent
// watchdog still enforces the deadline if native teardown does not finish.
app.on('will-quit', () => {
  app.exit(0);
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
