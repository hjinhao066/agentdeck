'use strict';
// Each case below is a way archive could destroy something the status
// command does not call a normal edit. None of them may delete the copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Worktree = require('../worktree-core');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function gitAllowFail(cwd, args) {
  try { return git(cwd, args); } catch (error) { return error.stderr ? String(error.stderr) : ''; }
}
function setup(t, branch = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-wt-safe-'));
  const repo = path.join(root, 'demo');
  const remote = path.join(root, 'remote.git');
  const copies = path.join(root, 'copies');
  fs.mkdirSync(repo);
  fs.mkdirSync(remote);
  git(repo, ['init', '-b', branch]);
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n.env\nnode_modules/\ndist\nbuild/\nout/\n');
  fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
  git(repo, ['add', '.gitignore', 'README']);
  git(repo, ['commit', '-m', 'init']);
  git(remote, ['init', '--bare', '-b', branch]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', branch]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, remote, copies };
}
function kept(result, file, text) {
  assert.equal(result.removed, false, result.reason);
  assert.equal(fs.existsSync(file), true);
  if (text !== undefined) assert.equal(fs.readFileSync(file, 'utf8'), text);
}
function ship(repo, copy, branch) {
  fs.writeFileSync(path.join(copy, 'ship.txt'), 'shipped\n');
  git(copy, ['add', 'ship.txt']);
  git(copy, ['commit', '-m', 'ship']);
  git(copy, ['push', '-u', 'origin', branch]);
}

function listedManual(copies, target) {
  const listed = Worktree.clean({ root: copies });
  const row = listed.manual.find((item) => item.path === target);
  assert.ok(row, listed.manual.map((item) => item.path).join('\n') + '\n' + listed.kept.map((item) => item.reason).join('\n'));
  assert.match(row.reason, /可手动清理/);
  assert.match(row.reason, /node_modules/);
  assert.match(row.reason, /占用/);
  assert.equal(listed.removed.length, 0);
  return row;
}

test('node_modules is not auto-removed and is listed for manual cleanup', (t) => {
  const { repo, copies } = setup(t);
  const deps = Worktree.prepare({ repo, branch: 'feat/deps', root: copies });
  fs.mkdirSync(path.join(deps.path, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(deps.path, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const blocked = Worktree.reclaim(deps, { root: copies });
  kept(blocked, path.join(deps.path, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  assert.match(blocked.reason, /可手动清理/);
  const row = listedManual(copies, deps.path);
  assert.equal(row.branch, 'feat/deps');
  assert.match(Worktree.formatClean(Worktree.clean({ root: copies })), new RegExp(deps.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('sqlite, key, and secrets inside node_modules are listed and not auto-removed', (t) => {
  const { repo, copies } = setup(t);
  const deps = Worktree.prepare({ repo, branch: 'feat/secrets', root: copies });
  ship(repo, deps.path, 'feat/secrets');
  const dir = path.join(deps.path, 'node_modules');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'local.sqlite'), 'sqlite-bytes\n');
  fs.writeFileSync(path.join(dir, 'server.key'), 'key-bytes\n');
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{"token":"local"}\n');
  const blocked = Worktree.reclaim(deps, { root: copies });
  kept(blocked, path.join(dir, 'local.sqlite'), 'sqlite-bytes\n');
  assert.equal(fs.readFileSync(path.join(dir, 'server.key'), 'utf8'), 'key-bytes\n');
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), '{"token":"local"}\n');
  assert.match(blocked.reason, /可手动清理/);
  assert.doesNotMatch(blocked.reason, /副本保留/);
  listedManual(copies, deps.path);
  const applied = Worktree.clean({ root: copies, apply: true });
  assert.equal(applied.removed.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), '{"token":"local"}\n');
});

test('a root node_modules without package.json is not auto-removed', (t) => {
  const { repo, copies } = setup(t);
  assert.equal(fs.existsSync(path.join(repo, 'package.json')), false);
  const deps = Worktree.prepare({ repo, branch: 'feat/python-modules', root: copies });
  ship(repo, deps.path, 'feat/python-modules');
  fs.mkdirSync(path.join(deps.path, 'node_modules'));
  fs.writeFileSync(path.join(deps.path, 'node_modules', 'user_module.py'), 'print("mine")\n');
  const blocked = Worktree.reclaim(deps, { root: copies });
  kept(blocked, path.join(deps.path, 'node_modules', 'user_module.py'), 'print("mine")\n');
  assert.match(blocked.reason, /可手动清理/);
  listedManual(copies, deps.path);
});

test('a pushed copy with no ignored files is removed automatically', (t) => {
  const { repo, copies } = setup(t);
  const pushed = Worktree.prepare({ repo, branch: 'feat/empty-ignored', root: copies });
  ship(repo, pushed.path, 'feat/empty-ignored');
  const removed = Worktree.reclaim(pushed, { root: copies });
  assert.equal(removed.removed, true, removed.reason);
  assert.match(removed.reason, /已回收/);
  assert.equal(fs.existsSync(pushed.path), false);
});

test('manual cleanup deletes nothing unless that copy is named with confirmation', (t) => {
  const { repo, copies } = setup(t);
  const deps = Worktree.prepare({ repo, branch: 'feat/manual', root: copies });
  fs.mkdirSync(path.join(deps.path, 'node_modules'));
  fs.writeFileSync(path.join(deps.path, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
  const listed = Worktree.clean({ root: copies });
  assert.equal(listed.removed.length, 0);
  assert.equal(fs.existsSync(deps.path), true);
  const applied = Worktree.clean({ root: copies, apply: true });
  assert.equal(applied.removed.length, 0);
  assert.match(Worktree.formatClean(applied), /没有删除/);
  assert.equal(fs.readFileSync(path.join(deps.path, 'node_modules', 'pkg.js'), 'utf8'), 'module.exports = 1;\n');
  const missing = Worktree.clean({ root: copies, paths: [deps.path] });
  assert.equal(missing.removed.length, 0);
  assert.equal(fs.existsSync(deps.path), true);
});

test('ignored files in dist, build, and out are kept and named, not offered for cleanup', (t) => {
  const { repo, copies } = setup(t);
  const secret = Worktree.prepare({ repo, branch: 'feat/secret', root: copies });
  ship(repo, secret.path, 'feat/secret');
  fs.writeFileSync(path.join(secret.path, '.env'), 'TOKEN=local\n');
  fs.writeFileSync(path.join(secret.path, 'dist'), 'not-a-build-directory\n');
  const blocked = Worktree.reclaim(secret, { root: copies });
  kept(blocked, path.join(secret.path, '.env'), 'TOKEN=local\n');
  assert.equal(fs.readFileSync(path.join(secret.path, 'dist'), 'utf8'), 'not-a-build-directory\n');
  assert.match(blocked.reason, /副本保留/);
  assert.match(blocked.reason, /\.env/);
  assert.match(blocked.reason, /dist/);
  assert.doesNotMatch(blocked.reason, /可手动清理/);

  const dist = Worktree.prepare({ repo, branch: 'feat/dist-env', root: copies });
  ship(repo, dist.path, 'feat/dist-env');
  fs.mkdirSync(path.join(dist.path, 'dist'));
  fs.writeFileSync(path.join(dist.path, 'dist', '.env'), 'SECRET=dist\n');
  const distResult = Worktree.reclaim(dist, { root: copies });
  kept(distResult, path.join(dist.path, 'dist', '.env'), 'SECRET=dist\n');
  assert.match(distResult.reason, /dist\/\.env/);
  assert.doesNotMatch(distResult.reason, /可手动清理/);

  const data = Worktree.prepare({ repo, branch: 'feat/build-data', root: copies });
  ship(repo, data.path, 'feat/build-data');
  fs.mkdirSync(path.join(data.path, 'build'));
  fs.writeFileSync(path.join(data.path, 'build', 'experiment_results.csv'), 'id,score\n');
  const dataResult = Worktree.reclaim(data, { root: copies });
  kept(dataResult, path.join(data.path, 'build', 'experiment_results.csv'), 'id,score\n');
  assert.match(dataResult.reason, /build\/experiment_results\.csv/);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(data.path, 'build', 'extra-' + i + '.txt'), 'x\n');
  const many = Worktree.reclaim(data, { root: copies });
  assert.match(many.reason, /还有 1 个/);
  assert.equal(fs.readFileSync(path.join(data.path, 'build', 'experiment_results.csv'), 'utf8'), 'id,score\n');

  const out = Worktree.prepare({ repo, branch: 'feat/out-secret', root: copies });
  ship(repo, out.path, 'feat/out-secret');
  fs.mkdirSync(path.join(out.path, 'out'));
  fs.writeFileSync(path.join(out.path, 'out', 'secrets.txt'), 'private config\n');
  const outResult = Worktree.reclaim(out, { root: copies });
  kept(outResult, path.join(out.path, 'out', 'secrets.txt'), 'private config\n');
  assert.match(outResult.reason, /out\/secrets\.txt/);

  const listed = Worktree.clean({ root: copies });
  for (const copy of [secret, dist, data, out]) {
    assert.equal(listed.manual.some((item) => item.path === copy.path), false, copy.branch);
    assert.ok(listed.kept.some((item) => item.path === copy.path), copy.branch);
  }
  assert.equal(listed.removed.length, 0);
});

test('stash, skip-worktree, assume-unchanged, and status config cannot hide local data', (t) => {
  const { repo, copies } = setup(t);
  const stashed = Worktree.prepare({ repo, branch: 'feat/stash', root: copies });
  fs.writeFileSync(path.join(stashed.path, 'shelved.txt'), 'shelved secret\n');
  git(stashed.path, ['add', 'shelved.txt']);
  git(stashed.path, ['stash', 'push', '-m', 'hold']);
  const stashResult = Worktree.reclaim(stashed, { root: copies });
  kept(stashResult, stashed.path);
  assert.match(stashResult.reason, /stash/);
  assert.match(git(stashed.path, ['stash', 'show', '-p']), /shelved secret/);

  const skipped = Worktree.prepare({ repo, branch: 'feat/skip', root: copies });
  fs.writeFileSync(path.join(skipped.path, 'README'), 'local edit\n');
  git(skipped.path, ['update-index', '--skip-worktree', 'README']);
  const skipResult = Worktree.reclaim(skipped, { root: copies });
  kept(skipResult, path.join(skipped.path, 'README'), 'local edit\n');
  assert.match(skipResult.reason, /skip-worktree|assume-unchanged/);

  const assumed = Worktree.prepare({ repo, branch: 'feat/assume', root: copies });
  fs.writeFileSync(path.join(assumed.path, 'README'), 'assumed edit\n');
  git(assumed.path, ['update-index', '--assume-unchanged', 'README']);
  kept(Worktree.reclaim(assumed, { root: copies }), path.join(assumed.path, 'README'), 'assumed edit\n');

  const hidden = Worktree.prepare({ repo, branch: 'feat/hidden', root: copies });
  git(repo, ['config', 'status.showUntrackedFiles', 'no']);
  git(repo, ['config', 'status.ignoreSubmodules', 'all']);
  fs.writeFileSync(path.join(hidden.path, 'notes.txt'), 'untracked\n');
  const hiddenResult = Worktree.reclaim(hidden, { root: copies });
  kept(hiddenResult, path.join(hidden.path, 'notes.txt'), 'untracked\n');
  assert.match(hiddenResult.reason, /未跟踪|未提交/);
});

test('a dirty submodule, detached HEAD, rebase, and merge are not removed', (t) => {
  const { root, repo, copies } = setup(t);
  const child = path.join(root, 'child');
  fs.mkdirSync(child);
  git(child, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(child, 'README'), 'child\n');
  git(child, ['add', 'README']);
  git(child, ['commit', '-m', 'child']);
  git(repo, ['submodule', 'add', child, 'sub']);
  git(repo, ['commit', '-m', 'add sub']);
  const sub = Worktree.prepare({ repo, branch: 'feat/sub', base: 'main', root: copies });
  git(sub.path, ['submodule', 'update', '--init']);
  fs.writeFileSync(path.join(sub.path, 'sub', 'local.txt'), 'only in the submodule\n');
  const subResult = Worktree.reclaim(sub, { root: copies });
  kept(subResult, path.join(sub.path, 'sub', 'local.txt'), 'only in the submodule\n');

  const detached = Worktree.prepare({ repo, branch: 'feat/detach', root: copies });
  git(detached.path, ['checkout', '--detach']);
  kept(Worktree.reclaim(detached, { root: copies }), path.join(detached.path, 'README'), 'hello\n');
  assert.equal(git(detached.path, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']));

  const rebasing = Worktree.prepare({ repo, branch: 'feat/rebase', root: copies });
  fs.writeFileSync(path.join(rebasing.path, 'README'), 'from branch\n');
  git(rebasing.path, ['add', 'README']);
  git(rebasing.path, ['commit', '-m', 'branch side']);
  fs.writeFileSync(path.join(repo, 'README'), 'from main\n');
  git(repo, ['add', 'README']);
  git(repo, ['commit', '-m', 'main side']);
  gitAllowFail(rebasing.path, ['rebase', 'main']);
  const rebaseResult = Worktree.reclaim(rebasing, { root: copies });
  kept(rebaseResult, path.join(rebasing.path, 'README'));
  assert.match(fs.readFileSync(path.join(rebasing.path, 'README'), 'utf8'), /from branch|from main|<<<<<<<|=======|>>>>>>>/);

  const merging = Worktree.prepare({ repo, branch: 'feat/merge', root: copies });
  fs.writeFileSync(path.join(merging.path, 'README'), 'merge branch\n');
  git(merging.path, ['add', 'README']);
  git(merging.path, ['commit', '-m', 'merge side']);
  fs.writeFileSync(path.join(repo, 'README'), 'from main again\n');
  git(repo, ['add', 'README']);
  git(repo, ['commit', '-m', 'main again']);
  gitAllowFail(merging.path, ['merge', 'main']);
  assert.equal(fs.existsSync(path.join(merging.path, '.git')), true);
  const mergeResult = Worktree.reclaim(merging, { root: copies });
  kept(mergeResult, path.join(merging.path, 'README'));
  assert.match(mergeResult.reason, /合并|未提交|变基|冲突|正在/);
  assert.match(fs.readFileSync(path.join(merging.path, 'README'), 'utf8'), /merge branch|from main again|<<<<<<<|=======|>>>>>>>/);
});

test('a branch ahead of its remote, or whose remote branch was deleted, stays on disk', (t) => {
  const { repo, copies } = setup(t);
  const ahead = Worktree.prepare({ repo, branch: 'feat/ahead', root: copies });
  ship(repo, ahead.path, 'feat/ahead');
  fs.writeFileSync(path.join(ahead.path, 'extra.txt'), 'not pushed\n');
  git(ahead.path, ['add', 'extra.txt']);
  git(ahead.path, ['commit', '-m', 'ahead']);
  const aheadTip = git(ahead.path, ['rev-parse', 'HEAD']);
  const aheadResult = Worktree.reclaim(ahead, { root: copies });
  kept(aheadResult, path.join(ahead.path, 'extra.txt'), 'not pushed\n');
  assert.equal(git(ahead.path, ['rev-parse', 'HEAD']), aheadTip);
  assert.match(aheadResult.reason, /未推送|尚未合入/);

  const dropped = Worktree.prepare({ repo, branch: 'feat/dropped', root: copies });
  ship(repo, dropped.path, 'feat/dropped');
  const droppedTip = git(dropped.path, ['rev-parse', 'HEAD']);
  git(repo, ['push', 'origin', ':feat/dropped']);
  const droppedResult = Worktree.reclaim(dropped, { root: copies });
  kept(droppedResult, path.join(dropped.path, 'ship.txt'), 'shipped\n');
  assert.equal(git(repo, ['rev-parse', 'refs/heads/feat/dropped']), droppedTip);
  assert.match(droppedResult.reason, /未推送|尚未合入|远端/);
});

test('without main, master, or origin/HEAD, HEAD is not treated as the trunk', (t) => {
  const { repo, copies } = setup(t, 'dev');
  const copy = Worktree.prepare({ repo, branch: 'feat/only', base: 'dev', root: copies });
  const result = Worktree.reclaim(copy, { root: copies });
  kept(result, path.join(copy.path, 'README'), 'hello\n');
  assert.equal(Worktree.defaultTrunk(repo), null);
  assert.match(result.reason, /主干|未推送/);
  assert.equal(git(repo, ['rev-parse', 'refs/heads/feat/only']), git(repo, ['rev-parse', 'HEAD']));
});

test('empty, relative, dotdot, symlink, repo, home, and root paths are not deleted', (t) => {
  const { root, repo, copies } = setup(t);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const record = (target) => ({ repo, path: target, branch: 'main', base });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'outside\n');
  const link = path.join(copies, 'escape');
  fs.mkdirSync(copies);
  fs.symlinkSync(outside, link);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'keep'), 'home\n');
  const project = path.join(process.cwd(), 'worktree-core.js');
  const before = fs.readFileSync(project);
  for (const target of ['', 'worktree-core.js', 'foo/../../etc', copies + '/../outside', link, repo, home, os.homedir(), copies]) {
    const result = Worktree.reclaim(record(target), { root: copies });
    assert.equal(result.removed, false, target + ' ' + result.reason);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside\n');
  assert.equal(fs.readFileSync(path.join(home, 'keep'), 'utf8'), 'home\n');
  assert.equal(fs.readFileSync(path.join(repo, 'README'), 'utf8'), 'hello\n');
  assert.equal(fs.existsSync(copies), true);
  assert.equal(fs.readFileSync(project).equals(before), true);
});
