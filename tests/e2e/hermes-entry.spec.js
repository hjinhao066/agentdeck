const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.AGENTDECK_HERMES_SHOTS;
let application, page, profile;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hermes-entry-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'light', columns: [{ id: 'hermes-shell', title: 'Shell', cmd: '', cwd: profile, width: 700, role: 'manual' }],
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  // Never open a real browser from the test: record what main would open.
  await application.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = (url) => { globalThis.__opened.push(url); return Promise.resolve(); };
  });
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const opened = () => application.evaluate(() => globalThis.__opened.slice());

test('sidebar footer has an accessible Hermes icon button', async () => {
  const btn = page.locator('#navBottom #hermesHubBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('title', /Hermes 网页总台/);
  await expect(btn).toHaveAttribute('aria-label', /Hermes 网页总台/);
  await expect(btn).toHaveText(''); // icon only
  await expect(btn.locator('svg')).toHaveCount(1);
  const box = await btn.boundingBox();
  const sibling = await page.locator('#navBottom #settingsBtn').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.height).toBeGreaterThanOrEqual(28);
  expect(box.width).toBe(sibling.width);
  expect(box.height).toBe(sibling.height);
});

test('click and keyboard both open the console in the system browser', async () => {
  const url = await page.evaluate(() => SidebarCore.HERMES_HUB_URL);
  await page.locator('#hermesHubBtn').click();
  await expect.poll(opened).toEqual([url]);

  await page.locator('#hermesHubBtn').focus();
  await expect(page.locator('#hermesHubBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(opened).toEqual([url, url]);
  await page.keyboard.press('Space');
  await expect.poll(opened).toEqual([url, url, url]);
});

test('light and dark screenshots', async () => {
  test.skip(!SHOTS, 'AGENTDECK_HERMES_SHOTS not set');
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#themeBtn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('#hermesHubBtn').hover();
    await page.locator('#hermesHubBtn').focus();
    await page.keyboard.press('Shift'); // keyboard modality so :focus-visible shows
    await page.screenshot({ path: path.join(SHOTS, `sidebar-${theme}.png`) });
    await page.locator('#navBottom').screenshot({ path: path.join(SHOTS, `footer-${theme}.png`) });
  }
});
