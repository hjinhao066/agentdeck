const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FAKE = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
let app, page, profile, envDir, captainEnv;
test.describe.configure({ mode: 'serial' });
function cli(args, env = captainEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../board-cli.js'), ...args], { env: { ...process.env, AGENTDECK_CONTROL_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function command(args, env) {
  const result = await cli(args, env); expect(result.stderr).toBe(''); expect(result.code).toBe(0); return result.stdout;
}
const list = (filter = {}) => page.evaluate((f) => TaskBoard.list(f), filter);
const card = async (id) => (await list({ archived: true })).find((c) => c.id === id);
async function add(title, verify = false, detail = 'Clear test instructions.') {
  return JSON.parse(await command(['task', 'add', '--project', 'e2e', '--title', title, '--detail', detail, ...(verify ? ['--verify'] : [])])).card;
}
async function worker(id, title = 'Worker', commandLine = FAKE, env, reviews = []) {
  const output = await command(['new', '--task-id', id, '--project', 'e2e', '--title', title, '--task', 'Run this single test task', '--command', commandLine, ...(reviews.length ? ['--reviews', reviews.join(',')] : [])], env);
  const session = output.match(/已开新会话 ([^「]+)/)?.[1]; expect(session).toBeTruthy();
  await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, session), { timeout: 30000 }).toBe('working');
  await expect.poll(() => fs.existsSync(path.join(envDir, session + '.json'))).toBe(true);
  return { session, env: JSON.parse(fs.readFileSync(path.join(envDir, session + '.json'), 'utf8')) };
}
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-board-e2e-')); envDir = path.join(profile, 'env'); fs.mkdirSync(envDir);
  const controlFile = path.join(profile, 'captain.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [{ id: 'task-idle-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }] }));
  const env = { ...process.env, AGENTDECK_TEST_RECEIPT_ENV_DIR: envDir }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform !== 'win32') env.ZDOTDIR = profile;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.MainSession === 'object' && typeof window.TaskBoard === 'object' && typeof config === 'object');
  await expect(page.locator('.column')).toHaveCount(1);
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  await expect.poll(() => page.evaluate(([id, platform]) => {
    const screen = dumpScreen(terms.get(id).term);
    return platform === 'win32' ? MainCore.isWindowsShellPrompt(screen) : /[%$#]\s*$/.test(screen);
  }, [captain, process.platform]), { timeout: 30000 }).toBe(true);
  // A script file keeps Windows PowerShell/native argument parsing out of the
  // capability export; the environment still comes from the Captain's real PTY.
  const exportScript = path.join(profile, 'export-control.cjs');
  fs.writeFileSync(exportScript, `require("fs").writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}));`);
  const exportEnv = `node "${exportScript}"`;
  await page.evaluate(([id, cmd]) => window.deck.ptyInput(id, cmd + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile), { timeout: 30000 }).toBe(true);
  captainEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  // The tests below open their own reviewers by hand; automatic verification has its own tests.
  await page.evaluate(() => TaskBoard.autoVerify(false));
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('task-board-state', { body: JSON.stringify({ cards: await list({ archived: true }), notices: await page.evaluate(() => config.mainSession.pending.filter((p) => p.title === '任务看板')) }), contentType: 'application/json' });
});

test('CLI cards bind actual worker receipts, exact text stays in the session and dependencies unlock', async () => {
  const first = await add('CLI parent');
  const next = JSON.parse(await command(['task', 'add', '--project', 'e2e', '--title', 'dependent', '--depends', first.id])).card;
  expect((await card(next.id)).flag).toBe('blocked');
  expect((await cli(['new', '--task-id', next.id, '--title', 'blocked', '--task', 'test', '--command', FAKE])).code).toBe(1);
  const w = await worker(first.id);
  await expect.poll(async () => (await card(first.id)).status).toBe('doing');
  expect((await card(first.id)).assignee.agent).toBeTruthy();
  await command(['ask', '--question', '需要决定格式？'], w.env); expect((await card(first.id)).status).toBe('needs_user');
  const full = '完成🙂。\n' + '完整原始回执𠮷'.repeat(2000);
  await command(['complete', '--result', full], w.env);
  expect((await card(first.id)).status).toBe('done'); expect((await card(first.id)).latest_receipt).toBe('完成🙂。');
  expect(await page.evaluate((id) => columns.find((c) => c.id === id).lastReceipt.summary, w.session)).toBe(full);
  expect((await card(next.id)).flag).toBe(null);
  const long = await add('Long details', false, 'detail'.repeat(3000));
  const listed = JSON.parse(await command(['task', 'list', '--project', 'e2e', '--status', 'todo']));
  expect(listed.find((c) => c.id === long.id).detail.length).toBe(18000);
  await command(['task', 'archive', '--done', '--project', 'e2e']); expect((await card(first.id)).archived).toBe(true);
});

test('verification rejects twice, reports held and refuses further automatic work', async () => {
  const c = await add('Verify card', true);
  const execution = await worker(c.id); await command(['complete', '--result', 'Implemented'], execution.env);
  expect((await card(c.id)).status).toBe('review');
  const review = await worker(c.id, 'Review 1'); await command(['complete', '--result', 'Tests failed', '--failed', 'Missing assertion'], review.env);
  expect((await card(c.id)).rework_count).toBe(1); expect((await card(c.id)).flag).toBe('failed');
  const repair = await worker(c.id, 'Repair'); await command(['complete', '--result', 'Repaired'], repair.env);
  const review2 = await worker(c.id, 'Review 2'); await command(['complete', '--result', 'Still broken', '--failed', 'Tests still fail'], review2.env);
  const held = await card(c.id); expect(held.rework_count).toBe(2); expect(held.flag).toBe('held');
  expect((await cli(['new', '--task-id', c.id, '--title', 'Must not retry', '--task', 'test', '--command', FAKE])).code).toBe(1);
  expect(await command(['receipts'])).toContain('连续失败 2 次');
});

