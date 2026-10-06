'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Worktree = require('../worktree-core');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function recordingExec(calls) {
  return (cmd, args, opts) => {
    calls.push(args);
    return execFileSync(cmd, args, opts);
  };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-wt-'));
  const repo = path.join(root, 'demo');
  const remote = path.join(root, 'remote.git');
  const copies = path.join(root, 'copies');
  fs.mkdirSync(repo);
  fs.mkdirSync(remote);
  git(repo, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
  git(repo, ['add', '.gitignore', 'README']);
  git(repo, ['commit', '-m', 'init']);
  git(remote, ['init', '--bare', '-b', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, remote, copies };
}
function callsOf(t) {
  const calls = [];
  t.after(() => {
    assert.ok(calls.length > 0);
    assert.ok(calls.every((args) => !args.includes('--force') && !args.includes('-f')));
    assert.ok(calls.some((args) => args.includes('core.autocrlf=false') && args.includes('core.longpaths=true') && args.includes('core.eol=lf') && args.includes('core.safecrlf=false')));
  });
  return calls;
}

test('paths stay under the managed root on both platform styles', () => {
  assert.equal(Worktree.location({ root: '/worktrees', repo: '/repos/demo', branch: 'feat/auto', platform: 'darwin' }), '/worktrees/demo/feat/auto');
  assert.equal(Worktree.location({ root: 'C:\\wt', repo: 'C:\\repos\\demo', branch: 'fix/me', platform: 'win32' }), 'C:\\wt\\demo\\fix\\me');
  const longRoot = 'C:\\Users\\me\\' + 'p'.repeat(220);
  const dest = Worktree.location({ root: longRoot, repo: 'C:\\repos\\demo', branch: 'feature/one', platform: 'win32' });
  assert.ok(dest.startsWith('\\\\?\\'), dest);
  assert.ok(dest.includes('\\demo\\feature\\one'), dest);
  for (const branch of ['../escape', 'feature/../../x', 'feature/con', 'feature/nul', '/abs', 'feature/', 'a//b']) {
    assert.throws(() => Worktree.location({ root: '/worktrees', repo: '/repos/demo', branch, platform: 'darwin' }), /无效分支名|越出/, branch);
  }
});

test('creating a copy records the repo, directory, branch and base commit', (t) => {
  const { repo, copies } = setup(t);
  const calls = callsOf(t);
  const created = Worktree.prepare({ repo, branch: 'feat/auto', base: 'main', root: copies }, { execFileSync: recordingExec(calls) });
  assert.equal(created.repo, fs.realpathSync(repo));
  assert.equal(created.branch, 'feat/auto');
  assert.equal(created.path, fs.realpathSync(path.join(copies, 'demo', 'feat', 'auto')));
  assert.match(created.base, /^[0-9a-f]{40}$/);
  assert.equal(created.base, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(fs.readFileSync(path.join(created.path, 'README'), 'utf8'), 'hello\n');
  assert.equal(fs.readFileSync(path.join(created.path, 'README')).includes(13), false);
  assert.equal(git(created.path, ['status', '--porcelain']), '');
  assert.equal(git(created.path, ['branch', '--show-current']), 'feat/auto');
  const homeRepo = path.join(os.homedir(), 'agentdeck');
  assert.equal(created.path.startsWith(fs.realpathSync(copies) + path.sep), true);
  assert.equal(fs.existsSync(homeRepo) && created.path.startsWith(homeRepo + path.sep), false);
});

test('a clean merged copy is listed and removed only when asked, and a dirty one stays', (t) => {
  const { repo, copies } = setup(t);
  const clean = Worktree.prepare({ repo, branch: 'agentdeck/clean', root: copies });
  const dirty = Worktree.prepare({ repo, branch: 'agentdeck/dirty', root: copies });
  fs.writeFileSync(path.join(dirty.path, 'notes.txt'), 'keep me\n');
  fs.writeFileSync(path.join(clean.path, 'noise.log'), 'ignored\n');
  const listed = Worktree.clean({ root: copies });
  assert.equal(listed.apply, false);
  assert.equal(listed.removed.length, 0);
  assert.ok(listed.safe.some((item) => item.path === clean.path));
  assert.ok(listed.kept.some((item) => item.path === dirty.path && /未提交|未跟踪/.test(item.reason)));
  assert.equal(fs.existsSync(clean.path), true);
  const applied = Worktree.clean({ root: copies, apply: true });
  assert.equal(fs.existsSync(clean.path), false);
  assert.equal(fs.existsSync(dirty.path), true);
  assert.ok(applied.removed.some((item) => item.path === clean.path && /已回收/.test(item.reason)));
  assert.ok(applied.kept.some((item) => item.path === dirty.path));
  assert.match(Worktree.formatClean(listed), /没有删除/);
});

test('a clean branch that is only on the remote is removed; an unpushed branch is kept', (t) => {
  const { repo, copies } = setup(t);
  const pushed = Worktree.prepare({ repo, branch: 'feat/pushed', root: copies });
  fs.writeFileSync(path.join(pushed.path, 'pushed.txt'), 'shipped\n');
  git(pushed.path, ['add', 'pushed.txt']);
  git(pushed.path, ['commit', '-m', 'ship']);
  git(pushed.path, ['push', '-u', 'origin', 'feat/pushed']);
  assert.throws(() => git(repo, ['merge-base', '--is-ancestor', 'feat/pushed', 'main']));
  const pushedResult = Worktree.reclaim(pushed, { root: copies });
  assert.equal(pushedResult.removed, true);
  assert.match(pushedResult.reason, /推送到远端/);
  assert.equal(fs.existsSync(pushed.path), false);
  assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/feat/pushed']), git(repo, ['rev-parse', 'origin/feat/pushed']));

  const local = Worktree.prepare({ repo, branch: 'feat/local', root: copies });
  fs.writeFileSync(path.join(local.path, 'local.txt'), 'only here\n');
  git(local.path, ['add', 'local.txt']);
  git(local.path, ['commit', '-m', 'local']);
  const kept = Worktree.reclaim(local, { root: copies });
  assert.equal(kept.removed, false);
  assert.match(kept.reason, /尚未合入主干|未推送/);
  assert.equal(fs.existsSync(local.path), true);
  assert.equal(fs.readFileSync(path.join(local.path, 'local.txt'), 'utf8'), 'only here\n');
});

test('reclaim never deletes the repository itself or a path outside the managed root', (t) => {
  const { repo, copies } = setup(t);
  const base = git(repo, ['rev-parse', 'HEAD']);
  const result = Worktree.reclaim({ repo, path: repo, branch: 'main', base }, { root: copies });
  assert.equal(result.removed, false);
  assert.match(result.reason, /约定目录/);
  assert.equal(fs.readFileSync(path.join(repo, 'README'), 'utf8'), 'hello\n');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});
