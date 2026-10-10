const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 2.0.5: the 自由画布 tab is gone. A profile last left on it (crewMap.mode 'canvas', the board view showing,
// cards placed there) opens on 队伍 with three tabs; the positions it saved stay in config.json as they were.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-tabs-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', activeView: 'board', crewMap: { mode: 'canvas' }, boardPositions: { 't-legacy': { x: 120, y: 80 } },
    columns: [{ id: 'one', title: '一', cmd: FAKE, cwd: profile, width: 460, role: 'manual' }],
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a profile left on the old 自由画布 opens on 队伍; the canvas positions stay in config.json', async () => {
  await expect(page.locator('#boardView')).toBeVisible();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('#boardView .board-toolbar h1')).toHaveText('队伍');
  await expect(page.locator('#boardView .board-mode button')).toHaveText(['队伍', '任务看板', 'Token 用量']);
  await page.evaluate(() => { saveConfig(); flushConfig(); });
  const saved = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  await expect.poll(() => saved().boardPositions).toEqual({ 't-legacy': { x: 120, y: 80 } });
  expect(saved().crewMap.mode).toBeUndefined();
});
