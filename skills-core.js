'use strict';
// Main-process half of the Skills page: finds every SKILL.md the agent CLIs on
// this machine can see, groups the symlinked copies of one file, and reads or
// rewrites an existing SKILL.md in place. The page only ever gets opaque keys
// from the last listing; every read and write re-resolves the real path here
// and refuses anything outside the skill roots that listing came from.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_SKILLS = 3000;
const MAX_DIRS = 40000;
const MAX_DEPTH = 8;
const HEAD_BYTES = 8192;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'site-packages', '.cache']);
const KEY_RE = /^[a-f0-9]{24}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

const PROVIDERS = ['shared', 'claude', 'codex', 'gemini', 'antigravity', 'cursor', 'grok'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const keyOf = (real) => sha256(real).slice(0, 24);
function inside(child, root) {
  const rel = path.relative(root, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function realDir(dir) {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch (_) { return null; }
}
function readJsonCapped(file, cap) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

// Directories named `skills` a few levels under a plugin cache.
function findSkillsDirs(base, maxDepth) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length > 500) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of entries) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      const p = path.join(dir, d.name);
      if (d.name === 'skills') out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(base, 1);
  return out.sort();
}

// Every place a skill can live. `kind` is canonical (the shared originals),
// tool (a CLI's own skills folder), builtin (shipped with the tool) or plugin.
function skillSources(home) {
  const h = (...p) => path.join(home, ...p);
  const sources = [
    { provider: 'shared', kind: 'canonical', label: '共享正本', dir: h('.agents', 'skills') },
    { provider: 'claude', kind: 'tool', label: 'Claude', dir: h('.claude', 'skills') },
    { provider: 'codex', kind: 'tool', label: 'Codex', dir: h('.codex', 'skills') },
    { provider: 'gemini', kind: 'tool', label: 'Gemini', dir: h('.gemini', 'skills') },
    { provider: 'antigravity', kind: 'tool', label: 'Antigravity', dir: h('.gemini', 'antigravity', 'global_skills') },
    { provider: 'antigravity', kind: 'builtin', label: 'Antigravity 内置', dir: h('.gemini', 'antigravity', 'builtin', 'skills') },
    { provider: 'cursor', kind: 'tool', label: 'Cursor', dir: h('.cursor', 'skills') },
    { provider: 'cursor', kind: 'builtin', label: 'Cursor 内置', dir: h('.cursor', 'skills-cursor') },
    { provider: 'grok', kind: 'tool', label: 'Grok', dir: h('.grok', 'skills') },
    { provider: 'grok', kind: 'builtin', label: 'Grok 内置', dir: h('.grok', 'bundled', 'skills') },
  ];
  // Claude: only plugins listed as installed, and only inside its plugin folder.
  const claudePlugins = realDir(h('.claude', 'plugins'));
  const installed = claudePlugins && readJsonCapped(path.join(claudePlugins, 'installed_plugins.json'), 1024 * 1024);
  if (installed && installed.plugins && typeof installed.plugins === 'object') {
    for (const [name, list] of Object.entries(installed.plugins)) {
      for (const item of Array.isArray(list) ? list : []) {
        const base = item && typeof item.installPath === 'string' ? realDir(item.installPath) : null;
        if (!base || !inside(base, claudePlugins)) continue;
        sources.push({ provider: 'claude', kind: 'plugin', label: 'Claude 插件 · ' + name.slice(0, 120), dir: path.join(base, 'skills') });
      }
    }
  }
  const caches = [
    ['codex', 'Codex', h('.codex', 'plugins', 'cache'), 4],
    ['grok', 'Grok', h('.grok', 'installed-plugins'), 4],
    ['cursor', 'Cursor', h('.cursor', 'plugins', 'cache'), 4],
    ['cursor', 'Cursor', h('.cursor', 'plugins', 'local'), 3],
    ['gemini', 'Gemini', h('.gemini', 'extensions'), 2],
  ];
  for (const [provider, label, base, depth] of caches) {
    for (const dir of findSkillsDirs(base, depth)) {
      const where = path.relative(base, path.dirname(dir)).split(path.sep).join('/');
      sources.push({ provider, kind: 'plugin', label: label + ' 插件 · ' + where, dir });
    }
  }
  return sources;
}

