const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = `node "${path.join(__dirname, 'fixtures', 'fake-agent.js')}" --token-saver --board-probe`;
const CAPTAIN = 'capability-captain', INDEPENDENT = 'capability-independent';
let application, page, profile;
const children = [];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}
function cli(args, extra = {}) {
  const child = spawn(process.execPath, [path.join(profile, 'board-control', 'tools', 'agentdeck-board.js'), ...args], {
    env: cleanEnv(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
const credentialsFile = (id) => path.join(profile, 'board-control', 'credentials', id + '.json');

test.beforeEach(async () => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-perpetual-capability-')));
  const home = path.join(profile, 'seats-home');
  for (const dir of ['.claude', '.claude-us']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, '.credentials.json'), '{}');
  }
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"cn@example.test"},"hasCompletedOnboarding":true}');
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), '{"oauthAccount":{"emailAddress":"us@example.test"},"hasCompletedOnboarding":true}');
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, theme: 'dark', fitCols: 2,
    columns: [
      { id: CAPTAIN, title: '队长', isMain: true, cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
      { id: INDEPENDENT, title: '独立会话', cmd: FAKE, cwd: profile, claudeSeatId: 'cn' },
    ],
    mainSession: { colId: CAPTAIN, cmd: FAKE, gen: 1, crewMarked: true, tasks: [], pending: [], inflight: [], waitlist: [] },
  }));
  application = await electron.launch({
    executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env: cleanEnv({ AGENTDECK_DEMO_FILE: path.join(profile, 'demo.md') }),
  });
  page = await application.firstWindow();
  await expect(page.locator('.column')).toHaveCount(2);
  await expect.poll(() => page.evaluate((id) => {
    const entry = terms.get(id);
    return entry?.state === 'done' && !entry.sendingPrompt && !entry.injecting && MainSession.relayIdle();
  }, CAPTAIN), { timeout: 20000 }).toBe(true);
});
test.afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  if (page && !page.isClosed()) await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  if (application) await application.close();
  application = null; page = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test('Relay revokes the old Captain and listener, preserves independent tokens, and leaves new receipts for its replacement', async () => {
  test.setTimeout(90000);
  const controlDir = path.join(profile, 'board-control');
  const old = JSON.parse(fs.readFileSync(credentialsFile(CAPTAIN), 'utf8'));
  const independent = JSON.parse(fs.readFileSync(credentialsFile(INDEPENDENT), 'utf8'));
  expect(old.controlToken).not.toBe(''); expect(independent.controlToken).toBe('');
  const oldEnv = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: old.controlToken };
  expect((await cli(['ledger'], oldEnv).done).code).toBe(0);
  const watcher = cli(['receipts', '--wait', '--timeout', '30'], oldEnv);
  expect(await page.evaluate(() => ClaudeSeats.switchSeat('us'))).toBe(true);
  const newId = await page.evaluate(() => config.mainSession.colId);
  expect(newId).not.toBe(CAPTAIN);
  await page.evaluate((id) => {
    config.mainSession.pending.push({ taskId: 'protected-task', colId: id, title: '交接后回执',
      ts: Date.now(), summary: 'handoff-protected-receipt', files: [] });
    flushConfig();
  }, INDEPENDENT);
  await expect.poll(() => fs.existsSync(credentialsFile(CAPTAIN))).toBe(false);
  await expect.poll(() => fs.existsSync(credentialsFile(newId))).toBe(true);
  const fresh = JSON.parse(fs.readFileSync(credentialsFile(newId), 'utf8'));
  expect(fresh.controlToken).not.toBe(old.controlToken);
  expect(fresh.receiptToken).not.toBe(old.receiptToken);
  expect(JSON.parse(fs.readFileSync(credentialsFile(INDEPENDENT), 'utf8'))).toEqual(independent);
  const obsolete = await watcher.done;
  expect(obsolete.code).toBe(1);
  expect(obsolete.stderr).toContain('Control request rejected');
  expect(obsolete.stdout).not.toContain('handoff-protected-receipt');
  expect(await page.evaluate(() => config.mainSession.pending.some((r) => r.summary === 'handoff-protected-receipt'))).toBe(true);
  expect((await cli(['ledger'], { ...oldEnv, AGENTDECK_TERMINAL_ID: newId }).done).code).toBe(1);
  expect((await cli(['ledger'], { AGENTDECK_TERMINAL_ID: CAPTAIN }).done).code).toBe(1);
  const denied = await cli(['ledger'], { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: independent.receiptToken }).done;
  expect(denied.code).toBe(1); expect(denied.stderr).toContain('Receipt capability');
  expect(await page.evaluate(async (id) => {
    try { await window.deck.captainRelayNotify(id, 'worker should not send'); return false; }
    catch (_) { return true; }
  }, INDEPENDENT)).toBe(true);
  // README's Codex receipt environment binds file fallback to the controlling
  // tty, never TERMINAL_ID. This helper runs outside the replacement's PTY, so
  // it must supply the rotated capability on every platform.
  expect((await cli(['ledger'], { AGENTDECK_TERMINAL_ID: newId }).done).code).toBe(1);
  const replacementEnv = { AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: fresh.controlToken };
  const replacement = await cli(['receipts', '--wait', '--timeout', '10'], replacementEnv).done;
  expect(replacement.code, replacement.stderr + replacement.stdout).toBe(0);
  expect(replacement.stdout).toContain('handoff-protected-receipt');
  expect(await page.evaluate(() => config.mainSession.pending.length)).toBe(0);
});
