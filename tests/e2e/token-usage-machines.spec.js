const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../token-usage-core');
const F = require('../../fleet-usage-core');
const { SharedStore } = require('../../shared-store');
const { startSyncServer } = require('../../sync-server');

// Token 用量's Mac | Windows switch on the chart, with a local sync service (never the
// real hub) holding the other machine: first an older build that sends nothing, then
// its summary. The cards above the chart always count this machine. The profile has
// one plain terminal column, and its made-up logs live in <profile>/usage-home.
// Set AGENTDECK_USAGE_MACHINES_SHOTS to a folder to keep PNGs of both themes.
const shots = process.env.AGENTDECK_USAGE_MACHINES_SHOTS;
test.describe.configure({ timeout: 180000 });
const TOKEN = 'e2e-usage-machines';
const SELF = process.platform;
const OTHER = SELF === 'darwin' ? 'win32' : 'darwin';
const selfLabel = F.platformLabel(SELF), otherLabel = F.platformLabel(OTHER);
let application, page, root, server, beat;
const errors = [];

async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}

// This machine: Claude Code on each of the last 7 days but 3 days ago. Returns the day totals.
function seedLocal(home, today) {
  const lines = [], totals = {};
  for (let back = 0; back < 7; back++) {
    if (back === 3) continue;
    const day = C.addDays(today, -back);
    const usage = { input_tokens: 4000 + back * 100, output_tokens: 1500, cache_read_input_tokens: 2_000_000 + back * 50_000, cache_creation_input_tokens: 60_000 };
    lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(C.dayStart(day) + 10 * 3600_000).toISOString(), message: { id: 'msg-' + back, model: 'claude-opus-5-5', usage } }));
    totals[day] = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  }
  const file = path.join(home, '.claude', 'projects', 'demo', 'a.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return totals;
}
// The other machine's summary, as its AgentDeck would send it: Codex and Sonnet, bigger days.
function otherSummary(today) {
  const days = {}, costs = {};
  for (let back = 0; back < 7; back++) {
    const day = C.addDays(today, -back);
    days[day] = { 'codex:gpt-6.1': [900_000, 80_000, 30_000_000 + back * 1_000_000, 0], 'claude:claude-sonnet-5-5': [20_000, 9_000, 6_000_000, 400_000] };
    costs[day] = { 'codex:gpt-6.1': [1.1, 0.8, 3, 0], 'claude:claude-sonnet-5-5': [0.06, 0.135, 1.8, 1.5] };
  }
  return F.summarize({ today, generatedAt: Date.now() - 6 * 60_000, pricesChecked: '2026-10-01', days, costs });
}
const sumOf = (v) => v[0] + v[1] + v[2] + v[3];

