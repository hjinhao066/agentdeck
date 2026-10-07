'use strict';
// The Relay handoff, from real board states: cards are driven through the real
// TaskStore, then one snapshot is turned into text. No model, no PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../relay-handoff-core');
const M = require('../main-core');
const R = require('../restart-resume');
const AV = require('../auto-verify-core');
const Seats = require('../claude-seats-main');
const { TaskStore } = require('../task-board');

const NOW = Date.parse('2026-10-05T06:19:52Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = [];
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => live });
  const f = {
    root, store, live,
    add: (extra = {}) => store.add({ project: 'p', title: '修登录', detail: '把登录修好', ...extra }).card,
    bind: (id, attempt, session, agent = 'Claude', model = 'claude-sonnet-5-5') => store.bind({ id, session_id: session, attempt_id: attempt, assignee: { agent, model } }).card,
    event: (id, type, message, attempt, session, source = 'command', files) => store.event({ id, type, message, attempt_id: attempt, session_id: session, source, ...(files ? { files } : {}) }),
    get: (id) => store.list({ archived: true }).find((c) => c.id === id),
    cards: () => store.list({ archived: true }),
  };
  return f;
}
// A dispatch record as main-session.js keeps it.
let seq = 0;
const record = (colId, status, extra = {}) => ({ id: 'k' + (++seq), colId, title: '执行', status, gen: 1, sentAt: NOW - 3600_000 + seq * 1000, receipt: null, project: 'p', reviews: [], boardId: '', boardAttempt: '', ...extra });
const receipt = (summary, extra = {}) => ({ summary, files: [], failed: '', explicit: true, source: 'command', ...extra });
const session = (id, state = 'working', extra = {}) => ({ id, title: id, state, alive: true, crew: true, ...extra });
// `text` is everything the handoff holds, overview and detail files together, so a fact can be checked
// wherever it lives; `brief` is the overview page alone, and `file(name)` one detail file.
const build = (snapshot) => {
  const built = H.build({ now: NOW, timeZone: 'America/Los_Angeles', ...snapshot });
  return { ...built, brief: built.text, text: [built.text, ...built.files.map((f) => f.text)].join('\n'), file: (name) => built.files.find((f) => f.name === name).text };
};
// One row per unfinished task: a record of its own, or a line under the not-started header.
const cardLines = (built) => built.file('tasks.md').split('\n').filter((l) => (/^- 【/.test(l) && !/^- 【待执行】还没启动的 \d+ 张/.test(l)) || /^ {2}- (?:t-|[\w-]+｜)/.test(l));

test('a card executed three times is one record: who has it now, what is left, where the old rounds are', (t) => {
  const f = fixture(t);
  const card = f.add();
  f.bind(card.id, 'a1', 'sA'); f.event(card.id, 'failed', '依赖装不上', 'a1', 'sA');
  f.live.push({ id: 'sA', archived: true });
  f.bind(card.id, 'a2', 'sB'); f.live.push({ id: 'sB', archived: true });   // the Captain stopped and archived it
  f.bind(card.id, 'a3', 'sC'); f.event(card.id, 'started', '', 'a3', 'sC');
  const dispatches = [
    record('sA', 'failed', { boardId: card.id, boardAttempt: 'a1', receipt: receipt('', { failed: '依赖装不上' }) }),
    record('sB', 'done', { boardId: card.id, boardAttempt: 'a2', receipt: receipt('后来又给这个会话发了新指令，结果看后面的卡片。', { source: 'superseded' }) }),
    record('sB', 'stopped', { boardId: card.id, boardAttempt: 'a2', receipt: receipt('队长已结束终端并归档。', { source: 'captain-archive' }) }),
    record('sC', 'working', { boardId: card.id, boardAttempt: 'a3', progress: '登录页已改完，还差补测试' }),
  ];
  const built = build({ cards: f.cards(), dispatches, sessions: [session('sC')], archivedIds: ['sA', 'sB'] });
  const mine = built.state.cards.filter((c) => c.id === card.id);
  assert.equal(mine.length, 1, 'one record per card, however many sessions touched it');
  assert.equal(mine[0].label, '执行中'); assert.equal(mine[0].executor, 'sC');
  assert.deepEqual(mine[0].history.map((h) => `${h.id}:${h.outcome}`), ['sA:失败', 'sB:叫停']);
  const text = built.text;
  assert.equal(text.split('\n').filter((l) => l.startsWith('- 【') && l.includes(card.id)).length, 1);
  assert.match(text, /会话：执行 sC（运行中）/);
  assert.match(text, /结果：进度：登录页已改完，还差补测试/);
  assert.ok(!text.includes('结果：依赖装不上'), 'the first round\'s failure is not the current result');
  assert.match(text, /旧轮次：sA（失败）、sB（叫停）/);
  assert.match(text, /等 sC 的回执[^\n]*不要另开执行者/);
  // before the open round has reported anything, what the card still carries is marked as the earlier round's
  const silent = build({ cards: f.cards(), dispatches: dispatches.map((d) => ({ ...d, progress: undefined })), sessions: [session('sC')], archivedIds: ['sA', 'sB'] });
  assert.match(silent.text, /结果：上一轮：依赖装不上/);
  // the board itself refuses a second executor while this one holds the card
  f.live.push({ id: 'sC' });
  assert.throws(() => f.bind(card.id, 'a4', 'sD'), /already has an active execution/);
});

