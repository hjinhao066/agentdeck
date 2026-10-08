const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

// 待我处理 on the desktop: 队长 files items with the real board CLI from its own
// terminal; a card waiting in 需要你 is never filed by itself (the item 1.9 filed
// for it is taken away and 队长 told); the user reads, answers with one tap or in
// words, ticks, and things settle on their own. Two columns: 要你处理 (counted on
// the sidebar) and 做完了你还没看 (a dot); a report 队长 said in a reply the user
// saw is already read. Isolated profile, stand-in shell Captain, the profile's
// own task store.
let application, page, profile;
const problems = [];
const CLI = process.platform === 'win32' ? '$env:AGENTDECK_BOARD_CLI' : '$AGENTDECK_BOARD_CLI';
const screen = () => page.evaluate(() => dumpScreen(terms.get('captain').term).replace(/\n/g, ''));
const run = (command) => page.evaluate((c) => window.deck.ptyInput('captain', c + '\r'), command);
const items = () => page.evaluate(() => (config.attention && config.attention.items || []).map((i) => ({ id: i.id, kind: i.kind, title: i.title, done: i.done, doneBy: i.doneBy, doneNote: i.doneNote, readAt: i.readAt, source: i.source, card: i.card, turn: i.turn })));
const pending = () => page.evaluate(() => MainSession.state().pending.map((p) => ({ title: p.title, summary: p.summary })));
const card = (title) => page.locator('.at-card', { hasText: title });
const RECEIPT = '验收完成，判定【通过】。会话回执逐项核实均属实：登录一年有效已生效';
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
    depends_on: [], assignee: null, session_id: null, latest_receipt: RECEIPT, needs_user_entry: now,
    verify: false, rework_count: 0, created: now, updated: now, archived: false }] }));
  // What 1.9 had filed for that card by itself: the card's last receipt as 要你做.
  const legacy = { id: 'at-legacy-ask1', kind: 'need', type: 'question', title: '「网页端登录改成一次长期有效」停下来等你回答', ask: RECEIPT, project: 'agentdeck',
    card: 't-ask', cardTitle: '网页端登录改成一次长期有效', source: 'card', key: `needs:t-ask:${now}`, created: Date.now() - 60000, updated: Date.now() - 60000 };
  fs.writeFileSync(path.join(profile, 'facts.md'), '# 取证\n');
  // No seat rotation: the stand-in shell Captain must stay the same column for the whole file.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
    mainSession: { colId: 'captain', cmd: '', crewMarked: true }, theme: 'dark',
    columns: [{ id: 'captain', title: '队长', isMain: true, cmd: '', cwd: profile }],
    attention: { version: 1, items: [legacy] },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => problems.push(String(error)));
  await expect(page.locator('.xterm')).toHaveCount(1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => t.alive).length)).toBe(1);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  expect(problems).toEqual([]);
});

