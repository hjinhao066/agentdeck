const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated profile and stand-in PTYs only; identity commands are metadata,
// assigned after launch so no real Claude/Cursor/Codex process ever starts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const titles = ['省钱中心每日产出与通知清理', '把界面工具动作改成图标按钮', 'AgentDeck 侧边栏模型与标题修复'];
let application, page, profile;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidebar-captain-'));
  const now = Date.now();
  fs.mkdirSync(path.join(profile, 'chats'));
  for (const [i, title] of titles.entries()) {
    fs.writeFileSync(path.join(profile, 'chats', `worker-${i}.json`), JSON.stringify({
      v: 1, id: `worker-${i}`, turns: [{ id: `turn-${i}`, ts: now - (i + 1) * 60000, user: title, reply: 'stand-in reply', done: true, atts: [] }],
    }));
  }
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 252,
    columns: [
      { id: 'captain', title: '队长', cmd: FAKE + ' --captain-statusline', cwd: profile, width: 460, role: 'manual', isMain: true },
      ...titles.map((title, i) => ({ id: `worker-${i}`, title, displayTitle: title, manualTitle: true,
        cmd: FAKE + ' --interruptible --sidebar-controls', cwd: profile, width: 460, role: 'manual', captainCrew: true })),
    ],
    mainSession: { colId: 'captain', cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [],
      fresh: false, crewMarked: true, waitlist: [], tasks: titles.map((title, i) => ({
        id: `task-${i}`, colId: `worker-${i}`, title, status: 'working', sentAt: now - (3 - i) * 60000, gen: 1,
      })) },
  }));
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
  // Finish the startup briefing before assigning actual-tool metadata.
  await expect.poll(() => page.evaluate(() => terms.get('captain').lastScreen)).toContain('Delegate report:');
  await page.evaluate(() => {
    const cap = columns.find((c) => c.id === 'captain');
    cap.cmd = 'claude --dangerously-skip-permissions --effort high';
    cap.agentProvider = 'Claude'; cap.agentModel = 'GPT-6.1-Sol high';
    const commands = ['cursor-agent --model grok-4.7-high-fast', 'agy --model gemini-3.8-flash-high', 'codex --model gpt-6.1-sol'];
    const models = ['grok-4.7-high-fast', 'gemini-3.8-flash-high', 'gpt-6.1-sol'];
    commands.forEach((cmd, i) => {
      columns.find((c) => c.id === `worker-${i}`).cmd = cmd;
      window.deck.ptyInput(`worker-${i}`, `/model ${models[i]}\r`);
    });
    config.crewOpen = true;
    Sidebar.render();
  });
  for (const [i, model] of ['Grok 4.7', 'Flash 3.8', 'GPT-6.1 Sol'].entries()) {
    await expect(page.locator(`.nav-crew [data-col-id="worker-${i}"] .agent-model-label`)).toHaveText(model, { timeout: 15000 });
  }
  await page.evaluate(() => [0, 1, 2].forEach((i) => window.deck.ptyInput(`worker-${i}`, 'keep working\r')));
});

test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('Captain badge repairs poisoned model cache using its own custom statusline', async () => {
  const header = page.locator('.column[data-col-id="captain"] .col-badge');
  const sidebar = page.locator('.captain-item .cn-badge');
  for (const badge of [header, sidebar]) {
    await expect(badge.locator('.agent-model-label')).toHaveText('Opus 5.5');
    await expect(badge).toHaveAttribute('title', 'Claude · Claude Opus 5.5 (xhigh)');
    await expect(badge.locator('.agent-provider-icon')).toHaveAttribute('data-icon-provider', 'claude');
  }
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).columns.find((c) => c.id === 'captain').agentModel).toBe('Opus 5.5');
  // A real model switch still replaces the starting/cached model.
  await page.evaluate(() => window.deck.ptyInput('captain', '/model Sonnet 5.5\r'));
  await expect(sidebar.locator('.agent-model-label')).toHaveText('Sonnet 5.5');
  await page.evaluate(() => window.deck.ptyInput('captain', '/model Opus 5.5\r'));
  await expect(sidebar.locator('.agent-model-label')).toHaveText('Opus 5.5');
});

