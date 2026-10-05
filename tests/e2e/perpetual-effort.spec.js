const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --token-saver --board-probe`;
const CAPTAIN = 'capability-captain', INDEPENDENT = 'capability-independent';
let application, page, profile;
const children = [];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  // The stand-in agents start in the column's shell. Whatever shell and startup files the
  // caller has must not decide whether they start: zsh, with ZDOTDIR on the empty profile
  // (set at launch), and the node that runs this test first on PATH.
  if (process.platform !== 'win32') {
    if (fs.existsSync('/bin/zsh')) env.SHELL = '/bin/zsh';
    env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
  }
  return { ...env, ...extra };
}
function cli(args, extra = {}) {
  const child = spawn(process.execPath, [path.join(profile, 'board-control', 'tools', 'agentdeck-board.js'), ...args], {
    env: cleanEnv(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
const credentialsFile = (id) => path.join(profile, 'board-control', 'credentials', id + '.json');

test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-perpetual-capability-')));
  const home = path.join(profile, 'seats-home');
  fs.writeFileSync(path.join(profile, '.zshrc'), '');   // an empty startup file: no personal hooks, no first-run wizard
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"},"hasCompletedOnboarding":true}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"},"hasCompletedOnboarding":true}');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, theme: 'dark', fitCols: 2,
    columns: [
      { id: CAPTAIN, title: '队长', isMain: true, cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
      { id: INDEPENDENT, title: '独立会话', cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
    ],
    mainSession: { colId: CAPTAIN, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
  }));
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env: cleanEnv({ ZDOTDIR: profile, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md'),
      AGENTDECK_TEST_BOARD_RESULTS_FILE: path.join(profile, 'board-results.jsonl') }),
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => page.evaluate((id) => {
    const entry = terms.get(id);
    return entry?.state === 'done' && !entry.sendingPrompt && !entry.injecting && MainSession.relayIdle();
  }, CAPTAIN), { timeout: 20000 }).toBe(true);
});
test.afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  if (page && !page.isClosed()) await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  if (application) await closeElectron(application);
  application = null; page = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('Relay revokes the old Captain and listener, preserves independent tokens, and leaves new receipts for its replacement', async () => {
  test.setTimeout(90000);
  const controlDir = path.join(profile, 'board-control');
  const old = JSON.parse(fs.readFileSync(credentialsFile(CAPTAIN), 'utf8'));
  const independent = JSON.parse(fs.readFileSync(credentialsFile(INDEPENDENT), 'utf8'));
  expect(old.controlToken).not.toBe(''); expect(independent.controlToken).toBe('');
  const oldEnv = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: old.controlToken };
  expect((await cli(['ledger'], oldEnv).done).code).toBe(0);
  const watcher = cli(['receipts', '--wait', '--timeout', '30'], oldEnv);
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(true);
  const newId = await page.evaluate(() => config.mainSession.colId);
  expect(newId).not.toBe(CAPTAIN);
  await page.evaluate((id) => {
    config.mainSession.pending.push({ taskId: 'protected-task', colId: id, title: '交接后回执',
      ts: Date.now(), summary: 'handoff-protected-receipt', files: [] });
    flushConfig();
  }, INDEPENDENT);
  await expect.poll(() => fs.existsSync(credentialsFile(CAPTAIN))).toBe(false);
  await expect.poll(() => fs.existsSync(credentialsFile(newId))).toBe(true);
  const fresh = JSON.parse(fs.readFileSync(credentialsFile(newId), 'utf8'));
  expect(fresh.controlToken).not.toBe(old.controlToken);
  expect(fresh.receiptToken).not.toBe(old.receiptToken);
  expect(JSON.parse(fs.readFileSync(credentialsFile(INDEPENDENT), 'utf8'))).toEqual(independent);
  const obsolete = await watcher.done;
  expect(obsolete.code).toBe(1);
  expect(obsolete.stderr).toContain('Control request rejected');
  expect(obsolete.stdout).not.toContain('handoff-protected-receipt');
  expect(await page.evaluate(() => config.mainSession.pending.some((r) => r.summary === 'handoff-protected-receipt'))).toBe(true);
  expect((await cli(['ledger'], { ...oldEnv, AGENTDECK_TERMINAL_ID: newId }).done).code).toBe(1);
  expect((await cli(['ledger'], { AGENTDECK_TERMINAL_ID: CAPTAIN }).done).code).toBe(1);
  const denied = await cli(['ledger'], { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: independent.receiptToken }).done;
  expect(denied.code).toBe(1); expect(denied.stderr).toContain('Receipt capability');
  expect(await page.evaluate(async (id) => {
    try { await window.deck.captainRelayNotify(id, 'worker should not send'); return false; }
    catch (_) { return true; }
  }, INDEPENDENT)).toBe(true);
  // This CLI runs in the external test runner, outside the replacement's PTY.
  // A column id cannot recover that terminal's private capability on any OS.
  const unbound = await cli(['ledger'], { AGENTDECK_TERMINAL_ID: newId }).done;
  expect(unbound.code).toBe(1);
  expect(unbound.stderr).toContain('This terminal is independent');
  const replacementEnv = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: fresh.controlToken };
  const replacement = await cli(['receipts', '--wait', '--timeout', '10'], replacementEnv).done;
  expect(replacement.code, replacement.stderr + replacement.stdout).toBe(0);
  expect(replacement.stdout).toContain('handoff-protected-receipt');
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
  if (process.platform !== 'win32') {
    // Recovery without inherited environment belongs to the real Captain PTY.
    await expect.poll(() => page.evaluate((id) => {
      const entry = terms.get(id);
      return entry?.state === 'done' && !entry.sendingPrompt && !entry.injecting;
    }, newId), { timeout: 20000 }).toBe(true);
    await page.evaluate((id) => window.deck.ptyInput(id, 'BOARD-NO-ENV ["ledger"]\r'), newId);
    const results = () => {
      const file = path.join(profile, 'board-results.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    };
    await expect.poll(() => results().find((r) => r.colId === newId)?.code, { timeout: 20000 }).toBe(0);
    expect(results().find((r) => r.colId === newId).stdout).toContain(INDEPENDENT);
  }
});

test('after a Relay the new Captain reads the handoff through the CLI; a second listener replaces the first; a command past its deadline is not run', async () => {
  test.setTimeout(120000);
  const controlDir = path.join(profile, 'board-control');
  const old = JSON.parse(fs.readFileSync(credentialsFile(CAPTAIN), 'utf8'));
  const oldEnv = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: old.controlToken };
  // work that is still out at the moment of the Relay
  await page.evaluate((id) => {
    config.mainSession.tasks = [{ id: 'k-open', colId: id, title: '交接时还在跑的活', status: 'working', gen: 1, sentAt: Date.now(), startedAt: Date.now() }];
    flushConfig();
  }, INDEPENDENT);
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(true);
  const newId = await page.evaluate(() => config.mainSession.colId);
  await expect.poll(() => fs.existsSync(credentialsFile(newId))).toBe(true);
  const fresh = JSON.parse(fs.readFileSync(credentialsFile(newId), 'utf8'));
  const env = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: fresh.controlToken };
  const boards = path.join(profile, 'seats-home', '.agents', 'boards');
  const file = path.join(boards, 'agentdeck-captain-handoff.md');
  // written before the old terminal was replaced, from the state at that moment
  const written = fs.readFileSync(file, 'utf8');
  expect(written).toContain('触发：席位 Relay'); expect(written).toContain(`上任会话：${CAPTAIN}`);
  expect(written).toContain('交接时还在跑的活'); expect(written).toContain('队长代次 gen 1 → 2');
  // the Captain's own notes file exists as an empty template and is not the app's to fill
  expect(fs.readFileSync(path.join(boards, 'agentdeck-captain-decisions.md'), 'utf8')).toContain('## 暂停/取消/暂不启动');

  // on demand: the same text from the live state, for the new Captain only
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.colId, { timeout: 15000 }).toBe(newId);
  const live = await cli(['handoff'], env).done;
  expect(live.stderr).toBe(''); expect(live.code).toBe(0);
  expect(live.stdout).toContain('# AgentDeck 队长交接'); expect(live.stdout).toContain('触发：队长运行 handoff');
  expect(live.stdout).toContain(`上任会话：${CAPTAIN}`); expect(live.stdout).toContain('交接时还在跑的活');
  expect(live.stdout).toBe(fs.readFileSync(file, 'utf8') + '\n');
  const refused = await cli(['handoff'], oldEnv).done;
  expect(refused.code).toBe(1); expect(refused.stderr).toContain('Control request rejected');
  expect((await cli(['handoff'], { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: fresh.receiptToken }).done).code).toBe(1);

  // two listeners in the new Captain's terminal: the later one keeps the channel
  const first = cli(['receipts', '--wait', '--timeout', '60'], env);
  await page.waitForTimeout(2500);
  const second = cli(['receipts', '--wait', '--timeout', '60'], env);
  const replaced = await first.done;
  expect(replaced.code).toBe(0); expect(replaced.stdout).toContain('已有更新的回执监听在运行'); expect(replaced.stdout).toContain('不要为它重挂');
  await page.evaluate((id) => {
    config.mainSession.pending.push({ taskId: 'after-replace', colId: id, title: '换监听之后的回执', ts: Date.now(), summary: 'reaches-the-one-listener', files: [] });
    flushConfig();
  }, INDEPENDENT);
  const delivered = await second.done;
  expect(delivered.code).toBe(0); expect(delivered.stdout).toContain('reaches-the-one-listener'); expect(delivered.stdout).not.toContain('已有更新的回执监听');
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);

  // a command the CLI has already given up on is refused instead of opening a session late
  const columnsBefore = await page.evaluate(() => columns.length);
  const requestId = `${Date.now()}-late-${Math.random().toString(16).slice(2, 10)}`;
  const request = { id: requestId, token: fresh.controlToken, createdAt: Date.now() - 31000, deadline: Date.now() - 1000,
    action: 'main-new', title: '迟到的派活', task: '不该被执行', command: FAKE, project: '', reviews: [], agent: '', cwd: '', boardId: '' };
  fs.writeFileSync(path.join(controlDir, 'requests', requestId + '.json.tmp'), JSON.stringify(request));
  fs.renameSync(path.join(controlDir, 'requests', requestId + '.json.tmp'), path.join(controlDir, 'requests', requestId + '.json'));
  const responseFile = path.join(controlDir, 'responses', requestId + '.json');
  await expect.poll(() => fs.existsSync(responseFile), { timeout: 15000 }).toBe(true);
  expect(JSON.parse(fs.readFileSync(responseFile, 'utf8')).error).toContain('没有执行');
  expect(await page.evaluate(() => columns.length)).toBe(columnsBefore);
  expect(await page.evaluate(() => config.mainSession.tasks.some((t) => t.title === '迟到的派活'))).toBe(false);
});
