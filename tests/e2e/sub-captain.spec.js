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

test('sub-captain: receipts, ledger, sidebar, restart and hand-back through the real board-cli', async ({}, testInfo) => {
  test.setTimeout(420000);
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
  let app, page;
  const controlOf = async (id, timeout = 30000) => {
    const file = path.join(envDir, id + '.json');
    const since = Date.now();
    try {
      await expect.poll(() => fs.existsSync(file), { timeout, message: `terminal ${id} holds a control capability` }).toBe(true);
    } catch (error) {
      // What the terminal looked like, for a run on another machine.
      const seen = await page?.evaluate((colId) => {
        const col = columns.find((c) => c.id === colId), entry = terms.get(colId);
        return { now: Date.now(), col: col && { cmd: col.cmd, subCaptain: col.subCaptain, captainCrew: col.captainCrew, isMain: col.isMain },
          entry: entry && { alive: entry.alive, state: entry.state, launchPending: entry.launchPending, launchedAt: entry.launchedAt, exitReason: entry.exitReason,
            screen: String(entry.lastScreen || '').split('\n').slice(-15).join('\n') }, columns: columns.map((c) => c.id) };
      }, id).catch((e) => ({ unavailable: e.message }));
      console.log(`[sub-captain diag] ${id} after ${Date.now() - since} ms: ${JSON.stringify(seen)}`);
      throw error;
    }
    console.log(`[sub-captain timing] ${id} control capability after ${Date.now() - since} ms`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const ok = async (env, args) => {
    const r = await cli(env, args);
    expect(r.stderr, args.join(' ')).toBe('');
    expect(r.code, args.join(' ')).toBe(0);
    return r.stdout;
  };
  const idIn = (text) => (/(c-board-[a-z0-9]+)/.exec(text) || [])[1];
  // Receipts in the order they come: keep listening until the expected one is among them.
  const receiptsUntil = async (env, text) => {
    let all = '';
    for (let i = 0; i < 6 && !all.includes(text); i++) all += await ok(env, ['receipts', '--wait', '--timeout', '60']);
    return all;
  };
  const launch = () => electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')]), `--test-user-data=${profile}`],
    env: cleanEnv({ ZDOTDIR: profile, AGENTDECK_TEST_CONTROL_ENV_DIR: envDir }),
  });
  try {
    app = await launch();
    page = await app.firstWindow();
    let captain = await controlOf('captain');

    // The Captain opens a sub-captain. It finishes its first instruction at once (stand-in),
    // so the Captain gets the sub-captain's own receipt: that one is the Captain's.
    const opened = await ok(captain, ['new', '--title', '秋招小队长', '--task', '统筹秋招', '--project', '秋招', '--sub-captain']);
    let subId = idIn(opened);
    expect(subId, opened).toBeTruthy();
    let sub = await controlOf(subId);

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
    expect(await receiptsUntil(sub, 'stand-in finished 总队长补一句')).toContain('stand-in finished 总队长补一句');
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

    // After an AgentDeck restart the hierarchy is still there: the sub-captain gets its
    // control capability back, still reaches its child, and still gets the child's receipts.
    await closeElectron(app);
    app = null;
    for (const id of ['captain', subId]) fs.rmSync(path.join(envDir, id + '.json'), { force: true });
    app = await launch();
    page = await app.firstWindow();
    // A relaunch usually brings the terminals back in seconds; on Windows the 队长's own startup
    // has been seen to stall past 90 s now and then, before anything 小队长-specific runs.
    captain = await controlOf('captain', 180000);
    sub = await controlOf(subId, 180000);
    expect(await ok(sub, ['ledger'])).toContain(childId);
    const relaunched = (await ok(captain, ['ledger'])).split('\n');
    expect(relaunched.slice(relaunched.findIndex((l) => l.startsWith(subId)) + 1).find((l) => l.includes(childId))).toMatch(/^\s+└\s*c-board-/);
    await ok(sub, ['tell', '--to', childId, '--message', '重启后再做一轮']);
    expect(await receiptsUntil(sub, 'stand-in finished 重启后再做一轮')).toContain('stand-in finished 重启后再做一轮');
    expect(await ok(captain, ['receipts'])).not.toContain('重启后再做一轮');
    await page.evaluate(() => { config.crewOpen = true; Sidebar.render(); });
    await expect(page.locator(`#subCrew-${subId} .colnav-item`)).toHaveCount(2, { timeout: 15000 });

    // Its 编辑 dialog with a new command respawns it with a new id: it still leads its child,
    // and the child's receipts still come to it.
    const respawnedId = await page.evaluate((id) => { const col = columns.find((c) => c.id === id); respawnColumn(col); return col.id; }, subId);
    expect(respawnedId).not.toBe(subId);
    subId = respawnedId;
    sub = await controlOf(subId, 180000);
    expect(await ok(sub, ['ledger'])).toContain(childId);
    await ok(captain, ['tell', '--to', childId, '--message', '编辑后再做一轮']);
    expect(await receiptsUntil(sub, 'stand-in finished 编辑后再做一轮')).toContain('stand-in finished 编辑后再做一轮');
    expect(await ok(captain, ['receipts'])).not.toContain('编辑后再做一轮');

    // D: archiving the sub-captain keeps the child running and hands it to the Captain.
    expect(await ok(captain, ['archive', '--id', subId])).toContain('已结束终端并归档');
    expect(await page.evaluate((id) => !!terms.get(id)?.alive && !columns.find((c) => c.id === id).subCaptainId, childId)).toBe(true);
    const handed = await ok(captain, ['receipts']);
    expect(handed).toContain('交回');
    expect(handed).toContain(childId);
    await ok(captain, ['tell', '--to', childId, '--message', '交回后再做一点']);
    expect(await receiptsUntil(captain, 'stand-in finished 交回后再做一点')).toContain('stand-in finished 交回后再做一点');
    await expect(page.locator(`.nav-crew .colnav-item[data-col-id="${childId}"]`)).toHaveCount(1);
  } finally {
    if (app) await closeElectron(app);
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
