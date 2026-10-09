'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');
const T = require('../workspace-trust-main');

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-trust-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project with spaces');
  fs.mkdirSync(cwd);
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const column = { captainCrew: true, cwd, trustedCwd: cwd };
  const prepare = (cmd, col = column, dir = cwd) => T.prepareWorkspaceTrust(cmd, col, dir, home);
  return { home, cwd, file, column, prepare };
}

// The launch command is shaped for the host shell: `command agy ...` after cd on
// POSIX, a PowerShell Get-Command wrapper on Windows. Check the program and its
// exact arguments in whichever form this platform produces.
function launches(command, program, args) {
  return process.platform === 'win32'
    ? command.includes(`Get-Command -Name '${program}' `) && command.includes(`.Source) ${args}`)
    : command.includes(`${program} ${args}`);
}

test('agy saves only the authorized directory before launch, preserving settings and other trust', (t) => {
  const { home, cwd, file, prepare } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = { theme: 'dark', nested: { keep: true }, trustedWorkspaces: ['/existing'] };
  fs.writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
  assert.ok(launches(prepare('agy --model gemini-3.8-flash-high').command, 'agy', '--model gemini-3.8-flash-high'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...before, trustedWorkspaces: ['/existing', cwd] });
  const saved = fs.readFileSync(file, 'utf8');
  prepare('agy');
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.ok(!JSON.parse(saved).trustedWorkspaces.includes(home));
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('agy creates missing settings; damaged or malformed settings and symlinks are kept intact', (t) => {
  const { file, cwd, prepare } = fixture(t);
  prepare('agy');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { trustedWorkspaces: [cwd] });
  for (const body of ['{bad', 'null', '[]', '{"trustedWorkspaces":{}}', '{"trustedWorkspaces":[3]}']) {
    fs.writeFileSync(file, body);
    assert.match(prepare('agy').warning, /原文件已保留/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
  if (process.platform !== 'win32') {
    const target = file + '-other';
    fs.writeFileSync(target, '{}'); fs.unlinkSync(file); fs.symlinkSync(target, file);
    assert.ok(prepare('agy').warning);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  }
});

test('manual, inherited, edited, missing and broad directories never get automatic trust', (t) => {
  const { home, cwd, file, column, prepare } = fixture(t);
  for (const col of [null, { cwd }, { ...column, captainCrew: false }, { ...column, trustedCwd: '' }, { ...column, trustedCwd: home }, { ...column, cwd: home }]) {
    assert.deepEqual(prepare('cursor-agent --force', col), { command: 'cursor-agent --force' });
    prepare('agy', col);
  }
  for (const dir of [home, path.parse(home).root, path.join(home, 'missing')]) {
    assert.equal(T.authorizedDirectory({ captainCrew: true, cwd: dir, trustedCwd: dir }, dir, home), false);
  }
  assert.equal(T.authorizedDirectory(column, home, home), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(T.authorizedDirectory(column, cwd, home), true);
  assert.equal(T.authorizedDirectory(column, cwd, path.join(home, 'isolated-home-not-created')), true);
});

test('launch stays in the authorized directory despite a different shell cwd, and cannot run after cd fails', { skip: process.platform === 'win32' }, (t) => {
  const { home, column, cwd } = fixture(t);
  const bin = path.join(home, 'cursor-agent');
  fs.writeFileSync(bin, '#!/bin/sh\npwd\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const command = T.prepareWorkspaceTrust(`"${bin}" -- "explain --trust please"`, column, cwd, home).command;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
  const result = execFileSync('/bin/sh', ['-c', command], { cwd: home, env, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(result, [cwd, '--trust', '--', 'explain --trust please']);
  fs.rmdirSync(cwd);
  const failed = require('child_process').spawnSync('/bin/sh', ['-c', command], { cwd: home, env, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '');
});

test('Cursor uses its official trust flag once; agy keeps native exact paths on both platforms', (t) => {
  const { prepare, column, cwd, home } = fixture(t);
  assert.ok(launches(prepare('cursor-agent --force --model grok-4.7-high-fast').command, 'cursor-agent', '--trust --force --model grok-4.7-high-fast'));
  assert.ok(launches(prepare('cursor-agent --trust --force').command, 'cursor-agent', '--trust --force'));
  const windows = T.prepareWorkspaceTrust('"C:\\Program Files\\Cursor\\cursor-agent.cmd" --force', column, cwd, home, 'win32').command;
  assert.ok(windows.startsWith('& { Set-Location -LiteralPath '));
  assert.ok(windows.includes("Get-Command -Name 'C:\\Program Files\\Cursor\\cursor-agent.cmd' -CommandType Application,ExternalScript"));
  assert.ok(windows.includes(').Source) --trust --force'));
  assert.ok(launches(prepare('cursor-agent -- "explain --trust please"').command, 'cursor-agent', '--trust -- "explain --trust please"'));
  assert.deepEqual(T.trustKeys('C:\\Users\\Test\\copy\\', 'C:\\Users\\Test\\copy', 'win32'), ['C:\\Users\\Test\\copy']);
  assert.deepEqual(T.trustKeys('C:\\Alias\\项目', 'C:\\Real\\项目', 'win32'), ['C:\\Alias\\项目', 'C:\\Real\\项目']);
  assert.deepEqual(T.trustKeys('/alias/copy/', '/real/copy', 'darwin'), ['/alias/copy', '/real/copy']);
});

test('compound commands, workspace overrides and other CLIs cannot acquire trust', (t) => {
  const { prepare, file } = fixture(t);
  for (const cmd of ['cd /elsewhere && agy', 'agy; cursor-agent', 'agy | cat', 'agy > out', 'agy $(pwd)', 'agy `pwd`', 'cursor-agent --workspace /other', 'cursor-agent --workspace=/other', 'cursor-agent --add-dir /other', 'cursor-agent --add-dir=/other', 'cursor-agent -w', 'cursor-agent -wother', 'cursor-agent --worktree=x', 'cursor-agent --work\\space /other', 'cursor-agent --"work"space /other', 'cursor-agent ("--work"+"space") /other', 'cursor-agent --work* /other', 'cursor-agent @launchArgs', 'cursor-agent.ps1 --workspace,/other', 'cursor-agent "hello ” --workspace /other “world"', 'agy --cwd=/other', 'gemini', 'claude', 'node fixture/cursor-agent.js']) {
    assert.deepEqual(prepare(cmd), { command: cmd }, cmd);
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(T.trustProvider('command /opt/agy --model x'), 'Antigravity');
  assert.equal(T.trustProvider('& "C:\\bin\\cursor-agent.exe" --force'), 'Cursor');
});

test('the existing privileged launch channel completes registration before returning a launch command', async (t) => {
  const { home, cwd, file, column } = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const begin = source.indexOf("handleMain('pty:prepare-launch'");
  const end = source.indexOf('\n});', begin) + 4;
  let handler, launch;
  const context = vm.createContext({
    handleMain: (_name, fn) => { handler = fn; },
    ptys: new Map([['worker', {}]]), ptyLaunchDirs: new Map([['worker', cwd]]),
    readLocalConfig: () => ({ columns: [{ id: 'worker', ...column }] }),
    prepareWorkspaceTrust: T.prepareWorkspaceTrust,
    codexLauncher: { prepare(cmd, dir) { launch = { cmd, dir, registered: JSON.parse(fs.readFileSync(file)).trustedWorkspaces.includes(cwd) }; return cmd; } },
    tudArg: null, HOME: home, send() {}, seatGate: null,
  });
  vm.runInContext(source.slice(begin, end), context);
  const command = await handler(null, { id: 'worker', command: 'agy --model x' });
  assert.ok(launches(command, 'agy', '--model x'));
  assert.deepEqual(launch, { cmd: command, dir: cwd, registered: true });
  assert.ok(launches(await handler(null, { id: 'worker', command: 'cursor-agent --force' }), 'cursor-agent', '--trust --force'));
  await assert.rejects(handler(null, { id: 'unknown', command: 'agy' }), /Invalid launch/);
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('workspace-trust-main.js'));
});
