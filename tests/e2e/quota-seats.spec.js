const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let app, page, profile;
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-seats-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'east', name: '东席', configDir: '~/.claude' }, { id: 'west', name: '西席', configDir: '~/.claude-west' }],
    activeClaudeSeatId: 'east', mainSession: { colId: 'east-column', tasks: [], pending: [] },
    columns: ['east', 'west'].map(id => ({ id: `${id}-column`, title: id === 'east' ? '东席模拟会话' : '西席模拟会话', claudeSeatId: id, isMain: id === 'east', cmd: `node "${FAKE}" Claude ${id}`, cwd: profile, width: 600, role: 'manual' })),
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test('each Claude seat keeps its own windows and reset times, marks the real Captain seat and survives reload', async () => {
  await expect(seat('east').locator('.quota-label')).toHaveText('5h 19% · 7d 91%', { timeout: 20000 });
  await expect(seat('east').locator('.quota-name')).toHaveText('东席 · 队长');
  await expect(seat('west').locator('.quota-label')).toHaveText('未登录/无数据');
  await expect(seat('west')).toHaveAttribute('title', /每周：未登录\/无数据；重置 未知/);
  await page.evaluate(() => { config.activeClaudeSeatId = 'west'; renderQuotaBar(); });
  await expect(seat('east').locator('.quota-name')).toHaveText('东席 · 队长'); // Switching the next seat is not switching the running Captain.
  await page.evaluate(() => window.deck.ptyInput('west-column', 'quota-data\r'));
  await expect(seat('west').locator('.quota-label')).toHaveText('5h 65% · 7d 30%');
  await expect(seat('west')).toHaveAttribute('title', /5 小时剩余 65%；重置.*每周剩余 30%；重置/s);
  await expect(seat('east').locator('.quota-label')).toHaveText('5h 19% · 7d 91%');
  await page.evaluate(() => window.deck.ptyInput('west-column', 'exhausted\r'));
  await expect(seat('west')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('east')).toHaveAttribute('data-state', 'warning');
  await page.evaluate(() => {
    for (const id of ['east', 'west']) QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: id, at: Date.now(), identityOnly: true, account: `${id.slice(0, 2)}***@example.com`, accountKey: `demo-${id}` });
    flushConfig();
  });
  await page.reload();
  await expect(seat('east').locator('.quota-name')).toHaveText('东席 · 队长');
  await expect(seat('west')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('east')).toHaveAttribute('title', /ea\*\*\*@example.com/);
  await seat('east').focus();
  await expect(seat('east').getByRole('tooltip')).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(seat('east').getByRole('tooltip')).toBeVisible();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-light.png') });
  }
});
