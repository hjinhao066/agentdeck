const { test, expect, _electron: electron, request: playwrightRequest } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

// Battery mode changed from outside the desktop settings box, end to end: the phone's web service
// (api/battery, real login + CSRF) and the Captain's `settings battery` (the real board CLI, run by the
// stand-in Captain agent). Every change must take effect at once: the queue follows the new limit, the
// desktop settings box shows it, and config.json holds it. The power source is simulated (the test
// instance starts on battery); nothing here touches the user's running AgentDeck or shared boards.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --screen-only --board-probe`;
const CAPTAIN = 'battery-remote-captain';
const shots = process.env.AGENTDECK_BATTERY_SHOTS;
let application, page, profile, phone, url, csrf;

const configOnDisk = () => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'));
const results = () => {
  const file = path.join(profile, 'board-results.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};
const shot = async (name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); } };
const phoneGet = async () => (await phone.get(url + '/api/battery')).json();
const phonePost = (data) => phone.post(url + '/api/battery', { data, headers: { Origin: url, 'X-CSRF-Token': csrf } });
const opened = (title) => page.evaluate((t) => columns.some((c) => c.displayTitle === t), title);
const queueWork = (title, id) => page.evaluate(({ title, id, cmd }) => MainSession.handle({ action: 'main-new', id, title, task: 'wait for a free slot ' + title, command: cmd }, MainSession.mainCol()),
  { title, id, cmd: FAKE.replace(' --board-probe', '') });
const working = (n) => page.evaluate((n) => { MainCore.activeCrew = () => new Set(Array.from({ length: n }, (_, i) => 'w' + i)); }, n);
async function viaCaptain(args) {
  await expect.poll(() => page.evaluate((id) => { const e = terms.get(id); return e?.state === 'done' && !e.sendingPrompt && !e.injecting; }, CAPTAIN), { timeout: 20000 }).toBe(true);
  const before = results().length;
  await page.evaluate(([id, command]) => window.deck.ptyInput(id, 'BOARD ' + JSON.stringify(command) + '\r'), [CAPTAIN, args]);
  await expect.poll(() => results().length, { timeout: 20000 }).toBeGreaterThan(before);
  return results().at(-1);
}

