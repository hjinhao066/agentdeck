const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Cursor-style shell around the deck: sidebar folders and archive, the
// split control, Schedule, Artifacts, composer attachments and the agent's
// status lines. Columns run a small TUI stand-in, never a real agent.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile, demoFile;
const deliveredPrompts = () => {
  const file = path.join(profile, 'delivered-prompts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};

const deckOrder = () => page.evaluate(() => [...deckEl.querySelectorAll('.column')].map((c) => c.dataset.colId));
const alive = (id) => page.evaluate((i) => window.deck.ptyIsAlive(i), id);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ws-'));
  demoFile = path.join(profile, 'report.md');
  fs.writeFileSync(demoFile, '# Report\n\nfrom the stand-in agent\n');
  fs.writeFileSync(path.join(profile, 'shot.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: ['a', 'b', 'c', 'd'].map((k) => ({
      id: `ws-${k}`, taskId: `task-${k}`, title: `Session ${k}`, cmd: FAKE, cwd: profile, width: 460, role: 'manual',
    })),
  }));
  const env = { ...process.env, AGENTDECK_DEMO_FILE: demoFile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'delivered-prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(4);
  await page.evaluate(() => columns.forEach((col) => ChatUI.setMode(col.id, 'chat')));
  await expect(page.locator('.column.chat-mode')).toHaveCount(4);
  // the stand-in has printed its box: the session is ready for prompts
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('status lines under the composer, a clean reply, and an artifact from it', async () => {
  const col = page.locator('.column[data-col-id="ws-a"]');
  await col.locator('.composer textarea').click();
  await page.keyboard.type('please write the report');
  await page.keyboard.press('Enter');
  const reply = col.locator('.reply').last();
  await expect(reply).toContainText('GOT please write the report', { timeout: 20000 }).catch(async (error) => {
    console.log('SCREEN', await page.evaluate(() => dumpScreen(terms.get('ws-a').term)));
    throw error;
  });
  await expect(col.locator('.tui-footer')).toContainText('Weekly Reset: 16hr');
  await expect(col.locator('.tui-footer')).toContainText('bypass permissions on');
  // the input box and status lines never leak into the reply bubble
  await expect(col.locator('.reply').last()).not.toContainText('Weekly Reset');
  await expect(col.locator('.reply').last()).not.toContainText('Context:');

  await page.locator('.nav-row[data-nav="artifacts"]').click();
  const card = page.locator('.art-card', { hasText: 'report.md' });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#pageView')).toBeVisible();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('Report');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pageView')).toBeHidden();
  await page.locator('#sideClose').click();
});

test('pasted images stay as attachments when the text is deleted, and go out as paths', async () => {
  const col = page.locator('.column[data-col-id="ws-b"]');
  const shot = path.join(profile, 'shot.png');
  await page.evaluate((p) => ChatUI.attach('ws-b', p), shot);
  const ta = col.locator('.composer textarea');
  await ta.click();
  await page.keyboard.type('look at this');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(ta).toHaveValue('');
  await expect(col.locator('.cp-atts .att-thumb img')).toHaveAttribute('src', /^data:image\/png/);
  await page.keyboard.type('what is in the picture');
  await page.keyboard.press('Enter');
  await expect(col.locator('.cp-atts')).toBeHidden();
  await expect(col.locator('.msg.user .bubble-atts .att-thumb')).toHaveCount(1);
  await expect(col.locator('.msg.user .bubble').last()).toHaveText('what is in the picture');
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('ws-b')), { timeout: 15000 }).toMatch(/shot\.png['"]? what is in the picture/);
});

test('a very long prompt is not cut: it goes to the agent as a file', async () => {
  const col = page.locator('.column[data-col-id="ws-c"]');
  const long = 'LONGSTART ' + '这是一段很长的需求说明。'.repeat(800) + ' LONGEND';
  await page.evaluate((t) => { const ta = document.querySelector('.column[data-col-id="ws-c"] .composer textarea'); ta.value = t; ta.dispatchEvent(new Event('input')); }, long);
  await col.locator('.composer textarea').press('Enter');
  const bubble = col.locator('.msg.user').last();
  await expect(bubble.locator('.bubble')).toContainText(`全文 ${long.length} 字`);
  await expect(bubble.locator('.bubble-atts .att-file')).toContainText('.txt');
  const file = await bubble.locator('.bubble-atts .att').getAttribute('title');
  expect(fs.readFileSync(file, 'utf8')).toBe(long);
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('ws-c')), { timeout: 15000 }).toContain('请先完整读取再照做');
  await expect(col.locator('.composer textarea')).toHaveValue('');
});

