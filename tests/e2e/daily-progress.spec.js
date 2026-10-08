// 每日进展 page: on the desktop from the sidebar (the test profile's own
// daily-progress folder), in the phone hub from 总览 and on a tablet from the
// sidebar (the Mac's api/progress). One overview card for the day, then one
// card per thing. Screenshots go to AGENTDECK_DAILY_PROGRESS_SHOTS when set.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');
const { startHub } = require('../fixtures/hub-proxy');
const H = require('../../mobile-web/hub/core.js');

const ROOT = path.resolve(__dirname, '../..');
const shots = process.env.AGENTDECK_DAILY_PROGRESS_SHOTS;
const shot = async (p, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: path.join(shots, name) }); } };

// Three days shaped like the daily-progress tool's files.
const card = (id, title, result = '', extra = {}) => ({ id, title, result, ...extra });
const project = (name, lists, sessions = 1) => ({ project: name, done: [], created: [], doing: [], needs_user: [], sessions, reject: 0, rework: 0, ...lists });
const many = (prefix, n) => Array.from({ length: n }, (_, k) => card(`t-${prefix}-${k}`, `${prefix} 第 ${k + 1} 件：把一件事做完并交回执`, k % 3 ? '验收通过：提交已推送，定向单测与 E2E 均核过。' : '验收通过。'));
const file = (date, projects, deliveries, summary) => ({ date, partial: false, as_of: date + 'T23:59', window: [], projects, deliveries,
  summary: { projects: projects.length, created: 12, sessions: 20, reject: 2, rework: 3, needs_user: 1, versions: [], deliveries: deliveries.length, ...summary } });
const DAY7 = file('2026-10-07', [
  project('agentdeck', {
    done: [card('t-a1', '修：网页版 ChatGPT 派活入口把「用户切了窗口」当成失败（答案其实已交付）', '验收通过。'), card('t-a2', '1.8 集成：把已过审的各项合成 release/1.8，测试并打包到就绪（不安装）', 'release/1.8 已推送，Mac 包就绪，单测 0 失败。'), ...many('agentdeck', 4)],
    doing: [card('t-a9', '队长提示词已顶到 8000 字上限：加新规则前先解决', '证据不足，返工中。', { status: 'doing' }), card('t-a8', '每日进展卡片页', '复审中', { status: 'review' })],
  }, 12),
  project('秋招', { done: [card('t-q1', '岗位 JD 批量分析：抓 100–500 条，摸清到底要什么人', '已抓取并去重落盘 300 条真实公开 JD。')], needs_user: [card('t-q2', 'JD 重做：按「不考手写代码的 AI 岗 + BI」筛已有 300 条')] }, 3),
  project('experience-learning', { done: many('经验', 2) }, 2),
  project('person-brief', { created: [card('t-p1', '只是新建')] }, 0),
], [{ time: '22:33 gen 43 US2', text: 'AgentDeck 1.8 全部交付完成', versions: ['1.8'] }, { time: '09:35 gen 43', text: '', versions: [] },
  { time: '约 03:35 真实时钟', text: 'iPad 修复已部署到 VPS', versions: [] }, { time: '21:45', text: '1.8 包就绪', versions: [] }], { done: 10 });
const DAY6 = file('2026-10-06', [project('agentdeck', { done: many('昨天', 6) }, 8)], [], { done: 6, needs_user: 0 });
const DAY5 = file('2026-10-05', [project('agentdeck', { done: many('前天', 12) }, 10), project('hermes', { done: many('hermes', 3) }, 3)],
  [{ time: '23:08', text: '1.2.4 全部交付完成', versions: [] }], { done: 15 });

