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
test('urgent without a configured key still notifies locally and prints the setup hint', async () => {
  await run('captain', `node "${CLI}" notify-user --message "请授权。" --urgent`);
  await expect.poll(() => screen()).toContain('Bark 已跳过');
  expect((await alerts()).filter((e) => e.type === 'notification')).toHaveLength(2);
  expect((await alerts()).filter((e) => e.type === 'bark')).toHaveLength(0);
});
test('configured urgent delivers critical/4/minuet with local toggles off; replay is harmless and key stays private', async () => {
  const file = path.join(profile, 'bark-test-key'); fs.writeFileSync(file, 'fake_e2e_device_key\n');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const pathInput = page.getByLabel('Bark 本机密钥文件路径（barkKeyFile）', { exact: true });
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
  expect((await close.boundingBox()).width).toBeGreaterThanOrEqual(36);
  await pathInput.fill(file);
  await page.getByLabel('Bark 本机密钥文件路径（barkKeyFile）', { exact: true }).press('Tab');
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
  await page.getByRole('button', { name: '关闭设置' }).click();
});

test('test command sends marked critical/3/minuet once; repeated acknowledgements cannot resend', async () => {
  await run('captain', `node "${CLI}" notify-user --test`);
  await expect.poll(async () => (await alerts()).filter((e) => e.type === 'bark').length).toBe(2);
  const events = await alerts();
  expect(events.filter((e) => e.type === 'bark').at(-1)).toEqual({ type: 'bark',
    title: '【测试】队长', body: '【测试】AgentDeck Bark 通知（critical，音量 3）。',
    level: 'critical', volume: 3, sound: 'minuet' });
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
