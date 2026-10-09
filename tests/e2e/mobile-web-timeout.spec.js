const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const closeElectron = require('./fixtures/close-electron');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, desktop, browser, mobile, profile, url, token;

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-timeout-e2e-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false },
    theme: 'light',
    fitWindow: true,
    fitCols: 1,
    captainTokenSaver: { enabled: false },
    mobileWeb: { enabled: false, port },
    mainSession: { colId: 'captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile },
    ],
  }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'captain.json'), JSON.stringify({
    v: 1, id: 'captain', turns: [{
      id: 'welcome', ts: Date.now(), user: '开始测试', reply: '队长已就绪。', done: true, atts: []
    }]
  }));

  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });

  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('#mobileWebEnabled').check();
  await expect(desktop.locator('#mobileWebUrl')).not.toHaveValue('');
  url = await desktop.locator('#mobileWebUrl').inputValue();
  token = await desktop.locator('#mobileWebToken').inputValue();

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile = await context.newPage();

  await mobile.goto(url);
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toBeVisible({ timeout: 10000 });
}

test.describe('mobile-web timeout and retry', () => {
  test.afterEach(async () => {
    if (browser) await browser.close();
    if (application) await closeElectron(application);
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });

  test('send timeout shows error with retry button', async () => {
    await launch();

    let firstRequest = true;
    await mobile.route('**/api/captain', async (route) => {
      if (firstRequest) {
        firstRequest = false;
        await new Promise(resolve => setTimeout(resolve, 16000));
      }
      await route.abort('blockedbyclient');
    });

    const input = mobile.locator('input[placeholder*="队长"]');
    await input.fill('超时测试');
    await mobile.getByRole('button', { name: /发送|⇧/ }).click();

    await expect(mobile.locator('.failed-reason')).toContainText('没有连上', { timeout: 20000 });
    await expect(mobile.locator('.failed-foot').getByRole('button').first()).toBeVisible();
  });

  test('deduplication key sent in requests', async () => {
    await launch();

    let capturedKey = '';
    await mobile.route('**/api/captain', async (route) => {
      const body = route.request().postDataJSON();
      capturedKey = body.deduplicationKey || '';
      await route.abort('blockedbyclient');
    });

    const input = mobile.locator('input[placeholder*="队长"]');
    await input.fill('去重测试');
    await mobile.getByRole('button', { name: /发送|⇧/ }).click();

    await mobile.waitForTimeout(1000);
    expect(capturedKey).toMatch(/^msg-/);
  });
});
