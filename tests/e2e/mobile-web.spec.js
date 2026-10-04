const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { TaskStore } = require('../../task-board');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, desktop, browser, mobile, profile, url, token;
const captures = () => {
  const file = path.join(profile, 'prompts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-e2e-'));
  // Keep the browser's origin stable across an isolated app restart.
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, captainTokenSaver: { enabled: false },
    mobileWeb: { enabled: false, port },
    mainSession: { colId: 'mobile-captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'mobile-captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile },
      { id: 'mobile-worker', title: '手机网页端 · 界面实现', cmd: FAKE, cwd: profile, captainCrew: true,
        lastReceipt: { summary: '会话与看板已完成，正在核对竖屏布局。', files: [] } },
      { id: 'mobile-failed', title: '数据导入 · 等待重试', cmd: FAKE, cwd: profile, captainCrew: true,
        lastReceipt: { summary: '测试夹具：连接中断，待队长安排。', failed: '测试连接中断', files: [] } },
    ],
  }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'mobile-captain.json'), JSON.stringify({ v: 1, id: 'mobile-captain', turns: [{
    id: 'mobile-history', ts: Date.now() - 60_000, user: '外出期间请检查队员的执行情况。',
    reply: '队长测试回复：界面任务正在核对，登录验收等待安排。\n<script>window.captainInjected=true</script>', done: true, atts: [],
  }, {
    id: 'mobile-history-latest', ts: Date.now() - 30_000, user: '手机首次打开也要看得到完整的发送按钮。',
    reply: '竖屏布局测试回复：最近对话可以上下滑动查看，发送按钮保持在底部导航上方。', done: true, atts: [],
  }] }));
  const store = new TaskStore(path.join(profile, 'tasks'));
  store.add({ id: 'mobile-todo', project: 'AgentDeck', title: '核对深浅主题', detail: '手机竖屏布局检查。' });
  store.add({ id: 'mobile-review', project: 'AgentDeck', title: '验收登录与鉴权', detail: '拒绝错误 token。' });
  store.move({ id: 'mobile-review', status: 'review' });
  store.add({ id: 'mobile-done', project: '资料整理', title: '整理项目目录', detail: '测试数据。' });
  store.move({ id: 'mobile-done', status: 'done' });
  const env = { ...process.env, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'),
    AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'columns.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await expect.poll(() => captures().some((text) => text.startsWith('你是 AgentDeck')), { timeout: 25000 }).toBe(true);
  await expect.poll(() => desktop.evaluate(() => terms.get('mobile-captain')?.state), { timeout: 20000 }).toBe('done');
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await expect(desktop.locator('#mobileWebEnabled')).not.toBeChecked();
  const disabled = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(disabled.enabled).toBe(false); expect(disabled.url).toBe(''); expect(disabled.token).toBe('');
  await desktop.locator('#mobileWebEnabled').check();
  await expect(desktop.locator('#mobileWebUrl')).not.toHaveValue('');
  url = await desktop.locator('#mobileWebUrl').inputValue();
  token = await desktop.locator('#mobileWebToken').inputValue();
  expect(token.length).toBeGreaterThanOrEqual(48);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  mobile = await context.newPage();
}
async function login() {
  const response = await mobile.goto(url);
  expect(response.status()).toBe(401);
  await screenshot('login');
  await mobile.getByLabel('登录 token').fill('wrong-token');
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('token 不正确');
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.getByRole('button', { name: '会话', exact: true })).toBeVisible();
  const cookies = await mobile.context().cookies();
  expect(cookies.find((c) => c.name === 'agentdeck_mobile')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  await mobile.reload();
  await expect(mobile.getByRole('button', { name: '会话', exact: true })).toBeVisible();
  await expect(mobile.locator('[data-view="captain"]')).toHaveAttribute('aria-current', 'page');
  await expect(mobile.locator('#captain-turns')).toContainText('外出期间请检查队员的执行情况。');
}
async function post(route, data, headers = {}) {
  const { csrfToken } = await (await mobile.request.get(url + '/api/auth')).json();
  return mobile.request.post(url + route, { data, headers: { Origin: url, 'X-CSRF-Token': csrfToken, ...headers } });
}
async function screenshot(name) {
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR) {
    const dir = path.resolve(process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    await mobile.screenshot({ path: path.join(dir, name + '.png') });
  }
}
async function restartDesktop() {
  await application.close(); application = null;
  const env = { ...process.env, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  const restored = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(restored.enabled).toBe(true); expect(restored.token === token).toBe(true);
  url = restored.url;
  return restored;
}
test.afterEach(async () => {
  if (browser) await browser.close(); browser = null;
  if (application) await application.close(); application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true }); profile = null;
});

