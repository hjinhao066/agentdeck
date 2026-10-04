const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const GEOM = `node "${path.join(__dirname, 'fixtures', 'font-zoom-agent.js')}"`;
const FOOTER = 'ROW-END';
const SHOTS = process.env.AGENTDECK_FONT_ZOOM_SHOTS || path.join(os.homedir(), 'reports', 'agentdeck-font-zoom');
const LONG = '侧边栏标题要保持单行省略即使这句话非常非常非常非常非常长';
const PROMPT = '请把这段话原样重复，用来确认放大以后对话文字在气泡里换行，不会叠到旁边一列。';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let application, page, profile;

test.afterEach(async () => {
  if (application) await application.close();
  application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return env;
}

async function launch(dir) {
  application = await electron.launch({
    args: [ROOT, `--test-user-data=${dir}`],
    env: cleanEnv(),
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => { throw error; });
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => fs.existsSync(path.join(dir, 'zoom-term.size.json')), { timeout: 20000 }).toBe(true);
  await page.evaluate(() => document.fonts.ready);
}

async function geometry() {
  return page.evaluate(() => {
    const { term, el } = terms.get('zoom-term');
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
    const cellHeight = term._core._renderService.dimensions.css.cell.height;
    const contentBottom = box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const deckBottom = deckEl.getBoundingClientRect().top + deckEl.clientTop + deckEl.clientHeight;
    return {
      rows: term.rows, cols: term.cols, cellHeight, screenBottom: screen.bottom,
      clipBottom: Math.min(box.bottom, el.closest('.column').getBoundingClientRect().bottom, deckBottom, innerHeight),
      contentBottom, capacity: Math.floor((contentBottom - screen.top) / cellHeight),
      footer: term.buffer.active.getLine(term.buffer.active.baseY + term.rows - 1)?.translateToString(true),
      inContent: !!el.querySelector('.term-content > .xterm'),
    };
  });
}

async function expectFitted(label) {
  await expect.poll(async () => {
    const g = await geometry();
    let pty = {};
    try { pty = JSON.parse(fs.readFileSync(path.join(profile, 'zoom-term.size.json'), 'utf8')); } catch (_) {}
    const errors = [];
    if (!g.inContent) errors.push('xterm is not measured inside .term-content');
    if (g.rows !== g.capacity || pty.rows !== g.capacity) errors.push(`xterm ${g.rows} / PTY ${pty.rows} rows, visible capacity ${g.capacity}`);
    if (pty.cols !== g.cols) errors.push(`xterm ${g.cols} / PTY ${pty.cols} columns`);
    if (g.screenBottom > g.clipBottom + 0.5 || g.screenBottom > g.contentBottom + 0.5) errors.push(`last row bottom ${g.screenBottom}, clip ${g.clipBottom}, content ${g.contentBottom}`);
    if (g.footer !== FOOTER.slice(0, g.cols)) errors.push(`footer: ${g.footer}`);
    return errors;
  }, { message: label, timeout: 10000 }).toEqual([]);
}

async function frames() {
  return page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const nav = box(document.getElementById('colNav'));
    const cols = [...document.querySelectorAll('#deck .column')].map((el) => Math.round(box(el).width));
    const icon = box(document.querySelector('#colNav .rail-btn svg')).width;
    const border = parseFloat(getComputedStyle(document.querySelector('.column')).borderRightWidth);
    const label = document.querySelector('.colnav-item .cn-label');
    const labelStyle = getComputedStyle(label);
    return {
      nav: Math.round(nav.width), cols, icon, border,
      titleNowrap: labelStyle.whiteSpace === 'nowrap',
      titleClipped: label.scrollWidth > label.clientWidth + 1,
      titleLines: label.getBoundingClientRect().height / parseFloat(labelStyle.fontSize),
    };
  });
}

async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); });
  await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
}

