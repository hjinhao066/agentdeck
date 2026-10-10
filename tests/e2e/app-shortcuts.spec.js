// AgentDeck's own shortcuts in the real window: ⌘ on a Mac; on Windows
// Ctrl+Shift+letter and Alt+1…9 / Alt+←→, since ⌘ is the Windows key there and a
// plain Ctrl+letter belongs to the terminal. The help page and tooltips say which.
const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mac = process.platform === 'darwin';
const keys = mac
  ? { newColumn: 'Meta+KeyN', close: 'Meta+KeyW', help: 'Meta+Slash', searchAll: 'Meta+KeyK', first: 'Meta+1', right: 'Meta+ArrowRight', left: 'Meta+ArrowLeft' }
  : { newColumn: 'Control+Shift+KeyT', close: 'Control+Shift+KeyW', help: 'Control+Shift+Slash', searchAll: 'Control+Shift+KeyK', first: 'Alt+Digit1', right: 'Alt+ArrowRight', left: 'Alt+ArrowLeft' };

let app, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-shortcuts-')));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    fitWindow: true, fitCols: 3, perpetualCaptain: { enabled: false },
    columns: ['a', 'b', 'c'].map((id) => ({ id, title: id, cmd: '', cwd: profile, width: 500, role: 'manual' })),
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  await expect(page.locator('.column')).toHaveCount(3, { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => ['a', 'b', 'c'].every((id) => terms.get(id)?.wrap?.isConnected)), { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const focused = () => page.evaluate(() => focusedId);
const count = () => page.evaluate(() => columns.length);
async function focusTerminal(id) {
  await page.evaluate((col) => { focusColumnInput(col); focusedId = col; }, id);
}

test('the help page and tooltips name this platform\'s keys', async () => {
  const help = page.locator('#helpDialog');
  await expect(help).toBeHidden();
  await focusTerminal('a');
  await page.keyboard.press(keys.help);
  await expect(help).toBeVisible();
  if (mac) {
    await expect(help.locator('[data-shortcut="newColumn"]')).toHaveText('⌘ N');
    await expect(help.locator('[data-shortcut="column"]')).toHaveText('⌘ 1…9');
  } else {
    await expect(help.locator('[data-shortcut="newColumn"]')).toHaveText('Ctrl+Shift+T');
    await expect(help.locator('[data-shortcut="column"]')).toHaveText('Alt+1…9');
    await expect(help.locator('[data-shortcut="prevColumn"]')).toHaveText('Alt+←');
    await expect(help.locator('[data-shortcut="search"]').first()).toHaveText('Ctrl+Shift+F 或 Ctrl+Alt+F');
    await expect(help).toContainText('改按 Ctrl+Alt+F');
    await expect(help).toContainText('关掉简繁切换');
    await expect(help.locator('[data-shortcut="crewMap"]')).toHaveText('Ctrl+Shift+M');
    await expect(help).toContainText('资源管理器');
    expect(await help.evaluate((n) => n.textContent.includes('⌘') || n.textContent.includes('⇧') || n.textContent.includes('访达'))).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  const newKey = mac ? '⌘N' : 'Ctrl+Shift+T';
  await expect(page.locator('#topBar button[aria-label^="新对话"]')).toHaveAttribute('title', `新对话 (${newKey})`);
  await expect(page.locator('#navSearchSlot .nav-row-hint, .nav-search .nav-row-hint').first()).toHaveText(mac ? '⌘K' : 'Ctrl+Shift+K');
});

test('switching columns: ⌘1…9 / ⌘←→ on a Mac, Alt+1…9 / Alt+←→ on Windows', async () => {
  await focusTerminal('c');
  await page.keyboard.press(keys.first);
  await expect.poll(focused).toBe('a');
  await page.keyboard.press(keys.right);
  await expect.poll(focused).toBe('b');
  await page.keyboard.press(keys.left);
  await expect.poll(focused).toBe('a');
  if (!mac) {
    // Ctrl+Shift+← selects a word in PowerShell, and ⌘ is the Windows key: neither moves columns.
    await page.keyboard.press('Control+Shift+ArrowRight');
    await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.press('Meta+3');
    expect(await focused()).toBe('a');
  }
});

test('new and close: ⌘N / ⌘W on a Mac, Ctrl+Shift+T / Ctrl+Shift+W on Windows', async () => {
  await focusTerminal('a');
  if (!mac) {
    // Win+N belongs to Windows, and Ctrl+Shift+N stays 速记待办's.
    await page.keyboard.press('Meta+KeyN');
    expect(await count()).toBe(3);
  }
  await page.keyboard.press(keys.newColumn);
  await expect.poll(count).toBe(4);
  const added = await page.evaluate(() => columns[columns.length - 1].id);
  await expect.poll(focused).toBe(added);
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.wrap?.isConnected, added), { timeout: 20000 }).toBe(true);
  await page.keyboard.press(keys.close);
  await expect.poll(count).toBe(3);
  expect(await page.evaluate((id) => columns.some((c) => c.id === id), added)).toBe(false);
});

test('search in a terminal column: ⌘F on a Mac; Ctrl+Shift+F or Ctrl+Alt+F on Windows', async () => {
  const bar = page.locator('#searchBar');
  const presses = mac ? ['Meta+KeyF'] : ['Control+Shift+KeyF', 'Control+Alt+KeyF'];
  for (const press of presses) {
    await page.evaluate(() => { ChatUI.setMode('b', 'term'); focusColumnInput('b'); focusedId = 'b'; });
    await expect(bar).toBeHidden();
    await page.keyboard.press(press);
    await expect(bar).toBeVisible();
    await expect(page.locator('#searchInput')).toBeFocused();
    await expect(page.locator('#searchInput')).toHaveAttribute('title', mac ? '列内搜索 (⌘F)' : '列内搜索 (Ctrl+Shift+F 或 Ctrl+Alt+F)');
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
  }
});

test('search all conversations: ⌘K on a Mac, Ctrl+Shift+K on Windows', async () => {
  await focusTerminal('b');
  await page.keyboard.press(keys.searchAll);
  await expect(page.locator('#navSearch')).toBeFocused();
  await page.keyboard.press('Escape');
});
