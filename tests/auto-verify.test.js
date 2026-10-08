'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../task-board');
const { TaskHeartbeat } = require('../task-heartbeat');
const AV = require('../auto-verify-core');

function fixture(t, sessions = () => []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-autoverify-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tasks');
  const store = new TaskStore(dir, { sessions });
  const add = (extra = {}) => store.add({ project: 'p', title: 'Card', detail: 'Do the thing.', verify: true, ...extra }).card;
  const bind = (id, attempt, session, agent = 'Claude', model = 'claude-sonnet-5-5') => store.bind({ id, attempt_id: attempt, session_id: session, assignee: { agent, model } });
  const event = (id, type, message, attempt, session, source = 'command', files) => store.event({ id, type, message, attempt_id: attempt, session_id: session, source, files });
  const get = (id) => store.list({ archived: true }).find((c) => c.id === id);
  // An execution that has just handed in its receipt: the card is in review, round `n`.
  const executed = (id, attempt = 'a1', session = 'worker', agent = 'Claude', model = 'claude-sonnet-5-5') => {
    bind(id, attempt, session, agent, model);
    return event(id, 'complete', '做完了。 完整回执第二句。', attempt, session, 'command', ['/tmp/a.js', '/tmp/b.png']).card;
  };
  const reviewer = (id, round) => AV.reviewAttemptId(id, round);
  return { root, dir, store, add, bind, event, get, executed, reviewer };
}

