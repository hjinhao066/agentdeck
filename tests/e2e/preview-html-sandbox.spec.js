const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// A previewed web page in the real app, at the edges of its sandbox (bug hunt ④): a public name
// that public DNS resolves to this machine (localtest.me) is refused, WebRTC
// sends no UDP to the local network, a page that sends itself somewhere without a click leaves the
// pane where it is, and the view's dialogs are off (alert() cannot cover the deck window). A server and a
// UDP socket on this machine count what reaches them. (beforeunload is covered outside Playwright,
// whose own dialog handling gets in the way: tests/preview-html.test.js.)
const ROOT = path.resolve(__dirname, '../..');
const COL = 'pv-sandbox';
// A public name that public DNS resolves to this machine (as *.nip.io does). Chromium is pinned to
// 127.0.0.1 for it as well, so the page side does not depend on the network; the app looks the
// name up itself before it lets the request out.
const ALIAS = 'localtest.me';
let application, page, profile, files, server, udp, hits = [], tcp = 0, packets = [];
const lanIp = () => { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address; return '127.0.0.1'; };
const P = (...p) => path.join(files, ...p);
const env = () => { const e = { ...process.env }; for (const key of Object.keys(e)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete e[key]; return e; };
const pageView = (run) => application.evaluate(async ({ webContents }, source) => {
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
  if (!wc) return null;
  return { url: wc.getURL(), title: wc.getTitle(), result: source ? await wc.executeJavaScript(source) : null };
}, run || '');

test.beforeAll(async () => {
  server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('local service'); });
  server.on('connection', () => { tcp++; });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  udp = dgram.createSocket('udp4');
  udp.on('message', (msg, from) => packets.push(from.address));
  await new Promise((resolve) => udp.bind(0, '0.0.0.0', resolve));
  const port = server.address().port, uport = udp.address().port, ip = lanIp();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adpvsb-'));
  files = path.join(profile, 'f');
  fs.mkdirSync(P('report'), { recursive: true });
  fs.writeFileSync(P('report', 'net.html'), `<!doctype html><meta charset="utf-8"><title>net</title><script>
    (async () => {
      const out = {};
      try { out.alias = await (await fetch('http://${ALIAS}:${port}/dns')).text(); } catch (e) { out.alias = 'blocked'; }
      try { out.direct = (await fetch('http://${ip}:${port}/direct')).status; } catch (e) { out.direct = 'blocked'; }
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${ip}:${uport}' }, { urls: 'turn:${ip}:${port}?transport=tcp', username: 'u', credential: 'p' }] });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        out.rtc = 'started';
      } catch (e) { out.rtc = 'error ' + e.message; }
      window.__net = out; setTimeout(() => { document.title = 'net-done'; }, 4000);
    })();</script>`);
  fs.writeFileSync(P('report', 'jump.html'), `<!doctype html><meta charset="utf-8"><title>jump</title><p>没人点它</p><script>setTimeout(() => { location.href = 'https://example.invalid/jumped-by-script'; }, 800);</script>`);
  fs.writeFileSync(P('report', 'next.html'), `<!doctype html><meta charset="utf-8"><title>next</title><p>下一个网页</p>`);
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 1, globalViewMode: 'term', perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    chatDeliverablesOpen: false, side: { open: false, tab: 'preview', width: 640 },
    columns: [{ id: COL, title: '预览', displayTitle: '预览', manualTitle: true, cwd: profile, width: 900, role: 'manual', cmd: '', view: 'chat' }],
  }));
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`, `--host-resolver-rules=MAP ${ALIAS} 127.0.0.1`], env: env() });
  page = await application.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate((id) => typeof terms !== 'undefined' && terms.has(id), COL), { timeout: 30000 }).toBe(true);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (udp) udp.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a name pointing at this machine is refused, and WebRTC sends no UDP to the local network', async () => {
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'net.html'), COL]);
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('net-done');
  const net = (await pageView('JSON.stringify(window.__net)')).result;
  console.log('[sandbox] net', net, 'hits', JSON.stringify(hits), 'tcp', tcp, 'udp', JSON.stringify(packets));
  expect(JSON.parse(net)).toMatchObject({ alias: 'blocked', direct: 'blocked' });
  expect(hits).toEqual([]);
  expect(packets).toEqual([]);
});

test('a page that sends itself somewhere without a click leaves the pane on the preview', async () => {
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'jump.html'), COL]);
  await page.waitForTimeout(3000);
  const tab = await page.locator('#sideTabs .side-tab.active').getAttribute('data-tab');
  const url = await page.locator('#sbUrl').inputValue();
  console.log('[sandbox] after the jump: tab', tab, 'browser url', url);
  expect(tab).toBe('preview');
  expect(url).not.toContain('jumped-by-script');
});

test('the page\'s view has its dialogs turned off, so alert() cannot cover the deck window', async () => {
  // Not by calling alert() here: Playwright handles every dialog the page reports and, with
  // the dialogs turned off, fails on "No dialog is showing" and loses the app. What alert()
  // does in such a view was checked in Electron without Playwright (bug hunt ④ report).
  await page.evaluate(([file, id]) => SidePane.openPreview(file, id), [P('report', 'next.html'), COL]);
  await expect.poll(async () => (await pageView())?.title, { timeout: 20000 }).toBe('next');
  const prefs = await application.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('agentdeck-preview://'));
    const p = wc.getLastWebPreferences();
    return { disableDialogs: p.disableDialogs, sandbox: p.sandbox };
  });
  expect(prefs).toEqual({ disableDialogs: true, sandbox: true });
});
