const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 任务看板 page: sidebar entry, crew-map tab, foldable project groups × status columns,
// drag / keyboard moves, the card detail drawer and the 需要你 answer box, plus
// the crew map's 队长 numbers. Real renderer, isolated userData (cards in
// <profile>/tasks), PTYs running only the stand-in TUI. Set
// AGENTDECK_TASK_BOARD_SHOTS to keep PNGs.
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

function seed(dir, big) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  let order = 0;
  const card = (project, id, title, status, extra = {}) => ({ id, project, title, detail: '测试卡片', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(600), updated: at(30), archived: false, ...extra });
  const claude = { agent: 'claude', model: 'Opus 5.5' };
  const boards = {
    '客户门户': [
      card('客户门户', 'p-login', '实现客户登录和多租户权限验证，包含跨项目访问边界及所有错误处理与重试提示', 'doing', { session_id: 'w-login', assignee: claude, updated: at(3) }),
      card('客户门户', 'p-ui', '构建数据工作台界面', 'review', { session_id: 'w-ui', assignee: { agent: 'codex', model: 'GPT-5.5' }, latest_receipt: '已完成实现、单元测试和端到端验证。', updated: at(12) }),
      card('客户门户', 'p-sso', '接入企业 SSO', 'todo', { depends_on: ['p-login'], flag: 'blocked', updated: at(50) }),
      card('客户门户', 'p-copy', '整理登录页文案', 'todo', { updated: at(80) }),
      card('客户门户', 'p-faq', '补充常见问题', 'todo', { updated: at(85) }),
      card('客户门户', 'p-ask', '确认密码策略', 'needs_user', { session_id: 'w-ask', attempt_id: 'att-ask', attempt_closed: false, last_event: 'att-ask:ask:command:abc', assignee: claude,
        detail: '密码策略要和安全规范一致，规范在 /Users/demo/docs/security/password-policy.md 。', latest_receipt: '密码最短 8 位还是 12 位？', updated: at(5) }),
      card('客户门户', 'p-done', '登录接口限流', 'done', { assignee: claude, latest_receipt: '完成，限流 10 次/分钟。', updated: at(240) }),
      card('客户门户', 'p-old', '旧版登录页', 'done', { archived: true, updated: at(9000) }),
    ],
    '报表服务': [
      card('报表服务', 'r-export', '新增汇总与导出报表', 'doing', { session_id: 'w-report', assignee: { agent: 'cursor', model: 'Grok 4.7' }, updated: at(1) }),
      card('报表服务', 'r-migrate', '同步迁移数据和历史记录', 'review', { session_id: 'w-gone', flag: 'failed', rework_count: 2, latest_receipt: '测试环境缺少数据访问权限，请队长处理后再继续运行迁移验证。', updated: at(20) }),
      card('报表服务', 'r-filter', '实现报告筛选和查询接口', 'todo', { updated: at(90) }),
      card('报表服务', 'r-held', '报表权限复核', 'todo', { flag: 'held', updated: at(400) }),
      card('报表服务', 'r-lost', '核对上月对账单', 'needs_user', { latest_receipt: '已结束，未提交回执', last_event: 'att-old:fallback::abc', updated: at(40) }),
      card('报表服务', 'r-done1', '报表模板', 'done', { latest_receipt: '模板已合并。', updated: at(1500) }),
      card('报表服务', 'r-done2', '导出 CSV', 'done', { updated: at(3000) }),
    ],
    'agentdeck': [
      card('agentdeck', 'a-board', '任务看板入口和页面打磨', 'doing', { session_id: 'w-deck', assignee: claude, latest_receipt: '侧边栏入口和架构图切换已接好。', updated: at(2) }),
      card('agentdeck', 'a-notes', '更新使用说明', 'todo', { depends_on: ['a-board', 'p-login', 'r-export'], flag: 'blocked', updated: at(100) }),
    ],
  };
  if (big) {
    // the size the user really has: 5 projects, 40 cards still open, one project far busier than the rest
    for (let i = 0; i < 11; i++) boards.agentdeck.push(card('agentdeck', 'a-doing' + i, `进行中的任务 ${i + 1}：一个比较长的标题用来检查一行放不下时会不会撑高卡片`, 'doing', { updated: at(4 + i), ...(i === 0 ? { flag: 'quota', resource_failure: 'quota' } : {}) }));
    for (let i = 0; i < 4; i++) boards.agentdeck.push(card('agentdeck', 'a-todo' + i, `排着队的任务 ${i + 1}`, 'todo'));
    for (let i = 0; i < 5; i++) boards.agentdeck.push(card('agentdeck', 'a-done' + i, `做完的任务 ${i + 1}`, 'done'));
    boards['hermes-music'] = [0, 1, 2, 3, 4, 5].map((i) => card('hermes-music', 'm-' + i, `音乐页任务 ${i + 1}`, i < 3 ? 'doing' : 'todo'));
    boards['旧项目'] = [0, 1].map((i) => card('旧项目', 'o-' + i, `早就做完的任务 ${i + 1}`, 'done', { latest_receipt: '已完成。', updated: at(5000) }));
    boards['type4me-windows'] = [0, 1, 2, 3, 4, 5].map((i) => card('type4me-windows', 't-' + i, `Windows 输入法任务 ${i + 1}`, ['doing', 'doing', 'todo', 'todo', 'review', 'needs_user'][i], i === 5 ? { latest_receipt: '默认用微软还是豆包语音？' } : {}));
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [project, cards] of Object.entries(boards)) fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
  return Object.values(boards).flat().filter((c) => !c.archived);
}
const readCard = (id) => fs.readdirSync(path.join(profile, 'tasks')).filter((n) => n.endsWith('.json'))
  .flatMap((n) => JSON.parse(fs.readFileSync(path.join(profile, 'tasks', n), 'utf8')).cards).find((c) => c.id === id);
