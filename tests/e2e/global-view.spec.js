const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

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
const globalButton = () => page.locator('#globalViewToggle');
const column = (id) => page.locator(`.column[data-col-id="${id}"]`);
const savedConfig = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));

async function expectGlobal(mode, count = 3) {
  await expect(page.locator('.column.chat-mode')).toHaveCount(mode === 'chat' ? count : 0);
  await expect(globalButton()).toHaveAttribute('aria-label', mode === 'chat' ? '全部切到终端' : '全部切到对话');
  await expect(globalButton()).toHaveAttribute('title', mode === 'chat' ? '全部切到终端' : '全部切到对话');
  await expect(globalButton()).toHaveAttribute('aria-pressed', String(mode === 'term'));
  await expect.poll(() => savedConfig().globalViewMode).toBe(mode);
}

test.beforeEach(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-global-view-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: Array.from({ length: 3 }, (_, i) => ({
      id: `view-${i}`, taskId: `task-${i}`, title: `Session ${i + 1}`,
      cmd: FAKE, cwd: profile, width: 460, role: 'manual',
    })),
  }));
  await launch();
});
test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  fs.rmSync(profile, { recursive: true, force: true });
});

test('global button follows its live choice across mixed and fully overridden columns', async () => {
  await expectGlobal('term');
  const chatIcon = await globalButton().innerHTML();
  const geometry = await page.evaluate(() => {
    const split = document.getElementById('tbSplit').getBoundingClientRect();
    const button = document.getElementById('globalViewToggle').getBoundingClientRect();
    return { splitRight: split.right, buttonLeft: button.left, gap: Math.abs(split.y + split.height / 2 - button.y - button.height / 2) };
  });
  expect(geometry.buttonLeft).toBeGreaterThan(geometry.splitRight);
  expect(geometry.gap).toBeLessThan(1);
  await column('view-0').locator('.view-toggle').click();
  await expect(page.locator('.column.chat-mode')).toHaveCount(1);
  await globalButton().click();
  await expectGlobal('chat');
  expect(await globalButton().innerHTML()).not.toBe(chatIcon);
  await column('view-1').locator('.view-toggle').click();
  await expect(column('view-1')).not.toHaveClass(/chat-mode/);
  await expect(column('view-0')).toHaveClass(/chat-mode/);
  await expect(column('view-2')).toHaveClass(/chat-mode/);
  expect(await page.evaluate(() => config.globalViewMode)).toBe('chat');
  await globalButton().click();
  await expectGlobal('term');
  await globalButton().click();
  await expectGlobal('chat');
});

test('new manual and Captain columns always start in terminal mode', async () => {
  await globalButton().click();
  await expectGlobal('chat');
  const terminalId = await page.evaluate(() => addAndFocusColumn().id);
  await expect(page.locator('.column')).toHaveCount(4);
  await expect(column(terminalId)).not.toHaveClass(/chat-mode/);
  const captainId = await page.evaluate((cmd) => createMain({ cmd }).id, FAKE);
  await expect(page.locator('.column')).toHaveCount(5);
  await expect(column(captainId)).not.toHaveClass(/chat-mode/);
  const backgroundId = await page.evaluate((cmd) => createSession({ title: 'Background', cmd, captainCrew: true }, true).id, FAKE);
  await expect(column(backgroundId)).toHaveClass(/backstage/);
  await expect(column(backgroundId)).not.toHaveClass(/chat-mode/);
  const chatId = await page.evaluate(() => addAndFocusColumn().id);
  await expect(column(chatId)).not.toHaveClass(/chat-mode/);
  await page.locator('.nav-row[data-nav="new"]').click();
  await expect(page.locator('.column')).toHaveCount(8);
  await expect(page.locator('.column.chat-mode')).toHaveCount(0);
});

test('every app launch returns sessions to terminal mode', async () => {
  await globalButton().click();
  await expectGlobal('chat');
  await column('view-0').locator('.view-toggle').click();
  await application.close();
  application = null;
  await launch();
  await expectGlobal('term');
  const id = await page.evaluate(() => createSession({ title: 'After restart' }, true).id);
  await expect(column(id)).not.toHaveClass(/chat-mode/);
  // Remove the blank shell column before restarting the three fixture agents.
  await page.evaluate((id) => removeCol(columns.find((c) => c.id === id)), id);
  await globalButton().click();
  await expectGlobal('chat');
  await application.close();
  application = null;
  await launch();
  await expectGlobal('term');
});

test('global changes preserve terminal objects, draft and side-pane terminal ownership', async () => {
  await column('view-0').locator('.view-toggle').click();
  await column('view-0').locator('.composer textarea').fill('unsent draft');
  await page.evaluate(() => {
    window.originalTerminals = [...terms.values()].map((t) => t.term);
    SidePane.show('terminal', true);
  });
  await expect(page.locator('.side-tab[data-tab="terminal"]')).toHaveClass(/active/);
  await globalButton().click();
  await expectGlobal('chat');
  for (const id of ['view-0', 'view-1', 'view-2']) await expect(column(id).locator('.term .xterm')).toHaveCount(1);
  await globalButton().click();
  await expectGlobal('term');
  await expect(column('view-0').locator('.composer textarea')).toHaveValue('unsent draft');
  expect(await page.evaluate(() => [...terms.values()].every((t, i) => t.term === window.originalTerminals[i]))).toBe(true);
  expect(await page.evaluate(() => ChatUI.turnsOf('view-0').length)).toBe(0);
});
