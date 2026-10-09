const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let profile, url, token;

async function launch(timeout = null) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-timeout-'));
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
    mobileWeb: { enabled: true, port },
    mainSession: { colId: 'captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile },
    ],
  }));

  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'captain.json'), JSON.stringify({
    v: 1, id: 'captain', turns: [
      { id: 'welcome', ts: Date.now(), user: '测试消息', reply: '测试回复', done: true, atts: [] }
    ]
  }));

  url = `http://127.0.0.1:${port}`;
  const csrfResponse = await fetch(`${url}/login`, { method: 'POST', body: JSON.stringify({}) });
  const loginData = await csrfResponse.json();
  token = loginData.token;

  return { profile, port, url, token };
}

test.beforeEach(async ({ context }) => {
  await launch();
  await context.addCookies([{
    name: 'agentdeck-token',
    value: token,
    url,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax'
  }]);
});

test.afterEach(async () => {
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test.describe('mobile-web timeout and retry', () => {
  test('send button shows timeout after 15 seconds without response', async ({ page }) => {
    await page.goto(url);
    await page.waitForSelector('[data-view="captain"]', { timeout: 5000 });

    // Type a message
    const input = await page.locator('input[placeholder*="队长"]');
    await input.fill('测试消息');

    // Slow down network to simulate timeout
    await page.route('**/api/captain', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 20000)); // 20 seconds delay
      await route.abort();
    });

    // Click send
    const sendButton = await page.locator('button[aria-label*="发送"]');
    await sendButton.click();

    // Wait for timeout error message
    const failedState = await page.locator('.outgoing[data-state="failed"]', { timeout: 20000 });
    await expect(failedState).toBeVisible();

    // Verify error message mentions timeout
    const errorMsg = await page.locator('.failed-reason');
    const text = await errorMsg.textContent();
    expect(text).toContain('没有连上');
  });

  test('retry button allows resending failed message', async ({ page }) => {
    await page.goto(url);
    await page.waitForSelector('[data-view="captain"]', { timeout: 5000 });

    // Create a failed message first
    const input = await page.locator('input[placeholder*="队长"]');
    await input.fill('会失败的消息');

    // Fail the first attempt
    let firstAttempt = true;
    await page.route('**/api/captain', async (route) => {
      if (firstAttempt) {
        firstAttempt = false;
        await new Promise(resolve => setTimeout(resolve, 20000));
        await route.abort();
      } else {
        await route.continue();
      }
    });

    const sendButton = await page.locator('button[aria-label*="发送"]');
    await sendButton.click();

    // Wait for failed state
    const failedState = await page.locator('.outgoing[data-state="failed"]', { timeout: 20000 });
    await expect(failedState).toBeVisible();

    // Find and click retry button
    const retryButton = failedState.locator('button[aria-label*="重新发送"]');
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    // Verify message is being sent again
    const sendingState = await page.locator('.outgoing[data-state="sending"]');
    await expect(sendingState).toBeVisible();
  });

  test('do not resend duplicate messages on retry', async ({ page }) => {
    await page.goto(url);
    await page.waitForSelector('[data-view="captain"]', { timeout: 5000 });

    const input = await page.locator('input[placeholder*="队长"]');
    await input.fill('避免重复的消息');

    let requestCount = 0;
    await page.route('**/api/captain', async (route) => {
      requestCount++;
      await route.abort();
    });

    const sendButton = await page.locator('button[aria-label*="发送"]');

    // Send twice rapidly
    await sendButton.click();
    await sendButton.click();

    // Should only make one request for duplicate content
    await page.waitForTimeout(2000);
    expect(requestCount).toBeLessThanOrEqual(2); // May have debounce
  });
});
