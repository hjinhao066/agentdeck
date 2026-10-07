'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Only a simple CLI launch qualifies. A shell wrapper or CLI workspace override
// could change the directory after we checked the PTY's cwd.
function launchWords(command) {
  if (/[\x00-\x1f\x7f\u2018\u2019\u201c\u201d]/.test(String(command))) return null;
  const words = String(command).match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
  const index = ['command', '&'].includes(words[0]) ? 1 : 0;
  if (/[$`;|&<>\r\n]/.test(words.slice(index).join(' '))) return null;
  // Executable paths may use native Windows separators. Arguments must be
  // literal whole words: no escapes, partial quoting, globbing or expressions.
  if (!/^(?:[A-Za-z0-9_./:\\-]+|"[^"]*"|'[^']*')$/.test(words[index] || '') ||
      words.slice(index + 1).some((word) => !/^(?:[A-Za-z0-9_./:=+-]+|"[^"\\]*"|'[^'\\]*')$/.test(word))) return null;
  return { words, index };
}

function trustProvider(command) {
  const parsed = launchWords(command);
  if (!parsed) return '';
  const { words, index } = parsed;
  const name = (words[index] || '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  if (!['agy', 'antigravity', 'cursor-agent'].includes(name)) return '';
  const args = words.slice(index + 1).map((word) => word.replace(/^["']|["']$/g, ''));
  if (args.some((word) => /^(?:--(?:workspace|add-dir|worktree|cwd|directory|project)(?:=|$)|-w)/.test(word))) return '';
  return name === 'cursor-agent' ? 'Cursor' : 'Antigravity';
}

function inDirectory(command, cwd, platform) {
  const quote = (value) => "'" + value.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
  // Shell profiles may cd during startup. Bind the CLI to the authorized cwd,
  // and do not launch it at all if changing to that directory fails.
  const { words, index } = launchWords(command);
  const program = words[index].replace(/^["']|["']$/g, '');
  const args = words.slice(index + 1).join(' ');
  // Resolve the executable, bypassing profile functions/aliases which might
  // append workspace roots after our argument check.
  command = platform === 'win32'
    ? `& ((Get-Command -Name ${quote(program)} -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1).Source) ${args}`
    : `command ${words[index]} ${args}`;
  return platform === 'win32'
    ? `& { Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; ${command} }`
    : `cd -- ${quote(cwd)} && ${command}`;
}

function authorizedDirectory(column, cwd, home) {
  if (!column?.captainCrew || !column.trustedCwd || column.trustedCwd !== column.cwd || cwd !== column.cwd || !path.isAbsolute(cwd)) return false;
  if (/[\x00-\x1f\x7f\u2018\u2019\u201c\u201d]/.test(cwd)) return false;
  try {
    const real = fs.realpathSync.native(cwd);
    const realHome = fs.existsSync(home) ? fs.realpathSync.native(home) : path.resolve(home);
    return fs.statSync(real).isDirectory() && real !== realHome && real !== path.parse(real).root;
  } catch (_) { return false; }
}

function trustKeys(cwd, real, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return [...new Set([cwd, real].map((dir) => paths.resolve(dir)))];
}

// agy's CliSetting.IsTrustedWorkspace and Store.TrustWorkspace use exact raw
// string membership. Keep native separators (also on Windows), like filepath.Clean.
function trustAgy(home, cwd) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  let temp;
  try {
    let settings = {}, mode = 0o600;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('配置文件不是普通文件或太大');
      mode = stat.mode & 0o777;
      settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        (settings.trustedWorkspaces !== undefined && (!Array.isArray(settings.trustedWorkspaces) || settings.trustedWorkspaces.some((p) => typeof p !== 'string')))) throw new Error('配置文件格式无效');
    const keys = trustKeys(cwd, fs.realpathSync.native(cwd));
    const list = settings.trustedWorkspaces || [];
    const added = keys.filter((key) => !list.includes(key));
    if (!added.length) return { ok: true };
    settings.trustedWorkspaces = [...list, ...added];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temp = file + `.agentdeck-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    // Synchronous read/rename serializes AgentDeck's concurrent launches. Never
    // replace damaged JSON, and retain all unrelated settings and directory entries.
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode, flag: 'wx' });
    fs.renameSync(temp, file);
    return { ok: true };
  } catch (_) {
    if (temp) { try { fs.unlinkSync(temp); } catch (_) {} }
    return { ok: false, reason: 'Antigravity 信任配置无法安全写入，原文件已保留' };
  }
}

function prepareWorkspaceTrust(command, column, cwd, home, platform = process.platform) {
  const provider = trustProvider(command);
  if (!provider || !authorizedDirectory(column, cwd, home)) return { command };
  if (provider === 'Cursor') {
    // Official interactive --trust support since Cursor CLI 2026.07.20. The
    // CLI saves its own decision before the trust prompt; no internal marker writes.
    const { words, index } = launchWords(command);
    const separator = words.indexOf('--');
    const options = words.slice(index + 1, separator < 0 ? undefined : separator);
    if (!options.some((word) => word.replace(/^["']|["']$/g, '') === '--trust')) words.splice(index + 1, 0, '--trust');
    return { command: inDirectory(words.join(' '), cwd, platform) };
  }
  const result = trustAgy(home, cwd);
  return { command: inDirectory(command, cwd, platform), ...(result.ok ? {} : { warning: result.reason }) };
}

module.exports = { trustProvider, authorizedDirectory, trustKeys, trustAgy, prepareWorkspaceTrust };
