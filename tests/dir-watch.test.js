'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { watchDir } = require('../dir-watch');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await wait(20);
  }
  return true;
}

// What libuv does on Windows once the watched folder is deleted while the watch holds it open:
// a rename of the folder itself, reported again the moment the watch re-arms, until it is closed.
function windowsLikeFs() {
  let exists = true, ino = 1, watched = null;
  const watchers = [];
  return {
    watchers,
    remove() {
      exists = false;
      for (const w of watchers) if (!w.closed) w.storm();
    },
    // Only the watched folder is deleted; its parent stays.
    statSync(p) { if (!exists && p === watched) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isDirectory: () => true, ino }; },
    mkdirSync() { if (!exists) { exists = true; ino += 1; } },
    watch(dir, listener) {
      watched = dir;
      const w = new EventEmitter();
      w.closed = false;
      w.calls = 0;
      w.close = () => { w.closed = true; };
      w.storm = () => {
        const fire = () => {
          if (w.closed || w.calls > 100000) return;
          w.calls += 1;
          listener('rename', '\\\\?\\' + dir);
          setImmediate(fire);
        };
        setImmediate(fire);
      };
      watchers.push(w);
      return w;
    },
  };
}

test('a watched folder deleted under the watch closes it after one event, then is watched again', async () => {
  const fake = windowsLikeFs();
  const events = [];
  const handle = watchDir('C:\\Users\\u\\.agents\\boards\\todos', (type) => events.push(type), { fs: fake, retryMs: 50 });
  assert.equal(fake.watchers.length, 1);
  fake.remove();
  await wait(30);
  assert.equal(fake.watchers[0].closed, true);
  assert.equal(fake.watchers[0].calls, 1, 'the storm stops at its first event');
  assert.deepEqual(events, ['rename'], 'the caller hears that the folder changed');
  assert.equal(handle.watching(), false);
  assert.ok(await until(() => handle.watching()), 'watched again after the retry delay');
  assert.equal(fake.watchers.length, 2);
  assert.deepEqual(events, ['rename', undefined], 'and told once more to read the folder again');
  handle.close();
  assert.equal(fake.watchers[1].closed, true);
});

test('a watch that cannot start is retried, and close stops the retries', async () => {
  let attempts = 0;
  const errors = [];
  const fake = {
    mkdirSync() {},
    statSync() { return { isDirectory: () => true, ino: 1 }; },
    watch() { attempts += 1; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
  };
  const handle = watchDir('/x', () => {}, { fs: fake, retryMs: 20, onError: (e) => errors.push(e.code) });
  assert.ok(await until(() => attempts >= 3));
  handle.close();
  const after = attempts;
  await wait(80);
  assert.equal(attempts, after);
  assert.deepEqual(errors, ['EPERM'], 'a lasting failure is reported once');
});

test('a watcher error closes the watch and reports it once per failure', async () => {
  const fake = windowsLikeFs();
  const errors = [];
  const handle = watchDir('/x', () => {}, { fs: fake, retryMs: 30, onError: (e) => errors.push(e.message) });
  fake.watchers[0].emit('error', new Error('boom'));
  assert.equal(fake.watchers[0].closed, true);
  assert.deepEqual(errors, ['boom']);
  assert.ok(await until(() => handle.watching()));
  handle.close();
});

test('real folder: deleting it stops the old watch, and changes in the re-created folder arrive', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dir-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'todos');
  fs.mkdirSync(dir);
  let calls = 0;
  const names = [];
  const handle = watchDir(dir, (_type, name) => { calls += 1; if (name) names.push(String(name)); }, { retryMs: 100 });
  t.after(() => handle.close());
  await wait(200);
  fs.rmSync(dir, { recursive: true, force: true });
  await wait(1000);
  // Raw fs.watch on Windows reaches tens of thousands here (145349 in 2 s on the PC).
  assert.ok(calls < 50, `callbacks after the folder went: ${calls}`);
  assert.ok(await until(() => handle.watching() && fs.existsSync(dir)), 'the folder is created and watched again');
  await wait(200);
  fs.writeFileSync(path.join(dir, 'dev-a.json'), '{}');
  assert.ok(await until(() => names.some((n) => n.endsWith('dev-a.json'))), 'a file written in the new folder is seen');
});

test('real folder: a file written while the watch was down is announced once the watch is back', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dir-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'todos');
  fs.mkdirSync(dir);
  let calls = 0;
  const handle = watchDir(dir, () => { calls += 1; }, { retryMs: 400 });
  t.after(() => handle.close());
  await wait(200);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(await until(() => !handle.watching()), 'the watch on the deleted folder is closed');
  // Another program (git, the other computer's sync) puts the folder back with a file in it.
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'dev-mac.json'), '{}');
  await wait(100);
  const before = calls;
  assert.ok(await until(() => handle.watching()), 'watched again');
  assert.ok(await until(() => calls > before, 1000), 'the caller is told to read the folder again');
});

test('real folder: a deleted parent is not created again; the folder comes back only once the parent does', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-dir-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = path.join(root, '.agents');
  const dir = path.join(agents, 'boards', 'todos');
  fs.mkdirSync(dir, { recursive: true });
  const errors = [];
  let calls = 0;
  const handle = watchDir(dir, () => { calls += 1; }, { retryMs: 150, onError: (e) => errors.push(e.code) });
  t.after(() => handle.close());
  await wait(200);
  // The folder goes first (its own watch sees that on every system), then the whole tree,
  // as when ~/.agents is deleted to be cloned again.
  fs.rmdirSync(dir);
  assert.ok(await until(() => !handle.watching()));
  fs.rmSync(agents, { recursive: true, force: true });
  await wait(700);
  assert.equal(fs.existsSync(agents), false, '~/.agents stays deleted');
  assert.equal(handle.watching(), false);
  assert.deepEqual(errors, [], 'waiting for the parent is not an error');
  // The clone brings the parent back: only the deleted level is made again, then watched.
  fs.mkdirSync(path.join(agents, 'boards'), { recursive: true });
  const before = calls;
  assert.ok(await until(() => handle.watching() && fs.existsSync(dir)), 'the folder is made and watched again');
  assert.ok(await until(() => calls > before, 1000), 'and the caller reads it again');
});

test('the main process watches its folders only through watchDir', () => {
  for (const file of ['main.js', 'task-heartbeat.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /\bfs\.watch\(/, `${file} calls fs.watch directly`);
  }
});
