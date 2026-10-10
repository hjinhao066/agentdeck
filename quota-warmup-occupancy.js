'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function scanProcesses({ platform = process.platform, execFileImpl = execFile } = {}) {
  const command = platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = platform === 'win32'
    // UTF-8 out, or a Chinese folder in an ExecutablePath arrives as U+FFFD (Windows PowerShell 5.1 writes the OEM code page).
    ? ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]
    : ['-eo', 'pid=,ppid=,lstart=,comm='];
  // Never request process arguments or environment: either can hold credentials.
  const output = await new Promise((resolve, reject) => {
    execFileImpl(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } },
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
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (!match || !processStart(match[3])) throw new Error('Incomplete process inventory');
    return { pid: Number(match[1]), ppid: Number(match[2]), procStart: processStart(match[3]), comm: match[4] };
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

function processStart(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/\s+/g, ' ');
  return /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(normalized) ? normalized : '';
}

async function isRegistryPath(parent) {
  const actual = await fs.promises.realpath(parent), expected = path.resolve(parent);
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

async function metadataPid(dir, filename, byPid) {
  if (!path.isAbsolute(dir)) return null;
  const directories = filename.startsWith('sessions/') ? [dir, path.join(dir, 'sessions')] : [dir];
  const identities = [];
  let handle;
  try {
    for (const parent of directories) {
      const stat = await fs.promises.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !await isRegistryPath(parent)) {
        throw new Error('Linked process registry');
      }
      identities.push(stat);
    }
    const file = path.join(dir, filename), stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Unsafe process metadata');
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile() || opened.nlink !== 1 || opened.size > 8192) {
      throw new Error('Replaced process metadata');
    }
    const value = JSON.parse(await handle.readFile('utf8'));
    const row = byPid.get(value?.pid), expected = filename.match(/^sessions\/(\d+)\.json$/);
    if (!row || !Number.isInteger(value.pid) || value.pid <= 0 || (expected && Number(expected[1]) !== value.pid) ||
      !processStart(row.procStart) || processStart(value.procStart) !== processStart(row.procStart)) return null;
    // Recheck the directories after reading so a swapped parent is not trusted.
    for (const [index, parent] of directories.entries()) {
      const after = await fs.promises.lstat(parent);
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== identities[index].dev || after.ino !== identities[index].ino ||
        !await isRegistryPath(parent)) {
        throw new Error('Replaced process registry');
      }
    }
    return value.pid;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (handle) await handle.close(); }
}

async function occupied({ seats, columns, ptys, home = os.homedir(), idleCaptainId = '' }, scan = scanProcesses) {
  const all = () => new Set(seats.map((seat) => seat.id));
  const busy = new Set();
  const generations = new Map(Array.from(ptys, ([id, pty]) => [id, pty.pid]));
  if (Array.from(ptys.keys()).some((id) => !columns.some((column) => column.id === id))) return all();
  const live = columns.filter((column) => ptys.has(column.id));
  const idleCaptain = live.find((column) => column.id === idleCaptainId && column.isMain);
  const matchSeat = (column) => {
    const dir = directory(column.claudeConfigDir, home);
    // A frozen launch directory outranks an editable seat id. Without the
    // snapshot, a legacy live Claude column's seat id is conservatively busy.
    return dir ? seats.filter((seat) => directory(seat.configDir, home) === dir)
      : seats.filter((seat) => seat.id === column.claudeSeatId);
  };
  for (const column of live.filter((col) => provider(col) === 'Claude')) {
    if (column === idleCaptain) continue;
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
  if (byPid.size !== rows.length) return all();
  const owners = new Map(live.map((column) => [ptys.get(column.id).pid, column]));
  const registered = new Map();
  let daemons;
  const registrations = async (pid) => {
    if (!registered.has(pid)) {
      const matches = new Set();
      for (const seat of seats) {
        const dir = directory(seat.configDir, home);
        if (await metadataPid(dir, `sessions/${pid}.json`, byPid) === pid) matches.add(seat.id);
      }
      registered.set(pid, matches);
    }
    return registered.get(pid);
  };
  for (const row of rows.filter((process) => isClaudeProcess(process.comm))) {
    let pid = row.pid, owner;
    const visited = new Set();
    while (pid && !visited.has(pid)) {
      visited.add(pid);
      if (owners.has(pid)) { owner = owners.get(pid); break; }
      pid = byPid.get(pid)?.ppid;
    }
    if (!owner && pid && visited.has(pid)) return all();
    if (owner) {
      if (owner === idleCaptain) continue;
      const matches = matchSeat(owner);
      if (!matches.length) return all();
      matches.forEach((seat) => busy.add(seat.id));
      continue;
    }
    // External sessions can prove their seat with native process registration,
    // but only when the inventory's UTC birth time matches the registered PID.
    if (!processStart(row.procStart)) return all();
    try {
      if (!daemons) {
        daemons = new Map();
        for (const seat of seats) {
          const daemonPid = await metadataPid(directory(seat.configDir, home), 'daemon.lock', byPid);
          if (daemonPid) {
            if (!daemons.has(daemonPid)) daemons.set(daemonPid, new Set());
            daemons.get(daemonPid).add(seat.id);
          }
        }
      }
      const matches = new Set();
      // Traverse leaf first; a contradictory ancestor registration fails closed.
      for (const candidate of visited) {
        for (const seatId of await registrations(candidate)) matches.add(seatId);
        for (const seatId of daemons.get(candidate) || []) matches.add(seatId);
      }
      if (matches.size !== 1) return all();
      matches.forEach((seatId) => busy.add(seatId));
    } catch (_) { return all(); }
  }
  if (ptys.size !== generations.size || Array.from(ptys).some(([id, pty]) => generations.get(id) !== pty.pid)) return all();
  return busy;
}

module.exports = { occupied, scanProcesses };