// `name:` / `description:` from the front matter, for the list only.
function frontMatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv || out[kv[1]]) continue;
    let v = kv[2].trim();
    if (!v || /^[|>][-+]?$/.test(v)) {
      const more = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      v = more.join(' ');
    }
    out[kv[1]] = v.replace(/^(['"])([\s\S]*)\1$/, '$2').slice(0, 300);
  }
  return out;
}
function readHead(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, got).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function discover(home) {
  const roots = skillSources(home).map((s) => ({ ...s, real: realDir(s.dir) }));
  const live = roots.filter((r) => r.real);
  const canonical = live.find((r) => r.kind === 'canonical');
  // Longest root first, so a nested plugin root wins over its parent.
  const byDepth = live.slice().sort((a, b) => b.real.length - a.real.length);
  const ownerOf = (real) => {
    if (canonical && inside(real, canonical.real)) return canonical;
    return byDepth.find((r) => inside(real, r.real)) || null;
  };
  const files = new Map();
  let dirs = 0;
  let truncated = false;

  const record = (src, logical) => {
    let real, st;
    try { real = fs.realpathSync(logical); st = fs.statSync(real); } catch (_) { return; }
    if (!st.isFile() || path.basename(real) !== 'SKILL.md') return;
    let entry = files.get(real);
    if (!entry) {
      if (files.size >= MAX_SKILLS) { truncated = true; return; }
      entry = { real, owner: ownerOf(real), finder: src, vias: [], size: st.size, mtime: st.mtimeMs };
      files.set(real, entry);
    }
    if (!entry.vias.some((v) => v.path === logical)) entry.vias.push({ provider: src.provider, kind: src.kind, path: logical });
  };
  const walk = (src, dir, depth, seen) => {
    if (depth > MAX_DEPTH) return;
    if (++dirs > MAX_DIRS) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of entries) {
      if (d.name === 'SKILL.md' && (d.isFile() || d.isSymbolicLink())) record(src, path.join(dir, d.name));
    }
    for (const d of entries) {
      if (SKIP_DIRS.has(d.name)) continue;
      const p = path.join(dir, d.name);
      let real;
      if (d.isDirectory()) real = p;
      else if (d.isSymbolicLink()) real = realDir(p);
      if (!real) continue;
      try { real = fs.realpathSync(real); } catch (_) { continue; }
      if (seen.has(real)) continue;
      // A link out of every skill root is shown, never crawled.
      if (!ownerOf(real)) {
        const file = path.join(p, 'SKILL.md');
        if (fs.existsSync(file)) record(src, file);
        continue;
      }
      seen.add(real);
      walk(src, p, depth + 1, seen);
      seen.delete(real);
    }
  };
  for (const src of live) walk(src, src.dir, 0, new Set([src.real]));

  const index = new Map();
  const skills = [];
  for (const entry of files.values()) {
    const owner = entry.owner;
    const blocked = owner ? '' : '链接指向允许的技能目录之外，AgentDeck 不读取也不修改它';
    const src = owner || entry.finder;
    const via = entry.vias.find((v) => v.provider === entry.finder.provider) || entry.vias[0];
    const relDir = owner
      ? path.relative(owner.real, path.dirname(entry.real)).split(path.sep).join('/')
      : path.relative(entry.finder.dir, path.dirname(via.path)).split(path.sep).join('/');
    let meta = {};
    if (!blocked && entry.size <= MAX_SKILL_BYTES) { try { meta = frontMatter(readHead(entry.real, entry.size)); } catch (_) {} }
    const key = keyOf(entry.real);
    const users = [...new Set(entry.vias.map((v) => v.provider).filter((p) => p !== 'shared'))]
      .sort((a, b) => PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b));
    index.set(key, { real: entry.real, rootDir: owner ? owner.dir : null, rootReal: owner ? owner.real : null, blocked });
    skills.push({
      key,
      name: meta.name || path.basename(path.dirname(entry.real)),
      description: meta.description || '',
      category: src.provider,
      kind: src.kind,
      source: src.label,
      rootDir: src.dir,
      relDir,
      nested: relDir.includes('/'),
      path: entry.real,
      users,
      links: entry.vias.filter((v) => v.path !== entry.real).map((v) => ({ provider: v.provider, path: v.path })),
      size: entry.size,
      mtime: entry.mtime,
      blocked,
    });
  }
  skills.sort((a, b) => PROVIDERS.indexOf(a.category) - PROVIDERS.indexOf(b.category) ||
    a.relDir.localeCompare(b.relDir) || a.path.localeCompare(b.path));
  return {
    skills,
    index,
    truncated,
    roots: roots.filter((r) => r.kind !== 'plugin').map((r) => ({ provider: r.provider, kind: r.kind, label: r.label, dir: r.dir, exists: !!r.real })),
  };
}

