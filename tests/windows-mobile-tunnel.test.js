'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const liveDir = path.join(os.homedir(), '.config', 'agentdeck-remote');
let liveMtime = null;
try { liveMtime = fs.statSync(liveDir).mtimeMs; } catch (err) { if (err.code !== 'ENOENT') throw err; }

const { main } = require('../scripts/install-mobile-tunnel');
const win = require('../scripts/windows-mobile-tunnel');

function liveUnchanged() {
  let now = null;
  try { now = fs.statSync(liveDir).mtimeMs; } catch (err) { if (err.code !== 'ENOENT') throw err; }
  assert.equal(now, liveMtime);
}

const directory = 'C:\\Users\\example\\云端硬盘\\[01] AI\\.config\\agentdeck-remote';
const origin = 'https://agentdeck.18-139-28-180.sslip.io';

function config(extra = {}) {
  return {
    host: '18.139.28.180',
    publicOrigin: origin,
    windowsUser: 'EXAMPLEPC\\example',
    directory,
    ...extra,
  };
}

function readUtf8Bom(file) {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  return buf.subarray(3).toString('utf8');
}

function readUtf16(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf[0], 0xFF);
  assert.equal(buf[1], 0xFE);
  return buf.subarray(2).toString('utf16le');
}

test('loading the installer does not touch the live tunnel directory', () => {
  liveUnchanged();
  assert.equal(typeof main, 'function');
});

test('a partial flag does not fall through to the macOS installer', () => {
  assert.throws(() => main(['--dry-run']), /macOS installer was not run/);
  assert.throws(() => main(['--platform', 'win32']), /Re-run with --dry-run/);
  liveUnchanged();
});