test('Cmd/Ctrl plus, equals, minus, and 0 scale text only and keep the last terminal row', async () => {
  test.setTimeout(180000);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-font-zoom-'));
  fs.mkdirSync(path.join(profile, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'tasks', '字体.json'), JSON.stringify({
    version: 1, project: '字体', cards: [{
      id: 'card-wrap', project: '字体', status: 'doing', order: 0, flag: null,
      title: '卡片标题在变大以后仍然在卡片宽度里换行，不会横着溢出到下一列',
      detail: '测试卡片',
      latest_receipt: '回执正文也应该在卡片里换行显示，而不是和旁边的字叠在一起，或者跑出卡片边框。',
      assignee: null, session_id: null, depends_on: [], verify: false, rework_count: 0,
      created: new Date().toISOString(), updated: new Date().toISOString(), archived: false,
    }],
  }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, globalViewMode: 'chat',
    columns: [
      { id: 'zoom-chat', title: LONG, manualTitle: true, cmd: FAKE, cwd: profile, width: 640, role: 'manual', view: 'chat' },
      { id: 'zoom-term', title: '终端', manualTitle: true, cmd: GEOM, cwd: profile, width: 640, role: 'manual', view: 'term' },
    ],
  }));
  await launch(profile);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1200);
  await page.evaluate(() => ChatUI.setMode('zoom-term', 'term'));
  await expect(page.locator('.column[data-col-id="zoom-term"]')).not.toHaveClass(/chat-mode/);
  const column = page.locator('.column[data-col-id="zoom-chat"]');
  await column.locator('.composer textarea').click();
  await column.locator('.composer textarea').fill(PROMPT);
  await page.keyboard.press('Enter');
  await expect(column.locator('.msg.user .bubble').last()).toHaveText(PROMPT);
  await expect(column.locator('.reply').last()).toContainText(PROMPT, { timeout: 20000 });

  const base = await frames();
  expect(base.titleNowrap).toBe(true);
  expect(base.titleClipped).toBe(true);
  expect(base.titleLines).toBeGreaterThan(0.8);
  expect(base.titleLines).toBeLessThan(2);
  expect(await page.evaluate(() => config.fontScale)).toBe(100);
  expect(await page.evaluate(() => config.fontSize)).toBe(13);
  await expectFitted('100% dark');

  await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(110);
  expect(await page.evaluate(() => terms.get('zoom-term').term.options.fontSize)).toBe(14);
  const replyAt110 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.reply')).fontSize));
  expect(replyAt110).toBeCloseTo(14 * 1.1, 1);
  const grown = await frames();
  expect(grown.nav).toBe(base.nav);
  expect(grown.cols).toEqual(base.cols);
  expect(grown.icon).toBe(base.icon);
  expect(grown.border).toBe(base.border);
  expect(grown.titleNowrap).toBe(true);
  expect(grown.titleClipped).toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);

  await page.keyboard.press(`${mod}+Shift+Equal`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(120);
  await page.keyboard.press(`${mod}+Minus`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(110);
  await page.keyboard.press(`${mod}+0`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(100);
  expect(await page.evaluate(() => config.fontSize)).toBe(13);

  const menu = await application.evaluate(({ Menu }) => {
    const walk = (m) => m.items.flatMap((i) => [{ label: i.label, id: i.id || '', accelerator: i.accelerator || '' }, ...(i.submenu ? walk(i.submenu) : [])]);
    return {
      view: Menu.getApplicationMenu().items.map((i) => i.label),
      items: walk(Menu.getApplicationMenu()).filter((i) => i.id.startsWith('text-')),
    };
  });
  expect(menu.view).toContain('视图');
  expect(menu.items).toEqual([
    { id: 'text-resetzoom', label: '默认字号', accelerator: 'CommandOrControl+0' },
    { id: 'text-zoomin', label: '放大文字', accelerator: 'CommandOrControl+Plus' },
    { id: 'text-zoomout', label: '缩小文字', accelerator: 'CommandOrControl+-' },
  ]);
  await application.evaluate(({ Menu, BrowserWindow }) => {
    const walk = (m) => m.items.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu) : [])]);
    const item = walk(Menu.getApplicationMenu()).find((i) => i.id === 'text-zoomout');
    const win = BrowserWindow.getAllWindows()[0];
    item.click(undefined, win, win.webContents);
  });
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(90);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);
  await page.keyboard.press(`${mod}+0`);

  for (let i = 0; i < 5; i++) await page.keyboard.press(`${mod}+Minus`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(80);
  await page.keyboard.press(`${mod}+Minus`);
  expect(await page.evaluate(() => config.fontScale)).toBe(80);
  for (let i = 0; i < 15; i++) await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(200);
  await page.keyboard.press(`${mod}+Equal`);
  expect(await page.evaluate(() => config.fontScale)).toBe(200);
  const maxed = await frames();
  expect(maxed.nav).toBe(base.nav);
  expect(maxed.cols).toEqual(base.cols);
  expect(maxed.icon).toBe(base.icon);
  expect(maxed.border).toBe(base.border);
  expect(maxed.titleNowrap).toBe(true);
  expect(maxed.titleLines).toBeGreaterThan(0.8);
  expect(maxed.titleLines).toBeLessThan(2);
  const bubble = await page.evaluate(() => {
    const el = document.querySelector('.column[data-col-id="zoom-chat"] .msg.user .bubble');
    const card = el.getBoundingClientRect();
    const column = el.closest('.column').getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      inside: card.right <= column.right + 1 && card.left >= column.left - 1,
      wraps: style.whiteSpace === 'pre-wrap' && el.getClientRects().length >= 1 && el.scrollWidth <= el.clientWidth + 2,
      lines: card.height / parseFloat(style.lineHeight),
    };
  });
  expect(bubble.inside).toBe(true);
  expect(bubble.wraps).toBe(true);
  expect(bubble.lines).toBeGreaterThan(1.4);
  await expectFitted('200% before theme shots');

  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => applyTheme(theme), theme);
    for (const percent of [80, 100, 200]) {
      await page.evaluate((percent) => setTextScale(percent), percent);
      await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(percent);
      await expectFitted(`${theme} ${percent}%`);
      await page.evaluate(() => TaskBoardUI.close());
      await shot(`${theme}-${percent}-deck.png`);
      await page.evaluate(() => TaskBoardUI.open());
      await expect(page.locator('.tbv-card')).toBeVisible();
      const cardFit = await page.evaluate(() => {
        const card = document.querySelector('.tbv-card');
        const title = card.querySelector('.tbv-title');
        const body = card.querySelector('.tbv-receipt');
        const c = card.getBoundingClientRect();
        const parts = [title, body].filter(Boolean).map((el) => el.getBoundingClientRect());
        const border = parseFloat(getComputedStyle(card).borderTopWidth);
        return {
          border,
          inside: parts.every((p) => p.left >= c.left - 1 && p.right <= c.right + 1),
          titleWrap: getComputedStyle(title).webkitLineClamp !== 'none' || getComputedStyle(title).whiteSpace !== 'nowrap',
        };
      });
      expect(cardFit.border).toBe(1);
      expect(cardFit.inside).toBe(true);
      expect(cardFit.titleWrap).toBe(true);
      await shot(`${theme}-${percent}-board.png`);
      await page.evaluate(() => TaskBoardUI.close());
    }
  }

  await page.evaluate(() => setTextScale(150));
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(150);
  await page.evaluate(() => flushConfig());
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).fontScale).toBe(150);
  await application.close();
  application = null;
  await launch(profile);
  await expect.poll(() => page.evaluate(() => config.fontScale)).toBe(150);
  expect(await page.evaluate(() => config.fontSize)).toBe(20);
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.reply')).fontSize))).toBeCloseTo(14 * 1.5, 1);
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale')))).toBeCloseTo(1.5, 2);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);
});