test('explicit queued review of a reopened card passes to done and keeps the original execution receipt', async () => {
  const c = await add('Reopened explicit pass', true), execution = await worker(c.id);
  await command(['complete', '--result', '原执行全文。第二句'], execution.env);
  const receipt = (await card(c.id)).exec_receipt;
  await command(['task', 'move', '--id', c.id, '--status', 'todo']);
  await command(['task', 'move', '--id', c.id, '--status', 'doing']);
  await page.evaluate(() => {
    window.testReviewActiveCrew = MainCore.activeCrew;
    MainCore.activeCrew = () => new Set(Array.from({ length: MainCore.MAX_ACTIVE }, (_, i) => 'busy-' + i));
    TaskBoard.autoVerify(true);
  });
  try {
    expect(await command(['new', '--task-id', c.id, '--project', 'e2e', '--reviews', execution.session, '--title', 'Reopened pass reviewer', '--task', 'Independent review', '--command', FAKE])).toContain('已排队');
    expect(await page.evaluate((id) => config.mainSession.waitlist.find((w) => w.metadata?.boardId === id)?.metadata.reviewRound, c.id)).toBe(1);
  } finally {
    await page.evaluate(() => { MainCore.activeCrew = window.testReviewActiveCrew; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
  }
  try {
    await expect.poll(async () => (await card(c.id)).review_session).toBe(true);
    const id = (await card(c.id)).session_id;
    await expect.poll(() => fs.existsSync(path.join(envDir, id + '.json'))).toBe(true);
    await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, id)).toBe('working');
    await command(['complete', '--result', '通过：已核对测试'], JSON.parse(fs.readFileSync(path.join(envDir, id + '.json'), 'utf8')));
    await expect.poll(async () => (await card(c.id)).status).toBe('done');
    expect((await card(c.id)).exec_receipt).toEqual(receipt);
    expect((await card(c.id)).consecutive_failures).toBe(0);
    expect(await page.evaluate((id) => columns.concat(config.archived).filter((s) => s.boardId === id).length, c.id)).toBe(2);
  } finally { await page.evaluate(() => TaskBoard.autoVerify(false)); }
});

test('explicit rejection restores the archived original executor and delivers the reviewer words once', async () => {
  for (const failedFlag of [false, true]) {
    const c = await add('Archived executor explicit rejection ' + failedFlag, true), execution = await worker(c.id);
    await command(['complete', '--result', 'Original implementation'], execution.env);
    await command(['archive', '--id', execution.session]);
    const reviewer = await worker(c.id, 'Manual reject ' + failedFlag, FAKE, captainEnv, [execution.session]);
    const findings = '不通过：1) 缺断言\n2) 提交未推送  （两个空格）';
    await page.evaluate(() => TaskBoard.autoVerify(true));
    try {
      await command(['complete', '--result', findings, ...(failedFlag ? ['--failed', findings] : [])], reviewer.env);
      await expect.poll(async () => (await card(c.id)).attempt_id, { timeout: 30000 }).toBe('auto-rework-' + c.id + '-r1');
      expect((await card(c.id)).session_id).toBe(execution.session);
      expect((await card(c.id)).consecutive_failures).toBe(1);
      expect((await card(c.id)).rework_count).toBe(1);
      expect((await card(c.id)).review_session).toBe(false);
      expect(await page.evaluate((id) => config.archived.some((s) => s.id === id), execution.session)).toBe(false);
      await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, execution.session)).toBe('working');
      const tasks = await page.evaluate((id) => config.mainSession.tasks.filter((t) => t.colId === id), execution.session);
      expect(tasks).toHaveLength(2);
      expect(await page.evaluate(([id, findings]) => ChatUI.turnsOf(id).filter((t) => t.user?.includes(findings)).length, [execution.session, findings])).toBe(1);
      expect(await page.evaluate((id) => columns.concat(config.archived).filter((s) => s.boardId === id).length, c.id)).toBe(2);
    } finally { await page.evaluate(() => TaskBoard.autoVerify(false)); }
    const restoredEnv = JSON.parse(fs.readFileSync(path.join(envDir, execution.session + '.json'), 'utf8'));
    await command(['complete', '--result', 'Reworked implementation'], restoredEnv);
    const final = await worker(c.id, 'Manual final pass', FAKE, captainEnv, [execution.session]);
    await command(['complete', '--result', '通过：返工已核对'], final.env);
    expect((await card(c.id)).status).toBe('done');
  }
});

