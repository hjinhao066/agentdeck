const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile, promptsFile, controlFile, receiptDir;
const prompts = () => fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const briefs = () => prompts().filter((p) => p.startsWith('你是 AgentDeck'));
const composer = () => page.locator('.column.is-main .composer textarea');
async function ready() {
  await expect.poll(() => page.evaluate(() => terms.get('rebrief-captain')?.state), { timeout: 20000 }).toBe('done');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('rebrief-captain').every((t) => t.done)), { timeout: 15000 }).toBe(true);
}
async function launch(flags = '', restart = false) {
  if (!restart) {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-rebrief-'));
    promptsFile = path.join(profile, 'prompts.jsonl'); controlFile = path.join(profile, 'control.json');
    receiptDir = path.join(profile, 'receipts'); fs.mkdirSync(receiptDir);
    const cmd = FAKE + ' --manual-reset' + flags;
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
      theme: 'dark', fitWindow: true, fitCols: 2, captainTokenSaver: { enabled: false },
      mainSession: { colId: 'rebrief-captain', cmd, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
      columns: [
        { id: 'rebrief-captain', title: '队长', isMain: true, cmd, cwd: profile },
        { id: 'rebrief-worker', title: 'Worker', cmd: FAKE, cwd: profile },
      ],
    }));
  }
  const previousBriefs = briefs().length;
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: promptsFile,
    AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile, AGENTDECK_TEST_RECEIPT_ENV_DIR: receiptDir };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await expect.poll(() => briefs().length, { timeout: 20000 }).toBe(previousBriefs + 1);
  await ready();
  await page.evaluate(() => ChatUI.setMode('rebrief-captain', 'chat'));
}
async function send(text) { await page.evaluate(() => ChatUI.setMode('rebrief-captain', 'chat')); await composer().fill(text); await composer().press('Enter'); await expect.poll(() => prompts().includes(text)).toBe(true); await ready(); }
async function raw(text) {
  await page.evaluate(() => ChatUI.setMode('rebrief-captain', 'term'));
  const terminal = page.locator('.column.is-main .xterm-helper-textarea');
  await terminal.focus(); await terminal.pressSequentially(text); await terminal.press('Enter');
  await expect.poll(() => prompts().includes(text)).toBe(true); await ready();
}
async function rebrief(count) {
  await expect.poll(() => briefs().length, { timeout: 20000 }).toBe(count);
  expect(briefs().at(-1)).toContain('不要等用户说“继续”');
  await ready();
}
async function cli(args, env) {
  return new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'board-cli.js'), ...args], {
    env: { ...process.env, AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_RECEIPT_TOKEN: '', ...env },
  }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
}
// Uses only this test's Electron and stand-in children; no global process killing.
test.afterEach(async () => {
  if (application) await application.close(); application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('reported 1.0.0 scenario: raw /clear at low context restores Captain identity without relying on memory; briefing exists', async () => {
  await launch(' --no-content-reset'); // percentage-only footer, no token decrease
  await send('保存真实场景的交接');
  const ids = await page.evaluate(() => columns.map((c) => c.id));
  await raw('/clear'); await rebrief(2);
  expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(ids);
  expect(await page.evaluate(() => [...terms.values()].every((e) => e.alive))).toBe(true);
  const cachedBefore = await page.evaluate(() => Object.keys(config.boardResponses));
  const env = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  const result = await cli(['briefing'], env);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(await page.evaluate(() => MainCore.instructions(navigator.platform.includes('Win') ? 'win32' : 'darwin') + '\n'));
  expect(result.stdout).toContain('briefing'); expect(result.stderr).not.toContain('Unknown action');
  expect(await page.evaluate(() => Object.keys(config.boardResponses))).toEqual(cachedBefore);
  // The bridge must preserve a future briefing longer than the normal 12k cap.
  const full = await page.evaluate(() => {
    window.rebriefOriginalInstructions = MainCore.instructions;
    MainCore.instructions = (...args) => window.rebriefOriginalInstructions(...args) + '\n' + 'x'.repeat(13000);
    return MainCore.instructions(env.platform) + '\n';
  });
  try { expect((await cli(['briefing'], env)).stdout).toBe(full); }
  finally { await page.evaluate(() => { MainCore.instructions = window.rebriefOriginalInstructions; delete window.rebriefOriginalInstructions; }); }
  expect(await page.evaluate(() => Object.keys(config.boardResponses))).toEqual(cachedBefore);
  const worker = JSON.parse(fs.readFileSync(path.join(receiptDir, 'rebrief-worker.json'), 'utf8'));
  const denied = await cli(['briefing'], worker);
  expect(denied.code).not.toBe(0); expect(denied.stderr).toContain('Only conductor-managed terminals');
  expect(await page.evaluate(async () => {
    try { await MainSession.handle({ action: 'main-briefing' }, columns.find((c) => !c.isMain)); return ''; }
    catch (error) { return error.message; }
  })).toContain('只有队长');
});

test('composer Claude aliases each rebrief once; history, ledger, pending receipts and worker survive relaunch', async () => {
  await launch();
  await send('历史关键词 keep this conversation');
  await page.evaluate(() => {
    MainSession.state().pending.push({ colId: 'rebrief-worker', title: 'Worker', summary: '未读回执', files: [] });
    MainSession.mainCol().modelSessionId = '00000000-0000-4000-8000-000000000001';
  });
  await send('/clear'); await rebrief(2);
  const archiveId = await page.evaluate(() => config.captainHistory.at(-1).id);
  const before = await page.evaluate(async (id) => ({
    read: (await MainSession.handle({ action: 'main-read', to: id }, MainSession.mainCol())).result,
    ledger: (await MainSession.handle({ action: 'main-ledger' }, MainSession.mainCol())).result,
    pending: MainSession.state().pending, session: MainSession.mainCol().modelSessionId,
  }), archiveId);
  expect(before.read).toContain('历史关键词'); expect(before.ledger).toContain(archiveId);
  expect(before.pending.at(-1).summary).toBe('未读回执'); expect(before.session).toBeUndefined();
  for (const command of ['/reset', '/new named conversation']) {
    await send(command); await rebrief(command.startsWith('/reset') ? 3 : 4);
  }
  await page.evaluate(() => { for (let i = 0; i < 5; i++) MainSession.onTick('rebrief-captain', terms.get('rebrief-captain')); });
  expect(briefs()).toHaveLength(4);
  await expect.poll(() => fs.existsSync(path.join(profile, 'chats', archiveId + '.json'))).toBe(true);
  await application.close(); application = null;
  await launch('', true); await ready();
  expect(await page.evaluate(async (id) => (await MainSession.handle({ action: 'main-read', to: id }, MainSession.mainCol())).result, archiveId)).toContain('历史关键词');
  expect(await page.evaluate(() => MainSession.state().pending.at(-1).summary)).toBe('未读回执');
});

test('Codex /new and /clear rebrief from the native context-left footer', async () => {
  await launch(' --codex-reset');
  await raw('/new'); await rebrief(2);
  // Give the fresh context a nonzero used amount before clearing again.
  await page.evaluate(() => ChatUI.setMode('rebrief-captain', 'chat'));
  await send('/context 23000'); await send('/clear'); await rebrief(3);
});

test('Codex workspace picker cancellation never rebriefs; acceptance waits for successful clear', async () => {
  await launch(' --codex-reset --reset-menu');
  await composer().fill('/new'); await composer().press('Enter');
  await expect.poll(() => page.evaluate(() => terms.get('rebrief-captain').state)).toBe('input');
  expect(briefs()).toHaveLength(1);
  await composer().fill('n'); await composer().press('Enter'); await ready();
  await page.evaluate(() => MainSession.onTick('rebrief-captain', terms.get('rebrief-captain')));
  expect(briefs()).toHaveLength(1); expect(await page.evaluate(() => config.captainHistory.length)).toBe(0);
  await composer().fill('/new'); await composer().press('Enter');
  await expect.poll(() => page.evaluate(() => terms.get('rebrief-captain').state)).toBe('input');
  await composer().fill('y'); await composer().press('Enter'); await ready(); await rebrief(2);
});

for (const flag of ['--reset-fail', '--reset-redraw']) test(`${flag}: failure or old header repaint does not rebrief or retire history`, async () => {
  await launch(' ' + flag); await send('旧上下文保留'); await send('/clear');
  await page.evaluate(() => {
    const now = Date.now; Date.now = () => now() + 61000;
    try { MainSession.onTick('rebrief-captain', terms.get('rebrief-captain')); } finally { Date.now = now; }
  });
  expect(briefs()).toHaveLength(1);
  expect(await page.evaluate(() => config.captainHistory.length)).toBe(0);
  expect(await page.evaluate(() => ChatUI.turnsOf('rebrief-captain').some((t) => t.user === '旧上下文保留'))).toBe(true);
});

test('confirmed clear waits behind composer draft, attachment, raw draft and busy states', async () => {
  await launch(); await send('protected history');
  await composer().fill('/clear'); await composer().press('Enter');
  await expect(composer()).toHaveValue(''); await composer().fill('用户半句话不要发送');
  await ready();
  await expect.poll(() => page.evaluate(() => config.captainHistory.length), { timeout: 15000 }).toBe(1);
  // Allow confirmation and the quiet-output period to pass while the draft holds delivery.
  await page.waitForTimeout(4000);
  expect(briefs()).toHaveLength(1); expect(await composer().inputValue()).toBe('用户半句话不要发送');
  await page.evaluate(() => ChatUI.attach('rebrief-captain', '/tmp/unsent.md')); await composer().fill('');
  await page.evaluate(() => MainSession.onTick('rebrief-captain', terms.get('rebrief-captain')));
  expect(briefs()).toHaveLength(1);
  await page.evaluate(() => { terms.get('rebrief-captain').typing.draft = 'raw unsent'; });
  await page.locator('.column.is-main .cp-atts .att').hover();
  await page.locator('.column.is-main .cp-atts button').click();
  const guards = await page.evaluate(() => {
    const e = terms.get('rebrief-captain');
    e.typing.draft = 'raw unsent'; MainSession.onTick('rebrief-captain', e); e.typing.draft = '';
    for (const state of ['working', 'quota', 'input']) { e.state = state; MainSession.onTick('rebrief-captain', e); }
    e.state = 'done'; return e.typing.draft;
  });
  expect(guards).toBe(''); expect(briefs()).toHaveLength(1);
  await rebrief(2);
  expect(prompts()).not.toContain('用户半句话不要发送');
});

test('worker commands, quoted slash text and uncertain raw editing never arm Captain reset', async () => {
  await launch();
  await page.evaluate(() => {
    MainSession.onContextCommand(columns.find((c) => !c.isMain), '/clear');
    const captain = MainSession.mainCol(), command = captain.cmd;
    captain.cmd = ''; MainSession.onContextCommand(captain, '/clear'); captain.cmd = command;
    const track = makePromptTracker(MainSession.mainCol());
    track('/clear\x1b[D\r'); // edited cursor: reconstructed text is uncertain
    track('\x1b[200~/clear\n\x1b[201~\r'); // multiline paste is not a command
    track('\x15/clea\t\r'); // completion can change the visible command
    track('\x15please /clear\r');
    MainSession.onOutput('rebrief-captain', 'Conversation cleared\n');
    MainSession.onTick('rebrief-captain', terms.get('rebrief-captain'));
  });
  expect(briefs()).toHaveLength(1); expect(await page.evaluate(() => config.captainHistory.length)).toBe(0);
  await page.evaluate(() => {
    MainSession.onContextCommand(MainSession.mainCol(), '/clear');
    MainSession.onContextCommand(MainSession.mainCol(), 'unrelated new user message');
    MainSession.onOutput('rebrief-captain', 'Conversation cleared\n');
    MainSession.onTick('rebrief-captain', terms.get('rebrief-captain'));
    MainSession.onContextCommand(MainSession.mainCol(), '/clear', false);
    MainSession.onOutput('rebrief-captain', 'Conversation cleared\n');
    MainSession.onTick('rebrief-captain', terms.get('rebrief-captain'));
    MainSession.onContextCommandSent(MainSession.mainCol(), '/clear');
    // Pre-Enter output was discarded; it cannot confirm the reset.
    MainSession.onTick('rebrief-captain', terms.get('rebrief-captain'));
    const now = Date.now; Date.now = () => now() + 61000;
    MainSession.onOutput('rebrief-captain', 'Conversation cleared\n');
    try { MainSession.onTick('rebrief-captain', terms.get('rebrief-captain')); } finally { Date.now = now; }
  });
  expect(briefs()).toHaveLength(1); expect(await page.evaluate(() => config.captainHistory.length)).toBe(0);
});
