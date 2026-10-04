const { test, expect, _electron: electron } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --quota-probe --token-saver --interruptible --board-probe`;
const CN = 'perpetual-captain-cn';
const WORKER = 'perpetual-worker';
let application, page, profile, home;

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}
function records(name) {
  const file = path.join(profile, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}
function promptsFor(id) { return records('prompt-columns.jsonl').filter((r) => r.colId === id).map((r) => r.text); }
async function captainId() { return page.evaluate(() => config.mainSession.colId); }
async function idle(id) {
  await expect.poll(() => page.evaluate((i) => {
    const entry = terms.get(i);
    return entry?.state === 'done' && !entry.sendingPrompt && !entry.injecting &&
      ChatUI.turnsOf(i).every((turn) => turn.kind === 'task' || turn.done);
  }, id), { timeout: 20000 }).toBe(true);
}
async function screenshot(name) {
  const dir = process.env.AGENTDECK_TEST_SCREENSHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}
async function nativeUsage(id, remaining = 3) {
  await page.evaluate(([i, left]) => {
    const entry = terms.get(i);
    entry.lastOutputAt = Date.now();
    ClaudeSeats.onTick(i, entry, `Current session\n  ${100 - left}% used\n  Resets in 1h\nCurrent week (all models)\n  20% used\n  Resets in 4d\n`);
  }, [id, remaining]);
  await expect.poll(async () => {
    const value = await page.evaluate(() => window.deck.claudeSeatUsage('cn'));
    return value?.windows.find((w) => w.key === 'fiveHour')?.remaining;
  }).toBe(remaining);
}
async function boardViaAgent(id, args, expected) {
  await idle(id);
  await page.evaluate(([i, command]) => window.deck.ptyInput(i, 'BOARD ' + JSON.stringify(command) + '\r'), [id, args]);
  await expect.poll(() => page.evaluate((i) => dumpScreen(terms.get(i).term).replace(/\n/g, ''), id), { timeout: 20000 }).toContain(expected);
}
async function boardWithoutCapabilities(id, args) {
  // Only the stand-in profile's per-terminal file can recover this capability.
  // A real AgentDeck capability is removed with every inherited AGENTDECK key.
  return execFileAsync(process.execPath, [path.join(profile, 'board-control', 'tools', 'agentdeck-board.js'), ...args],
    { env: isolatedEnv({ AGENTDECK_TERMINAL_ID: id }), timeout: 20000 });
}

test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-perpetual-e2e-')));
  home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}'); // existence stand-in; never a real credential
  }
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'cn@example.test', accountUuid: 'perpetual-cn-fixture' } }));
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'us@example.test', accountUuid: 'perpetual-us-fixture' } }));
  const barkKeyFile = path.join(profile, 'bark-fixture-key.txt');
  fs.writeFileSync(barkKeyFile, 'offline-test-device');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', fitWindow: true, fitCols: 2, barkKeyFile,
    columns: [
      { id: CN, title: '队长', cmd: FAKE, cwd: profile, isMain: true, claudeSeatId: 'cn' },
      { id: WORKER, title: '不中断的队员', cmd: FAKE, cwd: profile, claudeSeatId: 'cn', captainCrew: true },
    ],
    mainSession: { colId: CN, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
    captainRelayCodex: { name: 'ChatGPT', command: FAKE + ' --provider=codex' },
  })); // No perpetual setting: enabled and 3% must be the defaults.
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env: isolatedEnv({ AGENTDECK_TEST_SEATS_ENV_FILE: path.join(profile, 'seat-env.jsonl'),
      AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompt-columns.jsonl'),
      AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') }),
  });
  if (process.env.AGENTDECK_TEST_ELECTRON_LOGS) {
    const child = application.process();
    fs.mkdirSync(process.env.AGENTDECK_TEST_ELECTRON_LOGS, { recursive: true });
    child.stderr.on('data', (chunk) => fs.appendFileSync(path.join(process.env.AGENTDECK_TEST_ELECTRON_LOGS, `${child.pid}.log`), chunk));
  }
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => promptsFor(CN).some((p) => p.startsWith('你是 AgentDeck')), { timeout: 20000 }).toBe(true);
  await idle(CN);
  await expect.poll(() => records('seat-env.jsonl').some((r) => r.colId === WORKER), { timeout: 20000 }).toBe(true);
});
test.afterEach(async () => {
  if (application) {
    const child = application.process(), force = setTimeout(() => {
      // Playwright launches this Electron in its own process group. Close its
      // helpers too, so inherited stdio cannot keep the test worker alive.
      try {
        if (process.platform === 'win32') {
          if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else process.kill(-child.pid, 'SIGKILL');
      } catch (_) {}
    }, 10000);
    try {
      if (page && !page.isClosed()) await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach((d) => d.close());
        columns.forEach((c) => window.deck.ptyKill(c.id));
      });
      await application.close();
    } finally { clearTimeout(force); }
  }
  application = null; page = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('automatic CN → US → Codex preserves worker and handoff, then returns to restored Claude while idle', async () => {
  test.setTimeout(150000);
  expect(await page.evaluate(() => config.perpetualCaptain)).toEqual({ enabled: true, threshold: 3, preferEarlier: true });
  await page.evaluate((id) => {
    config.mainSession.tasks = [{ id: 'keep-task', colId: id, title: '继续跑的任务', status: 'working', gen: 1, startedAt: Date.now() }];
    sendWhenReady(columns.find((c) => c.id === id), 'keep working', { guardUserInput: true });
    flushConfig();
  }, WORKER);
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.state, WORKER)).toBe('working');
  await screenshot('perpetual-01-cn-initial');
  await nativeUsage(CN);
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 30000 }).toBe('us');
  const usId = await captainId();
  expect(usId).not.toBe(CN);
  const usBanner = page.locator(`.column[data-col-id="${usId}"] .perpetual-relay-banner`);
  await expect(usBanner).toContainText('US');
  await expect(usBanner).toContainText('3%');
  await screenshot('perpetual-02-us-automatic');
  const board = path.join(home, '.agents', 'boards', 'agentdeck-captain-handoff.md');
  expect(fs.readFileSync(board, 'utf8')).toContain('继续跑的任务');
  expect(fs.readFileSync(board, 'utf8')).toContain('## 队长交接');
  expect(fs.readFileSync(board, 'utf8')).toContain('CN → US');
  const firstArchive = JSON.parse(fs.readFileSync(path.join(profile, 'chats', CN + '.json')));
  expect(firstArchive.captainArchive).toBe(true);
  await expect.poll(() => promptsFor(usId).some((p) => p.includes('briefing') && p.includes('读看板继续') && p.includes('重挂恰好一个后台 receipts --wait --timeout 300')), { timeout: 20000 }).toBe(true);
  await idle(usId);
  // CN's still-running worker consumes its reserve after the threshold Relay.
  // Only actual exhaustion of both seats can send the Captain to Codex.
  await nativeUsage(WORKER, 0);
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'wait for quota', { guardUserInput: true }), usId);
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 30000 }).toBe('chatgpt');
  const codexId = await captainId();
  expect(codexId).not.toBe(usId);
  const codexBanner = page.locator(`.column[data-col-id="${codexId}"] .perpetual-relay-banner`);
  await expect(codexBanner).toContainText('ChatGPT');
  await expect(codexBanner).toContainText('Claude');
  await screenshot('perpetual-03-codex-automatic');
  const secondArchive = JSON.parse(fs.readFileSync(path.join(profile, 'chats', usId + '.json')));
  expect(secondArchive.turns.some((t) => t.user === 'wait for quota' && t.interrupted)).toBe(true);
  expect(fs.readFileSync(board, 'utf8')).toContain(`上任会话：${usId}`);
  expect(fs.readFileSync(board, 'utf8')).toContain('US → ChatGPT');
  const notices = await page.evaluate((id) => ChatUI.turnsOf(id).filter((t) => t.kind === 'notice'), codexId);
  expect(notices).toHaveLength(1);
  expect(notices[0].reply).toContain('ChatGPT');
  expect(notices[0].reply).toContain('Claude');
  expect(Number.isFinite(notices[0].ts)).toBe(true);
  expect(notices[0].reply).toMatch(/\d{1,2}:\d{2}/);
  await expect.poll(() => promptsFor(codexId).some((p) => p.includes('briefing') && p.includes('重挂恰好一个后台 receipts --wait --timeout 300')), { timeout: 20000 }).toBe(true);
  await boardViaAgent(codexId, ['ledger'], '不中断的队员');
  await boardViaAgent(codexId, ['briefing'], '现在只回复一句「队长已就绪」');
  if (process.platform === 'win32') {
    // Windows has no controlling tty: a supplied column id must not recover a
    // private capability. The real Captain PTY calls above still succeed.
    await expect(boardWithoutCapabilities(codexId, ['ledger'])).rejects.toThrow(/independent|conductor-managed/);
    await expect(boardWithoutCapabilities(codexId, ['briefing'])).rejects.toThrow(/independent|conductor-managed/);
  } else {
    const fallbackLedger = await boardWithoutCapabilities(codexId, ['ledger']);
    expect(fallbackLedger.stderr).toBe('');
    expect(fallbackLedger.stdout).toContain('不中断的队员');
    const fallbackBriefing = await boardWithoutCapabilities(codexId, ['briefing']);
    expect(fallbackBriefing.stdout).toContain('读看板继续');
    expect(fallbackBriefing.stdout).toContain('receipts --wait');
  }
  const alerts = await application.evaluate(({ app }) => app.testRelayAlerts);
  expect(alerts).toHaveLength(2);
  expect(alerts.every((alert) => alert.level === 'active' && !Object.hasOwn(alert, 'volume'))).toBe(true);
  expect(alerts.map((alert) => alert.body).join('\n')).toContain('US');
  expect(alerts.map((alert) => alert.body).join('\n')).toContain('ChatGPT');
  await idle(codexId);
  // Both the in-memory observation and its fixture cache must simulate the
  // elapsed reset: periodic refresh must not restore the fixture's future time.
  const cacheFile = path.join(home, '.claude', 'agentdeck-usage.json');
  const cachedUsage = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cachedUsage.windows.forEach((window) => { window.resetText = 'in 0m'; });
  fs.writeFileSync(cacheFile, JSON.stringify(cachedUsage));
  await page.evaluate(() => {
    const now = Date.now();
    const entry = config.quotas['Claude:cn'];
    for (const window of entry.sample.windows) window.resetAt = now - 1000;
    entry.blocked.resetAt = now - 1000;
    const cn = config.perpetualCaptainState.seats.cn;
    cn.lowAt = now - 2000; cn.lowResetAt = now - 1000;
    cn.exhaustedAt = now - 2000; cn.resetAt = now - 1000;
    cn.enteredAt = now - 11 * 60000; cn.leftAt = now - 11 * 60000;
    config.perpetualCaptainState.lastSwitch.at = now - 11 * 60000;
    flushConfig();
  });
  await expect.poll(() => page.evaluate(() => ({
    target: config.mainSession.relayTargetId, idle: MainSession.relayIdle(),
    state: config.perpetualCaptainState, cnQuota: config.quotas['Claude:cn'],
  })), { timeout: 30000 }).toMatchObject({ target: 'cn' });
  const restoredId = await captainId();
  await expect(page.locator(`.column[data-col-id="${restoredId}"] .perpetual-relay-banner`)).toContainText('恢复');
  expect(await page.evaluate((id) => columns.find((c) => c.id === id).claudeSeatId, WORKER)).toBe('cn');
  expect(await page.evaluate((id) => terms.get(id)?.state, WORKER)).toBe('working');
  expect(await page.evaluate((id) => window.deck.ptyIsAlive(id), WORKER)).toBe(true);
  expect(records('seat-env.jsonl').filter((r) => r.colId === WORKER)).toHaveLength(1);
  expect(await application.evaluate(({ app }) => app.testRelayAlerts.length)).toBe(3);
});

test('automatic rotation waits for a completed turn and preserves an unsent draft', async () => {
  test.setTimeout(90000);
  await page.evaluate((id) => sendWhenReady(columns.find((c) => c.id === id), 'keep working', { guardUserInput: true }), CN);
  await expect.poll(() => page.evaluate((id) => terms.get(id)?.state, CN)).toBe('working');
  await nativeUsage(CN);
  await page.waitForTimeout(4500); // three normal status ticks cannot interrupt a working Captain
  expect(await captainId()).toBe(CN);
  expect(await application.evaluate(({ app }) => app.testRelayAlerts.length)).toBe(0);
  const composer = page.locator(`.column[data-col-id="${CN}"] .composer textarea`);
  await page.evaluate((id) => ChatUI.setMode(id, 'chat'), CN);
  await composer.fill('尚未发出的指令');
  await page.evaluate((id) => window.deck.ptyInput(id, '\x1b'), CN);
  await idle(CN);
  await page.waitForTimeout(4500);
  expect(await captainId()).toBe(CN);
  await expect(composer).toHaveValue('尚未发出的指令');
  expect(promptsFor(CN)).not.toContain('尚未发出的指令');
  await composer.fill('');
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 30000 }).toBe('us');
});

test('icon switch and threshold settings persist and control automatic rotation', async () => {
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  const enabled = page.locator('#perpetualEnabled');
  const threshold = page.locator('#perpetualThreshold');
  await expect(enabled).toHaveAttribute('aria-pressed', 'true');
  await expect(enabled).toHaveAttribute('title', /永动机/);
  await expect(enabled.locator('svg')).toHaveCount(1);
  const priority = page.locator('#preferEarlierSeat');
  await expect(priority).toHaveAttribute('aria-pressed', 'true');
  await expect(priority).toHaveAttribute('title', '优先用快到期的席位');
  await expect(priority).toHaveAttribute('aria-label', '优先用快到期的席位');
  await expect(priority.locator('svg')).toHaveCount(1);
  expect(await priority.evaluate((b) => getComputedStyle(b).color)).toBe(await enabled.evaluate((b) => getComputedStyle(b).color));
  await priority.focus(); await expect(priority).toBeFocused();
  await priority.click();
  await threshold.fill('5');
  await enabled.click();
  await page.locator('#claudeSeatSettings').getByRole('button', { name: '保存设置' }).click();
  await expect.poll(() => page.evaluate(() => config.perpetualCaptain)).toEqual({ enabled: false, threshold: 5, preferEarlier: false });
  await page.reload();
  await expect(page.locator('.claude-seat-rotate')).toBeEnabled({ timeout: 20000 });
  expect(await page.evaluate(() => config.perpetualCaptain)).toEqual({ enabled: false, threshold: 5, preferEarlier: false });
  await idle(CN);
  await nativeUsage(CN, 4);
  await page.waitForTimeout(4500);
  expect(await captainId()).toBe(CN);
  await page.locator('#settingsBtn').click();
  await page.locator('#claudeSeatsSettings').click();
  await enabled.click();
  await priority.click();
  await page.locator('#claudeSeatSettings').getByRole('button', { name: '保存设置' }).click();
  await expect.poll(() => page.evaluate(() => config.perpetualCaptain)).toEqual({ enabled: true, threshold: 5, preferEarlier: true });
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 30000 }).toBe('us');
});

test('the idle current Captain renews its expired window before switching to the earlier usable seat', async () => {
  await page.evaluate((id) => window.deck.ptyKill(id), WORKER); // only this stand-in worker, to leave CN otherwise unused
  await expect.poll(() => page.evaluate((id) => window.deck.ptyIsAlive(id), WORKER)).toBe(false);
  const nextReset = Date.now() + 5 * 3600000;
  await page.evaluate(async () => {
    const infos = await ClaudeSeats.refresh(), now = Date.now();
    columns.find((c) => c.isMain).agentProvider = 'Claude';
    config.perpetualCaptainState = {};
    for (const info of infos) {
      const dir = config.claudeSeats.find((s) => s.id === info.id).configDir;
      config.quotas['Claude:' + info.id] = { scope: 'claude', configDir: dir, credentialKey: info.credentialKey, accountKey: info.accountKey,
        sample: { provider: 'Claude', scope: 'claude', official: true, seatId: info.id, configDir: dir,
          credentialKey: info.credentialKey, at: now,
          windows: [{ key: 'fiveHour', remaining: 80, resetAt: info.id === 'cn' ? now - 61000 : now + 3600000 },
            { key: 'weekly', remaining: 60, resetAt: now + 7 * 86400000 }] } };
    }
    flushConfig();
  });
  await application.evaluate(async ({ app }, [id, resetAt]) => {
    app.testWarmupResults.push({ ok: true, provenNative: true, resetAt });
  }, [CN, nextReset]);
  await page.evaluate((id) => window.deck.claudeWarmupIdle(id, false), CN);
  await application.evaluate(async ({ app }) => app.testQuotaWarmup.tick());
  expect(await application.evaluate(({ app }) => app.testWarmupRuns)).toHaveLength(0);
  await page.evaluate((id) => window.deck.claudeWarmupIdle(id, true), CN);
  await application.evaluate(async ({ app }) => app.testQuotaWarmup.tick());
  await expect.poll(async () => (await application.evaluate(({ app }) => app.testWarmupRuns)).map((r) => r.seatId)).toEqual(['cn']);
  expect(await captainId()).toBe(CN);
  await page.evaluate((resetAt) => {
    config.quotas['Claude:cn'].sample.at = Date.now();
    config.quotas['Claude:cn'].sample.windows[0] = { key: 'fiveHour', remaining: 100, resetAt };
    flushConfig();
  }, nextReset);
  await expect.poll(() => page.evaluate(() => config.mainSession.relayTargetId), { timeout: 30000 }).toBe('us');
  const id = await captainId();
  await expect(page.locator(`.column[data-col-id="${id}"] .perpetual-relay-banner`)).toContainText('快到期');
  await page.evaluate(async () => { await ClaudeSeats.refresh(); renderQuotaBar(); });
  await expect(page.locator('#quotaBar [data-seat-id="us"]')).toHaveAttribute('data-detail', /正在用.*US/);
});

test('official low quotas do not fall back to Codex, and changed identities reject the old slot sample before rotation', async () => {
  const outcome = await page.evaluate(async () => {
    const infos = await ClaudeSeats.refresh();
    const now = Date.now();
    config.perpetualCaptainState = {};
    for (const info of infos) {
      config.quotas['Claude:' + info.id] = { sample: {
        provider: 'Claude', scope: 'claude', official: true, seatId: info.id,
        configDir: info.configDir, credentialKey: info.credentialKey, at: now - 1000,
        windows: [{ key: 'fiveHour', used: 98, remaining: 2, exhausted: false, resetAt: now + 3600000 }],
      } };
    }
    const entry = terms.get(config.mainSession.colId);
    ClaudeSeats.onTick(config.mainSession.colId, entry, '');
    const doubleLow = config.mainSession.relayTargetId;
    const cn = infos.find((seat) => seat.id === 'cn');
    config.perpetualCaptainState = { seats: { cn: { accountKey: 'previous-account', configDir: cn.configDir } } };
    config.quotas['Claude:us'].sample.windows[0].remaining = 80;
    ClaudeSeats.onTick(config.mainSession.colId, entry, '');
    return { doubleLow, changedTarget: config.mainSession.relayTargetId,
      state: config.perpetualCaptainState.seats.cn };
  });
  expect(outcome.doubleLow).not.toBe('chatgpt');
  expect(outcome.changedTarget).not.toBe('us');
  expect(outcome.state.officialNotBefore).toBeGreaterThan(0);
  expect(outcome.state.lowAt).toBeUndefined();
  expect(await captainId()).toBe(CN);
});
