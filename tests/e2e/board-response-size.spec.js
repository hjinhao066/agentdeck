const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Answers to board commands are kept so a request asked again gets the same
// answer. Verbatim answers (a task list, a session's text) reach a megabyte
// each; kept in config.json, a live Windows profile's file had grown to 6 MB
// (4.5 MB of it these answers) and was rewritten several times a minute, with
// room to grow to 200 such answers. Long answers now stay in memory only.
const ROOT = path.resolve(__dirname, '../..');
let app, page, profile;
const saved = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-responses-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, globalViewMode: 'term',
    columns: [{ id: 'shell', title: 'Shell', cmd: '', role: 'manual', view: 'term' }],
    boardResponses: {
      'old-list': { done: true, result: '[' + '{"id":"t-1"},'.repeat(40000) + '{}]', updatedAt: 1 },
      'old-ack': { done: true, result: 'Result delivered.', updatedAt: 2 },
    } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof respondBoard === 'function' && typeof flushConfig === 'function'), { timeout: 30000 }).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a long verbatim answer is kept in memory, not written into config.json', async () => {
  await page.evaluate(() => {
    respondBoard('big-read', { done: true, result: 'line of a long session\n'.repeat(30000) }, true);
    respondBoard('small-ack', { done: true, result: 'Message sent.' }, true);
    flushConfig();
  });
  await expect.poll(() => Object.keys(saved().boardResponses || {}).sort(), { timeout: 10000 }).toEqual(['old-ack', 'small-ack']);
  expect(fs.statSync(path.join(profile, 'config.json')).size).toBeLessThan(200 * 1024);
  // the long answer still replays for this page's life
  expect(await page.evaluate(() => liveBoardResponses.get('big-read')?.result.length)).toBe('line of a long session\n'.length * 30000);
});
