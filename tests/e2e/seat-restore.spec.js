// A session opened with --seat us2 comes back on us2 every way a Claude process is started
// again (tell restoring it from 已归档, restartWorker, respawnColumn, an app restart), and a
// seat that is signed out starts nothing: no other seat stands in for it.
const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-agent.js');
const FAKE = `node "${FAKE_AGENT}"`;
const SIGNED_OUT = /席位 US2（us2@example\.test）未登录/;
// The terminal wraps a long notice over several rows.
const flat = (text) => String(text || '').replace(/\s+/g, '');
let sandbox, profile, home, seatHome, us2Dir, claude, app, page;

function records(name) {
  try { return fs.readFileSync(path.join(profile, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// Every start of the stand-in, with the CLAUDE_CONFIG_DIR that process actually got.
const launches = (id) => records('seat-env.jsonl').filter((r) => r.colId === id);
const prompts = (id) => records('prompt-columns.jsonl').filter((r) => r.colId === id).map((r) => r.text);
const screen = (id) => page.evaluate((i) => { const e = terms.get(i); return e ? dumpScreen(e.term) : ''; }, id);
async function diagnose(testInfo) {
  if (!page || page.isClosed()) return;
  const state = await page.evaluate(() => typeof terms === 'undefined' ? null : {
    columns: columns.map((c) => ({ id: c.id, seat: c.claudeSeatId, dir: c.claudeConfigDir, cmd: c.cmd })),
    archived: config.archived.map((a) => a.id),
    terms: [...terms].map(([id, e]) => ({ id, alive: e.alive, state: e.state, seatBlock: e.seatBlock, launchPending: e.launchPending, screen: dumpScreen(e.term) })),
    tasks: MainSession.state().tasks.map((t) => ({ colId: t.colId, status: t.status, failed: t.receipt?.failed })),
  }).catch((e) => ({ error: e.message }));
  await testInfo.attach('seat-restore-state', { body: JSON.stringify({ state, launches: records('seat-env.jsonl') }, null, 2), contentType: 'application/json' });
}
const lastTask = (id) => page.evaluate((i) => MainSession.state().tasks.filter((t) => t.colId === i).at(-1) || null, id);
const captain = (message) => page.evaluate((m) => MainSession.handle(m, MainSession.mainCol()).then((r) => ({ ok: r }), (e) => ({ error: e.message })), message);

async function launch() {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZDOTDIR: home,
    AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'), AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompt-columns.jsonl') };
  // This runner may itself sit in an AgentDeck terminal: none of its seat or control variables go in.
  for (const key of Object.keys(env)) if (/^AGENTDECK_(?!TEST_)/.test(key) || key === 'CLAUDE_CONFIG_DIR') delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.get('cap')?.lastScreen || ''), { timeout: 20000 }).toContain('Claude Code');
}
// `new --seat us2` with a program named claude, so the real seat launch wrapper runs.
async function openOnUs2(extra = '') {
  const result = await captain({ action: 'main-new', id: 'seat-probe-' + Date.now(), title: 'Seat probe', task: 'initial task',
    command: `${claude} --dangerously-skip-permissions --model claude-opus-5-5${extra}`, cwd: profile, seatId: 'us2' });
  expect(result.error).toBeUndefined();
  const id = await page.evaluate(() => columns.find((c) => c.displayTitle === 'Seat probe').id);
  await expect.poll(() => launches(id).length, { timeout: 20000 }).toBe(1);
  await expect.poll(() => prompts(id).some((p) => p.startsWith('initial task')), { timeout: 20000 }).toBe(true);
  return id;
}
async function archive(id) {
  await expect.poll(() => page.evaluate((i) => terms.get(i)?.state, id), { timeout: 20000 }).toBe('done');
  expect((await captain({ action: 'main-archive', to: id })).error).toBeUndefined();
  expect(await page.evaluate((i) => config.archived.find((a) => a.id === i)?.claudeSeatId, id)).toBe('us2');
}

