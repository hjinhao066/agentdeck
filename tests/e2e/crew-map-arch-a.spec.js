const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const closeElectron = require('./fixtures/close-electron');

// 架构图: one busy project on the canvas; finished projects are off the map, one with a failure waits in the bottom tray.
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
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: crew[i][2], sentAt: now - (60 - i * 4) * 60_000, doneAt: now - (30 - i * 2) * 1000, turnId: '',
        receipt: crew[i][2] === 'done' ? { summary: crew[i][3], files: ['/tmp/demo/report.md'], explicit: true } : crew[i][2] === 'failed' ? { failed: crew[i][3], files: [], explicit: true } : null })) },
  }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart)).toBe(false);
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
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});
test.describe.configure({ mode: 'serial' });
test.beforeAll(launch);

test('night and day: the sky palette, the grid that shows the whole map, finished projects in the tray, nothing overlapping or clipped', async () => {
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
        vp: { x: vp.x, y: vp.y, right: vp.right, bottom: vp.bottom }, boxes: [...document.querySelectorAll('.cm-node, .cm-pane')].map(rect),
        scale: CrewMap.view().scale, trayTop: document.querySelector('.cm-tray').getBoundingClientRect().y,
        canvas: css('.cm-viewport', 'backgroundColor'), card: getComputedStyle(card).backgroundColor,
        texts: [...document.querySelectorAll('.cm-node:not(.kind-captain)')].flatMap((c) => [...c.querySelectorAll('.cm-top, .cm-title, .cm-line, .cm-foot')].filter((n) => !n.hidden).map((n) => ({ id: c.dataset.nodeId, cls: n.className, bottom: n.getBoundingClientRect().bottom, right: n.getBoundingClientRect().right, card: c.getBoundingClientRect() }))),
        title: getComputedStyle(document.querySelector('.cm-node:not(.kind-captain) .cm-title')).color,
        sub: getComputedStyle(document.querySelector('.cm-node.st-working:not(.kind-captain) .cm-line')).color,
        status: ['working', 'failed'].map((s) => getComputedStyle(document.querySelector(`.cm-node.st-${s}:not(.kind-captain) .cm-status-text`)).color),
        cols: [...new Set([...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => n.offsetLeft))].length,
        sock: [...document.querySelectorAll('.cm-node.st-failed:not(.kind-captain)')].map((n) => getComputedStyle(n).backgroundColor),
      };
    });
    expect(g.canvas).toBe(theme === 'dark' ? 'rgb(6, 8, 15)' : 'rgb(243, 245, 252)');
    expect(g.card).toBe(theme === 'dark' ? 'rgb(22, 27, 44)' : 'rgb(255, 255, 255)');
    if (theme === 'light') expect(g.sock[0]).toBe('rgb(255, 241, 244)');
    // seven cards, four wide (4 + 3): three wide would be three rows and no longer show whole in these windows
    expect(g.cols).toBe(4);
    // The whole map shows above the tray: 队长, every card and the project's frame keep the
    // fit's margin (its 8px inset + the 16px the map carries around itself) from every edge
    // of the viewport, the tray sits under it; no two cards overlapping, no text past its card
    const edge = 8 + 16 * g.scale;
    expect(g.trayTop).toBeGreaterThanOrEqual(g.vp.bottom - 0.5);
    for (const a of g.boxes) {
      expect(a.x).toBeGreaterThanOrEqual(g.vp.x + edge - 0.5); expect(a.right).toBeLessThanOrEqual(g.vp.right - edge + 0.5);
      expect(a.y).toBeGreaterThanOrEqual(g.vp.y + edge - 0.5); expect(a.bottom, `${a.id || 'project frame'} above the tray`).toBeLessThanOrEqual(g.vp.bottom - edge + 0.5);
      for (const b of g.boxes) if (a.id && b.id && a.id !== b.id) expect(a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1, `${a.id}/${b.id}`).toBe(false);
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
    await expect(tray.locator('.cm-tray-sum')).toHaveText('1 个项目（1 个失败）');
    await expect(tray.locator('.cm-chip')).toHaveCount(1);
    await expect(tray.locator('.cm-chip.failed')).toHaveCount(1);
    await expect(tray.locator('.cm-chip.failed')).toContainText('hermes-quality');
    await expect(tray.locator('.cm-chip.failed .cm-chip-fail')).toHaveText('✕ 1');
    await expect(tray.locator('.cm-chip[aria-pressed="true"]')).toHaveCount(0);
    // the controls sit on the legend row, bottom right; 智能一页 is an icon with its name
    const box = await page.evaluate(() => { const c = document.querySelector('.cm-controls').getBoundingClientRect(), l = document.querySelector('.cm-legend').getBoundingClientRect(), v = document.querySelector('.cm-viewport').getBoundingClientRect(); return { c: [c.x, c.y, c.right, c.bottom], l: [l.x, l.y, l.right, l.bottom], vBottom: v.bottom }; });
    expect(box.c[1]).toBeGreaterThanOrEqual(box.l[1]); expect(box.c[3]).toBeLessThanOrEqual(box.l[3]); expect(box.c[2]).toBeGreaterThan(box.l[2] - 40);
    expect(box.l[1]).toBeGreaterThanOrEqual(box.vBottom);
    await expect(page.locator('[data-cm="fit"]')).toHaveAttribute('aria-label', /^智能一页/);
    await expect(page.locator('[data-cm="fit"]')).toHaveText('');
    await shot(`arch-a-${width}x${height}-${theme}`);
  }
});

