const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 任务看板's look (星图): the sky, the status light on a card, the dependency
// lines, the progress meter, the moves a card makes when its status changes,
// and the rules that keep it calm (only running work moves, nothing moves under
// 减少动态效果, text stays readable, no backdrop blur, animations touch transform
// and opacity only). Real renderer, isolated userData, PTYs running only the
// stand-in TUI. Set AGENTDECK_TASK_BOARD_SHOTS to keep PNGs of both themes.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_TASK_BOARD_SHOTS;
let application, page, profile;
const errors = [];

// The test window is invisible and click-through, but the page is still told where the real cursor
// rests whenever the layout under it changes, and the card there lights up. Moving the driven pointer
// off the board puts that out.
const park = () => page.mouse.move(Math.round((page.viewportSize() || { width: 1440 }).width * 0.48), 4);
// Running lights are frozen at a set point of their cycle so a picture shows them lit, the same way every time.
// `hovering` keeps the pointer where the test put it, for a picture of a hovered card.
async function screenshot(name, hovering) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  if (!hovering) await park();
  await page.evaluate(() => {
    const at = { 'tbv-breathe': 0.5, 'tbv-flow': 0.42, 'tbv-ping': 0.2, 'sky-twinkle': 0.6, 'tbv-twinkle-soft': 0.8, 'tbv-breathe-soft': 0.5 };
    document.getAnimations().forEach((a, i) => {
      const target = a.effect && a.effect.target;
      if (!target) return;
      const t = a.effect.getComputedTiming();
      // anything that ends is shown ended, wherever it is (a theme switch fades the app's own chrome too)
      if (t.iterations !== Infinity) { a.finish(); return; }
      if (!document.getElementById('taskBoardView').contains(target)) return;
      const spark = target.classList.contains('tbv-spark');
      a.pause();
      a.currentTime = (spark ? 0.3 + (i % 5) * 0.09 : at[a.animationName] || 0.5) * t.duration;
    });
  });
  await page.screenshot({ path: path.join(shots, 'board-' + name + '.png'), animations: 'allow', scale: 'css' });
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}
async function resize(width, height) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}

