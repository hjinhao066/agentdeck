'use strict';
// 小队长 (sub-captain): a background session the Captain opens with `new --sub-captain`.
// It opens its own child sessions with create-child; their receipts, questions and
// confirmation prompts go to its own `receipts`, never to the Captain's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const B = require('../board-core');
const M = require('../main-core');

const MIN = 60_000;

function runtime() {
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const columns = [captain];
  const config = { mainSession: null, folders: [], archived: [] };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }]]);
  const sent = [], cards = [], prompts = [], board = [];
  // memory: the pressure level new sessions see; failOpen: a title whose session cannot be opened
  const h = { memory: 1, failOpen: '' };
  const boardCard = { id: 'card-1', title: '秋招', project: '秋招', status: 'doing', session_id: null, attempt_closed: false };
  let turn = 0;
  const window = {
    MainCore: M, BoardCore: B, ClaudeSeatsCore: require('../claude-seats-core'),
    QuotaCore: { quotaFallback: (_q, cmd) => ({ action: 'open', cmd }), commandQuota: () => ({ out: false }) },
    ChatUI: { addCard: (colId, task) => cards.push({ colId, taskId: task.id }), updateCard() {}, hasDraft: () => false, turnsOf: () => [], readFooter: () => '',
      sendPrompt: async (col, _text, _atts, opts) => { prompts.push({ colId: col.id, text: opts.prefix, guarded: opts.guardUserInput === true }); return true; } },
    TaskBoard: { list: async () => [boardCard] },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, saveConfigSync: () => true,
      memoryPressure: async () => ({ level: h.memory }),
      taskBoard: async (op, input) => { if (op !== 'list') board.push({ op, type: input?.type }); return op === 'list' ? [boardCard] : {}; },
    },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const api = window.MainSession;
  // The renderer's archive and close: the column leaves the deck, then MainSession hears about it.
  const leave = (col, how) => {
    const at = columns.indexOf(col);
    if (at < 0) return;
    columns.splice(at, 1);
    terms.delete(col.id);
    if (how === 'archive') config.archived.unshift({ ...col, archivedAt: Date.now() });
    api.releaseSubCrew(col, how === 'archive' ? '归档' : '关掉');
  };
  const host = {
    config, platform: 'darwin', columns: () => columns, terms,
    saveConfig() {}, flushConfig() {}, showToast() {}, columnLabel: (c) => c.displayTitle || c.title || c.id,
    userComposing: () => false, isBackstage: (c) => !!c.captainCrew && !c.isMain, focusedId: () => '',
    lastTurnTs: () => 0, dumpScreen: (term) => term.screen || '', agentInForeground: async () => true, quotaText: () => 'Claude 剩余 80%',
    createMain: (c) => { const col = { ...c, id: 'captain' }; return col; },
    createSession: (c) => {
      if (h.failOpen && c.title === h.failOpen) throw new Error('开不出来');
      const col = { ...c, taskId: c.id };
      columns.push(col);
      terms.set(col.id, { alive: true, state: 'done', lastScreen: '', term: { screen: 'screen of ' + col.id }, lastOutputAt: Date.now() });
      return col;
    },
    sendWhenReady: (col, make, opts) => { sent.push({ colId: col.id, text: make() }); opts.onSent({ id: 'turn-' + ++turn }); },
    archiveColumn: (col) => leave(col, 'archive'),
    restoreArchived: (id) => {
      const a = config.archived.find((x) => x.id === id);
      config.archived = config.archived.filter((x) => x !== a);
      const { archivedAt, ...col } = a;
      columns.push(col);
      terms.set(col.id, { alive: true, state: 'done', lastScreen: '', term: { screen: '' } });
      return col;
    },
  };
  api.init(host);
  config.mainSession = { colId: captain.id, cmd: 'claude', gen: 1, pending: [], inflight: [], tasks: [], fresh: false, crewMarked: true, waitlist: [] };
  let seq = 0;
  const run = (action, caller, extra = {}) => api.handle({ action, id: 'req-' + ++seq, ...extra }, caller);
  const text = async (action, caller, extra) => (await run(action, caller, extra)).result;
  const byTitle = (title) => columns.find((c) => c.title === title);
  async function subCaptain(title = '秋招小队长') {
    await run('main-new', captain, { title, task: '统筹秋招：简历和 JD 分析', project: '秋招', subCaptain: true });
    return byTitle(title);
  }
  async function child(sub, title) {
    await run('create-child', sub, { title, task: '做 ' + title });
    return byTitle(title);
  }
  const settleDown = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { api, h, captain, columns, config, terms, sent, cards, prompts, board, run, text, byTitle, subCaptain, child, leave, settleDown, state: () => config.mainSession };
}

