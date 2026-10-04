const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const M = require('../../claude-seats-main');
const FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let application, page, profile;
const alerts = () => application.evaluate(({ app }) => app.testQuotaAlerts);
async function launch() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
}
test.beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-low-bark-'));
  const home = path.join(profile, 'seats-home');
  for (const id of ['cn', 'us']) {
    const seat = { id, configDir: `~/.claude-${id}` }, loc = M.credentialLocation(seat, home);
    fs.mkdirSync(loc.dir, { recursive: true });
    fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: `offline-${id}`, emailAddress: `${id}@example.test` } }));
    if (id === 'us') M.writeUsage(seat, home, { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 19, resetText: 'in 1h' }, { key: 'weekly', remaining: 91, resetText: 'in 4d' }] });
  }
  const file = path.join(profile, 'fake-key'); fs.writeFileSync(file, 'fake_e2e_quota_device_key');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ barkKeyFile: file,
    claudeSeats: ['cn', 'us'].map((id) => ({ id, name: id.toUpperCase(), configDir: `~/.claude-${id}` })),
    columns: ['cn', 'us'].map((id) => ({ id, title: id.toUpperCase(), claudeSeatId: id,
      cmd: `node "${FAKE}" Claude ${id}`, cwd: profile, role: 'manual' })),
  }));
});
test.afterEach(async () => {
  if (application) { await application.close(); application = null; }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('startup low quotas send once per account; relaunch and renderer replay do not resend', async () => {
  const file = path.join(profile, 'config.json'), config = JSON.parse(fs.readFileSync(file));
  config.quotas = Object.fromEntries(['cn', 'us'].map((id) => [`Claude:${id}`, {
    scope: 'claude', configDir: `~/.claude-${id}`, accountKey: require('crypto').createHash('sha256').update(`offline-${id}`).digest('hex').slice(0, 16),
    sample: { at: Date.now(), source: 'offline fixture', accountBound: true, configDir: `~/.claude-${id}`, accountKey: require('crypto').createHash('sha256').update(`offline-${id}`).digest('hex').slice(0, 16), windows: [
      { label: '5 小时', remaining: 2, resetAt: Date.now() + 3600000 },
    ] },
  }]));
  fs.writeFileSync(file, JSON.stringify(config)); await launch();
  await expect.poll(async () => (await alerts()).length).toBe(2);
  expect(await alerts()).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: 'critical', volume: 3, body: expect.stringMatching(/CN.*剩余 2%.*重置时间/) }),
    expect.objectContaining({ level: 'critical', volume: 3, body: expect.stringMatching(/US.*剩余 2%.*重置时间/) }),
  ]));
  await page.evaluate(() => { flushConfig(); window.deck.saveConfig(config); window.deck.saveConfig(config); });
  await page.waitForTimeout(500); expect(await alerts()).toHaveLength(2);
  expect(fs.readFileSync(path.join(profile, 'quota-bark-state.json'), 'utf8')).not.toContain('fake_e2e_quota_device_key');
  await application.close(); application = null; await launch();
  await page.waitForTimeout(2000); expect(await alerts()).toHaveLength(0);
  await page.reload(); await page.waitForTimeout(2000); expect(await alerts()).toHaveLength(0);
  expect(await page.evaluate(() => config.claudeQuotaAlert)).toEqual({ thresholdPercent: 2, volume: 3 });
  expect(await page.evaluate(() => config.barkKeyFile)).toBe(path.join(profile, 'fake-key'));
});
test('live Claude seat footer triggers inclusively, deduplicates and rearms after recovery', async () => {
  await launch();
  const badge = page.locator('#quotaBar [data-quota-key="Claude:us"] .quota-label');
  await expect(badge).toHaveText(/5h 19% ↻.* · 7d 91% ↻/, { timeout: 20000 });
  expect(await alerts()).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => terms.get('us')?.lastScreen || '')).toContain('Claude Code');
  await page.evaluate(() => window.deck.ptyInput('us', 'remaining:2\r'));
  await expect.poll(async () => (await alerts()).length).toBe(1);
  expect((await alerts())[0]).toMatchObject({ level: 'critical', volume: 3, body: expect.stringMatching(/US.*剩余 2%/) });
  await page.evaluate(() => window.deck.ptyInput('us', 'remaining:1\r'));
  await expect(badge).toHaveText(/5h 1% ↻.* · 7d 1% ↻/);
  await page.waitForTimeout(500); expect(await alerts()).toHaveLength(1);
  await page.evaluate(() => window.deck.ptyInput('us', 'remaining:50\r'));
  await expect(badge).toHaveText(/5h 50% ↻.* · 7d 1% ↻/);
  await expect.poll(() => Object.values(JSON.parse(fs.readFileSync(path.join(profile, 'quota-bark-state.json')))).some((s) => !s.notified)).toBe(true);
  await page.evaluate(() => window.deck.ptyInput('us', 'remaining:0\r'));
  await expect.poll(async () => (await alerts()).length).toBe(2);
  await page.evaluate(() => window.deck.ptyInput('cn', 'remaining:2\r'));
  await expect.poll(async () => (await alerts()).length).toBe(3);
  expect((await alerts())[2].body).toMatch(/CN.*剩余 2%/);
  expect(JSON.stringify(await alerts())).not.toContain('fake_e2e_quota_device_key');
  expect(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).not.toContain('fake_e2e_quota_device_key');
});
