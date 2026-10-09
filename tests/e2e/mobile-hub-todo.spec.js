const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// 随手记待办 in the phone hub, against two fake computers behind a Caddy-like
// local proxy. Nothing here touches a real AgentDeck, the VPS or ~/.agents.
// AGENTDECK_HUB_SCREENSHOT_DIR=<dir> saves 390-wide screenshots.
let hub, context, page, problems;

const minutes = (n) => new Date(Date.now() - n * 60000).toISOString();
const todo = (id, text, created, extra = {}) => ({ id: 'td-' + id, text, done: false, doneAt: null, created: minutes(created), updated: minutes(created), ...extra });
// Both computers hold the same list through git, each a little out of date.
function machines({ mac = [], win = [], macTodos = true, winTodos = true } = {}) {
  const base = (id, label, platform, hostname) => ({ id, label, platform, hostname, sessions: [{ id: id + '-captain', title: '队长', model: 'claude-opus', status: 'idle', isMain: true, receipt: '' }], turns: [], cards: [] });
  return [{ ...base('mac', 'Mac', 'darwin', 'Jinhao-MacBook.local'), todos: macTodos ? mac : null }, { ...base('win', 'Windows', 'win32', 'OWENJH'), todos: winTodos ? win : null }];
}
function dozen() {
  const shared = [
    todo('return-parcel-01', '退货包裹放门口', 300), todo('landlord-mail-01', '回复房东的邮件', 240), todo('health-check-01', '体检前把既往检查整理成一页', 200),
    todo('book-buy-00001', '买《置身事内》纸质版', 180), todo('call-mom-00001', '给妈妈打电话', 150), todo('imt540-hw-0001', '周五前交 IMT 540 作业', 120),
    todo('dentist-000001', '预约牙医洗牙', 100), todo('screenshots-01', '整理桌面截图文件夹', 90), todo('subscription-1', '退掉没用的视频会员', 70),
    todo('backup-check-1', '查一下 Mac 备份是不是正常', 50), todo('expense-00001', '下周二前把报销单交了', 30),
  ];
  const doneOnWin = { ...shared[4], done: true, doneAt: minutes(10), updated: minutes(10) };
  return {
    mac: [...shared, todo('mac-only-0001', '下班路上取快递', 5), todo('old-done-0001', '续订域名', 600, { done: true, doneAt: minutes(400), updated: minutes(400) })],
    // Windows ticked 给妈妈打电话 and deleted 整理桌面截图文件夹 after the last sync; it also has one the Mac has not seen.
    win: [...shared.map((t) => t.id === doneOnWin.id ? doneOnWin : t).filter((t) => t.id !== 'td-screenshots-01'),
      { id: 'td-screenshots-01', deleted: true, updated: minutes(8) }, todo('win-only-0001', '把 Hermes 早报里的求职邮件回掉', 20)],
  };
}
async function open(browser, { theme = 'dark', login = ['mac', 'win'], list = machines(), attention = null } = {}) {
  hub = await startHub({ machines: list });
  // 待我处理 as each computer answers api/attention (null: the fakes have none).
  if (attention) for (const [id, items] of Object.entries(attention)) hub.machines[id].attention = items;
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await page.goto(hub.url);
  for (const id of login) {
    const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
    await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
    await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
    await expect(card.locator('.pill')).toHaveText('在线');
  }
}
const nav = (name) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const box = () => page.locator('#todo-text');
const openRows = () => page.locator('.todo-list:not(.todo-list-done) .todo-row');
const rowFor = (text) => page.locator('.todo-row', { hasText: text });
const hint = () => page.locator('#todo-hint');
async function shot(name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main, .todo-list')].every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
  if (!process.env.AGENTDECK_HUB_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_HUB_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

test('record one from the phone: empty state, one line, Enter, saved on the default computer', async ({ browser }) => {
  await open(browser);
  await nav('待办');
  await expect(page.locator('#todo-view')).toBeVisible();
  await expect(page.locator('#machine-bar')).toBeHidden(); // one list for both computers: nothing to pick
  await expect(page.locator('.todo-empty strong')).toHaveText('清单还是空的');
  await expect(page.locator('.todo-empty p')).toHaveText('买东西、回邮件、别忘了的小事——打一句话，点右边的 ＋ 就存好。');
  await expect(page.locator('#todo-add')).toBeDisabled();
  await expect(box()).toBeFocused(); // tapping the tab is for writing one down
  await shot('phone-dark-empty');
  await box().click();
  await box().fill('明早把快递放门口');
  await expect(page.locator('#todo-add')).toBeEnabled();
  await shot('phone-dark-record-typing');
  await box().press('Enter');
  await expect(openRows()).toHaveCount(1);
  await expect(rowFor('明早把快递放门口')).toBeVisible();
  await expect(box()).toHaveValue('');
  await expect(box()).toBeFocused(); // the keyboard stays up for the next one
  await expect(hint()).toHaveText('已记下（存在 Mac）');
  await expect(page.locator('[data-view="todo"] .nav-badge')).toHaveText('1');
  expect(hub.machines.mac.todoWrites).toEqual([{ op: 'add', text: '明早把快递放门口' }]);
  expect(hub.machines.win.todoWrites).toEqual([]);
  await shot('phone-dark-record-saved');
  // The add button is an icon with a name and a big enough target.
  const add = await page.locator('#todo-add').evaluate((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), title: b.title, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, svg: !!b.querySelector('svg') }));
  expect(add).toMatchObject({ text: '', svg: true });
  expect(add.label).toContain('记下这条待办');
  expect(add.w).toBeGreaterThanOrEqual(44); expect(add.h).toBeGreaterThanOrEqual(44);
});

