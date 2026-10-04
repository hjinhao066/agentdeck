'use strict';

// Windows half of the mobile SSH tunnel. Pure planning runs anywhere.
// Applying a plan registers a logon task only on win32, and never starts it.
// No private key material belongs in this file.

const path = require('node:path');

const WINDOWS_USER = 'agentdeck-tunnel-win';
const LOCAL_PORT = 43121;
const REMOTE_PORT = 43123;
const TASK_NAME = '\\AgentDeck-Mobile-Tunnel-Win';
const SSH_EXE = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const SSH_KEYGEN = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe';
const ICACLS = 'C:\\Windows\\System32\\icacls.exe';
const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const REMOVABLE = ['agentdeck-tunnel.ps1', 'agentdeck-tunnel-hidden.vbs', 'AgentDeck-Mobile-Tunnel-Win.xml'];
const ALLOWED_FIELDS = new Set([
  'host', 'user', 'identityFile', 'knownHostsFile', 'localPort', 'remotePort',
  'publicOrigin', 'basePath', 'label', 'windowsUser', 'directory',
]);
const PATH_CMDLETS = [
  'Add-Content', 'Clear-Content', 'Copy-Item', 'Get-Acl', 'Get-ChildItem', 'Get-Content',
  'Get-Item', 'Move-Item', 'New-Item', 'Out-File', 'Remove-Item', 'Set-Acl', 'Set-Content',
  'Set-Item', 'Test-Path',
];
const REMOVE_SIDS = ['*S-1-5-18', '*S-1-5-32-544', '*S-1-1-0', '*S-1-5-32-545', '*S-1-5-11'];

const SUPERVISOR_BODY = [
  'function Write-TunnelLog([string]$Message) {',
  '  try {',
  '    $line = (Get-Date -Format \'yyyy-MM-ddTHH:mm:ssK\') + \' \' + $Message',
  '    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8',
  '  } catch { }',
  '}',
  'while ($true) {',
  '  $proc = $null',
  '  try {',
  '    if (-not (Test-Path -LiteralPath $SshExe)) { Write-TunnelLog \'ssh.exe missing\' }',
  '    elseif (-not (Test-Path -LiteralPath $IdentityFile)) { Write-TunnelLog \'identity missing\' }',
  '    elseif (-not (Test-Path -LiteralPath $KnownHostsFile)) { Write-TunnelLog \'known_hosts missing\' }',
  '    else {',
  '      $proc = New-Object System.Diagnostics.Process',
  '      $proc.StartInfo.FileName = $SshExe',
  '      $proc.StartInfo.Arguments = $Arguments',
  '      $proc.StartInfo.UseShellExecute = $false',
  '      $proc.StartInfo.CreateNoWindow = $true',
  '      $proc.StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
  '      $proc.StartInfo.RedirectStandardError = $true',
  '      $proc.StartInfo.RedirectStandardOutput = $true',
  '      $proc.StartInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8',
  '      $proc.StartInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8',
  '      [void]$proc.Start()',
  '      $outTask = $proc.StandardOutput.ReadToEndAsync()',
  '      $errTask = $proc.StandardError.ReadToEndAsync()',
  '      $proc.WaitForExit()',
  '      $err = \'\'',
  '      if ($errTask.Result) { $err = [string]$errTask.Result }',
  '      [void]$outTask.Result',
  '      if ($err.Length -gt 4000) { $err = $err.Substring(0, 4000) }',
  '      $err = $err.Replace("`r", \' \').Replace("`n", \' \').Trim()',
  '      Write-TunnelLog (\'ssh exited \' + $proc.ExitCode + \' \' + $err)',
  '    }',
  '  } catch {',
  '    Write-TunnelLog \'ssh failed to start\'',
  '  } finally {',
  '    if ($null -ne $proc) { try { $proc.Dispose() } catch { } }',
  '  }',
  '  Start-Sleep -Seconds $BackoffSeconds',
  '}',
  '',
].join('\r\n');

