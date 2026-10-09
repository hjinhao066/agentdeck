'use strict';
// TaskStore.mutate takes a cross-process lock directory and records its owner
// inside it. If recording the owner fails (the process is out of file
// descriptors, the temp disk is full), the lock directory must not stay behind:
// every later board write would then be refused as "being written by another
// local process" until someone deletes the directory by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../task-board');

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-board-lock-'));
  const s = new TaskStore(path.join(dir, 'tasks'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(s.lock, { recursive: true, force: true }); });
  return s;
}

test('a failed owner record does not leave the board lock behind', (t) => {
  const s = store(t);
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    if (typeof file === 'string' && file === path.join(s.lock, 'owner.json')) {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return real.call(this, file, ...rest);
  });
  assert.throws(() => s.add({ project: 'Lock', title: 'first' }), /EMFILE/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(s.lock), false, 'the lock directory is removed again');
  const { card } = s.add({ project: 'Lock', title: 'second' });
  assert.equal(card.title, 'second');
  assert.deepEqual(s.list().map((c) => c.title), ['second']);
});

test('a lock held by a live writer still refuses a second writer', (t) => {
  const s = store(t);
  fs.mkdirSync(s.lock);
  assert.throws(() => s.add({ project: 'Lock', title: 'blocked' }), /being written by another local process/);
  assert.equal(fs.existsSync(s.lock), true, 'somebody else\'s lock is left alone');
});