test('a reviewer that ends with 不通过 never leaves the task done: on the board, and in the handoff', (t) => {
  const f = fixture(t);
  // (a) the Captain's own reviewer, bound to the card under review
  const manual = f.add({ verify: true });
  f.bind(manual.id, 'e1', 'exec'); f.event(manual.id, 'complete', '做完了。', 'e1', 'exec');
  assert.equal(f.get(manual.id).status, 'review');
  f.live.push({ id: 'exec', archived: true });
  f.bind(manual.id, 'captain-review-1', 'rev');
  const rejected = f.event(manual.id, 'complete', '不通过：登录失败时没有提示，测试也没覆盖', 'captain-review-1', 'rev').card;
  assert.equal(rejected.status, 'doing'); assert.equal(rejected.flag, 'failed'); assert.equal(rejected.rework_count, 1);
  assert.notEqual(rejected.status, 'done');
  let built = build({ cards: f.cards(), archivedIds: ['exec', 'rev'], dispatches: [
    record('exec', 'done', { boardId: manual.id, boardAttempt: 'e1', receipt: receipt('做完了。') }),
    record('rev', 'done', { boardId: manual.id, boardAttempt: 'captain-review-1', reviews: ['exec'], receipt: receipt('不通过：登录失败时没有提示，测试也没覆盖') }),
  ] });
  let rec = built.state.cards.find((c) => c.id === manual.id);
  assert.equal(rec.group, 'rework'); assert.match(rec.label, /^返工/); assert.equal(rec.verdict.code, 'fail');
  assert.match(built.text, /【返工（验收不通过，待把意见发回原执行会话）】/);
  assert.match(built.text, /审查 rev（已结束·已归档，tell 可恢复，结论不通过）/);
  assert.match(built.text, /tell 给 exec/);
  // a clear pass still completes it; the session ending alone was never the signal
  const passed = f.add({ verify: true });
  f.bind(passed.id, 'e2', 'exec2'); f.event(passed.id, 'complete', '做完了。', 'e2', 'exec2'); f.live.push({ id: 'exec2', archived: true });
  f.bind(passed.id, 'captain-review-2', 'rev2');
  assert.equal(f.event(passed.id, 'complete', '通过：文件和测试都核对过', 'captain-review-2', 'rev2').card.status, 'done');

  // (b) a reviewer with a card of its own, pointing at the executor with --reviews:
  // the board never hears the verdict, so the reviewed card still says done
  const work = f.add({ title: '架构图 A 版' });
  f.bind(work.id, 'w1', 'artist'); f.event(work.id, 'complete', '画完了，已推送 feat/arch-a 提交 7eaf2c1。', 'w1', 'artist', 'command', ['/reports/arch/report.md']);
  f.live.push({ id: 'artist', archived: true });
  const check = f.add({ title: '验收：架构图 A 版' });
  f.bind(check.id, 'c1', 'judge'); f.event(check.id, 'complete', '不通过：57% 下卡片文字过小，断言被放宽 50px', 'c1', 'judge');
  assert.equal(f.get(work.id).status, 'done'); assert.equal(f.get(check.id).status, 'done');
  const artist = record('artist', 'done', { boardId: work.id, boardAttempt: 'w1', receipt: receipt('画完了，已推送 feat/arch-a 提交 7eaf2c1。', { files: ['/reports/arch/report.md'] }) });
  const judge = record('judge', 'done', { boardId: check.id, boardAttempt: 'c1', reviews: ['artist'], doneAt: NOW - 1000, receipt: receipt('不通过：57% 下卡片文字过小，断言被放宽 50px') });
  built = build({ cards: f.cards(), dispatches: [artist, judge], archivedIds: ['artist', 'judge', 'exec', 'rev', 'exec2', 'rev2'] });
  rec = built.state.cards.find((c) => c.id === work.id);
  assert.ok(rec, 'a done card with an open rejection is still listed');
  assert.equal(rec.group, 'rework'); assert.equal(rec.verdict.code, 'fail');
  assert.match(rec.conflicts[0], /看板记为完成，但审查会话 judge 的结论是不通过/);
  assert.ok(!built.state.cards.some((c) => c.id === check.id), 'the review task itself is finished');
  assert.match(built.text, /【返工（矛盾：看板记完成，验收不通过）】/);
  assert.match(built.text, /外部审查 judge（[^）]*结论不通过）/);
  assert.match(built.text, /先核实：read --id judge。属实就 task move --id \S+ --status doing，再把意见 tell 给 artist/);
  assert.equal(built.state.stats.conflicts, 1);
  // once the rework is out, the same card reads as rework under way, without a contradiction
  f.store.move({ id: work.id, status: 'doing', suppressDispatch: true });
  f.bind(work.id, 'w2', 'artist'); f.event(work.id, 'started', '', 'w2', 'artist');
  built = build({ cards: f.cards(), sessions: [session('artist')], archivedIds: ['judge'],
    dispatches: [artist, judge, record('artist', 'working', { boardId: work.id, boardAttempt: 'w2', sentAt: NOW - 500 })] });
  rec = built.state.cards.find((c) => c.id === work.id);
  assert.equal(rec.conflicts.length, 0); assert.match(rec.verdict.label, /不通过（审查会话 judge），返工中/); assert.equal(rec.executor, 'artist');

  // (c) the automatic loop: the reviewer's rejection is on the card and reads as rework
  const auto = f.add({ verify: true, title: '自动验收的卡' });
  f.bind(auto.id, 'x1', 'worker', 'Codex', 'gpt-6.1-sol'); f.event(auto.id, 'complete', '好了。', 'x1', 'worker'); f.live.push({ id: 'worker', archived: true });
  f.bind(auto.id, AV.reviewAttemptId(auto.id, 1), 'autorev', 'Antigravity', 'gemini-3.8-flash-high');
  f.event(auto.id, 'complete', '不通过：1) 截图没落盘', AV.reviewAttemptId(auto.id, 1), 'autorev');
  built = build({ cards: f.cards(), archivedIds: ['worker', 'autorev'] });
  rec = built.state.cards.find((c) => c.id === auto.id);
  assert.equal(rec.code, 'rework_pending'); assert.match(rec.result, /审查意见：不通过：1\) 截图没落盘/);
  assert.match(rec.next, /程序会把审查意见自动发回 worker/);
  // a reviewer bound with new --task-id --reviews while the card was not in review: the board
  // files it as the executor; the handoff still reads it as a review, and says the board has it wrong
  const final = f.add({ verify: true, title: '集成与打包' });
  f.bind(final.id, 'i1', 'packer', 'Codex', 'gpt-6.1-sol'); f.event(final.id, 'complete', 'release 分支已推送。', 'i1', 'packer'); f.live.push({ id: 'packer', archived: true });
  f.store.move({ id: final.id, status: 'doing', suppressDispatch: true });
  f.bind(final.id, 'i2', 'finalrev'); f.event(final.id, 'started', '', 'i2', 'finalrev');
  assert.equal(f.get(final.id).review_session, false);
  built = build({ cards: f.cards(), sessions: [session('finalrev')], archivedIds: ['packer'], dispatches: [
    record('packer', 'done', { boardId: final.id, boardAttempt: 'i1', receipt: receipt('release 分支已推送。') }),
    record('finalrev', 'working', { boardId: final.id, boardAttempt: 'i2', reviews: ['packer'] }),
  ] });
  rec = built.state.cards.find((c) => c.id === final.id);
  assert.equal(rec.code, 'reviewing'); assert.equal(rec.group, 'review'); assert.equal(rec.executor, '');
  assert.deepEqual(rec.roles.map((r) => `${r.role} ${r.id}`), ['审查 finalrev', '原执行 packer']);
  assert.match(rec.conflicts[0], /看板把审查会话 finalrev 记成了执行会话/);
  assert.match(rec.verdict.label, /未验收（finalrev 审查中）/);
  // a reviewer that ran out of quota gave no verdict either: nothing is held against a finished card
  const fine = f.add({ title: '没问题的卡' });
  f.bind(fine.id, 'q1', 'doer'); f.event(fine.id, 'complete', '做完了。', 'q1', 'doer');
  assert.equal(build({ cards: f.cards().filter((c) => c.id === fine.id), archivedIds: ['doer', 'broke'], dispatches: [
    record('doer', 'done', { boardId: fine.id, boardAttempt: 'q1', receipt: receipt('做完了。') }),
    record('broke', 'failed', { reviews: ['doer'], receipt: { summary: '', failed: '额度用尽：You\'ve hit your usage limit', explicit: true, files: [] } }),
  ] }).state.cards.length, 0);
  // a reviewer that crashed said nothing: the card is neither passed nor rejected
  const crashed = f.add({ verify: true, title: '审查会话挂了的卡' });
  f.bind(crashed.id, 'y1', 'worker2', 'Codex', 'gpt-6.1-sol'); f.event(crashed.id, 'complete', '好了。', 'y1', 'worker2'); f.live.push({ id: 'worker2', archived: true });
  f.bind(crashed.id, AV.reviewAttemptId(crashed.id, 1), 'autorev2', 'Antigravity', 'gemini-3.8-flash-high');
  f.event(crashed.id, 'failed', 'agent 进程异常退出（exit 7）', AV.reviewAttemptId(crashed.id, 1), 'autorev2', 'process');
  rec = build({ cards: f.cards(), archivedIds: ['worker2', 'autorev2'] }).state.cards.find((c) => c.id === crashed.id);
  assert.equal(rec.code, 'review_lost'); assert.equal(rec.group, 'review'); assert.equal(rec.verdict.code, 'none');
  assert.match(rec.verdict.label, /审查会话异常退出，没有结论/); assert.match(rec.next, /不要当成不通过打回/);
});

test('the summary and the task list are the same snapshot: the counts match the rows, and every running session is on the page', (t) => {
  const f = fixture(t);
  const doing = f.add({ title: '在做的' }); f.bind(doing.id, 'd1', 's-doing'); f.event(doing.id, 'started', '', 'd1', 's-doing');
  const review = f.add({ title: '待验收的', verify: true }); f.bind(review.id, 'r1', 's-rev'); f.event(review.id, 'complete', '交了。', 'r1', 's-rev');
  const ask = f.add({ title: '等用户的' }); f.bind(ask.id, 'q1', 's-ask'); f.event(ask.id, 'ask', '用哪个域名？', 'q1', 's-ask');
  const todo = f.add({ title: '没开始的' });
  f.add({ title: '被前置卡挡住的', depends_on: [todo.id] });
  const done = f.add({ title: '做完的' }); f.bind(done.id, 'z1', 's-done'); f.event(done.id, 'complete', '完成。', 'z1', 's-done');
  const dispatches = [
    record('s-doing', 'working', { boardId: doing.id, boardAttempt: 'd1' }),
    record('s-rev', 'done', { boardId: review.id, boardAttempt: 'r1', receipt: receipt('交了。') }),
    record('s-ask', 'asking', { boardId: ask.id, boardAttempt: 'q1', receipt: { question: '用哪个域名？' } }),
    record('s-done', 'done', { boardId: done.id, boardAttempt: 'z1', receipt: receipt('完成。') }),
    record('s-loose', 'working', { title: '没挂卡的小活' }),
  ];
  // s-ghost is running but no dispatch record or card names it: the old table lost such sessions
  const sessions = [session('s-doing'), session('s-ask', 'done'), session('s-loose'), session('s-ghost'), session('s-done', 'done'), session('manual', 'working', { crew: false })];
  const built = build({ cards: f.cards(), dispatches, sessions, decisions: { path: '/b/decisions.md', text: '## 当前目标\n- 发 1.2\n', mtime: NOW - 7200_000 },
    userTurns: [{ ts: NOW - 60_000, text: '先把登录修了', sourceId: 'cap-old' }] });
  const { stats } = built.state; const text = built.text;
  const total = stats.rework + stats.review + stats.doing + stats.paused + stats.todo;
  assert.equal(total, stats.cards + stats.loose);
  assert.equal(cardLines(built).length, total, 'one row per unfinished task, as many as the summary says');
  assert.match(text, new RegExp(`摘要：未完成任务 ${total} 条（返工 ${stats.rework}｜待验收 ${stats.review}｜执行中 ${stats.doing}｜暂停 ${stats.paused}｜待执行 ${stats.todo}）；在跑的队员会话 ${stats.running.length} 个`));
  assert.deepEqual([stats.review, stats.paused, stats.todo], [1, 1, 2]);
  // a session waiting for the Captain's answer still holds its task
  assert.deepEqual([...stats.running].sort(), ['s-ask', 's-doing', 's-ghost', 's-loose']);
  assert.match(text, /执行 s-ask（运行中·在等队长回答）/);
  for (const id of stats.running) assert.ok(built.file('tasks.md').includes(id), id);
  assert.match(text, /在跑、但没有对应未完成任务记录的会话：s-ghost/);
  assert.ok(!built.file('tasks.md').includes(done.id), 'finished work stays in the store, not in the handoff');
  assert.ok(!text.includes('manual'), 'the user\'s own terminals are not crew');
  assert.match(text, /各份文件都取自这一份快照，另标了时间的除外/);
  // the one part with a clock of its own says so, and says what came after it
  assert.match(built.brief, /来源 \/b\/decisions\.md（最后修改 10-04 21:19；此后还有 1 条用户消息没整理进来，以原文为准）/);
  // a crew question sits on its card and in the Captain's inbox: one line, the Captain's to answer
  // first, and not handed to the user by the program
  assert.match(text, new RegExp(`队员在等队长回答 1 条（卡着后续动作，先处理：已有授权能定或有把握的直接 tell / answer 回答，涉及不可逆的事或拿不准的才请用户决定）：\\n {2}- 提问｜s-ask｜${ask.id}｜「等用户的」｜用哪个域名？｜不阻塞其他卡`));
  assert.match(built.file('needs-user.md'), /- 无（队长没有记录）/);
  assert.match(text, new RegExp(`【暂停（队员提问，等回答）】${ask.id}[^\\n]*\\n[^\\n]*\\n[^\\n]*\\n {2}阻塞：队员提问：用哪个域名？\\n {2}下一步：先看清问题：已有授权能定或有把握就 tell s-ask 回答`));
  assert.equal(stats.asks, 1); assert.equal(stats.forUser, 0);
  assert.ok(!text.split('\n').find((l) => l.startsWith('7. ')).includes(ask.id), 'an open question is dealt with first, not parked');
  // compact: no padded table cells anywhere
  assert.ok(!/ {3,}\|| \| {2,}/.test(text)); assert.ok(!/\| --- \|/.test(text));
});

