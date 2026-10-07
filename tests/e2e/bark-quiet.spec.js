// Isolated profiles capture every transport; fake keys never reach Bark.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const closeElectron = require('./fixtures/close-electron');
const Calendar = require('../../bark-calendar');
const ROOT = path.resolve(__dirname, '../..');
const CLI = process.platform === 'win32' ? '$env:AGENTDECK_BOARD_CLI' : '$AGENTDECK_BOARD_CLI';
let application, page, profile;
const at = (day, hour, minute = 0) => { const value = new Date(day); value.setHours(hour, minute, 0, 0); return value.getTime(); };
const pendingFile = () => path.join(profile, 'bark-pending.json');
const pending = () => JSON.parse(fs.readFileSync(pendingFile(), 'utf8')).pending;
const status = () => page.evaluate(() => window.deck.barkStatus());
const digests = () => application.evaluate(({ app }) => app.testBarkDigests);
const local = () => application.evaluate(({ app }) => app.testCaptainAlerts.filter((event) => event.type === 'notification'));
async function clock(value, flush = false) {
  await application.evaluate(async ({ app }, input) => {
    app.testBarkNow = input.value;
    if (input.flush) await app.testBarkFlush();
  }, { value, flush });
}
async function launch(now) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [ROOT, `--test-user-data=${profile}`, `--test-bark-now=${now}`], env });
  page = await application.firstWindow();
  await expect(page.locator('.xterm')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => terms.get('captain')?.alive)).toBe(true);
  await expect.poll(() => application.evaluate(({ app }) => typeof app.testBarkFlush)).toBe('function');
}
async function urgent(message) {
  const count = (await local()).length;
  await page.evaluate((command) => window.deck.ptyInput('captain', command + '\r'),
    `node "${CLI}" notify-user --message "${message}" --urgent`);
  await expect.poll(async () => (await local()).length).toBe(count + 1);
}
test.beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bark-quiet-'));
  const key = path.join(profile, 'fake-key'); fs.writeFileSync(key, 'fake_quiet_test_key');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', barkKeyFile: key, barkNotifications: { classesEnabled: false },
    perpetualCaptain: { enabled: false }, mainSession: { colId: 'captain', cmd: '', crewMarked: true },
    columns: [{ id: 'captain', title: '队长', isMain: true, cmd: '', cwd: profile }],
  }));
});
test.afterEach(async () => {
  if (application) { await closeElectron(application); application = null; }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('night urgent and active reminders stay local, deduplicate durably and merge at 10:00', async () => {
  const day = Date.now(); await launch(at(day, 9));
  await urgent('US 席位需要重新登录。');
  await expect.poll(async () => (await status()).queuedCount).toBe(1);
  await urgent('US 席位需要重新登录。');
  await expect.poll(async () => (await local()).length).toBe(2);
  await expect.poll(async () => (await status()).queuedCount).toBe(1);
  await urgent('请确认另一席位授权。');
  await expect.poll(async () => (await status()).queuedCount).toBe(2);
  await page.evaluate(async () => {
    const added = await window.deck.taskBoard('add', { project: '离线测试', title: '决定课程材料', detail: '需要用户选择。' });
    await window.deck.taskBoard('move', { id: added.card.id, status: 'needs_user' });
  });
  await expect.poll(async () => (await status()).queuedCount, { timeout: 10000 }).toBe(3);
  expect(pending()).toHaveLength(3);
  expect(pending().filter((item) => item.message === 'US 席位需要重新登录。')).toHaveLength(1);
  expect(pending().some((item) => item.level === 'active')).toBe(true);
  expect(fs.readFileSync(pendingFile(), 'utf8')).not.toContain('fake_quiet_test_key');
  await closeElectron(application); application = null;
  await launch(at(day, 9));
  await expect.poll(async () => (await status()).queuedCount).toBe(3);
  await clock(at(day, 9, 59), true); expect(await digests()).toHaveLength(0);
  expect(await application.evaluate(({ app }) => app.testCaptainAlerts.filter((event) => event.type === 'bark'))).toHaveLength(0);
  expect(await application.evaluate(({ app }) => app.testNeedsUserAlerts)).toHaveLength(0);
  await clock(at(day, 10), true);
  expect(await digests()).toHaveLength(1);
  const [digest] = await digests();
  expect(digest).toMatchObject({ level: 'critical', volume: 4 });
  expect(digest.body).toContain('3 项提醒');
  expect(digest.body).toContain('US 席位需要重新登录。');
  expect(digest.body).toContain('决定课程材料');
  expect(pending()).toHaveLength(0);
  await clock(at(day, 10, 1), true); expect(await digests()).toHaveLength(1);
});

test('fresh cached class ranges postpone reminders until the exact 12:20 end', async () => {
  const day = Date.now(), now = at(day, 10);
  const file = path.join(profile, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.barkNotifications = { classesEnabled: true };
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(profile, 'bark-calendar.json'), JSON.stringify({
    version: 1, settingsKey: JSON.stringify({ enabled: true, calendarIds: ['primary'], filters: ['IMT 540', 'IMT 598 B'] }), state: 'ok',
    fetchedAt: now, lastAttemptAt: now, rangeStart: at(now, 0), rangeEnd: now + 14 * Calendar.DAY_MS,
    ranges: [{ start: at(day, 10, 30), end: at(day, 12, 20) }],
  }));
  await launch(now); await clock(at(day, 10, 30));
  expect((await status()).calendar.available).toBe(true);
  await urgent('课后请登录席位。');
  await expect.poll(async () => (await status()).queuedCount).toBe(1);
  expect(await local()).toHaveLength(1);
  await clock(at(day, 12, 19), true); expect(await digests()).toHaveLength(0);
  await clock(at(day, 12, 20), true);
  expect(await digests()).toHaveLength(1);
  expect((await digests())[0]).toMatchObject({ level: 'critical', volume: 4, body: expect.stringContaining('课后请登录席位。') });
  expect(pending()).toHaveLength(0);
});

test('missing calendar CLI visibly uses weekly fallback and postpones a Thursday class alert until 12:20', async () => {
  const configFile = path.join(profile, 'config.json'), config = JSON.parse(fs.readFileSync(configFile));
  config.barkNotifications = { sleepEnabled: false, classesEnabled: true };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const now = Date.parse('2026-10-08T11:00:00-07:00');
  await launch(now);
  await expect.poll(async () => (await status()).calendar.fallback).toBe(true);
  await urgent('US 需要在下课后重新登录。');
  await expect.poll(async () => (await status()).queuedCount).toBe(1);
  expect(await digests()).toHaveLength(0);
  expect((await status()).blockedUntil).toBe(Date.parse('2026-10-08T12:20:00-07:00'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#barkPolicyStatus')).toContainText('使用每周固定上课时段');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await clock(Date.parse('2026-10-08T12:20:00-07:00'), true);
  expect(await digests()).toHaveLength(1);
  expect((await digests())[0]).toMatchObject({ level: 'critical', volume: 4 });
});
