const closeElectron = require('./fixtures/close-electron');
const emulateScreen = require('./fixtures/screen-density');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 终端架构图: drawn from 队长's own task list, the live columns and the
// archive. Columns run the stand-in agent; nothing is sent to a real CLI.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
let application, page, profile;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-crewmap-'));
  const now = Date.now();
  const col = (id, title, extra) => ({ id, title, displayTitle: title, manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra });
  const T = (id, colId, status, sentAt, extra) => ({ id, colId, title: id, gen: 1, status, sentAt: now - sentAt * 60_000, turnId: '', receipt: null, ...extra });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { id: 'cap', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      col('c2001', '实现登录接口'), col('c2002', '写注册接口'), col('c2003', '代码审查', { reviews: ['c2001', 'c2002'] }), col('c2004', '迁移数据'),
    ],
    archived: [{ ...col('c1999', '旧活'), archivedAt: now - 3600_000 }],
    mainSession: {
      colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: [
        T('k0', 'c1999', 'done', 90, { doneAt: now - 80 * 60_000, receipt: { summary: '早就做完了', files: [], explicit: true } }),
        T('k1', 'c2001', 'done', 30, { doneAt: now, receipt: { summary: '登录好了', files: ['/tmp/demo/login.js'], explicit: true } }),
        T('k2', 'c2002', 'asking', 29, { doneAt: now, receipt: { question: '用哪个库？', files: [], explicit: true } }),
        T('k4', 'c2004', 'failed', 28, { doneAt: now, receipt: { summary: '', failed: '没有权限', files: [], explicit: true } }),
        T('k3', 'c2003', 'working', 5),
      ],
    },
  }));
  fs.mkdirSync(path.join(profile, 'chats'));
  fs.writeFileSync(path.join(profile, 'chats', 'c2003.json'), JSON.stringify({ turns: [{ id: 'u1', ts: now, user: '请审查 /tmp/demo/login.js 和「写注册接口」', reply: '', done: false }] }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  page.on('dialog', (d) => d.accept());
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(5);
  // a 2x screen, as on the MacBook these layouts were made on (see fixtures/screen-density)
  await emulateScreen(page, 0, 0, 2);
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const status = (id) => page.locator(`.cm-node[data-node-id="${id}"]`).getAttribute('data-status');

test('the board opens on the map: 队长 on top, a line to each session, review links, archived folded', async () => {
  await page.evaluate(() => showView('board'));
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('.cm-node.kind-captain')).toHaveCount(1);
  await expect(page.locator('.cm-node.kind-worker')).toHaveCount(4);
  await expect(page.locator('.cm-edges .cm-edge.dispatch')).toHaveCount(4);
  await expect(page.locator('.cm-edges .cm-edge.review')).toHaveCount(2);
  // what came back to 队长: the question and the failure (the reviewed result goes through its review)
  await expect(page.locator('.cm-edges .cm-edge.return')).toHaveCount(2);
  await expect(page.locator('.cm-edges .cm-edge.return.question')).toHaveAttribute('data-from', 'c2002');
  await expect(page.locator('.cm-node[data-node-id="c2003"]')).toHaveClass(/review/);
  // no relationship labels on the cards: the lines say it
  await expect(page.locator('.cm-role, .cm-review-chip')).toHaveCount(0);
  expect(await status('c2001')).toBe('done');
  expect(await status('c2002')).toBe('input');
  expect(await status('c2003')).toBe('working');
  expect(await status('c2004')).toBe('failed');
  await expect(page.locator('.cm-node[data-node-id="c2002"] .cm-line')).toHaveText('提问：用哪个库？');
  // the reviewer sits a row below what it reviews
  const y = (id) => page.locator(`.cm-node[data-node-id="${id}"]`).evaluate((n) => n.offsetTop);
  expect(await y('c2003')).toBeGreaterThan(await y('c2001'));
  await expect(page.locator('.cm-node[data-node-id="c1999"]')).toHaveCount(0);
  await page.locator('.cm-fold').click();
  await expect(page.locator('.cm-node.archived[data-node-id="c1999"]')).toBeVisible();
  await page.locator('[data-cm="archived"]').click();
  await expect(page.locator('.cm-node[data-node-id="c1999"]')).toHaveCount(0);
});

test('state changes show up on the next status tick', async () => {
  await page.evaluate(() => { MainSession.state().tasks.find((t) => t.id === 'k3').status = 'done'; });
  await expect.poll(() => status('c2003'), { timeout: 5000 }).toBe('done');
});

test('a canvas: cards drag and stay put inside their own frame, the view pans and zooms, all kept in config', async () => {
  // 代码审查's project is one card wide (fewer than seven sessions running): the card moves a little and never leaves its frame
  const card = page.locator('.cm-node[data-node-id="c2003"]');
  const before = await card.evaluate((n) => [n.offsetLeft, n.offsetTop]);
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 90, { steps: 6 });
  await page.mouse.up();
  const after = await card.evaluate((n) => [n.offsetLeft, n.offsetTop]);
  expect(after[0]).toBeGreaterThan(before[0]);
  expect(after[1]).toBeGreaterThan(before[1]);
  expect(await page.evaluate(() => { const l = CrewMap.layout(), b = l.nodes.get('c2003'), g = l.groups.find((x) => x.key === b.project); return b.x >= g.x && b.x + b.w <= g.x + g.w && b.y >= g.y && b.y + b.h <= g.y + g.h; })).toBe(true);
  // dragging is not a click: the board stays open
  expect(await page.evaluate(() => activeView)).toBe('board');
  expect(await page.evaluate(() => config.crewMap.positions.c2003)).toEqual({ x: after[0], y: after[1] });
  const v0 = await page.evaluate(() => CrewMap.view());
  await page.locator('[data-cm="in"]').click();
  expect((await page.evaluate(() => CrewMap.view())).scale).toBeGreaterThan(v0.scale);
  const vp = await page.locator('.cm-viewport').boundingBox();
  await page.mouse.move(vp.x + 20, vp.y + vp.height - 20);
  await page.mouse.down();
  await page.mouse.move(vp.x + 120, vp.y + vp.height - 60, { steps: 5 });
  await page.mouse.up();
  const v1 = await page.evaluate(() => CrewMap.view());
  expect(await page.evaluate(() => config.crewMap.view)).toEqual(v1);
  await page.locator('[data-cm="relayout"]').click();
  expect(await page.evaluate(() => config.crewMap.positions)).toEqual({});
});

test('a node opens its real column; the board has only 队伍 / 任务看板 / Token 用量', async () => {
  await page.locator('.cm-node[data-node-id="c2002"]').click();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'c2002']);
  await page.evaluate(() => showView('board'));
  await expect(page.locator('#boardView .board-toolbar h1')).toHaveText('队伍');
  await expect(page.locator('#boardView .board-mode button')).toHaveText(['队伍', '任务看板', 'Token 用量']);
  await expect(page.locator('#boardView .board-mode button.active')).toHaveText('队伍');
  await page.locator('#boardTasksTab').click();
  await expect(page.locator('#taskBoardView .board-mode button')).toHaveText(['队伍', '任务看板', 'Token 用量']);
  await page.locator('#taskBoardView .board-mode button[data-view="crew"]').click();
  await expect(page.locator('#crewMap')).toBeVisible();
});
