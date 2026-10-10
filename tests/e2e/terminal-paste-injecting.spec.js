const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A Ctrl+V that is still waiting for the clipboard holds back the keys typed meanwhile. They
// must come out through the same gate as any other keystroke: while AgentDeck types a receipt
// or a task into the terminal (guardUserInput), they wait for its Enter instead of landing in
// the middle of its text, and the pasted text stays in front of them. The proof is the order the
// agent read things in: the delivery's text, its Enter, then the pasted text, then the key.
test.skip(process.platform === 'darwin', 'a Mac keeps the single clipboard read');

let app, page, profile, log;
const ID = 'fullscreen';
const kinds = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')[1]) : []);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-paste-injecting-'));
  log = path.join(profile, 'agent-input.log');
  const cmd = `node "${path.join(__dirname, 'fixtures', 'claude-like-agent.js')}" --work=1 "--log=${log}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Full-screen agent', cmd, cwd: profile, role: 'manual', view: 'term' }] }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate((id) => typeof terms !== 'undefined' && terms.get(id)?.term.buffer.active.type, ID), { timeout: 30000 }).toBe('alternate');
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('keys held back by a waiting Ctrl+V still wait for AgentDeck\'s own typing, and follow the paste', async () => {
  // the clipboard reads empty for 300 ms (another program has it open), then gives the text
  await app.evaluate(({ ipcMain }) => {
    globalThis.__busyUntil = 0; globalThis.__clip = '';
    ipcMain.removeHandler('clipboard:write');
    ipcMain.handle('clipboard:write', (e, t) => { if (typeof t !== 'string') return false; globalThis.__clip = t; return true; });
    ipcMain.removeHandler('clipboard:read');
    ipcMain.handle('clipboard:read', () => (Date.now() < globalThis.__busyUntil ? '' : globalThis.__clip));
  });
  await page.evaluate(() => window.deck.clipboardWrite('PASTED TEXT'));
  await expect.poll(() => page.evaluate((id) => !userComposing(id), ID), { timeout: 10000 }).toBe(true);
  await page.evaluate((id) => { window.__delivery = ChatUI.sendPrompt(columns.find((c) => c.id === id), 'automatic delivery', null, { silent: true, guardUserInput: true }); }, ID);
  await expect.poll(() => page.evaluate((id) => terms.get(id).injecting === true, ID), { timeout: 5000 }).toBe(true);
  await page.evaluate((id) => terms.get(id).term.focus(), ID);
  await app.evaluate((_, ms) => { globalThis.__busyUntil = Date.now() + ms; }, 300);
  await page.keyboard.press('Control+V');
  await page.keyboard.type('x');
  expect(await page.evaluate(() => window.__delivery)).toBe(true);
  await expect.poll(() => kinds().filter((k) => k === 'key').length, { timeout: 10000 }).toBe(1);
  const order = kinds();
  const enter = order.indexOf('enter');
  expect(order.filter((k) => k === 'enter')).toHaveLength(1);
  // before its Enter only the delivery's own text; the pasted text and the key come after it, in that order
  expect(order.slice(0, enter)).toEqual(['paste']);
  expect(order.slice(enter + 1)).toEqual(['paste', 'key']);
  await page.evaluate((id) => terms.get(id).term.input('\x15', true), ID); // ^U: the stray x is no draft
});