async function launch({ fleet }) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-machines-'));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const today = C.dayKey(Date.now());
  const local = seedLocal(path.join(profile, 'usage-home'), today);
  // never an empty column list (that falls back to the default agents): one plain terminal
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark',
    columns: [{ id: 'col-shell', title: '终端', cmd: '', cwd: profile, width: 460, role: 'manual' }],
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  // no native dialog can open on the desktop, whatever goes wrong
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require "${path.join(__dirname, 'fixtures', 'no-dialogs.js')}"`].filter(Boolean).join(' ');
  if (fleet) {
    const tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    Object.assign(env, { AGENTDECK_FLEET_URL: fleet.url, AGENTDECK_FLEET_TOKEN_FILE: tokenFile, AGENTDECK_FLEET_SYNC_MS: '300',
      AGENTDECK_FLEET_START_DELAY_MS: '500', AGENTDECK_FLEET_USAGE_DELAY_MS: '300', AGENTDECK_FLEET_USAGE_MS: '0' });
  }
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => typeof TaskBoardUI !== 'undefined' && typeof TokenUsageUI !== 'undefined'), { timeout: 30000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => { try { TaskBoardUI.open('tokens'); return TaskBoardUI.mode(); } catch (_) { return ''; } }), { timeout: 30000 }).toBe('tokens');
  return { today, local, localTotal: C.dayRange(today, 7).reduce((s, d) => s + (local[d] || 0), 0) };
}
test.afterEach(async () => {
  clearInterval(beat); beat = null;
  if (application) await closeElectron(application);
  application = null;
  if (server) await server.close();
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = null;
});

const caps = () => page.evaluate(() => [...document.querySelectorAll('#taskBoardView .tu-col')].map((g) => ({ day: g.dataset.day, total: (g.querySelector('.tu-total') || {}).textContent || '' })));

test('默认本机; the other machine: an older build says so, then its own numbers; the cards stay this machine\'s; both themes', async () => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-hub-'));
  const store = new SharedStore({ file: path.join(hubDir, 'store.json') });
  let version = '2.0.6';
  const heartbeat = () => store.heartbeat({ id: 'dev-other', name: otherLabel + ' 测试机', platform: OTHER, version });
  heartbeat();
  beat = setInterval(heartbeat, 3000);
  server = await startSyncServer({ store, token: TOKEN });
  const { today, local, localTotal } = await launch({ fleet: server });
  const view = page.locator('#taskBoardView');
  const hero = view.locator('.tu-hero-num');
  await expect(hero).toHaveText(C.formatShort(localTotal), { timeout: 30000 });

  // the switch sits at the chart's top right, both machines shown, this one picked
  const sw = view.locator('.tu-chart-card .tu-machine');
  await expect(sw).toBeVisible({ timeout: 15000 });
  await expect(sw).toHaveAttribute('aria-label', '看哪台电脑的用量');
  const selfBtn = sw.locator(`button[data-platform="${SELF}"]`), otherBtn = sw.locator(`button[data-platform="${OTHER}"]`);
  await expect(sw.locator('button')).toHaveText(['Mac', 'Windows']);
  await expect(selfBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(otherBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(selfBtn).toHaveAttribute('aria-label', `看 ${selfLabel}（本机）的用量`);
  const card = await view.locator('.tu-chart-card').boundingBox(), box = await sw.boundingBox();
  expect(box.x + box.width).toBeGreaterThan(card.x + card.width - 40);
  expect(box.y).toBeLessThan(card.y + 30);
  expect(box.height).toBeLessThanOrEqual(30);
  for (const c of await caps()) expect(c.total, c.day).toBe(local[c.day] ? C.formatShort(local[c.day]) : '');
  // seven days fit: no sideways scrollbar under the chart
  expect(await page.evaluate(() => { const w = document.querySelector('#taskBoardView .tu-chart'); return w.offsetHeight - w.clientHeight; })).toBe(0);

  // this machine sent its own summary (the background scan), with the same day totals
  const selfId = await page.evaluate(async () => (await window.deck.fleetState()).selfId);
  await expect.poll(() => { const r = store.record(F.USAGE_SESSION, selfId); return r ? Object.keys(F.fromRecord(r).days).length : 0; }, { timeout: 30000 }).toBe(Object.keys(local).length);
  const mine = F.fromRecord(store.record(F.USAGE_SESSION, selfId));
  for (const [day, total] of Object.entries(local)) expect(sumOf(mine.days[day]['claude:claude-opus-5-5']), day).toBe(total);
  expect(JSON.stringify(mine)).not.toContain(TOKEN);
  expect(store.record(F.USAGE_SESSION, selfId).alternatives || []).toEqual([]);
  await screenshot('dark-1-local');

  // the other machine still runs an older build: why, in the chart's place; never empty columns
  await expect(otherBtn).toHaveAttribute('aria-label', new RegExp(`看 ${otherLabel} 的用量，.*还不会上传用量`), { timeout: 25000 });
  await otherBtn.focus();
  await page.keyboard.press('Enter');
  await expect(otherBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(selfBtn).toHaveAttribute('aria-pressed', 'false');
  const off = view.locator('.tu-off');
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute('data-state', 'old');
  await expect(off.locator('.tu-off-title')).toHaveText(`${otherLabel} 上的 AgentDeck 2.0.6 还不会上传用量`);
  await expect(off.locator('.tu-off-detail')).toContainText('2.0.7');
  await expect(view.locator('.tu-chart')).toBeHidden();
  await expect(view.locator('.tu-col')).toHaveCount(0);
  await expect(view.locator('.tu-day')).toBeHidden();
  await expect(view.locator('.tu-legend-item')).toHaveCount(0);
  await expect(hero).toHaveText(C.formatShort(localTotal), { timeout: 1 });
  await expect(otherBtn).toBeFocused();
  await screenshot('dark-3-other-missing');

  // it updates and sends its summary: its columns, its legend, its day table; the cards stay this machine's
  const summary = otherSummary(today);
  const push = () => store.pushHistory({ opId: 'op-other-' + Date.now(), sessionId: F.USAGE_SESSION, deviceId: 'dev-other', contentHash: require('crypto').createHash('sha256').update(JSON.stringify(F.turnsOf(summary))).digest('hex'),
    summary: F.LABEL, startedAt: F.EPOCH, endedAt: F.EPOCH, turns: F.turnsOf(summary) });
  version = '2.0.7'; heartbeat(); push();
  await expect.poll(async () => (await page.evaluate(() => window.deck.tokenUsageMachines())).fleet.usage['dev-other'] ? 1 : 0, { timeout: 15000 }).toBe(1);
  await selfBtn.click();
  await otherBtn.click();
  await expect(off).toBeHidden({ timeout: 15000 });
  await expect(view.locator('.tu-col')).toHaveCount(7);
  const otherDay = (d) => Object.values(summary.days[d] || {}).reduce((s, v) => s + sumOf(v), 0);
  for (const c of await caps()) expect(c.total, c.day).toBe(C.formatShort(otherDay(c.day)));
  await expect(view.locator('.tu-legend-item .tu-legend-name')).toHaveText(['GPT-6.1', 'Sonnet 5.5']);
  await expect(view.locator('.tu-machine-note')).toHaveText(/^截至 \d{2}:\d{2}$/);
  await expect(view.locator('.tu-table-day')).toContainText(`· ${otherLabel}`);
  await expect(hero).toHaveText(C.formatShort(localTotal));
  await expect(otherBtn).toHaveAttribute('aria-label', new RegExp(`看 ${otherLabel} 的用量，数字截至`));
  await expect(otherBtn.locator('.tu-machine-dot')).toHaveAttribute('data-state', 'ok');
  await screenshot('dark-2-other');
  // 金额 too: the caps in the other machine's dollars, the hero in this machine's
  await view.locator('.tu-unit button[data-unit="usd"]').click();
  const otherUsd = (d) => Object.values(summary.costs[d]).reduce((s, v) => s + sumOf(v), 0);
  for (const c of await caps()) expect(c.total, c.day).toBe(C.formatUsd(otherUsd(c.day)));
  await view.locator('.tu-unit button[data-unit="tokens"]').click();

  // back to this machine
  await selfBtn.click();
  await expect(view.locator('.tu-machine-note')).toBeHidden();
  for (const c of await caps()) expect(c.total, c.day).toBe(local[c.day] ? C.formatShort(local[c.day]) : '');
  await expect(view.locator('.tu-table-day')).not.toContainText(`· ${otherLabel}`);

  // the same three in the light theme
  await page.evaluate(() => applyTheme('light'));
  await page.waitForTimeout(400);
  await screenshot('light-1-local');
  await otherBtn.click();
  await expect(view.locator('.tu-col')).toHaveCount(7);
  await screenshot('light-2-other');
  // the hub drops it again and the machine goes back to the old build: the last numbers go too
  version = '2.0.6'; heartbeat();
  delete store.data.history[F.USAGE_SESSION + '@dev-other'];
  await expect.poll(async () => (await page.evaluate(() => window.deck.tokenUsageMachines())).fleet.usage['dev-other'] ? 1 : 0, { timeout: 15000 }).toBe(0);
  await selfBtn.click();
  await otherBtn.click();
  await expect(off).toBeVisible({ timeout: 15000 });
  await expect(off).toHaveAttribute('data-state', 'old');
  await screenshot('light-3-other-missing');

  // opened again, the view starts on this machine
  await page.evaluate(() => { TaskBoardUI.open('board'); });
  await expect.poll(() => page.evaluate(() => { try { TaskBoardUI.open('tokens'); return TaskBoardUI.mode(); } catch (_) { return ''; } }), { timeout: 30000 }).toBe('tokens');
  await expect(selfBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(off).toBeHidden();
  expect(errors).toEqual([]);
  fs.rmSync(hubDir, { recursive: true, force: true });
});

test('without two-machine sync the other machine says sync is off', async () => {
  const { localTotal } = await launch({ fleet: null });
  const view = page.locator('#taskBoardView');
  await expect(view.locator('.tu-hero-num')).toHaveText(C.formatShort(localTotal), { timeout: 30000 });
  const otherBtn = view.locator(`.tu-machine button[data-platform="${OTHER}"]`);
  await expect(otherBtn).toBeVisible({ timeout: 15000 });
  await expect(otherBtn.locator('.tu-machine-dot')).toHaveAttribute('data-state', 'warn');
  await otherBtn.click();
  const off = view.locator('.tu-off');
  await expect(off).toHaveAttribute('data-state', 'unconfigured');
  await expect(off.locator('.tu-off-title')).toHaveText(`这台电脑没开两机同步，看不到 ${otherLabel} 的用量`);
  await expect(view.locator('.tu-col')).toHaveCount(0);
  await screenshot('dark-4-other-unconfigured');
  expect(errors).toEqual([]);
});
