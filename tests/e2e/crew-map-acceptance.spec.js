const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Real renderer, isolated userData and PTYs running only the stand-in TUI.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
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
// a fit glides for a moment; measure only once the canvas has landed
async function settled() { await expect(page.locator('.cm-canvas.cm-smooth')).toHaveCount(0); }
async function geometry() {
  await settled();
  return page.evaluate(() => {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const viewport = rect(document.querySelector('.cm-viewport'));
    const nodes = [...document.querySelectorAll('.cm-node')].map((n) => ({ id: n.dataset.nodeId, ...rect(n) }));
    const groups = [...document.querySelectorAll('.cm-project')].map((n) => { const pane = document.querySelector(`.cm-pane[data-project="${CSS.escape(n.dataset.project)}"]`); return { id: n.dataset.project, ...rect(n), color: getComputedStyle(pane).backgroundColor, border: getComputedStyle(pane).borderColor }; });
    const texts = [...document.querySelectorAll('.cm-node')].flatMap((card) => [...card.querySelectorAll('.cm-top, .cm-title, .cm-line, .cm-live, .cm-foot')].filter((n) => !n.hidden).map((n) => ({ id: card.dataset.nodeId, cls: n.className, captain: card.classList.contains('kind-captain'), ...rect(n), parent: rect(card), lineHeight: parseFloat(getComputedStyle(n).lineHeight), localHeight: n.offsetHeight, clamp: getComputedStyle(n).webkitLineClamp })));
    const heads = [...document.querySelectorAll('.cm-project-head')].map((h) => { const sum = h.querySelector('.cm-project-summary'), name = h.querySelector('.cm-project-name'); return { id: h.parentElement.dataset.project, ...rect(h), sumClient: sum.clientWidth, sumScroll: sum.scrollWidth, sumRight: sum.getBoundingClientRect().right, counts: [...sum.querySelectorAll('.cm-count')].map((c) => ({ cls: c.className, ...rect(c.querySelector('b')) })), nameCut: name.scrollWidth > name.clientWidth + 1, nameOverflow: getComputedStyle(name).textOverflow }; });
    const below = [...document.querySelectorAll('.cm-tray, .cm-legend')].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect().y);
    return { viewport, nodes, groups, heads, below, texts, scale: CrewMap.view().scale, bodyPx: parseFloat(getComputedStyle(document.querySelector('.cm-node:not(.kind-captain) .cm-line')).fontSize) };
  });
}
async function assertLayout() {
  const g = await geometry();
  const overlaps = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
  // Auto-fit never goes below 85% (card body text is 13px: 11px or more on screen). The
  // controls sit on the legend row below the viewport, so the only thing the map keeps
  // clear of is the viewport's own edge: the fit's 8px inset plus the 16px the map carries
  // around itself, on every side (21.8px at 86%). A map too tall at the floor starts at the
  // top and is cut at the bottom edge: there a card is either whole with 16px (map px) to
  // spare, or plainly cut by 24px or more, never flush against the tray or the legend row.
  expect(g.scale).toBeGreaterThanOrEqual(0.85 - 1e-6);
  expect(g.bodyPx * g.scale).toBeGreaterThanOrEqual(11 - 1e-6);
  const fits = g.scale > 0.85 + 1e-3, edge = 8 + 16 * g.scale;
  for (const y of g.below) expect(y, 'tray and legend row sit under the viewport').toBeGreaterThanOrEqual(g.viewport.bottom - 0.5);
  for (const list of [g.nodes, g.groups]) for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (fits) {
      expect(a.x, a.id + ' left').toBeGreaterThanOrEqual(g.viewport.x + edge - 0.5);
      expect(a.y, a.id + ' top').toBeGreaterThanOrEqual(g.viewport.y + edge - 0.5);
      expect(a.right, a.id + ' right').toBeLessThanOrEqual(g.viewport.right - edge + 0.5);
      expect(a.bottom, a.id + ' bottom').toBeLessThanOrEqual(g.viewport.bottom - edge + 0.5);
    } else if (list === g.nodes) {
      const gap = g.viewport.bottom - a.bottom;
      expect(gap >= 16 * g.scale - 0.5 || gap <= -24 * g.scale + 0.5, `${a.id} ends ${gap.toFixed(1)}px above the bottom edge`).toBe(true);
    }
    for (const b of list.slice(i + 1)) expect(overlaps(a, b), `${a.id}/${b.id} overlap`).toBe(false);
  }
  // a project's tally is never clipped: every count shows whole inside the title strip,
  // and a name too long for what is left ends in an ellipsis
  for (const h of g.heads) {
    expect(h.sumScroll, h.id + ' tally clipped').toBeLessThanOrEqual(h.sumClient + 1);
    expect(h.sumRight, h.id + ' tally inside the strip').toBeLessThanOrEqual(h.right + 0.5);
    for (const c of h.counts) { expect(c.width, h.id + ' ' + c.cls).toBeGreaterThan(0); expect(c.x).toBeGreaterThanOrEqual(h.x); expect(c.right).toBeLessThanOrEqual(h.right + 0.5); }
    if (h.nameCut) expect(h.nameOverflow).toBe('ellipsis');
  }
  const cap = g.nodes.find((n) => n.id === 'cap');
  expect(cap.y, '队长 stays in view').toBeGreaterThanOrEqual(g.viewport.y + 8 - 0.5);
  for (const t of g.texts) {
    expect(t.bottom, `${t.id} ${t.cls} fits card`).toBeLessThanOrEqual(t.parent.bottom - 2);
    if (['cm-title', 'cm-line'].includes(t.cls) && !t.captain) {
      expect(t.clamp).toBe('2');
      expect(t.localHeight).toBe(t.lineHeight * 2);
    }
  }
  const controls = await page.evaluate(() => [...document.querySelectorAll('.cm-controls button, .cm-return-toggle, .cm-project-toggle, .cm-more, .cm-tray-arrow, #boardViewBtn, #navCollapseBtn')].filter((n) => !n.hidden).map((n) => ({ label: n.getAttribute('aria-label'), title: n.title, icon: !!n.querySelector('svg'), text: n.textContent.trim(), cm: n.dataset.cm || '' })));
  // icon buttons everywhere; only the zoom readout carries text
  for (const c of controls) {
    expect(c.label).toBeTruthy(); expect(c.title).toBeTruthy();
    if (c.cm === 'reset') expect(c.text).toMatch(/^\d+%$/);
    else { expect(c.icon).toBe(true); expect(c.text).toBe(''); }
  }
  await expect(page.locator('.cm-edges .cm-edge.return.show, .cm-edges .cm-chevron')).toHaveCount(0);
  expect(await page.locator('.cm-returned').count()).toBeGreaterThan(0);
  expect(await page.locator('.cm-legend [data-cm="return"]').count()).toBe(1);
  return { ...g, controls };
}
async function launch(scenario) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-acceptance-'));
  const titles = ['实现客户登录和多租户权限验证，包含跨项目访问边界及所有错误处理', '构建数据工作台界面，验证长标题在不同窗口中始终最多两行并显示省略号', '同步迁移数据和历史记录', '验证接口失败后的恢复流程', '审查登录和界面变更', '新增汇总与导出报表', '实现报告筛选和查询接口', '测试数据权限与边界条件', '修复上传流程和错误提示', '审查报表服务数据迁移'];
  const states = ['done', 'working', 'queued', 'failed', 'working', 'done', 'working', 'queued', 'failed', 'done'];
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = titles.map((title, i) => column('v3-' + i, title, { project: scenario === 'A' ? i < 5 ? '客户门户' : '报表服务' : '', reviews: scenario === 'A' && i === 4 ? ['v3-0', 'v3-1'] : scenario === 'A' && i === 9 ? ['v3-5', 'v3-6'] : [] }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: states[i], sentAt: now - 60_000 + i, turnId: '', receipt: states[i] === 'done' ? { summary: '已完成实现、单元测试和端到端验证。还核对了长段中文回执在两行内显示完整字符，超出的说明应当使用省略号，避免任何文字被裁掉半截。', files: [], explicit: true } : states[i] === 'failed' ? { failed: '测试环境缺少数据访问权限，请队长处理后再继续运行迁移验证。', files: [], explicit: true } : null })) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(11);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(11);
}
test.afterEach(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  application = null;
});

