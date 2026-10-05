const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
let application, page, profile;
const KEY = 'fake_e2e_needs_user_device';
const alerts = () => application.evaluate(({ app }) => app.testNeedsUserAlerts);
async function launch() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(2);
}
test.beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-needs-user-bark-'));
  const keyFile = path.join(profile, 'bark-key');
  fs.writeFileSync(keyFile, KEY + '\n');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', barkKeyFile: keyFile,
    columns: ['a', 'b'].map((id) => ({ id, title: id.toUpperCase(), cmd: '', cwd: profile })),
  }));
});
test.afterEach(async () => {
  if (application) { await application.close(); application = null; }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('entering 需要你 pushes once per visit, batches, and follows the settings switch', async () => {
  test.setTimeout(90000);
  await launch();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const toggle = page.getByRole('switch', { name: '需要你推到手机', exact: true });
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAttribute('aria-label', '需要你推到手机');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const ids = await page.evaluate(async () => {
    const first = await window.deck.taskBoard('add', { project: '门户', title: '确认密码策略', detail: '定长度。' });
    const second = await window.deck.taskBoard('add', { project: '报表', title: '核对账单', detail: '选月份。' });
    await window.deck.taskBoard('move', { id: first.card.id, status: 'needs_user' });
    await window.deck.taskBoard('move', { id: second.card.id, status: 'needs_user' });
    return [first.card.id, second.card.id];
  });
  await expect.poll(async () => (await alerts()).length, { timeout: 10000 }).toBe(1);
  const [firstPush] = await alerts();
  expect(firstPush).toMatchObject({ title: '需要你 · 2', level: 'active', sound: 'minuet' });
  expect(firstPush.body).toContain('门户 · 确认密码策略');
  expect(firstPush.body).toContain('报表 · 核对账单');
  expect(firstPush.body).toContain('请到看板决定下一步。');
  const statePath = path.join(profile, 'needs-user-bark-state.json');
  expect(fs.readFileSync(statePath, 'utf8')).not.toContain(KEY);
  expect(JSON.stringify(await alerts())).not.toContain(KEY);
  expect(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).not.toContain(KEY);
  await application.close(); application = null;
  await launch();
  await page.waitForTimeout(3000);
  expect(await alerts()).toHaveLength(0);
  await page.evaluate(async (id) => {
    await window.deck.taskBoard('move', { id, status: 'doing' });
    await window.deck.taskBoard('move', { id, status: 'needs_user' });
  }, ids[0]);
  await expect.poll(async () => (await alerts()).length, { timeout: 10000 }).toBe(1);
  expect((await alerts())[0].body).toContain('确认密码策略');
  expect((await alerts())[0].body).not.toContain('核对账单');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('switch', { name: '需要你推到手机', exact: true }).uncheck();
  await page.evaluate(() => flushConfig());
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).needsUserBark).toBe(false);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.evaluate(async (id) => {
    await window.deck.taskBoard('move', { id, status: 'doing' });
    await window.deck.taskBoard('move', { id, status: 'needs_user' });
  }, ids[1]);
  await page.waitForTimeout(3000);
  expect(await alerts()).toHaveLength(1);
  expect(fs.readFileSync(statePath, 'utf8')).not.toContain(KEY);
});
