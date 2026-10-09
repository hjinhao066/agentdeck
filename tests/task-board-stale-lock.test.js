'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TaskStore } = require('../task-board');

test('stale lock recovery: dead process', async () => {
  const dir = path.join(os.tmpdir(), 'agentdeck-test-stale-lock-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const store = new TaskStore(dir);
    const lockDir = store.lock;

    // Simulate a crashed process by creating a stale lock with a dead PID
    fs.mkdirSync(lockDir, { recursive: true });
    const deadPid = 999999; // Unlikely to exist
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: deadPid, created: new Date(Date.now() - 1000).toISOString() }));

    // The next mutate should recover the lock and succeed
    let called = false;
    store.mutate((docs) => {
      called = true;
      return { success: true };
    });

    assert.ok(called, 'mutate should execute after recovering stale lock');
    assert.ok(!fs.existsSync(lockDir), 'stale lock should be removed after recovery');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock recovery: lock timeout', async () => {
  const dir = path.join(os.tmpdir(), 'agentdeck-test-lock-timeout-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const store = new TaskStore(dir);
    const lockDir = store.lock;

    // Create a lock that's older than 5 minutes
    fs.mkdirSync(lockDir, { recursive: true });
    const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, created: oldTime }));

    // The next mutate should recover the lock and succeed
    let called = false;
    store.mutate((docs) => {
      called = true;
      return { success: true };
    });

    assert.ok(called, 'mutate should execute after recovering timeout lock');
    assert.ok(!fs.existsSync(lockDir), 'timeout lock should be removed after recovery');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock recovery: active process is not removed', async () => {
  const dir = path.join(os.tmpdir(), 'agentdeck-test-active-lock-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const store = new TaskStore(dir);
    const lockDir = store.lock;

    // Create a lock with current process
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));

    // Try to mutate - should fail since lock is held by current process
    let called = false;
    assert.throws(
      () => {
        store.mutate(() => {
          called = true;
          return { success: true };
        });
      },
      (err) => err.message.includes('being written by another local process')
    );

    assert.ok(!called, 'mutate should not execute when lock is held by active process');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock recovery: prevents concurrent writes', async () => {
  const dir = path.join(os.tmpdir(), 'agentdeck-test-concurrent-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const store = new TaskStore(dir);

    // First write succeeds
    store.mutate((docs) => {
      docs.set('test', { doc: { version: 1, project: 'test', cards: [] }, raw: null });
    });

    // Verify data persisted
    const docs1 = store.read();
    assert.ok(docs1.has('test'), 'data should be persisted');
    assert.equal(docs1.get('test').doc.version, 1);

    // Second write also succeeds and lock is properly released
    store.mutate((docs) => {
      docs.get('test').doc.version = 1;
    });

    // Verify lock is now released (try to get lock again)
    assert.ok(!store.lock || !fs.existsSync(store.lock), 'lock should be released after mutate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
