const { execFile } = require('child_process');
const path = require('path');
const BoardCore = require('./board-core');

function capabilitiesFromHelp(help) {
  // Only option declarations count, not an example or description mentioning it.
  const has = (flag) => new RegExp('^\\s+(?:-\\w,\\s+)?' + flag + '(?:\\s|$)', 'm').test(help);
  return { noDaemon: has('--no-daemon'), bypass: has('--dangerously-bypass-approvals-and-sandbox'), yolo: has('--yolo') };
}

function probeCommand(program, platform) {
  const quote = (s) => "'" + s.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
  if (platform !== 'win32') return ['-l', '-c', `command ${quote(program)} --help`];
  // Resolve npm's ps1/cmd shim rather than a profile function that appends flags.
  const resolve = /[\\/]/.test(program)
    ? `(Get-Item -LiteralPath ${quote(program)} -ErrorAction Stop).FullName`
    : `(Get-Command ${quote(program)} -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1).Source`;
  // Windows PowerShell 5.1 writes a pipe in the OEM code page (GBK on a Chinese Windows): a Chinese
  // folder in the path would come back as U+FFFD. Ask for UTF-8, as pty-work.js's WIN_QUERY does.
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = ${resolve}; $h = & $p --help | Out-String; if ($LASTEXITCODE -ne 0) { exit 1 }; Write-Output ('AGENTDECK_CODEX_HELP=' + (@{ program=$p; help=$h } | ConvertTo-Json -Compress))`;
  return ['-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function createCodexLauncher({ platform = process.platform, shell, env = process.env, run = execFile } = {}) {
  const cache = new Map();
  async function prepare(command, cwd) {
    const parsed = BoardCore.codexProgram(command, platform);
    if (!parsed) return BoardCore.shellLaunchCommand(command, platform);
    const relative = /[\\/]/.test(parsed.literal) && !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(parsed.literal);
    const key = JSON.stringify([parsed.literal, relative ? cwd || '' : '', env.PATH || env.Path || '']);
    if (!cache.has(key)) {
      cache.set(key, new Promise((resolve) => {
        const done = (error, stdout) => {
          if (error) { resolve(capabilitiesFromHelp('')); return; }
          try {
            if (platform === 'win32') {
              const line = String(stdout).split(/\r?\n/).find((s) => s.startsWith('AGENTDECK_CODEX_HELP='));
              const data = JSON.parse(line.slice('AGENTDECK_CODEX_HELP='.length));
              resolve({ ...capabilitiesFromHelp(data.help), program: data.program });
            } else resolve(capabilitiesFromHelp(String(stdout)));
          } catch (_) { resolve(capabilitiesFromHelp('')); }
        };
        try { run(shell, probeCommand(parsed.literal, platform), { cwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true }, done); }
        catch (error) { done(error); }
      }));
    }
    return BoardCore.shellLaunchCommand(command, platform, await cache.get(key));
  }
  return { prepare };
}

module.exports = { capabilitiesFromHelp, probeCommand, createCodexLauncher };
