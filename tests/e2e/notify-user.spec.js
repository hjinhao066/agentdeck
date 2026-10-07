const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
let application, page, profile;
const CLI = process.platform === 'win32' ? '$env:AGENTDECK_BOARD_CLI' : '$AGENTDECK_BOARD_CLI';
const alerts = () => application.evaluate(({ app }) => app.testCaptainAlerts);
const screen = (id = 'captain') => page.evaluate((i) => dumpScreen(terms.get(i).term).replace(/\n/g, ''), id);
const run = (id, command) => page.evaluate(([i, c]) => window.deck.ptyInput(i, c + '\r'), [id, command]);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-notify-cli-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    barkNotifications: { sleepEnabled: false, classesEnabled: false },
    mainSession: { colId: 'captain', cmd: '', crewMarked: true }, theme: 'dark',
    columns: [{ id: 'captain', title: '队长', isMain: true, cmd: '', cwd: profile },
      { id: 'worker', title: 'Managed worker', role: 'worker', taskId: 'task-worker', cmd: '', cwd: profile }],
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(2);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('real Captain CLI sends a local native alert; default never sends Bark', async () => {
  await page.evaluate(() => { terms.get('captain').captainTurnId = 'cli-current-turn'; });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await run('captain', `node "${CLI}" notify-user --message "请亲自登录。后续说明。"`);
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'notification').length).toBe(1);
  await expect.poll(() => screen()).toContain('已处理本机提醒');
  const events = await alerts();
  expect(events.find((e) => e.type === 'notification')).toMatchObject({ title: '队长', body: '请亲自登录。' });
  if (process.platform === 'darwin') expect(events.filter((e) => e.type === 'sound')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'bark')).toHaveLength(0);
  await page.evaluate(() => window.deck.notifyState({ id: 'captain', turnId: 'cli-current-turn', state: 'done', reply: '本轮回复结束。' }));
  await page.evaluate(() => window.deck.ptyIsAlive('captain'));
  expect((await alerts()).filter((e) => e.type === 'notification')).toHaveLength(1);
  await page.evaluate(() => { terms.get('captain').captainTurnId = null; });
});
test('a token-bearing managed worker cannot use notify-user, including urgent', async () => {
  const before = (await alerts()).filter((e) => e.type !== 'cancel').length;
  await run('worker', `node "${CLI}" notify-user --message "worker should be silent" --urgent`);
  await expect.poll(() => screen('worker')).toMatch(/只有队长可以用这个命令|Receipt capability allows only/);
  expect((await alerts()).filter((e) => e.type !== 'cancel').length).toBe(before);
});
// A blank path with no default key file is dropped with a setup hint (seat-auth-alert.spec.js);
// a path that was filled in but cannot be read is a fault and stays queued.
test('an unreadable configured key keeps local notification and queues Bark for retry', async () => {
  await page.evaluate((file) => { config.barkKeyFile = file; saveConfig(); flushConfig(); }, path.join(profile, 'no-such-key'));
  await run('captain', `node "${CLI}" notify-user --message "请授权。" --urgent`);
  await expect.poll(() => screen()).toMatch(/Bark.*(?:密钥文件不可读|发送失败)/);
  expect((await alerts()).filter((e) => e.type === 'notification')).toHaveLength(2);
  expect((await alerts()).filter((e) => e.type === 'bark')).toHaveLength(0);
  await expect.poll(() => page.evaluate(async () => (await window.deck.barkStatus()).queuedCount)).toBe(1);
});
test('configured urgent delivers critical/4/minuet with local toggles off; replay is harmless and key stays private', async () => {
  const file = path.join(profile, 'bark-test-key'); fs.writeFileSync(file, 'fake_e2e_device_key\n');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const pathInput = page.getByLabel('Bark 本机密钥文件路径（barkKeyFile）', { exact: true });
  await expect(page.getByLabel('手机加急通知音量', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('睡觉开始', { exact: true })).toHaveValue('23:00');
  await expect(page.getByLabel('睡觉结束', { exact: true })).toHaveValue('10:00');
  await expect(page.locator('#barkPolicyStatus')).toContainText('暂存手机提醒：1 条');
  await expect(page.locator('#barkPolicyStatus')).toContainText('发送失败待重试');
  await pathInput.fill(' ~/.secrets/bark-key.txt ');
  await pathInput.press('Tab');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).barkKeyFile).toBe('~/.secrets/bark-key.txt');
  const shots = process.env.AGENTDECK_BARK_SCREENSHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.locator('#notificationSettings').screenshot({ path: path.join(shots, 'settings-dark.png') });
    await page.evaluate(() => applyTheme('light'));
    await page.locator('#notificationSettings').screenshot({ path: path.join(shots, 'settings-light.png') });
    await page.evaluate(() => applyTheme('dark'));
  }
  const close = page.getByRole('button', { name: '关闭设置', exact: true });
  await expect(close).toHaveAttribute('title', '关闭设置');
  await expect(close.locator('svg')).toHaveCount(1);
  await close.evaluate((el) => Promise.all(el.closest('dialog').getAnimations().map((a) => a.finished)));
  expect(await close.evaluate((el) => el.offsetWidth)).toBeGreaterThanOrEqual(36);
  // Windows DIP coordinates can report 36px as 35.99993896484375.
  expect((await close.boundingBox()).width).toBeGreaterThanOrEqual(process.platform === 'win32' ? 36 - 0.0001 : 36);
  await pathInput.fill(file);
  await page.getByLabel('Bark 本机密钥文件路径（barkKeyFile）', { exact: true }).press('Tab');
  await page.getByRole('button', { name: '刷新课表并重试手机提醒', exact: true }).click();
  await expect.poll(() => application.evaluate(({ app }) => app.testBarkDigests.length)).toBe(1);
  await expect(page.locator('#barkPolicyStatus')).toContainText('暂存手机提醒：0 条');
  await page.getByRole('switch', { name: '系统通知', exact: true }).uncheck();
  await page.getByRole('switch', { name: '提示音', exact: true }).uncheck();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).barkKeyFile).toBe(file);
  await run('captain', `node "${CLI}" notify-user --message "请亲自确认付款。" --urgent`);
  await expect.poll(() => screen()).toContain('Bark 紧急提醒已发送');
  const events = await alerts();
  expect(events.filter((e) => e.type === 'bark')).toEqual([{ type: 'bark', title: '队长', body: '请亲自确认付款。', level: 'critical', volume: 4, sound: 'minuet' }]);
  expect(events.filter((e) => e.type === 'notification')).toHaveLength(2);
  expect(await screen()).not.toContain('fake_e2e_device_key');
  expect(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).not.toContain('fake_e2e_device_key');
  await page.evaluate(() => {
    const [requestId, response] = Object.entries(config.boardResponses).at(-1);
    window.deck.boardRespond({ requestId, ...response });
  });
  await page.evaluate(() => window.deck.ptyIsAlive('captain'));
  expect((await alerts()).filter((e) => e.type === 'bark')).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('Bark 本机密钥文件路径（barkKeyFile）', { exact: true })).toHaveValue(file);
  await page.getByLabel('手机加急通知音量', { exact: true }).fill('7');
  await page.getByLabel('手机加急通知音量', { exact: true }).press('Tab');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).barkNotifications.criticalVolume).toBe(7);
  await page.getByRole('button', { name: '关闭设置' }).click();
});

