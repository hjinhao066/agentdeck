const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, dialog, clipboard, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { validId, trustedSender, privateFile, boundedAppend } = require('./security');
const { createNotifications } = require('./notifications');
const { registerSideIpc } = require('./side-main');
const { registerSkillsIpc } = require('./skills-core');
const BoardCore = require('./board-core');
const ClaudeSeatsCore = require('./claude-seats-core');
const { seatEnvironment, registerSeatsIpc } = require('./claude-seats-main');
const { readLocal: readLocalQuota } = require('./quota-local');
const { readCodex: readCodexQuota } = require('./quota-codex');
let mainWindow = null;
let notifications = null;
let sidePane = null;
let pendingFocusColumn = null;

// Isolated test instance: `AgentDeck.exe --test-user-data=<absdir>` runs with
// its own userData (own config/sessions AND own single-instance lock), so an
// end-to-end test deck can run alongside the real one without touching it.
const tudArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--test-user-data='));
if (tudArg) app.setPath('userData', tudArg.slice('--test-user-data='.length));

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
  if (!buf) { buf = { chunks: [], totalSize: 0 }; ptyBuffers.set(id, buf); }
  boundedAppend(buf, data, PTY_BUFFER_MAX);
}

function spawnPty(id, cwd, cols, rows, managed, seatId, configDir) {
  if (!validId(id) || ptys.size >= 100) return;
  // Captain notifications replace legacy watch-ai spools, avoiding double
  // alerts and persistent plaintext terminal output in a shared directory.
  try { fs.unlinkSync(spoolPath(id)); } catch (_) {}
  if (ptys.has(id)) return; // already running (e.g. a stray re-spawn)
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const token = managed ? crypto.randomBytes(24).toString('hex') : '';
  const receiptToken = crypto.randomBytes(24).toString('hex');
  receiptSessions.set(id, receiptToken);
  if (token) managedSessions.set(id, token);
  else managedSessions.delete(id);
  let terminalEnv = { ...ENV, AGENTDECK_COL_ID: id, AGENTDECK_TERMINAL_ID: id };
  if (seatId) {
    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const seat = configDir ? { id: seatId, configDir } : ClaudeSeatsCore.normalize(cfg.claudeSeats).find((s) => s.id === seatId);
      if (!seat) throw new Error('席位不存在');
      terminalEnv = seatEnvironment(terminalEnv, seat, tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME);
    } catch (_) {
      managedSessions.delete(id);
      receiptSessions.delete(id);
      send('pty:data', { id, data: '\r\n[AgentDeck] 席位配置无效，请检查席位设置。\r\n' });
      send('pty:exit', { id });
      return;
    }
  }
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
    // Spawn can fail (fd exhaustion, bad shell). Surface it in the column
    // instead of throwing inside the IPC handler and crashing the main process.
    send('pty:data', { id, data: `\r\n[AgentDeck] shell 启动失败: ${err.message}\r\n` });
    send('pty:exit', { id, reason: `shell 启动失败: ${err.message}` });
    return;
  }
  p.onData((data) => { bufferAppend(id, data); send('pty:data', { id, data }); });
  p.onExit(({ exitCode, signal }) => {
    // Ignore a late exit from an older PTY generation. This matters if a
    // column is respawned quickly with the same id.
    if (ptys.get(id) === p) {
      writeSession(id, ptyBuffers.get(id));
      ptys.delete(id);
      managedSessions.delete(id);
      receiptSessions.delete(id);
      if (notifications) notifications.cancel(id);
      // Keep the frozen buffer until the column is explicitly removed. It lets
      // a renderer reload still show an exited terminal's useful final output.
      send('pty:exit', { id, reason: `终端进程退出（exit ${exitCode}${signal ? `，signal ${signal}` : ''}）` });
    }
  });
  ptys.set(id, p);
}

function send(channel, payload) {
  const w = mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function killPty(id, keepReplay) {
  if (notifications) notifications.cancel(id);
  // Archived sessions keep their last output so restoring replays it.
  if (keepReplay) writeSession(id, ptyBuffers.get(id));
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); }
  ptyBuffers.delete(id);
  managedSessions.delete(id);
  receiptSessions.delete(id);
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
  if (!boardRendererReady) return;
  for (const pending of pendingBoardCommands.values()) {
    if (pending.delivered) continue;
    pending.delivered = true;
    send('board:command', pending.command);
  }
}

function processBoardRequests() {
  if (processingBoardRequests || !boardControlDir) return;
  processingBoardRequests = true;
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
      if (submitOnly && !['complete', 'ask', 'progress', 'session-exit'].includes(action)) {
        writeBoardResponse(request.id, { done: true, error: 'Receipt capability allows only complete, ask and progress; it cannot control other sessions.' });
        continue;
      }
      // main-* actions are honored only for the 队长 (main session) column; the renderer
      // checks the caller before doing anything.
      if (!['create-child', 'spawn-child', 'wait', 'send', 'progress', 'complete', 'ask', 'session-exit', 'status',
        'main-ledger', 'main-quota', 'main-new', 'main-tell', 'main-read', 'main-peek', 'main-receipts', 'main-answer', 'main-stop', 'main-archive'].includes(action)) {
        writeBoardResponse(request.id, { done: true, error: `Unsupported board action: ${action}` });
        continue;
      }
      delete request.token;
      if (pendingBoardCommands.size >= 256) {
        writeBoardResponse(request.id, { done: true, error: 'Board request queue is full. Retry later.' });
        continue;
      }
      const command = { ...request, callerId: caller[0], submitOnly: !!submitOnly };
      // Do not discard an authenticated request while the renderer is loading.
      // It stays here until the renderer acknowledges it with board:response;
      // board:ready replays pending commands after a hot reload.
      if (!pendingBoardCommands.has(command.id)) {
        pendingBoardCommands.set(command.id, { command, delivered: false });
      }
    }
    dispatchPendingBoardCommands();
  } catch (_) {
  } finally {
    processingBoardRequests = false;
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
    boardCliPath = path.join(toolsDir, 'agentdeck-board.js');
    fs.copyFileSync(path.join(__dirname, 'board-cli.js'), boardCliPath);
  } catch (err) {
    nlog(`board-control setup failed: ${err.message}`);
  }
  setInterval(processBoardRequests, 250);
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

