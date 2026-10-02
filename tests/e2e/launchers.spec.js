const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The agent buttons on a blank session. Each button's command is swapped for
// the stand-in right before the click, so no real agent CLI ever starts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const WELCOME = 'Welcome to Claude Code (test stand-in)';
let application, page, profile;

async function launch() {
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'report.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column.chat-mode')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(3);
}
const launcher = (id) => page.locator(`.column[data-col-id="${id}"] .launcher .launch-btn`);
const colCmd = (id) => page.evaluate((i) => columns.find((c) => c.id === i).cmd, id);
const replay = (id) => page.evaluate((i) => window.deck.ptyReplay(i), id);
const agentUp = (id) => page.evaluate((i) => (env.platform === 'win32'
  ? /Claude Code/.test(terms.get(i).lastScreen || '')
  : window.deck.ptyForeground(i).then((p) => p === 'node')), id);
// point a button at another command, the way a test stand-in replaces the real CLI
const retarget = (id, label, cmd) => page.evaluate(([i, l, c]) => {
  const b = [...document.querySelectorAll(`.column[data-col-id="${i}"] .launch-btn`)].find((x) => x.textContent === l);
  b.dataset.cmd = c;
}, [id, label, cmd]);

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-launch-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [['ln-blank', ''], ['ln-manual', ''], ['ln-agent', FAKE]].map(([id, cmd]) => ({
      id, taskId: `task-${id}`, title: id, cmd, cwd: profile, width: 460, role: 'manual',
    })),
  }));
  await launch();
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('only a blank session offers the agents, with their real launch commands', async () => {
  await expect(launcher('ln-blank')).toHaveText(['Claude', 'Antigravity', 'Grok', 'Cursor CLI']);
  await expect(launcher('ln-blank').nth(3)).toHaveAttribute('data-cmd', 'cursor-agent --model claude-opus-5-5-high');
  await expect(launcher('ln-blank').nth(1)).toHaveAttribute('data-cmd', 'agy --model gemini-3.8-flash-high --effort high');
  await expect.poll(() => agentUp('ln-agent'), { timeout: 20000 }).toBe(true);
  await expect(launcher('ln-agent')).toHaveCount(0);
});

test('a CLI that is not installed is reported and the session stays blank', async () => {
  await retarget('ln-blank', 'Grok', 'agentdeck-no-such-cli');
  await launcher('ln-blank').nth(2).click();
  const note = page.locator('.column[data-col-id="ln-blank"] .launch-note.failed');
  await expect(note).toContainText('没找到 agentdeck-no-such-cli', { timeout: 20000 });
  expect(await colCmd('ln-blank')).toBe('');
  await expect(launcher('ln-blank')).toHaveCount(4);
  await expect(launcher('ln-blank').first()).toBeEnabled();
});

test('a button starts the agent once, in the same session, and the composer then talks to it', async () => {
  // computed, so the echoed command line itself never contains the marker
  await page.evaluate(() => window.deck.ptyInput('ln-blank', `node -e "console.log('kept-'+(20+22))"\r`));
  await expect.poll(() => replay('ln-blank'), { timeout: 15000 }).toContain('kept-42');
  const count = await page.evaluate(() => columns.length);
  await retarget('ln-blank', 'Cursor CLI', FAKE);
  // two quick clicks still start one agent
  await page.evaluate(() => { const b = document.querySelectorAll('.column[data-col-id="ln-blank"] .launch-btn')[3]; b.click(); b.click(); });
  await expect.poll(() => agentUp('ln-blank'), { timeout: 20000 }).toBe(true);
  await expect(launcher('ln-blank')).toHaveCount(0, { timeout: 10000 });
  expect(await colCmd('ln-blank')).toBe(FAKE);
  await page.evaluate(() => flushConfig());
  const disk = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(disk.columns.find((c) => c.id === 'ln-blank').cmd).toBe(FAKE);
  // same session, same terminal: nothing opened, nothing respawned, history kept
  expect(await page.evaluate(() => columns.length)).toBe(count);
  expect(await page.evaluate(() => window.deck.ptyIsAlive('ln-blank'))).toBe(true);
  expect(await replay('ln-blank')).toContain('kept-42');
  expect((await replay('ln-blank')).split(WELCOME).length - 1).toBe(1);
  // the hidden terminal stays mounted under the chat
  expect(await page.evaluate(() => { const t = terms.get('ln-blank'); return t.wrap.contains(t.el) && getComputedStyle(t.wrap.querySelector('.chat')).display !== 'none'; })).toBe(true);

  const col = page.locator('.column[data-col-id="ln-blank"]');
  await col.locator('.composer textarea').click();
  await page.keyboard.type('hello launcher');
  await page.keyboard.press('Enter');
  await expect(col.locator('.reply').last()).toContainText('GOT hello launcher', { timeout: 20000 });
  expect(await replay('ln-blank')).not.toMatch(/not found: hello|hello: command not found/);
});

test('an agent started by hand in the terminal hides the buttons; leaving it brings them back', async () => {
  await expect(launcher('ln-manual')).toHaveCount(4);
  await page.evaluate((c) => window.deck.ptyInput('ln-manual', c + '\r'), FAKE);
  await expect(launcher('ln-manual')).toHaveCount(0, { timeout: 15000 });
  expect(await colCmd('ln-manual')).toBe('');
  await page.evaluate(() => window.deck.ptyInput('ln-manual', '\x03'));
  await expect(launcher('ln-manual')).toHaveCount(4, { timeout: 15000 });
});

test('the chosen agent comes back after a restart, with the conversation', async () => {
  await application.close();
  application = null;
  await launch();
  expect(await colCmd('ln-blank')).toBe(FAKE);
  await expect.poll(() => agentUp('ln-blank'), { timeout: 20000 }).toBe(true);
  await expect(launcher('ln-blank')).toHaveCount(0);
  await expect(page.locator('.column[data-col-id="ln-blank"] .msg.user .bubble').last()).toHaveText('hello launcher');
  await expect(launcher('ln-manual')).toHaveCount(4);
});
