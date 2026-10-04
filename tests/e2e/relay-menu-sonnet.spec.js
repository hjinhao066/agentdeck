const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --quota-probe --token-saver`;
const SHOTS = '/Users/jinhao/reports/agentdeck-relay-menu';
let application, page, profile, home;
const cn = 'seat-captain';
function capture(name) {
  try { return fs.readFileSync(path.join(profile, name), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
function promptsFor(id) {
  return capture('prompt-columns.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.colId === id).map((r) => r.text);
}
async function idle(id) {
  await expect.poll(() => page.evaluate((i) => { const e = terms.get(i); return e?.state === 'done' && !e.sendingPrompt && !e.injecting && ChatUI.turnsOf(i).every((t) => t.kind === 'task' || t.done); }, id), { timeout: 20000 }).toBe(true);
}
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function launch() {
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'config.json')));
  const captainId = saved.mainSession.colId;
  const promptCount = promptsFor(captainId).length;
  const env = { ...process.env, AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'), AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'), AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompt-columns.jsonl'), AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    args: [path.resolve(__dirname, '../..'), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column.chat-mode')).toHaveCount(saved.columns.length);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code|Codex CLI/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(saved.columns.length);
  await expect(page.locator('.claude-seat-rotate')).toBeEnabled({ timeout: 15000 });
  await expect.poll(() => promptsFor(captainId).slice(promptCount).some((p) => p.startsWith('你是 AgentDeck')), { timeout: 20000 }).toBe(true);
  await idle(captainId);
}
test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-menu-')));
  home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"}}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"}}');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [
      { id: cn, title: '队长', cmd: FAKE, cwd: profile, isMain: true, claudeSeatId: 'cn' },
      { id: 'seat-worker', title: 'Running worker', cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
    ],
    mainSession: { colId: cn, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
    captainRelayCodex: { name: 'ChatGPT', command: FAKE + ' --provider=codex --board-probe' },
  }));
  await launch();
});
test.afterEach(async () => {
  if (page && !page.isClosed()) await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())).catch(() => {});
  if (application) {
    const app = application;
    application = null;
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8000))]);
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('Relay menu starts Sonnet on the chosen seat, then Opus on the way back', async () => {
  test.setTimeout(120000);
  await page.locator('.claude-seat-rotate').click();
  const menu = page.locator('#claudeSeatMenu');
  await expect(menu).toContainText('当前：CN · Opus 5.5');
  await expect(menu.locator('[data-relay-seat="cn"][data-relay-model="sonnet"]')).toContainText('CN · Sonnet 5.5');
  await expect(menu.locator('[data-relay-seat="us"][data-relay-model="sonnet"]')).toContainText('US · Sonnet 5.5');
  await expect(menu.locator('button[data-seat-id="cn"]')).toBeDisabled();
  await shot('relay-menu-sonnet-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('relay-menu-sonnet-light');
  await page.evaluate(() => applyTheme('dark'));
  await page.locator('#claudeSeatMenu button[aria-label="关闭"]').click();
  await idle(cn);
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'wait for quota', { guardUserInput: true }), cn);
  await expect(page.locator(`.column[data-col-id="${cn}"] .seat-quota-banner`)).toContainText('CN额度用尽', { timeout: 20000 });
  await page.locator('.claude-seat-rotate').click();
  await menu.locator('[data-relay-seat="us"][data-relay-model="sonnet"]').click();
  await expect.poll(() => page.evaluate(() => config.activeClaudeSeatId), { timeout: 20000 }).toBe('us');
  const sonnetId = await page.evaluate(() => config.mainSession.colId);
  expect(sonnetId).not.toBe(cn);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.isMain).cmd)).toContain('claude-sonnet-5-5');
  await expect.poll(() => promptsFor(sonnetId).some((p) => p.includes('读看板继续')), { timeout: 20000 }).toBe(true);
  const records = () => capture('seat-env.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse);
  await expect.poll(() => records().some((r) => r.colId === sonnetId)).toBe(true);
  expect(records().find((r) => r.colId === sonnetId).configDir).toBe(path.join(home, '.claude-us'));
  const retired = JSON.parse(fs.readFileSync(path.join(profile, 'chats', cn + '.json')));
  expect(retired.captainArchive).toBe(true);
  expect(retired.turns.some((t) => t.user === 'wait for quota' && t.interrupted)).toBe(true);
  await idle(sonnetId);
  await page.locator('.claude-seat-rotate').click();
  await expect(menu).toContainText('当前：US · Sonnet 5.5');
  await menu.locator('button[data-seat-id="cn"][data-relay-model="opus"]').click();
  await expect.poll(() => page.evaluate(() => config.activeClaudeSeatId), { timeout: 20000 }).toBe('cn');
  const opusId = await page.evaluate(() => config.mainSession.colId);
  expect(opusId).not.toBe(sonnetId);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.isMain).cmd)).toContain('claude-opus-5-5');
  expect(await page.evaluate(() => columns.find((c) => c.isMain).cmd)).not.toContain('claude-sonnet-5-5');
  await expect.poll(() => records().some((r) => r.colId === opusId)).toBe(true);
  expect(records().find((r) => r.colId === opusId).configDir).toBe(null);
  await expect.poll(() => promptsFor(opusId).some((p) => p.includes('读看板继续')), { timeout: 20000 }).toBe(true);
});
test('an unsent draft still blocks a Sonnet Relay', async () => {
  const composer = page.locator(`.column[data-col-id="${cn}"] .composer textarea`);
  await composer.fill('half written instruction');
  await page.locator('.claude-seat-rotate').click();
  await page.locator('#claudeSeatMenu [data-relay-seat="us"][data-relay-model="sonnet"]').click();
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  await expect(composer).toHaveValue('half written instruction');
  await expect(page.locator('#toast')).toContainText('再Relay');
});
test('quota banner follows the next captain and stops when every captain is exhausted', async () => {
  test.setTimeout(90000);
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'wait for quota', { guardUserInput: true }), cn);
  const banner = page.locator(`.column[data-col-id="${cn}"] .seat-quota-banner`);
  await expect(banner).toContainText('CN额度用尽', { timeout: 20000 });
  await expect(banner.getByRole('button', { name: '切到 🇺🇸 US' })).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  await shot('quota-banner-next-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('quota-banner-next-light');
  await page.evaluate(() => applyTheme('dark'));
  await page.evaluate(() => {
    const now = Date.now();
    const seat = config.claudeSeats.find((s) => s.id === 'us');
    QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: 'us', configDir: seat.configDir, at: now, source: '会话屏幕', windows: [], exhausted: true, resetAt: now + 3600000, sourceColumnId: 'banner-test' }, now);
    const id = config.mainSession.colId;
    ClaudeSeats.onTick(id, terms.get(id), terms.get(id).lastScreen || '');
  });
  await expect(banner.getByRole('button', { name: '切到 ChatGPT' })).toBeVisible();
  await expect(banner.getByRole('button', { name: '切到 🇺🇸 US' })).toHaveCount(0);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  await page.evaluate(() => {
    const now = Date.now();
    QuotaCore.observe(config.quotas, { provider: 'Codex', scope: 'codex', at: now, source: '会话屏幕', windows: [], exhausted: true, resetAt: now + 3600000 }, now);
    const id = config.mainSession.colId;
    ClaudeSeats.onTick(id, terms.get(id), terms.get(id).lastScreen || '');
  });
  await expect(banner).toContainText('队长额度都用尽了');
  await expect(banner.locator('button')).toHaveCount(0);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  await shot('quota-banner-exhausted-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('quota-banner-exhausted-light');
});
test('the updated banner button hands off to Codex instead of the exhausted seat', async () => {
  test.setTimeout(90000);
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'wait for quota', { guardUserInput: true }), cn);
  const banner = page.locator(`.column[data-col-id="${cn}"] .seat-quota-banner`);
  await expect(banner.getByRole('button', { name: '切到 🇺🇸 US' })).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    const now = Date.now();
    const seat = config.claudeSeats.find((s) => s.id === 'us');
    QuotaCore.observe(config.quotas, { provider: 'Claude', scope: 'claude', seatId: 'us', configDir: seat.configDir, at: now, source: '会话屏幕', windows: [], exhausted: true, resetAt: now + 3600000, sourceColumnId: 'banner-test' }, now);
    const id = config.mainSession.colId;
    ClaudeSeats.onTick(id, terms.get(id), terms.get(id).lastScreen || '');
  });
  await banner.getByRole('button', { name: '切到 ChatGPT' }).click();
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 20000 }).toBe('chatgpt');
  const id = await page.evaluate(() => config.mainSession.colId);
  expect(id).not.toBe(cn);
  await expect.poll(() => page.evaluate((i) => columns.find((c) => c.id === i).cmd.includes('--provider=codex'), id)).toBe(true);
  await expect.poll(() => promptsFor(id).some((p) => p.includes('读看板继续')), { timeout: 20000 }).toBe(true);
});