test('new --sub-captain opens a marked session and hands it the sub-captain rules with its task', async () => {
  const r = runtime();
  await assert.rejects(r.run('main-new', r.captain, { title: '小队长', task: '统筹', subCaptain: true }), /--project/);
  const sub = await r.subCaptain();
  assert.ok(sub, 'the session was opened');
  assert.equal(sub.subCaptain, true);
  assert.equal(sub.captainCrew, true);
  assert.equal(sub.project, '秋招');
  const delivered = r.sent.find((s) => s.colId === sub.id).text;
  assert.match(delivered, /统筹秋招/);
  assert.match(delivered, /create-child/);
  assert.match(delivered, /receipts --wait/);
  // Only the Captain makes sub-captains, and a sub-captain cannot make another one.
  await assert.rejects(r.run('main-new', sub, { title: '孙队长', task: 'x', project: '秋招', subCaptain: true }), /队长|小队长/);
});

test('A: a child receipt goes to its sub-captain\'s receipts and never to the Captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  assert.ok(kid, 'create-child opened a session');
  assert.equal(kid.subCaptainId, sub.id);
  assert.equal(kid.captainCrew, true);
  assert.equal(kid.project, '秋招');
  assert.match(r.sent.find((s) => s.colId === kid.id).text, /做 子会话A/);
  const asker = await r.child(sub, '子会话A2');
  await r.api.submit({ action: 'complete', result: 'A 做完了', files: [] }, kid);
  await r.api.submit({ action: 'ask', question: 'A2 用哪个模板？' }, asker);
  assert.ok(!r.state().pending.some((p) => [kid.id, asker.id].includes(p.colId)), 'nothing from the children waits for the Captain');
  const captainView = await r.text('main-receipts', r.captain);
  assert.doesNotMatch(captainView, /A 做完了|A2 用哪个模板/);
  const subView = await r.text('main-receipts', sub);
  assert.match(subView, /A 做完了/);
  assert.match(subView, /向你提问：A2 用哪个模板？/);
  assert.equal(await r.text('main-receipts', sub), '没有新的回执。');
  // The sub-captain's follow-up gets its receipt back the same way. A listener whose
  // poll expired never consumes anything.
  await r.text('main-tell', sub, { to: kid.id, message: '再做第二轮' });
  await r.api.submit({ action: 'complete', result: 'A 第二次', files: [] }, kid);
  assert.equal((await r.api.handle({ action: 'main-receipts', wait: true, expiresAt: Date.now() - 1 }, sub)).result, '');
  assert.match(await r.text('main-receipts', sub, { wait: true }), /A 第二次/);
});

test('A: a child stopped on a confirmation prompt is reported to its sub-captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话B');
  const entry = r.terms.get(kid.id);
  Object.assign(entry, { state: 'input', lastScreen: 'Proceed with the change? (y/n)' });
  r.api.onTick(kid.id, entry);
  assert.ok(!r.state().pending.some((p) => p.colId === kid.id));
  assert.match(await r.text('main-receipts', sub), /停在确认提示上/);
});

test('A: the Captain receives the sub-captain\'s own reports, every one of them, and its questions', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  await r.child(sub, '子会话A');
  await r.api.submit({ action: 'complete', result: '阶段一：简历 v1 出了', files: [] }, sub);
  await r.api.submit({ action: 'complete', result: '阶段二：JD 分析收齐', files: [] }, sub);
  await r.api.submit({ action: 'ask', question: '字节名额怎么分？' }, sub);
  const view = await r.text('main-receipts', r.captain);
  assert.match(view, /阶段一：简历 v1 出了/);
  assert.match(view, /阶段二：JD 分析收齐/);
  assert.match(view, /字节名额怎么分/);
  assert.equal(await r.text('main-receipts', sub), '没有新的回执。');
});

