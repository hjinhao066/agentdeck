const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
let app, page, profile, receiptDir, controlFile;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-command-e2e-'));
  receiptDir = path.join(profile, 'env'); fs.mkdirSync(receiptDir);
  controlFile = path.join(profile, 'control.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [
    { id: 'submit-worker', title: 'Command worker', cmd: fake, cwd: profile, role: 'manual' },
    { id: 'other-worker', title: 'Other worker', cmd: fake, cwd: profile, role: 'manual' },
  ] }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_RECEIPT_ENV_DIR: receiptDir, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => fs.existsSync(path.join(receiptDir, 'submit-worker.json'))).toBe(true);
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  // Export the Captain capability through its real PTY, never through page IPC.
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  // Run a file so PowerShell's native argument quoting cannot strip the JS
  // quotes or reinterpret the backslashes in a Windows path.
  const exportScript = path.join(profile, 'export-control.js');
  fs.writeFileSync(exportScript, `require('fs').writeFileSync(process.argv[2], JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}));`);
  const exportEnv = `node "${exportScript}" "${controlFile}"`;
  await page.evaluate(([id, c]) => window.deck.ptyInput(id, c + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
});
test.afterAll(async () => { if (app) await closeElectron(app); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [env.AGENTDECK_BOARD_CLI || path.resolve(__dirname, '../../board-cli.js'), ...args], { env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_TERMINAL_ID: '', AGENTDECK_CONTROL_DIR: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const workerEnv = () => ({ ...JSON.parse(fs.readFileSync(path.join(receiptDir, 'submit-worker.json'), 'utf8')), AGENTDECK_CONTROL_TOKEN: '' });
async function dispatch(text) {
  await page.evaluate((message) => MainSession.handle({ action: 'main-tell', to: 'submit-worker', message }, MainSession.mainCol()), text);
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status), { timeout: 30000 }).toBe('working');
}

test('receipt capability reaches manual agents but cannot control sessions; exact commands survive storage and delivery', async () => {
  const env = workerEnv();
  expect(env.control).toBe(false);
  expect(fs.existsSync(env.AGENTDECK_BOARD_CLI)).toBe(true);
  expect((await cli(['ledger'], { ...env, AGENTDECK_CONTROL_TOKEN: env.AGENTDECK_RECEIPT_TOKEN })).stderr).toContain('cannot control');
  await dispatch('command receipt Unicode');
  const result = '  改好了🙂\n' + '不乱码𠮷'.repeat(3500) + '\n完整结尾  ';
  const files = Array.from({ length: 12 }, (_, i) => path.join(profile, `result ${i}.md`));
  const submitted = await cli(['complete', '--result', result, '--files', files.join(',')], env);
  expect(submitted.code).toBe(0);
  await expect.poll(() => page.evaluate(() => columns.find((c) => c.id === 'submit-worker').lastReceipt.summary)).toBe(result);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.files)).toEqual(files);
  const read = await cli(['receipts'], JSON.parse(fs.readFileSync(controlFile, 'utf8')));
  expect(read.code).toBe(0); expect(read.stdout).toContain(result); expect(read.stdout).toContain(files.at(-1));
  await page.reload();
  await expect.poll(() => page.evaluate(() => config.mainSession?.tasks.at(-1)?.receipt?.summary)).toBe(result);
  expect(await page.evaluate(() => ChatUI.turnsOf(MainSession.mainCol().id).findLast((t) => t.kind === 'task').task.receipt.summary)).toBe(result);
});

test('progress, ask and failed completion update only the submitting task and preserve text', async () => {
  await dispatch('decision probe');
  expect((await cli(['progress', '--message', '正在验证🙂'], workerEnv())).code).toBe(0);
  await expect(page.locator('.task-card').last()).toContainText('正在验证🙂');
  const question = '  用 SQLite？\n请队长拍板🙂  ';
  expect((await cli(['ask', '--question', question], workerEnv())).code).toBe(0);
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status)).toBe('asking');
  expect(await page.evaluate(() => config.mainSession.pending.at(-1).question)).toBe(question);
  const asked = await cli(['receipts'], JSON.parse(fs.readFileSync(controlFile, 'utf8')));
  expect(asked.stdout).toContain(question);
  expect((await cli(['complete', '--result', '  未完成\n保留诊断🙂  ', '--failed', '  仓库没有权限🙂  '], workerEnv())).code).toBe(0);
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status)).toBe('failed');
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.failed)).toBe('  仓库没有权限🙂  ');
  const read = await cli(['receipts'], JSON.parse(fs.readFileSync(controlFile, 'utf8')));
  expect(read.stdout).toContain('  未完成\n保留诊断🙂  ');
  expect(read.stdout).toContain('  仓库没有权限🙂  ');
  expect(await page.evaluate(() => columns.find((c) => c.id === 'other-worker').lastReceipt || null)).toBe(null);
  const shots = process.env.AGENTDECK_COMMAND_RECEIPTS_SHOTS;
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'command-receipts.png') }); }
});

