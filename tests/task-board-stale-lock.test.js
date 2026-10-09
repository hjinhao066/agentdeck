'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TaskStore } = require('../task-board');

// The board's write lock is a directory in the system temp folder with owner.json
// (pid, host, created). A lock is taken over only when its owner process has
// exited; a live writer keeps it however long it takes, and a lock whose owner
// cannot be read is never touched.
function board(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-lock-test-'));
  const store = new TaskStore(dir);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    const base = path.basename(store.lock);
    for (const name of fs.readdirSync(os.tmpdir())) if (name === base || name.startsWith(base + '.')) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  });
  return store;
}
const add = (store, title = 'card') => store.add({ project: 'AgentDeck', title });
function lockWith(store, owner) {
  fs.mkdirSync(store.lock);
  const raw = JSON.stringify(owner);
  fs.writeFileSync(path.join(store.lock, 'owner.json'), raw);
  return raw;
}
// The pid of a process that has already exited.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}
const ownerOf = (store) => fs.readFileSync(path.join(store.lock, 'owner.json'), 'utf8');

test('a lock left by a process that exited mid-write is taken over and the write goes through', (t) => {
  const store = board(t);
  lockWith(store, { pid: deadPid(), host: os.hostname(), created: new Date().toISOString() });
  add(store, 'after the crash');
  assert.deepEqual(store.list().map((c) => c.title), ['after the crash']);
  assert.equal(fs.existsSync(store.lock), false, 'the new writer released the lock');
  add(store, 'next');
  assert.equal(store.list().length, 2);
});

test('an old-format owner record (pid and time only) of an exited process is taken over too', (t) => {
  const store = board(t);
  lockWith(store, { pid: deadPid(), created: new Date().toISOString() });
  add(store);
  assert.equal(store.list().length, 1);
});

test('a live writer keeps its lock however long it has held it; the refusal names the lock', (t) => {
  const store = board(t);
  // A slow writer: alive, and already running when it took the lock an hour ago.
  const raw = lockWith(store, { pid: process.pid, host: os.hostname(), created: new Date(Date.now() - 3600_000).toISOString() });
  store.processStart = () => Date.now() - 2 * 3600_000;
  assert.throws(() => add(store), (err) => /another local process/.test(err.message) && err.message.includes(store.lock));
  assert.equal(ownerOf(store), raw, 'the live lock is untouched');
  assert.equal(store.list().length, 0);
});

test('a live pid whose start time cannot be read is treated as the owner', (t) => {
  const store = board(t);
  const raw = lockWith(store, { pid: process.pid, host: os.hostname(), created: new Date(Date.now() - 3600_000).toISOString() });
  store.processStart = () => NaN;
  assert.throws(() => add(store), /another local process/);
  assert.equal(ownerOf(store), raw);
});

test('a reused pid (a process that started after the lock was taken) does not hold the lock', (t) => {
  const store = board(t);
  lockWith(store, { pid: process.pid, host: os.hostname(), created: new Date(Date.now() - 3600_000).toISOString() });
  store.processStart = () => Date.now() - 60_000;
  add(store);
  assert.equal(store.list().length, 1);
});

test('a fresh lock of a live writer is respected without asking for its start time', (t) => {
  const store = board(t);
  const raw = lockWith(store, { pid: process.pid, host: os.hostname(), created: new Date().toISOString() });
  store.processStart = () => { throw new Error('must not be asked'); };
  assert.throws(() => add(store), /another local process/);
  assert.equal(ownerOf(store), raw);
});

test('a lock without a readable owner is never removed (a writer may be between making it and naming itself)', (t) => {
  const store = board(t);
  fs.mkdirSync(store.lock);
  assert.throws(() => add(store), /another local process/);
  assert.equal(fs.existsSync(store.lock), true);
  fs.writeFileSync(path.join(store.lock, 'owner.json'), '{"pid":');
  assert.throws(() => add(store), /another local process/);
  assert.equal(ownerOf(store), '{"pid":');
});

test('a lock written on another computer name is not judged by this one', (t) => {
  const store = board(t);
  const raw = lockWith(store, { pid: deadPid(), host: os.hostname() + '-other', created: new Date().toISOString() });
  assert.throws(() => add(store), /another local process/);
  assert.equal(ownerOf(store), raw);
});

test('a pid owned by another user (no permission to signal it) counts as alive', (t) => {
  const store = board(t);
  const raw = lockWith(store, { pid: 424242, host: os.hostname(), created: new Date().toISOString() });
  const kill = process.kill;
  process.kill = (pid, signal) => { if (pid === 424242 && signal === 0) { const err = new Error('EPERM'); err.code = 'EPERM'; throw err; } return kill.call(process, pid, signal); };
  t.after(() => { process.kill = kill; });
  assert.throws(() => add(store), /another local process/);
  assert.equal(ownerOf(store), raw);
});