test.beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-seat-restore-')));
  profile = path.join(sandbox, 'profile'); home = path.join(sandbox, 'home');
  seatHome = path.join(profile, 'seats-home');   // where a test profile's main process keeps seat logins
  us2Dir = path.join(seatHome, '.claude-us2');
  for (const dir of [profile, home, path.join(seatHome, '.claude'), us2Dir, path.join(sandbox, 'bin')]) fs.mkdirSync(dir, { recursive: true });
  // Stand-in logins: a credential file exists. A test profile never reads a real Keychain or runs the real CLI.
  for (const dir of [path.join(seatHome, '.claude'), us2Dir]) fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
  fs.writeFileSync(path.join(seatHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test' }, hasCompletedOnboarding: true }));
  fs.writeFileSync(path.join(us2Dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us2@example.test' }, hasCompletedOnboarding: true }));
  claude = path.join(sandbox, 'bin', 'claude');   // a program named claude to the app, never the real CLI
  fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    fitWindow: true, fitCols: 2, perpetualCaptain: { enabled: false }, quotaWarmup: { enabled: false },
    // Absolute directories inside the profile, so the page and the main process read the same ones.
    // CN is the active seat: a session that lost its seat would land there.
    claudeSeats: [
      { id: 'cn', name: 'CN', configDir: path.join(seatHome, '.claude') },
      { id: 'us2', name: 'US2', configDir: us2Dir, email: 'us2@example.test' },
    ],
    activeClaudeSeatId: 'cn',
    columns: [{ id: 'cap', title: '队长', cmd: FAKE, cwd: profile, isMain: true, claudeSeatId: 'cn' }],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, fresh: false, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
  }));
  await launch();
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) await diagnose(testInfo);
  if (app) await closeElectron(app);
  app = null;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a --seat us2 session starts again on us2 after archive + tell, restartWorker, an app restart and respawnColumn', async () => {
  test.setTimeout(150000);
  const id = await openOnUs2();
  expect(launches(id)[0]).toEqual({ colId: id, configDir: us2Dir, authOverridePresent: false });
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 20000 }).toBe('done');

  await archive(id);
  const told = await captain({ action: 'main-tell', to: id, message: 'restored work' });
  expect(told.ok.result).toMatch(/已恢复/);
  await expect.poll(() => launches(id).length, { timeout: 20000 }).toBe(2);
  expect(launches(id)[1].configDir).toBe(us2Dir);
  await expect.poll(() => prompts(id).some((p) => p.startsWith('restored work')), { timeout: 30000 }).toBe(true);
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 20000 }).toBe('done');

  await page.evaluate((i) => restartWorker(columns.find((c) => c.id === i)), id);
  await expect.poll(() => launches(id).length, { timeout: 20000 }).toBe(3);
  expect(launches(id)[2].configDir).toBe(us2Dir);
  await expect.poll(() => screen(id), { timeout: 20000 }).toContain('Claude Code');

  await closeElectron(app);
  await launch();
  await expect.poll(() => launches(id).length, { timeout: 20000 }).toBe(4);
  expect(launches(id)[3].configDir).toBe(us2Dir);
  await expect.poll(() => screen(id), { timeout: 20000 }).toContain('Claude Code');

  // A crew column reopened under a new id (cwd or command edit) has no task record yet.
  const fresh = await page.evaluate((i) => respawnColumn(columns.find((c) => c.id === i)).id, id);
  expect(fresh).not.toBe(id);
  await expect.poll(() => launches(fresh).length, { timeout: 20000 }).toBe(1);
  expect(launches(fresh)[0].configDir).toBe(us2Dir);
  expect(records('seat-env.jsonl').filter((r) => r.colId !== 'cap').every((r) => r.configDir === us2Dir && !r.authOverridePresent)).toBe(true);
});

test('tell does not bring back a session whose own seat is signed out, and never starts it on another seat', async () => {
  test.setTimeout(90000);
  const id = await openOnUs2();
  await archive(id);
  fs.unlinkSync(path.join(us2Dir, '.credentials.json'));   // US2 signs out
  const told = await captain({ action: 'main-tell', to: id, message: 'restored work' });
  expect(told.error).toMatch(SIGNED_OUT);
  expect(told.error).toContain('不会换到别的席位');
  expect(await page.evaluate((i) => [config.archived.some((a) => a.id === i), columns.some((c) => c.id === i)], id)).toEqual([true, false]);
  await page.waitForTimeout(3000);
  expect(launches(id)).toHaveLength(1);
  expect(prompts(id).some((p) => p.startsWith('restored work'))).toBe(false);
});

