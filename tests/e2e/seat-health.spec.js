// A seat that cannot work must not look fine. Seven seats, one per state, behind isolated seat
// directories (stand-in credentials; one is the 128 bytes 2.0.2's renewal left behind): the sidebar
// row, 队长's `quota`, the single-computer phone page and the phone hub all take one colour from
// QuotaCore.seatHealth. Fine stays as it was; yellow for old numbers or a failed read; red for a
// damaged or expired login, a signed-out seat and a used-up one. A mark beside the name (triangle /
// circle) tells yellow from red without colour, and every colour is checked for contrast in both themes.
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const STAND_IN_CREDENTIAL = require('./fixtures/stand-in-credential');
const { startHub } = require('../fixtures/hub-proxy');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');

// id, directory, account behind it, stored login, expected [level, kind, label]
const TRUNCATED = JSON.stringify({ claudeAiOauth: { accessToken: 'stand-in-' + 'x'.repeat(200), refreshToken: 'stand-in' } }).slice(0, 128);
const EXPIRED = JSON.stringify({ claudeAiOauth: { accessToken: 'stand-in', expiresAt: Date.now() - 3600_000 } });
const SEATS = [
  ['cn', '~/.claude', 'fine.seat', STAND_IN_CREDENTIAL, ['ok', 'ok', '']],
  ['us', '~/.claude-us', 'bob.sub', TRUNCATED, ['bad', 'credential', '登录凭据坏了']],
  ['us2', '~/.claude-us2', 'old.numbers', STAND_IN_CREDENTIAL, ['warn', 'stale', '数据已旧']],
  ['us3', '~/.claude-us3', 'query.fails', STAND_IN_CREDENTIAL, ['warn', 'failed', '查询失败']],
  ['us4', '~/.claude-us4', 'used.up', STAND_IN_CREDENTIAL, ['bad', 'exhausted', '额度用尽']],
  ['us5', '~/.claude-us5', 'signed.out', null, ['bad', 'logged-out', '未登录']],
  ['us6', '~/.claude-us6', 'expired.login', EXPIRED, ['bad', 'login-expired', '登录已过期']],
];
let app, page, profile, browser, hub;