// ---- who may review ----
test('the reviewer is never from the executor\'s own provider/model family, and the table order decides among the rest', () => {
  const commandOf = (c) => c.command || c.agent;
  const cases = [
    [{ agent: 'Claude', model: 'claude-sonnet-5-5' }, 'gemini-flash'],
    [{ agent: 'Claude', model: 'default' }, 'gemini-flash'],
    [{ agent: 'Antigravity', model: 'gemini-3.8-flash-high' }, 'codex-sol'],
    [{ agent: 'Antigravity', model: 'default' }, 'codex-sol'],
    [{ agent: 'Codex', model: 'gpt-6.1-sol' }, 'gemini-flash'],
    [{ agent: 'Cursor', model: 'grok-4.7-high-fast' }, 'gemini-flash'],
    // Cursor and agy run other makers' models: the model name decides, not the harness.
    [{ agent: 'Cursor', model: 'claude-opus-5-5-high' }, 'gemini-flash'],
    [{ agent: 'Antigravity', model: 'claude-opus-4-6-thinking' }, 'gemini-flash'],
    [{ agent: 'Antigravity', model: 'gpt-oss-120b-medium' }, 'gemini-flash'],
  ];
  for (const [executor, expected] of cases) {
    const picked = AV.pickReviewer({ executor, commandOf });
    assert.equal(picked.candidate.id, expected, JSON.stringify(executor));
    assert.notEqual(picked.family, AV.familyOf(executor));
    assert.equal(picked.executorFamily, AV.familyOf(executor));
  }
});
test('exhausted providers are skipped; with nothing left there is no reviewer and the reasons say why', () => {
  const commandOf = (c) => c.command || c.agent;
  const out = new Set();
  const quotaOut = (cmd) => out.has(cmd);
  out.add('agy');
  assert.equal(AV.pickReviewer({ executor: { agent: 'Claude', model: 'claude-opus-5-5' }, commandOf, quotaOut }).candidate.id, 'codex-sol');
  out.add('codex');
  const none = AV.pickReviewer({ executor: { agent: 'Claude', model: 'claude-opus-5-5' }, commandOf, quotaOut });
  assert.equal(none.candidate, undefined); assert.equal(none.cmd, undefined);
  assert.match(none.reason, /Gemini 3\.8 Flash（Antigravity）：额度用尽/); assert.match(none.reason, /Codex GPT-6\.1 Sol：额度用尽/);
  assert.match(none.reason, /Claude Opus 5\.5：与执行会话同属 Anthropic/); assert.match(none.reason, /Opus 4\.6 Thinking（Antigravity）：与执行会话同属 Anthropic/);
  // Codex executor with Gemini out falls to Opus; with Opus out too, nobody is left.
  out.clear(); out.add('agy');
  assert.equal(AV.pickReviewer({ executor: { agent: 'Codex', model: 'default' }, commandOf, quotaOut }).candidate.id, 'claude-opus');
  out.add(AV.CANDIDATES.find((c) => c.id === 'claude-opus').command);
  assert.equal(AV.pickReviewer({ executor: { agent: 'Codex', model: 'default' }, commandOf, quotaOut }).candidate.id, 'agy-opus-46');
  out.add(AV.CANDIDATES.find((c) => c.id === 'agy-opus-46').command);
  assert.match(AV.pickReviewer({ executor: { agent: 'Codex', model: 'default' }, commandOf, quotaOut }).reason, /^没有可用的审查者/);
});
test('an executor whose model cannot be identified gets no reviewer instead of a guess', () => {
  for (const executor of [null, undefined, {}, { agent: 'Custom agent', model: 'default' }, { agent: 'Shell', model: 'default' }, { agent: 'Cursor', model: 'default' }]) {
    const picked = AV.pickReviewer({ executor, commandOf: (c) => c.agent || c.command });
    assert.equal(picked.cmd, undefined); assert.match(picked.reason, /看不出执行会话/);
  }
  // Even if every candidate were the same family as the executor, none is returned.
  const same = AV.pickReviewer({ executor: { agent: 'Claude', model: 'x' }, candidates: [{ id: 'c', label: 'C', family: 'anthropic', agent: 'claude' }], commandOf: (c) => c.agent });
  assert.equal(same.cmd, undefined);
});
test('verdicts: only a leading 通过/不通过 counts; anything else is unclear and never a pass', () => {
  for (const text of ['通过：文件都在，测试跑过', '  **通过** 全部核对', '【通过】ok', '验收通过。', '通过', 'PASS: all good']) assert.equal(AV.verdict(text), 'pass', text);
  for (const text of ['不通过：缺文件', '未通过：测试失败', '「不通过」1) x', '验收不通过', '**不通过**', 'FAIL: x']) assert.equal(AV.verdict(text), 'fail', text);
  for (const text of ['', '看起来不错', '通过运行测试发现有问题', '已核对，基本没问题', '结论：通过', 'Not bad, passes']) assert.equal(AV.verdict(text), 'unclear', text);
});
test('the review task carries the card, the full receipt, its files, the reviewed session and the fixed checklist', () => {
  const card = { id: 't-1', project: '项目', title: '修好登录', detail: '详细说明', latest_receipt: '只有第一句。' };
  const receipt = { text: '第一句。第二句很重要。\n第三行', files: ['/Users/x/a.js', '/Users/x/shot.png'], session_id: 'c-board-exec', assignee: { agent: 'Codex', model: 'gpt-6.1-sol' } };
  const text = AV.reviewPrompt({ card, receipt });
  for (const part of ['t-1', '项目', '修好登录', '详细说明', '第二句很重要。\n第三行', '/Users/x/a.js', '/Users/x/shot.png', 'c-board-exec', 'Codex / gpt-6.1-sol',
    '确认真的存在', '已经推送', '只跑和这次改动相关', '不跑全量 E2E', '截图', '删除测试用例', '放宽断言', '只审不改', '通过', '不通过', 'complete --result "不通过" --failed']) assert.ok(text.includes(part), part);
  // the CLI refuses `complete` without --result, so the reject command it is taught must carry one
  assert.doesNotMatch(text, /complete --failed/);
  assert.ok(!text.includes('只有第一句。'));
  assert.match(AV.reviewPrompt({ card, receipt: { text: 'x', files: [] } }), /（回执没有列出文件）/);
});
test('the rework message passes the reviewer\'s words through unchanged', () => {
  const findings = '不通过：1) tests/a.test.js 第 3 行断言被删\n2) 提交 abc123 没推送  \n（保留空格与换行）';
  const text = AV.reworkMessage({ card: { id: 't-1', title: 'X' }, findings });
  assert.ok(text.endsWith(findings)); assert.match(text, /t-1/);
});
test('attempt ids are fixed per card and round', () => {
  assert.equal(AV.reviewAttemptId('t-1', 2), 'auto-review-t-1-r2'); assert.equal(AV.reviewAttemptId('t-1', 2), AV.reviewAttemptId('t-1', 2));
  assert.notEqual(AV.reviewAttemptId('t-1', 2), AV.reviewAttemptId('t-1', 3));
  assert.ok(AV.isReviewAttempt('auto-review-t-1-r2')); assert.ok(!AV.isReviewAttempt('review1')); assert.ok(!AV.isReviewAttempt(undefined));
});

