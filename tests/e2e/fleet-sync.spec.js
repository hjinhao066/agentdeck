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
  const env = { ...process.env, AGENTDECK_FLEET_URL: server.url, AGENTDECK_FLEET_TOKEN_FILE: tokenFile, AGENTDECK_FLEET_SYNC_MS: '200', AGENTDECK_FLEET_START_DELAY_MS: '1000' };
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

// The 2.0.1 black window: a profile whose board has 453 cards that were never
// synced and whose state file is 6 MB. Sync starts at once (worst case); the
// deck must still come up and stay responsive while the whole board uploads.
function heavyProfile(dir, { pending, synced }) {
  const { newCard } = require('../../task-board');
  const { MUTABLE_KEYS } = require('../../shared-store');
  const pick = (card) => Object.fromEntries(MUTABLE_KEYS.filter((key) => card[key] !== undefined).map((key) => [key, card[key]]));
  const cards = [];
  for (let i = 0; i < pending + synced; i++) {
    const card = newCard({ project: 'agentdeck', title: '卡片 ' + i, detail: '说明'.repeat(1000) }, '2026-10-08T09:00:00.000Z');
    card.order = i;
    if (i >= pending) card.revision = 3;
    cards.push(card);
  }
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 'agentdeck.json'), JSON.stringify({ version: 1, project: 'agentdeck', cards }, null, 2) + '\n');
  const turns = (i) => Array.from({ length: 20 }, (_, n) => ({ prompt: `队长 ${i} 第 ${n} 轮`, reply: '回复'.repeat(500), ts: new Date(Date.UTC(2026, 9, 1, 0, i, n)).toISOString() }));
  fs.writeFileSync(path.join(dir, 'fleet-state.json'), JSON.stringify({
    bases: cards.slice(pending).map((card) => [card.id, { revision: 3, fields: pick(card) }]),
    taskOutbox: cards.slice(0, pending).map((card, i) => ({ opId: 'op-fixture-' + i, cardId: card.id, expectedRevision: 0, set: pick(card) })),
    historyOutbox: Array.from({ length: 49 }, (_, i) => ({ opId: 'op-history-' + i, sessionId: 'cap-' + i, contentHash: String(i % 10).repeat(64), turns: turns(i), summary: '' })),
    devices: [], history: [], lastSyncAt: null,
  }));
  return cards.slice(pending).map((card) => ({ opId: 'op-seed-' + card.id.slice(2), cardId: card.id, expectedRevision: 0, deviceId: 'dev-win', set: pick(card) }));
}
async function launchWithHub({ startDelayMs, prepare = () => [] }) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-e2e-'));
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  store._save = () => { store.data.seq += 1; };
  const heartbeats = [];
  const beat = store.heartbeat.bind(store);
  store.heartbeat = (body) => { if (body && body.id !== 'dev-win') heartbeats.push(Date.now()); return beat(body); };
  profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  for (const op of prepare(profile)) store.pushTask(op);
  server = await startSyncServer({ store, token: TOKEN });
  const column = { id: 'cap', title: '队长', displayTitle: '队长', manualTitle: true, cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true, captainCrew: false };
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, columns: [column],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] },
  }));
  const env = { ...process.env, AGENTDECK_FLEET_URL: server.url, AGENTDECK_FLEET_TOKEN_FILE: tokenFile, AGENTDECK_FLEET_SYNC_MS: '200', AGENTDECK_FLEET_START_DELAY_MS: String(startDelayMs) };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST') && !key.startsWith('AGENTDECK_FLEET_')) delete env[key];
  const launchedAt = Date.now();
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env,
  });
  page = await application.firstWindow();
  return { store, heartbeats, launchedAt };
}

test('a 453-card first upload with a 6 MB state neither keeps the deck from starting nor freezes it', async () => {
  test.setTimeout(120000);
  const { store, launchedAt } = await launchWithHub({ startDelayMs: 0, prepare: (dir) => heavyProfile(dir, { pending: 453, synced: 21 }) });
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(1);
  const deckMs = Date.now() - launchedAt;
  // Every page-to-main round trip stays quick while the board uploads.
  let worst = 0;
  const deadline = Date.now() + 60000;
  while (store.snapshot().cards.length < 474 && Date.now() < deadline) {
    worst = Math.max(worst, await page.evaluate(async () => { const t = performance.now(); await window.deck.fleetState(); return performance.now() - t; }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`[fleet-heavy] deck ready ${deckMs} ms after launch, upload done ${Date.now() - launchedAt} ms after launch, worst IPC round trip ${Math.round(worst)} ms`);
  expect(store.snapshot().cards.length).toBe(474);
  // Transcripts go up after the cards in the same round.
  await expect.poll(() => store.snapshot().history.length, { timeout: 15000 }).toBe(49);
  expect(worst).toBeLessThan(2000);
  await expect(page.locator('#fleetStatus .fleet-row.self')).toContainText('在线', { timeout: 15000 });
});

test('the first sync round waits for the start delay after launch', async () => {
  const { heartbeats, launchedAt } = await launchWithHub({ startDelayMs: 6000 });
  await expect.poll(() => page.evaluate(() => typeof terms !== 'undefined' && terms.size), { timeout: 20000 }).toBe(1);
  await expect.poll(() => heartbeats.length, { timeout: 20000 }).toBeGreaterThan(0);
  console.log(`[fleet-delay] first heartbeat ${heartbeats[0] - launchedAt} ms after launch`);
  expect(heartbeats[0] - launchedAt).toBeGreaterThanOrEqual(5500);
});

test.afterEach(async () => {
  if (application) await closeElectron(application);
  if (server) await server.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  application = null;
  server = null;
  root = null;
});
