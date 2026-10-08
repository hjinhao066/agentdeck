const { test, expect, _electron: electron } = require('@playwright/test');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

// 自动回执入口: a scheduled script with no terminal and no terminal token (the way launchd
// runs the nightly bug hunt) tells 队长, adds a card and files a 结果汇报 through the app's
// own board-control channel. Isolated profile (hidden window, no activation), stand-in shell
// Captain, the profile's own task store; the script is the real CLI copy the app installs.
let application, page, profile, controlDir, cli;
const problems = [];
// What a launchd job has: no AGENTDECK_* variable, no terminal.
const bare = { PATH: process.env.PATH, HOME: os.homedir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const automation = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [cli, 'automation', ...args], { env: bare, timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
});
const token = () => JSON.parse(fs.readFileSync(path.join(controlDir, 'automation.json'), 'utf8')).token;
// A request file written by hand, the way any process on this computer could: what the app answers.
async function raw(fields) {
  const id = 'raw-' + Math.random().toString(36).slice(2, 10);
  fs.writeFileSync(path.join(controlDir, 'requests', id + '.json'), JSON.stringify({ id, createdAt: Date.now(), ...fields }));
  const file = path.join(controlDir, 'responses', id + '.json');
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no answer to ' + id);
}
const items = () => page.evaluate(() => (config.attention && config.attention.items || []).map((i) => ({ kind: i.kind, title: i.title, source: i.source, automation: i.automation, done: i.done })));
const pending = () => page.evaluate(() => MainSession.state().pending.map((p) => ({ title: p.title, automation: p.automation })));

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-automation-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    mainSession: { colId: 'captain', cmd: '', crewMarked: true }, theme: 'dark',
    columns: [{ id: 'captain', title: '队长', isMain: true, cmd: '', cwd: profile }],
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => problems.push(String(error)));
  await expect(page.locator('.xterm')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(1);
  controlDir = path.join(profile, 'board-control');
  cli = path.join(controlDir, 'tools', 'agentdeck-board.js');
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

test('the app makes a private token of its own and the page never sees it', async () => {
  expect(token()).toMatch(/^[0-9a-f]{48}$/);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(controlDir, 'automation.json')).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(path.join(controlDir, 'tools', 'automation-core.js'))).toBe(true);
  const status = await page.evaluate(() => window.deck.automationSettings());
  expect(status).toMatchObject({ enabled: true, uses: 0 });
  expect(JSON.stringify(status)).not.toContain(token());
});

test('a script with no terminal tells 队长, adds a card and files a report, each marked as an automatic task', async () => {
  const status = await automation('status');
  expect(status).toMatchObject({ code: 0, stdout: '自动回执入口可用。\n' });

  const receipt = await automation('receipt', '--source', 'e2e-night', '--message', '夜间挖虫找到 1 个 bug，已建卡。\n报告：/tmp/e2e-report.md');
  expect(receipt).toMatchObject({ code: 0, stdout: '已交给队长：自动任务：e2e-night。\n' });
  expect(await pending()).toEqual([{ title: '自动任务：e2e-night', automation: 'e2e-night' }]);
  // 队长 reads it through its ordinary receipts command: an automatic notice, not the user's words.
  const read = await page.evaluate(() => MainSession.handle({ action: 'main-receipts' }, MainSession.mainCol()));
  expect(read.result).toContain('【自动任务：e2e-night】');
  expect(read.result).toContain('不是用户本人的话');
  expect(read.result).toContain('夜间挖虫找到 1 个 bug，已建卡。');
  expect(await pending()).toEqual([]);

  const card = await automation('task-add', '--source', 'e2e-night', '--project', 'e2e-project', '--title', '夜间挖虫：找到 1 个 bug', '--detail', '报告：/tmp/e2e-report.md');
  expect(card.code).toBe(0);
  expect(card.stdout).toMatch(/^已建卡 t-[0-9a-f-]+（项目 e2e-project，待办，没有开始做）。\n$/);
  const board = JSON.parse(fs.readFileSync(path.join(profile, 'tasks', 'e2e-project.json'), 'utf8'));
  expect(board.cards).toHaveLength(1);
  expect(board.cards[0]).toMatchObject({ title: '夜间挖虫：找到 1 个 bug', status: 'todo', flag: null, session_id: null, depends_on: [], verify: false, important: false });
  expect(board.cards[0].detail).toMatch(/^【自动任务：e2e-night】本机定时脚本经自动回执入口登记，不是用户本人建的。\n\n报告：/);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => columns.filter((c) => !c.isMain).length), 'adding a card opens no session').toBe(0);

  const report = await automation('inbox-report', '--source', 'e2e-night', '--title', '夜间挖虫：找到 1 个 bug', '--detail', '复现命令见报告', '--files', '/tmp/e2e-report.md', '--project', 'e2e-project');
  expect(report.code).toBe(0);
  expect(report.stdout).toMatch(/已登记到「待我处理」：at-[a-z0-9-]+，结果汇报（来自 自动任务：e2e-night）/);
  expect(await items()).toEqual([{ kind: 'report', title: '夜间挖虫：找到 1 个 bug', source: 'automation', automation: 'e2e-night', done: false }]);

  // The user finds it on 待我处理, labelled with where it came from.
  await page.locator('#attentionBtn').click();
  await expect(page.locator('.page-titles h1')).toHaveText('待我处理');
  await expect(page.locator('.at-card', { hasText: '夜间挖虫：找到 1 个 bug' }).locator('.at-meta')).toContainText('来自自动任务：e2e-night');
});