function parseArgs(argv) {
  const args = { platform: '', dryRun: false, uninstall: false, config: '', out: '', windowsUser: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const take = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + token.split('=')[0]);
      return value.trim();
    };
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--uninstall') args.uninstall = true;
    else if (token === '--apply') args.apply = true;
    else if (token === '--platform') args.platform = take();
    else if (token.startsWith('--platform=')) args.platform = token.slice('--platform='.length).trim();
    else if (token === '--config') args.config = take();
    else if (token.startsWith('--config=')) args.config = token.slice('--config='.length).trim();
    else if (token === '--out') args.out = take();
    else if (token.startsWith('--out=')) args.out = token.slice('--out='.length).trim();
    else if (token === '--windows-user') args.windowsUser = take();
    else if (token.startsWith('--windows-user=')) args.windowsUser = token.slice('--windows-user='.length).trim();
    else throw new Error('Unknown argument.');
  }
  if (args.dryRun && args.apply) throw new Error('Use either --dry-run or --apply.');
  if (args.platform && args.platform !== 'win32' && args.platform !== 'darwin') throw new Error('Unsupported platform.');
  return args;
}

function psSingleQuote(value) {
  return '\'' + String(value).replace(/'/g, '\'\'') + '\'';
}

function quoteWindowsProcessArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\t "]/.test(text)) return text;
  let out = '"';
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { slashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    if (slashes) { out += '\\'.repeat(slashes); slashes = 0; }
    out += ch;
  }
  if (slashes) out += '\\'.repeat(slashes * 2);
  out += '"';
  return out;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTrail(value) {
  return String(value).replace(/\\+$/g, '');
}

function samePath(left, right) {
  return stripTrail(path.win32.normalize(left)).toLowerCase() === stripTrail(path.win32.normalize(right)).toLowerCase();
}

function assertDirectory(value) {
  if (typeof value !== 'string' || !value) throw new Error('A tunnel directory is required.');
  const norm = stripTrail(path.win32.normalize(value));
  if (!/^[A-Za-z]:\\/.test(norm)) throw new Error('The tunnel directory must be a local drive path.');
  if (/[<>"|?*\u0000-\u001f%]/.test(norm.slice(2))) throw new Error('The tunnel directory contains unsupported characters.');
  if (norm.split('\\').includes('..')) throw new Error('Path traversal is not allowed.');
  if (!/\\\.config\\agentdeck-remote$/i.test(norm)) throw new Error('Windows tunnel files must live in .config\\agentdeck-remote.');
  return norm;
}

function assertPublicOrigin(value) {
  if (typeof value !== 'string') throw new Error('An HTTPS origin without a path is required.');
  let origin;
  try { origin = new URL(value); } catch (_) { throw new Error('An HTTPS origin without a path is required.'); }
  if (origin.protocol !== 'https:' || origin.origin !== value || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('An HTTPS origin without a path is required.');
  }
  return origin.origin;
}

function assertWindowsUser(value) {
  if (typeof value !== 'string' || !/^[^\\<>"|\r\n%]{1,64}\\[^\\<>"|\r\n%]{1,64}$/.test(value)) {
    throw new Error('windowsUser must be COMPUTER\\name.');
  }
  return value;
}

function assertPs1UsesLiteralPath(ps1) {
  for (const line of String(ps1).split(/\r?\n/)) {
    const code = line.replace(/#.*$/, '');
    for (const name of PATH_CMDLETS) {
      const re = new RegExp('(^|[^A-Za-z])' + name + '([^A-Za-z]|$)');
      if (re.test(code) && !/-LiteralPath\b/.test(code)) throw new Error('PowerShell path cmdlet without -LiteralPath.');
    }
  }
  if (/(^|[\s;(])-Path\b/.test(ps1)) throw new Error('PowerShell -Path is not allowed; use -LiteralPath.');
}

function assertPinnedKnownHosts(text, host) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8192) throw new Error('known_hosts is not a pinned host key.');
  if (text.includes('PRIVATE' + ' KEY')) throw new Error('known_hosts must not contain a private key.');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines.length !== 1) throw new Error('known_hosts must contain exactly one pinned host key.');
  const escaped = String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + ' ssh-ed25519 [A-Za-z0-9+/]{50,}={0,2}$');
  if (!re.test(lines[0])) throw new Error('known_hosts must pin this host with one ssh-ed25519 key.');
  return lines[0];
}

function assertPublicKeyLine(text) {
  const line = String(text).trim();
  if (!line || line.includes('\n') || line.includes('PRIVATE' + ' KEY')) throw new Error('Unexpected public key.');
  if (!/^ssh-ed25519 [A-Za-z0-9+/]{50,}={0,2} agentdeck-tunnel-win$/.test(line)) throw new Error('Unexpected public key.');
  return line;
}

