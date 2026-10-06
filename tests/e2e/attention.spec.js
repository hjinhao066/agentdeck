const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 待我处理 on the desktop: 队长 files items with the real board CLI from its own
// terminal, the board's 需要你 card shows up by itself, the user reads, replies
// and ticks, and things settle on their own. Isolated profile, stand-in shell
// Captain, the profile's own task store.
let application, page, profile;
const CLI = process.platform === 'win32' ? '$env:AGENTDECK_BOARD_CLI' : '$AGENTDECK_BOARD_CLI';
const screen = () => page.evaluate(() => dumpScreen(terms.get('captain').term).replace(/\n/g, ''));
const run = (command) => page.evaluate((c) => window.deck.ptyInput('captain', c + '\r'), command);
const items = () => page.evaluate(() => (config.attention && config.attention.items || []).map((i) => ({ id: i.id, kind: i.kind, title: i.title, done: i.done, doneBy: i.doneBy, doneNote: i.doneNote, readAt: i.readAt, source: i.source, card: i.card })));
const pending = () => page.evaluate(() => MainSession.state().pending.map((p) => ({ title: p.title, summary: p.summary })));
const card = (title) => page.locator('.at-card', { hasText: title });
async function shot(name) {
  const dir = process.env.AGENTDECK_ATTENTION_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-attention-'));
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(profile, 'tasks'));
  fs.writeFileSync(path.join(profile, 'tasks', 'agentdeck.json'), JSON.stringify({ version: 1, project: 'agentdeck', cards: [{
    id: 't-ask', project: 'agentdeck', title: '网页端登录改成一次长期有效', detail: '登录一次记住一年，手机和两台电脑都一样。', status: 'needs_user', flag: null, order: 1,
    depends_on: [], assignee: null, session_id: null, latest_receipt: '旧设备要不要一起踢下线？', user_question: '旧设备要不要一起踢下线？', needs_user_entry: now,
    verify: false, rework_count: 0, created: now, updated: now, archived: false }] }));
  fs.writeFileSync(path.join(profile, 'facts.md'), '# 取证\n');
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
  page.on('pageerror', (error) => console.error('pageerror', String(error)));
  await expect(page.locator('.xterm')).toHaveCount(1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(1);
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('队长 files needs and reports from its terminal; the board\'s 需要你 card shows up by itself; the sidebar counts them', async () => {
  // The card waiting on the user is an item without anyone filing it.
  await expect.poll(async () => (await items()).filter((i) => i.source === 'card').map((i) => i.title)).toEqual(['「网页端登录改成一次长期有效」停下来等你回答']);
  const row = page.locator('#attentionBtn');
  await expect(row.locator('.nav-row-badge')).toHaveText('1');

  await run(`node "${CLI}" inbox need --type decide --title "网页端登录改成「1」能做，但谁都能控制两台电脑" --ask "回复「仍要 1」，或者「改成登录一次长期有效」" --project agentdeck --detail "取证结论：网页端在公网上，登录后能给队长发指令。设成 1 等于谁猜一次就能操控两台电脑。" --files "${path.join(profile, 'facts.md')}"`);
  await expect.poll(screen, { timeout: 20000 }).toMatch(/已登记到「待我处理」：at-[a-z0-9-]+，要用户处理（等你拍板）/);
  await run(`node "${CLI}" inbox report --title "小福助手排查报告回来了：结论是完全正常，但这个结论我还不认，已让它补查两件" --project 小福助手 --detail "补查一：用真实 Excel 走一遍上传、识别、写入。补查二：识别失败时有没有提示。"`);
  await run(`node "${CLI}" inbox report --title "「登录改成 1」的会话卡在确认窗口，我已替它点了「是」" --project agentdeck`);
  await run(`node "${CLI}" notify-user --message "小红书要你在 Mac 的 Chrome 里登录一次。登录后抓取会自己接着跑。"`);
  await expect.poll(async () => (await items()).length, { timeout: 20000 }).toBe(5);
  const all = await items();
  expect(all.find((i) => i.source === 'notify')).toMatchObject({ kind: 'need', title: '小红书要你在 Mac 的 Chrome 里登录一次。' });
  // 3 need the user, 2 reports unread.
  await expect(row.locator('.nav-row-badge')).toHaveText('5');
  await expect(row).toHaveAttribute('title', '待我处理：3 件要你处理，2 条新汇报');

  // A worker's own terminal cannot file anything; bad input is refused with a reason.
  await run(`node "${CLI}" inbox need --title "${'很'.repeat(301)}"`);
  await expect.poll(screen).toContain('最多 300 字');
  await run(`node "${CLI}" inbox list`);
  await expect.poll(screen).toContain('待我处理：3 件要用户处理，2 条结果汇报。');
});

test('the page: needs first, then reports, details in place; icons with names; reading clears the dot', async () => {
  await page.locator('#attentionBtn').click();
  await expect(page.locator('.page-titles h1')).toHaveText('待我处理');
  await expect(page.locator('.at-section h2')).toHaveText(['要你处理3', '结果汇报2']);
  await expect(page.locator('.at-card .at-title')).toHaveText([/小红书要你/, /网页端登录改成「1」/, /停下来等你回答/, /「登录改成 1」的会话/, /小福助手排查报告/]);
  await expect(card('停下来等你回答').locator('.at-ask')).toContainText('旧设备要不要一起踢下线？');
  await expect(card('停下来等你回答').locator('.at-meta')).toContainText('来自任务看板');
  await shot('desktop-1-list-dark');

  await card('网页端登录改成「1」').getByRole('button', { name: /细节与证据/ }).click();
  await expect(card('网页端登录改成「1」').locator('.at-text')).toContainText('谁猜一次就能操控两台电脑');
  await expect(card('网页端登录改成「1」').locator('.at-file-name')).toHaveText('facts.md');
  await expect(card('网页端登录改成「1」').getByRole('button', { name: '复制路径' })).toBeVisible();
  await expect(card('网页端登录改成「1」').getByRole('button', { name: process.platform === 'darwin' ? '在访达中显示' : /显示/ })).toBeVisible();
  await shot('desktop-2-details-dark');

  // Every icon button has a tooltip and a name and is big enough to hit.
  const icons = await page.locator('.at-page .at-tool:visible').evaluateAll((all) => all.map((b) => ({ label: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
  expect(icons.length).toBeGreaterThan(5);
  for (const b of icons) { expect(b.label, JSON.stringify(b)).toBeTruthy(); expect(b.title).toBe(b.label); expect(b.text).toBe(''); expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(28); }
  const copy = card('小红书要你').getByRole('button', { name: '复制这一条' });
  await copy.click();
  await expect(card('小红书要你').getByRole('button', { name: '已复制' })).toBeVisible();

  // Everything on screen for a moment counts as read; the badge drops the read reports.
  await page.locator('#pageView').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => (await items()).filter((i) => !i.readAt).length, { timeout: 15000 }).toBe(0);
  await expect(page.locator('#attentionBtn .nav-row-badge')).toHaveText('3');
});

test('a reply goes to 队长 with the item and ticks it; 已处理 tells 队长; the card answer takes the board\'s path', async () => {
  await card('网页端登录改成「1」').getByRole('button', { name: '回复', exact: true }).click();
  const box = card('网页端登录改成「1」').getByRole('textbox');
  await expect(box).toBeFocused();
  await box.fill('改成登录一次长期有效，别设成 1');
  await shot('desktop-3-reply-dark');
  await box.press('Enter');
  await expect.poll(async () => (await items()).find((i) => i.title.startsWith('网页端登录改成「1」')).doneBy).toBe('reply');
  const told = (await pending()).find((p) => p.title === '待我处理' && p.summary.includes('用户的回复：'));
  expect(told.summary).toMatch(/用户在「待我处理」回复了一条要用户处理的事（等你拍板）（条目 at-[a-z0-9-]+，项目：agentdeck/);
  expect(told.summary).toContain('原条目：网页端登录改成「1」能做，但谁都能控制两台电脑');
  expect(told.summary).toContain('当时请用户做的：回复「仍要 1」，或者「改成登录一次长期有效」');
  expect(told.summary).toContain('用户的回复：改成登录一次长期有效，别设成 1');
  await expect(page.locator('.at-section h2').first()).toHaveText('要你处理2');

  await card('小红书要你').getByRole('button', { name: '已处理' }).click();
  await expect.poll(async () => (await pending()).some((p) => p.summary.includes('标为已处理') && p.summary.includes('小红书要你'))).toBe(true);

  // The board's own question: the answer goes the task board's way and the card moves on.
  await card('停下来等你回答').getByRole('button', { name: '回复', exact: true }).click();
  await card('停下来等你回答').getByRole('textbox').fill('一起踢下线');
  await card('停下来等你回答').getByRole('button', { name: '发送给队长' }).click();
  await expect.poll(async () => (await pending()).some((p) => p.summary.includes('用户在任务看板回答了卡片 t-ask') && p.summary.includes('一起踢下线'))).toBe(true);
  await expect(page.locator('.at-sec-need')).toHaveCount(0);
});

test('队长 resolves, a finished card ticks its item, 已完成 is folded and an item can be put back', async () => {
  const report = (await items()).find((i) => i.title.startsWith('「登录改成 1」'));
  await run(`node "${CLI}" inbox resolve --id ${report.id} --note "已经确认生效"`);
  await expect.poll(async () => (await items()).find((i) => i.id === report.id).doneBy).toBe('captain');
  // A need about a card ticks itself when the card is done.
  await run(`node "${CLI}" inbox need --title "确认旧设备踢下线后再发版" --card t-ask`);
  await expect.poll(async () => (await items()).filter((i) => i.card === 't-ask' && !i.done).length, { timeout: 20000 }).toBe(1);
  await page.evaluate(() => window.TaskBoard.move('t-ask', 'done'));
  await expect.poll(async () => (await items()).filter((i) => i.card === 't-ask' && !i.done).length).toBe(0);
  expect((await items()).find((i) => i.title === '确认旧设备踢下线后再发版')).toMatchObject({ doneBy: 'card', doneNote: '对应任务已完成' });

  const toggle = page.locator('.at-done-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(card('「登录改成 1」').locator('.at-done-text')).toHaveText('队长标记已解决：已经确认生效');
  await expect(card('网页端登录改成「1」').locator('.at-done-text')).toHaveText('你已回复：改成登录一次长期有效，别设成 1');
  await shot('desktop-4-done-dark');
  await card('小福助手排查报告').getByRole('button', { name: '知道了' }).click();
  await card('小福助手排查报告').getByRole('button', { name: '放回待处理' }).click();
  await expect(page.locator('.at-sec-report h2')).toHaveText('结果汇报1');

  await page.evaluate(() => applyTheme('light'));
  await page.evaluate(() => Pages.render());
  await shot('desktop-5-light');
});
