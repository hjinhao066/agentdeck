const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Battery mode, end to end. The power source is simulated: the test instance starts on AC and
// takes powerMonitor's own on-battery / on-ac events (emitted here), so nothing needs unplugging.
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
const shots = process.env.AGENTDECK_BATTERY_SHOTS;
let app, page, profile;

const power = (event) => app.evaluate(({ powerMonitor }, event) => { powerMonitor.emit(event); }, event);
const shot = async (name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); } };

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-battery-mode-'));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
    theme: 'dark', fitWindow: true, fitCols: 2,
    columns: [{ id: 'cap', title: '队长', isMain: true, cmd: FAKE, cwd: profile }],
    mainSession: { colId: 'cap', cmd: FAKE, gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] },
  }));
  const env = { ...process.env, ZDOTDIR: profile, AGENTDECK_TEST_PROMPTS_FILE: path.join(profile, 'prompts.jsonl') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENTDECK_TEST_POWER;
  app = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env,
  });
  await expect.poll(async () => {
    for (const candidate of app.windows()) {
      const ready = await candidate.evaluate(() => typeof terms !== 'undefined' && terms.get('cap')?.alive === true).catch(() => false);
      if (ready) { page = candidate; return true; }
    }
    return false;
  }, { timeout: 20000 }).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
});