// ---- the store: rounds, claims, verdicts ----
test('a verify card enters review with a round, the full receipt and who executed it; a plain card gets none of this', (t) => {
  const { store, add, bind, event, get, executed } = fixture(t);
  const card = add();
  const done = executed(card.id, 'a1', 'worker', 'Codex', 'gpt-6.1-sol');
  assert.equal(done.status, 'review'); assert.equal(done.review_round, 1);
  assert.deepEqual(done.exec_receipt, { text: '做完了。 完整回执第二句。', files: ['/tmp/a.js', '/tmp/b.png'], session_id: 'worker', attempt_id: 'a1', assignee: { agent: 'Codex', model: 'gpt-6.1-sol' } });
  assert.equal(done.latest_receipt, '做完了。');
  // Binding the reviewer replaces session_id/assignee; the executor is still recorded.
  bind(card.id, AV.reviewAttemptId(card.id, 1), 'rev', 'Antigravity', 'gemini-3.8-flash-high');
  assert.equal(get(card.id).session_id, 'rev'); assert.equal(get(card.id).exec_receipt.session_id, 'worker'); assert.equal(get(card.id).exec_receipt.assignee.agent, 'Codex');
  const plain = add({ verify: false }); bind(plain.id, 'p1', 'w2'); const finished = event(plain.id, 'complete', 'done', 'p1', 'w2').card;
  assert.equal(finished.status, 'done'); for (const key of ['review_round', 'exec_receipt', 'review_claim', 'review_block', 'review_reject']) assert.ok(!(key in finished), key);
  assert.equal(store.reviewDue(finished), false);
});
test('exactly one claim per round, even when asked many times, from another store instance, or after a restart', (t) => {
  const { dir, store, add, get, executed } = fixture(t);
  const card = add(); executed(card.id);
  assert.equal(store.reviewDue(get(card.id)), true);
  const first = store.claimReview({ id: card.id });
  assert.equal(first.card.review_claim.round, 1); assert.equal(first.card.review_claim.delivered, false);
  for (let i = 0; i < 5; i++) assert.equal(store.claimReview({ id: card.id }).ignored, true);
  const restarted = new TaskStore(dir);   // AgentDeck restarted
  assert.equal(restarted.reviewDue(get(card.id)), false);
  assert.equal(restarted.claimReview({ id: card.id }).ignored, true);
  assert.equal(restarted.reviewPending(get(card.id)), true, 'the unfinished claim is picked up again, not remade');
  assert.equal(get(card.id).review_claim.key, first.card.review_claim.key);
  restarted.reviewDispatched({ id: card.id, key: first.card.review_claim.key });
  assert.equal(restarted.reviewPending(get(card.id)), false); assert.equal(restarted.claimReview({ id: card.id }).ignored, true);
  // a stale key cannot mark anything
  assert.equal(store.reviewDispatched({ id: card.id, key: 'old' }).card.review_claim.delivered, true);
});
test('no claim when the Captain already has a reviewer bound or a live session on the card; legacy and plain review cards are left alone', (t) => {
  const live = [];
  const { store, add, bind, get, executed } = fixture(t, () => live);
  const manual = add(); executed(manual.id, 'm1', 'w1');
  bind(manual.id, 'captain-review', 'captain-reviewer', 'Codex', 'gpt-6.1-sol');   // Captain's own new --task-id
  assert.equal(get(manual.id).review_session, true);
  assert.equal(store.reviewDue(get(manual.id)), false); assert.equal(store.claimReview({ id: manual.id }).ignored, true);
  // A session working on the card that has not bound yet (just opened by the Captain) also blocks the claim.
  const racing = add(); executed(racing.id, 'r1', 'w2');
  live.push({ id: 'c-captain-reviewer', boardId: racing.id, active: true });
  assert.equal(store.claimReview({ id: racing.id }).ignored, true);
  live.length = 0;
  assert.equal(store.claimReview({ id: racing.id }).ignored, undefined);
  // Cards that reached review without the execution's own receipt (moved by hand, or from before this feature) are never claimed.
  const moved = add(); store.move({ id: moved.id, status: 'review' });
  assert.equal(store.reviewDue(get(moved.id)), false); assert.equal(store.claimReview({ id: moved.id }).ignored, true);
  const legacy = add(); store.mutate((docs) => { const c = store.find(docs, legacy.id); c.status = 'review'; c.session_id = 'old'; return {}; });
  assert.equal(store.reviewDue(get(legacy.id)), false);
  // archived / done / held cards are not due either
  const done = add(); executed(done.id, 'd1', 'w3'); store.move({ id: done.id, status: 'done' });
  assert.equal(store.claimReview({ id: done.id }).ignored, true);
});
test('no reviewer available: the card stays in review with the reason and notice, no new claim, and a manual reviewer clears it', (t) => {
  const { store, add, bind, get, executed } = fixture(t);
  const card = add(); executed(card.id);
  const { card: claimed } = store.claimReview({ id: card.id });
  const blocked = store.reviewBlocked({ id: card.id, key: claimed.review_claim.key, reason: '没有可用的审查者' });
  assert.equal(blocked.card.status, 'review'); assert.deepEqual({ round: blocked.card.review_block.round, reason: blocked.card.review_block.reason }, { round: 1, reason: '没有可用的审查者' });
  assert.match(blocked.notices[0], /不能自动开审查会话：没有可用的审查者。请队长处理/);
  assert.equal(store.reviewDue(get(card.id)), false); assert.equal(store.reviewPending(get(card.id)), false);
  assert.equal(store.claimReview({ id: card.id }).ignored, true);
  assert.equal(store.reviewBlocked({ id: card.id, key: claimed.review_claim.key, reason: 'again' }).ignored, true, 'no second notice');
  assert.equal(get(card.id).status, 'review'); assert.notEqual(get(card.id).status, 'done');
  bind(card.id, 'captain-review', 'rev', 'Codex', 'gpt-6.1-sol');   // the Captain takes it by hand
  assert.equal(get(card.id).review_block, null);
});
test('a reviewer that finishes without a clear verdict never passes the card', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id); bind(card.id, reviewer(card.id, 1), 'rev', 'Antigravity', 'gemini-3.8-flash-high');
  const result = event(card.id, 'complete', '看起来都不错', reviewer(card.id, 1), 'rev');
  assert.equal(result.card.status, 'review'); assert.equal(result.card.review_block.round, 1); assert.match(result.card.review_block.reason, /结论不明确/);
  assert.match(result.notices[0], /结论不明确/); assert.equal(result.card.rework_count, 0); assert.equal(result.card.review_reject, undefined);
  assert.equal(store.reviewDue(get(card.id)), false);
});
test('an unclear verdict after a rejection does not wipe the failure count that holds the card', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id);
  bind(card.id, reviewer(card.id, 1), 'rev1');
  event(card.id, 'failed', '不通过：第一轮', reviewer(card.id, 1), 'rev1');
  bind(card.id, AV.reworkAttemptId(card.id, 1), 'worker');
  event(card.id, 'complete', '返工完成', AV.reworkAttemptId(card.id, 1), 'worker');
  assert.equal(get(card.id).consecutive_failures, 1); assert.equal(get(card.id).review_round, 2);
  bind(card.id, reviewer(card.id, 2), 'rev2');
  const unclear = event(card.id, 'complete', '看起来都不错', reviewer(card.id, 2), 'rev2').card;
  assert.equal(unclear.status, 'review'); assert.equal(unclear.review_block.round, 2);
  assert.equal(unclear.consecutive_failures, 1, 'not a pass, so the earlier rejection still counts');
  assert.equal(unclear.rework_count, 1); assert.equal(store.reviewDue(unclear), false);
});
test('review passes with 通过; a plain failure or a "不通过" completion is a rejection that keeps the reviewer\'s full words', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const pass = add(); executed(pass.id); bind(pass.id, reviewer(pass.id, 1), 'rev');
  assert.equal(event(pass.id, 'complete', '通过：都核对过了', reviewer(pass.id, 1), 'rev').card.status, 'done');
  const findings = '不通过：1) 文件 /tmp/x 不存在\n2) 测试 a.test.js 没跑过。';
  for (const [how, type, message] of [['failed flag', 'failed', findings], ['不通过 result', 'complete', findings]]) {
    const card = add(); executed(card.id); bind(card.id, reviewer(card.id, 1), 'rev');
    const rejected = event(card.id, type, message, reviewer(card.id, 1), 'rev').card;
    assert.equal(rejected.status, 'doing', how); assert.equal(rejected.flag, 'failed', how); assert.equal(rejected.rework_count, 1, how);
    assert.equal(rejected.review_reject.findings, findings, how); assert.equal(rejected.review_reject.round, 1); assert.equal(rejected.review_reject.delivered, false);
    assert.equal(rejected.latest_receipt, '不通过：1) 文件 /tmp/x 不存在', how);
    assert.equal(store.reworkPending(get(card.id)), true, how);
  }
});
test('only a reviewer\'s own written verdict is sent back: manual reviews, crashes and quota stops are not findings', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const manual = add(); executed(manual.id); bind(manual.id, 'captain-review', 'rev');
  assert.equal(event(manual.id, 'failed', '问题很多', 'captain-review', 'rev').card.review_reject, undefined);
  const crash = add(); executed(crash.id); bind(crash.id, reviewer(crash.id, 1), 'rev');
  const crashed = event(crash.id, 'failed', 'agent 进程异常退出（exit 7）', reviewer(crash.id, 1), 'rev', 'process').card;
  assert.equal(crashed.review_reject, undefined); assert.equal(store.reworkPending(get(crash.id)), false);
  const quota = add(); executed(quota.id); bind(quota.id, reviewer(quota.id, 1), 'rev');
  const stopped = event(quota.id, 'failed', 'RESOURCE_EXHAUSTED', reviewer(quota.id, 1), 'rev', 'quota').card;
  assert.equal(stopped.review_reject, undefined); assert.equal(stopped.flag, 'quota'); assert.equal(store.reworkPending(get(quota.id)), false);
});
test('the same rejection is recorded once: a second event for the attempt cannot queue a second rework', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id); bind(card.id, reviewer(card.id, 1), 'rev');
  const first = event(card.id, 'failed', '不通过：A', reviewer(card.id, 1), 'rev').card.review_reject;
  event(card.id, 'failed', '不通过：另一份措辞', reviewer(card.id, 1), 'rev');
  assert.equal(get(card.id).review_reject.key, first.key); assert.equal(get(card.id).review_reject.findings, '不通过：A');
  assert.equal(get(card.id).rework_count, 1);
  store.reworkDispatched({ id: card.id, key: first.key });
  assert.equal(store.reworkPending(get(card.id)), false);
});
test('two rejected rounds: round two gets its own reviewer, the second rejection holds the card and nothing more is automatic', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add({ id: 't-two' }); executed(card.id);
  const claim1 = store.claimReview({ id: card.id }).card.review_claim; store.reviewDispatched({ id: card.id, key: claim1.key });
  bind(card.id, reviewer(card.id, 1), 'rev1', 'Antigravity', 'gemini-3.8-flash-high');
  event(card.id, 'failed', '不通过：第一轮问题', reviewer(card.id, 1), 'rev1');
  const reject1 = get(card.id).review_reject;
  assert.equal(store.reworkPending(get(card.id)), true);
  // rework: the executor is re-bound under the rework attempt id and finishes again
  bind(card.id, AV.reworkAttemptId(card.id, 1), 'worker', 'Claude', 'claude-sonnet-5-5');
  assert.equal(get(card.id).review_reject.delivered, true); assert.equal(store.reworkPending(get(card.id)), false);
  assert.equal(get(card.id).consecutive_failures, 1);
  const round2 = event(card.id, 'complete', '返工完成', AV.reworkAttemptId(card.id, 1), 'worker', 'command', ['/tmp/a.js']).card;
  assert.equal(round2.status, 'review'); assert.equal(round2.review_round, 2); assert.equal(round2.consecutive_failures, 1, 'passing execution does not clear review failures');
  assert.equal(store.reviewDue(get(card.id)), true, 'a new round is due a reviewer of its own');
  const claim2 = store.claimReview({ id: card.id }).card.review_claim; assert.equal(claim2.round, 2); assert.notEqual(claim2.key, claim1.key);
  store.reviewDispatched({ id: card.id, key: claim2.key });
  bind(card.id, reviewer(card.id, 2), 'rev2', 'Antigravity', 'gemini-3.8-flash-high');
  const held = event(card.id, 'failed', '不通过：第二轮问题', reviewer(card.id, 2), 'rev2');
  assert.equal(held.card.flag, 'held'); assert.equal(held.card.rework_count, 2); assert.match(held.notices[0], /连续失败 2 次，已挂起，不再自动重试/);
  assert.equal(store.reworkPending(get(card.id)), false, 'held: handed to the Captain, no automatic rework');
  assert.equal(store.reviewDue(get(card.id)), false); assert.equal(store.claimReview({ id: card.id }).ignored, true);
  assert.notEqual(reject1.key, get(card.id).review_reject.key);
  assert.equal(get(card.id).review_reject.delivered, true);
});
test('a Captain move or rebind replaces a pending automatic rework; the rework only fires for the failed card on this machine', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const reject = () => { const c = add(); executed(c.id); bind(c.id, reviewer(c.id, 1), 'rev'); event(c.id, 'failed', '不通过：x', reviewer(c.id, 1), 'rev'); return c.id; };
  const a = reject(); assert.equal(store.reworkPending(get(a)), true);
  store.move({ id: a, status: 'doing' }); assert.equal(store.reworkPending(get(a)), false);
  const b = reject(); bind(b, 'captain-tell', 'worker'); assert.equal(store.reworkPending(get(b)), false);
  const c = reject();
  store.mutate((docs) => { store.find(docs, c).review_reject.owner = 'some-other-machine'; return {}; });
  assert.equal(store.reworkPending(get(c)), false);
  const d = reject();
  store.mutate((docs) => { store.find(docs, d).review_claim = { round: 1, key: 'k', owner: 'some-other-machine', delivered: false }; store.find(docs, d).status = 'review'; store.find(docs, d).flag = null; return {}; });
  assert.equal(store.reviewPending(get(d)), false, 'another machine\'s claim is not delivered here');
});

