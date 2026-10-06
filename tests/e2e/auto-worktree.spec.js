const { test, expect, _electron: electron } = require('@playwright/test');
const closeElectron = require('./fixtures/close-electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-agent.js');
let application, page, sandbox, profile, home, repo, controlFile, cwdFile, promptsFile, workerCommand, isolatedEnv;

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=Worktree E2E', '-c', 'user.email=worktree@example.test',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(sandbox, 'empty-hooks'), ...args],
  { cwd, env: isolatedEnv, encoding: 'utf8' }).trim();
}
function cli(args) {
  const capability = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  return new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'board-cli.js'), ...args],
    { env: { ...isolatedEnv, ...capability }, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`board-cli ${args[0]} failed: ${stderr || error.message}`));
      else resolve(stdout);
    }));
}
async function startWorker(title, args, command = workerCommand) {
  const card = await page.evaluate(async (title) => (await window.deck.taskBoard('add', { project: 'worktree-e2e', title })).card, title);
  const response = await cli(['new', '--title', title, '--task', 'Check the temporary repository only.',
    '--task-id', card.id, '--project', 'worktree-e2e', '--command', command, ...args]);
  expect(response).toContain('已开新会话');
  await expect.poll(() => page.evaluate((id) => columns.find((c) => c.boardId === id)?.id || '', card.id), { timeout: 20000 }).not.toBe('');
  const column = await page.evaluate((id) => {
    const c = columns.find((c) => c.boardId === id);
    return { id: c.id, cwd: c.cwd, worktree: c.worktree || null };
  }, card.id);
  await expect.poll(() => fs.existsSync(cwdFile) && fs.readFileSync(cwdFile, 'utf8').trim().split('\n')
    .map(JSON.parse).some((record) => record.id === column.id), { timeout: 20000 }).toBe(true);
  const processCwd = fs.readFileSync(cwdFile, 'utf8').trim().split('\n').map(JSON.parse).find((record) => record.id === column.id).cwd;
  await expect.poll(() => fs.existsSync(promptsFile) && fs.readFileSync(promptsFile, 'utf8').trim().split('\n')
    .map(JSON.parse).some((record) => record.colId === column.id && record.text.includes('Check the temporary repository only.')),
  { timeout: 20000 }).toBe(true);
  return { column, cardId: card.id, processCwd };
}
async function worktreeCard(id) {
  return page.evaluate(async (id) => (await window.deck.taskBoard('list', { archived: true })).find((c) => c.id === id)?.worktree || null, id);
}

