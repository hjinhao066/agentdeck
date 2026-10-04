const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --interruptible`;
const WORKER = 'warmup-codex-worker';
const CLAUDE = 'warmup-cn-live';
const accountUuid = (id) => `quota-warmup-${id}-fixture`;
const accountKey = (id) => crypto.createHash('sha256').update(accountUuid(id)).digest('hex').slice(0, 16);
let application, page, profile, home;

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}
function records(file) {
  const target = path.join(profile, file);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}
function cache(id, extra = {}) {
  const configDir = path.join(home, id === 'cn' ? '.claude' : '.claude-us');
  fs.writeFileSync(path.join(configDir, 'agentdeck-usage.json'), JSON.stringify({
    at: Date.now() - 120_000, accountKey: accountKey(id), configDir,
    windows: [{ key: 'fiveHour', remaining: 80, resetText: new Date(Date.now() - 90_000).toISOString() },
      { key: 'weekly', remaining: 60, resetText: new Date(Date.now() + 7 * 86400000).toISOString() }], ...extra,
  }));
}
async function launch() {
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env: isolatedEnv({ AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'),
      AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') }),
  });
  if (process.env.AGENTDECK_TEST_ELECTRON_LOGS) {
    const child = application.process();
    fs.mkdirSync(process.env.AGENTDECK_TEST_ELECTRON_LOGS, { recursive: true });
    child.stderr.on('data', (chunk) => fs.appendFileSync(path.join(process.env.AGENTDECK_TEST_ELECTRON_LOGS, `${child.pid}.log`), chunk));
  }
  page = await application.firstWindow();
  await expect(page.locator('.column.chat-mode')).toHaveCount(1);
  await expect.poll(() => records('seat-env.jsonl').some((r) => r.colId === WORKER), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate((id) => {
    const entry = terms.get(id);
    return !!entry?.alive && dumpScreen(entry.term).includes('Codex CLI');
  }, WORKER), { timeout: 20000 }).toBe(true);
}
async function tick(results) {
  await application.evaluate(async ({ app }, supplied) => {
    if (supplied) app.testWarmupResults.push(...supplied);
    await app.testQuotaWarmup.tick();
  }, results);
}
async function snapshot() { return application.evaluate(({ app }) => app.testQuotaWarmup.snapshot()); }
async function runs() { return application.evaluate(({ app }) => app.testWarmupRuns); }
async function refresh() { await page.evaluate(async () => { await ClaudeSeats.refresh(); renderQuotaBar(); }); }
async function screenshot(name) {
  const dir = process.env.AGENTDECK_TEST_SCREENSHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
async function settings() {
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  await expect(page.locator('#claudeSeatSettings')).toBeVisible();
  return page.locator('#quotaWarmupEnabled');
}
async function saveSettings() { await page.locator('#claudeSeatSettings').getByRole('button', { name: '保存设置' }).click(); }
async function keepWorking(id) {
  await page.evaluate((i) => sendWhenReady(columns.find((c) => c.id === i), 'keep working', { guardUserInput: true }), id);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, id)).toBe('working');
}
async function workerPreserved(expectedColumns) {
  await expect(page.locator('.column.chat-mode')).toHaveCount(expectedColumns);
  expect(await page.evaluate((id) => terms.get(id)?.state, WORKER)).toBe('working');
  expect(await page.evaluate((id) => window.deck.ptyIsAlive(id), WORKER)).toBe(true);
  expect(records('seat-env.jsonl').filter((r) => r.colId === WORKER)).toHaveLength(1);
}

test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-warmup-e2e-')));
  home = path.join(profile, 'seats-home');
  for (const id of ['cn', 'us']) {
    const dir = path.join(home, id === 'cn' ? '.claude' : '.claude-us');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}'); // isolated existence fixture
    const metadata = id === 'cn' ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
    fs.writeFileSync(metadata, JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.test`, accountUuid: accountUuid(id) } }));
  }
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [{ id: WORKER, title: '继续工作的 Codex 队员', cmd: FAKE + ' --provider=codex', cwd: profile, agentProvider: 'Codex' }],
  })); // Missing quotaWarmup exercises the default enabled setting.
  await launch();
});
test.afterEach(async () => {
  if (application) {
    const child = application.process(), force = setTimeout(() => {
      // Playwright launches this Electron in its own process group. Close its
      // helpers too, so inherited stdio cannot keep the test worker alive.
      try {
        if (process.platform === 'win32') {
          if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else process.kill(-child.pid, 'SIGKILL');
      } catch (_) {}
    }, 10000);
    try {
      if (page && !page.isClosed()) await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach((d) => d.close());
        columns.forEach((c) => window.deck.ptyKill(c.id));
      });
      await application.close();
    } finally { clearTimeout(force); }
  }
  application = null; page = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('warmup uses an accessible icon switch, and saved off/on settings survive reload', async () => {
  expect(await page.evaluate(() => config.quotaWarmup)).toEqual({ enabled: true });
  let toggle = await settings();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', '额度窗口预热');
  await expect(toggle).toHaveAttribute('title', '额度窗口预热');
  await expect(toggle.locator('svg')).toHaveCount(1);
  expect(await toggle.innerText()).toBe('');
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await screenshot('warmup-settings');
  await toggle.click();
  await saveSettings();
  await expect.poll(() => page.evaluate(() => config.quotaWarmup)).toEqual({ enabled: false });
  cache('cn');
  await tick([{ ok: true }]);
  expect(await runs()).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#settingsBtn')).toBeVisible();
  expect(await page.evaluate(() => config.quotaWarmup)).toEqual({ enabled: false });
  toggle = await settings();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await saveSettings();
  await expect.poll(() => page.evaluate(() => config.quotaWarmup)).toEqual({ enabled: true });
  await tick();
  expect(await runs()).toHaveLength(1);
  await page.reload();
  await expect(page.locator('#settingsBtn')).toBeVisible();
  expect(await page.evaluate(() => config.quotaWarmup)).toEqual({ enabled: true });
});

test('a proven reset warms once in the background and shows its log and next reset without interrupting Codex', async () => {
  await keepWorking(WORKER);
  cache('cn');
  const nextReset = Date.now() + 5 * 3600_000;
  await tick([{ ok: true, provenNative: true, resetAt: nextReset }]);
  expect(await runs()).toEqual([{ seatId: 'cn', configDir: '~/.claude' }]);
  await tick(); await tick();
  expect(await runs()).toHaveLength(1);
  expect((await snapshot()).find((s) => s.seatId === 'cn')).toMatchObject({ status: 'pending', attempts: 0, newResetAt: nextReset });
  const log = records('quota-warmup.log');
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ seatId: 'cn', attempt: 1, outcome: 'warmed', newResetAt: nextReset });
  expect(Number.isFinite(Date.parse(log[0].time))).toBe(true);
  await refresh();
  const seat = page.locator('#quotaBar [data-seat-id="cn"]');
  await expect(seat).toHaveAttribute('title', /已预热 · 下次重置 \d{2}:\d{2}/);
  await expect(seat).toHaveAttribute('aria-label', /已预热 · 下次重置/);
  await seat.focus();
  await expect(seat.getByRole('tooltip')).toBeVisible();
  await expect(seat.getByRole('tooltip')).toContainText('已预热 · 下次重置');
  await screenshot('warmup-details');
  await workerPreserved(1);
});

