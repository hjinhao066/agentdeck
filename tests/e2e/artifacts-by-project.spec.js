const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Artifacts > 回执交付: the files the crew list in their receipts, collected by
// project. Everything runs in an isolated profile with the stand-in TUI; the
// receipts are seeded the three ways the app keeps them (a session's last
// receipt, 队长's task list, old task cards) and one more is submitted through
// the real board-cli. Set AGENTDECK_ARTIFACTS_SHOTS to keep PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --screen-only`;
const shots = process.env.AGENTDECK_ARTIFACTS_SHOTS;
const isWin = process.platform === 'win32';
const revealLabel = process.platform === 'darwin' ? '在访达中显示' : isWin ? '在资源管理器中显示' : '在文件管理器中显示';
// A path from the other kind of computer: it can never exist here.
const FOREIGN = isWin ? '/Users/jinhao/reports/mac-build-log.txt' : 'C:\\Users\\jinhao\\reports\\win-build-log.txt';
// The same file as a Windows user might type it the second time.
const FOREIGN_AGAIN = isWin ? FOREIGN : FOREIGN.toUpperCase().replace(/\\/g, '/');
const foreignName = FOREIGN.split(/[\\/]/).pop();
// Under the real home folder, never created: only its name is looked up.
const HOME_FILE = path.join(os.homedir(), 'agentdeck-artifacts-e2e-never-created', 'home-notes.md');
let application, page, profile, receiptDir, out;
test.describe.configure({ mode: 'serial' });

