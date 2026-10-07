'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../discussion-core');
const Privacy = require('../discussion-privacy');
const { createStore } = require('../discussion-store');

function create(overrides = {}) { return Core.createDiscussion({ question: '应该如何设计可靠的自动讨论流程？给出可验证的建议。', ...overrides }); }
function result(job, overrides = {}) {
  return { attemptId: job.attemptId, receiptId: `receipt-${job.attemptId}`, text: '推荐使用持久化轮次屏障。需要保留每位参与者的完整稿，失败时暂停。',
    actualModel: job.participant.model, actualTier: job.participant.tier,
    materialDisagreement: false, disagreements: [], minority: [], faithful: true,
    summary: '采用持久化屏障。保留完整稿。失败暂停。', ...overrides };
}
function finishPhase(run, overrides = {}) {
  const jobs = Core.nextJobs(run);
  for (const job of jobs) {
    Core.markStarted(run, job.id);
    assert.equal(Core.acceptResult(run, job.id, result(job, typeof overrides === 'function' ? overrides(job) : overrides)).accepted, true);
  }
  return jobs;
}
function tempStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createStore({ root });
}

test('two independent participants use identical packets, freeze all before review, then complete with minority/fidelity', (t) => {
  const store = tempStore(t);
  const run = create(); store.create(run);
  const [first, second] = Core.nextJobs(run);
  assert.equal(first.input, second.input);
  assert.doesNotMatch(first.input, /方案 A|方案 B/);
  Core.markStarted(run, first.id); Core.acceptResult(run, first.id, result(first));
  assert.equal(run.rounds.length, 0); assert.equal(run.phase, 'independent');
  Core.markStarted(run, second.id); Core.acceptResult(run, second.id, result(second));
  assert.equal(run.rounds.length, 1);
  const review = Core.nextJobs(run);
  assert.equal(review[0].input, review[1].input);
  assert.match(review[0].input, /方案 A/); assert.match(review[0].input, /方案 B/);
  assert.doesNotMatch(review[0].input, /claude-opus|ChatGPT|6 Pro/);
  finishPhase(run); assert.equal(run.phase, 'summary');
  finishPhase(run, { minority: ['若任务极小，单模型更节省额度。'] });
  store.save(run);
  assert.equal(run.status, 'complete'); assert.equal(run.faithful, true); assert.equal(run.rounds.length, 2);
  assert.equal(fs.readFileSync(path.join(store.dir(run.id), 'final.md'), 'utf8'), run.finalAnswer);
  const meta = JSON.parse(fs.readFileSync(path.join(store.dir(run.id), 'final-meta.json')));
  assert.deepEqual(meta.minority, ['若任务极小，单模型更节省额度。']);
  assert.equal(meta.actualModels.length, 5);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(store.dir(run.id), 'run.json')).mode & 0o777, 0o600);
});

test('concrete disagreement causes only one additional full round; wording differences do not', () => {
  const run = create(); finishPhase(run);
  finishPhase(run, (j) => j.participantId === 'opus' ? { materialDisagreement: true, disagreements: ['尚未核实账户是否支持后台排队，影响可靠性。'] } : {});
  assert.equal(run.phase, 'followup'); assert.equal(run.round, 3);
  const input = Core.nextJobs(run)[0].input;
  assert.match(input, /第一轮完整稿/); assert.match(input, /第二轮完整稿/); assert.match(input, /影响可靠性/);
  finishPhase(run, { materialDisagreement: true, disagreements: ['仍需核实账户条件。'] });
  assert.equal(run.phase, 'summary'); finishPhase(run);
  assert.equal(run.rounds.length, 3);
  const small = create(); finishPhase(small); finishPhase(small, { materialDisagreement: true });
  assert.equal(small.phase, 'summary');
});

test('a slow webpage is never discarded and timeout/unknown cannot silently resend', () => {
  const run = create();
  const jobs = Core.nextJobs(run); jobs.forEach((j) => Core.markStarted(run, j.id));
  Core.acceptResult(run, jobs[0].id, result(jobs[0]));
  Core.failJob(run, jobs[1].id, { reason: 'Web request timed out after 30 minutes.', uncertain: true });
  assert.equal(run.status, 'paused'); assert.equal(run.rounds.length, 0);
  assert.deepEqual(Core.nextJobs(run), []);
  Core.resume(run);
  assert.equal(run.status, 'paused');
  assert.throws(() => Core.resume(run, { retryIds: [jobs[1].id] }), /explicit confirmation/);
  const originalAttempt = jobs[1].attemptId;
  Core.resume(run, { retryIds: [jobs[1].id], confirmedNotSent: [jobs[1].id] });
  assert.equal(run.status, 'running'); assert.notEqual(jobs[1].attemptId, originalAttempt);
  assert.equal(Core.acceptResult(run, jobs[1].id, { ...result(jobs[1]), attemptId: originalAttempt }).stale, true);
  assert.equal(Core.nextJobs(run).length, 1);
});

