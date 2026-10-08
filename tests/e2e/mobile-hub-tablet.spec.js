const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHub, withRelay } = require('../fixtures/hub-proxy');

// The hub on a tablet lying on its side (desktop layout, preview pane on the
// right), on a phone (preview as a bottom sheet) and on a tablet held upright,
// against two fake computers whose file reads go through the real rules
// (file-preview-core) over a stand-in home folder. Nothing real is read.
let hub, context, page, problems, home;

function makeHome() {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tablet-')));
  const put = (rel, data) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const report = put('reports/r/review.md', '# 验收报告\n\n| 项 | 结果 |\n| --- | --- |\n| 单测 | **通过** |\n\n<script>window.hubInjected=1</script>\n\n见 [日志](run.log)\n');
  put('reports/r/run.log', 'line 1\nline 2\n');
  put('reports/r/shot.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636060606000000005000126e5a31b0000000049454e44ae426082', 'hex'));
  put('reports/r/pack.zip', Buffer.alloc(300, 1));
  const tax = put('Documents/tax.txt', 'private');
  const key = put('.ssh/id_ed25519', 'KEY');
  fs.symlinkSync(tax, path.join(home, 'reports/r/linked.md'));
  return { report, tax, key };
}
async function open(browser, size, { theme = 'dark' } = {}) {
  const files = makeHome();
  const [mac, win] = withRelay();
  const reply = ['验收完了，**可以发版**，报告：', files.report, '', '| 事 | 交给谁 |', '| --- | --- |', '| 修测试 | *Codex* |', '',
    '```sh', 'npm test', '```', '', `截图 ${path.join(home, 'reports/r/shot.png')} 安装包 ${path.join(home, 'reports/r/pack.zip')}`,
    `链接文件 ${path.join(home, 'reports/r/linked.md')} 密钥 ${files.key}`].join('\n');
  // Earlier rounds, so the conversation is taller than the screen.
  const earlier = Array.from({ length: 8 }, (_, i) => [{ id: 'e' + i, ts: Date.now() - 900000 + i * 1000, user: `第 ${i + 1} 个问题`, reply: '', done: true, interrupted: false },
    { id: 'r' + i, ts: Date.now() - 899000 + i * 1000, user: '', reply: `第 ${i + 1} 个回答，写得长一点，好让对话超过一屏。`.repeat(3), done: true, interrupted: false }]).flat();
  mac.turns = [...earlier, { id: 'm1', ts: Date.now() - 60000, user: `看看 ${files.tax}`, reply: '', done: true, interrupted: false },
    { id: 'm2', ts: Date.now() - 50000, user: '', reply, done: true, interrupted: false }];
  mac.files = { home, tmp: path.join(home, 'none') };
  hub = await startHub({ machines: [mac, win] });
  context = await browser.newContext({ viewport: size, isMobile: size.width < 600, hasTouch: true, colorScheme: theme, permissions: ['clipboard-read', 'clipboard-write'] });
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
  await expect(page.getByRole('article', { name: 'Windows', exact: true }).getByText('自动更新中')).toBeVisible();
  return files;
}
const captainView = () => page.evaluate(() => (document.querySelector('.wide [data-side-view="captain"]') || document.querySelector('[data-view="captain"]')).click());
const fileLink = (text) => page.locator('#captain-turns a.file-link', { hasText: text }).first();
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
test.afterEach(async () => {
  const seen = problems || [];
  if (context) await context.close(); context = null;
  if (hub) await hub.close(); hub = null;
  if (home) fs.rmSync(home, { recursive: true, force: true }); home = null;
  expect(seen).toEqual([]);
});

test('tablet on its side: the desktop layout, Markdown replies, and files open in the right-hand pane', async ({ browser }) => {
  await open(browser, { width: 1366, height: 1024 });
  // Sidebar with the pages, each computer's Captain with its sessions, the quota; no bottom tabs.
  const sidebar = page.getByRole('complementary', { name: '侧边栏' });
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await expect(sidebar.getByRole('button', { name: /^Mac 队长/ })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: /^Windows 队长/ })).toBeVisible();
  await expect(sidebar.locator('.side-quota .quota-row').first()).toBeVisible();
  await captainView();
  // The reply is laid out: a real table, bold, italics, a code block with its copy button. No bars and dashes.
  const reply = page.locator('#captain-turns .bubble-md').last();
  await expect(reply.locator('table th')).toHaveText(['事', '交给谁']);
  await expect(reply.locator('strong', { hasText: '可以发版' })).toBeVisible();
  await expect(reply.locator('em', { hasText: 'Codex' })).toBeVisible();
  await expect(reply.locator('pre.md-code')).toContainText('npm test');
  await expect(reply.getByRole('button', { name: '复制这段代码' })).toBeVisible();
  await expect(reply).not.toContainText('| ---');
  expect(await noOverflow()).toBe(true);
  // A path opens beside the conversation; the conversation stays usable.
  await fileLink('review.md').click();
  const pane = page.locator('#preview');
  await expect(pane).toHaveAttribute('role', 'complementary');
  await expect(pane.locator('.pv-md h1')).toHaveText('验收报告');
  await expect(pane.locator('.pv-md table td strong')).toHaveText('通过');
  await expect(page.locator('#preview-scrim')).toBeHidden();
  await expect(page.locator('#message')).toBeEditable();
  // Script in the file stays text.
  expect(await page.evaluate(() => window.hubInjected)).toBeUndefined();
  await expect(pane.locator('script')).toHaveCount(0);
  // A link inside the file opens next to it; the back icon returns.
  await pane.locator('a.file-link', { hasText: '日志' }).click();
  await expect(pane.locator('.pv-src')).toContainText('line 2');
  await pane.getByRole('button', { name: '回到上一个文件' }).click();
  await expect(pane.locator('.pv-md h1')).toHaveText('验收报告');
  // Tool actions are icon buttons with a name, a tooltip and room for a finger.
  for (const button of await pane.locator('.preview-actions button').all()) {
    expect(await button.getAttribute('aria-label')).toBeTruthy();
    expect(await button.getAttribute('title')).toBeTruthy();
    expect(await button.textContent()).toBe('');
    const box = await button.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  await fileLink('shot.png').click();
  await expect(pane.locator('img.pv-image')).toBeVisible();
  await fileLink('pack.zip').click();
  await expect(pane.locator('.pv-empty')).toContainText('不能在这里预览');
  await expect(pane.locator('.pv-empty')).toContainText('300 B');
  await pane.getByRole('button', { name: '关闭预览' }).click();
  await expect(pane).toBeHidden();
});

