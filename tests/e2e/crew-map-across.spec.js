const closeElectron = require('./fixtures/close-electron');
const emulateScreen = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图 v3, in the shape the user described: 24 sessions in 6 projects, one of them with 15.
// 智能一页 (the default, following the window) puts every project across one row and chooses every
// frame's columns (1 to 4) together so the whole map shows on one page as large as it can; a map too big
// for one page stands in lanes at 100%, what does not fit across under the lane that ends highest, and
// never scrolls sideways. A first drag leaves 智能一页 and can be taken back. A card's line of news is never a
// CLI's update notice or a restart's own note. Real renderer, isolated userData, PTYs running only
// stand-in TUIs. Set AGENTDECK_CREW_MAP_SHOTS to keep PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --captain-statusline`;
const SCREEN = path.join(__dirname, 'fixtures', 'screen-agent.js');
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
// Up to twenty-six stand-in terminals start with each test: on Windows (ConPTY) that alone can take a minute or more.
test.describe.configure({ timeout: 240000 });
let application, page, profile;
const errors = [];

const UPDATE = '  Update available! Run: brew upgrade claude-code';
const RESEND = '重发：Claude 无法续上原对话，这是新会话。\n下面重发卡片任务和最后回执，不要当成新派的另一张卡。';
// [project, title, status, model, provider, receipt / progress, screen rows]
const CREW = [
  ['agentdeck', 'crew-map 横排布局重做', 'working', 'Opus 5.5', 'Claude', null, ['⏺ Update(crew-map-core.js)', '  ⎿  Added 64 lines, removed 41 lines', '⏺ 正在跑 crew-map 端到端测试（3/8 组）']],
  ['agentdeck', '任务看板星图视觉', 'working', 'Opus 5.5', 'Claude', null, ['⏺ 星图卡片深浅两套已截图，正在对比', UPDATE]],
  ['agentdeck', '手机网页端对话区重排', 'asking', 'Sonnet 5.5', 'Claude', '对话区占屏 75% 还是 80%？两种都截了图，等你选', ['⏺ 两种比例的截图都放进报告了']],
  ['agentdeck', '额度面板并入侧栏', 'working', 'Sonnet 5.5', 'Claude', null, ['⏺ 侧栏额度行改好，正在跑单元测试']],
  ['agentdeck', 'Windows 安装包签名', 'failed', 'GPT-6.1 Sol', 'Codex', '签名证书在钥匙串里找不到，需要先导入 AgentDeck Dev 证书再重试。', ['• 签名失败：找不到证书']],
  ['agentdeck', '重启后自动续跑', 'working', 'Opus 5.5', 'Claude', 'RESEND', ['⏺ 读完上次回执，从第 3 步接着做', UPDATE]],
  ['agentdeck', '队长接力交接 v2', 'working', 'Opus 5.5', 'Claude', null, ['⏺ 交接页按看板卡片一卡一条重写中']],
  ['agentdeck', 'CI Verify #81 失败排查', 'working', 'Haiku 5.5', 'Claude', null, ['⏺ 定位到 Windows 换行符导致快照不一致']],
  ['agentdeck', '2.0.2 集成与打包', 'queued', 'Sonnet 5.5', 'Claude', null, []],
  ['agentdeck', 'Bark 提醒去重', 'done', 'Haiku 5.5', 'Claude', '同一轮只推一次，30 秒内不重复响铃；单元测试 12 条全部通过。', ['⏺ 已提交回执']],
  ['agentdeck', '字号缩放快捷键', 'working', 'Haiku 5.5', 'Claude', null, ['⏺ ⌘+ / ⌘− / ⌘0 三个快捷键接好了，正在补测试']],
  ['agentdeck', '侧栏席位显示账号名', 'stopped', 'Sonnet 5.5', 'Claude', null, ['⏺ 改完了']],
  ['agentdeck', '待我处理：两栏 + 自动已读', 'working', 'Opus 5.5', 'Claude', null, ['⏺ 两栏布局完成，正在核对手机端推送只推问题']],
  ['agentdeck', '版本更新页加每日进展', 'working', 'GPT-6.1 Sol', 'Codex', null, ['• 每日进展面板接上 release-notes.json']],
  ['agentdeck', '每日进展卡片接入', 'waiting', '', '', null, []],
  ['秋招', 'Lenovo GFLP 简历改写', 'working', 'Opus 5.5', 'Claude', null, ['⏺ 按 JD 关键词重写项目经历第 2 段']],
  ['秋招', 'JD 抓取：AI PM 岗位 40 条', 'working', 'Haiku 5.5', 'Claude', null, ['⏺ 已抓 26/40 条，正在去重']],
  ['秋招', '面试准备包：STAR 故事库', 'asking', 'Sonnet 5.5', 'Claude', '自我介绍要中英双语各一版吗？', ['⏺ 等队长回答']],
  ['kenke-auto', '第 6 周课程预习简报', 'working', 'Sonnet 5.5', 'Claude', null, ['⏺ 读完 3 篇阅读材料，正在写要点']],
  ['kenke-auto', 'UW Drive 上传失败修复', 'failed', 'Haiku 5.5', 'Claude', 'Profile 7 的扩展没有登录，Drive 返回 403，需要你在浏览器里登一次。', ['⏺ 上传失败']],
  ['fuqing-inventory', '库存成本图横轴改横排', 'working', 'Sonnet 5.5', 'Claude', null, ['⏺ 横轴日期隔 3 天标一个，正在截手机宽度']],
  ['fuqing-inventory', '出库单打印样式', 'done', 'Haiku 5.5', 'Claude', '打印样式改成 A5 两联，深浅色都截图核对过。', ['⏺ 已提交回执']],
  ['daily-progress', '10-08 进展汇总', 'working', 'Haiku 5.5', 'Claude', null, ['⏺ 汇总 6 个项目今天的回执']],
  // nothing on its screen yet: the card shows what the session reported itself
  ['', 'Mac 磁盘清理复核', 'working', 'GPT-6.1 Sol', 'Codex', 'PROGRESS:只读核对 42 项删除清单，已核 30 项', []],
];
const ORDER = ['agentdeck', '秋招', 'kenke-auto', 'fuqing-inventory', 'daily-progress', ''];
const columnsIn = (cards) => cards.filter((c) => c[2] !== 'waiting').length;

