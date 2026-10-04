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
        cmd: FAKE + ' --interruptible', cwd: profile, width: 460, role: 'manual', captainCrew: true })),
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

test('worker titles remain fully readable above metadata at default, minimum and wide sidebar widths', async ({}, testInfo) => {
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
        const range = document.createRange(); range.selectNodeContents(label);
        const rects = [...range.getClientRects()];
        return { titleWidth: l.width, modelBelow: b.top >= l.bottom,
          timeBelow: getComputedStyle(meta).display === 'none' || m.top >= l.bottom,
          fullTitle: rects.every((x) => x.left >= l.left - 1 && x.right <= l.right + 1 && x.bottom <= l.bottom + 1),
          contained: l.right <= r.right, clipped: getComputedStyle(label).overflow === 'hidden' };
      });
      expect(await check()).toMatchObject({ modelBelow: true, timeBelow: true, fullTitle: true, contained: true, clipped: false });
      expect((await check()).titleWidth).toBeGreaterThan(130);
      await row.hover();
      expect(await check()).toMatchObject({ modelBelow: true, fullTitle: true, clipped: false });
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
    await page.locator('#colNav').screenshot({ path: path.join(dir, `sidebar-${width}.png`) });
  }
});
