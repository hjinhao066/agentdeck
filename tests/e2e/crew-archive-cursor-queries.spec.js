const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A finished background session whose agent keeps asking the terminal for the cursor
// position (Claude Code sends ESC[?6n every few seconds while idle) is still quiet:
// those queries draw nothing, so the automatic archive takes it like any other.
// Stand-in agent only.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-cursorq-'));
  const now = Date.now();
  const H = 3_600_000;
  const col = (id, cmd) => ({ id, title: id, displayTitle: id, manualTitle: true, cmd, cwd: profile, width: 460, role: 'manual', captainCrew: true });
  const finished = (id, colId) => ({ id, colId, title: id, gen: 1, status: 'done', sentAt: now - 3 * H, doneAt: now - 3 * H + 60_000, turnId: '', receipt: { summary: '做完了', files: [], explicit: true } });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, resumeOnRestart: false,
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { id: 'cap', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      col('asks', FAKE + ' --cursor-queries'), col('plain', FAKE),
    ],
    mainSession: {
      colId: 'cap', cmd: FAKE, gen: 1, fresh: false, crewMarked: true, waitlist: [], inflight: [], pending: [],
      tasks: [finished('k1', 'asks'), finished('k2', 'plain')],
    },
  }));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(3);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a finished session that only sends cursor-position queries is archived', async () => {
  // ConPTY answers the query itself on Windows: nothing reaches the terminal there.
  test.skip(process.platform === 'win32', 'ConPTY swallows ESC[?6n');
  // The 10 quiet minutes are shortened; the 60 s of silent output archiveColumn requires is not.
  test.setTimeout(180_000);
  // the stand-in really is sending them: the PTY output keeps coming
  await expect.poll(() => page.evaluate(() => window.deck.ptyReplay('asks', true).then((r) => (r.data.match(/\x1b\[\?6n/g) || []).length)), { timeout: 20_000 }).toBeGreaterThan(2);
  await page.evaluate(() => { MainCore.ARCHIVE_AFTER = 1500; });
  await expect.poll(() => page.evaluate(() => config.archived.map((a) => a.id).sort()), { timeout: 150_000 }).toEqual(['asks', 'plain']);
});