// What 队长 has been told through the receipt channel (waiting or already handed over).
const captainNotices = () => page.evaluate(() => [...config.mainSession.pending, ...config.mainSession.inflight].filter((p) => p.title === '任务看板').map((p) => p.summary));
const cellIds = (project, status) => page.locator(`.tbv-lane[data-project="${project}"] .tbv-cell[data-status="${status}"] .tbv-card`).evaluateAll((n) => n.map((x) => x.dataset.cardId));
// Finite motion inside the board: the open slide and a card glide. Infinite
// running lights are ignored. A box read during that motion is stale once it
// ends — drag aims only 6px past a midpoint, and the open slide moves cards
// by up to 10px — so every geometry read waits until the motion has finished.
async function boardAtRest() {
  await expect.poll(() => page.evaluate(() => {
    const view = document.getElementById('taskBoardView');
    if (!view) return 0;
    return document.getAnimations().filter((a) => a.effect && a.effect.target && view.contains(a.effect.target) && a.effect.getComputedTiming().iterations !== Infinity && a.playState === 'running').length;
  })).toBe(0);
}
// A task-store refresh replaces lane nodes. Re-resolve the locator when a
// measurement races that repaint instead of dereferencing a detached node.
async function boxOf(locator) {
  let box;
  await expect.poll(async () => { box = await locator.boundingBox(); return box; }).not.toBeNull();
  return box;
}
async function bounds(locator) {
  await boardAtRest();
  return boxOf(locator);
}
const center = async (locator) => { const b = await bounds(locator); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// A real pointer drag: press on `from`, move in steps to (x, y), optionally stop before releasing.
async function drag(from, x, y, { release = true } = {}) {
  const a = await center(from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 8, a.y + 8, { steps: 2 });
  await page.mouse.move(x, y, { steps: 8 });
  if (release) await page.mouse.up();
}
// Aim at `anchor` (its center, or its top edge when `edge` is set) shifted by `dy`.
// The open slide and a glide after a cancelled drag both move cards. The reorder
// aim is only 6px past a midpoint, so the box is read once that motion is idle,
// then the pointer is released on that same reading.
async function dragAim(from, anchor, dy, { release = true, edge = false } = {}) {
  const point = (b) => edge ? { x: b.x + 60, y: b.y + dy } : { x: b.x + b.width / 2, y: b.y + b.height / 2 + dy };
  await boardAtRest();
  const a = await boxOf(from);
  const p = point(await boxOf(anchor));
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 2 });
  await page.mouse.move(p.x, p.y, { steps: 8 });
  if (release) await page.mouse.up();
}

let seeded = [];
async function launch(big = false) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-board-ui-'));
  seeded = seed(path.join(profile, 'tasks'), big);
  const column = (id, title, project) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, project });
  const workers = [column('w-login', '登录权限', '客户门户'), column('w-ui', '工作台界面', '客户门户'), column('w-ask', '密码策略', '客户门户'), column('w-report', '导出报表', '报表服务'), column('w-deck', '看板打磨', 'AgentDeck')];
  const states = ['working', 'done', 'working', 'working', 'failed'];
  const now = Date.now();
  // Large read-only fixtures have unbound doing cards. Route their heartbeat
  // notices to the stand-in Captain so they never launch a real provider CLI.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 3, taskBoard: { dispatcher: 'captain' },
    columns: [{ ...column('cap', '队长', ''), isMain: true, captainCrew: false }, ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: states[i], sentAt: now - 60_000 + i, turnId: '',
        receipt: states[i] === 'failed' ? { summary: '', files: [], failed: '额度用尽' } : states[i] === 'done' ? { summary: '已完成。', files: [] } : null })) },
  }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  // (a busy machine can take well over five seconds to bring the page up)
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(6);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(6);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  // A force-closed Electron's helpers can still hold files in the profile for a few seconds (EPERM on Windows):
  // a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
  application = null;
});

