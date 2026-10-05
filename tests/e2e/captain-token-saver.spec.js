const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --token-saver`;
const SHOTS = process.env.AGENTDECK_TOKEN_SAVER_SHOTS;
let application, page, profile, promptsFile, boardFile;
const prompts = () => fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const archivePrompts = () => prompts().filter((p) => p.startsWith('把当前进度写进'));
const banner = () => page.locator('.captain-token-saving');
async function tick() { await page.evaluate(() => MainSession.onTick('saver-captain', terms.get('saver-captain'))); }
async function context(used) {
  await page.evaluate((n) => ChatUI.sendPrompt(MainSession.mainCol(), '/context ' + n), used);
  await expect.poll(() => page.evaluate(() => terms.get('saver-captain').state), { timeout: 15000 }).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('saver-captain').every((t) => t.done)), { timeout: 15000 }).toBe(true);
}
async function shot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}
async function launch(flags = '', settings) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-token-saver-'));
  promptsFile = path.join(profile, 'prompts.jsonl');
  boardFile = path.join(profile, 'board.md');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2,
    captainTokenSaver: settings,
    mainSession: { colId: 'saver-captain', cmd: FAKE + flags, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'saver-captain', title: '队长', isMain: true, cmd: FAKE + flags, cwd: profile },
      { id: 'saver-worker', title: 'Worker', cmd: FAKE, cwd: profile },
    ],
  }));
  const env = { ...process.env, AGENTDECK_TEST_PROMPTS_FILE: promptsFile, AGENTDECK_TEST_BOARD_FILE: boardFile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction(() => typeof ChatUI !== 'undefined' && typeof terms !== 'undefined' && terms.get('saver-captain')?.wrap?.isConnected);
  await page.evaluate(() => ChatUI.setMode('saver-captain', 'chat'));
  await expect(page.locator('.column.is-main .tui-footer')).toContainText('23k/1000k', { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => terms.get('saver-captain')?.state), { timeout: 20000 }).toBe('done');
  // The Captain's initial briefing has completed, without any real AI CLI.
  await expect.poll(() => prompts().some((p) => p.startsWith('你是 AgentDeck'))).toBe(true);
}
test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('archives progress, waits for acknowledgement, sends /clear, rebriefs without restarting any terminal', async () => {
  await launch();
  await page.evaluate(() => { MainSession.mainCol().modelSessionId = '00000000-0000-4000-8000-000000000001'; });
  const before = await page.evaluate(() => columns.map((c) => c.id));
  await context(290000);
  await expect(banner()).toContainText('准备存看板', { timeout: 15000 });
  await shot('automatic-archive');
  await page.evaluate(() => ChatUI.setMode('saver-captain', 'term')); // footer detection works in either view
  await expect.poll(() => prompts().includes('/clear'), { timeout: 25000 }).toBe(true);
  expect(fs.readFileSync(boardFile, 'utf8')).toContain('Progress archived');
  await expect.poll(() => prompts().filter((p) => p.startsWith('你是 AgentDeck')).length, { timeout: 20000 }).toBe(2);
  const sent = prompts();
  const archive = sent.findIndex((p) => p.startsWith('把当前进度写进'));
  const clear = sent.indexOf('/clear');
  const brief = sent.findIndex((p, i) => i > clear && p.startsWith('你是 AgentDeck'));
  expect(archive).toBeLessThan(clear); expect(clear).toBeLessThan(brief);
  expect(sent[brief]).toBe(sent.find((p) => p.startsWith('你是 AgentDeck')) + '\n\n读看板继续。');
  expect(sent[brief]).toContain('不读大文件正文，只看报告的结论段；查进度优先 peek');
  expect(archivePrompts()).toHaveLength(1);
  expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(before);
  expect(await page.evaluate(() => [...terms.values()].every((e) => e.alive))).toBe(true);
  expect(await page.evaluate(() => MainSession.mainCol().modelSessionId)).toBeUndefined();
  await expect(banner()).toHaveCount(0);
  await page.evaluate(() => ChatUI.setMode('saver-captain', 'chat'));
  await page.locator('.column.is-main .retired-toggle').click();
  await page.locator('.column.is-main .retired-head').first().click();
  await expect(page.locator('.column.is-main .retired-turns')).toContainText('已存档');
});

test('chat draft, attachments, raw terminal draft and busy/quota/input states block automatic sends', async () => {
  await launch();
  const ta = page.locator('.column.is-main .composer textarea');
  await context(150000);
  await tick();
  await expect(banner()).toHaveCount(0); // strictly greater than threshold
  await ta.fill('用户未发出的半句话');
  await context(290000);
  await tick();
  expect(await ta.inputValue()).toBe('用户未发出的半句话');
  await expect(banner()).toHaveCount(0);
  await ta.fill('');
  await page.evaluate(() => ChatUI.attach('saver-captain', '/tmp/unsent-attachment.md'));
  await tick();
  await expect(banner()).toHaveCount(0);
  // Existing attachment removal is an icon action.
  await page.locator('.column.is-main .cp-atts .att').hover();
  await page.locator('.column.is-main .cp-atts button').click();
  for (const state of ['working', 'quota', 'input']) {
    await page.evaluate((st) => { const e = terms.get('saver-captain'); e.state = st; e.lastOutputAt = Date.now(); MainSession.onTick('saver-captain', e); }, state);
    await expect(banner()).toHaveCount(0);
  }
  await page.evaluate(() => { const e = terms.get('saver-captain'); e.state = 'done'; e.lastOutputAt = Date.now() - 10000; e.typing.draft = 'terminal draft'; MainSession.onTick('saver-captain', e); });
  await expect(banner()).toHaveCount(0);
  expect(archivePrompts()).toHaveLength(0);
});

test('cancel icon stops the cycle and suppresses repeated attempts at the same high usage', async () => {
  await launch();
  await context(290000);
  await expect(banner()).toBeVisible({ timeout: 15000 });
  const cancel = banner().getByRole('button', { name: '取消自动存档与清空' });
  await expect(cancel).toHaveAttribute('title', /取消后续/);
  await expect(cancel.locator('svg')).toHaveCount(1);
  await cancel.click();
  await expect(banner()).toHaveCount(0);
  await tick(); await tick();
  expect(archivePrompts()).toHaveLength(0);
  expect(prompts()).not.toContain('/clear');
  await context(23000); await tick();
  await context(290000);
  await expect(banner()).toBeVisible({ timeout: 15000 });
  await banner().getByRole('button').click();
});

test('failed archive acknowledgement never clears context', async () => {
  await launch(' --archive-fail');
  await context(290000);
  await expect.poll(() => archivePrompts().length, { timeout: 20000 }).toBe(1);
  await expect(banner()).toHaveCount(0, { timeout: 20000 });
  await tick();
  expect(prompts()).not.toContain('/clear');
  expect(fs.existsSync(boardFile)).toBe(false);
  expect(archivePrompts()).toHaveLength(1);
});

test('unchanged context after /clear does not rebrief and times out without consuming pending receipts', async () => {
  await launch(' --clear-no-reset');
  await context(290000);
  await expect.poll(() => prompts().includes('/clear'), { timeout: 30000 }).toBe(true);
  await expect(banner()).toContainText('/clear');
  await expect.poll(() => page.evaluate(() => terms.get('saver-captain').state), { timeout: 15000 }).toBe('done');
  await tick();
  expect(prompts().filter((p) => p.startsWith('你是 AgentDeck'))).toHaveLength(1);
  const pending = await page.evaluate(() => {
    MainSession.state().pending.push({ colId: 'saver-worker', title: '报告', summary: '未读回执', files: [] });
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try { MainSession.onTick('saver-captain', terms.get('saver-captain')); }
    finally { Date.now = realNow; }
    return MainSession.state().pending;
  });
  await expect(banner()).toHaveCount(0);
  expect(pending.at(-1).summary).toBe('未读回执');
  expect(prompts().filter((p) => p.startsWith('你是 AgentDeck'))).toHaveLength(1);
});

test('a new user message cancels remaining steps; non-Claude captains never receive /clear', async () => {
  await launch();
  await context(290000);
  await expect(banner()).toBeVisible({ timeout: 15000 });
  await page.locator('.column.is-main .composer textarea').fill('新的用户指令');
  await page.locator('.column.is-main .composer textarea').press('Enter');
  await expect(banner()).toHaveCount(0);
  expect(archivePrompts()).toHaveLength(0);
  await context(23000); await tick();
  await page.evaluate(() => { MainSession.mainCol().cmd = 'codex'; }); // existing stand-in PTY stays in place
  await context(290000); await tick();
  await expect(banner()).toHaveCount(0);
  expect(prompts()).not.toContain('/clear');
});

test('settings change threshold and disable the saver persistently', async () => {
  await launch();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#csThreshold')).toHaveValue('150');
  await shot('settings');
  await page.locator('#csThreshold').fill('350');
  await page.getByRole('button', { name: '保存设置' }).click();
  await context(290000); await tick();
  await expect(banner()).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('#csEnabled').uncheck();
  await page.getByRole('button', { name: '保存设置' }).click();
  await context(500000); await tick();
  await expect(banner()).toHaveCount(0);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).captainTokenSaver).toEqual({ enabled: false, threshold: 350000 });
  expect(archivePrompts()).toHaveLength(0);
});

test('background receipts and ledger deliver only 300 characters and five paths; read keeps the full reply', async () => {
  await launch();
  const result = await page.evaluate(async () => {
    const receipt = { summary: '结'.repeat(400), files: Array.from({ length: 8 }, (_, i) => `/tmp/report-${i}.md`) };
    const s = MainSession.state();
    s.pending.push({ colId: 'saver-worker', title: '报告', ...receipt });
    columns.find((c) => c.id === 'saver-worker').lastReceipt = receipt;
    ChatUI.noteSent(columns.find((c) => c.id === 'saver-worker'), 'write report');
    const turn = ChatUI.turnsOf('saver-worker').at(-1);
    Object.assign(turn, { done: true, reply: '【回执】\n摘要：' + receipt.summary + '\n文件：' + receipt.files.join('\n') });
    return {
      receipts: (await MainSession.handle({ action: 'main-receipts' }, MainSession.mainCol())).result,
      ledger: (await MainSession.handle({ action: 'main-ledger' }, MainSession.mainCol())).result,
      read: (await MainSession.handle({ action: 'main-read', to: 'saver-worker' }, MainSession.mainCol())).result,
    };
  });
  for (const text of [result.receipts, result.ledger]) {
    expect(text).toContain('结'.repeat(300)); expect(text).not.toContain('结'.repeat(301));
    expect(text).toContain('/tmp/report-4.md'); expect(text).not.toContain('/tmp/report-5.md');
    expect(text).toContain('其余见 read');
  }
  expect(result.read).toContain('/tmp/report-7.md');
});
