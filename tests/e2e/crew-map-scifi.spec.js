const closeElectron = require('./fixtures/close-electron');
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
  // Layout states, not a seat rotation and not interrupted jobs to resend.
  // Restart resume would start the queued rows and finish the working ones;
  // a project whose sessions are then all done leaves the map, so the tally
  // no longer matches the crew declared above.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [column('cap', '队长', { isMain: true, captainCrew: false, cmd: FAKE + ' --captain-statusline' }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => ({ id: 'task-' + c.id, colId: c.id, gen: 1, status: crew[i][2], sentAt: now - 3_600_000 + i * 240_000, doneAt: now - 60_000 + i * 1000, turnId: '', receipt: receipt(crew[i][2]) })) },
  }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  // a 2x screen, as on the MacBook these layouts were made on (the least a map shows at depends on it; crew-map-readable covers 1x)
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`, '--force-device-scale-factor=2'], env,
  });
  page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart)).toBe(false);
  await expect.poll(() => page.evaluate(() => config.perpetualCaptain && config.perpetualCaptain.enabled)).toBe(false);
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
  if (application) await closeElectron(application);
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
  if (process.env.ARCH_SCIFI_BEFORE) await shot((process.env.ARCH_SCIFI_SHOT_PREFIX || 'before') + '-dark-1920');
  if (process.env.ARCH_SCIFI_BEFORE) {
    await open(1920, 1080, 'light');
    await shot((process.env.ARCH_SCIFI_SHOT_PREFIX || 'before') + '-light-1920');
    return;
  }

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
  // Flat project panes (no backdrop blur: it costs frames on a zoomable canvas); 队长 has no aurora animation.
  const flat = await page.locator('.cm-project').first().evaluate((n) => getComputedStyle(n).backdropFilter + getComputedStyle(n, '::before').backdropFilter);
  expect(flat).not.toContain('blur');
  // (polled: a status tick may replace 队长's card between finding it and reading it)
  await expect.poll(() => page.locator('.cm-node.kind-captain').evaluate((n) => n.isConnected ? getComputedStyle(n, '::before').animationName : 'replaced')).toBe('none');
  // Icon controls keep their names, tooltips and a real hit area.
  const controls = await page.locator('.cm-controls button:not([hidden]), .cm-return-toggle, .cm-project-toggle, .cm-more').evaluateAll((list) => list.map((n) => {
    // CSS size: the project toggles live on the zoomable canvas
    return { cm: n.dataset.cm || '', label: n.getAttribute('aria-label'), title: n.title, svg: !!n.querySelector('svg'), text: n.textContent.trim(), w: n.offsetWidth, h: n.offsetHeight };
  }));
  for (const c of controls) {
    expect(c.label).toBeTruthy(); expect(c.title).toBeTruthy(); expect(Math.min(c.w, c.h)).toBeGreaterThanOrEqual(32);
    if (c.cm === 'reset') expect(c.text).toMatch(/^\d+%$/);
    else { expect(c.svg).toBe(true); expect(c.text).toBe(''); }
  }

  // 队长's tally is alive: an icon per status, large coloured numbers, and 干活中 keeps turning.
  const captain = page.locator('.cm-node.kind-captain');
  await expect(captain.locator('.cm-crest')).toHaveCount(1);
  await expect(captain.locator('.cm-line')).toHaveText('7 干活中 · 2 排队 · 2 失败 · 4 已完成');
  await expect(captain.locator('.cm-count .cm-ico svg')).toHaveCount(4);
  const tally = await captain.evaluate((n) => {
    const css = (sel, pseudo) => getComputedStyle(n.querySelector(sel), pseudo), line = n.querySelector('.cm-line');
    const inside = [...n.querySelectorAll('.cm-count, .cm-title, .cm-top, .cm-crest')].every((c) => { const a = c.getBoundingClientRect(), b = n.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom; });
    return { size: parseFloat(css('.cm-count.st-working b').fontSize), working: css('.cm-count.st-working b').color, queued: css('.cm-count.st-queued b').color, done: css('.cm-count.st-done b').color,
      spin: css('.cm-count.st-working .cm-ico svg').animationName, still: css('.cm-count.st-done .cm-ico svg').animationName,
      title: parseFloat(getComputedStyle(document.querySelector('.cm-node:not(.kind-captain) .cm-title')).fontSize), fits: line.scrollWidth <= line.clientWidth, inside };
  });
  expect(tally.size).toBeGreaterThanOrEqual(20);
  expect(tally.size).toBeGreaterThan(tally.title);
  expect(tally.fits).toBe(true);
  expect(tally.inside).toBe(true);
  expect(new Set([tally.working, tally.queued, tally.done]).size).toBe(3);
  expect(tally.spin).toBe('cm-spin');
  expect(tally.still).toBe('none');
  // Cards and project heads carry the same status icons; a working card's icon spins too.
  await expect(page.locator('.cm-node:not(.kind-captain) .cm-status .cm-ico')).toHaveCount(crew.length);
  expect(await page.locator('.cm-node.st-working:not(.kind-captain) .cm-status .cm-ico svg').first().evaluate((n) => getComputedStyle(n).animationName)).toBe('cm-spin');
  await expect(page.locator('.cm-project[data-project="agentdeck"] .cm-project-summary')).toHaveText('3 干活中 · 1 失败 · 2 已完成');
  await expect(page.locator('.cm-legend .cm-ico')).toHaveCount(5);
  // Finished cards step back without going transparent: their text stays readable.
  expect(await page.locator('.cm-node.st-done').first().evaluate((n) => getComputedStyle(n).opacity)).toBe('1');

  await shot('final-dark-1920');
  await open(1440, 900, 'dark');
  await shot('final-dark-1440');
  await open(1440, 900, 'light');
  await shot('final-light-1440');
  await open(1920, 1080, 'light');
  await shot('final-light-1920');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(1920, 1080, 'dark');
  expect((await style('.cm-pulse')).anim).toBe('none');
  expect(await page.locator('.cm-node.st-working').first().evaluate((n) => getComputedStyle(n, '::after').animationName)).toBe('none');
  expect(await page.locator('.cm-count.st-working .cm-ico svg').first().evaluate((n) => getComputedStyle(n).animationName)).toBe('none');
  expect(errors).toEqual([]);
});
