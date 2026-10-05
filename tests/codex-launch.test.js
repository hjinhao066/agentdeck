const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../board-core');
const M = require('../main-core');
const S = require('../claude-seats-core');
const { capabilitiesFromHelp: parse, createCodexLauncher, probeCommand } = require('../codex-launch');
const help = (version) => fs.readFileSync(path.join(__dirname, 'fixtures/codex-help', version + '.txt'), 'utf8');

for (const platform of ['darwin', 'win32']) {
  for (const version of ['0.154.0', '0.160.0']) {
    test(`${platform} ${version}: captain, worker, relay and saved commands use supported options`, async () => {
      let calls = 0;
      const launcher = createCodexLauncher({ platform, shell: 'shell', env: {}, run(_file, _args, _opts, cb) {
        calls++;
        const stdout = platform === 'win32' ? 'AGENTDECK_CODEX_HELP=' + JSON.stringify({ program: 'D:\\npm-global\\codex.ps1', help: help(version) }) : help(version);
        setImmediate(() => cb(null, stdout));
      } });
      const commands = [S.CODEX_COMMAND, M.checkCommand(B.commandForAgent('codex')).cmd,
        M.checkCommand('codex -m gpt-6-luna').cmd, S.relayCodexCommand('codex', 'xhigh'),
        'codex --no-daemon resume chat-1 --yolo --dangerously-bypass-approvals-and-sandbox'];
      const launches = await Promise.all(commands.map((c) => launcher.prepare(c, '/workspace')));
      assert.equal(calls, 1, 'concurrent paths share a help probe');
      for (const command of launches) {
        assert.equal((command.match(/--no-daemon/g) || []).length, version === '0.160.0' ? 1 : 0);
        assert.equal((command.match(/--dangerously-bypass-approvals-and-sandbox/g) || []).length, 1);
        assert.ok(!command.includes('--yolo'));
        assert.ok(command.startsWith(platform === 'win32' ? "& 'D:\\npm-global\\codex.ps1'" : 'command "codex"'));
      }
      assert.match(launches[2], /-m gpt-6-luna/);
      assert.match(launches[3], /model_reasoning_effort=xhigh/);
      assert.match(launches[4], /resume chat-1/);
      await launcher.prepare('codex', '/other-workspace');
      assert.equal(calls, 1, 'bare executable capabilities do not depend on cwd');
    });
  }
}

test('help declarations, not mentions in examples, determine managed flags', () => {
  assert.deepEqual(parse('Example: codex --no-daemon\n  Some prose mentions --dangerously-bypass-approvals-and-sandbox\n'), { noDaemon: false, bypass: false, yolo: false });
  const caps = parse('Options:\n  --yolo\n');
  assert.equal(B.shellLaunchCommand('codex --no-daemon --dangerously-bypass-approvals-and-sandbox', 'win32', caps), "& 'codex' --yolo");
  assert.equal(B.shellLaunchCommand('codex -- --no-daemon', 'darwin', parse(help('0.154.0'))), 'command "codex" --dangerously-bypass-approvals-and-sandbox -- --no-daemon');
});

test('failed, timed out or malformed help removes unsupported saved flags and still launches', async () => {
  for (const result of ['error', 'malformed', 'empty']) {
    let calls = 0;
    const launcher = createCodexLauncher({ platform: 'win32', shell: 'shell', run(_file, _args, opts, cb) {
      assert.equal(opts.timeout, 5000);
      calls++; cb(result === 'error' ? new Error('timeout') : null, result === 'malformed' ? 'AGENTDECK_CODEX_HELP=bad-json' : '');
    } });
    for (let i = 0; i < 2; i++) assert.equal(await launcher.prepare(B.commandForAgent('codex')), "& 'codex'");
    assert.equal(calls, 1);
  }
});

test('custom Windows quoted executable paths and probe literals preserve spaces, brackets and apostrophes', async () => {
  const binary = "C:\\[01] tools\\O'Brien\\codex.cmd";
  const command = `"${binary}" --no-daemon -c model_reasoning_effort=high`;
  let script;
  const launcher = createCodexLauncher({ platform: 'win32', shell: 'powershell.exe', run(file, args, _opts, cb) {
    assert.equal(file, 'powershell.exe');
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    cb(null, 'AGENTDECK_CODEX_HELP=' + JSON.stringify({ program: binary, help: help('0.154.0') }));
  } });
  const launch = await launcher.prepare(command);
  assert.ok(script.includes("Get-Item -LiteralPath 'C:\\[01] tools\\O''Brien\\codex.cmd' -ErrorAction Stop"));
  assert.equal(launch, "& 'C:\\[01] tools\\O''Brien\\codex.cmd' --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=high");
  assert.equal(B.shellLaunchCommand(launch, 'win32', { ...parse(help('0.154.0')), program: binary }), launch);
  assert.equal(await launcher.prepare(launch), launch, 'PowerShell escaped apostrophes resolve to the same executable');
});

test('non-Codex commands never probe and relative executables have independent cwd cache entries', async () => {
  let calls = 0;
  const launcher = createCodexLauncher({ platform: 'darwin', shell: '/bin/sh', run(_file, _args, _opts, cb) { calls++; cb(null, help('0.154.0')); } });
  assert.equal(await launcher.prepare('node fake-agent.js'), 'node fake-agent.js');
  assert.equal(calls, 0);
  for (const command of ['./codex', 'tools/codex']) {
    for (const cwd of ['/first', '/second', '/first']) await launcher.prepare(command, cwd);
  }
  assert.equal(calls, 4);
  assert.deepEqual(probeCommand("/tmp/O'Brien/codex", 'darwin'), ['-l', '-c', "command '/tmp/O'\\''Brien/codex' --help"]);
});
