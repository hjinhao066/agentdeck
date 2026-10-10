const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A long archive and a conversation that fell out of it (the archive kept only 500 before
// 2.0.4). At launch the lost conversation is back in 已归档, the list shows a page at a
// time, and restoring the recovered row opens a column with what was said in it.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-archive-recovery-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navArchivedOpen: true,
    columns: [{ id: 'ar-live', taskId: 'task-live', title: 'Open session', cmd: FAKE, cwd: profile, width: 460, role: 'manual' }],
    archived: Array.from({ length: 120 }, (_, i) => ({
      id: `ar-old-${i}`, title: `Archived ${i}`, cmd: FAKE, cwd: profile, role: 'manual', archivedAt: 1_760_000_000_000 + i * 60_000,
    })),
  }));
  const turn = (user, ts) => ({ id: 'u' + ts, ts, user, reply: 'GOT ' + user, done: true, atts: [] });
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'ar-lost.json'), JSON.stringify({ v: 1, id: 'ar-lost', turns: [turn('find the lost drill', 1_700_000_000_000), turn('and its follow-up', 1_700_000_060_000)] }));
  fs.writeFileSync(path.join(profile, 'chats', 'ar-silent.json'), JSON.stringify({ v: 1, id: 'ar-silent', turns: [] }));
  fs.mkdirSync(path.join(profile, 'sessions'));
  fs.writeFileSync(path.join(profile, 'sessions', 'ar-lost.txt'), 'saved output of the lost session\r\n');
  fs.writeFileSync(path.join(profile, 'sessions', 'ar-gone.txt'), 'a session nothing points at\r\n');
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]),
      `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(1);
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
});

test('a conversation that fell out of the archive is back, the archive pages, and restoring it shows the conversation', async () => {
  test.setTimeout(90000);
  await expect(page.locator('#toast')).toHaveText(/找回了 1 段掉出归档的对话/);
  // on disk: listed again, the config as it was kept aside, its replay kept, a dead replay pruned
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(saved.archived.find((a) => a.id === 'ar-lost')).toMatchObject({ title: 'find the lost drill', archivedAt: 1_700_000_060_000, recovered: true });
  expect(saved.archived.some((a) => a.id === 'ar-silent')).toBe(false);
  expect(fs.readdirSync(profile).filter((f) => f.startsWith('config.json.before-archive-recovery-'))).toHaveLength(1);
  expect(fs.readdirSync(path.join(profile, 'sessions')).sort()).toEqual(expect.arrayContaining(['ar-lost.txt']));
  expect(fs.existsSync(path.join(profile, 'sessions', 'ar-gone.txt'))).toBe(false);

  // the sidebar: all 121 counted, the newest 100 listed, the rest one click away
  await expect(page.locator('.nav-section[data-section="archived"] .nav-section-count')).toHaveText('121');
  await expect(page.locator('.nav-archived-item')).toHaveCount(100);
  await expect(page.locator('.nav-archived-item').first()).toHaveAttribute('data-archived-id', 'ar-old-119');
  const more = page.locator('.nav-archived-more');
  await expect(more).toHaveText('显示更早的 21 个（还有 21 个）');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.nav-archived-item')).toHaveCount(121);
  await expect(more).toHaveCount(0);
  const lost = page.locator('.nav-archived-item[data-archived-id="ar-lost"]');
  await expect(lost).toContainText('find the lost drill');
  await expect(page.locator('.nav-archived-item').last()).toHaveAttribute('data-archived-id', 'ar-lost');

  // it is searchable like any archived conversation
  await page.locator('#navSearch').fill('lost drill');
  await expect(page.locator('#navResults .nr-item', { hasText: '已归档' }).first()).toBeVisible();
  await page.locator('#navSearch').fill('');

  // restore: a column under the same id, with the conversation
  await page.locator('.nav-archived-item[data-archived-id="ar-lost"]').click();
  const restored = page.locator('.column[data-col-id="ar-lost"]');
  await expect(restored).toBeVisible();
  await restored.locator('.view-toggle').click();
  await expect(restored.locator('.msg.user .bubble')).toHaveText(['find the lost drill', 'and its follow-up']);
  await expect.poll(() => page.evaluate(() => window.deck.ptyIsAlive('ar-lost')), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => config.archived.length)).toBe(120);
  expect(fs.existsSync(path.join(profile, 'chats', 'ar-lost.json'))).toBe(true);
});
