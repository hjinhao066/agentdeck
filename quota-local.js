'use strict';
// Only known usage fields leave this module. Never open auth/settings files,
// execute a CLI, or call a provider endpoint.
const fs = require('fs/promises');
const path = require('path');
const Q = require('./quota-core');
async function tail(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, limit), start = stat.size - size;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, start);
    const text = buf.toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') + 1) : text, at: stat.mtimeMs };
  } finally { await handle.close(); }
}
async function readLocal(home, codexHome = path.join(home, '.codex'), now = Date.now()) {
  const observations = [];
  try {
    const file = path.join(home, '.cache', 'ccstatusline', 'usage.json');
    const data = await tail(file, 16384);
    const q = Q.cacheClaude(JSON.parse(data.text), data.at);
    if (q && now - q.at <= Q.FRESH_MS) observations.push(q);
  } catch (_) {}
  try {
    const data = await tail(path.join(home, '.gemini', 'antigravity-cli', 'agy_statusline_debug.json'), 65536);
    const q = Q.cacheAntigravity(JSON.parse(data.text), data.at);
    if (q && now - q.at <= Q.FRESH_MS) observations.push(q);
  } catch (_) {}
  // Recent daily folders only, at most 8 logs and 1 MB from each. This is a
  // bounded asynchronous read, not a recursive scan of conversation history.
  const files = [];
  for (let day = 0; day < 2; day++) {
    const d = new Date(now - day * 86400000);
    const dir = path.join(codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      for (const entry of (await fs.readdir(dir, { withFileTypes: true })).slice(-256)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry.name), stat = await fs.stat(file);
        if (now - stat.mtimeMs <= Q.FRESH_MS) files.push({ file, at: stat.mtimeMs });
      }
    } catch (_) {}
  }
  let latest = null;
  for (const { file } of files.sort((a, b) => b.at - a.at).slice(0, 8)) {
    try {
      const data = await tail(file, 1024 * 1024);
      for (const line of data.text.split('\n').reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let q;
        try { q = Q.cacheCodex(JSON.parse(line)); } catch (_) { continue; }
        if (q && now - q.at <= Q.FRESH_MS && (!latest || q.at > latest.at)) latest = q;
        if (q) break;
      }
    } catch (_) {}
  }
  if (latest) observations.push(latest);
  return observations;
}
module.exports = { readLocal };
