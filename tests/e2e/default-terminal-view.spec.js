const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

const column = (id) => page.locator(`.column[data-col-id="${id}"]`);

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(3);
}

test.beforeEach(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-default-terminal-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3, globalViewMode: 'chat',
    columns: Array.from({ length: 3 }, (_, i) => ({
      id: `default-${i}`, taskId: `task-${i}`, title: `Session ${i + 1}`,
      cmd: FAKE, cwd: profile, width: 460, role: 'manual', view: 'chat',
    })),
  }));
  await launch();
});

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  fs.rmSync(profile, { recursive: true, force: true });
});

test('starts in terminals, returns to terminals after navigation, and opens new sessions in terminals', async () => {
  await expect(page.locator('.column.chat-mode')).toHaveCount(0);
  expect(await page.evaluate(() => config.globalViewMode)).toBe('term');

  await column('default-0').locator('.view-toggle').click();
  await expect(column('default-0')).toHaveClass(/chat-mode/);
  await page.locator('.nav-row[data-nav="schedule"]').click();
  await page.locator('.page-close').click();
  await expect(column('default-0')).not.toHaveClass(/chat-mode/);

  await column('default-0').locator('.view-toggle').click();
  await page.locator(`.colnav-item[data-col-id="default-1"]`).click();
  await expect(column('default-1')).not.toHaveClass(/chat-mode/);
  await page.locator(`.colnav-item[data-col-id="default-0"]`).click();
  await expect(column('default-0')).not.toHaveClass(/chat-mode/);

  await page.evaluate(() => ChatUI.toggleGlobalMode());
  expect(await page.evaluate(() => config.globalViewMode)).toBe('chat');
  const id = await page.evaluate(() => addAndFocusColumn().id);
  await expect(column(id)).toBeVisible();
  await expect(column(id)).not.toHaveClass(/chat-mode/);

  await page.locator('.nav-row[data-nav="captain"]').click();
  await page.locator('#mdCmd').fill('');
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  const captainId = await page.evaluate(() => config.mainSession.colId);
  await expect(column(captainId)).toBeVisible();
  await expect(column(captainId)).not.toHaveClass(/chat-mode/);
  await column(captainId).locator('.view-toggle').click();
  await page.locator(`.colnav-item.captain-item[data-col-id="${captainId}"]`).click();
  await expect(column(captainId)).not.toHaveClass(/chat-mode/);
});
