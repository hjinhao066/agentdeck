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
    const other = new BrowserWindow({ title: 'Background focus test', width: 450, height: 300, focusable: false });
    other.loadURL('data:text/html,<h1>Other app stand-in</h1>');
    other.focus();
  });
  const popup = await popupFor('test-4');
  const focusedTitle = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle());
  expect(focusedTitle).not.toBe('AgentDeck notifications');
  await popup.locator('[data-column-id="test-4"] .open').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('test-4');
  // chat view (the default): the composer gets the keyboard
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('test-4').wrap.querySelector('.composer textarea'))).toBe(true);
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
  // terminal view: the xterm itself gets the keyboard
  await page.evaluate(() => { ChatUI.setMode('test-3', 'term'); ChatUI.setMode('test-2', 'term'); });
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

test('notification window size, bottom-right 12px anchor and card layout', async () => {
  const popup = await popupFor('test-0', 'done', 'A very long title that should be truncated with ellipsis without breaking card layout');
  const winBounds = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck notifications');
    return win ? win.getBounds() : null;
  });
  expect(winBounds).not.toBeNull();
  expect(winBounds.width).toBe(191);
  expect(winBounds.height).toBe(54);

  const displayInfo = await application.evaluate(({ screen, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck');
    const display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const area = display.workArea;
    return { areaX: area.x, areaY: area.y, areaW: area.width, areaH: area.height };
  });
  expect(winBounds.x + winBounds.width).toBe(displayInfo.areaX + displayInfo.areaW - 12);
  expect(winBounds.y + winBounds.height).toBe(displayInfo.areaY + displayInfo.areaH - 12);

  const cardBounds = await popup.locator('article').first().boundingBox();
  expect(Math.round(cardBounds.height)).toBe(46);
  expect(Math.round(cardBounds.width)).toBe(191 - 8);

  const overflow = await popup.evaluate(() => {
    const card = document.querySelector('article');
    const open = card.querySelector('.open');
    const strong = card.querySelector('strong');
    return {
      cardScrollHeight: card.scrollHeight,
      cardClientHeight: card.clientHeight,
      openScrollHeight: open.scrollHeight,
      openClientHeight: open.clientHeight,
      strongEllipsis: getComputedStyle(strong).textOverflow,
    };
  });
  expect(overflow.cardScrollHeight).toBeLessThanOrEqual(overflow.cardClientHeight);
  expect(overflow.openScrollHeight).toBeLessThanOrEqual(overflow.openClientHeight);
  expect(overflow.strongEllipsis).toBe('ellipsis');

  await popup.locator('.close').click();
});
