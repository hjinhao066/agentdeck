const closeElectron = require('./fixtures/close-electron');
const emulateScreen = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图 on a 1x screen (Windows at 100%), where a CSS pixel is one device pixel:
// - no word on the map (the smallest, a card's model, account, time and chips, are 11.5 on the canvas) is shown under
//   10 device px: a map that would need less on one page stands in lanes that large and scrolls;
// - the text is drawn at the scale it is shown at: at 140% the card as drawn is the card rastered afresh;
// - a window that changes once (the sidebar folded and back) glides to the new arrangement.
// Real renderer, isolated userData, PTYs running only stand-in TUIs. Every picture is kept in the test's own
// output folder, and in AGENTDECK_CREW_MAP_SHOTS when that is set.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --captain-statusline`;
const SCREEN = path.join(__dirname, 'fixtures', 'screen-agent.js');
const shots = process.env.AGENTDECK_CREW_MAP_SHOTS;
// Up to twenty-six stand-in terminals start with each test: on a busy Windows PC (ConPTY) that alone can take a minute or more.
test.describe.configure({ timeout: 240000 });
let application, page, profile;
const errors = [];
const sessionsOf = (spec) => Object.entries(spec).flatMap(([project, n]) => Array.from({ length: n }, (_, i) => [project, `${project} 第 ${i + 1} 件活`, 'working', 'Opus 5.5', 'Claude', [`⏺ 第 ${i + 1} 件活做到一半`]]));

async function launch(crew) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-map-readable-'));
  const now = Date.now();
  const specFile = path.join(profile, 'screens.json'), screens = {};
  const command = `node "${SCREEN}" "${specFile}"`;
  const column = (id, title, extra = {}) => ({ id, title, displayTitle: title, manualTitle: true, cmd: command, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const columns = [column('cap', '队长', { isMain: true, captainCrew: false, cmd: FAKE })], tasks = [];
  crew.forEach(([project, title, st, model, provider, screen], i) => {
    const sentAt = now - (120 - i * 4) * 60_000, id = 'w' + i;
    columns.push(column(id, title, { project }));
    screens[id] = { title, model, provider, screen };
    // (the first is 高优先级: its chip is among the smallest text on a card)
    tasks.push({ id: 'task-' + id, colId: id, gen: 1, status: st, title, project, sentAt, startedAt: sentAt + 30_000, doneAt: now - 3 * 60_000, turnId: '', receipt: null, important: i === 0 });
  });
  fs.writeFileSync(specFile, JSON.stringify(screens));
  // the default seat's directory records the account signed in there (no credentials): every card names it
  fs.mkdirSync(path.join(profile, 'seats-home'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'seats-home', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'agentdeck@example.test' }, hasCompletedOnboarding: true }));
  // These are layout states, not restartable tasks with a saved instruction.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, resumeOnRestart: false, theme: 'dark', fitWindow: true, fitCols: 3, columns,
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks } }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_') && !k.startsWith('AGENTDECK_TEST')) delete env[k];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow(); errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await expect.poll(() => page.evaluate(() => typeof config === 'undefined' ? null : config.resumeOnRestart), { timeout: 30000 }).toBe(false);
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 30000 }).toBe(crew.length + 1);
  await expect.poll(() => page.evaluate(() => [...terms].filter(([, t]) => !/Claude Code|OpenAI Codex/.test(t.lastScreen || '')).map(([id]) => id)), { timeout: 150000 }).toEqual([]);
}
test.afterEach(async () => {
  if (application) await closeElectron(application);
  // A force-closed Electron's helpers can still hold files in the profile for a few seconds (EPERM on Windows):
  // a temporary folder left behind is reported, it does not fail a test that passed.
  if (profile) try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch (e) { console.warn(`profile ${profile} not removed: ${e.code}`); }
  application = null;
});

