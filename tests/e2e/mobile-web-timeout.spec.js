const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const closeElectron = require('./fixtures/close-electron');
const { HUB_HEADERS } = require('../fixtures/hub-proxy');
const { MobileWebServer } = require('../../mobile-web');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;

// A slow network on the way to the computer: after 15 seconds without an answer
// the phone says 没连上 and offers 重试. The retry carries the same key as the
// first try, so whichever of the two reaches the computer first is the only one
// the Captain ever gets. Real AgentDeck (single page) and a real MobileWebServer
// behind a stand-in entry (hub); the slowness is injected in the browser.
test.describe.configure({ timeout: 150_000 });
let application, desktop, browser, mobile, profile, hubServer, proxy;
const captures = () => {
  const file = path.join(profile, 'prompts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function shot(name) {
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (!process.env.AGENTDECK_TIMEOUT_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_TIMEOUT_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await mobile.screenshot({ path: path.join(dir, name + '.png'), animations: 'disabled' });
}

async function launchApp() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-timeout-e2e-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
    theme: 'light', fitWindow: true, fitCols: 1, captainTokenSaver: { enabled: false }, mobileWeb: { enabled: false, port },
    mainSession: { colId: 'timeout-captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [{ id: 'timeout-captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile }] }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'timeout-captain.json'), JSON.stringify({ v: 1, id: 'timeout-captain', turns: [{
    id: 'timeout-history', ts: Date.now() - 60_000, user: '今晚把看板锁和手机重试修好。', reply: '队长测试回复：已安排队员处理。', done: true, atts: [] }] }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await expect.poll(() => captures().some((text) => text.startsWith('你是 AgentDeck')), { timeout: 25000 }).toBe(true);
  await expect.poll(() => desktop.evaluate(() => terms.get('timeout-captain')?.state), { timeout: 20000 }).toBe('done');
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('#mobileWebEnabled').check();
  await expect(desktop.locator('#mobileWebUrl')).not.toHaveValue('');
  const url = await desktop.locator('#mobileWebUrl').inputValue();
  const token = await desktop.locator('#mobileWebToken').inputValue();
  await desktop.locator('#notificationSettingsClose').click();
  browser = await chromium.launch();
  mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' })).newPage();
  await mobile.goto(url);
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('今晚把看板锁', { timeout: 15000 });
}
// A desktop draft the user has not sent holds the Captain's delivery, like a
// Captain busy with something else: the computer has the message, the
// conversation does not show it yet.
async function holdDelivery() {
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.evaluate(() => ChatUI.setMode('timeout-captain', 'chat'));
  await composer.fill('桌面上还没发的草稿');
  return async () => { await composer.fill(''); };
}
// Watches every POST to the Captain; `first` decides what happens to the first one.
async function slowFirstSend(page, pattern, first) {
  const posts = [];
  let retried;
  const retry = new Promise((resolve) => { retried = resolve; });
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    posts.push(request.postDataJSON());
    if (posts.length > 1) { const response = await route.fetch(); await route.fulfill({ response }); retried(response.status()); return; }
    await first(route, retry);
  });
  return posts;
}
async function failedBubble(text, started) {
  const failed = mobile.locator('.outgoing[data-state="failed"]').filter({ hasText: text });
  await expect(failed).toContainText('没连上', { timeout: 25000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(14_500);
  await expect(failed).toContainText('重试');
  // Retry, edit and close are icon buttons: tooltip, accessible name, 44px target, reachable by keyboard.
  const names = ['重新发送这条消息', '重新编辑这条消息', '关掉这条没发出的消息'];
  for (const name of names) {
    const button = failed.getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('title', name);
    await expect(button).toBeEnabled();
    expect(await button.evaluate((el) => el.textContent.trim() === '' && !!el.querySelector('svg') && el.tabIndex === 0 && el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)).toBe(true);
  }
  await failed.getByRole('button', { name: names[0], exact: true }).focus();
  await mobile.keyboard.press('Tab');
  expect(await mobile.evaluate(() => [document.activeElement.getAttribute('aria-label'), document.activeElement.matches(':focus-visible'), getComputedStyle(document.activeElement).outlineStyle])).toEqual([names[1], true, 'solid']);
  return failed;
}

test.afterEach(async () => {
  if (browser) await browser.close(); browser = null;
  if (application) await closeElectron(application); application = null;
  if (hubServer) await hubServer.close(); hubServer = null;
  if (proxy) await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections(); }); proxy = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true }); profile = null;
});

