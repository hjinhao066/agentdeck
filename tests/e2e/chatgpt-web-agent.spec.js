const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const COOLDOWN = 200;
let app, page, profile, eventsDir, captainEnv;
test.describe.configure({ mode: 'serial' });

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  // Never let the runner's real Captain/worker capability enter the test app.
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(profile, 'board-control/tools/agentdeck-board.js'), ...args], {
      env: isolatedEnv(captainEnv), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function command(args) {
  const result = await cli(args);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return result.stdout;
}
function events() {
  const file = path.join(eventsDir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
const task = (id) => page.evaluate((colId) => config.mainSession.tasks.findLast((t) => t.colId === colId), id);
async function create(title, scenario, cardId) {
  const output = await command(['new', '--title', title, '--agent', 'chatgpt-web', '--cwd', profile,
    '--task', '[' + scenario + '] Explain the freezing point of water using public sources.',
    ...(cardId ? ['--task-id', cardId] : [])]);
  const id = output.match(/已开新会话 ([^「\s]+)/)?.[1];
  expect(id).toBeTruthy();
  return id;
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-chatgpt-web-e2e-'));
  eventsDir = path.join(profile, 'web-events');
  fs.mkdirSync(eventsDir);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    columns: [{ id: 'web-idle-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }],
  }));
  const executable = process.env.AGENTDECK_TEST_EXECUTABLE;
  app = await electron.launch({ executablePath: executable || undefined,
    args: [...(executable ? [] : [ROOT]), '--test-user-data=' + profile],
    env: isolatedEnv({
      AGENTDECK_TEST_CHATGPT_WEB_CLI: path.join(__dirname, 'fixtures/fake-chatgpt-web.js'),
      AGENTDECK_TEST_CHATGPT_WEB_COOLDOWN_MS: String(COOLDOWN),
      AGENTDECK_TEST_CHATGPT_WEB_EVENTS_DIR: eventsDir,
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof MainSession === 'object' && typeof TaskBoard === 'object');
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  // Export the isolated capability through the real Captain PTY, as in the
  // command-receipts spec. Neither the capability nor browser state is printed.
  const controlFile = path.join(profile, 'captain.json');
  const exportScript = path.join(profile, 'export-control.cjs');
  fs.writeFileSync(exportScript, `require('fs').writeFileSync(process.argv[2], JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}));`);
  await page.evaluate(([id, cmd]) => window.deck.ptyInput(id, cmd + '\r'), [captain, `node "${exportScript}" "${controlFile}"`]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
  captainEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  await page.evaluate(() => TaskBoard.autoVerify(false));
});
test.afterAll(async () => {
  if (app) await closeElectron(app);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('Captain CLI dispatches web sessions, peek tracks waiting, cooldown serializes requests, and receipts close the board attempt', async () => {
  const card = JSON.parse(await command(['task', 'add', '--project', 'web-e2e', '--title', 'Public web research', '--verify'])).card;
  const first = await create('Web research first', 'FIRST', card.id);
  await expect(page.getByRole('button', { name: '收起队员列表', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => events().some((e) => e.event === 'begin' && e.scenario === 'FIRST'), { timeout: 15000 }).toBe(true);
  expect((await task(first)).status).toBe('working');
  const ledger = await command(['ledger']);
  expect(ledger).toContain(first);
  expect(ledger).toContain('Web research first');
  expect(ledger).toContain('干活中');
  expect(await command(['peek', '--id', first])).toMatch(/网页|等待|ChatGPT/);

  const second = await create('Web research second', 'SECOND');
  expect(await command(['peek', '--id', second])).toMatch(/排队|冷却|等待/);
  expect(events().filter((e) => e.event === 'begin')).toHaveLength(1);
  fs.writeFileSync(path.join(eventsDir, 'release-FIRST'), 'release');
  await expect.poll(async () => (await task(first))?.status, { timeout: 15000 }).toBe('done');
  await expect.poll(() => events().some((e) => e.event === 'begin' && e.scenario === 'SECOND'), { timeout: 15000 }).toBe(true);
  const firstEnd = events().find((e) => e.event === 'end' && e.scenario === 'FIRST');
  const secondBegin = events().find((e) => e.event === 'begin' && e.scenario === 'SECOND');
  expect(secondBegin.at - firstEnd.at).toBeGreaterThanOrEqual(COOLDOWN);
  fs.writeFileSync(path.join(eventsDir, 'release-SECOND'), 'release');
  await expect.poll(async () => (await task(second))?.status, { timeout: 15000 }).toBe('done');

  const receipt = (await task(first)).receipt;
  expect(receipt.summary).toContain('Water freezes at 0');
  expect(receipt.failed || '').toBe('');
  const report = receipt.files.find((file) => file.endsWith('.md'));
  expect(path.isAbsolute(report)).toBe(true);
  expect(fs.readFileSync(report, 'utf8')).toContain('[NIST](https://www.nist.gov/)');
  expect(JSON.parse(fs.readFileSync(report + '.meta.json', 'utf8')).selectedModel).toBe('6 Pro');
  await expect.poll(() => page.evaluate((id) => TaskBoard.list().then((cards) => cards.find((c) => c.id === id)?.status), card.id)).toBe('review');
  const bound = await page.evaluate((id) => TaskBoard.list().then((cards) => cards.find((c) => c.id === id)), card.id);
  expect(bound.session_id).toBe(first);
  expect(bound.latest_receipt).toContain('Water freezes at 0');
  const receipts = await command(['receipts']);
  expect(receipts).toContain(receipt.summary);
  expect(receipts).toContain(report);
  expect(await command(['peek', '--id', first])).toMatch(/完成|保存|Water freezes/);
  expect(events().map((e) => e.event + ':' + e.scenario)).toEqual(['begin:FIRST', 'end:FIRST', 'begin:SECOND', 'end:SECOND']);
});

for (const [scenario, reason] of [
  ['LOGIN_REQUIRED', /未登录|需要.*登录|用户.*登录/],
  ['RATE_LIMITED', /额度|上限|限流/],
  ['TIMEOUT', /超时/],
]) {
  test('web ' + scenario + ' returns a human-readable failed receipt without a report', async () => {
    const id = await create('Web ' + scenario, scenario);
    await expect.poll(async () => (await task(id))?.status, { timeout: 15000 }).toBe('failed');
    const receipt = (await task(id)).receipt;
    expect(receipt.failed).toMatch(reason);
    const ledgerLine = (await command(['ledger'])).split('\n').find((line) => line.startsWith(id + ' '));
    expect(ledgerLine).toContain('没做成');
    expect(ledgerLine).not.toContain('已完成');
    // Exercise the idle timer's post-debounce path too: it used to turn a
    // non-working state green once hasWorked was true, regardless of failure.
    await page.evaluate((colId) => {
      const entry = terms.get(colId);
      entry.idleTicks = 2;
      entry.workStart = Date.now() - 1000;
      setDot(entry, 'working');
    }, id);
    await expect.poll(() => page.evaluate((colId) => {
      const entry = terms.get(colId);
      return { state: entry.state, cls: entry.dot.className, title: entry.dot.title };
    }, id)).toEqual({ state: 'failed', cls: 'dot failed', title: '没做成' });
    await expect(page.locator(`.colnav-item[data-col-id="${id}"] .cn-dot`)).toHaveAttribute('title', '没做成');
    expect(receipt.files || []).not.toContainEqual(expect.stringMatching(/\.md$/));
    const receipts = await command(['receipts']);
    expect(receipts).toContain(receipt.failed);
    expect(await command(['peek', '--id', id])).toMatch(reason);
    expect(events().filter((e) => e.event === 'begin' && e.scenario === scenario)).toHaveLength(1);
    if (scenario === 'LOGIN_REQUIRED') expect(receipt.failed).toMatch(/用户|手动|专用.*登录/);
  });
}

for (const replace of [false, true]) {
  test('web tell --now runs C before queued B' + (replace ? ' and --replace drops B' : ' then resumes B'), async () => {
    const prefix = replace ? 'REPLACE' : 'NOW';
    const id = await create('Web urgent ' + prefix, prefix + '_A');
    const sessionTasks = () => page.evaluate((colId) => config.mainSession.tasks.filter((t) => t.colId === colId), id);
    const begins = () => events().filter((e) => e.event === 'begin' && e.scenario.startsWith(prefix + '_')).map((e) => e.scenario);
    await expect.poll(begins, { timeout: 15000 }).toEqual([prefix + '_A']);
    const first = await task(id);
    await command(['tell', '--to', id, '--message', '[' + prefix + '_B] Why are clouds white?']);
    const second = await task(id);
    expect(second.status).toBe('queued');
    await command(['tell', '--to', id, '--now', ...(replace ? ['--replace'] : []), '--message', '[' + prefix + '_C] Why are sunsets red?']);
    const urgent = await task(id);
    await expect.poll(begins, { timeout: 15000 }).toEqual([prefix + '_A', prefix + '_C']);
    const tasks = await sessionTasks();
    expect(tasks.find((t) => t.id === first.id).status).toBe('stopped');
    expect(tasks.find((t) => t.id === second.id).status).toBe(replace ? 'stopped' : 'queued');
    expect(tasks.find((t) => t.id === urgent.id).status).toBe('working');
    fs.writeFileSync(path.join(eventsDir, 'release-' + prefix + '_C'), 'release');
    await expect.poll(async () => (await sessionTasks()).find((t) => t.id === urgent.id)?.status, { timeout: 15000 }).toBe('done');
    if (!replace) {
      await expect.poll(begins, { timeout: 15000 }).toEqual([prefix + '_A', prefix + '_C', prefix + '_B']);
      fs.writeFileSync(path.join(eventsDir, 'release-' + prefix + '_B'), 'release');
      await expect.poll(async () => (await sessionTasks()).find((t) => t.id === second.id)?.status, { timeout: 15000 }).toBe('done');
    } else expect(begins()).toEqual([prefix + '_A', prefix + '_C']);
    await command(['receipts']);
  });
}
