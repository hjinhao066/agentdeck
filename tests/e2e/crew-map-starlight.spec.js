const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图: project frames side by side in lanes (项目框横排), 智能一页 (the
// arrangement and zoom that show the whole map in this window, never below the
// readable floor), 一键整理 (hand-dragged frames and cards back on the grid,
// animated, with undo), and the look (the sky, glass cards, lit wiring, nothing
// moving under 减少动态效果). Real renderer, isolated userData, PTYs running
// only the stand-in TUI. Set AGENTDECK_CREW_MAP_SHOTS to keep PNGs.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
let application, page, profile;
const errors = [];

// The shape the user described: one project of ten sessions, then four, two and one.
const BIG = [
  ...[['任务看板星图视觉', 'working'], ['手机网页端对话区重排', 'working'], ['额度面板并入侧栏', 'working'], ['Windows 安装包签名', 'working'], ['重启后自动续跑', 'working'],
    ['队长接力交接 v2', 'failed'], ['CI Verify #81 失败排查', 'working'], ['1.1.12 集成与打包', 'queued'], ['Bark 提醒去重', 'done'], ['字号缩放快捷键', 'working']].map(([t, s]) => ['agentdeck', t, s]),
  ...[['省钱中心雷达任务注册', 'working'], ['/daily 日报卡片', 'working'], ['订阅到期提醒', 'done'], ['回滚点保留策略', 'asking']].map(([t, s]) => ['hermes-savings', t, s]),
  ...[['豆包语音切换', 'working'], ['钥匙串密钥迁移', 'failed']].map(([t, s]) => ['type4me-windows', t, s]),
  ['vps-ops', 'Caddy 证书续期巡检', 'working'],
];
// Ten sessions in two projects.
const TEN = [
  ...['登录与多租户权限', '数据工作台界面', '迁移历史记录', '接口失败恢复', '导出报表', '报告筛选接口'].map((t, i) => ['客户门户', t, i === 3 ? 'failed' : i === 4 ? 'done' : 'working']),
  ...['雷达任务注册', '日报卡片', '订阅提醒', '回滚点'].map((t, i) => ['hermes-savings', t, i === 2 ? 'done' : 'working']),
];
const RECEIPT = { done: '已完成实现、单元测试和端到端验证，结果已交回。', failed: '测试环境缺少数据访问权限，需要队长处理后再继续。', asking: '回滚点保留 7 天还是 30 天？' };

async function launch(crew) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-star-'));
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = crew.map(([project, title], i) => column('w' + i, title, { project }));
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => { const st = crew[i][2]; return { id: 'task-' + c.id, colId: c.id, gen: 1, status: st, sentAt: now - (90 - i * 3) * 60_000, doneAt: now - (40 - i) * 60_000, turnId: '',
        receipt: st === 'done' ? { summary: RECEIPT.done, files: [], explicit: true } : st === 'failed' ? { failed: RECEIPT.failed, files: [], explicit: true } : st === 'asking' ? { question: RECEIPT.asking, files: [] } : null }; }) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart)).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(crew.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 40000 }).toBe(crew.length + 1);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  application = null;
});

