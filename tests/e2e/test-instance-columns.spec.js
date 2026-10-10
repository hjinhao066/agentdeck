const closeElectron = require('./fixtures/close-electron');
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A test instance (--test-user-data) whose column config is empty must open nothing. It used to fall back to the three default
// agent columns, whose launch lines (`agy`, `claude`, `grok`) are looked up by name on PATH and started a real agent: Grok opened
// sign-in pages in the user's browser. These tests leave the column config empty on purpose, so every one puts a trap in front of
// PATH first: each real agent name only writes a line to trap.log. A test instance with no columns must leave trap.log empty.
const AGENTS = ['claude', 'agy', 'antigravity', 'gemini', 'codex', 'cursor-agent', 'cursor', 'grok'];
const PACKAGED = !!process.env.AGENTDECK_TEST_EXECUTABLE;
const APP_ARGS = PACKAGED ? [] : [path.resolve(__dirname, '../..')];
let profile, trapFile, guardLog, app, page;

test.afterEach(async ({}, info) => {
  // A failure keeps what the trap caught, so the report names the agent that got started.
  if (info.status !== info.expectedStatus && trapFile) await info.attach('trap.log', { body: trapped(), contentType: 'text/plain' }).catch(() => {});
  if (app) await closeElectron(app).catch(() => {});
  app = null;
  // A profile the just-closed Electron still holds (Windows) is left to the temp folder, not a failure of the test.
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { console.warn(`profile not removed: ${error.code}`); } }
  profile = null;
});