function assertRemovable(directory, file) {
  const dir = assertDirectory(directory);
  const base = path.win32.basename(file);
  if (!REMOVABLE.includes(base) || !samePath(path.win32.dirname(file), dir)) {
    throw new Error('Refusing to delete an unexpected file.');
  }
  return path.win32.join(dir, base);
}

function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tunnel config.');
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error('Unsupported tunnel.json field.');
  }
  const directory = assertDirectory(input.directory);
  const identityFile = path.win32.join(directory, 'tunnel_ed25519');
  const knownHostsFile = path.win32.join(directory, 'known_hosts');
  if (input.identityFile != null) {
    if (typeof input.identityFile !== 'string') throw new Error('Invalid identityFile.');
    if (/binance-proxy/i.test(input.identityFile)) throw new Error('Refusing to reuse binance-proxy.');
    if (/(^|[\\/])\.ssh([\\/]|$)/i.test(input.identityFile)) throw new Error('Refusing a personal .ssh identity.');
    if (!samePath(input.identityFile, identityFile)) throw new Error('The Windows identity must be tunnel_ed25519 in agentdeck-remote.');
  }
  if (input.knownHostsFile != null) {
    if (typeof input.knownHostsFile !== 'string') throw new Error('Invalid knownHostsFile.');
    if (!samePath(input.knownHostsFile, knownHostsFile)) throw new Error('known_hosts must be the dedicated file in agentdeck-remote.');
  }
  const user = input.user == null ? WINDOWS_USER : input.user;
  if (user !== WINDOWS_USER) throw new Error('Windows tunnel account must be agentdeck-tunnel-win.');
  const localPort = input.localPort == null ? LOCAL_PORT : input.localPort;
  const remotePort = input.remotePort == null ? REMOTE_PORT : input.remotePort;
  if (localPort !== LOCAL_PORT || remotePort !== REMOTE_PORT) throw new Error('Windows ports must be local 43121 and remote 43123.');
  const basePath = input.basePath == null ? '/win/' : input.basePath;
  const label = input.label == null ? 'Windows' : input.label;
  if (basePath !== '/win/' || label !== 'Windows') throw new Error('Windows endpoint must use basePath /win/ and label Windows.');
  if (typeof input.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(input.host) || input.host.startsWith('.') || input.host.endsWith('.') || input.host.includes('..')) {
    throw new Error('Invalid SSH endpoint.');
  }
  return {
    directory,
    identityFile,
    knownHostsFile,
    publicKeyFile: identityFile + '.pub',
    user,
    localPort,
    remotePort,
    basePath,
    label,
    host: input.host,
    publicOrigin: assertPublicOrigin(input.publicOrigin),
    windowsUser: assertWindowsUser(input.windowsUser),
  };
}

function icaclsCommands(identityFile, windowsUser) {
  return [
    [ICACLS, identityFile, '/inheritance:r'],
    [ICACLS, identityFile, '/grant:r', windowsUser + ':(R)'],
    [ICACLS, identityFile, '/remove', ...REMOVE_SIDS],
  ];
}

function renderPs1(plan) {
  const lines = [
    '#requires -Version 5.1',
    '# AgentDeck Windows SSH tunnel supervisor.',
    '# After ssh exits, wait 10 seconds and connect again. No window. Does not start, stop, or restart AgentDeck.',
    '$ErrorActionPreference = \'Continue\'',
    '$SshExe = ' + psSingleQuote(plan.sshExe),
    '$IdentityFile = ' + psSingleQuote(plan.identityFile),
    '$KnownHostsFile = ' + psSingleQuote(plan.knownHostsFile),
    '$LogPath = ' + psSingleQuote(plan.logPath),
    '$BackoffSeconds = 10',
    '$Arguments = ' + psSingleQuote(plan.argumentString),
    '',
    SUPERVISOR_BODY,
  ];
  return lines.join('\r\n');
}

function buildVbs(ps1Path) {
  const inner = POWERSHELL + ' -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + ps1Path + '"';
  return [
    '\' Hidden launcher. Window style 0, and True waits so the scheduled task stays Running.',
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Run "' + inner.replace(/"/g, '""') + '", 0, True',
    '',
  ].join('\r\n');
}