test('a sub-captain commands only its own children', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  await r.run('main-new', r.captain, { title: '别的活', task: '不归小队长管' });
  const other = r.byTitle('别的活');
  assert.match(await r.text('main-peek', sub, { to: kid.id }), /screen of/);
  assert.match(await r.text('main-tell', sub, { to: kid.id, message: '再补一句' }), /已发给|待补充/);
  for (const [action, extra] of [['main-peek', { to: other.id }], ['main-tell', { to: other.id, message: 'x' }], ['main-read', { to: other.id }],
    ['main-archive', { to: other.id }], ['main-stop', { to: other.id }], ['main-answer', { to: other.id, key: 'y' }], ['main-tell', { to: r.captain.id, message: 'x' }]]) {
    await assert.rejects(r.run(action, sub, extra), /不是你开的子会话/, action);
  }
  for (const action of ['main-new', 'main-task', 'main-inbox', 'main-queue', 'main-settings', 'main-receipts-snapshot', 'main-briefing']) {
    await assert.rejects(r.run(action, sub, { title: 'x', task: 'x', op: 'list' }), /小队长/, action);
  }
  const own = await r.text('main-ledger', sub);
  assert.match(own, new RegExp(kid.id));
  assert.doesNotMatch(own, new RegExp(other.id));
  assert.doesNotMatch(own, new RegExp(sub.id));
  // An ordinary background session still cannot use these commands at all.
  await assert.rejects(r.run('create-child', other, { title: 'x', task: 'x' }), /只有队长|小队长/);
  await assert.rejects(r.run('main-receipts', other), /只有队长/);
});

test('B: the Captain\'s ledger lists children indented under their sub-captain, and it can still peek and tell them', async () => {
  const r = runtime();
  await r.run('main-new', r.captain, { title: '散活', task: 'x' });
  const sub = await r.subCaptain();
  const a = await r.child(sub, '子会话A');
  await r.run('main-new', r.captain, { title: '另一件散活', task: 'y' });
  const b = await r.child(sub, '子会话B');
  const lines = (await r.text('main-ledger', r.captain)).split('\n').filter((l) => /^\s*(└\s*)?c-board-/.test(l));
  const at = (id) => lines.findIndex((l) => l.includes(id));
  assert.equal(at(a.id), at(sub.id) + 1, 'child A right under its sub-captain');
  assert.equal(at(b.id), at(sub.id) + 2, 'child B right under child A');
  assert.match(lines[at(a.id)], /^\s+└/);
  assert.match(lines[at(b.id)], /^\s+└/);
  assert.doesNotMatch(lines[at(sub.id)], /^\s/);
  assert.match(lines[at(sub.id)], /小队长/);
  assert.match(await r.text('main-peek', r.captain, { to: a.id }), /screen of/);
  assert.match(await r.text('main-tell', r.captain, { to: a.id, message: '总队长直接补一句' }), /已发给|待补充/);
  assert.ok(r.sent.some((s) => s.colId === a.id && s.text.includes('总队长直接补一句')));
});

test('D: archiving a sub-captain keeps its children running and hands them, and their unread receipts, to the Captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const a = await r.child(sub, '子会话A');
  const b = await r.child(sub, '子会话B');
  await r.api.submit({ action: 'complete', result: 'B 还没被小队长看的回执', files: [] }, b);
  await r.text('main-receipts', r.captain); // the Captain has read everything it had
  assert.match(await r.text('main-archive', r.captain, { to: sub.id }), /已结束终端并归档/);
  assert.ok(r.columns.includes(a) && r.columns.includes(b), 'children were not ended');
  assert.ok(r.terms.get(a.id).alive && r.terms.get(b.id).alive);
  assert.equal(a.subCaptainId, undefined);
  assert.equal(b.subCaptainId, undefined);
  const view = await r.text('main-receipts', r.captain);
  assert.match(view, /小队长「秋招小队长」/);
  assert.match(view, /交回/);
  assert.match(view, new RegExp(a.id));
  assert.match(view, new RegExp(b.id));
  assert.match(view, /B 还没被小队长看的回执/);
  // From now on the children report to the Captain.
  await r.api.submit({ action: 'complete', result: 'A 交回后的回执', files: [] }, a);
  assert.match(await r.text('main-receipts', r.captain), /A 交回后的回执/);
  assert.ok(!(r.state().subReceipts || {})[sub.id], 'no queue left behind for the archived sub-captain');
});