test('process and quota events update data automatically and a stale execution cannot complete its reviewer', async () => {
  const quotaCard = await add('Quota failure'); const q = await worker(quotaCard.id);
  await page.evaluate((id) => MainSession.onTick(id, { ...terms.get(id), alive: true, state: 'quota', lastScreen: 'RESOURCE_EXHAUSTED: quota exhausted' }), q.session);
  await expect.poll(async () => (await card(quotaCard.id)).flag).toBe('quota');
  expect((await card(quotaCard.id)).latest_receipt).toContain('RESOURCE_EXHAUSTED');
  const crash = await add('Process failure'); const w = await worker(crash.id);
  await command(['session-exit', '--code', '7'], w.env);
  await expect.poll(async () => (await card(crash.id)).flag).toBe('failed');
  expect((await card(crash.id)).latest_receipt).toContain('exit 7');
  const auth = await add('Login failure exits before status tick'); const a = await worker(auth.id);
  await page.evaluate((id) => new Promise((resolve) => terms.get(id).term.write('\r\nAPI Error: 401 Unauthorized\r\n', resolve)), a.session);
  await command(['session-exit', '--code', '1'], a.env);
  await expect.poll(async () => (await card(auth.id)).flag).toBe('quota'); expect((await card(auth.id)).resource_failure).toBe('auth');
  expect((await card(auth.id)).consecutive_failures).toBe(0);
  const rapid = await add('Rate limit PTY exit'); const r = await worker(rapid.id);
  await page.evaluate((id) => MainSession.onTick(id, { ...terms.get(id), alive: false, state: 'exited', lastScreen: '429 Too many requests', exitReason: 'exit 1' }), r.session);
  await expect.poll(async () => (await card(rapid.id)).resource_failure).toBe('rate_limit');
  expect((await card(rapid.id)).consecutive_failures).toBe(0);
  const stale = await add('stale worker', true); const old = await worker(stale.id);
  await command(['complete', '--result', 'Execution done'], old.env); const review = await worker(stale.id, 'Reviewer');
  await command(['complete', '--result', 'Old late result'], old.env);
  expect((await card(stale.id)).session_id).toBe(review.session); expect((await card(stale.id)).status).toBe('review');
  await command(['complete', '--result', 'Review passed'], review.env);
});

test('Gemini drag starts share explicit dispatch and delegate only this card once; important or unclear cards go to Captain', async () => {
  expect(await page.evaluate(() => TaskBoard.settings().dispatcher)).toBe('gemini');
  // Substitute only the dispatcher executable. All permissions and board
  // commands still travel through real PTYs and authenticated request files.
  await page.evaluate((fake) => {
    window.testOriginalAgentCommand = BoardCore.commandForAgent;
    window.testDispatcherCommand = BoardCore.commandForAgent('agy');
    BoardCore.commandForAgent = (agent, ...args) => agent === 'agy' ? fake : window.testOriginalAgentCommand(agent, ...args);
  }, FAKE);
  const c = await add('Gemini dispatch');
  const started = await page.evaluate((id) => TaskBoard.requestStart(id), c.id);
  expect(started.dispatcher).toBe('gemini');
  expect(await page.evaluate((id) => TaskBoard.startCard(id), c.id)).toMatchObject({ ignored: true });
  expect(await page.evaluate((id) => columns.filter((c) => c.dispatcherCardId === id).length, c.id)).toBe(1);
  expect(await page.evaluate(() => window.testDispatcherCommand)).toContain('gemini-3.8-flash-high');
  await expect.poll(() => fs.existsSync(path.join(envDir, started.session_id + '.json'))).toBe(true);
  const env = JSON.parse(fs.readFileSync(path.join(envDir, started.session_id + '.json'), 'utf8'));
  const other = await add('Other card');
  expect((await cli(['new', '--task-id', other.id, '--title', 'Denied', '--task', 'test', '--command', FAKE], env)).code).toBe(1);
  expect((await cli(['task', 'move', '--id', other.id, '--status', 'done'], env)).code).toBe(1);
  const w = await worker(c.id, 'Dispatcher worker', FAKE, env);
  expect((await cli(['new', '--task-id', c.id, '--title', 'Duplicate', '--task', 'test', '--command', FAKE], env)).code).toBe(1);
  await command(['complete', '--result', 'Delegated'], env); await command(['complete', '--result', 'Worker done'], w.env);
  // The last available slot can belong to the dispatcher itself. Its new
  // queues successfully, and completion must not report a missing delegation.
  const queued = await add('Gemini queued dispatch');
  const dispatching = await page.evaluate((id) => TaskBoard.startCard(id), queued.id);
  await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, dispatching.session_id)).toBe('working');
  await expect.poll(() => fs.existsSync(path.join(envDir, dispatching.session_id + '.json'))).toBe(true);
  const dispatchEnv = JSON.parse(fs.readFileSync(path.join(envDir, dispatching.session_id + '.json'), 'utf8'));
  await page.evaluate(() => { window.testQueueActiveCrew = MainCore.activeCrew; MainCore.activeCrew = () => new Set(Array.from({ length: MainCore.MAX_ACTIVE }, (_, i) => 'busy-' + i)); });
  try {
    expect(await command(['new', '--task-id', queued.id, '--project', 'e2e', '--title', 'Queued by Gemini', '--task', 'Queued task', '--command', FAKE], dispatchEnv)).toContain('已排队');
    await command(['complete', '--result', 'Queued for a worker slot'], dispatchEnv);
    expect((await card(queued.id)).status).toBe('doing');
    expect(await page.evaluate((id) => config.mainSession.pending.some((p) => p.summary?.includes(id) && p.summary.includes('尚未派出')), queued.id)).toBe(false);
  } finally { await page.evaluate(() => { MainCore.activeCrew = window.testQueueActiveCrew; }); }
  await expect.poll(async () => (await card(queued.id)).session_id, { timeout: 30000 }).toBeTruthy();
  const queuedSession = (await card(queued.id)).session_id;
  await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, queuedSession), { timeout: 30000 }).toBe('working');
  await expect.poll(() => fs.existsSync(path.join(envDir, queuedSession + '.json'))).toBe(true);
  await command(['complete', '--result', 'Queued worker finished'], JSON.parse(fs.readFileSync(path.join(envDir, queuedSession + '.json'), 'utf8')));
  const important = await add('Important');
  await page.evaluate((c) => TaskBoard.update(c.id, { important: true }, c.updated), important);
  expect((await page.evaluate((id) => TaskBoard.startCard(id), important.id)).dispatcher).toBe('captain');
  const unclear = await add('Unclear', false, '');
  expect((await page.evaluate((id) => TaskBoard.startCard(id), unclear.id)).dispatcher).toBe('captain');
  await page.evaluate(() => { BoardCore.commandForAgent = window.testOriginalAgentCommand; TaskBoard.settings('captain'); });
});

