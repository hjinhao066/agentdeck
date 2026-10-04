const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOLD = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only --hold`;
const QUOTA = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only --quota-on-start`;
let app, page, profile, envDir, captainEnv, prompts;
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
  const result = await cli(args, env); expect(result.stderr, result.stdout).toBe(''); expect(result.code, result.stderr || result.stdout).toBe(0); return result.stdout;
}
const card = async (id) => (await page.evaluate((f) => TaskBoard.list(f), { archived: true })).find((c) => c.id === id);
async function add(title) {
  return JSON.parse(await command(['task', 'add', '--project', 'e2e', '--title', title, '--detail', 'Clear test instructions.'])).card;
}
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dispatch-fixes-e2e-'));
  envDir = path.join(profile, 'env'); fs.mkdirSync(envDir);
  prompts = path.join(profile, 'prompts.jsonl');
  const controlFile = path.join(profile, 'captain.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ columns: [] }));
  const env = { ...process.env, AGENTDECK_TEST_RECEIPT_ENV_DIR: envDir, AGENTDECK_TEST_PROMPTS_FILE: prompts };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => {
    try { return typeof MainSession.exists === 'function' && typeof MainSession.exists() === 'boolean' && typeof MainCore.pickDispatcher === 'function'; }
    catch (e) { return false; }
  });
  await page.evaluate((cwd) => MainSession.create('', cwd), profile);
  const captain = await page.evaluate(() => MainSession.mainCol().id);
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), captain)).toBe(true);
  const exportEnv = `node -e 'require("fs").writeFileSync(${JSON.stringify(controlFile)}, JSON.stringify({AGENTDECK_CONTROL_DIR:process.env.AGENTDECK_CONTROL_DIR,AGENTDECK_CONTROL_TOKEN:process.env.AGENTDECK_CONTROL_TOKEN}))'`;
  await page.evaluate(([id, cmd]) => window.deck.ptyInput(id, cmd + '\r'), [captain, exportEnv]);
  await expect.poll(() => fs.existsSync(controlFile)).toBe(true);
  captainEnv = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
});
test.afterAll(async () => {
  const pid = app?.process?.()?.pid;
  if (pid) { try { execFileSync('pkill', ['-KILL', '-P', String(pid)]); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} }
  app = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('dispatcher uses Cursor Grok unless that quota is exhausted', async () => {
  const choice = await page.evaluate(() => ({
    grok: MainCore.pickDispatcher({ Cursor: 'normal' }),
    unknown: MainCore.pickDispatcher({}),
    next: MainCore.pickDispatcher({ Cursor: 'exhausted', Codex: 'normal', Claude: 'unknown', Antigravity: 'exhausted' }),
    none: MainCore.pickDispatcher({ Cursor: 'exhausted', Codex: 'unknown', Claude: 'exhausted', Antigravity: 'unknown' }),
  }));
  expect(choice.grok).toEqual({ provider: 'Cursor', cmd: 'cursor-agent --force --model grok-4.7-high-fast' });
  expect(choice.unknown.cmd).toBe('cursor-agent --force --model grok-4.7-high-fast');
  expect(choice.next.provider).toBe('Codex');
  expect(choice.none).toBeNull();
});

test('a dispatcher quota failure does not hold the card and leaves the sidebar', async () => {
  await page.evaluate((cmd) => { MainCore.pickDispatcher = () => ({ provider: 'Cursor', cmd }); }, QUOTA);
  const c = await add('调度卡片');
  const started = await page.evaluate((id) => TaskBoard.startCard(id), c.id);
  expect(started.dispatcher).toBe('gemini');
  expect(started.session_id).toBeTruthy();
  await expect.poll(() => page.evaluate((id) => !!terms.get(id), started.session_id)).toBe(true);
  await page.evaluate((id) => {
    const entry = terms.get(id);
    MainSession.onTick(id, { ...entry, alive: true, state: 'quota', lastScreen: "You've hit your usage limit\nContinuing at 5pm · esc to cancel" });
  }, started.session_id);
  await expect.poll(async () => {
    const item = await card(c.id);
    const placed = await page.evaluate((id) => ({
      inDeck: columns.some((c) => c.id === id),
      archived: (config.archived || []).some((a) => a.id === id),
    }), started.session_id);
    return { flag: item.flag, failures: item.consecutive_failures, ...placed };
  }).toEqual({ flag: null, failures: 0, inDeck: false, archived: true });
  const again = await page.evaluate((id) => TaskBoard.startCard(id), c.id);
  expect(again.dispatcher).not.toBe('gemini');
  expect(await page.evaluate(() => columns.filter((c) => c.dispatcherCardId).length)).toBe(0);
});

test('tell resumes a done card, the session shows working, and moving it back does not dispatch', async () => {
  const c = await add('调度卡片派新人');
  const output = await command(['new', '--task-id', c.id, '--project', 'e2e', '--title', 'Worker', '--task', 'Run this single test task', '--command', HOLD]);
  const session = output.match(/已开新会话 ([^「]+)/)?.[1];
  expect(session).toBeTruthy();
  await expect.poll(() => page.evaluate((id) => config.mainSession.tasks.findLast((t) => t.colId === id)?.status, session), { timeout: 30000 }).toBe('working');
  await expect.poll(() => fs.existsSync(prompts)).toBe(true);
  expect(fs.readFileSync(prompts, 'utf8')).toMatch(/中途汇报或暂停用 progress，不要用 complete/);
  await expect.poll(() => fs.existsSync(path.join(envDir, session + '.json'))).toBe(true);
  const env = JSON.parse(fs.readFileSync(path.join(envDir, session + '.json'), 'utf8'));
  await command(['complete', '--result', '已停在安全点'], env);
  expect((await card(c.id)).status).toBe('done');
  const before = await page.evaluate(() => columns.filter((c) => String(c.title || '').startsWith('调度')).length);
  expect(await command(['tell', '--to', session, '--message', 'hold open and continue'])).toMatch(/已发给|准备好后会收到|待补充/);
  await expect.poll(async () => (await card(c.id)).status).toBe('doing');
  expect((await card(c.id)).session_id).toBe(session);
  expect((await card(c.id)).flag).not.toBe('held');
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.state, session), { timeout: 20000 }).toBe('working');
  await expect.poll(() => command(['ledger'])).toContain('干活中');
  const sidebar = await page.evaluate((id) => {
    config.crewOpen = true; Sidebar.render();
    return {
      counts: document.querySelector('.crew-counts')?.textContent || '',
      dot: document.querySelector(`#captainCrewList .colnav-item[data-col-id="${id}"] .cn-dot`)?.className || '',
    };
  }, session);
  expect(sidebar.counts).toContain('干活中');
  expect(sidebar.dot).toContain('working');
  await command(['task', 'move', '--id', c.id, '--status', 'doing']);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => columns.filter((c) => String(c.title || '').startsWith('调度')).length)).toBe(before);
  expect((await card(c.id)).session_id).toBe(session);
  expect((await card(c.id)).status).toBe('doing');
});
