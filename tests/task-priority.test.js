'use strict';
// 高优先级 (the card's `important` flag, `new --priority high` for work without a
// card): old data, the order it gives on the board, in the sidebar, in the queue
// and in the handoff, and the Captain's commands. No model, no PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { TaskStore, priorityOf, syncedCard } = require('../task-board');
const U = require('../task-board-ui-core');
const M = require('../main-core');
const { rulebook } = require('./fixtures/captain-rulebook');
const B = require('../board-core');
const S = require('../sidebar-core');
const C = require('../crew-map-core');
const H = require('../relay-handoff-core');

function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new TaskStore(path.join(root, 'tasks'), { sessions: () => [] });
}

// ---- data ----
test('a card is ordinary unless marked; add, priority and the list filter agree, and old cards without the field are ordinary', (t) => {
  const s = store(t);
  const plain = s.add({ project: 'p', title: 'plain' }).card;
  const high = s.add({ project: 'p', title: 'urgent', priority: 'high' }).card;
  const legacy = s.add({ project: 'p', title: 'legacy flag', important: true }).card;
  assert.equal(plain.important, false);
  assert.equal(high.important, true);
  assert.deepEqual([plain, high, legacy].map(priorityOf), ['normal', 'high', 'high']);
  assert.equal(s.add({ project: 'p', title: 'explicit normal wins', important: true, priority: 'normal' }).card.important, false);
  assert.throws(() => s.add({ project: 'p', title: 'x', priority: 'urgent' }), /priority must be high or normal/);

  // A card written before the field existed: no `important` key at all.
  const file = path.join(s.dir, 'p.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.cards.find((c) => c.id === plain.id).important;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  const old = s.list().find((c) => c.id === plain.id);
  assert.equal('important' in old, false);
  assert.equal(priorityOf(old), 'normal');
  assert.equal(U.isHigh(old), false);
  assert.equal(syncedCard(old).important, false);
  assert.deepEqual(s.list({ priority: 'high' }).map((c) => c.title), ['urgent', 'legacy flag']);
  assert.equal(s.list({ priority: 'normal' }).some((c) => c.id === plain.id), true);
  assert.throws(() => s.list({ priority: 'top' }), /priority must be high or normal/);

  // Marking the old card writes the flag; marking it again changes nothing.
  const marked = s.priority({ id: plain.id, level: 'high' }).card;
  assert.equal(marked.important, true);
  assert.notEqual(marked.updated, old.updated);
  assert.equal(s.priority({ id: plain.id, level: 'high' }).card.updated, marked.updated, 'no change, no new timestamp');
  assert.equal(s.priority({ id: plain.id, level: 'normal' }).card.important, false);
  assert.throws(() => s.priority({ id: plain.id, level: 'low' }), /priority must be high or normal/);
  assert.throws(() => s.priority({ id: 'missing', level: 'high' }), /Unknown task/);
});

test('the mark keeps the existing routing: a 高优先级 card dragged to 进行中 goes to the Captain, not the cheap dispatcher', (t) => {
  const s = store(t);
  const card = s.add({ project: 'p', title: 'urgent', detail: 'clear', priority: 'high' }).card;
  assert.equal(s.dispatch({ id: card.id }).captain, true);
  s.priority({ id: card.id, level: 'normal' });
  assert.equal(s.dispatch({ id: card.id }).captain, false);
});

// ---- board order ----
const card = (id, order, extra = {}) => ({ id, project: 'p', title: id, detail: '', status: 'todo', flag: null, order, depends_on: [], archived: false, ...extra });
test('on the board 高优先级 cards lead their column in task order; a finished one keeps its place and a quiet mark', () => {
  const board = U.buildBoard([
    card('a', 0), card('b', 1, { important: true }), card('c', 2), card('d', 3, { important: true }),
    card('e', 4, { status: 'doing' }), card('f', 5, { status: 'doing', important: true }),
    card('g', 6, { status: 'done' }), card('h', 7, { status: 'done', important: true }),
    card('old', 8, { important: undefined }), card('gone', 9, { important: true, archived: true }),
  ]);
  const lane = board.lanes[0];
  const ids = (key) => lane.columns.find((c) => c.key === key).cards.map((i) => i.card.id);
  assert.deepEqual(ids('todo'), ['b', 'd', 'a', 'c', 'old']);
  assert.deepEqual(ids('doing'), ['f', 'e']);
  assert.deepEqual(ids('done'), ['g', 'h'], 'done cards are not reshuffled');
  const item = (id) => lane.columns.flatMap((c) => c.cards).find((i) => i.card.id === id);
  assert.deepEqual([item('b').high, item('b').urgent], [true, true]);
  assert.deepEqual([item('h').high, item('h').urgent], [true, false]);
  assert.deepEqual([item('old').high, item('old').urgent], [false, false]);
  assert.equal(lane.urgent, 3, 'open 高优先级 cards in the project');
  assert.equal(board.projects[0].urgent, 3);
  assert.deepEqual(U.urgentFirst([1, 2, 3, 4], (n) => ({ important: n % 2 === 0, status: 'todo' })), [2, 4, 1, 3]);
});

// ---- queue order, ledger, sidebar, map ----
test('work waiting for a slot: 高优先级 first, each group still first come first served', () => {
  const list = [{ id: 1 }, { id: 2, important: true }, { id: 3 }, { id: 4, important: true }];
  assert.deepEqual(M.highFirst(list, (w) => w.important === true).map((w) => w.id), [2, 4, 1, 3]);
  assert.deepEqual(M.highFirst([], () => true), []);
  assert.deepEqual(M.highFirst(null, () => true), []);
  assert.notEqual(M.highFirst(list, () => false), list, 'a new array, the input is left alone');
});

test('ledger names the 高优先级 sessions; an ordinary line is unchanged', () => {
  const text = M.ledgerText([{ id: 'c1', title: '修登录', state: 'working', important: true }, { id: 'c2', title: '写文档', state: 'done' }]);
  assert.match(text, /^c1 {2}【高优先级】「修登录」 {2}干活中$/m);
  assert.match(text, /^c2 {2}「写文档」 {2}已完成$/m);
});

test('the briefing tells the Captain what 高优先级 means and how to mark it, inside the paste limit', () => {
  for (const platform of ['darwin', 'win32']) {
    const text = rulebook(platform);
    assert.match(M.instructions(platform), /task add [^\n]*\[--priority high\]/);
    assert.match(text, /task add [^\n]*\[--priority high\]/);
    assert.match(text, /task priority --id 卡片或会话id --level high\|normal/);
    assert.match(text, /new --title [^\n]*\[--priority high\]/);
    assert.match(text, /用户说「高优先级」＝立刻派到后台开工：建卡或 new 加 --priority high，排队排最前/);
    assert.ok((M.instructions(platform) + M.SAVER_RESUME).length <= M.CORE_LIMIT, platform);
  }
});

test('sidebar: inside a model group 高优先级 sessions come first, then recent activity', () => {
  const groups = S.crewModelGroups([
    { id: 'a', label: 'Opus', lastActive: 30 }, { id: 'b', label: 'Opus', lastActive: 10, urgent: true },
    { id: 'c', label: 'Opus', lastActive: 20, urgent: true }, { id: 'd', label: 'Opus', lastActive: 40 },
  ], []);
  assert.deepEqual(groups[0].ids, ['c', 'b', 'd', 'a']);
  assert.equal(groups[0].urgent, 2);
  assert.equal(S.crewModelGroups([{ id: 'x', label: 'Opus', lastActive: 1 }], [])[0].urgent, 0);
});

test('architecture map: live sessions and waiting work carry the mark, archived ones do not, and a change redraws', () => {
  const input = (important) => ({
    captain: { id: 'cap', title: '队长', alive: true, state: 'plain' },
    columns: [{ id: 'c1', title: '修登录', alive: true, state: 'working', captainCrew: true, project: 'p', important }],
    archived: [{ id: 'c2', title: '旧活', captainCrew: true, project: 'p', important: true, archivedAt: 1 }],
    tasks: [{ id: 'k1', colId: 'c1', status: 'working', sentAt: 1 }, { id: 'k2', colId: '', status: 'waiting', title: '排队的活', sentAt: 2, project: 'p', important: true },
      { id: 'k3', colId: 'c2', status: 'failed', sentAt: 1 }],
    showArchived: true,
  });
  const map = C.buildCrewMap(input(true));
  const node = (id) => map.nodes.find((n) => n.id === id);
  assert.equal(node('c1').important, true);
  assert.equal(node('wait:k2').important, true);
  assert.equal(node('c2').important, false);
  assert.equal(C.buildCrewMap(input(undefined)).nodes.find((n) => n.id === 'c1').important, false);
  assert.notEqual(C.signature(map), C.signature(C.buildCrewMap(input(false))));
});

// ---- handoff ----
test('handoff: 高优先级 tasks are marked, counted and listed first inside their group', (t) => {
  const s = store(t);
  const plain = s.add({ project: 'p', title: '普通待办' }).card;
  const high = s.add({ project: 'p', title: '紧急待办', priority: 'high' }).card;
  const running = s.add({ project: 'p', title: '普通在做' }).card;
  const urgent = s.add({ project: 'p', title: '紧急在做', priority: 'high' }).card;
  s.bind({ id: running.id, session_id: 'c-run', attempt_id: 'a1', assignee: { agent: 'Claude', model: 'm' } });
  s.bind({ id: urgent.id, session_id: 'c-urgent', attempt_id: 'a2', assignee: { agent: 'Claude', model: 'm' } });
  const record = (colId, extra = {}) => ({ id: 'k-' + colId, colId, title: colId, status: 'working', gen: 1, sentAt: 1, receipt: null, project: 'p', reviews: [], boardId: '', boardAttempt: '', ...extra });
  const built = H.build({
    now: Date.parse('2026-10-05T06:19:52Z'), timeZone: 'UTC', reason: 'refresh', cards: s.list({ archived: true }),
    dispatches: [record('c-run', { boardId: running.id, boardAttempt: 'a1' }), record('c-urgent', { boardId: urgent.id, boardAttempt: 'a2' }), record('c-loose', { title: '没挂卡的急事', important: true })],
    sessions: ['c-run', 'c-urgent', 'c-loose'].map((id) => ({ id, title: id, state: 'working', alive: true, crew: true })),
    waitlist: [{ taskId: 'k-wait', title: '排队的急事', project: 'p', important: true, metadata: { boardId: '' } }],
  });
  const text = built.files.find((f) => f.name === 'tasks.md').text;
  // the overview names them (it is what a squeezed page keeps), the full table marks and orders them
  assert.match(built.text, /## 3\. 用户点名的高优先级（4 条，先办）/);
  assert.match(built.files.find((f) => f.name === 'playbook.md').text, /用户点名高优先级 4 条（tasks\.md 里标了【高优先级】，先办）/);
  const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at(`【高优先级】${urgent.id}｜p｜紧急在做`) < at(`${running.id}｜p｜普通在做`), 'urgent first among running cards');
  assert.ok(at(`【高优先级】${high.id}｜p｜紧急待办`) < at(`${plain.id}｜p｜普通待办`), 'urgent first among cards not started');
  assert.doesNotMatch(text, new RegExp(`【高优先级】${plain.id}|【高优先级】${running.id}`));
  assert.match(text, /】【高优先级】没挂卡｜p｜没挂卡的急事/);
  assert.match(text, /】【高优先级】没挂卡｜p｜排队的急事｜还没开会话/);
  // Nothing marked: the summary line says nothing about it.
  const plainBuilt = H.build({ now: 1, timeZone: 'UTC', reason: 'refresh', cards: [], dispatches: [], sessions: [] });
  assert.doesNotMatch([plainBuilt.text, ...plainBuilt.files.map((f) => f.text)].join('\n'), /高优先级/);
});

// ---- the Captain's commands, against the real session code ----
function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-priority-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captain = { id: 'captain', isMain: true, cmd: '' }, columns = [captain];
  const state = { colId: captain.id, tasks: [], pending: [], waitlist: [] };
  const tasks = new TaskStore(path.join(root, 'tasks'), { sessions: () => columns });
  const h = { pressure: 1, out: new Set(['held']), renders: 0, turns: 0, hold: false, held: [], release() { h.hold = false; h.held.splice(0).forEach((send) => send()); } };
  const window = {
    MainCore: M, BoardCore: B,
    QuotaCore: {
      commandQuota: (_s, cmd) => ({ out: h.out.has(cmd) }),
      quotaFallback: (_s, cmd) => (h.out.has(cmd) ? { action: 'queue', cmd, reason: 'out', held: 'out' } : { action: 'open', cmd }),
    },
    ChatUI: { addCard() {}, updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    Sidebar: { render: () => { h.renders++; } },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      memoryPressure: async () => ({ level: h.pressure }),
      saveLongPrompt: async () => '/tmp/priority-long.txt',
      taskBoard: async (op, input) => tasks[op](input),
    },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  window.MainSession.init({
    config: { mainSession: state, folders: [] }, columns: () => columns, terms: new Map(),
    saveConfig() {}, flushConfig() {}, columnLabel: (c) => c.title || c.id, userComposing: () => false, showToast() {},
    createSession: (col) => { columns.push(col); return col; },
    // the stand-in session takes every instruction at once: its dispatch record goes to work
    // (h.hold: the session is busy, the instruction stays queued until h.release())
    sendWhenReady: (col, text, options = {}) => {
      const send = () => { if (typeof text === 'function') text(); if (options.onSent) options.onSent({ id: 'turn-' + (++h.turns) }); };
      if (h.hold) h.held.push(send); else send();
    },
  });
  let n = 0;
  const handle = (message, caller = captain) => window.MainSession.handle({ id: 'req-' + (++n), ...message }, caller);
  return Object.assign(h, {
    window, columns, state, captain, tasks, handle, api: window.MainSession,
    task: async (op, input = {}) => (await handle({ action: 'main-task', op, input })).result,
    assign: (title, extra = {}) => handle({ action: 'main-new', title, task: 'do ' + title, command: 'available', ...extra }),
    ledger: async () => (await handle({ action: 'main-ledger' })).result,
    queue: async () => JSON.parse((await handle({ action: 'main-queue', op: 'list' })).result),
    fill: () => { for (let i = 0; i < M.MAX_ACTIVE; i++) { columns.push({ id: 'busy-' + i, captainCrew: true }); state.tasks.push({ id: 'kb' + i, colId: 'busy-' + i, status: 'working' }); } },
  });
}

test('task add --priority high, task list and task priority: the card is the one record and every output says so', async (t) => {
  const h = runtime(t);
  const added = JSON.parse(await h.task('add', { project: 'p', title: '紧急修复', detail: 'now', priority: 'high' }));
  assert.equal(added.card.important, true);
  assert.equal(added.card.priority, 'high', 'said in plain words');
  const plain = JSON.parse(await h.task('add', { project: 'p', title: '普通活', detail: 'later' })).card;
  assert.equal('priority' in plain, false, 'an ordinary card has no such line');
  const listed = JSON.parse(await h.task('list', {}));
  assert.deepEqual(listed.map((c) => c.priority), ['high', undefined]);
  assert.deepEqual(JSON.parse(await h.task('list', { priority: 'high' })).map((c) => c.title), ['紧急修复']);

  assert.match(await h.task('priority', { id: plain.id, level: 'high' }), new RegExp(`已把卡片 ${plain.id}「普通活」标为高优先级`));
  assert.equal(h.tasks.list().find((c) => c.id === plain.id).important, true);
  assert.match(await h.task('priority', { id: plain.id, level: 'normal' }), /改回普通优先级/);
  assert.equal(h.tasks.list().find((c) => c.id === plain.id).important, false);
  await assert.rejects(h.task('priority', { id: plain.id, level: 'urgent' }), /只能是 high 或 normal/);
  await assert.rejects(h.task('priority', { id: 'nobody', level: 'high' }), /找不到卡片或会话：nobody/);
  assert.equal(h.state.pending.length, 0, "the Captain's own command sends the Captain no notice");
});

test('a session follows its card; work without a card carries the mark itself; task priority takes a session id too', async (t) => {
  const h = runtime(t);
  const card = h.tasks.add({ project: 'p', title: '挂卡的活', detail: 'x' }).card;
  await h.assign('挂卡的活', { boardId: card.id, project: 'p', priority: 'high' });
  await h.assign('没挂卡的急事', { priority: 'high' });
  await h.assign('普通活');
  const [bound, loose, plain] = h.columns.slice(1);
  assert.equal(h.tasks.list().find((c) => c.id === card.id).important, true, 'new --task-id --priority high marks the card');
  assert.equal(bound.important, undefined, 'the session reads the card, no second copy');
  const recordOf = (col) => h.state.tasks.findLast((x) => x.colId === col.id);
  assert.equal('important' in loose, false, 'without a card the mark is on the piece of work, not on the session');
  assert.equal(recordOf(loose).important, true);
  assert.equal('important' in recordOf(bound), false);
  assert.deepEqual([bound, loose, plain].map((c) => h.api.isPriority(c)), [true, true, false]);
  const ledger = await h.ledger();
  assert.match(ledger, new RegExp(`${bound.id} {2}【高优先级】「挂卡的活」`));
  assert.match(ledger, new RegExp(`${loose.id} {2}【高优先级】「没挂卡的急事」`));
  assert.match(ledger, new RegExp(`${plain.id} {2}「普通活」`));

  // by session id: a bound session changes its card, a loose one its own flag
  assert.match(await h.task('priority', { id: bound.id, level: 'normal' }), new RegExp(`已把卡片 ${card.id}`));
  assert.equal(h.tasks.list().find((c) => c.id === card.id).important, false);
  assert.equal(h.api.isPriority(bound), false);
  assert.match(await h.task('priority', { id: loose.id, level: 'normal' }), new RegExp(`已把会话 ${loose.id}「没挂卡的急事」改回普通优先级`));
  assert.equal('important' in loose, false);
  assert.equal('important' in recordOf(loose), false);
  assert.equal(h.api.isPriority(loose), false);
  assert.match(await h.task('priority', { id: plain.id, level: 'high' }), /标为高优先级/);
  assert.equal(h.api.isPriority(plain), true);
  assert.deepEqual([recordOf(plain).important, 'important' in plain], [true, false], 'work in progress: its record carries the mark');

  // once its own work is done the session no longer wears the mark
  h.state.tasks.findLast((x) => x.colId === plain.id).status = 'done';
  assert.equal(h.api.isPriority(plain), false);
  assert.doesNotMatch(await h.ledger(), new RegExp(`${plain.id} {2}【高优先级】`));

  await assert.rejects(h.assign('x', { priority: 'top' }), /--priority 只能是 high 或 normal/);
  const dispatcher = { id: 'dispatcher', dispatcherCardId: card.id };
  await assert.rejects(h.handle({ action: 'main-new', title: 'y', task: 'y', command: 'available', boardId: card.id, dispatcherCardId: card.id, priority: 'high' }, dispatcher), /只有队长可以标/);
});

// The mark belongs to a piece of work, not to the session that did it.
test('a finished 高优先级 job leaves nothing behind: an ordinary tell to the same session is ordinary everywhere', async (t) => {
  const h = runtime(t);
  await h.assign('urgent first task', { priority: 'high' });
  const col = h.columns[1];
  const last = () => h.state.tasks.findLast((x) => x.colId === col.id);
  assert.equal(h.api.isPriority(col), true);
  assert.match(await h.ledger(), new RegExp(`${col.id} {2}【高优先级】「urgent first task」`));

  await h.api.submit({ action: 'complete', result: 'finished' }, col);
  assert.equal(last().status, 'done');
  assert.equal(h.api.isPriority(col), false);
  assert.equal('important' in col, false, 'nothing is left on the session');

  // the reviewer's case: the new instruction is still waiting to go in (queued), then it is delivered (working)
  h.hold = true;
  assert.match((await h.handle({ action: 'main-tell', to: col.id, message: 'ordinary unrelated second task' })).result, /已发给|先放着/);
  assert.equal(last().status, 'queued');
  assert.equal('important' in last(), false);
  assert.equal(h.api.isPriority(col), false, 'the new ordinary work does not wear the old mark');
  assert.doesNotMatch(await h.ledger(), /【高优先级】/);
  h.release();
  assert.equal(last().status, 'working');
  assert.equal('important' in last(), false);
  assert.equal(h.api.isPriority(col), false);
  assert.doesNotMatch(await h.ledger(), /【高优先级】/);
  // the pieces the sidebar and the architecture map are drawn from
  assert.equal(S.crewModelGroups([{ id: col.id, label: 'Opus', lastActive: 1, urgent: h.api.isPriority(col) }], [])[0].urgent, 0);
  const map = C.buildCrewMap({ captain: { id: 'captain', title: '队长', alive: true, state: 'plain' }, tasks: h.state.tasks, showArchived: false,
    columns: [{ id: col.id, title: 'urgent first task', alive: true, state: 'working', captainCrew: true, important: h.api.isPriority(col) }] });
  assert.equal(map.nodes.find((n) => n.id === col.id).important, false);

  // marked again by hand, the new work wears it; when that is done it is gone again
  assert.match(await h.task('priority', { id: col.id, level: 'high' }), /标为高优先级/);
  assert.deepEqual([h.api.isPriority(col), last().important, 'important' in col], [true, true, false]);
  await h.api.submit({ action: 'complete', result: 'second finished' }, col);
  assert.equal(h.api.isPriority(col), false);
  await h.handle({ action: 'main-tell', to: col.id, message: 'a third ordinary thing' });
  assert.equal(h.api.isPriority(col), false);
});

test('an instruction added while the marked work is unfinished is part of it; a failed job stays marked through its rework', async (t) => {
  const h = runtime(t);
  await h.assign('urgent job', { priority: 'high' });
  const col = h.columns[1];
  const last = () => h.state.tasks.findLast((x) => x.colId === col.id);
  // a supplement while it is still at work
  await h.handle({ action: 'main-tell', to: col.id, message: 'one more detail for the same job' });
  assert.equal(h.state.tasks.filter((x) => x.colId === col.id).length, 2);
  assert.equal(last().important, true);
  assert.equal(h.api.isPriority(col), true);
  // it fails: still to be dealt with, still marked; the rework carries the mark
  await h.api.submit({ action: 'complete', result: 'could not finish', failed: 'tests fail' }, col);
  assert.equal(last().status, 'failed');
  assert.equal(h.api.isPriority(col), true);
  await h.handle({ action: 'main-tell', to: col.id, message: 'fix the tests and finish' });
  assert.equal(last().important, true);
  assert.equal(h.api.isPriority(col), true);
  await h.api.submit({ action: 'complete', result: 'done now' }, col);
  assert.equal(h.api.isPriority(col), false);
  await h.handle({ action: 'main-tell', to: col.id, message: 'unrelated ordinary work' });
  assert.equal(h.api.isPriority(col), false);
  assert.doesNotMatch(await h.ledger(), /【高优先级】/);
});

test('a session marked while it has no unfinished work hands the mark to its next piece of work, once', async (t) => {
  const h = runtime(t);
  await h.assign('ordinary job');
  const col = h.columns[1];
  const last = () => h.state.tasks.findLast((x) => x.colId === col.id);
  await h.api.submit({ action: 'complete', result: 'finished' }, col);
  // the user marks the idle session from the sidebar menu
  await h.api.setPriority(col.id, 'high');
  assert.deepEqual([col.important, h.api.isPriority(col)], [true, true]);
  assert.equal('important' in last(), false, 'the finished record is not rewritten');
  await h.handle({ action: 'main-tell', to: col.id, message: 'the urgent thing' });
  assert.deepEqual([last().important, 'important' in col, h.api.isPriority(col)], [true, false, true]);
  await h.api.submit({ action: 'complete', result: 'urgent thing done' }, col);
  await h.handle({ action: 'main-tell', to: col.id, message: 'back to ordinary work' });
  assert.deepEqual(['important' in last(), 'important' in col, h.api.isPriority(col)], [false, false, false]);
  // unmarking an idle session clears it before any work takes it
  await h.api.submit({ action: 'complete', result: 'ok' }, col);
  await h.api.setPriority(col.id, 'high');
  await h.api.setPriority(col.id, 'normal');
  assert.deepEqual(['important' in col, h.api.isPriority(col)], [false, false]);
});

test('queued 高优先级 work without a card: the mark arrives on its record, not on the session, and ends with it', async (t) => {
  const h = runtime(t);
  h.pressure = 4;
  await h.assign('queued urgent', { priority: 'high' });
  h.pressure = 1;
  h.window.ChatUI.readFooter = () => [];
  h.api.onTick(h.captain.id, { alive: true, state: 'plain' });
  for (let i = 0; i < 20 && h.state.waitlist.length; i++) await new Promise((resolve) => setImmediate(resolve));
  const col = h.columns[1];
  const last = () => h.state.tasks.findLast((x) => x.colId === col.id);
  assert.deepEqual([last().important, 'important' in col, h.api.isPriority(col)], [true, false, true]);
  await h.api.submit({ action: 'complete', result: 'finished' }, col);
  await h.handle({ action: 'main-tell', to: col.id, message: 'ordinary follow-up' });
  assert.deepEqual(['important' in last(), h.api.isPriority(col)], [false, false]);
});

test('queue: 高优先级 goes ahead of ordinary work already waiting, and is said so in queue list and ledger', async (t) => {
  const h = runtime(t);
  h.fill();
  assert.match((await h.assign('普通一')).result, /已排队/);
  assert.match((await h.assign('普通二')).result, /已排队/);
  assert.match((await h.assign('紧急一', { priority: 'high' })).result, /已排队：现在有 30 个会话占用干活名额/);
  await h.assign('紧急二', { priority: 'high' });
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['紧急一', '紧急二', '普通一', '普通二']);
  assert.deepEqual((await h.queue()).map((w) => w.priority), ['high', 'high', undefined, undefined]);
  assert.match(await h.ledger(), /排队等空位：【高优先级】「紧急一」、【高优先级】「紧急二」、「普通一」、「普通二」/);

  // marking a waiting request moves it into the first group at its own arrival place
  // (it arrived before both); unmarking sends it back to where it was
  const second = h.state.waitlist.find((w) => w.title === '普通二');
  assert.match(await h.task('priority', { id: second.taskId, level: 'high' }), /已把排队中的「普通二」标为高优先级/);
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['普通二', '紧急一', '紧急二', '普通一']);
  assert.equal(h.api.isHigh(h.state.tasks.find((x) => x.id === second.taskId)), true, 'its waiting card on the map is marked too');
  await h.task('priority', { id: second.taskId, level: 'normal' });
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['紧急一', '紧急二', '普通一', '普通二']);

  // one slot frees up: the first 高优先级 request takes it, nothing running was touched
  h.state.tasks.find((x) => x.colId === 'busy-0').status = 'done';
  h.window.ChatUI.readFooter = () => [];
  h.api.onTick(h.captain.id, { alive: true, state: 'plain' });
  for (let i = 0; i < 20 && h.state.waitlist.length === 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['紧急二', '普通一', '普通二']);
  assert.equal(h.columns.at(-1).title, '紧急一');
});

