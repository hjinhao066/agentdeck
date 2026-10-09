const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const data = require('../fixtures/deliverables-chat');

// 队长's conversation page: the 交付文件 panel on the right lists the result
// files from 队长's replies and the crew's receipts (also from before a context
// clear), newest first by day, one row per path, process files left out; and
// the reading column stands left of centre. Real renderer, isolated userData,
// stand-in TUI. Set AGENTDECK_DELIVERABLES_SHOTS to a folder to keep PNGs
// (AGENTDECK_DELIVERABLES_STAGE names the subfolder, "after" by default).
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_DELIVERABLES_SHOTS;
const stage = process.env.AGENTDECK_DELIVERABLES_STAGE || 'after';
const CAPTAIN = 'captain', OLD = 'captain-old1', LOGIN = 'w-login', EXPORT = 'w-export';
let application, page, profile, out, list;
const errors = [];
test.describe.configure({ mode: 'serial' });

const col = () => page.locator(`.column[data-col-id="${CAPTAIN}"]`);
const panel = () => col().locator('.dlv');
const toggle = () => col().locator('.col-head .dlv-toggle');
const rows = () => panel().locator('.dlv-row');
const row = (name) => panel().locator('.dlv-row', { has: page.locator('.dlv-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
const park = async () => { const size = page.viewportSize(); await page.mouse.move(size.width - 3, size.height - 3); };
const names = () => rows().locator('.dlv-name').allTextContents();

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-deliverables-')));
  out = path.join(profile, 'work');
  list = data.files(out);
  for (const r of list.results) if (r.made) { fs.mkdirSync(path.dirname(r.path), { recursive: true }); fs.writeFileSync(r.path, data.body(r.name)); }
  for (const p of list.process.filter((p) => p.startsWith(out))) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data.body(path.basename(p))); }
  const built = data.build(out, Date.now(), { CAPTAIN, OLD, LOGIN, EXPORT, FAKE });
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  for (const [id, chat] of Object.entries(built.chats)) fs.writeFileSync(path.join(profile, 'chats', id + '.json'), JSON.stringify(chat));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(built.config));
  const env = { ...process.env, ZDOTDIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1680, height: 1000 });
  await application.evaluate(({ shell }) => {
    global.revealed = [];
    shell.showItemInFolder = (p) => { global.revealed.push(p); };
    shell.openPath = async (p) => { global.revealed.push(p); return ''; };
  });
  await expect.poll(() => page.evaluate((ids) => typeof terms !== 'undefined' && ids.every((i) => terms.has(i)), [CAPTAIN, LOGIN, EXPORT]), { timeout: 30000 }).toBe(true);
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), CAPTAIN);
  await page.evaluate(() => columns.forEach((c) => ChatUI.setMode(c.id, 'chat')));
  await expect(col().locator('.msg.assistant .reply.md').first()).toBeVisible();
  await park();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function shoot(name) {
  if (!shots) return;
  const dir = path.join(shots, stage);
  fs.mkdirSync(dir, { recursive: true });
  await park();
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.evaluate((i) => { const s = document.querySelector(`.column[data-col-id="${i}"] .chat-scroll`); s.scrollTop = s.scrollHeight; }, CAPTAIN);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(dir, name + '.png'), animations: 'disabled', scale: 'css' });
}

test('the panel lists the result files newest first by day, and leaves process files out', async () => {
  await expect(panel()).toBeVisible();
  await expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  const results = list.results.map((r) => r.name);
  await expect(rows()).toHaveCount(results.length);
  expect((await names()).sort()).toEqual([...results].sort());
  for (const p of list.process) expect(await names(), p).not.toContain(path.basename(p));
  // days: today, yesterday, then the conversation from before the clear
  const old = await page.evaluate(() => DeliverablesCore.dayLabel(ChatUI.captainArchives()[0].turns[0].ts, Date.now()));
  await expect(panel().locator('.dlv-day')).toHaveText(['今天', '昨天', old]);
  await expect(panel().locator('.dlv-count')).toHaveText(String(results.length));
  // newest first: the last thing 队长 said comes first, the old plan last
  const shown = await names();
  expect(shown.indexOf('上线清单.md')).toBeLessThan(shown.indexOf('周报-第41周.md'));
  expect(shown.at(-1)).toBe('old-plan.md');
  expect(shown.slice(-4, -1).sort()).toEqual(['missing-summary.md', '经营分析.pptx', '需求说明.docx'].sort());
});

