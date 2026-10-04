const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
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
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(2);
}
const column = (id) => page.locator(`.column[data-col-id="${id}"]`);
const box = (id) => column(id).locator('.composer textarea');
const chatFile = (id) => path.join(profile, 'chats', `${id}.json`);
function readChat(id) {
  return JSON.parse(fs.readFileSync(chatFile(id), 'utf8'));
}

test.beforeEach(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-draft-sync-'));
  fs.writeFileSync(path.join(profile, 'note.md'), 'hello\n');
  fs.writeFileSync(path.join(profile, 'shot.png'), PNG);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [0, 1].map((i) => ({
      id: `draft-${i}`, taskId: `task-${i}`, title: `Session ${i + 1}`,
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

test('the app composer is one draft across chat and terminal, and the agent prompt is not', async () => {
  const id = 'draft-0';
  const ta = box(id);
  await ta.click();
  await ta.fill('共享草稿ABC');
  await ta.evaluate((el) => el.setSelectionRange(4, 4));
  await page.evaluate((p) => { ChatUI.attach('draft-0', p.note); ChatUI.attach('draft-0', p.shot); }, {
    note: path.join(profile, 'note.md'), shot: path.join(profile, 'shot.png'),
  });
  await expect(column(id).locator('.draft-hint')).toBeHidden();
  await expect(box('draft-1')).toHaveValue('');
  await expect(column('draft-1').locator('.att')).toHaveCount(0);

  const beforeReplay = await page.evaluate((i) => window.deck.ptyReplay(i), id);
  await column(id).locator('.view-toggle').click();
  await expect(column(id)).not.toHaveClass(/chat-mode/);
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue('共享草稿ABC');
  await expect(column(id).locator('.composer .att-file')).toBeVisible();
  await expect(column(id).locator('.composer .att-thumb')).toBeVisible();
  const placed = await page.evaluate((i) => {
    const col = document.querySelector(`.column[data-col-id="${i}"]`);
    const term = col.querySelector('.term').getBoundingClientRect();
    const composer = col.querySelector('.composer').getBoundingClientRect();
    const caret = col.querySelector('.composer textarea');
    return { termBottom: term.bottom, composerTop: composer.top, start: caret.selectionStart, end: caret.selectionEnd };
  }, id);
  expect(placed.composerTop).toBeGreaterThanOrEqual(placed.termBottom - 1);
  expect([placed.start, placed.end]).toEqual([4, 4]);
  expect(await page.evaluate((i) => window.deck.ptyReplay(i), id)).toBe(beforeReplay);

  await ta.click();
  await ta.fill('共享草稿ABC-改');
  await ta.evaluate((el) => el.setSelectionRange(2, 2));
  await column(id).locator('.view-toggle').click();
  await expect(column(id)).toHaveClass(/chat-mode/);
  await expect(ta).toHaveValue('共享草稿ABC-改');
  const back = await ta.evaluate((el) => [el.selectionStart, el.selectionEnd]);
  expect(back).toEqual([2, 2]);
  await expect(column(id).locator('.composer .att-thumb')).toBeVisible();
  await expect(box('draft-1')).toHaveValue('');

  await expect.poll(() => {
    try { return readChat(id).draft; } catch (_) { return null; }
  }).toMatchObject({ text: '共享草稿ABC-改', selStart: 2, selEnd: 2 });
  const saved = readChat(id).draft;
  expect(saved.atts).toEqual([path.join(profile, 'note.md'), path.join(profile, 'shot.png')]);
  expect(await page.evaluate((i) => userComposing(i), id)).toBe(true);
  expect(await page.evaluate(() => MainCore.draftBlocks({ draft: '终端草稿', unknown: false, lastKeyAt: 0 }, Date.now(), 5000))).toBe(true);

  await page.evaluate((i) => ChatUI.setMode(i, 'term'), id);
  await page.evaluate((i) => terms.get(i).term.focus(), id);
  await page.keyboard.type('agent prompt only');
  await page.evaluate((i) => ChatUI.setMode(i, 'chat'), id);
  await expect(ta).toHaveValue('共享草稿ABC-改');
  await expect(column(id).locator('.draft-hint')).toBeVisible();
  await expect(column(id).locator('.draft-hint')).toHaveText('终端里有未发送的输入');
  expect(await page.evaluate((i) => terms.get(i).typing.draft, id)).toContain('agent prompt only');
  expect(await ta.inputValue()).not.toContain('agent prompt only');
  expect(await ta.inputValue()).not.toContain('终端里有未发送的输入');
  await ta.fill('');
  await page.evaluate((i) => {
    const root = document.querySelector(`.column[data-col-id="${i}"] .composer`);
    let guard = 0;
    while (root.querySelector('.att-x') && guard++ < 10) root.querySelector('.att-x').click();
  }, id);
  await expect(ta).toHaveValue('');
  await expect(column(id).locator('.composer .att')).toHaveCount(0);
  expect(await page.evaluate((i) => userComposing(i) && terms.get(i).typing.draft.includes('agent prompt only'), id)).toBe(true);
  await expect(column(id).locator('.draft-hint')).toBeVisible();
});

test('sending clears the shared draft on both pages and in the saved chat', async () => {
  const id = 'draft-0';
  const ta = box(id);
  await ta.fill('发出去就清空');
  await page.evaluate((p) => ChatUI.attach('draft-0', p), path.join(profile, 'note.md'));
  await column(id).locator('.view-toggle').click();
  await expect(ta).toHaveValue('发出去就清空');
  await ta.press('Enter');
  await expect(ta).toHaveValue('');
  await expect(column(id).locator('.composer .att')).toHaveCount(0);
  await page.evaluate((i) => ChatUI.setMode(i, 'chat'), id);
  await expect(ta).toHaveValue('');
  await expect(column(id).locator('.composer .att')).toHaveCount(0);
  await expect(box('draft-1')).toHaveValue('');
  await expect.poll(() => {
    try { return Object.hasOwn(readChat(id), 'draft'); } catch (_) { return true; }
  }).toBe(false);
});

test('an unsent composer draft survives restart and stays on its own session', async () => {
  test.setTimeout(120000);
  const ta = box('draft-0');
  await ta.fill('重开还在');
  await ta.evaluate((el) => { el.focus(); el.setSelectionRange(2, 4); el.dispatchEvent(new Event('select')); });
  await page.evaluate((p) => ChatUI.attach('draft-0', p), path.join(profile, 'shot.png'));
  await box('draft-1').fill('另一会话');
  await expect.poll(() => {
    try { return [readChat('draft-0').draft.text, readChat('draft-1').draft.text]; } catch (_) { return []; }
  }).toEqual(['重开还在', '另一会话']);
  expect(readChat('draft-0').draft.selStart).toBe(2);
  expect(readChat('draft-0').draft.selEnd).toBe(4);
  expect(readChat('draft-0').draft.atts).toEqual([path.join(profile, 'shot.png')]);

  await application.close();
  application = null;
  await launch();
  await expect(box('draft-0')).toHaveValue('重开还在');
  await expect(box('draft-1')).toHaveValue('另一会话');
  await expect(column('draft-0').locator('.composer .att-thumb')).toBeVisible();
  await expect(column('draft-1').locator('.composer .att')).toHaveCount(0);
  const caret = await box('draft-0').evaluate((el) => [el.selectionStart, el.selectionEnd]);
  expect(caret).toEqual([2, 4]);
  await column('draft-0').locator('.view-toggle').click();
  await expect(box('draft-0')).toHaveValue('重开还在');
  await expect(column('draft-1')).toHaveClass(/chat-mode/);
  await expect(box('draft-1')).toHaveValue('另一会话');
});