function buildTaskXml(plan) {
  const user = xmlEscape(plan.windowsUser);
  const description = xmlEscape('SSH reverse tunnel: VPS 127.0.0.1:43123 to local 127.0.0.1:43121. Does not start, stop, or restart AgentDeck.');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <URI>' + xmlEscape(TASK_NAME) + '</URI>',
    '    <Description>' + description + '</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '      <UserId>' + user + '</UserId>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>' + user + '</UserId>',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>999</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>' + WSCRIPT + '</Command>',
    '      <Arguments>' + xmlEscape('"' + plan.vbsPath + '"') + '</Arguments>',
    '      <WorkingDirectory>' + xmlEscape(plan.directory) + '</WorkingDirectory>',
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

function assertSupervisor(plan) {
  assertPs1UsesLiteralPath(plan.ps1);
  if (!plan.ps1.includes('$BackoffSeconds = 10')) throw new Error('The supervisor must wait 10 seconds.');
  const waitAt = plan.ps1.indexOf('WaitForExit');
  const sleepAt = plan.ps1.indexOf('Start-Sleep -Seconds $BackoffSeconds');
  if (waitAt < 0 || sleepAt < waitAt) throw new Error('Sleep must happen after ssh exits.');
  if (!plan.ps1.includes('CreateNoWindow = $true')) throw new Error('ssh must be started without a window.');
  if (/Start-Process|taskkill|Stop-Process|AgentDeck\.exe|2>&1|Invoke-Expression|\biex\b|cmd\.exe/i.test(plan.ps1)) {
    throw new Error('The supervisor contains a forbidden command.');
  }
  if (!plan.vbs.includes(', 0, True')) throw new Error('The launcher must hide the window and wait.');
  if (!plan.vbs.includes('-WindowStyle Hidden') || !plan.vbs.includes('-NonInteractive') || !plan.vbs.includes('-NoProfile')) {
    throw new Error('The launcher must start PowerShell hidden.');
  }
  const forward = plan.sshArgs[plan.sshArgs.indexOf('-R') + 1];
  if (forward !== '127.0.0.1:43123:127.0.0.1:43121') throw new Error('Refusing a non-Windows forward.');
  for (const needle of ['StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes']) {
    if (!plan.sshArgs.includes(needle)) throw new Error('Missing SSH parameter.');
  }
  if (plan.sshArgs[plan.sshArgs.length - 1] !== plan.user + '@' + plan.host) throw new Error('Unexpected SSH destination.');
  if (!plan.taskXml.includes('<Command>' + WSCRIPT + '</Command>')) throw new Error('The task must start through wscript.');
  if (plan.taskXml.includes('powershell.exe</Command>')) throw new Error('The task must not start PowerShell directly.');
  for (const needle of ['<Hidden>true</Hidden>', '<LogonTrigger>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<LogonType>InteractiveToken</LogonType>']) {
    if (!plan.taskXml.includes(needle)) throw new Error('The scheduled task is missing a required setting.');
  }
  if (plan.taskXml.includes('<Password>')) throw new Error('The task must not store a password.');
  if (plan.registerTask.args.includes('/Run')) throw new Error('The installer must not start the task.');
}

function createWindowsPlan(input) {
  const config = normalizeConfig(input);
  const sshArgs = [
    '-NT', '-i', config.identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + config.knownHostsFile,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    '-R', '127.0.0.1:' + REMOTE_PORT + ':127.0.0.1:' + LOCAL_PORT,
    config.user + '@' + config.host,
  ];
  const plan = {
    ...config,
    sshExe: SSH_EXE,
    sshArgs,
    argumentString: sshArgs.map(quoteWindowsProcessArg).join(' '),
    logPath: path.win32.join(config.directory, 'tunnel-error.log'),
    ps1Path: path.win32.join(config.directory, 'agentdeck-tunnel.ps1'),
    vbsPath: path.win32.join(config.directory, 'agentdeck-tunnel-hidden.vbs'),
    xmlPath: path.win32.join(config.directory, 'AgentDeck-Mobile-Tunnel-Win.xml'),
    endpoint: { publicOrigin: config.publicOrigin, basePath: '/win/', label: 'Windows' },
    icacls: icaclsCommands(config.identityFile, config.windowsUser),
    keygen: {
      file: SSH_KEYGEN,
      args: ['-q', '-t', 'ed25519', '-f', config.identityFile, '-N', '', '-C', WINDOWS_USER],
    },
    registerTask: {
      file: SCHTASKS,
      args: ['/Create', '/TN', TASK_NAME, '/XML', path.win32.join(config.directory, 'AgentDeck-Mobile-Tunnel-Win.xml'), '/F'],
    },
  };
  plan.ps1 = renderPs1(plan);
  plan.vbs = buildVbs(plan.ps1Path);
  plan.taskXml = buildTaskXml(plan);
  assertSupervisor(plan);
  return plan;
}

function windowsApplyCommands(plan, options = {}) {
  const commands = [{ file: WHOAMI, args: [] }];
  if (!options.identityExists) commands.push(plan.keygen);
  for (const cmd of plan.icacls) commands.push({ file: cmd[0], args: cmd.slice(1) });
  commands.push(plan.registerTask);
  return commands;
}

function windowsUninstallPlan(directory) {
  const dir = assertDirectory(directory);
  const removeFiles = REMOVABLE.map((name) => assertRemovable(dir, path.win32.join(dir, name)));
  return {
    directory: dir,
    endTask: [SCHTASKS, '/End', '/TN', TASK_NAME],
    deleteTask: [SCHTASKS, '/Delete', '/TN', TASK_NAME, '/F'],
    removeFiles,
    keepFiles: ['tunnel_ed25519', 'tunnel_ed25519.pub', 'known_hosts', 'endpoint.json', 'tunnel.json', 'tunnel-error.log']
      .map((name) => path.win32.join(dir, name)),
  };
}

function withUtf8Bom(text) {
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
}

function withUtf16Bom(text) {
  return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
}

function renderWindowsArtifacts(plan) {
  return {
    'endpoint.json': Buffer.from(JSON.stringify(plan.endpoint), 'utf8'),
    'agentdeck-tunnel.ps1': withUtf8Bom(plan.ps1),
    'agentdeck-tunnel-hidden.vbs': withUtf16Bom(plan.vbs),
    'AgentDeck-Mobile-Tunnel-Win.xml': withUtf16Bom(plan.taskXml),
  };
}

function publicView(plan) {
  const uninstall = windowsUninstallPlan(plan.directory);
  return {
    taskName: TASK_NAME,
    sshExe: plan.sshExe,
    sshArgs: plan.sshArgs,
    icacls: plan.icacls,
    keygenIfMissing: plan.keygen,
    registerTask: plan.registerTask,
    uninstall: {
      endTask: uninstall.endTask,
      deleteTask: uninstall.deleteTask,
      removeFiles: uninstall.removeFiles,
      keepFiles: uninstall.keepFiles,
    },
    reconnectSeconds: 10,
    agentDeckTouched: false,
    keyGenerated: false,
    taskStarted: false,
  };
}

function writeArtifacts(dir, artifacts, fs) {
  if (!dir || typeof dir !== 'string') throw new Error('An output directory is required.');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(artifacts)) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Unexpected artifact name.');
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
  }
}

