// 小队长 end to end, through the real board-cli in an isolated profile with stand-in agents:
// the Captain opens a sub-captain, the sub-captain opens a child with create-child, the
// child's receipt reaches only the sub-captain's receipts; the Captain's ledger nests the
// child; the sidebar folds the children under the sub-captain; archiving the sub-captain
// hands the live child back to the Captain.
const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}"`;
const CLI = path.resolve(__dirname, '../../board-cli.js');

// The machine running the test may itself be an AgentDeck terminal: its own
// AgentDeck variables never reach the app or the CLI started here.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && !(key in extra)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
function cli(controlEnv, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: cleanEnv(controlEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('sub-captain: receipts, ledger, sidebar and hand-back through the real board-cli', async ({}, testInfo) => {
  test.setTimeout(240000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-sub-captain-'));
  const envDir = path.join(profile, 'control-env');
  fs.mkdirSync(envDir);
  const shots = process.env.AGENTDECK_SHOT_DIR || testInfo.outputPath();
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    theme: 'dark', navWidth: 300, perpetualCaptain: { enabled: false }, crewOpen: true,
    columns: [{ id: 'captain', title: '队长', cmd: FAKE, cwd: profile, width: 460, role: 'manual', isMain: true }],
    mainSession: { colId: 'captain', cmd: FAKE, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] },
  }));
  let app;
  const controlOf = async (id) => {
    const file = path.join(envDir, id + '.json');
    await expect.poll(() => fs.existsSync(file), { timeout: 30000, message: `terminal ${id} holds a control capability` }).toBe(true);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const ok = async (env, args) => {
    const r = await cli(env, args);
    expect(r.stderr, args.join(' ')).toBe('');
    expect(r.code, args.join(' ')).toBe(0);
    return r.stdout;
  };
  const idIn = (text) => (/(c-board-[a-z0-9]+)/.exec(text) || [])[1];
  try {
    app = await electron.launch({
      executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
      env: cleanEnv({ ZDOTDIR: profile, AGENTDECK_TEST_CONTROL_ENV_DIR: envDir }),
    });
    const page = await app.firstWindow();
    const captain = await controlOf('captain');

    // The Captain opens a sub-captain. It finishes its first instruction at once (stand-in),
    // so the Captain gets the sub-captain's own receipt: that one is the Captain's.
    const opened = await ok(captain, ['new', '--title', '秋招小队长', '--task', '统筹秋招', '--project', '秋招', '--sub-captain']);
    const subId = idIn(opened);
    expect(subId, opened).toBeTruthy();
    const sub = await controlOf(subId);

    // The sub-captain opens a child; create-child answers at once with the child's id.
    const made = await ok(sub, ['create-child', '--title', '子会话A', '--task', '做子会话A']);
    const childId = idIn(made);
    expect(childId, made).toBeTruthy();
    expect(childId).not.toBe(subId);

    // A: the child's receipt is in the sub-captain's receipts …
    const subGot = await ok(sub, ['receipts', '--wait', '--timeout', '60']);
    expect(subGot).toContain('stand-in finished 做子会话A');
    // … and never in the Captain's, which holds only the sub-captain's own report.
    const captainGot = await ok(captain, ['receipts']);
    expect(captainGot).toContain('stand-in finished 统筹秋招');
    expect(captainGot).not.toContain('做子会话A');

    // The sub-captain reaches only its own children.
    const refused = await cli(sub, ['peek', '--id', 'captain']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('不是你开的子会话');
    const noNew = await cli(sub, ['new', '--title', 'x', '--task', 'x']);
    expect(noNew.code).not.toBe(0);
    expect(noNew.stderr).toContain('小队长');

    // B: the Captain's ledger nests the child under its sub-captain; the Captain can still peek and tell it.
    const ledger = (await ok(captain, ['ledger'])).split('\n');
    const subLine = ledger.findIndex((l) => l.startsWith(subId));
    expect(subLine, ledger.join('\n')).toBeGreaterThanOrEqual(0);
    expect(ledger[subLine]).toContain('小队长');
    expect(ledger.slice(subLine + 1).find((l) => l.includes(childId))).toMatch(/^\s+└\s*c-board-/);
    expect(await ok(captain, ['peek', '--id', childId, '--lines', '20'])).toContain('GOT');
    await ok(captain, ['tell', '--to', childId, '--message', '总队长补一句']);
    expect(await ok(sub, ['receipts', '--wait', '--timeout', '60'])).toContain('stand-in finished 总队长补一句');
    expect(await ok(captain, ['receipts'])).not.toContain('总队长补一句');

    // C: the sidebar shows the children under the sub-captain, folded by an icon button.
    await ok(sub, ['create-child', '--title', '子会话B', '--task', '做子会话B']);
    await page.evaluate(() => { config.crewOpen = true; Sidebar.render(); });
    const subRow = page.locator(`.nav-crew .colnav-item[data-col-id="${subId}"]`);
    const fold = subRow.locator('button.sub-fold');
    const kids = page.locator(`#subCrew-${subId}`);
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(fold).toHaveAttribute('aria-label', /收起.*子会话/);
    await expect(fold).toHaveAttribute('title', /收起.*子会话/);
    await expect(fold).toHaveAttribute('aria-controls', `subCrew-${subId}`);
    await expect(kids.locator('.colnav-item')).toHaveCount(2, { timeout: 15000 });
    await expect(kids.locator(`.colnav-item[data-col-id="${childId}"]`)).toBeVisible();
    // the children are not also listed as their own rows elsewhere in the crew list
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${childId}"]`)).toHaveCount(1);
    const box = await fold.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    const kidDot = await kids.locator('.colnav-item .cn-dot').first().boundingBox();
    const subDot = await subRow.locator('.cn-dot').boundingBox();
    expect(kidDot.x).toBeGreaterThan(subDot.x + 12); // indented under the sub-captain
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => applyTheme(t), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, `sub-captain-sidebar-${theme}.png`) });
    }
    // Keyboard: focus the fold button and press Enter to fold, Space to unfold.
    await fold.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${subId}"] button.sub-fold`)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`#subCrew-${subId}`)).toBeHidden();
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${subId}"] button.sub-fold`)).toBeFocused();
    expect(await page.evaluate((id) => columns.find((c) => c.id === id).subCrewCollapsed, subId)).toBe(true);
    await page.keyboard.press('Space');
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${subId}"] button.sub-fold`)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#subCrew-${subId} .colnav-item`)).toHaveCount(2);

    // D: archiving the sub-captain keeps the child running and hands it to the Captain.
    expect(await ok(captain, ['archive', '--id', subId])).toContain('已结束终端并归档');
    expect(await page.evaluate((id) => !!terms.get(id)?.alive && !columns.find((c) => c.id === id).subCaptainId, childId)).toBe(true);
    const handed = await ok(captain, ['receipts']);
    expect(handed).toContain('交回');
    expect(handed).toContain(childId);
    await ok(captain, ['tell', '--to', childId, '--message', '交回后再做一点']);
    expect(await ok(captain, ['receipts', '--wait', '--timeout', '60'])).toContain('stand-in finished 交回后再做一点');
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${childId}"]`)).toHaveCount(1);
  } finally {
    if (app) await closeElectron(app);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
