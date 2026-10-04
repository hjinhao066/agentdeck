const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}"`;
const statusAgent = `node "${path.join(__dirname, 'fixtures/status-agent.js')}"`;
let app, page, profile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-status-light-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ fitWindow: true, fitCols: 2, crewOpen: true,
    columns: [
      { id: 'captain', title: '队长', cmd: fake, cwd: profile, role: 'manual', isMain: true },
      { id: 'silent-worker', title: 'Quiet worker', cmd: statusAgent, cwd: profile, role: 'manual', captainCrew: true },
    ], mainSession: { colId: 'captain', cmd: fake, gen: 1, pending: [], inflight: [], fresh: false,
      crewMarked: true, waitlist: [], tasks: [] } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => statusScreen(terms.get('silent-worker').term)), { timeout: 20000 }).toContain('Status stand-in ready');
  await expect.poll(() => page.evaluate(() => terms.get('captain')?.state)).not.toBe('working');
  await page.locator('.captain-fold').click();
  await expect(page.locator('.nav-crew [data-col-id="silent-worker"]')).toBeVisible();
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

for (const provider of ['codex', 'claude', 'agy', 'cursor']) {
  test(`${provider}: silent backstage work stays yellow without focus, then completion turns green`, async () => {
    await page.evaluate(() => {
      // Reproduce a busy row more than 40 rows above the footer, including a
      // narrow Codex line wrapped by xterm. The real PTY receives this resize.
      terms.get('silent-worker').term.resize(45, 80);
    });
    await page.evaluate((provider) => MainSession.handle({ action: 'main-tell', to: 'silent-worker', message: `busy ${provider}` }, MainSession.mainCol()), provider);
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 20000 }).toBe('working');
    await expect.poll(() => page.evaluate((provider) => {
      const entry = terms.get('silent-worker');
      const marker = { codex: '◦ Working', claude: '✻ Contemplating', agy: 'Searching…', cursor: '⠋ Thinking…' }[provider];
      return statusScreen(entry.term).includes(marker) && Date.now() - entry.lastOutputAt > 1000;
    }, provider)).toBe(true);
    const before = await page.evaluate(() => ({ focusedId, peekId, outputAt: terms.get('silent-worker').lastOutputAt }));
    expect(before.focusedId).not.toBe('silent-worker');
    expect(before.peekId).not.toBe('silent-worker');
    await expect(page.locator('.column[data-col-id="silent-worker"]')).toHaveClass(/backstage/);
    // Longer than both status debounce and ChatUI's six-second quiet fallback.
    await page.waitForTimeout(7500);
    const quiet = await page.evaluate(() => {
      const entry = terms.get('silent-worker');
      return { state: entry.state, outputAt: entry.lastOutputAt, turnDone: ChatUI.turnsOf('silent-worker').at(-1)?.done,
        taskStatus: config.mainSession.tasks.at(-1)?.status, tail: dumpScreen(entry.term), live: statusScreen(entry.term),
        nav: navItems.get('silent-worker').dot.className };
    });
    expect(quiet.outputAt).toBe(before.outputAt);
    expect(quiet.state).toBe('working');
    expect(quiet.nav).toContain('working');
    expect(quiet.turnDone).toBe(false);
    expect(quiet.taskStatus).toBe('working');
    expect(quiet.tail).not.toMatch(/esc to interrupt|esc to cancel|Thinking…/);
    expect(quiet.live).toMatch(/esc to interrupt|esc to cancel|Thinking…/);
    await page.evaluate(() => window.deck.ptyInput('silent-worker', 'finish\r'));
    await expect.poll(() => page.evaluate(() => terms.get('silent-worker').state), { timeout: 15000 }).toBe('done');
    await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('silent-worker').at(-1)?.done)).toBe(true);
    expect(await page.evaluate(() => navItems.get('silent-worker').dot.className)).toContain('done');
  });
}