async function size(width, height, theme) {
  // a 1x screen, whatever this machine's (see fixtures/screen-density)
  await emulateScreen(page, width, height, 1);
  if (theme) await page.evaluate((t) => applyTheme(t), theme);
}
async function open(width, height, theme, cards) {
  await size(width, height, theme);
  if (await page.locator('#crewMap').isVisible()) await page.locator('#boardViewBtn').click();
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('.cm-node:not(.kind-captain)')).toHaveCount(cards);
  // what this test is about: a 1x screen
  expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
}
const settled = () => expect.poll(() => page.evaluate(() => !document.querySelector('.cm-canvas.cm-smooth') && !document.querySelector('.cm-viewport.cm-moving') && ![...document.querySelectorAll('.cm-node, .cm-pane, .cm-project, .cm-edges')].some((n) => n.getAnimations().some((a) => a.effect && Number.isFinite(a.effect.getComputedTiming().iterations) && a.playState === 'running')))).toBe(true);
// Running lights stand still at one point of their cycle, so every picture shows them lit the same way (and a card
// shot twice is the same card); go lets them run again.
const still = () => page.evaluate(() => {
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
const go = () => page.evaluate(() => document.getAnimations().forEach((a) => { if (a.playState === 'paused') a.play(); }));
async function picture(name) {
  await settled();
  await page.mouse.move(2, 2);
  await still();
  const png = await emulateScreen.capture(page, { scale: 'css' });
  fs.writeFileSync(test.info().outputPath(name + '.png'), png);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), png); }
  await go();
}
// Every word on the map as it shows on the screen, in device px: each element that holds text of its own and shows,
// named by its class (or its parent's).
const typePx = () => page.evaluate(() => {
  const s = CrewMap.view().scale * devicePixelRatio;
  const own = (e) => [...e.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim());
  const kind = (e) => e.classList[0] ? '.' + e.classList[0] : `.${e.parentElement.classList[0] || e.parentElement.tagName.toLowerCase()} ${e.tagName.toLowerCase()}`;
  return [...document.querySelectorAll('.cm-canvas *')].filter((e) => own(e) && e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) > 0)
    .map((e) => { const n = e.closest('[data-node-id]'); return { kind: kind(e), what: `${n ? n.dataset.nodeId + ' ' : ''}${kind(e)} 「${e.textContent.trim().slice(0, 12)}」`, px: parseFloat(getComputedStyle(e).fontSize) * s }; });
});
const readable = (type) => { for (const t of type) expect(t.px, t.what).toBeGreaterThanOrEqual(10 - 0.01); };
const read = () => page.evaluate(() => ({ plan: CrewMap.plan(), pageFits: CrewMap.pageFits(), scale: CrewMap.view().scale, label: document.querySelector('[data-cm="reset"]').textContent }));

// the three situations of the earlier pictures, on a 1x screen
for (const [name, spec, [w, h]] of [
  ['the user\'s 2.0.0 map (11 / 3 / 1) at 1512x982', { agentdeck: 11, 秋招: 3, skills: 1 }, [1512, 982]],
  ['six projects of one or two cards at 1440x900', { alpha: 2, beta: 1, gamma: 2, delta: 1, epsilon: 2, zeta: 1 }, [1440, 900]],
  ['one project of twenty beside three small ones at 1920x1080', { big: 20, s1: 2, s2: 1, s3: 3 }, [1920, 1080]],
]) test(`1x screen: no card text under 10px, ${name}; what does not show whole that large scrolls`, async () => {
  const crew = sessionsOf(spec);
  await launch(crew);
  for (const theme of ['dark', 'light']) {
    await open(w, h, theme, crew.length); await settled();
    const g = await read(), type = await typePx();
    readable(type);
    // the smallest there are among them: a card's model, account, time and 高优 chip
    for (const k of ['.agent-model-label', '.seat-acct bdi', '.cm-time', '.cm-prio span']) expect(type.some((t) => t.kind === k), k).toBe(true);
    // as large as it may be shown, at least: 10 / 11.5 of the drawn size (124% of the map's own 100%)
    expect(g.scale).toBeGreaterThanOrEqual(10 / 11.5 - 1e-6);
    expect(g.label).toBe(`${Math.round(g.scale / 0.7 * 100)}%`);
    if (!g.pageFits) {
      // too tall at that size: lanes, from the top, scrolled to see the rest
      expect(!!g.plan.page).toBe(false);
      expect(await page.evaluate(() => document.querySelector('.cm-node.kind-captain').getBoundingClientRect().y - document.querySelector('.cm-viewport').getBoundingClientRect().y)).toBeGreaterThanOrEqual(8 - 0.5);
    }
    await picture(`page1x-${Object.values(spec).join('-')}-${w}x${h}-${theme}`);
  }
  expect(errors).toEqual([]);
});

