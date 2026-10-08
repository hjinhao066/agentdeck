const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHub, withRelay } = require('../fixtures/hub-proxy');

// Long settings and sheets scroll inside themselves: scrolled all the way down, the close
// button at the top and the save / action row at the bottom are still on screen and clickable.
// Desktop: an isolated profile with a stand-in Captain. Phone hub: two fake computers.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
const shots = process.env.AGENTDECK_SETTINGS_SHOTS;
const SIZES = [{ name: 'short', width: 1280, height: 640 }, { name: 'tablet-landscape', width: 1366, height: 1024 },
  { name: 'tablet-portrait', width: 1024, height: 1366 }, { name: 'phone', width: 440, height: 956 }];

// On screen and the topmost thing at its centre (nothing scrolled over it).
const reachable = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  if (!r.width || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return false;
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});
const scrollAllDown = (locator) => locator.evaluate((root) => {
  for (const el of [root, ...root.querySelectorAll('*')]) if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
  return [root, ...root.querySelectorAll('*')].some((el) => el.scrollTop > 0);
});

test.describe('desktop', () => {
  let app, page, profile;
  test.beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-settings-sticky-'));
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 2,
      columns: [{ id: 'cap', title: '队长', isMain: true, cmd: FAKE, cwd: profile }],
      mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] } }));
    const env = { ...process.env, ZDOTDIR: profile };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
    await expect.poll(async () => {
      for (const candidate of app.windows()) {
        if (await candidate.evaluate(() => typeof terms !== 'undefined' && terms.get('cap')?.alive === true).catch(() => false)) { page = candidate; return true; }
      }
      return false;
    }, { timeout: 20000 }).toBe(true);
  });
  test.afterAll(async () => {
    if (app) await closeElectron(app);
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  });
  const resize = async ({ width, height }) => {
    // Emulated, so a tablet-tall window works on a laptop screen too.
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  };

  test('settings scrolled to the bottom: close stays at the top, save stays at the bottom, Esc closes', async () => {
    test.setTimeout(90000);
    const dialog = page.locator('#notificationSettings'), close = page.locator('#notificationSettingsClose'), save = page.locator('#csSave');
    for (const size of SIZES) {
      await resize(size);
      await page.locator('#settingsBtn').click();
      await expect(dialog).toBeVisible();
      await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      expect(await scrollAllDown(page.locator('.notify-settings-body')), size.name).toBe(true);
      // The last setting really is in view: the body scrolled, not the dialog.
      expect(await reachable(page.locator('#claudeSeatsSettings')), size.name).toBe(true);
      expect(await reachable(close), size.name).toBe(true);
      expect(await reachable(save), size.name).toBe(true);
      const box = await close.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(36); expect(box.height).toBeGreaterThanOrEqual(36);
      expect((await dialog.boundingBox()).height).toBeLessThanOrEqual(size.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `desktop-settings-${size.name}-bottom.png`) }); }
      if (size.name === 'phone') { await page.keyboard.press('Escape'); } else await close.click();
      await expect(dialog).toBeHidden();
    }
  });

  test('settings: the save bar says when the explicitly saved fields are edited; saving clears it', async () => {
    await resize(SIZES[0]);
    await page.locator('#settingsBtn').click();
    const dirty = page.locator('#csDirty');
    await expect(dirty).toHaveText('');
    await page.locator('#concurrencyCap').fill('29');
    await expect(dirty).toHaveText('有改动还没保存');
    expect(await reachable(page.locator('#csSave'))).toBe(true);
    await page.locator('#csSave').click();
    await expect(page.locator('#notificationSettings')).toBeHidden();
    await page.locator('#settingsBtn').click();
    await expect(dirty).toHaveText('');
    await expect(page.locator('#concurrencyCap')).toHaveValue('29');
    await page.locator('#notificationSettingsClose').click();
  });

  test('help scrolled to the bottom keeps its close icon at the top', async () => {
    await resize(SIZES[0]);
    await page.evaluate(() => toggleHelp());
    const help = page.locator('#helpDialog'), x = page.locator('#helpX');
    await expect(help).toBeVisible();
    await expect(x).toHaveAttribute('aria-label', '关闭快捷键与使用提示');
    await expect(x.locator('svg')).toHaveCount(1);
    expect(await scrollAllDown(help)).toBe(true);
    expect(await reachable(x)).toBe(true);
    expect(await reachable(page.locator('#helpClose'))).toBe(true);
    await x.click();
    await expect(help).toBeHidden();
  });
});

test.describe('phone hub', () => {
  let hub, browser;
  test.beforeAll(async () => {
    const [mac, win] = withRelay();
    // More accounts than fit on one screen, so the sheet has to scroll.
    for (let i = 0; i < 8; i++) mac.relay.seats.push({ ...mac.relay.seats[1], id: 'x' + i, name: 'Extra ' + (i + 1) });
    hub = await startHub({ machines: [mac, win] });
    browser = await chromium.launch();
  });
  test.afterAll(async () => { if (browser) await browser.close(); if (hub) await hub.close(); });

  for (const size of SIZES.filter((s) => s.name !== 'short')) {
    test(`switch sheet scrolled to the bottom keeps its close button (${size.name})`, async () => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.width < 600, hasTouch: true, colorScheme: 'dark' });
      const page = await context.newPage();
      try {
        await page.goto(hub.url);
        for (const id of ['mac', 'win']) {
          const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
          await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
          await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
        }
        await page.getByRole('button', { name: '切换 Mac 队长', exact: true }).first().click();
        const sheet = page.locator('#switch-sheet'), close = sheet.locator('[data-action="close"]');
        await expect(sheet.locator('.seat-option')).toHaveCount(12); // the hub lists at most 12 accounts
        await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
        if (size.name === 'phone') expect(await scrollAllDown(sheet)).toBe(true);
        else await scrollAllDown(sheet);
        expect(await reachable(sheet.locator('.seat-option').last())).toBe(true);
        expect(await reachable(close)).toBe(true);
        const box = await close.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (shots) await page.screenshot({ path: path.join(shots, `hub-switch-${size.name}-bottom.png`) });
        // The confirm step: its worded actions stay at the bottom.
        await sheet.locator('.seat-option[data-seat-id="cn"]').click();
        expect(await reachable(sheet.locator('[data-action="confirm"]'))).toBe(true);
        expect(await reachable(sheet.locator('[data-action="back"]'))).toBe(true);
        await close.click();
        await expect(sheet).toBeHidden();
        // Esc closes it too.
        await page.getByRole('button', { name: '切换 Mac 队长', exact: true }).first().click();
        await expect(sheet).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(sheet).toBeHidden();
      } finally { await context.close(); }
    });
  }
});