test('a late or replayed receipt from an old round cannot move the card, and a finished card stays finished', (t) => {
  const f = fixture(t);
  const card = f.add();
  f.bind(card.id, 'a1', 'old'); f.event(card.id, 'failed', '跑挂了', 'a1', 'old');
  f.live.push({ id: 'old', archived: true });
  f.bind(card.id, 'a2', 'new'); f.event(card.id, 'started', '', 'a2', 'new');
  // the old session's receipt arrives after the card moved on
  const late = f.event(card.id, 'complete', '其实我做完了', 'a1', 'old');
  assert.equal(late.ignored, true);
  assert.equal(f.get(card.id).status, 'doing'); assert.equal(f.get(card.id).session_id, 'new'); assert.equal(f.get(card.id).attempt_id, 'a2');
  const built = build({ cards: f.cards(), sessions: [session('new')], archivedIds: ['old'], dispatches: [
    record('old', 'failed', { boardId: card.id, boardAttempt: 'a1', receipt: receipt('', { failed: '跑挂了' }) }),
    record('new', 'working', { boardId: card.id, boardAttempt: 'a2' }),
  ] });
  assert.equal(built.state.cards.find((c) => c.id === card.id).executor, 'new');
  // the new round finishes; replaying its receipt, or the old one, changes nothing
  f.event(card.id, 'complete', '这次真做完了。', 'a2', 'new');
  const done = f.get(card.id);
  assert.equal(done.status, 'done');
  assert.equal(f.event(card.id, 'complete', '这次真做完了。', 'a2', 'new').ignored, true);
  assert.equal(f.event(card.id, 'failed', '迟到的失败', 'a1', 'old').ignored, true);
  assert.equal(f.event(card.id, 'started', '', 'a2', 'new').ignored, true, 'a closed round is not reopened by a stray start');
  assert.deepEqual(f.get(card.id), done);
  assert.ok(!build({ cards: f.cards(), archivedIds: ['old', 'new'] }).state.cards.length);
});

test('a pause the user asked for is not overridden by the standing continue-the-work plan', (t) => {
  const f = fixture(t);
  const stopped = f.add({ title: 'Windows 升级' });
  f.bind(stopped.id, 'a1', 's-win'); f.event(stopped.id, 'started', '', 'a1', 's-win');
  const running = f.add({ title: '打包' });
  f.bind(running.id, 'b1', 's-pack'); f.event(running.id, 'started', '', 'b1', 's-pack');
  const halted = record('s-win', 'stopped', { boardId: stopped.id, boardAttempt: 'a1', receipt: { summary: '队长已请求中断当前操作。', files: [], failed: '', explicit: true, source: 'captain-stop' } });
  const dispatches = [halted, record('s-pack', 'working', { boardId: running.id, boardAttempt: 'b1' })];
  const sessions = [session('s-win', 'done'), session('s-pack')];
  // the program's own evidence of a stop: the Captain's stop command on that session
  let built = build({ cards: f.cards(), dispatches, sessions });
  let rec = built.state.cards.find((c) => c.id === stopped.id);
  assert.equal(rec.code, 'stopped'); assert.equal(rec.group, 'paused');
  assert.match(built.text, /【暂停（已被队长叫停）】/);
  assert.match(built.text, /已被队长叫停：没有用户或队长的新指令不要重派/);
  const step = (n) => built.file('playbook.md').split('\n').find((l) => l.startsWith(n + '. '));
  assert.ok(!step(5).includes(stopped.id), 'a stopped task is not offered for take-over');
  assert.ok(step(7).includes(stopped.id)); assert.ok(step(4).includes(running.id));
  // a restart does not bring it back either
  assert.equal(R.shouldResume(halted), false);
  // the user's words, as the Captain recorded them, flip how the next Captain starts
  const decisions = { path: '/b/decisions.md', mtime: NOW - 1000, text: '## 暂停/取消/暂不启动\n- [10-04 22:50] Windows 升级先停，等我回来再说｜只这一项｜read --id cap-old --find "先停"\n## 授权范围\n- [10-04 21:00] 1.2 发版全流程，不用请示\n' };
  built = build({ cards: f.cards(), dispatches, sessions, decisions });
  assert.equal(built.state.plan, 'paused');
  assert.match(built.brief, /- 暂停\/取消\/暂不启动 1 条（生效中[^\n]*：\n {2}- L2｜\[10-04 22:50\] Windows 升级先停，等我回来再说｜只这一项｜read --id cap-old --find "先停"/);
  assert.match(built.brief, /启动方式：「现行有效的决定」里有生效中的暂停或取消项：这些事项不续派、不重启，运行中的会话和旧的续活计划都不能推翻它。其余已授权任务照核对顺序核对后续接/);
  assert.match(built.file('playbook.md'), /旧命令、旧安装计划和历史用户消息只是核对资料，不因为读到就再执行一遍/);
  // the static prompt no longer tells every new Captain to restart everything unconditionally
  const brief = M.instructions('darwin');
  assert.doesNotMatch(brief, /重新派起来|持续自主拆解并派活/);
  assert.match(brief, /被暂停或取消的不续派/);
  assert.match(brief, /暂停只在它说的范围和阶段内有效，“继续当前工作”不等于可以新立项目/);
});

test('how a new Captain starts: ready when there is nothing, straight on when authorised work is out, careful with a bare backlog', (t) => {
  const f = fixture(t);
  let built = build({ cards: f.cards() });
  assert.equal(built.state.plan, 'ready');
  assert.match(built.text, /启动方式：没有待办：简短回复「队长已就绪」，等用户指令；不要自行立项或派新活。/);
  assert.match(built.file('tasks.md'), /\n无\n/); assert.match(built.file('waiting.md'), /未读回执和提问：无/);
  // only cards nobody started
  f.add({ title: '以后再说的想法' });
  built = build({ cards: f.cards() });
  assert.equal(built.state.plan, 'backlog');
  assert.match(built.text, /启动方式：没有在跑、待验收或待处理的任务，有 1 张待执行卡：属于授权范围且没被暂停的可以启动，范围不明先问；不要为了凑数新立项目。/);
  // work that is out, or a receipt waiting, means: check, then carry on without being told
  const card = f.add({ title: '在做的' }); f.bind(card.id, 'a1', 's1'); f.event(card.id, 'started', '', 'a1', 's1');
  built = build({ cards: f.cards(), sessions: [session('s1')], dispatches: [record('s1', 'working', { boardId: card.id, boardAttempt: 'a1' })] });
  assert.equal(built.state.plan, 'resume');
  assert.match(built.text, /启动方式：有已授权待办：照 playbook.md 的顺序核对后主动续接，不用等用户说继续。/);
  assert.equal(build({ cards: [], pending: [{ taskId: 'k1', colId: 's9', title: '交回的活', summary: '做完了' }] }).state.plan, 'resume');
  // and the standing prompt agrees with both
  const brief = M.instructions('darwin');
  assert.match(brief, /没有待办就简短回复「队长已就绪」等用户指令，不自行立项/);
  assert.match(brief, /Relay、清空或重启后有已授权待办，核对后主动续接，不要等用户说“继续”/);
});

test('a session still running with no record behind it is something to check first, never "nothing to do"', (t) => {
  // exactly the case a lost dispatch record leaves behind: the terminal works, the ledger of tasks is empty
  let built = build({ sessions: [{ id: 'worker-live', alive: true, state: 'working', crew: true, title: '尚在执行的任务' }], cards: [], dispatches: [] });
  assert.deepEqual(built.state.stats.running, ['worker-live']); assert.equal(built.state.strays.length, 1);
  assert.equal(built.state.plan, 'verify');
  assert.match(built.text, /启动方式：有 1 个会话还在跑、却没有对应的任务记录（worker-live）：先 peek 核实它在做什么，再决定继续跟踪还是叫停；核实前不要报告就绪，也不要另派同样的活。/);
  assert.doesNotMatch(built.text, /没有待办/);
  assert.match(built.file('tasks.md'), /在跑、但没有对应未完成任务记录的会话：worker-live「尚在执行的任务」（运行中）。用 peek 看它在做什么/);
  assert.match(built.text.split('\n').find((l) => l.startsWith('3. ')), /没有任务记录却在跑的会话 1 个（worker-live，先 peek）/);
  assert.match(built.text, /在跑的队员会话 1 个/);
  // next to real work it does not change the plan, but it is still the first thing to check
  const f = fixture(t);
  const card = f.add({ title: '在做的' }); f.bind(card.id, 'a1', 's1'); f.event(card.id, 'started', '', 'a1', 's1');
  built = build({ cards: f.cards(), sessions: [session('s1'), session('worker-live')], dispatches: [record('s1', 'working', { boardId: card.id, boardAttempt: 'a1' })] });
  assert.equal(built.state.plan, 'resume');
  assert.match(built.text.split('\n').find((l) => l.startsWith('3. ')), /没有任务记录却在跑的会话 1 个（worker-live，先 peek）/);
  // the user's own terminal and a session that has come to rest are not strays
  built = build({ sessions: [session('mine', 'working', { crew: false }), session('rested', 'done')], cards: [], dispatches: [] });
  assert.equal(built.state.plan, 'ready'); assert.equal(built.state.strays.length, 0);
  // a task the Captain stopped is all that is left: that is not "nothing" either, and not a licence to restart it
  const g = fixture(t);
  const halted = g.add({ title: 'Windows 升级' }); g.bind(halted.id, 'u1', 's-win'); g.event(halted.id, 'started', '', 'u1', 's-win');
  built = build({ cards: g.cards(), sessions: [session('s-win', 'done')],
    dispatches: [record('s-win', 'stopped', { boardId: halted.id, boardAttempt: 'u1', receipt: receipt('队长已请求中断当前操作。', { source: 'captain-stop' }) })] });
  assert.equal(built.state.plan, 'backlog');
  assert.match(built.text, /启动方式：没有在跑、待验收或待处理的任务，有 0 张待执行卡、1 条暂停中的任务：[^\n]*暂停的没有新指令不重启/);
  assert.doesNotMatch(built.text, /没有待办/);
});