test.beforeAll(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-battery-remote-')));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, captainTokenSaver: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 2,
    mobileWeb: { enabled: true, port, token }, batteryMode: 'auto', batteryConcurrency: 1,
    columns: [{ id: CAPTAIN, title: '队长', isMain: true, cmd: FAKE, cwd: profile }],
    mainSession: { colId: CAPTAIN, cmd: FAKE, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] },
  }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_POWER: 'battery', AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl'),
    AGENTDECK_TEST_BOARD_RESULTS_FILE: path.join(profile, 'board-results.jsonl') };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !key.startsWith('AGENTDECK_TEST_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`], env });
  await expect.poll(async () => {
    for (const candidate of application.windows()) {
      if (await candidate.evaluate((id) => typeof terms !== 'undefined' && terms.get(id)?.alive === true, CAPTAIN).catch(() => false)) { page = candidate; return true; }
    }
    return false;
  }, { timeout: 30000 }).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  url = (await page.evaluate(() => deck.mobileWebSettings())).url;
  phone = await playwrightRequest.newContext();
  const login = await phone.post(url + '/login', { data: { token }, headers: { Origin: url } });
  expect(login.status()).toBe(200);
  csrf = (await (await phone.get(url + '/api/auth')).json()).csrfToken;
});
test.afterAll(async () => {
  if (phone) await phone.dispose();
  if (application) await closeElectron(application);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('the phone and the Captain change battery mode live: the queue follows, the desktop box shows it, config.json holds it', async () => {
  test.setTimeout(150000);
  await working(1);

  // ---- what the phone reads: the real setting, the real power source ----
  expect(await phoneGet()).toEqual({ mode: 'auto', cap: 1, capMin: 1, capMax: 10, onBattery: true, active: true, boost: false, boostUntil: null, baseCap: 30, effectiveCap: 1, working: 1 });
  expect((await (await phone.get(url + '/api/info')).json()).capabilities).toContain('battery');

  // ---- new work past the limit waits ----
  const first = await queueWork('远程甲', 'q-remote-a');
  expect(first.result).toContain('电池供电，稍后自动开');
  expect(await opened('远程甲')).toBe(false);

  // ---- the desktop settings box is open while the phone raises the limit ----
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#batteryConcurrency')).toHaveValue('1');
  const raised = await phonePost({ cap: 2 });
  expect(raised.status()).toBe(200);
  expect(await raised.json()).toMatchObject({ mode: 'auto', cap: 2, active: true, effectiveCap: 2 });
  await expect(page.locator('#batteryConcurrency')).toHaveValue('2');          // the open box shows it at once
  await expect.poll(() => opened('远程甲'), { timeout: 20000 }).toBe(true);    // 1 working < new limit 2: the waiting session opens
  expect(await page.evaluate(() => config.mainSession.waitlist.length)).toBe(0);
  expect(await page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(2);
  expect(configOnDisk()).toMatchObject({ batteryMode: 'auto', batteryConcurrency: 2 });
  await expect(page.locator('#batteryIndicator')).toHaveAttribute('title', /同时最多开 2 个会话/);
  await page.locator('#batteryMode').scrollIntoViewIfNeeded();
  await shot('remote-1-desktop-box-after-phone-cap.png');
  await page.locator('#notificationSettingsClose').click();

  // ---- the Captain reads (nothing changes), then sets the limit with a command ----
  await working(2);
  await queueWork('远程乙', 'q-remote-b');
  expect(await opened('远程乙')).toBe(false);
  const read = await viaCaptain(['settings', 'battery']);
  expect(read.code).toBe(0);
  expect(read.stdout).toContain('电池模式：自动');
  expect(read.stdout).toContain('电池并发上限：2');
  expect(read.stdout).toContain('现在生效：电池供电，同时最多开 2 个会话');
  expect(read.stdout).not.toContain('已生效');
  expect(await opened('远程乙')).toBe(false);
  expect(configOnDisk().batteryConcurrency).toBe(2);

  const set = await viaCaptain(['settings', 'battery', '--cap', '3']);
  expect(set.code).toBe(0);
  expect(set.stdout).toContain('已生效并写入设置');
  expect(set.stdout).toContain('电池并发上限：3');
  await expect.poll(() => opened('远程乙'), { timeout: 20000 }).toBe(true);
  expect(configOnDisk().batteryConcurrency).toBe(3);
  expect(await phoneGet()).toMatchObject({ cap: 3, effectiveCap: 3 });          // the phone sees what the Captain set
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#batteryConcurrency')).toHaveValue('3');           // and so does the desktop box
  await page.locator('#notificationSettingsClose').click();

  // ---- 拉满强度: mode off lifts the limit, waiting work opens, the saved number survives ----
  await working(3);
  await queueWork('远程丙', 'q-remote-c');
  expect(await opened('远程丙')).toBe(false);
  const off = await phonePost({ mode: 'off' });
  expect(off.status()).toBe(200);
  expect(await off.json()).toMatchObject({ mode: 'off', cap: 3, active: false, effectiveCap: 30 });
  await expect.poll(() => opened('远程丙'), { timeout: 20000 }).toBe(true);
  expect(await page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(30);
  expect(configOnDisk()).toMatchObject({ batteryMode: 'off', batteryConcurrency: 3 });
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#batteryMode')).toHaveValue('off');
  await expect(page.locator('#batteryConcurrency')).toBeDisabled();
  await expect(page.locator('#batteryConcurrency')).toHaveValue('3');
  await page.locator('#batteryMode').scrollIntoViewIfNeeded();
  await shot('remote-2-desktop-box-after-phone-off.png');
  await page.locator('#notificationSettingsClose').click();
  await expect(page.locator('#batteryIndicator')).toBeHidden();
  expect((await viaCaptain(['settings', 'battery'])).stdout).toContain('电池模式：关（不限制）');

  // ---- and back: the Captain turns it on again, the limit applies to new work ----
  const auto = await viaCaptain(['settings', 'battery', '--mode', 'auto']);
  expect(auto.stdout).toContain('已生效并写入设置');
  await expect.poll(() => page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(3);
  expect(configOnDisk()).toMatchObject({ batteryMode: 'auto', batteryConcurrency: 3 });
  await expect(page.locator('#batteryIndicator')).toBeVisible();
  await queueWork('远程丁', 'q-remote-d');
  expect(await opened('远程丁')).toBe(false);                                   // 3 working, limit 3 again

  // ---- bad input changes nothing, on either road ----
  for (const body of [{ cap: 99 }, { cap: 0 }, { cap: 'x' }, { mode: 'maybe' }, {}, { cap: 2, command: 'x' }]) {
    expect((await phonePost(body)).status(), JSON.stringify(body)).toBe(400);
  }
  const bad = await viaCaptain(['settings', 'battery', '--cap', '99']);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('1 to 10');
  expect(configOnDisk()).toMatchObject({ batteryMode: 'auto', batteryConcurrency: 3 });
  expect(await phoneGet()).toMatchObject({ mode: 'auto', cap: 3 });
  // A phone without a login or CSRF token cannot change it.
  const stranger = await playwrightRequest.newContext();
  expect((await stranger.get(url + '/api/battery')).status()).toBe(401);
  expect((await stranger.post(url + '/api/battery', { data: { mode: 'off' }, headers: { Origin: url } })).status()).toBe(401);
  expect((await phone.post(url + '/api/battery', { data: { mode: 'off' }, headers: { Origin: url } })).status()).toBe(403);
  await stranger.dispose();
  expect(configOnDisk().batteryMode).toBe('auto');
});

const power = (event) => application.evaluate(({ powerMonitor }, event) => { powerMonitor.emit(event); }, event);

test('临时拉满: the Captain (or the phone) lifts the battery limit for a while; the battery mode stays; the desktop shows it and takes it back; plugging in ends it', async () => {
  test.setTimeout(150000);
  // State from the test above: battery mode 自动, limit 3, three working, 远程丁 still waiting.
  expect(await opened('远程丁')).toBe(false);
  expect(await phoneGet()).toMatchObject({ mode: 'auto', cap: 3, active: true, boost: false, effectiveCap: 3 });
  const read = await viaCaptain(['settings', 'battery']);
  expect(read.stdout).toContain('临时拉满：关');

  // ---- the Captain: 强度拉满 for two hours ----
  const on = await viaCaptain(['settings', 'battery', '--boost', 'on', '--for', '2h']);
  expect(on.code).toBe(0);
  expect(on.stdout).toContain('已生效并写入设置');
  expect(on.stdout).toMatch(/临时拉满：开（到 \d\d:\d\d）/);
  await expect.poll(() => opened('远程丁'), { timeout: 20000 }).toBe(true);            // waiting work opens at the normal limit
  expect(await page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(30);
  const saved = configOnDisk();
  expect(saved).toMatchObject({ batteryMode: 'auto', batteryConcurrency: 3 });         // the battery setting itself is untouched
  expect(saved.batteryBoost.until).toBeGreaterThan(Date.now() + 100 * 60000);
  expect(saved.batteryBoost.until).toBeLessThanOrEqual(Date.now() + 120 * 60000);
  const seen = await phoneGet();
  expect(seen).toMatchObject({ mode: 'auto', cap: 3, active: true, boost: true, effectiveCap: 30 });
  expect(seen.boostUntil).toBe(saved.batteryBoost.until);
  await expect(page.locator('#batteryIndicator')).toHaveAttribute('aria-label', '电池模式已临时拉满，点击调整');
  await expect(page.locator('#batteryIndicator')).toHaveAttribute('title', /已临时拉满（到 \d\d:\d\d）[\s\S]*同时最多开 30 个会话/);
  expect((await viaCaptain(['settings', 'battery'])).stdout).toMatch(/临时拉满：开/);
  expect((await viaCaptain(['ledger'])).stdout).toMatch(/电池模式：已临时拉满（到 \d\d:\d\d），同时最多开 30 个会话/);

  // ---- the desktop box shows it, with an × that takes it back ----
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#batteryBoostRow')).toBeVisible();
  await expect(page.locator('#batteryBoostText')).toContainText('已临时拉满');
  const cancel = page.locator('#batteryBoostCancel');
  await expect(cancel).toHaveAttribute('title', '取消临时拉满，恢复省电上限');
  await expect(cancel).toHaveAttribute('aria-label', '取消临时拉满，恢复省电上限');
  await expect(cancel).toHaveText('');
  expect((await cancel.boundingBox()).width).toBeGreaterThanOrEqual(24);
  await page.locator('#batteryBoostRow').scrollIntoViewIfNeeded();
  await shot('boost-1-desktop-box-on.png');
  await cancel.focus();
  await page.keyboard.press('Enter');                                                   // keyboard works too
  await expect(page.locator('#batteryBoostRow')).toBeHidden();
  expect(await page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(3);
  expect(configOnDisk().batteryBoost).toBeUndefined();
  expect(configOnDisk()).toMatchObject({ batteryMode: 'auto', batteryConcurrency: 3 });
  expect(await phoneGet()).toMatchObject({ boost: false, effectiveCap: 3 });
  await page.locator('#notificationSettingsClose').click();
  await queueWork('远程戊', 'q-remote-e');
  expect(await opened('远程戊')).toBe(false);                                           // the battery limit is back

  // ---- the phone turns it on (no end time); the Captain turns it off ----
  const phoneOn = await phonePost({ boost: true });
  expect(phoneOn.status()).toBe(200);
  expect(await phoneOn.json()).toMatchObject({ boost: true, boostUntil: null, effectiveCap: 30 });
  await expect.poll(() => opened('远程戊'), { timeout: 20000 }).toBe(true);
  expect(configOnDisk().batteryBoost).toEqual({ until: 0 });
  const captainOff = await viaCaptain(['settings', 'battery', '--boost', 'off']);
  expect(captainOff.stdout).toContain('临时拉满：关');
  await expect.poll(() => page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(3);
  expect((await phonePost({ boost: false })).status()).toBe(200);                       // off when already off is fine

  // ---- plugging in ends a boost; nothing is limiting then, so a new one is refused ----
  expect((await phonePost({ boost: true })).status()).toBe(200);
  await power('on-ac');
  await expect.poll(() => phoneGet().then((v) => v.boost)).toBe(false);
  await expect.poll(() => configOnDisk().batteryBoost, { timeout: 10000 }).toBeUndefined();
  const refused = await phonePost({ boost: true });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain('现在不需要拉满');
  const refusedCli = await viaCaptain(['settings', 'battery', '--boost', 'on']);
  expect(refusedCli.code).toBe(1);
  expect(refusedCli.stderr).toContain('现在不需要拉满');
  await power('on-battery');
  await expect.poll(() => phoneGet().then((v) => [v.onBattery, v.boost])).toEqual([true, false]);   // unplugging does not bring it back
  expect(await page.evaluate(() => MainCore.MAX_ACTIVE)).toBe(3);
});
