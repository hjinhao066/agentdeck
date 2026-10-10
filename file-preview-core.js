'use strict';

// Which files the phone page may read, and how much of them. The phone entry
// is on the public internet behind a weak login, so this is not "any file the
// logged-in user asks for": a path is readable only when the Captain, a
// receipt or a 待我处理 item named it, or when it sits inside one of a few
// report folders. The decision is made on the real path (after `..` and
// symbolic links are resolved), key and credential locations are refused
// wherever they are reached from, and every read is capped. Read only.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const HubCore = require('./mobile-web/hub/core.js');
const ChatCore = require('./chat-core');

const LIMITS = { text: 1024 * 1024, image: 12 * 1024 * 1024, pdf: 32 * 1024 * 1024, chunk: 768 * 1024, path: 1024, entries: 300 };
// Folders that hold reports and boards: readable without being named first.
const DEFAULT_ROOTS = ['reports', path.join('.agents', 'boards')];

// A folder with one of these names holds keys, wherever it is.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'secrets', '.secrets', 'keychains',
  'agentdeck-remote', '.git', 'gcloud', '.1password']);
// Files in the home folder itself that carry tokens or shell exports.
const SECRET_HOME_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude.json', '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile',
  '.zsh_history', '.bash_history', '.agents-vault-pass', '.gitconfig', '.boto', '.s3cfg', '.pgpass', '.my.cnf']);
// Formats with nothing to show as text or picture: the page names the file and its size.
const BINARY_EXT = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|pkg|iso|exe|dll|so|dylib|bin|app|asar|node|class|jar|o|a|wasm|sqlite|db|docx?|xlsx?|pptx?|pages|numbers|keynote|mp[34]|m4[av]|mov|avi|mkv|wav|flac|ogg|webm|heic|tiff?|psd|ttf|otf|woff2?)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg|ppk|mobileprovision|cer|crt|der)$/;
// credentials.json, .credentials.json, auth.json, bot-token.txt, oauth_creds.json, api_key.txt …
// A report named token-usage.md is not one of these: the word has to end the name.
const SECRET_STEM = /(?:^|[._-])(?:secrets?|credentials?|creds|passwords?|passwd|tokens?|api[_-]?keys?|private[_-]?keys?|auth|cookies?|vault[_-]?pass)$/;
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|known_hosts|authorized_keys|\.htpasswd|login\.keychain(?:-db)?|vps-access\.json|.*vault-pass.*)$/;

const insensitive = (platform) => platform === 'darwin' || platform === 'win32';
const fold = (value, platform) => insensitive(platform) ? value.toLowerCase() : value;
function inside(child, parent, platform, lib = path) {
  const rel = lib.relative(fold(parent, platform), fold(child, platform));
  return rel === '' || (!!rel && !rel.startsWith('..') && !lib.isAbsolute(rel));
}

// Is this real path a place keys live? `home` and `denied` are real paths too.
function secretPath(real, { home, denied = [], platform = process.platform, lib = path } = {}) {
  const lower = real.toLowerCase();
  const parts = lower.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  if (parts.slice(0, -1).some((part) => SECRET_DIRS.has(part)) || SECRET_DIRS.has(name)) return true;
  if (SECRET_NAME.test(name) || SECRET_EXT.test(name)) return true;
  const stem = name.replace(/\.[a-z0-9]{1,8}$/, '');
  if (SECRET_STEM.test(stem) || SECRET_STEM.test(name)) return true;
  if (denied.some((dir) => dir && inside(real, dir, platform, lib))) return true;
  if (home) {
    const rel = lib.relative(fold(home, platform), fold(real, platform)).toLowerCase();
    if (SECRET_HOME_FILES.has(rel)) return true;
    const top = rel.split(/[\\/]+/);
    // Sign-in state of the agent CLIs: everything in their folders except what reads as a document.
    if (/^\.(?:claude|codex|gemini|cursor|grok|openai|anthropic|config)(?:[-_.].*)?$/.test(top[0]) && top.length > 1 && !/\.(?:md|markdown|txt|png|jpe?g|gif|webp|pdf)$/.test(name)) return true;
    if (top[0] === 'library' && ['keychains', 'cookies', 'accounts', 'mail', 'messages', 'safari'].includes(top[1])) return true;
  }
  return false;
}

// "~/reports/a.md:12" → an absolute path with `..` folded away, or '' when it is not one.
function absolutePath(raw, { home, lib = path } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > LIMITS.path || /[\x00-\x1f\x7f]/.test(raw)) return '';
  let value = raw.trim().replace(/^file:\/\//i, '');
  if (/^~(?:[\\/]|$)/.test(value)) value = lib.join(home, value.slice(1));
  if (!lib.isAbsolute(value)) return '';
  return lib.resolve(value);
}

// The paths the texts name, as the page's own link finder reads them: only what
// is shown as a link can be opened. A folder named with enough depth under the
// home folder (or the temp folder) covers the files in it.
function mentionedPaths(texts, { home, lib = path } = {}) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const link of HubCore.findLinks(text)) {
      if (link.kind !== 'file') continue;
      const absolute = absolutePath(link.path, { home, lib });
      if (absolute) found.add(absolute);
    }
  }
  return found;
}

const refuse = (code) => ({ ok: false, code });

