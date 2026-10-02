const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Agent columns open as chat. Columns run the stand-in agent fixture and wait
// for its welcome box before typing prompts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const OLD_TURNS = 450;                    // more than the 400 the chat file used to keep
const oldPrompt = (i) => `oldprompt-${String(i).padStart(4, '0')}`;
let application, page, profile, demoFile;
test.describe.configure({ mode: 'serial' });

async function launch(columnCount) {
  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('dialog', (d) => d.accept());
  await expect(page.locator('.column.chat-mode')).toHaveCount(columnCount);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(columnCount);
}
const turns = (id) => page.evaluate((i) => ChatUI.turnsOf(i).map((t) => ({ id: t.id, user: t.user, reply: t.reply, done: t.done, interrupted: !!t.interrupted })), id);
const savedChat = (id) => JSON.parse(fs.readFileSync(path.join(profile, 'chats', `${id}.json`), 'utf8'));

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chat-'));
  demoFile = path.join(profile, 'note.md');
  fs.writeFileSync(demoFile, '# Note title\n\nhello from the preview pane\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: Array.from({ length: 4 }, (_, index) => ({
      id: `chat-${index}`, taskId: `task-${index}`, title: `Agent ${index + 1}`,
      cmd: FAKE, cwd: profile, width: 460, role: 'manual',
    })),
  }));
  // a long saved conversation from earlier runs (made-up stand-in turns)
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'chats', 'chat-3.json'), JSON.stringify({ v: 1, id: 'chat-3', turns: Array.from({ length: OLD_TURNS }, (_, i) => ({
    id: `old${i}`, ts: Date.now() - (OLD_TURNS - i) * 60_000, user: oldPrompt(i), reply: `old reply ${i}`, done: true, atts: [],
  })) }));
  await launch(4);
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

test('a prompt typed straight into the raw terminal is saved as a turn, even in terminal view', async () => {
  await page.evaluate(() => ChatUI.setMode('chat-2', 'term'));
  await expect(page.locator('.column[data-col-id="chat-2"]')).not.toHaveClass(/chat-mode/);
  await page.evaluate(() => terms.get('chat-2').term.focus());
  await page.keyboard.type('typed in the raw terminal');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await turns('chat-2')).find((t) => t.user === 'typed in the raw terminal')?.done, { timeout: 20000 }).toBe(true);
  expect((await turns('chat-2')).find((t) => t.user === 'typed in the raw terminal').reply).toContain('GOT typed in the raw terminal');
  await page.evaluate(() => ChatUI.setMode('chat-2', 'chat'));
  await expect(page.locator('.column[data-col-id="chat-2"] .msg.user .bubble').last()).toHaveText('typed in the raw terminal');
});

test('a long saved conversation keeps every turn; the view loads older ones on request', async () => {
  expect((await turns('chat-3')).length).toBe(OLD_TURNS);
  const column = page.locator('.column[data-col-id="chat-3"]');
  const step = await page.evaluate(() => ChatCore.RENDER_STEP);
  await expect(column.locator('.chat-scroll > .turn')).toHaveCount(step);
  await expect(column.locator('.chat-scroll > .turn .bubble').last()).toHaveText(oldPrompt(OLD_TURNS - 1));
  await column.locator('.chat-earlier').click();
  await expect(column.locator('.chat-scroll > .turn')).toHaveCount(step * 2);
  // search reaches a turn outside the rendered window and brings it into view
  await page.locator('#navSearch').fill(oldPrompt(3));
  await page.locator('#navResults .nr-item').first().click();
  await expect(column.locator('.msg.user', { hasText: oldPrompt(3) })).toBeVisible();
  await page.locator('#navSearch').fill('');
});

test('history survives quitting and relaunching: an unfinished turn, a raw terminal turn, all old turns, an archived chat', async () => {
  // a new turn on the long chat
  const long = page.locator('.column[data-col-id="chat-3"]');
  await long.locator('.composer textarea').click();
  await page.keyboard.type('one more after the old ones');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await turns('chat-3')).at(-1).done, { timeout: 20000 }).toBe(true);
  // a turn still open when the app closes (the stand-in stops at a y/n question)
  const open = page.locator('.column[data-col-id="chat-1"]');
  await open.locator('.composer textarea').click();
  await page.keyboard.type('ask me before quitting');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => terms.get('chat-1').state), { timeout: 20000 }).toBe('input');
  expect((await turns('chat-1')).at(-1).done).toBe(false);
  // an ordinary archive keeps the conversation under the same id
  const before0 = await turns('chat-0');
  expect(before0.map((t) => t.user)).toContain('hello chat view');
  await page.evaluate(() => archiveColumn(columns.find((c) => c.id === 'chat-0')));
  await expect(page.locator('.column[data-col-id="chat-0"]')).toHaveCount(0);
  const before2 = await turns('chat-2');

  await application.close();
  application = null;
  // on disk: whole, private, the open turn kept with what it had and marked
  const long3 = savedChat('chat-3');
  expect(long3.turns.length).toBe(OLD_TURNS + 1);
  expect(long3.turns[0].user).toBe(oldPrompt(0));
  const last1 = savedChat('chat-1').turns.at(-1);
  expect(last1.user).toBe('ask me before quitting');
  expect(last1.interrupted).toBe(true);
  expect(last1.reply).toContain('Proceed with the change');
  if (process.platform !== 'win32') expect(fs.statSync(path.join(profile, 'chats', 'chat-1.json')).mode & 0o077).toBe(0);

  await launch(3);
  const after1 = await turns('chat-1');
  expect(after1.at(-1)).toMatchObject({ user: 'ask me before quitting', done: true, interrupted: true });
  expect(after1.at(-1).reply).toContain('Proceed with the change');
  const reply1 = page.locator('.column[data-col-id="chat-1"] .msg.assistant').last();
  await expect(reply1.locator('.reply')).toContainText('Proceed with the change');
  await expect(reply1.locator('.reply-note')).toContainText('还没结束');
  expect(await turns('chat-2')).toEqual(before2);
  expect((await turns('chat-3')).length).toBe(OLD_TURNS + 1);
  // restoring the archived session brings back the same conversation, same ids
  expect(await page.evaluate(() => config.archived.map((a) => a.id))).toContain('chat-0');
  await page.evaluate(() => restoreArchived('chat-0', true));
  await expect(page.locator('.column[data-col-id="chat-0"] .msg.user .bubble').first()).toHaveText('hello chat view');
  expect((await turns('chat-0')).map((t) => t.id)).toEqual(before0.map((t) => t.id));
});