let crew = CREW;
async function launch(cards = CREW) {
  crew = cards;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-across-'));
  const now = Date.now();
  const specFile = path.join(profile, 'screens.json'), screens = {};
  const command = `node "${SCREEN}" "${specFile}"`;
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: command, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const columns = [column('cap', '队长', { isMain: true, captainCrew: false, cmd: FAKE })], tasks = [];
  crew.forEach(([project, title, st, model, provider, text, screen], i) => {
    const sentAt = now - (120 - i * 4) * 60_000;
    if (st === 'waiting') { tasks.push({ id: 'task-wait', colId: '', gen: 1, status: 'waiting', title, project, sentAt }); return; }
    const id = 'w' + i;
    columns.push(column(id, title, { project }));
    screens[id] = { title, model, provider, screen };
    const receipt = st === 'done' ? { summary: text, files: [], explicit: true } : st === 'failed' ? { failed: text, files: [], explicit: true }
      : st === 'asking' ? { question: text, files: [] }
      : text === 'RESEND' ? { summary: RESEND, files: [], images: [], failed: '', explicit: true, checkpoint: true, source: 'restart' } : null;
    const progress = typeof text === 'string' && text.startsWith('PROGRESS:') ? { progress: text.slice(9) } : {};
    // (a finished one finished a few minutes ago: one done over 10 minutes ago is archived once its terminal has been
    // quiet a minute, and on a slow machine that comes before every terminal has drawn)
    tasks.push({ id: 'task-' + id, colId: id, gen: 1, status: st, title, project, sentAt, startedAt: sentAt + 30_000, doneAt: now - (st === 'done' ? 3 + i % 3 : 60 - i * 2) * 60_000, turnId: '', receipt, ...progress });
  });
  fs.writeFileSync(specFile, JSON.stringify(screens));
  // the default seat's directory records the account signed in there (a stand-in record, no credentials): cards
  // name the seat by that account, as the sidebar does
  fs.mkdirSync(path.join(profile, 'seats-home'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'seats-home', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'agentdeck@example.test' }, hasCompletedOnboarding: true }));
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, columns,
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks } }));
  await start();
  // (a terminal that has not drawn its agent yet is named with the last rows it shows)
  await expect.poll(() => page.evaluate(() => [...terms].filter(([, t]) => !/Claude Code|OpenAI Codex/.test(t.lastScreen || ''))
    .map(([id, t]) => `${id}: ${(t.lastScreen || '').trim().split('\n').slice(-4).join(' / ')}`)), { timeout: 150000 }).toEqual([]);
}
// AgentDeck on the profile as it stands (launch, or a restart: what the last run saved is what this one reads)
async function start() {
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  // (a busy machine can take well over five seconds to bring the page up)
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart), { timeout: 30000 }).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(columnsIn(crew) + 1);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  // A force-closed Electron's helpers can still be writing into the profile for a few seconds on a busy
  // machine: a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
  application = null;
});

