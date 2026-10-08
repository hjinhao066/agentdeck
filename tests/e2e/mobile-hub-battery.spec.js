const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub, withBattery } = require('../fixtures/hub-proxy');

// 设置 · 电池模式 on the phone/tablet hub, against fake computers behind the local proxy.
// The Mac has the setting, Windows is an older build without it. Nothing here touches a real AgentDeck.
let hub, context, page, problems;

async function open(browser, { theme = 'dark', viewport = { width: 390, height: 844 }, machines = withBattery() } = {}) {
  hub = await startHub({ machines });
  context = await browser.newContext({ viewport, isMobile: viewport.width < 700, hasTouch: true, colorScheme: theme });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await page.goto(hub.url);
  for (const id of ['mac', 'win']) {
    const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
    await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
    await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
    await expect(card).toContainText('在线');
  }
}
const sheet = () => page.locator('#settings-sheet');
const macBlock = () => sheet().locator('.set-block[data-machine="mac"]');
const winBlock = () => sheet().locator('.set-block[data-machine="win"]');
async function shot(name) {
  if (!process.env.AGENTDECK_HUB_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_HUB_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
// Tool actions are icon-only with a tooltip and a name; worded controls (the 自动/关 choice) are at least 44px tall.
async function auditSheet() {
  const buttons = await sheet().locator('button').evaluateAll((elements) => elements.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { icon: button.classList.contains('icon-button'), text: button.textContent.trim(), label: button.getAttribute('aria-label'), title: button.title,
      width: Math.round(bounds.width), height: Math.round(bounds.height), svg: !!button.querySelector('svg'), role: button.getAttribute('role') };
  }));
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.height, JSON.stringify(button)).toBeGreaterThanOrEqual(44);
    expect(button.text, JSON.stringify(button)).not.toMatch(/^(复制|已复制|删除|编辑|刷新|设置|关闭|清空|返回|减少|增加|[+\-−])$/);
    if (button.icon) { expect(button.text).toBe(''); expect(button.svg).toBe(true); expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy(); expect(button.width).toBeGreaterThanOrEqual(44); }
  }
  // The sheet is fully on screen and nothing in it overflows sideways.
  await expect.poll(() => sheet().evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1 && el.scrollWidth <= el.clientWidth; })).toBe(true);
}
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  test(`settings: the battery mode of each computer is seen and changed at once, an older computer is told to upgrade (${theme})`, async ({ browser }) => {
    test.setTimeout(120000);
    await open(browser, { theme });
    const { mac, win } = hub.machines;

    // The gear is an icon button with a name and a tooltip; it opens a modal sheet.
    const gear = page.getByRole('button', { name: '设置', exact: true });
    await expect(gear).toHaveAttribute('title', '设置');
    await expect(gear).toHaveText('');
    expect((await gear.boundingBox()).width).toBeGreaterThanOrEqual(44);
    await gear.click();
    await expect(sheet()).toBeVisible();
    expect(await sheet().evaluate((el) => el.matches(':modal'))).toBe(true);
    await expect(sheet().getByRole('heading', { name: '设置', level: 2 })).toBeVisible();

    // Mac: what it says now (battery, limit 3, 2 working), mode 自动 chosen.
    await expect(macBlock().locator('.segment[data-mode][aria-checked="true"]')).toHaveText('自动');
    await expect(macBlock().locator('.step-value')).toHaveText('3');
    await expect(macBlock().locator('.set-state')).toHaveText('电池供电。同时最多开 3 个会话，多的新活排队，现在 2 个在干活。');
    // Windows is an older build: words, no controls that cannot work.
    await expect(winBlock()).toContainText('Windows 的 AgentDeck 还是旧版，更新到新版后才能在这里调整电池模式');
    await expect(winBlock().locator('button')).toHaveCount(0);
    await auditSheet();
    await shot(`battery-390-${theme}-1-open`);

    // 关: sent at once; the computer's state follows; the number greys out but stays.
    await macBlock().getByRole('radio', { name: '关' }).click();
    await expect.poll(() => mac.batteryWrites).toEqual([{ mode: 'off' }]);
    await expect(macBlock().locator('.segment[data-mode][aria-checked="true"]')).toHaveText('关');
    await expect(macBlock().locator('.set-state')).toHaveText('电池供电。电池模式已关，不限制，现在 2 个在干活。');
    await expect(macBlock().locator('.set-feedback')).toContainText('已生效，已写入这台电脑的设置');
    await expect(macBlock().locator('.set-row')).toHaveClass(/dimmed/);
    await expect(macBlock().getByRole('button', { name: '增加电池并发上限' })).toBeDisabled();
    await expect(macBlock().getByRole('button', { name: '减少电池并发上限' })).toBeDisabled();
    expect(mac.battery.mode).toBe('off');
    await shot(`battery-390-${theme}-2-off`);

    // 自动 again, then the limit: quick taps are merged into few requests, the number never goes past 10 or below 1.
    await macBlock().getByRole('radio', { name: '自动' }).click();
    await expect.poll(() => mac.battery.mode).toBe('auto');
    const more = macBlock().getByRole('button', { name: '增加电池并发上限' }), less = macBlock().getByRole('button', { name: '减少电池并发上限' });
    for (let i = 0; i < 3; i++) await more.click();
    await expect(macBlock().locator('.step-value')).toHaveText('6');                      // shown at once, before the computer confirms
    await expect.poll(() => mac.battery.cap).toBe(6);
    // Quick taps are merged (a tap that comes after the pause makes its own request); the last word is always the shown number.
    const capWrites = mac.batteryWrites.slice(2);
    expect(capWrites.length).toBeLessThanOrEqual(3);
    expect(capWrites.at(-1)).toEqual({ cap: 6 });
    await expect(macBlock().locator('.set-state')).toHaveText('电池供电。同时最多开 6 个会话，多的新活排队，现在 2 个在干活。');
    for (let i = 0; i < 12 && await more.isEnabled(); i++) await more.click();
    await expect.poll(() => mac.battery.cap).toBe(10);
    await expect(more).toBeDisabled();
    await expect(macBlock().locator('.step-value')).toHaveText('10');
    await shot(`battery-390-${theme}-3-max`);

    // The desktop changes it too (the computer's own settings box); the open sheet follows on its next read.
    mac.battery.cap = 4; mac.battery.onBattery = false;
    await expect(macBlock().locator('.step-value')).toHaveText('4', { timeout: 15000 });
    await expect(macBlock().locator('.set-state')).toContainText('接着电源。现在不限制；改成电池供电后，同时最多开 4 个会话');

    // Keyboard: the choice is reachable and operable without a pointer.
    await macBlock().getByRole('radio', { name: '关' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => mac.battery.mode).toBe('off');
    await expect(macBlock().getByRole('radio', { name: '关' })).toBeFocused();

    // A refusal: said in words, the old value comes back.
    mac.battery.refuse = '这台电脑的设置现在写不进去。';
    await macBlock().getByRole('radio', { name: '自动' }).click();
    await expect(macBlock().getByRole('alert')).toContainText('这台电脑的设置现在写不进去。');
    await expect(macBlock().locator('.segment[data-mode][aria-checked="true"]')).toHaveText('关');
    mac.battery.refuse = '';
    await shot(`battery-390-${theme}-4-refused`);

    // Closing: × (icon, named), focus returns to the gear. Escape and a tap on the dimmed page close it too.
    await sheet().getByRole('button', { name: '关闭', exact: true }).click();
    await expect(sheet()).toBeHidden();
    await expect(gear).toBeFocused();
    await gear.click();
    await page.keyboard.press('Escape');
    await expect(sheet()).toBeHidden();
  });
}