// Invented work in the shape the board really holds: one busy project, cards waiting on each other
// inside a project and across projects, a failure, a question, a held card and a finished project.
// Longer names for three of the projects: every one must show whole wherever it is written.
const LONG = { 'hermes-savings': 'hermes-savings-center', 'type4me-windows': 'type4me-windows-installer', '客户门户': '客户门户与数据工作台二期' };
function seed(dir, many, long) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  let order = 0;
  const card = (project, id, title, status, extra = {}) => ({ id, project, title, detail: '', status, flag: null, order: order++, depends_on: [],
    assignee: null, session_id: null, latest_receipt: '', verify: false, rework_count: 0, created: at(900), updated: at(45), archived: false, ...extra });
  const opus = { agent: 'claude', model: 'Opus 5.5' }, sonnet = { agent: 'claude', model: 'Sonnet 5.5' }, codex = { agent: 'codex', model: 'GPT-6.1 Sol' };
  const boards = {
    agentdeck: [
      card('agentdeck', 'a-1112', '1.1.12 集成与打包', 'todo', { depends_on: ['a-star', 'a-mobile', 'a-resume'], updated: at(18) }),
      card('agentdeck', 'a-docs', '更新使用说明和发版记录', 'todo', { depends_on: ['a-1112'], updated: at(52) }),
      card('agentdeck', 'a-clean', '清理旧 worktree', 'todo', { flag: 'held', updated: at(300) }),
      card('agentdeck', 'a-bark', 'Bark 提醒去重', 'todo', { detail: '同一件事十分钟内只响一次。', updated: at(95) }),
      card('agentdeck', 'a-font', '字号缩放快捷键', 'todo', { detail: '⌘+ / ⌘− 跟终端字号一起走。', updated: at(140) }),
      card('agentdeck', 'a-star', '任务看板星图视觉', 'doing', { session_id: 'w-star', assignee: opus, latest_receipt: '深浅两套样式已出，正在跑截图。', updated: at(2),
        detail: '近黑深空、玻璃卡片、依赖连线。\n对比图在 /Users/demo/reports/board-starlight/shots/compare.png 。' }),
      card('agentdeck', 'a-mobile', '手机网页端：对话区重排', 'doing', { session_id: 'w-mobile', assignee: opus, updated: at(6) }),
      card('agentdeck', 'a-ci', 'CI Verify #81 失败排查', 'doing', { flag: 'quota', resource_failure: 'quota', assignee: sonnet, latest_receipt: '额度用尽：You\'ve hit your session limit · resets 03:00', updated: at(24) }),
      card('agentdeck', 'a-quota', '额度面板并入侧栏', 'doing', { session_id: 'w-quota', assignee: sonnet, latest_receipt: '侧栏一行显示已接好，等队长看。', updated: at(11) }),
      card('agentdeck', 'a-sign', 'Windows 安装包签名', 'doing', { assignee: codex, updated: at(26) }),
      card('agentdeck', 'a-resume', '重启后自动续跑', 'review', { assignee: opus, latest_receipt: '单测和相关 E2E 通过，等验收。', updated: at(14) }),
      card('agentdeck', 'a-relay', '队长接力交接 v2', 'review', { flag: 'failed', rework_count: 1, assignee: codex, latest_receipt: '验收没过：交接摘要丢了最后一条回执。', updated: at(33) }),
      card('agentdeck', 'a-e2e', '发版前跑哪些测试', 'needs_user', { assignee: opus, user_question: '发版前要不要跑全量 E2E？全量约 40 分钟，冒烟 5 分钟。', latest_receipt: '发版前要不要跑全量 E2E？', updated: at(4) }),
      ...[1, 2, 3, 4, 5, 6].map((i) => card('agentdeck', 'a-done' + i, ['侧栏一行显示', '队长皇冠图标', '回执去重', '架构图只留当前的活', '额度低提醒', '版本号标签'][i - 1], 'done', { latest_receipt: '已合入。', updated: at(600 + i * 90) })),
    ],
    'hermes-savings': [
      card('hermes-savings', 'h-sub', '订阅到期提醒', 'todo', { depends_on: ['h-radar'], updated: at(70) }),
      card('hermes-savings', 'h-radar', '省钱中心雷达任务注册', 'doing', { session_id: 'w-radar', assignee: sonnet, latest_receipt: '已注册 3 个雷达任务，剩 2 个。', updated: at(1) }),
      card('hermes-savings', 'h-daily', '/daily 日报卡片', 'review', { assignee: codex, latest_receipt: '卡片样式和空状态已做完。', updated: at(38) }),
      card('hermes-savings', 'h-keep', '回滚点保留多久', 'needs_user', { user_question: '回滚点要保留 7 天还是 30 天？', updated: at(64) }),
      ...[1, 2, 3].map((i) => card('hermes-savings', 'h-done' + i, ['token 登录', '今日页', '订阅页'][i - 1], 'done', { updated: at(1400 + i * 60) })),
    ],
    'type4me-windows': [
      card('type4me-windows', 't-update', '安装包自动更新', 'todo', { depends_on: ['a-sign'], updated: at(120) }),
      card('type4me-windows', 't-hot', '热词表导入', 'todo', { depends_on: ['t-key'], updated: at(160) }),
      card('type4me-windows', 't-doubao', '豆包语音切换', 'doing', { session_id: 'w-doubao', assignee: sonnet, updated: at(9) }),
      card('type4me-windows', 't-key', '钥匙串密钥迁移', 'doing', { flag: 'failed', assignee: codex, latest_receipt: '钥匙串授权被拒绝，需要重新登录后再迁移。', updated: at(41) }),
      ...[1, 2].map((i) => card('type4me-windows', 't-done' + i, ['微软语音默认', '私有仓库同步'][i - 1], 'done', { updated: at(2000 + i * 60) })),
    ],
    '客户门户': [
      card('客户门户', 'p-sso', '接入企业 SSO', 'todo', { depends_on: ['p-login'], updated: at(200) }),
      card('客户门户', 'p-login', '客户登录与多租户权限', 'doing', { assignee: codex, updated: at(55) }),
      card('客户门户', 'p-ui', '数据工作台界面', 'review', { assignee: codex, latest_receipt: '已完成实现、单元测试和端到端验证。', updated: at(75) }),
      card('客户门户', 'p-done1', '登录接口限流', 'done', { latest_receipt: '完成，限流 10 次/分钟。', updated: at(900) }),
    ],
    '旧项目': [1, 2].map((i) => card('旧项目', 'o-' + i, `早就做完的任务 ${i}`, 'done', { latest_receipt: '已完成。', updated: at(5000) })),
  };
  if (many) {
    // a board far busier than the usual one: 110+ cards, a dozen and a half of them running at once
    const running = ['w-star', 'w-mobile', 'w-radar'];
    const names = ['hermes-music', '库存表', 'health', 'yitiaolong'];
    names.forEach((name, p) => {
      boards[name] = [];
      for (let i = 0; i < 16; i++) {
        const status = ['todo', 'todo', 'todo', 'doing', 'doing', 'doing', 'doing', 'review', 'review', 'needs_user', 'done', 'done', 'done', 'done', 'todo', 'doing'][i];
        const extra = status === 'doing' && i % 2 ? { session_id: running[(p + i) % 3], assignee: opus } : {};
        if (i === 14) extra.depends_on = [`m${p}-3`, `m${p}-4`];
        if (i === 1) extra.depends_on = [`m${p}-7`];
        boards[name].push(card(name, `m${p}-${i}`, `${name} 的任务 ${i + 1}${i % 5 === 0 ? '：标题长一些，看两行时卡片会不会被撑高或者截断' : ''}`, status, { updated: at(3 + i * 7), ...extra }));
      }
    });
    for (let i = 0; i < 14; i++) boards.agentdeck.push(card('agentdeck', 'a-more' + i, `进行中的任务 ${i + 1}`, 'doing', { updated: at(5 + i), ...(i % 2 ? { session_id: running[i % 3], assignee: sonnet } : {}) }));
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, cards] of Object.entries(boards)) {
    const project = (long && LONG[key]) || key;
    cards.forEach((c) => { c.project = project; });
    fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
  }
  return Object.values(boards).flat();
}

