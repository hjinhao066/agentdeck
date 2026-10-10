'use strict';
// A previewed web page runs its own scripts, so what it can reach is decided
// here: which files its own address serves, which requests leave the view, and
// how the view itself is built. Real files in a temporary folder, stand-in
// Electron objects; nothing here opens a window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../preview-html-core');
const { readPreview, registerSideIpc } = require('../side-main');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pvhtml-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home');
const report = path.join(home, 'reports', 'weekly');
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

write(path.join(report, 'index.html'), '<!doctype html><title>周报</title><script src="app.js"></script>');
write(path.join(report, 'app.js'), 'document.title = "ran";');
write(path.join(report, 'shots', 'a b.png'), 'png');
write(path.join(report, 'data.json'), '{"n":1}');
write(path.join(report, '.env'), 'KEY=1');
write(path.join(report, 'credentials.json'), '{}');
write(path.join(report, 'notes.docx'), 'doc');
write(path.join(home, 'reports', 'other', 'secret.txt'), 'other report');
write(path.join(home, 'loose.html'), '<p>loose</p>');
write(path.join(home, 'neighbour.txt'), 'home file');
write(path.join(home, 'Downloads', 'page.html'), '<p>dl</p>');
write(path.join(home, 'Downloads', 'bank.csv'), '1,2');

const opts = { home, tmp: path.join(tmp, 'tmp'), platform: process.platform };
const scope = Core.scopeFor(path.join(report, 'index.html'), opts);

test('an .html or .htm file previews as a web page and still carries its source', () => {
  const r = readPreview(path.join(report, 'index.html'), 'index.html');
  assert.equal(r.kind, 'html');
  assert.equal(r.lang, 'html');
  assert.match(r.text, /<title>周报<\/title>/);
  write(path.join(report, 'old.HTM'), '<p>old</p>');
  assert.equal(readPreview(path.join(report, 'old.HTM'), 'old.HTM').kind, 'html');
  assert.equal(readPreview(path.join(report, 'app.js'), 'app.js').kind, 'text');
});

test('a page is served from its own folder: itself, its scripts, pictures in sub-folders', () => {
  assert.equal(scope.wide, false);
  assert.equal(Core.entryPath(scope), '/index.html');
  const page = Core.resolveAsset(scope, '/index.html', opts);
  assert.deepEqual([page.ok, page.mime], [true, 'text/html; charset=utf-8']);
  assert.equal(Core.resolveAsset(scope, '/app.js', opts).mime, 'text/javascript; charset=utf-8');
  assert.equal(Core.resolveAsset(scope, '/shots/a%20b.png', opts).file, path.join(report, 'shots', 'a b.png'));
  assert.equal(Core.resolveAsset(scope, '/data.json', opts).ok, true);
});

test('nothing outside the folder is served, however the address is written', () => {
  for (const escape of ['/../other/secret.txt', '/%2e%2e/other/secret.txt', '/..%2fother%2fsecret.txt', '/shots/../../other/secret.txt',
    '/..\\other\\secret.txt', '/%5c..%5cother', '//etc/hosts', '/' + encodeURIComponent(path.join(home, 'neighbour.txt')), '/%00', '/%E0%A4%A'])
    assert.equal(Core.resolveAsset(scope, escape, opts).ok, false, escape);
});

test('a link that points out of the folder is not followed', { skip: process.platform === 'win32' }, () => {
  fs.symlinkSync(path.join(home, 'neighbour.txt'), path.join(report, 'link.txt'));
  fs.symlinkSync(path.join(home, 'reports', 'other'), path.join(report, 'linked'));
  assert.equal(Core.resolveAsset(scope, '/link.txt', opts).ok, false);
  assert.equal(Core.resolveAsset(scope, '/linked/secret.txt', opts).ok, false);
});

