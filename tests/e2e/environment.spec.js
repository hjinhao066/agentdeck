const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('independent PTYs keep CLI history and let statusline output reach the footer', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-env-'));
  const fake = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    columns: [{ id: 'env-agent', title: 'env-agent', cmd: fake, cwd: profile, role: 'manual' }],
  }));
  const flagsFile = path.join(profile, 'history-flags.json');
  const childEnv = { ...process.env, CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', AGENTDECK_TEST_HISTORY_FLAGS_FILE: flagsFile };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({
      executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
      env: childEnv,
    });
    const page = await application.firstWindow();
    await expect(page.locator('.column')).toHaveCount(1);
    await expect.poll(() => fs.existsSync(flagsFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(flagsFile, 'utf8'))).toEqual({ child: false, skip: false, statusWidth: '4096' });
  } finally {
    if (application) await closeElectron(application);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a test instance renders normally but stays invisible and click-through on the desktop', { tag: '@smoke' }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-env-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [] }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({
      executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
      env,
    });
    const page = await application.firstWindow();
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w ? [w.isVisible(), w.getOpacity(), w.isFocusable(), w.isFocused()] : null;
    })).toEqual([true, 0, false, false]);
    // still a live page: visible to itself, animation frames run, layout is real
    expect(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(document.visibilityState))))).toBe('visible');
    expect(await page.evaluate(() => innerWidth)).toBeGreaterThan(600);
  } finally {
    if (application) await closeElectron(application);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