test.beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-worktree-e2e-')));
  profile = path.join(sandbox, 'profile'); home = path.join(sandbox, 'home'); repo = path.join(sandbox, 'demo');
  for (const dir of [profile, home, repo, path.join(sandbox, 'empty-hooks')]) fs.mkdirSync(dir);
  // Only the isolated Electron/CLI children receive this home. Production's
  // default worktree root therefore stays entirely inside the owned fixture.
  isolatedEnv = { ...process.env, HOME: home, USERPROFILE: home, ZDOTDIR: home,
    GIT_CONFIG_GLOBAL: path.join(sandbox, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(isolatedEnv)) if (key.startsWith('AGENTDECK_')) delete isolatedEnv[key];
  delete isolatedEnv.ELECTRON_RUN_AS_NODE;
  fs.writeFileSync(isolatedEnv.GIT_CONFIG_GLOBAL, '');
  git(repo, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Original repository\n');
  git(repo, ['add', '.gitignore', 'README.md']); git(repo, ['commit', '-m', 'fixture baseline']);
  controlFile = path.join(profile, 'control.json'); cwdFile = path.join(profile, 'worker-cwd.jsonl');
  promptsFile = path.join(profile, 'prompts.jsonl');
  const shim = path.join(profile, 'worker.js');
  fs.writeFileSync(shim, `require('fs').appendFileSync(${JSON.stringify(cwdFile)}, JSON.stringify({id:process.env.AGENTDECK_COL_ID,cwd:process.cwd()})+'\\n');require(${JSON.stringify(FAKE)});`);
  workerCommand = `node "${shim}" --screen-only`;
  const captainCommand = `node "${FAKE}"`;
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false },
    captainTokenSaver: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 1,
    columns: [{ id: 'worktree-captain', title: '队长', cmd: captainCommand, cwd: profile, isMain: true }],
    mainSession: { colId: 'worktree-captain', cmd: captainCommand, gen: 1, crewMarked: true,
      tasks: [], pending: [], inflight: [], waitlist: [] } }));
  application = await electron.launch({ executablePath: process.env.AGENTDECK_TEST_EXECUTABLE || undefined,
    args: [...(process.env.AGENTDECK_TEST_EXECUTABLE ? [] : [ROOT]), `--test-user-data=${profile}`],
    env: { ...isolatedEnv, AGENTDECK_TEST_CONTROL_ENV_FILE: controlFile, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: promptsFile } });
  page = await application.firstWindow();
  await expect.poll(() => fs.existsSync(controlFile), { timeout: 20000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => terms.get('worktree-captain')?.state), { timeout: 20000 }).toBe('done');
  expect(await application.evaluate(() => process.env.HOME)).toBe(home);
});
test.afterEach(async () => {
  if (application) await closeElectron(application);
  application = null;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('Captain CLI creates an independent copy, binds its real PTY cwd, and archive keeps ignored user assets', async () => {
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  const worker = await startWorker('Isolated code task', ['--worktree', repo, '--branch', 'feat/held']);
  const expectedCopy = path.join(home, 'agentdeck-worktrees', 'demo', 'feat', 'held');
  expect(worker.column.cwd).toBe(expectedCopy); expect(worker.processCwd).toBe(expectedCopy);
  expect(worker.column.worktree).toMatchObject({ repo, path: expectedCopy, branch: 'feat/held', base: originalHead });
  expect(await worktreeCard(worker.cardId)).toMatchObject({ repo, path: expectedCopy, branch: 'feat/held', base: originalHead });
  expect(git(expectedCopy, ['branch', '--show-current'])).toBe('feat/held');
  fs.mkdirSync(path.join(expectedCopy, 'node_modules'));
  const asset = path.join(expectedCopy, 'node_modules', 'private.sqlite');
  fs.writeFileSync(asset, 'fixture user asset\n');
  expect(await cli(['archive', '--id', worker.column.id])).toContain('可手动清理');
  expect(fs.readFileSync(asset, 'utf8')).toBe('fixture user asset\n');
  expect(await worktreeCard(worker.cardId)).toMatchObject({ removed: false });
  const withoutPath = await cli(['worktree', 'clean', '--apply']);
  expect(withoutPath).toContain('--path');
  expect(fs.readFileSync(asset, 'utf8')).toBe('fixture user asset\n');
  expect(git(repo, ['rev-parse', 'HEAD'])).toBe(originalHead);
  expect(git(repo, ['status', '--porcelain', '--ignored'])).toBe('');
  expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('Original repository\n');
});

test('archive safely reclaims a completely clean copy whose commit is already on main', async () => {
  const worker = await startWorker('Clean merged task', ['--worktree', repo, '--branch', 'feat/clean']);
  expect(fs.existsSync(worker.column.cwd)).toBe(true);
  expect(git(worker.column.cwd, ['status', '--porcelain', '--ignored'])).toBe('');
  expect(await cli(['archive', '--id', worker.column.id])).toContain('已回收');
  expect(fs.existsSync(worker.column.cwd)).toBe(false);
  expect(await worktreeCard(worker.cardId)).toMatchObject({ removed: true });
  expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  expect(git(repo, ['branch', '--list', 'feat/clean'])).toBe('');
  expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
});

test('a Claude session in a new copy finds the copy already trusted for its seat; other folders and non-Claude sessions are not touched', { skip: process.platform === 'win32' }, async () => {
  const seatFile = path.join(profile, 'seats-home', '.claude.json');   // the default seat's global file in a test profile
  const launches = path.join(profile, 'claude-launches.jsonl');
  const shim = path.join(profile, 'claude-shim.js');
  fs.writeFileSync(shim, `const fs = require('fs');
let trusted = false, projects = [];
try { const j = JSON.parse(fs.readFileSync(${JSON.stringify(seatFile)}, 'utf8')); projects = Object.keys(j.projects || {}); trusted = j.projects[process.cwd()].hasTrustDialogAccepted === true; } catch (_) {}
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ id: process.env.AGENTDECK_COL_ID, cwd: process.cwd(), trusted, projects }) + '\\n');
fs.appendFileSync(${JSON.stringify(cwdFile)}, JSON.stringify({ id: process.env.AGENTDECK_COL_ID, cwd: process.cwd() }) + '\\n');
require(${JSON.stringify(FAKE)});`);
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, 'bin', 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${shim}" --screen-only\n`, { mode: 0o755 });
  // an absolute path to a program named claude is a Claude session to the app, but never the real CLI
  const worker = await startWorker('Claude copy task', ['--worktree', repo, '--branch', 'feat/trusted'], `${path.join(home, 'bin', 'claude')} --model claude-opus-5-5`);
  const launch = fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.id === worker.column.id);
  expect(launch.cwd).toBe(worker.column.cwd);
  expect(launch.trusted).toBe(true);   // already in the seat's file when the agent started
  // exactly that one directory: not the repo, the copy root or the user's home
  expect(launch.projects).toEqual([worker.column.cwd]);
  const trustedBefore = fs.readFileSync(seatFile, 'utf8');
  // a worker that is not Claude gets a copy and no trust record
  const other = await startWorker('Other agent copy task', ['--worktree', repo, '--branch', 'feat/untrusted']);
  expect(fs.existsSync(other.column.cwd)).toBe(true);
  expect(fs.readFileSync(seatFile, 'utf8')).toBe(trustedBefore);
});

test('new with only cwd preserves the requested directory and creates no code copy', async () => {
  const worker = await startWorker('Existing directory task', ['--cwd', repo]);
  expect(worker.column.cwd).toBe(repo); expect(worker.processCwd).toBe(repo);
  expect(worker.column.worktree).toBeNull(); expect(await worktreeCard(worker.cardId)).toBeNull();
  expect(fs.existsSync(path.join(home, 'agentdeck-worktrees'))).toBe(false);
  expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  expect(git(repo, ['branch', '--show-current'])).toBe('main');
});