test('what may not be read is refused on the screen and by the computer: unnamed, ../, a link out, a key', async ({ browser }) => {
  const files = await open(browser, { width: 1366, height: 1024 });
  await captainView();
  for (const name of ['linked.md', 'id_ed25519']) {
    await fileLink(name).click();
    await expect(page.locator('#preview .pv-empty[role="alert"]')).toContainText('不在可以查看的范围里');
  }
  // Straight at the API, as anyone logged in could: refused the same way.
  const csrf = await page.evaluate(async () => (await (await fetch('/mac/api/snapshot')).json()).csrfToken);
  const post = (body) => page.evaluate(async ([body, csrf]) => {
    const r = await fetch('/mac/api/file', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    return [r.status, (await r.json()).code];
  }, [body, csrf]);
  // the user's own message named the tax file: that opens nothing
  expect(await post({ path: files.tax })).toEqual([403, 'denied']);
  expect(await post({ path: path.join(home, 'reports/r/../../Documents/tax.txt') })).toEqual([403, 'denied']);
  expect(await post({ path: path.join(home, 'reports/r/linked.md') })).toEqual([403, 'denied']);
  expect(await post({ path: files.key })).toEqual([403, 'denied']);
  expect(await post({ path: '/etc/hosts' })).toEqual([403, 'denied']);
  expect((await post({ path: files.report }))[0]).toBe(200);
});

test('phone: unchanged bottom tabs, and a file opens in a sheet that goes full screen and closes', async ({ browser }) => {
  await open(browser, { width: 440, height: 956 });
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '侧边栏' })).toBeHidden();
  await captainView();
  const reply = page.locator('#captain-turns .bubble-md').last();
  await expect(reply.locator('table')).toBeVisible();
  expect(await noOverflow()).toBe(true);
  // Scrolled up to read: a button brings the newest reply back.
  const jump = page.getByRole('button', { name: '回到最新' });
  await expect(jump).toBeHidden();
  await page.locator('#captain-turns').evaluate((el) => { el.scrollTop = 0; });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  // A table wider than the bubble scrolls inside its own frame.
  expect(await reply.locator('.md-table').evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await fileLink('review.md').click();
  const sheet = page.locator('#preview');
  await expect(sheet).toHaveAttribute('role', 'dialog');
  await expect(sheet).toHaveAttribute('data-snap', 'half');
  await expect(page.locator('#preview-scrim')).toBeVisible();
  await expect(sheet.locator('.pv-md h1')).toHaveText('验收报告');
  // Tap the handle: full screen; drag the handle down: closed.
  await page.locator('#preview-grip').click();
  await expect(sheet).toHaveAttribute('data-snap', 'full');
  // Let it finish rising before taking hold of the handle.
  await expect.poll(() => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThanOrEqual(1);
  const grip = await page.locator('#preview-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let y = grip.y; y < 900; y += 60) await page.mouse.move(grip.x + grip.width / 2, y);
  await page.mouse.up();
  await expect(sheet).toBeHidden();
  // Esc and the scrim close it too, and the focus goes back to the link.
  await fileLink('review.md').click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await fileLink('review.md').click();
  await page.locator('#preview-scrim').click({ position: { x: 20, y: 20 } });
  await expect(sheet).toBeHidden();
});

test('tablet held upright: the desktop sidebar, and a file opens as a sheet over the page', async ({ browser }) => {
  await open(browser, { width: 1024, height: 1366 });
  await expect(page.getByRole('complementary', { name: '侧边栏' })).toBeVisible();
  await captainView();
  expect(await noOverflow()).toBe(true);
  await fileLink('review.md').click();
  await expect(page.locator('#preview')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#preview .pv-md h1')).toHaveText('验收报告');
});

test('a computer still on an AgentDeck without file previews: the layout works, a path says to upgrade instead of failing', async ({ browser }) => {
  await open(browser, { width: 1366, height: 1024 });
  // As 1.8.0 answers: no api/file route, so a plain JSON 404 and no "files" capability.
  hub.machines.mac.files = null;
  await captainView();
  await expect(page.getByRole('complementary', { name: '侧边栏' })).toBeVisible();
  await expect(page.locator('#captain-turns .bubble-md table').last()).toBeVisible();
  await expect(page.locator('#message-form').getByRole('button', { name: '添加图片', exact: true })).toBeEnabled();
  await fileLink('review.md').click();
  await expect(page.locator('#preview .pv-empty[role="alert"]')).toContainText('还是旧版，升级以后才能在这里看文件');
  expect(hub.machines.mac.fileReads).toEqual([]);
  await page.getByRole('button', { name: '关闭预览' }).click();
  await expect(page.locator('#message')).toBeEditable();
});