test('however many receipts are waiting, each is named: past the first few by session and title, never cut off', () => {
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => ({ receiptId: prefix + i, taskId: 'k' + i, colId: 'c-' + prefix + (i % 7), title: `${prefix}-${String(i).padStart(3, '0')}`, ts: NOW - i, summary: '很长的结果。'.repeat(30) }));
  const snapshot = { reason: 'relay', cards: [], dispatches: [], pending: many('unread', 70), unconfirmed: many('taken', 120),
    carry: { at: NOW - 3600_000, kind: 'relay', fromId: 'cap-0', items: many('older', 90) }, captain: { previousId: 'cap-1', gen: 3 } };
  for (const budget of [60000, 12000, 4000]) {
    const built = build({ ...snapshot, budget });
    for (const [prefix, n] of [['unread', 70], ['taken', 120], ['older', 90]]) {
      for (let i = 0; i < n; i++) assert.ok(built.text.includes(`「${prefix}-${String(i).padStart(3, '0')}」`), `${prefix} ${i} at budget ${budget}`);
    }
    assert.match(built.text, /未读回执和提问 70 条/); assert.match(built.text, /上任已取走、可能没处理完的回执 120 条/); assert.match(built.text, /之后也没人处理完的回执 90 条/);
    assert.equal(built.state.stats.unconfirmed, 210); assert.equal(built.state.plan, 'resume');
    assert.match(built.text, /其余 \d+ 条只列会话和标题，内容用 read --id 会话id 查：/);
    if (built.over) assert.match(built.text, /已超出预算：未完成任务、阻塞、限制和待决定事项一条没删/);
  }
  assert.ok(build({ ...snapshot, budget: 4000 }).length < build({ ...snapshot, budget: 60000 }).length);
  // the writer in the main process passes all of them through as well
  const src = fs.readFileSync(path.join(__dirname, '..', 'claude-seats-main.js'), 'utf8');
  assert.doesNotMatch(src, /cap\(payload\.(?:pending|inflight|unconfirmed)/);
});

