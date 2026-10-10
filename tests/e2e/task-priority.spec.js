const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHub } = require('../fixtures/hub-proxy');
const { MobileWebServer } = require('../../mobile-web');

// 高优先级: the mark on the task board, in the sidebar, on the architecture
// map and in the two phone task lists, the order it gives, the user's own
// toggle, and the Captain's commands through the real CLI. Real renderer,
// isolated userData (cards in <profile>/tasks), PTYs running only the stand-in
// TUI; the phone pages run against test fixtures. Set AGENTDECK_PRIORITY_SHOTS
// to keep PNGs of both themes.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_PRIORITY_SHOTS;
let application, page, profile, control;
const errors = [];

async function keep(target, name, options = {}) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await target.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css', ...options });
}
const readCard = (id) => fs.readdirSync(path.join(profile, 'tasks')).filter((n) => n.endsWith('.json'))
  .flatMap((n) => JSON.parse(fs.readFileSync(path.join(profile, 'tasks', n), 'utf8')).cards).find((c) => c.id === id);
const captainNotices = () => page.evaluate(() => [...config.mainSession.pending, ...config.mainSession.inflight].filter((p) => p.title === '任务看板').map((p) => p.summary));
const cellIds = (project, status) => page.locator(`.tbv-lane[data-project="${project}"] .tbv-cell[data-status="${status}"] .tbv-card`).evaluateAll((n) => n.map((x) => x.dataset.cardId));
function cli(args) {
  const env = { ...process.env, ...JSON.parse(fs.readFileSync(control, 'utf8')) };
  const file = path.join(profile, 'board-control/tools/agentdeck-board.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Ordinary cards are written first (lower `order`), so only the mark can put a 高优先级 card ahead of them.
function seed(dir) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  let order = 0;
  const card = (project, id, title, status, extra = {}) => ({ id, project, title, detail: '测试卡片', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(600), updated: at(30), archived: false, important: false, ...extra });
  const claude = { agent: 'claude', model: 'Opus 5.5' };
  const boards = {
    '客户门户': [
      card('客户门户', 'n-todo1', '整理登录页文案', 'todo', { updated: at(80) }),
      card('客户门户', 'n-todo2', '补充常见问题', 'todo', { updated: at(85) }),
      card('客户门户', 'h-todo', '修复支付回调丢单', 'todo', { important: true, updated: at(2) }),
      card('客户门户', 'n-doing', '构建数据工作台界面', 'doing', { session_id: 'w-norm', assignee: claude, updated: at(12) }),
      card('客户门户', 'h-doing', '线上登录失败紧急排查', 'doing', { important: true, session_id: 'w-hi', assignee: claude, updated: at(3) }),
      card('客户门户', 'n-review', '接入企业 SSO', 'review', { latest_receipt: '已完成实现和单元测试。', updated: at(40) }),
      card('客户门户', 'h-review', '补上权限越界的修复', 'review', { important: true, session_id: 'w-review', assignee: claude, latest_receipt: '已修复，等验收。', updated: at(6) }),
      card('客户门户', 'n-ask', '确认密码策略', 'needs_user', { latest_receipt: '密码最短 8 位还是 12 位？', last_event: 'a:ask:command:x', updated: at(5) }),
      card('客户门户', 'n-done', '登录接口限流', 'done', { latest_receipt: '完成。', updated: at(240) }),
      card('客户门户', 'h-done', '回滚出错的发布', 'done', { important: true, latest_receipt: '已回滚。', updated: at(200) }),
      card('客户门户', 'legacy', '很早以前建的卡片', 'todo', { updated: at(900) }),
    ],
    '报表服务': [
      card('报表服务', 'r-fail', '同步迁移数据和历史记录', 'doing', { flag: 'failed', latest_receipt: '测试环境缺少数据访问权限。', updated: at(20) }),
      card('报表服务', 'r-quota', '新增汇总与导出报表', 'doing', { flag: 'quota', resource_failure: 'quota', latest_receipt: '额度用尽，稍后自动继续。', updated: at(9) }),
      card('报表服务', 'r-held', '报表权限复核', 'todo', { flag: 'held', updated: at(400) }),
      card('报表服务', 'r-todo', '实现报告筛选和查询接口', 'todo', { updated: at(90) }),
    ],
  };
  // a card from before the field existed has no `important` key at all
  delete boards['客户门户'].find((c) => c.id === 'legacy').important;
  fs.mkdirSync(dir, { recursive: true });
  for (const [project, cards] of Object.entries(boards)) fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
}

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-priority-'));
  control = path.join(profile, 'control.json');
  seed(path.join(profile, 'tasks'));
  const column = (id, title, project, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, project, ...extra });
  // w-plain and w-norm are the most recently used: without the mark they would lead the sidebar group.
  const workers = [
    column('w-plain', '整理文档', '客户门户'), column('w-norm', '工作台界面', '客户门户', { boardId: 'n-doing' }),
    column('w-hi', '登录紧急排查', '客户门户', { boardId: 'h-doing' }), column('w-review', '审查：权限越界', '客户门户', { boardId: 'h-review' }),
    column('w-loose', '客户电话里说的急事', '客户门户'), column('w-fail', '迁移数据', '报表服务'),
  ];
  const states = ['working', 'working', 'working', 'working', 'working', 'failed'];
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, crewOpen: true,
    taskBoard: { dispatcher: 'captain', autoVerify: false }, concurrencyCap: 5,
    columns: [{ ...column('cap', '队长', ''), isMain: true, captainCrew: false }, ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true,
      waitlist: [
        { taskId: 'k-wait-n', title: '排队的普通活', cmd: FAKE, cwd: profile, requestId: 'rq-n', task: '普通活', project: '客户门户', reviews: [], metadata: { project: '客户门户', reviews: [], boardId: '' }, order: 1 },
        { taskId: 'k-wait-h', title: '排队的急事', cmd: FAKE, cwd: profile, requestId: 'rq-h', task: '急事', project: '客户门户', reviews: [], metadata: { project: '客户门户', reviews: [], boardId: '', important: true }, order: 2 },
      ],
      tasks: [
        ...workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: states[i], sentAt: now - 60_000 + i, startedAt: now - 50_000, turnId: '', project: c.project, boardId: c.boardId || '',
          ...(c.id === 'w-loose' ? { important: true } : {}),   // work without a card: the mark is on its dispatch record
          receipt: states[i] === 'failed' ? { summary: '', files: [], failed: '测试环境缺少数据访问权限' } : null })),
        { id: 'k-wait-n', colId: '', title: '排队的普通活', gen: 1, status: 'waiting', sentAt: now - 30_000, turnId: '', receipt: null, project: '客户门户', reviews: [] },
        { id: 'k-wait-h', colId: '', title: '排队的急事', gen: 1, status: 'waiting', sentAt: now - 20_000, turnId: '', receipt: null, project: '客户门户', reviews: [], important: true },
      ] },
  }));
  // lastTurn times: the ordinary sessions are the most recent
  fs.mkdirSync(path.join(profile, 'chats'), { recursive: true });
  workers.forEach((c, i) => fs.writeFileSync(path.join(profile, 'chats', c.id + '.json'), JSON.stringify({ v: 1, id: c.id, turns: [{ id: 't-' + c.id, ts: now - (i + 1) * 60_000, user: '开始', reply: '', done: false, atts: [] }] })));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_CONTROL_ENV_FILE: control }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(7);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 30000 }).toBe(7);
  await expect.poll(() => fs.existsSync(control)).toBe(true);
  // The Captain's start-up output ends with working -> done. Any state change rebuilds the architecture map's cards
  // (a new element for each), so a card read while that happens is a detached one with no size and no style.
  await expect.poll(() => page.evaluate(() => terms.get('cap').state), { timeout: 30000 }).toBe('done');
  await page.setViewportSize({ width: 1440, height: 900 });
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null; profile = null;
});

