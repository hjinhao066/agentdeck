const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

const ROOT = path.resolve(__dirname, '../..');
let application, page, profile;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-version-label-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', columns: [{ id: 'version-shell', title: 'Shell', cmd: '', cwd: profile, width: 700, role: 'manual' }],
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  // A closed Electron's helpers can still hold files in the profile for a few seconds (EPERM on Windows):
  // a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
});

test('sidebar footer shows the runtime version with accessible build details', async () => {
  const info = await page.evaluate(() => window.deck.envInfo());
  const label = page.locator('#navBottom .nav-brand');
  const details = [`AgentDeck v${info.version}`, info.build].filter(Boolean).join(' · ');

  await expect(label).toHaveText(`V${info.version}`);
  // The label is the 版本更新 button; the build details stay in its tooltip.
  await expect(label).toHaveAttribute('title', `版本更新：每版改了什么、接下来做什么（${details}）`);
  await expect(label).toHaveAttribute('aria-label', `版本更新，你在用 AgentDeck ${info.version}`);
  expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.build).toContain(info.platform);

  if (process.env.AGENTDECK_VERSION_SHOT) {
    fs.mkdirSync(path.dirname(process.env.AGENTDECK_VERSION_SHOT), { recursive: true });
    await page.locator('#navBottom').screenshot({ path: process.env.AGENTDECK_VERSION_SHOT });
  }
});

// The footer holds the version and six icon buttons; at the narrowest (200px) and the default
// (252px) sidebar the whole version stays readable and every icon keeps its full click area.
test('narrow sidebar shows the whole version and every footer button', async () => {
  const info = await page.evaluate(() => window.deck.envInfo());
  for (const theme of ['dark', 'light']) {
    for (const width of [200, 252]) {
      await page.evaluate(({ theme, width }) => { applyTheme(theme); config.navWidth = width; applyNavWidth(); }, { theme, width });
      await expect.poll(() => page.evaluate(() => document.getElementById('colNav').getBoundingClientRect().width)).toBe(width);
      const label = page.locator('#navBottom .nav-brand');
      await expect(label).toHaveText(`V${info.version}`);
      await expect(label).toHaveClass(/unseen/);
      await expect.poll(() => page.evaluate(() => {
        const bottom = document.getElementById('navBottom'), box = bottom.getBoundingClientRect();
        const brand = bottom.querySelector('.nav-brand'), b = brand.getBoundingClientRect();
        const buttons = [...bottom.querySelectorAll('.rail-btn')].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect());
        return {
          truncated: brand.scrollWidth > brand.clientWidth,
          brandInside: b.left >= box.left && b.right <= box.right,
          buttons: buttons.length,
          buttonsInside: buttons.every((r) => r.left >= box.left && r.right <= box.right),
          smallest: Math.min(...buttons.map((r) => Math.min(r.width, r.height))),
          overflow: bottom.scrollWidth > bottom.clientWidth,
        };
      }), `${theme} ${width}px`).toEqual({ truncated: false, brandInside: true, buttons: 6, buttonsInside: true, smallest: 28, overflow: false });
      if (process.env.AGENTDECK_VERSION_SHOT_DIR) {
        fs.mkdirSync(process.env.AGENTDECK_VERSION_SHOT_DIR, { recursive: true });
        await page.locator('#navBottom').screenshot({ path: path.join(process.env.AGENTDECK_VERSION_SHOT_DIR, `version-${width}px-${theme}.png`) });
      }
    }
  }
  // Where everything fits, the version stays on the icons' row.
  await page.evaluate(() => { config.navWidth = 360; applyNavWidth(); });
  await expect(page.locator('#navBottom')).not.toHaveClass(/nb-stack/);
  await expect.poll(() => page.evaluate(() => {
    const brand = document.getElementById('releaseNotesBtn').getBoundingClientRect();
    return [...document.querySelectorAll('#navBottom .rail-btn')].every((n) => Math.abs(n.getBoundingClientRect().top - brand.top) < 1);
  })).toBe(true);
});
