const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1.1.3: the sidebar 队长 row is a single line (counts and time in its tooltip),
// the Relay switch is a real icon button, and the 架构图 toolbar opens a
// 版本进度 drawer built from the next version's task cards (named, in flight,
// or a prerequisite of one).
// Isolated profile, task store in <profile>/tasks, stand-in PTYs only.
// Set AGENTDECK_SCREENSHOT_DIR to keep PNGs.
// Seeded doing cards carry a session_id: an unbound doing card would be
// auto-dispatched by the task heartbeat.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_SCREENSHOT_DIR;
// Keep pending-release fixtures ahead of the runtime when its version is bumped.
const appVersion = require('../../package.json').version;
const [major, minor, patch] = appVersion.split('.').map(Number);
const targetVersion = `${major}.${minor}.${patch + 1}`;
const laterVersion = `${major}.${minor + 1}.0`;
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
      card('agentdeck', 'v-112', `重启 AgentDeck 后自动续派队员（${appVersion}）`, 'done'),
      card('agentdeck', 'v-row', '侧边栏队长行并成一行 + 切换账号按钮重做；架构图右侧「版本进度」面板，标题很长时用省略号收尾', 'doing', { detail: `看整体进度。${targetVersion}`,
        session_id: 'worker-0', updated: at(2), assignee: { agent: 'Claude', model: 'claude-opus-5-5' }, latest_receipt: '队长行已并成一行，正在调切换账号按钮的点击面积和深浅主题配色。' }),
      card('agentdeck', 'v-font', 'Cmd 加号/减号放大缩小字体', 'done', { detail: `用户：按 Cmd+ 字变大，框不变。${targetVersion}`, created: at(190), updated: at(95),
        assignee: { agent: 'Cursor', model: 'grok-4.7-high-fast' }, latest_receipt: '分支 feat/font-zoom 已推送：Cmd+/- 只改字号，面板尺寸不变；单测 12/12 通过。' }),
      card('agentdeck', 'v-draft', '对话页和终端页草稿同步', 'done', { detail: targetVersion, archived: true, created: at(240), updated: at(120),
        assignee: { agent: 'Cursor', model: 'grok-4.7-high-fast' }, latest_receipt: '两页共用一份草稿，切换时不丢字。' }),
      card('agentdeck', 'v-label', '左下角显示版本号', 'review', { version: targetVersion, created: at(80), updated: at(20),
        assignee: { agent: 'Codex', model: 'gpt-6-luna' }, latest_receipt: '左下角改成 v 加版本号，等验收。' }),
      card('agentdeck', 'v-release', `${targetVersion} 发版：版本号 + 额度面板一行化 + 侧边栏队长行`, 'todo', { flag: 'blocked', depends_on: ['v-dep'], updated: at(40) }),
      card('agentdeck', 'v-dep', 'bug：cursor 会话正在干活却被标成已完成', 'doing', { session_id: 'worker-1', created: at(50), updated: at(5),
        assignee: { agent: 'Codex', model: 'GPT-6.1-Sol high' }, latest_receipt: '定位到状态判定只看静默时长，正在补「仍在输出」的判断和回归测试。' }),
      card('agentdeck', 'v-wip', '任务看板 v2：更紧凑、能拖动', 'review', { created: at(130), updated: at(10),
        assignee: { agent: 'Claude', model: 'claude-sonnet-5-5' } }),
      card('agentdeck', 'v-next', `${laterVersion}：派活指定 Mac/Windows`, 'doing', { session_id: 'worker-2' }),
      card('agentdeck', 'v-backlog', 'Artifacts：按项目收集回执文件', 'todo'),
      card('agentdeck', 'v-lookalike', `迁移脚本 ${targetVersion}0 兼容`, 'todo'),
      card('agentdeck', 'v-old', `旧版说明 ${targetVersion}`, 'todo', { archived: true }),
    ],
    hermes: [card('hermes', 'h-113', `Hermes ${targetVersion} 升级`, 'todo')],
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

