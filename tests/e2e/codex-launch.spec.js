const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const closeElectron = require('./fixtures/close-electron');

const ROOT = path.resolve(__dirname, '../..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
let application, page, profile;

function records(name) {
  const file = path.join(profile, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  }) : [];
}

test.afterEach(async ({}, testInfo) => {
  if (page && !page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
    const screens = await page.evaluate(async () => Promise.all(columns.map(async (c) => ({
      id: c.id, cmd: c.cmd, state: terms.get(c.id)?.state, screen: String(await window.deck.ptyReplay(c.id) || '').slice(-4000),
    })))).catch((error) => ({ error: error.message }));
    await testInfo.attach('isolated-launch-diagnostics', { body: JSON.stringify({ screens, argv: records('argv.jsonl') }), contentType: 'application/json' });
  }
  if (application) {
    const child = application.process();
    const force = setTimeout(() => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (_) {}
    }, 10000);
    try {
      if (page && !page.isClosed()) await page.evaluate(() => columns.forEach((c) => window.deck.ptyKill(c.id))).catch(() => {});
      await closeElectron(application);
    } finally { clearTimeout(force); }
  }
  application = null;
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

for (const embedded of [false, true]) {
  test(`Codex ${embedded ? 'with' : 'without'} --no-daemon launches captain and new worker and receives their prompts`, async () => {
    profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-codex-launch-')));
    // Spaces and brackets exercise the executable path and PowerShell invocation.
    const bin = path.join(profile, '[01] test binaries');
    fs.mkdirSync(bin);
    const executable = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const shim = path.join(bin, 'codex-stand-in.js');
    fs.writeFileSync(shim, `
const fs = require('fs');
const args = process.argv.slice(2);
const supported = ['--dangerously-bypass-approvals-and-sandbox'${embedded ? ", '--no-daemon'" : ''}];
fs.appendFileSync(${JSON.stringify(path.join(profile, 'argv.jsonl'))}, JSON.stringify({ args, colId: process.env.AGENTDECK_COL_ID }) + '\\n');
if (args.includes('--help')) {
  console.log('Codex CLI\\nUsage: codex [OPTIONS] [PROMPT]\\nOptions:\\n' + supported.map((flag) => '  ' + flag).join('\\n'));
  process.exit(0);
}
if (args.includes('--version')) { console.log('codex-cli ${embedded ? '0.160.0' : '0.120.0'}'); process.exit(0); }
const invalid = args.find((arg) => arg.startsWith('--') && !supported.includes(arg));
if (invalid) { console.error('error: unexpected argument ' + invalid); process.exit(2); }
process.argv.push('--provider=codex', '--codex-reset', '--board-probe');
require(${JSON.stringify(FAKE)});
`);
    fs.writeFileSync(executable, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(shim)});\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ theme: 'dark',
      columns: [{ id: 'codex-launch-shell', title: 'Shell', cmd: '', cwd: profile, role: 'manual' }],
      perpetualCaptain: { enabled: false } }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
      args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
      env: { ...env, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: path.join(profile, 'prompts.jsonl'),
        AGENTDECK_TEST_BOARD_RESULTS_FILE: path.join(profile, 'board-results.jsonl') },
    });
    page = await application.firstWindow();
    await page.waitForFunction(() => typeof MainSession !== 'undefined' && typeof BoardCore !== 'undefined' && typeof terms !== 'undefined' && terms.get('codex-launch-shell')?.alive);
    // Preserve the selected preset's arguments while substituting an isolated CLI.
    await page.evaluate((bin) => {
      const original = BoardCore.commandForAgent;
      const command = original('codex').replace(/^codex\b/, `"${bin}"`);
      BoardCore.commandForAgent = (agent, ...args) => agent === 'codex' ? command : original(agent, ...args);
      document.querySelector('#mainDialog .preset[data-cmd^="codex"]').dataset.cmd = command;
    }, executable);
    await page.locator('.nav-row[data-nav="captain"]').click();
    await page.locator('#mainDialog .preset').filter({ hasText: 'Codex (ChatGPT)' }).click();
    await page.locator('#mdCwd').fill(profile);
    await page.locator('#mdCreate').click();
    const captain = await page.evaluate(() => config.mainSession.colId);
    await expect.poll(() => records('argv.jsonl').filter((r) => r.colId === captain && !r.args.includes('--help')).length, { timeout: 30000 }).toBe(1);
    await expect.poll(() => records('prompts.jsonl').find((r) => r.colId === captain)?.text || '', { timeout: 30000 }).toContain('你是 AgentDeck');
    const task = 'codex worker launch regression';
    await page.evaluate(([id, task, cwd]) => window.deck.ptyInput(id,
      'BOARD ' + JSON.stringify(['new', '--agent', 'codex', '--title', 'Codex worker', '--task', task, '--cwd', cwd]) + '\r'), [captain, task, profile]);
    await expect.poll(() => records('board-results.jsonl').find((r) => r.colId === captain)?.stdout || '', { timeout: 20000 }).toContain('已开新会话');
    const worker = await page.evaluate(() => columns.find((c) => c.displayTitle === 'Codex worker').id);
    await expect.poll(() => records('prompts.jsonl').find((r) => r.colId === worker)?.text || '', { timeout: 30000 }).toContain(task);
    expect(records('prompts.jsonl').find((r) => r.colId === worker).text).toContain('AgentDeck 约定');
    // Exercise the chat button's preparation path after creating the captain and worker.
    await page.evaluate((bin) => {
      jumpToColumn(columns.find((c) => c.id === 'codex-launch-shell'));
      ChatUI.setMode('codex-launch-shell', 'chat');
      const button = document.querySelector('.column[data-col-id="codex-launch-shell"] .launch-btn[data-agent="codex"]')
        || [...document.querySelectorAll('.column[data-col-id="codex-launch-shell"] .launch-btn')].find((b) => b.textContent === 'Codex (ChatGPT)');
      button.dataset.cmd = BoardCore.commandForAgent('codex').replace(/^codex\b/, `"${bin}"`);
    }, executable);
    await expect.poll(() => page.evaluate(() => MainCore.isWindowsShellPrompt(terms.get('codex-launch-shell')?.lastScreen) || env.platform !== 'win32')).toBe(true);
    await page.locator('.column[data-col-id="codex-launch-shell"] .launch-btn').filter({ hasText: 'Codex (ChatGPT)' }).click();
    await expect.poll(() => page.evaluate(() => columns.find((c) => c.id === 'codex-launch-shell').cmd), { timeout: 30000 }).toContain(executable);
    const launched = records('argv.jsonl').filter((r) => !r.args.includes('--help') && !r.args.includes('--version'));
    expect(launched.map((r) => r.colId).sort()).toEqual(['codex-launch-shell', captain, worker].sort());
    for (const launch of launched) {
      expect(launch.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(launch.args.includes('--no-daemon')).toBe(embedded);
    }
    // Both paths share one capability probe, including concurrent launches.
    expect(records('argv.jsonl').filter((r) => r.args.includes('--help'))).toHaveLength(1);
    for (const id of [captain, worker]) {
      expect(await page.evaluate((id) => window.deck.ptyReplay(id), id)).not.toContain('unexpected argument');
    }
  });
}