test('a 高优先级 request is not held behind ordinary work that could start; a card marked on the board reorders the queue', async (t) => {
  const h = runtime(t);
  h.pressure = 4;   // memory hold: everything queues
  const card = h.tasks.add({ project: 'p', title: '卡片活', detail: 'x' }).card;
  await h.assign('普通一');
  await h.assign('卡片活', { boardId: card.id, project: 'p' });
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['普通一', '卡片活']);
  h.pressure = 1;
  // An ordinary request still lines up behind the two; a 高优先级 one opens at once.
  assert.match((await h.assign('普通二')).result, /前面有 2 条可执行任务/);
  assert.match((await h.assign('紧急', { priority: 'high' })).result, /已开新会话/);

  // The user marks the card on the task board (or the other machine does): the queue follows.
  h.pressure = 4;
  await h.window.TaskBoard.setPriority(card.id, 'high');
  assert.deepEqual(h.state.waitlist.map((w) => w.title), ['卡片活', '普通一', '普通二']);
  assert.ok(h.renders > 0, 'the sidebar is redrawn');
});

test("the user's own click: marking a card nobody started tells the Captain once; a started or re-marked card does not", async (t) => {
  const h = runtime(t);
  const todo = h.tasks.add({ project: 'p', title: '还没开始', detail: 'x' }).card;
  const doing = h.tasks.add({ project: 'p', title: '在做了', detail: 'x' }).card;
  h.tasks.move({ id: doing.id, status: 'doing' });
  await h.window.TaskBoard.setPriority(todo.id, 'high');
  assert.equal(h.state.pending.length, 1);
  assert.match(h.state.pending[0].summary, new RegExp(`用户在任务看板把卡片 ${todo.id}「还没开始」标为高优先级（项目：p），它还没开始做，请立刻安排`));
  await h.window.TaskBoard.setPriority(todo.id, 'high');
  await h.window.TaskBoard.setPriority(doing.id, 'high');
  await h.window.TaskBoard.setPriority(todo.id, 'normal');
  assert.equal(h.state.pending.length, 1);
  assert.equal(h.tasks.list().find((c) => c.id === doing.id).important, true);
});