// WCAG contrast of an element's text against what is really behind it (translucent layers composited).
async function contrast(locator) {
  return locator.evaluate((el) => {
    const rgba = (value) => { const m = value.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const bg = rgba(getComputedStyle(n).backgroundColor); if (bg.a > 0) layers.push(bg); if (bg.a === 1) break; }
    let base = { r: 255, g: 255, b: 255 };
    for (const layer of layers.reverse()) base = { r: layer.r * layer.a + base.r * (1 - layer.a), g: layer.g * layer.a + base.g * (1 - layer.a), b: layer.b * layer.a + base.b * (1 - layer.a) };
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const fg = rgba(getComputedStyle(el).color), a = lum(fg) + 0.05, b = lum(base) + 0.05;
    return Math.max(a, b) / Math.min(a, b);
  });
}
const shot = async (target, name) => target.screenshot({ path: test.info().outputPath(name + '.png'), animations: 'disabled' });

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seat-health-')));
  const home = path.join(profile, 'seats-home');
  for (const [id, dir, account, credential] of SEATS) {
    const full = path.join(home, dir.slice(2));
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(id === 'cn' ? path.join(home, '.claude.json') : path.join(full, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${account}@example.test`, accountUuid: `seat-health-${id}` }, hasCompletedOnboarding: true }));
    if (credential) fs.writeFileSync(path.join(full, '.credentials.json'), credential);
  }
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false }, mobileWeb: { enabled: false, port },
    claudeSeats: SEATS.map(([id, configDir]) => ({ id, name: id.toUpperCase(), configDir })), activeClaudeSeatId: 'cn',
    mainSession: { colId: 'health-captain', tasks: [], pending: [] },
    columns: [{ id: 'health-captain', title: '队长', claudeSeatId: 'cn', isMain: true, cmd: `node "${FAKE}" Claude cn`, cwd: profile, width: 600, role: 'manual' }],
  }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined, args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('.column')).toHaveCount(1);
  // The usage numbers each seat last had, in the desktop's own store, bound to the account behind it.
  await page.evaluate(async () => {
    const now = Date.now(), H = 3600_000;
    const infos = await ClaudeSeats.refresh(), info = (id) => infos.find((s) => s.id === id), dir = (id) => config.claudeSeats.find((s) => s.id === id).configDir;
    for (const key of Object.keys(config.quotas)) delete config.quotas[key];
    const official = (id, at, five, week) => QuotaCore.observe(config.quotas, { ...QuotaCore.cacheClaude({ source: QuotaCore.CLAUDE_OAUTH_SOURCE, windows: [
      { key: 'fiveHour', remaining: five, resetText: new Date(now + 2 * H).toISOString() }, { key: 'weekly', remaining: week, resetText: new Date(now + 3 * 86400_000).toISOString() }] }, at),
    seatId: id, configDir: dir(id), accountBound: true, accountKey: info(id).accountKey, credentialKey: info(id).credentialKey, account: info(id).accountEmail }, now);
    const failed = (id, failures) => QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: id, configDir: dir(id), at: now, failureOnly: true,
      failures, checkedAt: now, failure: '用量查询失败，等待 Claude 刷新凭据或网络恢复' }, now);
    official('cn', now - 60_000, 72, 64);
    // This morning's seat: its last numbers are still there, its login is 128 bytes of broken JSON.
    official('us', now - 3 * H, 40, 90); failed('us', 3);
    official('us2', now - 3 * H, 55, 80); failed('us2', 3);
    official('us3', now - 60_000, 66, 70); failed('us3', 1);
    official('us4', now - 60_000, 0, 30);
    official('us6', now - 3 * H, 50, 50);
    renderQuotaBar();
  });
});
test.afterAll(async () => {
  if (browser) await browser.close();
  if (hub) await hub.close();
  if (app) await app.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('sidebar: fine rows stay as they were; yellow and red rows say what is wrong and what to do, in both themes', async () => {
  const row = (id) => page.locator(`#quotaBar [data-seat-id="${id}"]`);
  for (const [id,, account,, [level, kind, label]] of SEATS) {
    await expect(row(id), id).toHaveAttribute('data-health', level);
    await expect(row(id), id).toHaveAttribute('data-health-kind', kind);
    await expect(row(id).locator('.quota-name')).toContainText(account);
    // The mark's shape carries the colour's meaning: none, a triangle (path) or a circle.
    // A used-up row's shape is the ⊘ in its cells.
    const marked = level !== 'ok' && kind !== 'exhausted';
    await expect(row(id).locator('.quota-name .quota-health')).toHaveCount(marked ? 1 : 0);
    if (kind === 'exhausted') await expect(row(id).locator('.quota-ban svg').first()).toBeVisible();
    if (level !== 'ok') {
      if (marked) await expect(row(id).locator(level === 'bad' ? '.quota-name .quota-health svg circle' : '.quota-name .quota-health svg path').first()).toBeAttached();
      await expect(row(id)).toHaveAttribute('aria-label', kind === 'exhausted' ? /：已用尽，\d\d:\d\d/ : new RegExp(`${label}，`));
    }
  }
  // The fine row keeps the usual name colour; yellow and red are each one colour, different from it.
  const color = (id) => row(id).locator('.quota-name').evaluate((el) => getComputedStyle(el).color);
  const [fine, yellow, red] = [await color('cn'), await color('us2'), await color('us')];
  expect(new Set([fine, yellow, red]).size).toBe(3);
  expect(await color('us3')).toBe(yellow);
  for (const id of ['us4', 'us5', 'us6']) expect(await color(id)).toBe(red);
  // 队长's own text: one line per seat, each with the same colour in words.
  const text = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  const line = (account) => text.split('\n').find((l) => l.includes(account)) || '';
  for (const [,, account,, [level,, label]] of SEATS) {
    if (level === 'ok') expect(line(account)).not.toMatch(/【[红黄]】/);
    else expect(line(account), account).toContain(`【${level === 'bad' ? '红' : '黄'}】${label}：`);
  }
  expect(line('bob.sub')).toMatch(/凭据文件里的登录凭据有 128 字节，不是合法 JSON.*需要重新登录这个席位/);
  expect(text).not.toMatch(/stand-in/);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => { config.theme = value; applyTheme(value); }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // Readable on whatever is behind it (the red rows are tinted): at least 4.5:1 for every name and mark.
    for (const [id,,,, [level]] of SEATS) {
      expect(await contrast(row(id).locator('.seat-acct, .quota-name').first()), `${theme} ${id}`).toBeGreaterThanOrEqual(4.5);
      if (level !== 'ok' && id !== 'us4') expect(await contrast(row(id).locator('.quota-name .quota-health')), `${theme} ${id} mark`).toBeGreaterThanOrEqual(3);
    }
    await shot(page.locator('#navQuota'), `sidebar-${theme}`);
    // Hover: the case, what was found and what to do; a login to redo comes with its command.
    await row('us').hover();
    const tip = row('us').locator('.quota-tooltip');
    await expect(tip).toBeVisible();
    await expect(tip.locator('.qt-badge')).toHaveText('登录凭据坏了');
    await expect(tip.locator('.qt-health')).toHaveText('登录凭据坏了：凭据文件里的登录凭据有 128 字节，不是合法 JSON，读不出来');
    await expect(tip).toContainText('要做：需要重新登录这个席位');
    await expect(tip.locator('.qt-login-command')).toHaveText(/claude auth login/);
    await expect(tip.getByRole('button', { name: '复制登录命令' })).toBeVisible();
    await shot(page, `tooltip-credential-${theme}`);
    await row('us2').hover();
    await expect(row('us2').locator('.qt-health')).toHaveText(/^数据已旧：额度数字停在 \d\d:\d\d，已连续 3 次查询失败$/);
    await expect(row('us2').locator('.quota-tooltip')).toContainText('要做：数字可能不准；一直不更新就检查网络，或重新登录这个席位');
    await expect(row('us2').locator('.qt-login-command')).toHaveCount(0);
    await shot(page, `tooltip-stale-${theme}`);
    await row('us4').hover();
    await expect(row('us4').locator('.quota-tooltip')).toContainText(/要做：等 \d\d:\d\d 恢复，或换别的席位/);
    await page.mouse.move(900, 400);
  }
  await page.evaluate(() => { config.theme = 'dark'; applyTheme('dark'); });
});

