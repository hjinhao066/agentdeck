const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Agent columns open as chat. The stand-in "agent" is a Node one-liner that
// echoes stdin, which works the same in PowerShell and zsh.
const ECHO = 'node -e "process.stdin.pipe(process.stdout)"';
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-'));
  fs.writeFileSync(path.join(profile, 'note.md'), '# Note title\n\nhello from the preview pane\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: Array.from({ length: 4 }, (_, index) => ({
      id: `chat-${index}`, taskId: `task-${index}`, title: `Agent ${index + 1}`,
      cmd: ECHO, cwd: profile, width: 460, role: 'manual',
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
  await expect(page.locator('.column.chat-mode')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(4);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a prompt typed in the composer reaches the terminal and comes back as a reply bubble', async () => {
  const column = page.locator('.column').first();
  await column.locator('.composer textarea').click();
  await page.keyboard.type('hello chat view');
  await page.keyboard.press('Enter');
  await expect(column.locator('.msg.user .bubble').last()).toHaveText('hello chat view');
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('chat-0')), { timeout: 20000 }).toContain('hello chat view');
  await expect(column.locator('.reply').last()).toContainText('hello chat view', { timeout: 20000 });
  await expect(column.locator('.reply.pending')).toHaveCount(0);
});

test('swiping sideways still pages through the columns', async () => {
  const box = await page.locator('.column').first().locator('.chat-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(400, 0);
  await expect.poll(() => page.evaluate(() => deckEl.scrollLeft)).toBeGreaterThan(0);
});

test('search over saved prompts and replies finds the conversation', async () => {
  await page.locator('#navSearch').fill('chat view');
  await expect(page.locator('#navResults .nr-item').first()).toBeVisible();
  await page.locator('#navSearch').fill('zzz-no-such-text');
  await expect(page.locator('#navResults .nr-empty')).toBeVisible();
  await page.locator('#navSearch').fill('');
  await expect(page.locator('#navResults')).toBeHidden();
});

test('files preview in the right pane, the real terminal and the browser tab are there', async () => {
  const file = path.join(profile, 'note.md');
  await page.evaluate((p) => SidePane.openPreview(p, 'chat-0'), file);
  await expect(page.locator('#sidePane')).toBeVisible();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('Note title');
  await page.locator('.side-tab[data-tab="terminal"]').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('stBody').contains(terms.get(focusedId || 'chat-0').el))).toBe(true);
  await page.locator('.side-tab[data-tab="browser"]').click();
  await expect(page.locator('#sbUrl')).toBeVisible();
  await page.locator('#sideClose').click();
  await expect(page.locator('#sidePane')).toBeHidden();
  expect(await page.evaluate(() => terms.get('chat-0').wrap.contains(terms.get('chat-0').el))).toBe(true);
});

test('the header toggle flips a column back to the raw terminal', async () => {
  const column = page.locator('.column').nth(1);
  await column.locator('.view-toggle').click();
  await expect(column).not.toHaveClass(/chat-mode/);
  await expect(column.locator('.term')).toBeVisible();
  await column.locator('.view-toggle').click();
  await expect(column).toHaveClass(/chat-mode/);
});

test('your own message can be copied and put back into the composer to edit', async () => {
  const column = page.locator('.column').first();
  const mine = column.locator('.msg.user', { hasText: 'hello chat view' }).first();
  await mine.hover();
  // (the copy button is not clicked here: it would overwrite the real clipboard)
  await expect(mine.locator('.user-tools .msg-tool')).toHaveCount(2);
  await mine.locator('.user-tools .msg-tool').nth(1).click();
  await expect(column.locator('.composer textarea')).toHaveValue('hello chat view');
  await column.locator('.composer textarea').fill('');
});