test('single page: the computer took the message but the answer is lost; 没连上 → 重试, the Captain gets it once', async () => {
  await launchApp();
  const release = await holdDelivery();
  const message = '慢网测试：回执晚了也只能收到一遍';
  // The first try reaches AgentDeck at once; its answer is held past the phone's 15 seconds.
  const posts = await slowFirstSend(mobile, '**/api/captain', async (route, retry) => {
    const response = await route.fetch();
    await Promise.race([retry, sleep(60_000)]);
    await route.fulfill({ response }).catch(() => { /* The phone gave up on it long ago. */ });
  });
  await mobile.getByLabel('给队长的消息').fill(message);
  const started = Date.now();
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('.outgoing[data-state="sending"]')).toContainText(message);
  const failed = await failedBubble(message, started);
  await shot('single-timeout-light');
  await mobile.emulateMedia({ colorScheme: 'dark' });
  await expect(mobile.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot('single-timeout-dark');
  await mobile.emulateMedia({ colorScheme: 'light' });

  await failed.getByRole('button', { name: '重新发送这条消息', exact: true }).click();
  await expect(mobile.locator('.outgoing[data-state="sent"]')).toContainText(message);
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  expect(posts.length).toBe(2);
  expect(posts[0].deduplicationKey).toMatch(/^[0-9a-f]{32}$/);
  expect(posts[1].deduplicationKey).toBe(posts[0].deduplicationKey);
  expect(posts[1].message).toBe(message);

  await release();
  await expect.poll(() => captures().filter((text) => text === message).length, { timeout: 25000 }).toBe(1);
  await sleep(5000);
  expect(captures().filter((text) => text === message).length).toBe(1);
  expect(await desktop.evaluate((text) => ChatUI.turnsOf('timeout-captain').filter((t) => t.user === text).length, message)).toBe(1);
  await expect(mobile.locator('#captain-turns .user-message').filter({ hasText: message })).toHaveCount(1, { timeout: 15000 });
});

test('single page: the first try is stuck on the way and lands after the retry; the Captain still gets it once', async () => {
  await launchApp();
  const release = await holdDelivery();
  const message = '慢网测试：第一次晚到也不会重复';
  let late;
  const posts = await slowFirstSend(mobile, '**/api/captain', async (route, retry) => {
    // Held in the network until the retry went through, then it arrives after all.
    await Promise.race([retry, sleep(60_000)]);
    late = await mobile.context().request.fetch(route.request());
    await route.abort().catch(() => { /* The phone gave up on it long ago. */ });
  });
  await mobile.getByLabel('给队长的消息').fill(message);
  const started = Date.now();
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  const failed = await failedBubble(message, started);
  await failed.getByRole('button', { name: '重新发送这条消息', exact: true }).click();
  await expect(mobile.locator('.outgoing[data-state="sent"]')).toContainText(message);
  await expect.poll(() => late && late.status(), { timeout: 15000 }).toBe(200);
  expect(await late.json()).toEqual({ queued: true });
  expect(posts.map((p) => p.deduplicationKey)).toEqual([posts[0].deduplicationKey, posts[0].deduplicationKey]);

  await release();
  await expect.poll(() => captures().filter((text) => text === message).length, { timeout: 25000 }).toBe(1);
  await sleep(5000);
  expect(captures().filter((text) => text === message).length).toBe(1);
});