for (const scenario of ['A', 'B']) test(`${scenario}: default layout at both window sizes and themes, with real pointer interactions`, async () => {
  await launch(scenario);
  const evidence = [];
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) for (const theme of ['dark', 'light']) {
    await resize(width, height);
    await page.evaluate((t) => applyTheme(t), theme);
    if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
    // Opening the map itself must arrange and fit; no pre-screenshot fit click.
    await page.locator('#boardViewBtn').click();
    await expect(page.locator('.cm-node')).toHaveCount(11);
    await expect(page.locator('.cm-project')).toHaveCount(scenario === 'A' ? 2 : 1);
    await expect(page.locator('.cm-node[data-status="queued"]')).toHaveCount(2);
    await expect(page.locator('.cm-node[data-status="failed"]')).toHaveCount(2);
    const g = await assertLayout();
    if (scenario === 'A') {
      expect(g.groups[0].color).not.toBe(g.groups[1].color); expect(g.groups[0].border).not.toBe(g.groups[1].border);
      // each project has a failure: its count stays in the title strip at every width
      for (const h of g.heads) expect(h.counts.some((c) => /st-failed/.test(c.cls)), h.id + ' failed count').toBe(true);
    }
    else expect(new Set(g.nodes.filter((n) => n.id !== 'cap').map((n) => Math.round(n.y))).size).toBeGreaterThan(1);
    expect(await page.locator('.cm-edges .cm-edge.dispatch').count()).toBe(10);
    expect(await page.locator('.cm-edges .cm-edge.review').count()).toBe(scenario === 'A' ? 4 : 0);
    const toolbar = await page.locator('#tbLeft > button').evaluateAll((nodes) => nodes.filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.id));
    expect(toolbar.slice(0, 2)).toEqual(['boardViewBtn', 'navCollapseBtn']);
    await expect(page.locator('#navTop #taskBoardBtn')).toBeVisible();
    evidence.push({ scenario, width, height, theme, ...g });
    await screenshot(`${scenario}-${width}x${height}-${theme}`);
    if (g.scale <= 0.85 + 1e-3) {
      // held at the floor: the rest is a wheel scroll away, and the last project comes to
      // rest with the same margin above the bottom edge as a map that fits, nothing over it
      const edge = 8 + 16 * g.scale, lowest = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('.cm-pane')].map((n) => n.getBoundingClientRect().bottom)));
      await page.mouse.move(g.viewport.x + g.viewport.width / 2, g.viewport.y + g.viewport.height / 2);
      await expect.poll(async () => {
        const over = await lowest() - (g.viewport.bottom - edge);
        // a wheel step lands 1x or 2x depending on the platform: go half way and close in
        if (over > 0) await page.mouse.wheel(0, Math.ceil(over / 2) + 1);
        return over <= 0;
      }).toBe(true);
      expect(await page.evaluate(() => CrewMap.userMoved())).toBe(true);
      const end = await geometry(), last = end.nodes.reduce((m, n) => (n.bottom > m.bottom ? n : m));
      expect(last.y, 'last card in view').toBeGreaterThanOrEqual(end.viewport.y);
      expect(last.bottom, 'last card clear of the bottom edge').toBeLessThanOrEqual(end.viewport.bottom - edge);
      expect(await page.evaluate(([id, x, y]) => !!document.elementFromPoint(x, y).closest(`.cm-node[data-node-id="${id}"]`), [last.id, last.x + last.width / 2, last.bottom - 4]), 'nothing covers the last card').toBe(true);
      await page.locator('[data-cm="fit"]').click();
      await settled();
    }
  }
  if (shots) fs.writeFileSync(path.join(shots, `${scenario}-geometry.json`), JSON.stringify(evidence, null, 2));
  if (scenario === 'A') {
    await page.evaluate(() => applyTheme('dark'));
    const group = page.locator('.cm-project[data-project="报表服务"]');
    const before = await geometry(), head = await group.locator('.cm-project-name').boundingBox();
    await page.mouse.move(head.x + 20, head.y + 10); await page.mouse.down();
    await page.mouse.move(head.x + 65, head.y + 55, { steps: 8 }); await page.mouse.up();
    const after = await geometry();
    const dx = after.groups[1].x - before.groups[1].x, dy = after.groups[1].y - before.groups[1].y;
    expect(dx).toBeGreaterThan(40); expect(dy).toBeGreaterThan(40);
    for (let i = 5; i < 10; i++) {
      const a = before.nodes.find((n) => n.id === 'v3-' + i), b = after.nodes.find((n) => n.id === a.id);
      expect(b.x - a.x).toBeCloseTo(dx, 1); expect(b.y - a.y).toBeCloseTo(dy, 1);
    }
    await screenshot('A-project-dragged');
    await page.locator('#boardViewBtn').click(); await page.locator('#boardViewBtn').click();
    const reopened = await page.evaluate(() => ({ groups: CrewMap.layout().groups.map((g) => [g.key, g.x, g.y]), positions: config.crewMap.projectPositions }));
    await page.reload(); await expect(page.locator('#crewMap')).toBeVisible();
    expect(await page.evaluate(() => ({ groups: CrewMap.layout().groups.map((g) => [g.key, g.x, g.y]), positions: config.crewMap.projectPositions }))).toEqual(reopened);
    await group.locator('.cm-project-toggle').click();
    await expect(group).toHaveClass(/collapsed/); await expect(page.locator('.cm-node')).toHaveCount(6);
    await screenshot('A-project-collapsed');
    await group.locator('.cm-project-toggle').click();
    await page.locator('[data-cm="return"]').click();
    await expect(page.locator('[data-cm="return"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.cm-edges .cm-edge.return.show').count()).toBeGreaterThan(0);
    await screenshot('A-return-lines-enabled');
    await page.locator('[data-cm="return"]').click();
  }
  // A manual card stays at its coordinates through refresh and reopen. 整理
  // alone discards the manual positions, then fits the clean layout again.
  const card = page.locator('.cm-node[data-node-id="v3-0"]');
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + 38, { steps: 6 }); await page.mouse.up();
  const position = await page.evaluate(() => config.crewMap.positions['v3-0']);
  expect(position).toBeTruthy();
  await resize(1440, 900);
  // ResizeObserver replaces cards on the next frame; wait for the attached
  // rendered card rather than reading offsetLeft from a detached old handle.
  await expect.poll(() => card.evaluate((n) => ({ connected: n.isConnected, x: n.offsetLeft, y: n.offsetTop }))).toEqual({ connected: true, ...position });
  await resize(1920, 1080);
  await page.evaluate(() => { MainSession.state().tasks.find((t) => t.colId === 'v3-2').status = 'asking'; CrewMap.refresh(); });
  await page.locator('#boardViewBtn').click(); await page.locator('#boardViewBtn').click();
  await expect.poll(() => card.evaluate((n) => ({ connected: n.isConnected, x: n.offsetLeft, y: n.offsetTop }))).toEqual({ connected: true, ...position });
  await screenshot(`${scenario}-card-position-preserved`);
  await page.locator('[data-cm="relayout"]').click();
  expect(await page.evaluate(() => [config.crewMap.positions, config.crewMap.projectPositions])).toEqual([{}, {}]);
  await settled();
  await assertLayout(); await screenshot(`${scenario}-arranged`);
  await page.locator('#navCollapseBtn').click();
  await expect(page.locator('#boardViewBtn')).toBeVisible();
  const collapsedToolbar = await page.locator('#tbLeft > button').evaluateAll((nodes) => nodes.filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.id));
  expect(collapsedToolbar.slice(0, 3)).toEqual(['boardViewBtn', 'navExpandBtn', 'quotaRailBtn']);
  expect(errors).toEqual([]);
});
