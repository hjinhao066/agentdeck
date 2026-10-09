// Sidebar quota panel layout: 5h/7d named once, % + reset over a thin bar, ⊘ for used up,
// Status for numberless rows, brand icons, and every long explanation in the hover/focus details.
// All numbers and accounts are injected offline fixtures; the only agent is the stand-in.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let app, page, profile;
const row = (key) => page.locator(`#quotaBar [data-quota-key="${key}"]`);
const cell = (key, w) => row(key).locator(`[data-window="${w}"]`);
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-quota-panel-'));
  // Who is signed in behind each seat directory. They do not line up with the seat names on purpose:
  // the Max account sits in the CN directory, and nobody is signed in to US2.
  const home = path.join(profile, 'seats-home');
  for (const [dir, meta, account] of [['.claude-cn', '.claude-cn/.claude.json', { emailAddress: 'nhunhao088us@example.test', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' }],
    ['.claude', '.claude.json', { emailAddress: 'sam.h.second@example.test', organizationType: 'claude_pro', organizationRateLimitTier: 'default_claude_ai' }]]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');   // stand-in credential existence only
    fs.writeFileSync(path.join(home, meta), JSON.stringify({ oauthAccount: account }));
  }
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    claudeSeats: [{ id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude-cn' }, { id: 'us', name: '🇺🇸 US', configDir: '~/.claude' }],
    activeClaudeSeatId: 'us', mainSession: { colId: 'us-column', tasks: [], pending: [] },
    columns: [{ id: 'us-column', title: '队长', claudeSeatId: 'us', isMain: true, cmd: `node "${FAKE}" Claude us`, cwd: profile, width: 600, role: 'manual' }],
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('.column')).toHaveCount(1);
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

test('compact quota rows: header once, used-up / low / no-data cells, brand icons and full details on hover', async () => {
  await page.evaluate(async () => {
    const at = Date.now(), H = 3600000, D = 24 * H;
    // The numbers belong to the account signed in behind each seat, so they carry that account's own key.
    const infos = await ClaudeSeats.refresh(), key = (id) => infos.find((s) => s.id === id).accountKey;
    const seat = (id, dir, w5, w7) => ({ scope: 'claude', account: infos.find((s) => s.id === id).accountEmail, accountKey: key(id), configDir: dir,
      sample: { provider: 'Claude', scope: 'claude', seatId: id, at, accountBound: true, accountKey: key(id), configDir: dir, source: 'Claude 席位用量（/usage）', confidence: '高（按账号 ID 归属）',
        windows: [{ key: 'fiveHour', label: '5 小时', remaining: w5[0], used: 100 - w5[0], exhausted: w5[0] <= 0, resetAt: at + w5[1] }, { key: 'weekly', label: '每周', remaining: w7[0], used: 100 - w7[0], exhausted: w7[0] <= 0, resetAt: at + w7[1] }] } });
    config.quotas = {
      'Claude:cn': seat('cn', '~/.claude-cn', [0, 2 * H + 20 * 60000], [64, 3 * D]),
      'Claude:us': seat('us', '~/.claude', [88, 4 * H + 50 * 60000], [18, 5 * D]),
      Codex: { scope: QuotaCore.SCOPES.Codex, account: 'gp***@example.com', sample: { provider: 'Codex', scope: QuotaCore.SCOPES.Codex, at, source: 'Codex 本地 rate_limits', confidence: '高（服务端采样）', windows: [{ key: 'weekly', label: '每周', remaining: 10, used: 90, exhausted: false, resetAt: at + 5 * D }] } },
      Cursor: { scope: QuotaCore.SCOPES.Cursor, sample: { provider: 'Cursor', scope: QuotaCore.SCOPES.Cursor, at, source: '会话屏幕', confidence: '低（仅未见用尽报错）', windows: [] } },
      Antigravity: { scope: QuotaCore.SCOPES.Antigravity, account: 'ge***@example.com', blocked: { at, resetAt: at + H + 39 * 60000, resetText: 'in 1h 39m', source: '会话屏幕' }, sample: { provider: 'Antigravity', scope: QuotaCore.SCOPES.Antigravity, at, source: '会话屏幕', confidence: '高（CLI 显示）', windows: [] } },
    };
    renderQuotaBar();
  });
  // 1. "5h" / "7d" appear once, in the header; rows carry only values.
  await expect(page.locator('#quotaBar .quota-cols')).toHaveCount(1);
  // The header says what the numbers are: what is left, not what is used.
  await expect(page.locator('#quotaBar .quota-cols')).toHaveText('5h 剩余7d 剩余');
  for (const text of await page.locator('#quotaBar .quota-item .quota-values').allInnerTexts()) expect(text).not.toMatch(/5h|7d/);
  // Normal and low cells: % + reset time over a bar; ≤20% is yellow, ≤10% red.
  await expect(cell('Claude:us', '5h').locator('.quota-pct')).toHaveText('88%');
  await expect(cell('Claude:us', '5h').locator('.quota-reset')).toHaveText(/^\d\d:\d\d$/);
  await expect(cell('Claude:us', '7d')).toHaveAttribute('data-level', 'low');
  await expect(cell('Claude:us', '7d').locator('.quota-reset')).toHaveText(/^周[日一二三四五六]$/);
  await expect(cell('Codex', '7d')).toHaveAttribute('data-level', 'danger');
  await expect(cell('Codex', '7d').locator('.quota-pct')).toHaveText('10%');
  // 2. Used up: ⊘ + reset time in red, no 0%, and the whole row tinted.
  for (const key of ['Claude:cn', 'Antigravity']) {
    await expect(row(key)).toHaveAttribute('data-state', 'exhausted');
    await expect(cell(key, '5h')).toHaveAttribute('data-level', 'out');
    await expect(cell(key, '5h').locator('.quota-ban svg')).toBeVisible();
    await expect(cell(key, '5h').locator('.quota-pct')).toHaveCount(0);
    await expect(cell(key, '5h')).toHaveText(/^\d\d:\d\d$/);
    expect(await row(key).evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  }
  // Missing windows keep —; a healthy numberless provider shows its status.
  for (const [key, w] of [['Codex', '5h'], ['Cursor', '7d'], ['Antigravity', '7d']]) {
    await expect(cell(key, w)).toHaveText('—');
    await expect(cell(key, w).locator('.quota-meter')).toHaveAttribute('style', '--pct: 0%;');
  }
  await expect(cell('Cursor', '5h')).toHaveText('正常');
  // Claude rows go by the account signed in behind the seat (the part before the @), never by the
  // fixed CN / US / US2 or a flag. The Max gem follows the account, on the corner of the row's lead
  // icon so it takes no width from the name; the crown leads 队长's row.
  await expect(row('Claude:cn').locator('.seat-acct')).toHaveText('nhunhao088us');
  await expect(row('Claude:cn').locator('.quota-name')).toHaveText('nhunhao088us');
  await expect(row('Claude:cn').locator('.quota-icon .quota-plan svg')).toBeVisible();
  await expect(row('Claude:us').locator('.quota-plan')).toHaveCount(0);
  expect(await row('Claude:cn').locator('.quota-plan').evaluate((e) => { const r = e.getBoundingClientRect(), n = e.closest('.quota-item').querySelector('.seat-acct').getBoundingClientRect(); return r.right <= n.left + 0.5; })).toBe(true);   // never over the name
  await expect(row('Claude:us').locator('.quota-name')).toHaveText('sam.h.second');
  await expect(row('Claude:us2').locator('.quota-name')).toHaveText('未登录');
  await expect(page.locator('#quotaBar .quota-name')).not.toContainText([/🇨🇳|🇺🇸|CN|US/]);
  await expect(row('Claude:us').locator('.quota-icon.quota-captain svg')).toBeVisible();
  await expect(row('Claude:cn').locator('.quota-captain')).toHaveCount(0);
  await expect(row('Claude:cn').locator('.quota-icon > svg')).toBeVisible();   // its provider mark
  // A long name never pushes a value out: whatever the width, it is the name that gives way, from the left.
  for (const width of [200, 252, 320]) {
    await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); renderQuotaBar(); }, width);
    const fit = await page.locator('#quotaBar .quota-item').evaluateAll((els) => els.map((e) => {
      const label = e.querySelector('.quota-label').getBoundingClientRect(), first = e.querySelector('.quota-cell').getBoundingClientRect(), box = e.getBoundingClientRect();
      const acct = e.querySelector('.seat-acct'), plan = e.querySelector('.quota-plan');
      return { key: e.dataset.quotaKey, inside: e.scrollWidth <= e.clientWidth, order: label.right <= first.left + 0.5,
        values: [...e.querySelectorAll('.quota-pct, .quota-reset')].every((n) => n.getBoundingClientRect().right <= box.right + 0.5 && n.scrollWidth <= n.clientWidth),
        acct: acct ? Math.round(acct.getBoundingClientRect().width) : null, cut: acct ? acct.scrollWidth > acct.clientWidth : false,
        plan: plan ? plan.getBoundingClientRect().right <= label.right + 0.5 : true, dir: acct ? getComputedStyle(acct).direction : '' };
    }));
    for (const r of fit) expect(r.inside && r.order && r.values && r.plan, JSON.stringify({ width, r })).toBe(true);
    const paid = fit.find((r) => r.key === 'Claude:cn');
    expect(paid.dir).toBe('rtl');                       // cut from the left: the end of the name stays
    expect(paid.acct, JSON.stringify({ width, paid })).toBeGreaterThanOrEqual(36);   // room for the last letters of the name
    // At the default width and wider, a twelve-letter account name is whole, Max gem and all.
    if (width >= 252) {
      expect(fit.some((r) => r.cut), JSON.stringify({ width, fit })).toBe(false);
      expect(await row('Claude:cn').locator('.seat-acct').evaluate((e) => e.firstElementChild.getBoundingClientRect().width <= e.getBoundingClientRect().width + 0.01), `whole at ${width}`).toBe(true);
    }
  }
  await page.evaluate(() => { config.navWidth = 252; applyNavWidth(); renderQuotaBar(); });
  for (const [key, name] of [['Codex', 'ChatGPT'], ['Cursor', 'Grok 4.7'], ['Antigravity', 'Gemini']]) await expect(row(key).locator('.quota-name')).toHaveText(name);
  // 4. Columns line up under the header, and 5h starts right after the widest name.
  const geo = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#quotaBar .quota-item')];
    const x = (e) => Math.round(e.getBoundingClientRect().left);
    return { head: [...document.querySelectorAll('#quotaBar .quota-col')].map(x),
      cells: ['5h', '7d'].map((w) => [...new Set(items.map((i) => x(i.querySelector(`[data-window="${w}"]`))))]),
      gap: Math.round(Math.min(...items.map((i) => i.querySelector('[data-window="5h"]').getBoundingClientRect().left)) - Math.max(...items.map((i) => i.querySelector('.quota-label').getBoundingClientRect().right))),
      fits: items.every((i) => i.scrollWidth <= i.clientWidth), heights: [...new Set(items.map((i) => i.getBoundingClientRect().height))] };
  });
  expect(geo.cells.map((c) => c.length)).toEqual([1, 1]);
  expect(geo.head).toEqual(geo.cells.map((c) => c[0]));
  expect(geo.gap).toBeLessThanOrEqual(1);
  expect(geo.fits).toBe(true);
  expect(geo.heights).toEqual([30]);
  // 6. Brand colours: Claude orange, ChatGPT green, Gemini gradient, Grok neutral — in both themes.
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    const colors = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#quotaBar .quota-item')].map((i) => [i.dataset.quotaKey, getComputedStyle(i.querySelector('.quota-icon')).color])));
    const rgb = (c) => c.match(/\d+/g).map(Number);
    const [cr, cg, cb] = rgb(colors['Claude:cn']), [gr, gg, gb] = rgb(colors.Codex);
    expect(cr > cg && cg > cb, JSON.stringify({ theme, colors })).toBe(true);
    expect(gg > gr && gg > gb, JSON.stringify({ theme, colors })).toBe(true);
    expect(await row('Antigravity').locator('.quota-icon path').evaluate((e) => getComputedStyle(e).fill)).toContain('quotaGeminiGradient');
    expect(colors.Cursor).toBe(await row('Cursor').evaluate((e) => getComputedStyle(e).color));
  }
  await page.evaluate(() => applyTheme('dark'));
  // 7. Refresh stays an icon button with a tooltip and an accessible name.
  const refresh = page.locator('#quotaRefresh');
  await expect(refresh).toHaveAttribute('aria-label', '刷新额度');
  await expect(refresh).toHaveAttribute('title', '刷新额度');
  await expect(refresh).toHaveText('');
  expect(await refresh.evaluate((e) => { const r = e.getBoundingClientRect(); return r.width >= 24 && r.height >= 24; })).toBe(true);
  // 3. Hover / keyboard focus shows the full explanation; the row is labelled and described by it.
  const tip = row('Claude:cn').getByRole('tooltip');
  await expect(row('Claude:cn')).toHaveAttribute('aria-describedby', 'quota-tip-Claude-cn');
  await expect(row('Claude:cn')).toHaveAttribute('aria-label', /^nhunhao088us Max 20x：已用尽，.*5 小时剩余 0%.*每周剩余 64%/);
  await row('Claude:cn').focus();
  await expect(tip).toBeVisible();
  // The detail carries what the row leaves out: the whole address, the plan, the seat code and its directory.
  await expect(tip.locator('.qt-name')).toHaveText('nhunhao088us');
  for (const text of ['账号', 'nhunhao088us@example.test', '套餐', 'Max 20x', '席位', 'cn', '目录', '~/.claude-cn', '5 小时', '已用尽', '每周', '剩余 64%', '来源', 'Claude 席位用量（/usage）', '采样', '可信度', '高（按账号 ID 归属）']) await expect(tip).toContainText(text);
  await expect(tip).toContainText(/每周剩余 64%\d\d-\d\d 周[日一二三四五六] \d\d:\d\d（3 天后）重置/);
  await expect(row('Antigravity').getByRole('tooltip', { includeHidden: true })).toContainText(/已用尽，预计 \d\d:\d\d（1 小时 39 分后）恢复/);
  await expect(row('Cursor').getByRole('tooltip', { includeHidden: true })).toContainText('未见用尽，此来源不提供百分比');
  await page.evaluate(() => document.activeElement?.blur());

  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.mouse.move(900, 300);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await page.waitForTimeout(150);
      await page.locator('#navQuota').screenshot({ path: path.join(shots, `after-panel-${theme}.png`) });
      await page.screenshot({ path: path.join(shots, `after-window-${theme}.png`) });
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await row('Claude:cn').hover();
      await expect(tip).toBeVisible();
      await page.screenshot({ path: path.join(shots, `after-tooltip-${theme}.png`) });
      await page.mouse.move(900, 300);
    }
    await page.evaluate(() => applyTheme('dark'));
  }
  // Narrowest sidebar: the reset times give way, the percentages and bars stay, nothing clips.
  await page.evaluate(() => { config.navWidth = 200; applyNavWidth(); });
  await expect(cell('Claude:us', '5h').locator('.quota-reset')).toBeHidden();
  await expect(cell('Claude:us', '7d').locator('.quota-pct')).toBeVisible();
  expect(await page.locator('#quotaBar .quota-item').evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth))).toBe(true);
  await page.evaluate(() => { config.navWidth = 252; applyNavWidth(); });
  await expect(cell('Claude:us', '5h').locator('.quota-reset')).toBeVisible();
});

