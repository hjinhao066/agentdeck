const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 任务看板 page: sidebar entry, crew-map tab, lanes × status columns, card →
// session. Real renderer, isolated userData (cards in <profile>/tasks), PTYs
// running only the stand-in TUI. Set AGENTDECK_TASK_BOARD_SHOTS to keep PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_TASK_BOARD_SHOTS;
let application, page, profile;
const errors = [];

async function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
async function resize(width, height) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}

function seed(dir) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  let order = 0;
  const card = (project, id, title, status, extra = {}) => ({ id, project, title, detail: '测试卡片', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(600), updated: at(30), archived: false, ...extra });
  const claude = { agent: 'claude', model: 'Opus 5.5' };
  const boards = {
    '客户门户': [
      card('客户门户', 'p-login', '实现客户登录和多租户权限验证，包含跨项目访问边界及所有错误处理与重试提示', 'doing', { session_id: 'w-login', assignee: claude, updated: at(3) }),
      card('客户门户', 'p-ui', '构建数据工作台界面', 'review', { session_id: 'w-ui', assignee: { agent: 'codex', model: 'GPT-5.5' }, latest_receipt: '已完成实现、单元测试和端到端验证，长段中文回执在卡片里最多显示两行，超出的部分用省略号收尾。', updated: at(12) }),
      card('客户门户', 'p-sso', '接入企业 SSO', 'todo', { depends_on: ['p-login'], flag: 'blocked', updated: at(50) }),
      card('客户门户', 'p-copy', '整理登录页文案', 'todo', { updated: at(80) }),
      card('客户门户', 'p-ask', '确认密码策略', 'needs_user', { session_id: 'w-ask', assignee: claude, latest_receipt: '需要你决定：密码最短 8 位还是 12 位？', updated: at(5) }),
      card('客户门户', 'p-done', '登录接口限流', 'done', { assignee: claude, latest_receipt: '完成，限流 10 次/分钟。', updated: at(240) }),
      card('客户门户', 'p-old', '旧版登录页', 'done', { archived: true, updated: at(9000) }),
    ],
    '报表服务': [
      card('报表服务', 'r-export', '新增汇总与导出报表', 'doing', { session_id: 'w-report', assignee: { agent: 'cursor', model: 'Grok 4.7' }, updated: at(1) }),
      card('报表服务', 'r-migrate', '同步迁移数据和历史记录', 'review', { session_id: 'w-gone', flag: 'failed', rework_count: 2, latest_receipt: '测试环境缺少数据访问权限，请队长处理后再继续运行迁移验证。', updated: at(20) }),
      card('报表服务', 'r-filter', '实现报告筛选和查询接口', 'todo', { updated: at(90) }),
      card('报表服务', 'r-held', '报表权限复核', 'todo', { flag: 'held', updated: at(400) }),
      card('报表服务', 'r-done1', '报表模板', 'done', { latest_receipt: '模板已合并。', updated: at(1500) }),
      card('报表服务', 'r-done2', '导出 CSV', 'done', { updated: at(3000) }),
    ],
    'agentdeck': [
      card('agentdeck', 'a-board', '任务看板入口和页面打磨', 'doing', { session_id: 'w-deck', assignee: claude, latest_receipt: '侧边栏入口和架构图切换已接好。', updated: at(2) }),
      card('agentdeck', 'a-notes', '更新使用说明', 'todo', { depends_on: ['a-board', 'p-login', 'r-export'], flag: 'blocked', updated: at(100) }),
    ],
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [project, cards] of Object.entries(boards)) fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
}

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-board-ui-'));
  seed(path.join(profile, 'tasks'));
  const column = (id, title, project) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, project });
  const workers = [column('w-login', '登录权限', '客户门户'), column('w-ui', '工作台界面', '客户门户'), column('w-ask', '密码策略', '客户门户'), column('w-report', '导出报表', '报表服务'), column('w-deck', '看板打磨', 'AgentDeck')];
  const states = ['working', 'done', 'working', 'working', 'working'];
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark', fitWindow: true, fitCols: 3, taskBoard: { dispatcher: 'captain' },
    columns: [{ ...column('cap', '队长', ''), isMain: true, captainCrew: false }, ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: states[i], sentAt: now - 60_000 + i, turnId: '', receipt: null })) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(6);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(6);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null;
});

