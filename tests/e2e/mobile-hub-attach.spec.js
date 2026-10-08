const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// The phone hub (the public entry on iPad and iPhone) keeps the plus button at
// the left of the input: it opens the picker, uploads to the chosen computer
// and the images reach that Captain with the message.
let hub, context, page, problems;
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

for (const [name, width, height] of [['iPad landscape', 1366, 1024], ['iPad portrait', 1024, 1366], ['iPhone', 440, 956]]) {
  test(`the input has the plus button that sends images to the Captain (${name} ${width}x${height})`, async ({ browser }) => {
    hub = await startHub();
    context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    page = await context.newPage();
    problems = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
    await page.goto(hub.url);
    for (const id of ['mac', 'win']) {
      const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
      await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
      await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
    }
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '队长', exact: true }).click();
    const { mac, win } = hub.machines;

    // An icon button with a tooltip and a name, at the left of the input, big enough for a finger.
    const attach = page.locator('#message-form').getByRole('button', { name: '添加图片', exact: true });
    await expect(attach).toBeVisible();
    await expect(attach).toBeEnabled();
    await expect(attach).toHaveAttribute('title', '添加图片');
    expect(await attach.textContent()).toBe('');
    await expect(attach.locator('svg')).toHaveCount(1);
    const [button, box] = await Promise.all([attach.boundingBox(), page.locator('#message').boundingBox()]);
    expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.x + button.width).toBeLessThanOrEqual(box.x + 1);
    await expect(page.locator('#image-input')).toHaveAttribute('accept', 'image/*');

    const dir = process.env.AGENTDECK_HUB_SCREENSHOT_DIR;
    if (dir) { fs.mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `after-${width}x${height}.png`) }); }

    // It opens the system picker; the picked screenshot uploads to the chosen computer only.
    const shot = await page.screenshot();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), attach.click()]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([{ name: 'screenshot.png', mimeType: 'image/png', buffer: shot }]);
    await expect(page.locator('.attachment[data-state="done"]')).toHaveCount(1);
    expect(mac.posts('api/upload')).toHaveLength(1);
    expect(win.posts('api/upload')).toHaveLength(0);
    await expect(page.locator('#send')).toBeEnabled();   // an image alone can be sent
    if (dir) await page.screenshot({ path: path.join(dir, `after-${width}x${height}-picked.png`) });
    await page.locator('#message').fill('看这张截图');
    await page.locator('#send').click();
    await expect(page.locator('#send-hint')).toHaveText('已排队到 Mac 队长。');
    await expect(page.locator('.attachment')).toHaveCount(0);
    const turn = mac.captain.turns.at(-1);
    expect(turn.user).toBe('看这张截图');
    expect(turn.images).toEqual([mac.uploads[0].id]);
    expect(win.messages).toEqual([]);
  });
}
