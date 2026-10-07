'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../discussion-core');
const { createStore } = require('../discussion-store');
const Runner = require('../discussion-runner');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-runner-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createStore({ root });
  const run = Core.createDiscussion({ question: '如何可靠地保存、恢复同一轮讨论？给出验证方法。' });
  store.create(run);
  return { root, store, run, dir: store.dir(run.id) };
}
function result(job) {
  return { text: '建议使用全员屏障与原子状态存储。假设所有参加者都必须交出完整稿，失败时暂停，保留不同意见。',
    actualModel: job.participant.model, actualTier: job.participant.tier,
    actualEffort: job.participant.effort, materialDisagreement: false,
    summary: '采用持久化屏障。失败暂停。保留原稿。', faithful: true, disagreements: [], minority: [] };
}
test('single runner lease rejects a second writer and releases only its own lock', (t) => {
  const { dir } = fixture(t);
  const release = Runner.lock(dir);
  assert.equal(Runner.owner(dir).pid, process.pid);
  assert.throws(() => Runner.lock(dir), /仍在运行/);
  release(); assert.equal(Runner.owner(dir), null);
});
test('a crashed runner lease is replaced with an already complete new owner', (t) => {
  const { dir } = fixture(t);
  fs.mkdirSync(path.join(dir, '.runner-lock'));
  fs.writeFileSync(path.join(dir, '.runner-lock', 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'crashed' }));
  const release = Runner.lock(dir);
  assert.equal(Runner.owner(dir).pid, process.pid);
  assert.notEqual(Runner.owner(dir).token, 'crashed');
  release();
});
test('completed private provider artifacts recover a crashed round without another send', async (t) => {
  const { run, store, dir } = fixture(t);
  for (const job of run.jobs) Core.markStarted(run, job.id);
  Core.acceptResult(run, run.jobs[0].id, { ...result(run.jobs[0]), attemptId: run.jobs[0].attemptId });
  store.save(run);
  const restarted = store.load(run.id);
  let reads = 0;
  await Runner.recoverResults(restarted, { recover: async (job) => {
    reads++; assert.equal(job.prompt, job.input); return result(job);
  } }, dir);
  assert.equal(reads, 1);
  assert.equal(restarted.rounds.length, 1);
  assert.equal(restarted.phase, 'review');
  assert.equal(restarted.jobs.filter((j) => j.phase === 'independent').length, 2);
});
test('unverifiable interrupted send stays unknown and sends nothing on recovery', async (t) => {
  const { run, dir } = fixture(t);
  Core.markStarted(run, run.jobs[0].id);
  await Runner.recoverResults(run, { recover: async () => { throw new Error('unverifiable'); } }, dir);
  assert.equal(run.status, 'paused'); assert.equal(run.jobs[0].status, 'unknown');
  assert.deepEqual(Core.nextJobs(run), []);
});
test('runner completes five calls and keeps original outputs out of the short receipt', async (t) => {
  const { run, store, dir } = fixture(t); let calls = 0;
  const completed = await Runner.runDiscussion({ id: run.id, store,
    adapter: { execute: async (job) => { calls++; return result(job); } } });
  assert.equal(calls, 5); assert.equal(completed.status, 'complete');
  assert.equal(Runner.owner(dir), null);
  const note = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  assert.equal(note.delivered, false); assert.match(note.text, /final\.md/);
  assert.doesNotMatch(note.text, /所有参加者都必须交出完整稿/);
});
test('adapter initialization failure leaves a visible pause and releases its lease', async (t) => {
  const { run, store, dir } = fixture(t);
  await assert.rejects(Runner.runDiscussion({ id: run.id, store, get adapter() { throw new Error('private setup diagnostic'); } }));
  assert.equal(store.load(run.id).status, 'paused');
  assert.equal(store.load(run.id).pauseReason, 'RUNNER_FAILED');
  assert.equal(Runner.owner(dir), null);
  const note = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  assert.match(note.text, /RUNNER_FAILED/);
  assert.doesNotMatch(note.text, /private setup diagnostic/);
});
test('cancellation aborts in-flight adapters, preserves completed drafts and prevents next round', async (t) => {
  const { run, store, dir } = fixture(t); let calls = 0;
  const pending = Runner.runDiscussion({ id: run.id, store, adapter: {
    execute: async (job, { signal }) => {
      calls++;
      if (job.participantId === 'opus') return result(job);
      fs.writeFileSync(path.join(dir, 'cancel.request'), 'cancel');
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), { code: 'CANCELLED' })), { once: true });
      });
    },
  } });
  const cancelled = await pending;
  assert.equal(calls, 2); assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.jobs[0].status, 'complete'); assert.equal(cancelled.rounds.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'final.md')), false);
});

