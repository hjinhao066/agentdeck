'use strict';

// Which files the phone page may read, and how much of them. The phone entry
// is on the public internet behind a weak login, so this is not "any file the
// logged-in user asks for": a path is readable only when the Captain, a
// receipt or a 待我处理 item named it, or when it sits inside one of a few
// report folders. The decision is made on the real path (after `..` and
// symbolic links are resolved), key and credential locations are refused
// wherever they are reached from, and every read is capped. Read only.
// The desktop's preview pane uses the same refusals (`localRefusal`).
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const HubCore = require('./mobile-web/hub/core.js');
const ChatCore = require('./chat-core');

const LIMITS = { text: 1024 * 1024, image: 12 * 1024 * 1024, pdf: 32 * 1024 * 1024, chunk: 768 * 1024, path: 1024, entries: 300 };
// Folders that hold reports and boards: readable without being named first.
const DEFAULT_ROOTS = ['reports', path.join('.agents', 'boards')];
// Beyond the home and temp folders, where a named file may also be read. On Windows the
// deliveries live on D:, so two kinds of folder there by default; a `*` stands for exactly
// one folder level. The user changes the list in Settings; a Mac has none.
const EXTRA_ROOTS = { win32: ['D:\\aiproject\\Playground', 'D:\\aiproject\\*\\reports'] };
const MAX_EXTRA_ROOTS = 20;

// A folder with one of these names holds keys, wherever it is (.private holds deploy logins on D:). The last three
// are a browser profile's storage.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', 'secrets', '.secrets', 'keychains',
  'agentdeck-remote', '.git', 'gcloud', '.1password', 'credentials', '.credentials', '.private', 'private', 'local storage', 'session storage', 'indexeddb']);
// Files that carry tokens or shell exports, wherever they are: a project folder on D: has them too.
const SECRET_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude.json', '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile',
  '.zsh_history', '.bash_history', '.agents-vault-pass', '.gitconfig', '.boto', '.s3cfg', '.pgpass', '.my.cnf', '.envrc', '.dockercfg']);
// Sign-in state of the agent CLIs (and ~/.config): a folder named so holds nothing but documents and pictures for the phone, wherever it is.
const CLI_DIR = /^\.(?:claude|codex|gemini|cursor|grok|openai|anthropic|config)(?:[-_.].*)?$/;
const CLI_READABLE = /\.(?:md|markdown|txt|png|jpe?g|gif|webp|pdf)$/;
// A Chromium user-data folder (Chrome, Edge, an automation profile) is marked by this file; everything in it is sign-in state.
const BROWSER_MARK = 'Local State';
// Formats with nothing to show as text or picture: the page names the file and its size.
const BINARY_EXT = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|pkg|iso|exe|dll|so|dylib|bin|app|asar|node|class|jar|o|a|wasm|sqlite|db|docx?|xlsx?|pptx?|pages|numbers|keynote|mp[34]|m4[av]|mov|avi|mkv|wav|flac|ogg|webm|heic|tiff?|psd|ttf|otf|woff2?)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg|ppk|mobileprovision|cer|crt|der)$/;
// A name ending in one of these words: api_key.txt, key.txt, openai_key.txt, oauth_creds.json, passwords.md …
// (keyboard.md and monkey.txt are not: the word has to stand alone at the end of the name, or follow a word that
// says whose key it is: mykey.txt, openaikey.txt.)
const SECRET_STEM = /(?:(?:^|[._-])(?:creds|passwords?|passwd|api[_-]?keys?|private[_-]?keys?|keys?|cookies?|vault[_-]?pass)|(?:my|api|openai|anthropic|claude|gemini|deepseek|groq|access|secret|private|master|license)keys?)$/;
// These words at the end refuse a name too (credentials.json, auth.json, bot-token.txt), except a delivered
// document's (design-tokens.md, github-auth.md): what a document holds is checked when it is read (`secretText`).
const LOOSE_STEM = /(?:^|[._-])(?:secrets?|credentials?|tokens?|auth)$/;
// What a backup copy adds to a name: auth.json.bak is auth.json, key.txt.old is key.txt.
const BACKUP_TAIL = /(?:\.(?:bak|old|orig|backup|save|tmp|\d+)|~)+$/;
// A file whose name holds one of these words anywhere is refused too (token.json, my_token.txt), unless it is
// a delivered document: a report, page, PDF or picture (token-usage.md). Those still answer to the exact names,
// extensions and stems above and to SECRET_DIRS. Folders are judged by SECRET_DIRS only.
const SECRET_WORD = /token|secret|credential/;
const DOCUMENT_EXT = /\.(?:md|markdown|html?|pdf|png|jpe?g|gif|webp|bmp|ico|svg|avif)$/;
// Exact names, any case: cloud service accounts, Terraform state (it holds every secret it created), and a
// browser profile's sign-in files in case one sits outside its user-data folder (Chromium's and Firefox's).
// An env file however it is named: .env, .env.local, deploy.env, private-login.env, app.env.prod (env.md and
// environment.md are not). Then OAuth and Firebase admin files, Playwright's saved sign-in, kubeconfig, rclone and
// WireGuard configs, DPAPI blobs.
const SECRET_NAME = /^(?:.*\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519).*|known_hosts|authorized_keys|\.htpasswd|login\.keychain(?:-db)?|vps-access\.json|.*vault-pass.*|service[-_]?account.*\.json|.*\.tfstate(?:\..*)?|local state|(?:secure )?preferences|login data.*|web data.*|history(?:-journal)?|network persistent state|logins\.json|key[34]\.db|cookies\.sqlite.*|oauth.*\.json|storage[-_]?state.*\.json|.*adminsdk.*\.json|kubeconfig.*|rclone\.conf|wg(?:\d+|[-_][^.]*)\.conf|.*\.dpapi)$/;