// Nothing in the toolbars overlaps, every group's cells sit under the shared
// column heads, every card stays inside its cell (a two-line title, one row of
// news and time; 需要你 may take two lines for its question), and every tool
// action is an icon button with a tooltip, a name and a real target.
async function assertBoardLayout(minCard, stacked = false) {
  await boardAtRest();
  const g = await page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (n) => !n.hidden && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
    const barGroups = [...document.querySelector('#taskBoardView .tbv-filters').children].filter(shown);
    // Project chips wrap as whole controls over the full width of the bar, beside the tally and tools
    // on the first row and under them after it: what must not touch is each chip and that block.
    const bar = barGroups.flatMap((n) => n.classList.contains('tbv-projects') ? [...n.querySelectorAll('.tbv-chip')].filter(shown) : [n]).map((n) => ({ cls: n.className, ...rect(n) }));
    const chips = [...document.querySelectorAll('#taskBoardView .tbv-chip')].filter(shown);
    const chipNames = chips.map((n) => { const name = n.querySelector('.tbv-chip-name'); return { text: name.textContent, scrollWidth: name.scrollWidth, clientWidth: name.clientWidth }; });
    const cells = [...document.querySelectorAll('.tbv-cell')].filter(shown).map((cell) => ({ cell: rect(cell), cards: [...cell.querySelectorAll('.tbv-card')].map((card) => ({ id: card.dataset.cardId, status: card.dataset.status, ...rect(card),
      title: parseFloat(getComputedStyle(card.querySelector('.tbv-title')).fontSize),
      laneName: parseFloat(getComputedStyle(document.querySelector('.tbv-lane-name')).fontSize),
      parts: [...card.querySelectorAll('.tbv-title, .tbv-question, .tbv-activity, .tbv-tag, .tbv-time')].filter(shown).map((p) => ({ cls: p.className, ...rect(p) })) })) }));
    const icons = [...document.querySelectorAll('#taskBoardView .tbv-icon')].filter(shown).map((n) => ({ label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height }));
    return { view: rect(document.getElementById('taskBoardView')), bar, barGroups: barGroups.map((n) => ({ cls: n.className, ...rect(n) })), projects: rect(document.querySelector('#taskBoardView .tbv-projects')), chipCount: chips.length, chipNames, cells, icons, heads: [...document.querySelectorAll('.tbv-head')].filter(shown).map(rect), grid: rect(document.querySelector('.tbv-lanes')),
      laneHeads: [...document.querySelectorAll('.tbv-lane-head')].map(rect),
      lanes: [...document.querySelectorAll('.tbv-lane:not(.collapsed) .tbv-cells')].map((c) => [...c.children].map(rect)) };
  });
  const overlaps = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
  expect(g.bar.filter((n) => n.cls.split(' ').includes('tbv-chip')).length, 'every visible project chip is measured').toBe(g.chipCount);
  expect(g.projects.x, 'project strip inside window').toBeGreaterThanOrEqual(g.view.x);
  expect(g.projects.right, 'project strip inside window').toBeLessThanOrEqual(g.view.right);
  for (const name of g.chipNames) expect(name.scrollWidth, name.text + ' shown whole').toBeLessThanOrEqual(name.clientWidth);
  for (const group of g.barGroups) expect(group.right, group.cls + ' inside window').toBeLessThanOrEqual(g.view.right);
  for (let i = 0; i < g.bar.length; i++) {
    expect(g.bar[i].height, g.bar[i].cls + ' single line').toBeLessThanOrEqual(34);
    expect(g.bar[i].right, g.bar[i].cls + ' inside window').toBeLessThanOrEqual(g.view.right);
    for (const b of g.bar.slice(i + 1)) expect(overlaps(g.bar[i], b), `${g.bar[i].cls}/${b.cls} overlap`).toBe(false);
  }
  // every group bar spans the board and is 36–40px tall
  for (const h of g.laneHeads) { expect(h.height).toBeGreaterThanOrEqual(36); expect(h.height).toBeLessThanOrEqual(40); expect(Math.abs(h.width - g.grid.width)).toBeLessThanOrEqual(1); }
  // one set of column widths for every group, under the global heads
  if (stacked) expect(g.heads).toEqual([]);
  else for (const cells of g.lanes) cells.forEach((c, i) => { expect(Math.abs(g.heads[i].x - c.x), 'head over its column').toBeLessThanOrEqual(1); expect(Math.abs(g.heads[i].width - c.width)).toBeLessThanOrEqual(1); });
  for (const { cell, cards } of g.cells) for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    expect(c.title, 'card title matches the group bar name').toBe(c.laneName);
    expect(c.width, c.id + ' readable width').toBeGreaterThanOrEqual(minCard);
    expect(c.height, c.id + ' compact').toBeLessThanOrEqual(c.status === 'needs_user' ? 88 : 76);
    expect(c.x).toBeGreaterThanOrEqual(cell.x - 0.5); expect(c.right).toBeLessThanOrEqual(cell.right + 0.5);
    for (const d of cards.slice(i + 1)) expect(overlaps(c, d), `${c.id}/${d.id} overlap`).toBe(false);
    for (const p of c.parts) { expect(p.right, `${c.id} ${p.cls} fits`).toBeLessThanOrEqual(c.right - 1); expect(p.bottom, `${c.id} ${p.cls} fits`).toBeLessThanOrEqual(c.bottom - 1); }
  }
  expect(g.icons.length).toBeGreaterThanOrEqual(5);
  for (const b of g.icons) { expect(b.label).toBeTruthy(); expect(b.title).toBeTruthy(); expect(b.svg).toBe(true); expect(b.text).toBe(''); expect(b.w).toBeGreaterThanOrEqual(28); expect(b.h).toBeGreaterThanOrEqual(28); }
}

