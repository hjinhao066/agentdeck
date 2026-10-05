const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
let app, page, profile;

async function setLevel(level) {
  await app.evaluate(({ ipcMain }, level) => {
    ipcMain.removeHandler('memory-pressure');
    ipcMain.handle('memory-pressure', async () => ({ level, critical: level === 4 }));
  }, level);
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-concurrency-cap-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [{ id: 'cap', title: '队长', isMain: true, cmd: FAKE, cwd: profile }],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] },
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env,
  });
  await expect.poll(async () => {
    for (const candidate of app.windows()) {
      const ready = await candidate.evaluate(() => typeof terms !== 'undefined' && terms.get('cap')?.alive === true).catch(() => false);
      if (ready) { page = candidate; return true; }
    }
    return false;
  }, { timeout: 20000 }).toBe(true);
  await setLevel(1);
});

test.afterAll(async () => {
  if (app) {
    const proc = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (proc && proc.exitCode == null) proc.kill('SIGKILL');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('settings cap queues overflow, a larger cap fills it, and critical memory pauses until pressure eases', async () => {
  await page.locator('#settingsBtn').click();
  const dialog = page.locator('#notificationSettings');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#concurrencyCap')).toHaveValue('30');
  await expect(page.locator('#concurrencyCapNote')).toHaveText('同时最多几个会话干活，超出的自动排队');
  await expect(page.locator('#notificationSettingsClose')).toHaveAttribute('aria-label', '关闭设置');
  await page.locator('#concurrencyCap').fill('4');
  await page.locator('#csSave').click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => config.concurrencyCap)).toBe(30);

  await page.locator('#concurrencyCap').fill('5');
  await page.locator('#csSave').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => [config.concurrencyCap, MainCore.MAX_ACTIVE])).toEqual([5, 5]);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).concurrencyCap).toBe(5);
  const brief = await page.evaluate(async () => (await MainSession.handle({ action: 'main-briefing' }, MainSession.mainCol())).result);
  expect(brief).toContain('最多 5 个会话在干活');
  expect(brief).toContain('并发上限 5');
  expect(brief).toContain('kern.memorystatus_vm_pressure_level');
  expect(brief).toContain('全量 E2E');
  expect(brief).not.toContain('vm.swapusage');

  await page.evaluate(() => { MainCore.activeCrew = () => new Set(['b0', 'b1', 'b2', 'b3', 'b4']); });
  const queued = await page.evaluate((cmd) => MainSession.handle({
    action: 'main-new', id: 'q-cap', title: '排队甲', task: 'wait for a free slot', command: cmd,
  }, MainSession.mainCol()), FAKE);
  expect(queued.result).toContain('已排队');
  expect(queued.result).toContain('5');
  const waiting = page.locator('.task-card.st-waiting', { hasText: '排队甲' });
  await expect(waiting).toContainText('同时最多 5 个会话干活');
  expect(await page.evaluate(() => columns.some((c) => c.displayTitle === '排队甲'))).toBe(false);

  await page.locator('#settingsBtn').click();
  await expect(page.locator('#concurrencyCap')).toHaveValue('5');
  await page.locator('#concurrencyCap').fill('6');
  await page.locator('#csSave').click();
  await expect.poll(() => page.evaluate(() => config.concurrencyCap)).toBe(6);
  await expect.poll(() => page.evaluate(() => columns.some((c) => c.displayTitle === '排队甲')), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => config.mainSession.waitlist.length)).toBe(0);

  await setLevel(4);
  const held = await page.evaluate((cmd) => MainSession.handle({
    action: 'main-new', id: 'q-mem', title: '内存乙', task: 'wait for memory', command: cmd,
  }, MainSession.mainCol()), FAKE);
  expect(held.result).toContain('内存吃紧，稍后自动开');
  const heldCard = page.locator('.task-card.st-waiting', { hasText: '内存乙' });
  await expect(heldCard).toContainText('内存吃紧，稍后自动开');
  expect(await page.evaluate(() => columns.some((c) => c.displayTitle === '内存乙'))).toBe(false);

  await setLevel(2);
  await page.evaluate(() => {
    const id = MainSession.mainCol().id;
    MainSession.onTick(id, terms.get(id));
  });
  await expect.poll(() => page.evaluate(() => columns.some((c) => c.displayTitle === '内存乙')), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => config.mainSession.waitlist.length)).toBe(0);
});