async function size(width, height, theme) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  if (theme) await page.evaluate((t) => applyTheme(t), theme);
}
async function open(width, height, theme) {
  await size(width, height, theme);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
}
// a glide has landed: the view's own (cm-smooth) and every frame and card's
const settled = () => expect.poll(() => page.evaluate(() => !document.querySelector('.cm-canvas.cm-smooth') && ![...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].some((n) => n.getAnimations().some((a) => !a.animationName && !(a instanceof CSSTransition) && a.playState === 'running')))).toBe(true);
// Running lights are frozen at a set point of their cycle, so a picture shows them lit the same way every time.
async function shot(name) {
  if (!shots) return;
  await settled();
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    const at = { 'cm-breathe': 0.5, 'cm-edge-flow': 0.45, 'cm-flow': 0.3, 'cm-flow-review': 0.3, 'cm-spin': 0.12, 'cm-ping': 0.2, 'sky-twinkle': 0.6 };
    document.getAnimations().forEach((a, i) => {
      const target = a.effect && a.effect.target;
      if (!target || !document.getElementById('crewMap').contains(target)) return;
      const t = a.effect.getComputedTiming();
      if (t.iterations !== Infinity) { a.finish(); return; }
      a.pause();
      a.currentTime = ((at[a.animationName] == null ? 0.5 : at[a.animationName]) + (a.animationName === 'cm-flow' ? (i % 4) * 0.17 : 0)) * t.duration;
    });
  });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'allow', scale: 'css' });
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}
const setTask = (ids, status) => page.evaluate(([list, st]) => { list.forEach((id) => { MainSession.state().tasks.find((t) => t.colId === id).status = st; }); CrewMap.refresh(); }, [ids, status]);

