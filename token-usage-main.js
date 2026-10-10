'use strict';
// Main-process side of the Token 用量 view: one IPC call, token-usage:get,
// answered from the last scan while it is fresh, otherwise by a new scan in a
// utility process (token-usage-worker.js). Two calls during one scan share it.
// The page only ever gets day totals per model and how each source went:
// no paths, prompts or replies.
const path = require('path');

const MAX_AGE = 60 * 1000;          // a scan younger than this answers a plain get
const SCAN_TIMEOUT = 3 * 60 * 1000; // a first scan of a busy machine takes ~10 s

function createTokenUsage({ run, now = () => Date.now(), maxAge = MAX_AGE }) {
  let last = null, lastAt = 0, pending = null;
  function get({ fresh = false } = {}) {
    if (!fresh && last && now() - lastAt < maxAge) return Promise.resolve(last);
    if (pending) return pending;
    pending = Promise.resolve().then(run).then((result) => {
      last = result; lastAt = now();
      return result;
    }).finally(() => { pending = null; });
    return pending;
  }
  return { get, last: () => last };
}

// Claude seat directories from the app's settings, as the scanner takes them
// (~/ expanded). The scanner reads each real directory once.
function seatDirs(seats, home) {
  return (Array.isArray(seats) ? seats : [])
    .map((s) => (s && typeof s.configDir === 'string' ? s.configDir.replace(/^~(?=$|[\\/])/, home) : ''))
    .filter((d) => d && path.isAbsolute(d));
}

function forkScan(input) {
  const { utilityProcess } = require('electron');
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'token-usage-worker.js'), [], { serviceName: 'AgentDeck token usage', stdio: 'ignore' });
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(reject, new Error('读取用量超时')); }, SCAN_TIMEOUT);
    child.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error((msg && msg.error) || '读取用量失败'));
    });
    child.once('exit', (code) => finish(reject, new Error(`读取用量的进程退出了（${code}）`)));
    child.postMessage(input);
  });
}

// Claude seats by id with their directories, for the 订阅值不值 rows. A test
// profile keeps only seats inside its own usage-home (~/...).
function seatList(seats, home, test = false) {
  return (Array.isArray(seats) ? seats : [])
    .filter((s) => s && typeof s.id === 'string' && s.id && typeof s.configDir === 'string' && (!test || /^~(?=$|[\\/])/.test(s.configDir)))
    .map((s) => ({ id: s.id, dir: s.configDir.replace(/^~(?=$|[\\/])/, home) }))
    .filter((s) => path.isAbsolute(s.dir) && (!test || path.resolve(s.dir).startsWith(path.resolve(home) + path.sep)));
}

// A test profile reads only <userData>/usage-home and never the real seats.
function registerTokenUsageIpc({ handleMain, home, userData, getSeats = () => [], test = false, run = forkScan }) {
  const usage = createTokenUsage({
    run: () => run({ home, cacheFile: path.join(userData, 'token-usage-cache.json'), extraClaude: test ? [] : seatDirs(getSeats(), home), seats: seatList(getSeats(), home, test) }),
  });
  handleMain('token-usage:get', (_e, payload) => usage.get({ fresh: payload?.fresh === true }));
  return usage;
}

module.exports = { createTokenUsage, seatDirs, seatList, registerTokenUsageIpc, MAX_AGE };