test('a signed-out seat starts nothing when restored by hand or after an app restart; work for it fails with the seat named', async () => {
  test.setTimeout(150000);
  const id = await openOnUs2();
  await archive(id);
  fs.unlinkSync(path.join(us2Dir, '.credentials.json'));   // US2 signs out

  // The user restores it from 已归档: the column says why, and nothing starts on any seat.
  await page.evaluate((i) => restoreArchived(i, true), id);
  await expect.poll(() => screen(id).then(flat), { timeout: 20000 }).toContain(flat('席位 US2（us2@example.test）未登录，没有启动 Claude，也不会换到别的席位'));
  await page.waitForTimeout(2000);
  expect(launches(id)).toHaveLength(1);

  // Work sent to it fails at once with the seat named; nothing is typed into its shell.
  const told = await captain({ action: 'main-tell', to: id, message: 'more work' });
  expect(told.error).toBeUndefined();
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 20000 }).toBe('failed');
  expect((await lastTask(id)).receipt.failed).toMatch(SIGNED_OUT);
  expect(prompts(id).some((p) => p.startsWith('more work'))).toBe(false);

  // Still signed out after a restart: still nothing.
  await closeElectron(app);
  await launch();
  await expect.poll(() => screen(id).then(flat), { timeout: 20000 }).toContain(flat('席位 US2（us2@example.test）未登录'));
  await page.waitForTimeout(2000);
  expect(launches(id)).toHaveLength(1);
  expect(records('seat-env.jsonl').filter((r) => r.colId !== 'cap').every((r) => r.configDir === us2Dir)).toBe(true);
});

const NUDGE = '接着做（登录已恢复）';
test('a "Not logged in" on a seat that is signed in gets one 接着做 after about a minute, and the task goes on', async () => {
  test.setTimeout(150000);
  const id = await openOnUs2(' --login-blip');
  await expect.poll(() => screen(id).then(flat), { timeout: 20000 }).toContain(flat('Not logged in · Please run /login'));
  await page.waitForTimeout(30000);
  expect((await lastTask(id)).status).toBe('working');   // not filed as 未登录
  expect(prompts(id).filter((p) => p.startsWith(NUDGE))).toHaveLength(0);
  await expect.poll(() => prompts(id).filter((p) => p.startsWith(NUDGE)).length, { timeout: 60000 }).toBe(1);
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 20000 }).toBe('done');
  expect((await lastTask(id)).receipt.summary).toContain('carried on after login blip');
  expect(prompts(id).filter((p) => p.startsWith(NUDGE))).toHaveLength(1);
});

test('the same "Not logged in" after that 接着做 is a failure receipt', async () => {
  test.setTimeout(150000);
  const id = await openOnUs2(' --login-blip-twice');
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 100000 }).toBe('failed');
  const task = await lastTask(id);
  expect(task.receipt.failed).toMatch(/^未登录：/);
  expect(task.receipt.failed).toContain('接着做');
  expect(prompts(id).filter((p) => p.startsWith(NUDGE))).toHaveLength(1);
});

test('an instruction whose Enter was lost while the session was busy gets one more Enter and goes through', async () => {
  test.setTimeout(90000);
  const result = await captain({ action: 'main-new', id: 'swallow-' + Date.now(), title: 'Swallow probe', task: 'swallowed task', command: FAKE + ' --swallow-first-enter', cwd: profile });
  expect(result.error).toBeUndefined();
  const id = await page.evaluate(() => columns.find((c) => c.displayTitle === 'Swallow probe').id);
  await expect.poll(() => prompts(id).some((p) => p.startsWith('swallowed task')), { timeout: 30000 }).toBe(true);
  await expect.poll(() => lastTask(id).then((t) => t?.status), { timeout: 20000 }).toBe('done');
  expect(prompts(id).filter((p) => p.startsWith('swallowed task'))).toHaveLength(1);
  // the diagnostic log names the column, never the instruction
  const log = fs.readFileSync(path.join(os.tmpdir(), 'agentdeck-notify.log'), 'utf8').split('\n').filter((l) => l.includes(`col=${id} `));
  expect(log.filter((l) => l.includes('sent->enter-again'))).toHaveLength(1);
  expect(log.join('\n')).not.toContain('swallowed task');
});
