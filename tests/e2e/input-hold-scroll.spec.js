const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code 2.1 runs full-screen in AgentDeck's terminal and takes the mouse: the wheel
// reaches the program, which scrolls its own transcript. While AgentDeck types a receipt
// or a task into that terminal (guardUserInput, up to 3 s while the agent keeps drawing),
// the wheel used to wait with the keys, so the terminal could not be scrolled (measured:
// 1.9 s median, 2.7 s worst, in a copy of a real 16-session profile). Keys still wait, Shift+F3
// too (xterm sends it as ESC[1;2R, the shape of a cursor reply). The proof is the order the
// agent read things in, not a stopwatch: the wheel ticks come before the delivery's Enter.

let app, page, profile, log;
const ID = 'fullscreen';
let seen = 0;   // log lines from before this test
const kinds = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')[1]) : []).slice(seen);
const viewTop = () => page.evaluate((id) => {
  const b = terms.get(id).term.buffer.active;
  const m = /VIEW_TOP (\d+)/.exec(b.getLine(b.viewportY)?.translateToString(true) || '');
  return m ? Number(m[1]) : null;
}, ID);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-input-hold-'));
  log = path.join(profile, 'agent-input.log');
  const cmd = `node "${path.join(__dirname, 'fixtures', 'claude-like-agent.js')}" --work=1 "--log=${log}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2, globalViewMode: 'term',
    columns: [{ id: ID, title: 'Full-screen agent', cmd, cwd: profile, role: 'manual', view: 'term' }] }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate((id) => typeof terms !== 'undefined' && terms.get(id)?.term.buffer.active.type, ID), { timeout: 30000 }).toBe('alternate');
  await expect.poll(viewTop, { timeout: 15000 }).not.toBeNull();
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the wheel scrolls a full-screen agent while AgentDeck types into it; keys still wait for its Enter', async () => {
  const box = await page.locator(`.column[data-col-id="${ID}"] .xterm-screen`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  const before = await viewTop();
  // An automatic delivery, as a receipt or a 队长 task arrives (not awaited: it is still typing).
  // It goes in only while nobody is typing there, as in the app.
  await expect.poll(() => page.evaluate((id) => !userComposing(id), ID), { timeout: 10000 }).toBe(true);
  seen = 0; seen = kinds().length;
  await page.evaluate((id) => { window.__delivery = ChatUI.sendPrompt(columns.find((c) => c.id === id), 'automatic delivery', null, { silent: true, guardUserInput: true }); }, ID);
  await expect.poll(() => page.evaluate((id) => terms.get(id).injecting === true, ID), { timeout: 5000 }).toBe(true);
  await page.evaluate((id) => terms.get(id).term.focus(), ID);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
  await page.keyboard.press('Shift+F3');
  await page.keyboard.type('x');
  expect(await page.evaluate(() => window.__delivery)).toBe(true);
  await expect.poll(() => kinds().filter((k) => k === 'key').length, { timeout: 10000 }).toBe(2);
  // In the order the agent read them: the delivery's text, the three wheel ticks while it was
  // still typing, its Enter, then the keys pressed meanwhile (Shift+F3 and x).
  const order = kinds();
  const enter = order.indexOf('enter');
  expect(order.filter((k) => k === 'enter')).toHaveLength(1);
  expect(order.indexOf('paste')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('paste')).toBeLessThan(enter);
  expect(order.slice(0, enter).filter((k) => k === 'wheel')).toHaveLength(3);
  expect(order.slice(enter + 1)).toEqual(['key', 'key']);
  // and it redrew further up
  await expect.poll(viewTop, { timeout: 5000 }).toBe(before - 9);
  await page.evaluate((id) => terms.get(id).term.input('\x15', true), ID);   // ^U: the stray x is no draft for the next run
});
