// A stand-in for Windows' CreateProcess, for tests that start a CLI the way the app does
// (child_process.spawn / execFile with these arguments) while process.platform is 'win32'.
// Without a shell only an .exe starts: a bare name gets .exe appended and is looked up on PATH,
// an absolute path must exist. Node refuses to start a .cmd/.bat without a shell (EINVAL, since
// 20.12.2). `shell: true` and cmd.exe /c resolve PATHEXT. Paths are files in a temp folder;
// backslashes are read as slashes so a Windows-style absolute path still finds them on macOS.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pathDirs = (env) => {
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH');
  return String(key ? env[key] : '').split(';').filter(Boolean);
};
const found = (env, name) => pathDirs(env).some((dir) => fs.existsSync(path.join(dir, name)));
const exists = (file) => fs.existsSync(String(file).replace(/\\/g, '/'));
const firstWord = (line) => (String(line).match(/^\s*"([^"]+)"|^\s*(\S+)/) || []).slice(1).find(Boolean) || '';

// Would Windows start this? Throws EINVAL like Node for a .cmd/.bat without a shell.
function windowsStarts(file, args = [], options = {}) {
  const base = path.win32.basename(String(file));
  if (options.shell) {
    const word = path.win32.basename(firstWord([file, ...args].join(' ')));
    return /\.(exe|cmd|bat|com)$/i.test(word) ? found(options.env, word) : ['.exe', '.cmd', '.bat', '.com'].some((ext) => found(options.env, word + ext));
  }
  if (/^cmd(\.exe)?$/i.test(base)) {
    const line = args.slice(args.findIndex((a) => /^\/c$/i.test(a)) + 1).join(' ');
    const word = firstWord(line.replace(/^"(?=")/, ''));
    return exists(word) || ['', '.exe', '.cmd', '.bat'].some((ext) => found(options.env, path.win32.basename(word) + ext));
  }
  if (/\.(cmd|bat)$/i.test(base)) throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
  const exe = /\.[a-z0-9]+$/i.test(base) ? base : base + '.exe';
  if (!/\.exe$/i.test(exe)) return false;
  return path.win32.isAbsolute(String(file)) || path.isAbsolute(String(file)) ? exists(file) : found(options.env, exe);
}

// An npm global folder laid out as on the live Windows PC (D:\npm-global): only the shims are on
// PATH; Claude's shim starts the native claude.exe inside its package, Codex's runs node on the
// package's bin script (which starts its own native codex.exe).
const SHIM_HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
function npmGlobal(dir) {
  const claudeExe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const codexJs = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const codexExe = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  for (const file of [claudeExe, codexJs, codexExe]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, file.endsWith('.js') ? '// starts the vendor codex.exe\n' : 'MZ');
  }
  const claudeShim = SHIM_HEAD + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const codexShim = SHIM_HEAD + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  for (const [name, text] of [['claude', claudeShim], ['claude.cmd', claudeShim], ['codex', codexShim], ['codex.cmd', codexShim]]) fs.writeFileSync(path.join(dir, name), text);
  return { dir, claudeExe, codexJs, codexExe };
}

// Run fn with process.platform reporting 'win32'; restored afterwards.
async function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

module.exports = { windowsStarts, npmGlobal, asWindows };