test('hub: a computer that does not answer for 15 seconds shows 没连上 → 重试, and the retry is not sent twice', async () => {
  // The real MobileWebServer of one computer, behind a stand-in for the HTTPS entry.
  const ORIGIN = 'https://hub.agentdeck.test';
  const sent = [];
  const captain = { id: 'mac-captain', title: '队长', status: 'working', turns: [{ id: 'h1', ts: Date.now() - 60_000, user: '今晚把看板锁和手机重试修好。', reply: '队长测试回复：已安排队员处理。', done: true }] };
  hubServer = new MobileWebServer({ getSessions: () => [{ id: 'mac-captain', title: '队长', model: 'Claude', status: 'working', isMain: true, receipt: '' }], getTasks: () => [],
    getCaptain: () => captain, getOutput: () => null, saveSettings: () => {}, sendCaptain: (message) => { sent.push(message); }, machine: { platform: 'darwin', hostname: 'mac', appVersion: '2.0.0' } });
  const status = await hubServer.configure({ enabled: true, port: 0, publicOrigin: ORIGIN, basePath: '/mac/', label: 'Mac' });
  const upstream = new URL(status.url);
  const HUB = path.join(ROOT, 'mobile-web', 'hub');
  const files = { '/': 'index.html', '/core.js': 'core.js', '/app.js': 'app.js', '/releases.js': 'releases.js', '/style.css': 'style.css' };
  const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
  proxy = http.createServer((req, res) => {
    if (req.url.startsWith('/mac/')) {
      // Like the entry: TLS ends here, the computer sees its public origin and the client address.
      const headers = { ...req.headers, host: new URL(ORIGIN).host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' };
      if (headers.origin) headers.origin = ORIGIN;
      const forward = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (answer) => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
      forward.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      return req.pipe(forward);
    }
    const route = req.url.split('?')[0];
    if (route === '/machines.json') { res.writeHead(200, { ...HUB_HEADERS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ machines: [{ id: 'mac', label: 'Mac', basePath: '/mac/', platform: 'darwin', default: true }] })); }
    if (route === '/release-notes.json') { res.writeHead(200, { ...HUB_HEADERS, 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(path.join(ROOT, 'release-notes.json'))); }
    if (!files[route]) { res.writeHead(404, HUB_HEADERS); return res.end(); }
    res.writeHead(200, { ...HUB_HEADERS, 'Content-Type': types[files[route].split('.').pop()] + '; charset=utf-8' });
    res.end(fs.readFileSync(path.join(HUB, files[route])));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' })).newPage();
  await mobile.goto(`http://localhost:${proxy.address().port}/`);
  const card = mobile.getByRole('article', { name: 'Mac', exact: true });
  await card.getByLabel('Mac 的登录 token').fill(status.token);
  await card.getByRole('button', { name: '登录 Mac', exact: true }).click();
  await mobile.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '队长', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('今晚把看板锁', { timeout: 15000 });

  const message = '总台慢网测试：只收到一遍';
  const posts = await slowFirstSend(mobile, '**/mac/api/captain', async (route, retry) => {
    const response = await route.fetch();
    await Promise.race([retry, sleep(60_000)]);
    await route.fulfill({ response }).catch(() => { /* The phone gave up on it long ago. */ });
  });
  await mobile.getByLabel('给队长的消息').fill(message);
  const started = Date.now();
  await mobile.locator('#send').click();
  const failed = await failedBubble(message, started);
  await expect(failed).toContainText('没连上 Mac');
  expect(sent).toEqual([message]);
  await shot('hub-timeout-light');
  await mobile.emulateMedia({ colorScheme: 'dark' });
  await expect(mobile.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot('hub-timeout-dark');
  await mobile.emulateMedia({ colorScheme: 'light' });

  await failed.getByRole('button', { name: '重新发送这条消息', exact: true }).click();
  await expect(mobile.locator('.outgoing[data-state="sent"]')).toContainText(message);
  expect(posts.length).toBe(2);
  expect(posts[0].deduplicationKey).toMatch(/^[0-9a-f]{32}$/);
  expect(posts[1].deduplicationKey).toBe(posts[0].deduplicationKey);
  await sleep(2000);
  expect(sent).toEqual([message]);

  // Closing a failed message takes it off the phone; nothing is sent.
  await mobile.route('**/mac/api/captain', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"offline":true}' }) : route.fallback());
  await mobile.getByLabel('给队长的消息').fill('这条不发了');
  await mobile.locator('#send').click();
  const dropped = mobile.locator('.outgoing[data-state="failed"]').filter({ hasText: '这条不发了' });
  await dropped.getByRole('button', { name: '关掉这条没发出的消息', exact: true }).click();
  await expect(dropped).toHaveCount(0);
  expect(sent).toEqual([message]);
});
