const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');
const STAND_IN_CREDENTIAL = require('./fixtures/stand-in-credential');

// 10-09 12:15, AgentDeck 2.0.3 installed on the Mac and restarted. The 队长's restart notice and three crew continue
// messages were typed while each `claude --resume` was still starting: Claude kept the text in its input box and
// lost the Enter, and the 队长 sat there four hours until the user pressed Enter. Five crew sessions that had
// stopped at their safe point had been closed three minutes before the quit by 已结束，未提交回执 and were never
// continued. Nobody was told. Here: an isolated profile, real windows and PTYs, two app starts around a quit, and
// a stand-in `claude` that takes three seconds to come up and keeps early keys in its box with their Enter lost
// (fixtures/fake-agent.js --startup-ms).
const ROOT = path.resolve(__dirname, '../..');
const SESSION = { cap: '33333333-3333-4333-8333-333333333333', live: '44444444-4444-4444-8444-444444444444', safe: '55555555-5555-4555-8555-555555555555' };

// The stand-ins start in the column's shell: zsh with an empty startup directory, and this test's node first on PATH.
function isolateShell(env, dir) {
  if (process.platform === 'win32') return env;
  fs.writeFileSync(path.join(dir, '.zshrc'), '');
  env.ZDOTDIR = dir;
  if (fs.existsSync('/bin/zsh')) env.SHELL = '/bin/zsh';
  env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
  return env;
}
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
  try {
    await Promise.all([application.close(), exited]);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
// A `claude` that runs the stand-in; a Claude session also needs a signed-in seat (a stand-in login).
// PowerShell does not run a quoted path followed by arguments, so on Windows the column calls it by name
// (the profile is first on PATH, see launch).
function standIn(profile) {
  const script = path.join(profile, 'stand-in.cjs');
  const executable = path.join(profile, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(script, `require(${JSON.stringify(path.join(__dirname, 'fixtures/fake-agent.js'))});`);
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o700 });
  fs.mkdirSync(path.join(profile, 'seats-home', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'seats-home', '.claude', '.credentials.json'), STAND_IN_CREDENTIAL);
  return process.platform === 'win32' ? 'claude' : `"${executable}"`;
}
const rows = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
async function launch(profile, files, extraEnv = {}, args = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  Object.assign(env, { AGENTDECK_TEST_PROMPT_COLUMNS_FILE: files.prompts, AGENTDECK_TEST_EARLY_INPUT_FILE: files.early }, extraEnv);
  delete env.ELECTRON_RUN_AS_NODE;
  isolateShell(env, profile);
  if (process.platform === 'win32') {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';   // Windows spells it Path
    env[key] = profile + path.delimiter + (env[key] || '');
  }
  const application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`, ...args], env });
  const page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof window.MainSession === 'object' && !!window.MainSession.mainCol()).catch(() => false), { timeout: 30000 }).toBe(true);
  return { application, page };
}

test('after a restart the 队长 and every crew session stopped at a safe point are back, and nothing is typed before their prompt is up', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-ready-'));
  const files = { prompts: path.join(profile, 'prompts.jsonl'), early: path.join(profile, 'early.jsonl') };
  const claude = standIn(profile);
  const cmd = claude + ' --startup-ms=3000';
  const crew = (id, title, session) => ({ id, title, displayTitle: title, manualTitle: true, cmd: cmd + ' --screen-only', cwd: profile, width: 460,
    role: 'manual', captainCrew: true, modelSessionId: session, modelSessionOwner: id, modelSessionCwd: profile });
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    resumeOnRestart: true, theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { id: 'cap', title: '队长', isMain: true, cmd, cwd: profile, modelSessionId: SESSION.cap, modelSessionOwner: 'cap', modelSessionCwd: profile },
      crew('worker-live', '干到一半', SESSION.live),
      crew('worker-safe', '停在安全点', SESSION.safe),
    ],
    mainSession: { colId: 'cap', cmd, gen: 1, fresh: false, crewMarked: true, pending: [], inflight: [], waitlist: [], tasks: [
      { id: 'k-live', colId: 'worker-live', title: '干到一半', gen: 1, status: 'working', sentAt: now, startedAt: now, turnId: '' },
      // told to stop at a safe point, it wrote its progress and ended the turn; three minutes later the fallback closed it
      { id: 'k-safe', colId: 'worker-safe', title: '停在安全点', gen: 1, status: 'stopped', sentAt: now, startedAt: now, doneAt: now, turnId: '',
        progress: '停在安全点：改动已推送，下一步写在 progress.md',
        receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } },
    ] } }));
  const received = (colId, from = 0) => rows(files.prompts).slice(from).filter((r) => r.colId === colId).map((r) => r.text);
  let app;
  try {
    // First start: the 队长 gets its prompt, the session that was working is continued.
    app = await launch(profile, files);
    await expect.poll(() => received('cap').length, { timeout: 60000 }).toBe(1);
    await expect.poll(() => received('worker-live').some((t) => t.includes('真续接：Claude')), { timeout: 60000 }).toBe(true);
    await expect.poll(() => app.page.evaluate(() => window.MainSession.state().briefed?.colId), { timeout: 15000 }).toBe('cap');
    await quitAndWait(app.application);

    // Restart. The screens now replay the last run, the idle prompts included.
    const mark = rows(files.prompts).length;
    const earlyMark = rows(files.early).length;
    app = await launch(profile, files);
    await expect.poll(() => received('cap', mark), { timeout: 60000 }).toEqual([M.restartNotice(process.platform, '')]);
    await expect.poll(() => received('worker-live', mark).some((t) => t.includes('真续接：Claude') && t.includes('AgentDeck 刚重启')), { timeout: 60000 }).toBe(true);
    await expect.poll(() => received('worker-safe', mark).some((t) => t.includes('真续接：Claude') && t.includes('AgentDeck 刚重启')), { timeout: 60000 }).toBe(true);
    expect(rows(files.early).slice(earlyMark), 'nothing typed before a prompt was up').toEqual([]);
    const tasks = await app.page.evaluate(() => window.MainSession.state().tasks.map((t) => [t.id, t.status]));
    expect(tasks).toEqual(expect.arrayContaining([['k-live', 'working'], ['k-safe', 'working']]));
    // every one of them is back: no restart alarm
    const view = await app.page.evaluate(() => window.AttentionUI.mobileView());
    expect(view.items.filter((i) => /重启后/.test(i.title))).toEqual([]);
  } catch (error) {
    const state = app && !app.page.isClosed() ? await app.page.evaluate(() => ({
      tasks: window.MainSession.state()?.tasks, screens: Object.fromEntries([...terms].map(([id, e]) => [id, e.lastScreen])),
    })).catch(() => null) : null;
    await testInfo.attach('restart-ready-state', { body: JSON.stringify({ state, prompts: rows(files.prompts), early: rows(files.early) }, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    if (app) await quitAndWait(app.application);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a 队长 that is not back at work after a start is reported on 待我处理 (sidebar and phone) and by an urgent Bark', async () => {
  test.setTimeout(120_000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-alarm-'));
  const files = { prompts: path.join(profile, 'prompts.jsonl'), early: path.join(profile, 'early.jsonl') };
  // its Claude never gets its prompt up within the test
  const cmd = standIn(profile) + ' --startup-ms=600000';
  fs.mkdirSync(path.join(profile, '.secrets'), { recursive: true });
  fs.writeFileSync(path.join(profile, '.secrets', 'bark-key.txt'), 'fake_restart_alarm_key');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    resumeOnRestart: true, theme: 'dark',
    columns: [{ id: 'cap', title: '队长', isMain: true, cmd, cwd: profile, modelSessionId: SESSION.cap, modelSessionOwner: 'cap', modelSessionCwd: profile }],
    mainSession: { colId: 'cap', cmd, gen: 1, fresh: false, crewMarked: true, pending: [], inflight: [], waitlist: [], tasks: [] } }));
  // a Wednesday 14:00 in Seattle: outside the Bark sleep hours and class times
  const barkNow = Date.parse('2026-10-07T21:00:00Z');
  let app;
  try {
    app = await launch(profile, files, { AGENTDECK_TEST_RESTART_WATCH_MS: '4000' }, [`--test-bark-now=${barkNow}`]);
    await expect.poll(async () => (await app.page.evaluate(() => window.AttentionUI.mobileView())).items
      .filter((i) => i.kind === 'need' && i.title === '重启后队长没接上').length, { timeout: 30000 }).toBe(1);
    const item = (await app.page.evaluate(() => window.AttentionUI.mobileView())).items.find((i) => i.title === '重启后队长没接上');
    expect(item.ask).toContain('队长还没开始干活');
    expect(item.detail).toContain('（cap）');
    expect(await app.page.evaluate(() => window.AttentionUI.counts().need)).toBe(1);   // the sidebar's number
    await expect.poll(() => app.application.evaluate(({ app: a }) => a.testCaptainAlerts.filter((x) => x.type === 'bark').map((x) => [x.title, x.level])), { timeout: 30000 })
      .toEqual([['AgentDeck · 重启没接上', 'critical']]);
    expect(rows(files.early)).toEqual([]);
    await app.page.waitForTimeout(6000);
    expect((await app.page.evaluate(() => window.AttentionUI.mobileView())).items.filter((i) => i.title === '重启后队长没接上')).toHaveLength(1);
  } finally {
    if (app) await quitAndWait(app.application);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// 10-09 21:04: the app came back without the five sessions the 3-minute rule had closed, the second time that
// evening. However the app went down, a crash included (no quit, nothing parked), they are continued.
test('after a crash, a crew session the 3-minute rule had closed at its safe point is continued', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-crash-'));
  const files = { prompts: path.join(profile, 'prompts.jsonl'), early: path.join(profile, 'early.jsonl') };
  const cmd = standIn(profile) + ' --startup-ms=3000';
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false },
    resumeOnRestart: true, theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [
      { id: 'cap', title: '队长', isMain: true, cmd, cwd: profile, modelSessionId: SESSION.cap, modelSessionOwner: 'cap', modelSessionCwd: profile },
      { id: 'worker-safe', title: '停在安全点', displayTitle: '停在安全点', manualTitle: true, cmd: cmd + ' --screen-only', cwd: profile, width: 460,
        role: 'manual', captainCrew: true, modelSessionId: SESSION.safe, modelSessionOwner: 'worker-safe', modelSessionCwd: profile },
    ],
    mainSession: { colId: 'cap', cmd, gen: 1, fresh: false, crewMarked: true, pending: [], inflight: [], waitlist: [], tasks: [
      { id: 'k-safe', colId: 'worker-safe', title: '停在安全点', gen: 1, status: 'stopped', sentAt: now, startedAt: now, doneAt: now, turnId: '',
        progress: '停在安全点：改动已推送，下一步写在 progress.md',
        receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' } },
    ] } }));
  const received = (colId, from = 0) => rows(files.prompts).slice(from).filter((r) => r.colId === colId).map((r) => r.text);
  let app;
  try {
    app = await launch(profile, files);
    await expect.poll(() => received('cap').length, { timeout: 60000 }).toBe(1);
    // The app dies: no quit, so nothing is parked.
    const child = app.application.process();
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await gone;
    app = null;
    const mark = rows(files.prompts).length;
    app = await launch(profile, files);
    await expect.poll(() => received('worker-safe', mark).some((t) => t.includes('真续接：Claude') && t.includes('AgentDeck 刚重启')), { timeout: 60000 }).toBe(true);
    expect(await app.page.evaluate(() => window.MainSession.state().tasks.find((t) => t.id === 'k-safe').status)).toBe('working');
  } catch (error) {
    await testInfo.attach('restart-crash-state', { body: JSON.stringify({ prompts: rows(files.prompts), early: rows(files.early) }, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    if (app) await quitAndWait(app.application);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