test('Captain arrow folds without selecting it; live counts stay visible, its row still opens chat', async ({}, testInfo) => {
  const row = page.locator('.captain-item');
  const fold = row.locator('.captain-fold');
  const counts = row.locator('.crew-counts');
  await expect(counts).toHaveText('3 干活中', { timeout: 15000 });
  await expect(page.locator('.crew-head, .nav-crew .nav-folder-name, .nav-crew .nav-folder-ico')).toHaveCount(0);
  await expect(row).not.toContainText('后台');
  await expect(fold).toHaveAttribute('title', '收起队员列表');
  await expect(fold).toHaveAttribute('aria-label', '收起队员列表');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toHaveText('');
  await expect(fold.locator('svg')).toHaveCount(1);
  expect((await fold.boundingBox()).x).toBeLessThan((await row.locator('.cn-crown').boundingBox()).x);
  await page.locator('.nav-crew [data-col-id="worker-0"]').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('worker-0');
  await fold.click();
  await expect(page.locator('.nav-crew .colnav-item')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('worker-0');
  await expect(counts).toBeVisible();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(fold).toHaveAttribute('aria-label', '展开队员列表');
  // Finishing/failing a worker updates the counts even while its row is folded.
  await page.evaluate(() => window.deck.ptyInput('worker-1', '\x1b'));
  await expect.poll(() => page.evaluate(() => terms.get('worker-1').state)).toBe('done');
  await page.evaluate(() => { MainSession.state().tasks.find((t) => t.colId === 'worker-1').status = 'failed'; Sidebar.refreshCrew(); });
  await expect(counts).toHaveText('2 干活中 · 1 失败');
  const dir = process.env.AGENTDECK_SCREENSHOT_DIR || testInfo.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  await page.mouse.move(800, 100);
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('#colNav').screenshot({ path: path.join(dir, 'sidebar-folded.png') });
  await page.evaluate(() => { MainSession.state().tasks.find((t) => t.colId === 'worker-1').status = 'done'; Sidebar.refreshCrew(); });
  await expect(counts).toHaveText('2 干活中 · 1 完成');
  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.nav-crew .colnav-item')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('worker-0');
  await page.evaluate(() => ChatUI.setMode('captain', 'term'));
  await row.locator('.cn-label').click();
  await expect.poll(() => page.evaluate(() => focusedId)).toBe('captain');
  await expect(page.locator('.column[data-col-id="captain"]')).not.toHaveClass(/chat-mode/);
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    MainSession.state().tasks.find((t) => t.colId === 'worker-1').status = 'working';
    window.deck.ptyInput('worker-1', 'keep working\r');
  });
  await expect(counts).toHaveText('3 干活中');
});

test('worker titles stay one full-width line above metadata at default, minimum and wide sidebar widths', async ({}, testInfo) => {
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
  for (const width of [252, 200, 420]) {
    await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); }, width);
    const rows = page.locator('.nav-crew .colnav-item');
    await expect(rows.locator('.cn-label')).toHaveText(titles);
    for (let i = 0; i < titles.length; i++) {
      const row = rows.nth(i);
      await page.mouse.move(800, 100);
      await page.evaluate(() => document.activeElement?.blur());
      await expect(row.locator('.cn-meta')).toHaveText(/\d+ 分钟/);
      const check = async () => row.evaluate((el) => {
        const label = el.querySelector('.cn-label');
        const badge = el.querySelector('.cn-badge');
        const l = label.getBoundingClientRect(), b = badge.getBoundingClientRect(), r = el.getBoundingClientRect();
        const meta = el.querySelector('.cn-meta');
        const m = meta.getBoundingClientRect();
        return { titleWidth: l.width, modelBelow: b.top >= l.bottom,
          timeBelow: getComputedStyle(meta).display === 'none' || m.top >= l.bottom,
          contained: l.right <= r.right,
          clamped: getComputedStyle(label).whiteSpace === 'nowrap' && getComputedStyle(label).textOverflow === 'ellipsis' && getComputedStyle(label).overflow === 'hidden',
          lines: l.height / parseFloat(getComputedStyle(label).lineHeight),
          fontSize: parseFloat(getComputedStyle(label).fontSize),
          navFontSize: parseFloat(getComputedStyle(document.querySelector('.nav-row')).fontSize) };
      });
      expect(await check()).toMatchObject({ modelBelow: true, timeBelow: true, contained: true, clamped: true });
      const layout = await check();
      expect(layout.titleWidth).toBeGreaterThan(120);
      expect(layout.lines).toBeLessThanOrEqual(1.35);
      expect(layout.fontSize).toBe(12.5);
      expect(layout.fontSize).toBeLessThan(layout.navFontSize);
      await row.hover();
      expect(await check()).toMatchObject({ modelBelow: true, clamped: true });
      for (const button of await row.locator('.cn-actions button').all()) {
        await expect(button).toHaveAttribute('aria-label', /.+/);
        await expect(button).toHaveAttribute('title', /.+/);
        await expect(button.locator('svg')).toHaveCount(1);
        await expect(button).toHaveText('');
        const area = await button.boundingBox();
        expect(area.width).toBeGreaterThanOrEqual(24);
        expect(area.height).toBeGreaterThanOrEqual(24);
        await button.focus();
        await expect(button).toBeFocused();
        await expect(row.locator('.cn-actions')).toHaveCSS('opacity', '1');
      }
    }
    await page.mouse.move(800, 100);
    await page.evaluate(() => document.activeElement?.blur());
    const dir = process.env.AGENTDECK_SCREENSHOT_DIR || testInfo.outputDir;
    fs.mkdirSync(dir, { recursive: true });
    await expect(rows.locator('.cn-sub')).toHaveText(['✻ Doing…', '✻ Doing…', '✻ Doing…']);
    await page.evaluate(() => { document.getElementById('navList').scrollTop = 0; });
    await page.locator('#colNav').screenshot({ path: path.join(dir, `sidebar-${width}.png`) });
  }
});