test('every window on the page says it is a window: old messages, long reference lists, the reset note, an unreadable notes file', (t) => {
  // more user messages than the excerpt holds
  const userTurns = Array.from({ length: 12 }, (_, i) => ({ ts: NOW - (12 - i) * 60_000, text: `第 ${i} 条`, sourceId: 'cap-old' }));
  let built = build({ cards: [], userTurns, userTurnsOlder: true, decisions: { path: '/b/d.md', mtime: NOW - 3600_000, text: '## 当前目标\n- 发 1.2\n' } });
  assert.match(built.brief, /本快照有用户消息 12 条，其中 12 条还没进决定文件，更早的没有统计在内/);
  assert.match(built.brief, /更早的：read --id captain-history --find 关键词|另有 \d+ 条没摘录/);
  assert.match(built.text, /此后还有 至少 12 条用户消息没整理进来/);
  built = build({ cards: [], userTurns: userTurns.slice(0, 3), decisions: { path: '/b/d.md', mtime: NOW - 3600_000, text: '## 当前目标\n- 发 1.2\n' } });
  assert.doesNotMatch(built.text, /更早的没有统计在内|至少/);
  // a notes file that could not be read is not "nothing recorded"
  built = build({ cards: [], decisions: { path: '/b/d.md', text: '', mtime: 0, error: '文件超过 512KB，没有读' } });
  assert.match(built.brief, /来源 \/b\/d\.md（文件超过 512KB，没有读，下面各项待核实）/);
  assert.doesNotMatch(built.text, /还没有这份文件/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-big-notes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.agents', 'boards'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'boards', H.DECISIONS_FILE), '## 暂停/取消/暂不启动\n- 别动 Windows\n' + '填充\n'.repeat(200_000));
  const written = Seats.handoff(home, path.join(home, 'deck'), { colId: 'cap', tasks: [], reason: 'refresh' }, {});
  assert.match(written.text, /文件超过 512KB，没有读，下面各项待核实/);
  // more branches or files than a line shows
  const f = fixture(t);
  const card = f.add({ title: '改了很多分支的' }); f.bind(card.id, 'a1', 's1'); f.event(card.id, 'started', '', 'a1', 's1');
  built = build({ cards: f.cards(), sessions: [session('s1')], dispatches: [record('s1', 'working', { boardId: card.id, boardAttempt: 'a1',
    progress: Array.from({ length: 8 }, (_, i) => `feat/branch-${i}`).join(' ') })] });
  assert.match(built.file('delivery.md'), /分支 feat\/branch-0、[^\n]*feat\/branch-5｜还有没列出的，见回执原文/);
  assert.equal(H.refsIn('feat/a', []).more, false);
  // the note a new Captain gets lists twenty tasks and says how many it left out
  const active = Array.from({ length: 27 }, (_, i) => ({ title: '活 ' + i, colId: 'c' + i, status: 'working' }));
  const note = M.resetNote('cap-old', active, 'relay');
  assert.equal(note.split('\n').filter((l) => /^ {3}- 「活 \d+」/.test(l)).length, 20);
  assert.match(note, /另有 7 件没列在这里，完整清单看交接目录里的 tasks.md。/);
  assert.doesNotMatch(M.resetNote('cap-old', active.slice(0, 20), 'relay'), /另有/);
  // the records themselves: when the list is at its cap, the page says finished ones were dropped
  const records = Array.from({ length: 120 }, (_, i) => record('s-old-' + i, 'done', { receipt: receipt('完成') }));
  assert.match(build({ cards: [], dispatches: records, dispatchCap: 120 }).text, /派活记录：本快照有 120 条。未结束的全部保留；已结束的只留最近的/);
  assert.doesNotMatch(build({ cards: [], dispatches: records.slice(0, 50), dispatchCap: 120 }).text, /派活记录：本快照/);
});

// Forty cards in every state, receipts, a notes file and twelve long user messages: the overview must fit
// whatever the limit, and nothing unfinished may become impossible to find.
function crowded(t) {
  const f = fixture(t);
  const ids = [], questions = [];
  const long = '这是一段很长的回执，'.repeat(60);
  const dispatches = [], sessions = [];
  for (let i = 0; i < 40; i++) {
    const card = f.add({ title: `第 ${i} 张卡：` + '标题很长'.repeat(12) });
    ids.push(card.id);
    if (i % 4 === 0) continue;   // never started
    f.bind(card.id, 'a' + i, 's' + i);
    if (i % 4 === 1) { f.event(card.id, 'started', '', 'a' + i, 's' + i); dispatches.push(record('s' + i, 'working', { boardId: card.id, boardAttempt: 'a' + i, progress: long })); sessions.push(session('s' + i)); }
    if (i % 4 === 2) { f.event(card.id, 'ask', `第 ${i} 张要用户定：选方案甲还是乙？`, 'a' + i, 's' + i); questions.push(`第 ${i} 张要用户定：选方案甲还是乙？`); }
    if (i % 4 === 3) { f.event(card.id, 'failed', long, 'a' + i, 's' + i); f.live.push({ id: 's' + i, archived: true }); f.bind(card.id, 'b' + i, 't' + i); f.event(card.id, 'failed', long, 'b' + i, 't' + i); }
  }
  const blocked = f.add({ title: '被挡住的', depends_on: [ids[0]] }); ids.push(blocked.id);
  const limits = ['[10-04 22:50] Windows 升级先停，等用户回来', '[10-04 23:10] 不许动登录凭证'];
  const decisions = { path: '/b/decisions.md', mtime: NOW - 6.5 * 60_000, text: `## 暂停/取消/暂不启动\n${limits.map((l) => '- ' + l).join('\n')}\n## 有效决定\n- [10-04 21:00] 1.1.11 之后版本号进一位\n## 等用户决定\n- 是否买第二张重置卡｜不阻塞\n` };
  const userTurns = Array.from({ length: 12 }, (_, i) => ({ ts: NOW - (12 - i) * 60_000, text: `第 ${i} 条用户消息 ` + '说了很多话'.repeat(80), sourceId: 'cap-old' }));
  const snapshot = { reason: 'relay', cards: f.cards(), dispatches, sessions, decisions, userTurns, captain: { previousId: 'cap-old', gen: 7 },
    pending: [{ taskId: 'k', colId: 's1', title: '回执', summary: long }], unconfirmed: [{ receiptId: 'r-1', colId: 's5', title: '上任取走的', summary: long }] };
  return { snapshot, ids, questions, limits };
}

test('the overview has a hard limit; whatever is squeezed out of it is still on file, with its count and where to read it', (t) => {
  const { snapshot, ids, questions, limits } = crowded(t);
  for (const budget of [20000, 6000, 3000]) {
    const built = build({ ...snapshot, budget });
    assert.ok(built.length <= budget, `${built.length} fits ${budget}`); assert.equal(built.over, false);
    assert.equal(built.length, Array.from(built.brief).length, 'the length it reports is the page\'s own');
    const { stats } = built.state;
    // every unfinished card, question, receipt and pause is findable: in a detail file, or on the page
    for (const id of ids) assert.ok(built.file('tasks.md').includes(id), `${id} in tasks.md at ${budget}`);
    for (const q of questions) assert.ok(built.file('waiting.md').includes(q), q);
    for (const limit of limits) assert.ok(built.brief.includes(limit) || built.file('decisions-history.md').includes(limit), limit);
    assert.match(built.file('needs-user.md'), /是否买第二张重置卡｜不阻塞/);
    assert.equal(cardLines(built).length, stats.cards + stats.loose);
    // the page itself says how many, and where
    assert.match(built.brief, new RegExp(`未完成任务 ${stats.cards + stats.loose} 条（返工 ${stats.rework}｜待验收 ${stats.review}｜执行中 ${stats.doing}｜暂停 ${stats.paused}｜待执行 ${stats.todo}）→ tasks\\.md`));
    assert.match(built.brief, new RegExp(`队员提问 ${stats.asks} 条｜未读回执 ${stats.pending} 条｜已取走未确认 ${stats.unconfirmed} 条｜矛盾 ${stats.conflicts} 条｜等队长拍板 ${built.state.forCaptain.length} 条 → waiting\\.md｜等用户决定 1 条 → needs-user\\.md`));
    assert.match(built.brief, /暂停\/取消\/暂不启动 2 条/);
    assert.equal(stats.asks, questions.length, 'each question once, however many places hold it');
    // the contents page names each file, how long it is and when to read it
    for (const f of built.files) assert.match(built.brief, new RegExp(`- ${f.name.replace('.', '\\.')}｜${String(f.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} 字｜[^\\n]*｜[^\\n]*读\\n`), f.name);
  }
  // roomy: nothing squeezed. tight: squeezed, and says so.
  assert.deepEqual(build({ ...snapshot, budget: 20000 }).cuts, []);
  const tight = build({ ...snapshot, budget: 3000 });
  assert.ok(tight.cuts.length > 0); assert.match(tight.brief, /为了放进 3,000 字，缩短了：/);
  // the detail files are never squeezed by the limit
  assert.equal(build({ ...snapshot, budget: 20000 }).file('tasks.md'), tight.file('tasks.md'));
  // the setting is clamped, not trusted
  assert.equal(M.handoffBudget(), 6000); assert.equal(M.handoffBudget(1), 3000); assert.equal(M.handoffBudget(1e9), 20000); assert.equal(M.handoffBudget('abc'), 6000);
  assert.equal(build({ ...snapshot, budget: 1 }).limit, 3000);
});

test('what is given up when the overview does not fit: the user\'s latest words go last', (t) => {
  const { snapshot } = crowded(t);
  const order = H.SQUEEZE.map(([key]) => key);
  // every step is taken in the fixed order, and the user's words are touched only after all the others
  const tight = build({ ...snapshot, budget: 3000 });
  assert.deepEqual(tight.cuts, order.slice(0, tight.cuts.length));
  assert.equal(order.indexOf('w'), order.findIndex((k, i) => k === 'w' && order.slice(0, i).every((x) => x !== 'w')));
  assert.ok(order.slice(0, order.indexOf('w')).every((k) => k !== 'w') && order.slice(order.indexOf('w')).every((k) => k === 'w'));
  // a limit that only the first steps can meet still shows the whole run of the user's messages
  const some = build({ ...snapshot, budget: 4200 });
  assert.ok(!some.cuts.includes('w'), some.cuts.join());
  assert.equal(some.brief.split('\n').filter((l) => /^- 10-04 \d\d:\d\d(?: 未整理)?｜「第 \d+ 条用户消息/.test(l)).length, 8);
  // at the smallest page, the latest message is still there, the oldest excerpts are what went
  assert.match(tight.brief, /第 11 条用户消息/); assert.ok(!tight.brief.includes('第 0 条用户消息'));
  assert.match(tight.brief, /read --id cap-old --find "第"/);
  // and the older ones are one file away
  assert.match(tight.file('user-messages.md'), /第 0 条用户消息/);
  // five hundred cards, three hundred receipts: still one page, still the user's words, still every count
  const f = fixture(t);
  for (let i = 0; i < 500; i++) f.add({ title: `卡 ${i}` });
  assert.equal(f.cards().length, 500, 'the stress case really builds five hundred cards');
  const pending = Array.from({ length: 300 }, (_, i) => ({ taskId: 'k' + i, colId: 's' + i, title: '回执' + i, summary: '做完了' }));
  const big = build({ ...snapshot, cards: f.cards(), pending, budget: 3000 });
  assert.ok(big.length <= 3000, String(big.length)); assert.equal(big.over, false);
  assert.match(big.brief, /第 11 条用户消息/); assert.equal(big.state.cards.length, 500); assert.match(big.brief, new RegExp(`未完成任务 ${big.state.stats.cards + big.state.stats.loose} 条`)); assert.match(big.brief, /未读回执 300 条/);
  assert.ok(big.file('tasks.md').includes('卡 499'), 'the last of the five hundred is on file');
});

// What the user stopped must never be lost on the way to the next Captain, or it gets dispatched again.
// A pause entry is "[time] what｜how far it reaches｜pointer": the page keeps the first two parts to the end.
const pauseText = (i, words = 30) => `[10-0${(i % 9) + 1} 12:00] 禁止重启-${i}｜适用范围：范围-${i}${'，很长的说明'.repeat(words)}｜read --id cap-old --find "禁止${i}"`;
const onPage = (built, i, line) => built.brief.split('\n').filter((l) => l.includes(`L${line}｜`) && l.includes(`禁止重启-${i}`) && l.includes(`范围-${i}`)).length;

test('every pause, cancellation and stopped task stays on the overview whatever the limit: only the words about each get shorter', (t) => {
  const { snapshot } = crowded(t);
  // the Captain stopped these two; the board still has them as ordinary unfinished cards
  const g = fixture(t);
  const halted = [];
  const dispatches = [...snapshot.dispatches], sessions = [...snapshot.sessions];
  for (const name of ['Windows 升级', '叫停的另一张']) {
    const card = g.add({ title: name + '：' + '很长的标题'.repeat(10) });
    g.bind(card.id, 'u-' + card.id, 's-' + card.id); g.event(card.id, 'started', '', 'u-' + card.id, 's-' + card.id);
    dispatches.push(record('s-' + card.id, 'stopped', { boardId: card.id, boardAttempt: 'u-' + card.id, receipt: receipt('队长已请求中断当前操作。', { source: 'captain-stop' }) }));
    sessions.push(session('s-' + card.id, 'done'));
    halted.push(card.id);
  }
  // one the Captain stopped that never had a card
  dispatches.push(record('s-loose', 'stopped', { title: '没挂卡的活', receipt: receipt('队长已请求中断当前操作。', { source: 'captain-stop' }) }));
  sessions.push(session('s-loose', 'done'));
  // nine pauses (the page used to list the first eight); line 1 is the heading
  const pauses = Array.from({ length: 9 }, (_, i) => pauseText(i + 1));
  const decisions = { path: '/b/decisions.md', mtime: NOW - 1000, text: '## 暂停/取消/暂不启动\n' + pauses.map((x) => '- ' + x).join('\n') + '\n## 有效决定\n- [10-04 21:00] 1.1.11 之后版本号进一位\n' };
  for (const budget of [60000, 20000, 6000, 3000]) {
    const built = build({ ...snapshot, cards: [...snapshot.cards, ...g.cards()], dispatches, sessions, decisions, budget });
    // thirteen paused tasks and nine pauses may be more than the smallest limit can hold: then the page says it is over, and still holds every one
    if (budget >= 6000) { assert.equal(built.over, false, `fits ${budget}`); assert.ok(built.length <= budget); }
    else if (built.over) assert.match(built.brief, /已超出预算：未完成任务、阻塞、限制和待决定事项一条没删/);
    else assert.ok(built.length <= budget);
    for (let i = 1; i <= 9; i++) assert.equal(onPage(built, i, i + 1), 1, `pause ${i} on the page at ${budget}: what it stops, how far, and its line`);
    assert.match(built.brief, /暂停\/取消\/暂不启动 9 条/);
    for (const id of halted) assert.ok(built.brief.split('\n').some((l) => l.includes(id) && /叫停/.test(l)), `stopped ${id} on the page at ${budget}`);
    assert.ok(built.brief.split('\n').some((l) => l.includes('没挂卡 s-loose') && /叫停/.test(l)), `a stopped task with no card at ${budget}`);
    // the three the Captain stopped, and the crowded snapshot's own that wait on the Captain's check (the next test says more about those)
    assert.match(built.brief, new RegExp(`暂停中的任务 ${3 + built.state.cards.filter((c) => ['needs_check', 'held'].includes(c.code)).length} 条`));
    // every task the program derives as stopped by the Captain is named on the page
    const stopped = [...built.state.cards.filter((c) => c.code === 'stopped').map((c) => c.id), ...built.state.loose.filter((l) => l.halted).map((l) => l.id)];
    assert.equal(stopped.length, 3);
    for (const id of stopped) assert.ok(built.brief.includes(id), `${id} at ${budget}`);
    assert.ok(built.file('decisions-history.md').includes(pauses[8].replace(/\s+/g, ' ')), 'the full text is in the history file');
  }
  // the reviewer's smallest case
  const rows = Array.from({ length: 9 }, (_, i) => `- 禁止重启-${i + 1}`);
  const bare = build({ budget: 6000, decisions: { text: '## 暂停/取消\n' + rows.join('\n') } });
  for (let i = 1; i <= 9; i++) assert.ok(bare.brief.includes('禁止重启-' + i), `禁止重启-${i}`);
  // so many that the page cannot hold them in its limit: still every one of them, and it says it is over
  const many = Array.from({ length: 120 }, (_, i) => pauseText(i + 1, 3));
  const crammed = build({ ...snapshot, decisions: { path: '/b/decisions.md', mtime: NOW - 1000, text: '## 暂停/取消/暂不启动\n' + many.map((x) => '- ' + x).join('\n') + '\n' }, budget: 3000 });
  for (let i = 1; i <= 120; i++) assert.equal(onPage(crammed, i, i + 1), 1, `pause ${i} of 120`);
  assert.equal(crammed.over, true); assert.match(crammed.brief, /已超出预算：未完成任务、阻塞、限制和待决定事项一条没删/);
  assert.match(crammed.brief, /暂停\/取消\/暂不启动 120 条/);
  // squeezing never removes the block: no step sets it to nothing
  assert.ok(H.SQUEEZE.filter(([key]) => key === 'paused').every(([, level]) => level > 0));
});

// Paused tasks that wait on the Captain are as easy to forget, or to dispatch twice, as the stopped ones.
test('paused tasks waiting on the Captain (to check, hung after two failures) stay on the overview whatever the limit, with project, title and where they are stuck', (t) => {
  const { snapshot } = crowded(t);   // forty cards, receipts and twelve long messages: the page is under real pressure
  const g = fixture(t);
  const check = g.add({ project: 'fuqing', title: '小福助手模型替换：' + '很长的标题'.repeat(10) });
  g.bind(check.id, 'c1', 's-c1'); g.event(check.id, 'fallback', '', 'c1', 's-c1');           // the session ended without a receipt
  const hung = g.add({ project: 'web-research', title: '让 Muse 操控网页：' + '很长的标题'.repeat(10) });
  g.bind(hung.id, 'h1', 's-h1'); g.event(hung.id, 'failed', '失败一', 'h1', 's-h1'); g.live.push({ id: 's-h1', archived: true });
  g.bind(hung.id, 'h2', 's-h2'); g.event(hung.id, 'failed', '失败二', 'h2', 's-h2');
  const cards = [...snapshot.cards, ...g.cards()];
  for (const budget of [60000, 20000, 6000, 4200, 3000]) {
    const built = build({ ...snapshot, cards, archivedIds: ['s-h1', 's-h2'], budget });
    assert.equal(built.over, false, `fits ${budget}`); assert.ok(built.length <= budget);
    const line = (id) => built.brief.split('\n').filter((l) => l.includes(id));
    assert.equal(built.state.cards.find((c) => c.id === check.id).code, 'needs_check');
    assert.equal(built.state.cards.find((c) => c.id === hung.id).code, 'held');
    for (const [card, project, head, stuck] of [[check, 'fuqing', '小福助手模型', '待队长核实'], [hung, 'web-research', '让 Muse', '连续失败 2 次，已挂起']]) {
      assert.ok(line(card.id).some((l) => l.includes(project) && l.includes(head) && l.includes(stuck)), `${card.id} (${head}) with project, title and where it is stuck at ${budget}`);
    }
    // every paused task that waits on the Captain, the crowded snapshot's own included, is named on the page
    const pinned = built.state.cards.filter((c) => ['needs_check', 'held'].includes(c.code));
    assert.ok(pinned.length >= 12);
    for (const c of pinned) assert.ok(line(c.id).some((l) => l.includes(c.project)), `${c.id} (${c.code}) at ${budget}`);
    assert.match(built.brief, new RegExp(`暂停中的任务 ${pinned.length} 条`));
  }
});

test('decisions-history.md and delivery.md list every entry of the decisions file, one line with its line number each; the contents page counts what is really listed', () => {
  const lines = [], found = [];
  const add = (title, count, tag) => { lines.push('## ' + title); for (let i = 0; i < count; i++) { found.push({ tag, i, line: lines.length + 1 }); lines.push(`- [09-1${i % 10} 10:0${i % 6}] ${tag}-${i}｜${'细节很多'.repeat(40)}`); } };
  // every section well past the caps it used to have (40, 40, 99, 60 and 30 lines)
  add('当前目标', 90, '目标'); add('授权范围', 70, '授权'); add('暂停/取消/暂不启动', 120, '暂停'); add('有效决定', 130, '决定'); add('其他记录', 80, '其他'); add('交付状态', 100, '交付'); add('等用户决定', 5, '问用户');
  const text = lines.join('\n') + '\n';
  const built = build({ cards: [], decisions: { path: '/b/decisions.md', mtime: NOW - 1000, text }, budget: 20000 });
  const history = built.file('decisions-history.md'), delivery = built.file('delivery.md');
  const listed = (file, re) => (file.match(re) || []).length;
  const inHistory = found.filter((e) => e.tag !== '交付' && e.tag !== '问用户');
  assert.equal(listed(history, /^- L\d+｜/gm), inHistory.length, 'one line for every entry, no cap');
  assert.equal(listed(delivery, /^ +- L\d+｜/gm), 100, 'every delivery record is a line');
  for (const e of inHistory) assert.ok(history.includes(`- L${e.line}｜`) && new RegExp(`- L${e.line}｜[^\\n]*${e.tag}-${e.i}｜`).test(history), `${e.tag}-${e.i} at L${e.line}`);
  for (const e of found.filter((e) => e.tag === '交付')) assert.match(delivery, new RegExp(`- L${e.line}｜[^\\n]*交付-${e.i}｜`));
  assert.doesNotMatch(history, /还有 \d+ 条更早的没列/); assert.doesNotMatch(delivery, /还有 \d+ 条更早的没列/);
  // the contents page says how many the file lists, and that is the number it lists
  const row = (name) => built.brief.split('\n').find((l) => l.startsWith(`- ${name}｜`));
  assert.match(row('delivery.md'), /，100 条记录｜/);
  assert.match(history, new RegExp(`本文件逐条列出 ${inHistory.length} 条`));
  // the file's own count and the source total are told apart: the rest are in the files named
  assert.match(row('decisions-history.md'), new RegExp(`，逐条列出 ${inHistory.length} 条（决定文件共 ${found.length} 条，其余在 delivery\\.md、needs-user\\.md）｜`));
  // the reviewer's smallest case: 75 decisions
  const seventy = build({ cards: [], decisions: { text: '## 有效决定\n' + Array.from({ length: 75 }, (_, i) => '- 决定-' + i).join('\n') } });
  assert.equal(listed(seventy.file('decisions-history.md'), /^- L\d+｜/gm), 75);
  assert.match(seventy.brief.split('\n').find((l) => l.startsWith('- decisions-history.md｜')), /，逐条列出 75 条（决定文件共 75 条，其余在 delivery\.md、needs-user\.md）｜/);
});

test('the Captain\'s decisions file: only the newest and the entries marked as lasting are quoted; older ones are a line and a pointer', () => {
  const lines = ['## 有效决定'];
  for (let i = 1; i <= 50; i++) lines.push(`- [09-${String(10 + (i % 20)).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}] 旧决定编号${i}｜${'细节很多'.repeat(40)}`);
  lines.push('- **[10-03 09:00 用户决定，长期有效]** 派活只看 5 小时额度，周额度不用管', '- [10-04 20:00] 最新决定甲', '- [10-04 21:00] 最新决定乙', '- [10-04 22:00] 最新决定丙', '- [10-02 08:00] 较新的决定丁');
  lines.push('## 暂停/取消/暂不启动', '- [10-04 22:50] 先别动 Windows', '## 当前目标', '- [10-04 12:00] 发 1.2');
  const text = lines.join('\n') + '\n';
  const built = build({ cards: [], decisions: { path: '/b/decisions.md', mtime: NOW - 1000, text }, budget: 6000 });
  // quoted: the lasting one, the three newest, the pause, nothing old
  assert.match(built.brief, /长期有效 1 条：\n {2}- L52｜\*\*\[10-03 09:00 用户决定，长期有效\]\*\* 派活只看 5 小时额度/);
  for (const n of ['最新决定甲', '最新决定乙', '最新决定丙']) assert.ok(built.brief.includes(n), n);
  assert.ok(!built.brief.includes('最新决定丁') || built.brief.includes('较新的决定丁') === false);
  assert.ok(!built.brief.includes('旧决定编号'), 'the old ones are not pasted in');
  assert.match(built.brief, /先别动 Windows/);
  assert.ok(built.length < 6000 && built.length < Array.from(text).length / 2);
  // each older entry is on file, as one line with the line it has in the decisions file
  const history = built.file('decisions-history.md');
  for (let i = 1; i <= 50; i++) {
    const m = new RegExp(`- L(\\d+)｜\\[09-\\d\\d 10:\\d\\d\\] 旧决定编号${i}｜`).exec(history);
    assert.ok(m, '旧决定编号' + i);
    assert.match(text.split('\n')[Number(m[1]) - 1], new RegExp(`旧决定编号${i}｜`), 'the pointer is the real line');
  }
  assert.match(history, /较新的决定丁/);
  assert.ok(!history.includes('细节很多'.repeat(40)), 'a title line, not the whole entry');
  // the file itself is not changed or parsed away: entries keep their line numbers across comments
  const entries = H.parseDecisionEntries('# t\n<!-- a\nb -->\n## 有效决定\n- x\n\n- y\n');
  assert.deepEqual(entries.decisions, [{ text: 'x', line: 5 }, { text: 'y', line: 7 }]);
  // a snapshot section is not the list of what is paused
  assert.equal(H.parseDecisions('## 暂停时的现场（10-05 17:05）\n- 流水一\n## 暂停/取消\n- 别动 A\n').paused.length, 1);
});

test('the profile of the person served is only pointed at, with its age; the file is never quoted, and no file means no line', () => {
  const at = (days) => build({ cards: [], aboutUser: { mtime: NOW - days * 86400_000, text: '# 关于用户\n- 秘密偏好不该出现在总览' } });
  const fresh = at(3);
  assert.match(fresh.brief, /\n关于用户：~\/\.agents\/memory\/about-user\.md（短档案）及 about-user\/ 下按主题的详档，需要了解他的偏好、近况时再读｜最后修改 10-01 23:19\n/);
  assert.ok(fresh.brief.indexOf('关于用户：') < fresh.brief.indexOf('## 1. 用户最近的原话'), 'right after the header');
  assert.ok(!fresh.text.includes('秘密偏好'), 'its contents are not in the page or any detail file');
  assert.doesNotMatch(fresh.brief, /可能过期/);
  assert.match(at(20).brief, /最后修改 09-14 23:19（可能过期：已 20 天没更新）/);
  assert.doesNotMatch(at(14).brief, /可能过期/); assert.match(at(15).brief, /可能过期/);
  for (const none of [build({ cards: [] }), build({ cards: [], aboutUser: null })]) assert.doesNotMatch(none.brief, /关于用户|about-user/);
  // one line, whatever the pressure: it is not something the limit squeezes
  const tight = build({ cards: [], aboutUser: { mtime: NOW }, budget: 3000, userTurns: Array.from({ length: 8 }, (_, i) => ({ ts: NOW - i * 60_000, text: `第 ${i} 句 ` + '话'.repeat(300), sourceId: 'c' })) });
  assert.ok(tight.length <= 3000); assert.match(tight.brief, /关于用户：/); assert.match(tight.brief, /第 0 句/);
  assert.ok(!H.SQUEEZE.some(([key]) => key === 'about'));
});

test('the writer points at the profile where the shared memory keeps it (modification time only), and puts the detail files beside the overview', (t) => {
  const f = fixture(t);
  const home = path.join(f.root, 'home'), userData = path.join(f.root, 'deck');
  const payload = { colId: 'captain-now', reason: 'refresh', now: NOW, timeZone: 'Asia/Shanghai', tasks: [], sessions: [], captain: { previousId: 'cap-old', gen: 3 } };
  const options = { cards: () => f.cards(), tasksDir: f.store.dir };
  const bare = Seats.handoff(home, userData, payload, options);
  assert.doesNotMatch(bare.text, /关于用户/);
  fs.mkdirSync(path.join(home, '.agents', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'memory', 'about-user.md'), '- 他在找暑期实习\n');
  const mtime = new Date('2026-10-04T10:00:00Z'); fs.utimesSync(path.join(home, '.agents', 'memory', 'about-user.md'), mtime, mtime);
  const built = Seats.handoff(home, userData, payload, options);
  assert.match(built.text, /\n关于用户：~\/\.agents\/memory\/about-user\.md（短档案）[^\n]*｜最后修改 10-04 18:00\n/);
  assert.ok(!built.text.includes('暑期实习'), 'pointed at, not read into the handoff');
  for (const file of H.DETAIL_FILES) assert.ok(fs.statSync(path.join(built.dir, file.name)).size > 0, file.name);
  assert.equal(fs.readdirSync(built.dir).length, H.DETAIL_FILES.length, 'nothing else, no temp files left behind');
  assert.equal(built.dir, path.join(path.dirname(built.path), 'agentdeck-captain-handoff'));
  assert.ok(built.text.includes(built.dir), 'the page says where the files are');
});

test('states are told apart: the session, the task, the verdict and the delivery each speak for themselves', (t) => {
  const f = fixture(t);
  // session ended (terminal idle), task still doing, no receipt: not "done"
  const quiet = f.add({ title: '悄悄停了的', verify: true });
  f.bind(quiet.id, 'a1', 's-quiet'); f.event(quiet.id, 'started', '', 'a1', 's-quiet');
  // execution delivered, verdict still open
  const waiting = f.add({ title: '等审查的', verify: true });
  f.bind(waiting.id, 'b1', 's-exec'); f.event(waiting.id, 'complete', '已提交 abc1234 并推送 feat/login，报告在附件。', 'b1', 's-exec', 'command', ['/reports/login/report.md']);
  // held after two failures: a pause for the Captain, not for the user
  const held = f.add({ title: '连败两次的' });
  f.bind(held.id, 'h1', 's-h1'); f.event(held.id, 'failed', '失败一', 'h1', 's-h1'); f.live.push({ id: 's-h1', archived: true });
  f.bind(held.id, 'h2', 's-h2'); f.event(held.id, 'failed', '失败二', 'h2', 's-h2');
  // being continued by the app after a restart
  const resumed = f.add({ title: '重启续接的' });
  f.bind(resumed.id, 'r1', 's-res'); f.event(resumed.id, 'started', '', 'r1', 's-res');
  const built = build({ cards: f.cards(), platform: 'darwin', host: 'mac.local', appVersion: '1.1.11', archivedIds: ['s-h1', 's-h2', 's-exec'],
    sessions: [session('s-quiet', 'done'), session('s-res', 'paused')],
    dispatches: [
      record('s-quiet', 'done', { boardId: quiet.id, boardAttempt: 'a1', receipt: receipt('后来又给这个会话发了新指令，结果看后面的卡片。') }),
      record('s-exec', 'done', { boardId: waiting.id, boardAttempt: 'b1', receipt: receipt('已提交 abc1234 并推送 feat/login，报告在附件。', { files: ['/reports/login/report.md'] }) }),
      record('s-res', 'paused', { boardId: resumed.id, boardAttempt: 'r1', restartHold: true, receipt: { summary: R.checkpointSummary(), checkpoint: true, explicit: true, failed: '', files: [], source: 'restart' } }),
    ],
    decisions: { path: '/b/d.md', mtime: NOW, text: '## 交付状态\n- agentdeck 1.1.11｜release/1.1.11｜e6794ae｜已提交 是｜已合并 否｜已打包 是｜已安装 Mac：是；Windows：待核实\n' } });
  const by = (card) => built.state.cards.find((c) => c.id === card.id);
  // a session whose only record is bookkeeping and whose terminal is idle is not an executor
  assert.equal(by(quiet).code, 'orphan'); assert.match(by(quiet).conflicts[0], /卡片仍绑定 s-quiet，但它已结束·终端空闲/);
  assert.match(by(quiet).next, /先核实[^\n]*确认没人在做，再在原卡下接手：new --task-id \S+，任务里写清前次结果和剩余工作/);
  // nothing a shell would expand is pasted into a command the Captain may run: the card id alone names the project
  const odd = f.add({ project: '$(touch x)', title: '怪项目' });
  const oddText = build({ cards: f.cards().filter((c) => c.id === odd.id) }).text;
  assert.ok(!/--project/.test(oddText)); assert.match(oddText, /new --task-id 卡片id）/);
  assert.equal(by(waiting).group, 'review'); assert.equal(by(waiting).verdict.code, 'pending'); assert.match(by(waiting).label, /待验收（等审查会话）/);
  assert.match(by(waiting).next, /程序会自动开一个不同提供方的审查会话，不要自己开/);
  assert.equal(by(held).code, 'held'); assert.equal(by(held).group, 'paused');
  assert.equal(by(resumed).code, 'resuming'); assert.match(by(resumed).next, /程序正在自动续接[^\n]*不要重派/);
  assert.ok(!by(resumed).result.includes('AGENTDECK-CHECKPOINT'), 'the app\'s own restart marker is not a result');
  const text = built.text;
  assert.match(text, /执行 s-res（被中断·重启后程序自动续接中）/);
  // delivery: what this machine runs is a fact; what a receipt claims is a claim; other machines are unknown
  assert.match(text, /本机：Mac mac\.local，正在运行 AgentDeck 1\.1\.11（程序自报，取自本快照）。其他机器：待核实，本机看不到/);
  assert.match(built.file('delivery.md'), /队长记录的交付状态[^\n]*：\n {2}- L2｜agentdeck 1\.1\.11｜release\/1\.1\.11｜e6794ae｜已提交 是｜已合并 否｜已打包 是｜已安装 Mac：是；Windows：待核实/);
  assert.match(text, /队员自述，程序没有核实；提交、合并、打包、安装各到哪一步都按待核实处理/);
  assert.match(text, new RegExp(`${waiting.id}｜分支 feat/login｜提交 abc1234｜产物 /reports/login/report\\.md`));
  assert.match(text, /等队长拍板 \d+ 条（已有授权能解决，不要转给用户）/);
  assert.deepEqual(H.refsIn('提交 7eaf2c1 推到 feat/arch-a；卡 t-a3f00db4-6ef2 和会话 c1791172885031680 不算', []).commits, ['7eaf2c1']);
});

test('a task still running names the branch and commit from its progress, as a claim to check', (t) => {
  const f = fixture(t);
  const card = f.add({ title: '在跑的' });
  f.bind(card.id, 'a1', 's-run'); f.event(card.id, 'started', '', 'a1', 's-run');
  const old = f.add({ title: '早就做完的' });
  f.bind(old.id, 'o1', 's-old'); f.event(old.id, 'complete', '已推送 feat/old-work 1234abc', 'o1', 's-old');
  const built = build({ cards: f.cards(), sessions: [session('s-run')], archivedIds: ['s-old'], dispatches: [
    record('s-old', 'done', { boardId: old.id, boardAttempt: 'o1', progress: '在 feat/old-work 上', receipt: receipt('已推送 feat/old-work 1234abc') }),
    record('s-run', 'working', { boardId: card.id, boardAttempt: 'a1', progress: '已合入 release/1.2.0，提交 32918b1 推到 feat/relay-handoff-v2，报告还没写' }),
  ] });
  assert.match(built.file('delivery.md'), new RegExp(`未完成任务的回执和进度里提到的分支、提交、产物（队员自述，程序没有核实；提交、合并、打包、安装各到哪一步都按待核实处理）：\\n {2}- ${card.id}｜分支 release/1\\.2\\.0、feat/relay-handoff-v2｜提交 32918b1`));
  assert.ok(!built.file('delivery.md').includes('feat/old-work'), 'a finished card is not delivery state to chase');
});

test('quota, relay roles and old messages come with their sampling time and are never restated as current', () => {
  const built = build({ reason: 'relay', captain: { previousId: 'cap-old', gen: 18, nextGen: 19, message: '永动机自动轮换：US → CN；每周剩余 3% ≤ 3%；10/4/2026, 11:19:52 PM', rotation: '永动机自动轮换开，席位顺序 us2 → us → cn，Claude 席位都用尽时交给 ChatGPT' },
    userTurns: [{ ts: NOW - 120_000, text: '一步。\n- 提供相关报告、产物和历史对话的查询入口。' + '很长'.repeat(900) + '（全文 2140 字，见附件）', longFile: '/u/long-prompts/prompt-abc.txt', sourceId: 'cap-old' }] });
  const text = built.text;
  assert.match(text, /生成：2026-10-04 23:19（America\/Los_Angeles，UTC-07:00）；触发：席位 Relay；永动机自动轮换：US → CN；每周剩余 3% ≤ 3%/);
  assert.match(text, /额度百分比是轮换那一刻的采样（来源：永动机轮换判定），只说明为什么轮换；现在的额度用 quota 查，不要拿它推算/);
  assert.match(text, /上任会话：cap-old（read --id cap-old 按需读）/);
  assert.match(text, /快照版本：队长代次 gen 18 → 19/);
  assert.match(text, /队长轮换：永动机自动轮换开，席位顺序 us2 → us → cn[^\n]*谁接任队长只看这项设置，和队员用什么模型无关；交接不改它/);
  // a long user message is a pointer, not a 600-character dump
  const line = built.brief.split('\n').find((l) => l.includes('一步。'));
  assert.ok(line.length < 520, String(line.length));
  assert.match(line, /10-04 23:17 未整理｜「一步。 - 提供相关报告[^」]*…」（共 \d+ 字，全文 \/u\/long-prompts\/prompt-abc\.txt）｜read --id cap-old --find "一步。"/);
  assert.match(built.brief, /暂停\/取消\/暂不启动 0 条/);
  // commands are spelled once, the way the CLI takes them
  assert.match(text, /命令：下文的 handoff、ledger、read 等都接在 node "\$AGENTDECK_BOARD_CLI" 后面运行/);
  assert.ok(!text.includes('board-cli read'));
});

test('the Captain\'s notes are read by heading, placeholders and comments are not decisions', () => {
  assert.deepEqual(H.parseDecisions(H.DECISIONS_TEMPLATE), { goal: [], scope: [], paused: [], decisions: [], delivery: [], user: [], other: [] });
  const notes = H.parseDecisions('# 标题\n## 当前目标\n- 发 1.2\n- 无\n## 授权范围\n* 合并打包安装不用问\n## 暂停/取消/暂不启动\n<!-- - 示例 -->\n- （无）\n## 有效决定\n- [22:00] A｜取代 B\n## 交付状态\n- 1.1.11 已安装 Mac\n## 等用户决定\n- 买不买重置卡\n## 杂项\n- 别的\n');
  assert.deepEqual(notes, { goal: ['发 1.2'], scope: ['合并打包安装不用问'], paused: [], decisions: ['[22:00] A｜取代 B'], delivery: ['1.1.11 已安装 Mac'], user: ['买不买重置卡'], other: ['别的'] });
});

test('the handoff file is the app\'s, the decisions file is the Captain\'s: one is rewritten, the other only read', (t) => {
  const f = fixture(t);
  const home = path.join(f.root, 'home'), userData = path.join(f.root, 'deck');
  const card = f.add({ title: '在做的' }); f.bind(card.id, 'a1', 's1'); f.event(card.id, 'started', '', 'a1', 's1');
  const options = { cards: () => f.cards(), tasksDir: f.store.dir, boardVersion: () => 'abc123', machine: { platform: 'win32', hostname: 'pc', appVersion: '1.2.0' } };
  const payload = { colId: 'captain-now', reason: 'refresh', now: NOW, timeZone: 'Asia/Shanghai', tasks: [record('s1', 'working', { boardId: card.id, boardAttempt: 'a1' })],
    sessions: [session('s1')], captain: { previousId: 'cap-old', gen: 3 }, budget: 20000 };
  const first = Seats.handoff(home, userData, payload, options);
  const dir = path.join(home, '.agents', 'boards');
  assert.equal(first.path, path.join(dir, 'agentdeck-captain-handoff.md'));
  assert.equal(fs.readFileSync(first.path, 'utf8'), first.text);
  assert.equal(first.plan, 'resume');
  const detail = (r, name) => fs.readFileSync(path.join(r.dir, name), 'utf8');
  assert.equal(first.dir, path.join(dir, 'agentdeck-captain-handoff'), 'the detail files sit beside the overview');
  assert.match(first.text, /生成 2026-10-05 14:19（Asia\/Shanghai）/);
  assert.match(detail(first, 'playbook.md'), /生成：2026-10-05 14:19（Asia\/Shanghai，UTC\+08:00）/);
  assert.match(detail(first, 'playbook.md'), /看板版本 abc123/); assert.match(detail(first, 'delivery.md'), /本机：Windows pc，正在运行 AgentDeck 1\.2\.0/);
  assert.match(detail(first, 'playbook.md'), new RegExp(`任务卡原始数据：${f.store.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/<项目>\\.json`));
  // the template is created once for the Captain to fill in
  const notes = path.join(dir, 'agentdeck-captain-decisions.md');
  assert.equal(fs.readFileSync(notes, 'utf8'), H.DECISIONS_TEMPLATE);
  fs.writeFileSync(notes, '## 暂停/取消/暂不启动\n- 先别派新活，等 1.2 装完\n');
  const second = Seats.handoff(home, userData, payload, options);
  assert.equal(fs.readFileSync(notes, 'utf8'), '## 暂停/取消/暂不启动\n- 先别派新活，等 1.2 装完\n', 'never rewritten by the app');
  assert.match(second.text, /暂停\/取消\/暂不启动 1 条[^\n]*：\n {2}- L2｜先别派新活，等 1\.2 装完/); assert.equal(second.plan, 'paused');
  // a board that cannot be read is said out loud; the Captain's own records still go out
  const broken = Seats.handoff(home, userData, payload, { ...options, cards: () => { throw new Error('Task board has invalid JSON or a sync conflict: p.json'); } });
  assert.match(detail(broken, 'tasks.md'), /任务看板读不出来（Task board has invalid JSON or a sync conflict: p\.json）：下面只有队长自己的派活记录，卡片状态待核实/);
  assert.match(detail(broken, 'tasks.md'), /没挂卡｜p｜执行｜执行 s1（运行中）/);
  assert.throws(() => Seats.handoff(home, userData, { ...payload, colId: '../x' }, options), /无效/);
  // open records are never trimmed, so more than the renderer's cap of 120 is a real payload; only an absurd one is refused
  assert.match(Seats.handoff(home, userData, { ...payload, tasks: Array(121).fill({}) }, options).text, /# AgentDeck 队长交接/);
  assert.throws(() => Seats.handoff(home, userData, { ...payload, tasks: Array(5001).fill({}) }, options), /无效/);
  // the Relay checkpoint is the same text, after the old chat is safely on disk
  const chat = { turns: [{ id: 't1', user: '继续', reply: '半句', interrupted: true, ts: NOW }] };
  const file = Seats.checkpoint(home, userData, { ...payload, colId: 'captain-old', chat, relayMessage: 'Relay：CN → US；手动切换' }, options);
  assert.equal(file, first.path);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'chats', 'captain-old.json'), 'utf8')).turns[0].interrupted, true);
  assert.match(fs.readFileSync(file, 'utf8'), /触发：席位 Relay/);
});