async function size(width, height, theme) {
  // a 2x screen, as on the MacBook these layouts were made on (see fixtures/screen-density)
  await emulateScreen(page, width, height, 2);
  if (theme) await page.evaluate((t) => applyTheme(t), theme);
}
async function open(width, height, theme) {
  await size(width, height, theme);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('.cm-node:not(.kind-captain)')).toHaveCount(crew.length);
}
// a glide has landed: the view's own (cm-smooth) and every frame and card's
const settled = () => expect.poll(() => page.evaluate(() => !document.querySelector('.cm-canvas.cm-smooth') && ![...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].some((n) => n.getAnimations().some((a) => a.effect && Number.isFinite(a.effect.getComputedTiming().iterations) && a.playState === 'running')))).toBe(true);
// Running lights are frozen at a set point of their cycle, so a picture shows them lit the same way every time.
// keep: the picture also stays in the test's own output folder, wherever it runs (智能一页's three situations).
async function shot(name, keep) {
  if (!shots && !keep) return;
  await settled();
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    const at = { 'cm-flow': 0.3, 'cm-trail': 0.3, 'cm-flow-review': 0.3, 'cm-spin': 0.12, 'cm-ping': 0.2, 'cm-beat': 0.3 };
    // a line's light (head and tail) keeps one phase, picked from the line's own path
    const phase = (n) => { let h = 0; for (const c of n.getAttribute('d') || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 4) * 0.17; };
    document.getAnimations().forEach((a) => {
      const target = a.effect && a.effect.target;
      if (!target) return;
      const t = a.effect.getComputedTiming();
      if (t.iterations !== Infinity) { a.finish(); return; }
      if (!document.getElementById('crewMap').contains(target)) return;
      a.pause();
      a.currentTime = ((at[a.animationName] == null ? 0.5 : at[a.animationName]) + (['cm-flow', 'cm-trail'].includes(a.animationName) ? phase(target) : 0)) * t.duration;
    });
  });
  const png = await emulateScreen.capture(page, { scale: 'css' });
  if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), png); }
  if (keep) fs.writeFileSync(test.info().outputPath(name + '.png'), png);
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}
async function dragBy(locator, dx, dy) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.min(40, b.width / 2) + dx / 2, b.y + b.height / 2 + dy / 2, { steps: 4 });
  await page.mouse.move(b.x + Math.min(40, b.width / 2) + dx, b.y + b.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

// Everything measurable about the map as it stands.
const read = () => page.evaluate(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const lay = CrewMap.layout();
  return {
    vp: rect(document.querySelector('.cm-viewport')), view: CrewMap.view(), plan: CrewMap.plan(), pageFits: CrewMap.pageFits(),
    order: CrewMapCore.orderByPlace(lay.groups),
    groups: lay.groups.map((g) => ({ key: g.key, x: g.x, y: g.y, w: g.w, h: g.h })),
    nodes: [...lay.nodes].map(([id, b]) => ({ id, x: b.x, y: b.y, w: b.w, h: b.h, project: b.project })),
    frames: [...document.querySelectorAll('.cm-pane')].map((n) => ({ key: n.dataset.project, ...rect(n) })),
    cards: [...document.querySelectorAll('.cm-node')].map((n) => ({ id: n.dataset.nodeId, ...rect(n) })),
    saved: { positions: config.crewMap.positions, projectPositions: config.crewMap.projectPositions, projectOrder: config.crewMap.projectOrder, plan: config.crewMap.plan },
  };
});
const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
// A map that shows whole fills the window: centred both ways, as large as the page holds it (up to 140% of its
// own 100%), so across or down it reaches its margins (8px, and the map's own 16 around it).
function fillsPage(g, label) {
  const boxes = [...g.frames, ...g.cards];
  const left = Math.min(...boxes.map((b) => b.x)) - g.vp.x, right = g.vp.right - Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.y)) - g.vp.y, bottom = g.vp.bottom - Math.max(...boxes.map((b) => b.bottom));
  expect(Math.abs(left - right), `${label}: centred across (${left.toFixed(1)} / ${right.toFixed(1)})`).toBeLessThanOrEqual(3);
  expect(Math.abs(top - bottom), `${label}: centred down (${top.toFixed(1)} / ${bottom.toFixed(1)})`).toBeLessThanOrEqual(3);
  expect(g.view.scale, `${label}: at most 140%`).toBeLessThanOrEqual(0.7 * 1.4 + 1e-6);
  expect(g.view.scale >= 0.7 * 1.4 - 1e-6 || Math.min(left, top) <= 8 + 16 * g.view.scale + 2, `${label}: fills the window across or down (${left.toFixed(1)} / ${top.toFixed(1)} left)`).toBe(true);
}
// No 派出 line passes through a frame other than the one it feeds.
const linesClear = () => page.evaluate(() => {
  const lay = CrewMap.layout(), routes = CrewMapCore.routes(CrewMap.lastMap(), lay).filter((r) => r.type === 'dispatch');
  const bad = [];
  routes.forEach((r) => r.points.slice(1).forEach(([x2, y2], k) => { const [x1, y1] = r.points[k];
    lay.groups.filter((f) => f.key !== r.project).forEach((f) => { if (Math.max(x1, x2) > f.x + 1 && Math.min(x1, x2) < f.x + f.w - 1 && Math.max(y1, y2) > f.y + 1 && Math.min(y1, y2) < f.y + f.h - 1) bad.push(`${r.to} crosses ${f.key}`); }); }));
  return bad;
});

