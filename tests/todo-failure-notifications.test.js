'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TodoFailureNotifications, nextAllowedTime, COALESCE_MS } = require('../todo-failure-notifications');
const id = (letter) => 'todo-error-' + letter.repeat(64);
const local = (hour, minute = 0, day = 7) => new Date(2026, 9, day, hour, minute).getTime();
function harness(t, initial = local(12)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-todo-alerts-'));
  const file = path.join(dir, 'queue.json'), calls = [], errors = [], scheduled = [];
  let now = initial;
  const options = { file, notify: async (command) => { calls.push(command); }, onError: (stage) => errors.push(stage),
    now: () => now, schedule: (fn, ms) => { const timer = { fn, ms }; scheduled.push(timer); return timer; }, clear: () => {} };
  const queue = new TodoFailureNotifications(options);
  t.after(() => { queue.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, calls, errors, scheduled, options, queue, setNow: (at) => { now = at; } };
}

test('failures coalesce into one generic ordinary-expedited notification and duplicate ids join only once', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ id: id('a'), message: 'private clinical report' });
  h.queue.enqueue({ id: id('b') }); h.queue.enqueue({ id: id('a') });
  assert.equal(h.scheduled.length, 1); assert.equal(h.scheduled[0].ms, COALESCE_MS);
  assert.equal(await h.queue.flush(), false); assert.equal(h.calls.length, 0);
  assert.ok(!fs.readFileSync(h.file, 'utf8').includes('clinical'));
  h.setNow(local(12) + COALESCE_MS);
  assert.equal(await h.queue.flush(), true);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].message, /有 2 条/);
  assert.equal(h.calls[0].level, 'timeSensitive'); assert.equal(h.calls[0].urgent, true);
  assert.equal(h.calls[0].volume, undefined); assert.match(h.calls[0].id, /^todo-failures-[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { pending: {} });
  assert.equal(await h.queue.flush(), false);
});

test('quiet-hour boundaries use local calendar times and permit exactly 10:00 through 22:59', () => {
  for (const [hour, minute, expected] of [[22, 59, local(22, 59)], [23, 0, local(10, 0, 8)],
    [23, 59, local(10, 0, 8)], [0, 0, local(10)], [9, 30, local(10)], [9, 59, local(10)], [10, 0, local(10)]]) {
    assert.equal(nextAllowedTime(local(hour, minute)), expected);
  }
});

test('late-evening failure persists through restart, joins overnight failures and sends together at 10:00', async (t) => {
  const h = harness(t, local(22, 59));
  h.queue.enqueue({ id: id('a') });
  assert.equal(h.scheduled[0].ms, local(10, 0, 8) - local(22, 59));
  h.setNow(local(23)); assert.equal(await h.queue.flush(), false);
  h.queue.stop();
  h.setNow(local(1, 0, 8));
  const restored = new TodoFailureNotifications(h.options);
  t.after(() => restored.stop()); restored.start(); restored.enqueue({ id: id('b') });
  assert.equal(await restored.flush(), false); assert.equal(h.calls.length, 0);
  h.setNow(local(9, 30, 8)); assert.equal(await restored.flush(), false);
  h.setNow(local(9, 59, 8)); assert.equal(await restored.flush(), false);
  assert.equal(h.calls.length, 0);
  h.setNow(local(10, 0, 8)); assert.equal(await restored.flush(), true);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].message, /有 2 条/);
});

test('missing Captain retains pending failures and retries later rather than dropping the queue', async (t) => {
  const h = harness(t); let ready = false;
  h.queue.notify = async (command) => { if (!ready) return false; h.calls.push(command); };
  h.queue.enqueue({ id: id('a') }); h.setNow(local(12) + COALESCE_MS);
  assert.equal(await h.queue.flush(), false);
  assert.ok(JSON.parse(fs.readFileSync(h.file, 'utf8')).pending[id('a')]);
  ready = true; assert.equal(await h.queue.flush(), true); assert.equal(h.calls.length, 1);
});