let seeded = [];
async function launch({ many = false, empty = false, long = false } = {}) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-board-star-'));
  seeded = empty ? [] : seed(path.join(profile, 'tasks'), many, long);
  const column = (id, title, project) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, project: (long && LONG[project]) || project });
  const workers = [column('w-star', '星图视觉', 'agentdeck'), column('w-mobile', '手机网页端', 'agentdeck'), column('w-quota', '额度面板', 'agentdeck'), column('w-radar', '雷达任务', 'hermes-savings'), column('w-doubao', '豆包切换', 'type4me-windows')];
  const now = Date.now();
  // Unbound 进行中 cards send their heartbeat notices to the stand-in Captain, never to a real provider CLI.
  // These sessions stand for work in progress; nothing is to be sent again when the app starts.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, taskBoard: { dispatcher: 'captain' },
    columns: [{ ...column('cap', '队长', ''), isMain: true, captainCrew: false }, ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: 'working', sentAt: now - 60_000 + i, turnId: '', receipt: null })) },
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
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 30000 }).toBe(6);
  // Three stand-in sessions count as busy for the whole test and two as idle, whatever their screens are doing.
  await page.evaluate(() => { for (const [id, state] of [['w-star', 'working'], ['w-mobile', 'working'], ['w-radar', 'working'], ['w-quota', 'done'], ['w-doubao', 'done']]) Object.defineProperty(terms.get(id), 'state', { get: () => state, set() {}, configurable: true }); });
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null;
});

const card = (id) => page.locator(`.tbv-card[data-card-id="${id}"]`);
const link = (from, to) => page.locator(`.tbv-link[data-from="${from}"][data-to="${to}"]`);
// The animations running inside the board: which element, which properties, whether they ever end.
const boardAnimations = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && document.getElementById('taskBoardView').contains(a.effect.target) && a.playState === 'running').map((a) => ({
  cls: String(a.effect.target.className && a.effect.target.className.baseVal != null ? a.effect.target.className.baseVal : a.effect.target.className), pseudo: a.effect.pseudoElement || '', name: a.animationName || '',
  endless: a.effect.getComputedTiming().iterations === Infinity,
  props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)) })));