test('a new plain session opens in terminal mode, and an agent shows its status lines in chat mode', async () => {
  const id = await page.evaluate(() => addAndFocusColumn().id);
  const col = page.locator(`.column[data-col-id="${id}"]`);
  await expect(col).not.toHaveClass(/chat-mode/);
  await col.locator('.view-toggle').click();
  await expect(col).toHaveClass(/chat-mode/);
  await expect.poll(() => page.evaluate((i) => window.deck.ptyIsAlive(i), id)).toBe(true);
  await page.evaluate(([i, cmd]) => window.deck.ptyInput(i, cmd + '\r'), [id, FAKE]);
  await expect(col.locator('.tui-footer')).toContainText('Weekly Reset', { timeout: 15000 });
  await page.evaluate((i) => removeCol(columns.find((c) => c.id === i)), id);
});

test('the side browser stays inside its pane when the page is zoomed', async () => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck').webContents.setZoomFactor(0.8));
  await page.evaluate(() => SidePane.openBrowser('about:blank'.replace('about:blank', 'https://example.invalid/')));
  await expect(page.locator('#sbView')).toBeVisible();
  const expected = await page.evaluate(() => { const r = document.getElementById('sbView').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 0.8)); });
  const actual = () => application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck');
    const view = win.contentView.children[win.contentView.children.length - 1];
    const b = view.getBounds();
    return [b.x, b.y, b.width, b.height];
  });
  // within rounding of the pane's rectangle in window pixels
  await expect.poll(async () => Math.max(...(await actual()).map((v, i) => Math.abs(v - expected[i])))).toBeLessThanOrEqual(2);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck').webContents.setZoomFactor(1));
  await page.locator('#sideClose').click();
});

test('the split control sets equal columns and the sidebar collapses', async () => {
  await page.locator('#tbSplit .split-btn[data-cols="4"]').click();
  const widths = () => page.evaluate(() => [...deckEl.querySelectorAll('.column')].map((c) => Math.round(c.getBoundingClientRect().width)));
  const deckWidth = () => page.evaluate(() => deckEl.clientWidth);
  await expect.poll(async () => { const w = await widths(); return Math.max(...w) - Math.min(...w); }).toBeLessThanOrEqual(2);
  expect(Math.abs((await widths())[0] - (await deckWidth()) / 4)).toBeLessThanOrEqual(2);
  await page.locator('#navCollapseBtn').click();
  await expect(page.locator('#colNav')).toBeHidden();
  // equal slices follow the wider deck
  await expect.poll(async () => Math.abs((await widths())[0] - (await deckWidth()) / 4)).toBeLessThanOrEqual(2);
  await page.locator('#navExpandBtn').click();
  await expect(page.locator('#colNav')).toBeVisible();
  await page.locator('#tbSplit .split-btn[data-cols="0"]').click();
  expect(await page.evaluate(() => config.fitWindow)).toBe(false);
  await page.locator('#tbSplit .split-btn[data-cols="3"]').click();
  expect(await page.evaluate(() => [config.fitWindow, config.fitCols])).toEqual([true, 3]);
});

