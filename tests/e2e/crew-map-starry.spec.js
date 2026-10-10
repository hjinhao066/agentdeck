const closeElectron = require('./fixtures/close-electron');
const emulateScreen = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 队伍 map 3.1 (星河流光): the moving light — stars, meteors, the waves 队长's heartbeat pushes along every working
// line, the spinners and pings — is drawn by a worker on two canvases (crew-fx.js, crew-fx-worker.js); nothing in the
// map is animated by the stylesheet. So the page rests between the worker's frames (no style recalculation, no
// layout), the motion costs the renderer a few percent, and it all stops while the map is out of sight, the window is
// hidden, or motion is switched off or reduced. Inside a frame what still runs stands on top and what has ended below
// a hairline; every project keeps its own colour. Real renderer, isolated userData, stand-in agents.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
test.describe.configure({ timeout: 180000 });
let application, page, profile;

// six projects, the shape of the user's map: 10 working, 2 failed, 1 asking, the rest done
const CREW = [
  ['agentdeck', '侧栏拖动排序回弹', 'working'], ['agentdeck', '导出诊断包图标按钮', 'working'], ['agentdeck', 'Windows 安装包签名', 'failed'],
  ['agentdeck', '手机端 390 宽输入框', 'working'], ['agentdeck', '断网重连重复发送', 'asking'], ['agentdeck', '2.1 版发版说明', 'done'],
  ['health', '九月睡眠和步数周报', 'working'], ['health', '喝水提醒改两小时', 'done'],
  ['秋招', '简历项目经历', 'working'], ['秋招', '面试流程时间线', 'working'], ['秋招', '招聘页岗位列表', 'failed'], ['秋招', 'STAR 模板 10 题', 'done'],
  ['mac-env', 'Homebrew 旧版本清理', 'working'], ['mac-env', '终端字体和配色', 'done'],
  ['hermes', '邮件日报重复推送', 'working'], ['hermes', '订阅雷达空状态', 'working'], ['hermes', '定时任务迁移', 'done'],
  ['fuqing-inventory', '库存成本图横排', 'working'], ['fuqing-inventory', '出库单批量打印', 'done'],
];
const WORKING = CREW.filter(([, , s]) => s === 'working').length;
const RECEIPT = { done: '已完成实现和验证，结果已交回。', failed: '测试环境缺少权限，需要队长处理。', asking: '旧记录里的重复要一并清掉吗？' };

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-starry-'));
  const now = Date.now();
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const workers = CREW.map(([project, title], i) => column('w' + i, title, { project }));
  // layout states, not restartable tasks; motion not held still by battery mode on a Mac running on battery
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, batteryMode: 'off',
    columns: [column('cap', '队长', { isMain: true, captainCrew: false }), ...workers],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: workers.map((c, i) => { const st = CREW[i][2]; return { id: 'task-' + c.id, colId: c.id, gen: 1, status: st, sentAt: now - (90 - i * 3) * 60_000, startedAt: now - (60 - i) * 60_000, doneAt: now - (st === 'done' ? 3 : 40 - i) * 60_000, turnId: '',
        receipt: st === 'done' ? { summary: RECEIPT.done, files: [], explicit: true } : st === 'failed' ? { failed: RECEIPT.failed, files: [], explicit: true } : st === 'asking' ? { question: RECEIPT.asking, files: [] } : null }; }) },
  }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart)).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(CREW.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms].filter(([, t]) => !/Claude Code/.test(t.lastScreen || '')).length), { timeout: 120000 }).toBe(0);
  await emulateScreen(page, 1600, 1000, 2);
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect.poll(() => page.locator('#crewMap .cm-node.st-working:not(.kind-captain)').count()).toBe(WORKING);
  // the pointer off every card: a hovered card repaints under it
  await page.mouse.move(2, 2);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
  application = null;
});

const stats = () => page.evaluate(() => window.CrewFx.stats());
const framesIn = async (ms) => { const a = await stats(); await page.waitForTimeout(ms); const b = await stats(); return b.frames - a.frames; };
// the renderer's own CPU over ms, in percent of one core (Electron's own count, every renderer of the app)
async function rendererCpu(ms) {
  const cpu = () => application.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab').reduce((s, m) => s + (m.cpu.cumulativeCPUUsage || 0), 0));
  const a = await cpu(), t0 = Date.now();
  await page.waitForTimeout(ms);
  return (100 * (await cpu() - a)) / ((Date.now() - t0) / 1000);
}

test('the moving light is drawn by a worker on two canvases; nothing in the map is animated by the stylesheet', async () => {
  await launch();
  await expect(page.locator('#crewMap')).toHaveClass(/\bfx-on\b/);
  expect(await page.locator('#crewMap .fx-sky canvas').count()).toBe(2);
  expect(await page.locator('#crewMap .cm-canvas > canvas.fx-layer').count()).toBe(1);
  // a line for every working card, and 队长's trunk and bus; a spinner on every working card
  await expect.poll(async () => (await stats()).spins).toBe(WORKING);
  const s = await stats();
  expect(s.paths).toBeGreaterThanOrEqual(WORKING + 1);
  expect(s.paths).toBeLessThanOrEqual(WORKING + 3);
  // at most 16 frames a second
  const frames = await framesIn(2000);
  expect(frames).toBeGreaterThan(6);
  expect(frames).toBeLessThanOrEqual(36);
  // the SVG light of before is gone, and no animation runs in the map
  expect(await page.locator('#crewMap :is(.cm-pulse, .cm-trail, .cm-hub-beat)').count()).toBe(0);
  expect(await page.evaluate(() => { const root = document.getElementById('crewMap'); return document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && root.contains(a.effect.target) && a.effect.getComputedTiming().iterations === Infinity).map((a) => a.animationName || 'script'); })).toEqual([]);
  // the spinner's own glyph gives way to the one the worker draws; the summary's stays
  expect(await page.locator('#crewMap .cm-node.st-working:not(.kind-captain) .cm-status > .cm-ico svg').first().evaluate((n) => getComputedStyle(n).visibility)).toBe('hidden');
});

