const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// 版本更新 in the phone hub: 每日进展 from the Mac's api/progress on top, then
// every version newest first. On a phone the entry is the row at the foot of
// 总览 (with the version); on a tablet lying on its side, the version at the
// foot of the sidebar. Windows plays an old build with no api/info; a Mac on
// a build before api/progress (404) says so in the card and shows the rest.
// Screenshots go to AGENTDECK_RELEASE_NOTES_SHOTS when it is set.
const notes = JSON.parse(fs.readFileSync(path.join(__dirname, '../../release-notes.json'), 'utf8'));
const pending = notes.upcoming.flatMap((e) => e.items).filter((i) => i.state === 'pending').length;
const latest = notes.released[0];
// The Mac runs this build, which release-notes.test.js keeps equal to the newest
// release, so the newest version carries the 「Mac 在用」 mark.
const macVersion = require('../../package.json').version;
const shots = process.env.AGENTDECK_RELEASE_NOTES_SHOTS;
const day = (date, done, sessions, projects) => ({ date, partial: false,
  summary: { projects: projects.length, done, created: done - 3, sessions, reject: 5, rework: 9, needsUser: 2, deliveries: 2 },
  projects: projects.map(([name, n]) => ({ name, done: n, created: 1, doing: 0, sessions: n, reject: 0, rework: 0, needsUser: 0 })),
  deliveries: ['AgentDeck 1.8 全部交付完成', '1.8 包就绪'] });
const DAYS = [day('2026-10-07', 58, 51, [['agentdeck', 33], ['秋招', 4], ['experience-learning', 4], ['daily-reflection', 3], ['memory-unified', 3], ['jarvis-todo', 3]]),
  day('2026-10-06', 55, 40, [['agentdeck', 40], ['秋招', 15]]), day('2026-10-05', 97, 81, [['agentdeck', 60], ['秋招', 20], ['hermes', 17]])];
let hub, context, page, problems;

async function open(browser, size, { theme = 'dark', progress = DAYS } = {}) {
  hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', appVersion: macVersion, progress }, { id: 'win', label: 'Windows', platform: 'win32', appVersion: '1.8.0' }] });
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
  await expect(page.locator('#releases-entry')).toContainText('V' + macVersion);
}
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth
  && [...document.querySelectorAll('#releases *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5));
const shot = async (name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); } };
const versions = () => [...[...notes.upcoming].reverse().map((e) => e.version || '以后'), ...notes.released.map((e) => e.version)];
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