test('external JSON start edges notify once, quiet edits do not dispatch, and settings persist', async () => {
  const c = await add('External Windows start');
  const file = path.join(profile, 'tasks', 'e2e.json');
  const write = (change) => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')); const item = doc.cards.find((x) => x.id === c.id); change(item);
    item.updated = new Date().toISOString(); fs.writeFileSync(file + '.remote.tmp', JSON.stringify(doc)); fs.renameSync(file + '.remote.tmp', file);
  };
  write((item) => { item.status = 'doing'; });
  const notices = () => page.evaluate((id) => config.mainSession.pending.filter((p) => p.title === '任务看板' && p.summary?.includes(id)).length, c.id);
  await expect.poll(notices).toBe(1);
  expect((await card(c.id)).dispatch_claim.delivered).toBe(true);
  write((item) => { item.detail = 'Changed only the description on Windows'; });
  // Wait for a changed notification rather than an arbitrary sleep.
  await expect.poll(async () => (await card(c.id)).detail).toContain('Changed only');
  await page.reload();
  await expect.poll(() => page.evaluate(() => TaskBoard.settings().dispatcher)).toBe('captain');
  expect(await notices()).toBe(1);
  expect(await page.evaluate((id) => TaskBoard.startCard(id), c.id)).toMatchObject({ ignored: true });
  expect((await cli(['task', 'move', '--id', c.id, '--status', 'invalid'])).code).toBe(1);
  expect(await page.evaluate(() => window.deck.taskBoard('read-file', { path: '/etc/passwd' }).then(() => false, () => true))).toBe(true);
});

test('queued execution keeps card binding until delivery, and Captain rejection can return work to the original session', async () => {
  const c = await add('Queued card', true);
  await page.evaluate(() => {
    window.testOriginalActiveCrew = MainCore.activeCrew;
    MainCore.activeCrew = () => new Set(Array.from({ length: MainCore.MAX_ACTIVE }, (_, i) => 'busy-' + i));
  });
  expect(await command(['new', '--task-id', c.id, '--project', 'e2e', '--title', 'Queued binding', '--task', 'Single queued task', '--command', FAKE])).toContain('已排队');
  expect((await card(c.id)).status).toBe('todo');
  expect(await page.evaluate((id) => config.mainSession.waitlist.at(-1).metadata.boardId, c.id)).toBe(c.id);
  await page.evaluate(() => {
    MainCore.activeCrew = window.testOriginalActiveCrew;
    MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id));
  });
  await expect.poll(async () => (await card(c.id)).status, { timeout: 30000 }).toBe('doing');
  const id = (await card(c.id)).session_id;
  expect(await page.evaluate((id) => { const c = columns.find((c) => c.id === id); return { project: c.project, reviews: c.reviews, boardId: c.boardId }; }, id)).toEqual({ project: 'e2e', reviews: [], boardId: c.id });
  await expect.poll(() => fs.existsSync(path.join(envDir, id + '.json'))).toBe(true);
  const env = JSON.parse(fs.readFileSync(path.join(envDir, id + '.json'), 'utf8'));
  await command(['complete', '--result', 'First execution'], env);
  await command(['task', 'move', '--id', c.id, '--status', 'doing']);
  expect((await card(c.id)).rework_count).toBe(1);
  await command(['tell', '--to', id, '--message', 'Fix the review issue'], captainEnv);
  await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, id), { timeout: 30000 }).toBe('working');
  await command(['complete', '--result', 'Reworked'], env);
  expect((await card(c.id)).status).toBe('review');
  const reviewer = await worker(c.id, 'Final review'); await command(['complete', '--result', 'Verified'], reviewer.env);
  expect((await card(c.id)).status).toBe('done');
});

test('a synced JSON conflict cannot swallow a command receipt; its transition retries after the file is resolved', async () => {
  const c = await add('Receipt during sync conflict'); const w = await worker(c.id);
  const file = path.join(profile, 'tasks', 'e2e.json'); const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '<<<<<<< sync conflict');
  try {
    await command(['complete', '--result', '原始结果🙂完整保留。'], w.env);
    expect(await page.evaluate((id) => columns.find((c) => c.id === id).lastReceipt.summary, w.session)).toBe('原始结果🙂完整保留。');
    expect(await command(['receipts'])).toContain('原始结果🙂完整保留。');
    expect(fs.readFileSync(file, 'utf8')).toBe('<<<<<<< sync conflict');
  } finally { fs.writeFileSync(file, raw); }
  await expect.poll(async () => (await card(c.id)).status, { timeout: 15000 }).toBe('done');
  expect((await card(c.id)).latest_receipt).toBe('原始结果🙂完整保留。');
});