test('duplicate and stale receipts cannot mutate frozen content', () => {
  const run = create(); const first = Core.nextJobs(run)[0]; Core.markStarted(run, first.id);
  const receipt = result(first); Core.acceptResult(run, first.id, receipt);
  assert.equal(Core.acceptResult(run, first.id, { ...receipt, text: 'A different later answer that must not replace the original.' }).duplicate, true);
  finishPhase(run);
  const frozen = JSON.stringify(run.rounds);
  assert.equal(Core.acceptResult(run, first.id, receipt).duplicate, true);
  assert.equal(JSON.stringify(run.rounds), frozen);
});

test('restart keeps completed drafts and makes all unfinished sends unknown', (t) => {
  const store = tempStore(t); let run = create(); store.create(run);
  const jobs = Core.nextJobs(run); jobs.forEach((j) => Core.markStarted(run, j.id));
  Core.acceptResult(run, jobs[0].id, result(jobs[0])); store.save(run);
  run = Core.recover(store.load(run.id)); store.save(run);
  assert.equal(run.status, 'paused'); assert.equal(run.jobs[0].status, 'complete'); assert.equal(run.jobs[1].status, 'unknown');
  assert.deepEqual(Core.nextJobs(run), []);
  const late = run.jobs[1]; assert.equal(Core.acceptResult(run, late.id, result(late)).accepted, true);
  assert.equal(run.phase, 'review'); assert.equal(run.status, 'running');
  assert.equal(run.jobs.filter((j) => j.phase === 'independent').length, 2);
  store.save(run);
  assert.equal(Core.nextJobs(store.load(run.id)).length, 2);
});

test('every round redacts newly generated private data and all participants read the same facts', (t) => {
  const store = tempStore(t);
  const run = create({ question: '用户 alice 邮箱 alice@example.com 在 /Users/alice/work 使用 10.2.3.4 与 internal.example.com；session_id=private-77；预算100元。', privacy: { usernames: ['alice'] } });
  store.create(run);
  const input = Core.nextJobs(run)[0].input;
  assert.doesNotMatch(input, /alice|example\.com|10\.2\.3\.4|private-77/); assert.match(input, /100元/);
  finishPhase(run, { text: '推荐进行可靠的队列处理。新增路径 C:\\Users\\alice\\secret 与 bob@corp.org\nAuthorization: Bearer secret\n模型签名：我是 Claude。' });
  const packet = Core.nextJobs(run)[0].input;
  assert.doesNotMatch(packet, /alice|bob@|Bearer secret|我是 Claude/);
  assert.equal(packet, Core.nextJobs(run)[1].input);
  store.save(run);
  const first = run.jobs[0];
  const raw = fs.readFileSync(path.join(store.dir(run.id), 'round-01', 'output', `${first.id}-${first.attemptId}.md`), 'utf8');
  assert.match(raw, /bob@corp.org/);
});

test('redaction removes credential forms, keys, IPs, domains, sessions and stable aliases', () => {
  const labelled = Privacy.redact('用户名: captain_alice，预算200元。 "username":"other_bob"; 工期两天。').text;
  assert.doesNotMatch(labelled, /captain_alice|other_bob/);
  assert.match(labelled, /预算200元/);
  assert.match(labelled, /工期两天/);
  const mapping = {};
  const secret = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  const first = Privacy.redact(`mail a@b.org again a@b.org\n${secret}\nsk-abcdefghijklmnop\nhttps://foo.dev/x?token=hidden\neyJabc.def.ghi\nTOKEN=supersecret\n{\"password\":\"supersecret\"}\n192.168.1.1\n2001:db8::1\n::1\nsession_id=abc`, { mapping });
  assert.doesNotMatch(first.text, /secret|abcdefghijkl|hidden|eyJabc|192\.168|2001:db8|::1|session_id=abc|a@b\.org/);
  assert.equal(Privacy.redact('a@b.org', { mapping }).text, '[邮箱-1]');
});

test('wrong model or tier pauses without generating a final; no paid or weaker fallback', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  assert.equal(Core.acceptResult(run, job.id, result(job, { actualModel: 'claude-sonnet-4' })).invalid, true);
  assert.equal(run.status, 'paused'); assert.equal(run.apiFallback, false);
  assert.equal(run.rounds.length, 0);
  assert.throws(() => create({ participants: [{ id: 'one', provider: 'api', model: 'opus' }, { id: 'two', provider: 'chatgpt-web', model: '6 Pro' }] }), /Only subscription/);
  const webRun = create(); const web = Core.nextJobs(webRun)[1]; Core.markStarted(webRun, web.id);
  assert.equal(Core.acceptResult(webRun, web.id, result(web, { actualTier: 'High' })).invalid, true);
  assert.throws(() => Core.resume(webRun), /Webpage retry needs confirmation/);
});

