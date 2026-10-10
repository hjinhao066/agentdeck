const { test, expect, _electron: electron } = require('@playwright/test');
const { execSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');
const mockApi = require('./fixtures/mock-model-api');
const STAND_IN_CREDENTIAL = require('./fixtures/stand-in-credential');

// Opt-in probe, never part of an ordinary run: AgentDeck installed and restarted with a real Claude Code
// 队长 (10-09, 2.0.3 on the Mac: the restart notice went in while `claude --resume` was still starting,
// stayed in its input box with the Enter lost, and the 队长 sat four hours).
//   AGENTDECK_REAL_CLI=claude npm run e2e -- tests/e2e/real-cli-restart.spec.js
// A throwaway profile; its `claude` is the installed CLI with an empty config directory and a local
// stand-in for the model API (no login, no quota). The app is quit and started again three times around the
// same conversation four times; each start, the notice must land in the CLI's conversation, once.
// (Measured with 2.1.295: the UI is up 0.6 s after the CLI starts, 1.5 s for the 队长's 26 MB conversation;
// padding a test conversation to 25 MB does not slow it, so none is added here.)
const WANTED = (process.env.AGENTDECK_REAL_CLI || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = path.resolve(__dirname, '../..');
const CAPTAIN = 'real-captain';

async function quitAndWait(application) {
  const child = application.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await application.evaluate(({ app }) => {
    const quit = app.quit.bind(app);
    app.quit = () => { setTimeout(quit, 50); };
  });
  let deadline;
  const exited = new Promise((resolve, reject) => {
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    deadline = setTimeout(() => reject(new Error('Electron did not exit within 8 seconds')), 8000);
  });
  try { await Promise.all([application.close(), exited]); }
  finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('real claude: after each restart the resumed 队长 takes its restart notice, and nothing is reported', async ({}, testInfo) => {
  test.skip(!WANTED.includes('claude') || process.platform === 'win32', 'set AGENTDECK_REAL_CLI=claude on macOS to run this against the installed CLI');
  test.setTimeout(600_000);
  const api = await mockApi.start();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-real-restart-'));
  const real = execSync('command -v claude', { encoding: 'utf8', shell: '/bin/bash' }).trim();
  const cfg = path.join(profile, 'cli-config');
  fs.mkdirSync(cfg, { recursive: true });
  const here = [...new Set([profile, fs.realpathSync(profile)])];
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    projects: Object.fromEntries(here.map((p) => [p, { hasTrustDialogAccepted: true }])) }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  // The column's `claude`: AgentDeck sees Claude (and resumes it by id); the CLI sees only the throwaway setup.
  const wrapper = path.join(profile, 'claude');
  fs.writeFileSync(wrapper, ['#!/bin/bash',
    'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDECODE',
    `export CLAUDE_CONFIG_DIR=${JSON.stringify(cfg)} ANTHROPIC_BASE_URL=http://127.0.0.1:${api.port} ANTHROPIC_AUTH_TOKEN=probe-not-a-real-key`,
    'export ANTHROPIC_MODEL=claude-opus-5-5 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1',
    `exec ${JSON.stringify(real)} "$@"`, ''].join('\n'), { mode: 0o700 });
  fs.mkdirSync(path.join(profile, 'seats-home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'seats-home', '.claude', '.credentials.json'), STAND_IN_CREDENTIAL);
  fs.writeFileSync(path.join(profile, '.zshrc'), '');
  const cmd = `"${wrapper}" --dangerously-skip-permissions`;
  // The 队长's own conversation, already there (like the real one): every start resumes it by its id.
  const SESSION = '66666666-6666-4666-8666-666666666666';
  // Not execSync: the stand-in API runs in this process and has to answer meanwhile.
  await promisify(execFile)(wrapper, ['-p', 'first turn', '--session-id', SESSION], { cwd: profile, timeout: 120000 });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 1,
    mainSession: { colId: CAPTAIN, cmd, gen: 1, fresh: false, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [{ id: CAPTAIN, title: '队长', isMain: true, cmd, cwd: profile, modelSessionId: SESSION, modelSessionOwner: CAPTAIN, modelSessionCwd: profile }] }));
  const env = { ...process.env, ZDOTDIR: profile };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  if (fs.existsSync('/bin/zsh')) env.SHELL = '/bin/zsh';
  const notice = M.restartNotice(process.platform, '');
  // Every model request carries the whole conversation, so count the notice where it lands once: as a user
  // message in the CLI's own conversation file.
  const conversation = () => {
    const dir = path.join(cfg, 'projects');
    for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, sub, SESSION + '.jsonl');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    }
    return [];
  };
  const notices = () => conversation().filter((l) => l.type === 'user' && l.message?.content === notice).length;
  // The 队长 of 10-09 had worked for hours: the replay keeps only its last 200 KB of output, long after its switch
  // to the alternate screen, so the restart painted its last idle frame into the main screen. A short test
  // session still has that switch in its replay; take it out, as those hours would have.
  const likeALongSession = () => {
    const file = path.join(profile, 'sessions', CAPTAIN + '.txt');
    if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\x1b\[\?(?:1049|1047|47)[hl]/g, ''));
  };
  const launch = async () => {
    const application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
    const page = await application.firstWindow();
    await page.waitForFunction((id) => typeof terms !== 'undefined' && terms.get(id)?.alive, CAPTAIN, { timeout: 30000 });
    return { application, page };
  };
  let app;
  const timings = [];
  try {
    // First start: nothing says this conversation got the prompt yet, so it gets the core prompt.
    app = await launch();
    await expect.poll(() => app.page.evaluate(() => window.MainSession.state().briefed?.colId), { timeout: 120000 }).toBe(CAPTAIN);
    await expect.poll(() => api.userTexts().some((t) => t.startsWith('你是 AgentDeck')), { timeout: 60000 }).toBe(true);
    await app.page.waitForTimeout(3000);
    await quitAndWait(app.application);
    app = null;
    console.log(`[real-cli-restart] ${execSync(`${JSON.stringify(real)} --version`, { encoding: 'utf8' }).trim()}`);
    for (let round = 1; round <= 4; round++) {
      likeALongSession();
      const started = Date.now();
      app = await launch();
      await expect.poll(notices, { timeout: 90000 }).toBe(round);
      await expect.poll(() => api.userTexts().includes(notice), { timeout: 30000 }).toBe(true);
      timings.push(Date.now() - started);
      await app.page.waitForTimeout(3000);
      const alarms = (await app.page.evaluate(() => window.AttentionUI.mobileView())).items.filter((i) => /重启后/.test(i.title));
      expect(alarms).toEqual([]);
      await quitAndWait(app.application);
      app = null;
    }
    console.log(`[real-cli-restart] the notice reached the model ${timings.map((ms) => (ms / 1000).toFixed(1) + ' s').join(', ')} after each start`);
  } catch (error) {
    const screen = app ? await app.page.evaluate((id) => dumpScreen(terms.get(id).term, 30), CAPTAIN).catch(() => '') : '';
    await testInfo.attach('real-cli-restart', { body: JSON.stringify({ timings, requests: api.requests.length, screen }, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    if (app) await quitAndWait(app.application);
    await api.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
