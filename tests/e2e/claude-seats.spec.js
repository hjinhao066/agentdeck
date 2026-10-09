const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --quota-probe --token-saver --board-probe`;
let application, page, profile, home;
const cn = 'seat-captain';
async function closeApplication() {
  await closeElectron(application);
}
async function screenshot(name) {
  const dir = process.env.AGENTDECK_TEST_SCREENSHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
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
async function launch() {
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'config.json')));
  const captainId = saved.mainSession.colId;
  const promptCount = promptsFor(captainId).length;
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'), AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'), AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompt-columns.jsonl'), AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  const count = saved.columns.length;
  await page.waitForFunction(() => typeof columns !== 'undefined' && typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && columns.length > 0 && columns.every((col) => terms.get(col.id)?.wrap?.isConnected));
  await page.evaluate(() => columns.forEach((col) => ChatUI.setMode(col.id, 'chat')));
  await expect(page.locator('.column.chat-mode')).toHaveCount(count);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code|Codex CLI/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(count);
  await expect(page.locator('.claude-seat-rotate')).toBeEnabled({ timeout: 15000 });
  await expect.poll(() => promptsFor(captainId).slice(promptCount).some((p) => p.startsWith('你是 AgentDeck')), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.lastScreen.includes('> 你是 AgentDeck'), captainId), { timeout: 20000 }).toBe(true);
  await idle(captainId);
}
test.beforeEach(async ({}, testInfo) => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seats-e2e-')));
  home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}'); // stand-in credential existence only
  }
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"},"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.289"}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"},"hasCompletedOnboarding":true}');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    // Saved legacy profile; CN expects another address than its stand-in login, so it is on the wrong account.
    claudeSeats: require('../../claude-seats-core').normalize().slice(0, 2).map((s) => ({ ...s, email: s.id === 'us' ? 'us@example.test' : 'cn@example.com' })),
    perpetualCaptain: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [
      { id: cn, title: '队长', cmd: FAKE, cwd: profile, isMain: true, claudeSeatId: 'cn' },
      { id: 'seat-worker', title: 'Running worker', cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
    ],
    archived: [{ id: 'seat-legacy-archived', title: 'Legacy archived', cmd: FAKE, cwd: profile, archivedAt: 1 }],
    mainSession: { colId: cn, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
    captainRelayCodex: { name: 'ChatGPT', command: FAKE + ' --provider=codex --board-probe --archive-fail' },
  }));
  try {
    await launch();
  } catch (error) {
    const state = await page.evaluate(() => typeof terms === 'undefined' ? [] : [...terms].map(([id, e]) => ({
      id, screen: dumpScreen(e.term), lastScreen: e.lastScreen, state: e.state,
      alive: e.alive, sending: e.sendingPrompt, injecting: e.injecting,
      typing: e.typing, inputBox: visibleInputBox(e), composing: userComposing(id),
      turns: ChatUI.turnsOf(id),
    })));
    await testInfo.attach('seat-launch-state', { body: JSON.stringify({ state,
      prompts: capture('prompt-columns.jsonl') }, null, 2), contentType: 'application/json' });
    throw error;
  }
});
test.afterEach(async () => {
  if (page && !page.isClosed()) await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  if (application) await closeApplication();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test('fresh Captain receives its complete multiline briefing after input is ready', async () => {
  const expected = await page.evaluate(() => MainCore.instructions(env.platform));
  expect(promptsFor(cn)).toContain(expected);
});
test('rotation shows each seat\'s signed-in email and flags a wrong account; an unlogged seat cannot replace Captain', async () => {
  await page.locator('.claude-seat-rotate').click();
  // Seats are listed by the account signed in behind each directory, never by the fixed CN / US / US2.
  await expect(page.locator('#claudeSeatMenu .seat-current')).toHaveText('当前：cn');
  const wrong = '登成了 cn@example.test，应为 cn@example.com';
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="cn"] .seat-who')).toHaveText('cn@example.test · 当前');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="cn"]')).toHaveAttribute('title', 'cn@example.test · 席位 cn · ~/.claude · ' + wrong);
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="cn"] .seat-account.mismatch')).toHaveText(wrong + ' · 席位 cn');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"]')).toHaveAttribute('title', 'us@example.test · 席位 us · ~/.claude-us');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"] .seat-who')).toHaveText('us@example.test');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"] .seat-account.ok')).toHaveText('席位 us');
  // Nobody signed in, no account on record: 未登录, with the seat code and directory in the hover text.
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us2"] .seat-who')).toHaveText('未登录');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us2"] .seat-account')).toHaveText('席位 us2');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us2"]')).toHaveAttribute('title', /^未登录 · 席位 us2 · ~\/\.claude-us2 · /);
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us2"]')).toBeDisabled();
  await expect(page.locator('#claudeSeatMenu')).not.toContainText(/🇨🇳|🇺🇸|CN|US/);
  await screenshot('relay-cn-us-chatgpt');
  await page.locator('#claudeSeatMenu button[aria-label="关闭"]').click();
  fs.unlinkSync(path.join(home, '.claude-us', '.credentials.json'));
  await page.locator('.claude-seat-rotate').click();
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"]')).toBeDisabled();
  // Login lost, the directory still records whose it was: the row keeps the account and asks for a login.
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"] .seat-who')).toHaveText('us@example.test · 需登录');
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
});
test('rotation checkpoints first, retains workers/receipts, briefs continuation and pins new workers', async () => {
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'remember prior instruction', { guardUserInput: true }), cn);
  await expect.poll(() => page.evaluate((id) => ChatUI.turnsOf(id).some((t) => t.user === 'remember prior instruction'), cn), { timeout: 20000 }).toBe(true);
  await page.evaluate(() => {
    config.mainSession.tasks = [{ id: 'keep-task', colId: 'seat-worker', title: 'Keep running', status: 'working', gen: 1, startedAt: Date.now() }];
    config.mainSession.pending = [{ taskId: 'keep-task', colId: 'seat-worker', summary: 'keep receipt' }];
    flushConfig();
  });
  await page.locator('.claude-seat-rotate').click();
  await page.locator('#claudeSeatMenu [data-seat-id="us"]').click();
  await expect.poll(() => page.evaluate(() => config.activeClaudeSeatId)).toBe('us');
  const id = await page.evaluate(() => config.mainSession.colId);
  expect(id).not.toBe(cn);
  const board = path.join(home, '.agents', 'boards', 'agentdeck-captain-handoff.md');
  expect(fs.readFileSync(path.join(path.dirname(board), 'agentdeck-captain-handoff', 'tasks.md'), 'utf8')).toContain('Keep running');
  expect(fs.existsSync(path.join(profile, 'chats', cn + '.json'))).toBe(true);
  expect(await page.evaluate(() => columns.find((c) => c.id === 'seat-worker').claudeSeatId)).toBe('cn');
  expect(await page.evaluate(() => window.deck.ptyIsAlive('seat-worker'))).toBe(true);
  expect(await page.evaluate(() => config.mainSession.tasks.find((t) => t.id === 'keep-task').gen)).toBe(2);
  await expect.poll(() => capture('prompts.jsonl'), { timeout: 20000 }).toContain('读看板继续');
  const next = await page.evaluate((cmd) => createSession({ cmd, title: 'New Claude', cwd: config.columns[0].cwd }, true).id, FAKE);
  await expect.poll(() => capture('seat-env.jsonl'), { timeout: 20000 }).toContain(next);
  const records = fs.readFileSync(path.join(profile, 'seat-env.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(records.find((r) => r.colId === 'seat-worker').configDir).toBe(null);
  expect(records.find((r) => r.colId === id).configDir).toBe(path.join(home, '.claude-us'));
  expect(records.find((r) => r.colId === next).configDir).toBe(path.join(home, '.claude-us'));
  expect(records.every((r) => !r.authOverridePresent)).toBe(true);
  expect(capture('prompts.jsonl')).not.toContain('"/clear"');
  expect(records.filter((r) => r.colId === 'seat-worker')).toHaveLength(1);
  const restored = await page.evaluate(() => restoreArchived('seat-legacy-archived', false, true).id);
  expect(await page.evaluate((i) => columns.find((c) => c.id === i).claudeSeatId, restored)).toBe('cn');
  await expect.poll(() => capture('seat-env.jsonl'), { timeout: 20000 }).toContain(restored);
  expect(capture('seat-env.jsonl').trim().split('\n').map(JSON.parse).find((r) => r.colId === restored).configDir).toBe(null);
  await closeApplication(); application = null;
  await launch();
  expect(await page.evaluate(() => config.activeClaudeSeatId)).toBe('us');
  expect(await page.evaluate(() => columns.find((c) => c.id === 'seat-worker').claudeSeatId)).toBe('cn');
});
test('failed Relay archive acknowledgement preserves the original Captain', async () => {
  await expect.poll(() => page.evaluate(() => terms.get(config.mainSession.colId).state)).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf(config.mainSession.colId).every((t) => t.done))).toBe(true);
  await page.evaluate(() => { MainCore.ARCHIVE_PROMPT = 'invalid archive confirmation'; });
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  expect(await page.evaluate(() => window.deck.ptyIsAlive(config.mainSession.colId))).toBe(true);
  expect(capture('prompts.jsonl')).toContain('invalid archive confirmation');
  expect(capture('prompts.jsonl')).not.toContain('"/clear"');
});
test('cancelling Relay archive preserves the original Captain and never clears it', async () => {
  await expect.poll(() => page.evaluate(() => terms.get(config.mainSession.colId).state)).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf(config.mainSession.colId).every((t) => t.done))).toBe(true);
  await page.evaluate(() => {
    MainCore.ARCHIVE_PROMPT = 'keep working';
    window.relayResult = ClaudeSeats.switchSeat('us');
  });
  await page.locator('.captain-token-saving button').click();
  expect(await page.evaluate(() => window.relayResult)).toBe(false);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  expect(await page.evaluate(() => window.deck.ptyIsAlive(config.mainSession.colId))).toBe(true);
  expect(capture('prompts.jsonl')).not.toContain('"/clear"');
});
test('checkpoint write failure keeps the old Captain alive and selected', async () => {
  fs.writeFileSync(path.join(home, '.agents'), 'block checkpoint directory');
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  expect(await page.evaluate(() => [config.mainSession.colId, config.activeClaudeSeatId])).toEqual([cn, 'cn']);
  expect(await page.evaluate(() => window.deck.ptyIsAlive(config.mainSession.colId))).toBe(true);
});
test('Relay archive timeout preserves the original Captain', async () => {
  await expect.poll(() => page.evaluate(() => terms.get(config.mainSession.colId).state)).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf(config.mainSession.colId).every((t) => t.done))).toBe(true);
  await page.evaluate(() => {
    MainCore.ARCHIVE_PROMPT = 'keep working';
    const realTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 5 * 60_000 ? 2000 : ms, ...args);
  });
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  expect(await page.evaluate(() => window.deck.ptyIsAlive(config.mainSession.colId))).toBe(true);
  expect(capture('prompts.jsonl')).not.toContain('"/clear"');
});
test('unsent composer text is preserved and blocks rotation', async () => {
  const composer = page.locator(`.column[data-col-id="${cn}"] .composer textarea`);
  await composer.fill('half written instruction');
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  await expect(composer).toHaveValue('half written instruction');
});
test('quota banner switches once and preserves the interrupted Captain turn', async () => {
  // The banner only offers a seat whose account-bound quota is known, not a
  // logged-in placeholder with unknown availability. Match the Relay fixture.
  await page.evaluate(async () => {
    const info = (await ClaudeSeats.refresh()).find((seat) => seat.id === 'us'), now = Date.now();
    const configDir = config.claudeSeats.find((seat) => seat.id === 'us').configDir;
    config.quotas['Claude:us'] = { scope: 'claude', configDir, accountKey: info.accountKey,
      credentialKey: info.credentialKey, sample: {
        provider: 'Claude', scope: 'claude', accountBound: true, accountKey: info.accountKey, seatId: 'us',
        configDir, credentialKey: info.credentialKey, at: now,
        windows: [{ key: 'fiveHour', remaining: 80, resetAt: now + 3600000 },
          { key: 'weekly', remaining: 60, resetAt: now + 4 * 86400000 }],
      } };
    flushConfig();
  });
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'wait for quota', { guardUserInput: true }), cn);
  const banner = page.locator(`.column[data-col-id="${cn}"] .seat-quota-banner`);
  await expect(banner).toContainText('cn额度用尽，下一可用席位 us', { timeout: 20000 });   // account names, not CN / US
  await screenshot('quota-relay');
  await expect(banner.locator('button.quota-seat-action')).toBeEnabled();
  await banner.locator('button.quota-seat-action').click();
  await expect.poll(() => page.evaluate(() => config.activeClaudeSeatId)).toBe('us');
  const retired = JSON.parse(fs.readFileSync(path.join(profile, 'chats', cn + '.json')));
  expect(retired.captainArchive).toBe(true);
  expect(retired.turns.some((t) => t.user === 'wait for quota' && t.interrupted)).toBe(true);
});
test('settings rename all placeholders in one config and survive renderer reload', async () => {
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  const settings = page.locator('#claudeSeatSettings');
  await screenshot('seat-settings');
  await settings.locator('input').nth(0).fill('交班');
  await settings.locator('[data-seat-id="cn"] input').nth(0).fill('甲席');
  await settings.locator('[data-seat-id="us"] input').nth(0).fill('乙席');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator('.claude-seat-rotate')).toHaveAttribute('aria-label', '交班');
  await page.reload();
  await expect(page.locator('.claude-seat-rotate')).toBeEnabled({ timeout: 20000 });
  await page.locator('.claude-seat-rotate').click();
  // The lists go by account; the name given to a seat is its code, beside the id `--seat` takes.
  await expect(page.locator('#claudeSeatMenu .seat-current')).toHaveText('当前：cn');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="cn"] .seat-account')).toContainText('席位 甲席（cn）');
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="us"]')).toContainText('乙席');
  await page.locator('#claudeSeatMenu button[aria-label="关闭"]').click();
  await expect(page.locator('#claudeSeatMenu')).toBeHidden();
  const captain = page.locator(`.column[data-col-id="${cn}"]`);
  // The dialog's queued close event returns to the Captain's terminal.
  // Wait for that navigation before selecting chat, so it cannot undo it.
  await expect(captain).not.toHaveClass(/chat-mode/);
  await captain.locator('.view-toggle').click();
  const composer = captain.locator('.composer textarea');
  await expect(composer).toBeVisible();
  await composer.fill('keep draft');
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  await expect(page.locator('#toast')).toContainText('再交班');
});
test('seat settings keep the account each seat should hold and copy a login command pre-filled with it', async () => {
  // The sidebar row of a seat on the wrong account is red and says so.
  await expect(page.locator('#quotaBar [data-seat-id="cn"]')).toHaveAttribute('data-account', 'mismatch');
  await expect(page.locator('#quotaBar [data-seat-id="cn"]')).toHaveAttribute('aria-label', /登成了 cn@example\.test，应为 cn@example\.com/);
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('data-account', '');
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  const settings = page.locator('#claudeSeatSettings');
  // Each row is headed by the account signed in there; the seat code follows it.
  await expect(settings.locator('[data-seat-id="cn"] .seat-setting-head strong')).toHaveText('cn@example.test');
  await expect(settings.locator('[data-seat-id="cn"] .seat-account.mismatch')).toHaveText('登成了 cn@example.test，应为 cn@example.com · 席位 cn');
  await expect(settings.locator('[data-seat-id="us"] .seat-setting-head strong')).toHaveText('us@example.test');
  await expect(settings.locator('[data-seat-id="us"] .seat-setting-head strong')).toHaveAttribute('title', 'us@example.test · 席位 us · ~/.claude-us');
  await expect(settings.locator('[data-seat-id="us"] .seat-account.ok')).toHaveText('席位 us');
  await expect(settings.locator('[data-seat-id="us2"] .seat-setting-head strong')).toHaveText('未登录');
  await expect(settings.locator('[data-seat-id="us2"] .seat-account.login')).toHaveText('席位 us2');
  await expect(settings.locator('input[data-seat-email="cn"]')).toHaveValue('cn@example.com');
  await expect(settings.locator('input[data-seat-email="us2"]')).toHaveValue('');
  for (const [name, size, theme] of [['seat-email-tablet', [820, 1180], 'dark'], ['seat-email-desktop', [1440, 900], 'dark'], ['seat-email-desktop-light', [1440, 900], 'light']]) {
    await application.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), size);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.querySelector('#claudeSeatSettings [data-seat-id="cn"]').scrollIntoView({ block: 'start' }); }, theme);
    await screenshot(name);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const copy = settings.locator('[data-seat-id="cn"] .seat-login-copy');
  await expect(copy).toHaveAttribute('aria-label', '复制登录命令（应登录 cn@example.com）');
  await copy.click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toMatch(/claude auth login --email cn@example\.com$/);
  expect(await copy.innerHTML()).toContain("points=\"20 6 9 17 4 12\"");   // copied: a tick for a moment
  await expect(page.locator('#toast')).toContainText('授权页右上角的账号要是 cn@example.com');
  // An address typed but not yet saved is the one the command carries; a bad one is refused on save.
  await settings.locator('input[data-seat-email="us"]').fill('other@example.test');
  await settings.locator('[data-seat-id="us"] .seat-login-copy').click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toMatch(/claude auth login --email other@example\.test$/);
  await settings.locator('input[data-seat-email="us2"]').fill('not an email');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await expect(page.locator('#toast')).toContainText('应登录邮箱格式不对');
  await expect(settings).toBeVisible();
  await settings.locator('input[data-seat-email="us2"]').fill('');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await expect(settings).toBeHidden();
  expect(await page.evaluate(() => config.claudeSeats.map((s) => s.email))).toEqual(['cn@example.com', 'other@example.test', '']);
  // US now holds an account other than us@example.test: flagged on the next refresh, nothing signed out.
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('data-account', 'mismatch');
  expect(JSON.parse(fs.readFileSync(path.join(home, '.claude-us', '.claude.json'))).oauthAccount.emailAddress).toBe('us@example.test');
  expect(fs.existsSync(path.join(home, '.claude-us', '.credentials.json'))).toBe(true);
});
test('native usage observations stay in the producing seat directory', async () => {
  await page.evaluate((id) => {
    const entry = terms.get(id);
    ClaudeSeats.onTick(id, entry, 'Current session\n  40% used\n  Resets 5pm\nCurrent week (all models)\n  90% used\n  Resets Oct 8\n');
  }, cn);
  await expect.poll(() => page.evaluate(() => window.deck.claudeSeatUsage('cn'))).toMatchObject({ windows: [{ key: 'fiveHour', remaining: 60 }, { key: 'weekly', remaining: 10 }] });
  expect(await page.evaluate(() => window.deck.claudeSeatUsage('us'))).toBe(null);
  expect(fs.existsSync(path.join(home, '.claude', 'agentdeck-usage.json'))).toBe(true);
  expect(fs.existsSync(path.join(home, '.claude-us', 'agentdeck-usage.json'))).toBe(false);
});
test('terminal draft also blocks Relay without discarding typing', async () => {
  await page.evaluate((id) => ChatUI.setMode(id, 'term'), cn);
  await page.locator(`.column[data-col-id="${cn}"] .xterm-helper-textarea`).pressSequentially('half typed terminal input');
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(false);
  expect(await page.evaluate(() => config.mainSession.colId)).toBe(cn);
  expect(await page.evaluate((id) => terms.get(id).typing.draft, cn)).toContain('half typed terminal input');

});
test('ChatGPT Relay keeps Captain capabilities for ledger/new/tell/receipts and returns to CN', async () => {
  test.setTimeout(150000);   // the whole briefing is typed first, so the continuation note arrives later
  test.setTimeout(120000);
  await page.locator('.claude-seat-rotate').click();
  await expect(page.locator('#claudeSeatMenu button[data-seat-id="chatgpt"]')).toHaveAttribute('title', 'ChatGPT · Codex GPT-6.1 Sol');
  await page.locator('#claudeSeatMenu button[data-seat-id="chatgpt"]').click();
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 20000 }).toBe('chatgpt');
  const id = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => page.evaluate((i) => /Codex CLI/.test(terms.get(i)?.lastScreen || ''), id), { timeout: 20000 }).toBe(true);
  await expect.poll(() => promptsFor(id).some((p) => p.startsWith('你是刚接任的队长：') && p.includes('handoff') && p.includes('读看板继续')), { timeout: 60000 }).toBe(true);
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.lastScreen.includes('> 你是刚接任的队长：'), id), { timeout: 60000 }).toBe(true);
  async function board(args, expected) {
    await idle(id);
    await page.evaluate(([i, a]) => window.deck.ptyInput(i, 'BOARD ' + JSON.stringify(a) + '\r'), [id, args]);
    await expect.poll(() => page.evaluate((i) => dumpScreen(terms.get(i).term).replace(/\n/g, ''), id), { timeout: 20000 }).toContain(expected);
  }
  await board(['ledger'], 'Running worker');
  await board(['new', '--title', 'Codex delegated worker', '--task', 'finish small task', '--command', FAKE], '已开新会话');
  const child = await page.evaluate(() => columns.find((c) => c.displayTitle === 'Codex delegated worker').id);
  await expect.poll(() => page.evaluate((i) => config.mainSession.tasks.find((t) => t.colId === i)?.status, child), { timeout: 25000 }).toBe('done');
  await board(['receipts'], 'stand-in finished finish small task');
  await board(['tell', '--to', 'seat-worker', '--message', 'second task'], '已发给');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('seat-worker').some((t) => t.user === 'second task')), { timeout: 20000 }).toBe(true);
  await page.locator('.claude-seat-rotate').click();
  await expect(page.locator('#claudeSeatMenu')).toContainText('当前：ChatGPT');
  await screenshot('chatgpt-captain-relay');
  await page.locator('#claudeSeatMenu button[data-seat-id="cn"]').click();
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 20000 }).toBe('cn');
  expect(promptsFor(id).some((p) => p.startsWith('把当前进度写进'))).toBe(false);
  await expect.poll(() => page.evaluate(() => AgentInfo.resolveAgentInfo(MainSession.mainCol(), terms.get(config.mainSession.colId)).provider), { timeout: 20000 }).toBe('Claude');
});


test('sidebar account labels follow Captain Relay immediately while workers retain their seat and directory', async () => {
  test.setTimeout(150000);   // the 60 s default is less than the briefing poll below
  const captainFlag = () => page.locator('.captain-item .agent-seat-label');
  const workerFlag = page.locator('[data-col-id="seat-worker"] .agent-seat-label');
  // A session's seat is named by the account signed in behind it; the seat code and directory are in the hover text.
  await expect(captainFlag()).toHaveText('cn');
  await expect(workerFlag).toHaveText('cn');
  await expect(captainFlag()).toHaveAttribute('title', '当前账号：cn@example.test · 席位 cn · ~/.claude');
  await expect(captainFlag()).toHaveAttribute('aria-label', '当前账号：cn@example.test · 席位 cn · ~/.claude');
  await page.evaluate(() => window.deck.ptyInput(config.mainSession.colId, '/model Opus 5.5\r'));
  await expect(page.locator('.captain-item .agent-model-label')).toHaveText('Opus 5.5');
  await idle(cn);
  const before = fs.readFileSync(path.join(home, '.claude/.credentials.json'), 'utf8');
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(true);
  await expect(captainFlag()).toHaveText('us');
  await expect(captainFlag()).toHaveAttribute('title', '当前账号：us@example.test · 席位 us · ~/.claude-us');
  await expect(workerFlag).toHaveText('cn');
  expect(await page.evaluate(() => columns.find(c => c.id === 'seat-worker').claudeConfigDir)).toBe('~/.claude');
  expect(await page.evaluate(() => window.deck.ptyIsAlive('seat-worker'))).toBe(true);
  expect(capture('seat-env.jsonl').trim().split('\n').map(JSON.parse).filter(r => r.colId === 'seat-worker')).toHaveLength(1);
  expect(fs.readFileSync(path.join(home, '.claude/.credentials.json'), 'utf8')).toBe(before);
  // The new seat must finish its continuation briefing before a direct TUI
  // command; otherwise readline batches /model into that first prompt.
  const fresh = await page.evaluate(() => config.mainSession.colId);
  // The whole briefing (not a file pointer) is typed into the line-reading stand-in first, so the note follows later.
  await expect.poll(() => promptsFor(fresh).some(p => p.startsWith('你是刚接任的队长：')), { timeout: 60000 }).toBe(true);
  await idle(fresh);
  await page.evaluate(() => { window.deck.ptyInput(config.mainSession.colId, '/model Opus 5.5\r'); window.deck.ptyInput('seat-worker', '/model Opus 5.5\r'); });
  await expect(page.locator('.captain-item .agent-model-label')).toHaveText('Opus 5.5');
  await expect(page.locator('.colnav-item[data-col-id="seat-worker"] .agent-model-label')).toHaveText('Opus 5.5');
  await captainFlag().focus();
  await screenshot('seat-flags-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await screenshot('seat-flags-light');
  // Reopening a worker after a directory edit must retain its original login.
  const id = await page.evaluate(() => {
    config.claudeSeats.find(s => s.id === 'cn').configDir = '~/.claude-new';
    return respawnColumn(columns.find(c => c.id === 'seat-worker')).id;
  });
  await expect.poll(() => capture('seat-env.jsonl')).toContain(id);
  expect(capture('seat-env.jsonl').trim().split('\n').map(JSON.parse).find(r => r.colId === id).configDir).toBe(null);
  await expect(page.locator(`[data-col-id="${id}"] .agent-seat-label`)).toHaveAttribute('title', '当前账号：cn@example.test · 席位 cn · ~/.claude');
});

test('US2 is migrated into settings and quota, then new --seat and Relay use its isolated login', async () => {
  const row = page.locator('#quotaBar [data-seat-id="us2"]');
  // Nobody is signed in to US2 yet: the row says so, with the seat code and directory in its detail.
  await expect(row.locator('.quota-name')).toHaveText('未登录');
  await expect(row.getByRole('tooltip', { includeHidden: true })).toContainText(/席位us2.*目录~\/\.claude-us2/);
  await expect(page.locator('#quotaBar [data-seat-id="us"] .quota-name')).toHaveText('us');
  await expect(page.locator('#quotaBar [data-seat-id="cn"] .quota-name')).toHaveText('cn');
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  await expect(page.locator('#claudeSeatSettings [data-seat-id="us2"] input').nth(0)).toHaveValue('US2');
  await expect(page.locator('#claudeSeatSettings [data-seat-id="us2"] input').nth(2)).toHaveValue('~/.claude-us2');
  await page.locator('#claudeSeatSettings button[aria-label="关闭"]').click();
  async function board(args, text) {
    await idle(cn);
    await page.evaluate(([id, command]) => window.deck.ptyInput(id, 'BOARD ' + JSON.stringify(command) + '\r'), [cn, args]);
    await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term).replace(/\n/g, ''), cn), { timeout: 20000 }).toContain(text);
  }
  await board(['quota'], '未登录（席位 us2）');
  await board(['new', '--title', 'US2 not logged', '--task', 'finish', '--seat', 'us2', '--command', FAKE], 'US2 未登录');
  // An account no directory holds: refused, with every directory and its account, nothing opened.
  await idle(cn);
  await page.evaluate(([id, command]) => window.deck.ptyInput(id, 'BOARD ' + JSON.stringify(command) + '\r'), [cn, ['new', '--title', 'Nobody there', '--task', 'finish', '--seat', 'nobody.here', '--command', FAKE]]);
  // The terminal wraps the line wherever it is full (a wide character can leave a gap): compare without spaces.
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term).replace(/\s/g, ''), cn), { timeout: 20000 }).toContain('没有哪个目录登着这个账号，没有派。当前各目录登录的账号：cn→cn；us→us；us2→未登录。');
  expect(await page.evaluate(() => columns.some((c) => c.displayTitle === 'Nobody there'))).toBe(false);
  expect(await page.evaluate(() => columns.some((c) => c.displayTitle === 'US2 not logged'))).toBe(false);
  const dir = path.join(home, '.claude-us2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}'); // fake isolated login
  // The paid account signs in here: the plan is read from the directory's own account record.
  fs.writeFileSync(path.join(dir, '.claude.json'), '{"oauthAccount":{"emailAddress":"paid.account2@example.test","organizationType":"claude_max","organizationRateLimitTier":"default_claude_max_20x"}}');
  require('../../claude-seats-main').writeUsage({ id: 'us2', configDir: '~/.claude-us2' }, home, { at: Date.now(), windows: [
    { key: 'fiveHour', remaining: 100, resetText: 'in 1h' }, { key: 'weekly', remaining: 100, resetText: 'in 4d' },
  ] });
  await page.evaluate(() => ClaudeSeats.refresh());
  // The row now goes by that account, with the Max gem; the other accounts carry none.
  await expect(row.locator('.seat-acct')).toHaveText('paid.account2');
  await expect(row.locator('.quota-icon .quota-plan svg')).toBeVisible();   // the Max gem, on the row's lead icon
  await expect(page.locator('#quotaBar [data-seat-id="us"] .quota-plan')).toHaveCount(0);
  await expect(row.getByRole('tooltip', { includeHidden: true })).toContainText(/账号paid\.account2@example\.test.*套餐Max 20x.*席位us2.*目录~\/\.claude-us2/);
  await expect(row).toHaveAttribute('aria-label', /^paid\.account2 Max 20x：/);
  await board(['quota'], '（Max 20x）');
  expect(await page.evaluate((id) => dumpScreen(terms.get(id).term).replace(/\s/g, ''), cn)).toContain('账号：paid.account2@example.test（Max20x）');
  await board(['new', '--title', 'US2 startup input', '--task', 'input is ready', '--seat', 'us2', '--command', `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --onboarding-probe`], '已开新会话');
  const startupWorker = await page.evaluate(() => columns.find((c) => c.displayTitle === 'US2 startup input').id);
  await expect.poll(() => capture('prompt-columns.jsonl')).toContain('input is ready');
  await expect.poll(() => page.evaluate((id) => (terms.get(id)?.lastScreen || '').includes('Claude Code startup input ready'), startupWorker)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))).toMatchObject({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.289' });
  const stillCaptain = await page.evaluate(async () => {
    const infos = await ClaudeSeats.refresh(), now = Date.now();
    config.perpetualCaptain = { enabled: true, threshold: 3, preferEarlier: false };
    for (const info of infos) config.quotas[QuotaCore.seatKey(info.id)] = { sample: {
      provider: 'Claude', scope: 'claude', official: true, seatId: info.id,
      configDir: info.configDir, credentialKey: info.credentialKey, at: now,
      windows: [{ key: 'fiveHour', remaining: info.id === 'us2' ? 80 : 2, resetAt: now + 3600000 },
        { key: 'weekly', remaining: 60, resetAt: now + 7 * 86400000 }],
    } };
    const id = config.mainSession.colId;
    const unfinished = terms.get(columns.find((col) => col.displayTitle === 'US2 startup input').id);
    unfinished.lastScreen = 'Claude Code\nSelect login method\n❯ 1. Claude account with subscription';
    unfinished.state = 'input';
    ClaudeSeats.onTick(id, terms.get(id), '');
    return MainSession.mainCol().claudeSeatId;
  });
  expect(stillCaptain).toBe('cn');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => MainSession.mainCol().claudeSeatId)).toBe('cn');
  const worker = startupWorker;
  await expect.poll(() => capture('seat-env.jsonl')).toContain(worker);
  expect(capture('seat-env.jsonl').trim().split('\n').map(JSON.parse).find((r) => r.colId === worker)).toMatchObject({ configDir: dir, authOverridePresent: false });
  await page.evaluate(() => { config.crewOpen = true; Sidebar.render(); });
  await expect(page.locator('.nav-crew .crew-model-flag[aria-label^="当前账号：paid.account2@example.test · 套餐 Max 20x · 席位 us2"]')).toHaveText('paid.account2');
  await board(['ledger'], '（us2）');
  expect(await page.evaluate((id) => dumpScreen(terms.get(id).term).replace(/\s/g, ''), cn)).toContain('账号:paid.account2（us2）');
  await idle(cn);
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us2'))).toBe(true);
  await expect(page.locator('.captain-item .agent-seat-label')).toHaveText('paid.account2');
  // The row 队长 is on leads with the crown; the Max gem stays with the account.
  await expect(row.locator('.quota-icon.quota-captain > svg')).toBeVisible();
  await expect(row.locator('.quota-name')).toHaveText('paid.account2');
  await expect(row.locator('.quota-icon.quota-captain .quota-plan svg')).toBeVisible();
  await expect(page.locator('#quotaBar [data-seat-id="cn"] .quota-captain')).toHaveCount(0);
  const id = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => capture('seat-env.jsonl')).toContain(id);
  expect(capture('seat-env.jsonl').trim().split('\n').map(JSON.parse).find((r) => r.colId === id).configDir).toBe(dir);
  for (const width of [200, 252]) {
    await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); }, width);
    // .quota-values is display:contents in the compact panel, so it has no box.
    // Measure the first value cell, which is what must sit to the right of the name.
    const geometry = await row.evaluate((e) => ({ scroll: e.scrollWidth, width: e.clientWidth, values: e.querySelector('.quota-cell, .quota-status').getBoundingClientRect().left, name: e.querySelector('.quota-name').getBoundingClientRect().right }));
    expect(await page.locator('.captain-item').evaluate((e) => e.querySelector('.agent-seat-label').getBoundingClientRect().right <= e.querySelector('.claude-seat-rotate').getBoundingClientRect().left)).toBe(true);
    await screenshot(`us2-quota-width-${width}`);
    expect(geometry.scroll <= geometry.width && geometry.values >= geometry.name, JSON.stringify({ width, geometry })).toBe(true);
  }
  await screenshot('us2-seat-quota-and-sidebar');
  // 队长 can name the account instead of the directory: the session lands in the directory that holds it now.
  await idle(id);
  await page.evaluate(([c, command]) => window.deck.ptyInput(c, 'BOARD ' + JSON.stringify(command) + '\r'), [id, ['new', '--title', 'By account name', '--task', 'go', '--seat', 'paid.account2', '--command', FAKE]]);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.displayTitle === 'By account name')?.claudeSeatId), { timeout: 20000 }).toBe('us2');
  expect(await page.evaluate(() => columns.find((c) => c.displayTitle === 'By account name').claudeConfigDir)).toBe('~/.claude-us2');
});