test('Captain held/completed moves never open a dispatcher and new binds stale archived/failed attempts', async () => {
  await page.evaluate(() => TaskBoard.settings('gemini'));
  const c = await add('Held rework fence');
  const first = await worker(c.id); await command(['complete', '--result', 'Broken', '--failed', 'Assertion failed'], first.env);
  const second = await worker(c.id); await command(['complete', '--result', 'Broken again', '--failed', 'Assertion still failed'], second.env);
  expect((await card(c.id)).flag).toBe('held');
  const dispatchers = () => page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length);
  const count = await dispatchers();
  await command(['task', 'move', '--id', c.id, '--status', 'doing']);
  expect((await card(c.id)).session_id).toBe(second.session);
  expect((await card(c.id)).dispatch_claim.delivered).toBe(true);
  const repair = await worker(c.id, 'Captain repair'); await command(['complete', '--result', 'Fixed'], repair.env);
  await command(['task', 'move', '--id', c.id, '--status', 'doing']);
  expect((await card(c.id)).session_id).toBe(repair.session);
  const rework = await worker(c.id, 'Completed rework'); await command(['complete', '--result', 'Fixed again'], rework.env);
  expect(await dispatchers()).toBe(count);

  const stale = await add('Archived legacy attempt'); const old = await worker(stale.id);
  await command(['archive', '--id', old.session]);
  // Reproduce a pre-fix card which still points to its archived open attempt.
  const file = path.join(profile, 'tasks', 'e2e.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const item = doc.cards.find((x) => x.id === stale.id);
  item.status = 'doing'; item.flag = null; item.session_id = old.session; item.attempt_id = 'legacy'; item.attempt_closed = false;
  fs.writeFileSync(file, JSON.stringify(doc));
  const fresh = await worker(stale.id, 'Fresh after archive');
  expect((await card(stale.id)).session_id).toBe(fresh.session);
  expect((await cli(['new', '--task-id', stale.id, '--title', 'Duplicate live worker', '--task', 'test', '--command', FAKE])).code).toBe(1);
  await command(['complete', '--result', 'Done'], fresh.env);
});

test('new rebinds missing legacy local workers directly, while a foreign-machine open attempt remains protected', async () => {
  for (const status of ['doing', 'needs_user']) {
    const c = await add('Missing legacy worker ' + status); const old = await worker(c.id);
    await command(['archive', '--id', old.session]);
    await page.evaluate(async (id) => {
      config.archived = config.archived.filter((c) => c.id !== id);
      await window.deck.saveConfig({ ...config, columns });
    }, old.session);
    const file = path.join(profile, 'tasks', 'e2e.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const item = doc.cards.find((card) => card.id === c.id);
    Object.assign(item, { status, flag: null, session_id: old.session, attempt_id: 'legacy', attempt_closed: false });
    delete item.session_host; fs.writeFileSync(file, JSON.stringify(doc));
    const fresh = await worker(c.id, 'Direct replacement');
    expect((await card(c.id)).session_id).toBe(fresh.session);
    expect((await card(c.id)).session_host).toBe(os.hostname());
    await command(['complete', '--result', 'Replacement finished'], fresh.env);
  }
  const remote = await add('Still running on another machine');
  const file = path.join(profile, 'tasks', 'e2e.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(doc.cards.find((card) => card.id === remote.id), { status: 'doing', session_id: 'remote-worker',
    session_host: os.hostname() + '-other-machine', attempt_id: 'remote-attempt', attempt_closed: false });
  fs.writeFileSync(file, JSON.stringify(doc));
  const rejected = await cli(['new', '--task-id', remote.id, '--title', 'Unsafe takeover', '--task', 'test', '--command', FAKE]);
  expect(rejected.code).toBe(1); expect(rejected.stderr).toContain('active execution or verification session');
  expect((await card(remote.id)).session_id).toBe('remote-worker');
});

test('Codex completed screen releases ordinary tell and tell --now after a Captain card move', async () => {
  const c = await add('Codex idle rework');
  const w = await worker(c.id, 'Codex completed stand-in', FAKE + ' --codex-completed --interruptible');
  await expect.poll(() => page.evaluate((id) => terms.get(id).state, w.session)).toBe('done');
  await command(['complete', '--result', 'First execution finished'], w.env);
  for (const now of [false, true]) {
    await command(['task', 'move', '--id', c.id, '--status', 'doing']);
    expect((await card(c.id)).session_id).toBe(w.session);
    const ledger = await command(['ledger']);
    expect(ledger.split('\n').find((line) => line.startsWith(w.session))).toContain('已完成');
    const message = now ? 'Immediate Codex rework delivered' : 'Ordinary Codex rework delivered';
    await command(['tell', '--to', w.session, '--message', message, ...(now ? ['--now'] : [])]);
    // A narrow column breaks the stand-in's line across rows (Windows' background desktop is small): read it unbroken.
    await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term).replace(/\s+/g, ''), w.session), { timeout: 15000 }).toContain(('GOT ' + message).replace(/\s+/g, ''));
    await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, w.session)).toBe('working');
    await expect.poll(() => page.evaluate((id) => terms.get(id).state, w.session)).toBe('done');
    expect((await card(c.id)).attempt_closed).toBe(false);
    await command(['complete', '--result', 'Rework finished'], w.env);
    expect((await card(c.id)).status).toBe('done');
  }
});