// Everything measurable about the map as it stands: the layout in canvas coordinates, the frames and
// cards on screen, the viewport, the view.
const read = () => page.evaluate(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const lay = CrewMap.layout(), view = CrewMap.view();
  return {
    vp: rect(document.querySelector('.cm-viewport')), view, plan: CrewMap.plan(), pageFits: CrewMap.pageFits(), canUndo: CrewMap.canUndo(), moved: CrewMap.userMoved(),
    groups: lay.groups.map((g) => ({ key: g.key, x: g.x, y: g.y, w: g.w, h: g.h, lane: g.lane })),
    nodes: [...lay.nodes].map(([id, b]) => ({ id, x: b.x, y: b.y, w: b.w, h: b.h, project: b.project })),
    captain: { ...lay.captain }, canvas: { w: lay.width, h: lay.height },
    frames: [...document.querySelectorAll('.cm-pane')].map((n) => ({ key: n.dataset.project, ...rect(n) })),
    cards: [...document.querySelectorAll('.cm-node')].map((n) => ({ id: n.dataset.nodeId, ...rect(n) })),
    bodyPx: parseFloat(getComputedStyle(document.querySelector('.cm-node:not(.kind-captain) .cm-line')).fontSize),
    saved: { positions: config.crewMap.positions, projectPositions: config.crewMap.projectPositions, projectOrder: config.crewMap.projectOrder, plan: config.crewMap.plan },
    hint: document.querySelector('.cm-hint').hidden ? '' : document.querySelector('.cm-hint').textContent,
  };
});
const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
// The map is in order: no frame or card on another, every card inside its own frame on the frame's column
// grid, frames of a lane on one left edge with one gap between them, and readable.
function assertNeat(g, ownZoom) {
  g.groups.forEach((a, i) => g.groups.slice(i + 1).forEach((b) => expect(apart(a, b), `${a.key}/${b.key} overlap`).toBe(true)));
  g.nodes.forEach((a, i) => g.nodes.slice(i + 1).forEach((b) => expect(apart(a, b), `${a.id}/${b.id} overlap`).toBe(true)));
  for (const n of g.nodes) {
    const f = g.groups.find((x) => x.key === n.project);
    expect(n.x >= f.x && n.x + n.w <= f.x + f.w && n.y >= f.y + 48 && n.y + n.h <= f.y + f.h, `${n.id} inside ${f.key}`).toBe(true);
    expect((n.x - f.x - 24) % 304, `${n.id} on its frame's column grid`).toBe(0);
  }
  const lanes = new Map();
  g.groups.forEach((f) => lanes.set(f.lane, [...(lanes.get(f.lane) || []), f]));
  lanes.forEach((list) => {
    expect(new Set(list.map((f) => f.x)).size, 'frames of a lane share its left edge').toBe(1);
    list.slice(1).forEach((f, i) => expect(f.y - (list[i].y + list[i].h), 'one gap between frames in a lane').toBe(32));
  });
  expect(new Set(g.groups.filter((f) => !lanes.get(f.lane).indexOf(f)).map((f) => f.y)).size, 'every lane starts on one line').toBe(1);
  if (ownZoom) return; // a zoom the user set is theirs: the readable floor belongs to the automatic fit
  expect(g.view.scale).toBeGreaterThanOrEqual(0.85 - 1e-6);
  expect(g.bodyPx * g.view.scale, 'card text stays 11px or more on screen').toBeGreaterThanOrEqual(11 - 1e-6);
}
// The whole map is inside the viewport with the fit's margin.
function assertWhole(g) {
  const edge = 8 + 16 * g.view.scale - 0.5;
  for (const a of [...g.frames, ...g.cards]) {
    expect(a.x, (a.key || a.id) + ' left').toBeGreaterThanOrEqual(g.vp.x + edge); expect(a.right, (a.key || a.id) + ' right').toBeLessThanOrEqual(g.vp.right - edge);
    expect(a.y, (a.key || a.id) + ' top').toBeGreaterThanOrEqual(g.vp.y + edge); expect(a.bottom, (a.key || a.id) + ' bottom').toBeLessThanOrEqual(g.vp.bottom - edge);
  }
}
// No 派出 line passes through a frame other than the one it feeds.
const linesClear = () => page.evaluate(() => {
  const lay = CrewMap.layout(), routes = CrewMapCore.routes(CrewMap.lastMap(), lay).filter((r) => r.type === 'dispatch');
  const bad = [];
  routes.forEach((r) => r.points.slice(1).forEach(([x2, y2], k) => { const [x1, y1] = r.points[k];
    lay.groups.filter((f) => f.key !== r.project).forEach((f) => { if (Math.max(x1, x2) > f.x + 1 && Math.min(x1, x2) < f.x + f.w - 1 && Math.max(y1, y2) > f.y + 1 && Math.min(y1, y2) < f.y + f.h - 1) bad.push(`${r.to} crosses ${f.key}`); }); }));
  return bad;
});
async function dragBy(locator, dx, dy) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.min(40, b.width / 2) + dx / 2, b.y + b.height / 2 + dy / 2, { steps: 4 });
  await page.mouse.move(b.x + Math.min(40, b.width / 2) + dx, b.y + b.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

test('项目框横排: frames stand side by side in lanes, small ones stacked beside the big one, at three widths in both themes', async () => {
  await launch(BIG);
  // a window that holds the whole map: the big project has a lane to itself, the small ones share the next
  await open(1920, 1080, 'dark');
  await expect(page.locator('.cm-project')).toHaveCount(4);
  await expect(page.locator('.cm-node:not(.kind-captain)')).toHaveCount(BIG.length);
  await settled();
  let g = await read();
  assertNeat(g);
  expect(g.pageFits).toBe(true);
  assertWhole(g);
  expect(g.plan.lanes.flat()).toEqual(['agentdeck', 'hermes-savings', 'type4me-windows', 'vps-ops']);
  expect(g.plan.lanes.length, 'more than one lane across').toBeGreaterThanOrEqual(2);
  expect(g.plan.lanes.some((l) => l.length > 1), 'small projects share a lane').toBe(true);
  expect(new Set(g.groups.map((f) => f.x)).size, 'frames side by side, not one under another').toBeGreaterThanOrEqual(2);
  // the page is filled, not run down: the map takes most of the window's width and height
  const filled = (m) => [(Math.max(...m.frames.map((f) => f.right)) - Math.min(...m.frames.map((f) => f.x))) / m.vp.width, (Math.max(...m.frames.map((f) => f.bottom)) - m.cards.find((c) => c.id === 'cap').y) / m.vp.height];
  expect(Math.max(...filled(g))).toBeGreaterThan(0.9);
  expect(Math.min(...filled(g))).toBeGreaterThan(0.7);
  expect(await linesClear()).toEqual([]);
  // the same seventeen cards one under another, the way it was, would need about twice the height
  const stackedHeight = await page.evaluate(() => { const C = CrewMapCore, map = CrewMap.lastMap();
    const one = C.layout(map, { nodeW: 280, nodeH: 172, captainW: 420, captainH: 104, gapX: 24, clusterGap: 32, fanY: 48, gapY: 20, pad: 16, padX: 24, padBottom: 20, rowGap: 20, reviewGap: 40, grid: true, center: true, tray: true, lanes: [map.projects.map((p) => p.key)], columnsPerProject: 3 });
    return one.height; });
  expect(g.canvas.h).toBeLessThan(stackedHeight * 0.6);
  await shot('map-4projects-1920-dark');
  await size(1920, 1080, 'light'); await settled();
  await shot('map-4projects-1920-light');

  // the look: the sky sits under the canvas, nothing blurs what is behind it, and only running work moves
  const look = await page.evaluate(() => { const root = document.getElementById('crewMap'), sky = root.querySelector('.star-sky'), vp = root.querySelector('.cm-viewport');
    const endless = document.getAnimations().filter((a) => a.effect && root.contains(a.effect.target) && a.effect.getComputedTiming().iterations === Infinity);
    const onCards = endless.filter((a) => a.effect.target.classList.contains('cm-node'));
    return { sky: !!sky && Math.abs(sky.getBoundingClientRect().width - vp.getBoundingClientRect().width) < 1 && getComputedStyle(sky).pointerEvents === 'none',
      blur: [...root.querySelectorAll('*')].filter((n) => getComputedStyle(n).backdropFilter !== 'none').length,
      cardAnimations: [...new Set(onCards.map((a) => a.animationName))].sort(),
      cardProps: [...new Set(onCards.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)).sort(),
      movingCards: new Set(onCards.map((a) => a.effect.target.dataset.status)).size === 1 && onCards[0].effect.target.dataset.status,
      stillCard: document.querySelector('.cm-node.st-done').getAnimations().length };
  });
  expect(look).toEqual({ sky: true, blur: 0, cardAnimations: ['cm-breathe', 'cm-edge-flow'], cardProps: ['opacity', 'transform'], movingCards: 'working', stillCard: 0 });

  // narrower windows: what cannot show whole at readable size is never squeezed and never scrolls sideways
  for (const [w, h] of [[1440, 900], [1280, 800], [980, 700]]) for (const theme of ['dark', 'light']) {
    await open(w, h, theme); await settled();
    g = await read();
    assertNeat(g);
    expect(await linesClear()).toEqual([]);
    if (g.pageFits) assertWhole(g);
    else {
      expect(g.view.scale).toBeCloseTo(0.85, 5);
      const width = Math.max(...g.frames.map((f) => f.right), ...g.cards.map((c) => c.right)) - Math.min(...g.frames.map((f) => f.x), ...g.cards.map((c) => c.x));
      expect(width, 'no sideways scrolling').toBeLessThanOrEqual(g.vp.width - 16 + 1);
      expect(g.cards.find((c) => c.id === 'cap').y, '队长 at the top').toBeGreaterThanOrEqual(g.vp.y + 8 - 0.5);
    }
    if (w >= 1280) expect(g.plan.lanes.length, `${w}: still more than one lane`).toBeGreaterThanOrEqual(2);
    await shot(`map-4projects-${w}-${theme}`);
  }

  // one project left on the map (the others finish and leave it): its cards spread to show whole
  await open(1440, 900, 'dark');
  await setTask(BIG.map((c, i) => [c, 'w' + i]).filter(([c]) => c[0] !== 'agentdeck').map(([, id]) => id), 'done');
  await expect(page.locator('.cm-project')).toHaveCount(1);
  await settled();
  g = await read();
  assertNeat(g);
  expect(g.pageFits).toBe(true);
  assertWhole(g);
  expect(g.plan.lanes).toEqual([['agentdeck']]);
  expect(g.plan.caps.agentdeck, 'ten cards four wide in three rows: three wide would be four rows and no longer show whole').toBe(4);
  for (const [w, h] of [[1440, 900], [1280, 800], [980, 700]]) for (const theme of ['dark', 'light']) {
    await open(w, h, theme); await settled();
    assertNeat(await read());
    await shot(`map-1project-${w}-${theme}`);
  }
  expect(errors).toEqual([]);
});

test('智能一页: one click hands arrangement and zoom back to the window; what cannot fit stays readable and says so; it can be undone', async () => {
  await launch(BIG);
  await open(1920, 1080, 'dark'); await settled();
  const auto = await read();
  // the buttons are icons with names, on the map's toolbar
  const buttons = await page.evaluate(() => ['fit', 'relayout', 'undo'].map((cm) => { const b = document.querySelector(`.cm-controls [data-cm="${cm}"]`); return { cm, label: b.getAttribute('aria-label'), title: b.title, svg: !!b.querySelector('svg'), text: b.textContent.trim(), hidden: b.hidden, w: b.offsetWidth, h: b.offsetHeight }; }));
  expect(buttons.map((b) => [b.cm, b.label.split('：')[0], b.hidden])).toEqual([['fit', '智能一页', false], ['relayout', '一键整理', false], ['undo', '撤销', true]]);
  for (const b of buttons) { expect(b.title).toBe(b.label); expect(b.svg).toBe(true); expect(b.text).toBe(''); if (!b.hidden) { expect(b.w).toBeGreaterThanOrEqual(32); expect(b.h).toBeGreaterThanOrEqual(32); } }

  // the user makes the map their own: a frame dragged off, the view zoomed and panned
  await dragBy(page.locator('.cm-project[data-project="hermes-savings"] .cm-project-name'), 160, 120);
  await page.locator('[data-cm="in"]').click(); await page.locator('[data-cm="in"]').click();
  const vp = await page.locator('.cm-viewport').boundingBox();
  const v0 = await page.evaluate(() => CrewMap.view());
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(-90, -60);
  await expect.poll(() => page.evaluate(() => CrewMap.view().x)).toBeGreaterThan(v0.x);
  await expect.poll(() => page.evaluate(() => JSON.stringify(config.crewMap.view) === JSON.stringify(CrewMap.view()))).toBe(true); // the pan is saved a moment later
  const mine = await read();
  expect(mine.moved).toBe(true);
  expect(mine.saved.projectPositions['hermes-savings']).toBeTruthy();
  expect(mine.saved.plan, 'the arrangement the move was made on is kept under it').toEqual(auto.plan);
  expect(mine.view.scale).toBeGreaterThan(auto.view.scale * 1.3);
  await shot('map-smartpage-before-1920-dark');
  // a smaller window: the hand-placed map keeps its ground (same frames, same places) and its view
  await size(1440, 900); await settled();
  const kept = await read();
  expect(kept.groups).toEqual(mine.groups);
  expect(kept.view).toEqual(mine.view);
  await shot('map-smartpage-before-1440-dark');

  // 智能一页 at 1440x900: seventeen cards cannot show whole at readable size, so it holds the floor and says so
  await page.locator('[data-cm="fit"]').click();
  await settled();
  let g = await read();
  expect(g.saved).toEqual({ positions: {}, projectPositions: {}, projectOrder: [], plan: null });
  expect(g.moved).toBe(false);
  assertNeat(g);
  expect(g.pageFits).toBe(false);
  expect(g.view.scale).toBeCloseTo(0.85, 5);
  expect(g.hint).toBe('一页放不下：文字保持在最小可读大小（85%），其余部分滚动查看');
  await expect(page.locator('.cm-hint')).toHaveAttribute('role', 'status');
  expect(g.cards.find((c) => c.id === 'cap').y).toBeGreaterThanOrEqual(g.vp.y + 8 - 0.5);
  expect(g.canUndo).toBe(true);
  await expect(page.locator('[data-cm="undo"]')).toBeVisible();
  await shot('map-smartpage-after-1440-dark');
  // undo: the hand-placed map and its zoom are back exactly
  await page.locator('[data-cm="undo"]').click();
  await settled();
  g = await read();
  expect(g.groups).toEqual(mine.groups);
  expect(g.view).toEqual(mine.view);
  expect(g.saved.projectPositions).toEqual(mine.saved.projectPositions);
  expect(g.moved).toBe(true);
  expect(g.canUndo).toBe(false);
  await expect(page.locator('[data-cm="undo"]')).toBeHidden();
  await expect(page.locator('.cm-hint')).toBeHidden();

  // 智能一页 in a window that can hold it: the whole map on one page, no hint
  await size(1920, 1080); await settled();
  await page.locator('[data-cm="fit"]').click();
  await settled();
  g = await read();
  expect(g.pageFits).toBe(true);
  assertNeat(g); assertWhole(g);
  expect(g.groups).toEqual(auto.groups);
  expect(g.view.scale).toBeCloseTo(auto.view.scale, 5);
  expect(g.hint).toBe('');
  await shot('map-smartpage-after-1920-dark');
  // from then on the map follows the window again
  await size(1440, 900); await settled();
  g = await read();
  expect(g.view.scale).toBeCloseTo(0.85, 5);
  expect(g.plan).not.toEqual(auto.plan);
  assertNeat(g);
  await size(1920, 1080, 'light'); await settled();
  g = await read();
  assertWhole(g);
  await shot('map-smartpage-after-1920-light');
  // nothing hand-placed and the view untouched: nothing to undo
  await page.locator('[data-cm="fit"]').click();
  await expect(page.locator('[data-cm="undo"]')).toBeHidden();
  // a small map grows a little to fill its page, never past 115%
  await setTask(BIG.map((c, i) => [c, 'w' + i]).filter(([c]) => c[0] !== 'vps-ops').map(([, id]) => id), 'done');
  await expect(page.locator('.cm-project')).toHaveCount(1);
  await settled();
  g = await read();
  expect(g.view.scale).toBeCloseTo(1.15, 5);
  assertWhole(g);
  expect(errors).toEqual([]);
});

test('一键整理: dragged frames and cards go back on the grid in the order they were left, gliding there, and 撤销 puts them back', async () => {
  await launch(BIG);
  await open(1920, 1080, 'dark'); await settled();
  const auto = await read();
  expect(auto.plan.lanes.flat()).toEqual(['agentdeck', 'hermes-savings', 'type4me-windows', 'vps-ops']);
  // drag things about: the last small frame up to the left of everything, another one askew, a card off its slot
  const frame = (key) => page.locator(`.cm-project[data-project="${key}"] .cm-project-name`);
  const big = auto.frames.find((f) => f.key === 'agentdeck'), small = auto.frames.find((f) => f.key === 'vps-ops');
  await dragBy(frame('vps-ops'), Math.round(big.x - small.x - 120), Math.round(big.y - small.y - 30));
  await dragBy(frame('hermes-savings'), 70, 90);
  await dragBy(page.locator('.cm-node[data-node-id="w2"]'), 60, 8);
  const messy = await read();
  expect(Object.keys(messy.saved.projectPositions).sort()).toEqual(['hermes-savings', 'vps-ops']);
  expect(messy.saved.positions.w2).toBeTruthy();
  expect(messy.groups.some((a, i) => messy.groups.slice(i + 1).some((b) => !apart(a, b))), 'the frames now overlap').toBe(true);
  await shot('map-tidy-before-1920-dark');
  // the user has also set a zoom: 整理 must leave it alone
  await page.locator('[data-cm="out"]').click();
  const zoomed = await read();
  expect(zoomed.moved).toBe(true);

  // 一键整理: frames and cards glide (transform only), the lines fade back in after them
  // (clicked and read in one step: the glide is short)
  const gliding = await page.evaluate(() => { document.querySelector('[data-cm="relayout"]').click();
    const moving = [...document.querySelectorAll('.cm-node, .cm-pane, .cm-project')].flatMap((n) => n.getAnimations().filter((a) => !a.animationName && !(a instanceof CSSTransition)));
    return { count: moving.length, props: [...new Set(moving.flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)).sort(),
      ms: Math.max(...moving.map((a) => a.effect.getComputedTiming().duration)), lines: document.querySelector('.cm-edges').getAnimations().length }; });
  expect(gliding.count).toBeGreaterThanOrEqual(4);
  expect(gliding.props).toEqual(['transform']);
  expect(gliding.ms).toBeLessThanOrEqual(400);
  expect(gliding.lines).toBe(1);
  await settled();
  let g = await read();
  assertNeat(g, true); // the zoom is still the one the user set
  expect(await linesClear()).toEqual([]);
  expect(g.saved.positions).toEqual({});
  expect(g.saved.projectPositions).toEqual({});
  expect(g.saved.plan).toBeNull();
  // the order the frames were left in: the one dragged to the far left now comes first, and it is remembered
  expect(g.saved.projectOrder[0]).toBe('vps-ops');
  expect(g.groups[0].key).toBe('vps-ops');
  expect(g.plan.lanes.flat()).toEqual(g.saved.projectOrder);
  expect(g.view.scale, 'the zoom the user set stays').toBeCloseTo(zoomed.view.scale, 5);
  expect(g.moved).toBe(true);
  expect(g.canUndo).toBe(true);
  await expect(page.locator('[data-cm="undo"]')).toBeVisible();
  await shot('map-tidy-after-1920-dark');
  await page.evaluate(() => applyTheme('light'));
  await shot('map-tidy-after-1920-light');
  await page.evaluate(() => applyTheme('dark'));

  // 撤销: every frame and card back where the user had dragged it
  await page.locator('[data-cm="undo"]').click();
  await settled();
  g = await read();
  expect(g.groups).toEqual(zoomed.groups);
  expect(g.nodes).toEqual(zoomed.nodes);
  expect(g.saved.positions).toEqual(zoomed.saved.positions);
  expect(g.saved.projectPositions).toEqual(zoomed.saved.projectPositions);
  expect(g.saved.projectOrder).toEqual([]);
  expect(g.view).toEqual(zoomed.view);
  await expect(page.locator('[data-cm="undo"]')).toBeHidden();

  // tidy again, then move something by hand: what was replaced is gone, the undo with it
  await page.locator('[data-cm="relayout"]').click();
  await settled();
  await expect(page.locator('[data-cm="undo"]')).toBeVisible();
  await dragBy(frame('type4me-windows'), 30, 20);
  await expect(page.locator('[data-cm="undo"]')).toBeHidden();
  // the order survives the board being closed and opened, and a restart of the page
  await page.locator('[data-cm="relayout"]').click();
  await settled();
  const ordered = await read();
  expect(ordered.saved.projectOrder[0]).toBe('vps-ops');
  await page.reload(); await expect(page.locator('#crewMap')).toBeVisible();
  await expect.poll(() => page.evaluate(() => CrewMap.layout() && CrewMap.layout().groups.map((f) => f.key))).toEqual(ordered.groups.map((f) => f.key));
  // 智能一页 hands the order back too
  await page.locator('[data-cm="fit"]').click();
  await settled();
  g = await read();
  expect(g.saved.projectOrder).toEqual([]);
  expect(g.groups.map((f) => f.key)).toEqual(['agentdeck', 'hermes-savings', 'type4me-windows', 'vps-ops']);
  expect(g.groups).toEqual(auto.groups);

  // 减少动态效果: the same tidy lands at once
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dragBy(frame('hermes-savings'), 70, 90);
  expect(await page.evaluate(() => { document.querySelector('[data-cm="relayout"]').click(); return [...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].flatMap((n) => n.getAnimations()).length; })).toBe(0);
  assertNeat(await read());
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-node.st-working:not(.kind-captain)'), '::before').display)).toBe('none');
  expect(errors).toEqual([]);
});

test('ten sessions in two projects: side by side at every width that holds them, both themes', async () => {
  await launch(TEN);
  for (const [w, h] of [[1440, 900], [1280, 800], [980, 700]]) for (const theme of ['dark', 'light']) {
    await open(w, h, theme);
    await expect(page.locator('.cm-project')).toHaveCount(2);
    await settled();
    const g = await read();
    assertNeat(g);
    expect(await linesClear()).toEqual([]);
    if (g.pageFits) assertWhole(g);
    if (w >= 1280) {
      expect(g.plan.lanes, `${w}: the two projects stand side by side`).toEqual([['客户门户'], ['hermes-savings']]);
      expect(g.groups[0].y).toBe(g.groups[1].y);
    }
    await shot(`map-10cards-2projects-${w}-${theme}`);
  }
  // text on the glass reads in both themes
  for (const theme of ['dark', 'light']) {
    await open(1440, 900, theme);
    const c = await page.evaluate(() => { const card = document.querySelector('.cm-node.st-working:not(.kind-captain)'), failed = document.querySelector('.cm-node.st-failed');
      const rgb = (v) => v.match(/[\d.]+/g).slice(0, 3).map((x) => Number(x) * (/^color\(/.test(v) ? 255 : 1));
      const lum = (v) => { const [r, g2, b] = rgb(v).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g2 + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const bg = getComputedStyle(card).backgroundColor, color = (n, sel) => getComputedStyle(n.querySelector(sel)).color;
      return { title: ratio(color(card, '.cm-title'), bg), line: ratio(color(card, '.cm-line'), bg), status: ratio(color(card, '.cm-status-text'), bg), time: ratio(color(card, '.cm-time'), bg),
        failed: ratio(color(failed, '.cm-status-text'), getComputedStyle(failed).backgroundColor), failedLine: ratio(color(failed, '.cm-line'), getComputedStyle(failed).backgroundColor) }; });
    expect(c.title, theme).toBeGreaterThan(7);
    for (const k of ['line', 'status', 'time', 'failed', 'failedLine']) expect(c[k], `${theme} ${k}`).toBeGreaterThanOrEqual(4.5);
  }
  // 动效开关: the toolbar's icon button stills the map (lights on the lines, the breathing rims, the sky) and brings it back
  const toggle = page.locator('#crewMap [data-motion-toggle]');
  const moving = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && document.getElementById('crewMap').contains(a.effect.target) && a.playState === 'running' && a.effect.getComputedTiming().iterations === Infinity).length);
  await expect(toggle).toHaveAttribute('aria-label', '关闭动效（卡片和连线保持静止）');
  expect((await toggle.textContent()).trim()).toBe('');
  const hit = await toggle.boundingBox();
  expect(Math.min(hit.width, hit.height)).toBeGreaterThanOrEqual(32);
  expect(await moving()).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', '开启动效（现在是静止的）');
  await expect.poll(moving).toBe(0);
  expect(await page.evaluate(() => [getComputedStyle(document.querySelector('.cm-pulse')).display, getComputedStyle(document.querySelector('.cm-node.st-working:not(.kind-captain)'), '::before').display])).toEqual(['none', 'none']);
  // 一键整理 lands at once while it is off
  await dragBy(page.locator('.cm-project .cm-project-name').first(), 60, 70);
  expect(await page.evaluate(() => { document.querySelector('[data-cm="relayout"]').click(); return [...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].flatMap((n) => n.getAnimations()).length; })).toBe(0);
  await shot('map-10cards-2projects-1440-light-motion-off');
  await toggle.click();
  await expect.poll(moving).toBeGreaterThan(0);
  expect(await page.evaluate(() => config.calmMotion)).toBe(false);
  expect(errors).toEqual([]);
});