test('too tall with the tray showing: a row is whole and clear of the tray or plainly cut; the end scrolls clear of it', async () => {
  const read = () => page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { y: r.y, bottom: r.bottom, x: r.x, width: r.width }; };
    return { vp: rect(document.querySelector('.cm-viewport')), tray: rect(document.querySelector('.cm-tray')), cap: rect(document.querySelector('.cm-node.kind-captain')), scale: CrewMap.view().scale,
      pane: rect(document.querySelector('.cm-pane')), card: Object.fromEntries([...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => [n.dataset.nodeId, rect(n)])) };
  });
  // 1280x800 cannot show seven cards whole: three wide, three rows at the floor (no sideways scrolling), the last cut by the tray's edge.
  await open(1280, 800, 'dark'); await settled();
  const base = await read();
  expect(base.scale).toBeCloseTo(0.85, 5);
  expect(base.card.w6.bottom).toBeGreaterThan(base.vp.bottom);
  // Size the window so the edge would land 5px under the second row (1.1.8 left a row 4.4px
  // above the tray), then 5px inside it: neither may stay flush against the tray.
  for (const [nudge, check] of [[5, (gap) => gap >= 16 * 0.85 - 0.5], [-5, (gap) => gap <= -24 * 0.85 + 0.5]]) {
    await open(1280, 800 - Math.round(base.vp.bottom - (base.card.w3.bottom + nudge)), 'dark'); await settled();
    const g = await read(), gap = g.vp.bottom - g.card.w3.bottom;
    expect(g.scale).toBeCloseTo(0.85, 5);
    expect(check(gap), `second row ends ${gap.toFixed(1)}px above the tray`).toBe(true);
    expect(g.cap.y, '队长 stays whole').toBeGreaterThanOrEqual(g.vp.y + 8 - 0.5);
    expect(g.tray.y).toBeGreaterThanOrEqual(g.vp.bottom - 0.5);
  }
  // scrolled to the end, the last card and its project's frame rest above the tray with the fit's margin
  await open(1280, 800, 'dark'); await settled();
  const edge = 8 + 16 * 0.85;
  await page.mouse.move(base.vp.x + base.vp.width / 2, base.vp.y + 200);
  await expect.poll(async () => {
    const over = (await read()).pane.bottom - (base.vp.bottom - edge);
    // A wheel step lands 1x or 2x: halve the gap, polling every 100ms
    // instead of backing off to 1s before the remaining steps have landed.
    if (over > 0) await page.mouse.wheel(0, Math.ceil(over / 2) + 1);
    return over <= 0;
  }, { intervals: [100] }).toBe(true);
  const end = await read();
  expect(end.card.w6.y).toBeGreaterThanOrEqual(end.vp.y);
  expect(end.card.w6.bottom).toBeLessThanOrEqual(end.tray.y - edge);
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('.cm-node[data-node-id="w6"]'), [end.card.w6.x + end.card.w6.width / 2, end.card.w6.bottom - 4])).toBe(true);
  await shot('arch-a-1280x800-scrolled-end-dark');
  await page.locator('[data-cm="fit"]').click();
});

test('pipes: hovering a card lights its own path; only the running lines carry a moving light', async () => {
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
    // a running line carries one short bright stretch, 14px of every 260
    return !!(pulse && failed && review && pulses === working + 1 && pulse.cap === 'round' && pulse.w >= 3 && pulse.anim === 'cm-flow' && /^14px, 246px$/.test(pulse.array) && failed.op < 1 && failed.anim === 'none' && getComputedStyle(review).strokeDasharray !== 'none');
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
  await expect(page.locator('.cm-project')).toHaveCount(2);
  await expect(arrow).toHaveAttribute('aria-expanded', 'true');
  await arrow.click();
  await expect(page.locator('.cm-project')).toHaveCount(1);
  await expect(page.locator('.cm-chip[aria-pressed="true"]')).toHaveCount(0);
});

test('live updates keep a hand-placed view; 智能一页 brings the fit back', async () => {
  await open(1920, 1080, 'dark');
  await settled();
  expect(await page.evaluate(() => CrewMap.userMoved())).toBe(false);
  // untouched view: a structural change refits (the tray project joins the canvas and the view follows)
  const v0 = await page.evaluate(() => CrewMap.view());
  await page.locator('.cm-chip[data-project="hermes-quality"]').click();
  await settled();
  const v1 = await page.evaluate(() => CrewMap.view());
  expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v0));
  await page.locator('.cm-chip[data-project="hermes-quality"]').click();
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

test('a finished project is not on the map; new activity brings it back without moving the view', async () => {
  await open(1920, 1080, 'dark');
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toHaveCount(0);
  await expect(page.locator('.cm-chip[data-project="type4me-windows"]')).toHaveCount(0);
  await page.locator('[data-cm="in"]').click();
  const mine = await page.evaluate(() => CrewMap.view());
  await setTask('w7', 'working');        // the finished project's session starts again
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toBeVisible();
  await expect(page.locator('.cm-node[data-node-id="w7"]')).toBeVisible();
  expect(await page.evaluate(() => CrewMap.view())).toEqual(mine);
  await setTask('w7', 'done');
  await expect(page.locator('.cm-project[data-project="type4me-windows"]')).toHaveCount(0);   // finished: off the map again
  await expect(page.locator('.cm-chip[data-project="type4me-windows"]')).toHaveCount(0);
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
