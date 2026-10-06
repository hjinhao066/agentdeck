'use strict';
// Antigravity CLI (agy) asks "Do you trust the contents of this project?" on first run in
// a new directory and persists accepted directories in ~/.gemini/antigravity-cli/settings.json
// under the "trustedWorkspaces" string array.
// AgentDeck records the answer for the one copy it created before an agy session starts.
// Only linked worktrees under ~/agentdeck-worktrees are accepted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settingsPath(home) {
  if (!home || typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new Error('settingsPath requires an absolute home path');
  }
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

function normalizeKey(p, platform = process.platform) {
  const norm = path.resolve(p).normalize('NFC');
  return platform === 'win32' ? norm.replace(/^\\\\\?\\/, '').replace(/\\/g, '/') : norm;
}

function trustKeys(dir, platform = process.platform) {
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch (_) {}
  return [...new Set([dir, real].map((v) => normalizeKey(v, platform)))];
}

async function withFileLock(file, work) {
  const lock = file + '.lock';
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 10_000) {
          try { fs.rmdirSync(lock); } catch (_) {}
          continue;
        }
      } catch (_) {}
      if (Date.now() - start > 5000) return { ok: false, reason: '等待 Antigravity 配置文件锁超时' };
      await pause(25);
    }
  }
  try { return await work(); } finally { try { fs.rmdirSync(lock); } catch (_) {} }
}

async function trustWorktree(home, dir, { root, platform = process.platform, configPath } = {}) {
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) {
      return { ok: false, reason: '用户目录无效' };
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || typeof root !== 'string' || !path.isAbsolute(root)) {
      return { ok: false, reason: '副本路径无效' };
    }
    let real, realRoot;
    try {
      real = fs.realpathSync.native(dir);
      realRoot = fs.realpathSync.native(root);
    } catch (_) {
      return { ok: false, reason: '副本或根目录不存在' };
    }
    const rel = path.relative(realRoot, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, reason: '目录不在 AgentDeck 的副本根目录里' };
    }
    // A linked worktree has a .git file; a real repository or a plain folder is not ours to trust.
    let gitStat;
    try {
      gitStat = fs.lstatSync(path.join(real, '.git'));
    } catch (_) {
      return { ok: false, reason: '不是 git 副本' };
    }
    if (!gitStat.isFile()) return { ok: false, reason: '不是 git 副本' };

    const targetFile = configPath || settingsPath(home);
    const keys = trustKeys(dir, platform);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    return await withFileLock(targetFile, () => {
      let existing = {}, mode = 0o600;
      try {
        const stat = fs.statSync(targetFile);
        if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: 'Antigravity 配置文件太大' };
        mode = stat.mode & 0o777;
        existing = JSON.parse(fs.readFileSync(targetFile, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        if (e.code !== 'ENOENT') return { ok: false, reason: 'Antigravity 配置文件读不了，没有改动' };
      }
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        return { ok: false, reason: 'Antigravity 配置文件格式不对，没有改动' };
      }
      if (existing.trustedWorkspaces != null && !Array.isArray(existing.trustedWorkspaces)) {
        return { ok: false, reason: 'Antigravity 配置文件格式不对，没有改动' };
      }
      const list = Array.isArray(existing.trustedWorkspaces) ? [...existing.trustedWorkspaces] : [];
      let changed = false;
      for (const key of keys) {
        if (!list.includes(key)) {
          list.push(key);
          changed = true;
        }
      }
      if (!changed) return { ok: true, changed: false };
      existing.trustedWorkspaces = list;
      const temp = targetFile + `.agentdeck-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(temp, JSON.stringify(existing, null, 2), { mode, flag: 'wx' });
        fs.renameSync(temp, targetFile);
      } catch (e) {
        try { fs.unlinkSync(temp); } catch (_) {}
        return { ok: false, reason: '写 Antigravity 配置文件失败：' + (e.code || e.message) };
      }
      return { ok: true, changed: true };
    });
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 200) };
  }
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

// Fallback screen-based check: detect if screen is showing the agy trust prompt,
// and strictly verify that the workspace displayed matches the expected worktree path.
function isTrustPrompt(screenText, expectedDir, { platform = process.platform } = {}) {
  if (!screenText || typeof expectedDir !== 'string') return false;
  const clean = stripAnsi(screenText);
  if (!clean.includes('Do you trust the contents of this project?')) return false;
  if (!clean.includes('Yes, I trust this folder')) return false;

  // Extract the workspace path shown between "Accessing workspace:" and "Do you trust"
  const marker = 'Accessing workspace:';
  const idx = clean.indexOf(marker);
  if (idx < 0) return false;
  const after = clean.slice(idx + marker.length);
  const endIdx = after.indexOf('Do you trust');
  if (endIdx < 0) return false;
  // Terminal word-wrapping may split the path across lines and insert whitespace/newlines
  const rawPath = after.slice(0, endIdx).replace(/[\r\n\s\t]+/g, '').trim();
  if (!rawPath) return false;

  const expectedKeys = trustKeys(expectedDir, platform);
  const normalizedRaw = normalizeKey(rawPath, platform);
  return expectedKeys.includes(normalizedRaw) || expectedKeys.some((k) => k.toLowerCase() === normalizedRaw.toLowerCase());
}

function autoConfirmPrompt(screenText, expectedDir, options) {
  if (isTrustPrompt(screenText, expectedDir, options)) {
    return '\r'; // First row is "> Yes, I trust this folder", Enter confirms it
  }
  return null;
}

module.exports = {
  settingsPath,
  trustKeys,
  trustWorktree,
  isTrustPrompt,
  autoConfirmPrompt,
};