test('a second process that judged the same dead lock never removes the lock a new writer made meanwhile', (t) => {
  const store = board(t);
  const stale = lockWith(store, { pid: deadPid(), host: os.hostname(), created: new Date().toISOString() });
  // First process: takes the dead lock over and is now writing (its own live lock).
  const first = new TaskStore(store.dir);
  first.mutate(() => {
    const live = ownerOf(store);
    assert.notEqual(live, stale);
    // Second process: read the dead owner just before the takeover, acts on it now.
    const late = new TaskStore(store.dir);
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) { if (file === path.join(store.lock, 'owner.json')) { fs.readFileSync = read; return stale; } return read.call(this, file, ...rest); };
    try { assert.throws(() => late.mutate(() => assert.fail('two writers at once')), /another local process/); }
    finally { fs.readFileSync = read; }
    assert.equal(ownerOf(store), live, 'the first writer still holds its lock');
    // Same, after the record of the first takeover has been cleared away.
    for (const name of fs.readdirSync(os.tmpdir())) if (name.startsWith(path.basename(store.lock) + '.stale-')) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    fs.readFileSync = function (file, ...rest) { if (file === path.join(store.lock, 'owner.json')) { fs.readFileSync = read; return stale; } return read.call(this, file, ...rest); };
    try { assert.throws(() => late.mutate(() => assert.fail('two writers at once')), /another local process/); }
    finally { fs.readFileSync = read; }
    assert.equal(ownerOf(store), live, 'the first writer still holds its lock');
    return {};
  });
  assert.equal(fs.existsSync(store.lock), false);
});

// Real processes: writers race each other while other processes die holding the
// lock. No two writers are ever inside the lock together and no card is lost.
test('many processes writing through crashed owners: one writer at a time, nothing lost', { timeout: 120_000 }, async (t) => {
  const store = board(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-lock-race-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const boardModule = path.join(__dirname, '..', 'task-board.js');
  const writer = `
    const fs = require('fs'), path = require('path');
    const { TaskStore } = require(${JSON.stringify(boardModule)});
    const [dir, work, name, count] = process.argv.slice(1);
    const store = new TaskStore(dir);
    const inside = path.join(work, 'inside');
    // Mark the time between taking the lock and releasing it.
    const rm = fs.rmSync;
    const overlap = (what) => fs.appendFileSync(path.join(work, 'overlap'), name + ' ' + what + '\\n');
    fs.rmSync = (p, o) => {
      if (p === store.lock) { let mark = ''; try { mark = fs.readFileSync(inside, 'utf8'); fs.unlinkSync(inside); } catch (_) {} if (mark !== name) overlap('released while ' + (mark || 'nobody') + ' was marked inside'); }
      return rm(p, o);
    };
    const mutate = store.mutate.bind(store);
    store.mutate = (run) => mutate((docs) => {
      try { fs.writeFileSync(inside, name, { flag: 'wx' }); }
      catch (_) { let other = '?'; try { other = fs.readFileSync(inside, 'utf8'); } catch (_) {} if (other !== name) overlap('entered while ' + other + ' was inside'); }
      return run(docs);
    });
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < Number(count); i++) {
      for (let tries = 0; ; tries++) {
        try { store.add({ project: 'AgentDeck', title: name + '-' + i }); break; }
        catch (err) { if (!/another local process|TASK_SYNC_RETRY/.test(err.message) || tries > 4000) throw err; Atomics.wait(sleep, 0, 0, 2 + Math.floor(Math.random() * 5)); }
      }
    }`;
  const crasher = `
    const { TaskStore } = require(${JSON.stringify(boardModule)});
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    for (let tries = 0; tries < 4000; tries++) {
      try { new TaskStore(process.argv[1]).mutate(() => process.exit(0)); } catch (_) { Atomics.wait(sleep, 0, 0, 3); }
    }
    process.exit(1);`;
  const run = (code, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  lockWith(store, { pid: deadPid(), host: os.hostname(), created: new Date().toISOString() });
  const WRITERS = 5, EACH = 12;
  const jobs = [];
  for (let w = 0; w < WRITERS; w++) jobs.push(run(writer, [store.dir, work, 'w' + w, String(EACH)]));
  for (let c = 0; c < 4; c++) jobs.push(new Promise((resolve) => setTimeout(resolve, 40 * c)).then(() => run(crasher, [store.dir])));
  const results = await Promise.all(jobs);
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.equal(fs.existsSync(path.join(work, 'overlap')), false, 'two writers were inside the lock together: ' + (fs.existsSync(path.join(work, 'overlap')) ? fs.readFileSync(path.join(work, 'overlap'), 'utf8') : ''));
  const titles = store.list().map((c) => c.title).sort();
  const expected = [];
  for (let w = 0; w < WRITERS; w++) for (let i = 0; i < EACH; i++) expected.push('w' + w + '-' + i);
  assert.deepEqual(titles, expected.sort());
});

test('the start time of a real process is read from the system', (t) => {
  const store = board(t);
  const started = Date.now() - process.uptime() * 1000;
  const read = store.processStart(process.pid);
  assert.ok(Math.abs(read - started) < 3000, `read ${new Date(read).toISOString()}, started ${new Date(started).toISOString()}`);
  assert.ok(Number.isNaN(store.processStart(deadPid())));
});

test('a lock whose owner record cannot be written (EMFILE, full disk) is removed and the real error reported', (t) => {
  const store = board(t);
  const write = fs.writeFileSync;
  let fail = true;
  fs.writeFileSync = function (file, ...rest) {
    if (fail && String(file) === path.join(store.lock, 'owner.json')) { fail = false; const err = new Error('EMFILE: too many open files'); err.code = 'EMFILE'; throw err; }
    return write.call(this, file, ...rest);
  };
  t.after(() => { fs.writeFileSync = write; });
  assert.throws(() => add(store, 'first'), (err) => err.code === 'EMFILE' && !/another local process/.test(err.message));
  assert.equal(fs.existsSync(store.lock), false, 'the half-made lock is gone');
  add(store, 'next');
  assert.deepEqual(store.list().map((c) => c.title), ['next']);
});
