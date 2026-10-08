'use strict';
// 真浏览器走一遍入口登录：打开 → 登录页 → 输一次 → 进总台 → 关掉浏览器重新打开仍是登录状态。
// 用 Chromium 和 WebKit（Safari 的内核），手机和平板的设备模拟各一遍。无头运行，不抢前台。
// 同 vps-caddy.test.js：需要 CADDY_BIN；没有 @playwright/test 或浏览器就跳过。

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./fixtures/vps/caddy-harness');

const caddy = H.findCaddy();
const skip = caddy ? false : 'caddy binary not found (set CADDY_BIN)';
const DAY = 24 * 60 * 60;

let pw = null;
try { pw = require('@playwright/test'); } catch { /* skipped below */ }

const CASES = [
  ['chromium', 'iPhone 13', 'chromium'],
  ['webkit', 'iPhone 13', 'webkit'],
  ['webkit', 'iPad Pro 11', 'webkit'],
];

for (const [label, deviceName, engine] of CASES) {
  test(`入口登录只输一次，关掉再开、隔天再开都直接进总台（${engine} / ${deviceName}）`, { skip: skip || (!pw && '@playwright/test not installed') }, async (t) => {
    let browser;
    try { browser = await pw[engine].launch(); } catch (e) { return t.skip(`${engine} unavailable: ${e.message.split('\n')[0]}`); }
    const s = await H.startStack(caddy, { https: true });
    t.after(async () => { await browser.close(); await s.stop(); s.cleanup(); });
    const device = pw.devices[deviceName];
    const dialogs = [];

    // 1. 第一次来：没有任何凭据。
    const first = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
    const page = await first.newPage();
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto(`${s.siteAddress}/`);
    assert.match(page.url(), /\/gate\/$/, 'sent to the login page');
    assert.equal(await page.title(), 'AgentDeck 登录');
    await page.getByLabel('账号').fill(H.AUTH_USER);

    // 显示口令是图标按钮：有提示、有名称、点一下变成「隐藏口令」。
    const eye = page.getByRole('button', { name: '显示口令' });
    assert.equal(await eye.getAttribute('title'), '显示口令');
    const box = await eye.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, `icon button is at least 44px, got ${box.width}x${box.height}`);
    assert.equal(await eye.evaluate((el) => el.textContent.trim()), '', 'icon only, no text');
    const pass = page.locator('#gate-pass');
    await pass.fill('wrong-pass');
    await eye.click();
    assert.equal(await pass.getAttribute('type'), 'text');
    assert.ok(await page.getByRole('button', { name: '隐藏口令' }).isVisible());
    assert.equal(await page.locator('.eye-on').evaluate((el) => getComputedStyle(el).display), 'none', 'the open-eye icon gives way to the crossed-out one');
    assert.equal(await page.locator('.eye-off').evaluate((el) => getComputedStyle(el).display), 'block');

    // 口令错：留在登录页，提示，没有 cookie，没有原生弹框。
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '账号或口令不对' }).waitFor();
    assert.match(page.url(), /\/gate\/$/);
    assert.equal((await first.cookies()).filter((c) => c.name.includes('gate')).length, 0);
    assert.deepEqual(dialogs, []);

    // 口令对：进总台。
    await pass.fill(H.AUTH_PASS);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(`${s.siteAddress}/`);
    assert.notEqual(await page.title(), 'AgentDeck 登录', 'the hub, not the login page');
    const gate = (await first.cookies()).find((c) => c.name === '__Host-agentdeck_gate');
    assert.ok(gate, 'the entrance cookie is stored');
    assert.equal(gate.value, s.gateSecret);
    assert.notEqual(gate.value, H.AUTH_PASS);
    assert.ok(gate.httpOnly && gate.secure && gate.path === '/');
    assert.ok(gate.expires > 0, 'persistent, not a session cookie');
    assert.ok(gate.expires - Date.now() / 1000 > 300 * DAY, `expires in ${Math.round((gate.expires - Date.now() / 1000) / DAY)} days`);
    const state = await first.storageState();
    await first.close();

    // 2. 关掉页面再打开（同一个浏览器，新页面）和「隔天」再打开：凭据来自浏览器存下来的 cookie，不再出现登录页或弹框。
    //    隔天用 cookie 的到期时间证明：它在 300 天后才到期，一天后仍然有效；再用只带这个 cookie 的全新环境打开，等同重启浏览器。
    for (const opening of ['reopen page', 'next day (fresh browser profile with only the stored cookie)']) {
      const again = await browser.newContext({ ...device, ignoreHTTPSErrors: true, storageState: state });
      const next = await again.newPage();
      next.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      await next.goto(`${s.siteAddress}/`);
      assert.equal(next.url(), `${s.siteAddress}/`, opening);
      assert.notEqual(await next.title(), 'AgentDeck 登录', opening);
      const api = await next.evaluate(async () => { const r = await fetch('/mac/api/info', { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; });
      assert.equal(api.status, 200, opening);
      assert.equal(api.body.app, 'agentdeck');
      const renewed = (await again.cookies()).find((c) => c.name === '__Host-agentdeck_gate');
      assert.ok(renewed.expires >= gate.expires, 'opening the hub renews, never shortens');
      await again.close();
    }
    assert.deepEqual(dialogs, [], 'the browser never showed its own login box');

    // 3. 没有 cookie 的另一部手机仍然进不去（登录不是被去掉了）。
    const stranger = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
    const other = await stranger.newPage();
    await other.goto(`${s.siteAddress}/`);
    assert.match(other.url(), /\/gate\/$/);
    const probe = await other.evaluate(async () => { const r = await fetch('/mac/api/info', { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; });
    assert.equal(probe.status, 401);
    assert.deepEqual(probe.body, { gate: 'login' });
    await stranger.close();
    assert.ok(label);
  });
}
