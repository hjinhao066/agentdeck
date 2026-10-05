const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;
const alerts = () => application.evaluate(({ app }) => app.testCaptainAlerts.filter((e) => e.type === 'notification'));
async function launch() {
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((e) => /Claude Code/.test(e.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
}
async function send(id, text) {
  await page.evaluate((id) => { jumpToColumn(columns.find((c) => c.id === id)); ChatUI.setMode(id, 'chat'); }, id);
  const box = page.locator(`.column[data-col-id="${id}"] .composer textarea`);
  await box.fill(text); await box.press('Enter');
}
const done = (id) => expect.poll(() => page.evaluate((id) => ChatUI.turnsOf(id).at(-1)?.done, id), { timeout: 20000 }).toBe(true);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-manual-notify-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ fitWindow: true, fitCols: 2,
    columns: [0, 1, 2, 3].map((i) => ({ id: `manual-${i}`, title: `手动 ${i}`, manualTitle: true, role: 'manual',
      captainCrew: i === 3, cmd: FAKE, cwd: profile, width: 460 })) }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.mkdirSync(path.join(profile, 'sessions'));
  for (const i of [0, 1, 2]) {
    const id = `manual-${i}`;
    fs.writeFileSync(path.join(profile, 'chats', `${id}.json`), JSON.stringify({ v: 1, id,
      turns: [{ id: 'old-turn', user: 'old task', reply: '本轮输出已停止', done: true, ts: Date.now() - 60000 }] }));
    fs.writeFileSync(path.join(profile, 'sessions', `${id}.txt`), 'Old work\nwaiting for confirmation\nProceed? (y/n)\nClaude Code\n');
  }
  await launch();
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('three restored terminals and startup output stay silent past the quiet window', async () => {
  await page.waitForTimeout(14000);
  expect(await alerts()).toEqual([]);
  expect(await page.evaluate(() => [...terms.values()].every((e) => !e.manualTurnId))).toBe(true);
});
test('a real composer submission alerts once, plays a gentle sound, and clicking opens that manual column', async () => {
  await send('manual-0', 'manual composer regression');
  await page.evaluate(() => toggleZoom('manual-1'));
  await expect.poll(async () => (await alerts()).length, { timeout: 30000 }).toBe(1);
  expect((await alerts())[0]).toMatchObject({ title: '手动 0', body: 'GOT manual composer regression' });
  if (process.platform === 'darwin') {
    expect(await application.evaluate(({ app }) => app.testCaptainAlerts.filter((e) => e.type === 'sound'))).toEqual([{ type: 'sound', tone: 'Glass' }]);
  }
  await application.evaluate(({ app }) => app.testCaptainNotification.emit('click'));
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('manual-0');
  await expect.poll(() => page.evaluate(() => document.activeElement === terms.get('manual-0').el.querySelector('.xterm-helper-textarea'))).toBe(true);
  await page.waitForTimeout(2000);
  expect(await alerts()).toHaveLength(1);
});
test('a raw-terminal submission arms its own turn, while Gemini thinking text never becomes a confirmation', async () => {
  await page.evaluate(() => { ChatUI.setMode('manual-1', 'term'); jumpToColumn(columns.find((c) => c.id === 'manual-1')); });
  await page.keyboard.type('gemini confirmation regression');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => terms.get('manual-1').lastScreen), { timeout: 10000 }).toContain('waiting for confirmation');
  expect(await page.evaluate(() => terms.get('manual-1').state)).toBe('working');
  expect(await page.evaluate(() => terms.get('manual-1').manualTurnId)).toBeTruthy();
  await expect.poll(async () => (await alerts()).length, { timeout: 30000 }).toBe(2);
  expect((await alerts()).at(-1)).toMatchObject({ title: '手动 1', body: 'GOT gemini confirmation regression' });
});
test('automatic manual sends and personally typed worker input remain silent', async () => {
  await page.evaluate(() => ChatUI.sendPrompt(columns.find((c) => c.id === 'manual-2'), 'scheduled output'));
  await done('manual-2');
  await send('manual-3', 'worker input remains silent');
  await done('manual-3');
  await page.waitForTimeout(14000);
  expect(await alerts()).toHaveLength(2);
  // Automatic work supersedes a just-submitted user turn before it can alert.
  await send('manual-2', 'superseded manual turn'); await done('manual-2');
  await page.evaluate(() => ChatUI.sendPrompt(columns.find((c) => c.id === 'manual-2'), 'automatic followup', null, { silent: true }));
  await page.waitForTimeout(14000);
  expect(await alerts()).toHaveLength(2);
});
test('renderer reload never replays an already finished manual turn', async () => {
  await send('manual-2', 'pending before reload'); await done('manual-2');
  await page.reload();
  await expect(page.locator('.xterm')).toHaveCount(4);
  await page.waitForTimeout(14000);
  expect(await alerts()).toHaveLength(2);
});
test('cold restart stays silent; only new user input can alert again', async () => {
  await application.close(); application = null;
  await launch();
  await page.waitForTimeout(14000);
  expect(await alerts()).toEqual([]);
  await send('manual-2', 'new input after restart');
  await expect.poll(async () => (await alerts()).length, { timeout: 30000 }).toBe(1);
  expect((await alerts())[0].body).toBe('GOT new input after restart');
});
test('a new personally submitted turn without reply text still alerts after the quiet guard', async () => {
  await send('manual-2', 'empty reply regression');
  await expect.poll(async () => (await alerts()).length, { timeout: 30000 }).toBe(2);
  expect((await alerts()).at(-1)).toMatchObject({ title: '手动 2', body: '本轮输出已停止。' });
});
