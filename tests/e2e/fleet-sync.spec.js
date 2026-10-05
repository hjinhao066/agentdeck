const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../../shared-store');
const { startSyncServer } = require('../../sync-server');

// Two-machine status in a real window. The sync service is local; the other
// computer is a heartbeat frozen in the past. PTYs run only the stand-in.
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const TOKEN = 'e2e-fleet-token';
let application, page, profile, server, root;

test('shows the other computer offline, a kept conflict, and a visible sync error', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-e2e-'));
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  let live = false;
  const store = new SharedStore({
    file: path.join(root, 'hub', 'store.json'),
    now: () => (live ? Date.now() : Date.parse('2026-10-01T00:00:00.000Z')),
  });
  store.heartbeat({ id: 'dev-win', name: 'Windows', platform: 'win32', version: '1.2.0' });
  store.pushTask({
    opId: 'op-e2e-create1', cardId: 'card-e2e', expectedRevision: 0, deviceId: 'dev-win',
    set: { project: 'agentdeck', title: '两机共享的任务', detail: '来自 Windows', status: 'todo' },
  });
  store.pushTask({
    opId: 'op-e2e-clash01', cardId: 'card-e2e', expectedRevision: 0, deviceId: 'dev-mac',
    set: { title: '另一份标题' },
  });
  live = true;
  server = await startSyncServer({ store, token: TOKEN });
  profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const column = { id: 'cap', title: '队长', displayTitle: '队长', manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true, captainCrew: false };
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, columns: [column],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] },
  }));
  const env = { ...process.env, AGENTDECK_FLEET_URL: server.url, AGENTDECK_FLEET_TOKEN_FILE: tokenFile, AGENTDECK_FLEET_SYNC_MS: '200' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST') && !key.startsWith('AGENTDECK_FLEET_')) delete env[key];
  const errors = [];
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env,
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(1);
  const win = page.locator('#fleetStatus [data-device-id="dev-win"]');
  await expect(win).toHaveAttribute('data-online', 'false', { timeout: 15000 });
  await expect(win).toContainText('离线');
  await expect(win).toContainText('最后在线');
  await expect(page.locator('#fleetStatus .fleet-row.self')).toContainText('在线');
  await page.locator('#taskBoardBtn').click();
  const conflict = page.locator('.tbv-card[data-card-id="card-e2e"] .tbv-tag.conflict');
  await expect(conflict).toHaveText('冲突', { timeout: 15000 });
  await expect(conflict).toHaveAttribute('title', /两机共享的任务/);
  await expect(conflict).toHaveAttribute('title', /另一份标题/);
  await server.close();
  server = null;
  await expect(page.locator('#fleetStatus .fleet-notice.error')).toContainText('同步失败', { timeout: 15000 });
  expect(errors).toEqual([]);
});

test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (server) await server.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  application = null;
  server = null;
  root = null;
});
