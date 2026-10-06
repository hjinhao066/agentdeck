const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

// Switching the Captain's account from the phone, end to end: the real mobile
// web service and the real desktop switch inside an isolated AgentDeck profile,
// with stand-in agents and stand-in logins. Nothing here touches the user's
// running AgentDeck, its Captain, its accounts or the shared boards.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --quota-probe --token-saver --board-probe`;
const CAPTAIN = 'relay-captain';
let application, desktop, browser, mobile, profile, home, url, token;

const capture = (name) => { try { return fs.readFileSync(path.join(profile, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
const seatEnv = () => capture('seat-env.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse);
const relayState = async () => (await mobile.request.get(url + '/api/relay')).json();
async function post(route, data) {
  const { csrfToken } = await (await mobile.request.get(url + '/api/auth')).json();
  return mobile.request.post(url + route, { data, headers: { Origin: url, 'X-CSRF-Token': csrfToken } });
}
async function screenshot(name) {
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (!process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await mobile.screenshot({ path: path.join(dir, name + '.png'), animations: 'disabled' });
}
// Tool actions are icon-only with a tooltip and a name; worded actions are the main ones. Everything is at least 44px tall.
async function auditSheet() {
  const buttons = await mobile.locator('#switch-sheet button').evaluateAll((elements) => elements.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { icon: button.classList.contains('icon-button'), text: button.textContent.trim(), label: button.getAttribute('aria-label'), title: button.title, width: bounds.width, height: bounds.height };
  }));
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.height, JSON.stringify(button)).toBeGreaterThanOrEqual(44);
    expect(button.text, JSON.stringify(button)).not.toMatch(/^(复制|删除|编辑|刷新|设置|关闭|返回)$/);
    if (button.icon) { expect(button.text).toBe(''); expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy(); expect(button.width).toBeGreaterThanOrEqual(44); }
  }
  expect(await mobile.locator('#switch-sheet').evaluate((el) => el.innerText)).not.toMatch(/relay|seat|席位/i);
}
const sheet = () => mobile.locator('#switch-sheet');
const option = (id) => sheet().locator(`.seat-option[data-seat-id="${id}"]`);
const idle = () => expect.poll(() => desktop.evaluate(() => { const e = terms.get(config.mainSession.colId); return e?.state === 'done' && !e.sendingPrompt && !e.injecting && ChatUI.turnsOf(config.mainSession.colId).every((t) => t.kind === 'task' || t.done); }), { timeout: 25000 }).toBe(true);

test.beforeEach(async ({}, testInfo) => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-switch-e2e-')));
  home = path.join(profile, 'seats-home');
  // CN and US have a stand-in login; US2 has none.
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"},"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.289"}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"},"hasCompletedOnboarding":true}');
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false }, theme: testInfo.title.includes('(light)') ? 'light' : 'dark', fitWindow: true, fitCols: 2,
    mobileWeb: { enabled: true, port, token },
    columns: [{ id: CAPTAIN, title: '队长', cmd: FAKE, cwd: profile, isMain: true, claudeSeatId: 'cn' }],
    mainSession: { colId: CAPTAIN, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
    captainRelayCodex: { name: 'ChatGPT', command: FAKE + ' --provider=codex' },
  }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', CAPTAIN + '.json'), JSON.stringify({ v: 1, id: CAPTAIN, turns: [
    { id: 'old-turn', ts: Date.now() - 60_000, user: '出门前把进度记一下。', reply: '原队长测试回复：进度已经记在看板上。', done: true, atts: [] }] }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'),
    AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'), AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompt-columns.jsonl') };
  // The stand-in app must never report to, or act as, the AgentDeck that runs this test.
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await desktop.evaluate(() => columns.forEach((col) => ChatUI.setMode(col.id, 'chat')));
  await expect.poll(() => capture('prompts.jsonl').includes('你是 AgentDeck'), { timeout: 25000 }).toBe(true);
  await idle();
  const status = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(status.enabled).toBe(true);
  url = status.url;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: testInfo.title.includes('(light)') ? 'light' : 'dark' });
  mobile = await context.newPage();
  await mobile.goto(url);
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('原队长测试回复', { timeout: 15000 });
});
test.afterEach(async () => {
  if (browser) await browser.close(); browser = null;
  if (application) await closeElectron(application); application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true }); profile = null;
});

