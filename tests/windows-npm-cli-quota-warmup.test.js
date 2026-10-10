// Regression (bug hunt 5, Windows): the five-hour quota warm-up started `claude.exe` without a
// shell. npm puts only a claude.cmd shim on PATH (the live Windows PC: D:\npm-global\claude.cmd,
// which starts node_modules\@anthropic-ai\claude-code\bin\claude.exe), so every warm-up failed:
// the live Windows quota-warmup.log had 9 attempts since 10-08, all `failed / request-failed`,
// while the Mac's log over the same days was almost all `warmed`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { windowsStarts, npmGlobal, asWindows } = require('./fixtures/windows-spawn');
const { createQuotaWarmupRunner, MODEL } = require('../quota-warmup-main');

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Windows with the npm-installed Claude CLI can run the quota warm-up', async (t) => {
  const home = tmp(t, 'agentdeck-warmup-home-');
  fs.mkdirSync(path.join(home, '.claude-us'));
  const npm = npmGlobal(tmp(t, 'agentdeck-npm-global-'));
  const env = { Path: npm.dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const now = Date.now();
  const ok = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: Math.floor(now / 1000) + 3600 } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, modelUsage: { [MODEL]: { inputTokens: 2, outputTokens: 1, provider: 'firstParty' } }, result: 'A' },
  ].map((m) => JSON.stringify(m)).join('\n');
  const started = [];
  const value = await asWindows(async () => {
    const runner = createQuotaWarmupRunner({ home, tempRoot: home, env, now: () => now,
      execFileImpl: (file, args, options, callback) => {
        started.push({ file, args, options });
        const starts = windowsStarts(file, args, options);
        queueMicrotask(() => starts ? callback(null, ok, '') : callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', ''));
        return { kill() {} };
      } });
    try { return await runner.run({ id: 'us', configDir: '~/.claude-us' }); } finally { runner.dispose(); }
  });
  assert.equal(value.status, 'success', `warm-up on Windows ended "${value.status}" (tried: ${started.map((s) => path.win32.basename(String(s.file))).join(', ')})`);
  // The native binary the shim names, started directly: no cmd.exe, no shell, the seat's own directory.
  const { file, args, options } = started.at(-1);
  assert.equal(file, npm.claudeExe);
  assert.equal(options.shell, false);
  assert.equal(args.at(-1), 'A');
  assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude-us'));
});
