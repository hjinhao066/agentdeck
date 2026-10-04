const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stand-in only. The saved launch command is applied after the process starts,
// so identity is read from that command and the bare "Model: Sonnet" footer.
const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
const standIn = (label) => `node "${FAKE}" --hide-provider --model-label=${label}`;
const shots = process.env.AGENTDECK_MODEL_LABEL_SHOTS || '/Users/jinhao/reports/agentdeck-model-label';
const workers = [
  { id: 'w-sonnet', title: '永动机预激活续做', label: 'Sonnet',
    cmd: 'env CLAUDE_CONFIG_DIR=/Users/jinhao/.claude-us claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high' },
  { id: 'w-opus', title: '1.1.7 集成', label: 'Opus',
    cmd: 'env CLAUDE_CONFIG_DIR=/Users/jinhao/.claude-us claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high' },
  { id: 'w-cn', title: '手机网页额度显示续做', label: 'Sonnet',
    cmd: 'FOO=value claude --model claude-sonnet-5-5 --effort high' },
  { id: 'w-custom', title: '激活 US 席位', label: 'Other',
    cmd: 'env FOO=bar /opt/bin/my-agent --model vendor/very-long-model-v7' },
];
let application, page, profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-model-label-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, navWidth: 300, crewOpen: true,
    columns: [
      { id: 'captain', title: '队长', cmd: `node "${FAKE}" --captain-statusline`, cwd: profile, width: 460, role: 'manual', isMain: true },
      ...workers.map((w) => ({
        id: w.id, title: w.title, displayTitle: w.title, manualTitle: true,
        cmd: standIn(w.label), cwd: profile, width: 460, role: 'manual', captainCrew: true,
        claudeSeatId: 'cn', claudeConfigDir: '~/.claude',
      })),
    ],
    mainSession: {
      colId: 'captain', cmd: `node "${FAKE}" --captain-statusline`, gen: 1, pending: [], inflight: [],
      fresh: false, crewMarked: true, waitlist: [], tasks: [],
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
  await expect(page.locator('.column')).toHaveCount(5);
  await expect.poll(() => page.evaluate(() => [...terms.values()].filter((t) => /Model: (Sonnet|Opus|Other)/.test(t.lastScreen || '')).length), { timeout: 20000 }).toBe(4);
  await page.evaluate((list) => {
    for (const worker of list) {
      const col = columns.find((c) => c.id === worker.id);
      col.cmd = worker.cmd;
      col.agentProvider = '';
      col.agentModel = worker.label;
      col.claudeSeatId = 'cn';
      col.claudeConfigDir = '~/.claude';
    }
    config.crewOpen = true;
    config.navWidth = 300;
    applyNavWidth();
    Sidebar.render();
  }, workers);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 860));
});

test.afterAll(async () => {
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('env-prefixed launches show the full model and seat instead of an unrecognized group', async () => {
  await page.waitForTimeout(1500);
  await expect(page.locator('.nav-crew .crew-model-name', { hasText: '未识别' })).toHaveCount(0);
  const sonnet = page.locator('.nav-crew .crew-model').filter({ has: page.locator('.crew-model-name', { hasText: /^Sonnet 5\.5$/ }) });
  await expect(sonnet).toHaveCount(2);
  await expect(sonnet.filter({ has: page.locator('.crew-model-flag', { hasText: '🇺🇸' }) })).toHaveCount(1);
  await expect(sonnet.filter({ has: page.locator('.crew-model-flag', { hasText: '🇨🇳' }) })).toHaveCount(1);
  const opus = page.locator('.nav-crew .crew-model').filter({ has: page.locator('.crew-model-name', { hasText: 'Opus 5.5' }) });
  await expect(opus).toHaveCount(1);
  await expect(opus.locator('.crew-model-flag')).toHaveText('🇺🇸');
  await expect(page.locator('.nav-crew .crew-model-name', { hasText: 'my-agent · vendor/very-long-model-v7' })).toHaveCount(1);

  const header = page.locator('.column[data-col-id="w-sonnet"] .col-badge');
  await expect(header.locator('.agent-model-label')).toHaveText('Sonnet 5.5');
  await expect(header.locator('.agent-seat-label')).toHaveAttribute('aria-label', /US/);
  await expect(header).toHaveAttribute('title', /Sonnet 5\.5/);
  const custom = page.locator('.column[data-col-id="w-custom"] .col-badge');
  await expect(custom.locator('.agent-model-label')).toHaveText('vendor/very-long-model-v7');

  fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((name) => applyTheme(name), theme);
    await page.evaluate(() => { document.getElementById('navList').scrollTop = 0; });
    await page.locator('#colNav').screenshot({ path: path.join(shots, `after-sidebar-${theme}.png`) });
  }
});