test('PID reuse and obsolete recovery guards do not block a restarted runner', (t) => {
  const { dir } = fixture(t);
  fs.mkdirSync(path.join(dir, '.runner-lock'));
  fs.writeFileSync(path.join(dir, '.runner-lock', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'old-generation', started: 'a different process start', boot: 1 }));
  fs.mkdirSync(path.join(dir, '.runner-recovery'));
  assert.equal(Runner.active(Runner.owner(dir), { dir }), false);
  const release = Runner.lock(dir);
  const lease = Runner.owner(dir);
  assert.equal(Runner.active(lease, { dir }), true);
  assert.equal(typeof lease.started, 'string');
  assert.equal(typeof lease.heartbeatAt, 'number');
  assert.throws(() => Runner.lock(dir), /仍在运行/);
  release();
});
test('a live lease without process evidence cannot be stolen', (t) => {
  const { dir } = fixture(t);
  const release = Runner.lock(dir);
  assert.equal(Runner.active(Runner.owner(dir), { dir, identity: () => null }), true);
  release();
});
test('whole-discussion deadline pauses a hung participant and retains completed drafts', async (t) => {
  const { run, store, dir } = fixture(t);
  const completed = await Runner.runDiscussion({ id: run.id, store, timeoutMs: 30,
    adapter: { execute: async (job) => job.participantId === 'opus' ? result(job) : new Promise(() => {}) } });
  assert.equal(completed.status, 'paused'); assert.equal(completed.pauseReason, 'DISCUSSION_TIMEOUT');
  assert.equal(completed.jobs[0].status, 'complete'); assert.equal(completed.jobs[1].status, 'unknown');
  assert.equal(fs.existsSync(path.join(dir, 'final.md')), false); assert.equal(Runner.owner(dir), null);
});
test('receipt ids stay valid even for the longest permitted custom discussion id', (t) => {
  const { run, dir } = fixture(t); run.id = 'x'.repeat(160);
  assert.match(Runner.receipt(run, dir).id, /^[A-Za-z0-9_-]{1,160}$/);
});

test('restart preserves affirmative unsent evidence and saved-foreground-answer diagnostics', async (t) => {
  const { run, dir } = fixture(t);
  for (const job of run.jobs) Core.markStarted(run, job.id);
  await Runner.recoverResults(run, { recover: async (job) => {
    throw Object.assign(new Error('stand-in recovery'), job.participantId === 'chatgpt'
      ? { code: 'LOCKED', mayHaveSent: false } : { code: 'FRONT_STOLEN', mayHaveSent: true, answerSaved: true });
  } }, dir);
  const web = run.jobs.find((j) => j.participantId === 'chatgpt');
  assert.equal(web.status, 'failed'); assert.equal(web.mayHaveSent, false);
  assert.equal(run.jobs[0].answerSaved, true); assert.equal(run.jobs[0].failure, 'FRONT_STOLEN');
  Core.resume(run);
  assert.equal(web.status, 'pending');
  assert.equal(run.jobs[0].status, 'unknown'); assert.equal(run.resumeBlocked.length, 1);
});