function existsFile(fs, file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function hiddenExec(io, file, args) {
  return io.execFileSync(file, args, { windowsHide: true, encoding: 'utf8' });
}

function applyWindows(plan, io) {
  if (io.dryRun) {
    const artifacts = renderWindowsArtifacts(plan);
    artifacts['plan.json'] = Buffer.from(JSON.stringify(publicView(plan), null, 2), 'utf8');
    writeArtifacts(io.outDir, artifacts, io.fs);
    return { mode: 'dry-run' };
  }
  if (io.platform !== 'win32') throw new Error('Refusing to register the Windows tunnel on this operating system.');
  const who = String(hiddenExec(io, WHOAMI, [])).trim();
  if (who.toLowerCase() !== plan.windowsUser.toLowerCase()) throw new Error('windowsUser does not match the installing account.');
  io.fs.mkdirSync(plan.directory, { recursive: true });
  if (!existsFile(io.fs, plan.identityFile)) hiddenExec(io, plan.keygen.file, plan.keygen.args);
  if (!existsFile(io.fs, plan.identityFile)) throw new Error('The identity file was not created.');
  for (const cmd of plan.icacls) hiddenExec(io, cmd[0], cmd.slice(1));
  assertPinnedKnownHosts(io.fs.readFileSync(plan.knownHostsFile, 'utf8'), plan.host);
  const publicKey = assertPublicKeyLine(io.fs.readFileSync(plan.publicKeyFile, 'utf8'));
  writeArtifacts(plan.directory, renderWindowsArtifacts(plan), io.fs);
  hiddenExec(io, plan.registerTask.file, plan.registerTask.args);
  return { mode: 'applied', publicKey };
}

function applyUninstall(plan, io) {
  if (io.platform !== 'win32') throw new Error('Refusing to change the Windows tunnel on this operating system.');
  const exec = (cmd) => hiddenExec(io, cmd[0], cmd.slice(1));
  try { exec(plan.endTask); } catch (_) {}
  try { exec(plan.deleteTask); } catch (_) { throw new Error('Could not delete the scheduled task.'); }
  for (const file of plan.removeFiles) {
    assertRemovable(plan.directory, file);
    io.fs.rmSync(file, { force: true });
  }
}

function loadInput(configPath, args, io) {
  const stat = io.fs.statSync(configPath);
  if (!stat.isFile() || stat.size > 65536) throw new Error('tunnel.json must be a small file.');
  const text = io.fs.readFileSync(configPath, 'utf8');
  if (text.includes('PRIVATE' + ' KEY')) throw new Error('tunnel.json must not contain a key.');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw new Error('tunnel.json is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tunnel config.');
  if (args.windowsUser) {
    if (parsed.windowsUser && parsed.windowsUser !== args.windowsUser) throw new Error('windowsUser does not match --windows-user.');
    parsed = { ...parsed, windowsUser: args.windowsUser };
  }
  return parsed;
}

function describePlan(plan) {
  return [
    'dry-run: Windows tunnel plan',
    'ssh: ' + plan.argumentString,
    'StrictHostKeyChecking=yes',
    'ExitOnForwardFailure=yes',
    '-R 127.0.0.1:43123:127.0.0.1:43121',
    'task: ' + TASK_NAME,
    'account: agentdeck-tunnel-win',
    'ssh-keygen: not executed',
    'schtasks: not executed',
    'AgentDeck was not started, stopped, or restarted.',
  ].join('\n');
}

function runCli(args, io) {
  const log = io.log || ((line) => console.log(line));
  if (!args.dryRun && io.platform !== 'win32') {
    throw new Error('Refusing to register the Windows tunnel on this operating system. Re-run with --dry-run.');
  }
  if (args.dryRun && !args.out) throw new Error('Pass --out for dry-run.');
  let configPath = args.config;
  if (!configPath) {
    if (args.dryRun || io.platform !== 'win32') throw new Error('Pass --config pointing at a private tunnel.json.');
    configPath = path.win32.join(io.homedir, '.config', 'agentdeck-remote', 'tunnel.json');
  }
  let input = loadInput(configPath, args, io);
  if (!input.directory) {
    if (!args.dryRun && io.platform === 'win32') input = { ...input, directory: path.win32.join(io.homedir, '.config', 'agentdeck-remote') };
    else throw new Error('tunnel.json must include directory.');
  }
  if (args.uninstall) {
    const plan = windowsUninstallPlan(normalizeConfig(input).directory);
    if (!args.dryRun) {
      applyUninstall(plan, io);
      log('Windows tunnel task removed. AgentDeck was not started, stopped, or restarted.');
      return { mode: 'uninstalled' };
    }
    writeArtifacts(args.out, {
      'uninstall-plan.json': Buffer.from(JSON.stringify({
        endTask: plan.endTask,
        deleteTask: plan.deleteTask,
        removeFiles: plan.removeFiles,
        keepFiles: plan.keepFiles,
        agentDeckTouched: false,
      }, null, 2), 'utf8'),
    }, io.fs);
    log([
      'dry-run: uninstall Windows tunnel',
      plan.endTask.join(' '),
      plan.deleteTask.join(' '),
      'AgentDeck was not started, stopped, or restarted.',
    ].join('\n'));
    return { mode: 'dry-run-uninstall' };
  }
  const plan = createWindowsPlan(input);
  if (args.dryRun) {
    applyWindows(plan, { ...io, dryRun: true, outDir: args.out });
    log(describePlan(plan));
    return { mode: 'dry-run' };
  }
  const applied = applyWindows(plan, io);
  log('public key for agentdeck-tunnel-win:\n' + applied.publicKey);
  log('Windows tunnel task registered. It was not started. AgentDeck was not started, stopped, or restarted.');
  return applied;
}

module.exports = {
  TASK_NAME,
  WINDOWS_USER,
  parseArgs,
  psSingleQuote,
  quoteWindowsProcessArg,
  xmlEscape,
  assertDirectory,
  assertPs1UsesLiteralPath,
  assertPinnedKnownHosts,
  assertPublicKeyLine,
  assertRemovable,
  normalizeConfig,
  createWindowsPlan,
  windowsApplyCommands,
  windowsUninstallPlan,
  renderWindowsArtifacts,
  applyWindows,
  applyUninstall,
  runCli,
};
