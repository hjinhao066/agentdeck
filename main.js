const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

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

// Spool dir the watch-ai daemon reads to "see" inside AgentDeck columns (it
// can't via AppleScript/tmux). Each column's rendered screen is dumped here.
const WATCH_SPOOL = path.join(HOME, '.local', 'share', 'watch-ai', 'agentdeck');
const spoolPath = (id) => path.join(WATCH_SPOOL, id + '.txt');

// When launched from Finder the GUI PATH is minimal, so tmux/claude/etc. aren't
// found. Prepend the usual homebrew + user bin dirs so columns can run them.
function buildEnv() {
  const env = { ...process.env };
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'), '/usr/bin', '/bin'];
  const cur = (env.PATH || '').split(':');
  env.PATH = [...extra, ...cur].filter((p, i, a) => p && a.indexOf(p) === i).join(':');
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
  env.LC_ALL = UTF8;

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

  return env;
}
const ENV = buildEnv();

// Each column is just an independent shell process. One dying never touches the
// others — close it and open a fresh one. (No tmux: kept deliberately simple.)
function shellFile() {
  if (isWin) return process.env.COMSPEC || 'powershell.exe';
  return ENV.SHELL || '/bin/zsh';
}

const ptys = new Map(); // columnId -> pty process

// --- Hot-reload support: buffer recent pty output so the renderer can replay
// it after a webContents.reload() without losing visible terminal content. ---
const ptyBuffers = new Map(); // columnId -> { chunks: string[], totalSize: number }
const PTY_BUFFER_MAX = 200_000; // ~200 KB per pty (plenty for a full screen)

function bufferAppend(id, data) {
  let buf = ptyBuffers.get(id);
  if (!buf) { buf = { chunks: [], totalSize: 0 }; ptyBuffers.set(id, buf); }
  buf.chunks.push(data);
  buf.totalSize += data.length;
  // Trim oldest chunks when over budget.
  while (buf.totalSize > PTY_BUFFER_MAX && buf.chunks.length > 1) {
    buf.totalSize -= buf.chunks.shift().length;
  }
}

function spawnPty(id, cwd, cols, rows) {
  if (ptys.has(id)) return; // already running (e.g. a stray re-spawn)
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const p = pty.spawn(shellFile(), [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: ENV,
  });
  p.onData((data) => { bufferAppend(id, data); send('pty:data', { id, data }); });
  p.onExit(() => { ptys.delete(id); ptyBuffers.delete(id); send('pty:exit', { id }); });
  ptys.set(id, p);
}

function send(channel, payload) {
  const w = BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function killPty(id) {
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); }
  ptyBuffers.delete(id);
  try { fs.unlinkSync(spoolPath(id)); } catch (_) {} // drop its watch-ai spool
}

// Live cwd of a column's shell (the user may have cd'd since spawn). macOS has
// no /proc, so ask lsof; only runs on a link click, so the spawn cost is fine.
function ptyCwd(id) {
  const p = id && ptys.get(id);
  if (!p || isWin) return null;
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf-8' });
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
  s = s.replace(/\\ /g, ' ').replace(/\s+$/, '');
  if (!s.startsWith('/')) return null;

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 640,
    minHeight: 480,
    title: 'AgentDeck',
    backgroundColor: '#000000',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  ipcMain.on('load-config-sync', (e) => {
    try { e.returnValue = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : null; }
    catch (_) { e.returnValue = null; }
  });
  ipcMain.on('save-config', (_e, cfg) => {
    try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8'); } catch (_) {}
  });
  ipcMain.on('env-info-sync', (e) => { e.returnValue = { platform: process.platform, home: HOME }; });

  ipcMain.on('pty:spawn', (_e, { id, cwd, cols, rows }) => spawnPty(id, cwd, cols, rows));
  ipcMain.on('pty:input', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
    const p = ptys.get(id);
    if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
  });
  ipcMain.on('pty:kill', (_e, { id }) => killPty(id));

  // --- Hot-reload IPC ---
  // Check whether a pty is still running (used by renderer after reload).
  ipcMain.handle('pty:is-alive', (_e, { id }) => ptys.has(id));
  // Return all buffered output for a pty so the renderer can replay it.
  ipcMain.handle('pty:replay', (_e, { id }) => {
    const buf = ptyBuffers.get(id);
    return buf ? buf.chunks.join('') : null;
  });
  // Renderer asks us to reload itself (Cmd+Shift+R). Pty processes stay alive.
  ipcMain.on('reload-renderer', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.isDestroyed()) w.webContents.reload();
  });

  // Renderer pushes each column's rendered screen; mirror it to the watch-ai
  // spool so the daemon can detect idle agents running inside AgentDeck.
  ipcMain.on('agentdeck:dump', (_e, { id, text }) => {
    try { fs.mkdirSync(WATCH_SPOOL, { recursive: true }); fs.writeFileSync(spoolPath(id), text || '', 'utf-8'); }
    catch (_) {}
  });

  // Open URLs in the browser / reveal local paths in Finder (clicked links).
  ipcMain.on('open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
  ipcMain.on('reveal-path', (_e, msg) => {
    const raw = (msg && msg.raw) || '';
    const isAbs = /^(file:\/\/|\/|~)/.test(raw);
    // Relative references (Claude Code's "src/renderer.js:406") are anchored to
    // the clicked column's live shell cwd. No ancestor fallback for those: a
    // miss should be a no-op, not a Finder window on some unrelated folder.
    const cand = isAbs ? raw : path.join(ptyCwd(msg && msg.id) || HOME, raw);
    const target = resolveLongestExisting(cand, isAbs);
    if (!target) return;
    try {
      const stat = fs.statSync(target);
      // A directory opens in Finder; a file is revealed within its parent folder.
      if (stat.isDirectory()) shell.openPath(target);
      else shell.showItemInFolder(target);
    } catch (_) {}
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  for (const [id, p] of ptys) {
    try { p.kill(); } catch (_) {}
    try { fs.unlinkSync(spoolPath(id)); } catch (_) {} // clear watch-ai spools on exit
  }
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
