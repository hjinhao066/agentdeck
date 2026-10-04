const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, captainTokenSaver: { enabled: false },
    mobileWeb: { enabled: false, port: 0 },
    mainSession: { colId: 'mobile-captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'mobile-captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile },
      { id: 'mobile-worker', title: '手机网页端 · 界面实现', cmd: FAKE, cwd: profile, captainCrew: true,
        lastReceipt: { summary: '会话与看板已完成，正在核对竖屏布局。', files: [] } },
      { id: 'mobile-failed', title: '数据导入 · 等待重试', cmd: FAKE, cwd: profile, captainCrew: true,
        lastReceipt: { summary: '测试夹具：连接中断，待队长安排。', failed: '测试连接中断', files: [] } },
    ],
  }));
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
  await expect(desktop.locator('.column.is-main')).toHaveCount(1);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile = await context.newPage();
}
async function login() {
  const response = await mobile.goto(url);
  expect(response.status()).toBe(401);
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
  await expect(desktop.locator('.column.is-main')).toHaveCount(1);
  const restored = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(restored.enabled).toBe(true); expect(restored.token).toBe(token);
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
  for (const theme of ['dark', 'light']) {
    await mobile.evaluate((value) => { localStorage.setItem('agentdeck-mobile-theme', value); }, theme);
    await mobile.reload();
    // Set via the public theme control if the app uses a different storage key.
    if (await mobile.locator('html').getAttribute('data-theme') !== theme) await mobile.getByRole('button', { name: '切换主题', exact: true }).click();
    await expect(mobile.locator('html')).toHaveAttribute('data-theme', theme);
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
    await mobile.getByRole('button', { name: '队长', exact: true }).click();
    await mobile.getByLabel('给队长的消息').fill('请核对手机竖屏布局，并汇总测试结果。');
    await screenshot(`captain-${theme}`);
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(persisted.mobileWeb.enabled).toBe(true); expect(persisted.mobileWeb.token).toBe(token);
  await restartDesktop();
  expect((await mobile.goto(url)).status()).toBe(200);
  await expect(mobile.getByText('会话与看板已完成，正在核对竖屏布局。')).toBeVisible();
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('#mobileWebEnabled').uncheck();
  await expect.poll(() => desktop.evaluate(() => deck.mobileWebSettings().then((s) => s.enabled))).toBe(false);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mobileWeb.enabled).toBe(false);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(profile, 'config.json')).mode & 0o777).toBe(0o600);
});

test('mobile message waits for desktop draft, goes only to Captain; forbidden controls reject', async () => {
  await launch(); await login();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.locator('#notificationSettingsClose').click();
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
  expect((await mobile.request.post(url + '/api/captain', { data: { message, to: 'mobile-worker' } })).status()).toBe(400);
  expect((await mobile.request.post(url + '/api/tasks', { data: { status: 'done' } })).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/output?id=mobile-captain')).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/sessions', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401);
  expect((await mobile.request.post(url + '/api/captain', { data: { message }, headers: { Origin: 'https://other.example' } })).status()).toBe(403);
});

test('accepted mobile messages survive a blocked delivery attempt and isolated app restart', async () => {
  await launch(); await login();
  await desktop.locator('#notificationSettingsClose').click();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await composer.fill('阻止发送的桌面草稿');
  await desktop.evaluate(() => {
    const send = deckHost.sendWhenReady;
    deckHost.sendWhenReady = (col, text, opts) => { window.mobileDeliveryOptions = opts; return send(col, text, opts); };
  });
  const message = '重启后继续送达的手机消息';
  expect((await mobile.request.post(url + '/api/captain', { data: { message } })).ok()).toBe(true);
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
});
