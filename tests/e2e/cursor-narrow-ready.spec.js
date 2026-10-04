const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A Cursor session in the narrowest column (260px, about 30 terminal columns)
// wraps its "Plan, search, build anything" prompt over two rows. The session
// must still count as ready, so 队长's work reaches it (it used to sit at
// "not started" for good, whatever the model).
const CURSOR = `node "${path.join(__dirname, 'fixtures', 'cursor-agent.js')}"`;
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-cursor-narrow-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: false, fitCols: 3,
    columns: [['cn-narrow', CURSOR], ['cn-busy', CURSOR + ' --busy']].map(([id, cmd]) => ({
      id, taskId: `task-${id}`, title: id, cmd, cwd: profile, width: 260, role: 'manual' })),
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await page.waitForLoadState('load');
  await page.waitForFunction(() => { try { return terms.has('cn-narrow') && terms.has('cn-busy'); } catch (_) { return false; } }, null, { timeout: 20000 });
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a Cursor prompt wrapped by a narrow column is ready, and a task sent to it arrives', async () => {
  await expect.poll(() => page.evaluate(() => {
    const e = terms.get('cn-narrow');
    return !!e && e.alive && !!(e.term.modes && e.term.modes.bracketedPasteMode) && /build\s*\n\s*anything/.test(e.lastScreen || '');
  }), { timeout: 20000 }).toBe(true);
  const screen = await page.evaluate(() => terms.get('cn-narrow').lastScreen);
  expect(screen).not.toContain('Plan, search, build anything');   // really wrapped
  expect(await page.evaluate(() => terms.get('cn-narrow').term.cols)).toBeLessThan(36);

  const outcome = await page.evaluate(() => new Promise((resolve) => {
    const col = columns.find((c) => c.id === 'cn-narrow');
    sendWhenReady(col, '请回答 ok', { timeout: 15000, force: true, requireIdle: true, onSent: () => resolve('sent'), onGiveUp: () => resolve('gave-up') });
  }));
  expect(outcome).toBe('sent');
  await expect.poll(() => page.evaluate(() => terms.get('cn-narrow').lastScreen), { timeout: 10000 }).toContain('GOT: 请回答 ok');
});

test('a busy narrow Cursor screen (spinner above the wrapped prompt) is not ready and receives nothing', async () => {
  await expect.poll(() => page.evaluate(() => {
    const e = terms.get('cn-busy');
    return !!e && e.alive && !!(e.term.modes && e.term.modes.bracketedPasteMode) && /Reading/.test(e.lastScreen || '') && /build\s*\n\s*anything/.test(e.lastScreen || '');
  }), { timeout: 20000 }).toBe(true);
  const outcome = await page.evaluate(() => new Promise((resolve) => {
    const col = columns.find((c) => c.id === 'cn-busy');
    sendWhenReady(col, '不该送进去', { timeout: 6000, force: true, requireIdle: true, onSent: () => resolve('sent'), onGiveUp: () => resolve('gave-up') });
  }));
  expect(outcome).toBe('gave-up');
  const screen = await page.evaluate(() => terms.get('cn-busy').lastScreen);
  expect(screen).not.toContain('GOT:');
  expect(await page.evaluate(() => terms.get('cn-busy').state)).toBe('working');
});