test('transport errors are redacted, reported and retain the durable batch for a delayed retry', async (t) => {
  const h = harness(t);
  h.queue.notify = async () => { throw new Error('secret clinical report'); };
  h.queue.enqueue({ id: id('a') }); h.setNow(local(12) + COALESCE_MS);
  assert.equal(await h.queue.flush(), false);
  assert.deepEqual(h.errors, ['todo-failure-notifications']);
  assert.ok(h.queue.pending[id('a')]);
  assert.equal(h.scheduled.at(-1).ms, COALESCE_MS);
});

test('new failures while a batch is in flight survive its delivery acknowledgment', async (t) => {
  const h = harness(t); let resolve;
  h.queue.notify = () => new Promise((done) => { resolve = done; });
  h.queue.enqueue({ id: id('a') }); h.setNow(local(12) + COALESCE_MS);
  const sending = h.queue.flush();
  h.queue.enqueue({ id: id('b') }); assert.equal(await h.queue.flush(), false);
  resolve(); assert.equal(await sending, true);
  assert.deepEqual(Object.keys(h.queue.pending), [id('b')]);
});

test('corrupt persisted queues fail visibly and are not overwritten', (t) => {
  const h = harness(t); fs.writeFileSync(h.file, '{private-invalid');
  assert.throws(() => new TodoFailureNotifications(h.options));
  assert.equal(fs.readFileSync(h.file, 'utf8'), '{private-invalid');
  fs.writeFileSync(h.file, JSON.stringify({ pending: { bad: 3 } }));
  assert.throws(() => new TodoFailureNotifications(h.options), /Invalid Todo/);
});

test('stop leaves the delayed queue durable without sending and malformed ids never enter it', async (t) => {
  const h = harness(t); assert.throws(() => h.queue.enqueue({ id: 'private-task-text' }), /Invalid Todo/);
  assert.equal(fs.existsSync(h.file), false);
  h.queue.enqueue({ id: id('a') }); h.queue.stop(); h.setNow(local(13));
  assert.equal(await h.queue.flush(), false); assert.equal(h.calls.length, 0);
  assert.ok(JSON.parse(fs.readFileSync(h.file, 'utf8')).pending[id('a')]);
});

test('a delivered batch never rings again when clearing its queue repeatedly fails in the same process', async (t) => {
  const h = harness(t), save = h.queue.save.bind(h.queue);
  h.queue.enqueue({ id: id('a') }); h.setNow(local(12) + COALESCE_MS);
  let fail = true;
  h.queue.save = (pending) => { if (fail) throw Object.assign(new Error('private path'), { code: 'EIO' }); save(pending); };
  assert.equal(await h.queue.flush(), false);
  assert.equal(h.calls.length, 1); assert.ok(h.queue.pending[id('a')]);
  assert.equal(await h.queue.flush(), false);
  assert.equal(h.calls.length, 1);
  fail = false; assert.equal(await h.queue.flush(), true);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.queue.pending, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { pending: {} });
  assert.deepEqual(h.errors, ['todo-failure-notifications', 'todo-failure-notifications']);
});

test('new failures keep their own coalescing window after an earlier delivered batch failed to clear', async (t) => {
  const h = harness(t), save = h.queue.save.bind(h.queue);
  h.queue.enqueue({ id: id('a') }); h.setNow(local(12) + COALESCE_MS);
  let fail = true;
  h.queue.save = (pending) => { if (fail && !Object.keys(pending).length) throw new Error('disk write failed'); save(pending); };
  assert.equal(await h.queue.flush(), false); assert.equal(h.calls.length, 1);
  h.setNow(local(12) + COALESCE_MS + 10000); h.queue.enqueue({ id: id('b') });
  fail = false;
  assert.equal(await h.queue.flush(), false);
  assert.deepEqual(Object.keys(h.queue.pending), [id('b')]); assert.equal(h.calls.length, 1);
  h.setNow(local(12) + 2 * COALESCE_MS + 10000);
  assert.equal(await h.queue.flush(), true); assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].message, /有 1 条/); assert.notEqual(h.calls[0].id, h.calls[1].id);
});
