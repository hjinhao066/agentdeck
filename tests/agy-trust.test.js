'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../agy-trust-main');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-agy-trust-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return dir;
}

function copyFixture(t) {
  const home = fixture(t);
  const root = path.join(home, 'agentdeck-worktrees');
  const dir = path.join(root, 'repo', 'feat', 'one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere/repo/.git/worktrees/one\n');
  return { home, root, dir };
}

const agyKey = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const realKey = (p) => agyKey(fs.realpathSync.native(p));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('已信任不重复写：已在 trustedWorkspaces 里的目录不触发重新写盘', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const keys = M.trustKeys(dir);
  const original = {
    colorScheme: 'dark',
    model: 'Gemini 3.8 Flash (High)',
    trustedWorkspaces: [...keys],
  };
  fs.writeFileSync(file, JSON.stringify(original, null, 2), { mode: 0o600 });
  const mtimeBefore = fs.statSync(file).mtimeMs;

  const result = await M.trustWorktree(home, dir, { root });
  assert.deepEqual(result, { ok: true, changed: false });

  const bytesAfter = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(bytesAfter), original);
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore, '文件未被重新写盘');

  // 第二次调用同样是 ok: true, changed: false
  assert.deepEqual(await M.trustWorktree(home, dir, { root }), { ok: true, changed: false });
});

test('只登记本目录：只登记给定副本，不放开上级目录或整个 worktrees 根目录，不改用户其他设置', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = {
    colorScheme: 'dark',
    toolPermission: 'always-proceed',
    trustedWorkspaces: ['/Users/jinhao/other-project'],
  };
  fs.writeFileSync(file, JSON.stringify(original, null, 2), { mode: 0o600 });

  const result = await M.trustWorktree(home, dir, { root });
  assert.deepEqual(result, { ok: true, changed: true });

  const after = readJson(file);
  assert.equal(after.colorScheme, 'dark');
  assert.equal(after.toolPermission, 'always-proceed');

  // trustedWorkspaces 应该保留原来项，且仅追加本副本
  assert.ok(after.trustedWorkspaces.includes('/Users/jinhao/other-project'));
  assert.ok(after.trustedWorkspaces.includes(realKey(dir)));

  // 父级目录、根目录、home 等决不可被登记
  for (const parent of [root, path.dirname(dir), path.join(root, 'repo'), home]) {
    assert.equal(after.trustedWorkspaces.includes(parent), false, `parent ${parent} should not be trusted`);
  }
});

test('配置文件不存在时的行为：自动建立目录并新建 settings.json', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  assert.equal(fs.existsSync(file), false);

  const result = await M.trustWorktree(home, dir, { root });
  assert.deepEqual(result, { ok: true, changed: true });

  assert.equal(fs.existsSync(file), true);
  const after = readJson(file);
  assert.deepEqual(after.trustedWorkspaces.sort(), M.trustKeys(dir).sort());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('配置文件损坏时的行为：格式不对或损坏的 JSON 绝不覆盖，原样保留并报错', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (const badContent of ['{ broken json', '[]', 'null', '{"trustedWorkspaces":"not-an-array"}']) {
    fs.writeFileSync(file, badContent, { mode: 0o600 });

    const result = await M.trustWorktree(home, dir, { root });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Antigravity 配置文件/);
    assert.equal(fs.readFileSync(file, 'utf8'), badContent, '损坏的文件未被破坏或覆盖');
  }
});