test('D: closing a sub-captain hands its children back too, archived children included', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const a = await r.child(sub, '子会话A');
  const b = await r.child(sub, '子会话B');
  r.leave(b, 'archive'); // a finished child the sub-captain already archived
  r.leave(sub, 'close');
  assert.ok(r.columns.includes(a));
  assert.equal(a.subCaptainId, undefined);
  assert.equal(r.config.archived.find((x) => x.id === b.id).subCaptainId, undefined);
  assert.match(await r.text('main-receipts', r.captain), /交回/);
  // A restored archived child also reports to the Captain.
  await r.text('main-tell', r.captain, { to: b.id, message: '回来再做一点' });
  const back = r.columns.find((c) => c.id === b.id);
  await r.api.submit({ action: 'complete', result: 'B 恢复后的回执', files: [] }, back);
  assert.match(await r.text('main-receipts', r.captain), /B 恢复后的回执/);
});

test('D: a sub-captain with live children is never archived automatically', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  await r.api.submit({ action: 'complete', result: '派完了', files: [] }, sub);
  const kid = await r.child(sub, '子会话A');
  await r.text('main-receipts', r.captain);
  r.state().inflight = []; // the Captain finished the turn that read it
  const task = r.state().tasks.findLast((t) => t.colId === sub.id);
  task.doneAt = task.sentAt = Date.now() - 60 * MIN;
  const entry = Object.assign(r.terms.get(sub.id), { state: 'done', lastOutputAt: Date.now() - 60 * MIN });
  r.api.onTick(sub.id, entry);
  assert.ok(r.columns.includes(sub), 'kept while a child is live');
  r.leave(kid, 'archive');
  r.api.onTick(sub.id, entry);
  assert.ok(!r.columns.includes(sub), 'archived like any finished session once no child is left');
});

test('a sub-captain filed into a folder is still the sub-captain of its children', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  sub.captainCrew = false; sub.folderId = 'f1'; // the user dragged it out of the 队长 list
  await r.api.submit({ action: 'complete', result: 'A 在文件夹里也归小队长', files: [] }, kid);
  assert.doesNotMatch(await r.text('main-receipts', r.captain), /A 在文件夹里也归小队长/);
  assert.match(await r.text('main-receipts', sub), /A 在文件夹里也归小队长/);
  assert.match(await r.text('main-ledger', sub), new RegExp(kid.id));
});

// ---- review round 1 (review-opus.md): the three must-fix findings ----
const fromSub = (r, sub) => ((r.state().subReceipts || {})[sub.id] || []);

test('review ①: a working child the user closed reports its failure to its sub-captain, not the Captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话X');
  assert.equal(r.state().tasks.findLast((t) => t.colId === kid.id).status, 'working');
  // the user closes the child's column (not archived; it was no sub-captain, so nothing is handed back)
  r.columns.splice(r.columns.indexOf(kid), 1);
  r.terms.delete(kid.id);
  r.api.onTick(r.captain.id, r.terms.get(r.captain.id));
  await r.settleDown();
  assert.ok(!r.state().pending.some((p) => p.colId === kid.id), 'nothing about the child waits for the Captain');
  assert.ok(fromSub(r, sub).some((p) => p.colId === kid.id && /关掉/.test(p.failed || '')), 'the sub-captain gets the failure');
  assert.match(await r.text('main-receipts', sub), /子会话X/);
});

test('review ①: a queued child that cannot be opened reports to its sub-captain, not the Captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  r.h.memory = 4; // critical memory: new sessions queue
  assert.match(await r.text('create-child', sub, { title: '排队子会话', task: 'x' }), /排队/);
  const waiting = r.state().tasks.findLast((t) => t.title === '排队子会话');
  assert.equal(waiting.status, 'waiting');
  r.h.memory = 1; r.h.failOpen = '排队子会话';
  r.api.onTick(r.captain.id, r.terms.get(r.captain.id));
  await r.settleDown();
  assert.equal(waiting.status, 'failed');
  assert.ok(!r.state().pending.some((p) => p.taskId === waiting.id), 'the Captain does not get it');
  assert.ok(fromSub(r, sub).some((p) => p.taskId === waiting.id && /开不出来/.test(p.failed || '')), 'the sub-captain does');
});

