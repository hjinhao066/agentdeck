'use strict';
// A card goes back to execution while a reviewer still holds it: the reviewer said
// 不通过 (automatic rework), the Captain moved it back to doing, or the Captain told
// the worker more (补充 / tell) in the middle of the review. The old reviewer must
// really stop: its terminal is ended and archived through the same path as the
// Captain's `archive --id`, the card drops review_session and the new execution
// attempt is open (attempt_closed=false), so a late verdict from that reviewer
// cannot pass or fail the card. Real TaskStore, real main-session; terminals are stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const AV = require('../auto-verify-core');
const AgentInfo = require('../agent-info');
const ClaudeSeatsCore = require('../claude-seats-core');
const R = require('../restart-resume');
const P = require('../perpetual-captain-core');
const { TaskStore, localSessions } = require('../task-board');

const CLAUDE = 'claude --dangerously-skip-permissions --model claude-opus-5-5';
const CODEX = 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox';
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-review-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const columns = [{ id: 'captain', isMain: true, cmd: CLAUDE }];
  const config = { folders: [], archived: [], captainHistory: [], columns,
    mainSession: { colId: 'captain', tasks: [], pending: [], inflight: [], waitlist: [], gen: 1, cmd: CLAUDE } };
  const store = new TaskStore(path.join(root, 'tasks'), { sessions: () => localSessions(config) });
  const entries = new Map([['captain', { alive: true, state: 'done', lastScreen: '' }]]);
  const ended = [], sent = [];
  const hooks = {};
  const window = {
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework(cb) { hooks.rework = cb; }, onTasksChanged() {},
      taskBoard: (op, input) => Promise.resolve().then(() => store[op](input)),
      memoryPressure: async () => ({ level: null }), saveLongPrompt: async () => '', saveConfigSync() {},
      restartManifestLoad: () => null, restartManifestSave() {}, ptyInput() {},
      claudeSeats: async () => ClaudeSeatsCore.normalize().map((seat) => ({ id: seat.id, loggedIn: true })),
    },
    MainCore: M, BoardCore: B, AutoVerifyCore: AV, RestartResume: R, PerpetualCaptainCore: P, AgentInfo, ClaudeSeatsCore,
    QuotaCore: { commandQuota: () => ({ out: false }), quotaFallback: (_s, cmd) => ({ action: 'open', cmd, note: '' }) },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {}, readFooter: () => null, captainArchives: () => [] },
    Sidebar: { render() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, console, Date, Intl });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config, platform: 'darwin', terms: entries, userComposing: () => false, columnLabel: (c) => c.title || c.id,
    saveConfig() {}, flushConfig() {}, showToast() {}, columns: () => columns,
    agentInForeground: async () => true,
    archiveColumn(col, opts) {
      ended.push({ id: col.id, captain: !!opts?.captain });
      config.archived = [{ ...col, archivedAt: Date.now() }, ...config.archived.filter((a) => a.id !== col.id)];
      columns.splice(columns.indexOf(col), 1);
      entries.get(col.id).alive = false;
    },
    restoreArchived(id) {
      const snapshot = config.archived.find((a) => a.id === id);
      config.archived = config.archived.filter((a) => a.id !== id);
      columns.push(snapshot);
      entries.set(id, { alive: true, state: 'done', lastScreen: '' });
      return snapshot;
    },
    // The captain's own startup briefing goes out too; only the workers' sends are kept.
    sendWhenReady(col, text, opts) { if (!col.isMain) sent.push({ to: col.id, text: typeof text === 'function' ? text() : text }); opts?.onSent?.({ id: 'turn-' + sent.length }); },
  });
  const s = config.mainSession;
  // A verify card the worker `exec` finished (round 1), reviewed by `rev`.
  function reviewed({ reviewerWorking = true } = {}) {
    const card = store.add({ project: 'demo', title: '修复', detail: '照做', verify: true }).card;
    const assignee = { agent: 'Claude', model: 'claude-opus-5-5' };
    store.bind({ id: card.id, session_id: 'exec', attempt_id: 'a1', assignee });
    store.event({ id: card.id, type: 'complete', message: '做完了。', attempt_id: 'a1', session_id: 'exec', source: 'command' });
    const attempt = AV.reviewAttemptId(card.id, 1);
    store.bind({ id: card.id, session_id: 'rev', attempt_id: attempt, reviews: ['exec'], review_round: 1, assignee: { agent: 'Codex', model: 'gpt-6.1-sol' } });
    columns.push({ id: 'exec', title: '执行', cmd: CLAUDE, captainCrew: true, boardId: card.id, boardAttempt: 'a1', reviews: [] },
      { id: 'rev', title: '审查：修复', cmd: CODEX, captainCrew: true, boardId: card.id, boardAttempt: attempt, reviews: ['exec'] });
    entries.set('exec', { alive: true, state: 'done', lastScreen: '❯ \n  ⏵⏵ bypass permissions on' });
    entries.set('rev', { alive: true, state: reviewerWorking ? 'working' : 'done', lastScreen: '› ' });
    s.tasks.push({ id: 'te', colId: 'exec', gen: 1, status: 'done', startedAt: 1, doneAt: 2, boardId: card.id, boardAttempt: 'a1' },
      { id: 'tr', colId: 'rev', gen: 1, status: reviewerWorking ? 'working' : 'done', startedAt: 3, boardId: card.id, boardAttempt: attempt });
    return { id: card.id, attempt };
  }
  return {
    store, config, columns, ended, sent, hooks, s,
    reviewed,
    card: (id) => store.list({ archived: true }).find((c) => c.id === id),
    tell: (to, message, id = 'tell-' + Math.random().toString(36).slice(2)) => window.MainSession.handle({ action: 'main-tell', to, message, id }, columns.find((c) => c.isMain)),
    move: (id, status) => window.MainSession.handle({ action: 'main-task', op: 'move', input: { id, status } }, columns.find((c) => c.isMain)),
  };
}

