const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// 版本更新 in the phone hub: on a phone (entry at the foot of 总览, a switch
// between 已发布 and 接下来) and on a tablet lying on its side (the version at the
// foot of the sidebar, both lists side by side). Windows plays an old build that
// has no api/info: the notes come with the page, so it changes nothing here.
// Screenshots go to AGENTDECK_RELEASE_NOTES_SHOTS when it is set.
const notes = JSON.parse(fs.readFileSync(path.join(__dirname, '../../release-notes.json'), 'utf8'));
const pending = notes.upcoming.flatMap((e) => e.items).filter((i) => i.state === 'pending').length;
const latest = notes.released[0];
const shots = process.env.AGENTDECK_RELEASE_NOTES_SHOTS;
let hub, context, page, problems;

async function open(browser, size, theme = 'dark') {
  hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', appVersion: '1.9.0' }, { id: 'win', label: 'Windows', platform: 'win32', appVersion: '1.8.0' }] });
  hub.machines.win.setMode('legacy');
  context = await browser.newContext({ viewport: size, isMobile: size.width < 600, hasTouch: true, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await page.goto(hub.url);
  const card = page.getByRole('article', { name: 'Mac', exact: true });
  await card.getByLabel('Mac 的登录 token').fill(hub.machines.mac.token);
  await card.getByRole('button', { name: '登录 Mac', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Windows', exact: true })).toContainText('需要升级 AgentDeck');
}
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth
  && [...document.querySelectorAll('#releases *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5));
const shot = async (name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); } };
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

test('phone: 总览 leads to 版本更新; released and next switch; copy is an icon that turns into a check', async ({ browser }) => {
  await open(browser, { width: 390, height: 844 });
  const entry = page.locator('#releases-entry');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('aria-label', `版本更新，最新 ${latest.version}，${pending} 件待你定`);
  expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await entry.click();
  await expect(page.locator('#releases-view')).toBeVisible();
  await expect(page.locator('#brand-title')).toHaveText('版本更新');
  await expect(page.locator('#back')).toBeVisible();
  await expect(page.locator('#back')).toHaveAttribute('aria-label', '返回总览');
  // Released first: the newest version with its items, and which computer runs it.
  const first = page.locator('.rn-released .rn-ver').first();
  await expect(first.locator('.rn-when .rn-num')).toHaveText(latest.version);
  await expect(first.locator('.rn-items li')).toHaveCount(latest.items.length);
  await expect(first.locator('.rn-mine')).toHaveText('Mac 在用');
  await expect(page.locator('.rn-mine')).toHaveCount(1);
  await expect(page.locator('.rn-upcoming')).toBeHidden();
  expect(await noOverflow()).toBe(true);
  await shot('phone-released-dark.png');

  const copy = first.locator('.rn-copy');
  await expect(copy).toHaveAttribute('aria-label', `复制 ${latest.version} 的更新内容`);
  const box = await copy.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  expect((await page.evaluate(() => navigator.clipboard.readText())).split('\n')[0]).toBe(`AgentDeck ${latest.version}（${latest.date}）${latest.title}`);
  await expect(copy).toHaveAttribute('aria-label', `复制 ${latest.version} 的更新内容`, { timeout: 4000 });

  const next = page.locator('#rn-tab-upcoming');
  await expect(next).toHaveAttribute('aria-label', `接下来，${pending} 件待你定`);
  await next.click();
  await expect(next).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.rn-upcoming')).toBeVisible();
  await expect(page.locator('.rn-released')).toBeHidden();
  await expect(page.locator('.rn-task[data-state="pending"] .rn-state')).toHaveCount(pending);
  await expect(page.locator('.rn-task[data-state="pending"] .rn-state').first()).toHaveText('待你定');
  expect(await noOverflow()).toBe(true);
  await shot('phone-upcoming-dark.png');
  // Polling goes on underneath; the page is not rebuilt (the switch keeps its focus).
  await page.waitForTimeout(5500);
  await expect(next).toBeFocused();

  await page.locator('#back').click();
  await expect(page.locator('#overview-view')).toBeVisible();
});

test('phone at 320 wide in light: nothing runs off the side', async ({ browser }) => {
  await open(browser, { width: 320, height: 640 }, 'light');
  await page.locator('#releases-entry').click();
  expect(await noOverflow()).toBe(true);
  await shot('phone-320-released-light.png');
  await page.locator('#rn-tab-upcoming').click();
  expect(await noOverflow()).toBe(true);
});

for (const theme of ['dark', 'light']) {
  test(`tablet on its side (${theme}): the version at the foot of the sidebar opens both lists side by side`, async ({ browser }) => {
    await open(browser, { width: 1366, height: 1024 }, theme);
    const version = page.locator('#side-version');
    await expect(version).toHaveText('V1.9.0');
    await version.click();
    await expect(version).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.rn-tabs')).toBeHidden();
    await expect(page.locator('.rn-released')).toBeVisible();
    await expect(page.locator('.rn-upcoming')).toBeVisible();
    const [left, right] = await Promise.all(['.rn-released', '.rn-upcoming'].map((s) => page.locator(s).boundingBox()));
    expect(right.x).toBeGreaterThan(left.x + left.width);
    // The timeline is the wide column; the plans keep to a readable side column.
    expect(right.width).toBeLessThanOrEqual(440); expect(left.width).toBeGreaterThan(right.width);
    await expect(page.locator('.rn-upcoming .rn-pending')).toHaveText(`${pending} 件待你定`);
    expect(await noOverflow()).toBe(true);
    await shot(`tablet-landscape-${theme}.png`);
  });
}

test('notes that cannot be read say so in plain words, and refresh tries again', async ({ browser }) => {
  await open(browser, { width: 390, height: 844 });
  await page.route('**/release-notes.json', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  await page.locator('#releases-entry').click();
  await expect(page.locator('.rn-empty strong')).toHaveText('没读到版本更新内容');
  await expect(page.locator('.rn-empty')).toContainText('点右上角的刷新再试一次');
  await shot('phone-unreadable-dark.png');
  await page.unroute('**/release-notes.json');
  await page.locator('#refresh').click();
  await expect(page.locator('.rn-released .rn-ver').first().locator('.rn-when .rn-num')).toHaveText(latest.version);
});
