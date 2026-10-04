const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let app, page, profile, home;
const M = require('../../claude-seats-main');
function writeCache(id, remaining) {
  M.writeUsage({ id, configDir: id === 'us' ? '~/.claude' : '~/.claude-cn' }, home, { at: Date.now(), windows: [
    { key: 'fiveHour', remaining: remaining[0], resetText: 'in 1h' }, { key: 'weekly', remaining: remaining[1], resetText: 'in 4d' },
  ] });
}
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-seats-'));
  home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-cn']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.com' } }));
  fs.writeFileSync(path.join(home, '.claude-cn/.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.com' } }));
  writeCache('us', [19, 91]);
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
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test('each Claude seat keeps its own windows and reset times, marks the real Captain seat and survives reload', async () => {
  await expect(seat('us').locator('.quota-label')).toHaveText('5h 19% · 7d 91%', { timeout: 20000 });
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长');
  await expect(seat('cn').locator('.quota-label')).toHaveText('未知');
  await expect(seat('cn')).toHaveAttribute('title', /每周：未知；重置 未知/);
  await page.evaluate(() => { config.activeClaudeSeatId = 'cn'; renderQuotaBar(); });
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长'); // Switching the next seat is not switching the running Captain.
  // The same shared footer cannot populate the other seat.
  await page.evaluate(() => window.deck.ptyInput('cn-column', 'quota-data\r'));
  await page.waitForTimeout(1800);
  await expect(seat('cn').locator('.quota-label')).toHaveText('未知');
  writeCache('cn', [65, 30]);
  await page.evaluate(async () => { for (const q of await window.deck.quotaLocal()) QuotaCore.observe(config.quotas, q); renderQuotaBar(); });
  await expect(seat('cn').locator('.quota-label')).toHaveText('5h 65% · 7d 30%');
  await expect(seat('cn')).toHaveAttribute('title', /5 小时剩余 65%；重置.*每周剩余 30%；重置/s);
  await expect(seat('us').locator('.quota-label')).toHaveText('5h 19% · 7d 91%');
  await page.evaluate(() => window.deck.ptyInput('cn-column', 'exhausted\r'));
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('data-state', 'warning');
  await page.evaluate(() => flushConfig());
  await page.reload();
  await expect(seat('us').locator('.quota-name')).toHaveText('🇺🇸 US · 队长');
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us')).toHaveAttribute('title', /us\*\*\*@example.com/);
  const text = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  expect(text).toMatch(/Claude \/ 🇨🇳 CN：已用尽[^\n]*5 小时剩余 65/);
  expect(text).toMatch(/Claude \/ 🇺🇸 US：19%[^\n]*5 小时剩余 19/);
  // The Captain's own statusline is recorded under its seat's account only.
  await page.evaluate(() => window.deck.ptyInput('us-column', 'statusline\r'));
  await expect.poll(async () => {
    await page.evaluate(async () => { for (const q of await window.deck.quotaLocal()) QuotaCore.observe(config.quotas, q); renderQuotaBar(); });
    return seat('us').locator('.quota-label').textContent();
  }, { timeout: 20000 }).toBe('5h 83% · 7d 59%');
  await expect(seat('us')).toHaveAttribute('title', /会话状态行/);
  await expect(seat('cn')).toHaveAttribute('data-state', 'exhausted');
  const after = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  expect(after).toMatch(/Claude \/ 🇺🇸 US：59%[^\n]*5 小时剩余 83/);
  expect(after).toMatch(/Claude \/ 🇨🇳 CN：已用尽[^\n]*5 小时剩余 65/);
  // Top bar tooltip, keyboard popover and board-cli quota share one summary.
  for (const id of ['us', 'cn']) {
    const title = await seat(id).getAttribute('title');
    expect(after.split('\n')).toContain(title.replace(/\n/g, ' · '));
    await expect(seat(id).getByRole('tooltip', { includeHidden: true })).toHaveText(title);
  }
  await seat('us').focus();
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(seat('us').getByRole('tooltip')).toBeVisible();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-claude-seats-light.png') });
  }
});
