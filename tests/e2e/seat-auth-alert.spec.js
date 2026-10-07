const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('../../claude-seats-main');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let application, page, profile;
const alerts = () => application.evaluate(({ app }) => app.testQuotaAlerts);
async function launch(barkNow) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTDECK_')));
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [ROOT, `--test-user-data=${profile}`,
    ...(Number.isFinite(barkNow) ? [`--test-bark-now=${barkNow}`] : [])], env });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => application.evaluate(({ app }) => typeof app.testSeatAuthObserve)).toBe('function');
}
async function observe(events) {
  await application.evaluate(({ app }, events) => {
    for (const [authStatus, at, provider = 'Claude'] of events) app.testSeatAuthObserve({ provider, scope: provider === 'Claude' ? 'claude' : 'codex',
      seatId: provider === 'Claude' ? 'us' : 'codex', configDir: provider === 'Claude' ? '~/.custom-us-seat' : '~/.codex', at, authStatus });
  }, events);
}
test.beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seat-auth-'));
  const seat = { id: 'us', name: 'US', configDir: '~/.custom-us-seat' }, home = path.join(profile, 'seats-home');
  const loc = M.credentialLocation(seat, home); fs.mkdirSync(loc.dir, { recursive: true });
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: 'offline-us', emailAddress: 'us@example.test' } }));
  M.writeUsage(seat, home, { at: Date.now(), windows: [{ key: 'fiveHour', remaining: 55 }, { key: 'weekly', remaining: 66 }] });
  const key = path.join(profile, 'fake-key'); fs.writeFileSync(key, 'fake_e2e_auth_key');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ barkKeyFile: key, perpetualCaptain: { enabled: false },
    barkNotifications: { sleepEnabled: false, classesEnabled: false },
    claudeSeats: [seat], activeClaudeSeatId: 'us',
    mainSession: { colId: 'captain', gen: 1, tasks: [], pending: [], inflight: [], waitlist: [], fresh: false, crewMarked: true },
    columns: [{ id: 'captain', title: '队长', isMain: true, cmd: `node "${FAKE}" Claude us`, cwd: profile, role: 'manual' },
      { id: 'worker', title: 'US worker', claudeSeatId: 'us', claudeConfigDir: seat.configDir, cmd: '', cwd: profile, role: 'manual' }],
  }));
});
test.afterEach(async () => {
  if (application) { await closeElectron(application); application = null; }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('confirmed logout sends one critical Bark, red 未登录 and a Captain question; recovery silently rearms', async () => {
  await launch();
  const row = page.locator('#quotaBar [data-seat-id="us"]');
  await expect(row.locator('[data-window="5h"] .quota-pct')).toHaveText('55%');
  const base = Date.now() - 180000;
  await observe([['logged-in', base], ['logged-out', base + 30000], [undefined, base + 60000], ['logged-out', base + 90000]]);
  expect(await alerts()).toHaveLength(0); await expect(row).not.toHaveAttribute('aria-label', /未登录/);
  await observe([['logged-out', base + 120000], ['logged-out', base + 130000]]);
  await expect.poll(async () => (await alerts()).length).toBe(1);
  expect((await alerts())[0]).toMatchObject({ level: 'critical', volume: 4, body: expect.stringMatching(/US（us）席位掉登录.*任务会失败或排队/s) });
  const command = process.platform === 'win32' ? 'claude auth login' : 'CLAUDE_CONFIG_DIR=~/.custom-us-seat claude auth login';
  expect((await alerts())[0].body).toContain(command);
  await expect(row).toHaveAttribute('data-state', 'danger');
  await expect(row.locator('[data-window="5h"] .quota-none')).toHaveText('未登录');
  await expect(row.locator('.quota-pct')).toHaveCount(0);
  await expect(row).toHaveAttribute('aria-label', /未登录/);
  await expect(row).toHaveAttribute('data-auth-status', 'logged-out');
  await page.evaluate(() => {
    QuotaCore.observe(config.quotas, { provider: 'Codex', scope: 'codex', at: Date.now(),
      windows: [{ label: '每周', key: 'weekly', remaining: 8 }] }); renderQuotaBar();
  });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => applyTheme(value), theme);
    const colors = await page.evaluate(() => {
      const row = document.querySelector('#quotaBar [data-seat-id="us"]');
      const login = getComputedStyle(row.querySelector('[data-window="5h"] .quota-none'));
      const dash = getComputedStyle(row.querySelector('[data-window="7d"] .quota-none'));
      const other = getComputedStyle(document.querySelector('#quotaBar [data-quota-key="Codex"] [data-window="5h"] .quota-none'));
      return { background: getComputedStyle(row).backgroundColor, login: login.color, dash: dash.color,
        weight: login.fontWeight, dashWeight: dash.fontWeight, otherWeight: other.fontWeight, other: other.color };
    });
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.login).not.toBe(colors.dash); expect(colors.weight).toBe('600');
    expect(colors.dashWeight).toBe('400'); expect(colors.otherWeight).toBe('400');
    expect(colors.dash).toBe(colors.other);
  }
  await row.focus();
  await expect(row.locator('.qt-login-command')).toHaveText(command);
  const copy = row.getByRole('button', { name: '复制登录命令', exact: true });
  await expect(copy).toHaveAttribute('title', '复制登录命令');
  await expect(copy.locator('svg rect')).toHaveCount(1); // existing overlapping-square copy icon
  const size = await copy.boundingBox(); expect(size.width).toBeGreaterThanOrEqual(35.99); expect(size.height).toBeGreaterThanOrEqual(35.99);
  await copy.focus(); await copy.press('Enter');
  await expect(row.getByRole('button', { name: '已复制', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(command); // test profiles have a private clipboard
  await expect(row.getByRole('button', { name: '复制登录命令', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.some((r) => r.source === 'seat-auth'))).toBe(true);
  const read = await page.evaluate(async () => (await MainSession.handle({ action: 'main-receipts', wait: true }, MainSession.mainCol())).result);
  expect(read).toMatch(/掉登录.*任务会失败或排队/s); expect(read).toMatch(/改派到其他已登录席位/);
  await observe([['logged-in', base + 140000]]);
  await expect(row).not.toHaveAttribute('aria-label', /未登录/); expect(await alerts()).toHaveLength(1);
  await expect(row.locator('.quota-login-copy')).toHaveCount(0);
  await observe([['logged-out', base + 150000], ['logged-out', base + 180000]]);
  await expect.poll(async () => (await alerts()).length).toBe(2);
  expect(fs.readFileSync(path.join(profile, 'seat-auth-state.json'), 'utf8')).not.toContain('fake_e2e_auth_key');
});
test('confirmed state survives renderer reload and app relaunch without another Bark', async () => {
  await launch(); const base = Date.now() - 90000;
  await observe([['logged-in', base], ['logged-out', base + 30000], ['logged-out', base + 60000]]);
  await expect.poll(async () => (await alerts()).length).toBe(1);
  await page.reload();
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('aria-label', /未登录/);
  expect(await alerts()).toHaveLength(1);
  await closeElectron(application); application = null; await launch();
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('aria-label', /未登录/);
  await observe([['logged-out', Date.now()]]); expect(await alerts()).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => config.mainSession.seatAuthAlerts?.length)).toBe(1);
});
test('Codex urgency works without a Captain and the retained exception arrives when a Captain exists', async () => {
  const file = path.join(profile, 'config.json'), cfg = JSON.parse(fs.readFileSync(file));
  cfg.columns[0].isMain = false; delete cfg.mainSession; fs.writeFileSync(file, JSON.stringify(cfg));
  await launch(); const base = Date.now() - 90000;
  await observe([['logged-in', base, 'Codex'], ['logged-out', base + 30000, 'Codex'], ['logged-out', base + 60000, 'Codex']]);
  await expect.poll(async () => (await alerts()).length).toBe(1);
  expect((await alerts())[0].body).toMatch(/Codex 席位掉登录.*codex login/s);
  await expect(page.locator('#quotaBar [data-quota-key="Codex"]')).toHaveAttribute('aria-label', /未登录/);
  expect(Object.values(JSON.parse(fs.readFileSync(path.join(profile, 'seat-auth-state.json')))).some((s) => s.receipts?.length)).toBe(true);
  await page.evaluate(() => {
    columns[0].isMain = true;
    config.mainSession = { colId: columns[0].id, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [], fresh: false, crewMarked: true };
    MainSession.init(deckHost); flushConfig();
  });
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.some((r) => r.source === 'seat-auth'))).toBe(true);
  expect(await alerts()).toHaveLength(1);
});

