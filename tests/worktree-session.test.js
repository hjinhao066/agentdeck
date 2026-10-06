'use strict';
// new --worktree creates a real copy and records it on the card. Archive
// removes it only when the copy is clean and the branch has been pushed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const B = require('../board-core');
const M = require('../main-core');
const AgentInfo = require('../agent-info');
const ClaudeSeatsCore = require('../claude-seats-core');
const AV = require('../auto-verify-core');
const R = require('../restart-resume');
const P = require('../perpetual-captain-core');
const Worktree = require('../worktree-core');
const { TaskStore, localSessions } = require('../task-board');

const CODEX = 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox';
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-wt-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'demo');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  fs.mkdirSync(remote);
  git(repo, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
  git(repo, ['add', '.gitignore', 'README']);
  git(repo, ['commit', '-m', 'init']);
  git(remote, ['init', '--bare', '-b', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  const w = {
    root, repo, remote, wt: path.join(root, 'copies'), prepares: 0, prepareInputs: [], trustResult: undefined,
    dir: path.join(root, 'tasks'), config: {
      folders: [], archived: [], captainHistory: [],
      mainSession: { colId: 'captain', tasks: [], pending: [], inflight: [], waitlist: [], gen: 1, cmd: 'claude' },
      concurrencyCap: 5,
    },
    columns: [{ id: 'captain', isMain: true, cmd: 'claude' }],
  };
  w.config.columns = w.columns;
  const store = new TaskStore(w.dir, { sessions: () => localSessions(w.config) });
  const entries = new Map(w.columns.map((c) => [c.id, { alive: true, state: 'done', lastScreen: '' }]));
  const window = {
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, onTasksChanged() {},
      taskBoard: (op, input) => Promise.resolve().then(() => store[op](input)),
      memoryPressure: async () => ({ level: null }), saveLongPrompt: async () => '', saveConfigSync() {},
      restartManifestLoad: () => null, restartManifestSave() {},
      prepareWorktree: (input) => {
        w.prepares += 1; w.prepareInputs.push(input);
        // main.js adds `trust` only when the page named a seat
        const prepared = Worktree.prepare({ repo: input.repo, base: input.base, branch: input.branch, taskId: input.taskId, root: w.wt });
        return input.seatId && w.trustResult ? { ...prepared, trust: w.trustResult } : prepared;
      },
      claudeSeats: async () => ClaudeSeatsCore.normalize().map((seat) => ({ id: seat.id, loggedIn: true })),
      reclaimWorktree: (record) => Worktree.reclaim(record, { root: w.wt }),
    },
    MainCore: M, BoardCore: B, AutoVerifyCore: AV, RestartResume: R, PerpetualCaptainCore: P, AgentInfo, ClaudeSeatsCore,
    QuotaCore: { commandQuota: () => ({ out: false }), quotaFallback: (_s, cmd) => ({ action: 'open', cmd, note: '' }) },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {}, readFooter: () => null, captainArchives: () => [] },
    Sidebar: { render() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, console, Date, Intl });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = {
    config: w.config, platform: 'darwin', terms: entries, userComposing: () => false, columnLabel: (c) => c.displayTitle || c.title || c.id,
    saveConfig() {}, flushConfig() {}, showToast() {}, columns: () => w.columns,
    createSession(meta) {
      const col = { ...meta, createdByRequestId: null };
      w.columns.push(col);
      entries.set(col.id, { alive: true, state: 'working', lastScreen: '' });
      return col;
    },
    archiveColumn(col) {
      const snapshot = { ...col };
      w.config.archived = [snapshot, ...(w.config.archived || []).filter((item) => item.id !== col.id)];
      const index = w.columns.indexOf(col);
      if (index >= 0) w.columns.splice(index, 1);
    },
    restoreArchived(id) {
      const snapshot = (w.config.archived || []).find((item) => item.id === id);
      w.config.archived = (w.config.archived || []).filter((item) => item.id !== id);
      w.columns.push(snapshot);
      entries.set(id, { alive: true, state: 'done', lastScreen: '' });
      return snapshot;
    },
    sendWhenReady(col, text, opts) { opts?.onSent?.({ id: 'turn' }); },
  };
  window.MainSession.init(host);
  return {
    w, store, window, host,
    captain: () => w.columns.find((c) => c.isMain),
    card: (id) => store.list({ archived: true }).find((c) => c.id === id),
    handle: (message) => window.MainSession.handle(message, w.columns.find((c) => c.isMain)),
  };
}

