const { test, expect, chromium, webkit } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');
const { MobileWebServer } = require('../../mobile-web');

// Both phone pages (the hub at / and one computer's own page) on an iPad in
// both orientations and on an iPhone: a sent message stays in the conversation
// while the Captain is busy, and the input stays pinned to the bottom of what
// is visible. Headless browsers and local stand-ins only; no AgentDeck window
// opens. AGENTDECK_COMPOSER_ENGINE=webkit runs the same checks in WebKit.
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const DEVICES = [
  { name: 'ipad-portrait', viewport: { width: 820, height: 1180 }, userAgent: IPAD, keyboard: 760 },
  { name: 'ipad-landscape', viewport: { width: 1180, height: 820 }, userAgent: IPAD, keyboard: 420 },
  { name: 'iphone', viewport: { width: 390, height: 844 }, userAgent: IPHONE, keyboard: 500 },
];
const engineName = process.env.AGENTDECK_COMPOSER_ENGINE === 'webkit' ? 'webkit' : 'chromium';
let browser, context, page, close, problems;

test.beforeAll(async () => { browser = await (engineName === 'webkit' ? webkit : chromium).launch(); });
test.afterAll(async () => { await browser.close(); });
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (close) await close(); close = null;
  expect(seen).toEqual([]);
});
async function newPage(device) {
  context = await browser.newContext({ viewport: device.viewport, userAgent: device.userAgent, isMobile: engineName !== 'webkit' || undefined, hasTouch: true, deviceScaleFactor: 2 });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
}
async function shot(device, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (!process.env.AGENTDECK_COMPOSER_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_COMPOSER_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${device.name}${engineName === 'webkit' ? '-webkit' : ''}.png`), animations: 'disabled' });
}

// The hub with two stand-in computers; the Mac's Captain is busy.
async function openHub(device) {
  const hub = await startHub({ plainCookie: engineName === 'webkit' });
  close = () => hub.close();
  await newPage(device);
  await page.goto(hub.url);
  for (const id of ['mac', 'win']) {
    const fake = hub.machines[id], card = page.getByRole('article', { name: fake.label, exact: true });
    await card.getByLabel(`${fake.label} 的登录 token`).fill(fake.token);
    await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
  }
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '队长', exact: true }).click();
  const mac = hub.machines.mac;
  return { conversation: page.locator('#captain-turns'), status: page.locator('#send-hint'), bar: page.locator('.navigation'), composer: page.locator('#message-form'),
    sendUrl: '**/mac/api/captain', posts: () => mac.posts('api/captain').length, busy: () => { mac.busy = true; }, release: () => mac.releaseQueued(),
    refresh: () => page.getByRole('button', { name: '刷新全部电脑', exact: true }).click() };
}
// One computer's own page, served by the real MobileWebServer over stand-in sources.
async function openSingle(device) {
  const captain = { id: 'captain', title: '队长', status: 'working', turns: [
    { id: 'old-1', ts: Date.now() - 90000, user: '外出期间请检查队员的执行情况。', reply: '队长测试回复：界面任务正在核对，登录验收等待安排。', done: true },
    ...Array.from({ length: 14 }, (_, i) => ({ id: 'old-' + (i + 2), ts: Date.now() - 80000 + i * 1000, user: `第 ${i + 1} 条历史指令：把对话区撑到可以上下滚动。`, reply: `队长测试回复 ${i + 1}：已安排，对话可以上下滑动查看。`, done: true })),
  ] };
  const sessions = [{ id: 'captain', title: '队长', model: 'Claude', status: 'working', isMain: true, receipt: '' }];
  const state = { busy: false, queued: [], posts: 0 };
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: () => [], getCaptain: () => captain, getOutput: () => null, saveSettings: () => {},
    sendCaptain: (message) => { const turn = { id: 'new-' + (++state.posts), ts: Date.now(), user: message, reply: '', done: false }; if (state.busy) state.queued.push(turn); else captain.turns.push(turn); } });
  const status = await server.configure({ enabled: true, port: 0 });
  close = () => server.close();
  await newPage(device);
  await page.goto(status.url);
  await page.getByLabel('登录 token').fill(status.token);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#captain-turns')).toContainText('外出期间');
  return { conversation: page.locator('#captain-turns'), status: page.locator('#send-status'), bar: page.locator('#tabbar'), composer: page.locator('#message-form'),
    sendUrl: '**/api/captain', posts: () => state.posts, busy: () => { state.busy = true; }, release: () => { state.busy = false; captain.turns.push(...state.queued.splice(0)); },
    refresh: () => page.getByRole('button', { name: '刷新', exact: true }).click() };
}

for (const [pageName, open] of [['hub', openHub], ['single', openSingle]]) {
  for (const device of DEVICES) {
    test(`${pageName} on ${device.name}: a sent message stays put while the Captain is busy, is never sent twice by mistake, and a failure keeps its words`, async () => {
      const ui = await open(device);
      const box = page.getByLabel('给队长的消息'), send = page.locator('#send');
      const outgoing = ui.conversation.locator('.outgoing');
      const text = '今晚把 iPad 网页端的两个问题修掉。';
      const mine = ui.conversation.locator('.bubble.mine, .user-message').filter({ hasText: text });
      ui.busy();

      // The request is held: the message is already in the conversation, marked as on its way, and the button waits.
      let answer;
      const held = new Promise((resolve) => { answer = resolve; });
      await page.route(ui.sendUrl, async (route) => { if (route.request().method() === 'POST') await held; await route.fallback(); });
      await box.fill(text);
      await send.click();
      await expect(mine).toHaveCount(1);
      await expect(mine).toBeInViewport();
      await expect(outgoing).toHaveAttribute('data-state', 'sending');
      await expect(outgoing).toContainText('发送中');
      await expect(box).toHaveValue('');
      await expect(box).toBeEnabled();
      await box.fill('下一条草稿');
      await expect(send).toBeDisabled();
      await box.fill('');
      await shot(device, `${pageName}-1-sending`);
      answer();

      // Accepted, the Captain still busy: the bubble stays through refreshes, saying where the message is.
      await expect(outgoing).toHaveAttribute('data-state', 'sent');
      await expect(outgoing).toContainText('已发出');
      await expect(ui.status).toContainText('已排队');
      for (let i = 0; i < 2; i++) { await ui.refresh(); await page.waitForTimeout(400); await expect(mine).toHaveCount(1); }
      await expect(mine).toBeInViewport();
      expect(ui.posts()).toBe(1);
      await shot(device, `${pageName}-2-sent-waiting`);

      // The same words again: a line says the first one went out; nothing is sent, and no dialog opens.
      await box.fill(text);
      await send.click();
      await expect(ui.status).toContainText('刚才那条已发出');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect(box).toHaveValue(text);
      await expect(mine).toHaveCount(1);
      expect(ui.posts()).toBe(1);
      await shot(device, `${pageName}-3-repeat-hint`);
      await box.fill('');

      // The Captain takes it: the computer's own record replaces the bubble in place. One bubble, no leftover.
      ui.release();
      await ui.refresh();
      await expect(outgoing).toHaveCount(0);
      await expect(mine).toHaveCount(1);
      await expect(mine).toBeInViewport();
      await shot(device, `${pageName}-4-merged`);

      // A send that fails says so, keeps the words, and can be sent again or put back for editing.
      const lost = '这条在断线时发出，不能丢。';
      await page.route(ui.sendUrl, (route) => route.request().method() === 'POST' ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"offline":true,"error":"电脑离线"}' }) : route.continue());
      await box.fill(lost);
      await send.click();
      const failed = ui.conversation.locator('.outgoing[data-state="failed"]');
      await expect(failed).toContainText(lost);
      await expect(failed).toContainText(/没有发/);
      for (const name of ['重新发送这条消息', '重新编辑这条消息']) {
        const button = failed.getByRole('button', { name, exact: true });
        await expect(button).toHaveAttribute('title', name);
        expect(await button.evaluate((el) => el.textContent.trim() === '' && !!el.querySelector('svg') && el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)).toBe(true);
      }
      await shot(device, `${pageName}-5-failed`);
      await failed.getByRole('button', { name: '重新编辑这条消息', exact: true }).click();
      await expect(box).toHaveValue(lost);
      await expect(failed).toHaveCount(0);
      await send.click();
      await expect(failed).toContainText(lost);
      await page.unrouteAll({ behavior: 'wait' });
      await failed.getByRole('button', { name: '重新发送这条消息', exact: true }).click();
      await expect(failed).toHaveCount(0);
      await expect(ui.conversation.locator('.bubble.mine, .user-message').filter({ hasText: lost })).toHaveCount(1);
      expect(ui.posts()).toBe(2);
    });

    test(`${pageName} on ${device.name}: the input stays on the bottom edge, above the keyboard, and the page itself cannot be dragged`, async () => {
      const ui = await open(device);
      const box = page.getByLabel('给队长的消息');
      const edges = () => page.evaluate(() => {
        const rect = (selector) => { const el = document.querySelector(selector); const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), shown: r.height > 0 }; };
        return { height: Math.round(visualViewport.height), composer: rect('#message-form'), bar: rect('.navigation, #tabbar'), header: rect('.app-header'), turns: rect('#captain-turns'),
          scrollY: Math.round(scrollY), pageHeight: document.scrollingElement.scrollHeight };
      });
      const pinned = async (keyboard) => {
        const at = await edges();
        // Header on top, the conversation between, the input at the bottom: on the navigation, or on the keyboard.
        expect(at.header.top).toBe(0);
        expect(at.turns.top).toBeGreaterThanOrEqual(at.header.bottom);
        expect(at.turns.bottom).toBeLessThanOrEqual(at.composer.top + 1);
        expect(at.turns.bottom - at.turns.top).toBeGreaterThan(120);
        if (keyboard) { expect(at.bar.shown).toBe(false); expect(at.height - at.composer.bottom).toBeGreaterThanOrEqual(0); expect(at.height - at.composer.bottom).toBeLessThanOrEqual(8); }
        else { expect(at.bar.shown).toBe(true); expect(at.bar.bottom).toBe(at.height); expect(at.bar.top - at.composer.bottom).toBeGreaterThanOrEqual(0); expect(at.bar.top - at.composer.bottom).toBeLessThanOrEqual(8); }
        expect(at.scrollY).toBe(0); expect(at.pageHeight).toBeLessThanOrEqual(at.height);
      };
      // The shell follows the visual viewport on its resize event.
      const resize = async (size) => {
        await page.setViewportSize(size);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'))).toBe(size.height + 'px');
      };
      await pinned(false);
      await shot(device, `${pageName}-6-pinned`);

      // The page has nowhere to scroll to, by script or by finger.
      await page.evaluate(() => { scrollTo(0, 400); document.body.scrollTop = 400; });
      await pinned(false);
      // A finger on the input, the header or the navigation moves nothing; inside a list that can scroll it scrolls the list.
      const drag = (selector, dy) => page.evaluate(([selector, dy]) => {
        const target = document.querySelector(selector), touch = (y) => [{ clientX: 100, clientY: y }];
        const fire = (type, y, cancelable) => { const event = new Event(type, { bubbles: true, cancelable }); Object.defineProperty(event, 'touches', { value: touch(y) }); target.dispatchEvent(event); return event.defaultPrevented; };
        fire('touchstart', 300, false);
        return fire('touchmove', 300 + dy, true);
      }, [selector, dy]);
      expect(await drag('#message', -60)).toBe(true);
      expect(await drag('#message-form', 60)).toBe(true);
      expect(await drag('.app-header', 60)).toBe(true);
      expect(await drag('.navigation, #tabbar', -60)).toBe(true);
      if (await ui.conversation.evaluate((el) => el.scrollHeight > el.clientHeight + 100)) {
        await ui.conversation.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        // At the newest message: pulling further up would drag the page, scrolling back is the list's own.
        expect(await drag('#captain-turns', -60)).toBe(true);
        expect(await drag('#captain-turns', 60)).toBe(false);
      }

      // The soft keyboard takes the lower part of the screen: the input sits right on it and the conversation keeps its place above.
      await box.focus();
      await resize({ width: device.viewport.width, height: device.keyboard });
      await pinned(true);
      await box.fill('键盘弹出时输入栏贴在键盘上方。');
      await pinned(true);
      await shot(device, `${pageName}-7-keyboard`);
      await box.blur();
      await resize(device.viewport);
      await pinned(false);

      // Turned around, and squeezed into a narrow split-view column: still pinned.
      await resize({ width: device.viewport.height, height: device.viewport.width });
      await pinned(false);
      await resize({ width: 320, height: device.viewport.height });
      await pinned(false);
      await shot(device, `${pageName}-8-split-320`);
    });
  }
}