// Starts a test instance on a fresh profile. `config` is the text of config.json (or a function of the profile folder that
// returns it), or null for no file at all.
async function start(config) {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-empty-columns-'));
  trapFile = path.join(profile, 'trap.log'); guardLog = path.join(profile, 'guard.log');
  if (config !== null) fs.writeFileSync(path.join(profile, 'config.json'), typeof config === 'function' ? config(profile) : config);
  const trapDir = path.join(profile, 'trapbin'); fs.mkdirSync(trapDir);
  for (const name of AGENTS) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(trapDir, name + '.cmd'), `@echo off\r\necho TRAP ${name}>> "${trapFile}"\r\n`);
    else { fs.writeFileSync(path.join(trapDir, name), `#!/bin/sh\necho TRAP ${name} >> "${trapFile}"\n`); fs.chmodSync(path.join(trapDir, name), 0o755); }
  }
  // Nothing of an outer AgentDeck leaks in; the trap goes first on PATH, and zsh does not read the user's profile and move it back.
  const env = { ...process.env, E2E_DIALOG_GUARD_LOG: guardLog };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_') && key !== 'AGENTDECK_TEST_EXECUTABLE') delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform !== 'win32') env.ZDOTDIR = profile;
  // On a Mac the app puts /opt/homebrew/bin, /usr/local/bin and ~/.local/bin (where claude lives) in front of the PATH it is
  // given (main.js buildEnv), and a login shell's path_helper reorders it again: the shell's own .zshrc, read last by an
  // interactive zsh, puts the trap back in front.
  if (process.platform !== 'win32') fs.writeFileSync(path.join(profile, '.zshrc'), `export PATH=${JSON.stringify(trapDir)}:"$PATH"\n`);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = trapDir + path.delimiter + (env[pathKey] || '');
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...APP_ARGS, `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => typeof config === 'object' && typeof terms === 'object');
  return { page, errors, guard: await guardLoaded() };
}
const trapped = () => (fs.existsSync(trapFile) ? fs.readFileSync(trapFile, 'utf8') : '');
const guardLines = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').trim().split('\n') : []);
// main.js installs test-instance-guard.js itself as soon as it sees --test-user-data, so the dialog guard is active in the source run
// and in the packaged app alike (nothing is passed with -r). It writes "guard loaded" to E2E_DIALOG_GUARD_LOG; a missing line fails.
async function guardLoaded() {
  await expect.poll(guardLines, { message: 'main.js did not install the test-instance dialog guard' }).toContain('guard loaded');
  return true;
}
// Zero columns. When it fails, give the default columns time to type their launch lines (~0.7 s), so trap.log says which agent they
// started, and put it in the failure message before the count is asserted.
async function expectNoColumns(label) {
  const count = await page.locator('.column').count();
  if (count !== 0) await page.waitForTimeout(3000);
  expect(count, `${label}: ${count} column(s) opened, trap.log: ${JSON.stringify(trapped())}`).toBe(0);
}

for (const [label, config] of [
  ['no config file', null],
  ['an empty columns list', JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [] })],
  ['columns missing from the file', JSON.stringify({ perpetualCaptain: { enabled: false }, theme: 'dark' })],
  ['a config file that cannot be read', '{ "columns": [ not json'],
]) {
  test(`a test instance with ${label} opens no default agent columns and starts nothing`, async () => {
    // start() has checked that main.js installed the dialog guard
    const { errors } = await start(config);
    await expectNoColumns('at start');
    expect(await page.evaluate(() => [config.columns.length, terms.size])).toEqual([0, 0]);
    // the default columns would type their launch lines after ~0.7 s (Windows: once the prompt is up): give them time to show
    await page.waitForTimeout(5000);
    await expectNoColumns('after 5 s');
    expect(await page.evaluate(() => terms.size)).toBe(0);
    expect(trapped()).toBe('');
    expect(errors).toEqual([]);
    expect(guardLines().filter((line) => line !== 'guard loaded')).toEqual([]);
  });
}

// "Reset to default layout" used to open the three default agent columns in a test instance as well.
test('resetting the layout in a test instance leaves no columns and starts nothing', async () => {
  const { errors } = await start((dir) => JSON.stringify({ perpetualCaptain: { enabled: false },
    columns: [{ id: 'saved-shell', title: 'Shell', cmd: '', cwd: dir, role: 'manual' }] }));
  await expect(page.locator('.column')).toHaveCount(1);
  // (Playwright cannot answer a page dialog in an Electron window: "No dialog is showing"; the page's own confirm() is answered instead)
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('button[aria-label="恢复默认布局"]').evaluate((button) => button.click());
  await page.waitForTimeout(5000);   // the reset is synchronous; the time is for any default column to type its launch line
  await expectNoColumns('after the reset');
  expect(await page.evaluate(() => [config.columns.length, terms.size])).toEqual([0, 0]);
  expect(trapped()).toBe('');
  expect(errors).toEqual([]);
});

test('a test instance with saved columns opens exactly those', async () => {
  // the column's folder is the profile itself, which afterEach removes once the app is closed
  const { errors } = await start((dir) => JSON.stringify({ perpetualCaptain: { enabled: false },
    columns: [{ id: 'saved-shell', title: 'Shell', cmd: '', cwd: dir, role: 'manual' }] }));
  await expect(page.locator('.column')).toHaveCount(1);
  expect(await page.evaluate(() => config.columns.map((c) => c.id))).toEqual(['saved-shell']);
  await page.waitForTimeout(3000);
  expect(await page.locator('.column').count()).toBe(1);
  expect(trapped()).toBe('');
  expect(errors).toEqual([]);
});

// The positive control: every test above asserts an empty trap.log, which only means something if the trap does catch a real agent
// name. Typed into a manual terminal of the same instance, `claude` has to land in the trap, and as exactly one new line.
test('the trap catches a real agent name typed into a manual terminal of the test instance', async () => {
  const { errors } = await start((dir) => JSON.stringify({ perpetualCaptain: { enabled: false },
    columns: [{ id: 'saved-shell', title: 'Shell', cmd: '', cwd: dir, role: 'manual' }] }));
  await expect(page.locator('.column')).toHaveCount(1);
  // wait for the shell's prompt so the line is read by the shell, not lost in start-up
  await expect.poll(() => page.evaluate((platform) => {
    const screen = dumpScreen(terms.get('saved-shell').term);
    return platform === 'win32' ? MainCore.isWindowsShellPrompt(screen) : /[%$#]\s*$/.test(screen);
  }, process.platform), { timeout: 30000 }).toBe(true);
  expect(trapped()).toBe('');
  await page.evaluate(() => window.deck.ptyInput('saved-shell', 'claude\r'));
  await expect.poll(trapped, { timeout: 15000, message: 'typing claude did not reach the trap in front of PATH' }).toMatch(/TRAP claude/);
  expect(trapped().trim().split(/\r?\n/).map((line) => line.trim())).toEqual(['TRAP claude']);
  expect(errors).toEqual([]);
});

// A test instance answers a main-process dialog as cancelled and notes it, without anything being passed with -r.
test('a main-process dialog opened in a test instance is answered as cancelled and noted', async () => {
  const { errors } = await start(JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [] }));
  const answers = await app.evaluate(async ({ dialog }) => ({
    box: dialog.showMessageBoxSync({ message: 'x', buttons: ['Delete', 'Cancel'], cancelId: 1 }),
    open: await dialog.showOpenDialog({ properties: ['openFile'] }),
    sync: dialog.showOpenDialogSync({}),
  }));
  expect(answers).toEqual({ box: 1, open: { canceled: true, filePaths: [] }, sync: undefined });
  expect(guardLines()).toEqual(['guard loaded', 'blocked showMessageBoxSync', 'blocked showOpenDialog', 'blocked showOpenDialogSync']);
  expect(errors).toEqual([]);
});

// A page's own confirm() is not the guard's business: Playwright still gets to answer it (the guard's early version took it away).
test('a page confirm() in a test instance still reaches Playwright, and the guard notes nothing for it', async () => {
  const { errors } = await start(JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [] }));
  page.once('dialog', (dialog) => dialog.accept());
  expect(await page.evaluate(() => confirm('sure?'))).toBe(true);
  expect(guardLines()).toEqual(['guard loaded']);
  expect(errors).toEqual([]);
});