test('handoff discovers running and paused discussion IDs from private state without importing topics or drafts', (t) => {
  const f = fixture(t), home = path.join(f.root, 'isolated-home'), userData = path.join(f.root, 'deck');
  const privateRoot = path.join(home, '.agents-state', 'agentdeck', 'discussions');
  const secret = 'PRIVATE-QUESTION-AND-DRAFT-SENTINEL';
  const states = [['d-running', 'running', 2], ['d-paused', 'paused', 3], ['d-complete', 'complete', 2], ['d-cancelled', 'cancelled', 1]];
  for (const [id, status, round] of states) {
    const dir = path.join(privateRoot, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ version: 1, id, status, round, phase: 'review',
      createdAt: new Date(NOW).toISOString(), question: secret, publicQuestion: secret,
      jobs: [{ output: secret, input: secret, rawOutput: secret }], rounds: [], finalAnswer: secret }), { mode: 0o600 });
  }
  // A similarly named shared directory is not a source for private discussions.
  const shared = path.join(home, '.agents', 'boards', 'discussions', 'd-shared-should-not-load');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'run.json'), JSON.stringify({ version: 1, id: 'd-shared-should-not-load', status: 'running', jobs: [], rounds: [] }));
  for (const reason of ['refresh', 'relay', 'restart']) {
    const result = Seats.handoff(home, userData, { colId: 'captain-new', tasks: [], sessions: [], reason, now: NOW,
      captain: { previousId: 'captain-old', gen: 2 }, budget: 20000 }, { cards: () => [] });
    assert.equal(result.plan, 'resume', reason + ': a discussion is authorized unfinished work even without task cards');
    assert.match(result.text, /进行中的讨论（私有原稿不进入交接）/);
    assert.match(result.text, /d-running：running，第 2 轮/);
    assert.match(result.text, /d-paused：paused，第 3 轮/);
    assert.match(result.text, /discuss status --id d-running/);
    assert.match(result.text, /unknown 不自动重发/);
    assert.doesNotMatch(result.text, /d-complete|d-cancelled|d-shared-should-not-load/);
    assert.ok(!result.text.includes(secret), reason + ': neither question nor model prose enters the Captain handoff');
    assert.equal(fs.readFileSync(result.path, 'utf8'), result.text);
  }
  for (const [id] of states.slice(0, 2)) {
    const file = path.join(privateRoot, id, 'run.json'), run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.status = 'complete'; fs.writeFileSync(file, JSON.stringify(run));
  }
  const finished = Seats.handoff(home, userData, { colId: 'captain-new', tasks: [], reason: 'refresh', now: NOW }, { cards: () => [] });
  assert.equal(finished.plan, 'ready'); assert.doesNotMatch(finished.text, /d-running|d-paused|进行中的讨论/);
});