test('an occupied Claude seat is skipped while the other seat warms without adding visible columns', async () => {
  await keepWorking(WORKER);
  await page.evaluate(([id, command, cwd, dir]) => {
    addColumn({ id, title: 'CN 正在使用', cmd: command, cwd, agentProvider: 'Claude', claudeSeatId: 'cn', claudeConfigDir: dir });
    flushConfig();
  }, [CLAUDE, FAKE, profile, path.join(home, '.claude')]);
  await expect.poll(() => page.evaluate((id) => {
    const entry = terms.get(id);
    return !!entry?.alive && dumpScreen(entry.term).includes('Claude Code');
  }, CLAUDE)).toBe(true);
  await keepWorking(CLAUDE);
  cache('cn'); cache('us');
  await tick([{ ok: true, provenNative: true, resetAt: Date.now() + 5 * 3600_000 }]);
  expect((await runs()).map((r) => r.seatId)).toEqual(['us']);
  await tick();
  expect(await runs()).toHaveLength(1);
  expect((await snapshot()).find((s) => s.seatId === 'cn')).toMatchObject({ status: 'pending', attempts: 0 });
  expect(await page.evaluate((id) => window.deck.ptyIsAlive(id), CLAUDE)).toBe(true);
  expect(await page.evaluate((id) => terms.get(id)?.state, CLAUDE)).toBe('working');
  expect(records('seat-env.jsonl').filter((r) => r.colId === CLAUDE)).toHaveLength(1);
  await workerPreserved(2);
});