// ---- the heartbeat ----
function beat(store, extra = {}) {
  const calls = { review: [], rework: [] };
  const hb = new TaskHeartbeat(store, { onReview: (i) => { calls.review.push(i); return false; }, onRework: (i) => { calls.rework.push(i); return false; }, ...extra });
  return { hb, calls };
}
test('the heartbeat claims a review round once and keeps offering the same claim until it is marked delivered', (t) => {
  const { store, add, get, executed } = fixture(t);
  const card = add(); executed(card.id);
  const { hb, calls } = beat(store);
  hb.scan(); hb.scan(); hb.scan();
  assert.equal(calls.review.length, 3); assert.equal(new Set(calls.review.map((c) => c.key)).size, 1);
  assert.equal(get(card.id).review_claim.key, calls.review[0].key);
  store.reviewDispatched({ id: card.id, key: calls.review[0].key });
  hb.scan(); hb.scan();
  assert.equal(calls.review.length, 3, 'delivered: never offered again');
  assert.equal(get(card.id).review_claim.round, 1);
});
test('a restarted heartbeat (new process) offers the old unfinished claim and makes no second one', (t) => {
  const { dir, store, add, get, executed } = fixture(t);
  const card = add(); executed(card.id);
  const first = beat(store); first.hb.scan();
  const key = get(card.id).review_claim.key;
  const second = beat(new TaskStore(dir)); second.hb.scan(); second.hb.scan();
  assert.deepEqual(second.calls.review.map((c) => c.key), [key, key]); assert.equal(get(card.id).review_claim.key, key);
  // and once delivered, a third process stays quiet
  store.reviewDispatched({ id: card.id, key });
  const third = beat(new TaskStore(dir)); third.hb.scan(); assert.deepEqual(third.calls.review, []);
});
test('the heartbeat does nothing for plain cards, held cards, a switched-off feature or cards the Captain already took', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const plain = add({ verify: false }); bind(plain.id, 'p', 'w'); event(plain.id, 'complete', 'done', 'p', 'w');
  const taken = add(); executed(taken.id, 't1', 'w1'); bind(taken.id, 'captain-review', 'rev');
  const off = add(); executed(off.id, 'o1', 'w2');
  const quiet = beat(store, { autoVerify: () => false }); quiet.hb.scan();
  assert.deepEqual(quiet.calls, { review: [], rework: [] }); assert.equal(get(off.id).review_claim, undefined);
  const on = beat(store); on.hb.scan();
  assert.deepEqual(on.calls.review.map((c) => c.key), [get(off.id).review_claim.key]); assert.equal(get(taken.id).review_claim, undefined); assert.equal(get(plain.id).review_claim, undefined);
  // switching it off again also drops anything not yet handed over
  const later = beat(store, { autoVerify: () => false }); later.hb.scan(); assert.deepEqual(later.calls.review, []);
  // a held card is not offered a rework
  const held = add(); executed(held.id, 'h1', 'w3'); bind(held.id, reviewer(held.id, 1), 'r'); event(held.id, 'failed', '不通过：a', reviewer(held.id, 1), 'r');
  bind(held.id, 'again', 'w3'); event(held.id, 'complete', 'again', 'again', 'w3');
  bind(held.id, reviewer(held.id, 2), 'r2'); event(held.id, 'failed', '不通过：b', reviewer(held.id, 2), 'r2');
  assert.equal(get(held.id).flag, 'held');
  const after = beat(store); after.hb.scan(); assert.deepEqual(after.calls.rework, []);
});
test('a rejection is offered for rework until marked delivered, in every heartbeat process', (t) => {
  const { dir, store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id); bind(card.id, reviewer(card.id, 1), 'rev'); event(card.id, 'failed', '不通过：x', reviewer(card.id, 1), 'rev');
  const key = get(card.id).review_reject.key;
  const a = beat(store); a.hb.scan(); a.hb.scan();
  assert.deepEqual(a.calls.rework, [{ id: card.id, key }, { id: card.id, key }]);
  const b = beat(new TaskStore(dir)); b.hb.scan(); assert.deepEqual(b.calls.rework, [{ id: card.id, key }]);
  store.reworkDispatched({ id: card.id, key });
  const c = beat(new TaskStore(dir)); c.hb.scan(); assert.deepEqual(c.calls.rework, []);
});
test('without the new callbacks the heartbeat is exactly the old one', (t) => {
  const { store, add, executed, get } = fixture(t);
  const card = add(); executed(card.id);
  const hb = new TaskHeartbeat(store, { onStart() {} }); hb.scan();
  assert.equal(get(card.id).review_claim, undefined);
});

test('the Captain briefing describes the automatic loop, stays static, and leaves rule 16 alone', () => {
  const M = require('../main-core');
  const text = require('./fixtures/captain-rulebook').rulebook('darwin');
  assert.equal(M.instructions('darwin'), M.instructions('darwin'));
  assert.match(text, /程序自动开一个和执行会话不同提供方的审查会话/); assert.match(text, /审查员的原话自动发回原执行会话返工/);
  assert.match(text, /连续失败两次 held，先由队长决定，不再自动重试/); assert.match(text, /选不出审查者（同一提供方或额度用尽）时卡片停在 review 并写明原因/);
  assert.match(text, /16\. 重要的活完成后，派 Gemini 3\.8 Flash/);
  assert.doesNotMatch(text, /auto-review-|review_round/);
});
