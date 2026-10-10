const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Copying what is selected in a terminal. On a Mac it is Cmd+C. On Windows
// Ctrl+Shift+C copies (the 速记待办 settings keep it free as 「终端复制」) and so
// does Ctrl+C while text is selected, as in Windows Terminal; it used to reach
// the program as Ctrl+C instead, which stops Claude in the middle of its work.
// Without a selection Ctrl+C is still the interrupt.
const ROOT = path.resolve(__dirname, '../..');
const ID = 'copy';
const mac = process.platform === 'darwin';
let app, page, profile, keyLog;

const keys = () => (fs.existsSync(keyLog) ? fs.readFileSync(keyLog, 'utf8') : '');
const selectLine = () => page.evaluate((id) => {
  if (typeof terms === 'undefined' || !terms.get(id)) return null;
  const { term } = terms.get(id);
  const b = term.buffer.active;
  for (let y = 0; y < b.length; y++) {
    const text = b.getLine(y)?.translateToString(true) || '';
    const at = text.indexOf('COPY-ME-4721');
    if (at >= 0) { term.select(at, y, 'COPY-ME-4721'.length); return term.getSelection(); }
  }
  return null;
}, ID);
const clipboard = () => page.evaluate(() => window.deck.clipboardRead());

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-terminal-copy-'));
  keyLog = path.join(profile, 'keys.log');
  const cmd = `node "${path.join(__dirname, 'fixtures', 'key-recorder.js')}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Key recorder', cmd, cwd: profile, role: 'manual', view: 'term' }] }));
  const env = { ...process.env, AGENTDECK_TEST_KEY_LOG: keyLog };
  for (const key of Object.keys(env)) if ((key.startsWith('AGENTDECK_') && key !== 'AGENTDECK_TEST_KEY_LOG') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(selectLine, { timeout: 30000 }).toBe('COPY-ME-4721');
  // the recorder is in raw mode once it reads: wait until a probe key reaches it
  await page.evaluate((id) => terms.get(id).term.focus(), ID);
  await expect.poll(async () => { await page.keyboard.press('x'); return keys().includes('78'); }, { timeout: 15000 }).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the copy key copies a terminal selection and never reaches the program as Ctrl+C', async () => {
  await page.evaluate(() => window.deck.clipboardWrite(''));
  expect(await selectLine()).toBe('COPY-ME-4721');
  const before = keys();
  await page.keyboard.press(mac ? 'Meta+C' : 'Control+Shift+C');
  await expect.poll(clipboard).toBe('COPY-ME-4721');

  if (!mac) {
    // Ctrl+C with text selected copies too, and leaves nothing selected so the next one interrupts.
    await page.evaluate(() => window.deck.clipboardWrite(''));
    expect(await selectLine()).toBe('COPY-ME-4721');
    await page.keyboard.press('Control+C');
    await expect.poll(clipboard).toBe('COPY-ME-4721');
    await expect.poll(() => page.evaluate((id) => terms.get(id).term.hasSelection(), ID)).toBe(false);
  }
  await page.waitForTimeout(500);
  expect(keys().slice(before.length)).not.toContain('03');

  // Nothing selected: Ctrl+C is the interrupt the program sees.
  await page.evaluate((id) => terms.get(id).term.clearSelection(), ID);
  await page.keyboard.press('Control+C');
  await expect.poll(() => keys().slice(before.length).split('\n').includes('03'), { timeout: 5000 }).toBe(true);
});
