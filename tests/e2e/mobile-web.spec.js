const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { TaskStore } = require('../../task-board');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, desktop, browser, mobile, profile, url, token;
const captures = () => {
  const file = path.join(profile, 'prompts.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};

async function launch(extraTurns = [], before = () => {}) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-mobile-e2e-'));
  // Keep the browser's origin stable across an isolated app restart.
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, captainTokenSaver: { enabled: false },
    mobileWeb: { enabled: false, port },
    mainSession: { colId: 'mobile-captain', cmd: FAKE, gen: 1, tasks: [], pending: [], inflight: [], waitlist: [] },
    columns: [
      { id: 'mobile-captain', title: '队长', isMain: true, cmd: FAKE, cwd: profile },
      { id: 'mobile-worker', title: '手机网页端 · 界面实现', cmd: FAKE + ' --quota-probe', cwd: profile, captainCrew: true, project: 'AgentDeck',
        lastReceipt: { summary: '会话与看板已完成，正在核对竖屏布局。', files: [] } },
      { id: 'mobile-failed', title: '数据导入 · 等待重试', cmd: FAKE, cwd: profile, captainCrew: true,
        lastReceipt: { summary: '测试夹具：连接中断，待队长安排。', failed: '测试连接中断', files: [] } },
    ],
  }));
  fs.mkdirSync(path.join(profile, 'chats'));
  before(profile);
  fs.writeFileSync(path.join(profile, 'chats', 'mobile-captain.json'), JSON.stringify({ v: 1, id: 'mobile-captain', turns: [...extraTurns, {
    id: 'mobile-history', ts: Date.now() - 60_000, user: '外出期间请检查队员的执行情况。',
    reply: '队长测试回复：界面任务正在核对，登录验收等待安排。\n<script>window.captainInjected=true</script>', done: true, atts: [],
  }, {
    id: 'mobile-history-markdown', ts: Date.now() - 45_000, user: '把检查步骤列一下。',
    reply: '**检查步骤**\n- 打开 [说明](https://example.com/docs)\n- 运行 `npm test`\n\n```bash\nnpx playwright test tests/e2e/mobile-web.spec.js --workers=1 --reporter=line --grep mobile\n```\n见 https://example.com/report。\n[危险](javascript:window.mdInjected=1) <img src=x onerror="window.mdInjected=1">',
    done: true, atts: [],
  }, {
    id: 'mobile-history-table', ts: Date.now() - 40_000, user: '把验收结果列成表。',
    reply: '验收结果：\n\n| 项目 | 状态 | 说明 | 负责人 |\n|:--|:-:|:--|---|\n| 登录 | **通过** | 见 https://example.com/a。然后复查 | 界面实现 |\n'
      + '| 看板 | 待验收 | `npm test` 通过，泳道在窄屏隐藏空列，等待真机复核 | 数据导入 |\n| 管道 | a \\| b | <img src=x onerror="window.tableInjected=1"> | 队长 |\n\n---\n结论见 https://example.com/b，下一步继续。',
    done: true, atts: [],
  }, {
    id: 'mobile-history-latest', ts: Date.now() - 30_000, user: '手机首次打开也要看得到完整的发送按钮。',
    reply: '竖屏布局测试回复：最近对话可以上下滑动查看，发送按钮保持在底部导航上方。', done: true, atts: [],
  }] }));
  const store = new TaskStore(path.join(profile, 'tasks'));
  store.add({ id: 'mobile-todo', project: 'AgentDeck', title: '核对深浅主题', detail: '手机竖屏布局检查。' });
  store.add({ id: 'mobile-review', project: 'AgentDeck', title: '验收登录与鉴权', detail: '拒绝错误 token。' });
  store.move({ id: 'mobile-review', status: 'review' });
  store.add({ id: 'mobile-done', project: '资料整理', title: '整理项目目录', detail: '测试数据。' });
  store.move({ id: 'mobile-done', status: 'done' });
  // Stand-ins must not load the user's zsh plugins/Conda hooks during startup.
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'),
    AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'columns.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await expect.poll(() => captures().some((text) => text.startsWith('你是 AgentDeck')), { timeout: 25000 }).toBe(true);
  await expect.poll(() => desktop.evaluate(() => terms.get('mobile-captain')?.state), { timeout: 20000 }).toBe('done');
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await expect(desktop.locator('#mobileWebEnabled')).not.toBeChecked();
  const disabled = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(disabled.enabled).toBe(false); expect(disabled.url).toBe(''); expect(disabled.token).toBe('');
  await desktop.locator('#mobileWebEnabled').check();
  await expect(desktop.locator('#mobileWebUrl')).not.toHaveValue('');
  url = await desktop.locator('#mobileWebUrl').inputValue();
  token = await desktop.locator('#mobileWebToken').inputValue();
  expect(token.length).toBeGreaterThanOrEqual(48);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  mobile = await context.newPage();
}
const tab = (name) => mobile.locator('#tabbar').getByRole('button', { name });
async function login() {
  const response = await mobile.goto(url);
  expect(response.status()).toBe(401);
  await screenshot('login');
  await mobile.getByLabel('登录 token').fill('wrong-token');
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('token 不正确');
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(tab('对话')).toHaveAttribute('aria-current', 'page');
  const cookies = await mobile.context().cookies();
  expect(cookies.find((c) => c.name === 'agentdeck_mobile')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  await mobile.reload();
  await expect(mobile.locator('#tabbar')).toBeVisible();
  await expect(mobile.locator('#captain-view')).toBeVisible();
  await expect(mobile.locator('#captain-turns')).toContainText('外出期间请检查队员的执行情况。');
}
async function post(route, data, headers = {}) {
  const { csrfToken } = await (await mobile.request.get(url + '/api/auth')).json();
  return mobile.request.post(url + route, { data, headers: { Origin: url, 'X-CSRF-Token': csrfToken, ...headers } });
}
async function screenshot(name) {
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR) {
    const dir = path.resolve(process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    await mobile.screenshot({ path: path.join(dir, name + '.png'), animations: 'disabled' });
  }
}
async function restartDesktop() {
  await application.close(); application = null;
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  desktop = await application.firstWindow();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  const restored = await desktop.evaluate(() => deck.mobileWebSettings());
  expect(restored.enabled).toBe(true); expect(restored.token === token).toBe(true);
  url = restored.url;
  return restored;
}
test.afterEach(async () => {
  if (browser) await browser.close(); browser = null;
  if (application) await application.close(); application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true }); profile = null;
});