// ---- command line ----
const cli = path.join(__dirname, '..', 'board-cli.js');
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, AGENTDECK_RECEIPT_TOKEN: '', AGENTDECK_TERMINAL_ID: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
test('command line: --priority on task add / task list / new, task priority --id --level, and the help text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-priority-cli-'));
  fs.mkdirSync(path.join(dir, 'requests')); fs.mkdirSync(path.join(dir, 'responses'));
  const requests = [];
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(path.join(dir, 'requests'))) {
      if (!file.endsWith('.json')) continue;
      let request;
      try { request = JSON.parse(fs.readFileSync(path.join(dir, 'requests', file), 'utf8')); } catch (_) { continue; }
      fs.unlinkSync(path.join(dir, 'requests', file));
      requests.push(request);
      fs.writeFileSync(path.join(dir, 'responses', file), JSON.stringify({ done: true, result: 'ok' }));
    }
  }, 20);
  t.after(() => { clearInterval(timer); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { AGENTDECK_CONTROL_DIR: dir, AGENTDECK_CONTROL_TOKEN: 'captain-test' };
  const run = async (args) => { const before = requests.length; const result = await runCli(args, env); return { ...result, request: requests[before] }; };

  let r = await run(['task', 'add', '--project', 'p', '--title', '紧急', '--priority', 'high']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.request.action, r.request.op, r.request.input.priority, r.request.input.title], ['main-task', 'add', 'high', '紧急']);
  r = await run(['task', 'add', '--project', 'p', '--title', '普通']);
  assert.equal('priority' in r.request.input, false, 'no flag, nothing sent: the card is ordinary');
  r = await run(['task', 'list', '--priority=high']);
  assert.deepEqual([r.request.op, r.request.input.priority], ['list', 'high']);
  r = await run(['task', 'priority', '--id', 't-1', '--level', 'high']);
  assert.deepEqual([r.request.action, r.request.op, r.request.input], ['main-task', 'priority', { id: 't-1', level: 'high' }]);
  r = await run(['task', 'priority', '--id', 'c-board-1', '--level', 'normal']);
  assert.deepEqual(r.request.input, { id: 'c-board-1', level: 'normal' });
  r = await run(['new', '--title', '急事', '--task', '马上做', '--priority', 'high']);
  assert.deepEqual([r.request.action, r.request.priority], ['main-new', 'high']);
  r = await run(['new', '--title', '平常事', '--task', '慢慢做']);
  assert.equal('priority' in r.request, false);

  const sent = requests.length;
  for (const [args, message] of [
    [['task', 'add', '--project', 'p', '--title', 'x', '--priority', 'urgent'], /--priority is high or normal/],
    [['task', 'add', '--project', 'p', '--title', 'x', '--priority'], /--priority is high or normal/],
    [['task', 'move', '--id', 't-1', '--status', 'doing', '--priority', 'high'], /Change a card with task priority/],
    [['task', 'priority', '--id', 't-1'], /task priority requires --id <card-or-session-id> and --level high\|normal/],
    [['task', 'priority', '--level', 'high'], /task priority requires --id/],
    [['task', 'priority', '--id', 't-1', '--level', 'top'], /task priority requires --id/],
    [['new', '--title', 'x', '--task', 'y', '--priority', 'now'], /new --priority is high or normal/],
  ]) {
    const bad = await runCli(args, env);
    assert.notEqual(bad.code, 0, args.join(' '));
    assert.match(bad.stderr, message);
  }
  assert.equal(requests.length, sent, 'a refused command reaches nobody');

  const help = (await runCli(['help'], env)).stdout;
  assert.match(help, /task add [^\n]*\[--priority high\]/);
  assert.match(help, /task list [^\n]*\[--priority high\|normal\]/);
  assert.match(help, /task priority --id <card-or-session-id> --level high\|normal/);
  assert.match(help, /new --title [^\n]*\[--priority high\]/);
  assert.match(help, /ledger [^\n]*高优先级 mark/);
});