test('unrelated login wording only requests a real check; two texts never become logout proofs', async () => {
  await launch(); const base = Date.now() - 90000;
  await observe([['logged-in', base]]);
  // Change metadata only: the worker keeps its existing isolated shell, and no
  // real provider command is launched. The sampler below is also a stand-in.
  await page.evaluate(() => {
    columns.find((column) => column.id === 'worker').cmd = 'claude';
    saveConfig(); flushConfig();
  });
  for (const message of ['user is not signed in to GitHub', '测试发现"未登录"提示样式不对']) {
    expect(await page.evaluate((message) => window.deck.seatAuthFailure({ colId: 'worker', message }), message)).toBe(true);
  }
  expect(await application.evaluate(({ app }) => app.testSeatAuthChecks)).toEqual([
    { provider: 'Claude', seatId: 'us' }, { provider: 'Claude', seatId: 'us' },
  ]);
  const state = JSON.parse(fs.readFileSync(path.join(profile, 'seat-auth-state.json'), 'utf8'))['Claude:us'];
  expect(state.status).toBe('logged-in'); expect(state.misses).toBe(0);
  expect(await alerts()).toHaveLength(0);
  const row = page.locator('#quotaBar [data-seat-id="us"]');
  await expect(row).not.toHaveAttribute('aria-label', /未登录/);
  for (const at of [base + 30000, base + 60000]) {
    await application.evaluate(({ app }, at) => app.testSeatAuthProofs.push({ at, authStatus: 'logged-out' }), at);
    await page.evaluate(() => window.deck.seatAuthFailure({ colId: 'worker', message: 'Not logged in' }));
  }
  await expect.poll(async () => (await alerts()).length).toBe(1);
  await expect(row).toHaveAttribute('aria-label', /未登录/);
});

