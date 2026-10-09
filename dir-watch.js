// fs.watch on a directory that another program may delete (git removes an emptied
// folder of ~/.agents when a sync rebase is aborted). On Windows the watch handle keeps the
// deleted folder "delete pending", and libuv then reports a rename of the folder itself and
// re-arms at once, forever: tens of thousands of callbacks a second, one CPU core gone
// (2.0.2 on the Windows PC). So every event first checks that the folder is still the one
// being watched; when it is not, the watcher is closed (which lets Windows finish the
// delete), the caller hears one change, and the folder is created and watched again later.
'use strict';
const nodeFs = require('node:fs');

const RETRY_MS = 5000;

function watchDir(dir, onChange, { onError = () => {}, retryMs = RETRY_MS, fs = nodeFs } = {}) {
  let watcher = null, ino = null, timer = null, closed = false, failing = false;
  // A failure that lasts is reported once, not at every retry.
  const fail = (error) => { stop(); if (!failing) onError(error); failing = true; retry(); };
  const current = () => { try { const s = fs.statSync(dir); return s.isDirectory() ? s.ino : null; } catch (_) { return null; } };
  const stop = () => { const w = watcher; watcher = null; if (w) { try { w.close(); } catch (_) {} } };
  const retry = () => {
    if (closed || timer) return;
    timer = setTimeout(start, retryMs);
    timer.unref?.();
  };
  function start() {
    timer = null;
    if (closed) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ino = current();
      const w = fs.watch(dir, (...args) => {
        if (watcher !== w) return;
        if (current() !== ino) { stop(); retry(); } else failing = false;
        onChange(...args);
      });
      watcher = w;
      w.on('error', (error) => { if (watcher === w) fail(error); });
      w.unref?.();
    } catch (error) { fail(error); }
  }
  start();
  return {
    watching: () => watcher !== null,
    close() { closed = true; clearTimeout(timer); timer = null; stop(); },
  };
}

module.exports = { watchDir, RETRY_MS };
