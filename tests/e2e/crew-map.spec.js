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
      col('c2001', '实现登录接口'), col('c2002', '写注册接口'), col('c2003', '代码审查'), col('c2004', '迁移数据'),
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
});
test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const status = (id) => page.locator(`.cm-node[data-node-id="${id}"]`).getAttribute('data-status');

test('the board opens on the map: 队长 on top, a line to each session, review links, archived folded', async () => {
  await page.evaluate(() => showView('board'));
  await expect(page.locator('#crewMap')).toBeVisible();
  await expect(page.locator('.board-workspace')).toBeHidden();
  await expect(page.locator('.cm-node.kind-captain')).toHaveCount(1);
  await expect(page.locator('.cm-node.kind-worker')).toHaveCount(4);
  await expect(page.locator('.cm-edge.dispatch')).toHaveCount(4);
  await expect(page.locator('.cm-edge.review')).toHaveCount(2);
  await expect(page.locator('.cm-node[data-node-id="c2003"] .cm-role.review')).toHaveText('审查');
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
  await page.locator('#crewMapArchived').click();
  await expect(page.locator('.cm-node[data-node-id="c1999"]')).toHaveCount(0);
});

test('state changes show up on the next status tick', async () => {
  await page.evaluate(() => { MainSession.state().tasks.find((t) => t.id === 'k3').status = 'done'; });
  await expect.poll(() => status('c2003'), { timeout: 5000 }).toBe('done');
});

test('a node opens its real column; the old canvas stays one click away', async () => {
  await page.locator('.cm-node[data-node-id="c2002"]').click();
  await expect.poll(() => page.evaluate(() => [activeView, focusedId])).toEqual(['terminals', 'c2002']);
  await page.evaluate(() => showView('board'));
  await page.locator('.board-mode button[data-mode="canvas"]').click();
  await expect(page.locator('.board-workspace')).toBeVisible();
  await expect(page.locator('#crewMap')).toBeHidden();
  await page.locator('.board-mode button[data-mode="crew"]').click();
  await expect(page.locator('#crewMap')).toBeVisible();
});
