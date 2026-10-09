'use strict';
// 小队长 (sub-captain): a background session the Captain opens with `new --sub-captain`.
// It opens its own child sessions with create-child; their receipts, questions and
// confirmation prompts go to its own `receipts`, never to the Captain's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

const MIN = 60_000;

function runtime() {
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const columns = [captain];
  const config = { mainSession: null, folders: [], archived: [] };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastScreen: '' }]]);
  const sent = [], cards = [];
  let turn = 0;
  const window = {
    MainCore: M, BoardCore: B,
    QuotaCore: { quotaFallback: (_q, cmd) => ({ action: 'open', cmd }), commandQuota: () => ({ out: false }) },
    ChatUI: { addCard: (colId, task) => cards.push({ colId, taskId: task.id }), updateCard() {}, hasDraft: () => false, turnsOf: () => [] },
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, saveConfigSync: () => true,
      memoryPressure: async () => ({ level: 1 }), taskBoard: async (op) => (op === 'list' ? [] : {}),
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
    lastTurnTs: () => 0, dumpScreen: (term) => term.screen || '', agentInForeground: async () => true,
    createMain: (c) => { const col = { ...c, id: 'captain' }; return col; },
    createSession: (c) => {
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
  return { api, captain, columns, config, terms, sent, cards, run, text, byTitle, subCaptain, child, leave, state: () => config.mainSession };
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
