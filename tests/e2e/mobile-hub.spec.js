const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { startHub, withRelay } = require('../fixtures/hub-proxy');

// The phone hub against two fake machines behind a Caddy-like local proxy.
// Nothing here touches a real AgentDeck, the VPS or the shared boards.
let hub, context, page, problems;

async function open(browser, { theme = 'dark', login = ['mac', 'win'], machines } = {}) {
  hub = await startHub(machines ? { machines } : undefined);
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
// In the Captain view the header switch is also the send target.
const sendTo = segment;
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
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，0/2 在线');
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
    await expect(segment('Mac')).toHaveAttribute('aria-label', 'Mac，在线');
    await expect(segment('Windows')).toHaveAttribute('aria-label', 'Windows，需要登录');
    await shot(`overview-needs-login-${theme}`);
    await signIn('win');
    await expect(machineCard('Windows')).toContainText('Windows 测试回执');
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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
    await expect(segment('Windows')).toHaveAttribute('aria-label', 'Windows，无响应（可能在睡眠）');
    await expect(machineCard('Mac')).toContainText('在线');
    await shot(`overview-unresponsive-${theme}`);

    win.setMode('online'); await refresh();
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
  });

  test(`captain, grouped sessions, merged board and output (${theme})`, async ({ browser }) => {
    await open(browser, { theme });
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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
  await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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
  await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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
  await expect(segment('Mac')).toHaveAttribute('aria-label', 'Mac，在线');
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

for (const tasks of ['missing cards', '404']) {
  test(`older snapshots without optional fields stay readable with quota 404 and tasks ${tasks}`, async ({ browser }) => {
    await open(browser, { login: [] });
    const missing = { csrf: false, captain: false };
    const calls = { snapshots: 0, quota: 0, tasks: 0 };
    // The 1.1.7 machine contract already required apiVersion, machine and
    // sessions. Keep those, but omit advisory metadata and newer turn details.
    // Intercept before login so no successful full snapshot can mask a failure.
    await page.route(/\/(mac|win)\/api\/snapshot$/, async (route) => {
      const response = await route.fetch();
      if (response.status() !== 200) return route.fulfill({ response });
      calls.snapshots++;
      const snapshot = await response.json();
      delete snapshot.now; delete snapshot.boardVersion;
      const { id, label, platform } = snapshot.machine;
      snapshot.machine = { id, label, platform };
      snapshot.sessions = snapshot.sessions.map(({ id, title, status, isMain }) => ({ id, title, status, isMain }));
      if (snapshot.captain) {
        delete snapshot.captain.title;
        snapshot.captain.turns = snapshot.captain.turns
          .filter((turn) => turn.user || (turn.reply && turn.kind !== 'notice'))
          .map(({ id, ts, user, reply, done, interrupted }) => ({ id, ts, user, reply, done, interrupted }));
      }
      if (missing.csrf) delete snapshot.csrfToken;
      if (missing.captain) delete snapshot.captain;
      await route.fulfill({ response, json: snapshot });
    });
    await page.route(/\/(mac|win)\/api\/quota$/, (route) => {
      calls.quota++;
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
    });
    await page.route(/\/(mac|win)\/api\/tasks$/, (route) => {
      calls.tasks++;
      return route.fulfill({ status: tasks === '404' ? 404 : 200, contentType: 'application/json', body: tasks === '404' ? '{"error":"Not found."}' : '{}' });
    });
    await expect(machineCard('Mac').getByLabel('Mac 的登录 token')).toBeVisible();
    await expect(machineCard('Windows').getByLabel('Windows 的登录 token')).toBeVisible();
    await signIn('mac'); await signIn('win');
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
    await expect(machineCard('Mac')).toContainText('在线');
    await expect(machineCard('Windows')).toContainText('在线');
    await expect(page.locator('.quota')).toHaveCount(0);
    expect(calls.snapshots).toBeGreaterThanOrEqual(2);
    expect(calls.quota).toBeGreaterThanOrEqual(2);
    expect(calls.tasks).toBeGreaterThanOrEqual(2);

    await nav('会话');
    await expect(page.getByRole('region', { name: 'Mac 的会话' }).getByRole('button')).toHaveCount(3);
    await expect(page.getByRole('region', { name: 'Windows 的会话' }).getByRole('button')).toHaveCount(2);
    await nav('看板');
    await expect(page.locator('#board-sources')).toHaveText('还没有读到任何一台电脑的看板。');
    await expect(page.locator('#projects')).toContainText('暂无任务');
    await expect(page.locator('.task-card')).toHaveCount(0);
    await nav('队长');
    await expect(page.locator('#captain-turns')).toContainText('出门前看一下三端方案的进度。');
    await expect(page.locator('#captain-turns')).toContainText('Mac 队长测试回复');
    await sendTo('Windows').click();
    await expect(page.locator('#captain-turns')).toContainText('检查隧道守护脚本。');
    await expect(page.locator('#captain-turns')).toContainText('Windows 队长测试回复');
    await sendTo('Mac').click();

    // Losing the safety credential must keep existing messages readable while
    // refusing both a click and a programmatic form submission.
    await page.getByLabel('给队长的消息').fill('缺少安全凭据时这条消息不能发送。');
    await expect(page.locator('#send')).toBeEnabled();
    missing.csrf = true;
    await refresh();
    await expect(page.locator('#send')).toBeDisabled();
    await expect(page.locator('#send-hint')).toContainText('安全校验还没就绪');
    await expect(page.locator('#captain-turns')).toContainText('Mac 队长测试回复');
    await page.evaluate(() => document.getElementById('message-form').requestSubmit());
    await expect(page.getByLabel('给队长的消息')).toHaveValue('缺少安全凭据时这条消息不能发送。');
    expect(hub.machines.mac.posts('api/captain')).toHaveLength(0);
    expect(hub.machines.win.posts('api/captain')).toHaveLength(0);

    // A build with no captain object is still a usable page, with an explicit
    // empty state and no write path. Other computers are never used as fallback.
    missing.captain = true;
    await refresh();
    await expect(page.locator('#captain-turns')).toContainText('Mac 还没有队长');
    await expect(page.locator('#send')).toBeDisabled();
    await expect(page.locator('#send-hint')).toContainText('Mac 的队长还没启动');
    await page.evaluate(() => document.getElementById('message-form').requestSubmit());
    await expect(page.getByLabel('给队长的消息')).toHaveValue('缺少安全凭据时这条消息不能发送。');
    expect(hub.machines.mac.messages).toEqual([]);
    expect(hub.machines.win.messages).toEqual([]);
    await nav('总览');
    await expect(machineCard('Mac')).toContainText('在线');
    expect(problems).toEqual([]);
  });
}

test('machine choice is remembered, content is not, and keyboard focus stays visible', async ({ browser }) => {
  await open(browser);
  const { mac, win } = hub.machines;
  await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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
  expect(storage.keys).toEqual(['agentdeck-hub-machine', 'agentdeck-hub-meta', 'agentdeck-hub-theme', 'agentdeck-hub-view']);
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
  await nav('总览');
  await segment('全部').click();
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
  await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
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

for (const theme of ['dark', 'light']) {
  test(`compact shell: the computer status lives in the header and the bottom is only the input (${theme})`, async ({ browser }) => {
    await open(browser, { theme });
    await expect(segment('全部')).toHaveAttribute('aria-label', '全部电脑，2/2 在线');
    await nav('队长');
    // No standalone status row: the switch is inside the header, and the content starts right under it.
    const layout = await page.evaluate(() => {
      const box = (selector) => { const el = document.querySelector(selector); const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      return { header: box('.app-header'), main: box('main'), composer: box('.composer'), nav: box('.navigation'), inHeader: !!document.querySelector('.app-header #machine-bar'),
        targetRow: !!document.querySelector('.target-row, #target'), hintHidden: document.getElementById('send-hint').hidden,
        composerButtons: [...document.querySelectorAll('.composer button')].map((b) => b.getAttribute('aria-label')), dots: document.querySelectorAll('#machine-bar .dot').length };
    });
    expect(layout.inHeader).toBe(true);
    expect(layout.header.height).toBeLessThanOrEqual(52);
    expect(layout.main.top).toBeCloseTo(layout.header.bottom, 0);
    expect(layout.targetRow).toBe(false);
    expect(layout.hintHidden).toBe(true);
    expect(layout.composerButtons).toEqual(['清空草稿', '发送给 Mac 队长']);
    expect(layout.dots).toBe(2);          // the captain view has no "all": one dot and a short name per computer
    // 844px phone: header 52, tabs 53, the rest is content.
    expect(layout.main.height).toBeGreaterThanOrEqual(720);
    // The conversation itself gets at least 70% of the screen: no title row above it, a one-line input and slim tabs below.
    const room = await page.evaluate(() => {
      const title = document.getElementById('captain-title'), wrapper = title.closest('.sr-only');
      const bounds = wrapper?.getBoundingClientRect(), style = wrapper && getComputedStyle(wrapper);
      // A clipped parent's child retains its natural box; verify the actual clipping contract.
      const titleClip = wrapper && { width: bounds.width, height: bounds.height, overflow: style.overflow, clipPath: style.clipPath };
      const clipped = bounds?.width <= 1 && bounds.height <= 1 && style.overflow === 'hidden' && style.clipPath === 'inset(50%)';
      return { turns: document.getElementById('captain-turns').clientHeight, screen: innerHeight,
        composer: document.querySelector('.composer').getBoundingClientRect().height,
        titleClip, headVisible: !clipped && title.getBoundingClientRect().height > 1 };
    });
    expect(room.turns / room.screen).toBeGreaterThanOrEqual(0.7);
    expect(room.composer).toBeLessThanOrEqual(50);
    expect(room.titleClip).toEqual({ width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' });
    expect(room.headVisible).toBe(false);
    await expect(page.locator('#captain-title')).toHaveText('Mac 队长');
    // The clear button only takes room while there is a draft; the input grows with it and shrinks back.
    const draft = page.getByLabel('给队长的消息'), clear = page.getByRole('button', { name: '清空草稿', exact: true });
    await expect(clear).toBeHidden();
    await draft.fill('第一行\n第二行\n第三行');
    await expect(clear).toBeVisible();
    await expect(clear).toHaveAttribute('title', '清空草稿');
    expect((await draft.boundingBox()).height).toBeGreaterThan(60);
    await auditButtons();
    await clear.click();
    await expect(clear).toBeHidden();
    expect((await draft.boundingBox()).height).toBeLessThanOrEqual(46);
    await expect(sendTo('Mac')).toHaveAttribute('aria-pressed', 'true');
    await expect(sendTo('Mac')).toHaveAttribute('aria-label', 'Mac，在线');
    await expect(segment('全部')).toHaveCount(0);
    await auditButtons();
    await shot(`hub-compact-390-${theme}-captain`);
    // Narrow phones keep the whole switch and the three header icons on one line.
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await page.evaluate(() => { const h = document.querySelector('.app-header'); return h.scrollWidth <= h.clientWidth && document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('.segment-name')].every((name) => name.scrollWidth <= name.clientWidth); })).toBe(true);
    // 360px still fits everything on the one 52px line.
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await page.evaluate(() => { const h = document.querySelector('.app-header'); return h.getBoundingClientRect().height <= 52 && [...document.querySelectorAll('.segment-name')].every((name) => name.scrollWidth <= name.clientWidth); })).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await nav('总览');
    await expect(segment('全部')).toHaveAttribute('aria-pressed', 'true');
    await shot(`hub-compact-390-${theme}-overview`);
  });

  test(`under /mac/ one round of the conversation is one message and one Captain reply (${theme})`, async ({ browser }) => {
    await open(browser, { theme });
    const { mac, win } = hub.machines;
    await nav('队长');
    const conversation = page.locator('#captain-turns');
    // The fixture holds a message, two dispatch cards, a notice and the reply as six desktop turns; the phone shows two bubbles.
    await expect(conversation.locator('.turn')).toHaveCount(1);
    await expect(conversation.locator('.bubble.mine')).toHaveCount(1);
    await expect(conversation.locator('.bubble:not(.mine)')).toHaveCount(1);
    await expect(conversation).toContainText('出门前看一下三端方案的进度。');
    await expect(conversation).toContainText('Mac 队长测试回复');
    await expect(conversation).not.toContainText('本次处理已结束');
    // Only the Captain's words: no process line, no receipt text, no tool steps, nothing left over from the terminal.
    await expect(conversation.locator('details, .process')).toHaveCount(0);
    for (const residue of ['过程：', '手机总台前端', '后来又给这个会话发了新指令', '队员回执已送达', 'git status', 'shell command', 'Background command', 'exit code', '❯']) await expect(conversation).not.toContainText(residue);
    // Both sides are bubbles: the user's on the right, the Captain's on the left, named and no wider than its text.
    const mine = conversation.locator('.bubble.mine'), reply = conversation.locator('.bubble:not(.mine)');
    await expect(reply.locator('.bubble-label')).toHaveText('Mac 队长');
    const shape = await conversation.evaluate((el) => {
      const box = (node) => node.getBoundingClientRect(), area = box(el), mine = el.querySelector('.bubble.mine'), reply = el.querySelector('.bubble:not(.mine)');
      const luminance = (colour) => { const [r, g, b] = colour.match(/[\d.]+/g).slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const mineStyle = getComputedStyle(mine), page = getComputedStyle(document.body).backgroundColor;
      return { mineRight: area.right - box(mine).right, mineLeft: box(mine).left - area.left, replyLeft: box(reply).left - area.left, replyRight: area.right - box(reply).right, areaWidth: area.width,
        radius: parseFloat(getComputedStyle(reply).borderTopLeftRadius), border: parseFloat(getComputedStyle(reply).borderTopWidth),
        text: contrast(mineStyle.color, mineStyle.backgroundColor), stands: contrast(mineStyle.backgroundColor, page) };
    });
    expect(shape.mineRight).toBeLessThanOrEqual(8); expect(shape.mineLeft).toBeGreaterThan(40);
    expect(shape.replyLeft).toBeLessThanOrEqual(8); expect(shape.replyRight).toBeGreaterThanOrEqual(16);
    expect(shape.radius).toBeGreaterThanOrEqual(12); expect(shape.border).toBeGreaterThanOrEqual(1);
    // The conversation uses the width of the phone: 390 wide leaves at most 12px a side.
    expect(shape.areaWidth).toBeGreaterThanOrEqual(366);
    // The user's bubble is a strong colour: readable text (WCAG AA) and clearly apart from the page behind it.
    expect(shape.text).toBeGreaterThanOrEqual(4.5);
    expect(shape.stands).toBeGreaterThanOrEqual(theme === 'dark' ? 5 : 1.25);
    await expect(mine).toHaveCount(1);
    // The reply is copyable with an icon button: tooltip, name, check mark afterwards.
    const copy = conversation.getByRole('button', { name: '复制队长回复', exact: true });
    await expect(copy).toHaveAttribute('title', '复制队长回复');
    await copy.click();
    await expect(conversation.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Mac 队长测试回复');
    await expect(conversation.getByRole('button', { name: '复制队长回复', exact: true })).toBeVisible({ timeout: 4000 });
    expect(await page.evaluate(() => window.hubInjected)).toBeUndefined();
    // The data came from this computer's own prefix only.
    expect(mac.requests.some((request) => request.url === '/mac/api/snapshot')).toBe(true);
    expect(win.requests.some((request) => request.url.startsWith('/mac/'))).toBe(false);
    await auditButtons();
    await shot(`hub-grouped-390-${theme}-captain`);

    // A long message is folded to a few lines with an expand control; the other computer's conversation stays separate.
    const long = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行：长消息也只算一条。`).join('\n');
    mac.captain.turns.push({ id: 'mac-long', ts: Date.now() - 1000, user: long, reply: '收到，开始处理。', done: true, interrupted: false });
    await refresh();
    // A short reply is a small bubble, not a full-width block.
    const short = conversation.locator('.bubble:not(.mine)', { hasText: '收到，开始处理。' });
    expect((await short.boundingBox()).width).toBeLessThan(220);
    expect(await short.locator('.bubble-md p').evaluate((el) => el.getClientRects().length && el.scrollHeight <= parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true);
    const toggle = conversation.getByRole('button', { name: '展开全文', exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await conversation.locator('.bubble-text.clamped').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await toggle.click();
    await expect(conversation.getByRole('button', { name: '收起', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(conversation).toContainText('第 14 行：长消息也只算一条。');
    await sendTo('Windows').click();
    await expect(conversation).not.toContainText('第 14 行');
    await expect(conversation.locator('.bubble.mine')).toHaveCount(1);
  });

  test(`quota table shows for each computer under its own prefix, with details in place (${theme})`, async ({ browser }) => {
    await open(browser, { theme });
    const { mac, win } = hub.machines;
    const quotaOf = (label) => machineCard(label).getByRole('region', { name: `${label} 的额度` });
    await expect(quotaOf('Mac').getByRole('listitem')).toHaveCount(3);
    await expect(quotaOf('Windows').getByRole('listitem')).toHaveCount(1);
    expect(mac.requests.some((request) => request.url === '/mac/api/quota')).toBe(true);
    expect(win.requests.some((request) => request.url === '/win/api/quota')).toBe(true);
    expect(mac.requests.concat(win.requests).filter((request) => request.url.includes('quota') && !/^\/(mac|win)\/api\/quota$/.test(request.url))).toEqual([]);
    const max = quotaOf('Mac').getByRole('listitem').filter({ hasText: 'Max' });
    await expect(max).toContainText('72%'); await expect(max).toContainText('41%');
    await expect(max.getByRole('button')).toHaveAttribute('aria-label', /^Claude Max · h\*\*\*@example\.com（队长在用）；5 小时剩余 72%.*每周剩余 41%.*；查看详情$/);
    await expect(max.locator('.quota-captain')).toHaveAttribute('title', '队长在用');
    // Low and used-up accounts are marked in words and shape, not colour alone.
    await expect(quotaOf('Mac').getByRole('listitem').filter({ hasText: 'Pro' })).toHaveAttribute('data-status', 'danger');
    const plus = quotaOf('Mac').getByRole('listitem').filter({ hasText: 'Plus' });
    await expect(plus.locator('[data-window="5h"] .quota-ban svg')).toBeVisible();
    await expect(plus.getByRole('button')).toHaveAttribute('aria-label', /5 小时已用尽.*恢复/);
    await expect(plus.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await expect(plus.locator('.quota-detail')).toBeHidden();
    await plus.getByRole('button').click();
    const details = quotaOf('Mac').getByRole('listitem').filter({ hasText: 'Plus' });
    await expect(details.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await expect(details.locator('.quota-detail')).toContainText('账号'); await expect(details.locator('.quota-detail')).toContainText('h***@example.com');
    await expect(details.locator('.quota-detail')).toContainText('每周'); await expect(details.locator('.quota-detail')).toContainText('剩余 12%');
    await expect(details.getByRole('button')).toBeFocused();
    await auditButtons();
    await shot(`hub-quota-390-${theme}-overview`);
    // Nothing from the quota rows is kept on the phone.
    const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    for (const value of ['example.com', 'Claude Max', '72%', 'Codex']) expect(dump).not.toContain(value);
    // Narrow screens: the table never scrolls sideways.
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.quota-row')].every((el) => el.scrollWidth <= el.clientWidth + 1) && [...document.querySelectorAll('.quota-row')].every((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }))).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });

    // A build without the quota route simply has no table; a failing read keeps the last rows and says so; offline hides the rows.
    await page.route('**/win/api/quota', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' }));
    await refresh();
    await expect(quotaOf('Windows')).toHaveCount(0);
    await expect(machineCard('Windows')).toContainText('在线');
    await page.unroute('**/win/api/quota');
    await page.route('**/mac/api/quota', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await refresh();
    await expect(quotaOf('Mac').locator('.quota-note')).toHaveText('未能更新');
    await expect(quotaOf('Mac').getByRole('listitem')).toHaveCount(3);
    await page.unroute('**/mac/api/quota');
    mac.setMode('down'); await refresh();
    await expect(machineCard('Mac').locator('.quota')).toHaveCount(0);
  });
}

// ---- moving a computer's Captain to another account ----
const sheet = () => page.locator('#switch-sheet');
const option = (id) => sheet().locator(`.seat-option[data-seat-id="${id}"]`);
const switchButton = (label, scope = page) => scope.getByRole('button', { name: `切换 ${label} 队长`, exact: true });
// Nothing on screen uses the internal words for this feature.
async function plainWords() { expect(await sheet().evaluate((el) => el.innerText)).not.toMatch(/relay|seat|席位/i); }
async function sheetShot(name) {
  await auditButtons(); await plainWords();
  // The sheet is fully on screen and nothing in it overflows sideways.
  // (Polled: the sheet slides up for a fifth of a second.)
  await expect.poll(() => sheet().evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight + 1 && r.top >= 0 && el.querySelector('.sheet-body').scrollWidth <= el.querySelector('.sheet-body').clientWidth; })).toBe(true);
  await shot(name);
}

for (const theme of ['dark', 'light']) {
  test(`the Captain moves to another account from the phone: pick, confirm, switching, done, and a failure that changes nothing (${theme})`, async ({ browser }) => {
    test.setTimeout(120000);
    await open(browser, { theme, machines: withRelay() });
    const { mac, win } = hub.machines;
    // Before: each computer's card says which account its Captain is on.
    const macSeat = machineCard('Mac').locator('.captain-seat'), winSeat = machineCard('Windows').locator('.captain-seat');
    await expect(macSeat).toContainText('队长在用');
    await expect(macSeat.locator('.captain-seat-value')).toHaveText('Claude US');
    await expect(macSeat.locator('.captain-seat-quota')).toHaveText('5 小时剩 4% · 每周剩 41%');
    await expect(macSeat).toHaveAttribute('data-level', 'danger');
    await expect(winSeat.locator('.captain-seat-value')).toHaveText('ChatGPT');
    await expect(switchButton('Mac')).toHaveText('切换队长');
    await expect(switchButton('Mac')).toHaveAttribute('aria-haspopup', 'dialog');
    await macSeat.scrollIntoViewIfNeeded();
    await auditButtons();
    await shot(`switch-390-${theme}-1-before`);

    // The sheet: this computer only, every account with its remainder, the unusable ones greyed with the reason.
    await switchButton('Mac').click();
    await expect(sheet()).toBeVisible();
    expect(await sheet().evaluate((el) => el.matches(':modal'))).toBe(true);
    await expect(sheet().getByRole('heading')).toHaveText('切换 Mac 队长');
    await expect(sheet()).toContainText('只换 Mac 这台电脑的队长。它现在用的是 Claude US');
    await expect(sheet().locator('.seat-option')).toHaveCount(6);
    await expect(sheet().locator('.seat-name')).toHaveText(['Claude US', 'Claude CN', 'Claude US2', 'Claude EU', 'Claude JP', 'ChatGPT']);
    await expect(option('us')).toContainText('队长在用');
    await expect(option('us')).toHaveAttribute('aria-disabled', 'true');
    await expect(option('cn')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(option('cn').locator('.seat-cell-value')).toHaveText(['72%', '63%']);
    await expect(option('us2')).toContainText('额度还不清楚，可以换过去试试');
    await expect(option('us2')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(option('eu')).toHaveAttribute('aria-disabled', 'true');
    await expect(option('eu').locator('.seat-reason')).toHaveText(/^额度用完了，\d\d:\d\d（1 小时 \d+ 分后）恢复$/);
    await expect(option('eu').locator('.seat-reason')).toHaveAttribute('data-blocked', 'true');
    await expect(option('eu')).toHaveAttribute('aria-label', /Claude EU；.*额度用完了.*现在不能选/);
    await expect(option('jp')).toHaveAttribute('aria-disabled', 'true');
    await expect(option('jp').locator('.seat-reason')).toHaveText('还没登录。要回到电脑上登录后才能用');
    // Greyed, but the reason keeps full strength and stays readable.
    expect(await option('eu').evaluate((el) => ({ name: getComputedStyle(el.querySelector('.seat-name')).opacity, reason: getComputedStyle(el.querySelector('.seat-reason')).opacity, border: getComputedStyle(el).borderTopStyle }))).toEqual({ name: '0.45', reason: '1', border: 'dashed' });
    const close = sheet().getByRole('button', { name: '关闭', exact: true });
    await expect(close).toHaveAttribute('title', '关闭');
    await expect(close).toHaveText('');
    await sheetShot(`switch-390-${theme}-2-pick`);
    await option('eu').scrollIntoViewIfNeeded();
    if (process.env.AGENTDECK_HUB_SCREENSHOT_DIR) await sheet().locator('.seat-list').screenshot({ path: path.join(path.resolve(process.env.AGENTDECK_HUB_SCREENSHOT_DIR), `switch-390-${theme}-7-used-up-greyed.png`) });
    // A greyed account does nothing, by tap or by keyboard.
    // (force: Playwright itself refuses to click what is marked disabled; a finger does not.)
    await option('eu').click({ force: true });
    await option('jp').focus(); await page.keyboard.press('Enter');
    await option('us').click({ force: true });
    await expect(sheet().getByRole('heading')).toHaveText('切换 Mac 队长');
    expect(mac.switches).toEqual([]);

    // Picking only asks; nothing is sent until the second, worded confirmation.
    await option('cn').click();
    await expect(sheet().getByRole('heading')).toHaveText('确认切换 Mac 队长？');
    await expect(sheet().getByRole('heading')).toBeFocused();
    await expect(sheet().locator('.sheet-route')).toHaveAttribute('aria-label', '从 Claude US 换到 Claude CN');
    await expect(sheet()).toContainText('现在这位队长正在说的话会中断，它没存下来的内容会丢。派出去的队员和任务不受影响。');
    await expect(sheet().getByRole('button', { name: '确认切换', exact: true })).toBeVisible();
    await sheetShot(`switch-390-${theme}-3-confirm`);
    expect(mac.switches).toEqual([]);
    await sheet().getByRole('button', { name: '先不换', exact: true }).click();
    await expect(sheet().getByRole('heading')).toHaveText('切换 Mac 队长');
    expect(mac.switches).toEqual([]);
    await option('cn').click();
    await sheet().getByRole('button', { name: '确认切换', exact: true }).click();

    // Switching: said in words, with a running clock; only Mac was asked.
    await expect(sheet().getByRole('heading')).toHaveText('正在切换 Mac 队长');
    await expect(sheet().getByRole('status')).toContainText('先让现在的队长存好进度，再启动新队长');
    await expect(sheet().locator('.sheet-route')).toHaveAttribute('aria-label', '从 Claude US 换到 Claude CN');
    await expect(sheet().locator('#switch-elapsed')).toHaveText(/^已经等了 0:0[1-9]$/, { timeout: 8000 });
    expect(mac.switches).toEqual([{ seatId: 'cn', expectCurrent: 'us' }]);
    expect(mac.posts('api/relay')).toHaveLength(1);
    expect(win.switches).toEqual([]);
    expect(win.requests.some((r) => r.method === 'POST' && /relay/.test(r.url))).toBe(false);
    await expect(macSeat.locator('.captain-seat-value')).toHaveText('正在换到 Claude CN…');
    await sheetShot(`switch-390-${theme}-4-switching`);

    // Done: the page follows the new Captain by itself.
    mac.finishRelay(true);
    await expect(sheet().getByRole('heading')).toHaveText('已换到 Claude CN', { timeout: 8000 });
    await expect(sheet().getByRole('status')).toContainText('Mac 的新队长已经用 Claude CN 接手');
    await sheetShot(`switch-390-${theme}-5-done`);
    await sheet().getByRole('button', { name: '去看新队长', exact: true }).click();
    await expect(sheet()).toBeHidden();
    await expect(sendTo('Mac')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#captain-turns')).toContainText('Mac 新队长测试回复', { timeout: 8000 });
    await expect(page.locator('#captain-turns')).not.toContainText('出门前看一下三端方案的进度。');
    const bar = page.locator('#captain-seat');
    await expect(bar.locator('.captain-seat-value')).toHaveText('Claude CN');
    await expect(bar).toContainText('Mac 队长在用');
    expect(await bar.evaluate((el) => { const v = el.querySelector('.captain-seat-value'); return v.getBoundingClientRect().width > 40 && el.scrollWidth <= el.clientWidth; })).toBe(true);
    // The conversation still gets most of the screen.
    expect(await page.evaluate(() => document.getElementById('captain-turns').clientHeight / innerHeight)).toBeGreaterThanOrEqual(0.7);
    await auditButtons();
    await shot(`switch-390-${theme}-6-new-captain`);
    expect(win.relay.currentId).toBe('chatgpt');

    // A failure, started from the conversation: the reason is shown and the Captain stays where it is.
    await switchButton('Mac', bar).click();
    await expect(option('cn')).toContainText('队长在用');
    await option('chatgpt').click();
    await sheet().getByRole('button', { name: '确认切换', exact: true }).click();
    await expect(sheet().getByRole('heading')).toHaveText('正在切换 Mac 队长');
    mac.finishRelay(false, '存进度或启动新队长没成功');
    await expect(sheet().getByRole('heading')).toHaveText('Mac 队长没有换成', { timeout: 8000 });
    await expect(sheet().getByRole('alert')).toHaveText('存进度或启动新队长没成功');
    await expect(sheet()).toContainText('Mac 队长现在用的还是 Claude CN，没有变化。');
    await sheetShot(`switch-390-${theme}-8-failed`);
    expect(mac.relay.currentId).toBe('cn');
    await sheet().getByRole('button', { name: '重新选账号', exact: true }).click();
    await expect(sheet().getByRole('heading')).toHaveText('切换 Mac 队长');
    await expect(option('cn')).toContainText('队长在用');
    // Escape closes the sheet and focus returns to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(sheet()).toBeHidden();
    await expect(switchButton('Mac', bar)).toBeFocused();
    await expect(page.locator('#captain-turns')).toContainText('Mac 新队长测试回复');
  });
}

test('the two computers switch separately; a refusal, a restart and a lost connection on the way are told apart', async ({ browser }) => {
  test.setTimeout(120000);
  await open(browser, { machines: withRelay() });
  const { mac, win } = hub.machines;
  const macSeat = machineCard('Mac').locator('.captain-seat'), winSeat = machineCard('Windows').locator('.captain-seat');
  const confirm = () => sheet().getByRole('button', { name: '确认切换', exact: true }).click();
  // Windows: its own sheet, its own prefix; Mac is never asked.
  await switchButton('Windows').click();
  await expect(sheet().getByRole('heading')).toHaveText('切换 Windows 队长');
  await expect(option('chatgpt')).toContainText('队长在用');
  await option('cn').click();
  await expect(sheet().getByRole('heading')).toHaveText('确认切换 Windows 队长？');
  await confirm();
  await expect(sheet().getByRole('heading')).toHaveText('正在切换 Windows 队长');
  expect(win.switches).toEqual([{ seatId: 'cn', expectCurrent: 'chatgpt' }]);
  expect(mac.switches).toEqual([]);
  // The sheet can be closed: the switch goes on, the card says so, and the outcome arrives at the top of the page.
  await sheet().getByRole('button', { name: '关闭', exact: true }).click();
  await expect(sheet()).toBeHidden();
  await expect(winSeat.locator('.captain-seat-value')).toHaveText('正在换到 Claude CN…');
  await expect(winSeat.getByRole('button', { name: '查看 Windows 队长的切换进度', exact: true })).toHaveText('查看进度');
  await expect(macSeat.locator('.captain-seat-value')).toHaveText('Claude US');
  await expect(switchButton('Mac')).toHaveText('切换队长');
  win.finishRelay(true);
  await expect(page.locator('#notice')).toHaveText('Windows 队长已换到 Claude CN。', { timeout: 8000 });
  await expect(winSeat.locator('.captain-seat-value')).toHaveText('Claude CN', { timeout: 8000 });
  expect(mac.relay.currentId).toBe('us');
  expect(mac.posts('api/relay')).toEqual([]);

  // The computer refuses (a draft is waiting on the desktop): its own words, and nothing changed.
  mac.relay.refuse = '电脑上队长的输入框里还有没发出去的内容，要先在电脑上发出或清空';
  await switchButton('Mac').click();
  await option('cn').click(); await confirm();
  await expect(sheet().getByRole('heading')).toHaveText('Mac 队长没有换成');
  await expect(sheet().getByRole('alert')).toHaveText(mac.relay.refuse);
  await expect(sheet()).toContainText('Mac 队长现在用的还是 Claude US，没有变化。');
  expect(mac.relay.currentId).toBe('us');
  mac.relay.refuse = '';

  // The Captain moved on the desktop meanwhile: the phone's stale picture is refused by the computer.
  await sheet().getByRole('button', { name: '重新选账号', exact: true }).click();
  await expect(option('cn')).toBeVisible();
  const posts = mac.switches.length;
  mac.relay.currentId = 'us2';
  await option('cn').click();
  // The list is re-read while the sheet is open, so the question is asked about what is true now.
  await expect(sheet().locator('.sheet-route')).toHaveAttribute('aria-label', '从 Claude US2 换到 Claude CN', { timeout: 10000 });
  await confirm();
  await expect(sheet().getByRole('heading')).toHaveText('正在切换 Mac 队长');
  expect(mac.switches.slice(posts)).toEqual([{ seatId: 'cn', expectCurrent: 'us2' }]);

  // The connection drops on the way: still "switching", said so, and the result shows up when it returns.
  mac.setMode('down');
  await expect(sheet()).toContainText('暂时连不上 Mac。恢复以后这里会自动显示结果，不用重新点。', { timeout: 10000 });
  await expect(sheet().getByRole('heading')).toHaveText('正在切换 Mac 队长');
  mac.setMode('online');
  mac.finishRelay(true);
  await expect(sheet().getByRole('heading')).toHaveText('已换到 Claude CN', { timeout: 10000 });
  await sheet().getByRole('button', { name: '关闭', exact: true }).click();

  // AgentDeck restarts on the way and forgets the switch: the account the Captain is on decides.
  await expect(macSeat.locator('.captain-seat-value')).toHaveText('Claude CN', { timeout: 8000 });
  await switchButton('Mac').click();
  await option('chatgpt').click(); await confirm();
  await expect(sheet().getByRole('heading')).toHaveText('正在切换 Mac 队长');
  mac.forgetRelay();
  await expect(sheet().getByRole('heading')).toHaveText('Mac 队长没有换成', { timeout: 8000 });
  await expect(sheet().getByRole('alert')).toHaveText('电脑上的 AgentDeck 中途重启了，切换没有完成。');
  await expect(sheet()).toContainText('Mac 队长现在用的还是 Claude CN，没有变化。');
  await plainWords();
});

test('a computer without the switch (older AgentDeck), offline or with no Captain offers no switch', async ({ browser }) => {
  const [mac, win] = withRelay();
  await open(browser, { machines: [{ ...mac, relay: null }, { ...win, captain: false }] });
  await expect(machineCard('Mac')).toContainText('最近回执');
  await expect(machineCard('Windows')).toContainText('最近回执');
  // Mac answers 404 for api/relay; Windows has accounts but no Captain to move.
  await expect.poll(() => hub.machines.mac.requests.some((r) => r.url === '/mac/api/relay')).toBe(true);
  await expect.poll(() => hub.machines.win.requests.some((r) => r.url === '/win/api/relay')).toBe(true);
  await expect(page.locator('.captain-seat')).toHaveCount(0);
  await expect(page.locator('[data-switch]')).toHaveCount(0);
  await nav('队长');
  await expect(page.locator('#captain-seat')).toBeHidden();
});