test('dragging a session into a folder moves its column, and the order persists', async () => {
  await page.locator('.nav-section[data-section="folders"] .nav-ibtn').click();
  const label = page.locator('.nav-folder-head .nav-folder-name');
  await expect(label).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type('Work');
  await page.keyboard.press('Enter');
  await expect(page.locator('.nav-folder-head .nav-folder-name')).toHaveText('Work');

  const row = page.locator('.colnav-item[data-col-id="ws-d"]');
  const target = page.locator('.nav-folder-head');
  const from = await row.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y - 20, { steps: 4 });
  await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 6 });
  const debug = await page.evaluate(([x, y]) => {
    const n = document.elementFromPoint(x, y);
    return { at: n && n.className, drop: [...document.querySelectorAll('.drop-into,.drop-before,.drop-after')].map((e) => e.className),
      body: document.body.className, rows: [...document.querySelectorAll('#navList > *')].map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().top)) };
  }, [to.x + 60, to.y + to.height / 2]);
  await page.mouse.up();
  await expect(page.locator('.nav-folder .colnav-item[data-col-id="ws-d"]')).toBeVisible().catch((e) => { console.log('DRAG', JSON.stringify({ from, to, debug })); throw e; });
  expect(await deckOrder()).toEqual(['ws-d', 'ws-a', 'ws-b', 'ws-c']);
  // moving it never restarted its terminal
  expect(await alive('ws-d')).toBe(true);
  const disk = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  await expect.poll(() => disk().columns.map((c) => c.id)).toEqual(['ws-d', 'ws-a', 'ws-b', 'ws-c']);
  expect(disk().columns[0].folderId).toBe(disk().folders[0].id);

  // clicking a row jumps to its column
  await page.locator('.colnav-item[data-col-id="ws-c"]').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('ws-c');

  // deleting the folder keeps the session, as a loose one
  await page.locator('.nav-folder-head').click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: '删除文件夹' }).click();
  await expect(page.locator('.nav-folder')).toHaveCount(0);
  await expect(page.locator('.nav-group .colnav-item[data-col-id="ws-d"]')).toBeVisible();
  expect(await alive('ws-d')).toBe(true);
});

test('archive keeps the conversation; restore brings the session back with it', { tag: '@smoke' }, async () => {
  const col = page.locator('.column[data-col-id="ws-a"]');
  await col.locator('.composer textarea').click();
  await page.keyboard.type('remember the archive drill');
  await page.keyboard.press('Enter');
  await expect(col.locator('.reply').last()).toContainText('GOT remember the archive drill', { timeout: 20000 });
  await col.hover();
  await col.locator('.secondary .icon-btn').first().click();   // archive
  await expect(col).toHaveCount(0);
  await expect.poll(() => alive('ws-a')).toBe(false);
  await expect(page.locator('.nav-section[data-section="archived"]')).toContainText('1');
  expect(fs.existsSync(path.join(profile, 'chats', 'ws-a.json'))).toBe(true);
  expect(fs.existsSync(path.join(profile, 'sessions', 'ws-a.txt'))).toBe(true);

  // archived conversations are still searchable
  await page.locator('#navSearch').fill('archive drill');
  await expect(page.locator('#navResults .nr-item', { hasText: '已归档' }).first()).toBeVisible();
  await page.locator('#navSearch').fill('');

  await page.locator('.nav-section[data-section="archived"]').click();
  await page.locator('.nav-archived-item[data-archived-id="ws-a"]').click();
  const restored = page.locator('.column[data-col-id="ws-a"]');
  await expect(restored).toBeVisible();
  await expect(restored).not.toHaveClass(/chat-mode/);
  await restored.locator('.view-toggle').click();
  await expect(restored.locator('.msg.user .bubble').last()).toHaveText('remember the archive drill');
  await expect.poll(() => alive('ws-a'), { timeout: 15000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('ws-a');
  expect(await page.evaluate(() => config.archived.length)).toBe(0);
});

test('Schedule sends a prompt on time, and runs due while closed are reported as missed', async () => {
  await page.locator('.nav-row[data-nav="schedule"]').click();
  await page.locator('.page-head .btn.primary').click();
  await page.locator('#sdPrompt').fill('scheduled hello');
  await page.locator('#sdTarget').selectOption('ws-c');
  await page.locator('.sd-kind[data-kind="interval"]').click();
  await page.locator('#sdEvery').fill('2');
  await page.locator('#sdSave').click();
  await expect(page.locator('.sched-card')).toHaveCount(1);
  const id = await page.evaluate(() => config.schedules[0].id);
  expect(await page.evaluate(() => config.schedules[0].nextAt - Date.now())).toBeGreaterThan(110 * 60_000);

  // make it due now and let the runner pick it up
  await page.evaluate(() => { config.schedules[0].nextAt = Date.now() - 1000; Pages.tick(false); });
  // ConPTY may split screen redraws with control sequences between letters.
  // Verify what the stand-in received, rather than relying on its screen echo.
  await expect.poll(deliveredPrompts, { timeout: 15000 }).toContain('scheduled hello');
  await expect(page.locator('.column[data-col-id="ws-c"] .msg.user .bubble').last()).toHaveText('scheduled hello');
  expect(await page.evaluate(() => config.schedules[0].lastStatus)).toBe('ok');

  // overdue at launch: reported, not fired
  const before = deliveredPrompts().filter((text) => text === 'scheduled hello').length;
  await page.evaluate(() => { config.schedules[0].nextAt = Date.now() - 3600_000; Pages.tick(true); });
  expect(await page.evaluate(() => config.schedules[0].lastStatus)).toBe('missed');
  expect(deliveredPrompts().filter((text) => text === 'scheduled hello').length).toBe(before);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).schedules?.[0]?.lastStatus).toBe('missed');
  await page.keyboard.press('Escape');
});

