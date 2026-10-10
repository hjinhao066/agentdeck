'use strict';
// Main-process half of the chat view and the right-hand side pane: saved
// conversations, file previews, and the embedded browser. Everything the page
// can ask for is validated here; the page never gets Node or a raw file path
// it did not click on.
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { validId, privateFile } = require('./security');
const ChatCore = require('./chat-core');
const PreviewHtml = require('./preview-html-core');

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// Saved chats keep every turn. A chat past this size is not written at all
// (never trimmed to fit) and the page is told, so nothing goes missing quietly.
const MAX_CHAT_BYTES = 64 * 1024 * 1024;
const MAX_DIR_ENTRIES = 300;
// A previewed page's link goes to the browser tab only this soon after a real click or key press in it.
const HAND_OVER_MS = 2000;
// How long a name a previewed page asked for keeps its looked-up verdict (local or public).
const NAME_TTL_MS = 60 * 1000;
const NAMES_KEPT = 500;

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
    // a web page is shown as the page (side:preview-html) and carries its source for the other view
    return { ...base, kind: PreviewHtml.HTML_NAME.test(name) ? 'html' : kind, text: buf.subarray(0, got).toString('utf8'), truncated: stat.size > MAX_TEXT_BYTES, lang: ChatCore.languageFor(name) };
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

// ---- delivered files: are they still on disk? ----
// One answer per path: 0 gone, 1 file, 2 folder. Only absolute paths are looked
// at, and nothing but this is told to the page.
const MAX_STAT_PATHS = 2000;
async function statPaths(paths, home) {
  const one = async (raw) => {
    if (typeof raw !== 'string' || !raw || raw.length > 2000) return 0;
    let p = raw.trim().replace(/^file:\/\//, '');
    if (/^~(?:[\\/]|$)/.test(p)) p = home + p.slice(1);
    if (!path.isAbsolute(p)) return 0;
    for (const cand of new Set([p, p.replace(/:\d+(?::\d+)?$/, '')])) {
      try { return (await fs.promises.stat(cand)).isDirectory() ? 2 : 1; } catch (_) {}
    }
    return 0;
  };
  const list = Array.isArray(paths) ? paths.slice(0, MAX_STAT_PATHS) : [];
  const out = [];
  // a batch at a time: a few hundred paths must not open a few hundred handles at once
  for (let i = 0; i < list.length; i += 64) out.push(...await Promise.all(list.slice(i, i + 64).map(one)));
  return out;
}

// ---- IPC ----
const isWebUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\//i.test(u);
const clampInt = (n, max) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));