test('recovery cancels only that seats durable quiet-hour reminder before morning digest and stops fast checks', async () => {
  const configFile = path.join(profile, 'config.json'), config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.barkNotifications = { sleepEnabled: true, sleepStart: '23:00', sleepEnd: '10:00', classesEnabled: false };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const morning = new Date(); morning.setHours(9, 0, 0, 0);
  await launch(morning.getTime()); const base = Date.now() - 120000;
  await observe([['logged-in', base], ['logged-out', base + 30000], ['logged-out', base + 60000],
    ['logged-in', base, 'Codex'], ['logged-out', base + 30000, 'Codex'], ['logged-out', base + 60000, 'Codex']]);
  await expect.poll(() => page.evaluate(async () => (await window.deck.barkStatus()).queuedCount)).toBe(2);
  expect(await alerts()).toHaveLength(0);
  const us = { provider: 'Claude', seatId: 'us', configDir: '~/.custom-us-seat' };
  expect(await application.evaluate(({ app }, seat) => app.testSeatAuthNeedsCheck(seat), us)).toBe(true);
  // Both episode and reminder survive restart; recovery must still remove the
  // obsolete message without consuming the Captain's historical exception.
  await closeElectron(application); application = null; await launch(morning.getTime());
  await expect.poll(() => page.evaluate(async () => (await window.deck.barkStatus()).queuedCount)).toBe(2);
  await observe([['logged-in', base + 90000]]);
  await expect.poll(() => page.evaluate(async () => (await window.deck.barkStatus()).queuedCount)).toBe(1);
  expect(await application.evaluate(({ app }, seat) => app.testSeatAuthNeedsCheck(seat), us)).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(profile, 'bark-pending.json'), 'utf8')).pending.map((item) => item.key)).toEqual(['seat-auth:Codex:codex']);
  morning.setHours(10, 0, 0, 0);
  await application.evaluate(async ({ app }, at) => { app.testBarkNow = at; await app.testBarkFlush(); }, morning.getTime());
  const digests = await application.evaluate(({ app }) => app.testBarkDigests);
  expect(digests).toHaveLength(1);
  expect(digests[0].body).toContain('Codex 席位掉登录');
  expect(digests[0].body).not.toContain('Claude US');
});

test('daytime phone failure stays queued, records a Captain exception and retries after key repair without another outage alert', async () => {
  const at = new Date('2026-10-07T12:00:00-07:00').getTime();
  await launch(at);
  const key = path.join(profile, 'fake-key'); fs.unlinkSync(key);
  const base = Date.now() - 90000;
  await observe([['logged-in', base], ['logged-out', base + 30000], ['logged-out', base + 60000]]);
  await expect.poll(() => page.evaluate(async () => (await window.deck.barkStatus()).queuedCount)).toBe(1);
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.some((r) => /提醒异常.*发送失败/.test(r.question)))).toBe(true);
  expect(await alerts()).toHaveLength(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#barkPolicyStatus')).toContainText('发送失败待重试');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  fs.writeFileSync(key, 'fake_e2e_repaired_key');
  await application.evaluate(async ({ app }, at) => { app.testBarkNow = at; await app.testBarkFlush(); }, at + 59_999);
  expect(await application.evaluate(({ app }) => app.testBarkDigests)).toHaveLength(0);
  await application.evaluate(async ({ app }, at) => { app.testBarkNow = at; await app.testBarkFlush(); }, at + 60_000);
  const sent = await application.evaluate(({ app }) => app.testBarkDigests);
  expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ level: 'critical', volume: 4 });
  expect(sent[0].body).toContain('CLAUDE_CONFIG_DIR=~/.custom-us-seat claude auth login');
  await observe([['logged-out', base + 90000]]);
  await application.evaluate(async ({ app }) => app.testBarkFlush());
  expect(await application.evaluate(({ app }) => app.testBarkDigests)).toHaveLength(1);
});