test('a link inside the folder to one of its hidden files is refused like the hidden file', { skip: process.platform === 'win32' }, () => {
  write(path.join(report, '.private.txt'), 'hidden');
  fs.symlinkSync(path.join(report, '.private.txt'), path.join(report, 'shown.txt'));
  assert.equal(Core.resolveAsset(scope, '/.private.txt', opts).ok, false);
  assert.equal(Core.resolveAsset(scope, '/shown.txt', opts).ok, false);
});

test('keys, hidden files and formats a page has no use for are refused inside the folder too', () => {
  for (const name of ['/.env', '/credentials.json', '/notes.docx', '/missing.js', '/shots'])
    assert.equal(Core.resolveAsset(scope, name, opts).ok, false, name);
});

test('a page lying in a catch-all folder gets only itself', () => {
  for (const file of [path.join(home, 'loose.html'), path.join(home, 'Downloads', 'page.html')]) {
    const wide = Core.scopeFor(file, opts);
    assert.equal(wide.wide, true, file);
    assert.equal(Core.resolveAsset(wide, Core.entryPath(wide), opts).ok, true);
  }
  assert.equal(Core.resolveAsset(Core.scopeFor(path.join(home, 'loose.html'), opts), '/neighbour.txt', opts).ok, false);
  assert.equal(Core.resolveAsset(Core.scopeFor(path.join(home, 'Downloads', 'page.html'), opts), '/bank.csv', opts).ok, false);
  // the temporary folder itself is one too; a folder of its own inside it is not
  write(path.join(opts.tmp, 'x.html'), '<p>t</p>');
  write(path.join(opts.tmp, 'job', 'x.html'), '<p>t</p>');
  fs.mkdirSync(opts.tmp, { recursive: true });
  assert.equal(Core.scopeFor(path.join(opts.tmp, 'x.html'), opts).wide, true);
  assert.equal(Core.scopeFor(path.join(opts.tmp, 'job', 'x.html'), opts).wide, false);
  // … also where the temporary folder lies deep inside the home folder, as on Windows
  const winLike = { ...opts, tmp: path.join(home, 'AppData', 'Local', 'Temp') };
  write(path.join(winLike.tmp, 'x.html'), '<p>t</p>');
  write(path.join(winLike.tmp, 'job', 'x.html'), '<p>t</p>');
  assert.equal(Core.scopeFor(path.join(winLike.tmp, 'x.html'), winLike).wide, true);
  assert.equal(Core.scopeFor(path.join(winLike.tmp, 'job', 'x.html'), winLike).wide, false);
});

test('requests: the page\'s own address and the public web, never this machine, the local network or a file', () => {
  const ok = (url) => Core.requestAllowed(url);
  for (const url of ['agentdeck-preview://abc/index.html', 'https://cdn.jsdelivr.net/npm/chart.js', 'http://example.com/a.png', 'data:image/png;base64,AAAA', 'blob:agentdeck-preview://abc/1'])
    assert.equal(ok(url), true, url);
  for (const url of ['file:///etc/hosts', 'file:///Users/me/.ssh/id_rsa', 'http://localhost:8787/api', 'http://127.0.0.1:3000/', 'http://127.1/', 'http://2130706433/',
    'http://[::1]:9000/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.3.4/', 'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/', 'http://[fd00::1]/', 'http://printer.local/', 'http://app.localhost/', 'https://localhost/', 'ws://example.com/', 'wss://example.com/', 'ftp://example.com/',
    'chrome://settings', 'devtools://devtools/x', 'javascript:alert(1)', 'not a url', ''])
    assert.equal(ok(url), false, url);
  assert.equal(ok('http://172.32.0.1/'), true);
  assert.equal(ok('http://11.0.0.1/'), true);
});

test('navigation stays on the opened page\'s own address', () => {
  assert.equal(Core.sameSite('agentdeck-preview://abc/detail.html#top', 'abc'), true);
  for (const url of ['agentdeck-preview://other/index.html', 'https://example.com/', 'file:///etc/hosts', 'about:blank', ''])
    assert.equal(Core.sameSite(url, 'abc'), false, url);
});

