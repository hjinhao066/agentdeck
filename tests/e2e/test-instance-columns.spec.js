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
const GUARD = path.join(__dirname, 'fixtures', 'no-dialog-guard.js');
const APP_ARGS = process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../..')];
let profile, trapFile, guardLog, app;

test.afterEach(async () => {
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
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = trapDir + path.delimiter + (env[pathKey] || '');
  app = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: ['-r', GUARD, ...APP_ARGS, `--test-user-data=${profile}`], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => typeof config === 'object' && typeof terms === 'object');
  return { page, errors };
}
const trapped = () => (fs.existsSync(trapFile) ? fs.readFileSync(trapFile, 'utf8') : '');
const guardLines = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').trim().split('\n') : []);

for (const [label, config] of [
  ['no config file', null],
  ['an empty columns list', JSON.stringify({ perpetualCaptain: { enabled: false }, columns: [] })],
  ['columns missing from the file', JSON.stringify({ perpetualCaptain: { enabled: false }, theme: 'dark' })],
  ['a config file that cannot be read', '{ "columns": [ not json'],
]) {
  test(`a test instance with ${label} opens no default agent columns and starts nothing`, async () => {
    const { page, errors } = await start(config);
    // the guard really was loaded before the app (-r in front of the app path)
    await expect.poll(guardLines).toContain('guard loaded');
    expect(await page.locator('.column').count()).toBe(0);
    expect(await page.evaluate(() => [config.columns.length, terms.size])).toEqual([0, 0]);
    // the default columns would type their launch lines after ~0.7 s (Windows: once the prompt is up): give them time to show
    await page.waitForTimeout(5000);
    expect(await page.locator('.column').count()).toBe(0);
    expect(await page.evaluate(() => terms.size)).toBe(0);
    expect(trapped()).toBe('');
    expect(errors).toEqual([]);
    expect(guardLines().filter((line) => line !== 'guard loaded')).toEqual([]);
  });
}

test('a test instance with saved columns opens exactly those', async () => {
  // the column's folder is the profile itself, which afterEach removes once the app is closed
  const { page, errors } = await start((dir) => JSON.stringify({ perpetualCaptain: { enabled: false },
    columns: [{ id: 'saved-shell', title: 'Shell', cmd: '', cwd: dir, role: 'manual' }] }));
  await expect(page.locator('.column')).toHaveCount(1);
  expect(await page.evaluate(() => config.columns.map((c) => c.id))).toEqual(['saved-shell']);
  await page.waitForTimeout(3000);
  expect(await page.locator('.column').count()).toBe(1);
  expect(trapped()).toBe('');
  expect(errors).toEqual([]);
});