app.whenReady().then(() => {
  if (isWin) app.setAppUserModelId('com.jinhao.agentdeck');
  if (tudArg && isMac) app.setActivationPolicy('accessory');
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  setupBoardControl();
  sidePane = registerSideIpc({
    onMain, handleMain, send, session, WebContentsView,
    getWindow: () => mainWindow, resolveClick, chatDir: () => CHAT_DIR,
  });
  // A test profile must never list or edit the real user's skills.
  registerSkillsIpc({ handleMain, home: tudArg ? path.join(app.getPath('userData'), 'skills-home') : HOME });
  const configPath = path.join(app.getPath('userData'), 'config.json');
  const seatHome = tudArg ? path.join(app.getPath('userData'), 'seats-home') : HOME;
  const seatConfig = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return {}; } };
  registerSeatsIpc({ handleMain, home: seatHome, userData: app.getPath('userData'),
    getSeats: () => seatConfig().claudeSeats, getCaptainId: () => seatConfig().mainSession?.colId });
  let quotaSeatConfig;
  let notificationConfig = {};
  try { notificationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  onMain('load-config-sync', (e) => {
    try { e.returnValue = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : null; quotaSeatConfig = e.returnValue?.claudeSeats; }
    catch (_) { e.returnValue = null; }
  });
  onMain('save-config', (_e, cfg) => {
    quotaSeatConfig = cfg?.claudeSeats;
    notificationConfig = cfg;
    if (notifications && cfg.captainNotifications?.enabled === false) notifications.dispose();
    // Atomic write: a crash mid-write must not corrupt config.json (which would
    // silently reset the whole deck layout to defaults on next launch).
    try {
      fs.writeFileSync(configPath + '.tmp', JSON.stringify(cfg, null, 2), 'utf-8');
      fs.renameSync(configPath + '.tmp', configPath);
    } catch (_) {}
  });
  onMain('env-info-sync', (e) => { e.returnValue = {
    platform: process.platform, home: HOME,
  }; });

  // Test profiles never read the user's quota caches or conversation logs.
  let quotaRead = null, quotaReadAt = 0, codexQuotaRead = null, codexQuotaAt = 0, quotaSeatsKey = '';
  handleMain('quota:local', () => {
    if (tudArg) return readLocalQuota(seatHome, path.join(seatHome, '.codex'), Date.now(), quotaSeatConfig);
    const seatsKey = JSON.stringify(quotaSeatConfig || null);
    if (!quotaRead || Date.now() - quotaReadAt >= 30000 || seatsKey !== quotaSeatsKey) {
      quotaSeatsKey = seatsKey;
      quotaReadAt = Date.now();
      if (!codexQuotaRead || Date.now() - codexQuotaAt >= 60000) {
        codexQuotaAt = Date.now();
        codexQuotaRead = readCodexQuota(ENV);
      }
      quotaRead = Promise.all([readLocalQuota(os.homedir(), process.env.CODEX_HOME, Date.now(), quotaSeatConfig), codexQuotaRead])
        .then(([local, codex]) => codex ? [...local, codex] : local).catch(() => []);
    }
    return quotaRead;
  });
  onMain('pty:spawn', (_e, { id, cwd, cols, rows, managed, seatId, configDir }) => spawnPty(id, cwd, cols, rows, !!managed, seatId, configDir));
  onMain('pty:input', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
  onMain('pty:resize', (_e, { id, cols, rows }) => {
    const p = ptys.get(id);
    if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
  });
  onMain('pty:kill', (_e, { id, keepReplay }) => killPty(id, !!keepReplay));

  onMain('board:response', (_e, { requestId, done, result, error, childId, snapshot }) => {
    const action = pendingBoardCommands.get(requestId)?.command.action;
    const verbatim = action === 'main-peek' || action === 'main-receipts';
    pendingBoardCommands.delete(requestId);
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
  handleMain('pty:replay', (_e, { id }) => {
    const buf = ptyBuffers.get(id);
    return buf ? buf.chunks.join('') : null;
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
    if (r.fallback) send('toast', { text: '该路径不完整存在，已打开最深的真实一层：' + r.target });
    try {
      const stat = fs.statSync(r.target);
      // A directory opens in Finder; a file is revealed within its parent folder.
      if (stat.isDirectory()) shell.openPath(r.target);
      else shell.showItemInFolder(r.target);
    } catch (_) {}
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

  createWindow();
  const initialFocus = process.argv.find((arg) => arg.startsWith('--focus-column='));
  if (initialFocus && validId(initialFocus.slice(15))) pendingFocusColumn = initialFocus.slice(15);
  app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });
});

app.on('before-quit', () => {
  if (notifications) notifications.dispose();
  if (isMac && app.dock) { try { app.dock.setBadge(''); } catch (_) {} }
  // Final flush of each column's recent output so the next launch can replay it
  // (the periodic flush already covers crashes that skip this handler).
  for (const [id, buf] of ptyBuffers) writeSession(id, buf);
  for (const [id, p] of ptys) {
    try { p.kill(); } catch (_) {}
    try { fs.unlinkSync(spoolPath(id)); } catch (_) {} // clear watch-ai spools on exit
  }
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
