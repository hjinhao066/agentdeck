'use strict';
// Independent git worktrees for coding sessions. Creation is opt-in.
// Removal never uses --force, and only happens when the copy has nothing a
// person could miss and the branch is already on a real trunk or still on a
// remote. Ignored files block removal unless they live in a regenerable
// directory named in REGENERABLE_DIRS. Nothing outside the managed root
// is deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_CONFIG = ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.eol=lf'];
// Directories that can be rebuilt. A matching path is ignored only when that
// segment is a directory. Anything else ignored (.env, a database, a file
// that merely shares one of these names) keeps the copy.
const REGENERABLE_DIRS = Object.freeze(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.turbo', '.cache', '__pycache__']);
const REGENERABLE = new Set(REGENERABLE_DIRS);
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];

function real(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
}
function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}
function assertBranch(branch) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) throw new Error('无效分支名。只用字母、数字和 . _ / -，不要用 .. 或盘符。');
  for (const part of branch.split('/')) {
    if (!part || part === '.' || part === '..' || RESERVED.test(part) || /[. ]$/.test(part)) throw new Error('无效分支名。');
  }
  return branch;
}
function assertSha(value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new Error('无效的基线提交。');
  return value.toLowerCase();
}
function pathValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('无效的副本路径。');
  return value;
}
function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的副本记录。');
  const record = { repo: pathValue(value.repo), path: pathValue(value.path), branch: assertBranch(value.branch), base: assertSha(value.base) };
  if (value.removed !== undefined) {
    if (typeof value.removed !== 'boolean') throw new Error('无效的副本记录。');
    record.removed = value.removed;
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || value.reason.length > 500) throw new Error('无效的副本记录。');
    if (value.reason) record.reason = value.reason;
  }
  return record;
}
function repoSlug(repoPath, platform) {
  const base = platformPath(platform).basename(repoPath);
  const slug = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80);
  if (!slug || slug === '.' || slug === '..' || RESERVED.test(slug)) throw new Error('无法从仓库路径得到安全的目录名。');
  return slug;
}
function extendedPath(abs, platform) {
  if (platform !== 'win32') return abs;
  const normalized = path.win32.normalize(abs);
  if (normalized.startsWith('\\\\?\\')) return normalized;
  if (normalized.length < 240) return normalized;
  if (normalized.startsWith('\\\\')) return '\\\\?\\UNC\\' + normalized.slice(2);
  return '\\\\?\\' + normalized;
}
function location({ root, repo, branch, platform = process.platform }) {
  assertBranch(branch);
  if (typeof root !== 'string' || !root.trim()) throw new Error('副本根目录无效。');
  const pp = platformPath(platform);
  if (!pp.isAbsolute(root) || !pp.isAbsolute(repo)) throw new Error('仓库路径和副本根目录都要是绝对路径。');
  const dest = pp.resolve(pp.join(root, repoSlug(repo, platform), ...branch.split('/')));
  const rel = pp.relative(pp.resolve(root), dest);
  if (!rel || rel.startsWith('..') || pp.isAbsolute(rel)) throw new Error('副本路径越出了约定目录。');
  return extendedPath(dest, platform);
}
function defaultRoot(home = os.homedir(), platform = process.platform) {
  return platformPath(platform).join(home, 'agentdeck-worktrees');
}
function gitArgv(repo, args) {
  if (!Array.isArray(args) || args.some((arg) => arg === '--force' || arg === '-f')) throw new Error('拒绝 git --force。');
  return ['-C', repo, ...GIT_CONFIG, ...args];
}
function runGit(argv, options = {}) {
  const exec = options.execFileSync || execFileSync;
  try {
    return exec('git', argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const wrapped = new Error((stderr || error.message || 'git 失败').slice(0, 500));
    wrapped.status = error.status;
    wrapped.gitArgs = argv;
    throw wrapped;
  }
}
function git(repo, args, options) {
  return String(runGit(gitArgv(repo, args), options)).replace(/\r?\n$/, '');
}
function gitOk(repo, args, options) {
  try { git(repo, args, options); return true; }
  catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}
function refExists(repo, ref, options) {
  try { git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref], options); return true; }
  catch (error) {
    if (error.status === 1 || error.status === 128) return false;
    throw error;
  }
}
function resolveCommon(dir, options) {
  let common = git(dir, ['rev-parse', '--git-common-dir'], options);
  if (!path.isAbsolute(common)) common = path.resolve(dir, common);
  return real(common);
}
function defaultTrunk(repo, options) {
  try {
    const ref = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], options);
    const name = ref.replace(/^refs\/remotes\//, '');
    return { name, sha: assertSha(git(repo, ['rev-parse', '--verify', '--end-of-options', name + '^{commit}'], options)) };
  } catch (error) {
    if (error.status !== 1 && error.status !== 128 && !/invalid/.test(error.message || '')) throw error;
  }
  for (const name of ['main', 'master']) {
    if (refExists(repo, name, options)) return { name, sha: assertSha(git(repo, ['rev-parse', '--verify', '--end-of-options', name + '^{commit}'], options)) };
  }
  return null;
}
function resolveBase(repo, base, options) {
  if (base) {
    if (typeof base !== 'string' || !base.trim() || base.length > 200 || /[\x00-\x1f\s]/.test(base) || base.startsWith('-')) throw new Error('无效的 --base。');
    return assertSha(git(repo, ['rev-parse', '--verify', '--end-of-options', base.trim() + '^{commit}'], options));
  }
  const trunk = defaultTrunk(repo, options);
  if (trunk) return trunk.sha;
  return assertSha(git(repo, ['rev-parse', '--verify', 'HEAD'], options));
}
function defaultBranch(taskId) {
  const id = typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(taskId)
    ? taskId
    : new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  return assertBranch('agentdeck/' + id);
}
function resolveRepo(repo, options) {
  if (typeof repo !== 'string' || !repo.trim() || /[\x00-\x1f]/.test(repo)) throw new Error('--worktree 需要仓库路径。');
  if (!path.isAbsolute(repo)) throw new Error('--worktree 需要绝对路径。');
  if (!fs.existsSync(repo)) throw new Error('找不到仓库目录。');
  const top = git(repo, ['rev-parse', '--show-toplevel'], options);
  return real(top);
}
function remoteTip(repo, remote, branch, options) {
  if (!remote || !branch || remote.startsWith('-') || branch.startsWith('-')) return '';
  try {
    const out = git(repo, ['ls-remote', '--heads', remote, 'refs/heads/' + branch], options);
    const sha = out.split('\n').map((line) => line.trim().split(/\s+/)[0]).find((item) => SHA_RE.test(item || ''));
    return sha ? sha.toLowerCase() : '';
  } catch (error) {
    if (error.status !== 1 && error.status !== 2 && error.status !== 128) throw error;
    return '';
  }
}
function isPushed(repo, branch, tip, options) {
  const refs = [`origin/${branch}`];
  try { refs.unshift(git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', branch + '@{upstream}'], options)); }
  catch (error) { if (error.status !== 1 && error.status !== 128) throw error; }
  for (const ref of refs) {
    const slash = typeof ref === 'string' ? ref.indexOf('/') : -1;
    if (slash <= 0) continue;
    const remote = remoteTip(repo, ref.slice(0, slash), ref.slice(slash + 1), options);
    if (remote && gitOk(repo, ['merge-base', '--is-ancestor', tip, remote], options)) return true;
  }
  return false;
}
function parseStatusZ(text) {
  const entries = [];
  const parts = String(text).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.length < 4 || rec[2] !== ' ') { entries.push({ xy: '??', path: rec }); continue; }
    const xy = rec.slice(0, 2);
    entries.push({ xy, path: rec.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1;
  }
  return entries;
}
function isRegenerableIgnored(root, rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  let acc = root;
  for (const part of parts) {
    acc = path.join(acc, part);
    if (!REGENERABLE.has(part)) continue;
    try { if (fs.statSync(acc).isDirectory()) return true; } catch (_) { return false; }
  }
  return false;
}
function worktreeGitDir(dir, options) {
  let line = git(dir, ['rev-parse', '--absolute-git-dir'], options);
  return real(line);
}
function inProgress(dir, options) {
  let gitDir;
  try { gitDir = worktreeGitDir(dir, options); } catch (_) { return 'unknown'; }
  return IN_PROGRESS.find((name) => fs.existsSync(path.join(gitDir, name))) || '';
}
function stashBlocks(repo, branch, options) {
  let list = '';
  try { list = git(repo, ['stash', 'list', '--pretty=%gs'], options); }
  catch (error) {
    if (error.status !== 1 && error.status !== 128) return true;
    return true;
  }
  if (!list.trim()) return false;
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(?:^|\\n)\\s*(?:WIP on |On )' + escaped + '(?::|\\s|$)', 'm');
  return pattern.test(list);
}
function indexBlocks(dir, options) {
  let out = '';
  try { out = runGit(gitArgv(dir, ['ls-files', '-v', '-z']), options); }
  catch (_) { return true; }
  return String(out).split('\0').some((rec) => rec && rec[0] !== 'H');
}
function isMainWorktree(dir, options) {
  const top = path.resolve(git(dir, ['rev-parse', '--show-toplevel'], options));
  const dotGit = path.join(top, '.git');
  if (!fs.existsSync(dotGit)) return false;
  return fs.statSync(dotGit).isDirectory() && real(dotGit) === resolveCommon(dir, options);
}
function insideRoot(dir, root) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\x00-\x1f]/.test(dir)) throw new Error('副本路径不在约定目录里，没有删除。');
  const abs = real(dir);
  const base = real(root);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('副本路径不在约定目录里，没有删除。');
  return abs;
}
function prepare(input = {}, options = {}) {
  const repo = resolveRepo(input.repo, options);
  const base = resolveBase(repo, typeof input.base === 'string' ? input.base.trim() : '', options);
  const branch = input.branch ? assertBranch(String(input.branch).trim()) : defaultBranch(input.taskId);
  const root = input.root || options.root || defaultRoot(options.home);
  if (!path.isAbsolute(root)) throw new Error('副本根目录无效。');
  fs.mkdirSync(root, { recursive: true });
  const dest = location({ root, repo, branch, platform: process.platform });
  if (fs.existsSync(dest)) throw new Error('副本目录已存在：' + dest);
  if (refExists(repo, 'refs/heads/' + branch, options)) throw new Error('分支已存在，换一个 --branch。');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    git(repo, ['worktree', 'add', '-b', branch, dest, base], options);
  } catch (error) {
    if (fs.existsSync(dest)) {
      try { git(repo, ['worktree', 'remove', dest], options); } catch (_) {}
    }
    if (refExists(repo, 'refs/heads/' + branch, options)) {
      try { git(repo, ['branch', '-d', '--', branch], options); } catch (_) {}
    }
    throw error;
  }
  return { repo: real(repo), path: real(dest), branch, base };
}
function inspect(record, options = {}) {
  let normalized;
  try { normalized = normalizeRecord(record); }
  catch (error) { return { safe: false, reason: '副本保留：' + error.message }; }
  if (!fs.existsSync(normalized.path)) return { safe: false, missing: true, reason: '副本目录不在本机，没有删除分支。', record: normalized };
  let branch, top;
  try {
    if (isMainWorktree(normalized.path, options)) return { safe: false, reason: '这是仓库本身，不是独立副本，没有删除。', record: normalized };
    top = real(git(normalized.path, ['rev-parse', '--show-toplevel'], options));
    branch = git(normalized.path, ['branch', '--show-current'], options);
    if (resolveCommon(normalized.path, options) !== resolveCommon(normalized.repo, options)) return { safe: false, reason: '副本不属于登记的仓库，已保留。', record: normalized };
  } catch (error) {
    return { safe: false, reason: '副本保留：无法确认这是登记的 git 副本：' + error.message, record: normalized };
  }
  if (top !== real(normalized.path) || branch !== normalized.branch) return { safe: false, reason: '副本的路径或分支和登记的不一致，已保留。', record: normalized };
  let entries = [];
  try {
    entries = parseStatusZ(runGit(gitArgv(normalized.path, ['status', '--porcelain', '--ignored=matching', '--untracked-files=normal', '--ignore-submodules=none', '-z']), options));
  } catch (error) {
    return { safe: false, reason: '副本保留：无法确认工作区是否干净：' + error.message, record: normalized };
  }
  const dirty = entries.some((entry) => entry.xy !== '!!');
  const ignored = entries.filter((entry) => entry.xy === '!!' && !isRegenerableIgnored(normalized.path, entry.path)).map((entry) => entry.path.replace(/[\\/]+$/, ''));
  const progress = inProgress(normalized.path, options);
  let stashed = false;
  let unusualIndex = false;
  try { stashed = stashBlocks(normalized.repo, normalized.branch, options); } catch (_) { stashed = true; }
  try { unusualIndex = indexBlocks(normalized.path, options); } catch (_) { unusualIndex = true; }
  const tip = assertSha(git(normalized.path, ['rev-parse', 'HEAD'], options));
  const trunk = defaultTrunk(normalized.repo, options);
  const merged = !!(trunk && gitOk(normalized.repo, ['merge-base', '--is-ancestor', tip, trunk.sha], options));
  const pushed = isPushed(normalized.repo, normalized.branch, tip, options);
  const reasons = [];
  if (dirty) reasons.push('工作区有未提交的改动或未跟踪的文件');
  if (ignored.length) {
    const shown = ignored.slice(0, 8).join('、');
    reasons.push('有被忽略、不能自动丢掉的文件：' + shown + (ignored.length > 8 ? ' 等 ' + ignored.length + ' 个' : ''));
  }
  if (progress) reasons.push(progress.startsWith('rebase') ? '正在变基' : '正在合并、拣选或还原');
  if (stashed) reasons.push('这个分支还有 stash');
  if (unusualIndex) reasons.push('索引里有 skip-worktree 或 assume-unchanged 的本地内容');
  if (!merged && !pushed) reasons.push(trunk ? '分支尚未合入主干，也未推送到远端' : '没有 main/master 或 origin/HEAD 这样的主干，也未推送到远端');
  if (reasons.length) return { safe: false, reason: ('副本保留：' + reasons.join('；') + '。').slice(0, 500), record: normalized, dirty: dirty || ignored.length > 0 || !!progress || stashed || unusualIndex, merged, pushed };
  const why = merged ? '分支已合入主干' : '分支已推送到远端';
  return { safe: true, reason: '已回收：工作区干净，且' + why + '。', record: normalized, dirty: false, merged, pushed };
}
function reclaim(record, options = {}) {
  const root = options.root || defaultRoot(options.home);
  let abs;
  try { abs = insideRoot(record && record.path, root); }
  catch (error) { return { removed: false, reason: error.message, path: record && record.path, branch: record && record.branch }; }
  const state = inspect({ ...record, path: abs }, options);
  if (!state.safe) return { removed: false, reason: state.reason, path: abs, branch: record.branch };
  try { git(state.record.repo, ['worktree', 'remove', abs], options); }
  catch (error) {
    if (!fs.existsSync(abs)) return { removed: true, reason: state.reason, path: abs, branch: state.record.branch };
    return { removed: false, reason: '副本保留：git worktree remove 失败（没有使用 --force）：' + error.message, path: abs, branch: state.record.branch };
  }
  if (state.merged) {
    try { git(state.record.repo, ['branch', '-d', '--', state.record.branch], options); } catch (_) {}
  }
  return { removed: true, reason: state.reason, path: abs, branch: state.record.branch };
}
function walkWorktrees(root, found = [], depth = 0) {
  if (depth > 8 || !fs.existsSync(root)) return found;
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (_) { return found; }
  for (const name of entries) {
    if (name === '.git') continue;
    const child = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(child); } catch (_) { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const gitFile = path.join(child, '.git');
    let gitStat;
    try { gitStat = fs.lstatSync(gitFile); } catch (_) { gitStat = null; }
    if (gitStat && gitStat.isFile()) { found.push(child); continue; }
    if (gitStat && gitStat.isDirectory()) continue;
    walkWorktrees(child, found, depth + 1);
  }
  return found;
}
function recordFromWorktree(dir, options) {
  const branch = git(dir, ['branch', '--show-current'], options);
  const base = assertSha(git(dir, ['rev-parse', 'HEAD'], options));
  const repo = path.dirname(resolveCommon(dir, options));
  return normalizeRecord({ repo: real(repo), path: real(dir), branch, base });
}
function clean({ root, apply = false, home, execFileSync: exec } = {}) {
  const options = { execFileSync: exec };
  const base = root || defaultRoot(home);
  const safe = [];
  const kept = [];
  for (const dir of walkWorktrees(base)) {
    let record;
    try { record = recordFromWorktree(dir, options); }
    catch (error) { kept.push({ path: dir, reason: '副本保留：' + error.message }); continue; }
    let state;
    try { state = inspect(record, options); }
    catch (error) { kept.push({ path: record.path, branch: record.branch, reason: '副本保留：' + error.message }); continue; }
    if (state.safe) safe.push({ ...record, reason: state.reason });
    else kept.push({ path: record.path, branch: record.branch, reason: state.reason });
  }
  const removed = [];
  if (apply) {
    for (const item of safe) {
      const result = reclaim(item, { ...options, root: base });
      if (result.removed) removed.push(result);
      else kept.push(result);
    }
  }
  return { root: base, apply: apply === true, safe: apply ? [] : safe, removed, kept };
}
function formatClean(result) {
  const lines = [];
  if (!result.apply) {
    lines.push(result.safe.length ? `可安全清理 ${result.safe.length} 份（本次只列出，没有删除）：` : '没有可安全清理的副本。');
    for (const item of result.safe) lines.push(`  ${item.path}  分支 ${item.branch}  ${item.reason}`);
  } else {
    lines.push(`已清理 ${result.removed.length} 份：`);
    for (const item of result.removed) lines.push(`  ${item.path}  分支 ${item.branch}  ${item.reason}`);
  }
  if (result.kept.length) {
    lines.push(`保留 ${result.kept.length} 份：`);
    for (const item of result.kept) lines.push(`  ${item.path}  ${item.reason}`);
  }
  return lines.join('\n');
}

module.exports = {
  GIT_CONFIG, REGENERABLE_DIRS, assertBranch, normalizeRecord, location, defaultRoot, gitArgv, extendedPath,
  prepare, inspect, reclaim, clean, formatClean, defaultTrunk,
};
