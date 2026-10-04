const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
// All quota numbers come from the offline quota-agent stand-in, not live usage.
const shots = process.env.AGENTDECK_TOPBAR_SHOTS;
let app, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-topbar-'));
  const col = (id, title, cmd, extra = {}) => ({ id, title, cmd, cwd: profile, width: 600, role: 'manual', ...extra });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude' }, { id: 'us', name: '🇺🇸 US', configDir: '~/.claude-us' }],
    activeClaudeSeatId: 'cn', mainSession: { colId: 'tb-cn', tasks: [], pending: [] },
    columns: [
      // quota-agent prints Claude numbers for any seat argument other than "cn".
      col('tb-cn', 'CN 模拟会话', `node "${FAKE}" Claude us`, { claudeSeatId: 'cn', isMain: true }),
      col('tb-us', 'US 模拟会话', `node "${FAKE}" Claude cn`, { claudeSeatId: 'us' }),
      ...['Codex', 'Cursor', 'Antigravity'].map((p) => col(`tb-${p}`, `${p} 模拟会话`, `node "${FAKE}" ${p}`)),
    ],
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('#quotaBar [data-seat-id="cn"] .quota-label')).toHaveText('5h 19% · 7d 91%', { timeout: 20000 });
  await expect(page.locator('#quotaBar [data-provider="Codex"] .quota-label')).toHaveText('8%');
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

// Every visible top-bar control sits on one row, inside the bar, without touching its neighbour.
async function topBarGeometry() {
  return page.evaluate(() => {
    const bar = document.getElementById('topBar').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#topBar button')].filter((b) => b.offsetParent && getComputedStyle(b).display !== 'none');
    const boxes = nodes.map((b) => ({ id: b.id || b.dataset.cols || b.title, ...b.getBoundingClientRect().toJSON() }));
    const overlaps = [];
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push([a.id, b.id]);
    }));
    const center = (b) => b.top + b.height / 2;
    return {
      overlaps,
      rows: new Set(boxes.map((b) => Math.round(center(b)))).size,
      outside: boxes.filter((b) => b.left < bar.left - 0.5 || b.right > bar.right + 0.5 || b.top < bar.top || b.bottom > bar.bottom).map((b) => b.id),
      tallest: Math.max(...boxes.map((b) => b.height)),
      overflow: document.getElementById('topBar').scrollWidth - document.getElementById('topBar').clientWidth,
      ids: boxes.map((b) => b.id),
    };
  });
}
async function expectTidy() {
  const g = await topBarGeometry();
  expect(g.overlaps).toEqual([]);
  expect(g.outside).toEqual([]);
  expect(g.rows).toBeLessThanOrEqual(2); // 30px rail buttons and 24px split pills share a centre line ±1px
  expect(g.tallest).toBeLessThanOrEqual(30);
  expect(g.overflow).toBeLessThanOrEqual(0);
  return g;
}
async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}

test('top bar keeps only the core controls, the free layout is an icon and quota lives in the sidebar', async () => {
  await expect(page.locator('#topBar .quota-item')).toHaveCount(0);
  await expect(page.locator('#colNav #quotaBar .quota-item')).toHaveCount(5);
  const free = page.locator('#tbSplit .split-btn[data-cols="0"]');
  await expect(free.locator('svg')).toBeVisible();
  expect((await free.textContent()).trim()).toBe('');
  await expect(free).toHaveAttribute('aria-label', '自由宽度');
  await expect(free).toHaveAttribute('title', /自由宽度/);
  for (const b of await page.locator('#topBar button:visible, #navBottom button').all()) {
    expect(await b.getAttribute('aria-label')).toBeTruthy();
    expect(await b.getAttribute('title')).toBeTruthy();
  }
  const g = await expectTidy();
  expect(g.ids).toEqual(['boardViewBtn', 'navCollapseBtn', '新对话 (Cmd+N)', '0', '2', '3', '4', '5', 'globalViewToggle', 'sideToggleBtn']);
  await expect(page.locator('#broadcastBtn')).toBeVisible(); // moved to the sidebar footer
  await expect(page.locator('#quotaBar [data-seat-id="cn"] .quota-name')).toHaveText('🇨🇳 CN · 队长');
  await expect(page.locator('#quotaBar [data-provider="Codex"]')).toHaveAttribute('data-state', 'danger');
});

