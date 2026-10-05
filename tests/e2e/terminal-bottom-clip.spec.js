const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'terminal-bottom-agent.js')}"`;
const FOOTER = '⏵⏵ bypass permissions on (shift+tab to cycle)';
let application, page, profile;

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    await testInfo.attach('terminal-screens.json', { body: JSON.stringify(await page.evaluate(() =>
      [...terms].map(([id, { term }]) => ({ id, screen: dumpScreen(term) })))), contentType: 'application/json' });
  }
  if (application) await application.close();
  application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function geometry(id) {
  return page.evaluate((id) => {
    const { term, el } = terms.get(id);
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
    const cellHeight = term._core._renderService.dimensions.css.cell.height;
    const contentBottom = box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const deckBottom = deckEl.getBoundingClientRect().top + deckEl.clientTop + deckEl.clientHeight;
    return { rows: term.rows, cols: term.cols, cellHeight, screenBottom: screen.bottom,
      clipBottom: Math.min(box.bottom, el.closest('.column').getBoundingClientRect().bottom, deckBottom, innerHeight),
      contentBottom, capacity: Math.floor((contentBottom - screen.top) / cellHeight),
      footer: term.buffer.active.getLine(term.buffer.active.baseY + term.rows - 1)?.translateToString(true),
      dpr: devicePixelRatio };
  }, id);
}

async function check(id, label, samples) {
  // Layout helpers schedule fit on the next frame. Measure after those frames,
  // then keep the matching renderer/PTY pair instead of racing a fresh read.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let sample;
  await expect.poll(async () => {
    const g = await geometry(id);
    const file = path.join(profile, `${id}.size.json`);
    let pty = {};
    try { pty = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const errors = [];
    if (g.rows !== g.capacity || pty.rows !== g.capacity) errors.push(`xterm ${g.rows} / PTY ${pty.rows} rows, visible capacity ${g.capacity}`);
    if (pty.cols !== g.cols) errors.push(`xterm ${g.cols} / PTY ${pty.cols} columns`);
    if (g.screenBottom > g.clipBottom || g.screenBottom > g.contentBottom) errors.push(`last row bottom ${g.screenBottom}, clip bottom ${g.clipBottom}, content bottom ${g.contentBottom}`);
    if (g.footer !== FOOTER) errors.push(`footer: ${g.footer}`);
    if (!errors.length) sample = { g, pty };
    return errors;
  }, { message: label, timeout: 10000 }).toEqual([]);
  const { g, pty } = sample;
  expect(pty, label).toEqual({ rows: g.capacity, cols: g.cols });
  expect(g.screenBottom, label).toBeLessThanOrEqual(g.contentBottom);
  samples.push({ label, id, ...g, pty });
}

for (const dpr of [1, 2]) {
  test(`last PTY row stays fully visible through layout changes at ${dpr}x`, async () => {
    test.setTimeout(180000);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bottom-clip-'));
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
      theme: 'dark', globalViewMode: 'term', fitWindow: true, fitCols: 2,
      columns: [0, 1].map((i) => ({ id: `bottom-${i}`, title: i ? 'Second session' : 'Captain footer stand-in',
        cmd: FAKE, cwd: profile, role: 'manual', width: 620, viewMode: 'term' })),
    }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`, `--force-device-scale-factor=${dpr}`], env });
    page = await application.firstWindow();
    await expect(page.locator('.xterm-screen')).toHaveCount(2);
    await expect.poll(() => fs.existsSync(path.join(profile, 'bottom-1.size.json')), { timeout: 20000 }).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => devicePixelRatio)).toBe(dpr);
    const samples = [];
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => applyTheme(theme), theme);
      for (const height of [800, 480, 537, 601, 733, 901]) {
        await application.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setContentSize(1440, height), height);
        // Wait for the renderer viewport to receive the native resize.
        await expect.poll(() => page.evaluate((height) => Math.abs(innerHeight - height), height)).toBeLessThanOrEqual(process.platform === 'win32' ? 1 : 0);
        await check('bottom-0', `${theme} height ${height}`, samples);
        await check('bottom-1', `${theme} height ${height}, second session`, samples);
        if (process.env.AGENTDECK_BOTTOM_CLIP_REPORT_DIR && dpr === 2 && [480, 800, 901].includes(height)) {
          await page.screenshot({ path: path.join(process.env.AGENTDECK_BOTTOM_CLIP_REPORT_DIR, `${theme}-${height}-2x.png`) });
        }
      }
      await page.evaluate(() => setNavCollapsed(true));
      await check('bottom-0', `${theme} sidebar closed`, samples);
      await page.evaluate(() => setNavCollapsed(false));
      await check('bottom-0', `${theme} sidebar opened`, samples);
      await page.evaluate(() => { toggleZoom('bottom-1'); jumpToColumn(columns[1]); });
      await check('bottom-1', `${theme} second session zoomed`, samples);
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 657));
      await expect.poll(() => page.evaluate(() => Math.abs(innerHeight - 657))).toBeLessThanOrEqual(process.platform === 'win32' ? 1 : 0);
      await check('bottom-1', `${theme} resized while first session hidden`, samples);
      await page.evaluate(() => { toggleZoom('bottom-1'); jumpToColumn(columns[0]); });
      await check('bottom-0', `${theme} first session shown again`, samples);
      await page.evaluate(() => ChatUI.setMode('bottom-0', 'chat'));
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 733));
      await expect.poll(() => page.evaluate(() => Math.abs(innerHeight - 733))).toBeLessThanOrEqual(process.platform === 'win32' ? 1 : 0);
      await page.evaluate(() => ChatUI.setMode('bottom-0', 'term'));
      await check('bottom-0', `${theme} terminal shown after chat resize`, samples);
      for (const size of [16, 12, 13]) {
        await page.evaluate((size) => setFontSize(size), size);
        await check('bottom-0', `${theme} font ${size}`, samples);
      }
      await page.evaluate(() => {
        config.fitWindow = false;
        columns.forEach((col) => { col.width = 800; });
        updateColumnStyles(); fitAll();
      });
      await expect.poll(() => page.evaluate(() => deckEl.scrollWidth > deckEl.clientWidth)).toBe(true);
      await check('bottom-0', `${theme} horizontal scrollbar visible`, samples);
      await page.evaluate(() => jumpToColumn(columns[1]));
      await check('bottom-1', `${theme} scroll to second session`, samples);
      await page.evaluate(() => { config.fitWindow = true; updateColumnStyles(); fitAll(); jumpToColumn(columns[0]); });
      await check('bottom-0', `${theme} equal split restored`, samples);
      const reportDir = process.env.AGENTDECK_BOTTOM_CLIP_REPORT_DIR;
      if (reportDir) {
        fs.mkdirSync(reportDir, { recursive: true });
        await expect(page.locator('#toast')).toHaveCSS('opacity', '0');
        await page.screenshot({ path: path.join(reportDir, `${theme}-${dpr}x.png`) });
      }
    }
    if (process.env.AGENTDECK_BOTTOM_CLIP_REPORT_DIR) fs.writeFileSync(
      path.join(process.env.AGENTDECK_BOTTOM_CLIP_REPORT_DIR, `geometry-${dpr}x.json`), JSON.stringify(samples, null, 2));
  });
}