test('路径校验：非 linked worktree、越界目录或非法路径一律拒绝，绝不写文件', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ trustedWorkspaces: [] });
  fs.writeFileSync(file, original);

  const plain = path.join(root, 'plain-dir'); fs.mkdirSync(plain);
  const repo = path.join(root, 'full-repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const outside = path.join(home, 'projects', 'mine'); fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(path.join(outside, '.git'), 'gitdir: x');

  for (const [bad, options] of [
    [root, { root }], [path.dirname(root), { root }], [home, { root }],
    [plain, { root }], [repo, { root }], [outside, { root }],
    ['relative/dir', { root }], [dir, {}], [dir, { root: 'relative' }], [undefined, { root }],
  ]) {
    const result = await M.trustWorktree(home, bad, options);
    assert.equal(result.ok, false, String(bad));
    assert.equal(typeof result.reason, 'string');
  }

  assert.equal(fs.readFileSync(file, 'utf8'), original, '文件未被修改');
});

test('并发锁：排队等待文件锁释放，超过 10 秒的死锁自动替换', async (t) => {
  const { home, root, dir } = copyFixture(t);
  const file = M.settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"trustedWorkspaces":[]}');

  // 1. 活跃锁：在 150ms 后释放
  fs.mkdirSync(file + '.lock');
  setTimeout(() => { try { fs.rmdirSync(file + '.lock'); } catch (_) {} }, 150);
  const res1 = await M.trustWorktree(home, dir, { root });
  assert.deepEqual(res1, { ok: true, changed: true });
  assert.equal(fs.existsSync(file + '.lock'), false);

  // 2. 过期锁（超过 10s）：直接清除接管
  const second = path.join(root, 'repo', 'feat', 'two');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, '.git'), 'gitdir: y');
  fs.mkdirSync(file + '.lock');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file + '.lock', old, old);

  const res2 = await M.trustWorktree(home, second, { root });
  assert.deepEqual(res2, { ok: true, changed: true });
  assert.equal(fs.existsSync(file + '.lock'), false);
  const after = readJson(file);
  assert.ok(after.trustedWorkspaces.includes(realKey(dir)));
  assert.ok(after.trustedWorkspaces.includes(realKey(second)));
});

test('路径不匹配时不自动确认：屏幕提示路径与当前副本不一致时拒绝确认', () => {
  const currentWorktree = '/Users/jinhao/agentdeck-worktrees/agentdeck/agentdeck/t-54d59d90';
  const otherWorktree = '/Users/jinhao/agentdeck-worktrees/agentdeck/agentdeck/t-other-dir';

  // 屏幕上显示的是 otherWorktree 的提示
  const screenOther = `
Accessing workspace:
/Users/jinhao/agentdeck-worktrees/agentdeck/agentdeck/t-other-dir

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit
`;

  assert.equal(M.isTrustPrompt(screenOther, currentWorktree), false, '路径不匹配时不应判定为本会话的信任提示');
  assert.equal(M.autoConfirmPrompt(screenOther, currentWorktree), null, '路径不匹配时不自动确认');

  // 当屏幕提示中的路径与 currentWorktree 一致时
  const screenMatches = `
Accessing workspace:
/Users/jinhao/agentdeck-worktrees/agentdeck/agentdeck/t-54d59d90

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit
`;

  assert.equal(M.isTrustPrompt(screenMatches, currentWorktree), true);
  assert.equal(M.autoConfirmPrompt(screenMatches, currentWorktree), '\r');

  // 跨行折行路径也能正确比对匹配
  const screenWrapped = `
Accessing workspace:
/Users/jinhao/agentdeck-worktrees/agentdeck/agentdeck/
t-54d59d90

Do you trust the contents of this project?

> Yes, I trust this folder
  No, exit
`;
  assert.equal(M.isTrustPrompt(screenWrapped, currentWorktree), true);
  assert.equal(M.autoConfirmPrompt(screenWrapped, currentWorktree), '\r');

  // 普通终端屏幕或无关提示不应判定
  assert.equal(M.isTrustPrompt('Antigravity CLI 1.3.0\n>', currentWorktree), false);
  assert.equal(M.autoConfirmPrompt('Antigravity CLI 1.3.0\n>', currentWorktree), null);
  assert.equal(M.isTrustPrompt('Do you want to proceed? (y/n)', currentWorktree), false);
});