function assertReviewerEnded(w, cardId) {
  assert.deepEqual(w.ended, [{ id: 'rev', captain: true }], 'the old reviewer terminal was ended and archived');
  assert.equal(w.columns.some((c) => c.id === 'rev'), false);
  assert.ok(w.config.archived.some((a) => a.id === 'rev'));
  const card = w.card(cardId);
  assert.equal(card.status, 'doing');
  assert.equal(card.session_id, 'exec');
  assert.equal(card.review_session, false);
  assert.equal(card.attempt_closed, false);
}

test('a Captain tell to the worker in the middle of a review ends the reviewer and takes the card back', async (t) => {
  const w = world(t);
  const { id, attempt } = w.reviewed();
  const reply = await w.tell('exec', '补充：把 Windows 的路径也改了', 'tell-1');
  await flush();
  assert.match(reply.result, /已发给/);
  assertReviewerEnded(w, id);
  assert.equal(w.card(id).attempt_id, 'tell-1');
  assert.equal(w.s.tasks.find((x) => x.id === 'tr').status, 'stopped');
  assert.deepEqual(w.sent.map((x) => x.to), ['exec']);
  // The old reviewer's late verdict no longer touches the card.
  assert.equal(w.store.event({ id, type: 'complete', message: '通过', attempt_id: attempt, session_id: 'rev', source: 'command' }).ignored, true);
  assert.equal(w.card(id).status, 'doing');
});

test('automatic rework after 不通过 ends the finished reviewer and opens the new execution attempt', async (t) => {
  const w = world(t);
  const { id, attempt } = w.reviewed({ reviewerWorking: false });
  w.store.event({ id, type: 'complete', message: '不通过：测试没跑。', attempt_id: attempt, session_id: 'rev', source: 'command' });
  const rejected = w.card(id);
  assert.equal(rejected.flag, 'failed');
  w.hooks.rework({ id, key: rejected.review_reject.key });
  await flush(60);
  assertReviewerEnded(w, id);
  assert.equal(w.card(id).attempt_id, AV.reworkAttemptId(id, 1));
  assert.match(w.sent[0].text, /测试没跑/);
});

test('after the Captain moves the card back to doing, the next tell ends the reviewer that is still running', async (t) => {
  const w = world(t);
  const { id } = w.reviewed();
  await w.move(id, 'doing');
  assert.equal(w.card(id).session_id, 'rev', 'the move alone keeps the reviewer as the occupancy fence');
  await w.tell('exec', '按审查前说的再改一处');
  await flush();
  assertReviewerEnded(w, id);
});

test('a card waiting for its reviewer goes back to execution on a tell, instead of making the worker its reviewer', async (t) => {
  const w = world(t);
  const card = w.store.add({ project: 'demo', title: '等审查', detail: '照做', verify: true }).card;
  w.store.bind({ id: card.id, session_id: 'exec', attempt_id: 'a1', assignee: { agent: 'Claude', model: 'claude-opus-5-5' } });
  w.store.event({ id: card.id, type: 'complete', message: '做完了。', attempt_id: 'a1', session_id: 'exec', source: 'command' });
  w.columns.push({ id: 'exec', title: '执行', cmd: CLAUDE, captainCrew: true, boardId: card.id, boardAttempt: 'a1', reviews: [] });
  await w.tell('exec', '再补一个测试');
  await flush();
  const now = w.card(card.id);
  assert.equal(now.status, 'doing');
  assert.equal(now.review_session, false);
  assert.equal(now.attempt_closed, false);
  assert.deepEqual(w.ended, []);
  // Its next receipt is a new execution round, not a verdict.
  const done = w.store.event({ id: card.id, type: 'complete', message: '补好了。', attempt_id: now.attempt_id, session_id: 'exec', source: 'command' }).card;
  assert.equal(done.status, 'review');
  assert.equal(done.review_round, 2);
});