test('a Captain answer closes the asking card and the next receipt binds to the new instruction', async () => {
  await dispatch('ask then continue');
  expect((await cli(['ask', '--question', 'Which format?'], workerEnv())).code).toBe(0);
  const askingId = await page.evaluate(() => config.mainSession.tasks.at(-1).id);
  await cli(['receipts'], JSON.parse(fs.readFileSync(controlFile, 'utf8')));
  await dispatch('use Markdown');
  expect(await page.evaluate((id) => config.mainSession.tasks.find((t) => t.id === id).status, askingId)).toBe('done');
  expect((await cli(['complete', '--result', 'Markdown completed'], workerEnv())).code).toBe(0);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.summary)).toBe('Markdown completed');
});

test('screen templates, Doing and open turns cannot produce receipts; ended turns wait three minutes', async () => {
  await dispatch('screen fallback probe');
  await expect.poll(() => page.evaluate(() => ChatUI.turnsOf('submit-worker').at(-1)?.done), { timeout: 15000 }).toBe(true);
  const probe = await page.evaluate(() => {
    const t = config.mainSession.tasks.at(-1);
    const entry = terms.get('submit-worker');
    const now = Date.now();
    const tick = (overrides) => MainSession.onTick('submit-worker', { ...entry, alive: true, state: 'done', lastOutputAt: now - 181000, ...overrides });
    const turn = ChatUI.turnsOf('submit-worker').at(-1);
    turn.done = false;
    t.endedAt = now - 181000;
    tick({ lastScreen: '【回执】\n摘要：open turn template' });
    const openTurn = t.status;
    turn.done = true;
    t.endedAt = now - 179000;
    tick({ lastScreen: '【回执】\n摘要：模板\n【提问】\n问题：模板' });
    const beforeDeadline = t.status;
    t.endedAt = now - 181000;
    tick({ lastScreen: '✻ Doing…\nwaiting for user confirmation\nPress up to edit queued messages' });
    const doing = t.status;
    const classified = classify('✻ Doing…\nwaiting for user confirmation', entry);
    t.endedAt = now - 181000;
    tick({ lastScreen: '【回执】\n摘要：模板不该被读取' });
    return { openTurn, beforeDeadline, doing, classified, status: t.status, receipt: t.receipt };
  });
  expect(probe.openTurn).toBe('working'); expect(probe.beforeDeadline).toBe('working'); expect(probe.doing).toBe('working'); expect(probe.classified).toBe('working');
  expect(probe.status).toBe('stopped'); expect(probe.receipt.summary).toBe('已结束，未提交回执');
  expect(probe.receipt.files).toEqual([]);
  const resumed = await page.evaluate(() => {
    const t = config.mainSession.tasks.at(-1);
    MainSession.onTick('submit-worker', { ...terms.get('submit-worker'), alive: true, state: 'working',
      lastScreen: '→ Add a follow-up ctrl+c to stop' });
    return { status: t.status, receipt: t.receipt || null,
      lastReceipt: columns.find((c) => c.id === 'submit-worker').lastReceipt || null,
      pending: config.mainSession.pending.filter((p) => p.taskId === t.id && p.source === 'fallback') };
  });
  expect(resumed).toEqual({ status: 'working', receipt: null, lastReceipt: null, pending: [] });
  // A late command wins over the automatic no-receipt notice.
  expect((await cli(['complete', '--result', '真实结果🙂'], workerEnv())).code).toBe(0);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.summary)).toBe('真实结果🙂');
});

test('an agent crash reports its exit code while its parent shell stays alive', async () => {
  await page.evaluate(([cmd, cwd]) => MainSession.handle({ action: 'main-new', id: 'exit-probe', title: 'Crash probe', task: 'crash after receiving task', command: cmd + ' --exit-after-task', cwd }, MainSession.mainCol()), [fake, profile]);
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.find((t) => t.title === 'Crash probe')?.status), { timeout: 30000 }).toBe('failed');
  const probe = await page.evaluate(() => {
    const t = config.mainSession.tasks.find((t) => t.title === 'Crash probe');
    return { receipt: t.receipt, alive: terms.get(t.colId).alive };
  });
  expect(probe.alive).toBe(true); expect(probe.receipt.failed).toContain('exit 7');
});