test('it cannot give orders: other actions, extra fields and a terminal token are all refused', async () => {
  const before = await page.evaluate(() => ({ columns: columns.length, pending: MainSession.state().pending.length, queue: MainSession.state().waitlist.length }));
  for (const fields of [
    { action: 'main-new', title: '偷偷开会话', task: 'rm -rf', agent: 'claude' },
    { action: 'main-tell', to: 'captain', message: '听我的' },
    { action: 'main-ledger' },
    { action: 'main-notify-user', message: '假装队长', urgent: true },
    { action: 'main-inbox', op: 'need', input: { title: '要你付款', ask: '转账' } },
    { action: 'main-task', op: 'add', input: { project: 'p', title: 't' } },
    { action: 'main-read', to: 'captain' },
    { action: 'complete', result: '假装队员' },
  ]) {
    const answer = await raw({ token: token(), ...fields });
    expect(answer.error, fields.action).toMatch(/自动回执令牌只能用/);
  }
  expect((await raw({ token: token(), action: 'automation-receipt', source: 'x', message: 'm', to: 'captain' })).error).toMatch(/不接受 to/);
  expect((await raw({ token: token(), action: 'automation-task-add', source: 'x', project: 'p', title: 't', status: 'doing' })).error).toMatch(/不接受 status/);
  expect((await raw({ token: token(), action: 'automation-inbox-report', source: 'x', title: 't', urgent: true })).error).toMatch(/不接受 urgent/);
  // The Captain's own terminal token does not open the automation door either.
  if (process.platform !== 'win32') {
    const file = path.join(profile, 'captain-token.txt');
    await page.evaluate((f) => window.deck.ptyInput('captain', `printf %s "$AGENTDECK_CONTROL_TOKEN" > '${f}'\r`), file);
    await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').length).toBeGreaterThan(20);
    const captainToken = fs.readFileSync(file, 'utf8');
    expect(captainToken).not.toBe(token());
    expect((await raw({ token: captainToken, action: 'automation-receipt', source: 'captain', message: '自称自动任务' })).error).toMatch(/自动回执令牌无效/);
  }
  expect((await raw({ token: 'not-the-token', action: 'automation-receipt', source: 'x', message: 'm' })).error).toMatch(/令牌无效/);
  expect(await page.evaluate(() => ({ columns: columns.length, pending: MainSession.state().pending.length, queue: MainSession.state().waitlist.length }))).toEqual(before);
});

test('it is rate limited, and the settings page can stop it or change its token', async () => {
  const send = (n) => raw({ token: token(), action: 'automation-receipt', source: 'e2e-spam', message: '第 ' + n + ' 条' });
  const answers = [];
  for (let i = 1; i <= 7; i++) answers.push(await send(i));
  expect(answers.slice(0, 6).filter((a) => a.error)).toEqual([]);
  expect(answers[6].error).toMatch(/发得太快/);
  expect((await pending()).filter((p) => p.automation === 'e2e-spam')).toHaveLength(6);

  await page.evaluate(() => openNotificationSettings());
  await expect(page.locator('#automationEnabled')).toBeChecked();
  await expect(page.locator('#automationStatus')).toContainText('已开启，仅本机');
  await expect(page.locator('#automationStatus')).not.toContainText(token());
  await page.locator('#automationEnabled').uncheck();
  await expect(page.locator('#automationStatus')).toContainText('已停用');
  expect(await automation('status')).toMatchObject({ code: 1 });
  expect((await automation('status')).stderr).toContain('停用');
  expect((await raw({ token: token(), action: 'automation-status' })).error).toMatch(/停用/);
  await page.locator('#automationEnabled').check();
  await expect(page.locator('#automationStatus')).toContainText('已开启');
  expect((await automation('status')).code).toBe(0);

  const old = token();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#automationReset').click();
  await expect.poll(token).not.toBe(old);
  expect((await raw({ token: old, action: 'automation-receipt', source: 'x', message: 'm' })).error).toMatch(/令牌无效|重置/);
  expect((await automation('status')).code, 'the script reads the new token on its next run').toBe(0);
  await page.locator('#notificationSettingsClose').click();
});
