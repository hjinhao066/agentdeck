const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1.1.3: the sidebar 队长 row is a single line (counts and time in its tooltip),
// the Relay switch is a real icon button, and the 架构图 toolbar opens a
// 当前版本进度 panel built from task cards that mention the next version.
// Isolated profile, task store in <profile>/tasks, stand-in PTYs only.
// Set AGENTDECK_SCREENSHOT_DIR to keep PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_SCREENSHOT_DIR;
let application, page, profile;
test.describe.configure({ mode: 'serial' });

function seed(dir) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  let order = 0;
  const card = (project, id, title, status, extra = {}) => ({ id, project, title, detail: '测试卡片', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(600), updated: at(30), archived: false, ...extra });
  const boards = {
    agentdeck: [
      card('agentdeck', 'v-112', '重启 AgentDeck 后自动续派队员（1.1.2）', 'done'),
      card('agentdeck', 'v-row', '侧边栏队长行并成一行 + 切换账号按钮重做；架构图右侧「版本进度」面板，标题很长时用省略号收尾', 'doing', { detail: '看整体进度。1.1.3' }),
      card('agentdeck', 'v-font', 'Cmd 加号/减号放大缩小字体', 'done', { detail: '用户：按 Cmd+ 字变大，框不变。1.1.3' }),
      card('agentdeck', 'v-draft', '对话页和终端页草稿同步', 'done', { detail: '1.1.3', archived: true }),
      card('agentdeck', 'v-label', '左下角显示版本号', 'review', { version: '1.1.3' }),
      card('agentdeck', 'v-release', '1.1.3 发版：版本号 + 额度面板一行化 + 侧边栏队长行', 'todo'),
      card('agentdeck', 'v-next', '1.2.0：派活指定 Mac/Windows', 'todo'),
      card('agentdeck', 'v-lookalike', '迁移脚本 1.1.30 兼容', 'todo'),
      card('agentdeck', 'v-old', '旧版说明 1.1.3', 'todo', { archived: true }),
    ],
    hermes: [card('hermes', 'h-113', 'Hermes 1.1.3 升级', 'todo')],
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [project, cards] of Object.entries(boards)) fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-row-'));
  seed(path.join(profile, 'tasks'));
  const now = Date.now();
  const titles = ['把界面工具动作改成图标按钮', 'AgentDeck 侧边栏模型与标题修复', '额度面板一行化'];
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 252, crewOpen: true,
    columns: [
      { id: 'captain', title: '队长', cmd: FAKE + ' --captain-statusline', cwd: profile, width: 460, role: 'manual', isMain: true },
      ...titles.map((title, i) => ({ id: `worker-${i}`, title, displayTitle: title, manualTitle: true,
        cmd: FAKE + ' --interruptible', cwd: profile, width: 460, role: 'manual', captainCrew: true })),
    ],
    mainSession: { colId: 'captain', cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [],
      fresh: false, crewMarked: true, waitlist: [], tasks: titles.map((title, i) => ({
        id: `task-${i}`, colId: `worker-${i}`, title, status: i === 2 ? 'queued' : 'working', sentAt: now - (3 - i) * 60000, gen: 1,
      })) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  await expect(page.locator('.column')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
  await expect.poll(() => page.evaluate(() => terms.get('captain').lastScreen)).toContain('Delegate report:');
  await page.evaluate(() => [0, 1].forEach((i) => window.deck.ptyInput(`worker-${i}`, 'keep working\r')));
  await expect.poll(() => page.evaluate(() => terms.get('worker-0').state)).toBe('working');
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function quiet() {
  await page.mouse.move(900, 400);
  await page.evaluate(() => { document.activeElement?.blur(); document.getElementById('navList').scrollTop = 0; });
}

test('队长 row is one line: crown, dot, name, tiny count, model capsule and a real switch-account button', async () => {
  const row = page.locator('.captain-item');
  const counts = row.locator('.crew-counts');
  await expect(counts).toHaveText(/^\d+$/);
  await expect(counts).toHaveAttribute('title', /干活中/);
  await expect(counts).toHaveAttribute('aria-label', /^队员：.*干活中/);
  await expect(row).toHaveAttribute('title', /^队长 · .*干活中.*(有活动)?/);
  await expect(row.locator('.cn-meta')).toBeHidden();
  await expect(row.locator('.cn-sub')).toBeHidden();
  const swap = row.locator('.claude-seat-rotate');
  await expect(swap).toHaveAttribute('aria-label', /.+/);
  await expect(swap).toHaveAttribute('title', /当前/);
  await expect(swap).toHaveText('');
  await expect(swap.locator('svg')).toHaveCount(1);
  await swap.focus();
  await expect(swap).toBeFocused();
  await page.evaluate(() => document.activeElement?.blur());
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    for (const width of [200, 252, 320, 420]) {
      await page.evaluate((w) => { config.navWidth = w; applyNavWidth(); Sidebar.render(); }, width);
      await quiet();
      const layout = await page.locator('.captain-item').evaluate((item) => {
        const r = item.getBoundingClientRect();
        const parts = ['.captain-fold', '.cn-crown', '.cn-dot', '.cn-label', '.crew-counts', '.cn-badge', '.claude-seat-rotate']
          .map((sel) => item.querySelector(sel).getBoundingClientRect());
        const label = item.querySelector('.cn-label'), css = getComputedStyle(label);
        const mid = (b) => b.top + b.height / 2;
        const swap = parts[6];
        return { height: r.height,
          oneLine: parts.every((b) => Math.abs(mid(b) - mid(parts[3])) <= 2),
          inside: parts.every((b) => b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.width > 0),
          ordered: parts.every((b, i) => i === 0 || b.left >= parts[i - 1].right - 0.5),
          clamped: css.whiteSpace === 'nowrap' && css.textOverflow === 'ellipsis' && label.scrollHeight <= label.clientHeight + 1,
          nameShown: label.scrollWidth <= label.clientWidth + 1,
          swapSize: Math.min(swap.width, swap.height) };
      });
      expect(layout, `${theme} width=${width}`).toMatchObject({ oneLine: true, inside: true, ordered: true, clamped: true, nameShown: true });
      expect(layout.height, `${theme} width=${width}`).toBeLessThanOrEqual(44);
      expect(layout.swapSize).toBeGreaterThanOrEqual(28);
    }
  }
  await page.evaluate(() => { applyTheme('dark'); config.navWidth = 252; applyNavWidth(); Sidebar.render(); });
});

test('版本进度 icon button next to 架构图 lists the next version\'s cards with a progress bar', async () => {
  await page.evaluate(() => { showView('board'); CrewMap.setMode('crew'); });
  const btn = page.locator('#versionProgressBtn');
  const panel = page.locator('#versionProgress');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', '当前版本进度');
  await expect(btn).toHaveAttribute('title', '当前版本进度');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toHaveText('');
  const box = await btn.boundingBox();
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(28);
  const tabs = await page.locator('#boardView .board-mode').boundingBox();
  expect(box.x).toBeGreaterThan(tabs.x + tabs.width - 1);
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.vp-heading')).toHaveText('v1.1.3 进度');
  const titles = ['侧边栏队长行并成一行 + 切换账号按钮重做；架构图右侧「版本进度」面板，标题很长时用省略号收尾',
    'Cmd 加号/减号放大缩小字体', '对话页和终端页草稿同步', '左下角显示版本号', '1.1.3 发版：版本号 + 额度面板一行化 + 侧边栏队长行'];
  await expect(panel.locator('.vp-title')).toHaveText(titles);
  await expect(panel.locator('.vp-item.done .vp-title')).toHaveText([titles[1], titles[2]]);
  await expect(panel.locator('.vp-status')).toHaveText(['进行中', '完成', '完成', '待验收', '待办']);
  await expect(panel.locator('.vp-summary')).toHaveText('2 / 5 完成 · 40%');
  await expect(panel.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '40');
  const first = panel.locator('.vp-title').first();
  await expect(first).toHaveAttribute('title', titles[0]);
  expect(await first.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap')).toBe(true);
  for (const b of await panel.locator('button').all()) {
    await expect(b).toHaveAttribute('aria-label', /.+/);
    await expect(b).toHaveAttribute('title', /.+/);
    await expect(b).toHaveText('');
    const area = await b.boundingBox();
    expect(Math.min(area.width, area.height)).toBeGreaterThanOrEqual(28);
  }
  // A card finished elsewhere (synced file) ticks itself while the panel is open.
  const file = path.join(profile, 'tasks', 'agentdeck.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(doc.cards.find((c) => c.id === 'v-label'), { status: 'done', updated: new Date().toISOString() });
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2));
  fs.renameSync(file + '.tmp', file);
  await expect(panel.locator('.vp-summary')).toHaveText('3 / 5 完成 · 60%', { timeout: 15000 });
  await expect(panel.locator('.vp-item').nth(3)).toHaveClass(/done/);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(700, 700);
  await expect(panel).toBeHidden();
  await page.evaluate(() => showView('terminals'));
});

test('screenshots of the sidebar and 架构图 toolbar in both themes', async () => {
  test.skip(!shots, 'AGENTDECK_SCREENSHOT_DIR not set');
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await page.evaluate(() => showView('terminals'));
    await quiet();
    await page.locator('#colNav').screenshot({ path: path.join(shots, `sidebar-${theme}.png`) });
    await page.locator('.captain-item').screenshot({ path: path.join(shots, `captain-row-${theme}.png`) });
    await page.evaluate(() => { showView('board'); CrewMap.setMode('crew'); });
    await quiet();
    await page.locator('#boardView .board-toolbar').screenshot({ path: path.join(shots, `crewmap-toolbar-${theme}.png`) });
    const toggle = page.locator('#versionProgressBtn');
    if (await toggle.count()) {
      await toggle.click();
      await expect(page.locator('#versionProgress')).toBeVisible();
      await expect(page.locator('#versionProgress .vp-item')).not.toHaveCount(0);
      await expect(page.locator('#versionProgress .vp-summary')).not.toHaveText('');
      await page.mouse.move(900, 600);
      await page.waitForTimeout(400); // the bar animates its width
      await page.screenshot({ path: path.join(shots, `version-progress-${theme}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => { applyTheme('dark'); showView('terminals'); });
});
