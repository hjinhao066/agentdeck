const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');

// The phone hub against two fake machines behind a Caddy-like local proxy.
// Nothing here touches a real AgentDeck, the VPS or the shared boards.
let hub, context, page, problems;

async function open(browser, { theme = 'dark', login = ['mac', 'win'] } = {}) {
  hub = await startHub();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
  problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
  await page.goto(hub.url);
  for (const id of login) await signIn(id);
}
async function signIn(id, token = hub.machines[id].token) {
  const fake = hub.machines[id], card = machineCard(fake.label);
  await card.getByLabel(`${fake.label} 的登录 token`).fill(token);
  await card.getByRole('button', { name: `登录 ${fake.label}`, exact: true }).click();
}
const machineCard = (label) => page.getByRole('article', { name: label, exact: true });
const nav = (name) => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const refresh = () => page.getByRole('button', { name: '刷新全部电脑', exact: true }).click();
const segment = (label) => page.locator('#machine-bar').getByRole('button', { name: new RegExp('^' + label) });
const sendTo = (label) => page.locator('#target').getByRole('button', { name: new RegExp('^发给 ' + label) });
async function shot(name) {
  // Neither the page nor the scrolling content area may overflow sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main, .stack, .turns')].every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
  if (!process.env.AGENTDECK_HUB_SCREENSHOT_DIR) return;
  const dir = path.resolve(process.env.AGENTDECK_HUB_SCREENSHOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
// Tool actions are icon-only buttons with a tooltip, a name and a 44px target.
async function auditButtons() {
  const buttons = await page.locator('button:visible').evaluateAll((elements) => elements.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { icon: button.classList.contains('icon-button'), text: button.textContent.trim(), label: button.getAttribute('aria-label'), title: button.title,
      width: bounds.width, height: bounds.height, svg: !!button.querySelector('svg') };
  }));
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    expect(button.height, JSON.stringify(button)).toBeGreaterThanOrEqual(44);
    expect(button.text, JSON.stringify(button)).not.toMatch(/^(复制|已复制|删除|编辑|刷新|设置|关闭|清空|清空草稿|退出|全部退出|返回|发送)$/);
    if (!button.icon) continue;
    expect(button.text).toBe(''); expect(button.svg).toBe(true);
    expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy();
    expect(button.width).toBeGreaterThanOrEqual(44);
  }
}
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  expect(seen).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  test(`overview tells the two computers apart in every state (${theme})`, async ({ browser }) => {
    test.setTimeout(120000);
    await open(browser, { theme, login: [] });
    const { mac, win } = hub.machines;
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(machineCard('Mac')).toContainText('需要登录');
    await expect(machineCard('Windows')).toContainText('需要登录');
    await expect(segment('全部')).toHaveAttribute('aria-pressed', 'true');
    await expect(segment('全部')).toContainText('0/2 在线');
    // The probe is asked first, without a login, and each machine only at its own prefix.
    expect(mac.requests[0]).toEqual({ method: 'GET', url: '/mac/api/info' });
    expect(win.requests[0]).toEqual({ method: 'GET', url: '/win/api/info' });
    // An old build on a phone that never logged in: "upgrade", and no login form to fail in.
    win.setMode('legacy'); await refresh();
    await expect(machineCard('Windows')).toContainText('需要升级 AgentDeck');
    await expect(machineCard('Windows')).toContainText('升级前不用在这里登录');
    await expect(machineCard('Windows').getByLabel('Windows 的登录 token')).toHaveCount(0);
    await expect(machineCard('Windows').getByRole('button')).toHaveCount(0);
    await expect(segment('Windows')).toHaveAttribute('aria-label', 'Windows，需要升级 AgentDeck');
    await expect(machineCard('Mac').getByLabel('Mac 的登录 token')).toBeVisible();
    await shot(`overview-needs-upgrade-not-logged-in-${theme}`);
    expect(win.posts('login')).toHaveLength(0);
    win.setMode('online'); await refresh();
    await expect(machineCard('Windows').getByLabel('Windows 的登录 token')).toBeVisible();
    // Each computer has its own token: the Mac token is never offered to Windows.
    await signIn('mac', 'wrong-token');
    await expect(machineCard('Mac').getByRole('alert')).toContainText('token 不正确');
    await signIn('mac');
    await expect(machineCard('Mac')).toContainText('在线');
    await expect(machineCard('Mac')).toContainText('最近回执');
    expect(win.posts('login')).toHaveLength(0);
    await expect(segment('Mac')).toContainText('在线');
    await expect(segment('Windows')).toContainText('需登录');
    await shot(`overview-needs-login-${theme}`);
    await signIn('win');
    await expect(machineCard('Windows')).toContainText('Windows 测试回执');
    await expect(segment('全部')).toContainText('2/2 在线');
    expect(mac.posts('login')).toHaveLength(2);
    await auditButtons();
    await shot(`overview-both-online-${theme}`);

    win.setMode('down'); await refresh();
    await expect(machineCard('Windows')).toContainText('离线');
    await expect(machineCard('Windows')).toContainText('最后在线 刚刚');
    await expect(machineCard('Windows')).toContainText('上次看到的状态（不是现在）');
    await expect(machineCard('Windows')).not.toContainText('Windows 测试回执');
    await expect(machineCard('Mac')).toContainText('在线');
    await expect(segment('Windows')).toHaveAttribute('aria-label', 'Windows，离线');
    await shot(`overview-offline-${theme}`);

    win.setMode('legacy'); await refresh();
    await expect(machineCard('Windows')).toContainText('需要升级 AgentDeck');
    await expect(machineCard('Windows').getByLabel('Windows 的登录 token')).toHaveCount(0);
    await shot(`overview-needs-upgrade-${theme}`);

    win.setMode('hang'); await refresh();
    await expect(machineCard('Windows')).toContainText('无响应（可能在睡眠）', { timeout: 15000 });
    await expect(segment('Windows')).toContainText('无响应');
    await expect(machineCard('Mac')).toContainText('在线');
    await shot(`overview-unresponsive-${theme}`);

    win.setMode('online'); await refresh();
    await expect(segment('全部')).toContainText('2/2 在线');
  });

  test(`captain, grouped sessions, merged board and output (${theme})`, async ({ browser }) => {
    await open(browser, { theme });
    await expect(segment('全部')).toContainText('2/2 在线');
    await nav('队长');
    await expect(page.locator('#captain-title')).toHaveText('Mac 队长');
    await expect(page.locator('#captain-turns')).toContainText('Mac 队长测试回复');
    expect(await page.evaluate(() => window.hubInjected)).toBeUndefined();
    await page.getByLabel('给队长的消息').fill('把三端方案的截图整理到报告目录。');
    await auditButtons();
    await shot(`captain-to-mac-${theme}`);
    await sendTo('Windows').click();
    await expect(page.locator('#captain-title')).toHaveText('Windows 队长');
    await expect(page.locator('#captain-turns')).toContainText('Windows 队长测试回复');
    await expect(page.locator('#captain-turns')).not.toContainText('Mac 队长测试回复');
    await expect(page.getByLabel('给队长的消息')).toHaveValue('把三端方案的截图整理到报告目录。');
    await shot(`captain-to-windows-${theme}`);

    await nav('会话');
    const macGroup = page.getByRole('region', { name: 'Mac 的会话' }), winGroup = page.getByRole('region', { name: 'Windows 的会话' });
    await expect(macGroup.getByRole('button')).toHaveCount(3);
    await expect(winGroup.getByRole('button')).toHaveCount(2);
    await expect(winGroup).toContainText('隧道守护脚本');
    await expect(macGroup).not.toContainText('隧道守护脚本');
    await shot(`sessions-grouped-${theme}`);

    await nav('看板');
    await expect(page.locator('#board-sources')).toContainText('已合并 Mac 和 Windows 的看板');
    // Same card on both machines: shown once, with the newer Mac copy and its claimant.
    const tunnel = page.locator('.task-card', { hasText: 'Windows 隧道和开机自启' });
    await expect(tunnel).toHaveCount(1);
    await expect(tunnel).toContainText('进行中'); await expect(tunnel).toContainText('Windows 领取');
    await expect(page.locator('.task-card', { hasText: '手机总台前端' })).toContainText('Mac 领取');
    await expect(page.locator('.task-card', { hasText: '清理旧的定时任务日志' })).toHaveCount(1);
    await expect(page.locator('.board-foot')).toContainText('每 30 分钟同步');
    await auditButtons();
    await shot(`board-merged-${theme}`);
    await page.getByRole('button', { name: /^待验收/ }).click();
    await expect(page.locator('.task-card')).toHaveCount(1);

    await nav('会话');
    await page.getByRole('button', { name: 'Mac · 三端方案 · 手机总台', exact: true }).click();
    await expect(page.locator('#output-text')).toContainText('Mac 队员测试输出');
    await expect(page.locator('#brand-title')).toHaveText('Mac');
    await expect(page.locator('#output-machine')).toContainText('Mac · 队员输出');
    expect(await page.evaluate(() => window.hubInjected)).toBeUndefined();
    await auditButtons();
    await shot(`output-${theme}`);
    await page.getByRole('button', { name: '复制输出', exact: true }).click();
    const copied = page.getByRole('button', { name: '已复制', exact: true });
    await expect(copied).toHaveAttribute('title', '已复制');
    expect(await copied.evaluate((button) => button.textContent.trim() === '' && !!button.querySelector('svg'))).toBe(true);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Mac 队员测试输出');
    await expect(page.getByRole('button', { name: '复制输出', exact: true })).toBeVisible({ timeout: 4000 });
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
    await expect(page.locator('#brand-title')).toHaveText('AgentDeck');
  });
}

