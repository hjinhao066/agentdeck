// Parsed config.json (several MB), re-read only when the file changed. The file is
// rewritten by AgentDeck itself (tmp file + rename) and by other tools, so the cache key
// is not the mtime alone: a rewrite inside one clock tick, or on a filesystem with coarse
// mtimes, keeps the mtime and often the size. The inode (changes on rename), the change
// time (cannot be set by utimes), the size and the nanosecond mtime together do not.
// Windows (NTFS) moves its timestamps in steps of about 16 ms, so an in-place rewrite of the
// same size inside one step keeps the whole key. A key taken while the file was that young is
// therefore not trusted alone: its text is kept and compared at later reads, until a read finds
// the same text with the file settled (git's "racily clean" check).
// The returned object is shared: callers must treat it as read-only.
'use strict';
const fs = require('node:fs');

const keyOf = (s) => `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const RACY_MS = 100;

function createJsonFileCache(file) {
  let data = null, key = null, text = null;
  return () => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      const k = keyOf(stat);
      const young = Date.now() - Number(stat.ctimeMs) < RACY_MS;
      if (data && k === key && text === null) return data;
      const raw = fs.readFileSync(file, 'utf8');
      if (data && k === key && raw === text) { if (!young) text = null; return data; }
      data = key = text = null;
      data = JSON.parse(raw);
      key = k;
      if (young) text = raw;
      return data;
    } catch (_) { data = key = text = null; return {}; }
  };
}

module.exports = { createJsonFileCache };
