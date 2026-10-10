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

// ---- who may review: a fresh Claude session, by the quota reading; never another provider ----
const SEATS = [{ id: 'cn', label: 'CN' }, { id: 'us', label: 'US' }, { id: 'us2', label: 'US2' }];
// stanceOf over a table: { cn: 'out', ... } by seat id for Claude commands; anything else 'ok'.
const bySeat = (table) => (cmd, seatId) => (/^claude/.test(cmd) ? table[seatId] || 'ok' : 'ok');
test('a card that is not simple is reviewed by Opus 5.5, a simple one by Sonnet 5.5, in a new Claude session', () => {
  const card = { id: 't', title: 'x' };
  const receipt = (extra = {}) => ({ text: '做完了', files: ['/a'], assignee: { agent: 'Claude', model: 'claude-sonnet-5-5' }, ...extra });
  const label = (c, r) => AV.pickReviewer({ card: c, receipt: r, seats: SEATS, stanceOf: bySeat({}) }).candidate.label;
  assert.equal(label(card, receipt()), 'Claude Sonnet 5.5', 'short receipt, one file, not marked important: simple');
  assert.equal(label({ ...card, important: true }, receipt()), 'Claude Opus 5.5', 'marked 高优先级');
  assert.equal(label(card, receipt({ files: ['/a', '/b', '/c', '/d'] })), 'Claude Opus 5.5', 'many files');
  assert.equal(label(card, receipt({ text: '长'.repeat(801) })), 'Claude Opus 5.5', 'long receipt');
  assert.equal(label(card, receipt({ assignee: { agent: 'Claude', model: 'claude-opus-5-5' } })), 'Claude Opus 5.5', 'an Opus executor means it was judged important');
  assert.equal(label(card, receipt({ assignee: { agent: 'Codex', model: 'gpt-6.1-sol' } })), 'Claude Sonnet 5.5', 'who made the executor does not matter');
  assert.equal(label(card, undefined), 'Claude Sonnet 5.5');
  // never another provider, whoever executed and whatever the quota table says
  for (const executor of [null, {}, { agent: 'Antigravity', model: 'gemini-3.8-flash-high' }, { agent: 'Codex', model: 'default' }, { agent: 'Custom agent', model: 'default' }]) {
    const picked = AV.pickReviewer({ card: { ...card, important: true }, receipt: receipt({ assignee: executor }), seats: SEATS, stanceOf: bySeat({}) });
    assert.match(picked.cmd, /^claude --dangerously-skip-permissions --model claude-opus-5-5 /); assert.equal(picked.family, 'anthropic');
  }
  assert.ok(AV.CANDIDATES.every((c) => /^claude /.test(c.command)), 'no Gemini, agy, Codex or Cursor candidate left');
});
test('a Claude seat that is out is skipped, the first one with room is taken, and a seat the quota cannot judge is not taken for having room', () => {
  const pick = (table, extra = {}) => AV.pickReviewer({ simple: false, seats: SEATS, stanceOf: bySeat(table), ...extra });
  assert.equal(pick({}).seat.id, 'cn', 'the seat a new session defaults to leads');
  assert.equal(pick({ cn: 'out' }).seat.id, 'us');
  assert.equal(pick({ cn: 'out', us: 'error' }).seat.id, 'us2');
  assert.equal(pick({ cn: 'low', us: 'ok' }).seat.id, 'us', 'a seat with plenty beats one at the threshold');
  assert.equal(pick({ cn: 'low', us: 'out', us2: 'out' }).seat.id, 'cn', 'low is still usable when nothing better is left');
  // unknown (stale, missing, failing query) is never "has quota": a seat that is ok wins over it, even when listed later
  assert.equal(pick({ cn: 'unknown', us: 'ok' }).seat.id, 'us');
  // with only unknown readings left the Claude session is still the last resort, flagged unverified
  const weak = pick({ cn: 'unknown', us: 'out', us2: 'unknown' });
  assert.equal(weak.seat.id, 'cn'); assert.equal(weak.unverified, true); assert.match(weak.cmd, /^claude /);
  // every seat out or broken: nobody, with a reason that names each
  const none = pick({ cn: 'out', us: 'out', us2: 'error' });
  assert.equal(none.cmd, undefined); assert.match(none.reason, /^没有可用的审查者/);
  assert.match(none.reason, /Claude Opus 5\.5（CN）：额度用尽/); assert.match(none.reason, /（US2）：登录或额度查询出错/);
});
test('Gemini, agy and Codex quota never matter to the reviewer, and a stand-in candidate table is judged by the same reading', () => {
  // exhausted Gemini and stale Codex change nothing
  const stance = (cmd) => (/^agy/.test(cmd) ? 'out' : /^codex/.test(cmd) ? 'unknown' : 'ok');
  assert.match(AV.pickReviewer({ simple: false, seats: SEATS, stanceOf: stance }).cmd, /^claude /);
  // a candidate table swapped in by a test: first usable in preference order, judged as written
  const table = [{ id: 'stand-in', label: '替身审查员', family: 'x', command: 'node stand-in.js' }];
  assert.equal(AV.pickReviewer({ candidates: table, seats: SEATS, stanceOf: () => 'unmetered' }).candidate.id, 'stand-in');
  assert.match(AV.pickReviewer({ candidates: table, seats: SEATS, stanceOf: () => 'unknown' }).reason, /替身审查员：额度读数过期或没有/);
});
test('the dispatcher is Gemini Flash only while a fresh reading shows room; otherwise a Claude Haiku 5.5 session on a seat with room', () => {
  const commandOf = (c) => c.command || (c.agent === 'agy' ? 'agy --model gemini-3.8-flash-high' : c.agent);
  const dispatch = (gemini, claude = {}) => AV.pickDispatcher({ commandOf, seats: SEATS, stanceOf: (cmd, seatId) => (/^agy/.test(cmd) ? gemini : claude[seatId] || 'ok') });
  assert.equal(dispatch('ok').candidate.id, 'gemini-flash');
  assert.equal(dispatch('low').candidate.id, 'gemini-flash');
  for (const gemini of ['out', 'unknown', 'error', 'unmetered']) {
    const picked = dispatch(gemini);
    assert.equal(picked.candidate.id, 'claude-haiku', `Gemini ${gemini}`); assert.equal(picked.seat.id, 'cn');
    assert.match(picked.cmd, /--model claude-haiku-5-5 --effort medium/);
  }
  assert.equal(dispatch('out', { cn: 'out' }).seat.id, 'us', 'a Claude seat that is out is skipped too');
  const weak = dispatch('out', { cn: 'unknown', us: 'out', us2: 'out' });
  assert.equal(weak.candidate.id, 'claude-haiku'); assert.equal(weak.unverified, true);
  const none = dispatch('out', { cn: 'out', us: 'out', us2: 'out' });
  assert.equal(none.cmd, undefined); assert.match(none.reason, /Gemini 3\.8 Flash（Antigravity）：额度用尽/);
});
test('a review title says what really runs: the executor\'s marks on the card title come out, the real provider and model go in', () => {
  const t = (title, label = 'Claude Opus 5.5') => AV.reviewTitle(title, label);
  assert.equal(t('修登录'), '审查：修登录（Claude Opus 5.5）');
  assert.equal(t('画图：大一统全景图页面（放进 Hermes 网站，Opus 5.5）'), '审查：画图：大一统全景图页面（放进 Hermes 网站）（Claude Opus 5.5）');
  assert.equal(t('2.0.5 集成（Opus 5.5 high·066us）', 'Claude Sonnet 5.5'), '审查：2.0.5 集成（Claude Sonnet 5.5）');
  assert.equal(t('统一下载器(Gemini 3.8 Flash)'), '审查：统一下载器（Claude Opus 5.5）');
  assert.equal(t('修（登录）页面（Opus·US2）'), '审查：修（登录）页面（Claude Opus 5.5）');
  assert.ok(t('标题'.repeat(100)).length <= 80); assert.ok(t('标题'.repeat(100)).endsWith('（Claude Opus 5.5）'));
  assert.equal(AV.reviewTitle('修登录（Opus）', 'Claude Haiku 5.5', 120, '调度：'), '调度：修登录（Claude Haiku 5.5）');
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
test('a second receipt from an executor told more: before the reviewer binds, the old round is void and the new receipt gets round 2', (t) => {
  const { store, add, bind, event, get, executed } = fixture(t);
  const card = add(); executed(card.id);
  const claim1 = store.claimReview({ id: card.id }).card.review_claim;
  // The executor is told to do more (the session layer rebinds it under a fresh attempt id).
  bind(card.id, 'tell-1', 'worker');
  const resumed = get(card.id);
  assert.equal(resumed.review_session, false, 'the executor is not a reviewer'); assert.equal(resumed.status, 'doing'); assert.equal(resumed.review_claim.delivered, true);
  assert.equal(store.reviewDue(resumed), false); assert.equal(store.reviewPending(resumed), false, 'the voided claim is not offered any more');
  const second = event(card.id, 'complete', '补充做完', 'tell-1', 'worker', 'command', ['/tmp/a.js']).card;
  assert.equal(second.status, 'review'); assert.equal(second.review_round, 2); assert.equal(second.exec_receipt.text, '补充做完'); assert.equal(second.exec_receipt.attempt_id, 'tell-1');
  assert.equal(store.reviewDue(get(card.id)), true);
  const claim2 = store.claimReview({ id: card.id }).card.review_claim; assert.equal(claim2.round, 2); assert.notEqual(claim2.key, claim1.key);
  assert.equal(store.claimReview({ id: card.id }).ignored, true, 'one claim per round');
});
test('a second receipt while the reviewer works: the review is void, the new receipt is round 2 under the executor\'s own make, the old verdict is ignored', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id);
  const claim1 = store.claimReview({ id: card.id }).card.review_claim; store.reviewDispatched({ id: card.id, key: claim1.key });
  bind(card.id, reviewer(card.id, 1), 'rev1', 'Antigravity', 'gemini-3.8-flash-high');
  assert.equal(get(card.id).session_id, 'rev1');
  // the executor's own attempt id is unchanged: the card is held by the reviewer, so nothing rebinds it
  const second = event(card.id, 'complete', '补充做完', 'a1', 'worker', 'command', ['/tmp/a.js', '/tmp/c.js']).card;
  assert.equal(second.status, 'review'); assert.equal(second.review_round, 2); assert.equal(second.review_session, false);
  assert.equal(second.session_id, 'worker'); assert.deepEqual(second.exec_receipt.files, ['/tmp/a.js', '/tmp/c.js']);
  assert.deepEqual(second.exec_receipt.assignee, { agent: 'Claude', model: 'claude-sonnet-5-5' }, 'the executor, not the old reviewer');
  assert.equal(store.reviewDue(second), true);
  // the voided reviewer's verdict (either way) changes nothing
  assert.equal(event(card.id, 'failed', '不通过：旧结论', reviewer(card.id, 1), 'rev1').ignored, true);
  assert.equal(event(card.id, 'complete', '通过：旧结论', reviewer(card.id, 1), 'rev1').ignored, true);
  assert.equal(get(card.id).status, 'review'); assert.equal(get(card.id).review_round, 2); assert.ok(!get(card.id).review_reject);
  // the new round's reviewer is a fresh Claude session again, picked from the new receipt
  const picked = AV.pickReviewer({ card: get(card.id), receipt: get(card.id).exec_receipt, seats: SEATS, stanceOf: bySeat({}) });
  assert.match(picked.cmd, /^claude /);
});
test('only a different written receipt from the original executor voids a running review', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add(); executed(card.id);
  const claim = store.claimReview({ id: card.id }).card.review_claim; store.reviewDispatched({ id: card.id, key: claim.key });
  bind(card.id, reviewer(card.id, 1), 'rev1', 'Antigravity', 'gemini-3.8-flash-high');
  // a replay of the very receipt under review, an automatic or failure report, another session: all ignored
  assert.equal(event(card.id, 'complete', '做完了。 完整回执第二句。', 'a1', 'worker').ignored, true);
  assert.equal(event(card.id, 'complete', '别的话', 'a1', 'worker', 'automatic').ignored, true);
  assert.equal(event(card.id, 'failed', '崩了', 'a1', 'worker', 'command').ignored, true);
  assert.equal(event(card.id, 'complete', '别人', 'x1', 'stranger').ignored, true);
  const kept = get(card.id); assert.equal(kept.session_id, 'rev1'); assert.equal(kept.review_round, 1); assert.equal(kept.review_session, true);
  // a manual reviewer on a plain (no --verify) card is not touched either
  const plain = add({ verify: false }); bind(plain.id, 'p1', 'w2'); event(plain.id, 'complete', 'ok', 'p1', 'w2');
  assert.equal(event(plain.id, 'complete', '再来', 'p1', 'w2').card.status, 'done');
});
test('a held card takes no new review from a second receipt', (t) => {
  const { store, add, bind, event, get, executed, reviewer } = fixture(t);
  const card = add({ id: 't-held' }); executed(card.id);
  for (const round of [1, 2]) {
    const c = store.claimReview({ id: card.id }).card.review_claim; store.reviewDispatched({ id: card.id, key: c.key });
    bind(card.id, reviewer(card.id, round), 'rev' + round, 'Antigravity', 'gemini-3.8-flash-high');
    event(card.id, 'failed', '不通过：' + round, reviewer(card.id, round), 'rev' + round);
    if (round === 1) { bind(card.id, AV.reworkAttemptId(card.id, 1), 'worker'); event(card.id, 'complete', '返工完成', AV.reworkAttemptId(card.id, 1), 'worker'); }
  }
  assert.equal(get(card.id).flag, 'held');
  assert.equal(event(card.id, 'complete', '又来', AV.reworkAttemptId(card.id, 1), 'worker').ignored, true);
  assert.equal(store.reviewDue(get(card.id)), false); assert.equal(store.claimReview({ id: card.id }).ignored, true);
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
  assert.match(text, /程序自动另起一个新的 Claude 审查会话（重要的用 Opus 5.5，简单的用 Sonnet 5.5/); assert.doesNotMatch(text, /不同提供方的审查会话/); assert.match(text, /审查员的原话自动发回原执行会话返工/);
  assert.match(text, /连续失败两次 held，先由队长决定，不再自动重试/); assert.match(text, /选不出审查者（Claude 各席位额度都用尽或出错）时卡片停在 review 并写明原因/);
  assert.match(text, /16\. 重要的活完成后，派 Opus 5\.5 新开会话验收（简单的核对派 Sonnet 5\.5；界面活一律 Opus 5\.5），不派 Gemini 等别家模型：/);
  assert.doesNotMatch(text, /派 Gemini 3\.8 Flash 验收/);
  assert.match(text, /验收通过再汇报。/);
  assert.doesNotMatch(text, /auto-review-|review_round/);
});

