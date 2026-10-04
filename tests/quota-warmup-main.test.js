'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createQuotaWarmupRunner, parseWarmupOutput, MODEL } = require('../quota-warmup-main');
const now = Date.parse('2026-10-04T12:00:00Z');
const nativeReset = Math.floor(now / 1000) + 1200;
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
  modelUsage: { [MODEL]: { inputTokens: 2, outputTokens: 1, provider: 'firstParty' } }, result: 'A', ...extra });
const event = (extra = {}) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: nativeReset, ...extra } });
const output = (...messages) => messages.map(JSON.stringify).join('\n');
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-warmup-unit-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.claude-us'));
  return home;
}

test('native five-hour resets are exact server seconds; missing resets are never invented', () => {
  const parsed = parseWarmupOutput(output(event(), result()), now);
  assert.equal(parsed.ok, true); assert.equal(parsed.model, MODEL);
  assert.equal(parsed.resetAt, nativeReset * 1000); assert.equal(parsed.provenNative, true);
  assert.equal(parsed.resetSource, 'rate_limit_event.five_hour');
  for (const info of [{ rateLimitType: 'seven_day' }, { rateLimitType: 'seven_day_sonnet' },
    { resetsAt: nativeReset * 1000 }, { resetsAt: String(nativeReset) }, { resetsAt: Math.floor(now / 1000) - 1 },
    { resetsAt: undefined }, { status: 'made-up' }]) {
    const value = parseWarmupOutput(output(event(info), result()), now);
    assert.equal(value.resetAt, null); assert.equal(value.provenNative, false);
  }
  const missing = parseWarmupOutput(output(result()), now);
  assert.equal(missing.ok, true); assert.equal(missing.resetAt, null);
});

test('native unified five-hour window is usable even when the binding limit is weekly', () => {
  const parsed = parseWarmupOutput(output(event({ rateLimitType: 'seven_day', resetsAt: nativeReset + 86400,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: nativeReset }, seven_day: { resetsAt: nativeReset + 86400 } } }), result()), now);
  assert.equal(parsed.resetAt, nativeReset * 1000);
  assert.equal(parsed.resetSource, 'rate_limit_event.unifiedWindows.five_hour');
  assert.equal(parsed.provenNative, true);
});

test('model-produced JSON, token usage and init model never establish quota or actual model', () => {
  const forged = output({ type: 'system', subtype: 'init', model: MODEL },
    { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(event()) }] } },
    result({ result: JSON.stringify(event()), resetAt: nativeReset, usage: { five_hour: { resetsAt: nativeReset } } }));
  assert.equal(parseWarmupOutput(forged, now).resetAt, null);
  for (const modelUsage of [undefined, {}, { 'claude-opus-5-5': { inputTokens: 2, outputTokens: 1 } },
    { [MODEL]: { inputTokens: 2, outputTokens: 1 }, 'claude-haiku-4-5': { inputTokens: 1, outputTokens: 1 } },
    { [MODEL]: { inputTokens: 2, outputTokens: 1, provider: 'vertex' } },
    { [MODEL]: { inputTokens: 0, outputTokens: 0 } }]) {
    const parsed = parseWarmupOutput(output({ type: 'system', subtype: 'init', model: MODEL }, result({ modelUsage })), now);
    assert.equal(parsed.ok, false); assert.equal(parsed.status, 'unverified-model'); assert.equal(parsed.model, null);
  }
  assert.equal(parseWarmupOutput(output(result({ num_turns: 2 })), now).ok, false);
  assert.equal(parseWarmupOutput(output(result({ modelUsage: { 'claude-sonnet-5-5-20261001': { inputTokens: 2, outputTokens: 1 } } })), now).ok, true);
});

test('native quota/auth failures are safe summaries with no raw output', () => {
  const secret = 'private-test-output-must-not-escape';
  for (const [messages, status] of [
    [[event({ status: 'rejected' }), result({ is_error: true, result: secret })], 'quota'],
    [[result({ is_error: true, api_error_status: 429, result: secret })], 'quota'],
    [[result({ is_error: true, api_error_status: 401, errors: [secret] })], 'authentication'],
    [[result({ is_error: true, api_error_status: 403, errors: [secret] })], 'authentication'],
    [[{ type: 'result', subtype: 'error_during_execution', errors: [secret] }], 'failed'],
  ]) {
    const parsed = parseWarmupOutput(output(...messages), now);
    assert.equal(parsed.ok, false); assert.equal(parsed.status, status);
    assert.equal(JSON.stringify(parsed).includes(secret), false);
  }
  assert.equal(parseWarmupOutput('not-json\n{"partial":', now).status, 'failed');
});