test('the list merges both computers: newest copy wins, deletions stay deleted, newest first', async ({ browser }) => {
  await open(browser, { list: machines(dozen()) });
  await nav('待办');
  await expect(openRows()).toHaveCount(11);
  await expect(openRows().first()).toContainText('下班路上取快递');
  await expect(openRows().nth(1)).toContainText('把 Hermes 早报里的求职邮件回掉'); // only Windows has it yet
  await expect(rowFor('整理桌面截图文件夹')).toHaveCount(0); // deleted on Windows after the Mac copy
  await expect(page.locator('.todo-done-toggle .todo-count')).toHaveText('2'); // 给妈妈打电话 (ticked on Windows) and 续订域名
  await expect(page.locator('#todo-foot')).toHaveText('已合并 Mac 和 Windows 的待办。两台电脑每 30 分钟自动同步一次。');
  await expect(page.locator('[data-view="todo"] .nav-badge')).toHaveText('11');
  // Every row's circle is a named checkbox with a 44px+ target.
  const checks = await page.locator('.todo-check').evaluateAll((list) => list.map((b) => ({ role: b.getAttribute('role'), label: b.getAttribute('aria-label'), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
  for (const c of checks) { expect(c.role).toBe('checkbox'); expect(c.label).toMatch(/^勾掉：/); expect(c.w).toBeGreaterThanOrEqual(44); expect(c.h).toBeGreaterThanOrEqual(44); }
  await shot('phone-dark-list');
  await page.locator('main').evaluate((m) => { m.scrollTop = 400; });
  await expect(page.locator('#todo-form')).toBeInViewport(); // the box stays at hand while scrolling
  await shot('phone-dark-list-scrolled');
});

test('ticking from the phone: the row moves to 已完成, the tick goes to the Mac with a base, and it can be undone', async ({ browser }) => {
  await open(browser, { list: machines(dozen()) });
  await nav('待办');
  await rowFor('预约牙医洗牙').locator('.todo-check').click();
  await expect(openRows()).toHaveCount(10);
  await expect(page.locator('[data-view="todo"] .nav-badge')).toHaveText('10');
  await expect(hint()).toHaveText('已勾掉（记在 Mac）');
  expect(hub.machines.mac.todoWrites[0]).toMatchObject({ op: 'update', id: 'td-dentist-000001', done: true, base: { text: '预约牙医洗牙', done: false } });
  // An item only Windows has seen still goes to the Mac, carried by its base.
  await rowFor('把 Hermes 早报里的求职邮件回掉').locator('.todo-check').click();
  await expect(openRows()).toHaveCount(9);
  expect(hub.machines.mac.todoWrites[1]).toMatchObject({ op: 'update', id: 'td-win-only-0001', done: true, base: { text: '把 Hermes 早报里的求职邮件回掉' } });
  expect(hub.machines.win.todoWrites).toEqual([]);
  await page.locator('.todo-done-toggle').click();
  await expect(page.locator('.todo-done-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.todo-list-done .todo-row')).toHaveCount(4);
  await expect(page.locator('.todo-list-done .todo-row').first()).toContainText('把 Hermes 早报里的求职邮件回掉');
  await page.locator('main').evaluate((m) => { m.scrollTop = m.scrollHeight; });
  await shot('phone-dark-ticked');
  await page.locator('.todo-list-done .todo-row', { hasText: '预约牙医洗牙' }).locator('.todo-check').click();
  await expect(openRows()).toHaveCount(10);
  await expect(hint()).toHaveText('已放回未完成（记在 Mac）');
});

test('light theme at 390 wide: record, list and a tick', async ({ browser }) => {
  await open(browser, { theme: 'light', list: machines(dozen()) });
  await nav('待办');
  await expect(openRows()).toHaveCount(11);
  await box().fill('周日给植物浇水');
  await shot('phone-light-record-typing');
  await box().press('Enter');
  await expect(openRows()).toHaveCount(12);
  await shot('phone-light-list');
  await rowFor('回复房东的邮件').locator('.todo-check').click();
  await expect(openRows()).toHaveCount(11);
  await page.locator('.todo-done-toggle').click();
  await page.locator('main').evaluate((m) => { m.scrollTop = m.scrollHeight; });
  await shot('phone-light-ticked');
});

test('the Mac asleep: the phone records on Windows; both away: the box says why and nothing is sent', async ({ browser }) => {
  await open(browser, { list: machines(dozen()) });
  hub.machines.mac.setMode('down');
  await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Mac', exact: true }).locator('.pill')).toHaveText('离线');
  await nav('待办');
  await box().fill('Mac 睡着时记的');
  await box().press('Enter');
  await expect(hint()).toHaveText('已记下（存在 Windows）');
  expect(hub.machines.win.todoWrites).toEqual([{ op: 'add', text: 'Mac 睡着时记的' }]);
  hub.machines.win.setMode('down');
  await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
  await expect(hint()).toHaveText('两台电脑现在都连不上，等它们上线后再记。');
  await box().fill('不会发出去');
  await expect(page.locator('#todo-add')).toBeDisabled();
  await box().press('Enter');
  await expect(box()).toHaveValue('不会发出去');
  expect(hub.machines.win.todoWrites).toHaveLength(1);
  expect(hub.machines.mac.todoWrites).toHaveLength(0);
});

test('a refused write keeps the text, an older build says it needs an upgrade, and no login means no list', async ({ browser }) => {
  await open(browser, { list: machines(dozen()) });
  await nav('待办');
  hub.machines.mac.todoRefuse = '待办最多 500 个字。';
  await box().fill('这一条会被拒');
  await box().press('Enter');
  await expect(hint()).toHaveText('待办最多 500 个字。');
  await expect(hint()).toHaveClass(/blocked/);
  await expect(box()).toHaveValue('这一条会被拒');
  await context.close(); await hub.close(); context = null; hub = null;

  await open(browser, { list: machines({ macTodos: false, winTodos: false }) });
  await nav('待办');
  await expect(page.locator('#todo-lists .empty')).toHaveText('这台电脑上的 AgentDeck 版本还没有待办，升级后就能在手机上记。');
  await expect(page.locator('#todo-add')).toBeDisabled();
  await context.close(); await hub.close(); context = null; hub = null;

  await open(browser, { login: [], list: machines(dozen()) });
  await nav('待办');
  await expect(page.locator('#todo-lists .empty')).toHaveText('先在「总览」登录一台电脑，才能记待办。');
  await expect(rowFor('退货包裹放门口')).toHaveCount(0);
  expect(hub.machines.mac.requests.filter((r) => r.url === '/mac/api/todos')).toEqual([]);
});

test('the hub opens where it was left, and a #todo link opens 待办 directly', async ({ browser }) => {
  await open(browser, { list: machines(dozen()) });
  await nav('待办');
  await page.reload();
  await expect(page.locator('#todo-view')).toBeVisible();
  await expect(page.locator('nav [data-view="todo"]')).toHaveAttribute('aria-current', 'page');
  await expect(openRows()).toHaveCount(11);
  await nav('总览');
  await page.reload();
  await expect(page.locator('#overview-view')).toBeVisible();
  await page.goto(hub.url + '#todo');
  await page.reload(); // a hash change alone does not reload: open it the way a home-screen link does
  await expect(page.locator('#todo-view')).toBeVisible();
  await expect(page.locator('#brand-title')).toHaveText('待办');
});

// 待办 @ai → 队长 → 待我处理, as the phone sees it. The Mac handed both items to
// AI; its api/todos and api/attention answers are built with the app's own
// functions from the same 待办 data, so the two tabs agree. Windows still has
// an older copy (queued) of one of them: the newer copy wins.
test('a 待办 handed to AI: its state under the item, and the answer on 待我处理 from the Mac only', async ({ browser }) => {
  const A = require('../../attention-core');
  const { phoneView } = require('../../todo-store');
  const ai = (status, extra = {}) => ({ revision: 'r'.repeat(64), taskId: 'todo-' + status[0].repeat(64), ownerDevice: 'dev-mac', status,
    submittedAt: minutes(60), updated: minutes(2), deliveredAt: minutes(59), files: [], message: '', exceptionNotifiedAt: null, ...extra });
  const book = todo('ai-book-00001', '@ai 找一本《置身事内》的 EPUB', 60, { updated: minutes(2), ai: ai('done', { files: ['/Users/jinhao/reports/books/置身事内.epub', '/Users/jinhao/reports/books/summary.md'] }) });
  const ct = todo('ai-ct-000001', '帮我@ai把体检报告整理成一页', 50, { updated: minutes(3), ai: ai('needs_user', { message: '等你提供体检报告 PDF 放在哪个文件夹' }) });
  const train = todo('ai-train-0001', '@ai 查周六去芝加哥的火车', 4, { updated: minutes(4), ai: ai('queued', { deliveredAt: null }) });
  const raw = [book, ct, train, todo('plain-000001', '自己去取快递', 30)];
  const store = A.normalize({});
  A.syncTodos(store, raw, 'dev-mac', Date.now());
  // Windows: the same 待办 a sync behind, and no AI answer on its own 待我处理.
  const winBook = { ...book, updated: minutes(40), ai: ai('queued', { updated: minutes(40) }) };
  await open(browser, { list: machines({ mac: phoneView(raw), win: phoneView([winBook, raw[3]]) }), attention: { mac: A.phoneView(store).items, win: [] } });
  await nav('待办');
  await expect(openRows()).toHaveCount(4);
  await expect(rowFor('置身事内').locator('.todo-ai-chip')).toHaveText('AI 办完了');
  await expect(rowFor('置身事内').locator('.todo-ai-files')).toHaveText('交回 2 个文件：置身事内.epub、summary.md（在「待我处理」打开）');
  await expect(rowFor('体检报告').locator('.todo-ai.is-needs_user')).toContainText('AI 在等你等你提供体检报告 PDF 放在哪个文件夹');
  await expect(rowFor('芝加哥').locator('.todo-ai-chip')).toHaveText('已交给 AI · 等队长接收');
  await expect(rowFor('自己去取快递').locator('.todo-ai')).toHaveCount(0);
  expect(await page.content()).not.toContain('/Users/jinhao/reports'); // names only on the 待办 tab
  await shot('phone-dark-todo-ai');
  if (process.env.AGENTDECK_TODO_AI_SHOTS) {
    fs.mkdirSync(process.env.AGENTDECK_TODO_AI_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AGENTDECK_TODO_AI_SHOTS, 'phone-todo-ai.png') });
  }
  // 待我处理: one question (the badge) and one report, both from the Mac, marked 来自待办.
  const tab = page.getByRole('navigation', { name: '主导航' }).locator('[data-view="attention"]');
  await expect(tab).toHaveAttribute('aria-label', '待我处理，1 件要你处理，1 条汇报你还没看');
  await tab.click();
  const need = page.locator('.at-item', { hasText: 'AI 在等你' });
  await expect(need.locator('.at-ask')).toContainText('等你提供体检报告 PDF 放在哪个文件夹');
  await expect(need.locator('.at-meta')).toContainText('来自待办');
  const report = page.locator('.at-item', { hasText: 'AI 办完了' });
  await expect(report.locator('.at-meta')).toContainText('来自待办');
  if (process.env.AGENTDECK_TODO_AI_SHOTS) await page.screenshot({ path: path.join(process.env.AGENTDECK_TODO_AI_SHOTS, 'phone-attention-ai.png') });
  // The answer goes to the Mac, which hands it to 队长 with the card.
  await need.getByRole('button', { name: '回复', exact: true }).click();
  await need.locator('textarea').fill('在 ~/Documents/体检');
  await need.getByRole('button', { name: '发送给 Mac 队长' }).click();
  await expect.poll(() => hub.machines.mac.attentionWrites.find((w) => w.op === 'reply')).toMatchObject({ op: 'reply', text: '在 ~/Documents/体检' });
  expect(hub.machines.win.attentionWrites.filter((w) => w.op === 'reply')).toEqual([]);
});

// The review's case in the real page, against real stores that answer as this
// build's mobile-web.js does: Windows still holds 「@ai 找第一本书」 queued; the
// Mac changed it to 「@ai 找第二本书」 and 队长 finished it with book.epub. The
// user picked Windows, which has not synced, and ticks it there. The text, the
// AI result and its file stay, on the phone and on both desktops after the sync.
test('a tick through a computer a sync behind keeps the newer text and the finished AI result', async ({ browser }) => {
  const os = require('os');
  const { TodoStore } = require('../../todo-store');
  const { TodoAI, taskId } = require('../../todo-ai');
  const { TaskStore } = require('../../task-board');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-todo-sync-'));
  try {
    const store = (id) => new TodoStore(path.join(root, id, 'todos'), { deviceId: 'dev-' + id });
    const mac = store('mac'), win = store('win');
    const send = (from, to) => { fs.mkdirSync(to.dir, { recursive: true }); fs.copyFileSync(path.join(from.dir, from.deviceId + '.json'), path.join(to.dir, from.deviceId + '.json')); };
    const ai = new TodoAI({ todos: mac, tasks: new TaskStore(path.join(root, 'mac', 'tasks')), deliver() {}, notify: async () => {} });
    const { id } = mac.add({ text: '@ai 找第一本书' });
    ai.scan();
    send(mac, win);
    mac.update({ id, text: '@ai 找第二本书' });
    ai.scan();
    const book = path.join(root, 'book.epub');
    fs.writeFileSync(book, 'x');
    const now = () => mac.list().find((t) => t.id === id);
    await ai.status({ id, taskId: taskId(now()), status: 'working' });
    await ai.status({ id, taskId: taskId(now()), status: 'done', files: [book] });
    const list = machines();
    list[0].todoStore = mac; list[1].todoStore = win;
    await open(browser, { list });
    await page.locator('#machine-bar').getByRole('button', { name: /^Windows/ }).click();
    await nav('待办');
    const row = rowFor('@ai 找第二本书');
    await expect(row.locator('.todo-ai-chip')).toHaveText('AI 办完了');
    await expect(row.locator('.todo-ai-files')).toHaveText('交回 1 个文件：book.epub（在「待我处理」打开）');
    await expect(rowFor('第一本书')).toHaveCount(0);
    await row.locator('.todo-check').click();
    await expect(hint()).toHaveText('已勾掉（记在 Windows）');
    expect(hub.machines.win.todoWrites).toEqual([{ op: 'update', id, done: true,
      base: { text: '@ai 找第二本书', done: false, doneAt: null, created: now().created, updated: now().updated, textUpdated: now().textUpdated } }]);
    expect(hub.machines.mac.todoWrites).toEqual([]);
    await page.locator('.todo-done-toggle').click();
    const ticked = page.locator('.todo-list-done .todo-row', { hasText: '@ai 找第二本书' });
    await expect(ticked.locator('.todo-ai-chip')).toHaveText('AI 办完了');
    await expect(ticked.locator('.todo-ai-files')).toHaveText('交回 1 个文件：book.epub（在「待我处理」打开）');
    // The next poll of both computers says the same.
    await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
    await expect(ticked.locator('.todo-ai-chip')).toHaveText('AI 办完了');
    await expect(openRows()).toHaveCount(0);
    // The desktops after git brings the files across agree with the phone.
    send(mac, win); send(win, mac);
    for (const side of [mac, win]) {
      const seen = side.list().find((t) => t.id === id);
      expect([seen.text, seen.done, seen.ai.status, seen.ai.files]).toEqual(['@ai 找第二本书', true, 'done', [book]]);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