// Nothing in the toolbars overlaps or wraps, every card sits inside its cell
// without touching its neighbours, and card text stays inside the card.
async function assertBoardLayout() {
  const g = await page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (n) => !n.hidden && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
    const rows = ['.tbv-toolbar .tbv-heading', '.tbv-toolbar .board-toolbar-actions', '.tbv-filters'].map((s) => document.querySelector('#taskBoardView ' + s));
    const bars = ['.tbv-toolbar .board-toolbar-actions', '.tbv-filters'].map((s) => [...document.querySelector('#taskBoardView ' + s).children].filter(shown).map((n) => ({ cls: n.className || n.tagName, ...rect(n) })));
    const cells = [...document.querySelectorAll('.tbv-cell')].map((cell) => ({ cell: rect(cell), cards: [...cell.children].map((card) => ({ id: card.dataset.cardId, ...rect(card),
      parts: [...card.querySelectorAll('.tbv-title, .tbv-owner, .tbv-receipt, .tbv-foot, .tbv-tag, .tbv-time')].filter(shown).map((p) => ({ cls: p.className, ...rect(p), lh: parseFloat(getComputedStyle(p).lineHeight) })) })) }));
    const heads = [...document.querySelectorAll('.tbv-head')].map(rect);
    const firstCells = [...document.querySelectorAll('.tbv-lane:first-child .tbv-cell')].map(rect);
    return { view: rect(document.getElementById('taskBoardView')), rows: rows.map(rect), bars, cells, heads, firstCells };
  });
  const overlaps = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
  for (const bar of g.bars) for (let i = 0; i < bar.length; i++) {
    expect(bar[i].height, bar[i].cls + ' single line').toBeLessThanOrEqual(34);
    expect(bar[i].right, bar[i].cls + ' inside window').toBeLessThanOrEqual(g.view.right);
    for (const b of bar.slice(i + 1)) expect(overlaps(bar[i], b), `${bar[i].cls}/${b.cls} overlap`).toBe(false);
  }
  expect(overlaps(g.rows[0], g.rows[1]), 'title and view switch overlap').toBe(false);
  // header columns line up with the lane columns
  g.heads.forEach((h, i) => { expect(Math.abs(h.x - g.firstCells[i].x)).toBeLessThanOrEqual(1); expect(Math.abs(h.width - g.firstCells[i].width)).toBeLessThanOrEqual(1); });
  for (const { cell, cards } of g.cells) for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    expect(c.width, c.id + ' readable width').toBeGreaterThanOrEqual(170);
    expect(c.x).toBeGreaterThanOrEqual(cell.x - 0.5); expect(c.right).toBeLessThanOrEqual(cell.right + 0.5);
    for (const d of cards.slice(i + 1)) expect(overlaps(c, d), `${c.id}/${d.id} overlap`).toBe(false);
    for (const p of c.parts) {
      expect(p.right, `${c.id} ${p.cls} fits`).toBeLessThanOrEqual(c.right - 1);
      expect(p.bottom, `${c.id} ${p.cls} fits`).toBeLessThanOrEqual(c.bottom - 1);
      if (/tbv-(title|receipt)/.test(p.cls)) expect(p.height, `${c.id} ${p.cls} at most two lines`).toBeLessThanOrEqual(p.lh * 2 + 0.5);
      if (/tbv-(owner|foot)$/.test(p.cls)) expect(p.height, `${c.id} ${p.cls} one line`).toBeLessThanOrEqual(22);
    }
  }
  const icons = await page.evaluate(() => [...document.querySelectorAll('#taskBoardView .tbv-icon')].map((n) => ({ label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), w: n.getBoundingClientRect().width })));
  expect(icons.length).toBe(2); // close and refresh; no write actions
  for (const b of icons) { expect(b.label).toBeTruthy(); expect(b.title).toBeTruthy(); expect(b.svg).toBe(true); expect(b.text).toBe(''); expect(b.w).toBeGreaterThanOrEqual(28); }
}