test('test command uses shared volume setting once; repeated acknowledgements cannot resend', async () => {
  await run('captain', `node "${CLI}" notify-user --test`);
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'bark').length).toBe(2);
  const events = await alerts();
  expect(events.filter((e) => e.type === 'bark').at(-1)).toEqual({ type: 'bark',
    title: '【测试】', body: 'AgentDeck 加急通知测试，音量 7',
    level: 'critical', volume: 7, sound: 'minuet' });
  await page.evaluate(() => {
    const [requestId, response] = Object.entries(config.boardResponses).at(-1);
    window.deck.boardRespond({ requestId, ...response });
    window.deck.boardRespond({ requestId, ...response });
  });
  await page.evaluate(() => window.deck.ptyIsAlive('captain'));
  expect((await alerts()).filter((e) => e.type === 'bark')).toHaveLength(2);
  expect(JSON.stringify(await alerts())).not.toContain('fake_e2e_device_key');
  expect(await screen()).not.toContain('fake_e2e_device_key');
});

test('calendar and fixed weekly class settings are editable, refreshable and durable', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const calendars = page.getByLabel('课程在哪个日历里（每行一个，主日历写 primary）', { exact: true });
  const filters = page.getByLabel('课程名称（每行一个）', { exact: true });
  const weekly = page.getByLabel('每周固定上课时段（西雅图时间，课表不可用时兜底）', { exact: true });
  await expect(weekly).toHaveValue('周二 10:30-12:20\n周四 10:30-12:20\n周二 15:30-17:20');
  await calendars.fill('primary\nschool@example.test'); await calendars.press('Tab');
  await filters.fill('COURSE 101\nCOURSE 102'); await filters.press('Tab');
  await weekly.fill('周三 10:00-11:00'); await weekly.press('Tab');
  await page.getByRole('switch', { name: '上课时暂停手机提醒', exact: true }).check();
  const refresh = page.getByRole('button', { name: '刷新课表并重试手机提醒', exact: true });
  await expect(refresh).toHaveAttribute('title', '刷新课表并重试手机提醒'); await expect(refresh.locator('svg')).toHaveCount(1);
  await refresh.click(); await expect(refresh).toBeEnabled();
  await expect(page.locator('#barkPolicyStatus')).toContainText('使用每周固定上课时段');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).barkNotifications).toMatchObject({
    classCalendarIds: ['primary', 'school@example.test'], classFilters: ['COURSE 101', 'COURSE 102'],
    weeklyClasses: [{ day: 3, start: '10:00', end: '11:00' }],
  });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(calendars).toHaveValue('primary\nschool@example.test');
  await expect(filters).toHaveValue('COURSE 101\nCOURSE 102'); await expect(weekly).toHaveValue('周三 10:00-11:00');
  await weekly.fill(''); await weekly.press('Tab'); await refresh.click();
  await expect(page.locator('#barkPolicyStatus')).toContainText('未设置固定上课时段，上课时手机可能响');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
});

