const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 架构图 A 版: one busy project on the canvas, four finished ones in the bottom tray.
// Real renderer, isolated userData, stand-in TUI. Screenshots when AGENTDECK_CREW_MAP_SHOTS is set.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
let application, page, profile;
const errors = [];

const crew = [
  ['agentdeck', '手机网页额度显示续做', 'working', '继续完善额度显示逻辑，处理边界情况和样式适配，保证手机网页端与桌面端一致。'],
  ['agentdeck', '永动机闲置席位续做', 'working', '完善闲置席位回收机制，优化并发处理逻辑。'],
  ['agentdeck', '三端统一集成', 'working', '对齐 Web / iOS / Android 的功能与接口，修复兼容性问题。'],
  ['agentdeck', '未识别模型查修', 'working', '排查未识别模型的问题，完善模型映射与容错机制。'],
  ['agentdeck', 'VPS 与 Windows 切换', 'working', '实现三端统一的切换方案，完善部署脚本与环境检测。'],
  ['agentdeck', '桌面额度区改版', 'working', '重构桌面额度区域 UI，提升交互体验与数据展示。'],
  ['agentdeck', '三端统一安全返工', 'failed', '修复登录态丢失、会话超时等安全问题，需要重新设计验证流程。'],
  ['type4me-windows', '豆包切换与安装包', 'done', '已完成并通过验证。'],
  ['ai-unified-map', '统一地图梳理', 'done', '已完成并通过验证。'],
  ['hermes-quality', '定时任务质量复核', 'done', '已完成并通过验证。'],
  ['hermes-quality', '邮件日报复测', 'failed', '复测未通过：邮箱授权过期，需要重新授权后再跑。'],
  ['opencli', '命令行封装整理', 'done', '已完成并通过验证。'],
];

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-arch-a-'));
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = crew.map(([project, title], i) => column('w' + i, title, { project }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: crew[i][2], sentAt: now - (60 - i * 4) * 60_000, doneAt: now - (30 - i * 2) * 60_000, turnId: '',
        receipt: crew[i][2] === 'done' ? { summary: crew[i][3], files: ['/tmp/demo/report.md'], explicit: true } : crew[i][2] === 'failed' ? { failed: crew[i][3], files: [], explicit: true } : null })) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(crew.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(crew.length + 1);
}
async function open(width, height, theme) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  await page.evaluate((t) => applyTheme(t), theme);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
}
const settled = () => expect(page.locator('.cm-canvas.cm-smooth')).toHaveCount(0);
async function shot(name, keepMouse) {
  if (!shots) return;
  await settled();
  fs.mkdirSync(shots, { recursive: true });
  if (!keepMouse) await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled', scale: 'css' });
}
const rgb = (c) => (/rgba?\(([^)]+)\)/.exec(c) || [])[1].split(',').slice(0, 3).map((v) => parseFloat(v));
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const setTask = (colId, status) => page.evaluate(([id, st]) => { MainSession.state().tasks.find((t) => t.colId === id).status = st; CrewMap.refresh(); }, [colId, status]);
const nodes = () => page.locator('.cm-node:not(.kind-captain)');

test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test.describe.configure({ mode: 'serial' });
test.beforeAll(launch);