test('settings: a computer that is offline is named and cannot be changed; coming back it can', async ({ browser }) => {
  test.setTimeout(90000);
  await open(browser);
  const { mac } = hub.machines;
  mac.setMode('down');
  await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(macBlock()).toContainText('Mac');
  await expect(macBlock()).toContainText('连上以后才能看和改');
  await expect(macBlock().locator('button')).toHaveCount(0);
  mac.setMode('online');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(macBlock().locator('.segment[data-mode]')).toHaveCount(2);
});

test('settings on a tablet: the same sheet, readable and operable at 1180 wide', async ({ browser }) => {
  test.setTimeout(90000);
  await open(browser, { viewport: { width: 1180, height: 820 } });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(macBlock().locator('.segment[data-mode][aria-checked="true"]')).toHaveText('自动');
  await auditSheet();
  await macBlock().getByRole('radio', { name: '关' }).click();
  await expect.poll(() => hub.machines.mac.battery.mode).toBe('off');
  await shot('battery-1180-dark-1-open');
});

for (const theme of ['dark', 'light']) {
  test(`settings: 临时拉满 is the main control: pick how long, one tap on, an × takes it back, plugged in it is not needed (${theme})`, async ({ browser }) => {
    test.setTimeout(90000);
    await open(browser, { theme });
    const { mac } = hub.machines;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const box = () => macBlock().locator('.boost-box');
    // Off: the lead says what it does, three lengths (直到取消 chosen), one worded main action.
    await expect(box().locator('strong')).toHaveText('临时拉满');
    await expect(box()).toContainText('电池供电时也按正常上限 30 开会话，不再被省电上限 3 卡住');
    await expect(box().getByRole('radio')).toHaveText(['直到取消', '2 小时', '今天 23:59']);
    await expect(box().getByRole('radio', { name: '直到取消' })).toHaveAttribute('aria-checked', 'true');
    await auditSheet();
    await shot(`boost-390-${theme}-1-off`);

    // 2 小时 → on: one request, with the length; the card says so and the battery mode below is unchanged.
    await box().getByRole('radio', { name: '2 小时' }).click();
    await expect(box().getByRole('radio', { name: '2 小时' })).toHaveAttribute('aria-checked', 'true');
    await box().getByRole('button', { name: '临时拉满', exact: true }).click();
    await expect.poll(() => mac.batteryWrites).toEqual([{ boost: true, boostMinutes: 120 }]);
    await expect(box().locator('.boost-on')).toHaveText(/^已临时拉满（到 \d\d:\d\d）$/);
    await expect(box()).toHaveAttribute('data-boosting', 'true');
    await expect(box()).toContainText('电池下也同时开到 30 个会话。接上电源、到时间或点 × 后恢复省电上限 3');
    await expect(macBlock().locator('.set-state')).toContainText('已临时拉满：同时最多开 30 个会话，不受省电上限 3 限制');
    await expect(macBlock().locator('.segment[data-mode][aria-checked="true"]')).toHaveText('自动');
    expect([mac.battery.mode, mac.battery.cap, mac.battery.boost]).toEqual(['auto', 3, true]);
    await auditSheet();
    await shot(`boost-390-${theme}-2-on`);

    // × cancels (icon, named, 44px); the battery limit is back.
    const cancel = box().getByRole('button', { name: '取消 Mac 的临时拉满', exact: true });
    await expect(cancel).toHaveAttribute('title', '取消 Mac 的临时拉满');
    await expect(cancel).toHaveText('');
    await cancel.click();
    await expect.poll(() => mac.battery.boost).toBe(false);
    expect(mac.batteryWrites.at(-1)).toEqual({ boost: false });
    await expect(box()).toHaveAttribute('data-boosting', 'false');
    await expect(macBlock().locator('.set-state')).toContainText('同时最多开 3 个会话，多的新活排队');

    // The last length stays chosen; 直到取消 sends no end time. The keyboard reaches and operates it.
    await expect(box().getByRole('radio', { name: '2 小时' })).toHaveAttribute('aria-checked', 'true');
    await box().getByRole('radio', { name: '直到取消' }).click();
    await box().getByRole('button', { name: '临时拉满', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => mac.batteryWrites.at(-1)).toEqual({ boost: true });
    await expect(box().locator('.boost-on')).toHaveText('已临时拉满（直到取消或接电源）');

    // The computer ends it itself (plugged in): the card follows on the next read and explains.
    mac.battery.boost = false; mac.battery.onBattery = false;
    await expect(box()).toContainText('现在接着电源，本来就不限制，不需要拉满', { timeout: 15000 });
    await expect(box().getByRole('button')).toHaveCount(0);
    await shot(`boost-390-${theme}-3-plugged`);
  });
}

test('settings: 今天 23:59 sends the minutes left today; a refusal is said in words', async ({ browser }) => {
  test.setTimeout(90000);
  await open(browser);
  const { mac } = hub.machines;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const box = () => macBlock().locator('.boost-box');
  await box().getByRole('radio', { name: '今天 23:59' }).click();
  await box().getByRole('button', { name: '临时拉满', exact: true }).click();
  await expect.poll(() => mac.batteryWrites.length).toBe(1);
  const { boost, boostMinutes } = mac.batteryWrites[0];
  expect(boost).toBe(true);
  const now = new Date(), end = new Date(now); end.setHours(23, 59, 0, 0);
  expect(Math.abs(boostMinutes - Math.max(1, Math.ceil((end - now) / 60000)))).toBeLessThanOrEqual(2);
  await box().getByRole('button', { name: '取消 Mac 的临时拉满', exact: true }).click();
  await expect.poll(() => mac.battery.boost).toBe(false);
  mac.battery.refuse = '这台电脑现在不能拉满。';
  await box().getByRole('button', { name: '临时拉满', exact: true }).click();
  await expect(macBlock().getByRole('alert')).toContainText('这台电脑现在不能拉满。');
  await expect(box()).toHaveAttribute('data-boosting', 'false');
});