test('24 sessions in 6 projects: 智能一页 puts them on one page where it can, agentdeck three wide; in lanes at 100% where it cannot; three widths, both themes', async () => {
  await launch();
  for (const [w, h] of [[1920, 1080], [1440, 900], [1024, 768]]) for (const theme of ['dark', 'light']) {
    await open(w, h, theme); await settled();
    const g = await read();
    // 1920: one page, shown as large as it holds (a little under 100%); smaller windows cannot hold it on one page readably.
    // In lanes it fills the window when the whole of it shows there (1440), else it stands at 100% from the top (1024).
    expect(g.plan.page, `${w}: on one page`).toBe(w === 1920);
    if (g.plan.page) { expect(g.view.scale).toBeLessThan(0.7); expect(g.view.scale).toBeGreaterThanOrEqual(0.7 * 0.8 - 1e-6); }
    if (g.pageFits) fillsPage(g, `${w}`);
    else expect(g.view.scale, `${w}: in lanes at the map's own 100%`).toBeCloseTo(0.7, 5);
    // fifteen cards three wide, five rows (two wide would leave it twice as long as the rest); the small ones one wide
    expect(g.plan.caps).toEqual({ agentdeck: 3, 秋招: 1, 'kenke-auto': 1, 'fuqing-inventory': 1, 'daily-progress': 1, '': 1 });
    const wide = (key) => new Set(g.nodes.filter((n) => n.project === key).map((n) => n.x)).size;
    expect(ORDER.map(wide), `${w}: cards abreast in each frame`).toEqual([3, 1, 1, 1, 1, 1]);
    expect(new Set(g.nodes.filter((n) => n.project === 'agentdeck').map((n) => n.y)).size, 'fifteen cards: five rows').toBe(5);
    // read like text, the projects stand in their own order; the first ones across the top on one line
    expect(g.order, `${w}: in order, from the left`).toEqual(ORDER);
    const tops = g.plan.lanes.map((lane) => g.groups.find((f) => f.key === lane[0]).y);
    expect(new Set(tops).size, `${w}: the first row on one line`).toBe(1);
    expect(g.plan.lanes.map((lane) => lane[0]), `${w}: as many abreast as the window holds, in order`).toEqual(ORDER.slice(0, g.plan.lanes.length));
    // on one page every project stands in a lane of its own, all on one line
    if (g.plan.page) expect(g.plan.lanes).toEqual(ORDER.map((key) => [key]));
    // no frame or card on another, every card inside its own frame, nothing beyond the sides, no line through another frame
    g.groups.forEach((a, i) => g.groups.slice(i + 1).forEach((b) => expect(apart(a, b), `${a.key}/${b.key}`).toBe(true)));
    g.nodes.forEach((a, i) => g.nodes.slice(i + 1).forEach((b) => expect(apart(a, b), `${a.id}/${b.id}`).toBe(true)));
    for (const n of g.nodes) { const f = g.groups.find((x) => x.key === n.project); expect(n.x >= f.x && n.x + n.w <= f.x + f.w && n.y >= f.y + 60 && n.y + n.h <= f.y + f.h, `${n.id} inside ${f.key}`).toBe(true); }
    for (const f of g.frames) { expect(f.x, `${w}: ${f.key} left`).toBeGreaterThanOrEqual(g.vp.x + 8 - 0.5); expect(f.right, `${w}: ${f.key} right`).toBeLessThanOrEqual(g.vp.right - 8 + 0.5); }
    expect(await linesClear()).toEqual([]);
    // 1920x1080 holds all of it: every card whole on one page
    if (g.plan.page) {
      expect(g.pageFits).toBe(true);
      for (const c of g.cards) { expect(c.y, c.id).toBeGreaterThanOrEqual(g.vp.y); expect(c.bottom, c.id).toBeLessThanOrEqual(g.vp.bottom); }
    }
    await shot(`across-${w}x${h}-${theme}`);
  }
  // one row of all six where the window holds it (the sidebar folded away)
  await page.locator('#navCollapseBtn').click();
  await open(1920, 1080, 'dark'); await settled();
  const g = await read();
  expect(g.plan.lanes).toEqual(ORDER.map((key) => [key]));
  await shot('across-1920x1080-dark-sidebar-folded');
  await page.locator('#navExpandBtn').click();
  expect(errors).toEqual([]);
});

