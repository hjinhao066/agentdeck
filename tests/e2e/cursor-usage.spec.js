const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('../../quota-core');
const ROOT = path.resolve(__dirname, '../..');
let app, page, profile;

test.describe.configure({ mode: 'serial', timeout: 120000 });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-cursor-usage-'));
  const at = Date.parse('2026-10-03T18:00:00Z');
  const resetAt = Date.parse('2026-11-01T07:31:34Z');
  const quotas = {};
  Q.observe(quotas, {
    provider: 'Cursor', scope: 'grok-4.7', official: true, at,
    source: '官方用量接口', confidence: '高（官方采样）',
    windows: [
      { key: 'cursorModels', label: 'Grok', used: 17, remaining: 83, exhausted: false, resetAt, resetText: new Date(resetAt).toISOString() },
      { key: 'otherModels', label: '其他', used: 100, remaining: 0, exhausted: true, resetAt, resetText: new Date(resetAt).toISOString() },
    ],
  }, at);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', quotas,
    columns: [{ id: 'cursor-usage-preview', title: '额度预览', cmd: '', cwd: profile, width: 640, role: 'manual' }],
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env,
    timeout: 90000,
  });
  page = await app.firstWindow({ timeout: 90000 });
  await expect(page.locator('#quotaBar [data-provider="Cursor"]')).toBeVisible();
});
test.afterAll(async () => {
  if (app) await app.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const row = () => page.locator('#quotaBar [data-provider="Cursor"]');

test('Cursor row shows both pools as remaining, marks the empty pool, and quota text includes the sample time', async () => {
  await expect(row().locator('.quota-label')).toHaveText(/Grok 83% · 其他 0% ↻\d\d-\d\d/);
  await expect(row().locator('.quota-pool.is-exhausted')).toHaveText('其他 0%');
  await expect(row().locator('.quota-pool').first()).not.toHaveClass(/is-exhausted/);
  await expect(row()).toHaveAttribute('title', /官方用量接口/);
  await expect(row()).toHaveAttribute('title', /采样/);
  const text = await page.evaluate(() => QuotaCore.text(config.quotas, Date.parse('2026-10-03T18:05:00Z')));
  expect(text).toContain('Grok 83%');
  expect(text).toContain('其他 0%');
  expect(text).toMatch(/采样/);
  expect(text).not.toMatch(/已用 \d|还剩/);
  const refresh = page.locator('#quotaRefresh');
  await expect(refresh).toHaveAttribute('aria-label', '刷新额度');
  await expect(refresh).toHaveAttribute('title', '刷新额度');
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await refresh.click();
  await expect(row().locator('.quota-label')).toContainText('Grok 83%');
});

test('a failed refresh keeps the last percentages and the original sample time', async () => {
  const before = await page.evaluate(() => config.quotas.Cursor.sample.at);
  await page.evaluate(() => {
    const at = Date.now();
    QuotaCore.observe(config.quotas, {
      provider: 'Cursor', scope: 'grok-4.7', at, failureOnly: true, official: true,
      failures: 1, checkedAt: at, failure: '网络查询失败',
    });
    flushConfig();
    renderQuotaBar();
  });
  await expect(row().locator('.quota-label')).toHaveText(/Grok 83% · 其他 0% ↻/);
  await expect(row().locator('.quota-sampled')).toHaveText(/采样 \d\d:\d\d/);
  await expect(row()).toHaveAttribute('title', /查询失败：网络查询失败/);
  await expect(row()).toHaveAttribute('title', /保留上次数字/);
  expect(await page.evaluate(() => config.quotas.Cursor.sample.at)).toBe(before);
  await page.reload();
  await expect(row().locator('.quota-label')).toHaveText(/Grok 83% · 其他 0% ↻/);
  expect(await page.evaluate(() => config.quotas.Cursor.sample.at)).toBe(before);
});

test('new refuses a Cursor claude model when Other Models is empty and still allows Grok', async () => {
  const denied = await page.evaluate(async () => {
    const col = columns[0];
    col.isMain = true;
    config.mainSession = { colId: col.id, tasks: [], pending: [], inflight: [], waitlist: [] };
    try {
      await MainSession.handle({
        action: 'main-new', id: 'cursor-pool-block', title: '不应启动', task: '不要启动真实代理',
        command: 'cursor-agent --force --model claude-opus-5-5-high',
      }, col);
      return 'opened';
    } catch (error) { return error.message; }
  });
  expect(denied).toContain('该池已用尽');
  await expect(page.locator('.column')).toHaveCount(1);
  const allowed = await page.evaluate(() => QuotaCore.cursorLaunchBlock('cursor-agent --force --model grok-4.7-high-fast', config.quotas));
  expect(allowed).toBe('');
});
