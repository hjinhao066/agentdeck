// Background work under a terminal, read off the OS process table: the commands
// Claude's Bash or PowerShell tool started (foreground or run_in_background) and
// whatever they run. Claude's resident children and the
// terminal's own shell are not work, or no quiet session would ever be archived.
// One listing serves every terminal for CACHE_MS, so the archive check does not
// spawn ps / PowerShell on every tick.
'use strict';

const CACHE_MS = 5000;
const WIN_QUERY = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';

// [{ pid, ppid, command }] from `ps -A -o pid=,ppid=,command=`, or from the
// Win32_Process JSON (one process comes back as an object, not an array).
function parseProcessTable(text, platform) {
  if (platform === 'win32') {
    const data = JSON.parse(String(text || '').trim() || '[]');
    return (Array.isArray(data) ? data : [data]).filter((p) => p && Number.isInteger(p.ProcessId))
      .map((p) => ({ pid: p.ProcessId, ppid: Number.isInteger(p.ParentProcessId) ? p.ParentProcessId : 0, command: typeof p.CommandLine === 'string' ? p.CommandLine : '' }));
  }
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return rows;
}

// The first words of a command line, with Windows' quoted paths kept whole.
function words(command, count) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m; out.length < count && (m = re.exec(String(command || '')));) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
const program = (word) => String(word || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd)$/, '');

function isClaude(command) {
  const [first, script] = words(command, 2);
  if (program(first) === 'claude' || /[\\/]claude[\\/]versions[\\/]/i.test(first || '')) return true;
  return ['node', 'bun'].includes(program(first)) && (program(script) === 'claude' || /[\\/]claude-code[\\/]/i.test(script || ''));
}
// zsh/bash -c …, Windows cmd /c …, powershell -Command …
function isShellCommand(command) {
  const [first, ...args] = words(command, 6);
  const name = program(first), flags = args.map((a) => a.toLowerCase());
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) return flags.some((a) => /^-[a-z]*c[a-z]*$/.test(a));
  if (name === 'cmd') return flags.includes('/c');
  if (name === 'powershell' || name === 'pwsh') return flags.some((a) => /^-(?:c|command|e|ec|encodedcommand)$/.test(a));
  return false;
}

// How Claude Code (2.1.294) starts a tool command:
// - Bash tool, Mac and Git Bash on Windows: through its shell snapshot,
//   `/bin/zsh -c source …/shell-snapshots/snapshot-zsh-….sh … && eval '…'`.
// - PowerShell tool on Windows: through its launcher, `cmd.exe /d /s /c ""…\chcp.com"
//   65001 >nul & "…\pwsh.exe" … -Command "$__claudeCodeScript =
//   $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; …" > "…\tasks\<id>.output" 2>&1"` (the script
//   itself travels in that variable); with the launcher off, pwsh itself with
//   -NonInteractive … -EncodedCommand.
// Its other shell children are resident: on the Windows PC the MCP server runs as
// `cmd.exe /d /s /c "npx -y tavily-mcp"` and the status line as
// `bash.exe -c "npx -y ccstatusline@latest"`.
function isToolCommand(command) {
  if (!isShellCommand(command)) return false;
  if (/[\\/]shell-snapshots[\\/]snapshot-|\bCLAUDE_CODE_SHELL_LAUNCHER_SCRIPT\b/.test(command)) return true;
  const [first, ...args] = words(command, 8);
  const flags = args.map((a) => a.toLowerCase());
  return ['powershell', 'pwsh'].includes(program(first)) && flags.includes('-noninteractive') && flags.some((a) => /^-(?:e|ec|encodedcommand)$/.test(a));
}

// Pids of the background work under the terminal whose process is rootPid.
function shellWork(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const under = (pid) => {
    const out = [], seen = new Set([pid]), stack = [pid];
    while (stack.length) {
      for (const child of children.get(stack.pop()) || []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid); out.push(child); stack.push(child.pid);
      }
    }
    return out;
  };
  const terminal = [rows.find((row) => row.pid === rootPid), ...under(rootPid)].filter(Boolean);
  const work = new Set();
  for (const claude of terminal.filter((row) => isClaude(row.command))) {
    for (const child of children.get(claude.pid) || []) {
      if (!isToolCommand(child.command)) continue;
      work.add(child.pid);
      for (const row of under(child.pid)) work.add(row.pid);
    }
  }
  return [...work];
}

function createPtyWork({ platform = process.platform, execFile, now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cached = null;
  let pending = null;
  function table() {
    if (cached && now() - cached.at < cacheMs) return Promise.resolve(cached.rows);
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (rows) => {
        cached = { at: now(), rows };
        pending = null;
        resolve(rows);
      };
      const read = (error, stdout) => {
        let rows = null;
        if (!error) { try { rows = parseProcessTable(stdout, platform); } catch (_) {} }
        finish(rows && rows.length ? rows : null);
      };
      try {
        if (platform === 'win32') {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY],
            { timeout: 20000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, read);
        } else {
          execFile(platform === 'darwin' ? '/bin/ps' : 'ps', ['-A', '-o', 'pid=,ppid=,command='],
            { timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, read);
        }
      } catch (_) { finish(null); }
    });
    return pending;
  }
  // true / false, or null when the process table could not be read.
  async function busy(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const rows = await table();
    return rows ? shellWork(rows, pid).length > 0 : null;
  }
  return { busy };
}

module.exports = { CACHE_MS, parseProcessTable, isClaude, isShellCommand, isToolCommand, shellWork, createPtyWork };