test('1x screen: the 24-session map that stands on one row on a 2x screen is not squeezed under 10px here: lanes at 124%, scrolled, and 智能一页 says so', async () => {
  const crew = sessionsOf({ agentdeck: 15, 秋招: 3, 'kenke-auto': 2, 'fuqing-inventory': 2, 'daily-progress': 1, other: 1 });
  await launch(crew);
  // agentdeck's first card a 小队长 of the next two (the 小队长 branch's fields, put on the live columns: see crew-map-squad)
  await page.evaluate(() => { Object.assign(columns.find((c) => c.id === 'w0'), { subCaptain: true }); for (const id of ['w1', 'w2']) columns.find((c) => c.id === id).subCaptainId = 'w0'; });
  await open(1920, 1080, 'dark', crew.length); await settled();
  const g = await read();
  expect(!!g.plan.page, 'one row would need its text under 10px').toBe(false);
  expect(g.pageFits, 'not whole at that size').toBe(false);
  expect(g.label).toBe('124%');
  const type = await typePx();
  readable(type);
  for (const k of ['.agent-model-label', '.cm-time', '.cm-prio span', '.cm-lead span', '.cm-project-name', '.cm-count-label']) expect(type.some((t) => t.kind === k), k).toBe(true);
  await page.locator('[data-cm="fit"]').click(); await settled();
  await expect(page.locator('.cm-hint')).toHaveText('一页放不下：保持 124% 大小，其余部分向下滚动查看');
  // the rest is down the page: the wheel brings the lowest card up whole, still that large
  const below = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('.cm-node')].map((n) => n.getBoundingClientRect().bottom)) - document.querySelector('.cm-viewport').getBoundingClientRect().bottom);
  const down = await below();
  expect(down, 'it goes on below the page').toBeGreaterThan(0);
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, Math.ceil(down) + 12);
  await settled();
  expect(await below(), 'the lowest card shows whole').toBeLessThanOrEqual(0);
  expect((await read()).label).toBe('124%');
  await picture('page1x-24-1920x1080-dark-scrolled');
  expect(errors).toEqual([]);
});

// A zoom the user sets is theirs, under the readable size too (100% on a 1x screen puts the smallest text at 8 device px):
// it is kept, 智能一页 arranges the map for it, and one line says the smallest text is under 10px and from what zoom it is
// clear. It is said, never changed.
test('1x screen: a zoom the user sets under the readable size is kept; 智能一页 arranges for it and says the smallest text is under 10px', async () => {
  const crew = sessionsOf({ agentdeck: 11, 秋招: 3, skills: 1 });
  await launch(crew);
  await open(1512, 982, 'dark', crew.length); await settled();
  expect((await read()).scale, 'untouched: as large as keeps the text readable, or larger').toBeGreaterThanOrEqual(10 / 11.5 - 1e-6);
  const hint = () => page.evaluate(() => { const h = document.querySelector('.cm-hint'); return h.hidden ? '' : h.textContent; });
  const SMALL = '100% 下卡片上最小的字不到 10 像素，可能看不清（放大到 125% 或以上就清楚）';
  // the user zooms to 100%: the line comes up at once
  await page.locator('[data-cm="reset"]').click();
  await expect(page.locator('[data-cm="reset"]')).toHaveText('100%');
  expect.soft(await hint(), 'zoomed under the readable size: said').toBe(SMALL);
  await page.locator('[data-cm="fit"]').click(); await settled();
  const g = await read();
  expect.soft(g.label, '智能一页 keeps the zoom the user set').toBe('100%');
  expect.soft(g.scale).toBeCloseTo(0.7, 5);
  expect.soft(g.pageFits, 'at 100% this map shows whole on the page').toBe(true);
  expect.soft(await hint(), '智能一页 says it too').toBe(SMALL);
  // what it says is so: the smallest text on the map is under 10 device px at this zoom
  expect.soft(Math.min(...(await typePx()).map((t) => t.px))).toBeLessThan(10);
  await picture('page1x-11-3-1-1512x982-dark-user-100');
  // a zoom that keeps it readable says nothing
  for (let i = 0; i < 3; i++) await page.locator('[data-cm="in"]').click();
  await expect(page.locator('[data-cm="reset"]')).toHaveText('130%');
  await page.locator('[data-cm="fit"]').click(); await settled();
  expect.soft(await hint(), 'readable at 130%: nothing said about the text').not.toContain('最小的字');
  readable(await typePx());
  expect(errors).toEqual([]);
});

// How many pixels two PNG screenshots differ in (decoded in the page).
const differ = (a, b) => page.evaluate(async ([a, b]) => {
  const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
  const px = (img) => { const k = document.createElement('canvas'); k.width = img.width; k.height = img.height; const g = k.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, k.width, k.height).data; };
  const [x, y] = await Promise.all([load(a), load(b)]); const P = px(x), Q = px(y); let n = 0;
  for (let i = 0; i < P.length; i += 4) if (Math.abs(P[i] - Q[i]) + Math.abs(P[i + 1] - Q[i + 1]) + Math.abs(P[i + 2] - Q[i + 2]) > 24) n++;
  return n;
}, [a.toString('base64'), b.toString('base64')]);