test('a card in 需要你 goes to 队长, not to the user; 队长 files plain questions and reports from its terminal; the sidebar counts them', async () => {
  // The item 1.9 filed for the card is read back from config.json (only a restored store can name it),
  // taken away, nothing new is filed for the card, and 队长 hears which card it was.
  await expect.poll(async () => (await pending()).some((p) => p.title === '待我处理' && p.summary.includes('不再由程序自动登记停下来的卡片') && p.summary.includes('卡片 t-ask「网页端登录改成一次长期有效」')), { timeout: 20000 }).toBe(true);
  expect(await items()).toEqual([]);
  expect(await page.evaluate(() => [config.attention.version, 'toCaptain' in config.attention])).toEqual([3, false]);
  const row = page.locator('#attentionBtn');
  await expect(row.locator('.nav-row-badge')).toBeHidden();
  await expect(row.locator('.nav-row-dot')).toBeHidden();
  await page.evaluate(() => AttentionUI.refresh());
  expect(await items()).toEqual([]);

  // The user is away from the 队长 conversation (another page in front): what 队长 reports now waits in 没看.
  await page.evaluate(() => Pages.show('schedule'));
  // 队长 judges the user is needed and asks one plain question with answers to pick from.
  await run(`node "${CLI}" inbox need --type decide --card t-ask --title "登录改成一次长期有效已经通过验收，旧设备怎么处理要你定" --ask "已经登录的旧设备要不要一起踢下线？" --options "一起踢下线|保留旧设备" --detail "${RECEIPT}"`);
  await expect.poll(screen, { timeout: 20000 }).toMatch(/已登记到「待我处理」：at-[a-z0-9-]+，要用户处理（等你拍板）/);
  await run(`node "${CLI}" inbox need --title "只有选项" --options "好|不好"`);
  await expect.poll(screen).toContain('--options requires --ask');
  await expect(row.locator('.nav-row-badge')).toHaveText('1');

  await run(`node "${CLI}" inbox need --type decide --title "网页端登录改成「1」能做，但谁都能控制两台电脑" --ask "回复「仍要 1」，或者「改成登录一次长期有效」" --project agentdeck --detail "取证结论：网页端在公网上，登录后能给队长发指令。设成 1 等于谁猜一次就能操控两台电脑。" --files "${path.join(profile, 'facts.md')}"`);
  await expect.poll(screen, { timeout: 20000 }).toMatch(/已登记到「待我处理」：at-[a-z0-9-]+，要用户处理（等你拍板）/);
  await run(`node "${CLI}" inbox report --title "小福助手排查报告回来了：结论是完全正常，但这个结论我还不认，已让它补查两件" --project 小福助手 --detail "补查一：用真实 Excel 走一遍上传、识别、写入。补查二：识别失败时有没有提示。"`);
  await run(`node "${CLI}" inbox report --title "「登录改成 1」的会话卡在确认窗口，我已替它点了「是」" --project agentdeck`);
  await run(`node "${CLI}" notify-user --message "小红书要你在 Mac 的 Chrome 里登录一次。登录后抓取会自己接着跑。"`);
  await expect.poll(async () => (await items()).length, { timeout: 20000 }).toBe(5);
  const all = await items();
  expect(all.find((i) => i.source === 'notify')).toMatchObject({ kind: 'need', title: '小红书要你在 Mac 的 Chrome 里登录一次。' });
  // 3 need the user: the number. 2 reports not seen yet: a dot of their own, not added to the number.
  await expect(row.locator('.nav-row-badge')).toHaveText('3');
  await expect(row.locator('.nav-row-dot')).toBeVisible();
  await expect(row).toHaveAttribute('title', '待我处理：3 件要你处理，2 条汇报你还没看');

  // A worker's own terminal cannot file anything; bad input is refused with a reason.
  await run(`node "${CLI}" inbox need --title "${'很'.repeat(301)}"`);
  await expect.poll(screen).toContain('最多 300 字');
  await run(`node "${CLI}" inbox list`);
  await expect.poll(screen).toContain('待我处理：3 件要用户处理，2 条结果汇报用户还没看。');
});

