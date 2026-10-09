const closeElectron = require('./fixtures/close-electron');
const screenDensity = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图 · 小队长分层. A 小队长 is a session 队长 opened with `new --sub-captain` (its column has
// subCaptain: true); each session it opens carries its column id (subCaptainId) and a card in 队长's list like
// any crew. The older create-child records still count (a worker of its parent's task: parentTaskId). On the
// map the crew hangs under its 小队长 a step in, on a pocket of its own, the 小队长's own lines running down to
// each; 队长's lines go to the 小队长, not past it, and nothing a crew member hands back or asks runs back to
// 队长. Real renderer, isolated userData, PTYs running only stand-in TUIs. Every picture is kept in the test's
// own output folder, and in AGENTDECK_CREW_MAP_SHOTS when that is set.
const SCREEN = path.join(__dirname, 'fixtures', 'screen-agent.js');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --captain-statusline`;
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
// Ten stand-in terminals: on a busy Windows PC (ConPTY) they can take a minute or more to draw.
test.describe.configure({ mode: 'serial', timeout: 180000 });
let application, page, profile;
const errors = [];

const WORKING = '✻ Working… (12s · esc to interrupt)';
// [id, project, title, status of 队长's card for it (null: none), screen rows, its record]. 2.0.2 发版小队长 leads three
// sessions it opened (subCaptainId); 签名证书续期 is the create-child kind, a worker of 打包 macOS's task.
// (create-child's column ids are 'c' and the time they were made: the map lists a crew in that order)
const CREW = [
  ['lead', 'agentdeck', '2.0.2 发版小队长', 'working', ['⏺ 3 个队员在打包，Windows 包回来就合更新说明', WORKING], { subCaptain: true }],
  ['c1mac', 'agentdeck', '打包 macOS 并公证', 'working', ['⏺ notarytool 已提交，等 Apple 回执', WORKING], { subCaptainId: 'lead' }],
  ['c2win', 'agentdeck', '打包 Windows 安装包', 'done', ['⏺ 已交给小队长'], { subCaptainId: 'lead' }],
  ['c3notes', 'agentdeck', '写 2.0.2 更新说明', 'asking', ['⏺ 问小队长：更新说明要不要写 Windows 已知问题？'], { subCaptainId: 'lead' }],
  ['c4cert', '', '签名证书续期', null, ['⏺ 证书 30 天后到期，先续上', WORKING], { role: 'worker', captainCrew: false, parentTaskId: 'T-c1mac', taskTitle: '签名证书续期', initialPromptSent: true }],
  ['w1', 'agentdeck', 'crew-map 横排布局重做', 'working', ['⏺ 正在跑 crew-map 端到端测试', WORKING]],
  ['w2', 'agentdeck', 'Bark 提醒去重', 'done', ['⏺ 已提交回执']],
  ['w3', 'agentdeck', '侧栏额度深色修正', 'working', ['⏺ 深色下额度条对比度调到 4.5:1', WORKING]],
  ['q1', '秋招', 'Lenovo GFLP 简历改写', 'working', ['⏺ 按 JD 关键词重写项目经历第 2 段', WORKING]],
];
const RECEIPT = {
  c2win: { summary: 'Windows 安装包已签名，SHA 写进 release-notes。', files: [], explicit: true },
  c3notes: { question: '更新说明要不要写 Windows 已知问题？', files: [] },
  w2: { summary: '同一轮只推一次，30 秒内不重复响铃。', files: [], explicit: true },
};
const SUB_FIELDS = (record) => Object.fromEntries(Object.entries(record || {}).filter(([k]) => k === 'subCaptain' || k === 'subCaptainId'));

async function launch() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-squad-'));
  const now = Date.now();
  const specFile = path.join(profile, 'screens.json'), screens = {};
  const command = `node "${SCREEN}" "${specFile}"`;
  const columns = [{ id: 'cap', title: '队长', displayTitle: '队长', manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true }];
  const tasks = [];
  CREW.forEach(([id, project, title, status, screen, record = {}], i) => {
    screens[id] = { title, model: 'Sonnet 5.5', screen };
    columns.push({ id, title, displayTitle: title, manualTitle: true, cmd: command, cwd: profile, width: 460, taskId: 'T-' + id, role: 'manual', captainCrew: true, project, ...record });
    if (!status) return;
    const sentAt = now - (90 - i * 5) * 60_000;
    // (finished a few minutes ago: one done over 10 minutes ago is archived once its terminal has been quiet a
    // minute, and on a slow machine that comes before every terminal has drawn)
    tasks.push({ id: 'task-' + id, colId: id, gen: 1, status, title, project, sentAt, startedAt: sentAt + 30_000, doneAt: now - (status === 'done' ? 3 : 40 - i) * 60_000, turnId: '',
      receipt: RECEIPT[id] || null, ...SUB_FIELDS(record) });
  });
  fs.writeFileSync(specFile, JSON.stringify(screens));
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, columns,
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks } }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart), { timeout: 30000 }).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(CREW.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Claude Code/.test(t.lastScreen || '')).length), { timeout: 120000 }).toBe(CREW.length + 1);
  // the stand-ins read as they are drawn: at work
  await expect.poll(() => page.evaluate(() => ['c1mac', 'c4cert'].map((id) => terms.get(id).state)), { timeout: 30000 }).toEqual(['working', 'working']);
  // The 小队长 branch keeps subCaptain and subCaptainId on a column when the app loads its sessions; until it is
  // merged the app drops fields it does not know, so they are put back on the live columns here, as that branch has them.
  await page.evaluate((fields) => { for (const [id, f] of fields) Object.assign(columns.find((c) => c.id === id), f); }, CREW.map((r) => [r[0], SUB_FIELDS(r[5])]).filter(([, f]) => Object.keys(f).length));
}
test.beforeAll(launch);
test.afterAll(async () => {
  if (application) await closeElectron(application);
  // A force-closed Electron's helpers can still hold files in the profile for a few seconds (EPERM on Windows):
  // a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
});

async function open(width, height, theme) {
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  // a 2x screen, as on the MacBook these layouts were made on (see fixtures/screen-density)
  await screenDensity(page, 2);
  await page.evaluate((t) => applyTheme(t), theme);
  if (!(await page.locator('#crewMap').isVisible())) await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('.cm-node:not(.kind-captain)')).toHaveCount(CREW.length);
  await settled();
}
const settled = () => expect.poll(() => page.evaluate(() => !document.querySelector('.cm-canvas.cm-smooth') && ![...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].some((n) => n.getAnimations().some((a) => a.effect && Number.isFinite(a.effect.getComputedTiming().iterations) && a.playState === 'running')))).toBe(true);
// The running lights stand still at one point of their cycle, so every picture shows them lit the same way.
async function picture(name) {
  await settled();
  await page.evaluate(() => {
    const at = { 'cm-flow': 0.3, 'cm-trail': 0.3, 'cm-spin': 0.12, 'cm-ping': 0.2, 'cm-beat': 0.3 };
    const phase = (n) => { let h = 0; for (const c of n.getAttribute('d') || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 4) * 0.17; };
    document.getAnimations().forEach((a) => {
      const target = a.effect && a.effect.target;
      if (!target || !document.getElementById('crewMap').contains(target)) return;
      const t = a.effect.getComputedTiming();
      if (t.iterations !== Infinity) { a.finish(); return; }
      a.pause();
      a.currentTime = ((at[a.animationName] == null ? 0.5 : at[a.animationName]) + (['cm-flow', 'cm-trail'].includes(a.animationName) ? phase(target) : 0)) * t.duration;
    });
  });
  const png = await page.screenshot({ animations: 'allow', scale: 'css' });
  fs.writeFileSync(test.info().outputPath(name + '.png'), png);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), png); }
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
}
const rgb = (c) => (/rgba?\(([^)]+)\)/.exec(c) || [])[1].split(',').slice(0, 3).map((v) => parseFloat(v));
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The map as it stands: its records, where everything is, what the lines and pockets are.
const read = () => page.evaluate(() => {
  const map = CrewMap.lastMap(), lay = CrewMap.layout();
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
  return {
    nodes: Object.fromEntries(map.nodes.map((n) => [n.id, { parent: n.parent, depth: n.depth, leader: n.leader, crew: n.crew, status: n.status, detail: n.detail, line: n.line, project: n.project }])),
    said: Object.fromEntries([...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => [n.dataset.nodeId, { status: n.querySelector('.cm-status-text').textContent, back: (n.querySelector('.cm-returned') || {}).title || '' }])),
    edges: map.edges.map((e) => `${e.type}:${e.from}>${e.to}`).sort(),
    boxes: Object.fromEntries([...lay.nodes].map(([id, b]) => [id, { x: b.x, y: b.y, w: b.w, h: b.h }])),
    frame: (({ x, y, w, h }) => ({ x, y, w, h }))(lay.groups.find((g) => g.key === 'agentdeck')),
    pockets: [...document.querySelectorAll('.cm-pocket')].map((p) => ({ lead: p.dataset.lead, x: +p.getAttribute('x'), y: +p.getAttribute('y'), w: +p.getAttribute('width'), h: +p.getAttribute('height'), fill: getComputedStyle(p).fill })),
    pane: getComputedStyle(document.querySelector('.cm-pane[data-project="agentdeck"]')).backgroundColor,
    squad: [...document.querySelectorAll('.cm-edge.squad')].map((p) => `${p.dataset.from}>${p.dataset.to}`).sort(),
    dispatch: [...document.querySelectorAll('.cm-edge.dispatch')].map((p) => p.dataset.to).sort(),
    returns: [...document.querySelectorAll('.cm-edge.return')].map((p) => p.dataset.from).sort(),
    chips: [...document.querySelectorAll('.cm-node .cm-lead')].map((c) => {
      const card = c.closest('.cm-node');
      return { id: card.dataset.nodeId, text: c.textContent, label: c.getAttribute('aria-label'), chip: rect(c), card: rect(card), color: getComputedStyle(c).color, bg: getComputedStyle(card).backgroundColor };
    }),
    cards: [...document.querySelectorAll('.cm-node:not(.kind-captain)')].map((n) => ({ id: n.dataset.nodeId, ...rect(n) })),
    vp: rect(document.querySelector('.cm-viewport')),
  };
});

test('a 小队长 heads its crew: the crew hangs under it a step in, on a pocket, on its 小队长\'s lines; 队长\'s lines stop at the 小队长 (both themes)', async () => {
  for (const theme of ['dark', 'light']) {
    await open(1512, 982, theme);
    const m = await read();
    // who leads whom: the 小队长's own fields (subCaptain, subCaptainId) for its three, create-child's record one level further
    expect(m.nodes.c1mac).toMatchObject({ parent: 'lead', depth: 1, project: 'agentdeck' });
    expect(m.nodes.c4cert).toMatchObject({ parent: 'c1mac', depth: 2, project: 'agentdeck' });
    expect(m.nodes.lead).toMatchObject({ leader: true, crew: 3, parent: '' });
    expect(m.nodes.c1mac).toMatchObject({ leader: true, crew: 1 });
    expect(m.nodes.c2win).toMatchObject({ status: 'done', line: 'Windows 安装包已签名，SHA 写进 release-notes。' });
    // what a crew member asks or hands back is its 小队长's: the card says so
    expect(m.nodes.c3notes).toMatchObject({ status: 'input', detail: '在问小队长' });
    expect(m.said.c3notes.status).toBe('在问小队长');
    expect(m.said.c2win.back).toBe('结果已交回小队长');
    expect(m.said.w2.back).toBe('结果已交回队长');
    // 队长's lines go to the sessions it sent; each 小队长's to its crew; only 队长's own crew report back to it
    expect(m.dispatch).toEqual(['lead', 'q1', 'w1', 'w2', 'w3']);
    expect(m.squad).toEqual(['c1mac>c4cert', 'lead>c1mac', 'lead>c2win', 'lead>c3notes']);
    expect(m.returns).toEqual(['w2']);
    // the 小队长's column: it, then its crew depth first, a row each, a step in a level
    const b = m.boxes, lead = b.lead;
    const order = ['lead', 'c1mac', 'c4cert', 'c2win', 'c3notes'];
    order.slice(1).forEach((id, i) => expect(b[id].y, id).toBeGreaterThan(b[order[i]].y));
    expect(order.map((id) => b[id].x - lead.x)).toEqual([0, 24, 48, 24, 24]);
    expect(order.map((id) => lead.x + lead.w - (b[id].x + b[id].w))).toEqual([0, 8, 16, 8, 8]);
    // the rest of the project stands beside it, the 小队长's block first
    for (const id of ['w1', 'w2', 'w3']) expect(b[id].x, id).toBeGreaterThanOrEqual(lead.x + lead.w);
    expect(Math.min(...['w1', 'w2', 'w3'].map((id) => b[id].y))).toBe(lead.y);
    // no card overlaps another, all inside the frame, all on screen
    const ids = Object.keys(b);
    for (const p of ids) for (const q of ids) if (p < q) expect(b[p].x + b[p].w <= b[q].x || b[q].x + b[q].w <= b[p].x || b[p].y + b[p].h <= b[q].y || b[q].y + b[q].h <= b[p].y, `${p} / ${q}`).toBe(true);
    for (const id of order) expect(b[id].x >= m.frame.x && b[id].x + b[id].w <= m.frame.x + m.frame.w && b[id].y + b[id].h <= m.frame.y + m.frame.h, id).toBe(true);
    for (const c of m.cards) expect(c.x >= m.vp.x - 1 && c.right <= m.vp.right + 1 && c.y >= m.vp.y - 1 && c.bottom <= m.vp.bottom + 1, c.id).toBe(true);
    // a pocket under each 小队长: from halfway down its card to under its last one, as wide as it; it shows against the frame
    expect(m.pockets.map((p) => p.lead)).toEqual(['lead', 'c1mac']);
    const [outer, inner] = m.pockets;
    expect(outer).toMatchObject({ x: lead.x, y: lead.y + lead.h / 2, w: lead.w });
    expect(outer.y + outer.h).toBe(b.c3notes.y + b.c3notes.h + 6);
    expect(inner).toMatchObject({ x: b.c1mac.x, y: b.c1mac.y + b.c1mac.h / 2, w: b.c1mac.w });
    expect(inner.y + inner.h).toBe(b.c4cert.y + b.c4cert.h + 6);
    expect(outer.fill).not.toBe(m.pane);
    // the 小队长 chip: whole inside its card, a crest and the word, readable, saying how many it leads
    expect(m.chips.map((c) => [c.id, c.text, c.label]).sort()).toEqual([['c1mac', '小队长', '小队长：带 1 个队员，挂在它下面'], ['lead', '小队长', '小队长：带 3 个队员，挂在它下面']]);
    for (const c of m.chips) {
      expect(c.chip.x >= c.card.x && c.chip.right <= c.card.right && c.chip.y >= c.card.y && c.chip.bottom <= c.card.bottom, c.id).toBe(true);
      expect(contrast(c.color, c.bg), `${c.id} ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
    await picture(`squad-1512x982-${theme}`);
  }
  expect(errors).toEqual([]);
});