test('review ②: child receipts nobody takes: the sub-captain is reminded once, then the Captain is told once', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  await r.api.submit({ action: 'complete', result: 'A 做完了', files: [] }, kid);
  await r.text('main-receipts', r.captain);
  const entry = Object.assign(r.terms.get(sub.id), { state: 'done', lastOutputAt: Date.now() - 60 * MIN });
  const age = (ms) => { for (const p of fromSub(r, sub)) p.ts = Date.now() - ms; };
  // AgentDeck reports the sub-captain's own `receipts --wait`, like the Captain's.
  const listening = (alive) => r.run('main-receipt-listener-status', sub, { alive });
  // A listener is up: nothing to say.
  await listening(true);
  age(4 * MIN);
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  assert.equal(r.prompts.length, 0);
  // No listener, receipts waiting three minutes, sub-captain idle: one reminder, typed with the draft guard.
  await listening(false);
  age(2 * MIN);
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  assert.equal(r.prompts.length, 0, 'not before three minutes');
  age(4 * MIN);
  entry.state = 'working';
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  assert.equal(r.prompts.length, 0, 'not while it is working');
  entry.state = 'done';
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  assert.equal(r.prompts.length, 1, 'once');
  assert.equal(r.prompts[0].colId, sub.id);
  assert.equal(r.prompts[0].guarded, true);
  assert.match(r.prompts[0].text, /receipts --wait/);
  assert.ok(!r.state().pending.some((p) => p.colId === sub.id), 'the Captain is not bothered yet');
  // Still untaken after ten minutes: the Captain hears about it once.
  age(11 * MIN);
  r.api.onTick(sub.id, entry);
  r.api.onTick(sub.id, entry);
  await r.settleDown();
  const told = await r.text('main-receipts', r.captain);
  assert.match(told, /秋招小队长/);
  assert.match(told, /1 条子会话回执/);
  assert.match(told, /没取/);
  r.api.onTick(sub.id, entry);
  assert.equal(await r.text('main-receipts', r.captain), '没有新的回执。', 'only once');
  // Once it takes them, a later pile-up starts over.
  await r.text('main-receipts', sub);
  r.api.onTick(sub.id, entry);
  await r.api.submit({ action: 'complete', result: '无关', files: [] }, kid); // ignored: no new instruction
  assert.equal(fromSub(r, sub).length, 0);
});

test('review ③: a card-bound sub-captain\'s stage reports leave the card alone; complete --final finishes it once', async () => {
  const r = runtime();
  await r.run('main-new', r.captain, { title: '卡片小队长', task: '统筹', project: '秋招', subCaptain: true, boardId: 'card-1' });
  const sub = r.byTitle('卡片小队长');
  assert.equal(sub.boardId, 'card-1');
  await r.api.submit({ action: 'complete', result: '阶段一', files: [] }, sub);
  await r.api.submit({ action: 'complete', result: '阶段二', files: [] }, sub);
  await r.settleDown();
  const completes = () => r.board.filter((e) => e.op === 'event' && e.type === 'complete').length;
  assert.equal(completes(), 0, 'stage reports do not complete the card');
  const view = await r.text('main-receipts', r.captain);
  assert.match(view, /阶段一/);
  assert.match(view, /阶段二/);
  await r.api.submit({ action: 'complete', result: '最终交付', files: [], final: true }, sub);
  await r.settleDown();
  assert.equal(completes(), 1, 'the final delivery completes it');
  assert.match(await r.text('main-receipts', r.captain), /最终交付/);
  assert.match(M.subCaptainBrief('darwin'), /complete --final/);
});

// docs/sub-captain.md: every complete is a stage report that reaches the Captain, and ask may come
// at any time. A 小队长's question leaves its one dispatch record 'asking'; its next complete or ask
// must not delete what the Captain has not taken yet from that record.
test('a sub-captain asks, then reports a stage before the Captain read either: the Captain gets both', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  await r.api.submit({ action: 'ask', question: '字节名额怎么分？' }, sub);
  await r.api.submit({ action: 'complete', result: '阶段二：JD 分析收齐', files: [] }, sub);
  const view = await r.text('main-receipts', r.captain);
  assert.match(view, /阶段二：JD 分析收齐/);
  assert.match(view, /字节名额怎么分/, 'the question was deleted before the Captain read it');
});

