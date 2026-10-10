// Regression (bug hunt 5, Windows): the Codex quota row reads the official account/rateLimits/read
// RPC from `codex app-server`, started without a shell. It asked Windows for `codex.exe`, but npm
// puts only a `codex.cmd` shim on PATH (the live Windows PC: D:\npm-global\codex.cmd, which runs
// node on the package's codex.js), so the start failed every minute: the Windows Codex row was
// last fed by 会话屏幕 on 10-09 00:40 with no windows, while the Mac row was fed by
// 「Codex 官方 account/rateLimits/read」 every minute.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { windowsStarts, npmGlobal, asWindows } = require('./fixtures/windows-spawn');
const { readCodex, cliLaunch } = require('../quota-codex');

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-npm-global-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The app server: answers initialize, account/read and account/rateLimits/read.
function codexServer() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', (chunk) => {
    for (const text of String(chunk).split('\n').filter(Boolean)) {
      const m = JSON.parse(text);
      if (!m.id) continue;
      const result = m.id === 2 ? { account: { type: 'chatgpt', email: 'alice@example.com' } }
        : m.id === 3 ? { rateLimits: { limitId: 'codex', primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } : {};
      setImmediate(() => child.stdout.write(JSON.stringify({ id: m.id, result }) + '\n'));
    }
  });
  return child;
}
function missing(file) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })));
  return child;
}

test('Windows with the npm-installed Codex CLI still gets the official Codex quota', async (t) => {
  const npm = npmGlobal(tmp(t));
  const env = { Path: npm.dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const started = [];
  const sample = await asWindows(() => readCodex(env, (file, args, options) => {
    started.push({ file, args, options });
    return windowsStarts(file, args, { ...options, env: options.env }) ? codexServer() : missing(file);
  }, 2000));
  assert.ok(sample && sample.windows?.length === 1, `no official Codex sample on Windows (tried: ${started.map((s) => path.win32.basename(String(s.file))).join(', ')})`);
  assert.equal(sample.windows[0].remaining, 72);
  // npm's own entry, run by this app's Node: no cmd.exe, no shell, nothing outside the npm folder.
  const { file, args, options } = started.at(-1);
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [npm.codexJs, 'app-server']);
  assert.equal(options.shell, false);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'the caller\'s environment is not changed');
});

test('Windows resolution reads the shim as data and keeps to the npm folder', async (t) => {
  const npm = npmGlobal(tmp(t));
  await asWindows(() => {
    // A native codex.exe on PATH wins over a shim later on PATH, as Windows itself would pick it.
    const first = tmp(t);
    fs.writeFileSync(path.join(first, 'codex.exe'), 'MZ');
    assert.deepEqual(cliLaunch('codex', ['app-server'], { PATH: `${first};${npm.dir}` }).file, path.join(first, 'codex.exe'));
    // Claude's shim starts the native binary inside its package directly.
    const claude = cliLaunch('claude', ['auth', 'status'], { PATH: npm.dir });
    assert.deepEqual([claude.file, claude.args], [npm.claudeExe, ['auth', 'status']]);
    // A shim that points outside its folder, or runs anything else, is not followed: the old
    // bare `<name>.exe` is what is started, and it fails as it did before.
    const odd = tmp(t);
    fs.writeFileSync(path.join(odd, 'codex.cmd'), '@ECHO off\r\n"%dp0%\\..\\elsewhere\\codex.exe" %*\r\npowershell -Command arbitrary\r\n');
    assert.equal(cliLaunch('codex', ['app-server'], { PATH: odd }).file, 'codex.exe');
    assert.equal(cliLaunch('codex', [], {}).file, 'codex.exe');
  });
  // Everywhere else the bare name, as before.
  assert.deepEqual(cliLaunch('codex', ['app-server'], { PATH: npm.dir }, 'darwin'), { file: 'codex', args: ['app-server'], env: { PATH: npm.dir } });
});