test('unowned cache numbers and an unknown reset do not send a warmup request', async () => {
  cache('cn', { accountKey: accountKey('us') });
  cache('us', { windows: [{ key: 'fiveHour', remaining: 80, resetText: '未知' }] });
  await tick(); await tick();
  expect(await runs()).toHaveLength(0);
  expect(records('quota-warmup.log')).toHaveLength(0);
  expect((await snapshot()).every((s) => !s.resetAt && !s.warmAt)).toBe(true);
  await expect(page.locator('.column.chat-mode')).toHaveCount(1);
});

test('official quota fields warm the matching seat without native cache or account-bound payload extensions', async () => {
  await keepWorking(WORKER);
  await page.evaluate(async () => {
    const info = (await window.deck.claudeSeats()).find((seat) => seat.id === 'us');
    config.quotas['Claude:us'] = { sample: {
      provider: 'Claude', scope: 'claude', official: true, seatId: info.id,
      configDir: info.configDir, credentialKey: info.credentialKey, at: Date.now() - 120000,
      windows: [{ key: 'fiveHour', used: 100, remaining: 0, exhausted: true, resetAt: Date.now() - 90000 },
        { key: 'weekly', remaining: 60, resetAt: Date.now() + 7 * 86400000 }],
    } };
    flushConfig();
  });
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).quotas['Claude:us']?.sample?.official).toBe(true);
  const nextReset = Date.now() + 5 * 3600000;
  await tick([{ ok: true, provenNative: true, resetAt: nextReset }]);
  expect((await runs()).map((run) => run.seatId)).toEqual(['us']);
  await refresh();
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('title', /已预热 · 下次重置/);
  await workerPreserved(1);
});

test('weekly exhausted and threshold quotas prevent preheat without consuming the window', async () => {
  for (const remaining of [0, 3]) {
    cache('us', { windows: [{ key: 'fiveHour', remaining: 80, resetText: new Date(Date.now() - 90000).toISOString() },
      { key: 'weekly', remaining, resetText: new Date(Date.now() + 7 * 86400000).toISOString() }] });
    await tick(); expect(await runs()).toHaveLength(0);
    expect((await snapshot()).find((s) => s.seatId === 'us').attempts).toBe(0);
  }
  expect(records('quota-warmup.log')).toHaveLength(0);
});

test('two failed requests abandon the same reset window, including across isolated restart', async () => {
  test.setTimeout(90000);
  cache('cn');
  await tick([{ ok: false, status: 'quota' }]);
  expect(await runs()).toHaveLength(1);
  expect((await snapshot()).find((s) => s.seatId === 'cn')).toMatchObject({ status: 'retry', attempts: 1 });
  await tick();
  expect(await runs()).toHaveLength(1); // The ordinary retry deadline is at least sixty seconds.
  await application.close(); application = null; page = null;
  // Fast-forward only the private fixture deadline after stopping this test's
  // process. Production state and the installed AgentDeck are never touched.
  const file = path.join(profile, 'quota-warmup-state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.seats.cn.retryAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(state));
  await launch();
  await tick([{ ok: false, status: 'timeout' }]);
  expect(await runs()).toHaveLength(1);
  expect((await snapshot()).find((s) => s.seatId === 'cn')).toMatchObject({ status: 'abandoned', attempts: 2 });
  await tick(); await tick();
  expect(await runs()).toHaveLength(1);
  expect(records('quota-warmup.log').map((r) => [r.attempt, r.outcome])).toEqual([[1, 'failed'], [2, 'failed']]);
  await refresh();
  await expect(page.locator('#quotaBar [data-seat-id="cn"]')).toHaveAttribute('title', /预热失败 · 本窗口已放弃/);
  await expect(page.locator('.column.chat-mode')).toHaveCount(1);
});