// Decide and read. `texts` are what the Captain, receipts and 待我处理 said.
// Returns { ok: true, kind, … } or { ok: false, code: 'invalid' | 'denied' | 'missing' }.
// A path outside what may be read answers 'denied' whether or not it exists.
async function readPreview(raw, { home = os.homedir(), roots, denied = [], texts = [], offset = 0, platform = process.platform, tmp = os.tmpdir() } = {}) {
  let line = (/:(\d+)(?::\d+)?$/.exec(String(raw || '')) || [])[1];
  let lexical = absolutePath(raw, { home });
  if (!lexical) return refuse('invalid');
  if (!Number.isSafeInteger(offset) || offset < 0) return refuse('invalid');
  const real = async (value) => { try { return await fs.realpath(value); } catch (_) { return ''; } };
  const realHome = await real(home) || home;
  const realRoots = (await Promise.all((roots || DEFAULT_ROOTS.map((dir) => path.join(home, dir))).map(real))).filter(Boolean);
  const realDenied = (await Promise.all(denied.map(real))).filter(Boolean);
  const temps = (await Promise.all([tmp, ...(platform === 'win32' ? [] : ['/tmp'])].map(real))).filter(Boolean);
  const mentioned = mentionedPaths(texts, { home });
  // "a.md:12" is the file a.md unless a file really carries that name.
  let target = await real(lexical);
  if (target) line = '';
  else if (line) { lexical = lexical.replace(/:\d+(?::\d+)?$/, ''); target = await real(lexical); }
  const same = (a, b) => fold(a, platform) === fold(b, platform);
  // A named path counts where it really is: its folders resolved (/tmp is /private/tmp on a Mac), its own name
  // kept. So naming a symbolic link names the link, never the file it points to: that one has to be allowed itself.
  const realMentioned = [];
  for (const entry of mentioned) {
    const dir = await real(path.dirname(entry));
    if (dir) realMentioned.push(path.join(dir, path.basename(entry)));
  }
  const named = (value) => [...mentioned].some((entry) => same(entry, value));
  // Under a named folder: the folder has to be at least two levels below home, or one below the temp folder.
  const depth = (entry, base) => inside(entry, base, platform) ? path.relative(base, entry).split(path.sep).filter(Boolean).length : 0;
  const underNamed = (value) => [...mentioned].some((entry) => inside(value, entry, platform) && !same(value, entry)
    && (depth(entry, home) >= 2 || depth(entry, realHome) >= 2 || temps.some((dir) => depth(entry, dir) >= 1)));
  const inRoots = (value) => realRoots.some((dir) => inside(value, dir, platform));
  const secret = (value) => secretPath(value, { home: realHome, denied: realDenied, platform });
  const byName = named(lexical) || underNamed(lexical);
  const realNamed = (value) => realMentioned.some((entry) => same(entry, value));
  const realUnder = (value) => realMentioned.some((entry) => inside(value, entry, platform) && !same(value, entry)
    && (depth(entry, realHome) >= 2 || temps.some((dir) => depth(entry, dir) >= 1)));
  if (!target) {
    // Say "gone" only for a path that could have been read; anything else is simply refused.
    // Where it would be: the nearest folder that exists, resolved, plus the rest of the name.
    let known = path.dirname(lexical), rest = [path.basename(lexical)], at = '';
    while (!(at = await real(known)) && path.dirname(known) !== known) { rest.unshift(path.basename(known)); known = path.dirname(known); }
    const would = at ? path.join(at, ...rest) : lexical;
    return refuse(!secret(would) && !secret(lexical) && (inRoots(would) || byName) ? 'missing' : 'denied');
  }
  if (secret(target) || secret(lexical)) return refuse('denied');
  // Decided on the real path only. A named one may be anywhere in the home or temp folder, never a system file.
  const reachable = inside(target, realHome, platform) || temps.some((dir) => inside(target, dir, platform));
  if (!(inRoots(target) || ((realNamed(target) || realUnder(target)) && reachable))) return refuse('denied');

  let stat;
  try { stat = await fs.stat(target); } catch (_) { return refuse('missing'); }
  const name = path.basename(lexical);
  const base = { ok: true, name, size: stat.size, mtime: Math.round(stat.mtimeMs), line: line ? Number(line) : 0 };
  if (stat.isDirectory()) {
    let entries = [];
    try { entries = await fs.readdir(target, { withFileTypes: true }); } catch (_) { return refuse('denied'); }
    const list = entries.filter((entry) => (entry.isDirectory() || entry.isFile()) && !entry.name.startsWith('.') && !secret(path.join(target, entry.name)))
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    return { ...base, kind: 'dir', size: 0, entries: list.slice(0, LIMITS.entries), more: Math.max(0, list.length - LIMITS.entries) };
  }
  if (!stat.isFile()) return refuse('denied');
  const kind = HubCore.fileKind(name);
  if (kind === 'image' || kind === 'pdf') {
    if (stat.size > LIMITS[kind]) return { ...base, kind: 'toolarge', limit: LIMITS[kind] };
    if (offset > stat.size) return refuse('invalid');
    const length = Math.min(LIMITS.chunk, stat.size - offset);
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const next = offset + bytesRead;
      return { ...base, kind, mime: kind === 'pdf' ? 'application/pdf' : HubCore.imageMime(name), offset, next: next < stat.size && bytesRead > 0 ? next : null, data: buffer.subarray(0, bytesRead).toString('base64') };
    } finally { await handle.close(); }
  }
  if (BINARY_EXT.test(name)) return { ...base, kind: 'other' };
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, LIMITS.text));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // Bytes that are not text (a NUL near the top, without a UTF-16 byte order mark) are not shown as text.
    const text = ChatCore.decodeText(buffer.subarray(0, bytesRead));
    if (text === null) return { ...base, kind: 'other' };
    return { ...base, kind, lang: HubCore.languageFor(name), truncated: stat.size > LIMITS.text, text };
  } finally { await handle.close(); }
}

module.exports = { readPreview, secretPath, absolutePath, mentionedPaths, inside, LIMITS, DEFAULT_ROOTS };
