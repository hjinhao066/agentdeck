// Parsed config.json (several MB), re-read only when the file changed. The file is
// rewritten by AgentDeck itself (tmp file + rename) and by other tools, so the cache key
// is not the mtime alone: a rewrite inside one clock tick, or on a filesystem with coarse
// mtimes, keeps the mtime and often the size. The inode (changes on rename), the change
// time (cannot be set by utimes), the size and the nanosecond mtime together do not.
// The returned object is shared: callers must treat it as read-only.
'use strict';
const fs = require('node:fs');

const keyOf = (s) => `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

function createJsonFileCache(file) {
  let data = null, key = null;
  return () => {
    try {
      const k = keyOf(fs.statSync(file, { bigint: true }));
      if (data && k === key) return data;
      data = key = null;
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      key = k;
      return data;
    } catch (_) { data = key = null; return {}; }
  };
}

module.exports = { createJsonFileCache };