test('quota pauses and missing final fidelity check is never complete', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  Core.failJob(run, job.id, { reason: 'Subscription quota exhausted.', quota: true });
  assert.equal(run.pauseReason, 'quota'); assert.deepEqual(Core.nextJobs(run), []);
  Core.resume(run); finishPhase(run); finishPhase(run);
  const final = Core.nextJobs(run)[0]; Core.markStarted(run, final.id);
  assert.equal(Core.acceptResult(run, final.id, result(final, { faithful: false })).invalid, true);
  assert.equal(run.status, 'paused'); assert.equal(run.finalAnswer, undefined);
});

test('cancel prevents queued sends and ignores late answers', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id); Core.cancel(run);
  assert.deepEqual(Core.nextJobs(run), []);
  assert.equal(Core.acceptResult(run, job.id, result(job)).stale, true);
  assert.throws(() => Core.resume(run), /cannot resume/);
  assert.equal(run.status, 'cancelled');
  const updatedAt = run.updatedAt, events = run.events.length;
  Core.cancel(run);
  assert.equal(run.updatedAt, updatedAt); assert.equal(run.events.length, events);
});

test('machine metadata is parsed while retaining exact original draft and invalid metadata pauses', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  const raw = '这是完整的独立答案。应通过轮次屏障保证每个人获得同样的事实材料。\n<discussion-meta>{"disagreements":[],"minority":[]}</discussion-meta>';
  assert.equal(Core.acceptResult(run, job.id, result(job, { text: raw })).accepted, true);
  assert.equal(job.rawOutput, raw); assert.doesNotMatch(job.output, /discussion-meta/);
  const second = Core.nextJobs(run)[0]; Core.markStarted(run, second.id);
  assert.equal(Core.acceptResult(run, second.id, result(second, { text: '这是完整答案，包含无法读取的元数据。\n<discussion-meta>{invalid}</discussion-meta>' })).invalid, true);
});
test('metadata wrapped in markdown fences is still accepted without changing the archived original', () => {
  const body = '这是完整的互评与修订稿。应保留匿名材料、有效的反驳和实施条件。';
  for (const packet of [
    '```xml\n<discussion-meta>{"materialDisagreement":false}</discussion-meta>\n```',
    '<discussion-meta>\n```json\n{"materialDisagreement":false}\n```\n</discussion-meta>',
  ]) {
    const parsed = Core.readResult({ text: body + '\n' + packet });
    assert.equal(parsed.materialDisagreement, false);
    assert.equal(parsed.text, body);
  }
});

test('invalid IDs, corrupt state, and attempts to change immutable snapshots are refused', (t) => {
  const store = tempStore(t); const run = create(); store.create(run);
  assert.throws(() => store.load('../escape'), /Invalid discussion id/);
  const original = fs.readFileSync(path.join(store.dir(run.id), 'question.md'), 'utf8');
  run.question = 'a changed question'; assert.throws(() => store.save(run), /cannot be overwritten/);
  assert.equal(fs.readFileSync(path.join(store.dir(run.id), 'question.md'), 'utf8'), original);
  fs.writeFileSync(path.join(store.dir(run.id), 'run.json'), '{broken');
  assert.throws(() => store.load(run.id));
  assert.equal(fs.readFileSync(path.join(store.dir(run.id), 'run.json'), 'utf8'), '{broken');
});


test('multiple invalid imports keep separate immutable rejected drafts for the same attempt', (t) => {
  const store = tempStore(t); const run = create(); store.create(run);
  const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  Core.acceptResult(run, job.id, result(job, { actualModel: 'wrong-model', text: '第一份原稿没有通过模型核验，原稿应保留用于本地排查。' }));
  store.save(run);
  Core.acceptResult(run, job.id, result(job, { actualModel: 'wrong-model', text: '第二份人工恢复原稿仍然没通过核验，两份原稿应分别保留。' }));
  store.save(run);
  assert.equal(fs.readdirSync(path.join(store.dir(run.id), 'round-01', 'rejected')).length, 2);
});


test('a claimed faithful final cannot silently discard recorded minority opinions', () => {
  const run = create(); finishPhase(run);
  finishPhase(run, { minority: ['若数据无需共享，简单串行流程可能更可靠。'] });
  const final = Core.nextJobs(run)[0]; Core.markStarted(run, final.id);
  const accepted = Core.acceptResult(run, final.id, result(final, { faithful: true, minority: [] }));
  assert.equal(accepted.invalid, true); assert.match(accepted.reason, /minority/);
  assert.equal(run.status, 'paused');
  assert.deepEqual(run.minority, ['若数据无需共享，简单串行流程可能更可靠。']);
  Core.resume(run); finishPhase(run, { minority: run.minority });
  assert.equal(run.status, 'complete');
});
test('minority metadata is supplied to later participants and the final summarizer even when absent from prose', () => {
  const run = create();
  finishPhase(run, { minority: ['高影响的变更应分阶段实施，先控制影响范围。'] });
  assert.match(Core.nextJobs(run)[0].input, /高影响的变更应分阶段实施/);
  finishPhase(run);
  assert.match(Core.nextJobs(run)[0].input, /高影响的变更应分阶段实施/);
});