test('isolated desktop settings, authenticated mobile views and light/dark portrait screenshots', async () => {
  await launch(); await login();
  // Real xterm output; HTML-like text must remain inert in the mobile reader.
  await desktop.evaluate(async () => {
    const col = columns.find((c) => c.id === 'mobile-worker');
    await ChatUI.sendPrompt(col, '竖屏检查 <script>window.mobileInjected=true</script>');
  });
  await expect.poll(() => captures().some((t) => t.includes('window.mobileInjected')), { timeout: 15000 }).toBe(true);
  for (const state of ['input', 'quota']) {
    await desktop.evaluate((value) => { terms.get('mobile-worker').state = value; }, state);
    const result = await (await mobile.request.get(url + '/api/sessions')).json();
    expect(result.sessions.find((session) => session.id === 'mobile-worker').status).toBe(state);
  }
  await desktop.evaluate(() => { terms.get('mobile-worker').state = 'done'; });
  for (const theme of ['dark', 'light']) {
    await mobile.evaluate((value) => { localStorage.setItem('agentdeck-mobile-theme', value); }, theme);
    await mobile.reload();
    // Set via the public theme control if the app uses a different storage key.
    if (await mobile.locator('html').getAttribute('data-theme') !== theme) await mobile.getByRole('button', { name: '切换主题', exact: true }).click();
    await expect(mobile.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
    expect(await mobile.evaluate(() => window.captainInjected)).toBeUndefined();
    await mobile.getByLabel('给队长的消息').fill('请核对手机竖屏布局，并汇总测试结果。');
    await mobile.evaluate(() => window.scrollTo(0, 0));
    const sendBounds = await mobile.locator('#send').boundingBox();
    const navBounds = await mobile.locator('.navigation').boundingBox();
    expect(sendBounds.height).toBeGreaterThanOrEqual(44);
    expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(navBounds.y);
    expect(await mobile.locator('#captain-turns').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await screenshot(`captain-${theme}`);
    await mobile.getByRole('button', { name: '会话', exact: true }).click();
    await expect(mobile.getByText('会话与看板已完成，正在核对竖屏布局。')).toBeVisible();
    await screenshot(`sessions-${theme}`);
    await mobile.getByRole('button', { name: '看板', exact: true }).click();
    await expect(mobile.getByText('核对深浅主题')).toBeVisible();
    await expect(mobile.getByText('资料整理', { exact: true })).toBeVisible();
    await screenshot(`board-${theme}`);
    await mobile.getByRole('button', { name: '会话', exact: true }).click();
    await mobile.getByRole('button', { name: '手机网页端 · 界面实现', exact: true }).click();
    await expect(mobile.locator('#outputText')).toContainText('window.mobileInjected');
    expect(await mobile.evaluate(() => window.mobileInjected)).toBeUndefined();
    await screenshot(`output-${theme}`);
    await mobile.getByRole('button', { name: '复制输出', exact: true }).click();
    await expect(mobile.getByRole('button', { name: '已复制', exact: true })).toHaveAttribute('title', '已复制');
    await mobile.setViewportSize({ width: 320, height: 740 });
    await screenshot(`output-narrow-${theme}`);
    const buttons = await mobile.locator('.icon-button:visible').evaluateAll((elements) => elements.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, label: button.getAttribute('aria-label'), title: button.title };
    }));
    for (const button of buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy();
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(persisted.mobileWeb.enabled).toBe(true); expect(persisted.mobileWeb.token === token).toBe(true);
  await restartDesktop();
  expect((await mobile.goto(url)).status()).toBe(200);
  await mobile.getByRole('button', { name: '会话', exact: true }).click();
  await expect(mobile.getByText('会话与看板已完成，正在核对竖屏布局。')).toBeVisible();
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('#mobileWebEnabled').uncheck();
  await expect.poll(() => desktop.evaluate(() => deck.mobileWebSettings().then((s) => s.enabled))).toBe(false);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mobileWeb.enabled).toBe(false);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(profile, 'config.json')).mode & 0o777).toBe(0o600);
});

test('desktop copy buttons put the login token and entry password on the clipboard', async () => {
  await launch();
  // The real preload → main path. A test profile has a private clipboard, so
  // this never reads or replaces what the user has copied.
  const copies = async (id, label, value) => {
    const button = desktop.locator(id);
    const icon = await button.innerHTML();
    await expect(button).toHaveAttribute('title', label);
    await button.click();
    await expect(button).toHaveAttribute('aria-label', '已复制');
    await expect(button).toHaveAttribute('title', '已复制');
    expect(await desktop.evaluate(() => deck.clipboardRead()) === value).toBe(true);
    await expect(button).toHaveAttribute('aria-label', label, { timeout: 5000 });
    await expect(button).toHaveAttribute('title', label);
    expect(await button.innerHTML()).toBe(icon);
  };
  await copies('#mobileWebCopyToken', '复制登录 token', token);
  // The entry password comes from the tunnel installer's private file, which a
  // test profile never reads; show the field with a stand-in value.
  const entryPassword = 'stand-in-entry-password';
  await desktop.evaluate((value) => {
    document.getElementById('mobileWebGateway').hidden = false;
    document.getElementById('mobileWebGatewayPassword').value = value;
  }, entryPassword);
  await copies('#mobileWebCopyGateway', '复制入口口令', entryPassword);
  expect(await desktop.evaluate(() => deck.clipboardRead()) === token).toBe(false);
});