// Re-checks everything about a listed skill before touching it.
function locate(item) {
  if (!item) throw new Error('列表已过期，请刷新 Skills');
  if (item.blocked) throw new Error(item.blocked);
  const rootReal = realDir(item.rootDir);
  if (!rootReal || rootReal !== item.rootReal) throw new Error('技能目录已经变了，请刷新 Skills');
  let real;
  try { real = fs.realpathSync(item.real); } catch (_) { throw new Error('文件已经不存在了，请刷新 Skills'); }
  if (real !== item.real || path.basename(real) !== 'SKILL.md' || !inside(real, rootReal)) throw new Error('文件位置已经变了，请刷新 Skills');
  const st = fs.lstatSync(real);
  if (!st.isFile()) throw new Error('不是普通文件');
  if (st.size > MAX_SKILL_BYTES) throw new Error('文件超过 1 MB，不在这里打开');
  return { real, st };
}
function decode(buf) {
  const text = buf.toString('utf8');
  if (buf.includes(0)) return { text: '', editable: false, reason: '这是二进制文件' };
  if (!Buffer.from(text, 'utf8').equals(buf)) return { text, editable: false, reason: '文件不是有效的 UTF-8，为避免损坏内容只读显示' };
  return { text, editable: true, reason: '' };
}

function createSkillCatalog(home) {
  let index = new Map();
  const list = () => {
    const r = discover(home);
    index = r.index;
    return { ok: true, skills: r.skills, roots: r.roots, truncated: r.truncated };
  };
  const lookup = (key) => {
    if (!index.size) index = discover(home).index;
    return index.get(key);
  };
  const read = (key) => {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return { ok: false, error: '无效的技能标识' };
    try {
      const { real, st } = locate(lookup(key));
      const buf = fs.readFileSync(real);
      if (buf.length > MAX_SKILL_BYTES) return { ok: false, error: '文件超过 1 MB，不在这里打开' };
      return { ok: true, key, ...decode(buf), hash: sha256(buf), size: buf.length, mtime: st.mtimeMs };
    } catch (error) { return { ok: false, error: error.message }; }
  };
  const save = (key, text, baseHash) => {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return { ok: false, error: '无效的技能标识' };
    if (typeof text !== 'string' || text.length > MAX_SKILL_BYTES) return { ok: false, error: '内容超过 1 MB，没有保存' };
    if (typeof baseHash !== 'string' || !HASH_RE.test(baseHash)) return { ok: false, error: '缺少打开时的版本，请重新载入' };
    const next = Buffer.from(text, 'utf8');
    if (next.length > MAX_SKILL_BYTES) return { ok: false, error: '内容超过 1 MB，没有保存' };
    const HARDLINKED = { ok: false, error: '这个文件有多个硬链接，为了不把它们拆开没有保存' };
    const CONFLICT = { ok: false, conflict: true, error: '文件在你打开之后被别处改过，没有保存' };
    let tmp = null;
    try {
      const item = lookup(key);
      const { real, st } = locate(item);
      if (st.nlink > 1) return HARDLINKED;
      const cur = fs.readFileSync(real);
      if (sha256(cur) !== baseHash) return CONFLICT;
      const src = decode(cur);
      if (!src.editable) return { ok: false, error: src.reason };
      const mode = st.mode & 0o7777;
      tmp = path.join(path.dirname(real), '.SKILL.md.' + crypto.randomBytes(6).toString('hex') + '.agentdeck-tmp');
      const fd = fs.openSync(tmp, 'wx', mode);
      try {
        fs.writeFileSync(fd, next);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try { fs.chmodSync(tmp, mode); } catch (_) {}
      if (sha256(fs.readFileSync(real)) !== baseHash) return CONFLICT;
      // The link, root or hard-link count may have moved while the temp file was written.
      if (locate(item).st.nlink > 1) return HARDLINKED;
      fs.renameSync(tmp, real);
      tmp = null;
      const after = fs.statSync(real);
      return { ok: true, key, hash: sha256(next), size: next.length, mtime: after.mtimeMs };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
  };
  return { list, read, save };
}

function registerSkillsIpc({ handleMain, home }) {
  const catalog = createSkillCatalog(home);
  handleMain('skills:list', () => {
    try { return catalog.list(); } catch (error) { return { ok: false, error: error.message }; }
  });
  handleMain('skills:read', (_e, msg) => catalog.read(msg && msg.key));
  handleMain('skills:save', (_e, msg) => (msg && typeof msg === 'object'
    ? catalog.save(msg.key, msg.text, msg.hash)
    : { ok: false, error: '无效的请求' }));
  return catalog;
}

module.exports = { skillSources, discover, frontMatter, createSkillCatalog, registerSkillsIpc, MAX_SKILL_BYTES };
