const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../../shared-store');
const { startSyncServer } = require('../../sync-server');

// The sidebar gives its height to the session list: the primary entries in two columns
// (icons only when a name would be cut), 两机 on one line with its details beside the
// sidebar. Stand-in PTYs, an isolated profile and a local sync service only.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const TOKEN = 'e2e-sidebar-compact';
const ENTRIES = ['new', 'captain', 'attention', 'tasks', 'todo', 'schedule', 'artifacts', 'skills'];
// The other computer is of the other kind, so the line names one Mac and one Windows wherever this runs.
const OTHER = process.platform === 'win32' ? { platform: 'darwin', name: 'studio-mac' } : { platform: 'win32', name: 'owen-pc' };
let application, page, root, server, store, shots;
const errors = [];
test.describe.configure({ mode: 'serial' });

const shot = async (name) => { if (shots) await page.locator('#colNav').screenshot({ path: path.join(shots, name + '.png') }); };
const setNavWidth = (w) => page.evaluate((width) => { config.navWidth = width; applyNavWidth(); }, w);
const topMode = () => page.evaluate(() => document.getElementById('navTop').classList.contains('nav-icons') ? 'icons' : 'columns');
const entryBoxes = () => page.evaluate(() => [...document.querySelectorAll('#navTop .nav-row')].map((b) => {
  const r = b.getBoundingClientRect();
  const label = b.querySelector('.nav-row-label');
  return { nav: b.dataset.nav, x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: r.height, right: r.right,
    title: b.title, aria: b.getAttribute('aria-label') || '', labelShown: !!label.offsetWidth, cut: label.scrollWidth > label.clientWidth };
}));

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidebar-compact-'));
  shots = process.env.AGENTDECK_SCREENSHOT_DIR || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  store.heartbeat({ id: 'dev-other', name: OTHER.name, platform: OTHER.platform, version: '2.0.4' });
  ['/LOGIN', '永动机', '永动机：每晚复盘', '永动机：派活', '永动机：看板巡检'].forEach((summary, i) => store.pushHistory({
    opId: 'op-compact-hist-' + i, sessionId: 'cap-other-' + i, deviceId: 'dev-other',
    contentHash: crypto.createHash('sha256').update(summary + i).digest('hex'),
    // each its own time, /LOGIN the newest though the hub got it first: the popup sorts by time
    startedAt: new Date(Date.now() - i * 60000).toISOString(), endedAt: null, summary, turns: [{ prompt: summary, reply: 'ok' }],
  }));
  server = await startSyncServer({ store, token: TOKEN });
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const now = Date.now();
  // twelve things wait on the user (a two-digit count) and one report is unread (the dot)
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `at-need-${1000 + i}`, kind: 'need', type: 'question', title: `问题 ${i + 1}`, ask: '要不要', created: now - i * 1000 }));
  items.push({ id: 'at-report-0001', kind: 'report', title: '做完了', created: now });
  const crew = ['查修侧栏队员', '省钱中心通知清理', '归档不设上限', '手机输入栏钉在底部', '图标按钮', '看板巡检'];
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 252,
    attention: { version: 1, items },
    columns: [
      { id: 'cap', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      ...crew.map((title, i) => ({ id: `w${i}`, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true })),
    ],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: crew.map((title, i) => ({ id: `t${i}`, colId: `w${i}`, title, status: 'working', sentAt: now - i * 60000, gen: 1 })) },
  }));
  const env = { ...process.env, AGENTDECK_FLEET_URL: server.url, AGENTDECK_FLEET_TOKEN_FILE: tokenFile, AGENTDECK_FLEET_SYNC_MS: '300', AGENTDECK_FLEET_START_DELAY_MS: '300' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST') && !key.startsWith('AGENTDECK_FLEET_')) delete env[key];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(7);
  await page.evaluate(() => window.deck.todos('add', { text: '补深色主题' }));
  await expect(page.locator('#todoBtn .nav-row-count')).toHaveText('1');
  await expect(page.locator('#fleetStatus [data-device-id="dev-other"]')).toHaveAttribute('data-online', 'true', { timeout: 20000 });
});
test.afterAll(async () => {
  expect(errors).toEqual([]);
  if (application) await closeElectron(application);
  if (server) await server.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('the primary entries sit in two columns, named and reachable by keyboard, with 搜索 across both under them', async () => {
  await expect(page.locator('#attentionBtn .nav-row-badge')).toHaveText('12');
  await expect(page.locator('#attentionBtn .nav-row-dot')).toBeVisible();
  await expect.poll(topMode).toBe('columns');
  const boxes = await entryBoxes();
  expect(boxes.map((b) => b.nav)).toEqual(ENTRIES);
  // four rows of two, in the order above
  for (let i = 0; i < boxes.length; i += 2) {
    expect(boxes[i].y).toBe(boxes[i + 1].y);
    expect(boxes[i].x).toBeLessThan(boxes[i + 1].x);
  }
  expect(new Set(boxes.map((b) => b.y)).size).toBe(4);
  for (const b of boxes) {
    expect(b.labelShown && !b.cut, `${b.nav} shows its whole name`).toBe(true);
    expect(b.title, `${b.nav} tooltip`).toBeTruthy();
    expect(b.aria, `${b.nav} accessible name`).toBeTruthy();
    expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(28);
  }
  // the counts stay inside their entry
  for (const sel of ['#attentionBtn .nav-row-badge', '#todoBtn .nav-row-count']) {
    const badge = await page.locator(sel).boundingBox();
    const entry = await page.locator(sel).locator('xpath=..').boundingBox();
    expect(badge.x + badge.width).toBeLessThanOrEqual(entry.x + entry.width);
  }
  // 搜索 is one row across both columns, right under the entries
  const search = await page.locator('#navTop .nav-search').boundingBox();
  const last = boxes[boxes.length - 1];
  expect(search.y).toBeGreaterThan(last.y);
  expect(search.width).toBeGreaterThan(boxes[0].w * 1.9);
  expect((await page.locator('#navTop > *').evaluateAll((n) => n.map((x) => x.dataset.nav || x.id)))).toEqual([...ENTRIES, 'navSearchSlot']);
  // five rows in all, where there were nine
  expect((await page.locator('#navTop').boundingBox()).height).toBeLessThanOrEqual(5 * 34 + 10);
  // Tab walks the entries in reading order, with a visible focus ring; Enter opens one
  await page.locator('#navTop .nav-row[data-nav="tasks"]').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.dataset.nav)).toBe('todo');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#pageView .page-titles h1')).toHaveText('待办');
  await page.locator('#todoBtn').click();
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await shot('compact-columns-dark');
});