test('runner pins seat auth routing, disables retries and customizations, and removes its own cwd', async (t) => {
  const home = fixture(t), calls = [];
  const env = { PATH: '/fixture/bin', CLAUDE_CONFIG_DIR: '/wrong', CLAUDE_CODE_OAUTH_TOKEN: 'test-secret',
    ANTHROPIC_API_KEY: 'test-secret', ANTHROPIC_AUTH_TOKEN: 'test-secret', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_BASE_URL: 'https://not-the-seat.invalid', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk',
    AGENTDECK_CONTROL_TOKEN: 'test-secret', AGENTDECK_BOARD_CLI: '/not-used', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_MAX_RETRIES: '5' };
  const before = { ...env };
  const runner = createQuotaWarmupRunner({ home, tempRoot: home, env, now: () => now,
    execFileImpl: (binary, args, options, callback) => {
      calls.push({ binary, args, options });
      assert.equal(fs.existsSync(options.cwd), true);
      queueMicrotask(() => callback(null, output(event(), result()), 'test-secret'));
      return { kill: () => assert.fail('successful process must not be killed') };
    } });
  t.after(() => runner.dispose());
  for (const seat of [{ id: 'cn', configDir: '~/.claude' }, { id: 'us', configDir: '~/.claude-us' }]) {
    const value = await runner.run(seat);
    assert.equal(value.ok, true); assert.equal(value.seatId, seat.id); assert.equal(value.at, now);
  }
  assert.deepEqual(env, before);
  assert.equal(calls.length, 2); assert.notEqual(calls[0].options.cwd, calls[1].options.cwd);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(calls[1].options.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude-us'));
  for (const { binary, args, options } of calls) {
    assert.equal(binary, process.platform === 'win32' ? 'claude.exe' : 'claude');
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 60000); assert.equal(options.maxBuffer, 256 * 1024);
    assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES, '0');
    assert.equal(Object.keys(options.env).some((key) => key.startsWith('AGENTDECK_')), false);
    for (const key of Object.keys(before).filter((key) => key !== 'PATH' && key !== 'CLAUDE_CONFIG_DIR' && key !== 'CLAUDE_CODE_MAX_RETRIES')) assert.equal(options.env[key], undefined);
    for (const flag of ['--print', '--safe-mode', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config']) assert.equal(args.includes(flag), true);
    for (const [flag, value] of [['--model', MODEL], ['--effort', 'low'], ['--tools', ''], ['--setting-sources', ''],
      ['--settings', '{"disableAllHooks":true}'], ['--max-turns', '1'], ['--system-prompt', 'A'], ['--output-format', 'stream-json']]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.equal(args.at(-1), 'A'); assert.equal(args.includes('--bare'), false);
    assert.equal(fs.existsSync(options.cwd), false);
  }
});

test('abort only kills that runner child, returns aborted, and ignores a late success', async (t) => {
  const home = fixture(t), calls = [];
  const runner = createQuotaWarmupRunner({ home, tempRoot: home, env: {}, now: () => now,
    execFileImpl: (_binary, _args, options, callback) => {
      const call = { options, callback, kills: [] }; calls.push(call);
      return { kill: (signal) => call.kills.push(signal) };
    } });
  t.after(() => runner.dispose());
  const abort = new AbortController();
  const first = runner.run({ id: 'cn', configDir: '~/.claude' }, { signal: abort.signal });
  const second = runner.run({ id: 'us', configDir: '~/.claude-us' });
  abort.abort();
  assert.equal((await first).status, 'aborted');
  assert.deepEqual(calls[0].kills, ['SIGKILL']); assert.deepEqual(calls[1].kills, []);
  calls[0].callback(null, output(event(), result()));
  calls[1].callback(null, output(event(), result()));
  assert.equal((await second).ok, true);
  assert.equal(fs.existsSync(calls[0].options.cwd), false);
  runner.dispose(); assert.deepEqual(calls[1].kills, []);
});

test('bounded timeout and disposal resolve safely and never start after cancellation', async (t) => {
  const home = fixture(t), calls = [];
  const runner = createQuotaWarmupRunner({ home, tempRoot: home, env: {}, timeoutMs: 10, now: () => now,
    execFileImpl: (_binary, _args, options) => {
      const call = { options, kills: [] }; calls.push(call); return { kill: (signal) => call.kills.push(signal) };
    } });
  const timed = await runner.run({ id: 'cn', configDir: '~/.claude' });
  assert.equal(timed.status, 'timeout'); assert.deepEqual(calls[0].kills, ['SIGKILL']);
  const pending = runner.run({ id: 'us', configDir: '~/.claude-us' });
  runner.dispose(); assert.equal((await pending).status, 'aborted');
  assert.deepEqual(calls[1].kills, ['SIGKILL']);
  assert.equal((await runner.run({ id: 'cn', configDir: '~/.claude' })).status, 'aborted');
  assert.equal(calls.length, 2);
  const fresh = createQuotaWarmupRunner({ home, tempRoot: home, execFileImpl: () => assert.fail('pre-aborted request must not spawn') });
  assert.equal((await fresh.run({ id: 'cn', configDir: '~/.claude' }, { signal: AbortSignal.abort() })).status, 'aborted');
  fresh.dispose();
});

test('spawn errors and nonzero exit redact all output; invalid seats never spawn', async (t) => {
  const home = fixture(t);
  for (const execFileImpl of [() => { throw new Error('test-private-spawn-error'); },
    (_binary, _args, _options, callback) => { queueMicrotask(() => callback(new Error('test-private-spawn-error'), output(result()), 'test-private-spawn-error')); return {}; }]) {
    const runner = createQuotaWarmupRunner({ home, tempRoot: home, env: {}, execFileImpl });
    const value = await runner.run({ id: 'cn', configDir: '~/.claude' });
    assert.equal(value.status, 'failed'); assert.equal(JSON.stringify(value).includes('test-private-spawn-error'), false);
    runner.dispose();
  }
  const runner = createQuotaWarmupRunner({ home, tempRoot: home, execFileImpl: () => assert.fail('invalid seat must not spawn') });
  assert.equal((await runner.run({ id: '../bad', configDir: '~/.claude' })).status, 'failed');
  assert.equal((await runner.run({ id: 'us', configDir: 'relative' })).status, 'failed');
  runner.dispose();
  assert.equal(fs.readdirSync(home).some((file) => file.startsWith('agentdeck-quota-warmup-')), false);
});
