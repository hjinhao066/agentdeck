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
    actualModel: job.participant.model, actualTier: job.participant.tier, actualEffort: job.participant.effort,
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
  assert.notEqual(review[0].input, review[1].input);
  assert.notDeepEqual(review[0].snapshotOrders, review[1].snapshotOrders);
  for (const job of review) for (const entry of run.rounds[0].entries) assert.ok(job.input.includes(entry.text));
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
  Core.resume(run, { retryIds: [jobs[1].id] });
  assert.equal(run.resumeBlocked[0].jobId, jobs[1].id);
  assert.match(run.resumeBlocked[0].reason, /explicitly confirm/);
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
  finishPhase(run, { text: '推荐进行可靠的队列处理。新增路径 C:\\Users\\alice\\secret 与 bob@corp.org\n模型签名：我是 Claude。' });
  const packet = Core.nextJobs(run)[0].input;
  assert.doesNotMatch(packet, /alice|bob@|我是 Claude/);
  for (const job of Core.nextJobs(run)) for (const entry of run.rounds[0].entries) assert.ok(job.input.includes(entry.text));
  store.save(run);
  const first = run.jobs[0];
  const raw = fs.readFileSync(path.join(store.dir(run.id), 'round-01', 'output', `${first.id}-${first.attemptId}.md`), 'utf8');
  assert.match(raw, /bob@corp.org/);
});

test('credential redaction preserves stable private aliases and reports an outbound hard block', () => {
  const mapping = {};
  const secret = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  const first = Privacy.redact(`mail a@b.org again a@b.org\n${secret}\nsk-abcdefghijklmnop\n192.168.1.1\n2001:db8::1\n::1\nsession_id=abc`, { mapping });
  assert.equal(first.blocked, true);
  assert.doesNotMatch(first.text, /secret|abcdefghijkl|192\.168|2001:db8|::1|session_id=abc|a@b\.org/);
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
  Core.resume(webRun);
  assert.equal(webRun.jobs[1].status, 'failed');
  assert.equal(webRun.resumeBlocked[0].jobId, web.id);
});

