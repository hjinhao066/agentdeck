const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A worker cut short by a sleeping computer. Sleep and wake are the real powerMonitor
// events, emitted from the test; nothing actually sleeps.
const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --sleep-error`;
let app, page, profile, promptsFile;
const power = (event) => app.evaluate(({ powerMonitor }, event) => { powerMonitor.emit(event); }, event);
const prompts = () => (fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8') : '');

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sleep-resume-e2e-'));
  promptsFile = path.join(profile, 'prompts.jsonl');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [
    { id: 'sleeper', title: 'Sleeper', cmd: fake, cwd: profile, role: 'manual' },
  ] }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: promptsFile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.get('sleeper')?.alive === true), { timeout: 20000 }).toBe(true);
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
});
test.afterAll(async () => { if (app) await closeElectron(app); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

test('a session cut short by sleep is nudged after waking, finishes by itself, and is never reported as ended without a receipt', async () => {
  test.setTimeout(120000);
  await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'sleeper', message: 'sleep probe' }, MainSession.mainCol()));
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status), { timeout: 30000 }).toBe('working');
  await expect.poll(() => page.evaluate(() => terms.get('sleeper').lastScreen.includes('went to sleep mid-response')), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => terms.get('sleeper').state), { timeout: 20000 }).toBe('done');

  await power('suspend');
  await expect.poll(() => page.evaluate(() => SleepResume.clock.snapshot().asleep)).toBe(true);
  await page.waitForTimeout(14000); // longer than the settle time: still nothing may be sent while asleep
  expect(prompts()).not.toContain('接着做');
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).status)).toBe('working');

  await power('resume');
  await expect.poll(() => page.evaluate(() => SleepResume.clock.snapshot().asleep)).toBe(false);
  await page.waitForTimeout(6000); // the network gets its moment first
  expect(prompts()).not.toContain('接着做');

  await expect.poll(prompts, { timeout: 40000 }).toContain('接着做');
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status), { timeout: 30000 }).toBe('done');
  const task = await page.evaluate(() => config.mainSession.tasks.at(-1));
  expect(task.receipt.source).toBe('command');
  expect(task.receipt.summary).toBe('resumed after sleep');
  expect(await page.evaluate(() => config.mainSession.pending.some((p) => p.source === 'fallback'))).toBe(false);
  expect((prompts().match(/接着做/g) || []).length).toBe(1);
});
