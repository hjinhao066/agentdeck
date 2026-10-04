const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let application, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-e2e-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'default', name: 'Claude', configDir: '~/.claude' }],
    columns: ['Claude', 'Codex', 'Cursor', 'Antigravity'].map((p) => ({ id: `quota-${p}`, taskId: `task-${p}`, title: `${p} stand-in`, cmd: `node "${FAKE}" ${p}`, cwd: profile, width: 600, role: 'manual' })),
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(4);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
const badge = (provider) => page.locator(`#quotaBar [data-provider="${provider}"]${provider === 'Claude' ? '[data-seat-id="cn"]' : ''}`);

test('passive live screens show remaining quota, provider icons and accessible details', async () => {
  await expect(badge('Claude').locator('.quota-label')).toHaveText('5h 19% · 7d 91%', { timeout: 20000 });
  await expect(page.locator('#quotaBar [data-seat-id="us"] .quota-label')).toHaveText('未登录/无数据');
  await expect(badge('Codex').locator('.quota-label')).toHaveText('8%');
  for (const provider of ['Cursor', 'Antigravity']) await expect(badge(provider).locator('.quota-label')).toHaveText('正常');
  await expect(badge('Claude')).toHaveAttribute('data-state', 'warning');
  await expect(badge('Codex')).toHaveAttribute('data-state', 'danger');
  await expect(badge('Claude')).toHaveAttribute('aria-label', /5 小时剩余 19%；重置/);
  await expect(badge('Claude')).toHaveAttribute('title', /来源：会话屏幕/);
  await expect(badge('Claude').locator('svg')).toBeVisible();
  await badge('Claude').focus();
  await expect(badge('Claude').getByRole('tooltip')).toBeVisible();
  await expect(badge('Claude').getByRole('tooltip')).toContainText('每周剩余 91%');
  await expect(badge('Cursor').locator('.quota-name')).toHaveText('Grok 4.7');
  await expect(badge('Antigravity').locator('.quota-name')).toHaveText('Gemini');
  await expect(badge('Claude')).toHaveAttribute('title', /模型：claude-opus-5-5-high；账号：未识别/);
  // The isolated profile is barred from reading the user's real quota caches.
  expect(await page.evaluate(() => window.deck.quotaLocal())).toEqual([]);
  // Quota tracks Grok on Cursor, while model badges already choose that family.
  for (const [provider, family] of [['Codex', 'codex'], ['Cursor', 'grok']]) {
    const svg = badge(provider).locator('.quota-icon svg');
    await expect(svg).toHaveAttribute('fill', 'currentColor');
    await expect(svg).toHaveAttribute('width', '13');
    await expect(svg).toHaveAttribute('height', '13');
    await expect(svg.locator('path')).toHaveCount(provider === 'Codex' ? 1 : 2);
    const sidebar = page.locator(`.colnav-item[data-col-id="quota-${provider}"] [data-icon-provider="${family}"] svg`);
    await expect(sidebar).toBeVisible();
    expect(await svg.evaluate((el) => el.outerHTML)).toBe(await sidebar.evaluate((el) => el.outerHTML));
    expect(await svg.evaluate((el) => getComputedStyle(el).fill)).toBe(await badge(provider).evaluate((el) => getComputedStyle(el).color));
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(500, 400);
  if (process.env.AGENTDECK_ICON_SHOT) await page.locator('#quotaBar').screenshot({ path: process.env.AGENTDECK_ICON_SHOT });
});

test('Claude-model limits never exhaust Gemini or Grok 4.7; screenshots use simulated data', async () => {
  for (const p of ['Cursor', 'Antigravity']) {
    await page.evaluate((p) => window.deck.ptyInput(`quota-${p}`, 'claude-exhausted\r'), p);
    await expect.poll(() => page.evaluate((p) => terms.get(`quota-${p}`).lastScreen, p)).toContain('Model: claude-opus-5-5-high');
    await page.waitForTimeout(1800);
    await expect(badge(p).locator('.quota-label')).toHaveText('正常');
    await page.evaluate((p) => window.deck.ptyInput(`quota-${p}`, 'normal\r'), p);
    await expect.poll(() => page.evaluate((p) => terms.get(`quota-${p}`).lastScreen, p)).toContain(p === 'Cursor' ? 'Model: grok-4.7' : 'Model: gemini-3.8');
  }
  await page.evaluate(() => document.activeElement.blur());
  await expect.poll(() => page.evaluate(() => columns.find(c => c.id === 'quota-Antigravity').agentModel)).toBe('gemini-3.8-flash-high');
  await page.evaluate(() => {
    const at = Date.now();
    QuotaCore.observe(config.quotas, { ...QuotaCore.cacheAntigravity({ model: 'gemini-3.8-flash-high', quota: {
      'gemini-5h': { remaining_fraction: 0.75, reset_time: new Date(at + 7200000).toISOString() },
      'gemini-weekly': { remaining_fraction: 0.58, reset_time: new Date(at + 86400000).toISOString() },
      '3p-5h': { remaining_fraction: 0 }, '3p-weekly': { remaining_fraction: 0 },
    } }, at), account: 'de***@example.com', accountKey: 'demo-gemini' });
    for (const provider of ['Claude', 'Codex', 'Cursor']) QuotaCore.observe(config.quotas, { provider, scope: QuotaCore.SCOPES[provider], at, identityOnly: true, account: 'de***@example.com', accountKey: 'demo-' + provider });
    renderQuotaBar();
  });
  await expect(badge('Antigravity').locator('.quota-label')).toHaveText('58%');
  await expect(badge('Antigravity')).toHaveAttribute('title', /Gemini 5 小时剩余 75%/);
  await badge('Antigravity').hover();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-gemini-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-gemini-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    fs.writeFileSync(path.join(shots, 'README.md'), '# Screenshot data\n\nAll quota numbers and masked accounts in these screenshots are simulated offline fixtures, not this Mac’s live usage. Gemini is 75% (5-hour) / 58% (weekly) while agy Claude pools are exhausted; Cursor observes Grok 4.7 only. quota-dark/light show simulated exhaustion afterward.\n');
  }
});