// 智能一页's choice in three situations, each a picture: the user's 2.0.0 map on a 14-inch MacBook,
// six small projects, one project of twenty beside small ones. (wraps: one row would have to shrink to
// about 80%, a thin strip across the page; in lanes, read like text, the whole map shows a fifth larger or more.)
const sessionsOf = (spec) => Object.entries(spec).flatMap(([project, n]) => Array.from({ length: n }, (_, i) => [project, `${project} 第 ${i + 1} 件活`, 'working', 'Opus 5.5', 'Claude', null, [`⏺ 第 ${i + 1} 件活做到一半`]]));
for (const [name, spec, [w, h], caps, wraps] of [
  ['the user\'s 2.0.0 map (11 / 3 / 1) on a 14-inch MacBook: agentdeck three wide', { agentdeck: 11, 秋招: 3, skills: 1 }, [1512, 982], { agentdeck: 3, 秋招: 1, skills: 1 }],
  ['six projects of one or two cards: every frame one wide, wrapped like lines of text to fill the page', { alpha: 2, beta: 1, gamma: 2, delta: 1, epsilon: 2, zeta: 1 }, [1440, 900], { alpha: 1, beta: 1, gamma: 1, delta: 1, epsilon: 1, zeta: 1 }, true],
  ['one project of twenty beside three small ones: it goes four wide', { big: 20, s1: 2, s2: 1, s3: 3 }, [1920, 1080], { big: 4, s1: 1, s2: 1, s3: 1 }],
]) test(`智能一页 on a real page: ${name}`, async () => {
  await launch(sessionsOf(spec));
  await open(w, h, 'dark'); await settled();
  const g = await read();
  expect(g.plan.page).toBe(!wraps);
  expect(g.pageFits).toBe(true);
  expect(g.plan.caps).toEqual(caps);
  if (!wraps) expect(g.plan.lanes).toEqual(Object.keys(spec).map((key) => [key]));
  else {
    // as many across as the window holds, the rest under them, read in order like text; at full size or more
    expect(g.plan.lanes.length).toBeLessThan(Object.keys(spec).length);
    expect(g.order).toEqual(Object.keys(spec));
    expect(g.view.scale, 'wrapped, the map shows at 100% or more').toBeGreaterThanOrEqual(0.7 - 1e-6);
  }
  // the whole map on the page: every card whole inside the viewport, nothing past its sides, no line through another frame
  for (const c of g.cards) { expect(c.y, c.id).toBeGreaterThanOrEqual(g.vp.y - 0.5); expect(c.bottom, c.id).toBeLessThanOrEqual(g.vp.bottom + 0.5); expect(c.x, c.id).toBeGreaterThanOrEqual(g.vp.x - 0.5); expect(c.right, c.id).toBeLessThanOrEqual(g.vp.right + 0.5); }
  // as large as the page holds it, centred: the user's 2.0.0 map grows past 100% to fill the window across
  fillsPage(g, name);
  expect(g.view.scale).toBeGreaterThanOrEqual(0.7 * 0.8 - 1e-6);
  if (w === 1512) expect(g.view.scale, 'grown past 100%').toBeGreaterThan(0.7 * 1.04);
  expect(await linesClear()).toEqual([]);
  await shot(`page-${Object.values(spec).join('-')}-${w}x${h}-dark`, true);
  // the same map in light
  await page.evaluate(() => applyTheme('light')); await settled();
  expect((await read()).plan.caps).toEqual(caps);
  await shot(`page-${Object.values(spec).join('-')}-${w}x${h}-light`, true);
  expect(errors).toEqual([]);
});

