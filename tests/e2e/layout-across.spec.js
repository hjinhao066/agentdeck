const closeElectron = require('./fixtures/close-electron');
const emulateScreen = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图 and 任务看板 across the window: project frames left to right, as many abreast
// as the window holds, the rest under the lane that ends highest, the map's own 100%, and the board's project chips over the full
// width. Real renderer, isolated userData, PTYs running only the stand-in TUI.
// Set AGENTDECK_LAYOUT_SHOTS to keep PNGs at three window widths.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_LAYOUT_SHOTS;
let application, page, profile;
const errors = [];

const WIDTHS = [['wide', 1920, 1080], ['normal', 1440, 900], ['narrow', 980, 760]];
// [project, sessions]: a session is a title, or [title, status], or [title, status, index of the session it reviews].
const ONE = [['agentdeck', ['桌面对话页留白调整', '任务看板星图视觉', ['额度面板并入侧栏', 'queued']]]];
const FOUR = [
  ['agentdeck', ['桌面对话页留白调整', '任务看板星图视觉', '额度面板并入侧栏', ['审查：任务看板星图视觉', 'done', 1]]],
  ['kenke-auto', ['复核：学生能否用 Canvas 令牌', '听课全自动：从 Canvas 取材料', ['审查：听课全自动', 'done', 1]]],
  ['web-research', ['浏览器自动化改成后台运行', ['网页端 ChatGPT 真机实测', 'failed']]],
  ['mac-ops', ['Mac 磁盘清理：查占用、清安全项']],
];
const NINE = [
  ['agentdeck', ['桌面对话页留白调整', ['返工：后台等待误报修复', 'queued']]],
  ['kenke-auto', ['复核：学生能否用 Canvas 令牌', '听课全自动：从 Canvas 取材料', ['审查：听课全自动', 'done', 1]]],
  ['web-research', ['Muse 跑 Gemini Deep Research', '浏览器自动化改成后台运行', '网页端 ChatGPT 真机实测', ['审查：网页端 ChatGPT', 'failed', 2]]],
  ['mac-ops', ['Mac 磁盘清理：查占用、清安全项']],
  ['type4me', ['历史页每日图表设计与实现', ['审查：每日图表', 'done', 0]]],
  ['daily-progress', ['每日进展统计：0 点自动汇总']],
  ['hermes-savings-v2', ['省钱中心雷达任务注册', '订阅到期提醒']],
  ['xiaohongshu', ['选题库去重']],
  ['memory-unified', ['共享记忆索引瘦身']],
];
const RECEIPT = { done: '已完成实现、单元测试和端到端验证，结果已交回。', failed: '测试环境缺少数据访问权限，需要队长处理后再继续。' };

// 任务看板: few projects, and as many as the user's own board holds.
const FEW = ['agentdeck', 'hermes-savings', 'type4me-windows', '客户门户', '旧项目'];
const MANY = ['agentdeck', 'ai-debate', 'ai-unified-map', 'daily-progress', 'daily-reflection', 'health', 'hermes', 'hermes-hub', 'hermes-music', 'hermes-quality', 'hermes-savings-v2', 'hermes-tv', 'imt540',
  'jarvis-todo', 'kenke-auto', 'mac-ops', 'mac-wireguard', 'memory-unified', 'opencli', 'type4me', 'web-research', 'windows-ops', 'xiaohongshu', 'yitiaolong', '秋招'];
function seedBoard(dir, names) {
  const now = Date.now();
  const at = (min) => new Date(now - min * 60_000).toISOString();
  fs.mkdirSync(dir, { recursive: true });
  names.forEach((project, p) => {
    // every third project is busy, every fifth waits on the user, every fourth is finished
    const statuses = p % 4 === 3 ? ['done', 'done'] : ['todo', 'todo', ...(p % 3 === 0 ? ['doing', 'doing'] : []), ...(p % 5 === 2 ? ['needs_user'] : []), 'review', 'done'];
    const cards = statuses.map((status, i) => ({ id: `c${p}-${i}`, project, title: `${project} 的任务 ${i + 1}`, detail: '', status, flag: null, order: i, depends_on: [], assignee: null, session_id: null,
      latest_receipt: '', verify: false, rework_count: 0, created: at(900), updated: at(10 + i * 7 + p), archived: false, ...(status === 'needs_user' ? { user_question: '这件事要不要现在做？' } : {}) }));
    fs.writeFileSync(path.join(dir, project + '.json'), JSON.stringify({ version: 1, project, cards }, null, 2));
  });
}