test('details open beside a quota row on hover and on click', async () => {
  const row = page.locator('#quotaBar [data-seat-id="cn"]');
  await row.hover();
  const tip = row.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('重置');
  const [rowBox, tipBox, nav] = await Promise.all([row.boundingBox(), tip.boundingBox(), page.locator('#colNav').boundingBox()]);
  expect(tipBox.x).toBeGreaterThanOrEqual(nav.x + nav.width);
  expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  await page.mouse.move(900, 500);
  await row.click();
  await page.mouse.move(900, 500);
  await expect(tip).toBeVisible(); // a click keeps it open until focus moves
  await page.evaluate(() => document.activeElement.blur());
  await expect(tip).toBeHidden();
});

test('no wrapping or overlap at common and minimum window sizes, both themes', async () => {
  for (const [width, height] of [[1440, 900], [1280, 800], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await expectTidy();
      await shot(`${width}x${height}-${theme}`);
      // Focus opens the same details as hover; the test window ignores real mouse moves.
      await page.locator('#quotaBar [data-seat-id="cn"]').focus();
      await shot(`${width}x${height}-${theme}-quota-detail`);
      await page.evaluate(() => document.activeElement.blur());
    }
  }
  await page.evaluate(() => applyTheme('dark'));
  for (const width of [640, 800, 1024]) {
    await page.setViewportSize({ width, height: 600 });
    await expectTidy();
    if (width === 640) await shot('640x600-dark-narrow');
    // The widest sidebar is capped so the deck keeps room for the top bar.
    await page.evaluate(() => { config.navWidth = NAV_MAX_W; applyNavWidth(); });
    await expectTidy();
    if (width === 640) await shot('640x600-dark-narrow-wide-sidebar');
    await page.evaluate(() => { config.navWidth = NAV_DEFAULT_W; applyNavWidth(); });
  }
  // Squeezed further (e.g. the right pane is open too): only the active width
  // choice stays, and a menu offers the rest — still one row, nothing clipped.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.getElementById('topBar').style.width = '300px'; });
  await expect(page.locator('#topBar')).toHaveClass(/tb-compact/);
  await expectTidy();
  await expect(page.locator('#tbSplit .split-btn[data-cols="3"]')).toBeHidden();
  await shot('topbar-compact-dark');
  await page.locator('#tbSplitMenu').click();
  await page.getByRole('menuitem', { name: '3 列均分' }).click();
  expect(await page.evaluate(() => [config.fitWindow, config.fitCols])).toEqual([true, 3]);
  await expect(page.locator('#tbSplit .split-btn[data-cols="3"]')).toBeVisible();
  await page.evaluate(() => { document.getElementById('topBar').style.width = ''; });
  await expect(page.locator('#topBar')).not.toHaveClass(/tb-compact/);
  await page.locator('#tbSplit .split-btn[data-cols="2"]').click();
});

test('collapsed sidebar keeps a gauge icon whose popover lists every quota', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#quotaRailBtn')).toBeHidden();
  await page.locator('#navCollapseBtn').click();
  const rail = page.locator('#quotaRailBtn');
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute('aria-label', '订阅额度');
  await expect(rail).toHaveAttribute('data-state', 'danger');
  await expectTidy();
  await rail.click();
  const pop = page.locator('#quotaPop');
  await expect(pop).toBeVisible();
  await expect(rail).toHaveAttribute('aria-expanded', 'true');
  await expect(pop.locator('.quota-item')).toHaveCount(5);
  await expect(pop.locator('[data-seat-id="us"] .quota-label')).toHaveText('未登录/无数据');
  await expect(pop.locator('[data-provider="Codex"] .quota-name')).toHaveText('ChatGPT');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await pop.locator('[data-provider="Codex"]').focus();
    await expect(pop.locator('[data-provider="Codex"]').getByRole('tooltip')).toBeVisible();
    await shot(`1440x900-${theme}-collapsed-quota`);
  }
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(rail).toBeFocused();
  await rail.click();
  await page.mouse.click(900, 600);
  await expect(pop).toBeHidden();
  for (const width of [640, 1280]) {
    await page.setViewportSize({ width, height: 600 });
    await expectTidy();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#navExpandBtn').click();
  await expect(rail).toBeHidden();
  await page.evaluate(() => applyTheme('dark'));
});
