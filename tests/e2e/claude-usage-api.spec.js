const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const { officialUsage } = require('../../quota-claude');
const Q = require('../../quota-core');
const S = require('../../claude-seats-core');
let app, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-official-usage-'));
  const at = Date.now(), quotas = {};
  S.normalize().forEach((seat, i) => {
    Q.observe(quotas, { ...officialUsage({ five_hour: { utilization: i ? 100 : 9, resets_at: new Date(at + 2 * 3600000).toISOString() },
      seven_day: { utilization: i ? 52 : 10, resets_at: new Date(at + 3 * 86400000).toISOString() } }, seat, `fixture-${seat.id}`, at), accountKey: `offline-${seat.id}`, accountBound: true });
  });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark', quotas, columns: [{ id: 'usage-preview', title: '额度预览（模拟数据）', cmd: '', cwd: profile, role: 'manual' }], claudeSeats: S.normalize() }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
});
test.afterAll(async () => {
  if (app) {
    // Quit outside the inspector evaluation so Electron can finish shutdown
    // after a renderer reload without leaving Playwright's close call pending.
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await closed;
    await app.close();
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
const shots = process.env.AGENTDECK_QUOTA_SHOTS;
async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png') });
}
test('all Claude surfaces use remaining percentages and resets; icons refresh without dropping values', async () => {
  await expect(seat('cn').locator('.quota-values')).toHaveText('91%');
  // Exhausted rows replace the numbers with the recovery time.
  await expect(seat('us')).toHaveAttribute('data-state', 'exhausted');
  await expect(seat('us').locator('.quota-values')).toHaveText(/^↻\d\d:\d\d$/);
  await expect(seat('us')).toHaveAttribute('aria-label', /已用尽，\d\d:\d\d 恢复/);
  await expect(seat('cn')).toHaveAttribute('title', /Claude OAuth usage/);
  const refresh = page.getByRole('button', { name: '刷新额度', exact: true });
  await expect(refresh).toHaveAttribute('title', '刷新额度');
  await refresh.click();
  await expect(seat('cn').locator('.quota-values')).toContainText('91%');
  const text = await page.evaluate(() => QuotaCore.text(config.quotas, Date.now(), config.claudeSeats));
  expect(text).toContain('5h 91% ↻'); expect(text).toContain('7d 90% ↻');
  expect(text).not.toMatch(/已用 \d|剩余|5h 9%/);
  await seat('us').focus();
  await expect(seat('us').getByRole('tooltip')).toContainText('5h 已用尽 ↻');
  await screenshot('official-usage-dark-details');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await screenshot('official-usage-light-details');
});
test('usage colors contrast with both sidebar backgrounds by at least 4.5:1', async () => {
  for (const theme of ['dark', 'light']) {
    const contrast = await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      const luminance = color => {
        const rgb = color.match(/\d+/g).slice(0, 3).map(v => { const n = Number(v) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const bg = luminance(getComputedStyle(document.getElementById('colNav')).backgroundColor);
      return [...document.querySelectorAll('#quotaBar [data-seat-id], #quotaBar [data-seat-id] .quota-values > span')].map(e => {
        const fg = luminance(getComputedStyle(e).color);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
    }, theme);
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
test('three failed samples retain windows, resets and stale sample time across reload and collapsed sidebar', async () => {
  const before = await page.evaluate(() => config.quotas['Claude:cn'].sample.at);
  await page.evaluate(() => {
    const at = Date.now();
    for (let failures = 1; failures <= 3; failures++) QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: '~/.claude', at,
      failureOnly: true, failures, checkedAt: at, failure: '网络查询失败' });
    QuotaCore.observe(config.quotas, { ...QuotaCore.screen('Claude', '', ['5h 91% ↻02:50 · 7d 90% ↻10-07 03:00'], at), seatId: 'cn', configDir: '~/.claude' });
    flushConfig(); renderQuotaBar();
  });
  await page.reload();
  await expect(seat('cn')).toHaveAttribute('title', /连续 3 次.*数据已旧/s);
  expect(await page.evaluate(() => config.quotas['Claude:cn'].sample.at)).toBe(before);
  await expect(seat('cn')).toHaveAttribute('title', /^状态：正常 · 采样 [^\n]*（数据已旧）/);
  await expect(seat('cn').locator('.quota-values')).toHaveText('91%');
  await page.locator('#navCollapseBtn').click();
  await page.getByRole('button', { name: '订阅额度', exact: true }).click();
  await expect(page.locator('#quotaPop')).toBeVisible();
  const popupSeat = page.locator('#quotaPopList [data-seat-id="cn"]');
  await expect(popupSeat.locator('.quota-values')).toHaveText('91%');
  await expect(popupSeat).toHaveAttribute('title', /数据已旧/);
  await screenshot('official-usage-collapsed');
});