test('one row per path: the latest mention wins, and each row says where it came from', async () => {
  // design-review.md was mentioned before the clear and twice today: listed once, under today's last mention
  await expect(row('design-review.md')).toHaveCount(1);
  const four = await page.evaluate((i) => ChatUI.turnsOf(i).find((t) => t.id === 'l-4').ts, CAPTAIN);
  await expect(row('design-review.md').locator('time')).toHaveAttribute('datetime', new Date(four).toISOString());
  await expect(row('design-review.md').locator('.dlv-from')).toHaveText('队长回复');
  // a receipt: the session that delivered it last and its project
  await expect(row('登录流程说明.md').locator('.dlv-project')).toHaveText('客户门户');
  await expect(row('登录流程说明.md').locator('.dlv-from')).toHaveText('登录与权限');
  await expect(row('q3-summary.pdf').locator('.dlv-project')).toHaveText('报表服务');
  // a session that is gone: the task it did
  await expect(row('logo.svg').locator('.dlv-from')).toHaveText('品牌素材');
  // a file 队长 mentioned takes the project of the folder it sits in
  await expect(row('周报-第41周.md').locator('.dlv-project')).toHaveText('客户门户');
  // the conversation from before the clear
  await expect(row('old-plan.md').locator('.dlv-from')).toHaveText('清空前的队长对话');
  // the whole story in the tooltip
  expect(await row('q3-summary.pdf').locator('.dlv-main').getAttribute('title')).toContain('第三季度报表和预算');
});

test('a file no longer on disk is greyed out and says so; the others open in the preview pane', async () => {
  const gone = row('missing-summary.md');
  await expect(gone).toHaveClass(/gone/);
  await expect(gone.locator('.dlv-main')).toHaveAttribute('aria-disabled', 'true');
  expect(await gone.locator('.dlv-main').getAttribute('title')).toContain('已不在磁盘上');
  await expect(row('周报-第41周.md')).not.toHaveClass(/gone/);
  const opacity = await gone.locator('.dlv-name').evaluate((n) => getComputedStyle(n.closest('.dlv-main')).opacity);
  expect(Number(opacity)).toBeLessThan(0.75);
  await gone.locator('.dlv-main').click({ force: true });
  await expect(page.locator('#toast')).toContainText('已经不在磁盘上');
  await expect(page.locator('#sidePane')).toBeHidden();
  // a Markdown file opens in the existing preview pane
  await row('周报-第41周.md').locator('.dlv-main').click();
  await expect(page.locator('#sidePane')).toBeVisible();
  await expect(page.locator('#sidePane .pv-md h1')).toHaveText('周报-第41周');
  await page.evaluate(() => SidePane.hide());
});

test('row actions are icon buttons with a tooltip, a name, a focus ring and room to click', async () => {
  const r = row('q3-summary.pdf');
  const tools = r.locator('.dlv-actions button');
  await expect(tools).toHaveCount(3);
  for (const b of await tools.all()) {
    const label = await b.getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(await b.getAttribute('title')).toBe(label);
    expect(await b.locator('svg').count()).toBe(1);
    expect((await b.textContent()).trim()).toBe('');
  }
  // keyboard: Tab from the row reaches its tools, and they show while focused
  await r.locator('.dlv-main').focus();
  await page.keyboard.press('Tab');
  const copy = r.getByRole('button', { name: '复制路径' });
  await expect(copy).toBeFocused();
  await expect(copy).toBeVisible();
  const box = await copy.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.height).toBeGreaterThanOrEqual(28);
  expect(await copy.evaluate((b) => getComputedStyle(b).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe(path.join(out, '报表服务', 'q3-summary.pdf'));
  await expect(copy).toHaveAttribute('aria-label', '已复制');
  await r.getByRole('button', { name: /在访达中显示|在资源管理器中显示|在文件管理器中显示/ }).click();
  await expect.poll(() => application.evaluate(() => global.revealed.slice(-1)[0])).toBe(path.join(out, '报表服务', 'q3-summary.pdf'));
  // jump to the session that delivered it
  await row('登录流程说明.md').getByRole('button', { name: '跳到交付它的会话' }).click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe(LOGIN);
  await page.evaluate((i) => jumpToColumn(columns.find((c) => c.id === i)), CAPTAIN);
  await page.evaluate((i) => ChatUI.setMode(i, 'chat'), CAPTAIN);
  // jump to 队长's reply that mentioned it
  await row('上线清单.md').getByRole('button', { name: '跳到提到它的回复' }).click();
  await expect(col().locator('.msg.assistant[data-turn="l-4"]')).toBeInViewport();
  await park();
});

test('the panel folds away and stays folded; the reading column then has the room', async () => {
  const before = await col().locator('.chat-scroll').evaluate((c) => c.getBoundingClientRect().width);
  await panel().getByRole('button', { name: '收起交付文件' }).click();
  await expect(panel()).toBeHidden();
  await expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => config.chatDeliverablesOpen)).toBe(false);
  const after = await col().locator('.chat-scroll').evaluate((c) => c.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 200);
  // the head button brings it back, from the keyboard too
  await toggle().focus();
  await page.keyboard.press('Enter');
  await expect(panel()).toBeVisible();
  expect(await page.evaluate(() => config.chatDeliverablesOpen)).toBe(true);
  await expect(toggle()).toHaveAttribute('title', '收起交付文件');
});