test('a card reads in three layers and its line is news: never a CLI update notice or a restart\'s own note', async () => {
  await launch();
  await open(1440, 900, 'dark'); await settled();
  const cards = await page.evaluate(() => [...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => {
    const line = n.querySelector('.cm-meta > .cm-line'), title = n.querySelector('.cm-title'), st = n.querySelector('.cm-top .cm-status-text'), cs = getComputedStyle(line);
    return { id: n.dataset.nodeId, status: st.textContent, title: title.textContent, titleLines: Math.round(title.offsetHeight / parseFloat(getComputedStyle(title).lineHeight)),
      line: line.textContent, tip: line.title, kind: line.className, oneLine: cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis' && line.offsetHeight === parseFloat(cs.lineHeight),
      more: (n.querySelector('.cm-more') || {}).ariaLabel || '', live: !!n.querySelector('.cm-live') };
  }));
  const card = (id) => cards.find((c) => c.id === id);
  for (const c of cards) {
    expect(c.line + c.tip, c.id).not.toMatch(/Update available|brew upgrade|重发：|无法续上原对话|AgentDeck 约定|AGENTDECK_BOARD_CLI/);
    expect(c.oneLine, `${c.id}: one line of news`).toBe(true);
    expect(c.titleLines, `${c.id}: the title in two lines`).toBe(2);
    expect(c.status, `${c.id}: a status`).toBeTruthy();
    expect(c.live, `${c.id}: no second line of terminal text`).toBe(false);
    if (!c.id.startsWith('wait:')) expect(c.more, c.id).toMatch(/^查看详情：/);
  }
  // the screen ending in an update notice shows the progress above it; the resent session what its terminal shows, and nothing handed back
  expect(card('w1').line).toBe('星图卡片深浅两套已截图，正在对比');
  expect(card('w5').line).toBe('读完上次回执，从第 3 步接着做');
  expect(card('w0').line).toBe('正在跑 crew-map 端到端测试（3/8 组）');
  await expect(page.locator('.cm-node[data-node-id="w5"] .cm-returned')).toHaveCount(0);
  // a question and a failure read as such, whole in the tooltip
  expect(card('w2')).toMatchObject({ line: '提问：对话区占屏 75% 还是 80%？两种都截了图，等你选', kind: 'cm-line k-question' });
  expect(card('w4').kind).toBe('cm-line k-failed');
  expect(card('w4').tip).toBe('失败：签名证书在钥匙串里找不到，需要先导入 AgentDeck Dev 证书再重试。');
  await expect(page.locator('.cm-node[data-node-id="w4"] .cm-view')).toHaveText('查看');
  // nothing on its screen yet: what the session reported; a newer report shows on the next tick, in place
  expect(card('w23').line).toBe('只读核对 42 项删除清单，已核 30 项');
  // The line updates in place, not rebuilt, and news replacing news rises into place (a short fade and lift,
  // opacity and transform only). (A status change elsewhere rebuilds the whole map on the same tick, and then
  // there is nothing to rise: the update is tried again, after the map has taken in what changed.)
  let round = 0;
  await expect.poll(() => page.evaluate((n) => {
    CrewMap.refresh();
    const line = document.querySelector('.cm-node[data-node-id="w23"] .cm-meta > .cm-line');
    MainSession.state().tasks.find((t) => t.colId === 'w23').progress = '已核完 42 项，没有误删' + (n ? `（${n}）` : '');
    CrewMap.refresh();
    return line.isConnected ? line.getAnimations().map((a) => [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => ['opacity', 'transform'].includes(k)).sort()) : 'rebuilt';
  }, round++)).toEqual([['opacity', 'transform']]);
  await expect(page.locator('.cm-node[data-node-id="w23"] .cm-meta > .cm-line')).toHaveText(/^已核完 42 项，没有误删/);
  // the account signed in behind the seat is a small text tag on the card: the part of its address before the @,
  // as the sidebar names it (never a fixed seat name or flag), named in full on hover; it gives way first: a long
  // account name is cut, from the left, never the status or the model
  await expect.poll(() => page.evaluate(() => [...new Set([...document.querySelectorAll('.cm-node:not(.kind-captain) .agent-seat-label')].map((n) => n.textContent.trim()))]), { timeout: 15000 }).toEqual(['agentdeck']);
  const seats = await page.evaluate(() => [...document.querySelectorAll('.cm-node:not(.kind-captain) .agent-seat-label')].map((n) => [n.textContent.trim(), n.getAttribute('aria-label') || '', getComputedStyle(n).display, n.scrollWidth <= n.clientWidth || getComputedStyle(n).textOverflow === 'ellipsis', n.getBoundingClientRect().width]));
  expect(seats.length).toBeGreaterThan(0);
  for (const [text, label, display, readable, width] of seats) {
    expect(text).not.toMatch(/\p{Regional_Indicator}|\p{Extended_Pictographic}/u);
    expect(label).toMatch(/^当前账号：agentdeck@example\.test · /); expect(display).not.toBe('none');
    // whole, or (where the row is tight) cut with an ellipsis, a few letters at least, the whole address on hover
    expect(readable, `${text}: whole or cut with an ellipsis`).toBe(true); expect(width, `${text}: a few letters at least`).toBeGreaterThanOrEqual(28);
  }
  const long = await page.evaluate(() => {
    const n = document.querySelector('.cm-node[data-node-id="w2"]'), seat = n.querySelector('.agent-seat-label'), st = n.querySelector('.cm-status'), model = n.querySelector('.agent-model-label'), more = n.querySelector('.cm-more');
    (seat.querySelector('bdi') || seat).textContent = 'hjinhao066us-research-team-account';
    const r = (x) => x.getBoundingClientRect();
    return { seatCut: seat.scrollWidth > seat.clientWidth, ellipsis: getComputedStyle(seat).textOverflow, statusCut: st.scrollWidth > st.clientWidth, modelCut: model.scrollWidth > model.clientWidth,
      inside: r(seat).left >= r(st).right && r(seat).right <= r(more).left + 0.5, letters: r(seat).width >= 28, named: /^当前账号：/.test(seat.title) };
  });
  expect(long).toEqual({ seatCut: true, ellipsis: 'ellipsis', statusCut: false, modelCut: false, inside: true, letters: true, named: true });
  // (cut from the left, as everywhere an account is named: the end that tells hjinhao066us from hjinhao066 stays)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-node[data-node-id="w2"] .agent-seat-label')).direction)).toBe('rtl');
  // 队长's tally and the bar of the whole crew under it
  const fleet = await page.evaluate(() => [...document.querySelectorAll('.cm-node.kind-captain .cm-fleet i')].map((i) => [i.className, Number(i.style.flexGrow)]));
  expect(fleet).toEqual([['st-working', 15], ['st-input', 2], ['st-queued', 2], ['st-failed', 2], ['st-stopped', 1], ['st-done', 2]]);
  await expect(page.locator('.cm-node.kind-captain .cm-line')).toHaveText('15 干活中 · 2 待补充 · 2 排队 · 2 失败 · 2 已完成 · 1 已停下');
  // the project's colour runs through its line and stops; the frame's title strip has two lines, nothing cut
  const heads = await page.evaluate(() => [...document.querySelectorAll('.cm-project-head')].map((h) => { const name = h.querySelector('.cm-project-name').getBoundingClientRect(), tally = h.querySelector('.cm-project-summary').getBoundingClientRect(), toggle = h.querySelector('.cm-project-toggle');
    return { key: h.parentElement.dataset.project, below: tally.top >= name.bottom - 0.5, nameCut: h.querySelector('.cm-project-name').scrollWidth > h.querySelector('.cm-project-name').clientWidth, tallyCut: h.querySelector('.cm-project-summary').scrollWidth > h.querySelector('.cm-project-summary').clientWidth + 1, toggle: [toggle.ariaLabel, toggle.title, toggle.offsetWidth, toggle.offsetHeight] }; }));
  for (const h of heads) {
    expect(h.below && !h.nameCut && !h.tallyCut, JSON.stringify(h)).toBe(true);
    expect(h.toggle[0]).toMatch(/^折叠项目：/); expect(h.toggle[1]).toBe(h.toggle[0]); expect(Math.min(h.toggle[2], h.toggle[3])).toBeGreaterThanOrEqual(32);
  }
  expect(errors).toEqual([]);
});