test('a crowded compressed handoff retains every unfinished discussion ID and excludes finished discussions', () => {
  const secret = 'NEVER-IMPORT-PRIVATE-DISCUSSION-PROSE';
  const discussions = Array.from({ length: 60 }, (_, i) => ({ id: `d-unfinished-${String(i).padStart(3, '0')}`,
    status: i % 2 ? 'paused' : 'running', round: i % 3 + 1, question: secret, finalAnswer: secret, jobs: [{ rawOutput: secret }] }));
  const result = build({ cards: [], dispatches: [], sessions: [], budget: 4000,
    discussions: [...discussions, { id: 'd-finished', status: 'complete' }, { id: 'd-cancelled', status: 'cancelled' }] });
  assert.equal(result.state.plan, 'resume');
  assert.equal(result.state.ctx.discussions.length, discussions.length);
  for (const discussion of discussions) {
    assert.ok(result.text.includes(`- ${discussion.id}：`), discussion.id + ': unfinished IDs survive compression');
    assert.ok(result.text.includes(`discuss status --id ${discussion.id}`), discussion.id + ': the new Captain can recover this exact discussion');
  }
  assert.doesNotMatch(result.text, /d-finished|d-cancelled/);
  assert.ok(!result.text.includes(secret));
  assert.equal(result.over, true, 'over-budget state is explicit rather than dropping discussion IDs');
});