test('new without --worktree does not create a copy or change the working directory', async (t) => {
  const app = world(t);
  const card = (await app.store.add({ project: 'demo', title: '整理笔记', detail: '' })).card;
  const plain = path.join(app.w.root, 'plain');
  fs.mkdirSync(plain);
  const reply = await app.handle({ action: 'main-new', id: 'plain-req', title: '整理笔记', task: '只整理，不改代码', boardId: card.id, project: 'demo', command: CODEX, cwd: plain });
  await tick();
  assert.match(reply.result, /已开新会话/);
  assert.equal(app.w.prepares, 0);
  const col = app.w.columns.find((c) => !c.isMain);
  assert.equal(col.cwd, plain);
  assert.equal(col.worktree, undefined);
  assert.equal(app.card(card.id).worktree, undefined);
  assert.equal(fs.existsSync(app.w.wt), false);
});

test('new --worktree records the copy on the card and archive keeps a dirty tree', async (t) => {
  const app = world(t);
  const card = (await app.store.add({ project: 'demo', title: '改代码', detail: '' })).card;
  const reply = await app.handle({
    action: 'main-new', id: 'code-req', title: '改代码', task: '在副本里改', boardId: card.id, project: 'demo', command: CODEX,
    worktree: app.w.repo, base: 'main', branch: 'feat/dirty',
  });
  await tick();
  assert.match(reply.result, /已开新会话/);
  assert.equal(app.w.prepares, 1);
  const col = app.w.columns.find((c) => !c.isMain);
  const recorded = app.card(card.id).worktree;
  assert.equal(col.cwd, recorded.path);
  assert.equal(recorded.repo, fs.realpathSync.native(app.w.repo));
  assert.equal(recorded.branch, 'feat/dirty');
  assert.equal(recorded.base, git(app.w.repo, ['rev-parse', 'main']));
  assert.equal(recorded.path.startsWith(fs.realpathSync.native(app.w.wt) + path.sep), true);
  fs.writeFileSync(path.join(recorded.path, 'dirty.txt'), 'not committed\n');
  const archived = await app.handle({ action: 'main-archive', to: col.id });
  assert.match(archived.result, /未提交|未跟踪/);
  assert.equal(fs.existsSync(recorded.path), true);
  assert.equal(fs.readFileSync(path.join(recorded.path, 'dirty.txt'), 'utf8'), 'not committed\n');
  const after = app.card(card.id).worktree;
  assert.equal(after.removed, false);
  assert.match(after.reason, /未提交|未跟踪/);
});

test('archive removes a clean copy only after its branch is pushed', async (t) => {
  const app = world(t);
  const card = (await app.store.add({ project: 'demo', title: '推上去', detail: '' })).card;
  await app.handle({
    action: 'main-new', id: 'push-req', title: '推上去', task: '提交并推送', boardId: card.id, project: 'demo', command: CODEX,
    worktree: app.w.repo, branch: 'feat/pushed',
  });
  await tick();
  const col = app.w.columns.find((c) => !c.isMain);
  const copy = col.cwd;
  fs.writeFileSync(path.join(copy, 'ship.txt'), 'shipped\n');
  git(copy, ['add', 'ship.txt']);
  git(copy, ['commit', '-m', 'ship']);
  const unpushed = Worktree.inspect(col.worktree, {});
  assert.equal(unpushed.safe, false);
  git(copy, ['push', '-u', 'origin', 'feat/pushed']);
  const archived = await app.handle({ action: 'main-archive', to: col.id });
  assert.match(archived.result, /已回收/);
  assert.match(archived.result, /推送/);
  assert.equal(fs.existsSync(copy), false);
  const after = app.card(card.id).worktree;
  assert.equal(after.removed, true);
  assert.equal(after.repo, fs.realpathSync.native(app.w.repo));
  assert.equal(after.branch, 'feat/pushed');
  assert.match(after.base, /^[0-9a-f]{40}$/);
  assert.equal(git(app.w.repo, ['rev-parse', 'refs/heads/feat/pushed']), git(app.w.repo, ['rev-parse', 'origin/feat/pushed']));
});

