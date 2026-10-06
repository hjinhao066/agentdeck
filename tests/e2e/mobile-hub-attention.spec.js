const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub, attentionFixture } = require('../fixtures/hub-proxy');

// 待我处理 on the phone hub, against two fake machines behind the local proxy.
// Nothing here touches a real AgentDeck, the VPS or the shared boards.
let hub, context, page, problems;

async function open(browser, theme = 'dark') {
  hub = await startHub();
  const data = attentionFixture();
  hub.machines.mac.attention = data.mac;
  hub.machines.win.attention = data.win;
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await page.goto(hub.url);
  for (const id of ['mac', 'win']) {
    const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
    await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
    await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
  }
  await expect(page.locator('.machine-card .pill', { hasText: '在线' })).toHaveCount(2);
}
const tab = () => page.getByRole('navigation', { name: '主导航' }).locator('[data-view="attention"]');
const item = (title) => page.locator('.at-item', { hasText: title });
async function shot(name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main, .at-lists, .at-item')].every((el) => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  const dir = process.env.AGENTDECK_ATTENTION_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

test('both computers on one page: what needs you first, then reports; reply, tick and put back go to that computer only', async ({ browser }) => {
  await open(browser);
  // 3 things need the user, 1 report is unread.
  await expect(tab()).toHaveAttribute('aria-label', '待我处理，3 件要你处理，1 条新汇报');
  await expect(tab().locator('.nav-attention')).toHaveText('4');
  await tab().click();
  const lists = page.locator('#attention-lists');
  await expect(lists.locator('.at-section h2')).toHaveText(['要你处理3', '结果汇报2']);
  await expect(lists.locator('.at-item .at-title')).toHaveText([/网页端登录改成「1」/, /小红书要你/, /Muse 冒烟测试/, /小福助手排查报告/, /登录改成 1」的会话/]);
  await expect(item('Muse 冒烟测试').locator('.at-meta')).toContainText('Windows · muse');
  await expect(item('网页端登录改成「1」').locator('.at-ask')).toContainText('要你做回复「仍要 1」');
  await expect(page.locator('#attention-sources')).toContainText('回复只发给那条所在的电脑');
  await shot('phone-1-list-dark');

  // Details and evidence unfold in place.
  await item('网页端登录改成「1」').getByRole('button', { name: /细节与证据/ }).click();
  await expect(item('网页端登录改成「1」').locator('.at-text')).toContainText('任何人猜一次就能操控');
  await expect(item('网页端登录改成「1」').locator('.at-files li')).toHaveText(['/Users/jinhao/reports/agentdeck-login/facts.md']);
  await expect(item('网页端登录改成「1」').locator('.at-links')).toHaveText('任务：网页端登录改成 1');

  // The unread report is marked read on Mac once it has been on screen (it starts below the fold).
  expect(hub.machines.mac.attentionWrites.filter((w) => w.op === 'read').flatMap((w) => w.ids)).not.toContain('at-m3-report');
  await item('小福助手排查报告').scrollIntoViewIfNeeded();
  await expect.poll(() => hub.machines.mac.attentionWrites.filter((w) => w.op === 'read').flatMap((w) => w.ids)).toContain('at-m3-report');
  await expect(item('小福助手排查报告').locator('.at-unread')).toHaveCount(0);

  // Reply: it goes to Mac with the item, and the item is ticked into 已完成.
  await item('网页端登录改成「1」').getByRole('button', { name: '回复', exact: true }).click();
  const box = item('网页端登录改成「1」').getByRole('textbox');
  await expect(box).toBeFocused();
  await box.fill('改成登录一次长期有效，别设成 1');
  await shot('phone-2-reply-dark');
  await item('网页端登录改成「1」').getByRole('button', { name: '发送给 Mac 队长' }).click();
  await expect(page.locator('.at-hint')).toContainText('已交给 Mac 的队长');
  expect(hub.machines.mac.attentionWrites.filter((w) => w.op === 'reply')).toEqual([{ op: 'reply', id: 'at-m1-decide', text: '改成登录一次长期有效，别设成 1' }]);
  expect(hub.machines.win.attentionWrites.filter((w) => w.op !== 'read')).toEqual([]);
  await expect(lists.locator('.at-section h2').first()).toHaveText('要你处理2');

  // Tick the Windows card item: only Windows hears about it.
  await item('Muse 冒烟测试').getByRole('button', { name: '已处理' }).click();
  await expect.poll(() => hub.machines.win.attentionWrites.filter((w) => w.op === 'done')).toEqual([{ op: 'done', id: 'at-w1-held' }]);
  await expect(tab().locator('.nav-attention')).toHaveText('1');

  // 已完成 is folded; open it, put one back.
  const toggle = page.getByRole('button', { name: /已完成/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(item('Windows 隧道守护脚本').locator('.at-done-text')).toHaveText('你已回复：好，开机自启也一起配上');
  await expect(item('网页端登录改成「1」').locator('.at-done-text')).toHaveText('你已回复：改成登录一次长期有效，别设成 1');
  await shot('phone-3-done-dark');
  await item('Muse 冒烟测试').getByRole('button', { name: '放回待处理' }).click();
  await expect.poll(() => hub.machines.win.attentionWrites.filter((w) => w.op === 'reopen')).toEqual([{ op: 'reopen', id: 'at-w1-held' }]);
  await expect(lists.locator('.at-section h2').first()).toHaveText('要你处理2');

  // Copy is an icon that turns into a tick.
  const copy = item('小红书要你').getByRole('button', { name: '复制这一条' });
  await copy.click();
  await expect(item('小红书要你').getByRole('button', { name: '已复制' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('小红书要你在 Mac 的 Chrome 里登录一次');

  // Touch targets: 44px, tool actions are icons with a name and a tooltip.
  const buttons = await lists.locator('button:visible').evaluateAll((all) => all.map((b) => ({ text: b.textContent.trim(), icon: b.classList.contains('icon-button'), label: b.getAttribute('aria-label'), title: b.title, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width })));
  for (const b of buttons) {
    expect(b.h, JSON.stringify(b)).toBeGreaterThanOrEqual(44);
    expect(b.text, JSON.stringify(b)).not.toMatch(/^(复制|已复制|删除|编辑|刷新|关闭|放回)$/);
    if (b.icon) { expect(b.text).toBe(''); expect(b.label).toBeTruthy(); expect(b.title).toBeTruthy(); expect(b.w).toBeGreaterThanOrEqual(44); }
  }
});

test('light theme, a refused reply keeps the draft, and an older computer without the page is named', async ({ browser }) => {
  await open(browser, 'light');
  hub.machines.win.attention = null;
  hub.machines.mac.attentionRefuse = '还没有队长：回复要交给队长，先在侧边栏创建队长。';
  await page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
  await tab().click();
  await expect(page.locator('#attention-sources')).toContainText('Windows 的 AgentDeck 还没有这个页面');
  await expect(page.locator('#attention-lists .at-item:not(.done)')).toHaveCount(4);
  await item('小福助手排查报告').getByRole('button', { name: '回复', exact: true }).click();
  await item('小福助手排查报告').getByRole('textbox').fill('补查完了告诉我');
  await item('小福助手排查报告').getByRole('button', { name: '发送给 Mac 队长' }).click();
  await expect(item('小福助手排查报告').getByRole('alert')).toHaveText('还没有队长：回复要交给队长，先在侧边栏创建队长。');
  await expect(item('小福助手排查报告').getByRole('textbox')).toHaveValue('补查完了告诉我');
  await shot('phone-4-light');
});
