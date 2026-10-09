const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub, attentionFixture } = require('../fixtures/hub-proxy');

// 待我处理 on the phone hub, against two fake machines behind the local proxy.
// Nothing here touches a real AgentDeck, the VPS or the shared boards.
let hub, context, page, problems;

async function open(browser, theme = 'dark', viewport = { width: 390, height: 844 }) {
  hub = await startHub();
  const data = attentionFixture();
  hub.machines.mac.attention = data.mac;
  hub.machines.win.attention = data.win;
  context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: true, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
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

test('both computers on one page: 要你处理, then 做完了你还没看; reply, tick and put back go to that computer only', async ({ browser }) => {
  await open(browser);
  // 3 things need the user: the number. 2 reports not seen yet: a dot of their own.
  await expect(tab()).toHaveAttribute('aria-label', '待我处理，3 件要你处理，2 条汇报你还没看');
  await expect(tab().locator('.nav-attention')).toHaveText('3');
  await expect(tab().locator('.nav-attention-dot')).toBeVisible();
  await tab().click();
  const lists = page.locator('#attention-lists');
  // Stacked on a phone: 要你处理 above 做完了你还没看. The report already read in the chat is not there.
  await expect(lists.locator('.at-section h2')).toHaveText(['要你处理3', '做完了你还没看2']);
  await expect(lists.locator('.at-cols .at-item .at-title')).toHaveText([/网页端登录改成「1」/, /小红书要你/, /Muse 冒烟测试/, /手机总台在做界面/, /小福助手排查报告/]);
  const [needBox, reportBox] = await lists.locator('.at-col').evaluateAll((all) => all.map((c) => c.getBoundingClientRect().toJSON()));
  expect(reportBox.top).toBeGreaterThan(needBox.bottom - 1);
  await expect(item('Muse 冒烟测试').locator('.at-meta')).toContainText('Windows · muse');
  await expect(item('网页端登录改成「1」').locator('.at-ask')).toContainText('回复「仍要 1」');
  // 队长's question is the biggest text on the card, its answers right under it; writing one's own is the fallback.
  const muse = item('Muse 冒烟测试');
  await expect(muse.locator('.at-ask')).toHaveAttribute('aria-label', '验收卡住了：还要继续做吗？');
  await expect(muse.locator('.at-ask .at-ask-text')).toHaveText('还要继续做吗？');
  await expect(muse.locator('.at-quick button')).toHaveText(['换个做法再试', '先放着', '不做了']);
  await expect(muse.getByRole('button', { name: '写别的回复' })).toBeVisible();
  await expect(muse.getByRole('button', { name: '回复', exact: true })).toHaveCount(0);
  const [askSize, titleSize] = await muse.evaluate((el) => ['.at-ask-text', '.at-title'].map((s) => parseFloat(getComputedStyle(el.querySelector(s)).fontSize)));
  expect(askSize).toBeGreaterThan(titleSize);
  await expect(muse.locator('.at-detail')).toHaveCount(0);
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
  // Read, it keeps its place (and its reply) while the tab stays open.
  await expect(item('小福助手排查报告')).toHaveClass(/\bseen\b/);
  await expect(item('小福助手排查报告').locator('.at-seen')).toHaveText('已读');
  await expect(item('小福助手排查报告').getByRole('button', { name: '回复', exact: true })).toBeVisible();

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
  await expect(page.getByRole('button', { name: /已完成和已读/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(item('网页端登录改成「1」')).toHaveCount(0);

  // Tick the Windows card item: only Windows hears about it.
  await item('Muse 冒烟测试').getByRole('button', { name: '已处理' }).click();
  await expect.poll(() => hub.machines.win.attentionWrites.filter((w) => w.op === 'done')).toEqual([{ op: 'done', id: 'at-w1-held' }]);
  await expect(tab().locator('.nav-attention')).toHaveText('1');

  // 已完成和已读 is folded; open it, put one back.
  const toggle = page.getByRole('button', { name: /已完成和已读/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(item('Windows 隧道守护脚本').locator('.at-done-text')).toHaveText('你已回复：好，开机自启也一起配上');
  await expect(item('网页端登录改成「1」').locator('.at-done-text')).toHaveText('你已回复：改成登录一次长期有效，别设成 1');
  await expect(item('网页端登录改成「1」')).toHaveClass(/\bdone\b/);
  await expect(item('网页端登录改成「1」').locator('.at-ok svg')).toHaveCount(1);
  // A finished plain 要你处理 drops its label; a typed one keeps it.
  await expect(item('Bark 推送').locator('.at-kind')).toHaveCount(0);
  await expect(item('「登录改成 1」的会话').locator('.at-done-text')).toHaveText('你在队长对话里看过了');
  await expect(item('网页端登录改成「1」').locator('.at-kind')).toHaveText('等你拍板');
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

  // A quick answer is one tap: it goes to Windows only as an ordinary reply, and the item is ticked.
  await item('Muse 冒烟测试').getByRole('button', { name: '先放着', exact: true }).click();
  await expect(page.locator('.at-hint')).toContainText('已回复「先放着」，交给 Windows 的队长');
  await expect.poll(() => hub.machines.win.attentionWrites.filter((w) => w.op === 'reply')).toEqual([{ op: 'reply', id: 'at-w1-held', text: '先放着' }]);
  expect(hub.machines.mac.attentionWrites.filter((w) => w.op === 'reply')).toHaveLength(1);
  await expect(lists.locator('.at-section h2').first()).toHaveText('要你处理1');
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
  await expect(item('小福助手排查报告').getByRole('alert')).toHaveText('Mac 上还没有队长。先到那台电脑的 AgentDeck 里创建队长，再回来回复。草稿还在。');
  await expect(item('小福助手排查报告').getByRole('textbox')).toHaveValue('补查完了告诉我');
  await shot('phone-4-light');
});

test('a report said in the 队长 reply the phone shows is read there; it never reaches 没看', async ({ browser }) => {
  await open(browser);
  await page.getByRole('navigation', { name: '主导航' }).locator('[data-view="captain"]').click();
  // The Mac round that ends with the reply at-m5-chat was said in (turn mac-t5).
  const round = page.locator('#captain-turns .turn[data-machine="mac"]', { hasText: 'Mac 队长测试回复' });
  await expect(round).toHaveAttribute('data-said', 'mac-t5');
  await round.locator('.reply').scrollIntoViewIfNeeded();
  await expect.poll(() => hub.machines.mac.attentionWrites.filter((w) => w.op === 'read'), { timeout: 15000 }).toEqual([{ op: 'read', ids: ['at-m5-chat'], via: 'chat' }]);
  expect(hub.machines.win.attentionWrites).toEqual([]);
  // One report is still unseen: the dot stays, the number is still only 要你处理.
  await expect(tab().locator('.nav-attention')).toHaveText('3');
  await expect(tab().locator('.nav-attention-dot')).toBeVisible();
  await tab().click();
  await expect(page.locator('#attention-lists .at-sec-report h2')).toHaveText('做完了你还没看1');
  await expect(page.locator('#attention-lists .at-cols').getByText('手机总台在做界面')).toHaveCount(0);
});

const reads = () => hub.machines.mac.attentionWrites.filter((w) => w.op === 'read');

test('a result is read only while the phone page is in front: blur or hidden leaves it unread, coming back starts the count again', async ({ browser }) => {
  await open(browser);
  // Leave before the first look can count: the window loses focus right as the page opens.
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await tab().click();
  const report = item('小福助手排查报告');
  await report.scrollIntoViewIfNeeded();
  await page.waitForTimeout(3500);
  expect(reads()).toEqual([]);
  await expect(report).toHaveClass(/unread/);
  // Shown but hidden (another tab, locked screen) does not count either, even with focus.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(3500);
  expect(reads()).toEqual([]);
  // Back in front: it starts from 0, so it is not read at once.
  const back = Date.now();
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(700);
  expect(reads()).toEqual([]);
  await expect.poll(() => reads().flatMap((w) => w.ids), { timeout: 10000 }).toContain('at-m3-report');
  expect(Date.now() - back).toBeGreaterThanOrEqual(1400);
});

test('a result said in the 队长 reply is not read while the phone page is out of front, and is read once it is back', async ({ browser }) => {
  await open(browser);
  await page.getByRole('navigation', { name: '主导航' }).locator('[data-view="captain"]').click();
  const round = page.locator('#captain-turns .turn[data-machine="mac"]', { hasText: 'Mac 队长测试回复' });
  await round.locator('.reply').scrollIntoViewIfNeeded();
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await page.waitForTimeout(3500);
  expect(reads()).toEqual([]);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect.poll(reads, { timeout: 15000 }).toEqual([{ op: 'read', ids: ['at-m5-chat'], via: 'chat' }]);
});

test('a tablet shows 要你处理 and 做完了你还没看 side by side', async ({ browser }) => {
  for (const viewport of [{ width: 1024, height: 1366 }, { width: 1366, height: 1024 }]) {
    await open(browser, 'dark', viewport);
    await page.locator('.side-nav [data-side-view="attention"]').click();
    await expect(page.locator('.side-nav .nav-attention')).toHaveText('3');
    await expect(page.locator('.side-nav .nav-attention-dot')).toBeVisible();
    const lists = page.locator('#attention-lists');
    await expect(lists.locator('.at-section h2')).toHaveText(['要你处理3', '做完了你还没看2']);
    const [needBox, reportBox] = await lists.locator('.at-col').evaluateAll((all) => all.map((c) => c.getBoundingClientRect().toJSON()));
    expect(reportBox.left).toBeGreaterThan(needBox.right);
    expect(Math.abs(reportBox.top - needBox.top)).toBeLessThan(2);
    await shot(`tablet-${viewport.width}x${viewport.height}-dark`);
    const seen = problems;
    await context.close(); context = null;
    await hub.close(); hub = null;
    expect(seen).toEqual([]);
  }
});