test('work goes only to the chosen computer and never falls over to the other one', async ({ browser }) => {
  await open(browser);
  const { mac, win } = hub.machines;
  await expect(segment('全部')).toContainText('2/2 在线');
  await nav('队长');
  const box = page.getByLabel('给队长的消息'), send = page.locator('#send'), hint = page.locator('#send-hint');
  // Both online: Mac is the default target.
  await expect(sendTo('Mac')).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveAttribute('placeholder', '写给 Mac 队长…');
  await expect(send).toHaveAttribute('aria-label', '发送给 Mac 队长');
  await expect(send).toBeDisabled();
  const first = '请 Windows 队长重试隧道守护脚本。';
  await box.fill(first);
  await sendTo('Windows').click();
  await expect(sendTo('Windows')).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveValue(first);
  await expect(box).toHaveAttribute('placeholder', '写给 Windows 队长…');
  await expect(send).toHaveAttribute('aria-label', '发送给 Windows 队长');
  await expect(send).toHaveAttribute('title', '发送给 Windows 队长');
  await send.click();
  await expect(hint).toHaveText('已排队到 Windows 队长。');
  await expect(box).toHaveValue('');
  await expect(page.locator('#captain-turns')).toContainText(first);
  expect(win.messages).toEqual([first]);
  expect(mac.messages).toEqual([]); expect(mac.posts('api/captain')).toHaveLength(0);

  // Target offline: the button is disabled, the reason is spelled out, the draft stays put.
  const second = '这条草稿在 Windows 离线时不能发出去。';
  await box.fill(second);
  win.setMode('down'); await refresh();
  await expect(send).toBeDisabled();
  await expect(hint).toContainText('Windows 离线');
  await expect(hint).toContainText('不会自动转给另一台电脑');
  await expect(sendTo('Windows')).toHaveAttribute('aria-pressed', 'true');
  await expect(box).toHaveValue(second);
  await page.evaluate(() => document.getElementById('message-form').requestSubmit());
  expect(mac.posts('api/captain')).toHaveLength(0);
  // Switching by hand is the only way to another computer; the draft comes along unsent.
  await sendTo('Mac').click();
  await expect(send).toBeEnabled();
  await expect(box).toHaveValue(second);
  await sendTo('Windows').click();
  await expect(send).toBeDisabled();

  // The target drops out between the last refresh and the tap: the message
  // fails visibly, is not re-sent anywhere, and can be put back for editing.
  win.setMode('online'); await refresh();
  await expect(send).toBeEnabled();
  await page.route('**/win/api/captain', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"offline":true}' }) : route.continue());
  await send.click();
  const failed = page.locator('.bubble.failed');
  await expect(failed).toContainText('没有发给 Windows');
  await expect(failed).toContainText('也没有转给另一台电脑');
  await expect(failed).toContainText(second);
  await expect(box).toHaveValue('');
  await auditButtons();
  await failed.getByRole('button', { name: '重新编辑这条消息', exact: true }).click();
  await expect(box).toHaveValue(second);
  await expect(failed).toHaveCount(0);
  await page.getByRole('button', { name: '清空草稿', exact: true }).click();
  await expect(box).toHaveValue('');
  expect(win.messages).toEqual([first]);
  expect(mac.messages).toEqual([]); expect(mac.posts('api/captain')).toHaveLength(0);
});

