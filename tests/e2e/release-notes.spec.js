// 版本更新 panel on the desktop: the version at the foot of the sidebar opens it;
// 每日进展 (from the test profile's own daily-progress folder) on top, then every
// version newest first. Screenshots go to AGENTDECK_RELEASE_NOTES_SHOTS when set.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

const ROOT = path.resolve(__dirname, '../..');
const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
const shots = process.env.AGENTDECK_RELEASE_NOTES_SHOTS;
let application, page, profile;

const project = (name, done, sessions, rework = 0) => ({ project: name, done: Array.from({ length: done }, (_, k) => ({ id: 't-' + k, title: '卡片标题不该出现' })), created: [{}], doing: [], sessions, reject: 0, rework, needs_user: [] });
const day = (date, done, sessions, projects) => ({ date, partial: false, as_of: date + 'T23:59', window: [],
  summary: { projects: projects.length, done, created: done - 3, sessions, reject: 5, rework: 9, needs_user: 2, deliveries: 3, versions: [] },
  projects, deliveries: [{ time: '22:33', text: 'AgentDeck 1.8 全部交付完成', versions: [] }, { time: '21:45', text: '1.8 包就绪', versions: [] }] });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-release-notes-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', columns: [{ id: 'release-shell', title: 'Shell', cmd: '', cwd: profile, width: 700, role: 'manual' }],
  }));
  const dir = path.join(profile, 'daily-progress');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '2026-10-05.json'), JSON.stringify(day('2026-10-05', 97, 81, [project('agentdeck', 60, 50, 4), project('秋招', 20, 12), project('hermes', 17, 19)])));
  fs.writeFileSync(path.join(dir, '2026-10-06.json'), JSON.stringify(day('2026-10-06', 55, 40, [project('agentdeck', 40, 30), project('秋招', 15, 10)])));
  fs.writeFileSync(path.join(dir, '2026-10-07.json'), JSON.stringify(day('2026-10-07', 58, 51, [project('agentdeck', 33, 27, 6), project('秋招', 4, 3), project('experience-learning', 4, 4),
    project('daily-reflection', 3, 3), project('memory-unified', 3, 3), project('jarvis-todo', 3, 3), project('fuqing-inventory', 2, 2)])));
  fs.writeFileSync(path.join(dir, '2026-10-07.md'), 'not read');
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

const panel = () => page.locator('#releasePanel');

test('the version at the foot of the sidebar opens the panel beside the sidebar and marks a version not looked at yet', async () => {
  const info = await page.evaluate(() => window.deck.envInfo());
  const button = page.locator('#navBottom #releaseNotesBtn');
  await expect(button).toHaveText(`V${info.version}`);
  await expect(button).toHaveAttribute('aria-label', `版本更新，你在用 AgentDeck ${info.version}`);
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(button).toHaveClass(/unseen/);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panel()).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(button).not.toHaveClass(/unseen/);
  expect(await page.evaluate(() => config.releaseNotesSeen)).toBe(info.version);
  const [nav, box] = await Promise.all([page.locator('#colNav').boundingBox(), panel().boundingBox()]);
  expect(box.x).toBeGreaterThanOrEqual(nav.x + nav.width);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await expect(panel().locator('h2')).toHaveText('版本更新');
});

test('每日进展 shows the newest day at a glance and other days from the columns or the arrows', async () => {
  const card = panel().locator('.dp');
  await expect(card.locator('.dp-day')).toContainText('10-07');
  await expect(card.locator('.dp-big')).toHaveText('58');
  await expect(card.locator('.dp-line')).toHaveText('推进 7 个项目 · 派出 51 个会话 · 新建 55 张卡');
  await expect(card.locator('.dp-col')).toHaveCount(3);
  await expect(card.locator('.dp-col[aria-pressed="true"] .dp-date')).toHaveText('10-07');
  await expect(card.locator('.dp-stats li.need b')).toHaveText('2');
  await expect(card.locator('.dp-projects li')).toHaveCount(5);
  await expect(card.locator('.dp-projects li').first().locator('.dp-pname')).toHaveText('agentdeck');
  await expect(card.locator('.dp-more')).toHaveText('另有 2 个项目');
  await expect(card).not.toContainText('卡片标题不该出现');
  // The arrows: newer is off on the newest day; older goes back one day and keeps the focus.
  await expect(card.getByRole('button', { name: '后一天' })).toBeDisabled();
  await card.getByRole('button', { name: '前一天' }).click();
  await expect(card.locator('.dp-big')).toHaveText('55');
  await expect(card.getByRole('button', { name: '前一天' })).toBeFocused();
  await card.locator('.dp-col', { hasText: '10-05' }).click();
  await expect(card.locator('.dp-big')).toHaveText('97');
  await expect(card.getByRole('button', { name: '前一天' })).toBeDisabled();
  await card.getByRole('button', { name: '后一天' }).click();
  await card.getByRole('button', { name: '后一天' }).click();
  await expect(card.locator('.dp-big')).toHaveText('58');
});