test('a tell to the reviewer itself neither ends it nor takes the card back', async (t) => {
  const w = world(t);
  const { id, attempt } = w.reviewed();
  await w.tell('rev', '结论第一个词写「通过」或「不通过」');
  await flush();
  assert.deepEqual(w.ended, []);
  const card = w.card(id);
  assert.equal(card.status, 'review');
  assert.equal(card.session_id, 'rev');
  assert.equal(card.review_session, true);
  assert.equal(card.attempt_id, attempt);
});

// ---- the store: 队长 decision "tell 本身就是明确要继续干" (50aa897), only for a tell ----
function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-tell-bind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = new TaskStore(path.join(root, 'tasks'));
  const assignee = { agent: 'Claude', model: 'claude-opus-5-5' };
  return {
    s, assignee,
    add: (extra) => s.add({ project: 'demo', title: '卡', detail: '照做', ...extra }).card,
    bind: (id, attempt, extra) => s.bind({ id, session_id: 'exec', attempt_id: attempt, assignee, ...extra }),
    event: (id, type, message, attempt) => s.event({ id, type, message, attempt_id: attempt, session_id: 'exec', source: 'command' }),
  };
}

test('a tell takes a done, archived or held card back to doing and leaves a record; other binds still refuse', (t) => {
  const b = store(t);
  const done = b.add();
  b.bind(done.id, 'a1'); b.event(done.id, 'complete', '做完了。', 'a1');
  assert.throws(() => b.bind(done.id, 'a2'), /archived, held or done/);
  const back = b.bind(done.id, 'tell-1', { tell: true }).card;
  assert.equal(back.status, 'doing');
  assert.equal(back.last_auto_recovered_from, 'done');
  assert.ok(back.last_auto_recovered_at);
  assert.equal(back.attempt_id, 'tell-1');
  assert.equal(back.attempt_closed, false);

  const archived = b.add();
  b.bind(archived.id, 'a1'); b.event(archived.id, 'complete', '做完了。', 'a1');
  b.s.archive({ done: true, project: 'demo' });
  const restored = b.bind(archived.id, 'tell-2', { tell: true }).card;
  assert.equal(restored.archived, false);
  assert.equal(restored.status, 'doing');
  assert.equal(restored.last_auto_recovered_from, 'archived');

  // Held after two failures: the tell lifts the hold but keeps the count, so the
  // next failure holds it again at once.
  const held = b.add();
  b.bind(held.id, 'f1'); b.event(held.id, 'failed', '测试挂了', 'f1');
  b.bind(held.id, 'f2'); const twice = b.event(held.id, 'failed', '还是挂', 'f2').card;
  assert.equal(twice.flag, 'held');
  assert.throws(() => b.bind(held.id, 'f3'), /held/);
  const lifted = b.bind(held.id, 'tell-3', { tell: true }).card;
  assert.equal(lifted.flag, null);
  assert.equal(lifted.consecutive_failures, 2);
  assert.equal(lifted.last_auto_recovered_from, 'held');
  assert.equal(b.event(held.id, 'failed', '又挂了', 'tell-3').card.flag, 'held');
  // A move by the Captain or the user still clears the count, as before.
  b.s.move({ id: held.id, status: 'todo' });
  assert.equal(b.s.list().find((c) => c.id === held.id).consecutive_failures, 0);
});

test('a tell bind replaces the bound reviewer and names it; a manual reviewer bind without --reviews is still a review', (t) => {
  const b = store(t);
  const card = b.add({ verify: true });
  b.bind(card.id, 'a1'); b.event(card.id, 'complete', '做完了。', 'a1');
  b.s.bind({ id: card.id, session_id: 'rev', attempt_id: AV.reviewAttemptId(card.id, 1), reviews: ['exec'], review_round: 1, assignee: b.assignee });
  assert.throws(() => b.bind(card.id, 'plain'), /active execution or verification/);
  const told = b.bind(card.id, 'tell-1', { tell: true });
  assert.equal(told.replaced_session, 'rev');
  assert.equal(told.card.session_id, 'exec');
  assert.equal(told.card.status, 'doing');
  assert.equal(told.card.review_session, false);
  assert.equal(told.card.attempt_closed, false);

  const legacy = b.add({ verify: true });
  b.bind(legacy.id, 'a1'); b.event(legacy.id, 'complete', '做完了。', 'a1');
  const manual = b.s.bind({ id: legacy.id, session_id: 'manual-reviewer', attempt_id: 'm1', assignee: b.assignee });
  assert.equal(manual.card.review_session, true);
  assert.equal(manual.replaced_session, undefined);
});