test('quota/login/throttle receipts preserve real failure count through repeated replacements', async () => {
  const c = await add('Resource errors do not hold'); const initial = await worker(c.id);
  await command(['complete', '--result', 'Failed test', '--failed', 'Assertion failed'], initial.env);
  expect((await card(c.id)).consecutive_failures).toBe(1);
  for (const reason of ['Not logged in. Please run /login', '429 Too many requests', 'RESOURCE_EXHAUSTED: quota exhausted']) {
    const w = await worker(c.id, 'Resource replacement');
    await page.evaluate(([id, reason]) => MainSession.onTick(id, { ...terms.get(id), state: 'quota', lastScreen: reason }), [w.session, reason]);
    await expect.poll(async () => (await card(c.id)).flag).toBe('quota');
    const failed = await card(c.id); expect(failed.flag).toBe('quota'); expect(failed.consecutive_failures).toBe(1); expect(failed.rework_count).toBe(0);
  }
  const w = await worker(c.id, 'Real defect'); await command(['complete', '--result', 'Broken', '--failed', 'Missing assertion'], w.env);
  expect((await card(c.id)).flag).toBe('held');
});

test('exhausted automatic dispatch waits without a PTY, resumes once, and yields to a Captain new', async () => {
  const setup = async () => page.evaluate((fake) => {
    window.quotaTestCommand = BoardCore.commandForAgent; window.quotaTestGate = QuotaCore.commandQuota; window.quotaTestStore = config.quotas;
    BoardCore.commandForAgent = (agent, ...args) => agent === 'agy' ? fake : window.quotaTestCommand(agent, ...args);
    QuotaCore.commandQuota = (store, cmd, ...args) => window.quotaTestGate(store, cmd === fake ? 'agy --model gemini-3.8-flash-high' : cmd, ...args);
    config.quotas = { Antigravity: { scope: 'gemini', blocked: { at: Date.now(), resetAt: Date.now() + 600000 } } };
    TaskBoard.settings('gemini');
  }, FAKE);
  await setup();
  try {
    const before = await page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length);
    const c = await add('Deferred dispatcher');
    expect(await page.evaluate((id) => TaskBoard.startCard(id), c.id)).toMatchObject({ queued: true });
    expect((await card(c.id)).dispatch_wait).toContain('额度用尽，稍后自动开');
    expect((await card(c.id)).dispatch_session_id).toBeFalsy(); expect((await card(c.id)).dispatch_claim.delivered).toBe(false);
    expect(await page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length)).toBe(before);
    await page.evaluate(() => { config.quotas.Antigravity.blocked.resetAt = Date.now() - 1; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
    await expect.poll(async () => (await card(c.id)).dispatch_session_id).toBeTruthy();
    expect((await card(c.id)).dispatch_wait).toBeNull(); expect((await card(c.id)).latest_receipt).toBe('');
    const dispatcher = (await card(c.id)).dispatch_session_id;
    await expect.poll(() => fs.existsSync(path.join(envDir, dispatcher + '.json'))).toBe(true);
    await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, dispatcher)).toBe('working');
    expect(await page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length)).toBe(before + 1);
    await page.evaluate((id) => MainSession.onTick(id, { ...terms.get(id), state: 'quota', lastScreen: 'Not logged in' }), dispatcher);
    await expect.poll(async () => (await card(c.id)).flag).toBe('quota'); expect((await card(c.id)).consecutive_failures).toBe(0);

    await page.evaluate(() => { config.quotas.Antigravity.blocked.resetAt = Date.now() + 600000; });
    const takeover = await add('Captain takes deferred card');
    expect(await page.evaluate((id) => TaskBoard.startCard(id), takeover.id)).toMatchObject({ queued: true });
    const manual = await worker(takeover.id, 'Captain immediate worker', FAKE + ' --worker');
    expect((await card(takeover.id)).dispatch_claim.delivered).toBe(true);
    await page.evaluate(() => { config.quotas.Antigravity.blocked.resetAt = Date.now() - 1; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
    expect((await card(takeover.id)).session_id).toBe(manual.session); expect((await card(takeover.id)).dispatch_session_id).toBeFalsy();
    expect(await page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length)).toBe(before + 1);
    await command(['complete', '--result', 'Captain worker done'], manual.env);
  } finally {
    await page.evaluate(() => { BoardCore.commandForAgent = window.quotaTestCommand; QuotaCore.commandQuota = window.quotaTestGate; config.quotas = window.quotaTestStore; TaskBoard.settings('captain'); });
  }
});