test('quota exhausted at startup fails the unsent task instead of leaving it queued forever', async () => {
  await page.evaluate(([cmd, cwd]) => MainSession.handle({ action: 'main-new', id: 'startup-quota', title: 'Startup quota', task: 'must not be sent into a quota screen', command: cmd + ' --quota-on-start', cwd }, MainSession.mainCol()), [fake, profile]);
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.find((t) => t.title === 'Startup quota')?.status), { timeout: 15000 }).toBe('failed');
  const task = await page.evaluate(() => config.mainSession.tasks.find((t) => t.title === 'Startup quota'));
  expect(task.receipt.failed).toContain("You've hit your usage limit");
  expect(task.startedAt).toBeUndefined();
  expect(await page.evaluate((id) => ChatUI.turnsOf(id).length, task.colId)).toBe(0);
});

const filteredEnv = (env) => ({ ...env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_CONTROL_TOKEN: '', AGENTDECK_CONTROL_DIR: '' });

test('a terminal id cannot select private credentials; this column tty is the only file key', async () => {
  const env = filteredEnv(workerEnv());
  const cred = JSON.parse(fs.readFileSync(path.join(profile, 'board-control', 'credentials', 'submit-worker.json'), 'utf8'));
  expect(cred.terminalId).toBe('submit-worker');
  expect(cred.receiptToken).toBe(workerEnv().AGENTDECK_RECEIPT_TOKEN);
  if (process.platform === 'win32') expect(cred.tty).toBe('');
  else {
    expect(cred.tty).toMatch(/^\/dev\/(?:ttys\d+|tty\d+|pts\/\d+)$/);
    expect(fs.readdirSync(path.join(profile, 'board-control', 'credentials', 'by-tty')).some((name) => name.endsWith('.json'))).toBe(true);
  }
  await dispatch('filtered command environment');
  for (const args of [['progress', '--message', 'filtered progress'], ['ask', '--question', 'filtered question'], ['complete', '--result', 'filtered completed'], ['ledger'], ['new', '--title', 'Forbidden', '--task', 'no worker control']]) {
    const denied = await cli(args, env);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('independent');
  }
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  expect((await cli(['ledger'], { ...env, AGENTDECK_TERMINAL_ID: captain })).code).toBe(1);
  expect((await cli(['receipts'], { ...env, AGENTDECK_TERMINAL_ID: captain })).stderr).toContain('independent');
  expect((await cli(['complete', '--result', 'env completed'], workerEnv())).code).toBe(0);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.summary)).toBe('env completed');
  expect(await page.evaluate(() => columns.some((c) => c.title === 'Forbidden'))).toBe(false);
});

test('archive revokes credentials and restore rotates them; a terminal id still cannot submit', async () => {
  const previous = workerEnv();
  const credentialFile = path.join(profile, 'board-control', 'credentials', 'submit-worker.json');
  await page.evaluate(() => MainSession.handle({ action: 'main-archive', to: 'submit-worker' }, MainSession.mainCol()));
  await expect.poll(() => fs.existsSync(credentialFile)).toBe(false);
  expect((await cli(['complete', '--result', 'archived'], filteredEnv(previous))).code).toBe(1);
  await page.evaluate(() => restoreArchived('submit-worker', false, true));
  await expect.poll(() => workerEnv().AGENTDECK_RECEIPT_TOKEN !== previous.AGENTDECK_RECEIPT_TOKEN).toBe(true);
  expect(workerEnv().control).toBe(false);
  const rotated = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  expect(rotated.receiptToken).toBe(workerEnv().AGENTDECK_RECEIPT_TOKEN);
  if (process.platform !== 'win32') expect(rotated.tty).toMatch(/^\/dev\/(?:ttys\d+|tty\d+|pts\/\d+)$/);
  await dispatch('restored command environment');
  expect((await cli(['complete', '--result', 'stale token'], previous)).stderr).toContain('not conductor-managed');
  expect((await cli(['complete', '--result', 'no tty'], filteredEnv(workerEnv()))).code).toBe(1);
  expect((await cli(['progress', '--message', 'restored progress'], workerEnv())).code).toBe(0);
  expect((await cli(['ask', '--question', 'restored question'], workerEnv())).code).toBe(0);
  expect((await cli(['complete', '--result', 'restored completed'], workerEnv())).code).toBe(0);
  expect(await page.evaluate(() => config.mainSession.tasks.at(-1).receipt.summary)).toBe('restored completed');
});

