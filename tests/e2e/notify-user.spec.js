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
  await expect.poll(() => screen('worker')).toContain('只有队长可以用这个命令');
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
  await page.getByLabel('Bark 本机密钥文件路径', { exact: true }).fill(file);
  await page.getByLabel('Bark 本机密钥文件路径', { exact: true }).press('Tab');
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
  await expect(page.getByLabel('Bark 本机密钥文件路径', { exact: true })).toHaveValue(file);
});