// The spec may be started from a terminal the live deck manages: none of its
// control or receipt variables may reach the test instance.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^AGENTDECK_/.test(key) && !/^AGENTDECK_TEST_/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
async function launch(dir, extra = {}) {
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${dir}`], env: cleanEnv(extra),
  });
  page = await application.firstWindow();
  await page.waitForFunction(() => typeof columns !== 'undefined' && typeof Pages !== 'undefined' && typeof terms !== 'undefined' && columns.length > 0 && columns.every((c) => terms.get(c.id)?.wrap?.isConnected));
  await page.setViewportSize({ width: 1440, height: 900 });
  // Finder / Explorer must not open during a test run: record what would be shown.
  await application.evaluate(({ shell }) => {
    global.revealed = [];
    global.revealOps = [];
    shell.showItemInFolder = (p) => { global.revealed.push(p); global.revealOps.push({ op: 'show', p }); };
    shell.openPath = async (p) => { global.revealed.push(p); global.revealOps.push({ op: 'open', p }); return ''; };
  });
}
function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [env.AGENTDECK_BOARD_CLI, ...args], { env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.mouse.move(700, 4);
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
async function inBothThemes(name) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await screenshot(`${name}-${theme}`);
  }
  await page.evaluate(() => applyTheme('dark'));
}
const openArtifacts = async () => {
  if (!(await page.evaluate(() => Pages.current() === 'artifacts'))) await page.locator('.nav-row[data-nav="artifacts"]').click();
  await expect(page.locator('#pageView .art-tabs')).toBeVisible();
};
const group = (key) => page.locator(`.dl-group[data-project="${key}"]`);
const row = (name) => page.locator('.dl-row', { has: page.locator('.art-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
const names = (key) => group(key).locator('.dl-row .art-name').allTextContents();

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-artifacts-')));
  receiptDir = path.join(profile, 'env'); fs.mkdirSync(receiptDir);
  out = path.join(profile, 'out');
  for (const dir of ['docs', 'shots', 'export', 'scratch']) fs.mkdirSync(path.join(out, dir), { recursive: true });
  fs.writeFileSync(path.join(out, 'docs', 'login-flow.md'), '# 登录流程\n\n先验证手机号，再发放会话。\n');
  fs.writeFileSync(path.join(out, 'docs', 'api-notes.md'), '# 接口说明\n');
  fs.writeFileSync(path.join(out, 'shots', 'login-dark.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(out, 'export', 'orders.csv'), 'id,total\n1,20\n');
  fs.writeFileSync(path.join(out, 'export', 'q3-summary.txt'), '第三季度汇总\n');
  fs.writeFileSync(path.join(out, 'scratch', 'cleanup.sh'), '#!/bin/sh\necho done\n');
  const f = (...parts) => path.join(out, ...parts);
  const now = Date.now(), min = 60_000;
  const column = (id, title, project, lastReceipt) => ({ id, title, displayTitle: title, manualTitle: true, project, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, lastReceipt });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { ...column('cap', '队长', '', null), isMain: true, captainCrew: false },
      // the latest receipt of each session: exactly what `ledger` prints after 「文件：」
      column('w-login', '登录与权限', '客户门户', { summary: '登录流程文档和深色截图都更新了，回归通过。', files: [f('docs', 'login-flow.md'), f('shots', 'login-dark.png')], explicit: true, source: 'command', ts: now - 5 * min }),
      column('w-ui', '工作台界面', '客户门户', null),
      column('w-export', '报表导出', '报表服务', { summary: '导出了订单表和季度汇总，另附构建日志。', files: [f('export', 'orders.csv'), f('export', 'q3-summary.txt'), f('export') + path.sep, FOREIGN], explicit: true, source: 'command', ts: now - 40 * min }),
      column('w-misc', '临时脚本', '', { summary: '清理脚本写好了。', files: [f('scratch', 'cleanup.sh'), HOME_FILE], explicit: true, source: 'command', ts: now - 180 * min }),
    ],
    archived: [{ ...column('a-migrate', '旧版迁移', '客户门户', { summary: '迁移方案定稿。', files: [f('docs', 'migration-plan.md')], explicit: true, source: 'command', ts: now - 2 * 24 * 60 * min }), archivedAt: now - 24 * 60 * min }],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [
      // an earlier receipt of the same session: the ledger no longer shows it, 队长's task list still has it.
      // It delivered login-flow.md first; 登录与权限 delivered it again later.
      { id: 'k-ui-1', colId: 'w-ui', title: '梳理登录流程', project: '客户门户', gen: 1, status: 'done', sentAt: now - 200 * min, doneAt: now - 120 * min, turnId: '',
        receipt: { summary: '流程初稿和接口说明。', files: [f('docs', 'login-flow.md'), f('docs', 'api-notes.md')], explicit: true, source: 'command' } },
    ] },
  }));
  // Task cards in 队长's conversation outlive both the session and the task list.
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'cap.json'), JSON.stringify({ v: 1, id: 'cap', turns: [
    { id: 'k-old-1', ts: now - 6 * 24 * 60 * min, user: '整理上线清单', reply: '上线清单在这里。\n' + f('docs', 'release-checklist.md'), done: true, atts: [], kind: 'task',
      task: { colId: 'deleted-session', title: '整理上线清单', status: 'done', receipt: { summary: '上线清单在这里。', failed: '', question: '', files: [f('docs', 'release-checklist.md')], images: [], explicit: true, source: 'command' } } },
  ] }));
  fs.writeFileSync(path.join(profile, 'chats', 'w-misc.json'), JSON.stringify({ v: 1, id: 'w-misc', turns: [
    { id: 'u1', ts: now - 30 * min, user: '脚本放哪了', reply: `脚本在 ${f('scratch', 'cleanup.sh')}\n用法见 https://example.com/docs/cleanup`, done: true, atts: [] },
  ] }));
  await launch(profile, { AGENTDECK_TEST_RECEIPT_ENV_DIR: receiptDir });
  await expect.poll(() => page.evaluate(() => typeof MainSession !== 'undefined' && !!MainSession.state())).toBe(true);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('receipts already on record are collected by project, newest first, one row per path', async () => {
  await openArtifacts();
  // deliveries exist, so the page opens on them; the old collection is one tab away
  await expect(page.locator('.art-tab.active')).toHaveText(/回执交付\s*11/);
  await expect(page.locator('.art-tab[data-tab="mentioned"]')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.dl-group .dl-project')).toHaveText(['客户门户', '报表服务', '未分组']);
  await expect(page.locator('.dl-group .dl-count')).toHaveText(['4', '4', '3']);
  // newest delivery first; login-flow.md was delivered twice and shows once
  expect(await names('客户门户')).toEqual(['login-dark.png', 'login-flow.md', 'api-notes.md', 'migration-plan.md']);
  expect(await names('报表服务')).toEqual(['export', 'orders.csv', 'q3-summary.txt', foreignName].sort((a, b) => a.localeCompare(b)));
  expect(await names('')).toEqual(['cleanup.sh', 'home-notes.md', 'release-checklist.md']);
  // a path under the home folder is shown short and copied whole
  await expect(row('home-notes.md').locator('.art-path')).toHaveText(/^\u200e~[\\/]agentdeck-artifacts-e2e-never-created[\\/]home-notes\.md\u200e$/);
  await row('home-notes.md').getByRole('button', { name: '复制路径' }).click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(HOME_FILE);

  // one row per path, under the session that delivered it last
  const flow = row('login-flow.md');
  await expect(flow).toHaveCount(1);
  await expect(flow.locator('.dl-session')).toHaveText('登录与权限');
  await expect(flow.locator('.dl-receipt')).toHaveText('登录流程文档和深色截图都更新了，回归通过。');
  await expect(flow.locator('.dl-time')).toHaveText(/^今天 \d\d:\d\d$|^昨天 \d\d:\d\d$/);
  await expect(flow.locator('.dl-by')).toHaveAttribute('title', /会话：登录与权限\n回执：登录流程文档[^\n]+\n交付：/);
  // the earlier receipt still accounts for the file only it delivered
  await expect(row('api-notes.md').locator('.dl-session')).toHaveText('工作台界面');
  await expect(row('api-notes.md').locator('.dl-by')).toHaveAttribute('title', /任务：梳理登录流程/);
  await expect(row('migration-plan.md').locator('.dl-session')).toHaveText('旧版迁移（已归档）');
  // a card whose session is gone has no project to go under
  await expect(row('release-checklist.md').locator('.dl-session')).toHaveText('整理上线清单（会话已删除）');
  await expect(row('release-checklist.md').locator('.art-tool[aria-disabled="true"]')).toHaveAttribute('aria-label', '交付它的会话已经删除');
  // a delivered folder is a folder
  await expect(row('export').locator('.art-tile')).toHaveClass(/t-dir/);
  await expect(page.locator('.dl-summary')).toHaveText('11 个文件 · 2 个项目 · 4 个已不在磁盘上');
});

test('files no longer on disk stay listed, greyed out and explained', async () => {
  await openArtifacts();
  const plan = row('migration-plan.md');
  await expect(plan).toHaveClass(/gone/);
  await expect(plan.locator('.dl-flag')).toHaveText('已不在磁盘上');
  await expect(plan.locator('.dl-main')).toHaveAttribute('aria-disabled', 'true');
  await expect(plan.locator('.dl-main')).toHaveAttribute('title', /已经不在磁盘上/);
  expect(await plan.locator('.art-name').evaluate((n) => getComputedStyle(n).color)).toBe(await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--muted)'; document.body.appendChild(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }));
  await expect(row(foreignName).locator('.dl-flag')).toHaveText('另一台电脑上的路径');
  await expect(group('客户门户').locator('.dl-lost')).toHaveText('1 个已不在磁盘上');
  // it explains itself instead of opening an empty preview, and the path can still be copied
  await page.evaluate(() => SidePane.hide());
  await plan.locator('.dl-main').click({ force: true });   // aria-disabled: Playwright would wait for it to enable
  await expect(page.locator('#toast')).toContainText('已经不在磁盘上');
  await expect(page.locator('#sidePane')).toBeHidden();
  await plan.getByRole('button', { name: '复制路径' }).click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(path.join(out, 'docs', 'migration-plan.md'));
  await inBothThemes('2-missing');

  // a file deleted while the page is open is noticed when the window comes back
  const notes = row('api-notes.md');
  await expect(notes).not.toHaveClass(/gone/);
  fs.rmSync(path.join(out, 'docs', 'api-notes.md'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notes).toHaveClass(/gone/);
  await expect(group('客户门户').locator('.dl-lost')).toHaveText('2 个已不在磁盘上');
  fs.writeFileSync(path.join(out, 'docs', 'api-notes.md'), '# 接口说明\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notes).not.toHaveClass(/gone/);
});

test('a row previews on the right; copy and reveal are icon buttons with a name, tooltip and keyboard focus', async () => {
  await openArtifacts();
  const flow = row('login-flow.md');
  await flow.locator('.dl-main').click();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('登录流程');
  await expect(page.locator('#pageView')).toBeVisible();
  // the preview pane narrows the page: rows fold onto two lines instead of scrolling sideways
  expect(await page.evaluate(() => { const v = document.getElementById('pageView'); return v.scrollWidth <= v.clientWidth + 1; })).toBe(true);
  await inBothThemes('3-preview');
  // the preview header gets the same two actions
  const pvCopy = page.locator('#pvHead').getByRole('button', { name: '复制路径' });
  await pvCopy.click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(path.join(out, 'docs', 'login-flow.md'));
  await expect(page.locator('#pvHead').getByRole('button', { name: revealLabel })).toBeVisible();
  await page.evaluate(() => SidePane.hide());

  const tools = flow.locator('.dl-actions button');
  await expect(tools).toHaveCount(3);
  for (const [i, label] of ['复制路径', revealLabel, '跳到交付它的会话'].entries()) {
    const b = tools.nth(i);
    await expect(b).toHaveAttribute('aria-label', label);
    await expect(b).toHaveAttribute('title', label);
    await expect(b.locator('svg')).toHaveCount(1);
    expect((await b.textContent()).trim(), 'icon only, no text label').toBe('');
    const box = await b.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(28);
  }
  // copy: the real button, the test profile's private clipboard, then a check mark for a moment
  await page.evaluate(() => window.deck.clipboardWrite('before'));
  const copy = tools.nth(0);
  const copyIcon = await copy.innerHTML();
  await copy.click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(path.join(out, 'docs', 'login-flow.md'));
  await expect(copy).toHaveClass(/done/);
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  expect(await copy.innerHTML()).not.toBe(copyIcon);
  await expect(copy).not.toHaveClass(/done/, { timeout: 4000 });
  await expect(copy).toHaveAttribute('aria-label', '复制路径');
  // keyboard: Tab walks row -> copy -> reveal -> jump with a visible ring, Enter presses
  await flow.locator('.dl-main').focus();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  expect(await copy.evaluate((b) => b.matches(':focus-visible') && getComputedStyle(b).outlineStyle !== 'none')).toBe(true);
  await page.evaluate(() => window.deck.clipboardWrite('before'));
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(path.join(out, 'docs', 'login-flow.md'));
  await page.keyboard.press('Tab');
  await expect(tools.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => application.evaluate(() => global.revealed.at(-1))).toBe(path.join(out, 'docs', 'login-flow.md'));
  // the row itself opens with Enter too
  await flow.locator('.dl-main').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sidePane')).toBeVisible();
  await page.evaluate(() => SidePane.hide());

  // jump goes to the session that delivered it
  await tools.nth(2).click();
  await expect(page.locator('#pageView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('w-login');
});

test('project groups fold, and stay folded', async () => {
  await openArtifacts();
  const head = group('客户门户').locator('.dl-head');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(group('客户门户').locator('.dl-rows')).toBeHidden();
  await expect(group('报表服务').locator('.dl-rows')).toBeVisible();
  // the count and the missing-file note stay readable on a folded project
  await expect(group('客户门户').locator('.dl-count')).toHaveText('4');
  await expect(group('客户门户').locator('.dl-lost')).toBeVisible();
  expect(await page.evaluate(() => config.artifactsCollapsed)).toEqual(['客户门户']);
  await screenshot('4-folded-dark');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pageView')).toBeHidden();
  await openArtifacts();
  await expect(group('客户门户').locator('.dl-head')).toHaveAttribute('aria-expanded', 'false');
  await group('客户门户').locator('.dl-head').focus();
  await page.keyboard.press('Enter');
  await expect(group('客户门户').locator('.dl-rows')).toBeVisible();
  expect(await page.evaluate(() => config.artifactsCollapsed)).toEqual([]);
});

test('a receipt submitted now shows up by itself, Windows and Mac paths alike', async () => {
  await openArtifacts();
  await expect.poll(() => fs.existsSync(path.join(receiptDir, 'w-ui.json'))).toBe(true);
  await page.evaluate(() => MainSession.handle({ action: 'main-tell', to: 'w-ui', message: '把工作台规格写出来' }, MainSession.mainCol()));
  await expect.poll(() => page.evaluate(() => config.mainSession.tasks.at(-1).status), { timeout: 30000 }).toBe('working');
  const spec = path.join(out, 'docs', 'dashboard spec.md');
  fs.writeFileSync(spec, '# 工作台规格\n');
  const env = { ...JSON.parse(fs.readFileSync(path.join(receiptDir, 'w-ui.json'), 'utf8')), AGENTDECK_CONTROL_TOKEN: '' };
  const done = await cli(['complete', '--result', '工作台规格写好了。', '--files', [spec, path.join(out, 'docs', 'login-flow.md'), FOREIGN_AGAIN].join(',')], env);
  expect(done.stderr).toBe('');
  expect(done.code).toBe(0);
  // no click, no reload: the open page picks it up, newest first, in the session's project
  await expect(row('dashboard spec.md')).toBeVisible();
  expect((await names('客户门户')).slice(0, 2).sort()).toEqual(['dashboard spec.md', 'login-flow.md']);
  await expect(row('login-flow.md')).toHaveCount(1);
  await expect(row('login-flow.md').locator('.dl-session')).toHaveText('工作台界面');
  await expect(row('dashboard spec.md').locator('.dl-time')).toHaveText(/^今天 /);
  // the same foreign path in another spelling is still one file, now under the newer receipt
  const foreignRows = page.locator('.dl-row .dl-flag', { hasText: '另一台电脑上的路径' });
  await expect(foreignRows).toHaveCount(1);
  expect(await names('报表服务')).toHaveLength(3);
  await expect(page.locator('.art-tab.active')).toHaveText(/回执交付\s*12/);
  await row('dashboard spec.md').locator('.dl-main').click();
  await expect(page.locator('#pvBody .pv-md h1')).toHaveText('工作台规格');
  await page.evaluate(() => SidePane.hide());
  await inBothThemes('1-files');
});

test('files and links mentioned in replies are still collected, with the same icon actions', async () => {
  await openArtifacts();
  await page.locator('.art-tab[data-tab="mentioned"]').click();
  await expect(page.locator('.art-tab.active')).toHaveText(/回复里提到的/);
  const file = page.locator('.art-card', { hasText: 'cleanup.sh' }).first();
  const link = page.locator('.art-card[data-kind="url"]', { hasText: 'example.com' });
  await expect(file).toBeVisible();
  await expect(link).toBeVisible();
  await expect(file.locator('.art-session')).toHaveText('临时脚本');
  // the receipt cards in 队长's conversation keep feeding this tab as before
  await expect(page.locator('.art-card', { hasText: 'release-checklist.md' })).toBeVisible();
  await expect(file.locator('.art-tools button')).toHaveCount(2);
  await expect(link.locator('.art-tools button')).toHaveCount(1);
  await link.getByRole('button', { name: '复制网址' }).click();
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe('https://example.com/docs/cleanup');
  await expect(page.locator('#sidePane')).toBeHidden();
  await file.getByRole('button', { name: revealLabel }).click();
  await expect.poll(() => application.evaluate(() => global.revealed.at(-1))).toBe(path.join(out, 'scratch', 'cleanup.sh'));
  // filters and the search box work as before
  await page.locator('.seg-btn', { hasText: '网页' }).click();
  await expect(page.locator('.art-card')).toHaveCount(1);
  await page.locator('.seg-btn', { hasText: '全部' }).click();
  await page.locator('.art-search').fill('cleanup.sh');
  await expect(page.locator('.art-card[data-kind="url"]')).toHaveCount(0);
  await page.locator('.art-search').fill('');
  await inBothThemes('5-mentioned');
  await page.locator('.art-card', { hasText: 'cleanup.sh' }).first().click();
  await expect(page.locator('#pvBody')).toContainText('echo done');
  await page.evaluate(() => SidePane.hide());
  // arrow keys move between the two tabs
  await page.locator('.art-tab.active').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.art-tab.active')).toHaveText(/回执交付/);
  await expect(page.locator('.art-tab.active')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('show locates a folder, an app bundle and a command file instead of opening them', async () => {
  const dir = path.join(out, 'locate-me');
  const app = path.join(out, 'LocateMe.app');
  const command = path.join(out, 'run.command');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'LocateMe'), '#!/bin/sh\necho launched\n');
  fs.writeFileSync(command, '#!/bin/sh\necho launched\n');
  await openArtifacts();
  await page.evaluate(({ dir, app, command }) => {
    const col = columns.find((c) => c.id === 'w-misc');
    col.lastReceipt = { summary: '只定位，不打开。', files: [dir, app, command], explicit: true, source: 'command', ts: Date.now() };
    Pages.refresh();
  }, { dir, app, command });
  await application.evaluate(() => { global.revealOps = []; });
  for (const [name, target] of [['locate-me', dir], ['LocateMe.app', app], ['run.command', command]]) {
    await row(name).getByRole('button', { name: revealLabel }).click();
    await expect.poll(() => application.evaluate(() => global.revealOps.at(-1))).toEqual({ op: 'show', p: target });
  }
  expect(await application.evaluate(() => global.revealOps.some((x) => x.op === 'open'))).toBe(false);
});

test('with no receipts the page says so and opens on the replies tab', async () => {
  await closeElectron(application);
  application = null;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-artifacts-empty-'));
  try {
    fs.writeFileSync(path.join(empty, 'config.json'), JSON.stringify({ theme: 'dark', fitWindow: true, fitCols: 3,
      columns: [{ id: 'solo', title: '新对话', cmd: FAKE, cwd: empty, width: 460, role: 'manual' }] }));
    await launch(empty);
    await openArtifacts();
    await expect(page.locator('.art-tab.active')).toHaveText(/回复里提到的\s*0/);
    await expect(page.locator('.page-empty strong')).toHaveText('还没有产物');
    // the first receipt arrives while the replies tab is being read: counted, but the tab stays put
    const late = path.join(empty, 'late.md');
    fs.writeFileSync(late, '# late\n');
    await page.evaluate((file) => { columns[0].lastReceipt = { summary: '刚交付', files: [file], explicit: true, source: 'command', ts: Date.now() }; Pages.refresh(); }, late);
    await expect(page.locator('.art-tab[data-tab="delivered"]')).toHaveText(/回执交付\s*1/);
    await expect(page.locator('.art-tab.active')).toHaveText(/回复里提到的/);
    // the next visit opens on the deliveries
    await page.locator('.page-close').click();
    await expect(page.locator('#pageView')).toBeHidden();
    await openArtifacts();
    await expect(page.locator('.art-tab.active')).toHaveText(/回执交付\s*1/);
    await expect(row('late.md').locator('.dl-session')).toHaveText('新对话');
    await expect(page.locator('.dl-project')).toHaveText(['未分组']);
    await page.evaluate(() => { columns[0].lastReceipt = null; });
    await page.locator('.page-close').click();
    await expect(page.locator('#pageView')).toBeHidden();
    await openArtifacts();
    await expect(page.locator('.art-tab.active')).toHaveText(/回复里提到的\s*0/);
    await page.locator('.art-tab[data-tab="delivered"]').click();
    await expect(page.locator('.art-tab.active')).toHaveText(/回执交付\s*0/);
    await expect(page.locator('.page-empty strong')).toHaveText('还没有交付的文件');
    await expect(page.locator('.dl-group')).toHaveCount(0);
    await inBothThemes('6-empty');
  } finally {
    await closeElectron(application);
    application = null;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