test('sidebar bottom row: settings is a standard gear icon button sized like its neighbours', async () => {
  const settings = page.locator('#settingsBtn');
  await expect(settings).toHaveAttribute('aria-label', '设置');
  await expect(settings).toHaveAttribute('title', '设置');
  // A gear: toothed rim path plus a hub circle, same stroke and box as the theme button.
  await expect(settings.locator('svg path')).toHaveCount(1);
  await expect(settings.locator('svg circle')).toHaveAttribute('r', '3');
  expect(await settings.locator('svg path').getAttribute('d')).toMatch(/^M12\.22 2h-\.44/);
  const box = (sel) => page.locator(sel).evaluate((e) => { const s = e.querySelector('svg'); const r = s.getBoundingClientRect(); return [e.getBoundingClientRect().width, r.width, r.height, s.getAttribute('stroke-width')]; });
  expect(await box('#settingsBtn')).toEqual(await box('#themeBtn'));
  const shots = process.env.AGENTDECK_QUOTA_SHOTS;
  if (shots) {
    await page.mouse.move(900, 300);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await page.waitForTimeout(150);
      await page.locator('#navBottom').screenshot({ path: path.join(shots, `after-bottom-buttons-${theme}.png`) });
    }
    await page.evaluate(() => applyTheme('dark'));
  }
});