test('智能一页 is the default and follows the window; a first drag leaves it, and 撤销 or 智能一页 brings it back', async () => {
  await launch();
  await open(1920, 1080, 'dark'); await settled();
  const fit = page.locator('[data-cm="fit"]'), undo = page.locator('[data-cm="undo"]');
  await expect(fit).toHaveAttribute('data-state', 'auto');
  await expect(fit).toHaveAttribute('aria-label', /^智能一页：已开启/);
  // the dot grid under the map is the map's own: it scales and moves with the view
  const grid = () => page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.cm-viewport')), v = CrewMap.view(); return [parseFloat(cs.backgroundSize) / v.scale, parseFloat(cs.backgroundPositionX) - v.x, parseFloat(cs.backgroundPositionY) - v.y].map((n) => Math.round(n * 100) / 100 || 0); });
  expect(await grid()).toEqual([28, 0, 0]);
  await page.locator('[data-cm="in"]').click(); await settled();
  expect(await grid()).toEqual([28, 0, 0]);
  await page.locator('[data-cm="reset"]').click(); await settled();
  expect(await fit.evaluate((n) => [n.title === n.getAttribute('aria-label'), !!n.querySelector('svg'), n.textContent.trim()])).toEqual([true, true, '']);
  const wide = await read();
  // the window narrows: the map arranges itself again (in lanes), and fills this window, still on its own
  // (the window's new size reaches the map on its next frame, which a busy machine draws late)
  await size(1440, 900);
  await expect.poll(async () => (await read()).plan, { timeout: 15000 }).not.toEqual(wide.plan);
  await settled();
  let g = await read();
  if (g.pageFits) fillsPage(g, '1440'); else expect(g.view.scale).toBeCloseTo(0.7, 5);
  await expect(fit).toHaveAttribute('data-state', 'auto');
  // a frame dragged by hand: the map is the user's now, and that first move can be taken back
  await dragBy(page.locator('.cm-project[data-project="秋招"] .cm-project-name'), 140, 90);
  await expect(fit).toHaveAttribute('data-state', 'manual');
  await expect(fit).toHaveAttribute('aria-label', /^智能一页：回到自动排法/);
  await expect(undo).toBeVisible();
  await expect(undo).toHaveAttribute('aria-label', '撤销：回到智能一页，放弃刚才的拖动');
  await expect(page.locator('.cm-hint')).toContainText('智能一页');
  await shot('across-dragged-1440-dark');
  const mine = await read();
  expect(mine.saved.projectPositions['秋招']).toBeTruthy();
  // the window changes again: the hand-placed map keeps its ground
  await size(1280, 800); await settled();
  expect((await read()).groups).toEqual(mine.groups);
  // 撤销: back to the map's own arrangement, for this window
  await undo.click(); await settled();
  g = await read();
  expect(g.saved).toEqual({ positions: {}, projectPositions: {}, projectOrder: [], plan: null });
  expect(g.order).toEqual(ORDER);
  await expect(fit).toHaveAttribute('data-state', 'auto');
  await expect(undo).toBeHidden();
  // a second move by hand, then 智能一页: the same way back, and that too can be undone
  await dragBy(page.locator('.cm-project[data-project="kenke-auto"] .cm-project-name'), -90, 120);
  await expect(fit).toHaveAttribute('data-state', 'manual');
  const placed = await read();
  await fit.click(); await settled();
  await expect(fit).toHaveAttribute('data-state', 'auto');
  expect((await read()).saved.projectPositions).toEqual({});
  await expect(undo).toHaveAttribute('aria-label', '撤销：回到整理前的位置和缩放');
  await undo.click(); await settled();
  expect((await read()).groups).toEqual(placed.groups);
  await expect(fit).toHaveAttribute('data-state', 'manual');
  // a drag made on a hand-placed map is not offered back: 智能一页 is the way home
  await dragBy(page.locator('.cm-project[data-project="daily-progress"] .cm-project-name'), 40, 30);
  await expect(undo).toBeHidden();
  await fit.click(); await settled();
  await expect(fit).toHaveAttribute('data-state', 'auto');
  expect(errors).toEqual([]);
});

