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
async function open(browser, { theme = 'dark', login = ['mac', 'win'], list = machines() } = {}) {
  hub = await startHub({ machines: list });
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
  await expect(page.locator('#todo-add')).toBeDisabled();
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
  await expect(page.locator('#todo-foot')).toContainText('已合并 Mac 和 Windows 的待办');
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