test('a computer that answers with a redirect toward the other one is never followed, for polls and for sends', async ({ browser }) => {
  await open(browser);
  const { mac, win } = hub.machines;
  await expect(segment('全部')).toContainText('2/2 在线');
  await nav('队长');
  const box = page.getByLabel('给队长的消息'), send = page.locator('#send');
  // Windows turns hostile: every answer is a 307 to a path on the Mac. Followed, the hub's request would carry the
  // Mac cookie to the Mac, and a 307 would replay a POST (with the Mac CSRF token the hub holds) against it.
  win.redirectTo = '/mac/api/canary';
  win.setMode('redirect');
  const canary = () => mac.requests.filter((request) => request.url.startsWith('/mac/api/canary'));
  await box.fill('这条消息不能被 Windows 的跳转转到 Mac。');
  await sendTo('Windows').click();
  await expect(send).toBeEnabled();      // Windows still looks online until the next poll
  await send.click();
  await expect(page.locator('.bubble.failed')).toContainText('手机连不上入口，消息没有发出');
  expect(win.posts('api/captain')).toHaveLength(1);
  expect(mac.posts('api/captain')).toHaveLength(0);
  expect(canary()).toEqual([]);
  // The poll treats it as a broken connection, never as data, and still never reaches the Mac.
  await refresh();
  await nav('总览');
  await expect(machineCard('Windows')).toContainText('连接异常');
  await expect(machineCard('Windows')).not.toContainText('Windows 测试回执');
  await expect(machineCard('Mac')).toContainText('在线');
  expect(canary()).toEqual([]);
  expect(mac.messages).toEqual([]);
});

