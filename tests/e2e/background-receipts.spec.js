const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('background receipts leave a half-written terminal sentence and chat message untouched', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-background-receipts-'));
  const promptsFile = path.join(profile, 'prompts.jsonl');
  const controlFile = path.join(profile, 'control-env.json');
  const fake = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    columns: [{ id: 'receipt-worker', title: 'Worker', cmd: fake, cwd: profile, role: 'manual' }],
  }));
  const env = { ...process.env, AGENTDECK_TEST_PROMPTS_FILE: promptsFile, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, listener;
  const captured = () => fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  try {
    app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
    const page = await app.firstWindow();
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mdCmd').fill(fake);
    await page.locator('#mdCwd').fill(profile);
    await page.locator('#mdCreate').click();
    await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
    const mainId = await page.evaluate(() => config.mainSession.colId);
    await expect.poll(() => captured().join('\n'), { timeout: 20000 }).toContain('run_in_background: true');
    await expect.poll(() => page.evaluate((id) => terms.get(id).sendingPrompt, mainId)).toBe(false);
    await page.waitForTimeout(2500);
    const before = captured().length;
    const half = 'my unfinished sentence';
    await page.evaluate((id) => { ChatUI.setMode(id, 'term'); focusColumnInput(id); }, mainId);
    await page.keyboard.type(half);
    await expect.poll(() => page.evaluate((id) => terms.get(id).typing.draft, mainId)).toBe(half);
    const controlEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    const startListener = (seconds) => {
      listener = spawn(process.execPath, [path.resolve(__dirname, '../../board-cli.js'), 'receipts', '--wait', '--timeout', String(seconds)], {
        env: { ...process.env, ...controlEnv }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      listener.stdout.on('data', (chunk) => { stdout += chunk; });
      listener.stderr.on('data', (chunk) => { stderr += chunk; });
      return new Promise((resolve) => listener.on('close', (code) => resolve({ code, stdout, stderr })));
    };
    const receipt = startListener(20);
    await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'receipt-worker', message: 'background proof' }, MainSession.mainCol()));
    const result = await receipt;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('stand-in finished background proof');
    expect(result.stdout).toContain('【AgentDeck 新回执】');
    await page.waitForTimeout(6000); // multiple status ticks and past the key quiet guard
    expect(captured().slice(before).some((p) => p.includes(half))).toBe(false);
    expect(captured().slice(before).some((p) => p.includes('【AgentDeck 新回执】'))).toBe(false);
    expect(await page.evaluate((id) => terms.get(id).typing.draft, mainId)).toBe(half);
    expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
    // Only the user's Enter submits the original sentence.
    await page.keyboard.press('Enter');
    await expect.poll(() => captured().slice(before)).toContain(half);
    expect(captured().slice(before).find((p) => p.includes(half))).toBe(half);
    await page.evaluate(() => { config.mainSession.pending.push({ colId: 'receipt-worker', title: 'Worker', question: 'which database?' }); });
    // Even the next user message receives no receipt prefix in background mode.
    await page.evaluate((id) => ChatUI.setMode(id, 'chat'), mainId);
    const box = page.locator(`.column[data-col-id="${mainId}"] .composer textarea`);
    await box.fill('my next message');
    await box.press('Enter');
    await expect.poll(() => captured()).toContain('my next message');
    await page.waitForTimeout(6000); // empty and quiet: default mode still never injects
    expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(1);
    expect(captured().slice(before).some((p) => p.includes('【AgentDeck 新回执】'))).toBe(false);
    const question = await startListener(10);
    expect(question.code).toBe(0);
    expect(question.stdout).toContain('向你提问：which database?');
    const cachedBeforeTimeout = await page.evaluate(() => Object.keys(config.boardResponses).length);
    const timeout = await startListener(0.5);
    expect(timeout).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await page.evaluate(() => Object.keys(config.boardResponses).length)).toBe(cachedBeforeTimeout);
    // A request held across renderer unavailability cannot drain a late receipt.
    const expired = await page.evaluate(async () => {
      config.mainSession.pending.push({ title: 'Worker', summary: 'late receipt' });
      const response = await MainSession.handle({ action: 'main-receipts', wait: true, expiresAt: Date.now() - 1 }, MainSession.mainCol());
      return { response, pending: config.mainSession.pending.length };
    });
    expect(expired).toEqual({ response: { done: true, result: '' }, pending: 1 });
    const denied = await page.evaluate(() => MainSession.handle({ action: 'main-receipts', wait: true }, columns.find((c) => c.id === 'receipt-worker')).then(() => '', (e) => e.message));
    expect(denied).toContain('只有队长');
  } finally {
    if (listener && listener.exitCode === null) listener.kill();
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
