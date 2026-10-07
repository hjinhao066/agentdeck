const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('../../claude-seats-main');
const ROOT = path.resolve(__dirname, '../..'), FAKE = path.join(__dirname, 'fixtures/quota-agent.js');
let application, page, profile;
const alerts = () => application.evaluate(({ app }) => app.testQuotaAlerts);
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTDECK_')));
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [ROOT, `--test-user-data=${profile}`], env });
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
  await expect.poll(() => page.evaluate(() => config.mainSession.pending.some((r) => r.source === 'seat-auth'))).toBe(true);
  const read = await page.evaluate(async () => (await MainSession.handle({ action: 'main-receipts', wait: true }, MainSession.mainCol())).result);
  expect(read).toMatch(/掉登录.*任务会失败或排队/s); expect(read).toMatch(/改派到其他已登录席位/);
  await observe([['logged-in', base + 140000]]);
  await expect(row).not.toHaveAttribute('aria-label', /未登录/); expect(await alerts()).toHaveLength(1);
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