// Where a line starts and ends, and the edges of the cards it joins, in the grid's own coordinates.
const geometry = (from, to) => page.evaluate(([f, t]) => {
  const grid = document.querySelector('.tbv-grid').getBoundingClientRect();
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.left - grid.left, y: r.top - grid.top, right: r.right - grid.left, bottom: r.bottom - grid.top, mid: (r.top + r.bottom) / 2 - grid.top }; };
  const g = document.querySelector(`.tbv-link[data-from="${f}"][data-to="${t}"]`);
  const nums = g.querySelector('.tbv-link-line').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
  const cardOf = (id) => document.querySelector(`.tbv-card[data-card-id="${id}"]`);
  return { start: nums.slice(0, 2), end: nums.slice(-2), from: cardOf(f) ? rect(cardOf(f)) : null, to: rect(cardOf(t)), tone: g.dataset.tone, live: g.classList.contains('live') };
}, [from, to]);
// WCAG contrast of two CSS colours, the second painted over `under` first when it is translucent.
const contrast = (fg, bg, under) => page.evaluate(([f, b, u]) => {
  const view = document.getElementById('taskBoardView');
  const rgba = (c) => { const p = document.createElement('i'); p.style.color = c; view.append(p); const m = getComputedStyle(p).color.match(/[\d.]+/g).map(Number); p.remove(); return [m[0], m[1], m[2], m[3] == null ? 1 : m[3]]; };
  const token = (name) => rgba(name.startsWith('--') ? getComputedStyle(view).getPropertyValue(name).trim() : name);
  const over = (top, base) => top.slice(0, 3).map((v, i) => v * top[3] + base[i] * (1 - top[3])).concat(1);
  const lum = (c) => { const [r, g, bl] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const back = u ? over(token(b), token(u)) : token(b);
  const a = lum(over(token(f), back)), c = lum(back);
  return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
}, [fg, bg, under || '']);

test('star chart: status light, dependency lines, meter, motion rules and both themes at three sizes', async () => {
  await launch();
  await resize(1440, 900);
  await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
  const view = page.locator('#taskBoardView');
  await expect(view).toBeVisible();
  await expect(page.locator('.tbv-lane')).toHaveCount(4);
  await expect(page.locator('.tbv-head .tbv-count')).toHaveText(['9', '9', '4', '2', '14']);

  // the sky sits under everything, is never hit, and no part of the board blurs what is behind it
  const sky = await page.evaluate(() => { const s = document.querySelector('#taskBoardView .star-sky'), v = document.getElementById('taskBoardView');
    const a = s.getBoundingClientRect(), b = v.getBoundingClientRect();
    return { covers: Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, events: getComputedStyle(s).pointerEvents, hidden: s.getAttribute('aria-hidden'),
      blur: [...v.querySelectorAll('*')].filter((n) => getComputedStyle(n).backdropFilter !== 'none').length }; });
  expect(sky).toEqual({ covers: true, events: 'none', hidden: 'true', blur: 0 });

  // progress meter: the share that is done, the fraction, one lit segment per status that has cards
  const meter = page.locator('.tbv-meter');
  await expect(meter.locator('.tbv-meter-pct')).toHaveText('36');
  await expect(meter.locator('.tbv-meter-frac')).toHaveText('14 / 38');
  expect(await meter.locator('.tbv-meter-bar i').evaluateAll((n) => n.map((x) => [x.dataset.status, x.style.flexGrow, x.title]))).toEqual([
    ['done', '14', '完成 14'], ['review', '4', '待验收 4'], ['doing', '9', '进行中 9'], ['needs_user', '2', '需要你 2'], ['todo', '9', '待办 9']]);
  await expect(meter).toHaveAttribute('aria-label', '完成进度 36%：38 张里完成 14 张。完成 14，待验收 4，进行中 9，需要你 2，待办 9');
  // each group bar carries how much of the group is done
  expect(await page.locator('.tbv-lane[data-project="agentdeck"]').evaluate((n) => n.style.getPropertyValue('--tbv-done'))).toBe((6 / 19).toFixed(3));

  // status light: only a card somebody is working on carries the travelling light; a 需要你 card carries a beacon
  await expect(card('a-star')).toHaveAttribute('data-run', 'working');
  await expect(card('a-star').locator('.tbv-flow')).toHaveCount(1);
  await expect(card('t-doubao')).toHaveAttribute('data-run', 'live');
  await expect(card('p-login')).toHaveAttribute('data-run', 'open');
  await expect(card('a-ci')).toHaveAttribute('data-run', 'failed');
  await expect(page.locator('.tbv-card:not([data-run="working"]) .tbv-flow')).toHaveCount(0);
  await expect(page.locator('.tbv-flow')).toHaveCount(3);
  await expect(page.locator('.tbv-card[data-status="needs_user"] .tbv-beacon')).toHaveCount(2);
  await expect(page.locator('.tbv-card:not([data-status="needs_user"]) .tbv-beacon')).toHaveCount(0);
  // the four lit statuses do not share a colour
  const tops = await page.evaluate(() => ['a-star', 'a-resume', 'a-e2e', 'a-relay', 'a-docs'].map((id) => getComputedStyle(document.querySelector(`.tbv-card[data-card-id="${id}"]`), '::before').backgroundImage));
  expect(new Set(tops).size).toBe(5);

  // dependency lines: one per unfinished prerequisite, from the prerequisite's side into the waiting card's side
  await expect(page.locator('.tbv-link')).toHaveCount(8);
  for (const [from, to, tone, live] of [['a-star', 'a-1112', 'flow', true], ['a-mobile', 'a-1112', 'flow', true], ['a-resume', 'a-1112', 'flow', false], ['a-1112', 'a-docs', 'idle', false],
    ['h-radar', 'h-sub', 'flow', true], ['a-sign', 't-update', 'flow', false], ['t-key', 't-hot', 'stuck', false], ['p-login', 'p-sso', 'flow', false]]) {
    const g = await geometry(from, to);
    expect([g.tone, g.live], `${from} → ${to}`).toEqual([tone, live]);
    expect(Math.abs(g.end[1] - g.to.mid), `${from} → ${to} enters the middle of its side`).toBeLessThanOrEqual(1);
    expect(Math.min(Math.abs(g.end[0] - g.to.x), Math.abs(g.end[0] - g.to.right))).toBeLessThanOrEqual(1);
    if (from === 'a-sign') { expect(g.from).toBeNull(); continue; } // behind 展开剩余: checked below
    expect(Math.abs(g.start[1] - g.from.mid), `${from} → ${to} leaves the middle of its side`).toBeLessThanOrEqual(1);
    expect(Math.min(Math.abs(g.start[0] - g.from.x), Math.abs(g.start[0] - g.from.right))).toBeLessThanOrEqual(1);
  }
  // a line never takes clicks from the cards, and sits under them
  expect(await page.evaluate(() => { const l = document.querySelector('.tbv-links'), lanes = document.querySelector('.tbv-lanes');
    return [getComputedStyle(l).pointerEvents, Number(getComputedStyle(l).zIndex) < Number(getComputedStyle(lanes).zIndex)]; })).toEqual(['none', true]);
  // a light travels only the lines whose prerequisite is being worked on
  await expect(page.locator('.tbv-link.live')).toHaveCount(3);
  await expect(page.locator('.tbv-spark')).toHaveCount(3);

  // hovering a card lights its own lines and the cards at their other ends; the rest step back
  await card('a-1112').hover();
  await expect(page.locator('.tbv-links')).toHaveClass(/hot/);
  await expect(page.locator('.tbv-link.on')).toHaveCount(4);
  expect((await page.locator('.tbv-card.linked').evaluateAll((n) => n.map((x) => x.dataset.cardId))).sort()).toEqual(['a-docs', 'a-mobile', 'a-resume', 'a-star']);
  await screenshot('dark-1440-links-lit', true);
  await page.mouse.move(700, 20);
  await expect(page.locator('.tbv-links')).not.toHaveClass(/hot/);
  await expect(page.locator('.tbv-card.linked')).toHaveCount(0);
  // so does keyboard focus
  await card('t-hot').focus();
  await expect(link('t-key', 't-hot')).toHaveClass(/on/);
  await page.evaluate(() => document.activeElement.blur());

  // a prerequisite folded away is reached at its fold: behind 展开剩余, or in a folded group
  const startOf = (selector) => page.evaluate((sel) => { const grid = document.querySelector('.tbv-grid').getBoundingClientRect(), r = document.querySelector(sel).getBoundingClientRect();
    const nums = document.querySelector('.tbv-link[data-from="a-sign"][data-to="t-update"] .tbv-link-line').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
    return { dx: Math.min(Math.abs(nums[0] - (r.left - grid.left)), Math.abs(nums[0] - (r.right - grid.left))), dy: Math.abs(nums[1] - ((r.top + r.bottom) / 2 - grid.top)) }; }, selector);
  const more = '.tbv-lane[data-project="agentdeck"] .tbv-cell[data-status="doing"] .tbv-more';
  await expect(card('a-sign')).toHaveCount(0); // the fifth 进行中 card
  let at = await startOf(more);
  expect(at.dx).toBeLessThanOrEqual(1); expect(at.dy).toBeLessThanOrEqual(1);
  await page.locator(more).click();
  await expect(card('a-sign')).toHaveCount(1);
  at = await startOf('.tbv-card[data-card-id="a-sign"]');
  expect(at.dx).toBeLessThanOrEqual(1); expect(at.dy).toBeLessThanOrEqual(1);
  await page.locator('.tbv-lane[data-project="agentdeck"] .tbv-lane-open').click(); // fold the whole group
  await expect(page.locator('.tbv-lane[data-project="agentdeck"]')).toHaveClass(/collapsed/);
  await expect(page.locator('.tbv-link')).toHaveCount(4); // the lines between the folded group's own cards went with them
  at = await startOf('.tbv-lane[data-project="agentdeck"] .tbv-lane-head .tbv-dot');
  expect(at.dy).toBeLessThanOrEqual(1);
  await page.locator('.tbv-lane[data-project="agentdeck"] .tbv-lane-toggle').click();
  await page.locator(more).click();
  await expect(card('a-sign')).toHaveCount(0);
  await expect(page.locator('.tbv-link')).toHaveCount(8);
  await page.mouse.move(700, 20);

  // motion: everything that runs forever touches transform and opacity only, and belongs to running work, 需要你 or the sky
  const running = await boardAnimations();
  const endless = running.filter((a) => a.endless);
  expect(endless.length).toBeGreaterThan(0);
  for (const a of endless) expect(a.props.every((p) => p === 'transform' || p === 'opacity'), `${a.cls}${a.pseudo} animates ${a.props}`).toBe(true);
  const owners = new Set(endless.map((a) => a.name || a.cls));
  for (const name of owners) expect(['tbv-breathe', 'tbv-flow', 'tbv-ping', 'sky-twinkle', 'tbv-spark']).toContain(name);
  // a still card has nothing running on it
  expect(await page.evaluate(() => { const n = document.querySelector('.tbv-card[data-card-id="a-docs"]'); return n.getAnimations({ subtree: true }).length; })).toBe(0);

  // text stays readable on the glass and on the sky, in both themes (WCAG AA for body text)
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    for (const ink of ['--tbv-ink', '--tbv-ink-2', '--tbv-ink-3', '--tbv-doing', '--tbv-review', '--tbv-need', '--tbv-fail', '--tbv-done', '--tbv-wire-hi']) {
      for (const [bg, under] of [['--tbv-glass', '--tbv-sky'], ['--tbv-glass-2', '--tbv-sky'], ['--tbv-sky', '']]) {
        expect(await contrast(ink, bg, under), `${theme}: ${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(await contrast('--tbv-cta-ink', theme === 'dark' ? '#4f63ea' : '#4a5fe8'), `${theme}: 发送答案`).toBeGreaterThanOrEqual(4.5);
    // nothing spills sideways and every card keeps to its cell
    const layout = await page.evaluate(() => { const s = document.querySelector('.tbv-scroll');
      const bad = [...document.querySelectorAll('.tbv-cell')].flatMap((cell) => { const c = cell.getBoundingClientRect(); return [...cell.querySelectorAll('.tbv-card')].filter((n) => { const r = n.getBoundingClientRect(); return r.left < c.left - 0.5 || r.right > c.right + 0.5; }).map((n) => n.dataset.cardId); });
      return { fits: s.scrollWidth <= s.clientWidth + 1, bad }; });
    expect(layout).toEqual({ fits: true, bad: [] });
    await screenshot(`${theme}-1440-board`);
  }
  await page.evaluate(() => applyTheme('dark'));

  // a card whose status changes glides to its new cell and is lit once; the lines follow it
  const before = await card('p-ui').boundingBox();
  await page.evaluate(async () => { const c = (await TaskBoard.list()).find((x) => x.id === 'p-ui'); await TaskBoard.move('p-ui', 'needs_user', c.updated); });
  await expect(page.locator('.tbv-cell[data-status="needs_user"] .tbv-card[data-card-id="p-ui"]')).toHaveCount(1);
  const moving = await page.evaluate(() => { const n = document.querySelector('.tbv-card[data-card-id="p-ui"]');
    return { glide: n.getAnimations().some((a) => !a.animationName && a.effect.getKeyframes().some((k) => /translate/.test(k.transform || ''))), cls: n.classList.contains('gliding'), flash: n.querySelectorAll('.tbv-flash').length }; });
  expect(moving).toEqual({ glide: true, cls: true, flash: 1 });
  await expect(card('p-ui').locator('.tbv-flash')).toHaveCount(0, { timeout: 4000 });
  await expect(card('p-ui')).not.toHaveClass(/gliding/);
  expect((await card('p-ui').boundingBox()).x).toBeGreaterThan(before.x + 200);
  await expect(card('p-ui').locator('.tbv-beacon')).toHaveCount(1);
  // folding and filtering redraw at once: no card is left mid-air for the layout to be read wrong
  await page.locator('.tbv-head[data-status="done"]').click();
  expect(await page.evaluate(() => [...document.querySelectorAll('.tbv-card')].filter((n) => n.getAnimations().some((a) => !a.animationName)).length)).toBe(0);
  await page.locator('.tbv-head[data-status="done"]').click();

  // the drawer: the opened card keeps its lines lit; tool actions are icon buttons
  await card('a-1112').click();
  const detail = page.locator('.tbv-detail');
  await expect(detail).toBeVisible();
  await page.mouse.move(700, 20);
  await expect(page.locator('.tbv-link.on')).toHaveCount(4);
  await expect(detail.locator('.tbv-d-moves button .tbv-n-ico svg')).toHaveCount(5);
  await page.keyboard.press('Escape'); // focus goes back to the card, so its lines stay lit until it loses it
  await expect(card('a-1112')).toBeFocused();
  await expect(page.locator('.tbv-link.on')).toHaveCount(4);
  await page.evaluate(() => document.activeElement.blur());
  await expect(page.locator('.tbv-link.on')).toHaveCount(0);
  await card('a-e2e').click();
  await expect(detail.locator('.tbv-ask-question')).toHaveText('发版前要不要跑全量 E2E？全量约 40 分钟，冒烟 5 分钟。');
  await detail.locator('textarea').fill('先跑冒烟，全量放到夜里。');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    // the opened card has no lines of its own: nothing else on the board is lit or marked
    await park();
    expect(await page.evaluate(() => [...document.querySelectorAll('.tbv-card.linked, .tbv-card .tbv-flash, .tbv-link.on')].map((n) => `${n.className.baseVal || n.className} ${n.dataset.cardId || n.parentElement.dataset.cardId || n.dataset.from + '>' + n.dataset.to}`))).toEqual([]);
    await screenshot(`${theme}-1440-drawer`);
  }
  await page.evaluate(() => applyTheme('dark'));
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await card('a-star').click();
  await expect(detail.locator('.tbv-d-file')).toHaveText('/Users/demo/reports/board-starlight/shots/compare.png');
  const icons = await page.evaluate(() => [...document.querySelectorAll('#taskBoardView .tbv-icon')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => ({ label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height })));
  expect(icons.map((i) => i.label)).toEqual(expect.arrayContaining(['关闭任务看板 (Esc)', '展开全部分组', '收起全部分组', '刷新', '关闭详情 (Esc)', '打开「星图视觉」的终端', '复制路径', '复制卡片编号']));
  for (const b of icons) { expect(b.title).toBe(b.label); expect(b.svg).toBe(true); expect(b.text).toBe(''); expect(b.w).toBeGreaterThanOrEqual(28); expect(b.h).toBeGreaterThanOrEqual(28); }
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await screenshot(`${theme}-1440-drawer-working`);
  }
  await page.evaluate(() => applyTheme('dark'));
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // narrower windows: the columns stack, the lines turn into brackets beside the cards, nothing spills
  await page.evaluate(() => document.activeElement.blur());
  await page.mouse.move(700, 20);
  for (const [w, h] of [[980, 700], [700, 800]]) {
    await resize(w, h);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await expect.poll(() => page.locator('.tbv-link').count()).toBe(8);
      const narrow = await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'), v = document.getElementById('taskBoardView').getBoundingClientRect();
        const grid = document.querySelector('.tbv-grid').getBoundingClientRect();
        const xs = [...document.querySelectorAll('.tbv-link-line')].flatMap((p) => { const n = p.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number); return n.filter((_, i) => i % 2 === 0); });
        return { fits: s.scrollWidth <= s.clientWidth + 1, inside: v.right <= innerWidth, left: Math.min(...xs) + grid.left - v.left, heads: getComputedStyle(document.querySelector('.tbv-heads')).display }; });
      expect(narrow.fits, 'no horizontal scroll').toBe(true);
      expect(narrow.inside).toBe(true);
      expect(narrow.heads).toBe('none');
      expect(narrow.left, 'lines stay inside the board').toBeGreaterThanOrEqual(2);
      await screenshot(`${theme}-${w}-board`);
    }
  }
  expect(errors).toEqual([]);
});

test('减少动态效果: nothing on the board moves, and a status change lands at once', async () => {
  await launch();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await resize(1440, 900);
  await page.locator('#taskBoardBtn').click();
  await expect(card('a-star')).toHaveAttribute('data-run', 'working');
  await expect(page.locator('.tbv-link')).toHaveCount(8);
  await expect(page.locator('.tbv-link.live')).toHaveCount(3); // the lines still say what is moving
  await expect(page.locator('.tbv-spark')).toHaveCount(0);
  expect(await boardAnimations()).toEqual([]);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.tbv-flow')).display)).toBe('none');
  // the working rim holds a steady light instead of breathing
  expect(Number(await page.evaluate(() => getComputedStyle(document.querySelector('.tbv-card[data-card-id="a-star"]'), '::after').opacity))).toBeGreaterThan(0.5);
  await page.evaluate(async () => { const c = (await TaskBoard.list()).find((x) => x.id === 'p-ui'); await TaskBoard.move('p-ui', 'needs_user', c.updated); });
  await expect(page.locator('.tbv-cell[data-status="needs_user"] .tbv-card[data-card-id="p-ui"]')).toHaveCount(1);
  expect(await page.evaluate(() => { const n = document.querySelector('.tbv-card[data-card-id="p-ui"]'); return [n.getAnimations({ subtree: true }).length, n.querySelectorAll('.tbv-flash').length]; })).toEqual([0, 0]);
  expect(await boardAnimations()).toEqual([]);
  await screenshot('dark-1440-reduced-motion');
  expect(errors).toEqual([]);
});

test('动效开关: one icon button holds the board still, says so, and is remembered', async () => {
  await launch();
  await resize(1440, 900);
  await page.locator('#taskBoardBtn').click();
  await expect(card('a-star')).toHaveAttribute('data-run', 'working');
  const toggle = page.locator('#taskBoardView [data-motion-toggle]');
  const OFF = '关闭动效（卡片和连线保持静止）', ON = '开启动效（现在是静止的）';
  // an icon button: no words on it, a name for the tooltip and for a screen reader, big enough to hit
  await expect(toggle).toHaveAttribute('aria-label', OFF);
  await expect(toggle).toHaveAttribute('title', OFF);
  expect((await toggle.textContent()).trim()).toBe('');
  await expect(toggle.locator('svg')).toHaveCount(1);
  const box = await toggle.boundingBox();
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
  await expect.poll(() => page.locator('.tbv-spark').count()).toBeGreaterThan(0);
  expect((await boardAnimations()).length).toBeGreaterThan(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', ON);
  await expect(page.locator('.tbv-spark')).toHaveCount(0);
  await expect.poll(boardAnimations).toEqual([]); // the board's own arrival may still be finishing
  await expect(page.locator('.tbv-link.live')).toHaveCount(3); // the lines still say what is moving
  expect(await page.evaluate(() => [getComputedStyle(document.querySelector('.tbv-flow')).display, getComputedStyle(document.querySelector('#taskBoardView .star-sky i')).animationName])).toEqual(['none', 'none']);
  expect(Number(await page.evaluate(() => getComputedStyle(document.querySelector('.tbv-card[data-card-id="a-star"]'), '::after').opacity))).toBeGreaterThan(0.5);
  // a status change lands at once while it is off
  await page.evaluate(async () => { const c = (await TaskBoard.list()).find((x) => x.id === 'p-ui'); await TaskBoard.move('p-ui', 'needs_user', c.updated); });
  await expect(page.locator('.tbv-cell[data-status="needs_user"] .tbv-card[data-card-id="p-ui"]')).toHaveCount(1);
  expect(await page.evaluate(() => { const n = document.querySelector('.tbv-card[data-card-id="p-ui"]'); return [n.getAnimations({ subtree: true }).length, n.querySelectorAll('.tbv-flash').length]; })).toEqual([0, 0]);
  // the 架构图's button is the same switch
  await expect(page.locator('#crewMap [data-motion-toggle]')).toHaveAttribute('aria-label', ON);

  // the keyboard reaches it, and the lights come back
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-label', OFF);
  await expect.poll(() => page.locator('.tbv-spark').count()).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-label', ON);

  // remembered across a reload
  await page.evaluate(() => flushConfig());
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion || '')).toBe('off');
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('.tbv-card').first()).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-label', ON);
  expect(await boardAnimations()).toEqual([]);

  // the system setting wins: the button only reports it
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', OFF);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(toggle).toHaveAttribute('aria-label', '系统已开启「减少动态效果」，动效保持关闭');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await toggle.click({ force: true });
  expect(await page.evaluate(() => config.calmMotion)).toBe(false);
  expect(await boardAnimations()).toEqual([]);
  expect(errors).toEqual([]);
});

// Every name on the board that is not whole, every pair of things in the filter bar that touch, and
// every 需要你 entry that shows cut. Nothing here may be cut to fit: chips wrap, the tally and tools
// drop to their own row, and an entry that does not fit the reminder bar is left out whole.
const cutNames = () => page.evaluate(() => {
  const view = document.getElementById('taskBoardView');
  const shown = (n) => n.getClientRects().length > 0;
  const rect = (n) => n.getBoundingClientRect();
  const cut = [...view.querySelectorAll('.tbv-chip-name, .tbv-lane-name, .tbv-summary, .tbv-heading h1, .tbv-head-label, .tbv-lane-open')].filter(shown)
    .filter((n) => n.scrollWidth > n.clientWidth).map((n) => `${n.className}「${n.textContent}」 ${n.scrollWidth}>${n.clientWidth}`);
  const bar = rect(view.querySelector('.tbv-filters'));
  const parts = [...view.querySelectorAll('.tbv-chip, .tbv-summary, .tbv-filters > .tbv-icon')].filter(shown).map((n) => ({ what: n.className + ' ' + n.textContent.trim().slice(0, 12), r: rect(n) }));
  const touching = [];
  parts.forEach((a, i) => { if (a.r.left < bar.left - 0.5 || a.r.right > bar.right + 0.5) touching.push(a.what + ' outside the bar');
    parts.slice(i + 1).forEach((b) => { if (a.r.left < b.r.right + 4 && b.r.left < a.r.right + 4 && a.r.top < b.r.bottom && b.r.top < a.r.bottom) touching.push(a.what + ' / ' + b.what); }); });
  const list = view.querySelector('.tbv-alert-list'), box = list && shown(list) ? rect(list) : null;
  const entries = box ? [...list.querySelectorAll('.tbv-alert-item')].map((n) => { const r = rect(n), title = n.querySelector('.tbv-alert-title');
    const inside = r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5, outside = r.top >= box.bottom - 0.5;
    return { text: title.textContent, inside, outside, cut: inside && (r.left < box.left - 0.5 || r.right > box.right + 0.5 || title.scrollWidth > title.clientWidth) }; }) : [];
  return { cut, touching, entries: entries.filter((e) => e.cut || (!e.inside && !e.outside)).map((e) => e.text), entriesShown: entries.filter((e) => e.inside).length, chipRows: new Set([...view.querySelectorAll('.tbv-chip')].map((n) => Math.round(rect(n).top))).size };
});

test('名字完整显示: long project names at 1920, 1440, 980 and 700 in both themes; no chip, group name or reminder entry is cut', async () => {
  await launch({ long: true });
  await resize(1920, 1080);
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('.tbv-lane')).toHaveCount(4);
  const names = ['agentdeck', 'hermes-savings-center', 'type4me-windows-installer', '客户门户与数据工作台二期', '旧项目'];
  for (const [w, h] of [[1920, 1080], [1440, 900], [980, 700], [700, 800]]) {
    await resize(w, h);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => applyTheme(t), theme);
      expect((await page.locator('.tbv-chip-name').allTextContents()).sort()).toEqual(['全部', ...names].sort());
      expect((await page.locator('.tbv-lane[data-project] .tbv-lane-name').allTextContents()).sort()).toEqual(names.slice(0, 4).sort());
      const got = await cutNames();
      expect(got.cut, `${w} ${theme}: names cut`).toEqual([]);
      expect(got.touching, `${w} ${theme}: filter bar`).toEqual([]);
      expect(got.entries, `${w} ${theme}: reminder entries shown cut`).toEqual([]);
      expect(got.entriesShown, `${w} ${theme}: at least one reminder entry shows`).toBeGreaterThanOrEqual(1);
      if (w >= 1920) expect(got.chipRows, `${w}: the chips fit one row`).toBe(1);
      expect(await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'); return s.scrollWidth <= s.clientWidth + 1; }), `${w}: no sideways scrolling`).toBe(true);
      await screenshot(`names-${w}-${theme}`);
    }
  }
  expect(errors).toEqual([]);
});

test('a board of 110 cards stays in its columns and keeps its moving parts bounded', async () => {
  await launch({ many: true });
  await resize(1440, 900);
  await page.locator('#taskBoardBtn').click();
  await expect(page.locator('.tbv-lane')).toHaveCount(8);
  expect(seeded.length).toBeGreaterThanOrEqual(110);
  // every group opened, every cell unfolded: the heaviest the board gets
  await page.locator('.tbv-expand-all').click();
  await page.locator('.tbv-head[data-status="done"]').click();
  for (let guard = 0; guard < 40 && await page.locator('.tbv-more:not(.open)').count(); guard++) await page.locator('.tbv-more:not(.open)').first().click();
  await expect(page.locator('.tbv-card')).toHaveCount(seeded.length);
  const heavy = await page.evaluate(() => { const s = document.querySelector('.tbv-scroll');
    const cards = [...document.querySelectorAll('.tbv-card')];
    const bad = [...document.querySelectorAll('.tbv-cell')].flatMap((cell) => { const c = cell.getBoundingClientRect(); const inside = [...cell.querySelectorAll('.tbv-card')].map((n) => n.getBoundingClientRect());
      return inside.filter((r, i) => r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.height > 88 || inside.slice(i + 1).some((o) => r.top < o.bottom - 1 && r.bottom > o.top + 1)); }).length;
    const view = document.getElementById('taskBoardView');
    const endless = document.getAnimations().filter((a) => a.effect && view.contains(a.effect.target) && a.effect.getComputedTiming().iterations === Infinity);
    return { fits: s.scrollWidth <= s.clientWidth + 1, bad, working: cards.filter((n) => n.dataset.run === 'working').length, endless: endless.length, sparks: document.querySelectorAll('.tbv-spark').length,
      blur: [...view.querySelectorAll('*')].filter((n) => getComputedStyle(n).backdropFilter !== 'none').length, props: [...new Set(endless.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)).sort() }; });
  expect(heavy.fits, 'no horizontal scroll').toBe(true);
  expect(heavy.bad, 'cards inside their cells, compact, not overlapping').toBe(0);
  expect(heavy.blur).toBe(0);
  expect(heavy.working).toBeGreaterThanOrEqual(16);
  expect(heavy.sparks).toBeLessThanOrEqual(14); // travelling lights are capped however many lines are live
  // three small layers per working card, one per 需要你 card, the sky's dozen stars, the reminder bar, the sparks
  expect(heavy.endless).toBeLessThanOrEqual(heavy.working * 3 + await page.locator('.tbv-beacon').count() + 12 + 2 + heavy.sparks * 2);
  expect(heavy.props).toEqual(['opacity', 'transform']);
  // redrawing all of it is quick enough to stay out of the way of typing and dragging
  const ms = await page.evaluate(async () => { const t = performance.now(); document.querySelector('.tbv-refresh').click(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
  console.log(`redraw of ${seeded.length} cards: ${Math.round(ms)}ms`);
  await page.locator('.tbv-collapse-all').click();
  await page.locator('.tbv-expand-all').click();
  await page.locator('.tbv-head[data-status="done"]').click();
  await page.evaluate(() => { document.querySelector('.tbv-scroll').scrollTop = 0; });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    // nine projects do not fit one row of chips: they wrap, every one whole, and no reminder entry is shown cut
    const whole = await cutNames();
    expect([whole.cut, whole.touching, whole.entries]).toEqual([[], [], []]);
    expect(whole.chipRows).toBeGreaterThanOrEqual(2);
    await screenshot(`${theme}-1440-many`);
  }
  await page.evaluate(() => { const s = document.querySelector('.tbv-scroll'); s.scrollTop = s.scrollHeight * 0.38; });
  await screenshot('light-1440-many-scrolled');
  await page.evaluate(() => applyTheme('dark'));
  await screenshot('dark-1440-many-scrolled');
  expect(errors).toEqual([]);
});

test('an empty board shows its constellation in both themes', async () => {
  await launch({ empty: true });
  await resize(1440, 900);
  await page.locator('#taskBoardBtn').click();
  const empty = page.locator('.tbv-empty-board');
  await expect(empty).toBeVisible();
  await expect(empty.locator('strong')).toHaveText('还没有任务');
  await expect(empty.locator('.tbv-empty-art')).toBeVisible();
  await expect(page.locator('.tbv-meter')).toBeHidden();
  await expect(page.locator('.tbv-link, .tbv-spark')).toHaveCount(0);
  const box = await empty.locator('.tbv-empty-art').boundingBox(), text = await empty.locator('strong').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(text.y + 1);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => applyTheme(t), theme);
    await screenshot(`${theme}-1440-empty`);
  }
  expect(errors).toEqual([]);
});