test('grouped board: foldable project groups over shared status columns; counts, filter, folds, 需要你 entries and layout at three sizes', async () => {
  await launch(true);
  const open = seeded.filter((c) => c.status !== 'done');
  expect(open.length).toBe(40);
  const entry = page.locator('#navTop .nav-row[data-nav="tasks"]');
  await resize(1440, 900);
  await expect(entry).toHaveText('任务看板');
  expect((await page.locator('#navTop > *').evaluateAll((n) => n.map((x) => x.dataset.nav || x.id))).slice(0, 6)).toEqual(['new', 'captain', 'attention', 'tasks', 'navSearchSlot', 'todo']);
  await entry.click();
  await expect(page.locator('#taskBoardView')).toBeVisible();
  await expect(page.locator('.tbv-head .tbv-head-label')).toHaveText(['待办', '进行中', '待验收', '需要你', '完成']);
  await expect(page.locator('.tbv-head .tbv-count')).toHaveText(['15', '19', '3', '3', '10']);
  // five groups with work left; the finished project waits in one folded bar under them
  await expect(page.locator('.tbv-lane')).toHaveCount(5);
  const finished = page.locator('.tbv-finished');
  await expect(finished).toHaveAttribute('aria-expanded', 'false');
  await expect(finished).toContainText('已完成的 Agent');
  await expect(finished.locator('.tbv-lane-n')).toHaveText('已完成 2');
  expect(await page.locator('.tbv-lanes > *').evaluateAll((n) => n.map((x) => x.classList.contains('tbv-finished')).indexOf(true))).toBe(5);
  await expect(page.locator('.tbv-summary')).toHaveText('40 件待完成 · 3 件需要你');
  await expect(page.locator('.tbv-card[data-card-id="p-old"]')).toHaveCount(0);

  const deck = page.locator('.tbv-lane[data-project="agentdeck"]');
  await expect(deck.locator('.tbv-lane-open')).toHaveText('17 件待完成');
  await expect(deck.locator('.tbv-lane-n')).toHaveText(['待办 5', '进行中 12', '完成 5']);
  await expect(page.locator('.tbv-lane[data-project="客户门户"] .tbv-lane-n')).toHaveText(['待办 3', '进行中 1', '待验收 1', '需要你 1', '完成 1']);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    expect(await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'); return s.scrollWidth <= s.clientWidth + 1; }), 'no horizontal scroll').toBe(true);
    await assertBoardLayout(150);
    await screenshot(`1-board-1440x900-${theme}`);
  }
  await page.evaluate(() => applyTheme('dark'));
  // the column heads stay put while the groups scroll under them
  const sticky = await page.evaluate(() => {
    const s = document.querySelector('.tbv-scroll'), heads = document.querySelector('.tbv-heads');
    const before = heads.getBoundingClientRect().top;
    s.scrollTop = s.scrollHeight;
    const out = { moved: s.scrollTop, before, after: heads.getBoundingClientRect().top, top: s.getBoundingClientRect().top };
    return out;
  });
  expect(sticky.moved).toBeGreaterThan(40);
  expect(Math.abs(sticky.after - sticky.top)).toBeLessThanOrEqual(1);
  await screenshot('1b-board-scrolled-1440x900-dark');
  await page.evaluate(() => { document.querySelector('.tbv-scroll').scrollTop = 0; });
  // one palette: the group dots, the overview chips and the crew map's hue function agree
  const hues = await page.evaluate(() => [...document.querySelectorAll('.tbv-lane, .tbv-chip[data-project]:not([data-project=""])')].map((l) => [l.style.getPropertyValue('--project-hue'), String(CrewMapCore.projectHue(l.dataset.project))]));
  expect(hues.length).toBe(11);
  for (const [set, expected] of hues) expect(set).toBe(expected);

  // cards: the title leads, the second line is the real news — why it failed, what it waits on, whether anyone is on it
  const card = (id) => page.locator(`.tbv-card[data-card-id="${id}"]`);
  await expect(card('r-migrate').locator('.tbv-tag.failed')).toHaveText('失败');
  await expect(card('r-migrate').locator('.tbv-activity.failed')).toHaveText('测试环境缺少数据访问权限，请队长处理后再继续运行迁移验证。');
  await expect(card('a-doing0').locator('.tbv-tag.failed')).toHaveText('额度');
  await expect(card('r-held').locator('.tbv-activity')).toHaveText('已挂起，等队长放行');
  await expect(card('p-sso').locator('.tbv-activity.wait')).toHaveText('等「实现客户登录和多租户权限验证，包含跨项目访问边界及所有错误处理与重试提示」完成');
  // the run hint is the same fact as the state dot: a live session, or nobody on it
  await expect(card('r-export').locator('.tbv-activity')).toHaveText(/^(队员正在干活|已派给队员)$/);
  expect(await card('r-export').locator('.tbv-activity').textContent()).toBe(await card('r-export').locator('.tbv-state').getAttribute('title'));
  await expect(card('r-export').locator('.tbv-state')).toHaveClass(/working|live/);
  await expect(card('a-doing1').locator('.tbv-activity')).toHaveText('还没有队员在做');
  await expect(card('a-doing1').locator('.tbv-state')).toHaveClass(/open/);
  await expect(card('a-board').locator('.tbv-activity')).toHaveText('侧边栏入口和架构图切换已接好。');
  await expect(card('p-copy').locator('.tbv-time')).toHaveText('1 小时前');
  await expect(page.locator('.tbv-cell:not([data-status="doing"]) .tbv-state')).toHaveCount(0); // the column already names the status

  // a busy cell shows three cards and says exactly how many more; 完成 is only a count
  const busy = deck.locator('.tbv-cell[data-status="doing"]');
  await expect(busy.locator('.tbv-card')).toHaveCount(3);
  await expect(busy.locator('.tbv-more')).toHaveText('展开剩余 9 项');
  await expect(deck.locator('.tbv-cell[data-status="todo"] .tbv-more')).toHaveText('展开剩余 2 项');
  await busy.locator('.tbv-more').click();
  await expect(busy.locator('.tbv-card')).toHaveCount(12);
  await expect(busy.locator('.tbv-more')).toHaveAttribute('aria-label', /收起/);
  await busy.locator('.tbv-more').click();
  await expect(busy.locator('.tbv-card')).toHaveCount(3);
  await expect(page.locator('.tbv-cell[data-status="done"] .tbv-card')).toHaveCount(0);
  await expect(deck.locator('.tbv-done-count')).toHaveText('5');
  await page.locator('.tbv-head[data-status="done"]').click();
  await expect(page.locator('.tbv-cell[data-status="done"] .tbv-card')).toHaveCount(6); // agentdeck 3 (rest behind 展开剩余) + 客户门户 1 + 报表服务 2
  await expect(deck.locator('.tbv-cell[data-status="done"] .tbv-more')).toHaveText('展开剩余 2 项');
  await expect(page.locator('.tbv-head[data-status="done"]')).toBeFocused();
  await assertBoardLayout(140);
  await page.keyboard.press('Enter');
  await expect(page.locator('.tbv-cell[data-status="done"] .tbv-card')).toHaveCount(0);

  // a click anywhere on a group bar folds it to that one bar; it stays folded after the board is reopened
  await deck.locator('.tbv-lane-open').click();
  await expect(deck).toHaveClass(/collapsed/);
  await expect(deck.locator('.tbv-card')).toHaveCount(0);
  await expect(deck.locator('.tbv-lane-n')).toHaveText(['待办 5', '进行中 12', '完成 5']);
  expect((await deck.boundingBox()).height).toBeLessThanOrEqual(40);
  await expect.poll(() => page.evaluate(() => config.taskBoardView)).toEqual({ laneOrder: [], collapsed: { agentdeck: true }, doneOpen: false, completedOpen: false });
  await page.keyboard.press('Escape');
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await entry.click();
  await expect(deck).toHaveClass(/collapsed/);
  await deck.locator('.tbv-lane-toggle').click();
  await expect(deck.locator('.tbv-lane-toggle')).toBeFocused();
  await expect(deck.locator('.tbv-card')).toHaveCount(6);

  // 收起全部 leaves one bar per group; 展开全部 opens every group and the finished area
  await page.locator('.tbv-collapse-all').click();
  await expect(page.locator('.tbv-lane.collapsed')).toHaveCount(5);
  await expect(page.locator('.tbv-card')).toHaveCount(0);
  for (const h of await page.locator('.tbv-lane').evaluateAll((n) => n.map((x) => x.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(40);
  await screenshot('1c-collapsed-1440x900-dark');
  await page.locator('.tbv-expand-all').click();
  await expect(page.locator('.tbv-lane.collapsed')).toHaveCount(0);
  await expect(page.locator('.tbv-lane')).toHaveCount(6);
  await expect(page.locator('.tbv-lane.finished')).toHaveAttribute('data-project', '旧项目');
  await expect(page.locator('.tbv-lane.finished .tbv-lane-open')).toHaveText('都做完了');
  await expect(finished).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => page.evaluate(() => config.taskBoardView)).toEqual({ laneOrder: [], collapsed: {}, doneOpen: false, completedOpen: true });
  await finished.click();
  await expect(page.locator('.tbv-lane')).toHaveCount(5);
  await expect(finished).toBeFocused();

  // 需要你: the bar names every waiting card and each opens its own detail; so does the red count in a group bar
  const alert = page.locator('.tbv-alert');
  const detail = page.locator('.tbv-detail');
  await expect(alert.locator('.tbv-alert-n')).toHaveText('3 件需要你');
  await expect(alert.locator('.tbv-alert-item')).toHaveCount(3);
  const asked = await alert.locator('.tbv-alert-item').evaluateAll((n) => n.map((x) => x.dataset.cardId));
  expect(asked.slice().sort()).toEqual(['p-ask', 'r-lost', 't-5']);
  await alert.locator('.tbv-alert-item[data-card-id="p-ask"]').click();
  await expect(detail).toHaveAttribute('data-card-id', 'p-ask');
  await expect(detail.locator('.tbv-ask-question')).toHaveText('密码最短 8 位还是 12 位？');
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await alert.locator('.tbv-alert-go').click();
  await expect(detail).toHaveAttribute('data-card-id', asked[0]);
  await page.keyboard.press('Escape');
  const windows = page.locator('.tbv-lane[data-project="type4me-windows"]');
  await expect(windows.locator('button.tbv-lane-n')).toHaveText('需要你 1');
  await windows.locator('button.tbv-lane-n').click();
  await expect(detail).toHaveAttribute('data-card-id', 't-5');
  await expect(windows).not.toHaveClass(/collapsed/); // the count is its own button, not a fold
  await page.keyboard.press('Escape');

  // overview strip: counts per project, a click shows only that project (everything, unfolded) and every number follows
  const chip = page.locator('.tbv-chip[data-project="agentdeck"]');
  await expect(chip.locator('.tbv-chip-n.doing')).toHaveText('12');
  await expect(page.locator('.tbv-chip[data-project="客户门户"] .tbv-chip-n.needs')).toHaveText('1');
  await chip.click();
  await expect(page.locator('.tbv-lane')).toHaveCount(1);
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(busy.locator('.tbv-card')).toHaveCount(12);
  await expect(page.locator('.tbv-head .tbv-count')).toHaveText(['5', '12', '0', '0', '5']);
  await expect(page.locator('.tbv-summary')).toHaveText('17 件待完成');
  await expect(alert).toBeHidden();
  await expect(finished).toHaveCount(0);
  await chip.click();
  await page.locator('.tbv-chip[data-project="旧项目"]').click(); // picked by name, a finished project is an ordinary group
  await expect(page.locator('.tbv-lane')).toHaveAttribute('data-project', '旧项目');
  await expect(page.locator('.tbv-summary')).toHaveText('0 件待完成');
  await page.locator('.tbv-chip[data-project=""]').click();
  await expect(page.locator('.tbv-lane')).toHaveCount(5);
  await expect(alert.locator('.tbv-alert-item')).toHaveCount(3);

  // 架构图 tab inside the board goes to the crew map; its 任务看板 tab comes back
  await page.locator('#taskBoardView .board-mode button[data-view="crew"]').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#crewMap')).toBeVisible();
  await page.locator('#boardTasksTab').click();
  await expect(page.locator('#taskBoardView')).toBeVisible();

  // narrow panel: each group's columns stack under its bar with their own label; titles stay readable
  for (const [w, h, theme] of [[980, 700, 'dark'], [980, 700, 'light'], [700, 800, 'dark'], [700, 800, 'light']]) {
    await resize(w, h);
    await page.evaluate((t) => applyTheme(t), theme);
    await assertBoardLayout(300, true);
    const narrow = await page.evaluate(() => { const l = document.querySelector('.tbv-lane'), s = document.querySelector('.tbv-scroll');
      return { head: l.querySelector('.tbv-lane-head').getBoundingClientRect().bottom, cells: l.querySelector('.tbv-cells').getBoundingClientRect().top, view: document.getElementById('taskBoardView').getBoundingClientRect().right, win: innerWidth,
        fits: s.scrollWidth <= s.clientWidth + 1, labels: [...l.querySelectorAll('.tbv-cell:not(.folded)')].filter((c) => c.getBoundingClientRect().height > 0).map((c) => getComputedStyle(c, '::before').content.replace(/"/g, '')) }; });
    expect(narrow.head).toBeLessThanOrEqual(narrow.cells + 1);
    expect(narrow.view).toBeLessThanOrEqual(narrow.win);
    expect(narrow.fits, 'no horizontal scroll').toBe(true);
    expect(narrow.labels.length).toBeGreaterThan(0);
    for (const label of narrow.labels) expect(['待办', '进行中', '待验收', '需要你']).toContain(label);
    await expect(alert.locator('.tbv-alert-go')).toBeVisible();
    await screenshot(`2-board-${w}x${h}-${theme}`);
  }
  await resize(980, 700);
  for (const h of await page.locator('#tbSplit .split-btn').evaluateAll((n) => n.map((b) => b.getBoundingClientRect().height))) expect(h).toBeLessThanOrEqual(26);
  expect(errors).toEqual([]);
});

test('drag and keyboard: reorder is saved, Captain dispatch sends a notice, and lanes reorder', async () => {
  await launch();
  await page.evaluate(() => TaskBoard.settings('captain'));
  await resize(1440, 900);
  const columnIds = await page.evaluate(() => columns.map((c) => c.id));
  await page.locator('#taskBoardBtn').click();
  const card = (id) => page.locator(`.tbv-card[data-card-id="${id}"]`);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-sso', 'p-copy', 'p-faq']);

  // while dragging: a ghost follows the pointer and a line shows where the card lands
  await dragAim(card('p-faq'), card('p-sso'), -6, { release: false });
  await expect(page.locator('.tbv-ghost')).toHaveCount(1);
  await expect(page.locator('.tbv-lane[data-project="客户门户"] .tbv-cell[data-status="todo"]')).toHaveClass(/drop-target/);
  expect(await page.locator('.tbv-drop').evaluate((n) => n.nextElementSibling.dataset.cardId)).toBe('p-sso');
  await screenshot('3-dragging-1440x900-dark');
  // Escape drops the drag without changing anything
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.tbv-ghost, .tbv-drop')).toHaveCount(0);
  await expect(page.locator('#taskBoardView')).toBeVisible();
  expect(await cellIds('客户门户', 'todo')).toEqual(['p-sso', 'p-copy', 'p-faq']);

  // reorder inside the column: saved in the shared file, still there after reopening
  await dragAim(card('p-faq'), card('p-sso'), -6);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-faq', 'p-sso', 'p-copy']);
  expect(readCard('p-faq').order).toBeLessThan(readCard('p-sso').order);
  expect(readCard('p-faq').status).toBe('todo');
  await expect(page.locator('.tbv-detail')).toBeHidden(); // a drag is not a click
  await dragAim(card('p-faq'), card('p-copy'), 9);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-sso', 'p-copy', 'p-faq']);
  await dragAim(card('p-copy'), card('p-sso'), -6);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-copy', 'p-sso', 'p-faq']);
  await page.keyboard.press('Escape');
  await page.locator('#taskBoardBtn').click();
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-copy', 'p-sso', 'p-faq']);

  // dispatcher=captain: 待办 → 进行中 moves the card and notifies 队长.
  const doing = page.locator('.tbv-lane[data-project="客户门户"] .tbv-cell[data-status="doing"]');
  await dragAim(card('p-copy'), doing, 30);
  await expect.poll(() => cellIds('客户门户', 'doing')).toContain('p-copy');
  await expect.poll(captainNotices).toEqual(['用户要开始卡片 p-copy「整理登录页文案」。项目：客户门户。']);
  await expect.poll(() => readCard('p-copy').dispatch_claim?.delivered).toBe(true);
  expect(readCard('p-copy').status).toBe('doing');
  // a card whose prerequisite is unfinished stays put and says why
  await dragAim(card('p-sso'), doing, 30);
  await expect(page.locator('#toast')).toContainText('它前面的任务还没做完');
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['p-sso', 'p-faq']);
  // a card cannot leave its project: a drop on another lane does nothing
  await dragAim(card('p-faq'), page.locator('.tbv-lane[data-project="报表服务"] .tbv-cell[data-status="doing"]'), 0);
  expect(readCard('p-faq').status).toBe('todo');
  expect(readCard('p-faq').project).toBe('客户门户');

  // keyboard: Alt+↓ reorders, Alt+→ changes status (and tells 队长), focus stays on the card
  await card('r-filter').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => cellIds('报表服务', 'todo')).toEqual(['r-held', 'r-filter']);
  await expect(card('r-filter')).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => cellIds('报表服务', 'todo')).toEqual(['r-filter', 'r-held']);
  await expect(card('r-filter')).toBeFocused();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => cellIds('报表服务', 'doing')).toContain('r-filter');
  await expect(card('r-filter')).toBeFocused();
  await expect.poll(async () => (await captainNotices()).some((n) => n.includes('用户要开始卡片 r-filter「实现报告筛选和查询接口」'))).toBe(true);
  await expect(page.locator('.tbv-live')).toHaveText('「实现报告筛选和查询接口」已移到进行中');
  // 待验收 → 完成 goes through the normal move
  await card('p-ui').focus();
  await page.keyboard.press('Alt+ArrowRight'); // 需要你
  await expect.poll(() => readCard('p-ui').status).toBe('needs_user');
  await page.keyboard.press('Alt+ArrowRight'); // 完成 (the folded column opens to show it)
  await expect.poll(() => readCard('p-ui').status).toBe('done');
  await expect(card('p-ui')).toBeVisible();
  // nothing above opened a session behind 队长's back
  expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(columnIds);
  expect((await captainNotices()).length).toBe(2);

  // lanes: drag a project above another, or Alt+↑/↓ on its fold button; the order is remembered
  const lanes = () => page.locator('.tbv-lane').evaluateAll((n) => n.map((x) => x.dataset.project));
  expect(await lanes()).toEqual(['agentdeck', '报表服务', '客户门户'].sort((a, b) => a.localeCompare(b)));
  const first = (await lanes())[0], last = (await lanes())[2];
  await dragAim(page.locator(`.tbv-lane[data-project="${last}"] .tbv-lane-name`), page.locator(`.tbv-lane[data-project="${first}"]`), 2, { edge: true });
  await expect.poll(lanes).toEqual([last, first, (await lanes()).find((k) => k !== first && k !== last)]);
  const order = await lanes();
  await expect.poll(() => page.evaluate(() => config.taskBoardView.laneOrder)).toEqual(order);
  await page.locator(`.tbv-lane[data-project="${last}"] .tbv-lane-toggle`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(lanes).toEqual([order[1], order[0], order[2]]);
  await expect(page.locator(`.tbv-lane[data-project="${last}"] .tbv-lane-toggle`)).toBeFocused();
  await expect(page.locator(`.tbv-lane[data-project="${last}"]`)).not.toHaveClass(/collapsed/);
  await page.keyboard.press('Escape');
  await page.locator('#taskBoardBtn').click();
  await expect.poll(lanes).toEqual([order[1], order[0], order[2]]);
  expect(errors).toEqual([]);
});

test('Gemini drag dispatches once, dragging back keeps the session fence, and blocked starts explain why', async () => {
  await launch();
  await resize(1440, 900);
  await page.evaluate((fake) => {
    const original = BoardCore.commandForAgent;
    BoardCore.commandForAgent = (agent, ...args) => agent === 'agy' ? fake : original(agent, ...args);
    TaskBoard.settings('gemini');
  }, FAKE);
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  const card = (id) => page.locator(`.tbv-card[data-card-id="${id}"]`);
  const cell = (status) => page.locator(`.tbv-lane[data-project="客户门户"] .tbv-cell[data-status="${status}"]`);
  const dispatchers = () => page.evaluate(() => columns.filter((c) => c.dispatcherCardId).map((c) => c.id));
  const count = (await dispatchers()).length;
  let doing = await center(cell('doing'));
  await drag(card('p-copy'), doing.x, doing.y + 30);
  await expect(page.locator('#toast')).toContainText('已开始调度「整理登录页文案」');
  await expect.poll(() => readCard('p-copy').dispatch_session_id).toBeTruthy();
  await expect.poll(() => readCard('p-copy').dispatch_claim?.delivered).toBe(true);
  await expect.poll(dispatchers).toHaveLength(count + 1);
  const session = readCard('p-copy').dispatch_session_id;
  expect(await captainNotices()).toEqual([]);
  expect(await page.evaluate((id) => TaskBoard.startCard(id), 'p-copy')).toMatchObject({ ignored: true, occupied: true });

  const todo = await center(cell('todo'));
  await drag(card('p-copy'), todo.x, todo.y + 30);
  await expect.poll(() => readCard('p-copy').status).toBe('todo');
  doing = await center(cell('doing'));
  await drag(card('p-copy'), doing.x, doing.y + 30);
  await expect(page.locator('#toast')).toContainText('仍有关联的未归档会话');
  expect(readCard('p-copy').status).toBe('todo');
  expect(await dispatchers()).toContain(session);
  expect((await dispatchers()).length).toBe(count + 1);

  await drag(card('p-sso'), doing.x, doing.y + 30);
  await expect(page.locator('#toast')).toContainText('它前面的任务还没做完');
  expect(readCard('p-sso').status).toBe('todo');
  expect(readCard('p-sso').dispatch_claim).toBeFalsy();
  expect((await dispatchers()).length).toBe(count + 1);
  expect(await captainNotices()).toEqual([]);

  // Keyboard starts use the same dispatcher setting as pointer dragging.
  await card('p-faq').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => readCard('p-faq').dispatch_session_id).toBeTruthy();
  await expect.poll(dispatchers).toHaveLength(count + 2);
  await page.evaluate(async () => {
    const card = (await TaskBoard.list()).find((c) => c.id === 'r-filter');
    await TaskBoard.update(card.id, { important: true }, card.updated);
  });
  await card('r-filter').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('#toast')).toContainText('已通知队长安排');
  await expect.poll(captainNotices).toEqual(['用户要开始卡片 r-filter「实现报告筛选和查询接口」（需要队长判断）。项目：报表服务。']);
  expect((await dispatchers()).length).toBe(count + 2);
  expect(errors).toEqual([]);
});

test('需要你: the card shows the question, the drawer takes an answer and sends it to 队长', async () => {
  await launch();
  await resize(1440, 900);
  const columnIds = await page.evaluate(() => columns.map((c) => c.id));
  await page.locator('#taskBoardBtn').click();
  const card = (id) => page.locator(`.tbv-card[data-card-id="${id}"]`);
  const detail = page.locator('.tbv-detail');
  await expect(card('p-ask').locator('.tbv-question')).toHaveText('密码最短 8 位还是 12 位？');
  // a card that landed in 需要你 without a question says so, never the internal wording
  await expect(card('r-lost').locator('.tbv-question')).toHaveText('队长还没把问题整理出来');
  await expect(page.locator('#taskBoardView')).not.toContainText('未提交回执');

  // any card opens the drawer: title, who has it, latest receipt, description
  await card('p-login').click();
  await expect(detail).toBeVisible();
  await expect(detail.locator('.tbv-d-title')).toHaveText(/实现客户登录和多租户权限验证/);
  await expect(detail.locator('.tbv-d-who-name')).toHaveText('登录权限');
  await expect(detail.locator('.tbv-d-label')).toHaveText(['谁在做', '最近回执', '说明', '移到']);
  await expect(detail.locator('.tbv-ask, textarea')).toHaveCount(0);
  await expect(card('p-login')).toHaveClass(/selected/);
  await assertBoardLayout(120);
  // Escape closes the drawer first and hands focus back to the card
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(page.locator('#taskBoardView')).toBeVisible();
  await expect(card('p-login')).toBeFocused();

  // no question yet: the drawer says so and still lets the user tell 队长 what to do
  await page.keyboard.press('Tab');
  await card('r-lost').focus();
  await page.keyboard.press('Enter');
  await expect(detail.locator('.tbv-ask-label')).toHaveText('需要你决定');
  await expect(detail.locator('.tbv-ask-question')).toHaveText('队长还没把问题整理出来');
  await expect(detail).not.toContainText('未提交回执');
  await expect(detail.locator('.tbv-d-text').first()).toHaveText('队员停下了，但没有交结果。');
  await expect(detail.locator('textarea')).toBeFocused();
  await page.keyboard.type('先不对了，下个月一起核。');
  await page.keyboard.press('Meta+Enter');
  await expect(page.locator('#toast')).toContainText('答案已发给队长');
  await expect.poll(() => readCard('r-lost').status).toBe('doing');
  await expect.poll(() => readCard('r-lost').dispatch_claim?.delivered).toBe(true);
  expect(await captainNotices()).toEqual(['用户在任务看板回答了卡片 r-lost「核对上月对账单」（项目：报表服务）。用户的答案：先不对了，下个月一起核。\n请按这个答案继续推进这张卡片。']);

  // a real question: on top of the drawer, with the answer box under it
  await card('p-ask').click();
  await expect(detail).toHaveAttribute('data-card-id', 'p-ask');
  await expect(detail.locator('.tbv-ask-question')).toHaveText('密码最短 8 位还是 12 位？');
  const order = await detail.locator('.tbv-d-body > *').evaluateAll((n) => n.map((x) => x.className.split(' ')[0]));
  expect(order.slice(0, 2)).toEqual(['tbv-d-title', 'tbv-ask']);
  await expect(detail.locator('.tbv-send')).toHaveText('发送答案');
  await expect(detail.locator('.tbv-d-label')).toHaveText(['谁在做', '说明', '相关文件', '移到']);
  // related file: shown with a copy icon that turns into a tick
  await expect(detail.locator('.tbv-d-file')).toHaveText('/Users/demo/docs/security/password-policy.md');
  const copy = detail.locator('.tbv-d-files .tbv-copy');
  await expect(copy).toHaveAttribute('aria-label', '复制路径');
  const saved = await page.evaluate(() => window.deck.clipboardRead()); // isolated profile clipboard
  await copy.click();
  await expect(copy).toHaveClass(/ok/);
  expect(await page.evaluate(() => window.deck.clipboardRead())).toBe('/Users/demo/docs/security/password-policy.md');
  await page.evaluate((text) => window.deck.clipboardWrite(text), saved);
  // an empty answer is not sent; a refresh in between keeps what was typed
  await detail.locator('.tbv-send').click();
  expect((await captainNotices()).length).toBe(1);
  await detail.locator('textarea').fill('12 位，并且要有数字。');
  await page.locator('.tbv-refresh').click();
  await expect(detail.locator('textarea')).toHaveValue('12 位，并且要有数字。');
  await screenshot('4-needs-you-1440x900-dark');
  await page.evaluate(() => applyTheme('light'));
  await screenshot('4-needs-you-1440x900-light');
  // the drawer open at the narrower panels, both themes
  for (const [w, h] of [[980, 700], [700, 800]]) {
    await resize(w, h);
    await screenshot(`4-needs-you-${w}x${h}-light`);
    await page.evaluate(() => applyTheme('dark'));
    await screenshot(`4-needs-you-${w}x${h}-dark`);
    await page.evaluate(() => applyTheme('light'));
  }
  await resize(1440, 900);
  await page.evaluate(() => applyTheme('dark'));
  await detail.locator('.tbv-send').click();
  await expect.poll(captainNotices).toHaveLength(2);
  expect((await captainNotices())[1]).toBe('用户在任务看板回答了卡片 p-ask「确认密码策略」（项目：客户门户）。问题：密码最短 8 位还是 12 位？\n用户的答案：12 位，并且要有数字。\n请按这个答案继续推进这张卡片。');
  // the card is back in 进行中 and still belongs to the session that asked
  await expect.poll(() => readCard('p-ask').status).toBe('doing');
  expect(readCard('p-ask').session_id).toBe('w-ask');
  await expect(detail.locator('.tbv-d-status')).toHaveText('进行中');
  await expect(detail.locator('.tbv-ask, textarea')).toHaveCount(0);
  await expect(page.locator('.tbv-head[data-status="needs_user"] .tbv-count')).toHaveText('0');
  expect(await page.evaluate(() => columns.map((c) => c.id))).toEqual(columnIds);

  // 移到 in the drawer is the same move as a drag; the terminal icon opens the session
  await detail.locator('.tbv-d-moves button[data-status="needs_user"]').click();
  await expect.poll(() => readCard('p-ask').status).toBe('needs_user');
  expect(readCard('p-ask').session_id).toBeNull(); // a move lets go of the session, so no terminal icon is left
  await expect(detail.locator('.tbv-d-open')).toHaveCount(0);
  await card('r-export').click();
  await expect(detail.locator('.tbv-d-open')).toHaveAttribute('aria-label', '打开「导出报表」的终端');
  await detail.locator('.tbv-d-open').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'w-report']);
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
  await page.locator('.tbv-chip[data-project="报表服务"]').click();
  await expect(page.locator('.tbv-lane')).toHaveCount(1);
  await page.locator('.tbv-card[data-card-id="r-export"]').click();
  await expect(page.locator('.tbv-detail')).toBeVisible();
  const file = path.join(profile, 'tasks', '报表服务.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.cards.forEach((c) => { c.archived = true; });
  fs.writeFileSync(file + '.remote.tmp', JSON.stringify(doc));
  fs.renameSync(file + '.remote.tmp', file);
  await expect(page.locator('.tbv-chip[data-project=""]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tbv-lane')).toHaveCount(2);
  await expect(page.locator('.tbv-chip')).toHaveCount(3);
  await expect(page.locator('.tbv-detail')).toBeHidden(); // its card is gone
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#crewMap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Escape restores sidebar focus and keyboard column navigation closes the overlay without replacing terminals', async () => {
  await launch();
  const originalIds = await page.evaluate(() => columns.map((c) => c.id));
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('#taskBoardView')).toBeFocused();
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

test('dragging a card with only a finished old worker gives an accurate occupancy notice', async () => {
  await launch();
  await page.evaluate(async () => {
    columns.find((c) => c.id === 'w-ui').boardId = 'p-ui';
    await window.deck.saveConfig({ ...config, columns });
    await TaskBoard.move('p-ui', 'todo');
  });
  await page.locator('#taskBoardBtn').click();
  const card = page.locator('.tbv-card[data-card-id="p-ui"]');
  await expect(card).toBeVisible();
  const doing = await center(page.locator('.tbv-lane[data-project="客户门户"] .tbv-cell[data-status="doing"]'));
  await drag(card, doing.x, doing.y + 30);
  await expect(page.locator('#toast')).toContainText('仍有关联的未归档会话，请队长检查并安排');
  expect(readCard('p-ui').status).toBe('todo');
  expect(await captainNotices()).toEqual([]);
});