test('quota pauses and missing final fidelity check is never complete', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  Core.failJob(run, job.id, { reason: 'Subscription quota exhausted.', quota: true });
  assert.equal(run.pauseReason, 'quota'); assert.deepEqual(Core.nextJobs(run), []);
  Core.resume(run); finishPhase(run); finishPhase(run);
  const final = Core.nextJobs(run)[0]; Core.markStarted(run, final.id);
  assert.equal(Core.acceptResult(run, final.id, result(final, { faithful: false })).metadataNeeded, true);
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

test('machine metadata is parsed while retaining the exact draft; a bad review is held for metadata', () => {
  const run = create(); const job = Core.nextJobs(run)[0]; Core.markStarted(run, job.id);
  const raw = '这是完整的独立答案。应通过轮次屏障保证每个人获得同样的事实材料。\n<discussion-meta>{"disagreements":[],"minority":[]}</discussion-meta>';
  assert.equal(Core.acceptResult(run, job.id, result(job, { text: raw })).accepted, true);
  assert.equal(job.rawOutput, raw); assert.doesNotMatch(job.output, /discussion-meta/);
  finishPhase(run);
  const review = Core.nextJobs(run)[0]; Core.markStarted(run, review.id);
  const delivered = { text: '这是一份完整的互评修订答案。应保留完整证据、核查前提，并确保每位成员读到同样的材料。\n<discussion-meta>{invalid}</discussion-meta>', actualModel: review.participant.model, actualTier: review.participant.tier, actualEffort: review.participant.effort };
  assert.equal(Core.acceptResult(run, review.id, delivered).metadataNeeded, true);
  assert.equal(review.status, 'metadata-needed'); assert.equal(review.awaitingMetadata.rawText, delivered.text);
  assert.equal(review.attempt, 1); assert.equal(review.rejectedOutput, undefined);
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
  assert.equal(accepted.metadataNeeded, true); assert.match(accepted.reason, /minority/);
  assert.equal(run.status, 'paused');
  assert.deepEqual(run.minority, ['若数据无需共享，简单串行流程可能更可靠。']);
  const attempt = final.attemptId;
  Core.resume(run);
  assert.equal(final.attemptId, attempt); assert.equal(final.status, 'metadata-needed');
  assert.equal(Core.supplyMetadata(run, final.id, { faithful: true, summary: '保留少数派。分阶段实施。按条件取舍。', minority: run.minority }).accepted, true);
  assert.equal(run.status, 'complete');
});
test('minority metadata is supplied to later participants and the final summarizer even when absent from prose', () => {
  const run = create();
  finishPhase(run, { minority: ['高影响的变更应分阶段实施，先控制影响范围。'] });
  assert.match(Core.nextJobs(run)[0].input, /高影响的变更应分阶段实施/);
  finishPhase(run);
  assert.match(Core.nextJobs(run)[0].input, /高影响的变更应分阶段实施/);
});


test('web-export escaping, inline code, JSON key escapes, and trailing prose retain valid metadata', () => {
  const body = '这是完整的互评与修订答案。保留正确的建议，回应具体反驳并说明实施条件。';
  const meta = '{"materialDisagreement":false,"disagreements":[],"minority":[]}';
  const variants = [
    `<discussion-meta>${meta}</discussion-meta>`,
    `\\<discussion-meta\\>${meta}\\</discussion-meta\\>`,
    `\\<discussion-meta\\>${meta}\\<\\/discussion-meta\\>`,
    `\`<discussion-meta>${meta}</discussion-meta>\``,
    `&lt;discussion-meta&gt;${meta}&lt;/discussion-meta&gt;`,
    '<discussion-meta>{"material\\_Disagreement":false,"disagreements":[],"minority":[]}</discussion-meta>',
    '<discussion-meta>{"material_disagreement":false,"disagreements":[],"minority":[]}</discussion-meta>',
    '```xml\n<discussion-meta>' + meta + '</discussion-meta>\n```',
  ];
  for (const packet of variants) {
    const parsed = Core.readResult({ text: body + '\n' + packet + '\n补充说明：需要核查证据。' });
    assert.equal(parsed.materialDisagreement, false, packet);
    assert.match(parsed.text, /完整的互评/); assert.match(parsed.text, /补充说明/);
    assert.doesNotMatch(parsed.text, /discussion-meta|materialDisagreement|```/);
  }
});

test('missing metadata survives restart and is completed manually without a new attempt or model request', (t) => {
  const store = tempStore(t); let run = create(); finishPhase(run);
  const jobs = Core.nextJobs(run); jobs.forEach((job) => Core.markStarted(run, job.id));
  const first = jobs[0], body = '这是一份完整互评修订稿。先保留可靠的轮次屏障，再补充失败恢复的条件。';
  assert.equal(Core.acceptResult(run, first.id, { text: body, actualModel: first.participant.model, actualEffort: first.participant.effort }).metadataNeeded, true);
  Core.acceptResult(run, jobs[1].id, result(jobs[1])); store.create(run);
  run = Core.recover(store.load(run.id));
  const saved = run.jobs.find((job) => job.id === first.id), attempt = saved.attemptId;
  Core.resume(run);
  assert.equal(run.status, 'paused'); assert.equal(run.resumeBlocked[0].status, 'metadata-needed');
  assert.equal(Core.nextJobs(run).length, 0); assert.equal(saved.attemptId, attempt);
  assert.equal(Core.supplyMetadata(run, saved.id, { material_disagreement: false, disagreements: [], minority: [] }).accepted, true);
  assert.equal(saved.attemptId, attempt); assert.equal(saved.rawOutput, body); assert.equal(run.phase, 'summary');
  store.save(run);
  assert.equal(store.load(run.id).jobs.find((job) => job.id === first.id).rawOutput, body);
});

test('safe failed jobs resume while a possibly sent webpage stays visibly blocked', () => {
  const run = create(); const [cli, web] = Core.nextJobs(run);
  Core.markStarted(run, cli.id); Core.markStarted(run, web.id);
  Core.failJob(run, cli.id, { reason: 'QUOTA', quota: true, uncertain: false, mayHaveSent: false });
  Core.failJob(run, web.id, { reason: 'TIMEOUT', uncertain: true, mayHaveSent: true });
  const webAttempt = web.attemptId; Core.resume(run);
  assert.equal(run.status, 'running'); assert.deepEqual(run.resumedJobs, [cli.id]);
  assert.equal(web.attemptId, webAttempt); assert.equal(web.status, 'unknown');
  assert.deepEqual(Core.nextJobs(run).map((job) => job.id), [cli.id]);
  assert.equal(run.resumeBlocked[0].mayHaveSent, true); assert.match(run.resumeBlocked[0].reason, /previous request/);
  Core.markStarted(run, cli.id); Core.acceptResult(run, cli.id, result(cli));
  assert.equal(run.status, 'paused'); assert.equal(run.rounds.length, 0);
});

test('webpage failure proven unsent retries without confirmation, with submission evidence kept', () => {
  const run = create(); const [cli, web] = Core.nextJobs(run);
  Core.markStarted(run, cli.id); Core.acceptResult(run, cli.id, result(cli)); Core.markStarted(run, web.id);
  Core.failJob(run, web.id, { reason: 'LOGIN_REQUIRED', uncertain: false, mayHaveSent: false });
  assert.equal(web.mayHaveSent, false);
  const attempt = web.attemptId; Core.resume(run);
  assert.equal(run.status, 'running'); assert.notEqual(web.attemptId, attempt);
  assert.equal(web.attempts[0].mayHaveSent, false); assert.deepEqual(run.resumeBlocked, []);
  Core.markStarted(run, web.id); Core.acceptResult(run, web.id, result(web));
  assert.equal(run.phase, 'review');
});

test('each reviewer gets a durable distinct order of the same frozen full drafts and anonymous metadata', (t) => {
  const store = tempStore(t);
  const run = create({ participants: [...Core.DEFAULT_PARTICIPANTS, Core.GEMINI_PARTICIPANT] });
  finishPhase(run, { text: 'ChatGPT 认为采用可靠的屏障方案。By Claude：需要保留完整证据。Anthropic/OpenAI 不能替代事实核验。',
    disagreements: ['ChatGPT 认为队列边界还需要核实。'], minority: ['By Claude：极小任务可以只用一位参与者。'] });
  const jobs = Core.nextJobs(run);
  assert.equal(new Set(jobs.map((job) => job.snapshotOrders[1].join(','))).size, 3);
  const authors = run.rounds[0].entries.map((entry) => entry.author).sort();
  for (const job of jobs) {
    assert.deepEqual([...job.snapshotOrders[1]].sort(), authors);
    for (const entry of run.rounds[0].entries) assert.ok(job.input.includes(entry.text));
    assert.doesNotMatch(job.input, /Claude|ChatGPT/);
    assert.match(job.input, /Anthropic\/OpenAI 不能替代事实核验/, 'objective company mentions retain their meaning');
  }
  store.create(run); const loaded = store.load(run.id);
  assert.deepEqual(Core.nextJobs(loaded).map((job) => job.inputHash), jobs.map((job) => job.inputHash));
});

test('summary fidelity is recorded as model self-report rather than external verification', () => {
  const run = create(); finishPhase(run); finishPhase(run); finishPhase(run);
  assert.deepEqual(run.faithfulness, { modelReported: true, externallyVerified: false, source: 'summarizer-self-report' });
});

test('credentials in the original question or a new draft hard-pause before any following outbound job', (t) => {
  const blocked = create({ question: '应该采用什么架构？真实凭据 sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 不应发出。' });
  assert.equal(blocked.status, 'paused'); assert.equal(blocked.pauseReason, 'privacy-blocked');
  assert.equal(blocked.jobs.length, 0); assert.match(blocked.question, /sk-proj/);
  Core.resume(blocked); assert.equal(blocked.resumeBlocked[0].status, 'privacy-blocked');
  const store = tempStore(t), run = create();
  finishPhase(run, { text: '这是完整回答，建议使用持久化轮次屏障。凭据 sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 必须留在本地。' });
  assert.equal(run.status, 'paused'); assert.equal(run.pauseReason, 'privacy-blocked');
  assert.equal(run.rounds.length, 0); assert.equal(Core.nextJobs(run).length, 0); assert.equal(run.jobs.length, 2);
  store.create(run); assert.match(store.load(run.id).jobs[0].rawOutput, /sk-proj/);
});

test('credential-bearing protocol metadata cannot bypass the hard gate after being stripped from prose', () => {
  const run = create();
  finishPhase(run, { text: '这是完整的建议与依据。应采用可靠的屏障方案以确保完整性。',
    disagreements: ['需要保护 sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'], minority: [] });
  assert.equal(run.pauseReason, 'privacy-blocked'); assert.equal(run.jobs.length, 2); assert.equal(run.rounds.length, 0);
});

test('manual or automatic draft evidence cannot omit or weaken the requested effort', () => {
  for (const effort of [undefined, 'medium']) {
    const run = create(), job = run.jobs[0]; Core.markStarted(run, job.id);
    const accepted = Core.acceptResult(run, job.id, result(job, { actualEffort: effort, verificationSource: 'manual-import' }));
    assert.equal(accepted.invalid, true); assert.match(accepted.reason, /effort/);
    assert.equal(job.status, 'failed'); assert.equal(run.rounds.length, 0);
  }
});