async function launch(crew, boardProjects) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-layout-'));
  if (boardProjects) seedBoard(path.join(profile, 'tasks'), boardProjects);
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = [], states = [];
  crew.forEach(([project, sessions], p) => sessions.forEach((s, i) => {
    const [title, status, reviews] = Array.isArray(s) ? s : [s, 'working'];
    workers.push(column(`p${p}s${i}`, title, { project, ...(reviews == null ? {} : { reviews: [`p${p}s${reviews}`] }) }));
    states.push(status || 'working');
  }));
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, taskBoard: { dispatcher: 'captain' },
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      // (a finished one finished a few minutes ago: one done over 10 minutes ago is archived once its terminal has been
      // quiet a minute, and on a slow machine that comes before every terminal has drawn)
      tasks: workers.map((c, i) => { const st = states[i]; return { id: 'task-' + c.id, colId: c.id, gen: 1, status: st, sentAt: now - (90 - i * 3) * 60_000, doneAt: now - (st === 'done' ? 3 : 40 - i) * 60_000, turnId: '',
        receipt: st === 'done' ? { summary: RECEIPT.done, files: [], explicit: true } : st === 'failed' ? { failed: RECEIPT.failed, files: [], explicit: true } : null }; }) },
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
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart), { timeout: 30000 }).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(workers.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 40000 }).toBe(workers.length + 1);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  // A force-closed Electron's helpers can still hold files in the profile for a few seconds (EPERM on Windows):
  // a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
  application = null;
});

async function size(width, height) {
  // a 2x screen, as on the MacBook these layouts were made on (see fixtures/screen-density)
  await emulateScreen(page, width, height, 2);
}
async function openMap(width, height) {
  await size(width, height);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
}
// a glide has landed: the view's own (cm-smooth) and every frame and card's
const settled = () => expect.poll(() => page.evaluate(() => !document.querySelector('.cm-canvas.cm-smooth') && ![...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].some((n) => n.getAnimations().some((a) => a.effect && Number.isFinite(a.effect.getComputedTiming().iterations) && a.playState === 'running')))).toBe(true);
// Running lights are frozen at a set point of their cycle, so a picture shows them lit the same way every time.
async function shot(name) {
  if (!shots) return;
  await settled();
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(Math.round((await page.evaluate(() => innerWidth)) * 0.48), 4);
  await page.evaluate(() => {
    const at = { 'cm-flow': 0.3, 'cm-trail': 0.3, 'cm-flow-review': 0.3, 'cm-spin': 0.12, 'cm-ping': 0.2, 'cm-beat': 0.3, 'sky-twinkle': 0.6, 'tbv-breathe': 0.5, 'tbv-flow': 0.42, 'tbv-ping': 0.2 };
    // a line's light (head and tail) keeps one phase, picked from the line's own path
    const phase = (n) => { let h = 0; for (const c of n.getAttribute('d') || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 4) * 0.17; };
    document.getAnimations().forEach((a) => {
      const target = a.effect && a.effect.target;
      if (!target) return;
      const t = a.effect.getComputedTiming();
      // anything that ends is shown ended, wherever it is
      if (t.iterations !== Infinity) { a.finish(); return; }
      if (!target.closest('#crewMap, #taskBoardView')) return;
      a.pause();
      a.currentTime = ((at[a.animationName] == null ? 0.5 : at[a.animationName]) + (['cm-flow', 'cm-trail'].includes(a.animationName) ? phase(target) : 0)) * t.duration;
    });
  });
  await emulateScreen.capture(page, { path: path.join(shots, name + '.png'), scale: 'css' });
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}

// The map as it stands: the plan, the frames and 队长 on screen, the viewport, the view.
const readMap = () => page.evaluate(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const lay = CrewMap.layout();
  return { vp: rect(document.querySelector('.cm-viewport')), view: CrewMap.view(), plan: CrewMap.plan(), pageFits: CrewMap.pageFits(), label: document.querySelector('[data-cm="reset"]').textContent,
    groups: lay.groups.map((g) => ({ key: g.key, x: g.x, y: g.y, w: g.w, h: g.h, lane: g.lane })), order: CrewMapCore.orderByPlace(lay.groups),
    frames: [...document.querySelectorAll('.cm-pane')].map((n) => ({ key: n.dataset.project, ...rect(n) })), captain: rect(document.querySelector('.cm-node.kind-captain')),
    cardPx: document.querySelector('.cm-node:not(.kind-captain)').getBoundingClientRect().width };
});
// lanes at 1920, 1440 and 980 wide windows (智能一页: one page where it fits, else lanes at 100%; as many lanes as show
// the map largest, not simply as many as the width holds: nine projects at 1920 stand in five, at 135%)
const LANES = { 1: [1, 1, 1], 4: [4, 4, 2], 9: [5, 4, 2] };