test.afterAll(async () => {
  if (app) {
    const proc = app.process();
    const closed = app.close().catch(() => {});
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (proc && proc.exitCode == null) proc.kill('SIGKILL');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const snapshot = () => page.evaluate(() => ({
  active: BatteryCore.shared.active(), cap: MainCore.MAX_ACTIVE,
  power: document.documentElement.dataset.power || '', motion: document.documentElement.dataset.motion || '',
  blink: terms.get('cap').term.options.cursorBlink,
  shown: [...document.querySelectorAll('.battery-indicator')].map((b) => !b.hidden && b.offsetParent !== null),
}));

test('battery mode: plugged in nothing changes; unplugged it limits, queues, calms; plugging in restores and fills', async () => {
  test.setTimeout(120000);
  await page.evaluate(() => { MainCore.activeCrew = () => new Set(['b0', 'b1']); });

  // ---- plugged in: exactly as before ----
  await power('on-ac');
  await expect.poll(snapshot).toMatchObject({ active: false, cap: 30, power: '', motion: '', blink: true, shown: [false, false] });
  await expect(page.locator('#batteryIndicator')).toBeHidden();

  // ---- settings: 自动 by default, cap 1–10 default 3 ----
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#batteryMode')).toHaveValue('auto');
  await expect(page.locator('#batteryConcurrency')).toHaveValue('3');
  await page.locator('#batteryMode').scrollIntoViewIfNeeded();
  await shot('battery-settings.png');
  await page.locator('#batteryConcurrency').fill('11');
  await page.locator('#csSave').click();
  await expect(page.locator('#notificationSettings')).toBeVisible();          // out of range: refused
  await page.locator('#batteryConcurrency').fill('2');
  await page.locator('#csSave').click();
  await expect(page.locator('#notificationSettings')).toBeHidden();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).batteryConcurrency).toBe(2);
  expect(await snapshot()).toMatchObject({ active: false, cap: 30 });         // still plugged in

  // ---- unplug ----
  await power('on-battery');
  await expect.poll(snapshot).toMatchObject({ active: true, cap: 2, power: 'battery', motion: 'off', blink: false });
  const indicator = page.locator('#batteryIndicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('title', /同时干活的会话最多 2 个[\s\S]*不跑全量 E2E[\s\S]*光标闪烁[\s\S]*轮询放慢/);
  await expect(indicator).toHaveAttribute('aria-label', /电池供电，已启用/);
  await indicator.focus();
  await expect(indicator).toBeFocused();
  const box = await indicator.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  // The motion switch is held and says why; the user's own choice is untouched.
  await expect(page.locator('[data-motion-toggle]').first()).toHaveAttribute('aria-label', /电池供电，动效保持关闭/);
  expect(await page.evaluate(() => config.calmMotion)).toBe(false);
  await shot('battery-on-sidebar.png');

  // ---- new work past the cap waits, with the battery wording ----
  const queued = await page.evaluate((cmd) => MainSession.handle({
    action: 'main-new', id: 'q-bat', title: '电池排队甲', task: 'wait for a free slot', command: cmd,
  }, MainSession.mainCol()), FAKE);
  expect(queued.result).toContain('电池供电，稍后自动开');
  const waiting = page.locator('.task-card.st-waiting', { hasText: '电池排队甲' });
  await expect(waiting).toContainText('电池供电，稍后自动开');
  expect(await page.evaluate(() => columns.some((c) => c.displayTitle === '电池排队甲'))).toBe(false);
  // Show the Captain's conversation for the screenshot (best effort; the text above is what is asserted).
  await page.evaluate(() => { jumpToColumn('cap'); ChatUI.setMode('cap', 'chat'); });
  await waiting.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await shot('battery-queued-card.png');

  // ---- the Captain sees it in ledger and quota ----
  const ledger = await page.evaluate(async () => (await MainSession.handle({ action: 'main-ledger' }, MainSession.mainCol())).result);
  expect(ledger).toContain('电池模式：开（电池供电），同时最多 2 个会话干活（设置上限 30）');
  const quota = await page.evaluate(async () => (await MainSession.handle({ action: 'main-quota' }, MainSession.mainCol())).result);
  expect(quota).toContain('电池模式：开（电池供电）');

  // ---- plug in: back to normal at once, and the waiting session opens by itself ----
  await power('on-ac');
  await expect.poll(snapshot).toMatchObject({ active: false, cap: 30, power: '', motion: '', blink: true, shown: [false, false] });
  await expect.poll(() => page.evaluate(() => columns.some((c) => c.displayTitle === '电池排队甲')), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => config.mainSession.waitlist.length)).toBe(0);
  await expect(page.locator('[data-motion-toggle]').first()).toHaveAttribute('aria-label', /关闭动效/);
  await shot('battery-off-after-plug-in.png');

  // ---- work handed out while on battery ends with the reminder; plugged in it does not ----
  const prompts = () => (fs.existsSync(path.join(profile, 'prompts.jsonl')) ? fs.readFileSync(path.join(profile, 'prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  await expect.poll(() => prompts().some((p) => p.includes('wait for a free slot')), { timeout: 30000 }).toBe(true);
  const plain = prompts().find((p) => p.includes('wait for a free slot'));       // sent after plugging in
  expect(plain).not.toContain('当前电池供电');
  await power('on-battery');
  await expect.poll(() => page.evaluate(() => BatteryCore.shared.active())).toBe(true);
  await page.evaluate(() => { MainCore.activeCrew = () => new Set(); });
  await page.evaluate((cmd) => MainSession.handle({ action: 'main-new', id: 'q-note', title: '带提醒', task: 'edit the button', command: cmd }, MainSession.mainCol()), FAKE);
  await expect.poll(() => prompts().some((p) => p.includes('edit the button')), { timeout: 30000 }).toBe(true);
  const NOTE = '当前电池供电：不要跑全量 E2E，只跑相关单测，E2E 留到接电后';
  const noted = prompts().find((p) => p.includes('edit the button'));
  expect(noted).toContain('edit the button\n\n' + NOTE);
  expect(noted.indexOf(NOTE)).toBeLessThan(noted.indexOf('AgentDeck 约定'));   // before the receipt contract

  // ---- setting 关闭: unplugged, but nothing is limited ----
  await page.locator('#settingsBtn').click();
  await page.locator('#batteryMode').selectOption('off');
  await page.locator('#csSave').click();
  await expect(page.locator('#notificationSettings')).toBeHidden();
  await expect.poll(snapshot).toMatchObject({ active: false, cap: 30, power: '', motion: '', blink: true, shown: [false, false] });
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).batteryMode).toBe('off');
  const off = await page.evaluate(async () => (await MainSession.handle({ action: 'main-ledger' }, MainSession.mainCol())).result);
  expect(off).toContain('电池模式：关闭（设置里选了关闭）');
});