test('a sub-captain\'s stage, question, stage and two questions in a row, none read yet: every one reaches the Captain', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  await r.api.submit({ action: 'complete', result: '阶段一：简历 v1 出了', files: [] }, sub);
  await r.api.submit({ action: 'ask', question: '字节名额怎么分？' }, sub);
  await r.api.submit({ action: 'complete', result: '阶段二：JD 分析收齐', files: [] }, sub);
  await r.api.submit({ action: 'ask', question: '腾讯要不要投？' }, sub);
  await r.api.submit({ action: 'ask', question: '阿里笔试几号？' }, sub);
  const view = await r.text('main-receipts', r.captain);
  for (const said of ['阶段一：简历 v1 出了', '字节名额怎么分', '阶段二：JD 分析收齐', '腾讯要不要投', '阿里笔试几号']) assert.ok(view.includes(said), `lost: ${said}`);
});

test('a sub-captain\'s stage report still replaces an unread automatic notice, and an ordinary worker\'s result its own unread question', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  await r.api.submit({ action: 'complete', result: '阶段一：简历 v1 出了', files: [] }, sub);
  await r.api.submit({ action: 'ask', question: '字节名额怎么分？' }, sub);
  // The 小队长's terminal exits with no new receipt: an automatic notice, not something it said.
  await r.api.submit({ action: 'session-exit', code: 1 }, sub);
  await r.api.submit({ action: 'complete', result: '阶段二：JD 分析收齐', files: [] }, sub);
  const view = await r.text('main-receipts', r.captain);
  assert.match(view, /阶段一：简历 v1 出了/);
  assert.match(view, /字节名额怎么分/);
  assert.match(view, /阶段二：JD 分析收齐/);
  assert.doesNotMatch(view, /未提交回执/, 'the automatic notice gives way to the real report');
  // Unchanged for everyone else: a worker's real result replaces its own unread question.
  await r.run('main-new', r.captain, { title: '普通队员', task: 'x' });
  const worker = r.byTitle('普通队员');
  await r.api.submit({ action: 'ask', question: '用哪个模板？' }, worker);
  await r.api.submit({ action: 'complete', result: '做完了', files: [] }, worker);
  const later = await r.text('main-receipts', r.captain);
  assert.match(later, /做完了/);
  assert.doesNotMatch(later, /用哪个模板/);
});

// A child queued for a slot (memory, concurrency or quota) is the sub-captain's too: its ledger lists
// it under 排队等空位, and the queued request carries its subCaptainId. After a restart nothing on
// the sub-captain's screen keeps it busy (its receipts --wait is gone) and no child receipt waits yet.
test('D: a sub-captain whose only child still waits in the queue is not archived automatically', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  r.h.memory = 4; // critical memory: new sessions queue
  assert.match(await r.text('create-child', sub, { title: '排队子会话', task: 'x' }), /排队/);
  await r.api.submit({ action: 'complete', result: '阶段一：拆好了，子会话排队中', files: [] }, sub);
  await r.text('main-receipts', r.captain);
  r.state().inflight = []; // the Captain finished the turn that read it
  const task = r.state().tasks.findLast((t) => t.colId === sub.id);
  task.doneAt = task.sentAt = Date.now() - 60 * MIN;
  const entry = Object.assign(r.terms.get(sub.id), { state: 'done', lastOutputAt: Date.now() - 60 * MIN });
  r.api.onTick(sub.id, entry);
  assert.ok(r.columns.includes(sub), 'archived while its child waits for a slot');
  assert.equal(r.state().waitlist.find((w) => w.title === '排队子会话')?.metadata?.subCaptainId, sub.id, 'the queued child is still its own');
});

// The 编辑 dialog with a new command or folder respawns the column (renderer.js respawnColumn):
// the same column object, a new id. The stand-in does what respawnColumn does, telling MainSession
// as respawnColumn does for a sub-captain.
function respawn(r, col) {
  const oldId = col.id;
  col.id = 'c-board-respawned-' + oldId;
  r.terms.set(col.id, r.terms.get(oldId));
  r.terms.delete(oldId);
  if (col.subCaptain) r.api.subCaptainIdChanged?.(oldId, col.id);
  return col;
}