test('hovering a crew member lights its whole chain, 队长 → its 小队长s → it; a card drag keeps its pocket under it', async () => {
  await open(1512, 982, 'dark');
  await page.locator('.cm-node[data-node-id="c4cert"]').hover();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.cm-lit .cm-hl-path')].map((p) => p.getAttribute('class')).sort())).toEqual(['cm-hl-path dispatch', 'cm-hl-path squad', 'cm-hl-path squad']);
  const lit = await page.evaluate(() => [...document.querySelectorAll('.cm-edge.hl')].map((p) => `${p.dataset.from}>${p.dataset.to}`).sort());
  expect(lit).toEqual([await page.evaluate(() => CrewMap.lastMap().captain.id) + '>lead', 'lead>c1mac', 'c1mac>c4cert'].sort());
  await picture('squad-hover-1512x982-dark');
  // its line follows it when it is dragged a little, and the pocket keeps to the crew under the 小队长
  await page.mouse.move(2, 2);
  const before = await read();
  const card = page.locator('.cm-node[data-node-id="c2win"]'), box = await card.boundingBox();
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + box.height / 2 + 6, { steps: 4 });
  await page.mouse.up();
  const after = await read();
  expect(after.boxes.c2win.x).toBeGreaterThan(before.boxes.c2win.x);
  const end = await page.evaluate(() => { const d = document.querySelector('.cm-edge.squad[data-to="c2win"]').getAttribute('d'); return d.trim().split(/\s+/).slice(-2).map(Number); });
  expect(end).toEqual([after.boxes.c2win.x - 2, after.boxes.c2win.y + 20]);
  expect(after.pockets[0]).toEqual(before.pockets[0]);
  // 撤销 puts it back
  await page.locator('[data-cm="undo"]').click();
  await expect.poll(async () => (await read()).boxes.c2win).toEqual(before.boxes.c2win);
  expect(errors).toEqual([]);
});