test('new selected Claude seat queues at quota and the queue opens after recovery without blocking other providers', async () => {
  await page.evaluate((fake) => {
    window.queueQuotaGate = QuotaCore.commandQuota; window.queueQuotaStore = config.quotas;
    const seat = QuotaCore.claudeSeats(config.claudeSeats).find((s) => s.id === config.activeClaudeSeatId);
    config.quotas = { [QuotaCore.seatKey(seat.id)]: { scope: 'claude', configDir: seat.configDir, blocked: { at: Date.now(), resetAt: Date.now() + 600000 } } };
    QuotaCore.commandQuota = (store, cmd, ...args) => window.queueQuotaGate(store, cmd === fake ? 'claude --model sonnet' : cmd, ...args);
  }, FAKE);
  try {
    const c = await add('Quota queued worker');
    expect(await command(['new', '--task-id', c.id, '--title', 'Wait at quota', '--task', 'test', '--command', FAKE])).toContain('额度用尽，稍后自动开');
    expect((await card(c.id)).session_id).toBeFalsy();
    const other = await add('Other provider can proceed');
    expect(await command(['new', '--task-id', other.id, '--title', 'Available provider', '--task', 'test', '--command', FAKE + ' --worker'])).toContain('已开新会话');
    await page.evaluate(() => MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)));
    await expect.poll(async () => (await card(other.id)).session_id).toBeTruthy();
    expect((await card(c.id)).session_id).toBeFalsy();
    // (a background quota sample may have added an entry of its own, without a block)
    await page.evaluate(() => { for (const q of Object.values(config.quotas)) if (q && q.blocked) q.blocked.resetAt = Date.now() - 1; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
    await expect.poll(async () => (await card(c.id)).session_id).toBeTruthy();
    for (const id of [c.id, other.id]) {
      const session = (await card(id)).session_id;
      await expect.poll(() => fs.existsSync(path.join(envDir, session + '.json'))).toBe(true);
      await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, session)).toBe('working');
      await command(['complete', '--result', 'Quota queue test done'], JSON.parse(fs.readFileSync(path.join(envDir, session + '.json'), 'utf8')));
    }
  } finally { await page.evaluate(() => { QuotaCore.commandQuota = window.queueQuotaGate; config.quotas = window.queueQuotaStore; }); }
});

// Automatic verification with a stand-in reviewer: the candidate table and the family rules are swapped in the
// page for the test, so nothing real is started. A "Custom agent" executor is given a family of its own.
async function autoVerifyOn(reviewerFamily) {
  await page.evaluate(([cmd, family]) => {
    window.testAutoVerifyBackup = { candidates: AutoVerifyCore.CANDIDATES.slice(), rules: AutoVerifyCore.FAMILY_RULES.slice() };
    AutoVerifyCore.CANDIDATES.splice(0, AutoVerifyCore.CANDIDATES.length, { id: 'stand-in', label: '替身审查员', family, command: cmd });
    AutoVerifyCore.FAMILY_RULES.unshift({ agent: /^Custom agent$/, family: 'e2e-executor' });
    TaskBoard.autoVerify(true);
  }, [FAKE, reviewerFamily]);
}
async function autoVerifyOff() {
  await page.evaluate(() => {
    TaskBoard.autoVerify(false);
    const b = window.testAutoVerifyBackup; if (!b) return;
    AutoVerifyCore.CANDIDATES.splice(0, AutoVerifyCore.CANDIDATES.length, ...b.candidates);
    AutoVerifyCore.FAMILY_RULES.splice(0, AutoVerifyCore.FAMILY_RULES.length, ...b.rules);
  });
}
const autoReviewers = (id) => page.evaluate((id) => columns.filter((c) => c.boardId === id && String(c.boardAttempt).startsWith('auto-review-')).map((c) => ({ id: c.id, attempt: c.boardAttempt })), id);
// The reviewer has its task once the prompt has actually been delivered; only then can it submit.
const sessionEnv = async (id) => {
  await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, id), { timeout: 30000 }).toBe('working');
  await expect.poll(() => fs.existsSync(path.join(envDir, id + '.json')), { timeout: 30000 }).toBe(true);
  return JSON.parse(fs.readFileSync(path.join(envDir, id + '.json'), 'utf8'));
};

test('a verify card is reviewed automatically: one reviewer per round, rejection returns to the original session, a pass completes', async () => {
  await autoVerifyOn('e2e-reviewer');
  try {
    const c = await add('Auto verify', true);
    const execution = await worker(c.id, 'Executor');
    const resultFile = path.join(profile, 'result.txt'); fs.writeFileSync(resultFile, 'done');
    await command(['complete', '--result', 'Implemented it. Second sentence stays in the card.', '--files', resultFile], execution.env);
    await expect.poll(async () => (await card(c.id)).review_session, { timeout: 40000 }).toBe(true);
    const first = await card(c.id);
    expect(first.status).toBe('review'); expect(first.session_id).not.toBe(execution.session);
    expect(first.exec_receipt.session_id).toBe(execution.session); expect(first.exec_receipt.files).toEqual([resultFile]);
    expect(first.exec_receipt.text).toBe('Implemented it. Second sentence stays in the card.');
    expect(first.attempt_id).toBe(`auto-review-${c.id}-r1`);
    await page.waitForTimeout(1500);   // more heartbeats must not open another
    expect(await autoReviewers(c.id)).toEqual([{ id: first.session_id, attempt: `auto-review-${c.id}-r1` }]);
    // rejection: the reviewer's words go back to the executor, which is bound to the card again
    const reviewer1 = await sessionEnv(first.session_id);
    await command(['complete', '--result', 'checked', '--failed', '不通过：缺少断言\n第二行问题'], reviewer1);
    await expect.poll(async () => (await card(c.id)).attempt_id, { timeout: 40000 }).toBe(`auto-rework-${c.id}-r1`);
    const rework = await card(c.id);
    expect(rework.session_id).toBe(execution.session); expect(rework.review_session).toBe(false); expect(rework.rework_count).toBe(1);
    expect(rework.attempt_closed).toBe(false);
    // the card went back to execution: the round-1 reviewer's terminal is ended and archived
    await expect.poll(() => page.evaluate((id) => (config.archived || []).some((a) => a.id === id), first.session_id), { timeout: 30000 }).toBe(true);
    expect(await autoReviewers(c.id)).toEqual([]);
    await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, execution.session), { timeout: 30000 }).toBe('working');
    // the executor hands in again: round 2 gets a reviewer of its own
    await command(['complete', '--result', 'Fixed the assertions'], execution.env);
    await expect.poll(async () => (await autoReviewers(c.id)).map((r) => r.attempt), { timeout: 40000 }).toEqual([`auto-review-${c.id}-r2`]);
    const second = await card(c.id);
    expect(second.review_round).toBe(2); expect(second.attempt_id).toBe(`auto-review-${c.id}-r2`);
    await page.waitForTimeout(1500);
    expect((await autoReviewers(c.id)).length).toBe(1);
    await command(['complete', '--result', '通过：文件在，测试我跑过'], await sessionEnv(second.session_id));
    expect((await card(c.id)).status).toBe('done');
  } finally { await autoVerifyOff(); }
});

