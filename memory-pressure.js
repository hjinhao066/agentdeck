// macOS kernel memory-pressure level, cached so a queue tick does not spawn
// sysctl on every pass. Windows has no equivalent; callers then use the cap only.
// Levels: 1 normal, 2 warning, 4 critical. Only critical pauses auto-start.
'use strict';

const CACHE_MS = 5000;

function parseLevel(text) {
  const match = /^(?:kern\.memorystatus_vm_pressure_level:\s*)?([124])$/.exec(String(text || '').trim());
  return match ? Number(match[1]) : null;
}

function createMemoryPressure({ platform = process.platform, execFile, now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cached = null;
  let pending = null;
  function read() {
    if (platform !== 'darwin') return Promise.resolve({ level: null, critical: false });
    const at = now();
    if (cached && at - cached.at < cacheMs) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (level) => {
        const value = { level, critical: level === 4 };
        cached = { at: now(), value };
        pending = null;
        resolve(value);
      };
      try {
        execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
          timeout: 1500, encoding: 'utf8', maxBuffer: 1024, windowsHide: true,
        }, (error, stdout) => finish(error ? null : parseLevel(stdout)));
      } catch (_) { finish(null); }
    });
    return pending;
  }
  return { read };
}

module.exports = { CACHE_MS, parseLevel, createMemoryPressure };