test.describe('desktop', () => {
  test.describe.configure({ mode: 'serial' });
  let application, page, profile, dir;
  test.beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-daily-progress-'));
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
      theme: 'dark', columns: [{ id: 'progress-shell', title: 'Shell', cmd: '', cwd: profile, width: 700, role: 'manual' }],
    }));
    dir = path.join(profile, 'daily-progress');
    fs.mkdirSync(dir);
    for (const d of [DAY5, DAY6, DAY7]) fs.writeFileSync(path.join(dir, d.date + '.json'), JSON.stringify(d));
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
  const view = () => page.locator('#pageView .dpv');

  test('the sidebar entry opens the newest day: overview on top, then one card per thing by project', async () => {
    const entry = page.locator('#navTop .nav-row[data-nav="progress"]');
    await expect(entry).toHaveText('每日进展');
    await entry.click();
    await expect(entry).toHaveClass(/active/);
    await expect(page.locator('#pageView h1')).toHaveText('每日进展');
    await expect(view().locator('.dpv-day')).toContainText('10-07');
    await expect(view().locator('.dpv-big')).toHaveText('10');
    await expect(view().locator('.dpv-line')).toHaveText('推进 4 个项目 · 派出 20 个会话 · 新建 12 张卡');
    await expect(view().locator('.dpv-stats li span')).toHaveText(['交付', '等你决定', '返工', '审查不通过']);
    // 交付 counts the lines that have words (the log's empty entry does not count).
    await expect(view().locator('.dpv-stats li.ship b')).toHaveText('3');
    await expect(view().locator('.dpv-stats li.need b')).toHaveText('1');
    await expect(view().locator('.dpv-highlights li')).toHaveText(['AgentDeck 1.8 全部交付完成', 'agentdeck 完成 6 件，占全天 60%', '比前一天多完成 4 件']);
    await expect(view().locator('.dpv-projects .dpv-pname')).toHaveText(['agentdeck', 'experience-learning', '秋招']);
    await expect(view().locator('.dpv-delivered .dpv-time')).toHaveText(['03:35', '21:45', '22:33']);
    await expect(view().locator('.dpv-col')).toHaveCount(3);
    // The things: grouped in the overview's order, finished first, each card once.
    await expect(view().locator('.dpv-count')).toHaveText('12 件');
    await expect(view().locator('.dpv-group-name')).toHaveText(['agentdeck', 'experience-learning', '秋招']);
    const first = view().locator('.dpv-group').first();
    await expect(first.locator('.dpv-thing')).toHaveCount(8);
    await expect(first.locator('.dpv-thing').first()).toHaveAttribute('data-state', 'done');
    await expect(first.locator('.dpv-thing').last().locator('.dpv-state')).toHaveText('进行中');
    await expect(first.locator('.dpv-thing[data-state="review"] .dpv-state')).toHaveText('待验收');
    await expect(view().locator('.dpv-thing[data-state="needs_user"] .dpv-thing-title')).toHaveText('JD 重做：按「不考手写代码的 AI 岗 + BI」筛已有 300 条');
    await expect(view()).not.toContainText('只是新建');
    await expect(view()).not.toContainText('t-a1');
  });

  test('the arrows and the columns switch the day and keep the focus', async () => {
    await expect(view().getByRole('button', { name: '后一天' })).toBeDisabled();
    await view().getByRole('button', { name: '前一天' }).click();
    await expect(view().locator('.dpv-big')).toHaveText('6');
    await expect(view().getByRole('button', { name: '前一天' })).toBeFocused();
    await expect(view().locator('.dpv-delivered')).toHaveCount(0);
    await expect(view().locator('.dpv-none').first()).toHaveText('这一天没有记下交付。');
    await view().locator('.dpv-col', { hasText: '10-05' }).click();
    await expect(view().locator('.dpv-big')).toHaveText('15');
    await expect(view().locator('.dpv-col[aria-pressed="true"]')).toBeFocused();
    await expect(view().locator('.dpv-highlights li').last()).toHaveText('最近 3 天里完成最多的一天');
    await view().locator('.dpv-col', { hasText: '10-07' }).click();
    await expect(view().locator('.dpv-big')).toHaveText('10');
  });

  test('refresh is an icon button; a new night keeps the chosen day and adds the new one', async () => {
    const refresh = page.locator('#pageView .page-actions .dpv-refresh');
    await expect(refresh).toHaveAttribute('aria-label', '刷新每日进展');
    await expect(refresh).toHaveAttribute('title', '刷新');
    await expect(refresh).toHaveText('');
    const box = await refresh.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(28); expect(box.height).toBeGreaterThanOrEqual(28);
    const day8 = file('2026-10-08', [project('agentdeck', { done: many('今天', 2) }, 2)], [], { done: 2 });
    fs.writeFileSync(path.join(dir, '2026-10-08.json'), JSON.stringify(day8));
    await refresh.click();
    await expect(view().locator('.dpv-col')).toHaveCount(4);
    await expect(view().locator('.dpv-day')).toContainText('10-07');
    await expect(view().getByRole('button', { name: '后一天' })).toBeEnabled();
    fs.rmSync(path.join(dir, '2026-10-08.json'));
    await refresh.click();
    await expect(view().locator('.dpv-col')).toHaveCount(3);
  });

  test('light and dark, wide and narrow: nothing runs off the side; screenshots for review', async () => {
    const body = page.locator('#pageView .page-body');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await page.locator('#pageView').evaluate((v) => { v.scrollTop = 0; });
      await page.mouse.move(1430, 890);
      await page.waitForTimeout(250);
      await shot(page, `desktop-progress-${theme}.png`);
      await view().locator('.dpv-things').scrollIntoViewIfNeeded();
      await shot(page, `desktop-progress-cards-${theme}.png`);
    }
    // The wide layout puts the columns beside the big number and the two lists side by side.
    const [hero, chart] = await Promise.all([view().locator('.dpv-hero').boundingBox(), view().locator('.dpv-chart').boundingBox()]);
    expect(chart.x).toBeGreaterThan(hero.x + hero.width - 1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 760));
    await page.waitForTimeout(250);
    expect(await body.evaluate((b) => [...b.querySelectorAll('*')].every((el) => el.getBoundingClientRect().right <= b.getBoundingClientRect().right + 0.5))).toBe(true);
    await page.locator('#pageView').evaluate((v) => { v.scrollTop = 0; });
    await shot(page, 'desktop-progress-narrow-light.png');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.evaluate(() => applyTheme('dark'));
  });

  test('Esc closes the page; with no statistics yet it says when they come', async () => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#pageView')).toBeHidden();
    fs.renameSync(dir, dir + '-away');
    try {
      await page.locator('#navTop .nav-row[data-nav="progress"]').click();
      await expect(page.locator('#pageView .dpv-empty-title')).toHaveText('还没有每日进展');
      await expect(page.locator('#pageView .dpv-empty')).toContainText('每天 0 点自动统计前一天');
      await page.keyboard.press('Escape');
    } finally { fs.renameSync(dir + '-away', dir); }
  });
});

