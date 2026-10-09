const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The Captain's crew list opens by itself, with every model group open: at each launch,
// and again the first time the window is used on a new day. Stand-in PTYs only; the
// worker commands are identity metadata set in memory after launch (and put back on disk
// before a relaunch), so no real Cursor/Codex/Antigravity process ever starts.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const titles = ['省钱中心每日产出与通知清理', '把界面工具动作改成图标按钮', 'AgentDeck 侧边栏模型与标题修复'];
const members = [
  { cmd: 'cursor-agent --model grok-4.7-high-fast', model: 'grok-4.7-high-fast', label: 'Grok 4.7' },
  { cmd: 'agy --model gemini-3.8-flash-high', model: 'gemini-3.8-flash-high', label: 'Flash 3.8' },
  { cmd: 'codex --model gpt-6.1-sol', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
];
const WORKER_CMD = FAKE + ' --interruptible --sidebar-controls';
let application, page, profile, shots;
test.describe.configure({ mode: 'serial' });

async function launch() {
  const env = { ...process.env, AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`], env,
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(4);
  // the stand-in prints its model in a footer; give each worker the identity and model it should show
  for (const [i, m] of members.entries()) {
    await expect.poll(() => page.evaluate((id) => terms.get(id)?.lastScreen || '', `worker-${i}`), { timeout: 20000 }).toContain('Model: ');
    await page.evaluate(([id, cmd, model]) => {
      columns.find((c) => c.id === id).cmd = cmd;
      window.deck.ptyInput(id, `/model ${model}\r`);
    }, [`worker-${i}`, m.cmd, m.model]);
  }
  await expect(page.locator('.nav-crew .crew-model')).toHaveCount(3, { timeout: 15000 });
  for (const m of members) await expect(page.locator('.nav-crew .crew-model .agent-model-label', { hasText: m.label })).toHaveCount(1, { timeout: 15000 });
}
async function shot(name) {
  await page.mouse.move(800, 100);
  await page.evaluate(() => { document.getElementById('navList').scrollTop = 0; });
  await page.locator('#colNav').screenshot({ path: path.join(shots, name) });
}
const fold = () => page.locator('.captain-item .captain-fold');
const modelFolds = () => page.locator('.nav-crew .crew-model .crew-model-fold');
const rows = () => page.locator('.nav-crew .colnav-item');

async function expectEverythingOpen() {
  await expect(fold()).toHaveAttribute('aria-expanded', 'true');
  await expect(fold()).toHaveAttribute('aria-label', '收起队员列表');
  await expect(fold()).toHaveAttribute('title', '收起队员列表');
  await expect(modelFolds()).toHaveCount(3);
  for (const label of ['Grok 4.7', 'Flash 3.8', 'GPT-6.1 Sol']) {
    await expect(page.locator('.nav-crew .crew-model-fold[aria-label="收起 ' + label + '"]')).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(rows()).toHaveCount(3);
  // every member is on screen with the task it runs
  for (const [i, title] of titles.entries()) {
    const row = page.locator(`.nav-crew [data-col-id="worker-${i}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('.cn-label')).toContainText(title);
  }
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sidebar-open-'));
  shots = process.env.AGENTDECK_SCREENSHOT_DIR || path.join(profile, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const now = Date.now();
  fs.mkdirSync(path.join(profile, 'chats'));
  for (const [i, title] of titles.entries()) {
    fs.writeFileSync(path.join(profile, 'chats', `worker-${i}.json`), JSON.stringify({
      v: 1, id: `worker-${i}`, turns: [{ id: `turn-${i}`, ts: now - (i + 1) * 60000, user: title, reply: 'stand-in reply', done: true, atts: [] }],
    }));
  }
  // An older build saved the fold: it must not come back at launch.
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 252, crewOpen: false, crewModelsCollapsed: ['Flash 3.8\u001f', 'Grok 4.7\u001f'],
    columns: [
      { id: 'captain', title: '队长', cmd: FAKE + ' --captain-statusline', cwd: profile, width: 460, role: 'manual', isMain: true },
      ...titles.map((title, i) => ({ id: `worker-${i}`, title, displayTitle: title, manualTitle: true,
        cmd: WORKER_CMD, cwd: profile, width: 460, role: 'manual', captainCrew: true })),
    ],
    mainSession: { colId: 'captain', cmd: FAKE + ' --captain-statusline', gen: 1, pending: [], inflight: [],
      fresh: false, crewMarked: true, waitlist: [], tasks: titles.map((title, i) => ({
        id: `task-${i}`, colId: `worker-${i}`, title, status: 'working', sentAt: now - (3 - i) * 60000, gen: 1,
      })) },
  }));
  await launch();
});
test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('a fresh launch shows the whole crew list open, every model group open, ignoring a fold saved by an older build', async () => {
  await expectEverythingOpen();
  await expect(fold().locator('svg')).toHaveCount(1);
  await expect(fold()).toHaveText('');
  const box = await fold().boundingBox();
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(20);
  await shot('1-fresh-launch-expanded.png');
});

test('the user can fold the list and one model group; both stay folded for the rest of the day', async () => {
  await fold().click();
  await expect(rows()).toHaveCount(0);
  await expect(fold()).toHaveAttribute('aria-expanded', 'false');
  await expect(fold()).toHaveAttribute('aria-label', '展开队员列表');
  await shot('2-captain-folded.png');
  await fold().click();
  await expect(rows()).toHaveCount(3);
  await page.locator('.nav-crew .crew-model-fold[aria-label="收起 Flash 3.8"]').click();
  await expect(page.locator('.nav-crew [data-col-id="worker-1"]')).toHaveCount(0);
  await expect(rows()).toHaveCount(2);
  await shot('3-one-model-folded.png');
  // coming back to the window on the same day changes nothing
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => Sidebar.refreshCrew());
  await expect(rows()).toHaveCount(2);
  await expect(page.locator('.nav-crew .crew-model-fold[aria-label="展开 Flash 3.8"]')).toHaveAttribute('aria-expanded', 'false');
  await fold().click();
  await expect(rows()).toHaveCount(0);
});

test('the first time the window is used on a new day, the list and every group open again', async () => {
  // the Captain fold and the Flash group are both folded here
  await expect(fold()).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { crewFoldDay = '2000-01-01'; window.dispatchEvent(new Event('focus')); });
  await expectEverythingOpen();
  await shot('4-new-day-reopened.png');
  // after that, a fold holds again until the next day
  await fold().click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(rows()).toHaveCount(0);
  await fold().click();
  await expectEverythingOpen();
});

test('after an app restart the list is open again even though the fold had been saved', async () => {
  await page.locator('.nav-crew .crew-model-fold[aria-label="收起 Grok 4.7"]').click();
  await expect(rows()).toHaveCount(2);
  await fold().click();
  await expect(rows()).toHaveCount(0);
  await page.evaluate(() => flushConfig());
  await expect.poll(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
    return saved.crewModelsCollapsed.length;
  }).toBeGreaterThan(0);
  await closeElectron(application);
  application = null;
  // the identity commands were only for display: put the stand-ins back before relaunching
  const file = path.join(profile, 'config.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const col of saved.columns) if (col.id.startsWith('worker-')) col.cmd = WORKER_CMD;
  fs.writeFileSync(file, JSON.stringify(saved));
  await launch();
  await expectEverythingOpen();
  await shot('5-after-restart-expanded.png');
});