test('night and day: the A palette, a 3-column grid, finished projects in the tray, nothing overlapping or clipped', async () => {
  for (const [width, height] of [[1920, 1080], [1440, 900]]) for (const theme of ['dark', 'light']) {
    await open(width, height, theme);
    await expect(page.locator('.cm-project')).toHaveCount(1);
    await expect(nodes()).toHaveCount(7);
    const g = await page.evaluate(() => {
      const rect = (n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.nodeId, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      const vp = document.querySelector('.cm-viewport').getBoundingClientRect();
      const card = document.querySelector('.cm-node.st-working:not(.kind-captain)');
      return {
        vp: { x: vp.x, y: vp.y, right: vp.right, bottom: vp.bottom }, boxes: [...document.querySelectorAll('.cm-node')].map(rect),
        canvas: css('.cm-viewport', 'backgroundColor'), card: getComputedStyle(card).backgroundColor,
        texts: [...document.querySelectorAll('.cm-node:not(.kind-captain)')].flatMap((c) => [...c.querySelectorAll('.cm-top, .cm-title, .cm-line, .cm-foot')].filter((n) => !n.hidden).map((n) => ({ id: c.dataset.nodeId, cls: n.className, bottom: n.getBoundingClientRect().bottom, right: n.getBoundingClientRect().right, card: c.getBoundingClientRect() }))),
        title: getComputedStyle(document.querySelector('.cm-node:not(.kind-captain) .cm-title')).color,
        sub: getComputedStyle(document.querySelector('.cm-node.st-working:not(.kind-captain) .cm-line')).color,
        status: ['working', 'failed'].map((s) => getComputedStyle(document.querySelector(`.cm-node.st-${s}:not(.kind-captain) .cm-status-text`)).color),
        cols: [...new Set([...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => n.offsetLeft))].length,
        sock: [...document.querySelectorAll('.cm-node.st-failed:not(.kind-captain)')].map((n) => getComputedStyle(n).backgroundColor),
      };
    });
    expect(g.canvas).toBe(theme === 'dark' ? 'rgb(12, 16, 22)' : 'rgb(246, 247, 249)');
    expect(g.card).toBe(theme === 'dark' ? 'rgb(21, 26, 34)' : 'rgb(255, 255, 255)');
    if (theme === 'light') expect(g.sock[0]).toBe('rgb(254, 243, 242)');
    expect(g.cols).toBe(3);
    // everything inside the viewport, no two cards overlapping, no text past its card
    for (const a of g.boxes) {
      expect(a.x).toBeGreaterThanOrEqual(g.vp.x); expect(a.right).toBeLessThanOrEqual(g.vp.right);
      expect(a.y).toBeGreaterThanOrEqual(g.vp.y); expect(a.bottom).toBeLessThanOrEqual(g.vp.bottom);
      for (const b of g.boxes) if (a.id !== b.id) expect(a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1, `${a.id}/${b.id}`).toBe(false);
    }
    for (const t of g.texts) { expect(t.bottom, `${t.id} ${t.cls}`).toBeLessThanOrEqual(t.card.bottom - 2); expect(t.right, `${t.id} ${t.cls}`).toBeLessThanOrEqual(t.card.right); }
    // readable text on the card surface
    expect(contrast(g.title, g.card)).toBeGreaterThan(7);
    expect(contrast(g.sub, g.card)).toBeGreaterThan(4.5);
    for (const c of g.status) expect(contrast(c, g.card)).toBeGreaterThan(4.5);
    // the tray: a real count, one chip per finished project, the failing one flagged
    const tray = page.locator('.cm-tray');
    await expect(tray).toBeVisible();
    await expect(tray.locator('.cm-tray-title')).toContainText('非活跃项目');
    await expect(tray.locator('.cm-tray-sum')).toHaveText('4 个项目（3 个已完成 · 1 个失败）');
    await expect(tray.locator('.cm-chip')).toHaveCount(4);
    await expect(tray.locator('.cm-chip.failed')).toHaveCount(1);
    await expect(tray.locator('.cm-chip.failed')).toContainText('hermes-quality');
    await expect(tray.locator('.cm-chip.failed .cm-chip-fail')).toHaveText('✕ 1');
    await expect(tray.locator('.cm-chip[aria-pressed="true"]')).toHaveCount(0);
    // the controls sit on the legend row, bottom right; fit has its words
    const box = await page.evaluate(() => { const c = document.querySelector('.cm-controls').getBoundingClientRect(), l = document.querySelector('.cm-legend').getBoundingClientRect(), v = document.querySelector('.cm-viewport').getBoundingClientRect(); return { c: [c.x, c.y, c.right, c.bottom], l: [l.x, l.y, l.right, l.bottom], vBottom: v.bottom }; });
    expect(box.c[1]).toBeGreaterThanOrEqual(box.l[1]); expect(box.c[3]).toBeLessThanOrEqual(box.l[3]); expect(box.c[2]).toBeGreaterThan(box.l[2] - 40);
    expect(box.l[1]).toBeGreaterThanOrEqual(box.vBottom);
    await expect(page.locator('[data-cm="fit"]')).toHaveText('适应画布');
    await shot(`arch-a-${width}x${height}-${theme}`);
  }
});

test('pipes: hovering a card lights its own path; only the running lines carry moving dots', async () => {
  await open(1920, 1080, 'dark');
  await settled();
  // One read per frame: a status tick can replace the wiring between two locators,
  // and a detached path reports a blank opacity. The numbers are unchanged.
  await expect.poll(() => page.evaluate(() => {
    const styleOf = (sel) => { const n = document.querySelector(sel); if (!n || !n.isConnected) return null; const s = getComputedStyle(n); return { op: parseFloat(s.opacity), anim: s.animationName, array: s.strokeDasharray, cap: s.strokeLinecap, w: parseFloat(s.strokeWidth) }; };
    const pulse = styleOf('.cm-edges .cm-pulse'), failed = styleOf('.cm-edges .cm-edge.dispatch.st-failed');
    const review = document.querySelector('.cm-legend .cm-edge.review');
    const pulses = document.querySelectorAll('.cm-edges .cm-pulse').length;
    const working = document.querySelectorAll('.cm-edges .cm-edge.dispatch.st-working').length;
    return !!(pulse && failed && review && pulses === working + 1 && pulse.cap === 'round' && pulse.w >= 4 && pulse.anim === 'cm-flow' && /^0\.1/.test(pulse.array) && failed.op < 1 && failed.anim === 'none' && getComputedStyle(review).strokeDasharray !== 'none');
  })).toBe(true);
  await expect(page.locator('.cm-edges.cm-hovering')).toHaveCount(0);
  await expect.poll(async () => {
    await nodes().nth(4).hover();
    const hit = await page.evaluate(() => ({
      hovering: document.querySelectorAll('.cm-edges.cm-hovering').length,
      path: document.querySelectorAll('.cm-hl-path').length,
      edge: document.querySelectorAll('.cm-edge.hl').length,
    }));
    expect(hit.hovering).toBe(1);
    expect(hit.path).toBeGreaterThanOrEqual(1);
    expect(hit.edge).toBeGreaterThanOrEqual(1);
    return true;
  }).toBe(true);
  await shot('arch-a-hover-dark', true);
  await page.mouse.move(2, 2);
  await expect(page.locator('.cm-edges.cm-hovering')).toHaveCount(0);
});

test('the tray opens a project onto the canvas, closes it again, and fits smoothly', async () => {
  await open(1920, 1080, 'dark');
  const chip = page.locator('.cm-chip[data-project="hermes-quality"]');
  const before = await page.evaluate(() => CrewMap.view());
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-project[data-project="hermes-quality"]')).toBeVisible();
  await expect(page.locator('.cm-node')).toHaveCount(1 + 7 + 2);
  expect(await page.evaluate(() => config.crewMap.collapsedProjects['hermes-quality'])).toBe(false);
  const after = await page.evaluate(() => CrewMap.view());
  expect(after.scale).toBeLessThan(before.scale + 1e-6);
  await settled();
  await shot('arch-a-tray-expanded-dark');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.cm-project[data-project="hermes-quality"]')).toHaveCount(0);
  // the arrow opens everything, then tucks everything away
  const arrow = page.locator('.cm-tray-arrow');
  await expect(arrow).toHaveAttribute('aria-expanded', 'false');
  await arrow.click();
  await expect(page.locator('.cm-project')).toHaveCount(5);
  await expect(arrow).toHaveAttribute('aria-expanded', 'true');
  await arrow.click();
  await expect(page.locator('.cm-project')).toHaveCount(1);
  await expect(page.locator('.cm-chip[aria-pressed="true"]')).toHaveCount(0);
});

test('live updates keep a hand-placed view; 适应画布 brings the fit back', async () => {
  await open(1920, 1080, 'dark');
  await settled();
  expect(await page.evaluate(() => CrewMap.userMoved())).toBe(false);
  // untouched view: a structural change refits (the tray project joins the canvas and the view follows)
  const v0 = await page.evaluate(() => CrewMap.view());
  await page.locator('.cm-chip[data-project="opencli"]').click();
  await settled();
  const v1 = await page.evaluate(() => CrewMap.view());
  expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v0));
  await page.locator('.cm-chip[data-project="opencli"]').click();
  // the user zooms and pans: from now on the view is theirs
  await page.locator('[data-cm="in"]').click();
  const vp = await page.locator('.cm-viewport').boundingBox();
  await page.mouse.move(vp.x + 20, vp.y + vp.height - 20); await page.mouse.down();
  await page.mouse.move(vp.x + 80, vp.y + vp.height - 50, { steps: 5 }); await page.mouse.up();
  const mine = await page.evaluate(() => CrewMap.view());
  expect(await page.evaluate(() => CrewMap.userMoved())).toBe(true);
  await setTask('w5', 'done');           // a structural change: a card changes state
  await expect.poll(() => page.locator('.cm-node[data-node-id="w5"]').getAttribute('data-status')).toBe('done');
  expect(await page.evaluate(() => CrewMap.view())).toEqual(mine);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  expect(await page.evaluate(() => CrewMap.view())).toEqual(mine);
  await setTask('w5', 'working');
  await page.locator('[data-cm="fit"]').click();
  expect(await page.evaluate(() => CrewMap.userMoved())).toBe(false);
  await settled();
  expect(await page.evaluate(() => CrewMap.view())).not.toEqual(mine);
  // 100% button
  await page.locator('[data-cm="reset"]').click();
  expect((await page.evaluate(() => CrewMap.view())).scale).toBeCloseTo(1, 5);
  await expect(page.locator('[data-cm="reset"]')).toHaveText('100%');
  await page.locator('[data-cm="fit"]').click();
});

