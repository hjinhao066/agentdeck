const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let application, page, profile;
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-e2e-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3, columns: Array.from({ length: 5 }, (_, index) => ({
      id: `test-${index}`, taskId: `task-${index}`, title: `Terminal ${index + 1}`,
      cmd: '', cwd: profile, width: 460, role: 'manual',
    })),
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(5);
  // Ensure the renderer has completed its asynchronous PTY spawn handshake.
  await expect.poll(() => page.evaluate(() => window.deck.ptyIsAlive('test-4'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('test-4')), { timeout: 20000 }).toMatch(/PS |[$%>] /);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function popupFor(id, state = 'done', title = '测试终端') {
  await page.evaluate((payload) => window.deck.notifyState(payload), { id, state, title });
  let popup;
  await expect.poll(() => {
    popup = application.windows().find((w) => w.url().endsWith('/notification.html'));
    return !!popup;
  }).toBe(true);
  await expect(popup.locator(`[data-column-id="${id}"]`)).toBeVisible();
  return popup;
}

test('background popup, fifth column reveal, focus and actual keyboard input', async () => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    const other = new BrowserWindow({ title: 'Background focus test', width: 450, height: 300 });
    other.loadURL('data:text/html,<h1>Other app stand-in</h1>');
    other.focus();
  });
  const popup = await popupFor('test-4');
  const focusedTitle = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
  expect(focusedTitle).not.toBe('AgentDeck notifications');
  await popup.locator('[data-column-id="test-4"] .open').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('test-4');
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('test-4').term.textarea)).toBe(true);
  expect(await page.evaluate(() => {
    const bounds = terms.get('test-4').wrap.getBoundingClientRect();
    return bounds.left >= deckEl.getBoundingClientRect().left - 1 && bounds.right <= innerWidth + 1;
  })).toBe(true);
  await page.keyboard.type('echo AGENTDECK_FOCUS_OK');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('test-4')), { timeout: 15000 }).toContain('AGENTDECK_FOCUS_OK');
  await expect.poll(() => page.evaluate(() => dumpScreen(terms.get('test-4').term))).toContain('AGENTDECK_FOCUS_OK');
  expect(errors).toEqual([]);
});

test('minimized/zoomed/board view notifications restore the exact input target', async () => {
  await page.evaluate(() => toggleZoom('test-0'));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck').minimize());
  let popup = await popupFor('test-3', 'input');
  await popup.locator('[data-column-id="test-3"] .open').click();
  await expect.poll(() => page.evaluate(() => zoomedId)).toBe('test-3');
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('test-3').term.textarea)).toBe(true);
  await page.evaluate(() => showView('board'));
  popup = await popupFor('test-2');
  await popup.locator('[data-column-id="test-2"] .open').click();
  await expect.poll(() => page.evaluate(() => activeView)).toBe('terminals');
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('test-2').term.textarea)).toBe(true);
});

test('stacking, text injection, cancellation and stale targets', async () => {
  const popup = await popupFor('test-0', 'done', '<img src=x onerror=alert(1)>');
  await popupFor('test-1', 'input');
  await expect(popup.locator('article')).toHaveCount(2);
  await expect(popup.locator('img')).toHaveCount(0);
  await page.evaluate(() => window.deck.notifyCancel({ id: 'test-0' }));
  await expect(popup.locator('article')).toHaveCount(1);
  await popup.locator('.close').click();
  const before = await page.evaluate(() => focusedId);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck').webContents.send('focus-column', { id: 'removed-terminal' });
  });
  expect(await page.evaluate(() => focusedId)).toBe(before);
});

test('all-agent state flow waits for quiet and retracts resumed work', async () => {
  await page.evaluate(() => {
    const entry = terms.get('test-1');
    entry.hasWorked = true;
    entry.notificationState = { state: 'working' };
    maybeNotifyState('test-1', entry, 'done');
  });
  const popup = application.windows().find((w) => w.url().endsWith('/notification.html'));
  await expect(popup.locator('article')).toHaveCount(0);
  await page.evaluate(() => {
    const entry = terms.get('test-1');
    entry.notificationState.since = Date.now() - 13000;
    entry.lastOutputAt = Date.now() - 13000;
    maybeNotifyState('test-1', entry, 'done');
  });
  await expect(popup.locator('[data-column-id="test-1"]')).toBeVisible();
  await page.evaluate(() => maybeNotifyState('test-1', terms.get('test-1'), 'working'));
  await expect(popup.locator('article')).toHaveCount(0);
});

test('sandboxed notification frame cannot access the terminal bridge; navigation is denied', async () => {
  const popup = await popupFor('test-0');
  expect(await popup.evaluate(() => typeof window.deck)).toBe('undefined');
  expect(await popup.evaluate(() => typeof require)).toBe('undefined');
  const url = page.url();
  await page.evaluate(() => { const link = document.createElement('a'); link.href = 'https://example.com'; document.body.append(link); link.click(); link.remove(); });
  expect(page.url()).toBe(url);
  await popup.locator('.close').click();
});
