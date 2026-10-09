const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TaskStore } = require('../../task-board');

// The board's write lock on this platform's own process rules (Windows: signal 0
// through OpenProcess, start time through PowerShell; macOS/Linux: ps). No app
// window; real processes only.
test.describe.configure({ timeout: 180_000 });
const ROOT = path.resolve(__dirname, '../..');
let store, children = [];
test.beforeEach(() => { store = new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-lock-e2e-'))); });
test.afterEach(() => {
  for (const child of children) child.kill();
  children = [];
  fs.rmSync(store.dir, { recursive: true, force: true });
  const base = path.basename(store.lock);
  for (const name of fs.readdirSync(os.tmpdir())) if (name === base || name.startsWith(base + '.')) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
});
function lockWith(owner) {
  fs.mkdirSync(store.lock);
  const raw = JSON.stringify(owner);
  fs.writeFileSync(path.join(store.lock, 'owner.json'), raw);
  return raw;
}
function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

test('lock unit tests, including many crashing processes, pass on this platform', () => {
  const run = spawnSync(process.execPath, ['--test', path.join('tests', 'task-board-stale-lock.test.js')], { cwd: ROOT, encoding: 'utf8', timeout: 170_000 });
  expect(run.stdout + run.stderr).toMatch(/(?:# |ℹ )pass 12\b[\s\S]*(?:# |ℹ )fail 0\b/);
  expect(run.status).toBe(0);
});

test('a slow writer that has held the lock for over 10 seconds keeps it', async () => {
  const child = liveChild();
  await new Promise((resolve) => child.once('spawn', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Taken by the running child, then held past the 10-second mark, so its real start time is read.
  const raw = lockWith({ pid: child.pid, host: os.hostname(), created: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  expect(Number.isFinite(store.processStart(child.pid))).toBe(true);
  expect(() => store.add({ project: 'AgentDeck', title: 'must wait' })).toThrow(/another local process/);
  expect(fs.readFileSync(path.join(store.lock, 'owner.json'), 'utf8')).toBe(raw);
  // Once that process is gone, the next write takes the lock over.
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  store.add({ project: 'AgentDeck', title: 'after the writer died' });
  expect(store.list().map((c) => c.title)).toEqual(['after the writer died']);
});

test('a pid now used by a process that started after the lock was taken does not hold it', async () => {
  const child = liveChild();
  await new Promise((resolve) => child.once('spawn', resolve));
  lockWith({ pid: child.pid, host: os.hostname(), created: new Date(Date.now() - 120_000).toISOString() });
  store.add({ project: 'AgentDeck', title: 'pid reused' });
  expect(store.list().map((c) => c.title)).toEqual(['pid reused']);
});