test('the page: two columns, 要你处理 beside 做完了你还没看, details in place; icons with names; reading clears the dot', async () => {
  await page.locator('#attentionBtn').click();
  await expect(page.locator('.page-titles h1')).toHaveText('待我处理');
  await expect(page.locator('.page-titles p')).toHaveText('要你处理的事回复或办完才打勾；队长的汇报你在这里或队长对话里看过，就归到已读。');
  // Side by side at this width, each column with its own heading.
  const [needBox, reportBox] = await page.locator('.at-col').evaluateAll((all) => all.map((c) => c.getBoundingClientRect().toJSON()));
  expect(reportBox.left).toBeGreaterThan(needBox.right);
  expect(Math.abs(reportBox.top - needBox.top)).toBeLessThan(2);
  await expect(page.getByRole('region', { name: /要你处理/ })).toBeVisible();
  await expect(page.getByRole('region', { name: /做完了你还没看/ })).toBeVisible();
  // 回复 is the main action: accent text, unlike 已处理 beside it.
  const colors = await card('小红书要你').locator('.at-actions .btn').evaluateAll((all) => all.map((b) => getComputedStyle(b).color));
  const accent = await page.evaluate(() => { const s = document.createElement('span'); s.style.color = 'var(--accent)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; });
  expect(colors[0]).toBe(accent);
  expect(colors[1]).not.toBe(accent);
  await expect(page.locator('.at-section h2')).toHaveText(['要你处理3', '做完了你还没看2']);
  await expect(page.locator('.at-card .at-title')).toHaveText([/小红书要你/, /网页端登录改成「1」/, /旧设备怎么处理/, /「登录改成 1」的会话/, /小福助手排查报告/]);
  // The question is the biggest thing on the card, its answers right under it; the receipt stays folded in the details.
  const asked = card('旧设备怎么处理');
  await expect(asked.getByRole('group', { name: '等你拍板：已经登录的旧设备要不要一起踢下线？' })).toBeVisible();
  await expect(asked.locator('.at-ask-text')).toHaveText('已经登录的旧设备要不要一起踢下线？');
  await expect(asked.locator('.at-quick .btn')).toHaveText(['一起踢下线', '保留旧设备']);
  await expect(asked.getByRole('button', { name: '写别的回复' })).toBeVisible();
  await expect(asked).not.toContainText('验收完成');
  await expect(asked.locator('.at-meta')).not.toContainText('来自任务看板');
  const [askSize, titleSize] = await asked.evaluate((el) => ['.at-ask-text', '.at-title'].map((s) => parseFloat(getComputedStyle(el.querySelector(s)).fontSize)));
  expect(askSize).toBeGreaterThan(titleSize);
  await asked.getByRole('button', { name: /细节与证据/ }).click();
  await expect(asked.locator('.at-text')).toHaveText(RECEIPT);
  await asked.getByRole('button', { name: '收起细节' }).click();
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

  // Each item must actually stay on screen: jumping to the bottom can skip one.
  for (const unread of (await items()).filter((i) => !i.readAt)) {
    await page.locator(`.at-card[data-id="${unread.id}"]`).scrollIntoViewIfNeeded();
    await expect.poll(async () => (await items()).find((i) => i.id === unread.id).readAt, { timeout: 15000 }).toBeGreaterThan(0);
  }
  // Reading never ticks what needs the user; a report read here goes to 已读 (seen) but keeps
  // its place and its reply while the page stays open.
  await expect(page.locator('#attentionBtn .nav-row-badge')).toHaveText('3');
  await expect(page.locator('#attentionBtn .nav-row-dot')).toBeHidden();
  expect((await items()).filter((i) => i.kind === 'report').map((i) => [i.done, i.doneBy])).toEqual([[true, 'seen'], [true, 'seen']]);
  expect((await items()).filter((i) => i.kind === 'need').every((i) => !i.done)).toBe(true);
  const kept = page.locator('.at-sec-report .at-card.seen');
  await expect(kept).toHaveCount(2);
  await expect(kept.first().locator('.at-seen')).toHaveText('已读');
  await expect(kept.first().getByRole('button', { name: '回复', exact: true })).toBeVisible();
  await expect(kept.first().getByRole('button', { name: '知道了' })).toHaveCount(0);
});

test('redrawing captures keyboard focus and reading position before the page is cleared', async () => {
  const position = await page.evaluate(() => {
    const scroller = document.getElementById('pageView');
    const button = scroller.querySelector('[data-fk^="copy:"]');
    button.focus({ preventScroll: true });
    scroller.scrollTop = 100;
    const before = { top: scroller.scrollTop, focus: document.activeElement.dataset.fk };
    Pages.render();
    return { before, after: { top: scroller.scrollTop, focus: document.activeElement.dataset.fk } };
  });
  expect(position.before.top).toBeGreaterThan(0);
  expect(position.before.focus).toMatch(/^copy:/);
  expect(position.after).toEqual(position.before);
});

test('a reply goes to 队长 with the item and ticks it; 已处理 tells 队长; a quick answer goes with its choices', async () => {
  await card('网页端登录改成「1」').getByRole('button', { name: '回复', exact: true }).click();
  const box = card('网页端登录改成「1」').getByRole('textbox');
  await expect(box).toBeFocused();
  await box.fill('改成登录一次长期有效，别设成 1');
  // An unrelated refresh must leave an unsent draft and its focus intact.
  await page.evaluate(() => {
    const report = config.attention.items.find((i) => i.kind === 'report' && i.title.startsWith('「登录改成 1」'));
    AttentionUI.reopen(report.id);
    AttentionUI.tick(report.id);
  });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('改成登录一次长期有效，别设成 1');
  await shot('desktop-3-reply-dark');
  await box.press('Enter');
  await expect.poll(async () => (await items()).find((i) => i.title.startsWith('网页端登录改成「1」')).doneBy).toBe('reply');
  const told = (await pending()).find((p) => p.title === '待我处理' && p.summary.includes('用户的回复：'));
  expect(told.summary).toMatch(/用户在「待我处理」回复了一条要用户处理的事（等你拍板）（条目 at-[a-z0-9-]+，项目：agentdeck/);
  expect(told.summary).toContain('原条目：网页端登录改成「1」能做，但谁都能控制两台电脑');
  expect(told.summary).toContain('当时请用户做的：回复「仍要 1」，或者「改成登录一次长期有效」');
  expect(told.summary).toContain('用户的回复：改成登录一次长期有效，别设成 1');
  await expect(page.locator('.at-section h2').first()).toHaveText('要你处理2');
  await expect(page.locator('.at-done-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(card('网页端登录改成「1」')).toHaveCount(0);
  await page.locator('.at-done-toggle').click();
  await expect(card('网页端登录改成「1」')).toHaveClass(/\bdone\b/);
  await expect(card('网页端登录改成「1」').locator('.at-check svg')).toHaveCount(1);
  await expect(card('网页端登录改成「1」').locator('.at-done-text')).toHaveText('你已回复：改成登录一次长期有效，别设成 1');
  await page.locator('.at-done-toggle').click();

  await card('小红书要你').getByRole('button', { name: '已处理' }).click();
  await expect.poll(async () => (await pending()).some((p) => p.summary.includes('标为已处理') && p.summary.includes('小红书要你'))).toBe(true);

  // One tap on a quick answer: it reaches 队长 with the question and the choices, and the item is ticked.
  await card('旧设备怎么处理').getByRole('button', { name: '一起踢下线', exact: true }).click();
  await expect.poll(async () => (await pending()).some((p) => p.summary.includes('当时请用户做的：已经登录的旧设备要不要一起踢下线？\n当时给的选项：一起踢下线 / 保留旧设备\n用户的回复：一起踢下线'))).toBe(true);
  expect((await items()).find((i) => i.title.includes('旧设备怎么处理'))).toMatchObject({ done: true, doneBy: 'reply' });
  // The column stays, saying it is empty.
  await expect(page.locator('.at-col.at-sec-need .at-col-empty')).toHaveText('没有要你处理的事。');
  await expect(page.locator('#attentionBtn .nav-row-badge')).toBeHidden();
});

test('a report reply carries its context too and ticks only that item into folded 已完成', async () => {
  // Read on this visit, it still takes a reply.
  const report = card('小福助手排查报告');
  await expect(report).toHaveClass(/\bseen\b/);
  await report.getByRole('button', { name: '回复', exact: true }).click();
  await report.getByRole('textbox').fill('补查两件后再汇报');
  await report.getByRole('textbox').press('Enter');
  // Nothing is left open in either column: the page says so once, not twice.
  await expect(page.locator('.at-empty strong')).toHaveText('都处理完了');
  await expect(page.locator('.at-col')).toHaveCount(0);
  await expect(report).toHaveCount(0);
  await expect(page.locator('.at-done-toggle')).toHaveAttribute('aria-expanded', 'false');
  const told = (await pending()).find((p) => p.summary.includes('用户的回复：补查两件后再汇报'));
  expect(told.summary).toContain('回复了一条结果汇报');
  expect(told.summary).toContain('原条目：小福助手排查报告回来了：结论是完全正常，但这个结论我还不认，已让它补查两件');
  await page.locator('.at-done-toggle').click();
  await expect(report).toHaveClass(/\bdone\b/);
  await expect(report.locator('.at-check svg')).toHaveCount(1);
  await expect(report.locator('.at-done-text')).toHaveText('你已回复：补查两件后再汇报');
  // Put back, a report is not seen any more: it returns to 没看 (and is read again where it stands).
  await report.getByRole('button', { name: '放回没看' }).click();
  await expect(page.locator('.at-sec-report').getByText('小福助手排查报告回来了')).toBeVisible();
  await expect.poll(async () => (await items()).find((i) => i.title.startsWith('小福助手')).doneBy, { timeout: 15000 }).toBe('seen');
  await page.locator('.at-done-toggle').click();
});

test('队长 resolves, a finished card ticks its item, 已完成 is folded and an item can be put back', async () => {
  await run(`node "${CLI}" inbox need --title "发版时间要你确认"`);
  await expect.poll(async () => (await items()).some((i) => i.title === '发版时间要你确认'), { timeout: 20000 }).toBe(true);
  const asked = (await items()).find((i) => i.title === '发版时间要你确认');
  await run(`node "${CLI}" inbox resolve --id ${asked.id} --note "已经确认生效"`);
  await expect.poll(async () => (await items()).find((i) => i.id === asked.id).doneBy).toBe('captain');
  // A need about a card ticks itself when the card is done.
  await run(`node "${CLI}" inbox need --title "确认旧设备踢下线后再发版" --card t-ask`);
  await expect.poll(async () => (await items()).filter((i) => i.card === 't-ask' && !i.done).length, { timeout: 20000 }).toBe(1);
  await page.evaluate(() => window.TaskBoard.move('t-ask', 'done'));
  await expect.poll(async () => (await items()).filter((i) => i.card === 't-ask' && !i.done).length).toBe(0);
  expect((await items()).find((i) => i.title === '确认旧设备踢下线后再发版')).toMatchObject({ doneBy: 'card', doneNote: '对应任务已完成' });

  const toggle = page.locator('.at-done-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(card('发版时间要你确认').locator('.at-done-text')).toHaveText('队长标记已解决：已经确认生效');
  await expect(card('「登录改成 1」').locator('.at-done-text')).toHaveText('你看过了');
  await expect(card('网页端登录改成「1」').locator('.at-done-text')).toHaveText('你已回复：改成登录一次长期有效，别设成 1');
  // A finished plain 要你处理 drops its label; a typed one keeps it.
  await expect(card('确认旧设备踢下线后再发版').locator('.at-kind')).toHaveCount(0);
  await expect(card('网页端登录改成「1」').locator('.at-kind')).toHaveText('等你拍板');
  await shot('desktop-4-done-dark');

  await page.evaluate(() => applyTheme('light'));
  await page.evaluate(() => Pages.render());
  // Let the theme's colour transitions settle so the shot is not taken halfway.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await shot('desktop-5-light');
});

test('a report 队长 said in a reply the user saw is read; one filed while the user was away waits in 没看', async () => {
  // Back to the deck: the 队长 conversation is in front, in the chat view.
  await page.evaluate(() => { Pages.hide(); if (!ChatUI.isChatMode('captain')) ChatUI.setMode('captain', 'chat'); });
  const box = page.locator('.column[data-col-id="captain"] .composer textarea');
  await box.fill(`node "${CLI}" inbox report --title "迁移预检通过了，队长在对话里说过"`);
  await box.press('Enter');
  await expect.poll(async () => (await items()).find((i) => i.title === '迁移预检通过了，队长在对话里说过'), { timeout: 20000 }).toBeTruthy();
  const said = (await items()).find((i) => i.title === '迁移预检通过了，队长在对话里说过');
  // Filed with the 队长 turn under way; that reply on screen for a moment reads it.
  expect(said.turn).toBe(await page.evaluate(() => terms.get('captain').captainTurnId));
  await expect.poll(async () => (await items()).find((i) => i.id === said.id).doneBy, { timeout: 30000 }).toBe('chat');
  await expect(page.locator('#attentionBtn .nav-row-dot')).toBeHidden();

  // Away from the conversation (another page in front): the next report waits in 没看, a dot, not a number.
  await page.evaluate(() => Pages.show('schedule'));
  await run(`node "${CLI}" inbox report --title "夜里跑完的回归：全部通过"`);
  await expect.poll(async () => (await items()).find((i) => i.title === '夜里跑完的回归：全部通过'), { timeout: 20000 }).toBeTruthy();
  await page.waitForTimeout(2500);
  const away = (await items()).find((i) => i.title === '夜里跑完的回归：全部通过');
  expect(away.done).toBe(false);
  const row = page.locator('#attentionBtn');
  await expect(row.locator('.nav-row-dot')).toBeVisible();
  await expect(row.locator('.nav-row-badge')).toBeHidden();
  await expect(row).toHaveAttribute('title', '待我处理：没有要你处理的事，1 条汇报你还没看');

  // Opened here and looked at, it is read too; it keeps its place until the page is left.
  await row.click();
  const waiting = page.locator('.at-sec-report .at-card', { hasText: '夜里跑完的回归' });
  await expect(waiting).toHaveClass(/\bunread\b/);
  await shot('desktop-6-unseen-dark');
  await expect.poll(async () => (await items()).find((i) => i.id === away.id).doneBy, { timeout: 15000 }).toBe('seen');
  await expect(waiting).toHaveClass(/\bseen\b/);
  await expect(row.locator('.nav-row-dot')).toBeHidden();
  await page.evaluate(() => Pages.hide());
  await row.click();
  // Left and opened again, it is in 已读: nothing is open any more.
  await expect(page.locator('.at-empty strong')).toHaveText('都处理完了');
  await expect(page.locator('.at-card:not(.done)')).toHaveCount(0);
  if (await page.locator('.at-done-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.at-done-toggle').click();
  await expect(card('迁移预检通过了').locator('.at-done-text')).toHaveText('你在队长对话里看过了');
  await expect(card('夜里跑完的回归').locator('.at-done-text')).toHaveText('你看过了');
});