// ---- interface work is always Opus ----
test('interface work is recognised from the files, the card and the receipt, and is never a simple card', () => {
  const card = (extra = {}) => ({ id: 't', title: '修校验', detail: '改后端', ...extra });
  const receipt = (files = ['/repo/a.js'], text = '改完', model = 'claude-sonnet-5-5') => ({ text, files, assignee: { agent: 'Claude', model } });
  const ui = (c, r) => AV.isUiWork({ card: c, receipt: r });
  for (const file of ['/r/task-board-ui.js', 'C:\\r\\sidebar-core.js', '/r/style.css', '/r/index.html', '/r/shot.png', '/r/a.SVG', '/r/chat-ui.js', '/r/renderer.js', '/r/mobile-web/hub/core.js', '/r/preview-themes.css', '/r/App.vue', '/r/shot.jpeg']) {
    assert.equal(ui(card(), receipt([file])), true, file);
  }
  for (const file of ['/r/main.js', '/r/task-board.js', '/r/tests/a.test.js', '/r/README.md', '/r/auto-verify-core.js']) assert.equal(ui(card(), receipt([file])), false, file);
  for (const [title, detail, text] of [['手机端布局小改', '', ''], ['x', '加一个按钮', ''], ['x', '', '侧栏对齐了'], ['x', '', '深色主题下的对比度'], ['Fix the sidebar', '', ''], ['x', '', 'added a CSS rule'], ['x', '', '截图在 /tmp'], ['x', '', '弹窗不再抢焦点']]) {
    assert.equal(ui(card({ title, detail }), receipt(['/repo/a.js'], text)), true, title + detail + text);
  }
  for (const [title, detail, text] of [['修校验', '改后端', '改完，测试过'], ['quota reading', 'the passive source', 'tests pass'], ['同步冲突', '', '合并规则']]) {
    assert.equal(ui(card({ title, detail }), receipt(['/repo/a.js'], text)), false, title);
  }
  // a small change made by Sonnet that touches a screen is not simple; the same size without one is
  assert.equal(AV.reviewIsSimple({ card: card(), receipt: receipt() }), true);
  assert.equal(AV.reviewIsSimple({ card: card(), receipt: receipt(['/repo/side-pane.js']) }), false);
  assert.equal(AV.reviewIsSimple({ card: card(), receipt: receipt(['/repo/a.js', '/tmp/shot.png']) }), false);
  const pick = (c, r, extra = {}) => AV.pickReviewer({ card: c, receipt: r, seats: [{ id: 'cn' }], stanceOf: () => 'ok', ...extra });
  assert.equal(pick(card(), receipt()).candidate.label, 'Claude Sonnet 5.5');
  assert.equal(pick(card(), receipt(['/repo/style.css'])).candidate.label, 'Claude Opus 5.5');
  assert.equal(pick(card({ title: '界面小改' }), receipt()).candidate.label, 'Claude Opus 5.5');
  assert.equal(pick(card(), receipt(['/repo/style.css']), { simple: true }).candidate.label, 'Claude Opus 5.5', 'even when told the card is simple');
  // with Opus out the interface review still never falls to Sonnet by itself: the pick keeps its order and says what it took
  assert.equal(pick(card(), receipt(['/repo/style.css'])).simple, false);
});