test('1x screen: the text is drawn at the scale it shows at: at 140%, on arrival and zoomed in, the card as drawn is the card rastered afresh', async () => {
  const crew = sessionsOf({ alpha: 2, beta: 1 });
  await launch(crew);
  await open(1512, 982, 'dark', crew.length); await settled();
  // (3.1) the light the worker draws over the cards (a spinner, the waves) moves between two shots: the text is compared
  await page.addStyleTag({ content: '#crewMap .fx-layer { visibility: hidden !important; }' });
  const card = async () => { await page.mouse.move(2, 2); await settled(); await still(); const b = await page.locator('.cm-node:not(.kind-captain)').first().boundingBox(); return emulateScreen.capture(page, { clip: { x: b.x, y: b.y, width: b.width, height: b.height } }); };
  // drop the canvas's layer for a moment: Chromium rasters it again at the scale it is shown at
  const afresh = async () => {
    await page.evaluate(() => { const c = document.querySelector('.cm-canvas'); c.style.willChange = 'auto'; void c.offsetWidth; });
    await page.waitForTimeout(300);
    const png = await card();
    await page.evaluate(() => { document.querySelector('.cm-canvas').style.willChange = ''; });
    await page.waitForTimeout(300);
    return png;
  };
  expect((await read()).label, 'a small map arrives at 140%').toBe('140%');
  const drawn = await card(), fresh = await afresh();
  fs.writeFileSync(test.info().outputPath('crisp-140-arrival-asdrawn.png'), drawn); fs.writeFileSync(test.info().outputPath('crisp-140-arrival-afresh.png'), fresh);
  expect(await differ(drawn, fresh), 'arrived at 140%: pixels the card as drawn differs in').toBe(0);
  // at rest (no glide, drag or wheel: a session's news can start a glide on its own) the canvas has no layer of its own
  await expect.poll(() => page.evaluate(() => { const c = document.querySelector('.cm-canvas'); return c.matches('.cm-smooth, .panning .cm-canvas, .cm-moving .cm-canvas') ? 'moving' : getComputedStyle(c).willChange; }), { message: 'no layer of its own at rest' }).toBe('auto');
  await go();
  // 100%, then four steps in: 140% again, by hand
  for (const c of ['reset', 'in', 'in', 'in', 'in']) { await page.locator(`[data-cm="${c}"]`).click(); await page.waitForTimeout(150); }
  await settled();
  expect((await read()).label).toBe('140%');
  const zoomed = await card(), again = await afresh();
  fs.writeFileSync(test.info().outputPath('crisp-140-zoomed-asdrawn.png'), zoomed); fs.writeFileSync(test.info().outputPath('crisp-140-zoomed-afresh.png'), again);
  expect(await differ(zoomed, again), 'zoomed in to 140%: pixels the card as drawn differs in').toBe(0);
  expect(errors).toEqual([]);
});

test('1x screen: a window that changes once (the sidebar folded, then back) glides to the new arrangement', async () => {
  const crew = sessionsOf({ agentdeck: 11, 秋招: 3, skills: 1 });
  await launch(crew);
  await open(1512, 982, 'dark', crew.length); await settled();
  // count the moments (sampled every 10ms, frames or not) in which anything on the map is gliding: the view's own
  // glide, or frames and cards moving
  const watch = () => page.evaluate(() => { window.__glides = 0; window.__watch = setInterval(() => { if (document.querySelector('.cm-canvas.cm-smooth') || [...document.querySelectorAll('.cm-pane, .cm-node')].some((n) => n.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().iterations)))) window.__glides++; }, 10); });
  const stop = () => page.evaluate(() => { clearInterval(window.__watch); return window.__glides; });
  // (the map may keep its arrangement and its size, a window grown never shows it smaller: it moves to stay centred)
  const where = () => page.evaluate(() => { const v = CrewMap.view(); return [v.scale, v.x, v.y].map((n) => Math.round(n * 1000) / 1000).join(' '); });
  for (const button of ['#navCollapseBtn', '#navExpandBtn']) {
    const before = await where();
    await watch();
    await page.locator(button).click();
    await expect.poll(where, { timeout: 15000 }).not.toBe(before);
    await settled();
    expect(await stop(), `${button}: the map glided there`).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});
