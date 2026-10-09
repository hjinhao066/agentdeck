// fs.watch on a directory that another program may delete (git removes an emptied
// folder of ~/.agents when a sync rebase is aborted). On Windows the watch handle keeps the
// deleted folder "delete pending", and libuv then reports a rename of the folder itself and
// re-arms at once, forever: tens of thousands of callbacks a second, one CPU core gone
// (2.0.2 on the Windows PC). So every event first checks that the folder is still the one
// being watched; when it is not, the watcher is closed (which lets Windows finish the
// delete), the caller hears one change, and the folder is watched again later.
// Watching again re-creates only the deleted folder itself, and only while its parent is
// there: a deleted ~/.agents (to be cloned again) is never brought back. Changes made while
// nothing watched are not seen, so the caller hears one more change once the watch is back.
'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');

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
  // The first start makes the whole path, as the callers always did; later ones only the
  // folder itself, and while its parent is missing they just wait for it.
  function start(first = false) {
    timer = null;
    if (closed) return;
    try {
      if (first) fs.mkdirSync(dir, { recursive: true });
      else if (current() === null) {
        try { fs.statSync(path.dirname(dir)); } catch (_) { retry(); return; }
        try { fs.mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      ino = current();
      const w = fs.watch(dir, (...args) => {
        if (watcher !== w) return;
        if (current() !== ino) { stop(); retry(); }
        onChange(...args);
      });
      watcher = w;
      failing = false;
      w.on('error', (error) => { if (watcher === w) fail(error); });
      w.unref?.();
    } catch (error) { fail(error); return; }
    if (!first) onChange();
  }
  start(true);
  return {
    watching: () => watcher !== null,
    close() { closed = true; clearTimeout(timer); timer = null; stop(); },
  };
}

module.exports = { watchDir, RETRY_MS };