for (const theme of ['dark', 'light']) {
  test(`from the phone the Captain really moves to another account and the conversation follows the new Captain (${theme})`, async () => {
    test.setTimeout(150000);
    await expect(mobile.locator('html')).toHaveAttribute('data-theme', theme);
    // The computer's own account list: masked accounts, the one in use, the one that was never logged in.
    const before = await relayState();
    expect([before.captainId, before.currentId, before.switching, before.job]).toEqual([CAPTAIN, 'cn', false, null]);
    expect(before.seats.map((s) => [s.id, s.provider, s.account, s.current, s.selectable, s.reason])).toEqual([
      ['cn', 'Claude', 'c***@example.test', true, false, 'current'], ['us', 'Claude', 'u***@example.test', false, true, 'unknown'],
      ['us2', 'Claude', '', false, false, 'login'], ['chatgpt', 'Codex', '', false, true, '']]);
    expect(JSON.stringify(before)).not.toMatch(/seats-home|configDir|\.claude|credential|cn@|us@/);

    // Ways in: next to the quota rows in the sidebar, and in "more".
    await mobile.getByRole('button', { name: '打开侧边栏', exact: true }).click();
    const entry = mobile.locator('#quota-switch');
    await expect(entry).toHaveText('切换队长');
    expect((await entry.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await mobile.locator('#drawer-close').click();
    await mobile.locator('#tabbar').getByRole('button', { name: '更多' }).click();
    await expect(mobile.locator('#switch-entry')).toContainText('切换队长');
    await expect(mobile.locator('#switch-entry-text')).toHaveText('Claude CN');
    await screenshot(`single-switch-${theme}-1-before`);
    await mobile.locator('#switch-entry').click();

    await expect(sheet()).toBeVisible();
    expect(await sheet().evaluate((el) => el.matches(':modal'))).toBe(true);
    await expect(sheet().getByRole('heading')).toHaveText('切换队长');
    await expect(sheet()).toContainText('队长现在用的是 Claude CN，要换到哪个账号？');
    await expect(sheet().locator('.seat-name')).toHaveText(['Claude CN', 'Claude US', 'Claude US2', 'ChatGPT']);
    await expect(option('cn')).toContainText('队长在用');
    await expect(option('cn')).toHaveAttribute('aria-disabled', 'true');
    await expect(option('us')).toContainText('u***@example.test');
    await expect(option('us')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(option('us2')).toHaveAttribute('aria-disabled', 'true');
    await expect(option('us2').locator('.seat-reason')).toHaveText('还没登录。要回到电脑上登录后才能用');
    await auditSheet();
    await screenshot(`single-switch-${theme}-2-pick`);
    // The account without a login does nothing when tapped.
    await option('us2').click({ force: true });
    await option('us2').focus(); await mobile.keyboard.press('Enter');
    await expect(sheet().getByRole('heading')).toHaveText('切换队长');

    await option('us').click();
    await expect(sheet().getByRole('heading')).toHaveText('确认切换队长？');
    await expect(sheet().locator('.sheet-route')).toHaveAttribute('aria-label', '从 Claude CN 换到 Claude US');
    await expect(sheet()).toContainText('它没存下来的内容会丢');
    await auditSheet();
    await screenshot(`single-switch-${theme}-3-confirm`);
    // Nothing has happened on the desktop yet.
    expect(await desktop.evaluate(() => config.mainSession.colId)).toBe(CAPTAIN);
    expect((await relayState()).job).toBe(null);
    await sheet().getByRole('button', { name: '确认切换', exact: true }).click();

    await expect(sheet().getByRole('heading')).toHaveText(/^(正在切换队长|已换到 Claude US)$/);
    if (await sheet().locator('#switch-elapsed').count()) await screenshot(`single-switch-${theme}-4-switching`);
    await expect(sheet().getByRole('heading')).toHaveText('已换到 Claude US', { timeout: 90000 });
    await auditSheet();
    await screenshot(`single-switch-${theme}-5-done`);

    // The desktop really switched: a new Captain column on the US login, the old chat kept, the handoff written.
    const after = await relayState();
    expect([after.currentId, after.switching, after.job.status, after.job.fromId, after.job.targetId, after.job.error]).toEqual(['us', false, 'done', 'cn', 'us', '']);
    const captainId = await desktop.evaluate(() => config.mainSession.colId);
    expect(captainId).not.toBe(CAPTAIN);
    expect(after.captainId).toBe(captainId);
    expect(await desktop.evaluate(() => config.activeClaudeSeatId)).toBe('us');
    await expect.poll(() => seatEnv().find((r) => r.colId === captainId)?.configDir, { timeout: 20000 }).toBe(path.join(home, '.claude-us'));
    expect(fs.existsSync(path.join(profile, 'chats', CAPTAIN + '.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'boards', 'agentdeck-captain-handoff.md'))).toBe(true);
    await expect.poll(() => capture('prompts.jsonl'), { timeout: 25000 }).toContain('读看板继续');

    // Back in the conversation the phone is on the new Captain without a reload.
    await sheet().getByRole('button', { name: '回到对话', exact: true }).click();
    await expect(sheet()).toBeHidden();
    await expect(mobile.locator('#captain-view')).toBeVisible();
    await expect.poll(async () => (await (await mobile.request.get(url + '/api/captain')).json()).id, { timeout: 15000 }).toBe(captainId);
    await expect(mobile.locator('#captain-turns')).not.toContainText('原队长测试回复', { timeout: 15000 });
    await mobile.locator('#tabbar').getByRole('button', { name: '更多' }).click();
    await expect(mobile.locator('#switch-entry-text')).toHaveText('Claude US', { timeout: 15000 });
    // A message from the phone reaches the new Captain.
    await mobile.locator('#tabbar').getByRole('button', { name: '对话' }).click();
    await idle();
    await mobile.getByLabel('给队长的消息').fill('新队长收到了吗');
    await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
    await expect.poll(() => capture('prompt-columns.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse).filter((p) => p.text === '新队长收到了吗').map((p) => p.colId), { timeout: 30000 }).toEqual([captainId]);
    await screenshot(`single-switch-${theme}-6-new-captain`);
  });
}

test('a switch the desktop cannot do fails in plain words and the original Captain stays', async () => {
  test.setTimeout(120000);
  // An unsent draft sits in the Captain's input box on the desktop.
  const composer = desktop.locator('.column.is-main .composer textarea');
  await composer.fill('桌面上还没发出去的草稿');
  await mobile.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  await mobile.locator('#quota-switch').click();
  await expect(mobile.locator('#drawer')).toBeHidden();
  await option('us').click();
  await sheet().getByRole('button', { name: '确认切换', exact: true }).click();
  await expect(sheet().getByRole('heading')).toHaveText('队长没有换成', { timeout: 30000 });
  await expect(sheet().getByRole('alert')).toHaveText('电脑上队长的输入框里还有没发出去的内容，要先在电脑上发出或清空');
  await expect(sheet()).toContainText('队长现在用的还是 Claude CN，没有变化。');
  await auditSheet();
  await screenshot('single-switch-dark-7-failed');
  const state = await relayState();
  expect([state.captainId, state.currentId, state.job.status, state.job.targetId]).toEqual([CAPTAIN, 'cn', 'failed', 'us']);
  expect(await desktop.evaluate(() => config.mainSession.colId)).toBe(CAPTAIN);
  expect(await desktop.evaluate((id) => window.deck.ptyIsAlive(id), CAPTAIN)).toBe(true);
  await expect(composer).toHaveValue('桌面上还没发出去的草稿');
  await expect(mobile.locator('#captain-turns')).toContainText('原队长测试回复');

  // Asked for directly, the computer still refuses what the sheet would not offer; nothing changes.
  const refusals = [
    [{ seatId: 'us2' }, '这个账号还没登录，要回电脑上登录'], [{ seatId: 'cn' }, '队长已经在这个账号上了'], [{ seatId: 'nope' }, '这台电脑上没有这个账号'],
    [{ seatId: 'us', expectCurrent: 'us2' }, '队长已经不在你看到的那个账号上了，请看最新状态后再选']];
  for (const [body, reason] of refusals) {
    const response = await post('/api/relay', body);
    expect([response.status(), await response.json()], JSON.stringify(body)).toEqual([409, { started: false, error: reason }]);
  }
  expect((await post('/api/relay', { seatId: 'us', command: 'x' })).status()).toBe(400);
  expect((await mobile.request.post(url + '/api/relay', { data: { seatId: 'us' }, headers: { Origin: url } })).status()).toBe(403);
  expect((await relayState()).currentId).toBe('cn');
  expect(await desktop.evaluate(() => config.mainSession.colId)).toBe(CAPTAIN);
  expect(seatEnv().filter((r) => r.configDir === path.join(home, '.claude-us'))).toEqual([]);

  // Once the draft is gone the same switch goes through, and a second request while it runs is refused.
  await sheet().getByRole('button', { name: '重新选账号', exact: true }).click();
  await composer.fill('');
  await option('us').click();
  await sheet().getByRole('button', { name: '确认切换', exact: true }).click();
  await expect.poll(async () => (await relayState()).job?.status, { timeout: 15000 }).toMatch(/switching|done/);
  // (An account that is refused either way, so this probe can never start a switch of its own.)
  const again = await post('/api/relay', { seatId: 'us2' });
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toMatch(/^(电脑正在切换队长，等它结束再试|这个账号还没登录，要回电脑上登录)$/);
  await expect(sheet().getByRole('heading')).toHaveText('已换到 Claude US', { timeout: 90000 });
  expect((await relayState()).currentId).toBe('us');
});