test('a mistyped class period does not trap the settings window: the rest is saved and it closes', async () => {
  const saved = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).barkNotifications;
  const before = saved().weeklyClasses;
  const weekly = page.locator('#barkWeeklyClasses'), volume = page.locator('#barkCriticalVolume'), dialog = page.locator('#notificationSettings');
  for (const [close, value] of [[() => page.getByRole('button', { name: '关闭设置', exact: true }).click(), 7], [() => page.keyboard.press('Escape'), 6]]) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await weekly.fill('周二 12:20-10:30\n随便写的'); await volume.fill(String(value));
    await close();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#toast')).toHaveText('上课时段有一行格式不对，这一项没改；其他设置已保存。');
    await expect.poll(() => saved().criticalVolume).toBe(value);
    expect(saved().weeklyClasses).toEqual(before);
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(volume).toHaveValue('6');
  await expect(weekly).toHaveValue(before.map((p) => `周${'日一二三四五六'[p.day]} ${p.start}-${p.end}`).join('\n'));
  await volume.fill('4'); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('empty key setting uses the Captain default file within the isolated profile', async () => {
  fs.mkdirSync(path.join(profile, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(profile, '.secrets/bark-key.txt'), 'fake_default_captain_key');
  await page.evaluate(() => {
    config.barkKeyFile = ''; config.barkNotifications = BarkPolicy.settings({ sleepEnabled: false, classesEnabled: false });
    saveConfig(); flushConfig();
  });
  const before = (await alerts()).filter((event) => event.type === 'bark').length;
  await run('captain', `node "${CLI}" notify-user --message "隔离默认密钥链路验证。" --urgent`);
  await expect.poll(async () => (await alerts()).filter((event) => event.type === 'bark').length).toBe(before + 1);
  expect((await alerts()).filter((event) => event.type === 'bark').at(-1)).toMatchObject({ level: 'critical', volume: 4, body: '隔离默认密钥链路验证。' });
  expect(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).not.toContain('fake_default_captain_key');
});