test('sidebar entry, crew-map tab and the board: lanes, columns, colours, layout at two sizes and both themes', async () => {
  await launch();
  const originals = Object.fromEntries(fs.readdirSync(path.join(profile, 'tasks')).map((name) => [name, fs.readFileSync(path.join(profile, 'tasks', name), 'utf8')]));
  const entry = page.locator('#navTop .nav-row[data-nav="tasks"]');
  for (const [width, height] of [[1440, 900], [1280, 800]]) for (const theme of ['dark', 'light']) {
    const tag = `${width}x${height}-${theme}`;
    await resize(width, height);
    await page.evaluate((t) => applyTheme(t), theme);
    if (await page.locator('#taskBoardView').isVisible()) await page.keyboard.press('Escape');
    await page.evaluate(() => { showView('terminals'); document.activeElement.blur(); });

    // 1) sidebar: 任务看板 sits with 队长 / search as a first-level entry
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText('任务看板');
    expect(await entry.locator('svg').count()).toBe(1);
    const order = await page.locator('#navTop > *').evaluateAll((n) => n.map((x) => x.dataset.nav || x.id));
    expect(order.slice(0, 4)).toEqual(['new', 'captain', 'tasks', 'navSearchSlot']);
    await screenshot(`1-sidebar-${tag}`);

    // 2) the board, from the sidebar
    await entry.click();
    await expect(page.locator('#taskBoardView')).toBeVisible();
    await expect(entry).toHaveClass(/active/);
    await expect(page.locator('.tbv-head .tbv-head-label')).toHaveText(['待办', '进行中', '待验收', '需要你', '完成']);
    await expect(page.locator('.tbv-head .tbv-count')).toHaveText(['5', '3', '2', '1', '3']);
    await expect(page.locator('.tbv-lane-name')).toHaveText(['agentdeck', '报表服务', '客户门户'].sort((a, b) => a.localeCompare(b)));
    await expect(page.locator('.tbv-card')).toHaveCount(14);
    await expect(page.locator('.tbv-card[data-card-id="p-old"]')).toHaveCount(0);
    await expect(page.locator('.tbv-card[data-card-id="r-migrate"] .tbv-tag.failed')).toHaveText('失败');
    await expect(page.locator('.tbv-card[data-card-id="p-ui"] .tbv-receipt')).toContainText('已完成实现');
    await expect(page.locator('.tbv-card[data-card-id="p-login"] .tbv-owner-name')).toHaveText('登录权限');
    await expect(page.locator('.tbv-card[data-card-id="r-migrate"]')).not.toHaveClass(/linked/);
    await expect(page.locator('.tbv-card[data-card-id="p-copy"] .tbv-owner-name')).toHaveText('未派活');
    await expect(page.locator('.tbv-card[data-card-id="r-migrate"] .tbv-owner-name')).toHaveText('会话已关闭');
    // at the two standard sizes all five columns fit without sideways scrolling
    expect(await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'); return s.scrollWidth <= s.clientWidth; })).toBe(true);
    // one palette: the board lane, the crew map project (session project spelt 'AgentDeck') and the hue function agree
    const hues = await page.evaluate(() => [...document.querySelectorAll('.tbv-lane')].map((l) => [l.dataset.project, l.style.getPropertyValue('--project-hue'), String(CrewMapCore.projectHue(l.dataset.project))]));
    for (const [, set, expected] of hues) expect(set).toBe(expected);
    await assertBoardLayout();
    await screenshot(`2-board-${tag}`);

    // 3) 架构图 tab inside the board goes to the crew map; its 任务看板 tab comes back
    await page.locator('#taskBoardView .board-mode button[data-view="crew"]').click();
    await expect(page.locator('#taskBoardView')).toBeHidden();
    await expect(page.locator('#crewMap')).toBeVisible();
    await expect(page.locator('#boardView .board-mode button')).toHaveText(['架构图', '自由画布', '任务看板']);
    await expect(page.locator('#boardView .board-mode button[data-mode="crew"]')).toHaveClass(/active/);
    const mapHue = await page.evaluate(() => [...document.querySelectorAll('.cm-project')].find((g) => g.dataset.project === 'AgentDeck')?.style.getPropertyValue('--project-hue'));
    expect(mapHue).toBe(hues.find(([key]) => key === 'agentdeck')[1]);
    await screenshot(`3-crewmap-tab-${tag}`);
    await page.locator('#boardTasksTab').click();
    await expect(page.locator('#taskBoardView')).toBeVisible();
    await expect(page.locator('#boardViewBtn')).not.toHaveClass(/\bon\b/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#taskBoardView')).toBeHidden();
    await expect(page.locator('#crewMap')).toBeVisible();
    await expect(entry).not.toHaveClass(/active/);
  }

  // narrow window: nothing overlaps, the five columns scroll sideways at a readable width
  await page.evaluate(() => showView('terminals'));
  await resize(980, 700);
  await entry.click();
  await assertBoardLayout();
  expect(await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'); return s.scrollWidth > s.clientWidth; })).toBe(true);
  // the deck toolbar's width buttons stay on one line too
  for (const h of await page.locator('#tbSplit .split-btn').evaluateAll((n) => n.map((b) => b.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(26);
  await screenshot('4-board-980x700-light');

  // project filter, then clicking a card opens its session
  await page.locator('#tbvProject').selectOption('报表服务');
  await expect(page.locator('.tbv-lane')).toHaveCount(1);
  await expect(page.locator('.tbv-lane[data-project="报表服务"] .tbv-card')).toHaveCount(6);
  await expect(page.locator('#taskBoardView .tbv-archive, #taskBoardView [draggable="true"], #taskBoardView input, #taskBoardView textarea')).toHaveCount(0);
  await page.locator('#tbvProject').selectOption('');
  await page.locator('.tbv-card[data-card-id="r-export"]').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'w-report']);
  for (const [name, raw] of Object.entries(originals)) expect(fs.readFileSync(path.join(profile, 'tasks', name), 'utf8')).toBe(raw);
  expect(errors).toEqual([]);
});

test('the board stays read-only and opens with no cards', { tag: '@smoke' }, async () => {
  await launch();
  fs.rmSync(path.join(profile, 'tasks'), { recursive: true, force: true });
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  await expect(page.locator('.tbv-empty-board')).toBeVisible();
  await expect(page.locator('.tbv-grid')).toBeHidden();
  await page.locator('.tbv-refresh').click();
  await expect(page.locator('.tbv-empty-board')).toBeVisible();
  // the sidebar entry toggles the page closed again
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  expect(fs.existsSync(path.join(profile, 'tasks'))).toBe(false);
  expect(errors).toEqual([]);
});

test('external archival of the selected project immediately restores all remaining project lanes', async () => {
  await launch();
  await page.locator('#taskBoardBtn').click();
  await page.locator('#tbvProject').selectOption('报表服务');
  await expect(page.locator('.tbv-lane')).toHaveCount(1);
  const file = path.join(profile, 'tasks', '报表服务.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.cards.forEach((c) => { c.archived = true; });
  fs.writeFileSync(file + '.remote.tmp', JSON.stringify(doc));
  fs.renameSync(file + '.remote.tmp', file);
  await expect(page.locator('#tbvProject')).toHaveValue('');
  await expect(page.locator('.tbv-lane')).toHaveCount(2);
  await expect(page.locator('.tbv-card')).toHaveCount(8);
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#crewMap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Escape restores sidebar focus and keyboard column navigation closes the overlay without replacing terminals', async () => {
  await launch();
  const originalIds = await page.evaluate(() => columns.map((c) => c.id));
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('#tbvProject')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#taskBoardBtn')).toBeFocused();
  await page.locator('#taskBoardBtn').click();
  await page.locator('.tbv-close').click();
  await expect(page.locator('#taskBoardBtn')).toBeFocused();
  for (const view of ['terminals', 'board']) {
    await page.evaluate((v) => showView(v), view);
    await page.locator('#taskBoardBtn').click();
    await expect(page.locator('#taskBoardView')).toBeVisible();
    await page.keyboard.press('Meta+1');
    await expect(page.locator('#taskBoardView')).toBeHidden();
    expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(originalIds);
    for (const id of originalIds) expect(await page.evaluate((s) => window.deck.ptyIsAlive(s), id)).toBe(true);
  }
  expect(errors).toEqual([]);
});
