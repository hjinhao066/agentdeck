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
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [{ id: 'task-idle-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }] }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_RECEIPT_ENV_DIR: envDir }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('memory-pressure'); ipcMain.handle('memory-pressure', () => ({ level: 1 })); });
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.MainSession === 'object' && typeof window.TaskBoard === 'object' && typeof config === 'object');
  await expect(page.locator('.column')).toHaveCount(1);
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  await expect.poll(() => page.evaluate((id) => dumpScreen(terms.get(id).term), captain)).toMatch(/[%>$#]\s*$/m);
  // A script file keeps Windows PowerShell/native argument parsing out of the
  // capability export; the environment still comes from the Captain's real PTY.
  const exportScript = path.join(profile, 'export-control.cjs');
  fs.writeFileSync(exportScript, `require("fs").writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}));`);
  const exportEnv = `node "${exportScript}"`;
  await page.evaluate(([id, cmd]) => window.deck.ptyInput(id, cmd + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
  captainEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  // The tests below open their own reviewers by hand; automatic verification has its own tests.
  await page.evaluate(() => TaskBoard.autoVerify(false));
});
test.afterAll(async () => {
  // This suite verifies dispatch, not restart/quit. Quit only its isolated app
  // so macOS window closure cannot leave the test host alive.
  if (app) {
    const child = app.process();
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      // evaluate/close can await a CDP reply after app.quit has already closed
      // that target. The process exit is the authoritative cleanup completion.
      app.evaluate(({ app }) => app.quit()).catch(() => {});
      await exited;
    } finally { clearTimeout(timer); }
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach('task-board-state', { body: JSON.stringify({ cards: await list({ archived: true }), notices: await page.evaluate(() => config.mainSession.pending.filter((p) => p.title === '任务看板')) }), contentType: 'application/json' });
});


const queue = async () => JSON.parse(await command(['queue', 'list']));
const assign = (id, title, cmd = FAKE, body = 'Single queue regression task') => command(['new', ...(id ? ['--task-id', id] : []), '--title', title, '--task', body, '--command', cmd]);
async function holdQuota(all = false) {
  await page.evaluate(({ fake, all }) => {
    window.queueOriginalQuota = QuotaCore.commandQuota;
    window.queueOriginalFallback = QuotaCore.quotaFallback;
    QuotaCore.commandQuota = (store, cmd, ...rest) => (all ? cmd.startsWith(fake) : cmd === fake)
      ? { out: true, state: 'out' } : window.queueOriginalQuota(store, cmd, ...rest);
    QuotaCore.quotaFallback = (store, cmd, ...rest) => (all ? cmd.startsWith(fake) : cmd === fake)
      ? { action: 'queue', cmd, reason: 'out', held: 'out', note: '' } : window.queueOriginalFallback(store, cmd, ...rest);
  }, { fake: FAKE, all });
}
async function countActive(count, cap = 30) {
  await page.evaluate(({ count, cap }) => {
    window.queueOriginalActive ||= MainCore.activeCrew;
    MainCore.MAX_ACTIVE = cap;
    MainCore.activeCrew = () => new Set(Array.from({ length: count }, (_, i) => 'occupied-' + i));
  }, { count, cap });
}
test.afterEach(async () => {
  if (!page) return;
  await page.evaluate(() => {
    for (let i = columns.length - 1; i >= 0; i--) if (columns[i].id.startsWith('fixture-occupancy-')) columns.splice(i, 1);
    config.mainSession.tasks = config.mainSession.tasks.filter((t) => !t.colId.startsWith('fixture-occupancy-'));
  });
  // Only this isolated profile's stand-in workers and unsent requests are touched.
  for (const w of await queue()) await command(['queue', 'cancel', '--task-id', w.queueId]);
  for (const id of await page.evaluate(() => columns.filter((c) => c.captainCrew && !c.isMain).map((c) => c.id))) await command(['archive', '--id', id]);
  await page.evaluate(() => {
    if (window.queueOriginalQuota) { QuotaCore.commandQuota = window.queueOriginalQuota; delete window.queueOriginalQuota; }
    if (window.queueOriginalFallback) { QuotaCore.quotaFallback = window.queueOriginalFallback; delete window.queueOriginalFallback; }
    if (window.queueOriginalActive) { MainCore.activeCrew = window.queueOriginalActive; delete window.queueOriginalActive; }
    MainCore.MAX_ACTIVE = config.concurrencyCap;
  });
});

test('four occupied slots and an exhausted provider do not falsely report thirty or block an available provider', async () => {
  await holdQuota();
  const active = await page.evaluate(() => {
    MainCore.MAX_ACTIVE = 30;
    for (let i = 0; i < 30; i++) {
      const id = 'fixture-occupancy-' + i;
      columns.push({ id, captainCrew: true, cmd: '', title: id });
      config.mainSession.tasks.push({ id: 'task-' + id, colId: id, status: i < 4 ? 'working' : 'quota' });
    }
    return MainCore.activeCrew(config.mainSession.tasks, new Set(columns.filter((c) => c.captainCrew).map((c) => c.id))).size;
  });
  expect(active).toBe(4);
  const held = await add('Quota-only head');
  expect(await assign(held.id, 'Quota-only head')).toContain('额度用尽');
  const available = await add('Available provider');
  expect(await assign(available.id, 'Available provider', FAKE + ' --provider=codex')).toContain('已开新会话');
  expect((await card(held.id)).session_id).toBeFalsy();
  expect((await card(available.id)).session_id).toBeTruthy();
  expect((await queue()).map((w) => w.taskId)).toEqual([held.id]);
});

test('same command is refused; changed model replaces a quota-held card and immediately sends only the new task', async () => {
  await holdQuota();
  const c = await add('Replace queued model');
  await assign(c.id, 'Old task');
  const old = (await queue())[0];
  expect((await cli(['new', '--task-id', c.id, '--title', 'Duplicate', '--task', 'duplicate', '--command', FAKE])).stderr).toContain('已经在排队');
  const cmd = FAKE + ' --model available-model --provider=codex';
  const output = await assign(c.id, 'Replacement', cmd, 'ONLY_NEW_BODY');
  expect(output).toContain('已开新会话');
  expect(await queue()).toEqual([]);
  const id = (await card(c.id)).session_id;
  expect(await page.evaluate(({ id, oldId }) => ({
    cmd: columns.find((c) => c.id === id).cmd,
    old: config.mainSession.tasks.find((t) => t.id === oldId).status,
  }), { id, oldId: old.queueId })).toEqual({ cmd, old: 'stopped' });
  await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, id)).toBe('working');
  const delivered = await page.evaluate((id) => ChatUI.turnsOf(id).at(-1)?.user, id);
  expect(delivered).toContain('ONLY_NEW_BODY');
  expect(delivered).not.toContain('Single queue regression task');
  expect(await command(['ledger'])).not.toContain('排队等空位');
});

test('replacement still held by quota keeps exactly one request and only the replacement starts on recovery', async () => {
  await holdQuota(true);
  const c = await add('Replace while still held');
  await assign(c.id, 'Old held');
  const changed = FAKE + ' --model next-model';
  expect(await assign(c.id, 'New held', changed)).toContain('额度用尽');
  expect(await queue()).toMatchObject([{ taskId: c.id, title: 'New held', command: changed }]);
  await page.evaluate(() => { QuotaCore.commandQuota = window.queueOriginalQuota; QuotaCore.quotaFallback = window.queueOriginalFallback; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
  await expect.poll(async () => (await card(c.id)).session_id).toBeTruthy();
  expect(await page.evaluate((id) => columns.filter((c) => c.boardId === id).length, c.id)).toBe(1);
  expect(await queue()).toEqual([]);
});

test('queue cancellation supports card ids and standalone queue ids, persists, and denies workers', async () => {
  await holdQuota();
  const c = await add('Cancel by card'); await assign(c.id, 'Cancel by card');
  await assign('', 'Cancel unbound');
  const items = await queue(); expect(items).toHaveLength(2);
  expect(items[0].reason).toContain('额度用尽');
  expect(await command(['queue', 'cancel', '--task-id', c.id])).toContain('已取消 1 条');
  expect(await command(['queue', 'cancel', '--task-id', c.id])).toContain('没有这条排队');
  expect(await command(['queue', 'cancel', '--task-id', items[1].queueId])).toContain('已取消 1 条');
  await page.reload();
  await page.waitForFunction(() => typeof MainSession === 'object' && MainSession.mainCol());
  expect(await queue()).toEqual([]);
  expect(await command(['ledger'])).not.toContain('排队等空位');
  const w = await worker((await add('Worker cannot cancel')).id);
  const denied = await cli(['queue', 'cancel', '--task-id', c.id], w.env);
  expect(denied.code).toBe(1); expect(denied.stderr).toContain('Only conductor-managed terminals');
  expect((await cli(['queue', 'list'], w.env)).code).toBe(1);
  // Even a worker trying to present its receipt token as a control token is
  // rejected by the main-process capability check, beyond the CLI guard.
  const forged = { ...w.env, AGENTDECK_CONTROL_TOKEN: w.env.AGENTDECK_RECEIPT_TOKEN };
  const serverDenied = await cli(['queue', 'cancel', '--task-id', c.id], forged);
  expect(serverDenied.code).toBe(1); expect(serverDenied.stderr).toContain('Receipt capability');
  expect((await cli(['queue', 'list'], forged)).code).toBe(1);
});

test('moving queued cards to done or todo via CLI or UI removes their requests and prevents delayed starts', async () => {
  await holdQuota();
  const ids = [];
  for (const status of ['done', 'todo']) {
    const c = await add('CLI move ' + status); ids.push(c.id); await assign(c.id, 'CLI move ' + status);
    await command(['task', 'move', '--id', c.id, '--status', status]);
    expect((await queue()).some((w) => w.taskId === c.id)).toBe(false);
  }
  const ui = await add('UI move todo'); ids.push(ui.id); await assign(ui.id, 'UI move todo');
  await page.evaluate((id) => TaskBoard.move(id, 'todo'), ui.id);
  expect(await queue()).toEqual([]);
  expect(await command(['ledger'])).not.toContain('排队等空位');
  await page.evaluate(() => { QuotaCore.commandQuota = window.queueOriginalQuota; QuotaCore.quotaFallback = window.queueOriginalFallback; MainSession.onTick(MainSession.mainCol().id, terms.get(MainSession.mainCol().id)); });
  expect(await page.evaluate((ids) => config.mainSession.tasks.filter((t) => ids.includes(t.boardId)).map((t) => t.status), ids)).toEqual(['stopped', 'stopped', 'stopped']);
  for (const id of ids) expect((await card(id)).session_id).toBeFalsy();
});

test('full capacity reports actual occupied slots and a runnable backlog reports its own reason', async () => {
  await countActive(7, 5);
  const c = await add('Capacity reason');
  expect(await assign(c.id, 'Capacity reason')).toContain('7 个会话占用干活名额，上限 5');
  // Keep admission within one page turn so a periodic tick cannot consume the
  // runnable head before the new request's backlog decision.
  const behind = await page.evaluate((fake) => {
    MainCore.MAX_ACTIVE = 30;
    MainCore.activeCrew = () => new Set(Array.from({ length: 4 }, (_, i) => 'occupied-' + i));
    return MainSession.handle({ action: 'main-new', id: 'backlog-probe', title: 'Backlog reason', task: 'test', command: fake }, MainSession.mainCol());
  }, FAKE);
  expect(behind.result).toContain('前面有 1 条可执行任务，当前 4 个会话');
  expect(behind.result).not.toContain('30 个会话');
});