// The mark: an image with a name and a tooltip, drawn in the one colour kept for it.
async function markOf(locator) {
  return locator.evaluate((n) => {
    const style = getComputedStyle(n), root = getComputedStyle(document.documentElement);
    const probe = document.createElement('i'); probe.style.color = root.getPropertyValue('--prio'); document.body.append(probe);
    const prio = getComputedStyle(probe).color; probe.remove();
    return { role: n.getAttribute('role'), label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), background: style.backgroundColor, color: style.color, prio };
  });
}
const statusColours = () => page.evaluate(() => {
  const probe = document.createElement('i'); document.body.append(probe);
  const out = ['--st-working', '--st-input', '--st-done', '--st-plain'].map((name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; });
  probe.remove(); return out;
});

test('task board: the mark, the order, the group count, the drawer toggle and the keyboard rule, in both themes', async () => {
  await launch();
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('#taskBoardView')).toBeVisible();
  await expect(page.locator('.tbv-card')).not.toHaveCount(0);
  await page.locator('.tbv-head[data-status="done"]').click();   // open the 完成 column
  await keep(page, 'board-dark');
  await page.locator('.tbv-more[data-cell="客户门户/todo"]').click();   // a cell shows three cards until it is opened

  // 高优先级 leads each column; everything else keeps the user's order. Done cards are not reshuffled.
  expect(await cellIds('客户门户', 'todo')).toEqual(['h-todo', 'n-todo1', 'n-todo2', 'legacy']);
  expect(await cellIds('客户门户', 'doing')).toEqual(['h-doing', 'n-doing']);
  expect(await cellIds('客户门户', 'review')).toEqual(['h-review', 'n-review']);
  expect(await cellIds('客户门户', 'done')).toEqual(['n-done', 'h-done']);

  const marked = await page.locator('.tbv-card[data-priority="high"]').evaluateAll((n) => n.map((x) => x.dataset.cardId).sort());
  expect(marked).toEqual(['h-doing', 'h-review', 'h-todo']);
  const mark = await markOf(page.locator('.tbv-card[data-card-id="h-todo"] .tbv-prio'));
  expect(mark).toMatchObject({ role: 'img', label: '高优先级', svg: true });
  expect(mark.title).toContain('高优先级');
  expect(mark.background, 'solid chip in the priority colour').toBe(mark.prio);
  expect(await statusColours(), 'never a status colour').not.toContain(mark.prio);
  await expect(page.locator('.tbv-card[data-card-id="h-todo"] .tbv-prio')).toContainText('高优');
  await expect(page.locator('.tbv-card[data-card-id="h-todo"]')).toHaveAttribute('aria-label', /高优先级/);
  await expect(page.locator('.tbv-card[data-card-id="h-todo"]')).toHaveAttribute('title', /高优先级/);
  // a finished one keeps a quiet outline, an ordinary or pre-field card has nothing
  const quiet = page.locator('.tbv-card[data-card-id="h-done"] .tbv-prio');
  await expect(quiet).toHaveClass(/quiet/);
  await expect(quiet).toHaveAttribute('aria-label', '高优先级，已完成');
  expect((await markOf(quiet)).background).not.toBe(mark.prio);
  for (const id of ['n-todo1', 'legacy', 'n-doing', 'r-fail', 'r-quota']) await expect(page.locator(`.tbv-card[data-card-id="${id}"] .tbv-prio`)).toHaveCount(0);
  // the mark stays inside its card and does not push the card past the board's size limit
  const fit = await page.locator('.tbv-card[data-priority="high"]').evaluateAll((cards) => cards.map((card) => {
    const c = card.getBoundingClientRect(), m = card.querySelector('.tbv-prio').getBoundingClientRect(), t = card.querySelector('.tbv-title').getBoundingClientRect();
    return { height: c.height, inside: m.left >= c.left && m.right <= c.right && m.top >= c.top && m.bottom <= c.bottom, beforeTitle: m.right <= t.left + 1, titleWidth: t.width };
  }));
  for (const f of fit) { expect(f.inside).toBe(true); expect(f.beforeTitle).toBe(true); expect(f.height).toBeLessThanOrEqual(76); expect(f.titleWidth).toBeGreaterThan(60); }

  // the group bar counts what is still open, and still says so when the group is folded
  const count = page.locator('.tbv-lane[data-project="客户门户"] .tbv-lane-prio');
  await expect(count).toHaveText('3');
  await expect(count).toHaveAttribute('aria-label', '客户门户 有 3 件高优先级还没做完');
  await expect(page.locator('.tbv-lane[data-project="报表服务"] .tbv-lane-prio')).toHaveCount(0);
  await page.evaluate(() => applyTheme('light'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await markOf(page.locator('.tbv-card[data-card-id="h-todo"] .tbv-prio'));
  expect(light.background).toBe(light.prio);
  expect(light.prio).not.toBe(mark.prio);
  expect(await statusColours()).not.toContain(light.prio);
  await keep(page, 'board-light');
  await page.locator('.tbv-lane[data-project="客户门户"] .tbv-lane-toggle').click();
  await expect(count).toHaveText('3');
  await keep(page, 'board-folded-light');
  await page.locator('.tbv-lane[data-project="客户门户"] .tbv-lane-toggle').click();
  await page.evaluate(() => applyTheme('dark'));

  // keyboard: a card cannot be moved across the line between the two kinds
  await page.locator('.tbv-card[data-card-id="h-todo"]').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.tbv-live')).toHaveText('高优先级的卡片固定排在这一栏最前面');
  expect(await cellIds('客户门户', 'todo')).toEqual(['h-todo', 'n-todo1', 'n-todo2', 'legacy']);
  expect(readCard('h-todo').order).toBe(2);

  // dragging: an ordinary card dropped above the 高优先级 one stays where it was, and the page says why
  await expect.poll(() => page.evaluate(() => { const view = document.getElementById('taskBoardView');
    return document.getAnimations().filter((x) => x.effect && x.effect.target && view.contains(x.effect.target) && x.effect.getComputedTiming().iterations !== Infinity && x.playState === 'running').length; })).toBe(0);
  const from = await page.locator('.tbv-card[data-card-id="n-todo2"]').boundingBox(), to = await page.locator('.tbv-card[data-card-id="h-todo"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 - 8, { steps: 2 });
  await page.mouse.move(to.x + 60, to.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toContainText('高优先级的卡片固定排在这一栏最前面');
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['h-todo', 'n-todo1', 'n-todo2', 'legacy']);
  expect([readCard('n-todo1').order, readCard('n-todo2').order, readCard('h-todo').order]).toEqual([0, 1, 2]);
  // inside its own kind a card still reorders by drag
  const a = await page.locator('.tbv-card[data-card-id="n-todo2"]').boundingBox(), b = await page.locator('.tbv-card[data-card-id="n-todo1"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 - 8, { steps: 2 });
  await page.mouse.move(b.x + 60, b.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['h-todo', 'n-todo2', 'n-todo1', 'legacy']);

  // the drawer's flag button: an icon button with a name, a tooltip and a state
  await page.locator('.tbv-card[data-card-id="legacy"]').click();
  const toggle = page.locator('.tbv-d-prio');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-label', '标为高优先级（排到最前，队长优先安排）');
  const button = await toggle.evaluate((n) => ({ title: n.title, text: n.textContent.trim(), svg: !!n.querySelector('svg'), w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height }));
  expect(button.title).toBe('标为高优先级（排到最前，队长优先安排）'); expect(button.text).toBe(''); expect(button.svg).toBe(true);
  expect(button.w).toBeGreaterThanOrEqual(28); expect(button.h).toBeGreaterThanOrEqual(28);
  await toggle.click();
  await expect.poll(() => readCard('legacy').important).toBe(true);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['h-todo', 'legacy', 'n-todo2', 'n-todo1']);
  await expect(page.locator('.tbv-d-prio')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tbv-d-prio')).toHaveAttribute('aria-label', '取消高优先级');
  await expect(page.locator('.tbv-d-prio')).toBeFocused();
  await expect(page.locator('.tbv-d-crumb .tbv-prio')).toContainText('高优先级');
  await expect(count).toHaveText('4');
  // a card nobody has started: the Captain is told once, through the receipt channel
  await expect.poll(captainNotices).toEqual([expect.stringMatching(/用户在任务看板把卡片 legacy「很早以前建的卡片」标为高优先级（项目：客户门户），它还没开始做，请立刻安排/)]);
  await keep(page, 'board-drawer-dark');
  await page.locator('.tbv-d-prio').click();
  await expect.poll(() => readCard('legacy').important).toBe(false);
  await expect.poll(() => cellIds('客户门户', 'todo')).toEqual(['h-todo', 'n-todo2', 'n-todo1', 'legacy']);
  await expect(page.locator('.tbv-d-prio')).toHaveAttribute('aria-pressed', 'false');
  // marking a card somebody is already on tells nobody
  await page.locator('.tbv-card[data-card-id="n-doing"]').click();
  await page.locator('.tbv-d-prio').click();
  await expect.poll(() => readCard('n-doing').important).toBe(true);
  await expect.poll(() => cellIds('客户门户', 'doing')).toEqual(['n-doing', 'h-doing']);
  expect(await captainNotices()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('sidebar and architecture map: marked sessions and waiting work, their order, and the menu toggle, in both themes', async () => {
  await launch();
  const row = (id) => page.locator(`#captainCrewList .colnav-item[data-col-id="${id}"]`);
  if (!(await page.evaluate(() => !!config.crewOpen))) await page.locator('.captain-item .captain-fold').click();
  await expect(row('w-hi')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ['w-hi', 'w-review', 'w-loose', 'w-norm', 'w-plain', 'w-fail'].map((id) => MainSession.isPriority(columns.find((c) => c.id === id))))).toEqual([true, true, true, false, false, false]);
  // executor and reviewer of a marked card, and work marked without a card
  for (const id of ['w-hi', 'w-review', 'w-loose']) {
    await expect(row(id)).toHaveClass(/prio/);
    const mark = await markOf(row(id).locator('.cn-prio'));
    expect(mark).toMatchObject({ role: 'img', label: '高优先级', svg: true });
    expect(mark.title).toContain('高优先级');
    expect(mark.color).toBe(mark.prio);
    expect(await statusColours()).not.toContain(mark.color);
    await expect(row(id).locator('.cn-label')).toHaveAttribute('aria-label', /^高优先级，/);
  }
  for (const id of ['w-norm', 'w-plain', 'w-fail']) await expect(row(id).locator('.cn-prio')).toHaveCount(0);
  // inside one model group the marked sessions come first although the ordinary ones were used more recently
  const order = await page.locator('#captainCrewList .colnav-item[data-col-id]').evaluateAll((n) => n.map((x) => x.dataset.colId));
  expect(order.slice(0, 3).sort()).toEqual(['w-hi', 'w-loose', 'w-review']);
  expect(order.slice(3).sort()).toEqual(['w-fail', 'w-norm', 'w-plain']);
  // the status dot keeps its own meaning next to the flag
  await expect(row('w-hi').locator('.cn-dot')).toBeVisible();
  // waiting work: the marked request is listed first and wears the flag
  const waiting = page.locator('#captainCrewList .crew-waiting');
  await expect(waiting).toHaveCount(2);
  await expect(waiting.nth(0)).toContainText('排队的急事');
  await expect(waiting.nth(0)).toHaveClass(/prio/);
  await expect(waiting.nth(0)).toHaveAttribute('title', /^高优先级，排在普通任务前面/);
  await expect(waiting.nth(1)).toContainText('排队的普通活');
  await expect(waiting.nth(1).locator('.cn-prio')).toHaveCount(0);
  expect(await page.evaluate(() => config.mainSession.waitlist.map((w) => w.title))).toEqual(['排队的急事', '排队的普通活']);
  const clip = async () => { const b = await page.locator('#captainCrewList').boundingBox(); return { x: 0, y: Math.max(0, b.y - 90), width: Math.min(420, b.x + b.width + 16), height: Math.min(900 - Math.max(0, b.y - 90), b.height + 130) }; };
  await keep(page, 'sidebar-dark', { clip: await clip() });
  await page.evaluate(() => applyTheme('light'));
  const lightMark = await markOf(row('w-hi').locator('.cn-prio'));
  expect(lightMark.color).toBe(lightMark.prio);
  await keep(page, 'sidebar-light', { clip: await clip() });
  await keep(page, 'window-light');
  await page.evaluate(() => applyTheme('dark'));
  await keep(page, 'window-dark');

  // the session menu: one checkable item sets and clears the mark
  await row('w-plain').click({ button: 'right' });
  const item = page.locator('.ctx-menu .ctx-item', { hasText: '高优先级' });
  await expect(item).toHaveCount(1);
  await expect(item).not.toHaveClass(/checked/);
  await item.click();
  await expect(row('w-plain').locator('.cn-prio')).toHaveCount(1);
  const marks = (id) => page.evaluate((col) => [config.mainSession.tasks.findLast((t) => t.colId === col).important === true, 'important' in columns.find((c) => c.id === col)], id);
  expect(await marks('w-plain'), 'on the work in progress, not on the session').toEqual([true, false]);
  await row('w-plain').click({ button: 'right' });
  await expect(page.locator('.ctx-menu .ctx-item.checked', { hasText: '高优先级' })).toHaveCount(1);
  await page.locator('.ctx-menu .ctx-item', { hasText: '高优先级' }).click();
  await expect(row('w-plain').locator('.cn-prio')).toHaveCount(0);
  expect(await marks('w-plain')).toEqual([false, false]);
  // a session bound to a card changes the card, not a copy of its own
  await row('w-norm').click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: '高优先级' }).click();
  await expect.poll(() => readCard('n-doing').important).toBe(true);
  await expect(row('w-norm').locator('.cn-prio')).toHaveCount(1);
  expect(await page.evaluate(() => 'important' in columns.find((c) => c.id === 'w-norm'))).toBe(false);
  expect(await captainNotices(), 'already being worked on: nobody is told').toEqual([]);
  await row('w-norm').click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: '高优先级' }).click();
  await expect.poll(() => readCard('n-doing').important).toBe(false);
  await expect(row('w-norm').locator('.cn-prio')).toHaveCount(0);

  // ---- architecture map ----
  await page.evaluate(() => { showView('board'); if (CrewMap.mode() !== 'crew') CrewMap.setMode('crew'); });
  const node = (id) => page.locator(`#crewMap .cm-node[data-node-id="${id}"]`);
  await expect(node('w-hi')).toBeVisible();
  for (const id of ['w-hi', 'w-review', 'w-loose', 'wait:k-wait-h']) {
    await expect(node(id)).toHaveClass(/prio/);
    const mark = await markOf(node(id).locator('.cm-prio'));
    expect(mark).toMatchObject({ role: 'img', label: '高优先级', svg: true });
    expect(mark.background).toBe(mark.prio);
    await expect(node(id).locator('.cm-prio')).toContainText('高优');
    await expect(node(id)).toHaveAttribute('title', /^【高优先级】/);
    // the flag leads the title inside the card; the top row (status, model) is as wide as on an ordinary card
    const g = await node(id).evaluate((n) => { const r = (x) => x.getBoundingClientRect(); const c = r(n), m = r(n.querySelector('.cm-prio')), t = r(n.querySelector('.cm-title'));
      return { inside: m.left >= c.left && m.right <= c.right && m.top >= c.top && m.bottom <= c.bottom, inTitle: n.querySelector('.cm-title').firstElementChild === n.querySelector('.cm-prio'), room: t.right - m.right };
    });
    expect(g.inside).toBe(true); expect(g.inTitle).toBe(true); expect(g.room).toBeGreaterThan(120);
  }
  for (const id of ['w-norm', 'w-plain', 'wait:k-wait-n']) await expect(node(id).locator('.cm-prio')).toHaveCount(0);
  await expect(page.locator('#crewMap .cm-prio')).toHaveCount(4);
  // a marked card is exactly as tall as an ordinary one and keeps its status light ((3.1) the two may stand on different
  // rows, 高优 first in its frame: on the scaled map their heights then differ by a float's last digits, nothing more)
  const sizes = await page.evaluate(() => ['w-hi', 'w-norm'].map((id) => { const n = document.querySelector(`#crewMap .cm-node[data-node-id="${id}"]`); return [n.getBoundingClientRect().height, getComputedStyle(n).boxShadow]; }));
  expect(sizes[0][0]).toBeCloseTo(sizes[1][0], 2);
  expect(sizes[0][1]).toBe(sizes[1][1]);
  await page.evaluate(() => document.querySelector('#crewMap .cm-fit, #crewMap [data-act="fit"]')?.click());
  await keep(page, 'map-dark');
  await page.evaluate(() => applyTheme('light'));
  await keep(page, 'map-light');
  await page.evaluate(() => applyTheme('dark'));
  // a card marked while the map is open: its session gets the flag on the next tick
  await page.evaluate(() => TaskBoard.setPriority('n-doing', 'high'));
  await expect(node('w-norm').locator('.cm-prio')).toHaveCount(1, { timeout: 10000 });
  expect(errors).toEqual([]);
});

test('the Captain marks from the command line: task add, task priority, new, and ledger / task list / queue list / handoff say so', async () => {
  await launch();
  const ok = async (args) => { const r = await cli(args); expect(r.code, r.stderr).toBe(0); return r.stdout; };
  const added = JSON.parse(await ok(['task', 'add', '--project', '客户门户', '--title', '客户点名的急事', '--detail', '今天要', '--priority', 'high']));
  expect(added.card).toMatchObject({ important: true, priority: 'high', status: 'todo' });
  expect(readCard(added.card.id).important).toBe(true);
  expect(JSON.parse(await ok(['task', 'list', '--priority', 'high'])).map((c) => c.id).sort()).toEqual([added.card.id, 'h-doing', 'h-done', 'h-review', 'h-todo'].sort());
  expect(JSON.parse(await ok(['task', 'list', '--project', '客户门户', '--status', 'todo'])).map((c) => [c.id, c.priority])).toContainEqual(['n-todo1', undefined]);

  // by card id, and by the id of the session working on the card
  expect(await ok(['task', 'priority', '--id', 'n-todo1', '--level', 'high'])).toContain('已把卡片 n-todo1「整理登录页文案」标为高优先级');
  expect(readCard('n-todo1').important).toBe(true);
  expect(await ok(['task', 'priority', '--id', 'w-norm', '--level', 'high'])).toContain('已把卡片 n-doing「构建数据工作台界面」标为高优先级');
  expect(readCard('n-doing').important).toBe(true);
  expect(await ok(['task', 'priority', '--id', 'w-loose', '--level', 'normal'])).toContain('「客户电话里说的急事」改回普通优先级');
  expect(await ok(['task', 'priority', '--id', 'h-review', '--level', 'normal'])).toContain('改回普通优先级');
  const bad = await cli(['task', 'priority', '--id', 'nobody', '--level', 'high']);
  expect(bad.code).not.toBe(0); expect(bad.stderr).toContain('找不到卡片或会话：nobody');
  expect(await captainNotices(), "the Captain's own commands send it no notice").toEqual([]);

  const ledger = await ok(['ledger']);
  expect(ledger).toMatch(/w-hi {2}【高优先级】「登录紧急排查」/);
  expect(ledger).toMatch(/w-norm {2}【高优先级】「工作台界面」/);
  expect(ledger).toMatch(/w-loose {2}「客户电话里说的急事」/);
  expect(ledger).toMatch(/w-review {2}「审查：权限越界」/);
  expect(ledger).toMatch(/w-plain {2}「整理文档」/);
  expect(ledger).toContain('排队等空位：【高优先级】「排队的急事」、「排队的普通活」');
  expect(JSON.parse(await ok(['queue', 'list'])).map((w) => [w.title, w.priority])).toEqual([['排队的急事', 'high'], ['排队的普通活', undefined]]);

  // the page follows: the board card and the session row
  if (!(await page.evaluate(() => !!config.crewOpen))) await page.locator('.captain-item .captain-fold').click();
  await expect(page.locator('#captainCrewList .colnav-item[data-col-id="w-norm"] .cn-prio')).toHaveCount(1);
  await expect(page.locator('#captainCrewList .colnav-item[data-col-id="w-loose"] .cn-prio')).toHaveCount(0);
  await expect(page.locator('#captainCrewList .colnav-item[data-col-id="w-review"] .cn-prio')).toHaveCount(0);

  // new --priority high with every slot taken: it waits behind the marked request already there and
  // ahead of the ordinary one. Without a card the request carries the mark; with a card, the card does.
  expect(await ok(['new', '--title', '马上查一下告警', '--task', '查告警', '--command', FAKE, '--priority', 'high'])).toContain('已排队：现在有 5 个会话占用干活名额');
  const waitlist = () => page.evaluate(() => config.mainSession.waitlist.map((w) => [w.title, w.metadata.important === true]));
  expect(await waitlist()).toEqual([['排队的急事', true], ['马上查一下告警', true], ['排队的普通活', false]]);
  expect(await ok(['new', '--title', '做登录文案', '--task', '写文案', '--command', FAKE, '--task-id', 'n-todo2', '--project', '客户门户', '--priority', 'high'])).toContain('已排队');
  expect(readCard('n-todo2').important).toBe(true);
  expect(await waitlist()).toEqual([['排队的急事', true], ['马上查一下告警', true], ['做登录文案', false], ['排队的普通活', false]]);
  expect(await ok(['ledger'])).toContain('排队等空位：【高优先级】「排队的急事」、【高优先级】「马上查一下告警」、【高优先级】「做登录文案」、「排队的普通活」');
  await expect(page.locator('#captainCrewList .crew-waiting')).toHaveCount(4);
  await expect(page.locator('#captainCrewList .crew-waiting.prio')).toHaveCount(3);
  await expect(page.locator('#captainCrewList .crew-waiting').nth(3)).toContainText('排队的普通活');
  // marking the ordinary request by its queue id moves it to its own arrival place (it came first); unmarking sends it back
  const queued = JSON.parse(await ok(['queue', 'list'])).find((w) => w.title === '排队的普通活');
  expect(await ok(['task', 'priority', '--id', queued.queueId, '--level', 'high'])).toContain('已把排队中的「排队的普通活」标为高优先级');
  expect((await waitlist()).map((w) => w[0])).toEqual(['排队的普通活', '排队的急事', '马上查一下告警', '做登录文案']);
  await ok(['task', 'priority', '--id', queued.queueId, '--level', 'normal']);
  expect((await waitlist()).map((w) => w[0])).toEqual(['排队的急事', '马上查一下告警', '做登录文案', '排队的普通活']);

  // the handoff the next Captain reads
  const overview = await ok(['handoff']);
  expect(overview).toMatch(/## 3\. 用户点名的高优先级（\d+ 条，先办）/);
  expect(overview.length).toBeLessThan(6000);
  // the full table is a detail file beside the overview
  const handoff = fs.readFileSync(path.join(profile, 'seats-home', '.agents', 'boards', 'agentdeck-captain-handoff', 'tasks.md'), 'utf8');
  expect(handoff).toMatch(/】【高优先级】h-doing｜客户门户｜线上登录失败紧急排查/);
  expect(handoff).toMatch(/【高优先级】h-todo｜客户门户｜修复支付回调丢单/);
  expect(handoff).toMatch(/】【高优先级】没挂卡｜客户门户｜排队的急事｜还没开会话/);
  expect(handoff).toMatch(/】【高优先级】没挂卡｜[^｜]*｜马上查一下告警｜还没开会话/);
  expect(handoff).toMatch(/】没挂卡｜客户门户｜排队的普通活｜还没开会话/);
  expect(handoff).not.toMatch(/【高优先级】n-review|【高优先级】h-review|【高优先级】r-todo|【高优先级】没挂卡｜客户门户｜排队的普通活/);
  expect(handoff.indexOf('【高优先级】h-todo')).toBeLessThan(handoff.indexOf('legacy｜客户门户'));

  // slots free up one at a time: the waiting work starts in line order, the ordinary request last.
  // (A stand-in agent may finish and free its own slot early; the order must hold all the same.)
  const line = ['排队的急事', '马上查一下告警', '做登录文案', '排队的普通活'];
  const started = () => page.evaluate((titles) => titles.map((title) => !!config.mainSession.tasks.find((t) => t.title === title && t.colId)), line);
  const busy = ['w-plain', 'w-loose', 'w-review', 'w-norm'];
  for (let n = 1; n <= line.length; n++) {
    await page.evaluate((id) => { const t = config.mainSession.tasks.find((x) => x.colId === id); t.status = 'done'; t.doneAt = Date.now(); }, busy[n - 1]);
    await expect.poll(async () => {
      const now = await started();
      expect(now.join(), 'started work is always the head of the line').toBe([...now].sort((a, b) => b - a).join());
      return now.filter(Boolean).length;
    }, { timeout: 30000 }).toBeGreaterThanOrEqual(n);
  }
  const alarm = await page.evaluate(() => columns.find((c) => columnLabel(c) === '马上查一下告警').id);
  expect(await page.evaluate((id) => [config.mainSession.tasks.findLast((t) => t.colId === id).important === true, 'important' in columns.find((c) => c.id === id)], alarm), 'the mark came with the work, the session holds none').toEqual([true, false]);
  expect(await page.evaluate(() => 'important' in columns.find((c) => columnLabel(c) === '做登录文案')), 'bound to a card: the card carries the mark').toBe(false);
  // The mark belongs to that piece of work. Once it is done, an ordinary instruction to the same
  // session is ordinary: no flag on its row, none in the ledger, nothing left on the session.
  const record = () => page.evaluate((id) => { const t = config.mainSession.tasks.findLast((x) => x.colId === id); return [t.status, !!t.startedAt, t.important === true]; }, alarm);
  await expect.poll(async () => { const [status, started] = await record(); return started || status === 'done'; }, { timeout: 30000 }).toBe(true);
  await page.evaluate((id) => MainSession.submit({ action: 'complete', result: '告警查完了' }, columns.find((c) => c.id === id)), alarm);
  await expect.poll(async () => (await record())[0], { timeout: 15000 }).toBe('done');
  expect(await page.evaluate((id) => MainSession.isPriority(columns.find((c) => c.id === id)), alarm)).toBe(false);
  await expect(page.locator(`#captainCrewList .colnav-item[data-col-id="${alarm}"] .cn-prio`)).toHaveCount(0);
  await ok(['tell', '--to', alarm, '--message', '顺便整理一下文档，不急']);
  await expect.poll(async () => (await record())[0]).not.toBe('done');
  expect((await record())[2], 'the new work is not marked').toBe(false);
  expect(await page.evaluate((id) => [MainSession.isPriority(columns.find((c) => c.id === id)), 'important' in columns.find((c) => c.id === id)], alarm)).toEqual([false, false]);
  await expect(page.locator(`#captainCrewList .colnav-item[data-col-id="${alarm}"]`)).toHaveCount(1);
  await expect(page.locator(`#captainCrewList .colnav-item[data-col-id="${alarm}"] .cn-prio`)).toHaveCount(0);
  expect(await ok(['ledger'])).toMatch(new RegExp(`${alarm} {2}「马上查一下告警」`));
  // marked again by the Captain, it shows again
  expect(await ok(['task', 'priority', '--id', alarm, '--level', 'high'])).toContain('标为高优先级');
  await expect(page.locator(`#captainCrewList .colnav-item[data-col-id="${alarm}"] .cn-prio`)).toHaveCount(1);
  expect(await ok(['ledger'])).toMatch(new RegExp(`${alarm} {2}【高优先级】「马上查一下告警」`));

  expect((await ok(['help']))).toContain('task priority --id <card-or-session-id> --level high|normal');
  expect(errors).toEqual([]);
});

// ---- phone ----
const phoneCards = () => {
  const stamp = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const card = (id, title, status, updated, extra = {}) => ({ id, project: '客户门户', title, detail: '', status, flag: null, order: 0, assignee: null, latest_receipt: '', archived: false, important: false, updated: stamp(updated), ...extra });
  return [
    card('p-n1', '整理登录页文案', 'todo', 80), card('p-h1', '修复支付回调丢单', 'todo', 2, { important: true }),
    card('p-n2', '构建数据工作台界面', 'doing', 12, { assignee: { agent: 'claude', model: 'Opus 5.5' }, latest_receipt: '界面骨架已搭好。' }),
    card('p-h2', '线上登录失败紧急排查', 'doing', 3, { important: true, assignee: { agent: 'claude', model: 'Opus 5.5' }, latest_receipt: '已定位到会话过期判断。' }),
    card('p-f', '同步迁移数据', 'doing', 20, { flag: 'failed', latest_receipt: '测试环境缺少数据访问权限。' }),
    card('p-d', '回滚出错的发布', 'done', 200, { important: true, latest_receipt: '已回滚。' }),
    (({ important, ...old }) => old)(card('p-old', '很早以前建的卡片', 'todo', 900)),
  ];
};
async function phoneMark(locator) {
  return locator.evaluate((n) => {
    const probe = document.createElement('i'); probe.style.color = 'var(--prio)'; document.body.append(probe);
    const prio = getComputedStyle(probe).color; probe.remove();
    return { role: n.getAttribute('role'), label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), background: getComputedStyle(n).backgroundColor, prio };
  });
}

test('phone, single machine: the task list marks 高优先级 cards and lists them first, in both themes', async () => {
  const sessions = [{ id: 'captain', title: '队长', model: 'Opus 5.5', status: 'idle', isMain: true, receipt: '' }];
  const server = new MobileWebServer({ getSessions: () => sessions, getTasks: phoneCards,
    getCaptain: () => ({ id: 'captain', title: '队长', status: 'idle', turns: [{ id: 't1', user: '看一下看板', reply: '好的。', done: true }] }),
    getOutput: () => null, sendCaptain: () => {}, saveSettings: () => {} });
  const status = await server.configure({ enabled: true, port: 0 });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const mobile = await context.newPage();
    const problems = [];
    mobile.on('pageerror', (error) => problems.push(String(error)));
    await mobile.goto(status.url);
    await mobile.getByLabel('登录 token').fill(status.token);
    await mobile.getByRole('button', { name: '登录', exact: true }).click();
    await mobile.locator('#tabbar').getByRole('button', { name: '看板' }).click();
    await expect(mobile.locator('.task-card')).not.toHaveCount(0);
    const lane = (key) => mobile.locator(`.board-lane[data-status="${key}"] .task-card`).evaluateAll((n) => n.map((x) => x.dataset.taskId));
    expect(await lane('todo')).toEqual(['p-h1', 'p-n1', 'p-old']);
    expect(await lane('doing')).toEqual(['p-h2', 'p-n2', 'p-f']);
    expect(await mobile.locator('.task-card[data-priority="high"]').evaluateAll((n) => n.map((x) => x.dataset.taskId))).toEqual(['p-h1', 'p-h2']);
    for (const theme of ['dark', 'light']) {
      if (await mobile.locator('html').getAttribute('data-theme') !== theme) {
        await mobile.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      }
      await expect(mobile.locator('html')).toHaveAttribute('data-theme', theme);
      const mark = await phoneMark(mobile.locator('.task-card[data-task-id="p-h1"] .task-prio'));
      expect(mark).toMatchObject({ role: 'img', label: '高优先级', svg: true, text: '高优先级' });
      expect(mark.title).toContain('高优先级');
      expect(mark.background).toBe(mark.prio);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await mobile.locator('.task-card[data-task-id="p-h1"]').scrollIntoViewIfNeeded();
      await keep(mobile, 'mobile-' + theme);
    }
    await expect(mobile.locator('.task-card[data-task-id="p-d"] .task-prio'), 'done: no longer urgent').toHaveCount(0);
    await expect(mobile.locator('.task-card[data-task-id="p-n1"] .task-prio')).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
  }
});