// ---- the view the page runs in ----
// What names resolve to in these tests (a public name may point at this machine or the local network).
const NAMES = { 'cdn.jsdelivr.net': ['151.101.1.229'], 'example.com': ['93.184.216.34'], 'lan-alias.example.com': ['127.0.0.1'],
  'nas.example.org': ['192.168.1.20'], 'v6-loop.example.net': ['::1'], 'mixed.example.net': ['93.184.216.34', '10.0.0.7'] };
function standIn() {
  const calls = { handlers: {}, invoke: {}, sent: [], views: [], partitions: [] };
  const makeSession = (name) => {
    const ses = { name, events: {}, protocol: { handle: (scheme, fn) => { ses.scheme = scheme; ses.serve = fn; } },
      webRequest: { onBeforeRequest: (fn) => { ses.filter = fn; } },
      setPermissionRequestHandler: (fn) => { ses.permission = fn; }, setPermissionCheckHandler: (fn) => { ses.check = fn; },
      on: (event, fn) => { ses.events[event] = fn; } };
    return ses;
  };
  const sessions = new Map();
  const session = { fromPartition: (name) => { calls.partitions.push(name); if (!sessions.has(name)) sessions.set(name, makeSession(name)); return sessions.get(name); } };
  class WebContentsView {
    constructor(options) {
      this.options = options; this.bounds = null; this.visible = false;
      const wc = this.webContents = { events: {}, loaded: [], closed: false, on: (event, fn) => { const before = wc.events[event]; wc.events[event] = before ? (...a) => { before(...a); fn(...a); } : fn; }, loadURL: (url) => { wc.loaded.push(url); return Promise.resolve(); },
        setWindowOpenHandler: (fn) => { wc.opener = fn; }, setWebRTCIPHandlingPolicy: (policy) => { wc.webrtc = policy; }, isDestroyed: () => wc.closed, close: () => { wc.closed = true; }, getURL: () => wc.loaded[wc.loaded.length - 1] || '',
        getTitle: () => '', isLoading: () => false, canGoBack: () => false, canGoForward: () => false, reload: () => { wc.reloads = (wc.reloads || 0) + 1; },
        finds: [], stops: [], findInPage: (text, o) => { wc.finds.push([text, o]); return (wc.lastRequest = (wc.lastRequest || 0) + 1); }, stopFindInPage: (how) => { wc.stops.push(how); } };
      calls.views.push(this);
    }
    setBounds(b) { this.bounds = b; }
    setVisible(v) { this.visible = v; }
  }
  const win = { isDestroyed: () => false, webContents: { getZoomFactor: () => 1, focus: () => { calls.focused = (calls.focused || 0) + 1; } }, contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter((c) => c !== v); } } };
  const pane = registerSideIpc({
    onMain: (channel, fn) => { calls.handlers[channel] = fn; }, handleMain: (channel, fn) => { calls.invoke[channel] = fn; },
    send: (channel, message) => calls.sent.push([channel, message]), getWindow: () => win, session, WebContentsView,
    resolveClick: (msg) => (fs.existsSync(msg.raw) ? { target: msg.raw } : null), chatDir: () => path.join(tmp, 'chats'), home, tmp: opts.tmp,
    // names are looked up before a request leaves; no real lookups in a test
    lookup: async (host) => (NAMES[host] || []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  });
  return { calls, sessions, win, pane };
}