test('numberless quota rows keep status words distinct without changing numeric cells or row height', async () => {
  for (const provider of ['Cursor', 'Codex']) {
    for (const [kind, text] of [['normal', '正常'], ['exhausted', '已用尽'], ['unknown', '未知'], ['expired', '过期']]) {
      await page.evaluate(({ provider, kind }) => {
        const at = Date.now();
        const entry = { scope: QuotaCore.SCOPES[provider], sample: { provider, scope: QuotaCore.SCOPES[provider], at: kind === 'expired' ? at - QuotaCore.FRESH_MS - 1000 : at, windows: [], source: '离线回归样本' } };
        if (kind === 'exhausted') entry.blocked = { at, source: '离线回归样本' };
        config.quotas = kind === 'unknown' ? {} : { [provider]: entry };
        renderQuotaBar();
      }, { provider, kind });
      await expect(cell(provider, '5h').locator('.quota-none')).toHaveText(text);
      await expect(cell(provider, '7d')).toHaveText('—');
      await expect(cell(provider, '5h').locator('.quota-meter')).toHaveAttribute('style', '--pct: 0%;');
      expect(await row(provider).evaluate((e) => e.getBoundingClientRect().height)).toBe(30);
      await expect(row(provider).getByRole('tooltip', { includeHidden: true }).locator('.qt-meta')).toHaveCount(1);
    }
  }
  await page.evaluate(() => {
    const at = Date.now();
    config.quotas = {
      Cursor: { scope: QuotaCore.SCOPES.Cursor, sample: { provider: 'Cursor', scope: QuotaCore.SCOPES.Cursor, at, windows: [] } },
      Codex: { scope: QuotaCore.SCOPES.Codex, sample: { provider: 'Codex', scope: QuotaCore.SCOPES.Codex, at, windows: [{ key: 'weekly', label: '每周', remaining: 37, exhausted: false, resetAt: at + 86400000 }] } },
    };
    renderQuotaBar();
  });
  await expect(cell('Codex', '5h')).toHaveText('—');
  await expect(cell('Codex', '7d').locator('.quota-pct')).toHaveText('37%');
  await expect(cell('Cursor', '5h')).toHaveText('正常');
  await page.evaluate(() => { config.navWidth = 200; applyNavWidth(); });
  const compact = await cell('Cursor', '5h').locator('.quota-none').evaluate((e) => {
    const s = getComputedStyle(e); return [s.whiteSpace, s.textOverflow, s.overflow];
  });
  expect(compact).toEqual(['nowrap', 'ellipsis', 'hidden']);
  expect(await row('Cursor').evaluate((e) => [e.getBoundingClientRect().height, e.scrollWidth <= e.clientWidth])).toEqual([30, true]);
  await page.evaluate(() => { config.navWidth = 252; applyNavWidth(); document.activeElement?.blur(); });
});
