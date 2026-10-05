const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');
const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(__dirname, 'fixtures/fake-agent.js');
const FAKE = `node "${FIXTURE}" --interruptible`;
let app, page, profile, captured, control;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-pending-tell-'));
  captured = path.join(profile, 'prompts.jsonl'); control = path.join(profile, 'control.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ fitWindow: true, fitCols: 2,
    columns: [{ id: 'cap', title: '队长', cmd: FAKE, cwd: profile, isMain: true }],
    mainSession: { colId: 'cap', gen: 1, cmd: FAKE, fresh: false, crewMarked: true,
      tasks: [], pending: [], inflight: [], waitlist: [] } }));
  const env = { ...process.env, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: captured, AGENTDECK_TEST_CONTROL_ENV_FILE: control };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof terms !== 'undefined', null, { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => terms.get('cap')?.lastScreen || ''), { timeout: 20000 }).toContain('Claude Code');
  await expect.poll(() => fs.existsSync(control)).toBe(true);
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function cli(args) {
  const env = { ...process.env, ...JSON.parse(fs.readFileSync(control, 'utf8')) };
  const file = path.join(profile, 'board-control/tools/agentdeck-board.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const prompts = (id) => fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((p) => p.colId === id).map((p) => p.text) : [];
async function worker(title, command = FAKE) {
  await page.evaluate(([title, command, cwd]) => MainSession.handle({ action: 'main-new', title,
    task: 'keep working', command, cwd }, MainSession.mainCol()), [title, command, profile]);
  const id = await page.evaluate((title) => columns.find((c) => c.displayTitle === title).id, title);
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.state, id), { timeout: 20000 }).toBe('working');
  return id;
}

test('busy past 30 minutes stays queued with one reminder, then reaches the real PTY exactly once', async () => {
  const id = await worker('Long research');
  const message = 'queued supplement after the long research';
  const queued = await cli(['tell', '--to', id, '--message', message]);
  expect(queued.code, queued.stderr).toBe(0);
  const taskId = await page.evaluate((id) => MainSession.state().tasks.filter((t) => t.colId === id).at(-1).id, id);
  try {
    await page.evaluate(() => { window.pendingTellRealNow = Date.now; Date.now = () => window.pendingTellRealNow() + 31 * 60_000; });
    await expect.poll(() => page.evaluate((id) => MainSession.state().pending.filter((p) => p.taskId === id && p.source === 'queue').length, taskId)).toBe(1);
    expect(await page.evaluate((id) => MainSession.state().tasks.find((t) => t.id === id).status, taskId)).toBe('queued');
    expect(prompts(id).some((p) => p.startsWith(message))).toBe(false);
    await page.waitForTimeout(1100);
    expect(await page.evaluate((id) => MainSession.state().pending.filter((p) => p.taskId === id && p.source === 'queue').length, taskId)).toBe(1);
    expect((await cli(['receipts'])).stdout).toContain('仍在排队');
  } finally {
    await page.evaluate(() => { Date.now = window.pendingTellRealNow; delete window.pendingTellRealNow; });
  }
  await page.evaluate((id) => window.deck.ptyInput(id, '\x1b'), id);
  await expect.poll(() => prompts(id).filter((p) => p.startsWith(message)).length, { timeout: 20000 }).toBe(1);
  await expect.poll(() => page.evaluate((id) => MainSession.state().tasks.find((t) => t.id === id).status, taskId), { timeout: 20000 }).toBe('done');
  expect(prompts(id).filter((p) => p.startsWith(message))).toHaveLength(1);
});

test('actual agent exit fails unsent work while the shell stays alive and read recovers the full text after reload', async () => {
  const script = path.join(profile, 'crash-agent.cjs');
  const pidFile = path.join(profile, 'crash-agent.pid');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => process.exit(7)); require(${JSON.stringify(FIXTURE)});`);
  const id = await worker('Exiting research', `node "${script}" --interruptible`);
  const body = 'unsent instructions🙂\n'.repeat(700) + 'FULL INSTRUCTION END';
  expect((await cli(['tell', '--to', id, '--message', body])).code).toBe(0);
  const taskId = await page.evaluate((id) => MainSession.state().tasks.filter((t) => t.colId === id).at(-1).id, id);
  process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
  await expect.poll(() => page.evaluate((id) => MainSession.state().tasks.find((t) => t.id === id).status, taskId), { timeout: 20000 }).toBe('failed');
  expect(await page.evaluate((id) => terms.get(id).alive, id)).toBe(true);
  expect(prompts(id).some((p) => p.includes('FULL INSTRUCTION END'))).toBe(false);
  const receipt = await cli(['receipts']);
  expect(receipt.stdout).toContain('exit'); expect(receipt.stdout).toContain(`read --id ${taskId}`);
  expect((await cli(['read', '--id', taskId])).stdout).toBe(body + '\n');
  await page.reload();
  await page.waitForFunction(() => typeof MainSession !== 'undefined', null, { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => !!MainSession.state())).toBe(true);
  expect((await cli(['read', '--id', taskId])).stdout).toBe(body + '\n');
  expect(await page.evaluate((id) => ChatUI.turnsOf('cap').find((t) => t.id === id).task.receipt.undeliveredInstruction, taskId)).toBe(body);
});
