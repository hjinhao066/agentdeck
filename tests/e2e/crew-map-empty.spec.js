const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated deck: finished projects leave no empty frame, and project names that
// differ only by case share one box. The stand-in agent never calls a real CLI.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const shots = process.env.AGENTDECK_CREWMAP_EMPTY_SHOTS;
let application, page, profile;

async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, name + '.png'), animations: 'disabled' });
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-crewmap-empty-'));
  const now = Date.now();
  const column = (id, title, project) => ({ id, title, displayTitle: title, manualTitle: true, project, cmd: FAKE, cwd: profile, width: 460, role: 'manual', captainCrew: true });
  const task = (id, status) => ({ id: 'task-' + id, colId: id, title: id, gen: 1, status, sentAt: now, turnId: '', receipt: status === 'done' ? { summary: '已完成', files: [], explicit: true } : null });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 3,
    columns: [
      { id: 'cap', title: '队长', displayTitle: '队长', manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true },
      column('q1', '收尾一', '空项目'), column('q2', '收尾二', '空项目'),
      column('m1', '合并准备', 'agentdeck'), column('m2', '网页第一步', 'agentdeck'), column('m3', '集成说明', 'AgentDeck'),
      column('m4', '旧任务甲', 'AgentDeck'), column('m5', '旧任务乙', 'AgentDeck'),
      column('h1', '每日链接', 'hermes-savings-v2'),
    ],
    archived: [{ ...column('q3', '收尾归档', '空项目'), archivedAt: now - 3600_000 }],
    mainSession: {
      colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: [
        task('q1', 'done'), task('q2', 'stopped'), task('q3', 'done'),
        task('m1', 'working'), task('m2', 'working'), task('m3', 'working'), task('m4', 'done'), task('m5', 'done'),
        task('h1', 'working'),
      ],
    },
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env,
  });
  page = await application.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size)).toBe(9);
});

test.afterAll(async () => {
  if (application) await application.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('finished projects are absent, case variants merge, and tool actions are icon buttons', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => showView('board'));
  await expect(page.locator('.cm-project')).toHaveCount(2);
  await expect(page.locator('.cm-project[data-project="空项目"]')).toHaveCount(0);
  await expect(page.locator('.cm-project[data-project="agentdeck"]')).toHaveCount(0);
  const merged = page.locator('.cm-project[data-project="AgentDeck"]');
  await expect(merged).toBeVisible();
  await expect(merged.locator('.cm-project-name')).toHaveText('AgentDeck');
  await expect(merged.locator('.cm-project-summary')).toHaveText('3 干活中 · 2 已完成');
  await expect(page.locator('.cm-project[data-project="hermes-savings-v2"] .cm-project-summary')).toHaveText('1 干活中');
  await expect(page.locator('.cm-node[data-node-id="q1"], .cm-node[data-node-id="q2"], .cm-node[data-node-id="q3"]')).toHaveCount(0);
  await expect(page.locator('.cm-node[data-node-id="m1"]')).toBeVisible();
  await expect(page.locator('.cm-node[data-node-id="m4"]')).toBeVisible();

  const controls = await page.locator('.cm-controls button:visible, .cm-project-toggle, .cm-return-toggle').evaluateAll((nodes) => nodes.map((n) => ({
    label: n.getAttribute('aria-label'), title: n.title, icon: !!n.querySelector('svg'), text: n.textContent.trim(),
  })));
  expect(controls.length).toBeGreaterThan(0);
  for (const c of controls) {
    expect(c.label).toBeTruthy();
    expect(c.title).toBeTruthy();
    expect(c.icon).toBe(true);
    expect(c.text).toBe('');
  }

  await shot('dark');
  await page.evaluate(() => applyTheme('light'));
  await expect(page.locator('.cm-project')).toHaveCount(2);
  await shot('light');
  await page.evaluate(() => applyTheme('dark'));
});
