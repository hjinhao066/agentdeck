const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = path.join(__dirname, 'fixtures/fake-agent.js');
let app, page, profile;
const seat = (id) => page.locator(`#quotaBar [data-seat-id="${id}"]`);
test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seat-refresh-e2e-')));
  const home = path.join(profile, 'seats-home');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    claudeSeats: [{ id: 'cn', name: 'CN', configDir: path.join(home, '.claude') }, { id: 'us', name: 'US', configDir: path.join(home, '.claude-us') }],
    columns: ['captain', 'worker'].map(id => ({ id, title: id, cmd: `node "${FAKE}"`, cwd: profile, isMain: id === 'captain', claudeSeatId: 'cn' })),
    mainSession: { colId: 'captain', tasks: [], pending: [], crewMarked: true },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('#quotaBar [data-seat-id]')).toHaveCount(3);
  // Test-only main-process transport replacement: real isolated file store,
  // credential selection, GET parser, poller and IPC; never real credentials/network.
  await app.evaluate(({ ipcMain, app }, { profile }) => {
    const root = app.getAppPath();
    const require = process.getBuiltinModule('module').createRequire(root + '/main.js');
    const fs = require('fs'), path = require('path'), { EventEmitter } = require('events');
    const C = require(path.join(root, 'quota-claude'));
    const S = require(path.join(root, 'claude-seats-core'));
    const M = require(path.join(root, 'claude-seats-main'));
    const { readLocal } = require(path.join(root, 'quota-local'));
    const home = path.join(profile, 'seats-home');
    const seats = S.normalize(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).claudeSeats);
    const state = globalThis.seatRefreshTest = { at: Date.now(), failUs: false, calls: [] };
    for (const seat of seats) {
      const loc = M.credentialLocation(seat, home);
      fs.mkdirSync(loc.dir, { recursive: true });
      fs.writeFileSync(loc.metadataPath, JSON.stringify({ oauthAccount: { accountUuid: `fake-refresh-${seat.id}`, emailAddress: `${seat.id}@example.test` } }));
      fs.writeFileSync(loc.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: `fake-${seat.id}`, scopes: ['user:profile'], expiresAt: state.at + 86400000 } }));
    }
    state.poller = C.createRefresh({ home, getSeats: () => seats, now: () => state.at, read: async (seat) => {
      const token = await C.readCredentials(seat, home, 'win32');
      const value = await C.requestUsage(token, (url, options, cb) => {
        if (url !== 'https://api.anthropic.com/api/oauth/usage' || options.headers.Authorization !== `Bearer fake-${seat.id}`) throw new Error('wrong request');
        state.calls.push(seat.id);
        const req = new EventEmitter(); req.destroy = () => {};
        queueMicrotask(() => {
          const res = new EventEmitter(); res.destroy = () => {}; res.setEncoding = () => {};
          res.statusCode = state.failUs && seat.id === 'us' ? 401 : 200; cb(res);
          if (res.statusCode === 200) {
            res.emit('data', JSON.stringify({ five_hour: { utilization: seat.id === 'cn' ? 25 : 60, resets_at: new Date(state.at + 3600000).toISOString() }, seven_day: { utilization: seat.id === 'cn' ? 40 : 10, resets_at: new Date(state.at + 86400000).toISOString() } }));
            res.emit('end');
          }
        });
        return req;
      });
      const loc = M.credentialLocation(seat, home);
      return value ? { ...value, accountKey: M.usageAccountKey(loc), configDir: loc.dir } : null;
    } });
    ipcMain.removeHandler('quota:local');
    ipcMain.handle('quota:local', async () => [...await readLocal(home, undefined, state.at, seats), ...state.poller.samples()]);
  }, { profile });
  await app.evaluate(() => globalThis.seatRefreshTest.poller.tick());
  await page.evaluate(() => readQuotaCache());
});
test.afterEach(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test('both idle seats show independent fresh windows, resets and visible sample times without sending any prompt', async () => {
  await app.evaluate(() => globalThis.seatRefreshTest.poller.tick());
  await page.evaluate(() => readQuotaCache());
  await expect(seat('cn').locator('[data-window="5h"] .quota-pct')).toHaveText('75%');
  await expect(seat('us').locator('[data-window="5h"] .quota-pct')).toHaveText('40%');
  for (const id of ['cn', 'us']) {
    await expect(seat(id)).toHaveAttribute('data-detail', /^状态：正常 · 采样 \d\d:\d\d\n/);
    await expect(seat(id)).toHaveAttribute('data-detail', /5h \d+% ↻.*7d \d+% ↻.*Claude OAuth usage.*采样/s);
  }
  if (process.env.AGENTDECK_REFRESH_SHOTS) {
    fs.mkdirSync(process.env.AGENTDECK_REFRESH_SHOTS, { recursive: true });
    await page.locator('#topBar').screenshot({ path: path.join(process.env.AGENTDECK_REFRESH_SHOTS, 'idle-seat-quota.png') });
  }
  await app.evaluate(() => globalThis.seatRefreshTest.poller.tick());
  expect(await app.evaluate(() => globalThis.seatRefreshTest.calls.slice().sort())).toEqual(['cn', 'us', 'us2']);
  // The refreshed US seat has no terminal at all; Captain and worker stay CN.
  expect(await page.evaluate(() => columns.every(c => c.claudeSeatId === 'cn'))).toBe(true);
  expect(await page.evaluate(() => ChatUI.turnsOf('worker').length)).toBe(0);
  expect(await page.evaluate(() => Promise.all(['captain', 'worker'].map(id => window.deck.ptyIsAlive(id))))).toEqual([true, true]);
});
test('one-seat authentication failure emits no new authoritative sample; previous numbers remain marked stale and recover', async () => {
  const at = await app.evaluate(async () => {
    const state = globalThis.seatRefreshTest;
    state.at += 31 * 60000; state.failUs = true; await state.poller.tick(); return state.at;
  });
  const failed = await app.evaluate(() => globalThis.seatRefreshTest.poller.samples().find((s) => s.seatId === 'us'));
  expect(failed).toMatchObject({ failureOnly: true, failures: 1, at });
  expect(failed.windows).toBeUndefined();
  await page.evaluate(async (at) => { Date.now = () => at; await readQuotaCache(); }, at);
  await expect(seat('cn').locator('[data-window="5h"] .quota-pct')).toHaveText('75%');
  await expect(seat('us')).toHaveAttribute('data-state', 'normal');
  await expect(seat('us').locator('[data-window="5h"] .quota-pct')).toHaveText('40%');
  await expect(seat('us')).toHaveAttribute('data-detail', /5h 40% ↻[\s\S]*7d 90% ↻[\s\S]*查询失败：[\s\S]*连续 1 次[\s\S]*保留上次数字[\s\S]*数据已旧/);
  expect(await page.evaluate(() => config.quotas['Claude:us'].sample.at)).toBe(at - 31 * 60000);
  await page.reload();
  await expect(page.locator('#quotaBar [data-seat-id]')).toHaveCount(3);
  await page.evaluate(async (at) => { Date.now = () => at; await readQuotaCache(); }, at);
  await expect(seat('us')).toHaveAttribute('data-state', 'normal');
  await expect(seat('us')).toHaveAttribute('data-detail', /数据已旧/);
  const later = await app.evaluate(async () => {
    const state = globalThis.seatRefreshTest;
    state.at += 15 * 60000; state.failUs = false; await state.poller.tick(); return state.at;
  });
  await page.evaluate(async (at) => { Date.now = () => at; await readQuotaCache(); }, later);
  await expect(seat('us').locator('[data-window="5h"] .quota-pct')).toHaveText('40%');
  await expect(seat('us')).not.toHaveAttribute('data-detail', /数据已旧|查询失败/);
  expect(await page.evaluate(() => config.quotas['Claude:us'].sample.at)).toBe(later);
  expect(await app.evaluate(() => globalThis.seatRefreshTest.calls.slice().sort())).toEqual(['cn', 'cn', 'cn', 'us', 'us', 'us', 'us2', 'us2', 'us2']);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe('captain');
  expect(await page.evaluate(() => Promise.all(['captain', 'worker'].map(id => window.deck.ptyIsAlive(id))))).toEqual([true, true]);
});