test('版本进度 icon button next to 架构图 slides in a drawer with the next version\'s cards, live', async () => {
  await page.evaluate(() => { showView('board'); CrewMap.setMode('crew'); });
  const btn = page.locator('#versionProgressBtn');
  const drawer = page.locator('#versionProgress');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', '版本进度');
  await expect(btn).toHaveAttribute('title', '版本进度');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toHaveText('');
  await expect(drawer).toBeHidden();
  const box = await btn.boundingBox();
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(28);
  const tabs = await page.locator('#boardView .board-mode').boundingBox();
  expect(box.x).toBeGreaterThan(tabs.x + tabs.width - 1);
  const mapWidth = (await page.locator('#crewMap').boundingBox()).width;
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.locator('.vd-version')).toHaveText(`v${targetVersion}`);
  await expect(drawer.locator('.vd-sub')).toHaveText(`下一版 · 正在用 v${appVersion}`);
  // The drawer sits right of the crew map, which narrows instead of being covered.
  await expect.poll(async () => (await drawer.boundingBox()).x).toBeGreaterThan(1280 - 400);
  const map = await page.locator('#crewMap').boundingBox();
  const side = await drawer.boundingBox();
  expect(map.width).toBeLessThan(mapWidth - 300);
  expect(map.x + map.width).toBeLessThanOrEqual(side.x + 1);
  expect(side.x + side.width).toBeLessThanOrEqual(1281);

  await expect(drawer.locator('.vd-group-head > span:nth-child(2)')).toHaveText(['进行中', '待验收', '待办', '已完成']);
  const titles = (group) => drawer.locator(`.vd-group[data-group="${group}"] .vd-title`);
  const longTitle = '侧边栏队长行并成一行 + 切换账号按钮重做；架构图右侧「版本进度」面板，标题很长时用省略号收尾';
  await expect(titles('doing')).toHaveText([longTitle, 'bug：cursor 会话正在干活却被标成已完成']);
  await expect(titles('review')).toHaveText(['任务看板 v2：更紧凑、能拖动', '左下角显示版本号']);
  await expect(titles('todo')).toHaveText([`${targetVersion} 发版：版本号 + 额度面板一行化 + 侧边栏队长行`]);
  await expect(titles('done')).toHaveText(['Cmd 加号/减号放大缩小字体', '对话页和终端页草稿同步']);
  await expect(drawer.locator('.vd-item.done .vd-mark svg')).toHaveCount(2);
  await expect(drawer.locator('.vd-count')).toHaveText('2 / 7 完成');
  await expect(drawer.locator('.vd-percent')).toHaveText('29');
  await expect(drawer.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '29');
  await expect(drawer.locator('.vd-seg')).toHaveCount(4);

  const dep = drawer.locator('.vd-item[data-card-id="v-dep"]');
  await expect(dep.locator('.vd-tag')).toHaveText('前置');
  await expect(dep.locator('.vd-model')).toHaveText('GPT-6.1 Sol');
  await expect(dep.locator('.vd-model svg')).toHaveCount(1);
  await expect(dep.locator('.vd-receipt')).toHaveText(/^定位到状态判定/);
  await expect(dep.locator('.vd-time')).toHaveText('50 分');
  await expect(drawer.locator('.vd-item[data-card-id="v-wip"] .vd-tag')).toHaveText('在做');
  await expect(drawer.locator('.vd-item[data-card-id="v-wip"] .vd-receipt')).toHaveText('干活中，还没有回执');
  await expect(drawer.locator('.vd-item[data-card-id="v-release"] .vd-receipt')).toHaveText('等「bug：cursor 会话正在干活却被标成已完成」完成');
  await expect(drawer.locator('.vd-item[data-card-id="v-font"] .vd-time')).toHaveText('1 时 35 分');
  const first = titles('doing').first();
  await expect(first).toHaveAttribute('title', longTitle);
  expect(await first.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap')).toBe(true);
  for (const b of await drawer.locator('button').all()) {
    await expect(b).toHaveAttribute('aria-label', /.+/);
    await expect(b).toHaveAttribute('title', /.+/);
    await expect(b).toHaveText('');
    const area = await b.boundingBox();
    expect(Math.min(area.width, area.height)).toBeGreaterThanOrEqual(28);
  }
  await drawer.locator('.vd-rules summary').click();
  await expect(drawer.locator('.vd-rules dt')).toHaveText(['点名', '在做', '已纳入', '前置']);
  await drawer.locator('.vd-rules summary').click();

  // Cards finished elsewhere (synced file) tick themselves while the drawer is
  // open; in-flight work that finishes stays listed as 已纳入.
  const file = path.join(profile, 'tasks', 'agentdeck.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  [['v-label', 1000], ['v-wip', 2000]].forEach(([id, ago]) => Object.assign(doc.cards.find((c) => c.id === id), { status: 'done', updated: new Date(Date.now() - ago).toISOString() }));
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2));
  fs.renameSync(file + '.tmp', file);
  await expect(drawer.locator('.vd-count')).toHaveText('4 / 7 完成', { timeout: 15000 });
  await expect(titles('done')).toHaveText(['左下角显示版本号', '任务看板 v2：更紧凑、能拖动', 'Cmd 加号/减号放大缩小字体', '对话页和终端页草稿同步']);
  await expect(drawer.locator('.vd-item[data-card-id="v-wip"] .vd-tag')).toHaveText('已纳入');
  await expect(drawer.locator('.vd-group[data-group="review"]')).toHaveCount(0);

  // A monitor, not a popover: clicking the map leaves it open. Esc folds it.
  // (an empty spot of the map: a click on a card would open that session's column instead)
  const spot = await page.evaluate(() => { const v = document.querySelector('#crewMap .cm-viewport').getBoundingClientRect();
    for (let y = v.bottom - 6; y > v.top; y -= 12) for (let x = v.left + 6; x < v.right; x += 12) { const n = document.elementFromPoint(x, y); if (n && n.closest('.cm-viewport') && !n.closest('.cm-node, .cm-pane, .cm-project, .cm-pop, .cm-hint, .cm-tray, .vd')) return [x, y]; }
    return null; });
  await page.mouse.click(spot[0], spot[1]);
  await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('agentdeck.versionDrawer')).open)).toBe(true);
  await drawer.focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('agentdeck.versionDrawer')).open)).toBe(false);
  await expect.poll(async () => (await page.locator('#crewMap').boundingBox()).width).toBeCloseTo(mapWidth, 0);
  await btn.click();
  await expect(drawer).toBeVisible();
  await drawer.locator('.vd-close').click();
  await expect(drawer).toBeHidden();
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
      await expect(page.locator('#versionProgress .vd-item')).not.toHaveCount(0);
      await expect(page.locator('#versionProgress .vd-count')).not.toHaveText('');
      await page.mouse.move(300, 600);
      await page.waitForTimeout(500); // the drawer slides and the bar animates
      await page.screenshot({ path: path.join(shots, `version-progress-${theme}.png`) });
      await page.locator('#versionProgress').screenshot({ path: path.join(shots, `version-progress-drawer-${theme}.png`) });
      await page.locator('#versionProgress .vd-close').click();
    }
  }
  await page.evaluate(() => { applyTheme('dark'); showView('terminals'); });
});