function registerSideIpc(ctx) {
  const { onMain, handleMain, send, getWindow, resolveClick, session, WebContentsView, chatDir, home } = ctx;
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

  // The file on screen is watched so the pane can show it again when someone changes it. Polling
  // its stat once a second sees a file saved in place, one an editor renames over it, and one that
  // goes and comes back; only the file shown is watched, and the page is told only a number.
  let watched = null;                // { file, listener }
  let watchCount = 0;
  const unwatch = () => { if (watched) fs.unwatchFile(watched.file, watched.listener); watched = null; };
  handleMain('preview:watch', (_e, msg) => {
    unwatch();
    if (!rawOf(msg)) return 0;
    const r = resolveClick(msg, false);
    if (!r) return 0;
    const watch = ++watchCount;
    const listener = (now, before) => {
      if (now.mtimeMs === before.mtimeMs && now.size === before.size && now.ino === before.ino) return;
      send('side:preview-changed', { watch });
    };
    fs.watchFile(r.target, { interval: ctx.watchInterval || 1000, persistent: false }, listener);
    watched = { file: r.target, listener };
    return watch;
  });
  onMain('preview:unwatch', () => unwatch());
  handleMain('artifacts:stat', (_e, msg) => statPaths(msg && msg.paths, home));

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
  function place(v, b) {
    if (!v || v.webContents.isDestroyed()) return;
    const win = getWindow();
    let z = 1;
    try { if (win && !win.isDestroyed()) z = win.webContents.getZoomFactor() || 1; } catch (_) {}
    v.setBounds({ x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) });
    v.setVisible(b.visible && b.width > 0 && b.height > 0);
  }
  const applyBounds = () => place(view, lastBounds);
  const readBounds = (b) => ({ x: clampInt(b.x, 20000), y: clampInt(b.y, 20000), width: clampInt(b.width, 20000), height: clampInt(b.height, 20000), visible: !!b.visible });

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
    lastBounds = readBounds(b);
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

  // ---- a web page previewed in the pane ----
  // The page runs its own scripts, so it gets what a page from the internet
  // would: a sandboxed view without a bridge, a session of its own that keeps
  // nothing, and an address that serves only the folder the file lies in
  // (preview-html-core.js). It cannot name a file, this machine or the deck.
  let pageView = null;
  let pageSession = null;
  let opened = null;                 // { token, scope }: the one page the address serves right now
  let pageBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  const tokens = new Map();          // folder (or lone file) → its address, the same for the whole run
  // A name is looked up before a request to it leaves: a public name can point at this machine
  // or the local network. Not proof against a name that answers differently a moment later
  // (DNS rebinding), but every name that simply points there is refused.
  const lookup = ctx.lookup || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const names = new Map();           // name → { at, local }: a page loads many files from one CDN
  function nameIsLocal(host) {
    const known = names.get(host);
    if (known && Date.now() - known.at < NAME_TTL_MS) return Promise.resolve(known.local);
    return Promise.resolve().then(() => lookup(host)).then(
      (list) => !Array.isArray(list) || !list.length || list.some((entry) => PreviewHtml.privateHost(entry && entry.address)),
      () => true,                      // a name that does not resolve: the request could not go anywhere anyway
    ).then((local) => {
      if (names.size >= NAMES_KEPT) names.clear();
      names.set(host, { at: Date.now(), local });
      return local;
    });
  }
  const refusal = (status) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
  async function serve(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(405);
    let url;
    try { url = new URL(request.url); } catch (_) { return refusal(404); }
    if (!opened || url.hostname !== opened.token) return refusal(404);
    const asset = PreviewHtml.resolveAsset(opened.scope, url.pathname);
    if (!asset.ok) return refusal(404);
    let body;
    try { body = await fs.promises.readFile(asset.file); } catch (_) { return refusal(404); }
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: {
      'content-type': asset.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    } });
  }
  function ensurePageSession() {
    if (pageSession) return pageSession;
    const ses = session.fromPartition(PreviewHtml.PARTITION);
    ses.protocol.handle(PreviewHtml.SCHEME, serve);
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!PreviewHtml.requestAllowed(details.url)) { callback({ cancel: true }); return; }
      const host = PreviewHtml.namedHost(details.url);
      if (!host) { callback({ cancel: false }); return; }
      nameIsLocal(host).then((local) => callback({ cancel: local }));
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    return (pageSession = ses);
  }
  let findRequest = 0;               // the page's latest search; an answer to an older one is dropped
  function ensurePageView() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    if (pageView && !pageView.webContents.isDestroyed()) return pageView;
    // disableDialogs: a page's alert() or confirm() is a box over the whole deck window
    // (Windows disables the window under it), and one in a loop locks the app.
    pageView = new WebContentsView({
      webPreferences: { session: ensurePageSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: true, disableDialogs: true },
    });
    const wc = pageView.webContents;
    // WebRTC does not pass onBeforeRequest: its STUN packets reached addresses on the local
    // network and the WireGuard link. No UDP leaves the page that way.
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.on('found-in-page', (_e, r) => {
      if (r && r.finalUpdate && r.requestId === findRequest) send('side:preview-found', { active: r.activeMatchOrdinal || 0, total: r.matches || 0 });
    });
    // ⌘F (Ctrl+F off the Mac) while the page has the keyboard opens the pane's find bar; the page
    // gets every other key. Only the press itself is passed on, nothing the page typed.
    wc.on('before-input-event', (event, input) => {
      const mod = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
      if (input.type !== 'keyDown' || !mod || input.shift || input.alt || String(input.key).toLowerCase() !== 'f') return;
      event.preventDefault();
      const host = getWindow();
      if (host && !host.isDestroyed()) host.webContents.focus();
      send('side:preview-find-key', {});
    });
    // A link to the public web is handed to the browser tab; nothing else leaves the
    // page. A script can "click" too, so an address on this machine or its network is
    // not handed over: the browser tab would fetch it on the page's behalf. And only
    // right after the user really clicked or pressed a key in the page (input a script
    // cannot make): a page that sends itself somewhere (location, <meta refresh>,
    // window.open on a timer) would otherwise switch the pane to the browser tab, whose
    // session keeps the user's sign-ins.
    let touchedAt = 0;
    wc.on('before-mouse-event', (_e, mouse) => { if (mouse && (mouse.type === 'mouseDown' || mouse.type === 'mouseUp')) touchedAt = Date.now(); });
    wc.on('before-input-event', (_e, input) => { if (input && input.type === 'keyDown') touchedAt = Date.now(); });
    const outside = (url) => {
      if (Date.now() - touchedAt > HAND_OVER_MS) return;
      if (isWebUrl(url) && PreviewHtml.requestAllowed(url)) send('side:preview-link', { url });
    };
    wc.setWindowOpenHandler(({ url }) => { outside(url); return { action: 'deny' }; });
    const guard = (event, url) => {
      if (opened && PreviewHtml.sameSite(url, opened.token)) return;
      event.preventDefault();
      outside(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    // A page the user clicked in once may ask before it is left (beforeunload). Nobody is
    // asked here: the next preview or 重新加载 replaces it (unanswered, Electron cancelled the
    // load and the old page stayed under the new file's name).
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    win.contentView.addChildView(pageView);
    place(pageView, pageBounds);
    return pageView;
  }
  function closePage() {
    opened = null;
    if (!pageView) return;
    const win = getWindow();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(pageView); } catch (_) {}
    if (!pageView.webContents.isDestroyed()) { try { pageView.webContents.close(); } catch (_) {} }
    pageView = null;
  }
  onMain('side:preview-html', (_e, msg) => {
    if (!rawOf(msg)) return;
    const r = resolveClick(msg, false);
    if (!r || !PreviewHtml.HTML_NAME.test(r.target)) return;
    const scope = PreviewHtml.scopeFor(r.target, { home, tmp: ctx.tmp || os.tmpdir() });
    if (!scope || !PreviewHtml.resolveAsset(scope, PreviewHtml.entryPath(scope)).ok) {
      // Not drawn here (over the size cap, or a name an address cannot carry: a leading dot, a
      // colon). The page shown before is ended rather than left under this file's name, and
      // the pane says why.
      closePage();
      let big = false;
      try { big = fs.statSync(r.target).size > PreviewHtml.MAX_ASSET_BYTES; } catch (_) {}
      send('side:preview-state', { refused: big ? 'big' : 'name', path: r.target });
      return;
    }
    const v = ensurePageView();
    if (!v) return;
    const key = scope.wide ? scope.file : scope.root;
    if (!tokens.has(key)) tokens.set(key, crypto.randomBytes(16).toString('hex'));
    opened = { token: tokens.get(key), scope };
    v.webContents.loadURL(`${PreviewHtml.SCHEME}://${opened.token}${PreviewHtml.entryPath(scope)}`).catch(() => {});
    send('side:preview-state', { alone: scope.wide });
  });
  onMain('side:preview-bounds', (_e, b) => {
    if (!b || typeof b !== 'object') return;
    pageBounds = readBounds(b);
    place(pageView, pageBounds);
  });
  onMain('side:preview-action', (_e, msg) => {
    const action = msg && msg.action;
    if (action === 'close') closePage();
    else if (action === 'reload' && pageView && !pageView.webContents.isDestroyed()) pageView.webContents.reload();
  });
  // Find in the page: Chromium's own search in the page's view; the count comes back on side:preview-found.
  const livePage = () => (pageView && !pageView.webContents.isDestroyed() ? pageView.webContents : null);
  function stopFind() {
    const wc = livePage();
    findRequest = 0;
    if (wc) wc.stopFindInPage('clearSelection');
  }
  onMain('side:preview-find', (_e, msg) => {
    const wc = livePage();
    if (!wc || !msg) return;
    if (typeof msg.text !== 'string' || !msg.text) { stopFind(); send('side:preview-found', { active: 0, total: 0 }); return; }
    findRequest = wc.findInPage(msg.text.slice(0, 200), { forward: msg.forward !== false, findNext: !msg.next, matchCase: false });
  });
  onMain('side:preview-find-stop', () => stopFind());

  return {
    dispose() {
      unwatch();
      if (view && !view.webContents.isDestroyed()) { try { view.webContents.close(); } catch (_) {} }
      view = null;
      closePage();
    },
  };
}

module.exports = { readPreview, statPaths, loadAllChats, saveChat, deleteChat, registerSideIpc, MAX_TEXT_BYTES };