test('mobile message waits for desktop draft, goes only to Captain; forbidden controls reject', async () => {
  await launch(); await login();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.locator('#notificationSettingsClose').click();
  await desktop.evaluate(() => ChatUI.setMode('mobile-captain', 'chat'));
  await composer.fill('桌面尚未发送的草稿');
  const message = '手机消息只给队长';
  await mobile.locator('[data-view="captain"]').click();
  await mobile.getByLabel('给队长的消息').fill(message);
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('');
  await expect(composer).toHaveValue('桌面尚未发送的草稿');
  // Wait beyond the first delivery check while the genuine draft remains.
  await expect.poll(() => desktop.evaluate(() => userComposing('mobile-captain'))).toBe(true);
  expect(captures().some((t) => t.includes(message))).toBe(false);
  await composer.fill('');
  await expect.poll(() => captures().includes(message), { timeout: 25000 }).toBe(true);
  expect(await desktop.evaluate((text) => ChatUI.turnsOf('mobile-captain').some((t) => t.user === text), message)).toBe(true);
  const delivered = fs.readFileSync(path.join(profile, 'columns.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((p) => p.text === message);
  expect(delivered).toEqual([{ colId: 'mobile-captain', text: message }]);
  await expect(mobile.locator('#captain-turns')).toContainText(message, { timeout: 15000 });
  expect((await post('/api/captain', { message, to: 'mobile-worker' })).status()).toBe(400);
  expect((await post('/api/tasks', { status: 'done' })).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/output?id=mobile-captain')).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/sessions', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401);
  expect((await post('/api/captain', { message }, { Origin: 'https://other.example' })).status()).toBe(403);
  expect((await mobile.request.post(url + '/api/captain', { data: { message }, headers: { Origin: url } })).status()).toBe(403);
  expect((await post('/api/captain', { message }, { 'X-CSRF-Token': 'wrong-csrf' })).status()).toBe(403);
});

test('accepted mobile messages survive a blocked delivery attempt and isolated app restart', async () => {
  await launch(); await login();
  await desktop.locator('#notificationSettingsClose').click();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.evaluate(() => ChatUI.setMode('mobile-captain', 'chat'));
  await composer.fill('阻止发送的桌面草稿');
  await desktop.evaluate(() => {
    const send = deckHost.sendWhenReady;
    deckHost.sendWhenReady = (col, text, opts) => { window.mobileDeliveryOptions = opts; return send(col, text, opts); };
  });
  const message = '重启后继续送达的手机消息';
  const oldAuth = await (await mobile.request.get(url + '/api/auth')).json();
  expect((await post('/api/captain', { message })).ok()).toBe(true);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.mobileMessages).toEqual([message]);
  // Simulate the existing channel's timeout callback; accepted text must stay
  // durable rather than being discarded when one delivery attempt gives up.
  await desktop.evaluate(() => mobileDeliveryOptions.onGiveUp());
  expect(await desktop.evaluate(() => MainSession.state().mobileMessages)).toEqual([message]);
  expect(captures().includes(message)).toBe(false);
  await restartDesktop();
  await expect.poll(() => captures().filter((t) => t === message).length, { timeout: 25000 }).toBe(1);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.mobileMessages).toEqual([]);
  expect(await desktop.evaluate((text) => ChatUI.turnsOf('mobile-captain').some((t) => t.user === text), message)).toBe(true);
  const freshMessage = '重启后手机页面继续发送新指令';
  expect((await mobile.request.post(url + '/api/captain', { data: { message: freshMessage }, headers: { Origin: url, 'X-CSRF-Token': oldAuth.csrfToken } })).status()).toBe(403);
  await Promise.all([
    mobile.waitForResponse((response) => response.url() === url + '/api/auth' && response.ok()),
    mobile.getByRole('button', { name: '刷新', exact: true }).click(),
  ]);
  await mobile.getByLabel('给队长的消息').fill(freshMessage);
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect.poll(() => captures().filter((text) => text === freshMessage).length, { timeout: 25000 }).toBe(1);
});

test('device logout and desktop revocation reject remembered devices and rotate the login token', async () => {
  await launch(); await login();
  expect((await mobile.request.post(url + '/logout', { headers: { Origin: url } })).status()).toBe(403);
  await mobile.getByRole('button', { name: '退出此设备', exact: true }).click();
  await expect(mobile.getByLabel('登录 token')).toBeVisible();
  expect((await mobile.request.get(url + '/api/sessions')).status()).toBe(401);
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
  const restored = await desktop.evaluate(() => deck.mobileWebSettings({ revoke: true }));
  expect(restored.token.length).toBeGreaterThanOrEqual(48);
  expect(restored.token !== token).toBe(true);
  expect((await mobile.request.get(url + '/api/sessions')).status()).toBe(401);
  await mobile.reload();
  await expect(mobile.getByLabel('登录 token')).toBeVisible();
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('token 不正确');
  await mobile.getByLabel('登录 token').fill(restored.token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
});
