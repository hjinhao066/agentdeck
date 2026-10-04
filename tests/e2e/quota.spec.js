const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const M = require('../../claude-seats-main');
const FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let application, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-e2e-'));
  const home = path.join(profile, 'seats-home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test' } }));
  M.writeUsage({ id: 'cn', configDir: '~/.claude' }, home, { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 19, resetText: 'in 1h' }, { key: 'weekly', remaining: 91, resetText: 'in 4d' }] });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'cn', name: 'CN', configDir: '~/.claude' }, { id: 'us', name: 'US', configDir: '~/.claude-us' }],
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
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
const badge = (provider) => page.locator(`#quotaBar [data-provider="${provider}"]${provider === 'Claude' ? '[data-seat-id="cn"]' : ''}`);

test('passive live screens show remaining quota, provider icons and accessible details', { tag: '@smoke' }, async () => {
  await expect(badge('Claude').locator('[data-window="5h"] .quota-pct')).toHaveText('19%', { timeout: 20000 });

  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('data-state', 'unknown');
  await expect(page.locator('#quotaBar [data-seat-id="us"] .quota-values')).toHaveText('——');
  await expect(badge('Codex').locator('.quota-values')).toContainText('8%');
  for (const provider of ['Cursor', 'Antigravity']) await expect(badge(provider)).toHaveAttribute('data-state', 'normal');
  // No number: both cells read — over an empty bar; 正常 moves into the details.
  for (const provider of ['Cursor', 'Antigravity']) {
    await expect(badge(provider).locator('.quota-values')).toHaveText('——');
    await expect(badge(provider).getByRole('tooltip', { includeHidden: true })).toContainText('未见用尽');
  }
  // Codex that reports only the weekly window shows that number, marked as weekly.
  await page.evaluate(() => {
    window.codexQuotaBackup = JSON.stringify(config.quotas.Codex);
    const entry = JSON.parse(window.codexQuotaBackup), at = Date.now();
    entry.sample = { ...entry.sample, at, windows: [{ key: 'weekly', label: '每周', used: 85, remaining: 15, exhausted: false, resetAt: at + 86400000, resetText: '' }] };
    config.quotas.Codex = entry; renderQuotaBar();
  });
  await expect(badge('Codex').locator('[data-window="7d"] .quota-pct')).toHaveText('15%');
  await expect(badge('Codex').locator('[data-window="5h"] .quota-none')).toHaveText('—');
  await expect(badge('Codex').locator('.quota-values')).not.toHaveText(/^[—–-]$/);
  expect(await page.evaluate(() => QuotaCore.summary(config.quotas, 'Codex', Date.now()).shortText)).toBe('周 15%');
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(800, 400);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => applyTheme(theme), theme);
      await page.locator('#navQuota').screenshot({ path: path.join(shots, `quota-weekly-grok-${theme}.png`) });
      await page.screenshot({ path: path.join(shots, `quota-window-${theme}.png`) });
    }
    await page.evaluate(() => applyTheme('dark'));
  }
  await page.evaluate(() => { config.quotas.Codex = JSON.parse(window.codexQuotaBackup); renderQuotaBar(); });
  await expect(badge('Codex').locator('.quota-values')).toContainText('8%');
  await expect(badge('Claude')).toHaveAttribute('data-state', 'warning');
  await expect(badge('Codex')).toHaveAttribute('data-state', 'danger');
  await expect(badge('Claude')).toHaveAttribute('aria-label', /快用完，5 小时剩余 19%[^，]*，每周剩余 91%/);
  await expect(badge('Claude')).toHaveAttribute('data-detail', /^状态：快用完 · 采样 \d\d:\d\d\n/);
  await expect(badge('Claude')).toHaveAttribute('data-detail', /来源：(Claude 席位用量（\/usage）；高（按账号 ID 归属）|Claude 席位本地用量缓存；高（原生用量及账号归属已验证）)/);

  const binding = await page.evaluate(async () => {
    const sample = config.quotas['Claude:cn'].sample;
    return { bound: sample.accountBound, key: sample.accountKey, expected: (await window.deck.claudeSeatUsage('cn')).accountKey };
  });
  expect(binding.bound).toBe(true);
  expect(binding.key).toBeTruthy();
  expect(binding.key).toBe(binding.expected);

  // Every account stays on one compact row: no wrapping, no clipped name or value.
  for (const box of await page.locator('#quotaBar .quota-item').evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().height, e.scrollWidth <= e.clientWidth]))) expect(box).toEqual([30, true]);
  // Default width shows each window's reset time; the narrowest sidebar keeps just the two percentages.
  const fits = () => page.locator('#quotaBar .quota-item').evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth && e.querySelector('.quota-cell').getBoundingClientRect().left >= e.querySelector('.quota-name').getBoundingClientRect().right));
  await expect(badge('Claude').locator('[data-window="5h"] .quota-reset')).toBeVisible();
  await expect(badge('Claude').locator('[data-window="7d"] .quota-pct')).toHaveText('91%');
  await page.evaluate(() => { config.navWidth = 200; applyNavWidth(); });
  await expect(badge('Claude').locator('[data-window="5h"] .quota-reset')).toBeHidden();
  await expect(badge('Claude').locator('[data-window="5h"] .quota-pct')).toBeVisible();
  await expect(badge('Claude').locator('[data-window="7d"] .quota-pct')).toBeVisible();
  expect(await fits()).toBe(true);
  await page.evaluate(() => { config.navWidth = 252; applyNavWidth(); });
  await expect(badge('Claude').locator('[data-window="5h"] .quota-reset')).toBeVisible();
  expect(await fits()).toBe(true);
  await expect(badge('Claude').locator('svg')).toBeVisible();
  await badge('Claude').focus();
  await expect(badge('Claude').getByRole('tooltip')).toBeVisible();
  await expect(badge('Claude').getByRole('tooltip')).toContainText('剩余 91%');
  // One tooltip only: no native title duplicating it; source and confidence yes, config dir / model no.
  await expect(badge('Claude')).not.toHaveAttribute('title');
  await expect(badge('Claude').getByRole('tooltip')).toContainText(/来源.*可信度/);
  await expect(badge('Claude').getByRole('tooltip')).not.toContainText(/配置目录|模型/);
  await expect(badge('Cursor')).toHaveAttribute('aria-label', /^Grok 4\.7：/);
  await expect(badge('Antigravity')).toHaveAttribute('aria-label', /^Gemini：/);
  await expect(badge('Claude').locator('.quota-name')).toHaveText('🇨🇳');
  await expect(badge('Claude')).toHaveAttribute('data-detail', /模型：claude-opus-5-5-high；账号：cn?\*\*\*@example.test/);
  // The isolated profile is barred from reading the user's real quota caches.
  expect((await page.evaluate(() => window.deck.quotaLocal())).filter(q => q.windows).map(q => q.seatId)).toEqual(['cn']);
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
    expect(await svg.evaluate((el) => getComputedStyle(el).fill)).toBe(await badge(provider).locator('.quota-icon').evaluate((el) => getComputedStyle(el).color));
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
    await expect(badge(p)).toHaveAttribute('data-state', 'normal');
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
  await expect(badge('Antigravity').locator('[data-window="5h"] .quota-pct')).toHaveText('75%');
  await expect(badge('Antigravity')).toHaveAttribute('data-detail', /Gemini 5 小时剩余 75%/);
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
    await expect(badge(p)).toHaveAttribute('data-state', 'exhausted');
    await expect(badge(p).locator('.quota-values [data-level="out"] .quota-reset')).toHaveText(/\d/);
    await expect(badge(p)).toHaveAttribute('data-detail', /恢复.*来源：会话屏幕/s);
    await expect.poll(() => page.evaluate((p) => terms.get(`quota-${p}`).state, p)).toBe('quota');
  }
  const resetAt = await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt);
  await page.evaluate(() => window.deck.ptyInput('quota-Antigravity', 'exhausted-redraw\r'));
  await expect.poll(() => page.evaluate(() => terms.get('quota-Antigravity').lastScreen)).toContain('unrelated redraw');
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt)).toBe(resetAt);
  await page.evaluate(() => window.deck.ptyInput('quota-Antigravity', 'normal\r'));
  await expect.poll(() => page.evaluate(() => terms.get('quota-Antigravity').lastScreen)).not.toContain('Individual quota reached');
  await expect(badge('Antigravity')).toHaveAttribute('data-state', 'exhausted');
  await page.evaluate(() => flushConfig());
  await page.reload();
  await expect(badge('Antigravity')).toHaveAttribute('data-state', 'exhausted');
  expect(await page.evaluate(() => config.quotas.Antigravity.blocked.resetAt)).toBe(resetAt);
});