test('isolated desktop settings, authenticated mobile views and light/dark portrait screenshots', async () => {
  await launch(); await login();
  // Real xterm output; HTML-like text must remain inert in the mobile reader.
  await desktop.evaluate(async () => {
    const col = columns.find((c) => c.id === 'mobile-worker');
    await ChatUI.sendPrompt(col, '竖屏检查 <script>window.mobileInjected=true</script>');
  });
  await expect.poll(() => captures().some((t) => t.includes('window.mobileInjected')), { timeout: 15000 }).toBe(true);
  // Keep status evidence on the real terminal so the desktop status tick
  // cannot overwrite a manually assigned state before the HTTP read.
  for (const [state, prompt] of [['input', 'ask me'], ['quota', 'wait for quota']]) {
    await desktop.evaluate((text) => deck.ptyInput('mobile-worker', text + '\r'), prompt);
    await expect.poll(() => desktop.evaluate(() => terms.get('mobile-worker').state)).toBe(state);
    const result = await (await mobile.request.get(url + '/api/sessions')).json();
    expect(result.sessions.find((session) => session.id === 'mobile-worker').status).toBe(state);
  }
  await desktop.evaluate(() => deck.ptyInput('mobile-worker', '竖屏检查 <script>window.mobileInjected=true</script>\r'));
  await expect.poll(() => desktop.evaluate(() => terms.get('mobile-worker').state)).toBe('done');
  // A session waiting on the user shows as a compact chip, not a card. The
  // desktop resets a stand-in's state quickly, so hold it on the page side.
  await mobile.route('**/api/sessions', async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.sessions.find((session) => session.id === 'mobile-worker').status = 'input';
    await route.fulfill({ response, json: body });
  });
  await mobile.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(mobile.locator('#attention .attention-chip')).toHaveText(['手机网页端 · 界面实现停在确认']);
  expect((await mobile.locator('#attention').boundingBox()).height).toBeLessThanOrEqual(60);
  // The same session is counted on the sessions tab, and listed first there.
  await expect(mobile.locator('#sessions-badge')).toHaveText('1');
  await expect(mobile.locator('.tab[data-view="sessions"]')).toHaveAttribute('aria-label', '会话，1 个等你处理');
  await screenshot('attention');
  await mobile.locator('#attention .attention-chip').click();
  await expect(mobile.locator('#output-view')).toBeVisible();
  await expect(tab(/会话/)).toHaveAttribute('aria-current', 'page');
  // Back returns to where the output was opened from.
  await mobile.getByRole('button', { name: '返回', exact: true }).click();
  await expect(mobile.locator('#captain-view')).toBeVisible();
  // The sessions tab opens the sidebar; the waiting session is listed first there.
  await tab(/会话/).click();
  await expect(mobile.locator('#drawer')).toBeVisible();
  await expect(mobile.locator('#sessions .session-row').first()).toContainText('手机网页端 · 界面实现');
  await expect(mobile.locator('#sessions .session-row').first().locator('.row-tag')).toHaveText('停在确认');
  await expect(mobile.locator('#sessions .session-row')).toHaveCount(2);
  await screenshot('sessions-badge');
  await mobile.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  await expect(mobile.locator('#drawer')).toBeHidden();
  await mobile.unroute('**/api/sessions');
  await mobile.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(mobile.locator('#attention')).toBeHidden();
  await expect(mobile.locator('#sessions-badge')).toBeHidden();
  await expect(mobile.locator('.tab[data-view="sessions"]')).toHaveAttribute('aria-label', '会话');
  // Lost connection: explicit state, draft kept, sending blocked until it recovers.
  await mobile.route('**/api/**', (route) => route.abort());
  await mobile.getByLabel('给队长的消息').fill('断线时写的草稿');
  await mobile.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(mobile.locator('#notice')).toHaveText('暂时连不上桌面端，正在自动重连…');
  await expect(mobile.locator('#view-meta')).toHaveText('连接中断');
  await expect(mobile.locator('#title-dot')).toHaveAttribute('data-status', 'offline');
  await expect(mobile.locator('#send')).toBeDisabled();
  await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
  await screenshot('offline');
  await mobile.unroute('**/api/**');
  await mobile.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(mobile.locator('#notice')).toBeHidden();
  await expect(mobile.locator('#view-meta')).not.toHaveText(/连接中断/);
  await expect(mobile.locator('#title-dot')).not.toHaveAttribute('data-status', 'offline');
  await expect(mobile.locator('#send')).toBeEnabled();
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('断线时写的草稿');
  await mobile.getByLabel('给队长的消息').fill('');
  await desktop.evaluate(() => { terms.get('mobile-worker').state = 'done'; });
  for (const theme of ['dark', 'light']) {
    await mobile.evaluate((value) => { localStorage.setItem('agentdeck-mobile-theme', value); }, theme);
    await mobile.reload();
    // Set via the public theme control if the app uses a different storage key.
    if (await mobile.locator('html').getAttribute('data-theme') !== theme) { await tab('更多').click(); await mobile.getByRole('switch', { name: '深色模式' }).click(); await tab('对话').click(); }
    await expect(mobile.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(mobile.locator('#theme')).toHaveAttribute('aria-checked', String(theme === 'dark'));
    await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
    expect(await mobile.evaluate(() => window.captainInjected)).toBeUndefined();
    // Minimal Markdown built with textContent only: bold, lists, code, http(s) links.
    const markdown = mobile.locator('[data-turn-id="mobile-history-markdown"] .markdown');
    await expect(markdown.locator('strong')).toHaveText('检查步骤');
    await expect(markdown.locator('ul > li')).toHaveCount(2);
    await expect(markdown.locator('.md-code')).toHaveText('npm test');
    await expect(markdown.locator('a')).toHaveCount(2);
    await expect(markdown.getByRole('link', { name: '说明' })).toHaveAttribute('href', 'https://example.com/docs');
    await expect(markdown.getByRole('link', { name: '说明' })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(markdown.getByRole('link', { name: 'https://example.com/report' })).toHaveAttribute('target', '_blank');
    await expect(markdown).toContainText('[危险](javascript:window.mdInjected=1) <img src=x');
    expect(await markdown.locator('img, script, [onerror]').count()).toBe(0);
    const code = markdown.locator('.code-block pre');
    await expect(code).toHaveCSS('white-space', 'pre');
    expect(await code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await markdown.getByRole('button', { name: '复制代码', exact: true }).click();
    expect(await mobile.evaluate(() => navigator.clipboard.readText())).toBe('npx playwright test tests/e2e/mobile-web.spec.js --workers=1 --reporter=line --grep mobile');
    expect(await mobile.evaluate(() => window.mdInjected)).toBeUndefined();
    // Pipe tables become a sideways-scrolling table, --- a thin rule; a bare
    // link stops before the Chinese text that follows it.
    const tableReply = mobile.locator('[data-turn-id="mobile-history-table"] .markdown');
    await expect(tableReply.locator('.table-wrap')).toHaveCSS('overflow-x', 'auto');
    await expect(tableReply.locator('th')).toHaveText(['项目', '状态', '说明', '负责人']);
    await expect(tableReply.locator('tbody tr')).toHaveCount(3);
    await expect(tableReply.locator('th').nth(1)).toHaveCSS('text-align', 'center');
    await expect(tableReply.locator('tbody tr').nth(0).locator('strong')).toHaveText('通过');
    await expect(tableReply.locator('tbody tr').nth(1).locator('.md-code')).toHaveText('npm test');
    await expect(tableReply.locator('tbody tr').nth(2).locator('td').nth(1)).toHaveText('a | b');
    await expect(tableReply.locator('tbody tr').nth(2).locator('td').nth(2)).toHaveText('<img src=x onerror="window.tableInjected=1">');
    await expect(tableReply.locator('hr')).toHaveCount(1);
    await expect(tableReply).not.toContainText('---');
    await expect(tableReply).not.toContainText('|:--');
    await expect(tableReply.getByRole('link', { name: 'https://example.com/a', exact: true })).toHaveAttribute('href', 'https://example.com/a');
    await expect(tableReply.locator('tbody tr').nth(0).locator('td').nth(2)).toHaveText('见 https://example.com/a。然后复查');
    await expect(tableReply.getByRole('link', { name: 'https://example.com/b', exact: true })).toHaveAttribute('href', 'https://example.com/b');
    await expect(tableReply.locator('p').last()).toHaveText('结论见 https://example.com/b，下一步继续。');
    expect(await tableReply.locator('img, script, [onerror]').count()).toBe(0);
    expect(await mobile.evaluate(() => window.tableInjected)).toBeUndefined();
    await tableReply.locator('.table-wrap').evaluate((element) => {
      const conversation = document.getElementById('captain-turns');
      conversation.scrollTop += element.getBoundingClientRect().top - conversation.getBoundingClientRect().top - 12;
    });
    await expect(tableReply.locator('hr')).toBeInViewport();
    await screenshot(`markdown-table-${theme}`);
    await mobile.locator('#captain-turns').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    for (const [width, height] of [[390, 844], [430, 932]]) {
      await mobile.setViewportSize({ width, height });
      await expect.poll(() => mobile.locator('#send').boundingBox().then((b) => b.y + b.height)).toBeGreaterThan(height - 80);
      // Chat layout: the conversation fills the screen, the one-line composer
      // sits at the bottom edge and grows with its text.
      const conversation = await mobile.locator('#captain-turns').boundingBox();
      expect(conversation.height).toBeGreaterThanOrEqual(height * 0.6);
      const composer = await mobile.locator('#message').boundingBox();
      expect(composer.height).toBeLessThanOrEqual(48);
      const sendBounds = await mobile.locator('#send').boundingBox();
      expect(sendBounds.height).toBeGreaterThanOrEqual(44);
      expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(height);
      expect(sendBounds.y + sendBounds.height).toBeGreaterThan(height - 80);
      // The tab bar is pinned to the bottom edge, below the composer, with
      // four labelled tabs of at least 44px each.
      const bar = await mobile.locator('#tabbar').boundingBox();
      expect(Math.round(bar.y + bar.height)).toBe(height);
      expect(bar.width).toBe(width);
      expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(bar.y);
      await expect(mobile.locator('#tabbar .tab-label')).toHaveText(['对话', '会话', '看板', '更多']);
      for (const box of await mobile.locator('#tabbar .tab').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await mobile.locator('#tabbar').evaluate((el) => getComputedStyle(el).backgroundColor === getComputedStyle(document.body).backgroundColor)).toBe(true);
      expect((await mobile.locator('.app-header').boundingBox()).height).toBeLessThanOrEqual(60);
      await mobile.getByLabel('给队长的消息').fill('请核对手机竖屏布局，\n并汇总测试结果，\n再附上截图。');
      expect((await mobile.locator('#message').boundingBox()).height).toBeGreaterThan(composer.height + 20);
      expect(await mobile.locator('#captain-turns').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      expect(await mobile.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await screenshot(`captain-${width}-${theme}`);
      await mobile.getByLabel('给队长的消息').fill('');
    }
    // Lost connection in either theme: the header stops claiming a live status.
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.route('**/api/**', (route) => route.abort());
    await mobile.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(mobile.locator('#view-meta')).toHaveText('连接中断');
    await screenshot(`offline-${theme}`);
    await mobile.unroute('**/api/**');
    await mobile.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(mobile.locator('#title-dot')).not.toHaveAttribute('data-status', 'offline');
    // Soft keyboard open (a text field has focus and the visible height
    // shrinks): the tab bar hides, the composer sits on the keyboard and stays
    // within 30% of what is visible.
    await mobile.getByLabel('给队长的消息').focus();
    await mobile.setViewportSize({ width: 390, height: 420 });
    await expect(mobile.locator('#tabbar')).toBeHidden();
    await expect.poll(() => mobile.locator('#send').boundingBox().then((b) => b.y + b.height)).toBeGreaterThan(420 - 20);
    // Wait for the shell to refit the shorter viewport before measuring the composer.
    await expect.poll(() => mobile.locator('#send').boundingBox().then((b) => b.y + b.height)).toBeLessThanOrEqual(420);
    await mobile.getByLabel('给队长的消息').fill(Array.from({ length: 12 }, (_, i) => '第 ' + (i + 1) + ' 行').join('\n'));
    expect((await mobile.locator('#message').boundingBox()).height).toBeLessThanOrEqual(420 * 0.3 + 1);
    expect((await mobile.locator('#captain-turns').boundingBox()).height).toBeGreaterThanOrEqual(150);
    await mobile.getByLabel('给队长的消息').fill('键盘弹起时的草稿');
    await screenshot(`keyboard-${theme}`);
    await mobile.getByLabel('给队长的消息').fill('');
    // Keyboard closed again: the tab bar comes back.
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.getByLabel('给队长的消息').blur();
    await expect(mobile.locator('#tabbar')).toBeVisible();
    // A short window alone is not a keyboard: without focus the tab bar stays.
    await mobile.setViewportSize({ width: 390, height: 420 });
    await expect(mobile.locator('#tabbar')).toBeVisible();
    await mobile.setViewportSize({ width: 390, height: 844 });
    // Tabs switch the pages; the sessions tab opens the sidebar, which holds
    // the only session list, and leaves the current page marked.
    await tab(/会话/).click();
    await expect(mobile.locator('#drawer')).toBeVisible();
    await expect(tab('对话')).toHaveAttribute('aria-current', 'page');
    await expect(mobile.locator('#tabbar [aria-current="page"]')).toHaveCount(1);
    await expect(mobile.locator('#sessions-view')).toHaveCount(0);
    await expect(mobile.locator('#drawer').getByText('会话与看板已完成，正在核对竖屏布局。')).toBeVisible();
    await screenshot(`sessions-${theme}`);
    await mobile.keyboard.press('Escape');
    await expect(mobile.locator('#drawer')).toBeHidden();
    await tab('看板').click();
    await expect(tab('看板')).toHaveAttribute('aria-current', 'page');
    await expect(mobile.getByText('核对深浅主题')).toBeVisible();
    await expect(mobile.getByText('资料整理', { exact: true })).toBeVisible();
    await screenshot(`board-${theme}`);
    await tab('更多').click();
    await expect(mobile.locator('#view-title')).toHaveText('更多');
    await expect(mobile.getByRole('button', { name: '退出此设备', exact: true })).toBeVisible();
    await screenshot(`more-${theme}`);
    await tab(/会话/).click();
    await mobile.locator('#sessions [data-session-id="mobile-worker"]').click();
    await expect(mobile.locator('#drawer')).toBeHidden();
    await expect(tab(/会话/)).toHaveAttribute('aria-current', 'page');
    await expect(mobile.locator('#outputText')).toContainText('window.mobileInjected');
    expect(await mobile.evaluate(() => window.mobileInjected)).toBeUndefined();
    await screenshot(`output-${theme}`);
    await mobile.getByRole('button', { name: '复制输出', exact: true }).click();
    await expect(mobile.getByRole('button', { name: '已复制', exact: true })).toHaveAttribute('title', '已复制');
    await mobile.setViewportSize({ width: 320, height: 740 });
    await screenshot(`output-narrow-${theme}`);
    const buttons = await mobile.locator('.icon-button:visible').evaluateAll((elements) => elements.map((button) => {
      const bounds = button.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, label: button.getAttribute('aria-label'), title: button.title };
    }));
    for (const button of buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy();
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.getByRole('button', { name: '返回', exact: true }).click();
    await expect(mobile.locator('#more-view')).toBeVisible();
    await tab('对话').click();
    await mobile.getByRole('button', { name: '复制队长回复', exact: true }).last().click();
    await expect(mobile.getByRole('button', { name: '已复制', exact: true })).toHaveAttribute('title', '已复制');
    expect(await mobile.evaluate(() => navigator.clipboard.readText())).toContain('竖屏布局测试回复');
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(persisted.mobileWeb.enabled).toBe(true); expect(persisted.mobileWeb.token === token).toBe(true);
  await restartDesktop();
  expect((await mobile.goto(url)).status()).toBe(200);
  await tab(/会话/).click();
  await expect(mobile.getByText('会话与看板已完成，正在核对竖屏布局。')).toBeVisible();
  await desktop.getByRole('button', { name: '设置', exact: true }).click();
  await desktop.locator('#mobileWebEnabled').uncheck();
  await expect.poll(() => desktop.evaluate(() => deck.mobileWebSettings().then((s) => s.enabled))).toBe(false);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mobileWeb.enabled).toBe(false);
  if (process.platform !== 'win32') expect(fs.statSync(path.join(profile, 'config.json')).mode & 0o777).toBe(0o600);
});

// Seeds the desktop's own quota store, so the phone reads what the sidebar shows.
async function seedQuota(state) {
  await desktop.evaluate((kind) => {
    const now = Date.now(), old = now - 45 * 60000;
    config.claudeSeats = ClaudeSeatsCore.normalize([{ id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude' }, { id: 'us', name: '🇺🇸 US', configDir: '~/.claude-us' }]);
    columns.find((c) => c.isMain).agentProvider = 'Claude';
    for (const key of Object.keys(config.quotas)) delete config.quotas[key];
    const official = (id, dir, at, five, week, account) => QuotaCore.observe(config.quotas, { ...QuotaCore.cacheClaude({ source: QuotaCore.CLAUDE_OAUTH_SOURCE, windows: [
      { key: 'fiveHour', remaining: five, resetText: new Date(now + 2 * 3600000 + 600000).toISOString() }, { key: 'weekly', remaining: week, resetText: new Date(now + 3 * 86400000).toISOString() }] }, at),
      seatId: id, configDir: dir, accountBound: true, accountKey: id + '-account', credentialKey: id + '-cred', account }, now);
    official('cn', '~/.claude', kind === 'stale' ? old : now, kind === 'low' ? 8 : kind === 'out' ? 0 : 26, 61, 'hjinhao@gmail.com');
    official('us', '~/.claude-us', now, 0, 40, 'us***@example.com');
    QuotaCore.observe(config.quotas, { ...QuotaCore.screen('Codex', 'Weekly limit: 8% left (resets 10:00)', [], now), account: 'co***@example.com' }, now);
    // A screen sample from before the app was last closed: too old to trust its numbers.
    config.quotas.Antigravity = { scope: 'gemini', sample: { provider: 'Antigravity', scope: 'gemini', at: old, source: 'agy 本地状态行快照', confidence: '中', windows: [{ key: 'Gemini 5 小时', label: 'Gemini 5 小时', used: 20, remaining: 80, exhausted: false, resetAt: null, resetText: '' }] } };
    renderQuotaBar();
  }, state);
  // Read it now instead of waiting for the next poll: the drawer's refresh icon when open, the header's otherwise.
  const open = await mobile.locator('#drawer').evaluate((el) => !el.inert);
  await mobile.locator(open ? '#quota-refresh' : '#refresh').click();
}
test('sidebar: Captain, sessions by project and the desktop quota rows; exhausted, old and unknown are explicit', async () => {
  await launch(); await login();
  // No login, no quota: the endpoint answers 401 without a device cookie.
  const stranger = await browser.newContext();
  expect((await stranger.request.get(url + '/api/quota')).status()).toBe(401);
  await stranger.close();
  await seedQuota('normal');
  const response = await mobile.request.get(url + '/api/quota');
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).toContain('h***@gmail.com');
  expect(text).not.toMatch(/hjinhao|\.claude|account"?:\s*"[^"*]*@|cn-account|cn-cred|configDir|token/);
  expect(JSON.parse(text).rows.map((row) => [row.key, row.status, row.captain])).toEqual([
    ['Claude:cn', 'normal', true], ['Claude:us', 'out', false], ['Claude:us2', 'unknown', false], ['Codex', 'danger', false], ['Cursor', 'unknown', false], ['Antigravity', 'expired', false]]);
  await mobile.getByRole('button', { name: '刷新', exact: true }).click();
  // The seat indicator sits beside the title and adds no height to the header.
  const chip = mobile.locator('#seat-chip');
  await expect(chip).toHaveText('CN 26%');
  await expect(chip).toHaveAttribute('data-level', 'ok');
  await expect(chip).toHaveAttribute('aria-label', /当前席位 Claude 🇨🇳 CN：5 小时剩余 26%/);
  expect((await mobile.locator('.app-header').boundingBox()).height).toBeLessThanOrEqual(60);
  expect((await chip.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await screenshot('chip-normal');
  // Closed: the drawer is inert and out of the tab order.
  await expect(mobile.locator('#drawer')).toBeHidden();
  expect(await mobile.locator('#drawer').evaluate((el) => el.inert)).toBe(true);
  // The menu button opens it: focus moves inside, everything behind is inert.
  await mobile.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  const drawer = mobile.locator('#drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(mobile.locator('#drawer-close')).toBeFocused();
  expect(await mobile.locator('#app').evaluate((app) => [...app.children].filter((el) => el.id !== 'drawer' && el.id !== 'scrim').every((el) => el.inert))).toBe(true);
  await expect(mobile.locator('#tabbar')).toBeVisible();
  // Captain first, then sessions grouped by project with a status each.
  await expect(drawer.locator('#drawer-captain')).toContainText('队长');
  await expect(drawer.locator('#drawer-captain')).toHaveAttribute('aria-current', 'page');
  await expect(drawer.locator('.session-group .nav-section-label')).toHaveText(['AgentDeck', '未分项目']);
  await expect(drawer.locator('.session-group').first().locator('.session-row')).toHaveText(/手机网页端 · 界面实现/);
  await expect(drawer.locator('[data-session-id="mobile-failed"] .row-tag')).toHaveText('失败');
  await expect(drawer.locator('#version')).toHaveText(/^V\d+\.\d+\.\d+/);
  // Quota: one row per account, in the desktop's order, the Captain's seat marked.
  const rows = drawer.locator('.quota-item');
  await expect(rows.locator('.quota-name-text')).toHaveText(['🇨🇳 CN', '🇺🇸 US', '🇺🇸 US2', 'Codex', 'Cursor', 'Gemini']);
  // 5h and 7d are named once, right above the two columns of every row.
  await expect(drawer.locator('#quota-columns span')).toHaveText(['5h', '7d']);
  // Read header and cells in ONE pass: the drawer slides in, and two separate reads straddle the animation.
  const columnLefts = await mobile.evaluate(() => {
    const left = (el) => Math.round(el.getBoundingClientRect().left);
    return [[...document.querySelectorAll('#quota-columns span')].map(left), [...document.querySelector('.quota-item').querySelectorAll('.quota-cell')].map(left)];
  });
  expect(columnLefts[0]).toEqual(columnLefts[1]);
  await expect(drawer.locator('.quota-item[data-captain="true"]')).toHaveAttribute('data-quota-key', 'Claude:cn');
  await expect(rows.nth(0).locator('.quota-captain')).toHaveAttribute('title', '队长在用');
  await expect(rows.nth(0).locator('.quota-cell[data-window="5h"] .quota-pct')).toHaveText('26%');
  await expect(rows.nth(0).locator('.quota-cell[data-window="5h"] .quota-reset')).toHaveText(/^\d\d:\d\d$/);
  await expect(rows.nth(0).locator('.quota-cell[data-window="7d"] .quota-pct')).toHaveText('61%');
  await expect(rows.nth(0).locator('.quota-cell[data-window="7d"] .quota-reset')).toHaveText(/^周[日一二三四五六]$/);
  expect(await rows.nth(0).locator('.quota-cell[data-window="5h"] .quota-meter').evaluate((el) => el.style.getPropertyValue('--pct'))).toBe('26%');
  await expect(rows.nth(0).locator('.quota-row-note')).toHaveCount(0);
  // Exhausted: a red cell with the no-entry mark and the time it comes back, on a tinted row.
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'out');
  const outCell = rows.nth(1).locator('.quota-cell[data-window="5h"]');
  await expect(outCell).toHaveAttribute('data-level', 'out');
  await expect(outCell.locator('.quota-ban svg')).toHaveCount(1);
  await expect(outCell.locator('.quota-pct')).toHaveCount(0);
  await expect(outCell.locator('.quota-reset')).toHaveText(/^\d\d:\d\d$/);
  await expect(rows.nth(1).locator('.quota-row')).toHaveAttribute('aria-label', /5 小时已用尽，\d\d:\d\d（2 小时 \d+ 分后）恢复/);
  await expect(rows.nth(1).locator('.quota-cell[data-window="7d"] .quota-pct')).toHaveText('40%');
  const red = await outCell.locator('.quota-reset').evaluate((el) => getComputedStyle(el).color);
  expect(red).toBe(await outCell.locator('.quota-ban').evaluate((el) => getComputedStyle(el).color));
  expect(red).not.toBe(await rows.nth(0).locator('.quota-pct').first().evaluate((el) => getComputedStyle(el).color));
  expect(await rows.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await rows.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor));
  // US2 is the upgraded third seat: same flag as US, named, unknown until it has a sample.
  await expect(rows.nth(2)).toHaveAttribute('data-quota-key', 'Claude:us2');
  await expect(rows.nth(2)).toHaveAttribute('data-status', 'unknown');
  await expect(rows.nth(2).locator('.quota-cell')).toHaveCount(0);
  await expect(rows.nth(2).locator('.quota-status')).toHaveText('未知');
  // A weekly-only account keeps both columns: a dash and an empty meter under 5h, never a number.
  await expect(rows.nth(3).locator('.quota-cell')).toHaveCount(2);
  await expect(rows.nth(3).locator('.quota-cell[data-window="5h"]')).toHaveAttribute('data-missing', 'true');
  await expect(rows.nth(3).locator('.quota-cell[data-window="5h"] .quota-pct')).toHaveText('—');
  expect(await rows.nth(3).locator('.quota-cell[data-window="5h"] .quota-meter').evaluate((el) => el.style.getPropertyValue('--pct'))).toBe('0%');
  await expect(rows.nth(3).locator('.quota-cell[data-window="7d"]')).toHaveAttribute('data-level', 'danger');
  await expect(rows.nth(3).locator('.quota-cell[data-window="7d"] .quota-pct')).toHaveText('8%');
  // Unknown and out-of-date rows say 未知 in grey and never show a percentage.
  await expect(rows.nth(4)).toHaveAttribute('data-status', 'unknown');
  await expect(rows.nth(4).locator('.quota-cell')).toHaveCount(0);
  await expect(rows.nth(4).locator('.quota-status')).toHaveText('未知');
  await expect(rows.nth(4).locator('.quota-row-note')).toHaveCount(0);
  await expect(rows.nth(5)).toHaveAttribute('data-status', 'expired');
  await expect(rows.nth(5).locator('.quota-cell')).toHaveCount(0);
  await expect(rows.nth(5).locator('.quota-status')).toHaveText('未知');
  await expect(rows.nth(5).locator('.quota-row-note')).toHaveText(/^数据已旧 · 采样 \d\d:\d\d$/);
  const grey = await rows.nth(5).locator('.quota-row-note').evaluate((el) => getComputedStyle(el).color);
  expect(await rows.nth(5).locator('.quota-status .quota-line').evaluate((el) => getComputedStyle(el).color)).toBe(grey);
  await expect(drawer).not.toContainText(/NaN|undefined/);
  // Brand colours on the marks, as on the desktop.
  const iconColor = (index) => rows.nth(index).locator('.quota-icon').evaluate((el) => getComputedStyle(el).color);
  expect(new Set([await iconColor(0), await iconColor(3), await iconColor(4), await iconColor(5)]).size).toBe(4);
  // Everything stays inside the drawer; tools are 44px icon buttons with a name.
  for (const [width, height] of [[390, 844], [430, 932]]) {
    await mobile.setViewportSize({ width, height });
    // The shell follows the visual viewport on its resize event.
    await expect.poll(async () => Math.round((await drawer.boundingBox()).height)).toBe(height);
    const box = await drawer.boundingBox(), quotaBox = await mobile.locator('#quota').boundingBox(), foot = await mobile.locator('.drawer-foot').boundingBox();
    expect(box.x).toBe(0); expect(box.y).toBe(0); expect(box.width).toBeLessThan(width);
    // Nothing stretches the shell, so focusing a row can never scroll the drawer away.
    expect(await mobile.locator('#app').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    expect(quotaBox.y + quotaBox.height).toBeLessThanOrEqual(foot.y + 1);
    expect(foot.y + foot.height).toBeLessThanOrEqual(height);
    expect(await drawer.locator('.quota-row, .session-row, .nav-row').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height >= 44))).toBe(true);
    for (const button of await drawer.locator('.icon-button:visible').evaluateAll((els) => els.map((el) => ({ ...el.getBoundingClientRect().toJSON(), label: el.getAttribute('aria-label'), title: el.title, text: el.textContent.trim() })))) {
      expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.label).toBeTruthy(); expect(button.title).toBeTruthy(); expect(button.text).toBe('');
    }
    for (const theme of ['dark', 'light']) {
      await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await screenshot(`sidebar-${width}-${theme}`);
    }
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  // A row opens its details in a sheet: full name, exact reset times, masked account, source and sample time.
  const sheet = mobile.locator('#quota-sheet');
  await expect(sheet).toBeHidden();
  await rows.nth(0).locator('.quota-row').click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('aria-modal', 'true');
  await expect(mobile.locator('#quota-sheet-close')).toBeFocused();
  await expect(mobile.locator('#quota-sheet-title')).toHaveText('Claude 🇨🇳 CN');
  await expect(mobile.locator('#quota-sheet-captain')).toHaveText('队长在用');
  const lines = sheet.locator('.sheet-line');
  await expect(lines).toHaveText([/^5 小时剩余 26%\d\d:\d\d（2 小时 \d+ 分后）重置$/, /^每周剩余 61%\d\d-\d\d \d\d:\d\d（[23] 天后）重置$/, '账号h***@gmail.com', '来源Claude OAuth usage', /^采样\d\d:\d\d$/]);
  await expect(sheet).not.toContainText('hjinhao');
  expect(await mobile.locator('#drawer').evaluate((el) => [...el.children].every((child) => child.id === 'quota-sheet' || child.id === 'quota-sheet-scrim' || child.inert))).toBe(true);
  for (const button of await sheet.locator('.icon-button').evaluateAll((els) => els.map((el) => ({ ...el.getBoundingClientRect().toJSON(), label: el.getAttribute('aria-label'), title: el.title, text: el.textContent.trim() })))) {
    expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.label).toBe('关闭详情'); expect(button.title).toBe('关闭详情'); expect(button.text).toBe('');
  }
  const sheetBox = await sheet.boundingBox(), drawerBox = await drawer.boundingBox();
  expect(sheetBox.x).toBeGreaterThanOrEqual(drawerBox.x); expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 1);
  expect(Math.round(sheetBox.y + sheetBox.height)).toBe(844);
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const theme of ['dark', 'light']) {
    await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(`quota-detail-390-${theme}`);
  }
  // Escape closes the sheet only and hands focus back to its row; the drawer stays.
  await mobile.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(rows.nth(0).locator('.quota-row')).toBeFocused();
  expect(await mobile.locator('#drawer').evaluate((el) => [...el.children].some((child) => child.inert))).toBe(false);
  // Exhausted and unknown accounts say so in words; the close icon and a tap outside both close.
  await rows.nth(1).locator('.quota-row').click();
  await expect(lines.nth(0)).toHaveText(/^5 小时已用尽\d\d:\d\d（2 小时 \d+ 分后）恢复$/);
  await expect(lines.nth(0)).toHaveAttribute('data-level', 'out');
  await screenshot('quota-detail-out-390-light');
  await mobile.locator('#quota-sheet-close').click();
  await expect(sheet).toBeHidden();
  await rows.nth(4).locator('.quota-row').click();
  await expect(mobile.locator('#quota-sheet-title')).toHaveText('Cursor Grok');
  await expect(lines).toHaveText(['5 小时未知', '每周未知', '状态暂无额度数据，等待桌面端下次采样', '账号未知', '来源未知', '采样暂无采样']);
  await mobile.locator('#quota-sheet-scrim').click({ position: { x: 20, y: 20 } });
  await expect(sheet).toBeHidden();
  await expect(drawer).toBeVisible();
  await mobile.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  // Side by side with the desktop sidebar the rows were taken from.
  if (process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR) {
    const dir = path.resolve(process.env.AGENTDECK_MOBILE_SCREENSHOT_DIR);
    await desktop.keyboard.press('Escape');
    for (const theme of ['dark', 'light']) {
      await desktop.evaluate((value) => applyTheme(value), theme);
      await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const images = [await desktop.locator('#colNav').screenshot(), await drawer.screenshot()].map((data) => 'data:image/png;base64,' + data.toString('base64'));
      const page = await browser.newPage({ viewport: { width: 760, height: 980 } });
      await page.setContent(`<body style="margin:0;padding:24px;font:14px -apple-system,sans-serif;background:${theme === 'dark' ? '#0e0e0e;color:#ddd' : '#ececec;color:#222'}"><div style="display:flex;gap:32px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="margin-bottom:10px">桌面端侧边栏</figcaption><img src="${images[0]}" style="height:844px"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:10px">手机端侧边栏（390×844）</figcaption><img src="${images[1]}" style="height:844px"></figure></div></body>`);
      await page.screenshot({ path: path.join(dir, `compare-desktop-vs-mobile-${theme}.png`), fullPage: true });
      await page.close();
    }
    await mobile.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  }
  // The refresh icon reads the desktop again; a failed read keeps the rows and says so.
  await mobile.route('**/api/quota', (route) => route.abort());
  await drawer.getByRole('button', { name: '刷新额度', exact: true }).click();
  await expect(mobile.locator('#quota-note')).toHaveText('未能更新');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0).locator('.quota-cell[data-window="5h"]')).toHaveAttribute('data-level', 'none');
  await mobile.unroute('**/api/quota');
  await drawer.getByRole('button', { name: '刷新额度', exact: true }).click();
  await expect(mobile.locator('#quota-note')).toHaveText('');
  await expect(rows.nth(0).locator('.quota-cell[data-window="5h"]')).toHaveAttribute('data-level', 'ok');
  // Escape closes and hands focus back; the scrim closes too.
  await mobile.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(mobile.locator('#menu')).toBeFocused();
  expect(await mobile.locator('.app-header').evaluate((el) => el.inert)).toBe(false);
  await mobile.locator('#menu').click();
  await expect(drawer).toBeVisible();
  await mobile.mouse.click(380, 400);
  await expect(drawer).toBeHidden();
  // A right swipe from the left edge opens it, a left swipe closes it; a swipe that starts elsewhere does nothing.
  const swipe = (fromX, toX) => mobile.evaluate(([from, to]) => {
    const touch = (x) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 400 });
    document.body.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(from)] }));
    document.body.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(to)] }));
    document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  }, [fromX, toX]);
  await swipe(120, 260);
  await expect(drawer).toBeHidden();
  await swipe(8, 120);
  await expect(drawer).toBeVisible();
  await swipe(200, 100);
  await expect(drawer).toBeHidden();
  // The indicator opens the drawer at the quota rows.
  await chip.click();
  await expect(drawer).toBeVisible();
  await expect(mobile.locator('#quota')).toBeFocused();
  await expect(rows.last()).toBeInViewport();
  // Picking a session closes the drawer and shows it; the Captain row returns to the conversation.
  await drawer.locator('[data-session-id="mobile-worker"]').click();
  await expect(drawer).toBeHidden();
  await expect(mobile.locator('#output-view')).toBeVisible();
  await expect(chip).toBeHidden();
  await tab(/会话/).click();
  await expect(drawer.locator('[data-session-id="mobile-worker"]')).toHaveAttribute('aria-current', 'page');
  await drawer.locator('#drawer-captain').click();
  await expect(mobile.locator('#captain-view')).toBeVisible();
  await expect(chip).toBeVisible();
  // Below 10% the indicator turns orange; exhausted is red; old data is grey, never a live number.
  await seedQuota('low');
  await expect(chip).toHaveText('CN 8%');
  await expect(chip).toHaveAttribute('data-level', 'low');
  await screenshot('chip-low');
  await seedQuota('out');
  await expect(chip).toHaveText('CN 用尽');
  await expect(chip).toHaveAttribute('data-level', 'out');
  await screenshot('chip-out');
  await seedQuota('stale');
  await expect(chip).toHaveText('CN 26%');
  await expect(chip).toHaveAttribute('data-level', 'none');
  await expect(chip).toHaveAttribute('aria-label', /（数据已旧）/);
  await chip.click();
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'stale');
  await expect(rows.nth(0).locator('.quota-cell[data-window="5h"]')).toHaveAttribute('data-level', 'none');
  await expect(rows.nth(0).locator('.quota-row-note')).toHaveText(/^数据已旧 · 采样 \d\d:\d\d$/);
  // Same grey as the note in whichever theme is showing.
  expect(await rows.nth(0).locator('.quota-cell[data-window="5h"] .quota-pct').evaluate((el) => getComputedStyle(el).color))
    .toBe(await rows.nth(0).locator('.quota-row-note').evaluate((el) => getComputedStyle(el).color));
  await rows.nth(0).locator('.quota-row').click();
  await expect(mobile.locator('#quota-sheet .sheet-line').nth(2)).toHaveText('状态数据已旧，数字仅供参考');
  await mobile.keyboard.press('Escape');
  for (const [width, height] of [[390, 844], [430, 932]]) {
    await mobile.setViewportSize({ width, height });
    for (const theme of ['dark', 'light']) {
      await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await screenshot(`sidebar-stale-${width}-${theme}`);
    }
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.keyboard.press('Escape');
  // The More page keeps one entry that leads to the same rows.
  await tab('更多').click();
  await expect(mobile.locator('#more-view .quota-item')).toHaveCount(0);
  await expect(mobile.locator('#quota-entry-text')).toHaveText('🇨🇳 CN 26%');
  await mobile.locator('#quota-entry').click();
  await expect(drawer).toBeVisible();
  await expect(mobile.locator('#quota')).toBeFocused();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('desktop copy buttons put the login token and entry password on the clipboard', async () => {
  await launch();
  // The real preload → main path. A test profile has a private clipboard, so
  // this never reads or replaces what the user has copied.
  const copies = async (id, label, value) => {
    const button = desktop.locator(id);
    const icon = await button.innerHTML();
    await expect(button).toHaveAttribute('title', label);
    await button.click();
    await expect(button).toHaveAttribute('aria-label', '已复制');
    await expect(button).toHaveAttribute('title', '已复制');
    expect(await desktop.evaluate(() => deck.clipboardRead()) === value).toBe(true);
    await expect(button).toHaveAttribute('aria-label', label, { timeout: 5000 });
    await expect(button).toHaveAttribute('title', label);
    expect(await button.innerHTML()).toBe(icon);
  };
  await copies('#mobileWebCopyToken', '复制登录 token', token);
  // The entry password comes from the tunnel installer's private file, which a
  // test profile never reads; show the field with a stand-in value.
  const entryPassword = 'stand-in-entry-password';
  await desktop.evaluate((value) => {
    document.getElementById('mobileWebGateway').hidden = false;
    document.getElementById('mobileWebGatewayPassword').value = value;
  }, entryPassword);
  await copies('#mobileWebCopyGateway', '复制入口口令', entryPassword);
  expect(await desktop.evaluate(() => deck.clipboardRead()) === token).toBe(false);
});

test('mobile message waits for desktop draft, goes only to Captain; forbidden controls reject', async () => {
  await launch(); await login();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.locator('#notificationSettingsClose').click();
  await desktop.evaluate(() => ChatUI.setMode('mobile-captain', 'chat'));
  await composer.fill('桌面尚未发送的草稿');
  const message = '手机消息只给队长';
  await mobile.getByLabel('给队长的消息').fill(message);
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('');
  await expect(composer).toHaveValue('桌面尚未发送的草稿');
  // Wait beyond the first delivery check while the genuine draft remains.
  await expect.poll(() => desktop.evaluate(() => userComposing('mobile-captain'))).toBe(true);
  expect(captures().some((t) => t.includes(message))).toBe(false);
  await composer.fill('');
  await expect.poll(() => captures().includes(message), { timeout: 25000 }).toBe(true);
  expect(await desktop.evaluate((text) => ChatUI.turnsOf('mobile-captain').some((t) => t.user === text), message)).toBe(true);
  const delivered = fs.readFileSync(path.join(profile, 'columns.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((p) => p.text === message);
  expect(delivered).toEqual([{ colId: 'mobile-captain', text: message }]);
  await expect(mobile.locator('#captain-turns')).toContainText(message, { timeout: 15000 });
  // Replying from a worker's page still goes only to the Captain, naming the worker.
  await tab(/会话/).click();
  await mobile.locator('#sessions [data-session-id="mobile-worker"]').click();
  await mobile.getByLabel('给队长的消息').fill('可以继续');
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已转给队长');
  const relayed = '关于队员「手机网页端 · 界面实现」：\n可以继续';
  await expect.poll(() => captures().includes(relayed), { timeout: 25000 }).toBe(true);
  expect(fs.readFileSync(path.join(profile, 'columns.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter((p) => p.text === relayed)).toEqual([{ colId: 'mobile-captain', text: relayed }]);
  expect((await post('/api/captain', { message, to: 'mobile-worker' })).status()).toBe(400);
  expect((await post('/api/tasks', { status: 'done' })).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/output?id=mobile-captain')).status()).toBe(404);
  expect((await mobile.request.get(url + '/api/sessions', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401);
  expect((await post('/api/captain', { message }, { Origin: 'https://other.example' })).status()).toBe(403);
  expect((await mobile.request.post(url + '/api/captain', { data: { message }, headers: { Origin: url } })).status()).toBe(403);
  expect((await post('/api/captain', { message }, { 'X-CSRF-Token': 'wrong-csrf' })).status()).toBe(403);
});

test('accepted mobile messages survive a blocked delivery attempt and isolated app restart', async () => {
  await launch(); await login();
  await desktop.locator('#notificationSettingsClose').click();
  const composer = desktop.locator('.column.is-main .composer textarea');
  await desktop.evaluate(() => ChatUI.setMode('mobile-captain', 'chat'));
  await composer.fill('阻止发送的桌面草稿');
  await desktop.evaluate(() => {
    const send = deckHost.sendWhenReady;
    deckHost.sendWhenReady = (col, text, opts) => { window.mobileDeliveryOptions = opts; return send(col, text, opts); };
  });
  const message = '重启后继续送达的手机消息';
  const oldAuth = await (await mobile.request.get(url + '/api/auth')).json();
  expect((await post('/api/captain', { message })).ok()).toBe(true);
  // A queued message with an image keeps its file path across the restart too.
  const upload = await mobile.request.post(url + '/api/upload', { data: await mobile.screenshot(), headers: { 'Content-Type': 'application/octet-stream', Origin: url, 'X-CSRF-Token': oldAuth.csrfToken } });
  const image = path.join(profile, 'mobile-uploads', (await upload.json()).id);
  expect((await post('/api/captain', { message: '重启后带图送达', images: [path.basename(image)] })).ok()).toBe(true);
  const queued = [message, { text: '重启后带图送达', atts: [image] }];
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.mobileMessages).toEqual(queued);
  // Simulate the existing channel's timeout callback; accepted text must stay
  // durable rather than being discarded when one delivery attempt gives up.
  await desktop.evaluate(() => mobileDeliveryOptions.onGiveUp());
  expect(await desktop.evaluate(() => MainSession.state().mobileMessages)).toEqual(queued);
  expect(captures().includes(message)).toBe(false);
  await restartDesktop();
  await expect.poll(() => captures().filter((t) => t === message).length, { timeout: 25000 }).toBe(1);
  await expect.poll(() => captures().filter((t) => t === image + ' 重启后带图送达').length, { timeout: 25000 }).toBe(1);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).mainSession.mobileMessages).toEqual([]);
  expect(await desktop.evaluate((text) => ChatUI.turnsOf('mobile-captain').some((t) => t.user === text), message)).toBe(true);
  const freshMessage = '重启后手机页面继续发送新指令';
  expect((await mobile.request.post(url + '/api/captain', { data: { message: freshMessage }, headers: { Origin: url, 'X-CSRF-Token': oldAuth.csrfToken } })).status()).toBe(403);
  await Promise.all([
    mobile.waitForResponse((response) => response.url() === url + '/api/auth' && response.ok()),
    mobile.getByRole('button', { name: '刷新', exact: true }).click(),
  ]);
  await mobile.getByLabel('给队长的消息').fill(freshMessage);
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect.poll(() => captures().filter((text) => text === freshMessage).length, { timeout: 25000 }).toBe(1);
});

test('device logout and desktop revocation reject remembered devices and rotate the login token', async () => {
  await launch(); await login();
  expect((await mobile.request.post(url + '/logout', { headers: { Origin: url } })).status()).toBe(403);
  await tab('更多').click();
  await mobile.getByRole('button', { name: '退出此设备', exact: true }).click();
  await expect(mobile.getByLabel('登录 token')).toBeVisible();
  expect((await mobile.request.get(url + '/api/sessions')).status()).toBe(401);
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
  const restored = await desktop.evaluate(() => deck.mobileWebSettings({ revoke: true }));
  expect(restored.token.length).toBeGreaterThanOrEqual(48);
  expect(restored.token !== token).toBe(true);
  expect((await mobile.request.get(url + '/api/sessions')).status()).toBe(401);
  await mobile.reload();
  await expect(mobile.getByLabel('登录 token')).toBeVisible();
  await mobile.getByLabel('登录 token').fill(token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('token 不正确');
  await mobile.getByLabel('登录 token').fill(restored.token);
  await mobile.getByRole('button', { name: '登录', exact: true }).click();
  await expect(mobile.locator('#captain-turns')).toContainText('队长测试回复：');
});

test('images picked or pasted on the phone upload, send with the text and reach the Captain as files', async () => {
  await launch(); await login();
  await desktop.locator('#notificationSettingsClose').click();
  const uploads = path.join(profile, 'mobile-uploads');
  const stored = () => fs.existsSync(uploads) ? fs.readdirSync(uploads) : [];
  const shot = await mobile.screenshot();
  const attach = mobile.getByRole('button', { name: '添加图片', exact: true });
  await expect(attach).toHaveAttribute('title', '添加图片');
  await expect(mobile.locator('#image-input')).toHaveAttribute('accept', 'image/*');
  await expect(mobile.locator('#image-input')).toHaveAttribute('multiple', '');
  // The icon button opens the system picker (photo library or camera on a phone).
  const [chooser] = await Promise.all([mobile.waitForEvent('filechooser'), attach.click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([{ name: '../../IMG 0001.png', mimeType: 'image/png', buffer: shot }, { name: 'IMG_0002.png', mimeType: 'image/png', buffer: shot }]);
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(2);
  await expect(mobile.locator('#send')).toBeEnabled();   // images alone can be sent
  // Client file names never reach the disk.
  expect(stored().length).toBe(2);
  expect(stored().every((name) => /^[a-f0-9]{32}\.png$/.test(name))).toBe(true);
  // Remove one by its icon button.
  const remove = mobile.getByRole('button', { name: '移除图片', exact: true });
  await expect(remove.first()).toHaveAttribute('title', '移除图片');
  await remove.first().click();
  await expect(mobile.locator('.attachment')).toHaveCount(1);
  // Paste a large image into the message box: it is shrunk to a JPEG first.
  const paste = (width, height) => mobile.evaluate(async ([w, h]) => {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const context = canvas.getContext('2d'), pixels = context.createImageData(w, h);
    for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new DataTransfer(); data.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
    document.getElementById('message').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return blob.size;
  }, [width, height]);
  expect(await paste(2400, 1200)).toBeGreaterThan(800 * 1024);
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(2);
  const shrunk = stored().find((name) => name.endsWith('.jpg'));
  expect(shrunk).toBeTruthy();
  expect(fs.statSync(path.join(uploads, shrunk)).size).toBeLessThan(800 * 1024);
  expect(await mobile.evaluate(async (id) => { const bitmap = await createImageBitmap(await (await fetch('/api/image?id=' + id)).blob()); return [bitmap.width, bitmap.height]; }, shrunk)).toEqual([1600, 800]);
  // A failed upload says so, blocks sending and can be retried.
  await mobile.route('**/api/upload', (route) => route.abort());
  await paste(40, 40);
  await expect(mobile.locator('.attachment[data-state="failed"]')).toHaveCount(1);
  await expect(mobile.locator('#send-status')).toContainText('可重试');
  await expect(mobile.locator('#send')).toBeDisabled();
  const buttons = await mobile.locator('#message-form .icon-button').evaluateAll((elements) => elements.map((button) => {
    const bounds = button.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, label: button.getAttribute('aria-label'), title: button.title, text: button.textContent };
  }));
  expect(buttons.map((button) => button.label).sort()).toEqual(['添加图片', '移除图片', '移除图片', '移除图片', '给队长发送消息', '重试上传'].sort());
  for (const button of buttons) {
    expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.title).toBeTruthy(); expect(button.text).toBe('');
  }
  await mobile.getByLabel('给队长的消息').fill('看下这三张截图');
  await screenshot('images-thumbs');
  // Remove and retry never share a point, keyboard down or up, and each keeps
  // a 44px target; the retry icon's centre belongs to retry.
  const targets = () => mobile.locator('.attachment').evaluateAll((chips) => chips.flatMap((chip) => [...chip.querySelectorAll('.icon-button')].map((button) => {
    const box = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
    const x = icon.left + icon.width / 2, y = icon.top + icon.height / 2;
    return { label: button.getAttribute('aria-label'), left: box.left, top: box.top, right: box.right, bottom: box.bottom, x, y, hit: document.elementFromPoint(x, y)?.closest('button') === button };
  })));
  const separate = async () => {
    const boxes = await targets();
    expect(boxes.map((box) => box.label)).toEqual(['移除图片', '移除图片', '重试上传', '移除图片']);
    for (const box of boxes) {
      expect(box.right - box.left).toBeGreaterThanOrEqual(44); expect(box.bottom - box.top).toBeGreaterThanOrEqual(44);
      expect(box.hit).toBe(true);
      for (const other of boxes) if (other !== box) expect(box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom).toBe(false);
    }
    return boxes.find((box) => box.label === '重试上传');
  };
  await separate();
  await mobile.setViewportSize({ width: 390, height: 420 });
  await expect(mobile.locator('#tabbar')).toBeHidden();
  await expect.poll(() => mobile.locator('.attachment[data-state="done"]').first().evaluate((chip) => chip.getBoundingClientRect().width)).toBe(48);
  expect(await mobile.locator('.attachments').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const retry = await separate();
  await screenshot('images-failed-keyboard');
  // Keyboard up: a tap on the centre of the retry icon retries; it must not remove.
  await mobile.unroute('**/api/upload');
  await mobile.touchscreen.tap(retry.x, retry.y);
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(3);
  await expect(mobile.locator('.attachment')).toHaveCount(3);
  // The tap left the message box focused, so nothing moved under the finger.
  await expect(mobile.getByLabel('给队长的消息')).toBeFocused();
  await expect(mobile.locator('#tabbar')).toBeHidden();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await expect(mobile.locator('#tabbar')).toBeVisible();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const ids = stored();
  expect(ids.length).toBe(4);   // three attached, one removed before sending
  // Sent together with the text; the Captain's terminal receives the saved
  // files as paths in front of the message, like a screenshot pasted on the desktop.
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect(mobile.locator('.attachment')).toHaveCount(0);
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('');
  await expect.poll(() => captures().some((text) => text.endsWith(' 看下这三张截图')), { timeout: 25000 }).toBe(true);
  const typed = captures().find((text) => text.endsWith(' 看下这三张截图'));
  const sentIds = ids.filter((id) => typed.includes(path.join(uploads, id)));
  expect(sentIds.length).toBe(3);
  for (const id of sentIds) expect(fs.statSync(path.join(uploads, id)).isFile()).toBe(true);
  const turn = await desktop.evaluate(() => ChatUI.turnsOf('mobile-captain').find((t) => t.user === '看下这三张截图'));
  expect(turn.atts.map((file) => path.basename(file)).sort()).toEqual([...sentIds].sort());
  // The phone shows its own images as thumbnails in the conversation.
  const sent = mobile.locator('#captain-turns .captain-turn').filter({ hasText: '看下这三张截图' }).locator('.sent-image img');
  await expect(sent).toHaveCount(3, { timeout: 15000 });
  await expect.poll(() => sent.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Loaded images never push the newest reply out of view: still at the bottom.
  const gap = () => mobile.locator('#captain-turns').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  expect(await gap()).toBeLessThanOrEqual(1);
  await screenshot('images-sent');
  // A single image (a tall screenshot) is the common case and behaves the same,
  // right after sending, once it has loaded, and after the next refreshes.
  const [single] = await Promise.all([mobile.waitForEvent('filechooser'), attach.click()]);
  await single.setFiles([{ name: 'one.png', mimeType: 'image/png', buffer: shot }]);
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(1);
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  const one = mobile.locator('#captain-turns .captain-turn').last().locator('.sent-image img');
  await expect(one).toHaveCount(1, { timeout: 25000 });
  expect(await gap()).toBeLessThanOrEqual(1);
  await expect.poll(() => one.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await one.evaluate((image) => image.naturalHeight > image.naturalWidth)).toBe(true);
  expect(await gap()).toBeLessThanOrEqual(1);
  await expect(mobile.locator('#captain-turns .captain-turn').last()).toBeInViewport({ ratio: 1 });
  for (let i = 0; i < 2; i++) await Promise.all([mobile.waitForResponse((response) => response.url() === url + '/api/captain' && response.ok()), mobile.getByRole('button', { name: '刷新', exact: true }).click()]);
  expect(await gap()).toBeLessThanOrEqual(1);
  await screenshot('image-single-sent');
  ids.push(...stored().filter((id) => !ids.includes(id)));
  // Refused uploads: no login, no CSRF, wrong origin, not an image, too large.
  const png = { 'Content-Type': 'application/octet-stream', Origin: url };
  const { csrfToken } = await (await mobile.request.get(url + '/api/auth')).json();
  const anonymous = await browser.newContext();
  expect((await anonymous.request.post(url + '/api/upload', { data: shot, headers: { ...png, 'X-CSRF-Token': csrfToken } })).status()).toBe(401);
  expect((await anonymous.request.get(url + '/api/image?id=' + sentIds[0])).status()).toBe(401);
  await anonymous.close();
  expect((await mobile.request.post(url + '/api/upload', { data: shot, headers: png })).status()).toBe(403);
  expect((await mobile.request.post(url + '/api/upload', { data: shot, headers: { ...png, 'X-CSRF-Token': 'wrong-csrf' } })).status()).toBe(403);
  expect((await mobile.request.post(url + '/api/upload', { data: shot, headers: { ...png, Origin: 'https://other.example', 'X-CSRF-Token': csrfToken } })).status()).toBe(403);
  expect((await mobile.request.post(url + '/api/upload', { data: Buffer.from('<script>alert(1)</script>'), headers: { ...png, 'X-CSRF-Token': csrfToken } })).status()).toBe(415);
  expect((await mobile.request.post(url + '/api/upload', { data: Buffer.concat([shot, Buffer.alloc(4 * 1024 * 1024)]), headers: { ...png, 'X-CSRF-Token': csrfToken } })).status()).toBe(413);
  expect((await mobile.request.get(url + '/api/image?id=../config.json')).status()).toBe(400);
  expect((await post('/api/captain', { message: '看图', images: ['../config.json'] })).status()).toBe(400);
  expect(stored().length).toBe(5);
  if (process.platform !== 'win32') for (const id of stored()) expect(fs.statSync(path.join(uploads, id)).mode & 0o777).toBe(0o600);
});

test('the reload icon reloads the whole page and keeps the unsent text and finished images', async () => {
  await launch(); await login();
  await desktop.locator('#notificationSettingsClose').click();
  const reload = mobile.locator('#reload'), refresh = mobile.locator('#refresh');
  // An icon button next to refresh, with a different icon, a name, a tooltip and a 44px target.
  await expect(mobile.getByRole('button', { name: '重新加载页面', exact: true })).toBeVisible();
  await expect(reload).toHaveAttribute('title', '重新加载页面');
  await expect(reload).toHaveText('');
  expect(await reload.evaluate((el) => el.nextElementSibling?.id)).toBe('refresh');
  expect(await reload.locator('svg').innerHTML()).not.toBe(await refresh.locator('svg').innerHTML());
  const box = await reload.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect((await mobile.locator('.app-header').boundingBox()).height).toBeLessThanOrEqual(60);
  for (const theme of ['dark', 'light']) {
    await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(`reload-${theme}`);
  }
  // Reachable from the keyboard: Shift+Tab from refresh lands on it.
  await refresh.focus();
  await mobile.keyboard.press('Shift+Tab');
  await expect(reload).toBeFocused();
  // It stays on every page, including More where refresh is hidden.
  await tab('更多').click();
  await expect(reload).toBeVisible();
  await expect(refresh).toBeHidden();
  await tab('对话').click();
  // A draft with text and an uploaded image survives the reload.
  const [chooser] = await Promise.all([mobile.waitForEvent('filechooser'), mobile.getByRole('button', { name: '添加图片', exact: true }).click()]);
  await chooser.setFiles([{ name: 'draft.png', mimeType: 'image/png', buffer: await mobile.screenshot() }]);
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(1);
  await mobile.getByLabel('给队长的消息').fill('重新加载前写的草稿\n第二行');
  await mobile.evaluate(() => { window.beforeReload = true; });
  await Promise.all([mobile.waitForEvent('load'), reload.click()]);
  expect(await mobile.evaluate(() => window.beforeReload)).toBeUndefined();
  await expect(mobile.locator('#captain-view')).toBeVisible();
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('重新加载前写的草稿\n第二行');
  await expect(mobile.locator('.attachment[data-state="done"]')).toHaveCount(1);
  expect(await mobile.locator('.attachment img').evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
  // The saved copy is used once; a second reload does not bring it back after sending.
  expect(await mobile.evaluate(() => sessionStorage.getItem('agentdeck-mobile-draft'))).toBeNull();
  await mobile.getByRole('button', { name: '给队长发送消息', exact: true }).click();
  await expect(mobile.locator('#send-status')).toContainText('已排队');
  await expect.poll(() => captures().some((text) => text.endsWith('第二行')), { timeout: 25000 }).toBe(true);
  expect(captures().find((text) => text.endsWith('第二行'))).toMatch(/mobile-uploads[\\/][a-f0-9]{32}\.png/);
  await Promise.all([mobile.waitForEvent('load'), reload.click()]);
  await expect(mobile.locator('#captain-view')).toBeVisible();
  await expect(mobile.getByLabel('给队长的消息')).toHaveValue('');
  await expect(mobile.locator('.attachment')).toHaveCount(0);
});

test('a long exchange reads as one message and one Captain reply, with the process folded', async () => {
  const T = Date.now() - 6 * 3600_000, min = 60_000;
  const full = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：手机网页端要和电脑端一致，一来一回，别把派活标题当成我说的话。`).join('\n');
  const task = (n, title, summary) => ({ kind: 'task', id: 'task-' + n, ts: T + n * min, user: title, done: true, atts: [], reply: summary,
    task: { colId: 'w' + n, title, status: 'done', receipt: { summary, failed: '', question: '', files: [], images: [], explicit: true } } });
  let longFile = '';
  await launch([
    { id: 'demo-user', ts: T, user: full.slice(0, 2000) + `\n…（全文 ${full.length} 字，见附件）`, reply: '收到，我先拆成三件活。', done: true, atts: [], steps: ['Read(board.md)', 'Bash(git status)'] },
    task(1, '手机网页额度显示接手收尾', '额度表格已核对。'),
    task(2, '登录与鉴权验收', '鉴权通过。'),
    task(3, '深浅主题截图', '截图已生成。'),
    { kind: 'notice', id: 'notice-1', ts: T + 5 * min, user: '永动机', reply: '已切换座位。', done: true, atts: [] },
    { id: 'receipt-1', ts: T + 8 * min, user: '', reply: '三件活都回来了：额度和鉴权没问题。', done: true, atts: [] },
    { id: 'receipt-2', ts: T + 9 * min, user: '', reply: '截图也齐了，可以验收。', done: true, atts: [] },
    { id: 'bg-1', ts: T + 4 * 3600_000, user: '', reply: '后台回执：夜间巡检完成，没有异常。', done: true, atts: [] },
    { id: 'bg-2', ts: T + 4 * 3600_000 + min, user: '', reply: '补充：磁盘空间充足。', done: true, atts: [] },
  ], (dir) => {
    fs.mkdirSync(path.join(dir, 'long-prompts'));
    longFile = path.join(dir, 'long-prompts', 'prompt-20260101-000000-abc123.txt');
    fs.writeFileSync(longFile, full);
  });
  // The clipped copy points at the saved file, as the desktop writes it.
  const chatFile = path.join(profile, 'chats', 'mobile-captain.json');
  const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
  chat.turns[0].atts = [longFile]; fs.writeFileSync(chatFile, JSON.stringify(chat));
  await desktop.reload();
  await expect(desktop.locator('.column.is-main')).toHaveCount(1, { timeout: 20000 });
  await login();
  const log = mobile.locator('#captain-turns');
  await expect(log).not.toContainText('本次处理已结束');
  const first = log.locator('.captain-turn').first();
  // One bubble with the whole text (not the clipped copy), folded until expanded.
  await expect(first.locator('.user-message')).toHaveCount(1);
  await expect(first.locator('.user-message .chat-text')).toHaveText(full);
  await expect(first.locator('.user-message .chat-text')).toHaveClass(/clamped/);
  await first.getByRole('button', { name: '展开全文' }).click();
  await expect(first.locator('.user-message .chat-text')).not.toHaveClass(/clamped/);
  await first.getByRole('button', { name: '收起' }).click();
  // The Captain's words in order, in one block; task titles are not messages.
  await expect(first.locator('.captain-message')).toHaveCount(1);
  await expect(first.locator('.captain-message')).toContainText('收到，我先拆成三件活。');
  await expect(first.locator('.captain-message')).toContainText('截图也齐了，可以验收。');
  await expect(first.locator('.user-message')).not.toContainText('手机网页额度显示接手收尾');
  await expect(log.locator('.user-message', { hasText: '手机网页额度显示接手收尾' })).toHaveCount(0);
  await expect(first.locator('.process > summary')).toHaveText(/过程：派了 3 件活/);
  await expect(first.locator('.process-list')).toBeHidden();
  await first.locator('.process > summary').click();
  await expect(first.locator('.process-list')).toContainText('手机网页额度显示接手收尾');
  await first.locator('.process > summary').click();
  // Background talk without a message of yours: left-aligned, merged, no empty bubble.
  const background = log.locator('.captain-turn', { hasText: '后台回执：夜间巡检完成' });
  await expect(background.locator('.user-message')).toHaveCount(0);
  await expect(background.locator('.captain-message')).toContainText('补充：磁盘空间充足。');
  await mobile.locator('#captain-turns').evaluate((el) => { el.scrollTop = 0; });
  await first.scrollIntoViewIfNeeded();
  for (const theme of ['light', 'dark']) {
    await mobile.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await first.evaluate((el) => el.scrollIntoView());
    await screenshot(`chat-flow-${theme}`);
    await first.getByRole('button', { name: '展开全文' }).click();
    await first.locator('.process > summary').click();
    await screenshot(`chat-flow-expanded-${theme}`);
    await first.getByRole('button', { name: '收起' }).click();
    await first.locator('.process > summary').click();
  }
});