for (const [label, crew] of [['1', ONE], ['4', FOUR], ['9', NINE]]) test(`架构图: ${label} 个项目 stand across the window, as many abreast as show the map largest, the rest under them; filling it when they show whole`, async () => {
  await launch(crew);
  const keys = crew.map(([project]) => project);
  for (const [i, [name, w, h]] of WIDTHS.entries()) {
    await openMap(w, h);
    await settled();
    // opening the map is enough: no click on 智能一页 is needed to get this arrangement. A map that shows whole
    // arrives filling the window (up to 140% of its own 100%); one taller than the window at 100%, 0.7 of the
    // drawn size, where a card is 196px wide on screen (what 70% used to show)
    const g = await readMap();
    if (g.pageFits) { expect(g.view.scale).toBeGreaterThanOrEqual(0.7 * 0.8 - 1e-6); expect(g.view.scale).toBeLessThanOrEqual(0.7 * 1.4 + 1e-6); }
    else expect(g.view.scale, `${name}: taller than the window, the map arrives at its own 100%, 0.7 of the drawn size`).toBeCloseTo(0.7, 5);
    expect(g.label).toBe(`${Math.round(g.view.scale / 0.7 * 100)}%`);
    expect(g.cardPx, `${name}: a card is 280 map px wide (196px at 100%)`).toBeCloseTo(280 * g.view.scale, 0);
    expect(g.plan.lanes.length, `${name}: lanes across`).toBe(LANES[label][i]);
    expect(g.order, `${name}: projects fill the window from the left, in order, read like text`).toEqual(keys);
    // 智能一页's columns: a project alone with three cards goes two wide (two rows, not three); among several, small frames stay one wide
    expect(g.plan.caps, `${name}: columns`).toEqual(Object.fromEntries(keys.map((k) => [k, label === '1' ? 2 : 1])));
    // the first row stands on one line; every later frame is close under the one above it in its lane
    const lanes = g.plan.lanes.map((lane) => lane.map((key) => g.groups.find((f) => f.key === key)));
    expect(new Set(lanes.map((lane) => lane[0].y)).size, `${name}: the first row on one line`).toBe(1);
    lanes.forEach((lane) => lane.slice(1).forEach((f, k) => expect(f.y - (lane[k].y + lane[k].h), `${name}: ${f.key} close under ${lane[k].key}`).toBe(32)));
    lanes.slice(1).forEach((lane, k) => expect(lane[0].x, `${name}: lanes left to right`).toBeGreaterThan(lanes[k][0].x + lanes[k][0].w));
    // nothing runs off the sides, and 队长 is on the page
    for (const f of g.frames) { expect(f.x, `${name}: ${f.key} left`).toBeGreaterThanOrEqual(g.vp.x + 8); expect(f.right, `${name}: ${f.key} right`).toBeLessThanOrEqual(g.vp.right - 8); }
    expect(g.captain.y).toBeGreaterThanOrEqual(g.vp.y + 8 - 0.5);
    if (g.pageFits) for (const f of g.frames) expect(f.bottom, `${name}: ${f.key} whole`).toBeLessThanOrEqual(g.vp.bottom - 8);
    // 智能一页 gives the same arrangement back
    await page.evaluate(() => CrewMap.page());
    await settled();
    const again = await readMap();
    expect(again.plan).toEqual(g.plan);
    expect(again.view.scale).toBeCloseTo(g.view.scale, 5);
    await shot(`map-${label}-projects-${name}`);
  }
  if (label === '9') {
    // too tall for the narrow page: 智能一页 says so at the bottom, and the word goes as soon as the map is scrolled
    await page.evaluate(() => CrewMap.page());
    await settled();
    expect(await page.evaluate(() => CrewMap.pageFits())).toBe(false);
    await expect(page.locator('.cm-hint')).toBeVisible();
    const vp = await page.locator('.cm-viewport').boundingBox();
    await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
    await page.mouse.wheel(0, 200);
    await expect(page.locator('.cm-hint')).toBeHidden({ timeout: 1000 });
  }
  expect(errors).toEqual([]);
});

// The project chips as they show: each chip's box, whether its name is whole and whether a click at its
// middle lands on it; the tally-and-tools block; the bar they share.
const readChips = () => page.evaluate(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const bar = document.querySelector('#taskBoardView .tbv-filters'), pad = getComputedStyle(bar);
  return { bar: { ...rect(bar), left: rect(bar).x + parseFloat(pad.paddingLeft), inner: rect(bar).right - parseFloat(pad.paddingRight) }, tools: rect(bar.querySelector('.tbv-tools')),
    chips: [...bar.querySelectorAll('.tbv-chip')].map((n) => { const r = rect(n), name = n.querySelector('.tbv-chip-name'), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { key: n.dataset.project, ...r, whole: name.scrollWidth <= name.clientWidth, hit: !!hit && n.contains(hit), label: n.title }; }),
    icons: [...bar.querySelectorAll('.tbv-tools button')].map((n) => ({ label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), ...rect(n) })),
    boardScrollsSideways: document.querySelector('.tbv-scroll').scrollWidth > document.querySelector('.tbv-scroll').clientWidth + 1 };
});
// rows the chips take at 1920, 1440 and 980 wide windows (1.3 gave the 25 projects 3, 4 and 9 rows, in the left part of the bar)
const CHIP_ROWS = { few: [1, 1, 2], many: [2, 3, 5] };