test('new receipts and replies join the list; the index is saved with what it read', async () => {
  const fresh = path.join(out, '报表服务', '年度总结.pdf');
  fs.writeFileSync(fresh, '%PDF-1.4\n');
  await page.evaluate(({ id, file }) => {
    const c = columns.find((x) => x.id === id);
    c.lastReceipt = { summary: '年度总结导出了。', files: [file, file.replace(/年度总结\.pdf$/, 'raw.csv')], explicit: true, source: 'command', ts: Date.now() };
    ChatDeliverables.refresh();
  }, { id: EXPORT, file: fresh });
  await expect(rows().first().locator('.dlv-name')).toHaveText('年度总结.pdf');
  await expect(rows().first().locator('.dlv-from')).toHaveText('报表导出');
  await expect(row('raw.csv')).toHaveCount(0);
  // the index is in config.json: the old conversation is read once and remembered
  await page.evaluate(() => flushConfig());
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
  expect(saved.chatDeliverables.scanned).toContain(OLD);
  const keys = saved.chatDeliverables.items.map((i) => path.basename(i.path));
  expect(keys).toContain('old-plan.md');
  expect(keys).toContain('年度总结.pdf');
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).not.toContain('build.py');
  // history outlives its source: an old conversation's file stays listed from the index alone
  await page.evaluate((old) => { ChatUI.captainArchives().find((c) => c.id === old).turns.forEach((t) => { t.reply = '（已整理）'; }); ChatDeliverables.refresh(); }, OLD);
  await expect(row('old-plan.md')).toHaveCount(1);
});

test('the two lists are editable: a type added shows its files, the defaults come back', async () => {
  await panel().getByRole('button', { name: '筛选规则' }).click();
  const form = panel().locator('.dlv-rules');
  await expect(form).toBeVisible();
  const types = form.getByLabel('算作交付的文件类型');
  await expect(types).toHaveValue(/(^|[ ,])md([ ,]|$)/);
  await types.fill((await types.inputValue()) + ', csv');
  await form.getByRole('button', { name: '保存' }).click();
  await expect(form).toBeHidden();
  await expect(row('orders.csv')).toHaveCount(1);
  await expect(row('raw.csv')).toHaveCount(1);
  expect(await page.evaluate(() => config.deliverableRules.types.includes('csv'))).toBe(true);
  // folders work the same way
  await panel().getByRole('button', { name: '筛选规则' }).click();
  const skip = form.getByLabel('跳过这些文件夹里的文件');
  await skip.fill((await skip.inputValue()) + ', export');
  await form.getByRole('button', { name: '保存' }).click();
  await expect(row('orders.csv')).toHaveCount(0);
  // back to the defaults (minus the temp folders this test profile lives in)
  await panel().getByRole('button', { name: '筛选规则' }).click();
  await form.getByRole('button', { name: '恢复默认' }).click();
  await expect(form).toBeHidden();
  expect(await page.evaluate(() => config.deliverableRules)).toBeUndefined();
  await page.evaluate((skip) => { config.deliverableRules = { skip }; ChatDeliverables.refresh(); }, data.build(out, Date.now(), { CAPTAIN, OLD, LOGIN, EXPORT, FAKE }).config.deliverableRules.skip);
  await expect(row('raw.csv')).toHaveCount(0);
});

