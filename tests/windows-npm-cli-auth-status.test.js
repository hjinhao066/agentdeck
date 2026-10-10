// Regression (bug hunt 5, Windows): the seat list asks `claude auth status --json` which account a
// seat directory is really signed in to. It started `claude.exe` without a shell, and with the
// npm-installed CLI (only claude.cmd on PATH, as on the live Windows PC) the start always failed,
// so on Windows the CLI's answer was never used: a seat whose credentials file is still there but
// whose CLI says it is signed out read as signed in, and a /login to another account in the same
// directory kept the old account name until the metadata file changed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { windowsStarts, npmGlobal, asWindows } = require('./fixtures/windows-spawn');
const M = require('../claude-seats-main');

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Windows with the npm-installed Claude CLI gets the seat\'s real sign-in state', async (t) => {
  const home = tmp(t, 'agentdeck-auth-home-');
  fs.mkdirSync(path.join(home, '.claude-us'));
  const npm = npmGlobal(tmp(t, 'agentdeck-npm-global-'));
  const env = { Path: npm.dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const started = [];
  const value = await asWindows(() => M.readAuthStatus({ id: 'us', name: 'US', configDir: '~/.claude-us' }, home, env, (file, args, options, callback) => {
    started.push({ file, args, options });
    const starts = windowsStarts(file, args, options);
    // Signed out: the CLI exits 1 but still prints its JSON.
    queueMicrotask(() => starts ? callback(Object.assign(new Error('exit 1'), { code: 1 }), '{"loggedIn":false}', '')
      : callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''));
    return { kill() {} };
  }));
  assert.deepEqual(value, { loggedIn: false, email: '' }, `no answer from the Claude CLI on Windows (tried: ${started.map((s) => path.win32.basename(String(s.file))).join(', ')})`);
  const { file, args, options } = started.at(-1);
  assert.equal(file, npm.claudeExe);
  assert.deepEqual(args, ['auth', 'status', '--json']);
  assert.equal(options.shell, false);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude-us'));
});
