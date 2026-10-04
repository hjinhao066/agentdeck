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
async function worker(id, title = 'Worker', commandLine = FAKE, env) {
  const output = await command(['new', '--task-id', id, '--project', 'e2e', '--title', title, '--task', 'Run this single test task', '--command', commandLine], env);
  const session = output.match(/已开新会话 ([^「]+)/)?.[1]; expect(session).toBeTruthy();
  await expect.poll(() => page.evaluate((s) => config.mainSession.tasks.findLast((t) => t.colId === s)?.status, session), { timeout: 30000 }).toBe('working');
  await expect.poll(() => fs.existsSync(path.join(envDir, session + '.json'))).toBe(true);
  return { session, env: JSON.parse(fs.readFileSync(path.join(envDir, session + '.json'), 'utf8')) };
}
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-board-e2e-')); envDir = path.join(profile, 'env'); fs.mkdirSync(envDir);
  const controlFile = path.join(profile, 'captain.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [{ id: 'task-idle-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }] }));
  const env = { ...process.env, AGENTDECK_TEST_RECEIPT_ENV_DIR: envDir }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.MainSession === 'object' && typeof window.TaskBoard === 'object' && typeof config === 'object');
  await expect(page.locator('.column')).toHaveCount(1);
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  const exportEnv = `node -e 'require("fs").writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}))'`;
  await page.evaluate(([id, cmd]) => window.deck.ptyInput(id, cmd + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
  captainEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
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

test('process and quota events update data automatically and a stale execution cannot complete its reviewer', async () => {
  const quotaCard = await add('Quota failure'); const q = await worker(quotaCard.id);
  await page.evaluate((id) => MainSession.onTick(id, { ...terms.get(id), alive: true, state: 'quota', lastScreen: 'RESOURCE_EXHAUSTED: quota exhausted' }), q.session);
  await expect.poll(async () => (await card(quotaCard.id)).flag).toBe('failed');
  expect((await card(quotaCard.id)).latest_receipt).toContain('RESOURCE_EXHAUSTED');
  const crash = await add('Process failure'); const w = await worker(crash.id);
  await command(['session-exit', '--code', '7'], w.env);
  await expect.poll(async () => (await card(crash.id)).flag).toBe('failed');
  expect((await card(crash.id)).latest_receipt).toContain('exit 7');
  const stale = await add('stale worker', true); const old = await worker(stale.id);
  await command(['complete', '--result', 'Execution done'], old.env); const review = await worker(stale.id, 'Reviewer');
  await command(['complete', '--result', 'Old late result'], old.env);
  expect((await card(stale.id)).session_id).toBe(review.session); expect((await card(stale.id)).status).toBe('review');
  await command(['complete', '--result', 'Review passed'], review.env);
});

test('Gemini is default; its stand-in can delegate only this card once, while important or unclear cards go to Captain', async () => {
  expect(await page.evaluate(() => TaskBoard.settings().dispatcher)).toBe('gemini');
  // Substitute only the dispatcher executable. All permissions and board
  // commands still travel through real PTYs and authenticated request files.
  await page.evaluate((fake) => {
    window.testOriginalAgentCommand = BoardCore.commandForAgent;
    window.testDispatcherCommand = BoardCore.commandForAgent('agy');
    BoardCore.commandForAgent = (agent, ...args) => agent === 'agy' ? fake : window.testOriginalAgentCommand(agent, ...args);
  }, FAKE);
  const c = await add('Gemini dispatch');
  const started = await page.evaluate((id) => TaskBoard.startCard(id), c.id);
  expect(started.dispatcher).toBe('gemini');
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

test('queued new keeps the card binding until delivery, and Captain rejection can return work to the original session', async () => {
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