const insensitive = (platform) => platform === 'darwin' || platform === 'win32';
const fold = (value, platform) => insensitive(platform) ? value.toLowerCase() : value;
function inside(child, parent, platform, lib = path) {
  const rel = lib.relative(fold(parent, platform), fold(child, platform));
  return rel === '' || (!!rel && !rel.startsWith('..') && !lib.isAbsolute(rel));
}

// Is this real path a place keys live? `home` and `denied` are real paths too.
// `dir`: the path is a folder, judged by its name only through SECRET_DIRS.
function secretPath(real, { home, denied = [], platform = process.platform, lib = path, dir = false } = {}) {
  const lower = real.toLowerCase();
  const parts = lower.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  if (parts.slice(0, -1).some((part) => SECRET_DIRS.has(part)) || SECRET_DIRS.has(name)) return true;
  // The name as it is, and without a backup copy's tail.
  const secretName = (value) => {
    if (SECRET_NAME.test(value) || SECRET_EXT.test(value) || SECRET_FILES.has(value)) return true;
    const document = DOCUMENT_EXT.test(value);
    if (!dir && SECRET_WORD.test(value) && !document) return true;
    const stem = value.replace(/\.[a-z0-9]{1,8}$/, '');
    return SECRET_STEM.test(stem) || SECRET_STEM.test(value) || (!document && (LOOSE_STEM.test(stem) || LOOSE_STEM.test(value)));
  };
  if (secretName(name) || secretName(name.replace(BACKUP_TAIL, ''))) return true;
  // Inside an agent CLI's folder, wherever it is: only what reads as a document.
  if (parts.slice(0, -1).some((part) => CLI_DIR.test(part)) && !CLI_READABLE.test(name)) return true;
  if (denied.some((dir) => dir && inside(real, dir, platform, lib))) return true;
  if (home) {
    const top = lib.relative(fold(home, platform), fold(real, platform)).toLowerCase().split(/[\\/]+/);
    if (top[0] === 'library' && ['keychains', 'cookies', 'accounts', 'mail', 'messages', 'safari'].includes(top[1])) return true;
  }
  return false;
}