test('PTY startup failure and quit revoke credentials; app restart removes crash leftovers', async () => {
  const dir = path.join(profile, 'board-control', 'credentials');
  const file = path.join(dir, 'spawn-failure.json');
  const badCwd = path.join(profile, 'not-a-directory');
  fs.writeFileSync(badCwd, 'a file cannot be a shell cwd');
  const reason = await page.evaluate((cwd) => new Promise((resolve) => {
    window.deck.onPtyExit((id, reason) => { if (id === 'spawn-failure') resolve(reason); });
    window.deck.ptySpawn('spawn-failure', cwd, 80, 24, false);
  }), badCwd);
  expect(reason).toMatch(/启动失败|终端进程退出/);
  expect(fs.existsSync(file)).toBe(false);
  const previous = workerEnv().AGENTDECK_RECEIPT_TOKEN;
  const electronProcess = app.process();
  await closeElectron(app); app = null;
  expect(electronProcess.exitCode).toBe(0);
  expect(fs.existsSync(path.join(dir, 'submit-worker.json'))).toBe(false);
  // Simulate a file left by an abnormal exit, then start the isolated app again.
  fs.writeFileSync(path.join(dir, 'stale.json'), '{}', { mode: 0o600 });
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_RECEIPT_ENV_DIR: receiptDir, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => workerEnv().AGENTDECK_RECEIPT_TOKEN !== previous).toBe(true);
  expect(fs.existsSync(path.join(dir, 'stale.json'))).toBe(false);
  await dispatch('after app restart');
  const restarted = JSON.parse(fs.readFileSync(path.join(dir, 'submit-worker.json'), 'utf8'));
  expect(restarted.receiptToken).toBe(workerEnv().AGENTDECK_RECEIPT_TOKEN);
  if (process.platform !== 'win32') expect(restarted.tty).toMatch(/^\/dev\/(?:ttys\d+|tty\d+|pts\/\d+)$/);
  expect((await cli(['complete', '--result', 'no tty'], filteredEnv(workerEnv()))).code).toBe(1);
  expect((await cli(['complete', '--result', 'restarted completed'], workerEnv())).code).toBe(0);
});

test('a day-long receipt wait returns promptly for a labelled abnormal receipt and duplicates stay quiet', async () => {
  // The preceding restart rotates the Captain capability; export its current
  // credential through the real PTY again instead of reusing the old snapshot.
  fs.rmSync(controlFile, { force: true });
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  const exportEnv = `node "${path.join(profile, 'export-control.js')}" "${controlFile}"`;
  await page.evaluate(([id, command]) => window.deck.ptyInput(id, command + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  expect((await cli(['receipts'], control)).code).toBe(0);
  await dispatch('silence monitor probe');
  const waiting = cli(['receipts', '--wait', '--timeout', '86400'], control);
  // Allow the first authenticated poll to register before producing the event.
  await expect.poll(() => fs.readdirSync(path.join(profile, 'board-control', 'receipt-listeners')).filter((name) => name.endsWith('.json')).length).toBe(1);
  const duplicate = await cli(['receipts', '--wait', '--timeout', '86400'], control);
  expect(duplicate).toEqual({ code: 0, stdout: '', stderr: '' });
  const started = Date.now();
  await page.evaluate(() => {
    const task = config.mainSession.tasks.at(-1), entry = terms.get('submit-worker');
    const quiet = Date.now() - MainCore.silenceTimeout(columns.find((c) => c.id === task.colId).cmd) - 1000;
    task.startedAt = quiet;
    task.endedAt = 0;
    MainSession.onTick(task.colId, { ...entry, alive: true, state: 'working', lastOutputAt: quiet, lastScreen: '' });
  });
  const received = await waiting;
  expect(Date.now() - started).toBeLessThan(10000);
  expect(received.code, received.stderr).toBe(0); expect(received.stdout).toContain('异常回执（长时间无输出）');
  expect(received.stdout).toContain('submit-worker');
  const task = await page.evaluate(() => config.mainSession.tasks.at(-1));
  expect(task.status).toBe('working');
  expect((await cli(['complete', '--result', 'silence check complete'], workerEnv())).code).toBe(0);
});

test('closing the isolated application ends its day-long listener without an orphan', async () => {
  const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  expect((await cli(['receipts'], control)).code).toBe(0);
  const waiting = cli(['receipts', '--wait', '--timeout', '86400'], control);
  await expect.poll(() => fs.readdirSync(path.join(profile, 'board-control', 'receipt-listeners')).filter((name) => name.endsWith('.json')).length).toBe(1);
  const started = Date.now();
  await closeElectron(app); app = null;
  const ended = await waiting;
  expect(ended).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(Date.now() - started).toBeLessThan(10000);
});