test('Cursor and agy errors latch provider-wide through normal redraw and reload; recovery time is stable', async () => {
  for (const p of ['Cursor', 'Antigravity']) await page.evaluate((p) => window.deck.ptyInput(`quota-${p}`, 'exhausted\r'), p);
  for (const p of ['Cursor', 'Antigravity']) {
    await expect(badge(p).locator('.quota-label')).toHaveText('已用尽');
    await expect(badge(p)).toHaveAttribute('title', /恢复.*来源：会话屏幕/s);
    await expect.poll(() => page.evaluate((p) => terms.get(`quota-${p}`).state, p)).toBe('quota');
  }
  const resetAt = await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt);
  await page.evaluate(() => window.deck.ptyInput('quota-Antigravity', 'exhausted-redraw\r'));
  await expect.poll(() => page.evaluate(() => terms.get('quota-Antigravity').lastScreen)).toContain('unrelated redraw');
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt)).toBe(resetAt);
  await page.evaluate(() => window.deck.ptyInput('quota-Antigravity', 'normal\r'));
  await expect.poll(() => page.evaluate(() => terms.get('quota-Antigravity').lastScreen)).not.toContain('Individual quota reached');
  await expect(badge('Antigravity').locator('.quota-label')).toHaveText('已用尽');
  await page.evaluate(() => flushConfig());
  await page.reload();
  await expect(badge('Antigravity').locator('.quota-label')).toHaveText('已用尽');
  expect(await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt)).toBe(resetAt);
});

test('Captain quota CLI returns both Claude seats and changes no tasks, receipts or cached board responses', async () => {
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeVisible();
  await page.locator('#mdCmd').fill('');
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  const id = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyForeground(id), id)).toMatch(/^(?:zsh|bash|sh|powershell|pwsh|cmd)$/i);
  const before = await page.evaluate(() => JSON.stringify([config.mainSession.tasks, config.mainSession.pending, config.boardResponses]));
  const output = path.join(profile, 'quota.txt');
  // Node writes UTF-8 on both platforms; PowerShell 5 redirection writes UTF-16.
  const command = `node -e "require('fs').writeFileSync(process.argv[1],require('child_process').execFileSync(process.execPath,[process.env.AGENTDECK_BOARD_CLI,'quota'],{encoding:'utf8'}))" "${output}"`;
  await page.evaluate(({ id, command }) => window.deck.ptyInput(id, command + '\r'), { id, command });
  await expect.poll(() => fs.existsSync(output) && fs.readFileSync(output, 'utf8')).toMatch(/Claude \/ 🇨🇳 CN：19%[^\n]*\nClaude \/ 🇺🇸 US：未登录\/无数据[^\n]*\nCodex \/ ChatGPT：8%[^\n]*\nCursor \/ Grok 4.7：已用尽[^\n]*\nAntigravity \/ Gemini：已用尽/);
  expect(fs.readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(5);
  expect(await page.evaluate(() => JSON.stringify([config.mainSession.tasks, config.mainSession.pending, config.boardResponses]))).toBe(before);
  // A worker doesn't have the Captain capability, even for this read-only command.
  const rejected = await page.evaluate(async () => {
    try { await MainSession.handle({ action: 'main-quota' }, columns.find((c) => c.id === 'quota-Cursor')); return ''; }
    catch (e) { return e.message; }
  });
  expect(rejected).toContain('只有队长');
  await badge('Antigravity').hover();
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'quota-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(shots, 'quota-light.png') });
  }
});