// The reading column stands left of centre: the air on its left is about 0.618
// of what an even split would leave, your bubble keeps the column's right edge,
// and the composer stands on the same two edges.
test('the reading column moves left: its left air is 0.618 of an even split', async () => {
  const measure = async () => {
    await park();
    await col().locator('.msg.assistant[data-turn="l-4"]').scrollIntoViewIfNeeded();
    return page.evaluate((i) => {
      // the chat's own room: a docked panel takes its share off the right
      const c = document.querySelector(`.column[data-col-id="${i}"]`), box = c.querySelector('.chat-scroll').getBoundingClientRect();
      const r = (sel) => c.querySelector(sel).getBoundingClientRect();
      const turn = r('.turn:has(.msg.assistant[data-turn="l-4"])'), reply = r('.msg.assistant[data-turn="l-4"] .reply'), bubble = r('.msg.user[data-turn="l-4"] .bubble'), composer = r('.composer-box');
      const panel = c.querySelector('.dlv'), p = panel && panel.offsetParent ? panel.getBoundingClientRect() : null;
      return { pane: box.width, chatRight: box.right, left: reply.x - box.x, right: box.right - turn.right, text: turn.width, bubbleRight: bubble.right, turnRight: turn.right,
        composer: [composer.x - box.x, box.right - composer.right], panel: p && { x: p.x, w: p.width, right: p.right }, colRight: c.getBoundingClientRect().right };
    }, CAPTAIN);
  };
  for (const [w, h] of [[1920, 1080], [1680, 1000], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const open of [false, true]) {
      if ((await panel().isVisible()) !== open) await toggle().click();
      const g = await measure();
      const name = `${w} panel ${open ? 'open' : 'closed'}`;
      const even = (g.pane - g.text) / 2;
      expect(Math.abs(g.text - Math.min(900, Math.max(780, g.pane * 0.52))), name).toBeLessThanOrEqual(1.5);
      if (even * 0.618 >= 57) expect(Math.abs(g.left - even * 0.618), name).toBeLessThanOrEqual(2);
      else expect(g.left, name).toBeLessThanOrEqual(g.right + 1.5);
      // your bubble on the column's right edge; the composer on both edges
      expect(Math.abs(g.bubbleRight - g.turnRight), name).toBeLessThanOrEqual(2);
      expect(Math.abs(g.composer[0] - g.left), name).toBeLessThanOrEqual(1);
      expect(Math.abs(g.composer[1] - g.right), name).toBeLessThanOrEqual(1.5);
      if (open) {
        // docked: the chat ends where the panel starts, the panel ends at the column's edge
        expect(Math.abs(g.chatRight - g.panel.x), name).toBeLessThanOrEqual(1);
        expect(Math.abs(g.panel.right - g.colRight), name).toBeLessThanOrEqual(1);
        expect(g.panel.w, name).toBeGreaterThanOrEqual(280);
        expect(g.panel.w, name).toBeLessThanOrEqual(340);
      }
    }
  }
  await page.setViewportSize({ width: 1680, height: 1000 });
});

test('a narrow window keeps the conversation whole: the panel slides over it on request', async () => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await expect(panel()).toBeHidden();
  await expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  // the button says how many files there are
  await expect(toggle().locator('.dlv-badge')).toHaveText(/^\d+$/);
  const chatW = await col().locator('.chat-scroll').evaluate((c) => c.getBoundingClientRect().width);
  await toggle().click();
  await expect(panel()).toBeVisible();
  await expect(panel()).toHaveClass(/overlay/);
  // over the chat, not beside it: the chat keeps its width
  expect(await col().locator('.chat-scroll').evaluate((c) => c.getBoundingClientRect().width)).toBeCloseTo(chatW, 0);
  await shoot('narrow-open-dark');
  await page.evaluate(() => applyTheme('light'));
  await shoot('narrow-open-light');
  await page.evaluate(() => applyTheme('dark'));
  // Esc closes it and puts the keyboard back on the button that opened it
  await panel().locator('.dlv-row .dlv-main').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await expect(toggle()).toBeFocused();
  // the docked choice is untouched by the drawer
  expect(await page.evaluate(() => config.chatDeliverablesOpen)).toBe(true);
  await page.setViewportSize({ width: 1680, height: 1000 });
  await expect(panel()).toBeVisible();
});

test('screenshots: wide and narrow, dark and light', async () => {
  test.skip(!shots, 'set AGENTDECK_DELIVERABLES_SHOTS to keep screenshots');
  for (const [name, w, h] of [['wide', 1680, 1000], ['xwide', 1920, 1080], ['narrow', 1100, 760]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await shoot(`${name}-${theme}`);
    }
  }
  await page.evaluate(() => applyTheme('dark'));
  await page.setViewportSize({ width: 1680, height: 1000 });
  expect(errors).toEqual([]);
});