test('Captain metadata and counts stay inside its row when the sidebar list overflows or folds', async () => {
  // The old flex-shrunk Captain row overlapped the first worker only with a
  // crowded list; the roomy default window did not expose it.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 520));
  for (const width of [200, 225, 252, 320, 420]) {
    await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); }, width);
    for (const open of [true, false]) {
      await page.evaluate((value) => { config.crewOpen = value; Sidebar.render(); }, open);
      await page.mouse.move(800, 100);
      await page.evaluate(() => { document.getElementById('navList').scrollTop = 0; });
      if (open) expect(await page.locator('#navList').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      const layout = await page.evaluate(() => {
        const captain = document.querySelector('.captain-item');
        const r = captain.getBoundingClientRect();
        const parts = ['.cn-label', '.cn-badge', '.cn-meta', '.crew-counts'].map((selector) => {
          const el = captain.querySelector(selector), b = el.getBoundingClientRect();
          return { visible: getComputedStyle(el).display !== 'none', top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        }).filter((b) => b.visible);
        const next = captain.nextElementSibling.hidden ? captain.nextElementSibling.nextElementSibling : captain.nextElementSibling;
        return { contained: parts.every((b) => b.top >= r.top && b.bottom <= r.bottom && b.left >= r.left && b.right <= r.right),
          ordered: parts[1].top >= parts[0].bottom && parts[3].top >= parts[1].bottom,
          separate: next.getBoundingClientRect().top >= r.bottom };
      });
      expect(layout, `width=${width}, open=${open}`).toEqual({ contained: true, ordered: true, separate: true });
    }
  }
});

test('subtitles hide controls-only screens and show new real progress', async () => {
  await page.evaluate(() => { config.crewOpen = true; Sidebar.render(); });
  const sub = page.locator('.nav-crew [data-col-id="worker-0"] .cn-sub');
  const writeScreen = (text) => page.evaluate((value) => new Promise((resolve) => {
    terms.get('worker-0').term.write('\x1b[2J\x1b[H' + value.replace(/\n/g, '\r\n'), resolve);
  }), text);
  await writeScreen('Thinking: xhigh\n← for agents · ? for shortcuts ⚠…');
  await expect.poll(() => page.evaluate(() => terms.get('worker-0').lastScreen)).toContain('← for agents');
  await expect(sub).toHaveText('', { timeout: 10000 });
  await expect(sub).toBeHidden();
  await writeScreen('✻ 正在跑侧边栏回归测试…\n────────────────────\n> \n────────────────────\nThinking: xhigh\n← for agents · ? for shortcuts ⚠…');
  await expect(sub).toHaveText('✻ 正在跑侧边栏回归测试…', { timeout: 10000 });
  await expect(sub).toBeVisible();
});