test('the page opens in a view of its own: sandboxed, no bridge, a session nothing else uses', async () => {
  const { calls, sessions, win } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const view = calls.views.find((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://')));
  assert.ok(view, 'a view loaded the page from its own address');
  assert.deepEqual(calls.sent.splice(0), [['side:preview-state', { alone: false }]]);
  const prefs = view.options.webPreferences;
  assert.deepEqual([prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webviewTag], [true, true, false, false]);
  assert.equal('preload' in prefs, false);
  const ses = prefs.session;
  assert.equal(ses.name, 'agentdeck-preview');           // not persisted, not the deck's, not the browser tab's
  assert.equal(ses.scheme, 'agentdeck-preview');
  assert.ok(win.contentView.children.includes(view));

  const url = view.webContents.loaded[0];
  assert.match(url, /^agentdeck-preview:\/\/[a-f0-9]{32}\/index\.html$/);
  const token = new URL(url).hostname;
  // the address serves the folder and nothing else
  const get = (target, method = 'GET') => ses.serve({ url: target, method });
  const page = await get(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /<title>周报<\/title>/);
  assert.equal((await get(`agentdeck-preview://${token}/app.js`)).status, 200);
  assert.equal((await get(`agentdeck-preview://${token}/%2e%2e/other/secret.txt`)).status, 404);
  assert.equal((await get(`agentdeck-preview://${token}/.env`)).status, 404);
  assert.equal((await get('agentdeck-preview://' + 'f'.repeat(32) + '/index.html')).status, 404);   // an address nobody opened
  assert.equal((await get(url, 'POST')).status, 405);

  // requests leaving the view
  const verdict = (target) => new Promise((resolve) => ses.filter({ url: target }, (r) => resolve(!!r.cancel)));
  assert.equal(await verdict('file:///etc/hosts'), true);
  assert.equal(await verdict('http://127.0.0.1:8787/hub'), true);
  assert.equal(await verdict('https://cdn.jsdelivr.net/npm/chart.js'), false);
  assert.equal(await verdict(url), false);

  // permissions, downloads, new windows
  let granted = null; ses.permission({}, 'media', (v) => { granted = v; });
  assert.equal(granted, false);
  assert.equal(ses.check(), false);
  let stopped = false; ses.events['will-download']({ preventDefault: () => { stopped = true; } });
  assert.equal(stopped, true);
  // the user clicks in the page (real input, which a script cannot make): a web link then goes to the browser tab
  const click = () => view.webContents.events['before-mouse-event']({}, { type: 'mouseUp', x: 10, y: 10 });
  click();
  assert.deepEqual(view.webContents.opener({ url: 'https://example.com/docs' }), { action: 'deny' });
  assert.deepEqual(calls.sent.pop(), ['side:preview-link', { url: 'https://example.com/docs' }]);
  assert.deepEqual(view.webContents.opener({ url: 'file:///etc/hosts' }), { action: 'deny' });
  // a script can open a window as well as a person can: this machine's own addresses are not passed on
  assert.deepEqual(view.webContents.opener({ url: 'http://127.0.0.1:8787/hub/api' }), { action: 'deny' });
  assert.equal(calls.sent.length, 0);

  // leaving the page: its own pages yes, a web link goes to the browser tab, anything else nowhere
  const leave = (target) => { let blocked = false; view.webContents.events['will-navigate']({ preventDefault: () => { blocked = true; } }, target); return blocked; };
  assert.equal(leave(`agentdeck-preview://${token}/detail.html`), false);
  assert.equal(leave('https://example.com/a'), true);
  assert.deepEqual(calls.sent.pop(), ['side:preview-link', { url: 'https://example.com/a' }]);
  assert.equal(leave('file:///etc/hosts'), true);
  assert.equal(leave('http://localhost:8787/hub/api'), true);
  assert.equal(leave('http://192.168.1.1/'), true);
  assert.equal(leave('agentdeck-preview://' + 'f'.repeat(32) + '/index.html'), true);
  assert.equal(calls.sent.length, 0);
});

test('a public name that points at this machine or the local network is refused like the address itself', async () => {
  // In the real app a name resolving to 127.0.0.1 reached a local service and the page read its answer.
  const { calls, sessions } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const ses = sessions.get('agentdeck-preview');
  const verdict = (target) => new Promise((resolve) => ses.filter({ url: target }, (r) => resolve(!!r.cancel)));
  for (const url of ['http://lan-alias.example.com:8787/hub/api', 'https://nas.example.org/', 'http://v6-loop.example.net/', 'https://mixed.example.net/a.js', 'https://nowhere.example/'])
    assert.equal(await verdict(url), true, url);
  for (const url of ['https://cdn.jsdelivr.net/npm/chart.js', 'https://example.com/a.png', 'https://EXAMPLE.com./b.png'])
    assert.equal(await verdict(url), false, url);
  assert.equal(Core.namedHost('http://93.184.216.34/'), '');
  assert.equal(Core.namedHost('http://[2606:2800::1]/'), '');
  assert.equal(Core.namedHost('data:text/plain,x'), '');
});

test('a page that asks before it is left never keeps the next preview or a reload out', () => {
  // In Electron (checked outside the app) a page clicked once that set beforeunload made the main
  // process's next loadURL end in ERR_ABORTED: the old page stayed under the new file's name.
  const { calls } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const view = calls.views.find((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://')));
  let left = false;
  view.webContents.events['will-prevent-unload']({ preventDefault: () => { left = true; } });
  assert.equal(left, true);
});

test('WebRTC sends no UDP from the page (it does not pass the request filter)', () => {
  // In the real app a page's STUN packets reached the local network / WireGuard address.
  const { calls } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const view = calls.views.find((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://')));
  assert.equal(view.webContents.webrtc, 'disable_non_proxied_udp');
});

test('a page\'s alert() or confirm() cannot put a box over the deck window', () => {
  // In the real app (Windows) an alert left the AgentDeck window disabled under its box.
  const { calls } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const view = calls.views.find((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://')));
  assert.equal(view.options.webPreferences.disableDialogs, true);
});

test('a page that sends itself somewhere without a click does not take the pane to the browser tab', () => {
  // In the real app a page's own location.href / <meta refresh> / window.open switched the pane
  // to the browser tab (whose session keeps the user's sign-ins), with nothing clicked.
  const { calls } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  const view = calls.views.find((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://')));
  calls.sent.length = 0;
  let blocked = false;
  view.webContents.events['will-navigate']({ preventDefault: () => { blocked = true; } }, 'https://example.com/redirected');
  assert.equal(blocked, true);
  assert.deepEqual(view.webContents.opener({ url: 'https://example.com/popup' }), { action: 'deny' });
  // a key press that is not a key down, a mouse move: not a click
  view.webContents.events['before-input-event']({}, { type: 'keyUp', key: 'a' });
  view.webContents.events['before-mouse-event']({}, { type: 'mouseMove', x: 1, y: 1 });
  view.webContents.events['will-navigate']({ preventDefault() {} }, 'https://example.com/again');
  assert.deepEqual(calls.sent, []);
  // Enter on a focused link is a key down: that one goes
  view.webContents.events['before-input-event']({}, { type: 'keyDown', key: 'Enter' });
  view.webContents.events['will-navigate']({ preventDefault() {} }, 'https://example.com/entered');
  assert.deepEqual(calls.sent, [['side:preview-link', { url: 'https://example.com/entered' }]]);
});

test('only a real .html the user clicked is opened, and closing the preview ends the page', () => {
  const { calls } = standIn();
  const opened = () => calls.views.filter((v) => v.webContents.loaded.some((u) => u.startsWith('agentdeck-preview://'))).length;
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'app.js') });
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'nope.html') });
  calls.handlers['side:preview-html']({}, { raw: 42 });
  calls.handlers['side:preview-html']({}, null);
  assert.equal(opened(), 0);
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  assert.equal(opened(), 1);
  const view = calls.views[calls.views.length - 1];
  calls.handlers['side:preview-bounds']({}, { x: 10.4, y: 20, width: 300, height: 400, visible: true });
  assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 400 });
  assert.equal(view.visible, true);
  calls.handlers['side:preview-action']({}, { action: 'reload' });
  assert.equal(view.webContents.reloads, 1);
  calls.handlers['side:preview-action']({}, { action: 'close' });
  assert.equal(view.webContents.closed, true);
});

test('a page in a catch-all folder is opened alone and the pane is told', () => {
  const { calls } = standIn();
  calls.handlers['side:preview-html']({}, { raw: path.join(home, 'Downloads', 'page.html') });
  assert.deepEqual(calls.sent.pop(), ['side:preview-state', { alone: true }]);
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  assert.deepEqual(calls.sent.pop(), ['side:preview-state', { alone: false }]);
});

test('find in the page: the words go to the page\'s own view, its count comes back, and ⌘F pressed inside the page opens the bar', () => {
  const { calls } = standIn();
  calls.handlers['side:preview-find']({}, { text: '周报' });            // no page open: nothing to search, nothing breaks
  calls.handlers['side:preview-html']({}, { raw: path.join(report, 'index.html') });
  calls.sent.splice(0);
  const wc = calls.views[calls.views.length - 1].webContents;
  calls.handlers['side:preview-find']({}, { text: '周报' });
  assert.deepEqual(wc.finds.pop(), ['周报', { forward: true, findNext: true, matchCase: false }]);
  calls.handlers['side:preview-find']({}, { text: '周报', next: true, forward: false });
  assert.deepEqual(wc.finds.pop(), ['周报', { forward: false, findNext: false, matchCase: false }]);
  wc.events['found-in-page']({}, { requestId: wc.lastRequest, activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
  assert.deepEqual(calls.sent.pop(), ['side:preview-found', { active: 2, total: 5 }]);
  // an answer to an older search, or one still on its way, is not passed on
  wc.events['found-in-page']({}, { requestId: wc.lastRequest - 1, activeMatchOrdinal: 1, matches: 9, finalUpdate: true });
  wc.events['found-in-page']({}, { requestId: wc.lastRequest, activeMatchOrdinal: 1, matches: 9, finalUpdate: false });
  assert.equal(calls.sent.length, 0);
  // the words are cut to a sane length; an empty or odd query clears the page instead
  calls.handlers['side:preview-find']({}, { text: 'x'.repeat(5000) });
  assert.equal(wc.finds.pop()[0].length, 200);
  for (const text of ['', 42, null]) {
    calls.handlers['side:preview-find']({}, { text });
    assert.equal(wc.stops.pop(), 'clearSelection');
    assert.deepEqual(calls.sent.pop(), ['side:preview-found', { active: 0, total: 0 }]);
  }
  calls.handlers['side:preview-find']({}, null);
  calls.handlers['side:preview-find-stop']({});
  assert.equal(wc.stops.pop(), 'clearSelection');

  // ⌘F (Ctrl+F off the Mac) pressed while the page has the keyboard: the pane's bar opens; every other key stays with the page
  const key = (input) => { let kept = false; wc.events['before-input-event']({ preventDefault: () => { kept = true; } }, input); return kept; };
  const mod = process.platform === 'darwin' ? { meta: true } : { control: true };
  calls.sent.splice(0);
  assert.equal(key({ type: 'keyDown', key: 'f', ...mod }), true);
  assert.deepEqual(calls.sent.pop(), ['side:preview-find-key', {}]);
  assert.equal(calls.focused, 1);                                         // the deck's page takes the keyboard back
  assert.equal(key({ type: 'keyDown', key: 'F', ...mod }), true);
  calls.sent.splice(0);
  for (const input of [{ type: 'keyDown', key: 'f' }, { type: 'keyUp', key: 'f', ...mod }, { type: 'keyDown', key: 'c', ...mod }, { type: 'keyDown', key: 'f', ...mod, shift: true }, { type: 'keyDown', key: 'f', ...mod, alt: true }])
    assert.equal(key(input), false, JSON.stringify(input));
  assert.equal(calls.sent.length, 0);
});