// ---- a test instance only opens stand-ins ----
test('the program a launch line runs is told by name; a stand-in is anything else, and a test instance refuses the real ones', () => {
  for (const [command, name] of [['claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high', 'claude'], ['command claude', 'claude'], ['FOO=1 agy --model gemini-3.8-flash-high', 'agy'],
    ['antigravity --x', 'antigravity'], ['codex --no-daemon', 'codex'], ['gemini', 'gemini'], ['cursor-agent --force', 'cursor-agent'], ['"C:\\Users\\x\\AppData\\claude.cmd" --x', 'claude'],
    ['"D:\\npm\\codex.exe" a', 'codex'], ['/usr/local/bin/claude --x', 'claude'], ['& "C:\\a\\agy.ps1" --x', 'agy'], ['claude-ds --x', 'claude-ds']]) {
    assert.equal(AV.realAgentProgram(command), name, command);
    assert.match(AV.testInstanceRefusal(command, '自动审查'), /测试实例里自动审查只许开替身命令，不开真的 /, command);
  }
  for (const command of ['node "C:/r/tests/e2e/fixtures/fake-agent.js" --screen-only', '"C:\\Program Files\\nodejs\\node.exe" fake-agent.js', 'node fake-claude.js --provider=codex', 'python stand-in.py', '', 'bash -c "echo claude"', 'claude-like.sh']) {
    assert.equal(AV.realAgentProgram(command), '', command); assert.equal(AV.testInstanceRefusal(command, '调度员'), '', command);
  }
});
test('the command put in the Captain\'s hands carries the model in --command and nothing new does not know', () => {
  const card = { id: 't-1', project: '项目 A', title: '修"登录"（Opus 5.5）$x' };
  for (const [receipt, model] of [[{ text: '短', files: ['/a.js'], assignee: { model: 'claude-sonnet-5-5' } }, 'claude-sonnet-5-5'], [{ text: '短', files: ['/style.css'], assignee: { model: 'claude-sonnet-5-5' } }, 'claude-opus-5-5'], [undefined, 'claude-sonnet-5-5']]) {
    const command = AV.manualReviewCommand({ card, receipt, executorId: 'c-board-x' });
    assert.ok(command.startsWith('node "$AGENTDECK_BOARD_CLI" new --task-id t-1 --project "项目 A" '), command);
    assert.ok(command.includes('--reviews c-board-x --command "claude --dangerously-skip-permissions --model ' + model + ' --effort high"'), command);
    assert.doesNotMatch(command.replace(/--command "[^"]*"/, ''), /--model|--effort|--verify/);
    assert.ok(!/["`$]/.test(/--title "([^"]*)"/.exec(command)[1]), 'the title cannot break out of its quotes');
  }
});