// The user, 2026-10-09 17:16: 「我自己可以随意调这个百分比；右边那个智能一页按钮，在我任意调好的百分比下都能保证智能一页。
// 现在怎么每次按它都跳回 100%？」 Their map that day (agentdeck 17, health 5, 秋招 3, hermes 2) in a 1366x900 window: 2.0.3's
// 智能一页 put it in two lanes at 100%, too tall for the page, whatever zoom they had set. The zoom they set stays now:
// 智能一页 arranges the frames' columns and lanes for it, and a restart keeps it. (The checks are soft, so a run on code
// without this keeps going and leaves every picture: the "before" set.)
test('智能一页 keeps the zoom the user set (80%, 100%, 125%): arranged for it, the whole map on one page where it can, the most compact where it cannot, and kept after a restart', async () => {
  test.setTimeout(480000);
  const USER = { agentdeck: 17, health: 5, 秋招: 3, hermes: 2 };
  await launch(sessionsOf(USER));
  await open(1366, 900, 'dark'); await settled();
  // (the page changes with a restart: every lookup goes to the page of the moment)
  const label = () => page.locator('[data-cm="reset"]');
  const hint = () => page.evaluate(() => { const h = document.querySelector('.cm-hint'); return h.hidden ? '' : h.textContent; });
  const summary = [];
  // the map as it stands and what the line at the bottom says, read at once (that line goes after six seconds)
  const note = async (pct, name) => { const said = await hint(), g = await read(); summary.push({ pct, name, label: await label().textContent(), scale: g.view.scale, pageFits: g.pageFits, plan: g.plan, hint: said, saved: await page.evaluate(() => config.crewMap.zoom ?? null) }); return { ...g, said }; };
  // untouched, as before: no zoom set, 智能一页 picks one (this map does not fit this page at 80% or more: lanes at 100%, scrolled)
  let g = await note(null, 'auto');
  expect.soft(g.view.scale, 'no zoom set: 智能一页 picks it (lanes at 100%)').toBeCloseTo(0.7, 5);
  await shot('user-zoom-auto-1366x900-dark', true);
  const zoomTo = async (pct) => {
    await label().click();
    if (pct === 80) { await page.locator('[data-cm="out"]').click(); await page.locator('[data-cm="out"]').click(); }
    // (125% is no step of the buttons: a pinch, as a trackpad sends it, ctrl+wheel by exactly that much)
    if (pct === 125) await page.evaluate(() => { const vp = document.querySelector('.cm-viewport'), r = vp.getBoundingClientRect(); vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -Math.log(1.25) / 0.0022, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); });
    await expect(label()).toHaveText(`${pct}%`);
  };
  for (const pct of [80, 100, 125]) {
    await zoomTo(pct);
    await page.locator('[data-cm="fit"]').click(); await settled();
    g = await note(pct, `${pct}%`);
    // the zoom stays the user's, on screen and saved
    await expect.soft(label(), `智能一页 at ${pct}%: the zoom stays`).toHaveText(`${pct}%`);
    expect.soft(g.view.scale, `智能一页 at ${pct}%: shown at ${pct}%`).toBeCloseTo(0.7 * pct / 100, 5);
    expect.soft(await page.evaluate(() => config.crewMap.zoom), `${pct}%: saved`).toBeCloseTo(0.7 * pct / 100, 5);
    // never past the window's sides, 队长 on the page
    for (const f of g.frames) { expect.soft(f.x, `${pct}%: ${f.key} left`).toBeGreaterThanOrEqual(g.vp.x + 8 - 0.5); expect.soft(f.right, `${pct}%: ${f.key} right`).toBeLessThanOrEqual(g.vp.right - 8 + 0.5); }
    expect.soft(g.cards.find((c) => c.id === 'cap').y, `${pct}%: 队长 on the page`).toBeGreaterThanOrEqual(g.vp.y + 8 - 0.5);
    // 80%: rearranged, the whole map comes onto this page (2.0.3: two lanes at 100%, scrolled)
    if (pct === 80) {
      expect.soft(g.pageFits, '80%: the whole map on one page').toBe(true);
      for (const c of g.cards) { expect.soft(c.y, `80%: ${c.id} top`).toBeGreaterThanOrEqual(g.vp.y - 0.5); expect.soft(c.bottom, `80%: ${c.id} bottom`).toBeLessThanOrEqual(g.vp.bottom + 0.5); }
    }
    // where it cannot be one page at that zoom, it says so in plain words, and the rest is down the page
    if (!g.pageFits) expect.soft(g.said, `${pct}%: what the hint says`).toBe(`按你设的 ${pct}% 一页放不下：已排到最紧凑，其余部分向下滚动查看`);
    await shot(`user-zoom-${pct}-1366x900-dark`, true);
  }
  // A restart: the zoom is read back from the saved settings (the file on disk), and the map is arranged for it again
  await expect.poll(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).crewMap.zoom ?? null; } catch { return null; } }, { timeout: 15000, message: 'the zoom is in the settings on disk' }).toBeCloseTo(0.875, 5);
  await closeElectron(application);
  await start();
  await open(1366, 900, 'dark'); await settled();
  g = await note(125, 'after restart');
  await expect.soft(label(), 'after a restart: the zoom the user set').toHaveText('125%');
  expect.soft(g.view.scale).toBeCloseTo(0.875, 5);
  for (const f of g.frames) expect.soft(f.right, `after restart: ${f.key} right`).toBeLessThanOrEqual(g.vp.right - 8 + 0.5);
  await shot('user-zoom-125-1366x900-dark-after-restart', true);
  fs.writeFileSync(test.info().outputPath('user-zoom.json'), JSON.stringify(summary, null, 2));
  expect(errors).toEqual([]);
});