test('with no acceptable reviewer the card waits in review with the reason for the Captain, and a manual reviewer can still take it', async () => {
  await autoVerifyOn('e2e-executor');   // the only candidate is the executor's own family
  try {
    const c = await add('No reviewer', true);
    const execution = await worker(c.id, 'Executor');
    await command(['complete', '--result', 'Implemented'], execution.env);
    await expect.poll(async () => (await card(c.id)).review_block?.round, { timeout: 40000 }).toBe(1);
    const blocked = await card(c.id);
    expect(blocked.status).toBe('review'); expect(blocked.review_block.reason).toContain('同属');
    expect(await autoReviewers(c.id)).toEqual([]);
    expect(await page.evaluate(() => config.mainSession.pending.filter((p) => p.title === '任务看板').map((p) => p.summary))).toEqual(expect.arrayContaining([expect.stringContaining('不能自动开审查会话')]));
    await page.waitForTimeout(1500);
    expect(await autoReviewers(c.id)).toEqual([]); expect((await card(c.id)).status).toBe('review');
    const manual = await worker(c.id, 'Manual review');
    expect((await card(c.id)).review_block ?? null).toBe(null);
    await command(['complete', '--result', 'Verified by hand'], manual.env);
    expect((await card(c.id)).status).toBe('done');
  } finally { await autoVerifyOff(); }
});

test('a named --command queues when its quota is out and does not switch models', async () => {
  await page.evaluate(() => {
    const seat = QuotaCore.claudeSeats(config.claudeSeats).find((s) => s.id === config.activeClaudeSeatId) || QuotaCore.claudeSeats(config.claudeSeats)[0];
    window.explicitQuotaStore = config.quotas;
    config.quotas = { [QuotaCore.seatKey(seat.id)]: { scope: 'claude', configDir: seat.configDir, blocked: { at: Date.now(), resetAt: Date.now() + 600000 } } };
  });
  try {
    const named = 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high';
    const plan = await page.evaluate((cmd) => QuotaCore.quotaFallback(config.quotas, cmd, config.claudeSeats, config.activeClaudeSeatId, Date.now(), { explicit: true }), named);
    expect(plan.action).toBe('queue');
    const c = await add('Named model waits');
    const result = await command(['new', '--task-id', c.id, '--title', 'Named Opus', '--task', 'test', '--command', named]);
    expect(result).toContain('不自动更换');
    expect(result).toContain('额度用尽，稍后自动开');
    expect(result).not.toContain('因额度换成');
    expect((await card(c.id)).session_id).toBeFalsy();
  } finally {
    await page.evaluate(() => { config.quotas = window.explicitQuotaStore; });
  }
});

test('exhausted Gemini dispatch switches tier, marks the session and tells the captain', async () => {
  await page.evaluate((fake) => {
    window.switchQuotaStore = config.quotas;
    window.switchFallback = QuotaCore.quotaFallback;
    window.switchGate = QuotaCore.commandQuota;
    const agy = BoardCore.commandForAgent('agy');
    QuotaCore.commandQuota = (store, cmd, ...args) => /gemini-[\d.]+-flash(?:-(?:low|medium|high))?(?:\s|$)/.test(cmd) || cmd === agy
      ? { out: true, state: 'exhausted', stale: false, fiveHour: 0, weekly: 0 }
      : window.switchGate(store, cmd, ...args);
    QuotaCore.quotaFallback = (...args) => {
      const plan = window.switchFallback(...args);
      window.switchPlan = plan;
      return plan.action === 'switch' ? { ...plan, cmd: fake } : plan;
    };
    TaskBoard.settings('gemini');
  }, FAKE);
  try {
    const c = await add('Fallback dispatcher');
    const started = await page.evaluate((id) => TaskBoard.startCard(id), c.id);
    expect(started.session_id).toBeTruthy();
    const plan = await page.evaluate(() => window.switchPlan);
    expect(plan.action).toBe('switch');
    expect(plan.note).toBe('原本派Gemini Flash，因额度换成agy gpt-oss-120b-medium');
    expect(plan.cmd).toContain('gpt-oss-120b-medium');
    expect(plan.cmd).not.toContain('--effort');
    const title = await page.evaluate((id) => { const col = columns.find((c) => c.id === id); return col.displayTitle || col.title; }, started.session_id);
    expect(title).toContain(plan.note);
    expect(await page.evaluate((id) => columns.find((c) => c.id === id).cmd, started.session_id)).toContain('fake-agent.js');
    expect(await page.evaluate(() => config.mainSession.pending.map((p) => p.summary).join('\n'))).toContain(plan.note);
  } finally {
    await page.evaluate(() => {
      QuotaCore.quotaFallback = window.switchFallback;
      QuotaCore.commandQuota = window.switchGate;
      config.quotas = window.switchQuotaStore;
      TaskBoard.settings('captain');
    });
  }
});