test('quote and LiteralPath helpers keep bracket paths literal', () => {
  assert.equal(win.quoteWindowsProcessArg('plain'), 'plain');
  assert.equal(win.quoteWindowsProcessArg('has space'), '"has space"');
  assert.equal(win.quoteWindowsProcessArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(win.psSingleQuote("O'Brien"), "'O''Brien'");
  win.assertPs1UsesLiteralPath('Test-Path -LiteralPath $IdentityFile');
  assert.throws(() => win.assertPs1UsesLiteralPath('Test-Path $IdentityFile'), /-LiteralPath/);
  assert.throws(() => win.assertPs1UsesLiteralPath('Remove-Item -Path $IdentityFile'), /-LiteralPath|-Path/);
});

test('the Windows plan forwards only 43123 and pins the host key', () => {
  const plan = win.createWindowsPlan(config());
  assert.equal(plan.sshArgs[0], '-NT');
  assert.equal(plan.sshArgs[1], '-i');
  assert.equal(plan.sshArgs[2], path.win32.join(directory, 'tunnel_ed25519'));
  assert.equal(plan.sshExe, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  assert.ok(plan.sshArgs.includes('StrictHostKeyChecking=yes'));
  assert.ok(plan.sshArgs.includes('ExitOnForwardFailure=yes'));
  assert.ok(plan.sshArgs.includes('IdentitiesOnly=yes'));
  assert.ok(plan.sshArgs.includes('BatchMode=yes'));
  assert.ok(plan.sshArgs.includes('ClearAllForwardings=yes'));
  assert.ok(plan.sshArgs.includes('PreferredAuthentications=publickey'));
  const forward = plan.sshArgs[plan.sshArgs.indexOf('-R') + 1];
  assert.equal(forward, '127.0.0.1:43123:127.0.0.1:43121');
  assert.equal(plan.sshArgs.at(-1), 'agentdeck-tunnel-win@18.139.28.180');
  assert.equal(plan.sshArgs.some((arg) => String(arg).includes('43122')), false);
  assert.equal(plan.argumentString.includes('43122'), false);
  assert.deepEqual(plan.endpoint, { publicOrigin: origin, basePath: '/win/', label: 'Windows' });
  assert.deepEqual(Object.keys(plan.endpoint), ['publicOrigin', 'basePath', 'label']);
});

test('omitted Windows fields default to the dedicated account, ports, and label', () => {
  const plan = win.createWindowsPlan(config());
  assert.equal(plan.user, 'agentdeck-tunnel-win');
  assert.equal(plan.localPort, 43121);
  assert.equal(plan.remotePort, 43123);
  assert.equal(plan.basePath, '/win/');
  assert.equal(plan.label, 'Windows');
  assert.equal(plan.identityFile, path.win32.join(directory, 'tunnel_ed25519'));
  assert.equal(plan.knownHostsFile, path.win32.join(directory, 'known_hosts'));
});

test('Mac account, Mac port, personal keys, and secrets are refused', () => {
  const secret = 'super-secret-value';
  const cases = [
    [config({ user: 'agentdeck-tunnel' }), /agentdeck-tunnel-win/],
    [config({ remotePort: 43122 }), /43123/],
    [config({ localPort: 80 }), /43121/],
    [config({ basePath: '/mac/' }), /\/win\//],
    [config({ basePath: '/win' }), /\/win\//],
    [config({ label: 'Mac' }), /Windows/],
    [config({ publicOrigin: 'http://agentdeck.example' }), /HTTPS/],
    [config({ publicOrigin: origin + '/win/' }), /HTTPS/],
    [config({ publicOrigin: 'https://user:pw@agentdeck.example' }), /HTTPS/],
    [config({ host: 'evil;calc' }), /SSH endpoint/],
    [config({ directory: '\\\\server\\share\\.config\\agentdeck-remote' }), /local drive/],
    [config({ directory: 'C:\\Windows\\System32' }), /agentdeck-remote/],
    [config({ identityFile: 'C:\\Users\\example\\.ssh\\id_ed25519' }), /\.ssh/],
    [config({ identityFile: directory + '\\binance-proxy.pem' }), /binance-proxy/],
    [config({ password: secret }), /Unsupported/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => win.createWindowsPlan(input), (err) => {
      assert.match(err.message, pattern);
      assert.equal(err.message.includes(secret), false);
      return true;
    });
  }
});

test('paths with brackets, spaces, apostrophes, and ampersands stay literal', () => {
  const plan = win.createWindowsPlan(config());
  win.assertPs1UsesLiteralPath(plan.ps1);
  assert.match(plan.ps1, /\$IdentityFile = 'C:\\Users\\example\\云端硬盘\\\[01\] AI\\.config\\agentdeck-remote\\tunnel_ed25519'/);
  assert.match(plan.ps1, /\$BackoffSeconds = 10/);
  assert.match(plan.ps1, /CreateNoWindow = \$true/);
  assert.match(plan.ps1, /while \(\$true\)/);
  assert.ok(plan.ps1.indexOf('WaitForExit') < plan.ps1.indexOf('Start-Sleep -Seconds $BackoffSeconds'));
  assert.doesNotMatch(plan.ps1, /Start-Process|taskkill|Stop-Process|AgentDeck\.exe|2>&1|cmd\.exe/);
  assert.match(plan.argumentString, /"C:\\Users\\example\\云端硬盘\\\[01\] AI\\.config\\agentdeck-remote\\tunnel_ed25519"/);

  const quoted = win.createWindowsPlan(config({
    directory: 'C:\\Users\\O\'Brien\\.config\\agentdeck-remote',
    windowsUser: 'EXAMPLEPC\\example',
  }));
  assert.match(quoted.ps1, /\$IdentityFile = 'C:\\Users\\O''Brien\\.config\\agentdeck-remote\\tunnel_ed25519'/);

  const ampersand = win.createWindowsPlan(config({
    directory: 'C:\\Users\\A&B\\.config\\agentdeck-remote',
    windowsUser: 'EXAMPLE&PC\\example',
  }));
  assert.match(ampersand.ps1, /A&B/);
  assert.doesNotMatch(ampersand.ps1, /&amp;/);
  assert.match(ampersand.taskXml, /A&amp;B/);
  assert.match(ampersand.taskXml, /EXAMPLE&amp;PC\\example/);
  assert.doesNotMatch(ampersand.taskXml, /A&B/);
});

test('the logon task is hidden through wscript and is not started', () => {
  const plan = win.createWindowsPlan(config());
  assert.match(plan.vbs, /WScript\.Shell/);
  assert.match(plan.vbs, /-NoProfile -NonInteractive -WindowStyle Hidden/);
  assert.match(plan.vbs, /, 0, True/);
  assert.match(plan.vbs, /\[01\] AI/);
  assert.doesNotMatch(plan.vbs, /, 1, True/);
  assert.match(plan.taskXml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.doesNotMatch(plan.taskXml, /powershell\.exe/);
  assert.match(plan.taskXml, /<LogonTrigger>/);
  assert.match(plan.taskXml, /<Hidden>true<\/Hidden>/);
  assert.match(plan.taskXml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(plan.taskXml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(plan.taskXml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(plan.taskXml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(plan.taskXml, /<WakeToRun>false<\/WakeToRun>/);
  assert.doesNotMatch(plan.taskXml, /<Password>/);
  assert.deepEqual(plan.registerTask.args.slice(0, 3), ['/Create', '/TN', '\\AgentDeck-Mobile-Tunnel-Win']);
  assert.equal(plan.registerTask.args.includes('/Run'), false);
  assert.equal(plan.registerTask.file, 'C:\\Windows\\System32\\schtasks.exe');
});

test('key ACL commands grant only the installing user and do not run during planning', () => {
  const plan = win.createWindowsPlan(config());
  const identity = plan.identityFile;
  assert.deepEqual(plan.icacls[0], ['C:\\Windows\\System32\\icacls.exe', identity, '/inheritance:r']);
  assert.deepEqual(plan.icacls[1], ['C:\\Windows\\System32\\icacls.exe', identity, '/grant:r', 'EXAMPLEPC\\example:(R)']);
  assert.equal(plan.icacls[2][0], 'C:\\Windows\\System32\\icacls.exe');
  assert.equal(plan.icacls[2][2], '/remove');
  for (const sid of ['*S-1-5-18', '*S-1-5-32-544', '*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11']) {
    assert.ok(plan.icacls[2].includes(sid), sid);
  }
  assert.equal(JSON.stringify(plan.icacls).includes('Everyone'), false);
  const absent = win.windowsApplyCommands(plan, { identityExists: true }).map((cmd) => cmd.file);
  assert.equal(absent.includes('C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'), false);
  const created = win.windowsApplyCommands(plan, { identityExists: false });
  assert.equal(created.filter((cmd) => cmd.file.endsWith('ssh-keygen.exe')).length, 1);
  const keygen = created.find((cmd) => cmd.file.endsWith('ssh-keygen.exe'));
  assert.deepEqual(keygen.args, ['-q', '-t', 'ed25519', '-f', identity, '-N', '', '-C', 'agentdeck-tunnel-win']);
  assert.equal(created.some((cmd) => cmd.args.includes('/Run')), false);
  assert.equal(created.some((cmd) => /AgentDeck\.exe|taskkill|Stop-Process/i.test(cmd.file + ' ' + cmd.args.join(' '))), false);
});

test('uninstall removes the task and scripts, not the key', () => {
  const plan = win.windowsUninstallPlan(directory);
  assert.deepEqual(plan.endTask.slice(0, 4), ['C:\\Windows\\System32\\schtasks.exe', '/End', '/TN', '\\AgentDeck-Mobile-Tunnel-Win']);
  assert.deepEqual(plan.deleteTask.slice(1, 5), ['/Delete', '/TN', '\\AgentDeck-Mobile-Tunnel-Win', '/F']);
  assert.deepEqual(plan.removeFiles.map((file) => path.win32.basename(file)), [
    'agentdeck-tunnel.ps1', 'agentdeck-tunnel-hidden.vbs', 'AgentDeck-Mobile-Tunnel-Win.xml',
  ]);
  assert.ok(plan.keepFiles.some((file) => file.endsWith('\\tunnel_ed25519')));
  assert.ok(plan.keepFiles.some((file) => file.endsWith('\\endpoint.json')));
  assert.throws(() => win.assertRemovable(directory, path.win32.join(directory, 'tunnel_ed25519')), /unexpected file/);
  assert.throws(() => win.applyUninstall(plan, {
    platform: 'darwin',
    execFileSync() { throw new Error('exec called'); },
    fs,
  }), /Refusing/);
});

test('known_hosts and public key checks accept one pinned line and nothing secret', () => {
  const key = 'A'.repeat(68);
  const line = '18.139.28.180 ssh-ed25519 ' + key;
  assert.equal(win.assertPinnedKnownHosts('# comment\n' + line + '\n', '18.139.28.180'), line);
  assert.throws(() => win.assertPinnedKnownHosts(line + '\n18.139.28.180 ssh-ed25519 ' + key, '18.139.28.180'), /exactly one/);
  assert.throws(() => win.assertPinnedKnownHosts('* ssh-ed25519 ' + key, '18.139.28.180'), /one ssh-ed25519/);
  assert.throws(() => win.assertPinnedKnownHosts('|1|abc ssh-ed25519 ' + key, '18.139.28.180'), /one ssh-ed25519/);
  assert.throws(() => win.assertPinnedKnownHosts(line + '\nPRIVATE' + ' KEY', '18.139.28.180'), /private key/i);
  assert.equal(win.assertPublicKeyLine('ssh-ed25519 ' + key + ' agentdeck-tunnel-win'), 'ssh-ed25519 ' + key + ' agentdeck-tunnel-win');
  assert.throws(() => win.assertPublicKeyLine('ssh-ed25519 ' + key + ' other'), /Unexpected public key/);
});

test('dry-run writes the isolated plan and refuses to apply on this OS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-win-tunnel-'));
  const configPath = path.join(root, 'tunnel.json');
  const out = path.join(root, 'out');
  fs.writeFileSync(configPath, JSON.stringify(config()));
  let executed = false;
  const result = win.runCli({
    platform: 'win32', dryRun: true, uninstall: false, config: configPath, out, windowsUser: '', apply: false,
  }, {
    platform: 'darwin',
    homedir: os.homedir(),
    fs,
    execFileSync() { executed = true; throw new Error('exec called'); },
    log() {},
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(executed, false);
  const endpoint = JSON.parse(fs.readFileSync(path.join(out, 'endpoint.json'), 'utf8'));
  assert.deepEqual(endpoint, { publicOrigin: origin, basePath: '/win/', label: 'Windows' });
  const ps1 = readUtf8Bom(path.join(out, 'agentdeck-tunnel.ps1'));
  const xml = readUtf16(path.join(out, 'AgentDeck-Mobile-Tunnel-Win.xml'));
  assert.match(ps1, /StrictHostKeyChecking=yes/);
  assert.match(ps1, /ExitOnForwardFailure=yes/);
  assert.match(ps1, /127\.0\.0\.1:43123:127\.0\.0\.1:43121/);
  assert.match(xml, /127\.0\.0\.1:43123/);
  const view = JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8'));
  assert.equal(view.keyGenerated, false);
  assert.equal(view.taskStarted, false);
  assert.equal(view.agentDeckTouched, false);
  assert.equal(fs.readdirSync(out).includes('tunnel_ed25519'), false);
  assert.equal(JSON.stringify(view).includes('PRIVATE KEY'), false);
  assert.throws(() => win.applyWindows(win.createWindowsPlan(config()), {
    dryRun: false,
    platform: 'darwin',
    outDir: out,
    fs,
    execFileSync() { throw new Error('exec called'); },
  }), /Refusing to register/);
  liveUnchanged();
});

test('the CLI dry-run prints the SSH parameters and does not clear parent env', () => {
  const boardCli = process.env.AGENTDECK_BOARD_CLI;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-win-tunnel-cli-'));
  const configPath = path.join(root, 'tunnel.json');
  const out = path.join(root, 'out');
  fs.writeFileSync(configPath, JSON.stringify(config()));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  const child = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'install-mobile-tunnel.js'),
    '--platform', 'win32', '--dry-run', '--config', configPath, '--out', out,
  ], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  for (const needle of ['StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', '-R 127.0.0.1:43123:127.0.0.1:43121', 'ssh-keygen: not executed', 'AgentDeck was not started, stopped, or restarted.']) {
    assert.ok(child.stdout.includes(needle), needle);
  }
  assert.equal(child.stdout.includes('PRIVATE KEY'), false);
  const uninstallOut = path.join(root, 'uninstall');
  const removed = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'install-mobile-tunnel.js'),
    '--platform', 'win32', '--uninstall', '--dry-run', '--config', configPath, '--out', uninstallOut,
  ], { env, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /schtasks\.exe \/Delete \/TN \\AgentDeck-Mobile-Tunnel-Win \/F/);
  const uninstallPlan = JSON.parse(fs.readFileSync(path.join(uninstallOut, 'uninstall-plan.json'), 'utf8'));
  assert.equal(uninstallPlan.agentDeckTouched, false);
  assert.ok(uninstallPlan.keepFiles.some((file) => file.endsWith('tunnel_ed25519')));
  assert.equal(process.env.AGENTDECK_BOARD_CLI, boardCli);
  liveUnchanged();
});

test('installer sources keep macOS and Windows side effects apart', () => {
  const installSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-mobile-tunnel.js'), 'utf8');
  const winSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'windows-mobile-tunnel.js'), 'utf8');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'windows-mobile-tunnel.md'), 'utf8');
  assert.match(installSrc, /require\.main === module/);
  assert.match(installSrc, /JSON\.stringify\(\{ publicOrigin: origin\.origin \}\)/);
  assert.match(installSrc, /launchctl/);
  assert.doesNotMatch(installSrc, /schtasks/);
  assert.match(winSrc, /schtasks\.exe/);
  assert.doesNotMatch(winSrc, /launchctl/);
  assert.match(doc, /StrictHostKeyChecking=yes/);
  assert.match(doc, /127\.0\.0\.1:43123:127\.0\.0\.1:43121/);
  assert.match(doc, /agentdeck-tunnel-win/);
  assert.match(doc, /-LiteralPath/);
  assert.match(doc, /卸载/);
  assert.match(doc, /wscript\.exe/);
  assert.match(doc, /不启动/);
  assert.doesNotMatch(doc, /PRIVATE KEY/);
});