test('phone hub: the merged task list marks 高优先级 cards and lists them first inside a status, in both themes', async () => {
  const hub = await startHub({ machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Test-Mac.local', cards: phoneCards(),
    sessions: [{ id: 'mac-captain', title: '队长', model: 'claude-opus', status: 'idle', isMain: true, receipt: '' }], turns: [] }] });
  const browser = await chromium.launch();
  try {
    for (const theme of ['dark', 'light']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
      const phone = await context.newPage();
      const problems = [];
      phone.on('pageerror', (error) => problems.push(String(error)));
      phone.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) problems.push(message.text()); });
      await phone.goto(hub.url);
      const card = phone.getByRole('article', { name: 'Mac', exact: true });
      await card.getByLabel('Mac 的登录 token').fill(hub.machines.mac.token);
      await card.getByRole('button', { name: '登录 Mac', exact: true }).click();
      await phone.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '看板', exact: true }).click();
      await expect(phone.locator('.task-card')).toHaveCount(7);
      const titles = await phone.locator('.task-card h3').allTextContents();
      expect(titles).toEqual(['修复支付回调丢单', '整理登录页文案', '很早以前建的卡片', '线上登录失败紧急排查', '构建数据工作台界面', '同步迁移数据', '回滚出错的发布']);
      expect(await phone.locator('.task-card[data-priority="high"] h3').allTextContents()).toEqual(['修复支付回调丢单', '线上登录失败紧急排查']);
      const mark = await phoneMark(phone.locator('.task-card[data-priority="high"] .task-prio').first());
      expect(mark).toMatchObject({ role: 'img', label: '高优先级', svg: true, text: '高优先级' });
      expect(mark.background).toBe(mark.prio);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await keep(phone, 'mobile-hub-' + theme);
      expect(problems).toEqual([]);
      await context.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
});
