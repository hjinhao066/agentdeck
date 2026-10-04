const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let application, page, profile;
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const alerts = () => application.evaluate(({ app }) => app.testCaptainAlerts);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-notify-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    mainSession: { colId: 'captain', cmd: '', crewMarked: true },
    columns: [
      { id: 'captain', title: '队长', isMain: true, cmd: '', cwd: profile, width: 460 },
      { id: 'crew', title: '后台测试队员', captainCrew: true, cmd: '', cwd: profile, width: 460 },
      { id: 'manual', title: '普通会话', cmd: '', cwd: profile, width: 460 },
    ],
  }));
  const env = { ...process.env, AGENTDECK_LEGACY_WATCH: '1', AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((e) => e.alive).length)).toBe(3);
  await page.evaluate((cmd) => window.deck.ptyInput('captain', cmd + '\r'), FAKE);
  await expect.poll(() => page.evaluate(() => dumpScreen(terms.get('captain').term)), { timeout: 20000 }).toContain('Claude Code');
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('completed Captain reply flows from real PTY/chat to a native alert, with one gentle sound', async () => {
  await page.evaluate(() => ChatUI.sendPrompt(columns.find((c) => c.id === 'captain'), 'notify regression'));
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'notification').length, { timeout: 30000 }).toBe(1);
  const events = await alerts();
  expect(events[0]).toMatchObject({ type: 'notification', title: '队长', body: 'GOT notify regression' });
  if (process.platform === 'darwin') expect(events.filter((e) => e.type === 'sound')).toEqual([{ type: 'sound', tone: 'Glass' }]);
  expect(application.windows()).toHaveLength(1);
  await page.evaluate(() => {
    const turn = ChatUI.turnsOf('captain').at(-1);
    window.deck.notifyState({ id: 'captain', turnId: turn.id, state: 'input', reply: '重复提示。' });
  });
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'notification').length).toBe(1);
});

test('native click restores exact Captain from board/zoom/minimized views without stale fallback', async () => {
  await page.evaluate(() => { toggleZoom('manual'); showView('board'); });
  await application.evaluate(({ BrowserWindow, app }) => {
    BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'AgentDeck').minimize();
    app.testCaptainNotification.emit('click');
  });
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('captain');
  await expect.poll(() => page.evaluate(() => activeView)).toBe('terminals');
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('captain').el.querySelector('.xterm-helper-textarea'))).toBe(true);
  await page.evaluate(() => jumpToColumn(columns.find((c) => c.id === 'manual')));
  await application.evaluate(({ app }) => app.testCaptainNotification.emit('click'));
  expect(await page.evaluate(() => focusedId)).toBe('manual');
  await page.evaluate(() => { if (zoomedId) toggleZoom(zoomedId); });
});

test('background, peeked, foreground workers and unarmed manual sessions never popup or sound', async () => {
  const before = (await alerts()).filter((e) => ['notification', 'sound'].includes(e.type)).length;
  await page.evaluate((cmd) => window.deck.ptyInput('crew', cmd + '\r'), FAKE);
  await expect.poll(() => page.evaluate(() => dumpScreen(terms.get('crew').term)), { timeout: 15000 }).toContain('Claude Code');
  await page.evaluate(() => ChatUI.sendPrompt(columns.find((c) => c.id === 'crew'), 'worker done silently'));
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('crew').at(-1)?.done), { timeout: 15000 }).toBe(true);
  await page.evaluate(() => {
    const crew = columns.find((c) => c.id === 'crew');
    for (const foreground of [false, true]) {
      if (foreground) { jumpToColumn(crew); crew.captainCrew = false; updateColumnStyles(); }
      for (const id of ['crew', 'manual']) {
        const entry = terms.get(id);
        entry.hasWorked = true;
        entry.lastOutputAt = Date.now() - 60000;
        maybeNotifyState(id, entry, 'input');
        maybeNotifyState(id, entry, 'done');
        // Main-process filtering remains effective even if an old renderer sends.
        window.deck.notifyState({ id, turnId: 'worker-complete', state: 'done', reply: '队员完成。' });
      }
    }
  });
  // IPC round-trip flushes earlier sends.
  await page.evaluate(() => window.deck.ptyIsAlive('crew'));
  expect((await alerts()).filter((e) => ['notification', 'sound'].includes(e.type)).length).toBe(before);
  expect(application.windows()).toHaveLength(1);
  await page.evaluate(() => new Promise((resolve) => terms.get('crew').term.write('\x07', resolve)));
  expect((await alerts()).filter((e) => ['notification', 'sound'].includes(e.type)).length).toBe(before);
});

test('permission prompt alerts immediately; completion and quick next reply never repeat the sound', async () => {
  const before = (await alerts()).filter((e) => e.type === 'notification').length;
  await page.evaluate(() => ChatUI.sendPrompt(columns.find((c) => c.id === 'captain'), 'ask me'));
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'notification').length, { timeout: 15000 }).toBe(before + 1);
  const events = await alerts();
  expect(events.filter((e) => e.type === 'notification').at(-1).body).toContain('Proceed with the change?');
  if (process.platform === 'darwin') expect(events.filter((e) => e.type === 'sound')).toHaveLength(1);
});

test('visibility gate covers visible deck, horizontally hidden Captain, zoom, board and pages', async () => {
  expect(await page.evaluate(() => {
    jumpToColumn(columns.find((c) => c.id === 'captain'));
    return captainColumnVisible('captain');
  })).toBe(true);
  expect(await page.evaluate(() => { toggleZoom('manual'); return captainColumnVisible('captain'); })).toBe(false);
  expect(await page.evaluate(() => { toggleZoom('manual'); showView('board'); return captainColumnVisible('captain'); })).toBe(false);
  expect(await page.evaluate(() => { showView('terminals'); Pages.toggle('artifacts'); return captainColumnVisible('captain'); })).toBe(false);
  await page.evaluate(() => Pages.hide());
});

test('settings use accessible icon/switch controls and persist both toggles and tone', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.locator('#notificationSettings');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#settingsBtn svg')).toHaveCount(1);
  await page.getByRole('switch', { name: '系统通知', exact: true }).uncheck();
  await page.getByRole('switch', { name: '提示音', exact: true }).uncheck();
  if (process.platform === 'darwin') await page.getByLabel('选择提示音').selectOption('Tink');
  const shotDir = process.env.AGENTDECK_NOTIFY_SCREENSHOTS;
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await dialog.screenshot({ path: path.join(shotDir, 'settings-dark.png') });
    await page.evaluate(() => applyTheme('light'));
    await dialog.screenshot({ path: path.join(shotDir, 'settings-light.png') });
  }
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).captainNotifications).toMatchObject({ enabled: false, sound: false });
  const before = (await alerts()).filter((e) => ['notification', 'sound'].includes(e.type)).length;
  await page.evaluate(() => window.deck.notifyState({ id: 'captain', turnId: 'disabled-turn', state: 'input', reply: '关闭后不提醒。' }));
  await page.evaluate(() => window.deck.ptyIsAlive('captain'));
  expect((await alerts()).filter((e) => ['notification', 'sound'].includes(e.type)).length).toBe(before);
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('switch', { name: '系统通知', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '提示音', exact: true })).not.toBeChecked();
  if (process.platform === 'darwin') await expect(page.getByLabel('选择提示音')).toHaveValue('Tink');
});
