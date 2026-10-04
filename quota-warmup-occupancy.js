'use strict';
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

async function scanProcesses({ platform = process.platform, execFileImpl = execFile } = {}) {
  const command = platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]
    : ['-eo', 'pid=,ppid=,comm='];
  // Never request process arguments or environment: either can hold credentials.
  const output = await new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  if (typeof output !== 'string' || !output.trim()) throw new Error('Process inventory unavailable');
  if (platform === 'win32') {
    const value = JSON.parse(output.replace(/^\uFEFF/, ''));
    return (Array.isArray(value) ? value : [value]).map((row) => ({
      pid: row.ProcessId, ppid: row.ParentProcessId, comm: row.ExecutablePath || row.Name,
    }));
  }
  return output.trim().split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) throw new Error('Incomplete process inventory');
    return { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] };
  });
}

function isClaudeProcess(comm) {
  const normalized = String(comm).replace(/\\/g, '/').toLowerCase();
  // Desktop's Electron UI does not run a CLI session with a seat config dir.
  // Exclude its exact UI executables, not native CLIs elsewhere in the bundle.
  if (/\/claude\.app\/contents\/macos\/claude$/.test(normalized) ||
    /\/claude\.app\/contents\/frameworks\/(claude helper(?: \((?:renderer|gpu|plugin)\))?)\.app\/contents\/macos\/\1$/.test(normalized)) return false;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return /^(?:claude(?:\.exe)?|claude-code)(?:$|\s)/.test(name) ||
    /\/(?:claude|claude-code)\/versions\/\d[^/]*$/.test(normalized);
}
function provider(column) {
  const words = String(column.cmd || '').match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
  const program = (words[0] === 'command' ? words[1] : words[0]) || '';
  const name = program.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (isClaudeProcess(program.replace(/^["']|["']$/g, ''))) return 'Claude';
  if (name === 'codex' || name === 'chatgpt') return 'Codex';
  return column.agentProvider;
}
function directory(value, home) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = path.posix.normalize(value.trim().replace(/^~(?=$|[\\/])/, home).replace(/\\/g, '/')).replace(/\/$/, '');
  return process.platform === 'win32' || /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

async function occupied({ seats, columns, ptys, home = os.homedir() }, scan = scanProcesses) {
  const all = () => new Set(seats.map((seat) => seat.id));
  const busy = new Set();
  const generations = new Map(Array.from(ptys, ([id, pty]) => [id, pty.pid]));
  if (Array.from(ptys.keys()).some((id) => !columns.some((column) => column.id === id))) return all();
  const live = columns.filter((column) => ptys.has(column.id));
  const matchSeat = (column) => {
    const dir = directory(column.claudeConfigDir, home);
    // A frozen launch directory outranks an editable seat id. Without the
    // snapshot, a legacy live Claude column's seat id is conservatively busy.
    return dir ? seats.filter((seat) => directory(seat.configDir, home) === dir)
      : seats.filter((seat) => seat.id === column.claudeSeatId);
  };
  for (const column of live.filter((col) => provider(col) === 'Claude')) {
    const matches = matchSeat(column);
    if (!matches.length) return all();
    matches.forEach((seat) => busy.add(seat.id));
  }
  let rows;
  try {
    rows = await scan();
    if (!Array.isArray(rows) || rows.some((row) => !row || !Number.isInteger(row.pid) || row.pid < 0 ||
      !Number.isInteger(row.ppid) || row.ppid < 0 || typeof row.comm !== 'string' || !row.comm)) return all();
  } catch (_) { return all(); }
  // A spawn or replacement during the asynchronous inventory invalidates the
  // snapshot. Recheck next tick rather than starting a request against it.
  if (ptys.size !== generations.size || Array.from(ptys).some(([id, pty]) => generations.get(id) !== pty.pid)) return all();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const owners = new Map(live.map((column) => [ptys.get(column.id).pid, column]));
  for (const row of rows.filter((process) => isClaudeProcess(process.comm))) {
    let pid = row.pid, owner;
    const visited = new Set();
    while (pid && !visited.has(pid)) {
      visited.add(pid);
      if (owners.has(pid)) { owner = owners.get(pid); break; }
      pid = byPid.get(pid)?.ppid;
    }
    if (!owner) return all(); // An external Claude process has unknown account ownership.
    const matches = matchSeat(owner);
    if (!matches.length) return all();
    matches.forEach((seat) => busy.add(seat.id));
  }
  return busy;
}

module.exports = { occupied, scanProcesses };