// ---- what a text holds ----
// A key in a file whose name does not say so (a copied config.yaml): the phone is not sent text holding a private
// key block, a provider key by its prefix, or a key, token, secret or password field (YAML, JSON or env) set to a
// long random value. Placeholders (sk-xxxx, your-api-key, <token>) and code (process.env.X) are not keys.
// Every pattern is bounded and starts at a word edge, so a long blob without spaces costs one pass.
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/;
const KEY_PREFIX = /(?<![A-Za-z0-9])(?:sk-(?:ant-|or-|proj-|live-|test-)?|gh[pousr]_|github_pat_|AKIA|xox[abposr]-|AIza)([A-Za-z0-9_-]{16,200})/g;
const KEY_FIELD = /(?<![A-Za-z0-9_.-])["']?[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,40}["']?[ \t]{0,5}[:=][ \t]{0,5}["']?([A-Za-z0-9_+/=.~-]{20,200})/gi;
// A Telegram bot token: the bot's number, a colon, 35 random characters (the colon stops KEY_FIELD's value).
const TELEGRAM_TOKEN = /(?<![0-9])[0-9]{8,10}:([A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g;
const PLACEHOLDER =/x{4,}|X{4,}|\*{3,}|your|example|placeholder|changeme|dummy|redacted|sample|fake|test[_-]?key|\.\.\./i;
function randomValue(value) {
  if (PLACEHOLDER.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  return (value.match(/[0-9]/g) || []).length >= 2 && /[A-Za-z]/.test(value) && new Set(value).size >= 10;
}
function secretText(text) {
  if (typeof text !== 'string' || !text) return false;
  if (PRIVATE_KEY_BLOCK.test(text)) return true;
  for (const match of text.matchAll(KEY_PREFIX)) if (randomValue(match[1])) return true;
  for (const match of text.matchAll(KEY_FIELD)) if (randomValue(match[1])) return true;
  for (const match of text.matchAll(TELEGRAM_TOKEN)) if (randomValue(match[1])) return true;
  return false;
}

// Is this real path a Chromium user-data folder, or inside one? Such a folder has a "Local State" file
// (it holds the key that unlocks the profile's cookies); everything below it is sign-in state.
// `own`: AgentDeck's own data folder, which Electron marks the same way. The desktop shows its uploads and
// reports; its cookies and storage are refused by name, and the phone refuses the whole folder (`denied`).
function inBrowserProfile(real, dir = false, own = '') {
  const ownReal = own ? (() => { try { return fsSync.realpathSync.native(own); } catch (_) { return own; } })() : '';
  for (let at = dir ? real : path.dirname(real); ; at = path.dirname(at)) {
    const mine = ownReal && fold(at, process.platform) === fold(ownReal, process.platform);
    try { if (!mine && fsSync.statSync(path.join(at, BROWSER_MARK)).isFile()) return true; } catch (_) {}
    if (path.dirname(at) === at) return false;
  }
}

// "~/reports/a.md:12" → an absolute path with `..` folded away, or '' when it is not one.
function absolutePath(raw, { home, lib = path } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > LIMITS.path || /[\x00-\x1f\x7f]/.test(raw)) return '';
  let value = raw.trim().replace(/^file:\/\//i, '');
  if (/^~(?:[\\/]|$)/.test(value)) value = lib.join(home, value.slice(1));
  if (!lib.isAbsolute(value)) return '';
  return lib.resolve(value);
}

// Windows reads some paths as something other than a plain file on this computer: a network
// share or device path (\\server\share, \\?\C:\…, \\.\…), a second data stream (a.md:hidden,
// a.md::$DATA) or a name Windows trims (".env." and ".env " open .env). Such a path is never
// previewed, on the phone or the desktop. `value` is absolute and has lost its ":12" line already.
function plainPath(value, platform = process.platform) {
  if (platform !== 'win32') return true;
  if (/^[\\/]{2}/.test(value) || !/^[A-Za-z]:[\\/]/.test(value) || value.indexOf(':', 2) !== -1) return false;
  return value.slice(3).split(/[\\/]+/).every((part) => part === '' || part === '.' || part === '..' || !/[. ]$/.test(part));
}

// The folders in Settings, cleaned: absolute, no network or device path, no `..`, at least two
// folders deep, and `*` only as a whole folder name after the first one. Returns { roots, bad }.
function cleanRoots(list, platform = process.platform) {
  const win = platform === 'win32';
  const roots = [], bad = [], seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const drive = win ? (/^([A-Za-z]):[\\/]/.exec(value) || [])[1] : (value.startsWith('/') ? '/' : '');
    const segs = drive ? value.slice(win ? 3 : 1).split(win ? /[\\/]+/ : /\/+/).filter(Boolean) : [];
    const ok = !!drive && value.length <= LIMITS.path && !/[\x00-\x1f\x7f?"<>|]/.test(value) && plainPath(value.replace(/\*/g, 'x'), platform)
      && segs.length >= 2 && segs[0] !== '*' && segs.every((seg) => seg === '*' || (!seg.includes('*') && seg !== '.' && seg !== '..' && seg !== '~'));
    if (!ok) { bad.push(value.slice(0, 120)); continue; }
    const clean = win ? drive.toUpperCase() + ':\\' + segs.join('\\') : '/' + segs.join('/');
    if (seen.has(fold(clean, platform))) continue;
    seen.add(fold(clean, platform));
    if (roots.length < MAX_EXTRA_ROOTS) roots.push(clean);
  }
  return { roots, bad };
}
const defaultExtraRoots = (platform = process.platform) => [...(EXTRA_ROOTS[platform] || [])];

// Settings folders ready to compare with real paths: the part before the first `*` is resolved
// the way the home folder is, the rest is matched folder by folder against the real path. A link
// or junction below that part is therefore not followed: where it leads has to be allowed itself.
async function realExtra(patterns, real) {
  const out = [];
  for (const pattern of patterns) {
    const segs = pattern.split(/[\\/]+/).filter(Boolean);
    const star = segs.indexOf('*');
    const fixed = star < 0 ? segs : segs.slice(0, star);
    const base = await real(pattern.startsWith('/') ? '/' + fixed.join('/') : fixed[0] + '\\' + fixed.slice(1).join('\\'));
    if (base) out.push({ base, rest: star < 0 ? [] : segs.slice(star) });
  }
  return out;
}
// `below`: a named folder has to be below a Settings folder without a `*` (naming D:\aiproject\Playground itself
// does not open all of it); a `*` folder is already one project's own (naming its reports folder does).
function inExtra(value, extra, platform, { below = false } = {}) {
  return extra.some(({ base, rest }) => {
    if (!inside(value, base, platform)) return false;
    const rel = path.relative(base, value).split(/[\\/]+/).filter(Boolean);
    if (below && !rest.length && !rel.length) return false;
    return rel.length >= rest.length && rest.every((seg, i) => seg === '*' || fold(seg, platform) === fold(rel[i], platform));
  });
}

// The desktop preview pane. The user clicked the path on this computer, so it may be in any
// folder, but the refusals are the phone's: no network, device or stream path, and no key or
// credential file, judged on the real path (links, junctions and 8.3 short names resolved).
// Returns '' when the file may be shown, otherwise 'path', 'secret' or 'missing'.
function localRefusal(target, { home = os.homedir(), platform = process.platform, own = '' } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || !plainPath(target, platform)) return 'path';
  let real, stat;
  try { real = fsSync.realpathSync.native(target); stat = fsSync.statSync(real); } catch (_) { return 'missing'; }
  if (!plainPath(real, platform)) return 'path';
  let realHome = home;
  try { realHome = fsSync.realpathSync.native(home); } catch (_) {}
  const dir = stat.isDirectory();
  return secretPath(real, { home: realHome, platform, dir }) || secretPath(target, { home, platform, dir }) || inBrowserProfile(real, dir, own) ? 'secret' : '';
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
// `extra`: the Settings folders (see EXTRA_ROOTS) where a named file may be read too.
async function readPreview(raw, { home = os.homedir(), roots, denied = [], extra = [], own = '', texts = [], offset = 0, platform = process.platform, tmp = os.tmpdir() } = {}) {
  let line = (/:(\d+)(?::\d+)?$/.exec(String(raw || '')) || [])[1];
  let lexical = absolutePath(raw, { home });
  if (!lexical) return refuse('invalid');
  if (!Number.isSafeInteger(offset) || offset < 0) return refuse('invalid');
  // On Windows "a.md:12" is always a.md at line 12: a name with a colon in it is a data stream there.
  if (platform === 'win32' && line) lexical = lexical.replace(/:\d+(?::\d+)?$/, '');
  if (!plainPath(lexical, platform)) return refuse('invalid');
  // fs.realpath is the system's own: links and junctions followed, 8.3 short names written out in full.
  const real = async (value) => { try { return await fs.realpath(value); } catch (_) { return ''; } };
  const realHome = await real(home) || home;
  const realRoots = (await Promise.all((roots || DEFAULT_ROOTS.map((dir) => path.join(home, dir))).map(real))).filter(Boolean);
  const realDenied = (await Promise.all(denied.map(real))).filter(Boolean);
  const temps = (await Promise.all([tmp, ...(platform === 'win32' ? [] : ['/tmp'])].map(real))).filter(Boolean);
  const extras = await realExtra(cleanRoots(extra, platform).roots, real);
  const mentioned = mentionedPaths(texts, { home });
  // A Windows name cannot hold a colon, so a named "a.md:12" names a.md.
  if (platform === 'win32') for (const entry of [...mentioned]) if (/:\d+(?::\d+)?$/.test(entry)) mentioned.add(entry.replace(/:\d+(?::\d+)?$/, ''));
  // "a.md:12" is the file a.md unless a file really carries that name.
  let target = await real(lexical);
  if (platform !== 'win32') {
    if (target) line = '';
    else if (line) { lexical = lexical.replace(/:\d+(?::\d+)?$/, ''); target = await real(lexical); }
  }
  // A real path on a network share (a link or junction pointing there) is not this computer's file.
  if (target && !plainPath(target, platform)) return refuse('denied');
  const same = (a, b) => fold(a, platform) === fold(b, platform);
  // A named path counts where it really is: its folders resolved (/tmp is /private/tmp on a Mac), its own name
  // kept. So naming a symbolic link names the link, never the file it points to: that one has to be allowed itself.
  const realMentioned = [];
  for (const entry of mentioned) {
    const dir = await real(path.dirname(entry));
    if (dir) realMentioned.push(path.join(dir, path.basename(entry)));
  }
  const named = (value) => [...mentioned].some((entry) => same(entry, value));
  // Under a named folder: the folder has to be at least two levels below home, or one below the temp folder,
  // or inside one of the Settings folders.
  const depth = (entry, base) => inside(entry, base, platform) ? path.relative(base, entry).split(path.sep).filter(Boolean).length : 0;
  const underNamed = (value) => [...mentioned].some((entry) => inside(value, entry, platform) && !same(value, entry)
    && (depth(entry, home) >= 2 || depth(entry, realHome) >= 2 || temps.some((dir) => depth(entry, dir) >= 1) || inExtra(entry, extras, platform, { below: true })));
  const inRoots = (value) => realRoots.some((dir) => inside(value, dir, platform));
  const secret = (value, dir = false) => secretPath(value, { home: realHome, denied: realDenied, platform, dir });
  const byName = named(lexical) || underNamed(lexical);
  const realNamed = (value) => realMentioned.some((entry) => same(entry, value));
  const realUnder = (value) => realMentioned.some((entry) => inside(value, entry, platform) && !same(value, entry)
    && (depth(entry, realHome) >= 2 || temps.some((dir) => depth(entry, dir) >= 1) || inExtra(entry, extras, platform, { below: true })));
  if (!target) {
    // Say "gone" only for a path that could have been read; anything else is simply refused.
    // Where it would be: the nearest folder that exists, resolved, plus the rest of the name.
    let known = path.dirname(lexical), rest = [path.basename(lexical)], at = '';
    while (!(at = await real(known)) && path.dirname(known) !== known) { rest.unshift(path.basename(known)); known = path.dirname(known); }
    const would = at ? path.join(at, ...rest) : lexical;
    return refuse(!secret(would) && !secret(lexical) && !inBrowserProfile(would, false, own) && (inRoots(would) || byName) ? 'missing' : 'denied');
  }
  let stat = null;
  try { stat = await fs.stat(target); } catch (_) {}
  const isDir = !!stat && stat.isDirectory();
  if (secret(target, isDir) || secret(lexical, isDir) || inBrowserProfile(target, isDir, own)) return refuse('denied');
  // Decided on the real path only. A named one may be anywhere in the home or temp folder or a Settings
  // folder, never a system file.
  const reachable = inside(target, realHome, platform) || temps.some((dir) => inside(target, dir, platform)) || inExtra(target, extras, platform);
  if (!(inRoots(target) || ((realNamed(target) || realUnder(target)) && reachable))) return refuse('denied');
  if (!stat) return refuse('missing');
  // A second name for a file (a hard link) is not resolved by realpath: the name it is reached by says nothing
  // about what it holds, so a file with more than one name is not sent to the phone.
  if (stat.isFile() && stat.nlink > 1) return refuse('denied');
  const name = path.basename(lexical);
  const base = { ok: true, name, size: stat.size, mtime: Math.round(stat.mtimeMs), line: line ? Number(line) : 0 };
  if (stat.isDirectory()) {
    let entries = [];
    try { entries = await fs.readdir(target, { withFileTypes: true }); } catch (_) { return refuse('denied'); }
    const list = entries.filter((entry) => (entry.isDirectory() || entry.isFile()) && !entry.name.startsWith('.') && !secret(path.join(target, entry.name), entry.isDirectory())
      && !(entry.isDirectory() && inBrowserProfile(path.join(target, entry.name), true, own)))
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
    // What would be sent is read for keys first, after decoding (UTF-8 or UTF-16); a hit is refused like a key file.
    if (secretText(text)) return refuse('denied');
    return { ...base, kind, lang: HubCore.languageFor(name), truncated: stat.size > LIMITS.text, text };
  } finally { await handle.close(); }
}

module.exports = { readPreview, localRefusal, secretPath, secretText, inBrowserProfile, plainPath, cleanRoots, defaultExtraRoots, absolutePath, mentionedPaths, inside, LIMITS, DEFAULT_ROOTS };
