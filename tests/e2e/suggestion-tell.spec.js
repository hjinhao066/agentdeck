const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');
const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(__dirname, 'fixtures/fake-agent.js');
const FAKE = `node "${FIXTURE}" --interruptible`;
const SUGGESTION = `node "${FIXTURE}" --interruptible --suggestion`;
let app, page, profile, captured, control;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-suggestion-tell-'));
  captured = path.join(profile, 'prompts.jsonl'); control = path.join(profile, 'control.json');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, fitWindow: true, fitCols: 2,
    columns: [{ id: 'cap', title: '队长', cmd: FAKE, cwd: profile, isMain: true }],
    mainSession: { colId: 'cap', gen: 1, cmd: FAKE, fresh: false, crewMarked: true,
      tasks: [], pending: [], inflight: [], waitlist: [] } }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: captured, AGENTDECK_TEST_CONTROL_ENV_FILE: control };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && key !== 'AGENTDECK_TEST_PROMPT_COLUMNS_FILE' && key !== 'AGENTDECK_TEST_CONTROL_ENV_FILE') delete env[key];
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

test('suggestion text stays idle, the prose question is pushed once, and tell arrives', async () => {
  await page.evaluate(([title, command, cwd]) => MainSession.handle({ action: 'main-new', title,
    task: 'keep working', command, cwd }, MainSession.mainCol()), ['Suggestion worker', SUGGESTION, profile]);
  const id = await page.evaluate(() => columns.find((c) => c.displayTitle === 'Suggestion worker').id);
  await expect.poll(() => page.evaluate((wid) => terms.get(wid)?.lastScreen || '', id), { timeout: 20000 }).toContain('要我继续，还是你想换个做法？');
  await expect.poll(() => page.evaluate((wid) => terms.get(wid)?.state, id), { timeout: 20000 }).toBe('done');
  expect(await page.evaluate((wid) => userComposing(wid), id)).toBe(false);
  let asked = '';
  await expect.poll(async () => {
    const out = (await cli(['receipts'])).stdout;
    if (out.includes('要我继续，还是你想换个做法？')) asked = out;
    return out;
  }, { timeout: 20000 }).toContain('向你提问：要我继续，还是你想换个做法？');
  expect(asked.match(/要我继续，还是你想换个做法？/g)).toHaveLength(1);
  await page.waitForTimeout(2000);
  expect((await cli(['receipts'])).stdout).not.toContain('要我继续');

  const follow = 'follow the suggestion idle prompt';
  expect((await cli(['tell', '--to', id, '--message', follow])).code).toBe(0);
  await expect.poll(() => prompts(id).filter((p) => p.startsWith(follow)).length, { timeout: 20000 }).toBe(1);

  await page.evaluate((wid) => terms.get(wid).term.input('真实草稿', true), id);
  await expect.poll(() => page.evaluate((wid) => userComposing(wid), id), { timeout: 5000 }).toBe(true);
  const blocked = 'must not send over a real draft';
  expect((await cli(['tell', '--to', id, '--message', blocked])).code).toBe(0);
  await page.waitForTimeout(1500);
  expect(prompts(id).some((p) => p.startsWith(blocked))).toBe(false);
  await page.evaluate((wid) => terms.get(wid).term.input('\x15', true), id);
  await expect.poll(() => prompts(id).filter((p) => p.startsWith(blocked)).length, { timeout: 20000 }).toBe(1);

  const urgent = 'replace now while the suggestion is showing';
  expect((await cli(['tell', '--to', id, '--replace', '--now', '--message', urgent])).stdout).toContain('输入框就绪后立即送达');
  await expect.poll(() => prompts(id).filter((p) => p.startsWith(urgent)).length, { timeout: 20000 }).toBe(1);
});