test('every version, planned and released, newest first on one line', async () => {
  const nums = await panel().locator('.rn-line > .rn-ver .rn-num').allTextContents();
  const planned = [...notes.upcoming].reverse().map((e) => e.version || '以后');
  expect(nums).toEqual([...planned, ...notes.released.map((e) => e.version)]);
  await expect(panel().locator('.rn-group')).toHaveText(['计划中', '已发布']);
  const pending = notes.upcoming.flatMap((e) => e.items).filter((i) => i.state === 'pending').length;
  await expect(panel().locator('.rn-task[data-state="pending"] .rn-state')).toHaveCount(pending);
  await expect(panel().locator('.rn-task[data-state="pending"] .rn-state').first()).toHaveText('待你定');
  await expect(panel().locator('.rn-ver.latest .rn-num')).toHaveText(notes.released[0].version);
  const overflow = await page.evaluate(() => { const b = document.querySelector('#releasePanel .rp-body'); return b.scrollWidth - b.clientWidth; });
  expect(overflow).toBeLessThanOrEqual(1);
});

test('copy is an icon button that turns into a check, then back', async () => {
  const latest = panel().locator('.rn-ver.latest');
  await latest.scrollIntoViewIfNeeded();
  await latest.hover();
  const copy = latest.locator('.rn-copy');
  const label = `复制 ${notes.released[0].version} 的更新内容`;
  await expect(copy).toHaveAttribute('aria-label', label);
  await expect(copy).toHaveText('');
  const box = await copy.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(28); expect(box.height).toBeGreaterThanOrEqual(28);
  await copy.click();
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  const copied = await page.evaluate(() => window.deck.clipboardRead());
  expect(copied.split('\n')[0]).toBe(`AgentDeck ${notes.released[0].version}（${notes.released[0].date}）${notes.released[0].title}`);
  await expect(copy).toHaveAttribute('aria-label', label, { timeout: 4000 });
});

test('light and dark: screenshots for review', async () => {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await panel().locator('.rp-body').evaluate((b) => { b.scrollTop = 0; });
    await page.mouse.move(1430, 890);
    await page.waitForTimeout(300);
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `desktop-panel-${theme}.png`) });
      await panel().locator('.rp-body').evaluate((b) => { const g = b.querySelectorAll('.rn-group')[1]; b.scrollTop += g.getBoundingClientRect().top - b.getBoundingClientRect().top - 12; });
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(shots, `desktop-panel-released-${theme}.png`) });
    }
  }
  await page.evaluate(() => applyTheme('dark'));
});

test('a narrow window keeps the panel inside it', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 760));
  await page.waitForTimeout(200);
  const box = await panel().boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(820);
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-panel-narrow-dark.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
});

test('Esc closes the panel and gives the focus back; the button and a click outside close it too', async () => {
  await panel().locator('.rp-close').focus();
  await page.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await expect(page.locator('#releaseNotesBtn')).toBeFocused();
  await expect(page.locator('#releaseNotesBtn')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#releaseNotesBtn').click();
  await expect(panel()).toBeVisible();
  await page.locator('#releaseNotesBtn').click();
  await expect(panel()).toBeHidden();
  await page.locator('#releaseNotesBtn').click();
  await page.mouse.click(1300, 500);
  await expect(panel()).toBeHidden();
});

test('no statistics yet: the card says when they come, the versions still show', async () => {
  const dir = path.join(profile, 'daily-progress');
  fs.renameSync(dir, dir + '-away');
  try {
    await page.locator('#releaseNotesBtn').click();
    await expect(panel().locator('.dp-empty-title')).toHaveText('还没有每日进展');
    await expect(panel().locator('.dp-empty')).toContainText('每天 0 点自动统计前一天');
    await expect(panel().locator('.rn-ver.latest .rn-num')).toHaveText(notes.released[0].version);
    await page.keyboard.press('Escape');
    await expect(panel()).toBeHidden();
  } finally { fs.renameSync(dir + '-away', dir); }
});