test('the page rests between the worker\'s frames, and the motion costs the renderer a few percent', async () => {
  await launch();
  await page.waitForTimeout(1500);
  // the map's own cost: what animates elsewhere in the window is held (version-progress's 实时 dot pulses a box-shadow,
  // a repaint every frame, whether the map is open or not)
  await page.evaluate(() => { const root = document.getElementById('crewMap'); document.getAnimations().forEach((a) => { const t = a.effect && a.effect.target; if (!t || !root.contains(t)) a.pause(); }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await metrics();
  await page.waitForTimeout(5000);
  const m1 = await metrics();
  // no style recalculation or layout every frame (the old SVG light: one of each every frame, ~600 in 5 s at 120 Hz);
  // what is left is the app's own status ticks and terminal redraws, a few a second
  expect(m1.RecalcStyleCount - m0.RecalcStyleCount).toBeLessThanOrEqual(60);
  expect(m1.LayoutCount - m0.LayoutCount).toBeLessThanOrEqual(60);
  const on = await rendererCpu(12000);
  await page.locator('#crewMap [data-motion-toggle]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe('off');
  const off = await rendererCpu(12000);
  console.log(`renderer CPU with the map moving ${on.toFixed(2)}%, still ${off.toFixed(2)}%`);
  expect(on - off).toBeLessThan(4);
});

test('it stops while motion is off or reduced, the map out of sight or the window hidden, and goes on after', async () => {
  await launch();
  expect(await framesIn(1500)).toBeGreaterThan(3);
  // the motion switch: one still frame, nothing more
  await page.locator('#crewMap [data-motion-toggle]').click();
  await expect.poll(async () => (await stats()).running).toBe(false);
  expect(await framesIn(1500)).toBe(0);
  await page.locator('#crewMap [data-motion-toggle]').click();
  await expect.poll(async () => (await stats()).running).toBe(true);
  // reduced motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await stats()).running).toBe(false);
  expect(await framesIn(1500)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(async () => (await stats()).running).toBe(true);
  // the board closed: the map out of sight
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeHidden();
  await expect.poll(async () => (await stats()).running).toBe(false);
  expect(await framesIn(1500)).toBe(0);
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect.poll(async () => (await stats()).running).toBe(true);
  // the window hidden (minimizing goes the same way: 'minimize' and 'restore' as 'hide' and 'show')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await expect.poll(async () => (await stats()).running).toBe(false);
  expect(await framesIn(1500)).toBe(0);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await expect.poll(async () => (await stats()).running).toBe(true);
  expect(await framesIn(1500)).toBeGreaterThan(3);
});

test('inside a frame what still runs stands on top and what has ended below a hairline; every project keeps its own colour', async () => {
  await launch();
  const frame = await page.evaluate(() => {
    const pane = document.querySelector('#crewMap .cm-pane[data-project="agentdeck"]');
    const inPane = [...document.querySelectorAll('#crewMap .cm-node:not(.kind-captain)')].filter((n) => { const a = n.getBoundingClientRect(), b = pane.getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom; });
    const split = pane.querySelector('.cm-split');
    return { rows: inPane.map((n) => ({ st: n.dataset.status, y: n.getBoundingClientRect().top })), split: split ? split.getBoundingClientRect().top : null };
  });
  const open = frame.rows.filter((r) => !['done', 'stopped', 'idle'].includes(r.st)), ended = frame.rows.filter((r) => ['done', 'stopped', 'idle'].includes(r.st));
  expect(open.length).toBe(5);
  expect(ended.length).toBe(1);
  expect(Math.max(...open.map((r) => r.y))).toBeLessThan(Math.min(...ended.map((r) => r.y)));
  expect(frame.split).not.toBeNull();
  expect(frame.split).toBeGreaterThan(Math.max(...open.map((r) => r.y)));
  expect(frame.split).toBeLessThan(Math.min(...ended.map((r) => r.y)));
  // six projects, six colours (each frame's --pc resolved), kept in the config
  const resolved = await page.evaluate(() => [...document.querySelectorAll('#crewMap .cm-pane')].map((p) => { const probe = document.createElement('i'); probe.style.color = 'var(--pc)'; p.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }));
  expect(resolved.length).toBe(6);
  expect(new Set(resolved).size).toBe(6);
  const slots = await page.evaluate(() => config.crewMap.projectSlots);
  expect(Object.values(slots).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  // a redraw does not hand out colours again
  await page.evaluate(() => window.CrewMap.render());
  expect(await page.evaluate(() => config.crewMap.projectSlots)).toEqual(slots);
});
