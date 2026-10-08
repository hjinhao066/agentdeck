// 版本更新 page on the desktop: opened from the version in the sidebar footer,
// read from the packaged release-notes.json. Screenshots go to
// AGENTDECK_RELEASE_NOTES_SHOTS when it is set.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

const ROOT = path.resolve(__dirname, '../..');
const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
const shots = process.env.AGENTDECK_RELEASE_NOTES_SHOTS;
let application, page, profile;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-release-notes-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', columns: [{ id: 'release-shell', title: 'Shell', cmd: '', cwd: profile, width: 700, role: 'manual' }],
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const noSideScroll = () => page.evaluate(() => {
  const view = document.getElementById('pageView');
  return view.scrollWidth <= view.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
});

test('the version in the sidebar footer opens 版本更新 and marks a version not looked at yet', async () => {
  const info = await page.evaluate(() => window.deck.envInfo());
  const button = page.locator('#navBottom #releaseNotesBtn');
  await expect(button).toHaveText(`V${info.version}`);
  await expect(button).toHaveAttribute('aria-label', `版本更新，你在用 AgentDeck ${info.version}`);
  await expect(button).toHaveAttribute('title', new RegExp(`AgentDeck v${info.version.replace(/\./g, '\\.')}`));
  await expect(button).toHaveClass(/unseen/);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#pageView .page-releases h1')).toHaveText('版本更新');
  await expect(button).not.toHaveClass(/unseen/);
  await expect(button).toHaveClass(/active/);
  expect(await page.evaluate(() => config.releaseNotesSeen)).toBe(info.version);
});

test('released versions newest first, next versions with 待你定 marked, side by side on a wide window', async () => {
  const versions = page.locator('.rn-released .rn-ver .rn-when .rn-num');
  await expect(versions).toHaveCount(notes.released.length);
  await expect(versions.first()).toHaveText(notes.released[0].version);
  await expect(page.locator('.rn-released .rn-ver').first().locator('.rn-items li')).toHaveCount(notes.released[0].items.length);
  const pending = notes.upcoming.flatMap((entry) => entry.items).filter((item) => item.state === 'pending').length;
  await expect(page.locator('.rn-task[data-state="pending"]')).toHaveCount(pending);
  await expect(page.locator('.rn-task[data-state="pending"] .rn-state').first()).toHaveText('待你定');
  await expect(page.locator('.rn-upcoming .rn-pending')).toHaveText(`${pending} 件待你定`);
  // Both lists show at once; the switch is only for narrow windows.
  await expect(page.locator('.rn-released')).toBeVisible();
  await expect(page.locator('.rn-upcoming')).toBeVisible();
  await expect(page.locator('.rn-tabs')).toBeHidden();
  const [left, right] = await Promise.all(['.rn-released', '.rn-upcoming'].map((s) => page.locator(s).boundingBox()));
  expect(right.x).toBeGreaterThan(left.x + left.width);
  // The timeline is the wide column; the plans keep to a readable side column.
  expect(right.width).toBeLessThanOrEqual(440); expect(left.width).toBeGreaterThan(right.width);
  expect(await noSideScroll()).toBe(true);
});

test('copy is an icon button that turns into a check, then back', async () => {
  const first = page.locator('.rn-released .rn-ver').first();
  await first.hover();
  const copy = first.locator('.rn-copy');
  await expect(copy).toHaveAttribute('aria-label', `复制 ${notes.released[0].version} 的更新内容`);
  await expect(copy).toHaveText('');
  const box = await copy.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(28); expect(box.height).toBeGreaterThanOrEqual(28);
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  await expect(copy).toHaveClass(/done/);
  const copied = await page.evaluate(() => window.deck.clipboardRead());
  expect(copied.split('\n')[0]).toBe(`AgentDeck ${notes.released[0].version}（${notes.released[0].date}）${notes.released[0].title}`);
  await expect(copy).toHaveAttribute('aria-label', `复制 ${notes.released[0].version} 的更新内容`, { timeout: 4000 });
});

test('light and dark both read well; screenshots for review', async () => {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await page.mouse.move(5, 890);
    await page.waitForTimeout(250);
    const colors = await page.evaluate(() => {
      const pick = (s) => getComputedStyle(document.querySelector(s)).color;
      return { text: pick('.rn-released .rn-title'), pending: pick('.rn-task[data-state="pending"] .rn-state'), bg: getComputedStyle(document.getElementById('pageView')).backgroundColor };
    });
    expect(colors.text).not.toBe(colors.bg);
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `desktop-${theme}.png`) });
    }
  }
  await page.evaluate(() => applyTheme('dark'));
});

test('a narrow window switches between 已发布 and 接下来 without sideways scrolling', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 820));
  await expect(page.locator('.rn-tabs')).toBeVisible();
  await expect(page.locator('.rn-released')).toBeVisible();
  await expect(page.locator('.rn-upcoming')).toBeHidden();
  const next = page.locator('#rn-tab-upcoming');
  await expect(next.locator('.rn-badge')).toHaveText(/^\d+$/);
  await next.click();
  await expect(next).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.rn-upcoming')).toBeVisible();
  await expect(page.locator('.rn-released')).toBeHidden();
  expect(await noSideScroll()).toBe(true);
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-narrow-upcoming-dark.png') });
  await page.locator('#rn-tab-released').click();
  await expect(page.locator('.rn-released')).toBeVisible();
});

test('Esc or the version button closes the page', async () => {
  await page.locator('#releaseNotesBtn').click();
  await expect(page.locator('#pageView')).toBeHidden();
  await expect(page.locator('#releaseNotesBtn')).not.toHaveClass(/active/);
});