test('a sub-captain whose column was respawned with a new id still leads its children', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  await r.api.submit({ action: 'complete', result: 'A 第一轮', files: [] }, kid);
  respawn(r, sub); // the user changed its model in the 编辑 dialog
  await r.text('main-tell', r.captain, { to: kid.id, message: '再做一轮' });
  await r.api.submit({ action: 'complete', result: 'A 第二轮', files: [] }, kid);
  assert.doesNotMatch(await r.text('main-receipts', r.captain), /A 第二轮/, 'a child receipt went to the Captain');
  const subView = await r.text('main-receipts', sub);
  assert.match(subView, /A 第一轮/, 'its untaken receipt from before the respawn is still its own');
  assert.match(subView, /A 第二轮/);
  assert.match(await r.text('main-ledger', sub), new RegExp(kid.id), 'its ledger still lists the child');
  assert.match(await r.text('main-tell', sub, { to: kid.id, message: '第三轮' }), /已发给|待补充/, 'it can still tell its child');
});

// The real board-cli against a stand-in app whose requests the real MainSession answers, by token.
function boardApp(controlDir, callers, r) {
  fs.mkdirSync(path.join(controlDir, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(controlDir, 'responses'), { recursive: true });
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(path.join(controlDir, 'requests')).filter((n) => n.endsWith('.json'))) {
      const file = path.join(controlDir, 'requests', name);
      let request;
      try { request = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file); } catch (_) { continue; }
      const { token, ...message } = request;
      const caller = callers.get(token);
      const reply = (payload) => fs.writeFileSync(path.join(controlDir, 'responses', `${request.id}.json`), JSON.stringify(payload));
      if (!caller) { reply({ done: true, error: 'Control request rejected: terminal is not conductor-managed.' }); continue; }
      Promise.resolve().then(() => r.api.handle({ ...message, callerId: caller.id }, caller)).then(reply, (error) => reply({ done: true, error: error.message }));
    }
  }, 20);
  return () => clearInterval(timer);
}
function boardCli(args, env) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));
    const child = spawn(process.execPath, [path.resolve(__dirname, '../board-cli.js'), ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('discuss is the Captain\'s only: a sub-captain\'s token is refused', async (t) => {
  const r = runtime();
  const sub = await r.subCaptain();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-discuss-test-sub-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  fs.writeFileSync(path.join(profile, 'test-profile.json'), '{}');
  const controlDir = path.join(profile, 'board-control');
  t.after(boardApp(controlDir, new Map([['captain-token', r.captain], ['sub-token', sub]]), r));
  const env = (token) => ({ AGENTDECK_CONTROL_DIR: controlDir, AGENTDECK_CONTROL_TOKEN: token, AGENTDECK_DISCUSS_TEST_PROFILE: profile });
  const captain = await boardCli(['discuss', 'status'], env('captain-token'));
  assert.equal(captain.code, 0, captain.err);
  const fromSub = await boardCli(['discuss', 'status'], env('sub-token'));
  assert.notEqual(fromSub.code, 0, `discuss ran for the sub-captain: ${fromSub.out.trim()}`);
  assert.match(fromSub.err, /只有队长能用/);
});

// A child the user filed into a folder (captainCrew false) is still its sub-captain's (subCaptainId).
// Archived, the sub-captain's ledger offers it as 「tell 会先自动恢复」; tell must then find it.
test('a sub-captain can tell its archived child that had been filed into a folder, as its ledger offers', async () => {
  const r = runtime();
  const sub = await r.subCaptain();
  const kid = await r.child(sub, '子会话A');
  kid.captainCrew = false; kid.folderId = 'f1';
  r.leave(kid, 'archive');
  assert.match(await r.text('main-ledger', sub), new RegExp(`已归档的子会话（tell 会先自动恢复）：${kid.id}`), 'the ledger offers it');
  assert.match(await r.text('main-tell', sub, { to: kid.id, message: '回来再做一点' }), /已恢复|已发给/);
  // Someone else's archived session in a folder is still not the sub-captain's.
  const other = { id: 'c-board-other', title: '别人的', subCaptainId: 'c-board-someone-else', archivedAt: Date.now() };
  r.config.archived.unshift(other);
  await assert.rejects(r.text('main-tell', sub, { to: other.id, message: 'x' }), /不是你开的子会话/);
});