test('an ignored .env survives archive, tell restore, and a restarted settling flag', async (t) => {
  const app = world(t);
  const card = (await app.store.add({ project: 'demo', title: '密钥', detail: '' })).card;
  await app.handle({
    action: 'main-new', id: 'env-req', title: '密钥', task: '本地配置', boardId: card.id, project: 'demo', command: CODEX,
    worktree: app.w.repo, branch: 'feat/env',
  });
  await tick();
  const col = app.w.columns.find((c) => !c.isMain);
  fs.writeFileSync(path.join(col.cwd, 'ship.txt'), 'shipped\n');
  git(col.cwd, ['add', 'ship.txt']);
  git(col.cwd, ['commit', '-m', 'ship']);
  git(col.cwd, ['push', '-u', 'origin', 'feat/env']);
  const secret = path.join(col.cwd, '.env');
  fs.writeFileSync(secret, 'TOKEN=local\n');
  const archived = await app.handle({ action: 'main-archive', to: col.id });
  assert.match(archived.result, /\.env/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOKEN=local\n');
  assert.equal(app.card(card.id).worktree.removed, false);
  assert.match(app.card(card.id).worktree.reason, /\.env/);
  const told = await app.handle({ action: 'main-tell', to: col.id, id: 'again', message: '接着改' });
  assert.match(told.result, /已恢复/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOKEN=local\n');
  const live = app.w.columns.find((c) => c.id === col.id);
  const again = await app.handle({ action: 'main-archive', to: live.id });
  assert.match(again.result, /\.env/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOKEN=local\n');

  const restarted = JSON.parse(JSON.stringify(app.w.config.archived.find((item) => item.id === col.id)));
  restarted.worktree.settling = true;
  app.w.config.archived = [restarted];
  const settled = await app.window.MainSession.settleArchivedWorktree(restarted);
  assert.equal(settled.removed, false);
  assert.equal(settled.settling, undefined);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOKEN=local\n');
  fs.rmSync(secret);
  const cleaned = await app.window.MainSession.settleArchivedWorktree(restarted);
  assert.equal(cleaned.removed, true);
  assert.equal(fs.existsSync(secret), false);
  assert.equal(fs.existsSync(col.cwd), false);
});

test('a Claude session in a new copy names the seat that will run it, so the folder is trusted before it starts; other agents name none', async (t) => {
  const app = world(t);
  const claude = 'claude --model claude-opus-5-5 --effort high';
  const open = async (title, extra) => {
    const card = (await app.store.add({ project: 'demo', title, detail: '' })).card;
    const reply = await app.handle({ action: 'main-new', id: 'req-' + title, title, task: '改代码', boardId: card.id, project: 'demo', worktree: app.w.repo, branch: 'feat/' + title, ...extra });
    await tick();
    assert.match(reply.result, /已开新会话/);
    return { card, input: app.w.prepareInputs.at(-1) };
  };
  // the default seat is the active one, with its configured directory
  const first = await open('default', { command: claude });
  assert.deepEqual(JSON.parse(JSON.stringify(first.input)), { repo: app.w.repo, base: '', branch: 'feat/default', taskId: first.card.id, seatId: 'cn', configDir: '~/.claude' });
  app.w.config.activeClaudeSeatId = 'us2';
  const second = (await open('active', { command: claude })).input;
  assert.equal(second.seatId, 'us2'); assert.equal(second.configDir, '~/.claude-us2');
  // --seat names its own seat, whatever is active
  const third = (await open('named', { command: claude, seatId: 'us' })).input;
  assert.equal(third.seatId, 'us'); assert.equal(third.configDir, '~/.claude-us');
  // not a Claude session: nothing about a seat leaves the page
  const fourth = (await open('codex', { command: CODEX })).input;
  assert.equal('seatId' in fourth, false); assert.equal('configDir' in fourth, false);
  // what the main process records stays out of the card and the column
  const col = app.w.columns.find((c) => c.title === 'default' || c.displayTitle === 'default');
  assert.equal(col.worktree && 'trust' in col.worktree, false);
});
test('when the trust record cannot be written the task still starts and the Captain is told how to answer the menu', async (t) => {
  const app = world(t);
  app.w.trustResult = { ok: false, reason: '席位配置文件读不了，没有改动' };
  const card = (await app.store.add({ project: 'demo', title: '无法登记', detail: '' })).card;
  const reply = await app.handle({ action: 'main-new', id: 'req-fail', title: '无法登记', task: '改代码', boardId: card.id, project: 'demo', command: 'claude --model claude-opus-5-5', worktree: app.w.repo, branch: 'feat/fail' });
  await tick();
  assert.match(reply.result, /已开新会话/);
  const col = app.w.columns.find((c) => !c.isMain);
  assert.equal(fs.existsSync(col.cwd), true);
  assert.equal('trust' in app.card(card.id).worktree, false);
  const notice = app.w.config.mainSession.pending.map((p) => p.summary).join('\n');
  assert.match(notice, /没能预先登记 Claude 的文件夹信任（席位配置文件读不了，没有改动）/);
  assert.match(notice, /answer --key down,enter/);
  assert.ok(notice.includes(col.cwd));
  // success is silent
  app.w.config.mainSession.pending = []; app.w.trustResult = { ok: true, reason: '' };
  const second = (await app.store.add({ project: 'demo', title: '登记好', detail: '' })).card;
  await app.handle({ action: 'main-new', id: 'req-ok', title: '登记好', task: '改代码', boardId: second.id, project: 'demo', command: 'claude --model claude-opus-5-5', worktree: app.w.repo, branch: 'feat/ok' });
  await tick();
  assert.equal(app.w.config.mainSession.pending.filter((p) => /信任/.test(p.summary || '')).length, 0);
});