test('a schedule can open a fresh session and deliver once the agent is ready', async () => {
  const beforeIds = await page.evaluate(() => columns.map((c) => c.id));
  await page.evaluate(({ cwd, cmd }) => {
    const orig = BoardCore.commandForAgent;
    try {
      BoardCore.commandForAgent = () => cmd;
      config.schedules.push(ScheduleCore.arm(ScheduleCore.normalizeSchedule({
        id: 'fresh', prompt: 'please write the report', target: 'new', cwd, kind: 'interval', every: 60, createdAt: Date.now(),
      }), Date.now()));
      config.schedules[config.schedules.length - 1].nextAt = Date.now() - 500;
      Pages.tick(false);
    } finally {
      BoardCore.commandForAgent = orig;
    }
  }, { cwd: profile, cmd: FAKE });
  await expect.poll(() => page.evaluate(() => columns.length)).toBe(beforeIds.length + 1);
  const id = await page.evaluate((old) => columns.find((c) => !old.includes(c.id))?.id, beforeIds);
  expect(id).toBeTruthy();
  // once the stand-in agent is ready, the prompt is delivered and answered
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.alive, id), { timeout: 15000 }).toBe(true);
  await expect.poll(deliveredPrompts, { timeout: 20000 }).toContain('please write the report');
  await expect(page.locator(`.column[data-col-id="${id}"] .reply`).last()).toContainText('GOT please write the report', { timeout: 20000 });
});

test('a schedule can open a fresh bare shell session and execute', async () => {
  const beforeIds = await page.evaluate(() => columns.map((c) => c.id));
  const marker = path.join(profile, 'executed-shell.txt');
  const command = `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'fresh-session-'+(40+2))"`;
  await page.evaluate(({ cwd, command }) => {
    config.schedules.push(ScheduleCore.arm(ScheduleCore.normalizeSchedule({
      id: 'fresh-shell', prompt: command, target: 'new', agent: 'shell', cwd, kind: 'interval', every: 60, createdAt: Date.now(),
    }), Date.now()));
    config.schedules[config.schedules.length - 1].nextAt = Date.now() - 500;
    Pages.tick(false);
  }, { cwd: profile, command });
  await expect.poll(() => page.evaluate(() => columns.length)).toBe(beforeIds.length + 1);
  const id = await page.evaluate((old) => columns.find((c) => !old.includes(c.id))?.id, beforeIds);
  expect(id).toBeTruthy();
  // The marker only exists if the shell executed the delivered command; ConPTY
  // screen wrapping must not make a successful execution look like a failure.
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.alive, id), { timeout: 15000 }).toBe(true);
  await expect.poll(() => fs.existsSync(marker), { timeout: 15000 }).toBe(true);
  expect(fs.readFileSync(marker, 'utf8')).toBe('fresh-session-42');
});