test('both phone pages show the same colours, marks and words as the desktop', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('#mobileWebEnabled').check();
  await expect(page.locator('#mobileWebUrl')).not.toHaveValue('');
  const url = await page.locator('#mobileWebUrl').inputValue(), token = await page.locator('#mobileWebToken').inputValue();
  await page.keyboard.press('Escape');
  browser = await chromium.launch();
  let served = null;
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
    const mobile = await context.newPage();
    await mobile.goto(url);
    await mobile.getByLabel('登录 token').fill(token);
    await mobile.getByRole('button', { name: '登录', exact: true }).click();
    await expect(mobile.locator('#tabbar')).toBeVisible();
    // What the computer hands the phone: the colour field by field, nothing about the credential itself.
    const body = await (await mobile.request.get(url + '/api/quota')).text();
    expect(body).not.toMatch(/stand-in|credentials|configDir/);
    served = JSON.parse(body).rows;
    await mobile.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    const drawer = mobile.locator('#drawer');
    await expect(drawer).toBeVisible();
    for (const [id,, account,, [level, kind, label]] of SEATS) {
      const item = drawer.locator(`.quota-item[data-quota-key="Claude:${id}"]`);
      await expect(item, id).toHaveAttribute('data-health', level);
      expect(served.find((r) => r.key === `Claude:${id}`).health.kind).toBe(kind);
      await expect(item.locator('.quota-health')).toHaveCount(level === 'ok' || kind === 'exhausted' ? 0 : 1);
      await expect(item.locator('.quota-name-text')).toHaveText(account);
      expect(await contrast(item.locator('.quota-name-text')), `${theme} ${id}`).toBeGreaterThanOrEqual(4.5);
      if (level !== 'ok') await expect(item.locator('.quota-row')).toHaveAttribute('aria-label', new RegExp(label));
    }
    // A login to redo says so under the row; old numbers keep their usual note.
    await expect(drawer.locator('.quota-item[data-quota-key="Claude:us"] .quota-row-note')).toHaveText('登录凭据坏了 · 需要重新登录这个席位');
    await expect(drawer.locator('.quota-item[data-quota-key="Claude:us5"] .quota-row-note')).toHaveText('未登录 · 需要重新登录这个席位');
    await expect(drawer.locator('.quota-item[data-quota-key="Claude:us2"] .quota-row-note')).toHaveText(/^查询失败 · 数据已旧 · 采样/);
    await expect(drawer.locator('.quota-item[data-quota-key="Claude:cn"] .quota-row-note')).toHaveCount(0);
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mobile.waitForTimeout(400);   // the drawer's slide-in
    await shot(mobile, `phone-${theme}`);
    await drawer.locator('.quota-item[data-quota-key="Claude:us"] .quota-row').click();
    await expect(mobile.locator('#quota-sheet')).toBeVisible();
    await expect(mobile.locator('#quota-sheet')).toContainText('登录凭据坏了：凭据文件里的登录凭据有 128 字节，不是合法 JSON，读不出来；需要重新登录这个席位');
    await shot(mobile, `phone-sheet-${theme}`);
    await context.close();
  }

  // The hub, given the very rows this computer served.
  hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'seat-health.local', quota: served, sessions: [], turns: [], cards: [] }] });
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
    const phone = await context.newPage();
    await phone.goto(hub.url);
    const card = phone.getByRole('article', { name: 'Mac', exact: true });
    await card.getByLabel('Mac 的登录 token').fill(hub.machines.mac.token);
    await card.getByRole('button', { name: '登录 Mac', exact: true }).click();
    for (const [id,, account,, [level, kind, label]] of SEATS) {
      const item = card.locator('.quota-item').filter({ has: phone.locator('.quota-name-text', { hasText: new RegExp(`^${account}$`) }) });
      await expect(item, id).toHaveAttribute('data-health', level);
      await expect(item.locator('.quota-health')).toHaveCount(level === 'ok' || kind === 'exhausted' ? 0 : 1);
      expect(await contrast(item.locator('.quota-name-text')), `hub ${theme} ${id}`).toBeGreaterThanOrEqual(4.5);
      if (level !== 'ok') await expect(item.locator('.quota-row')).toHaveAttribute('aria-label', new RegExp(label));
    }
    await expect(card.locator('.quota-item').filter({ has: phone.locator('.quota-name-text', { hasText: /^bob\.sub$/ }) }).locator('.quota-row-note')).toHaveText('登录凭据坏了 · 需要重新登录这个席位');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.locator('.quota').scrollIntoViewIfNeeded();
    await shot(phone, `hub-${theme}`);
    await context.close();
  }
});