test('sidebar text shortcuts scale metadata with titles, clamp safely and share native menu routing', async ({}, testInfo) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
  await page.evaluate(() => { config.navWidth = 252; config.crewOpen = true; applyNavWidth(); Sidebar.render(); });
  await page.locator('.captain-fold').focus();
  await page.evaluate(() => [0, 1, 2].forEach((i) => window.deck.ptyInput(`worker-${i}`, 'keep working\r')));
  await expect(page.locator('.nav-crew .cn-sub')).toHaveText(['✻ Doing…', '✻ Doing…', '✻ Doing…']);
  const sizes = () => page.evaluate(() => {
    const font = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return { title: font('.nav-crew .cn-label'), model: font('.nav-crew .agent-model-label'),
      status: font('.nav-crew .cn-sub'), time: font('.nav-crew .cn-meta'), counts: font('.crew-counts') };
  });
  const base = await sizes();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(`${mod}+${i === 2 ? 'Shift+Equal' : 'Equal'}`);
    await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(14 + i);
  }
  const large = await sizes();
  for (const key of Object.keys(base)) expect(large[key] / base[key], key).toBeCloseTo(16 / 13, 3);
  expect(await page.evaluate(() => config.fontSize)).toBe(13);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(0);
  const shots = process.env.AGENTDECK_SCREENSHOT_DIR || testInfo.outputDir;
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(800, 100);
  await page.evaluate(() => { document.getElementById('navList').scrollTop = 0; });
  await page.locator('#colNav').screenshot({ path: path.join(shots, 'sidebar-font-large.png') });
  for (let i = 0; i < 20; i++) await page.keyboard.press(`${mod}+Minus`);
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(10);
  const small = await sizes();
  for (const key of Object.keys(base)) expect(small[key] / base[key], key).toBeCloseTo(10 / 13, 3);
  await page.locator('#colNav').screenshot({ path: path.join(shots, 'sidebar-font-small.png') });
  for (let i = 0; i < 20; i++) await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(20);
  for (const width of [200, 252]) {
    await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); }, width);
    for (const open of [true, false]) {
      await page.evaluate((value) => { config.crewOpen = value; Sidebar.render(); }, open);
      expect(await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.captain-item, .nav-crew .colnav-item')];
        return rows.every((row) => {
          const r = row.getBoundingClientRect();
          const parts = [...row.querySelectorAll('.cn-label, .cn-badge, .cn-meta, .crew-counts, .cn-sub')]
            .filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.getBoundingClientRect());
          const next = row.nextElementSibling;
          return parts.every((p) => p.left >= r.left && p.right <= r.right + 1 && p.top >= r.top && p.bottom <= r.bottom + 1) &&
            (!next || next.hidden || next.getBoundingClientRect().top >= r.bottom);
        });
      }), `maximum size, width=${width}, open=${open}`).toBe(true);
    }
  }
  await page.locator('.captain-fold').focus();
  await page.keyboard.press(`${mod}+0`);
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(13);
  const invoke = (role) => application.evaluate(({ Menu, BrowserWindow }, r) => {
    const items = (m) => m.items.flatMap((i) => [i, ...(i.submenu ? items(i.submenu) : [])]);
    const item = items(Menu.getApplicationMenu()).find((i) => i.id === `text-${r}`);
    const win = BrowserWindow.getAllWindows()[0]; item.click(undefined, win, win.webContents);
  }, role);
  await invoke('zoomin');
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(14);
  await invoke('resetzoom');
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(13);
  // Chat/terminal content retains its own size control, separate from the sidebar.
  await page.locator('.captain-item .cn-label').click();
  await page.locator('.column[data-col-id="captain"] .composer textarea').focus();
  await page.keyboard.press(`${mod}+Minus`);
  await expect.poll(() => page.evaluate(() => config.fontSize)).toBe(12);
  expect(await page.evaluate(() => config.sidebarFontSize)).toBe(13);
  expect(await page.evaluate(() => terms.get('captain').term.options.fontSize)).toBe(12);
  await page.keyboard.press(`${mod}+0`);
  await expect.poll(() => page.evaluate(() => config.fontSize)).toBe(13);
  await page.evaluate(() => ChatUI.setMode('captain', 'term'));
  await page.locator('.column[data-col-id="captain"] .xterm textarea').focus();
  await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.fontSize)).toBe(14);
  expect(await page.evaluate(() => config.sidebarFontSize)).toBe(13);
  await page.keyboard.press(`${mod}+0`);
  await page.evaluate(() => ChatUI.setMode('captain', 'chat'));
  // A click on non-focusable chrome must switch scope even if a composer had focus.
  await page.locator('#navList').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(14);
  expect(await page.evaluate(() => config.fontSize)).toBe(13);
  await page.keyboard.press(`${mod}+0`);
});

test('sidebar font preference survives an isolated application restart', async () => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('.captain-fold').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${mod}+Equal`);
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(16);
  // The earlier identity tests assign real commands as metadata. Restore stand-ins
  // before restart so this test can never launch a real agent or spend quota.
  await page.evaluate((fake) => {
    columns.forEach((col) => { col.cmd = fake + (col.isMain ? ' --captain-statusline' : ' --interruptible --sidebar-controls'); });
    config.mainSession.cmd = columns.find((c) => c.isMain).cmd;
    flushConfig();
  }, FAKE);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).sidebarFontSize).toBe(16);
  await application.close();
  application = null;
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.captain-fold')).toBeVisible();
  await expect.poll(() => page.evaluate(() => config.sidebarFontSize)).toBe(16);
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.captain-item .cn-label')).fontSize))).toBeCloseTo(13.5 * 16 / 13, 3);
  expect(await page.evaluate(() => config.fontSize)).toBe(13);
});
