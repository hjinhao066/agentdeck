'use strict';
// Main-process half of the chat view and the right-hand side pane: saved
// conversations, file previews, and the embedded browser. Everything the page
// can ask for is validated here; the page never gets Node or a raw file path
// it did not click on.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { validId, privateFile } = require('./security');
const ChatCore = require('./chat-core');

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// Saved chats keep every turn. A chat past this size is not written at all
// (never trimmed to fit) and the page is told, so nothing goes missing quietly.
const MAX_CHAT_BYTES = 64 * 1024 * 1024;
const MAX_DIR_ENTRIES = 300;

// ---- previews ----
function readPreview(target, raw) {
  const stat = fs.statSync(target);
  const name = path.basename(target);
  const line = (/:(\d+)(?::\d+)?$/.exec(String(raw || '')) || [])[1];
  const base = { ok: true, path: target, name, line: line ? Number(line) : 0, mtime: stat.mtimeMs };

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
      .slice(0, MAX_DIR_ENTRIES);
    return { ...base, kind: 'dir', entries };
  }
  const kind = ChatCore.fileKind(name);
  base.size = stat.size;
  if (kind === 'pdf') return { ...base, kind };
  if (kind === 'image') {
    if (stat.size > MAX_IMAGE_BYTES) return { ...base, kind: 'toolarge' };
    const mime = ChatCore.imageMime(name);
    return { ...base, kind, dataUrl: `data:${mime};base64,${fs.readFileSync(target).toString('base64')}` };
  }
  const fd = fs.openSync(target, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES));
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, Math.min(got, 8000));
    if (head.includes(0)) return { ...base, kind: 'binary' };
    return { ...base, kind, text: buf.subarray(0, got).toString('utf8'), truncated: stat.size > MAX_TEXT_BYTES, lang: ChatCore.languageFor(name) };
  } finally { fs.closeSync(fd); }
}

// ---- saved conversations ----
function loadAllChats(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return out; }
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (id === f || !validId(id)) continue;
    try { out.push(ChatCore.normalizeChat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), id)); } catch (_) {}
  }
  return out;
}
function saveChat(dir, id, chat) {
  const text = JSON.stringify(ChatCore.normalizeChat(chat, id));
  if (text.length > MAX_CHAT_BYTES) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = privateFile(dir, id, '.json');
  fs.writeFileSync(file + '.tmp', text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return true;
}
function deleteChat(dir, id) {
  try { fs.unlinkSync(privateFile(dir, id, '.json')); } catch (_) {}
}

// ---- IPC ----
const isWebUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\//i.test(u);
const clampInt = (n, max) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));

function registerSideIpc(ctx) {
  const { onMain, handleMain, send, getWindow, resolveClick, session, WebContentsView, chatDir } = ctx;
  let view = null;
  let allowedFile = '';
  let lastBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };

  const rawOf = (msg) => (msg && typeof msg.raw === 'string' && msg.raw.length <= 2000 ? msg : null);

  handleMain('chat:load-all', () => loadAllChats(chatDir()));
  const refused = new Set();
  onMain('chat:save', (_e, { id, chat }) => {
    if (!chat || typeof chat !== 'object' || !validId(id)) return;
    let ok = false;
    try { ok = saveChat(chatDir(), id, chat); } catch (_) {}
    if (ok) { refused.delete(id); if (typeof ctx.onChatSaved === 'function') ctx.onChatSaved(id, chat); return; }
    if (refused.has(id)) return;
    refused.add(id);
    send('toast', { text: '这个对话的记录没能保存（太大或写入失败），之前存下的记录还在。' });
  });
  onMain('chat:delete', (_e, { id }) => deleteChat(chatDir(), id));

  handleMain('preview:read', (_e, msg) => {
    if (!rawOf(msg)) return { ok: false, error: '路径无效' };
    const r = resolveClick(msg, false);
    if (!r) return { ok: false, error: '路径不存在：' + msg.raw.slice(0, 80) };
    try { return readPreview(r.target, msg.raw); } catch (error) { return { ok: false, error: error.message }; }
  });

  // The embedded browser is a separate sandboxed view with its own cookie jar,
  // so a page opened here never sees the deck's bridge.
  function ensureView() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    if (view && !view.webContents.isDestroyed()) return view;
    const ses = session.fromPartition('persist:agentdeck-side');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    view = new WebContentsView({
      // throttled while hidden: a busy web page must not burn CPU behind a closed pane
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
    });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    const guard = (event, url) => {
      if (isWebUrl(url) || (allowedFile && url === allowedFile)) return;
      event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    const push = () => {
      if (wc.isDestroyed()) return;
      const history = wc.navigationHistory;
      send('side:browser-state', {
        url: wc.getURL().slice(0, 4096), title: String(wc.getTitle() || '').slice(0, 300),
        canGoBack: history ? history.canGoBack() : wc.canGoBack(),
        canGoForward: history ? history.canGoForward() : wc.canGoForward(),
        loading: wc.isLoading(),
      });
    };
    ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']
      .forEach((name) => wc.on(name, push));
    win.contentView.addChildView(view);
    applyBounds();
    return view;
  }
  // The page reports CSS pixels; the view is placed in window pixels. They
  // differ by the page's zoom (⌘− / ⌘= in the View menu), which used to push
  // the browser out of the side pane.
  function applyBounds() {
    if (!view || view.webContents.isDestroyed()) return;
    const b = lastBounds;
    const win = getWindow();
    let z = 1;
    try { if (win && !win.isDestroyed()) z = win.webContents.getZoomFactor() || 1; } catch (_) {}
    view.setBounds({ x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) });
    view.setVisible(b.visible && b.width > 0 && b.height > 0);
  }

  onMain('side:browser-open', (_e, { url }) => {
    if (!isWebUrl(url)) return;
    const v = ensureView();
    if (!v) return;
    allowedFile = '';
    v.webContents.loadURL(url).catch(() => {});
  });
  onMain('side:browser-pdf', (_e, msg) => {
    if (!rawOf(msg)) return;
    const r = resolveClick(msg, false);
    if (!r || ChatCore.fileKind(r.target) !== 'pdf') return;
    const v = ensureView();
    if (!v) return;
    allowedFile = pathToFileURL(r.target).href;
    v.webContents.loadURL(allowedFile).catch(() => {});
  });
  onMain('side:browser-bounds', (_e, b) => {
    if (!b || typeof b !== 'object') return;
    lastBounds = { x: clampInt(b.x, 20000), y: clampInt(b.y, 20000), width: clampInt(b.width, 20000), height: clampInt(b.height, 20000), visible: !!b.visible };
    applyBounds();
  });
  onMain('side:browser-action', (_e, { action }) => {
    if (!view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const nav = wc.navigationHistory || wc;
    if (action === 'back') { if (nav.canGoBack()) nav.goBack(); }
    else if (action === 'forward') { if (nav.canGoForward()) nav.goForward(); }
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  });

  return {
    dispose() {
      if (view && !view.webContents.isDestroyed()) { try { view.webContents.close(); } catch (_) {} }
      view = null;
    },
  };
}

module.exports = { readPreview, loadAllChats, saveChat, deleteChat, registerSideIpc, MAX_TEXT_BYTES };
