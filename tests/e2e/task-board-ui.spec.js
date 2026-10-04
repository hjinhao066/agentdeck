const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs'), os = require('os'), path = require('path');
const { newCard } = require('../../task-board');
const ROOT = path.resolve(__dirname, '../..');
let app, page, profile, originals;
const errors = [];
test.describe.configure({ mode: 'serial' });
const project = name => page.locator('.tbv-col').filter({ has: page.getByRole('heading', { name, exact: true }) });
test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-task-ui-'));
  fs.mkdirSync(path.join(profile, 'tasks'));
  const now = new Date().toISOString();
  const card = (id, title, project, extra = {}) => ({ ...newCard({ id, title, project }, now), ...extra });
  originals = {
    AgentDeck: [card('ui-build', '合并准备', 'AgentDeck', { status: 'doing', session_id: 'ui-shell' }),
      card('ui-wait', '验收合并结果', 'AgentDeck', { depends_on: ['ui-build'], flag: 'blocked', order: 1 }),
      card('ui-done', '已完成回执通道', 'AgentDeck', { status: 'done', order: 2 })],
    Hermes: [card('ui-free', '刷新项目汇总', 'Hermes'),
      card('ui-failed', '检查云端任务', 'Hermes', { status: 'doing', flag: 'failed', latest_receipt: '测试接口不可用', order: 1 })],
  };
  for (const [name, cards] of Object.entries(originals)) {
    originals[name] = JSON.stringify({ version: 1, project: name, cards }, null, 2) + '\n';
    fs.writeFileSync(path.join(profile, 'tasks', name + '.json'), originals[name]);
  }
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark',
    columns: [{ id: 'ui-shell', title: '合并会话', cmd: '', cwd: profile, role: 'manual' }] }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  await expect(page.locator('#taskBoardBtn')).toBeVisible();
});
test.afterAll(async () => { if (app) await app.close(); if (profile) fs.rmSync(profile, { recursive: true, force: true }); });

test('opens read-only project columns with status and dependencies in both themes', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const button = page.getByRole('button', { name: '任务看板', exact: true });
  await expect(button.locator('svg')).toHaveCount(1);
  await expect(button).toHaveAttribute('title', '任务看板');
  await button.click();
  await expect(page.locator('.tbv-col')).toHaveCount(2);
  await expect(project('AgentDeck').locator('.tbv-card')).toHaveCount(3);
  await expect(project('Hermes').locator('.tbv-card')).toHaveCount(2);
  await expect(project('AgentDeck')).toContainText('进行中');
  await expect(project('AgentDeck')).toContainText('等「合并准备」完成');
  await expect(project('Hermes')).toContainText('可并行');
  await expect(project('Hermes')).toContainText('失败');
  await expect(page.locator('#taskBoardView button')).toHaveCount(3); // two sort options and close
  await expect(page.locator('#taskBoardView [draggable="true"], #taskBoardView input, #taskBoardView textarea')).toHaveCount(0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => applyTheme(t), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const colors = await page.locator('.tbv-card').first().evaluate(n => {
      const style = getComputedStyle(n); return { text: style.color, background: style.backgroundColor, width: n.clientWidth };
    });
    expect(colors.text).not.toBe(colors.background);
    expect(colors.width).toBeGreaterThan(200);
    if (process.env.AGENTDECK_TASK_BOARD_SHOTS) {
      fs.mkdirSync(process.env.AGENTDECK_TASK_BOARD_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENTDECK_TASK_BOARD_SHOTS, 'task-board-' + theme + '.png'), animations: 'disabled' });
    }
  }
  for (const [name, raw] of Object.entries(originals)) expect(fs.readFileSync(path.join(profile, 'tasks', name + '.json'), 'utf8')).toBe(raw);
  expect(errors).toEqual([]);
});

test('filters projects and closes with Escape while preserving the live terminal', async () => {
  await page.locator('#tbvProject').selectOption('Hermes');
  await expect(page.locator('.tbv-col')).toHaveCount(1);
  await expect(project('Hermes').locator('.tbv-card')).toHaveCount(2);
  await page.locator('[data-sort="order"]').click();
  await expect(project('Hermes').locator('.tbv-title')).toHaveText(['刷新项目汇总', '检查云端任务']);
  await page.locator('#tbvProject').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#taskBoardBtn')).toBeFocused();
  await page.locator('#taskBoardBtn').click();
  await page.keyboard.press('Escape'); // immediate Escape after opening
  await expect(page.locator('#taskBoardView')).toBeHidden();
  expect(await page.evaluate(() => window.deck.ptyIsAlive('ui-shell'))).toBe(true);
  expect(await page.evaluate(() => columns.map(c => c.id))).toEqual(['ui-shell']);
});

test('external archival of the selected project immediately restores all remaining projects', async () => {
  await page.locator('#taskBoardBtn').click();
  await page.locator('#tbvProject').selectOption('Hermes');
  const doc = JSON.parse(originals.Hermes);
  doc.cards.forEach(c => { c.archived = true; });
  fs.writeFileSync(path.join(profile, 'tasks', 'Hermes.json'), JSON.stringify(doc));
  await expect(page.locator('#tbvProject')).toHaveValue('');
  await expect(page.locator('.tbv-col')).toHaveCount(1);
  await expect(project('AgentDeck').locator('.tbv-card')).toHaveCount(3);
  await page.locator('#boardViewBtn').click();
  await expect(page.locator('#taskBoardView')).toBeHidden();
  await expect(page.locator('#crewMap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keyboard column navigation closes the task overlay in terminal and map views', async () => {
  for (const view of ['terminals', 'board']) {
    await page.evaluate(v => showView(v), view);
    await page.locator('#taskBoardBtn').click();
    await expect(page.locator('#taskBoardView')).toBeVisible();
    await page.keyboard.press('Meta+1');
    await expect(page.locator('#taskBoardView')).toBeHidden();
    expect(await page.evaluate(() => window.deck.ptyIsAlive('ui-shell'))).toBe(true);
  }
});
