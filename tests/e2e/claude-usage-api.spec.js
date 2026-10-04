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
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
const seat = id => page.locator(`#quotaBar [data-seat-id="${id}"]`);
const shots = process.env.AGENTDECK_QUOTA_SHOTS;
async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png') });
}
test('all Claude surfaces use remaining percentages and resets; icons refresh without dropping values', async () => {
  await expect(seat('cn').locator('.quota-label')).toHaveText(/5h 91% ↻\d\d:\d\d · 7d 90% ↻\d\d-\d\d \d\d:\d\d/);
  await expect(seat('us').locator('.quota-label')).toHaveText(/5h 已用尽 ↻\d\d:\d\d · 7d 48% ↻/);
  await expect(seat('cn')).toHaveAttribute('title', /Claude OAuth usage/);
  const refresh = page.getByRole('button', { name: '刷新额度', exact: true });
  await expect(refresh).toHaveAttribute('title', '刷新额度');
  await refresh.click();
  await expect(seat('cn').locator('.quota-label')).toContainText('91%');
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
      return [...document.querySelectorAll('#quotaBar [data-seat-id]')].map(e => {
        const fg = luminance(getComputedStyle(e).color);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
    }, theme);
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
test('failed sample persists original windows/time across reload; collapsed sidebar exposes quota details', async () => {
  const before = await page.evaluate(() => config.quotas['Claude:cn'].sample.at);
  await page.evaluate(() => {
    const at = Date.now();
    QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: 'cn', configDir: '~/.claude', at,
      failureOnly: true, failures: 1, checkedAt: at, failure: '网络查询失败' });
    flushConfig(); renderQuotaBar();
  });
  await page.reload();
  await expect(seat('cn')).toHaveAttribute('title', /保留上次数字/);
  expect(await page.evaluate(() => config.quotas['Claude:cn'].sample.at)).toBe(before);
  await page.locator('#navCollapseBtn').click();
  await page.getByRole('button', { name: '额度详情', exact: true }).click();
  await expect(page.locator('#quotaPop')).toBeVisible();
  await expect(seat('cn').locator('.quota-label')).toContainText('5h 91% ↻');
  await screenshot('official-usage-collapsed');
});