test('new activity brings a folded project back without moving the view', async () => {
  await open(1920, 1080, 'dark');
  // a finished project the user opened from the tray tucks itself away again... until it starts working
  await page.locator('.cm-chip[data-project="type4me-windows"]').click();
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toBeVisible();
  await page.locator('.cm-project[data-project="type4me-windows"] .cm-project-toggle').click();
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toHaveCount(0);
  await expect(page.locator('.cm-chip[data-project="type4me-windows"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-cm="in"]').click();
  const mine = await page.evaluate(() => CrewMap.view());
  await setTask('w7', 'working');        // the folded project's session starts again
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toBeVisible();
  await expect(page.locator('.cm-node[data-node-id="w7"]')).toBeVisible();
  expect(await page.evaluate(() => CrewMap.view())).toEqual(mine);
  await expect(page.locator('.cm-chip[data-project="type4me-windows"]')).toHaveCount(0);
  await setTask('w7', 'done');
  await expect(page.locator('.cm-chip[data-project="type4me-windows"]')).toHaveCount(1);   // finished: back in the tray
  await page.locator('[data-cm="fit"]').click();
});

test('details: ··· and a failed card\'s 查看 open one popover with the whole receipt; Esc and outside clicks close it', async () => {
  await open(1440, 900, 'light');
  await page.locator('[data-cm="fit"]').click();
  await settled();
  const failed = page.locator('.cm-node[data-node-id="w6"]');
  await expect(failed.locator('.cm-view')).toHaveText('查看');
  await expect(failed.locator('.cm-more')).toHaveAttribute('aria-label', /查看详情/);
  await failed.locator('.cm-view').click();
  const pop = page.locator('.cm-pop');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('三端统一安全返工');
  await expect(pop).toContainText('需要重新设计验证流程');
  await expect(pop.getByRole('button', { name: '打开终端' })).toBeVisible();
  const inside = await page.evaluate(() => { const p = document.querySelector('.cm-pop').getBoundingClientRect(), v = document.querySelector('.cm-viewport').getBoundingClientRect(); return p.x >= v.x && p.right <= v.right && p.y >= v.y && p.bottom <= v.bottom; });
  expect(inside).toBe(true);
  expect(await page.evaluate(() => activeView)).toBe('board');
  await shot('arch-a-detail-light');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await page.locator('.cm-node[data-node-id="w1"] .cm-more').click();
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('永动机闲置席位续做');
  await page.mouse.click(5, 300);        // blank sidebar area: outside
  await expect(pop).toBeHidden();
  await page.locator('.cm-node[data-node-id="w1"] .cm-more').click();
  await pop.locator('.cm-pop-x').click();
  await expect(pop).toBeHidden();
  // the card itself still opens its real terminal
  await page.locator('.cm-node[data-node-id="w2"]').click();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'w2']);
  expect(errors).toEqual([]);
});