test('a computer that is not logged in or has no captain cannot be sent to', async ({ browser }) => {
  await open(browser, { login: ['mac'] });
  hub.machines.mac.captain = null;
  await expect(segment('Mac')).toContainText('在线');
  await nav('队长');
  await page.getByLabel('给队长的消息').fill('测试草稿');
  await refresh();
  await expect(page.locator('#send-hint')).toContainText('Mac 的队长还没启动');
  await expect(page.locator('#send')).toBeDisabled();
  await sendTo('Windows').click();
  await expect(page.locator('#send-hint')).toContainText('Windows 还没登录');
  await expect(page.locator('#send')).toBeDisabled();
  expect(hub.machines.win.posts('api/captain')).toHaveLength(0);
});

test('machine choice is remembered, content is not, and keyboard focus stays visible', async ({ browser }) => {
  await open(browser);
  const { mac, win } = hub.machines;
  await expect(segment('全部')).toContainText('2/2 在线');
  await segment('Windows').click();
  await expect(machineCard('Mac')).toBeHidden();
  await nav('队长');
  await expect(page.locator('#captain-title')).toHaveText('Windows 队长');
  const message = '只存在内存里的手机消息';
  await page.getByLabel('给队长的消息').fill(message);
  await page.locator('#send').click();
  await expect(page.locator('#send-hint')).toHaveText('已排队到 Windows 队长。');
  await page.getByLabel('给队长的消息').fill('还没发出的草稿正文');
  await nav('会话');
  await expect(page.getByRole('region', { name: 'Mac 的会话' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Windows · 隧道守护脚本', exact: true }).click();
  await expect(page.locator('#output-text')).toContainText('Windows 队员测试输出');
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await nav('看板');
  await expect(page.locator('.task-card').first()).toBeVisible();
  await page.getByRole('button', { name: '切换浅色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const storage = await page.evaluate(() => ({ keys: Object.keys(localStorage).sort(), dump: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }), cookie: document.cookie }));
  expect(storage.keys).toEqual(['agentdeck-hub-machine', 'agentdeck-hub-meta', 'agentdeck-hub-theme']);
  expect(storage.cookie).toBe('');
  for (const content of [mac.token, win.token, message, '还没发出的草稿正文', '队长测试回复', '检查隧道守护脚本', '出门前看一下', '测试回执', '总览和派活界面', '队员测试输出', '隧道守护脚本', '手机总台前端', '清理旧的定时任务日志', '三端方案']) {
    expect(storage.dump).not.toContain(content);
  }
  expect(Object.keys(JSON.parse(JSON.parse(storage.dump.slice(0, storage.dump.lastIndexOf('{')))['agentdeck-hub-meta']).win).sort())
    .toEqual(['appVersion', 'captainStatus', 'hostname', 'lastOnline', 'sessionCount', 'workingCount']);

  await page.reload();
  await expect(segment('Windows')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await nav('队长');
  await expect(sendTo('Windows')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('给队长的消息')).toHaveValue('');
  await segment('全部').click();
  await nav('总览');
  await expect(machineCard('Mac')).toBeVisible();

  // Tab through the overview: every stop shows a focus ring.
  const stops = new Set();
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement, style = getComputedStyle(el);
      return { tag: el.tagName, name: el.getAttribute('aria-label') || el.textContent.trim(), ring: el.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 };
    });
    if (focus.tag === 'BODY') continue;
    expect(focus.ring, JSON.stringify(focus)).toBe(true);
    stops.add(focus.name);
  }
  expect([...stops]).toEqual(expect.arrayContaining(['刷新全部电脑', '切换深色主题', 'Mac，在线', 'Windows，在线']));
  expect(stops.size).toBeGreaterThanOrEqual(8);
});

test('logging out of one computer leaves the other signed in; logging out of all needs a second tap', async ({ browser }) => {
  await open(browser);
  const { mac, win } = hub.machines;
  await expect(segment('全部')).toContainText('2/2 在线');
  const exitWindows = machineCard('Windows').getByRole('button', { name: /^退出 Windows：只退出这台电脑/ });
  await expect(exitWindows).toHaveAttribute('title', /另一台不受影响/);
  await exitWindows.click();
  await expect(page.locator('#notice')).toContainText('再点一次，确认退出 Windows');
  expect(win.devices.size).toBe(1);
  await machineCard('Windows').getByRole('button', { name: '再点一次，确认退出 Windows', exact: true }).click();
  await expect(machineCard('Windows')).toContainText('需要登录');
  await expect(machineCard('Mac')).toContainText('在线');
  expect(win.devices.size).toBe(0); expect(mac.devices.size).toBe(1);
  expect(mac.posts('logout')).toHaveLength(0);
  await page.getByRole('button', { name: /^全部退出/ }).click();
  expect(mac.devices.size).toBe(1);
  await page.getByRole('button', { name: '再点一次，确认在这部手机上退出所有电脑', exact: true }).click();
  await expect(machineCard('Mac')).toContainText('需要登录');
  expect(mac.devices.size).toBe(0);
});