test('两机 is one line; the computers, the whole message and the captain records open beside the sidebar', async () => {
  const fleet = page.locator('#fleetStatus');
  const line = fleet.locator('.fleet-line');
  const detail = fleet.locator('.fleet-detail');
  expect((await fleet.boundingBox()).height).toBeLessThanOrEqual(40);
  expect((await line.locator('.fleet-chip-name').allInnerTexts()).sort()).toEqual(['Mac', 'Windows']);
  await expect(fleet.locator('.fleet-chip.online')).toHaveCount(2);
  await expect(line).toHaveAttribute('aria-label', /两机：/);
  // the records are not in the sidebar any more
  await expect(detail).toBeHidden();
  await expect(fleet.locator('.fleet-history')).toHaveCount(5);
  // hover shows the detail beside the sidebar; leaving hides it
  await line.hover();
  await expect(detail).toBeVisible();
  const nav = await page.locator('#colNav').boundingBox();
  const box = await detail.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(nav.x + nav.width);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await expect(detail.locator('.fleet-row')).toHaveCount(2);
  await expect(detail.locator('.fleet-row.self')).toContainText('在线');
  await expect(detail.locator('.fleet-history-head')).toHaveText('队长记录');
  await expect(detail.locator('.fleet-history').first()).toHaveText(/^\/LOGIN · /);
  await page.mouse.move(900, 300);
  await expect(detail).toBeHidden();
  // a click keeps it open through the refreshes until Esc
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.move(900, 300);
  await page.waitForTimeout(3500);
  await expect(detail).toBeVisible();
  await expect(line).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  // reaching it with the keyboard shows it too (Shift+Tab from the quota refresh, the next stop)
  await page.locator('#quotaRefresh').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(line).toBeFocused();
  await expect(detail).toBeVisible();
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await expect(detail).toBeHidden();
  // the service fails: the line says so in one word, the detail has the whole message
  await server.close();
  server = null;
  await expect(line.locator('.fleet-line-state.error')).toHaveText('同步失败', { timeout: 15000 });
  await expect(fleet.locator('.fleet-notice.error')).toContainText('同步失败：');
  expect((await fleet.boundingBox()).height).toBeLessThanOrEqual(40);
  await shot('compact-fleet-error-dark');
});

test('a narrow sidebar or a bigger sidebar font shows the entries as icons, still named and big enough to click', async () => {
  await setNavWidth(200);
  await expect.poll(topMode).toBe('icons');
  const boxes = await entryBoxes();
  expect(new Set(boxes.map((b) => b.y)).size).toBe(2);
  for (const b of boxes) {
    expect(b.labelShown).toBe(false);
    expect(b.title && b.aria).toBeTruthy();
    expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(28);
  }
  // counts stay visible on the icons' corners, inside the entry
  for (const sel of ['#attentionBtn .nav-row-badge', '#todoBtn .nav-row-count']) {
    await expect(page.locator(sel)).toBeVisible();
    const badge = await page.locator(sel).boundingBox();
    const entry = await page.locator(sel).locator('xpath=..').boundingBox();
    expect(badge.x).toBeGreaterThanOrEqual(entry.x);
    expect(badge.x + badge.width).toBeLessThanOrEqual(entry.x + entry.width);
  }
  // nothing in the sidebar runs past its edge; 两机 keeps its dots and its one line
  const overflow = await page.evaluate(() => ['navTop', 'fleetStatus'].filter((id) => { const n = document.getElementById(id); return n.scrollWidth > n.clientWidth + 1; }));
  expect(overflow).toEqual([]);
  await expect(page.locator('#fleetStatus .fleet-chip .fleet-dot')).toHaveCount(2);
  await expect(page.locator('#fleetStatus .fleet-chip-name').first()).toBeHidden();
  expect((await page.locator('#fleetStatus').boundingBox()).height).toBeLessThanOrEqual(40);
  await page.evaluate(() => applyTheme('light'));
  await shot('compact-icons-light');
  await page.evaluate(() => applyTheme('dark'));
  // back to the usual width: two columns again
  await setNavWidth(252);
  await expect.poll(topMode).toBe('columns');
  // a bigger sidebar font would cut a name at 252: icons, and back when the font returns
  await page.evaluate(() => { config.sidebarFontSize = 18; applySidebarFontSize(); });
  await expect.poll(topMode).toBe('icons');
  await page.evaluate(() => { config.sidebarFontSize = SidebarCore.FONT_DEFAULT; applySidebarFontSize(); });
  await expect.poll(topMode).toBe('columns');
});
