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
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
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