for (const [label, names] of [['few', FEW], ['many', MANY]]) test(`任务看板: ${label} project chips run across the full width, compact, every one whole and clickable`, async () => {
  await launch(ONE, names);
  for (const [i, [name, w, h]] of WIDTHS.entries()) {
    await size(w, h);
    if (!(await page.locator('#taskBoardView').isVisible())) await page.locator('#navTop .nav-row[data-nav="tasks"]').click();
    await expect(page.locator('.tbv-chip')).toHaveCount(names.length + 1);
    const g = await readChips();
    // every project shows: whole name, a real target, nothing outside the bar or over the tools
    expect(g.chips.map((c) => c.key).sort()).toEqual(['', ...names].sort());
    for (const c of g.chips) {
      expect(c.whole, `${name}: 「${c.key}」 shows whole`).toBe(true);
      expect(c.hit, `${name}: a click on 「${c.key}」 lands on it`).toBe(true);
      expect(c.height, `${name}: compact, still a target`).toBe(26);
      expect(c.label).toBeTruthy();
      expect(c.x).toBeGreaterThanOrEqual(g.bar.left - 0.5); expect(c.right).toBeLessThanOrEqual(g.bar.inner + 0.5);
      expect(c.right <= g.tools.x - 4 || c.y >= g.tools.bottom, `${name}: 「${c.key}」 clear of the tools`).toBe(true);
    }
    // rows: each starts at the bar's left edge and runs as far as the width goes, to the tools on the
    // first row and to the bar's right edge after it; the next chip would not have fitted
    const rowsOf = [...new Set(g.chips.map((c) => Math.round(c.y)))].sort((a, b) => a - b).map((y) => g.chips.filter((c) => Math.round(c.y) === y));
    expect(rowsOf.length, `${name}: rows of chips`).toBe(CHIP_ROWS[label][i]);
    rowsOf.forEach((row, r) => {
      expect(row[0].x, `${name}: row ${r + 1} starts at the left edge`).toBeCloseTo(g.bar.left, 0);
      row.slice(1).forEach((c, k) => expect(c.x - row[k].right, `${name}: one gap between chips`).toBeCloseTo(6, 0));
      const next = rowsOf[r + 1];
      if (!next) return;
      const limit = row[0].y < g.tools.bottom ? g.tools.x - 10 : g.bar.inner;
      expect(row[row.length - 1].right + 6 + next[0].width, `${name}: row ${r + 1} is full`).toBeGreaterThan(limit);
    });
    // the tally and the tools hold the right end of the first row; every tool is an icon button with a name
    expect(g.tools.right).toBeCloseTo(g.bar.inner, 0);
    expect(Math.abs(g.tools.y + g.tools.height / 2 - (rowsOf[0][0].y + rowsOf[0][0].height / 2)), `${name}: tools level with the first row`).toBeLessThanOrEqual(1);
    expect(g.icons.map((b) => b.label.replace(/（.*/, ''))).toEqual(['展开全部分组', '收起全部分组', '关闭动效', '刷新']);
    for (const b of g.icons) { expect(b.title).toBe(b.label); expect(b.svg).toBe(true); expect(b.text).toBe(''); expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(32); }
    expect(g.boardScrollsSideways).toBe(false);
    await shot(`board-${label}-${name}`);
  }
  // a chip on the last row still filters, and 全部 brings everything back
  const last = names[names.length - 1];
  await page.locator(`.tbv-chip[data-project="${last}"]`).click();
  await expect(page.locator(`.tbv-chip[data-project="${last}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tbv-lane[data-project]')).toHaveCount(1);
  await page.locator('.tbv-chip[data-project=""]').click();
  await expect(page.locator('.tbv-chip[data-project=""]')).toHaveAttribute('aria-pressed', 'true');
  // the keyboard reaches the chips and then the tools, each with a visible focus ring
  const focused = () => page.evaluate(() => { const n = document.activeElement; return [n.classList.contains('tbv-chip') ? 'chip:' + n.dataset.project : n.getAttribute('aria-label'), n.matches(':focus-visible'), getComputedStyle(n).outlineStyle]; });
  await page.locator('#taskBoardView .tbv-close').focus();
  await page.keyboard.press('Tab');
  expect(await focused()).toEqual(['chip:', true, 'solid']);
  await page.locator('.tbv-chip').last().focus();
  await page.keyboard.press('Tab');
  expect(await focused()).toEqual(['展开全部分组', true, 'solid']);
  expect(errors).toEqual([]);
});
