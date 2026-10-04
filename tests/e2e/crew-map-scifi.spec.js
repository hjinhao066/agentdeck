const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The sci-fi crew map: one trunk out of 队长, a bus per project, lower projects
// routed through the gaps instead of across other projects, working lines
// flowing, finished ones dimmed. Real renderer, isolated userData, stand-in TUI.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.ARCH_SCIFI_SHOTS;
let application, page, profile;

const crew = [
  ['agentdeck', 'Windows AgentDeck 升到最新版', 'working'],
  ['agentdeck', '查清并修复队员终端不可见', 'working'],
  ['agentdeck', '额度面板：修误报已用尽+精简显示', 'done'],
  ['agentdeck', '左下角显示版本号', 'done'],
  ['agentdeck', '对话页仿 ChatGPT/Codex 设计', 'failed'],
  ['agentdeck', '审查额度面板与版本号', 'working', ['w2', 'w3']],
  ['hermes-savings', '省钱中心雷达任务注册', 'working'],
  ['hermes-savings', '订阅页补充续费提醒', 'done'],
  ['type4me-windows', '豆包切换与安装包', 'working'],
  ['health', '导入菜谱表格', 'done'],
  ['health', '盯邮件下载 ChatGPT 导出', 'working'],
  ['mac-wireguard', 'Mac WireGuard 开满一小时自动关闭', 'queued'],
  ['mac-wireguard', '核验 WireGuard 自动关闭', 'failed'],
  ['yitiaolong', '一条龙：浪前前哨站视频', 'working'],
  ['', '整理共享记忆索引', 'queued'],
];

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-arch-scifi-'));
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = crew.map(([project, title, , reviews = []], i) => column('w' + i, title, { project, reviews, cmd: FAKE + (i % 3 ? '' : ' --captain-statusline') }));
  const receipt = (status) => status === 'done' ? { summary: '已完成并推送，单测与端到端全过，截图已存档。', files: [], explicit: true }
    : status === 'failed' ? { failed: '测试环境缺少权限，需要队长处理后再继续。', files: [], explicit: true } : null;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false, cmd: FAKE + ' --captain-statusline' }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: crew[i][2], sentAt: now - 3_600_000 + i * 240_000, doneAt: now - 600_000 + i * 30_000, turnId: '', receipt: receipt(crew[i][2]) })) },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(crew.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(crew.length + 1);
}
async function open(width, height, theme) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  await page.evaluate((t) => applyTheme(t), theme);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('.cm-node')).toHaveCount(crew.length + 1);
}
async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, name + '.png') });
}

test.afterEach(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  application = null;
});

test('sci-fi crew map: bundled trunk, dispatch lines avoid other projects, motion is optional', async () => {
  await launch();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(1920, 1080, 'dark');
  await expect(page.locator('.cm-edges .cm-edge.dispatch')).toHaveCount(crew.length);
  await expect(page.locator('.cm-edges .cm-edge.review')).toHaveCount(2);
  for (const st of ['working', 'done', 'failed']) expect(await page.locator(`.cm-node[data-status="${st}"]`).count()).toBeGreaterThan(0);
  await shot(process.env.ARCH_SCIFI_SHOT_PREFIX ? process.env.ARCH_SCIFI_SHOT_PREFIX + '-dark-1920' : 'dark-1920');
  if (process.env.ARCH_SCIFI_BEFORE) return;

  // One trunk leaves 队长; every dispatch line starts at that single port.
  await expect(page.locator('.cm-edges .cm-bus.trunk')).toHaveCount(1);
  const geo = await page.evaluate(() => {
    const lay = CrewMap.layout(), map = CrewMap.lastMap();
    return { routes: CrewMapCore.routes(map, lay), groups: lay.groups.map((g) => ({ key: g.key, x: g.x, y: g.y, w: g.w, h: g.h })), nodes: [...lay.nodes].map(([id, b]) => ({ id, project: b.project })) };
  });
  const dispatch = geo.routes.filter((r) => r.type === 'dispatch');
  expect(new Set(dispatch.map((r) => r.points[0].join(','))).size).toBe(1);
  // A dispatch line only crosses the project box of the card it feeds.
  const projectOf = new Map(geo.nodes.map((n) => [n.id, n.project]));
  for (const r of dispatch) for (let k = 1; k < r.points.length; k++) {
    const [[x1, y1], [x2, y2]] = [r.points[k - 1], r.points[k]];
    for (const g of geo.groups) {
      if (g.key === projectOf.get(r.to)) continue;
      const hit = Math.max(x1, x2) > g.x + 1 && Math.min(x1, x2) < g.x + g.w - 1 && Math.max(y1, y2) > g.y + 1 && Math.min(y1, y2) < g.y + g.h - 1;
      expect(hit, `${r.to} crosses ${g.key}`).toBe(false);
    }
  }
  // Working lines flow; finished lines are thinner and dimmer than working ones.
  const style = (sel) => page.locator(sel).first().evaluate((n) => { const s = getComputedStyle(n); return { w: parseFloat(s.strokeWidth), anim: s.animationName }; });
  const working = await style('.cm-edge.dispatch.st-working'), done = await style('.cm-edge.dispatch.st-done');
  expect(done.w).toBeLessThan(working.w);
  expect((await style('.cm-pulse')).anim).not.toBe('none');
  // Glass project boxes; the project colour stays on the edges.
  const glass = await page.locator('.cm-project').first().evaluate((n) => getComputedStyle(n, '::before').backdropFilter);
  expect(glass).toContain('blur');
  // Icon controls keep their names, tooltips and a real hit area.
  const controls = await page.locator('.cm-controls button:not([hidden]), .cm-return-toggle, .cm-project-toggle').evaluateAll((list) => list.map((n) => {
    // CSS size: the project toggles live on the zoomable canvas
    return { label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), w: n.offsetWidth, h: n.offsetHeight };
  }));
  for (const c of controls) { expect(c.label).toBeTruthy(); expect(c.title).toBeTruthy(); expect(c.svg).toBe(true); expect(c.text).toBe(''); expect(Math.min(c.w, c.h)).toBeGreaterThanOrEqual(32); }

  await shot('after-dark-1920');
  await open(1440, 900, 'dark');
  await shot('after-dark-1440');
  await open(1920, 1080, 'light');
  await shot('after-light-1920');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(1920, 1080, 'dark');
  expect((await style('.cm-pulse')).anim).toBe('none');
  expect(await page.locator('.cm-node.st-working').first().evaluate((n) => getComputedStyle(n, '::after').animationName)).toBe('none');
  expect(errors).toEqual([]);
});