test('Captain quota CLI returns both Claude seats and changes no tasks, receipts or cached board responses', async () => {
  await page.locator('.nav-row[data-nav="captain"]').click();
  await expect(page.locator('#mainDialog')).toBeVisible();
  await page.locator('#mdCmd').fill('');
  await page.locator('#mdCwd').fill(profile);
  await page.locator('#mdCreate').click();
  const id = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), id)).toBe(true);
  await page.evaluate(() => {
    window.quotaRequestIds = [];
    window.deck.onBoardCommand((m) => { if (m.action === 'main-quota') window.quotaRequestIds.push(m.id); });
  });
  const before = await page.evaluate(() => JSON.parse(JSON.stringify([config.mainSession.tasks, config.mainSession.pending, config.boardResponses])));
  const output = path.join(profile, 'quota.txt');
  // Node writes UTF-8 on both platforms; PowerShell 5 redirection writes UTF-16.
  // ConPTY's process property is the terminal name, not the foreground shell.
  // The output file proves that the real shell ran the CLI with its capability.
  const script = path.join(profile, 'read-quota.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(process.argv[2],require('child_process').execFileSync(process.execPath,[process.env.AGENTDECK_BOARD_CLI,'quota'],{encoding:'utf8'}));`);
  const command = `node "${script}" "${output}"`;
  await page.evaluate(({ id, command }) => window.deck.ptyInput(id, command + '\r'), { id, command });
  await expect.poll(() => fs.existsSync(output) && fs.readFileSync(output, 'utf8')).toMatch(/Claude \/ 🇨🇳 CN：19%[^\n]*\nClaude \/ 🇺🇸 US：未知[^\n]*\nCodex \/ ChatGPT：8%[^\n]*\nCursor \/ Grok 4.7：已用尽[^\n]*\nAntigravity \/ Gemini：已用尽/);
  expect(fs.readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(5);
  const after = await page.evaluate(() => [config.mainSession.tasks, config.mainSession.pending, config.boardResponses]);
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  // Other startup/exit acknowledgements may arrive concurrently. The quota
  // request itself never adds a cache entry or changes an existing response.
  for (const [key, value] of Object.entries(before[2])) expect(after[2][key]).toEqual(value);
  const quotaIds = await page.evaluate(() => window.quotaRequestIds);
  expect(quotaIds).toHaveLength(1);
  for (const requestId of quotaIds) expect(after[2]).not.toHaveProperty(requestId);
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
