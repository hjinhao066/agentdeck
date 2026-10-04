const { test, expect } = require('@playwright/test');
const { electron, closeElectron, waitForTicks } = require('./electron-helper');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let app, page, profile;
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-seats-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'us', name: '🇺🇸 US', configDir: '~/.claude' }, { id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude-cn' }],
    activeClaudeSeatId: 'us', mainSession: { colId: 'us-column', tasks: [], pending: [] },
    columns: ['us', 'cn'].map(id => ({ id: `${id}-column`, title: id === 'us' ? '🇺🇸 US模拟会话' : '🇨🇳 CN模拟会话', claudeSeatId: id, isMain: id === 'us', cmd: `node "${FAKE}" Claude ${id}`, cwd: profile, width: 600, role: 'manual' })),
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
});
test.afterAll(async () => { if (app) await closeElectron(app, { requireGraceful: false }); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test('each Claude seat keeps its own windows and reset times, marks the real Captain seat and survives reload', async () => {
  await expect(seat('us').locator('.quota-label')).toHaveText('5h 19% · 7d 91%', { timeout: 20000 });
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长');
  await expect(seat('cn').locator('.quota-label')).toHaveText('未登录/无数据');
  await expect(seat('cn')).toHaveAttribute('title', /每周：未登录\/无数据；重置 未知/);
  await page.evaluate(() => { config.activeClaudeSeatId = 'cn'; renderQuotaBar(); });
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长'); // Switching the next seat is not switching the running Captain.
  await page.evaluate(() => window.deck.ptyInput('cn-column', 'quota-data\r'));
  await expect(seat('cn').locator('.quota-label')).toHaveText('5h 65% · 7d 30%');
  await expect(seat('cn')).toHaveAttribute('title', /5 小时剩余 65%；重置.*每周剩余 30%；重置/s);
  await expect(seat('us').locator('.quota-label')).toHaveText('5h 19% · 7d 91%');
  await page.evaluate(() => window.deck.ptyInput('cn-column', 'exhausted\r'));
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('data-state', 'warning');
  await page.evaluate(() => {
    for (const id of ['us', 'cn']) QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: id, at: Date.now(), identityOnly: true, account: `${id.slice(0, 2)}***@example.com`, accountKey: `demo-${id}` });
    flushConfig();
  });
  await page.reload();
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长');
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('title', /us\*\*\*@example.com/);
  await seat('us').focus();
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  await waitForTicks(page, 'us-column', 2);
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-light.png') });
  }
});