test('phone: the version row on 总览 opens 每日进展 and every version, newest first; copy turns into a check', async ({ browser }) => {
  await open(browser, { width: 390, height: 844 });
  const entry = page.locator('#releases-entry');
  await expect(entry).toHaveAttribute('aria-label', `版本更新与每日进展，Mac 在用 ${macVersion}，${pending} 件待你定`);
  expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await entry.click();
  await expect(page.locator('#releases-view')).toBeVisible();
  await expect(page.locator('#brand-title')).toHaveText('版本更新');
  await expect(page.locator('#back')).toHaveAttribute('aria-label', '返回总览');

  const card = page.locator('#releases .dp');
  await expect(card.locator('.dp-big')).toHaveText('58');
  await expect(card.locator('.dp-day')).toContainText('10-07');
  await expect(card.locator('.dp-col')).toHaveCount(3);
  await expect(card.locator('.dp-stats li.need b')).toHaveText('2');
  await expect(card.locator('.dp-projects li')).toHaveCount(5);
  await expect(card.locator('.dp-more')).toHaveText('另有 1 个项目');
  await expect(card.locator('.dp-source')).toHaveText('来自 Mac');
  for (const b of await card.locator('button').all()) {
    const box = await b.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(await noOverflow()).toBe(true);
  await shot('phone-progress-dark.png');
  await card.getByRole('button', { name: '前一天' }).click();
  await expect(card.locator('.dp-big')).toHaveText('55');
  await expect(card.getByRole('button', { name: '前一天' })).toBeFocused();
  await card.locator('.dp-col', { hasText: '10-05' }).click();
  await expect(card.locator('.dp-big')).toHaveText('97');
  // Polling goes on underneath without rebuilding the card (the chosen day, the focus and a copy check stay).
  await card.evaluate((el) => { el.dataset.kept = '1'; });
  const polls = hub.machines.mac.requests.filter((r) => r.url.endsWith('/api/snapshot')).length;
  await expect.poll(() => hub.machines.mac.requests.filter((r) => r.url.endsWith('/api/snapshot')).length, { timeout: 15000 }).toBeGreaterThan(polls);
  await page.waitForTimeout(300);
  await expect(page.locator('#releases .dp[data-kept="1"] .dp-big')).toHaveText('97');

  await expect(page.locator('#releases .rn-line > .rn-ver .rn-when .rn-num')).toHaveText(versions());
  await expect(page.locator('#releases .rn-group')).toHaveText(['计划中', '已发布']);
  await expect(page.locator('#releases .rn-task[data-state="pending"] .rn-state')).toHaveCount(pending);
  const first = page.locator('#releases .rn-ver.latest');
  await expect(first.locator('.rn-mine')).toHaveText('Mac 在用');
  await expect(page.locator('#releases .rn-mine')).toHaveCount(1);
  await first.scrollIntoViewIfNeeded();
  await shot('phone-released-dark.png');
  const copy = first.locator('.rn-copy');
  const label = `复制 ${latest.version} 的更新内容`;
  await expect(copy).toHaveAttribute('aria-label', label);
  const box = await copy.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  expect((await page.evaluate(() => navigator.clipboard.readText())).split('\n')[0]).toBe(`AgentDeck ${latest.version}（${latest.date}）${latest.title}`);
  await expect(copy).toHaveAttribute('aria-label', label, { timeout: 4000 });
  await page.locator('#releases .rn-plan').first().scrollIntoViewIfNeeded();
  await shot('phone-planned-dark.png');
  expect(await noOverflow()).toBe(true);

  await page.locator('#back').click();
  await expect(page.locator('#overview-view')).toBeVisible();
});

test('phone at 320 wide in light: nothing runs off the side', async ({ browser }) => {
  await open(browser, { width: 320, height: 640 }, { theme: 'light' });
  await page.locator('#releases-entry').click();
  await expect(page.locator('#releases .dp-big')).toHaveText('58');
  expect(await noOverflow()).toBe(true);
  // The four counts keep their names whole (two by two here).
  expect(await page.locator('#releases .dp-stats span').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
  await shot('phone-320-light.png');
});

test('a Mac on a build before 每日进展: the card says to upgrade, the versions still show', async ({ browser }) => {
  await open(browser, { width: 390, height: 844 }, { progress: null });
  await page.locator('#releases-entry').click();
  await expect(page.locator('#releases .dp-empty-title')).toHaveText('Mac 上的 AgentDeck 还是旧版');
  await expect(page.locator('#releases .rn-ver.latest .rn-num')).toHaveText(latest.version);
  await shot('phone-old-mac-dark.png');
});

for (const theme of ['dark', 'light']) {
  test(`tablet on its side (${theme}): the version at the foot of the sidebar opens the same page`, async ({ browser }) => {
    await open(browser, { width: 1366, height: 1024 }, { theme });
    const version = page.locator('#side-version');
    await expect(version).toHaveText('V' + macVersion);
    await version.click();
    await expect(version).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#releases .dp-big')).toHaveText('58');
    await expect(page.locator('#releases .rn-line > .rn-ver .rn-when .rn-num')).toHaveText(versions());
    expect(await noOverflow()).toBe(true);
    await shot(`tablet-landscape-${theme}.png`);
  });
}

test('notes that cannot be read say so in plain words, and refresh tries again', async ({ browser }) => {
  await open(browser, { width: 390, height: 844 });
  await page.route('**/release-notes.json', (route) => route.fulfill({ status: 404, body: '' }));
  await page.reload();
  await page.locator('#releases-entry').click();
  await expect(page.locator('#releases .rn-all .dp-empty-title')).toHaveText('没读到版本更新内容');
  await expect(page.locator('#releases .rn-all')).toContainText('点右上角的刷新再试一次');
  await page.unroute('**/release-notes.json');
  await page.locator('#refresh').click();
  await expect(page.locator('#releases .rn-ver.latest .rn-num')).toHaveText(latest.version);
});
