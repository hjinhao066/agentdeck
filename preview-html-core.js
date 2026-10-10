'use strict';

// What a web page previewed in the side pane may reach. The page runs its own
// scripts (our reports draw their charts with them), so it is treated like any
// page from the internet: it gets an address of its own that serves the folder
// the file lies in and nothing else, requests to this machine, the local
// network or a file are cancelled, and it may only move between its own pages.
// Decisions are made on real paths (after `..` and symbolic links are resolved).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { secretPath, inside } = require('./file-preview-core');

const SCHEME = 'agentdeck-preview';
// Not "persist:": whatever a previewed page stores is gone when the app quits.
const PARTITION = 'agentdeck-preview';
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const HTML_NAME = /\.html?$/i;
// What a page is made of. Anything else in the folder (documents, databases,
// source code) is not its business.
const TEXT = '; charset=utf-8';
const MIME = {
  html: 'text/html' + TEXT, htm: 'text/html' + TEXT, css: 'text/css' + TEXT, js: 'text/javascript' + TEXT, mjs: 'text/javascript' + TEXT,
  json: 'application/json' + TEXT, map: 'application/json' + TEXT, txt: 'text/plain' + TEXT, md: 'text/plain' + TEXT, csv: 'text/csv' + TEXT,
  tsv: 'text/tab-separated-values' + TEXT, xml: 'application/xml' + TEXT, svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm',
};

const real = (value) => { try { return fs.realpathSync(value); } catch (_) { return ''; } };
const fold = (value, platform) => (platform === 'darwin' || platform === 'win32' ? value.toLowerCase() : value);
const same = (a, b, platform) => fold(a, platform) === fold(b, platform);
const depth = (child, parent) => path.relative(parent, child).split(path.sep).filter(Boolean).length;

// The folder a page is served from, or the page alone when that folder is a
// catch-all: the home folder and what sits right in it (Desktop, Downloads,
// ~/reports), a drive, the temporary folder. A page saved there must not get
// to read everything else that happens to lie next to it.
function scopeFor(file, { home = os.homedir(), tmp = os.tmpdir(), platform = process.platform } = {}) {
  const target = real(file);
  if (!target) return null;
  const root = path.dirname(target);
  const realHome = real(home) || home;
  const temps = [tmp, os.tmpdir(), ...(platform === 'win32' ? [] : ['/tmp'])].map(real).filter(Boolean);
  let wide;
  // the temporary folder first: on Windows it lies deep inside the home folder
  if (temps.some((dir) => inside(dir, root, platform))) wide = true;                   // the temporary folder or above it
  else if (inside(realHome, root, platform)) wide = true;                              // the home folder or above it
  else if (inside(root, realHome, platform)) wide = depth(root, realHome) < 2;
  else if (temps.some((dir) => inside(root, dir, platform))) wide = false;
  else wide = depth(root, path.parse(root).root) < 2;
  return { file: target, root, wide, home: realHome };
}
const entryPath = (scope) => '/' + encodeURIComponent(path.basename(scope.file));

const no = { ok: false };
// "/shots/a%20b.png" → the file under the page's folder, or a refusal.
function resolveAsset(scope, pathname, { platform = process.platform } = {}) {
  let decoded;
  try { decoded = decodeURIComponent(String(pathname)); } catch (_) { return no; }
  if (decoded[0] !== '/' || /[\x00-\x1f\x7f\\]/.test(decoded)) return no;
  const parts = decoded.slice(1).split('/');
  // no "..", no hidden file, nothing that reads as a drive or a stream name
  if (parts.some((part) => !part || part[0] === '.' || part.includes(':'))) return no;
  const target = real(path.join(scope.root, ...parts));
  if (!target) return no;
  const entry = same(target, scope.file, platform);
  if (!entry) {
    if (scope.wide || !inside(target, scope.root, platform) || same(target, scope.root, platform)) return no;
    if (secretPath(target, { home: scope.home, platform })) return no;
  }
  const mime = MIME[path.extname(target).slice(1).toLowerCase()];
  if (!mime) return no;
  let stat;
  try { stat = fs.statSync(target); } catch (_) { return no; }
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return no;
  return { ok: true, file: target, mime, size: stat.size };
}

// ---- requests leaving the page ----
function privateV4(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
// A name or address on this machine or its network: the deck's own phone page
// and sync server listen there, and so does everything else the user runs.
function privateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    // an IPv4 address carried in an IPv6 one (::ffff:7f00:1, 64:ff9b::7f00:1)
    const mapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) { const hi = parseInt(mapped[1], 16); return privateV4(hi >> 8, hi & 255); }
    return false;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  if (!host.includes('.')) return true;                                                // "localhost", "printer"
  return /\.(?:localhost|local|localdomain|internal|lan|home|home\.arpa|corp|intranet)$/.test(host);
}
function requestAllowed(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (_) { return false; }
  if (parsed.protocol === SCHEME + ':' || parsed.protocol === 'data:') return true;
  if (parsed.protocol === 'blob:') return String(url).startsWith('blob:' + SCHEME + '://');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !privateHost(parsed.hostname);
}
// The name an allowed web request goes to when it is a name and not an address: it is
// looked up before the request leaves (a public name can point at 127.0.0.1 or the local
// network: *.nip.io, localtest.me, anyone's own domain). '' for an address, the page's own
// address, data: and blob:.
function namedHost(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch (_) { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return '';
  return host;
}
// Another page of the same opened folder.
function sameSite(url, token) {
  try { const parsed = new URL(String(url)); return parsed.protocol === SCHEME + ':' && !!token && parsed.hostname === token; } catch (_) { return false; }
}

module.exports = { SCHEME, PARTITION, MAX_ASSET_BYTES, HTML_NAME, MIME, scopeFor, entryPath, resolveAsset, privateHost, requestAllowed, namedHost, sameSite };