test.describe('phone hub', () => {
  // The Mac's api/progress answers what mobile-web.js sends: the files cleaned by HubCore.
  const DAYS = H.progressDays([DAY7, DAY6, DAY5]);
  const macVersion = require('../../package.json').version;
  let hub, context, page, problems;
  async function open(browser, size, { theme = 'dark', progress = DAYS } = {}) {
    hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', appVersion: macVersion, progress }, { id: 'win', label: 'Windows', platform: 'win32', appVersion: '1.8.0' }] });
    hub.machines.win.setMode('legacy');
    context = await browser.newContext({ viewport: size, isMobile: size.width < 600, hasTouch: true, colorScheme: theme });
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
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
    && [...document.querySelectorAll('#progress *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5));
  test.afterEach(async () => {
    const seen = problems || [];
    if (context) await context.close(); context = null;
    if (hub) await hub.close(); hub = null;
    expect(seen).toEqual([]);
  });

  for (const theme of ['dark', 'light']) {
    test(`phone (${theme}): the 每日进展 row on 总览 opens the day, then the cards; back returns`, async ({ browser }) => {
      await open(browser, { width: 390, height: 844 }, { theme });
      const entry = page.locator('#progress-entry');
      await expect(entry).toContainText('每日进展');
      expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await entry.click();
      await expect(page.locator('#progress-view')).toBeVisible();
      await expect(page.locator('#brand-title')).toHaveText('每日进展');
      await expect(page.locator('#back')).toHaveAttribute('aria-label', '返回总览');
      const v = page.locator('#progress .dpv');
      await expect(v.locator('.dpv-big')).toHaveText('10');
      await expect(v.locator('.dpv-source')).toHaveText('来自 Mac');
      await expect(v.locator('.dpv-thing')).toHaveCount(12);
      for (const b of await v.locator('button').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await noOverflow()).toBe(true);
      await shot(page, `phone-progress-${theme}.png`);
      await v.locator('.dpv-things').scrollIntoViewIfNeeded();
      await shot(page, `phone-progress-cards-${theme}.png`);
      await v.getByRole('button', { name: '前一天' }).click();
      await expect(v.locator('.dpv-big')).toHaveText('6');
      // Polling goes on underneath without rebuilding the page (the chosen day and the focus stay).
      await page.locator('#progress .dpv').evaluate((el) => { el.dataset.kept = '1'; });
      const polls = hub.machines.mac.requests.filter((r) => r.url.endsWith('/api/snapshot')).length;
      await expect.poll(() => hub.machines.mac.requests.filter((r) => r.url.endsWith('/api/snapshot')).length, { timeout: 15000 }).toBeGreaterThan(polls);
      await page.waitForTimeout(300);
      await expect(page.locator('#progress .dpv[data-kept="1"] .dpv-big')).toHaveText('6');
      await page.locator('#back').click();
      await expect(page.locator('#overview-view')).toBeVisible();
    });
  }

  test('phone at 320 wide: nothing runs off the side', async ({ browser }) => {
    await open(browser, { width: 320, height: 640 }, { theme: 'light' });
    await page.locator('#progress-entry').click();
    await expect(page.locator('#progress .dpv-big')).toHaveText('10');
    expect(await noOverflow()).toBe(true);
    expect(await page.locator('#progress .dpv-stats span').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    await shot(page, 'phone-320-light.png');
  });

  test('a Mac on a build that sends counts only: the overview shows, the cards say to upgrade', async ({ browser }) => {
    const counts = DAYS.map(({ items, delivered, ...rest }) => rest);
    await open(browser, { width: 390, height: 844 }, { progress: counts });
    await page.locator('#progress-entry').click();
    await expect(page.locator('#progress .dpv-big')).toHaveText('10');
    await expect(page.locator('#progress .dpv-things .dpv-none')).toContainText('升级到 2.1');
  });

  test('tablet on its side: 每日进展 in the sidebar opens the page wide', async ({ browser }) => {
    await open(browser, { width: 1366, height: 1024 }, { theme: 'light' });
    const side = page.locator('[data-side-view="progress"]');
    await side.click();
    await expect(side).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#progress .dpv-big')).toHaveText('10');
    expect(await noOverflow()).toBe(true);
    await shot(page, 'tablet-progress-light.png');
  });
});
