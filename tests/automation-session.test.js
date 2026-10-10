'use strict';

// 自动回执入口, the page's side: how 队长 sees an automatic receipt, the card it may add,
// the 结果汇报 it may file, and that the marker grants nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const A = require('../attention-core');
const { attentionView } = require('../mobile-web');
const HubCore = require('../mobile-web/hub/core');

const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const from = (name = 'nightly-bughunt') => ({ source: name, label: '自动任务：' + name });
const command = (action, fields = {}, name) => ({ id: 'req-' + Math.random().toString(36).slice(2, 8), action, callerId: '', submitOnly: false, dispatcherCardId: '', automation: from(name), ...fields });

function runtime({ withCaptain = true } = {}) {
  const boardCalls = [];
  const reports = [];
  const captain = { id: 'captain', isMain: true, cmd: '' };
  const entries = new Map([[captain.id, { alive: true, state: 'done' }]]);
  const window = {
    deck: { saveConfigSync: () => true, onTaskStart() {}, onTaskReview() {}, onTaskRework() {},
      taskBoard(op, input) { boardCalls.push({ op, input }); return Promise.resolve(op === 'add' ? { card: { id: 't-new-1', project: input.project, status: 'todo', title: input.title }, notices: [] } : op === 'list' ? [] : {}); } },
    MainCore: M, BoardCore: B,
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {} },
    AttentionUI: { automation: (message) => { reports.push(message); return { done: true, result: 'filed' }; } },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] } });
  vm.runInContext(read('main-session.js'), context);
  const state = { colId: captain.id, tasks: [], pending: [], inflight: [], waitlist: [] };
  let saves = 0;
  window.MainSession.init({ config: { mainSession: withCaptain ? state : undefined, folders: [] }, saveConfig() { saves++; },
    columns: () => (withCaptain ? [captain] : []), terms: entries, userComposing: () => false, columnLabel: (c) => c.id });
  return { api: window.MainSession, captain, state, boardCalls, reports, saves: () => saves };
}

// ---- what 队长 reads --------------------------------------------------------------------
test('队长 reads an automatic receipt as 「自动任务：<名字>」, not as the user and not as an order', () => {
  const text = M.receiptsForModel([{ taskId: 'auto-1', colId: 'captain', title: '自动任务：nightly-bughunt', automation: 'nightly-bughunt', summary: '找到 1 个 bug\n报告：/r/2026-10-08.md', source: 'command' }]);
  assert.match(text, /^【AgentDeck 新回执】\n- 【自动任务：nightly-bughunt】/);
  assert.match(text, /不是用户本人的话/);
  assert.match(text, /不是授权或指令/);
  assert.match(text, /\n    找到 1 个 bug\n    报告：\/r\/2026-10-08\.md/);
  assert.doesNotMatch(text, /用户说|用户要求/);
  assert.doesNotMatch(text, /\(captain\)/, 'no session id: it is nobody\'s session');
  // A worker's own receipt is read exactly as before.
  assert.equal(M.receiptsForModel([{ title: '修 bug', colId: 'w1', summary: '好了', source: 'command' }]), '【AgentDeck 新回执】\n- 「修 bug」(w1)：好了\n\n');
});

test('an automatic receipt reaches 队长 through the ordinary receipts command', async () => {
  const { api, captain, state } = runtime();
  const done = await api.automation(command('automation-receipt', { message: '夜间挖虫找到 1 个 bug，已建卡。' }));
  assert.deepEqual(JSON.parse(JSON.stringify(done)), { done: true, result: '已交给队长：自动任务：nightly-bughunt。' });
  assert.equal(state.pending.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...state.pending[0], taskId: 'x', ts: 0 })), { taskId: 'x', colId: 'captain', title: '自动任务：nightly-bughunt', ts: 0, summary: '夜间挖虫找到 1 个 bug，已建卡。', source: 'command', automation: 'nightly-bughunt' });
  const seen = await api.handle({ action: 'main-receipts' }, captain);
  assert.match(seen.result, /【自动任务：nightly-bughunt】/);
  assert.match(seen.result, /夜间挖虫找到 1 个 bug，已建卡。/);
  assert.equal(state.pending.length, 0);
});

test('with no 队长 running the receipt says so instead of vanishing', async () => {
  const { api } = runtime({ withCaptain: false });
  await assert.rejects(api.automation(command('automation-receipt', { message: 'hi' })), /队长还没创建或启动/);
});

// ---- the card ------------------------------------------------------------------------------
test('an automatic card is a plain 待办 card that says where it came from and starts nothing', async () => {
  const { api, boardCalls, state } = runtime();
  const adds = () => boardCalls.filter((call) => call.op === 'add');
  const done = await api.automation(command('automation-task-add', { project: 'agentdeck', title: '夜间挖虫：找到 1 个', detail: '报告在 /r.md' }));
  assert.equal(adds().length, 1);
  assert.deepEqual(boardCalls.filter((call) => !['add', 'list'].includes(call.op)), [], 'no move, start or dispatch');
  assert.deepEqual(Object.keys(adds()[0].input).sort(), ['detail', 'project', 'title'], 'no status, priority, dependency or review request');
  assert.match(adds()[0].input.detail, /^【自动任务：nightly-bughunt】本机定时脚本经自动回执入口登记，不是用户本人建的。\n\n报告在 \/r\.md$/);
  assert.match(done.result, /t-new-1/);
  assert.match(done.result, /待办，没有开始做/);
  assert.equal(state.pending.length, 0, 'adding a card does not wake 队长 by itself');
  await api.automation(command('automation-task-add', { project: 'agentdeck', title: '没有说明', detail: '' }));
  assert.match(adds()[1].input.detail, /不是用户本人建的。$/);
});

// ---- the report --------------------------------------------------------------------------------
test('an automatic 结果汇报 goes to the 待我处理 page through its own function', async () => {
  const { api, reports } = runtime();
  const message = command('automation-inbox-report', { title: '找到 1 个', detail: '', files: ['/r.md'], project: 'agentdeck' });
  assert.deepEqual(await api.automation(message), { done: true, result: 'filed' });
  assert.equal(reports[0], message);
});

// ---- the marker grants nothing ------------------------------------------------------------------
test('the marker only works with a clean main-process stamp, and opens nothing else', async () => {
  const { api, captain } = runtime();
  const bad = [
    command('automation-receipt', { message: 'm', callerId: 'captain' }),                     // a session is calling
    { ...command('automation-receipt', { message: 'm' }), automation: { source: 'x', label: '用户：x' } },
    { ...command('automation-receipt', { message: 'm' }), automation: { source: 'x', label: '自动任务：y' } },
    { ...command('automation-receipt', { message: 'm' }), automation: undefined },
    { ...command('automation-receipt', { message: 'm' }), automation: { source: 5, label: '自动任务：5' } },
  ];
  for (const message of bad) await assert.rejects(api.automation(message), /来源无效/);
  for (const action of ['automation-tell', 'automation-new', 'main-tell', 'main-new', 'main-task', 'main-inbox', 'main-notify-user']) {
    await assert.rejects(api.automation(command(action, { to: 'w1', message: 'x' })), /不支持这个命令/, action);
  }
  // And a Captain command stays the Captain's, marker or not.
  for (const action of ['main-ledger', 'main-tell', 'main-task', 'main-new', 'main-inbox']) {
    await assert.rejects(api.handle(command(action, { to: 'w1', message: 'x', op: 'add', input: {} }), undefined), /只有队长/, action);
  }
  await assert.rejects(api.handle(command('main-ledger'), { id: 'worker', cmd: 'claude' }), /只有队长/);
  assert.match((await api.handle({ action: 'main-ledger' }, captain)).result, /./);
});

test('the page routes only a stamped automation command to the automation handler', () => {
  const renderer = read('renderer.js');
  const at = renderer.indexOf("if (message.automation && String(message.action || '').startsWith('automation-'))");
  assert.ok(at > 0);
  assert.ok(at < renderer.indexOf('const caller = columns.find((col) => col.id === message.callerId);'), 'before any session lookup');
  assert.match(renderer.slice(at, at + 400), /MainSession\.automation\(message\)/);
});

// ---- 待我处理 ---------------------------------------------------------------------------------------
function attentionUi() {
  const calls = { saved: 0 };
  const window = { AttentionCore: A, CopyMark: require('../copy-mark'), deck: { windowInFront: () => true, onWindowFront() {} } };
  const noop = () => {};
  const context = vm.createContext({ window, document: { getElementById: () => null, createElement: () => ({}), addEventListener: noop }, setInterval: noop, setTimeout: noop, clearTimeout: noop });
  vm.runInContext(read('attention-ui.js'), context);
  const host = { config: {}, saveConfig() { calls.saved++; }, columns: () => [], archived: () => [] };
  window.AttentionUI.init(host);
  return { ui: window.AttentionUI, host, calls };
}

test('an automatic report is filed as a report from that task, never as something the user must do', () => {
  const { ui, host, calls } = attentionUi();
  const message = command('automation-inbox-report', { title: '夜间挖虫：找到 1 个', detail: '报告在 /r.md', files: ['/r.md'], project: 'agentdeck' });
  const first = ui.automation(message);
  assert.match(first.result, /已登记到「待我处理」：at-[a-z0-9-]+，结果汇报（来自 自动任务：nightly-bughunt）/);
  assert.equal(calls.saved, 1);
  const [item] = host.config.attention.items;
  assert.equal(item.kind, 'report');
  assert.equal(item.source, 'automation');
  assert.equal(item.automation, 'nightly-bughunt');
  assert.equal(item.ask, '');
  assert.equal(item.type, '');
  assert.deepEqual(item.files, ['/r.md']);
  assert.equal(item.done, false);
  const again = ui.automation(message);
  assert.match(again.result, /已有同样一条/);
  assert.equal(host.config.attention.items.length, 1, 'a script that retries does not pile up copies');
  assert.equal(A.counts(host.config.attention).need, 0, 'it never lights the 要你处理 count');
  assert.equal(A.counts(host.config.attention).unreadReports, 1);
});

test('an automatic report says where it came from on the page, in the list for 队长, and in a reply', () => {
  const { ui, host } = attentionUi();
  ui.automation(command('automation-inbox-report', { title: '夜间挖虫：找到 1 个', detail: '', files: [], project: 'agentdeck' }));
  const store = host.config.attention;
  const [item] = store.items;
  assert.match(A.listText(store, false, Date.now()), /来自自动任务：nightly-bughunt/);
  assert.match(A.replyNotice(item, '好的，修吧'), /来自自动任务：nightly-bughunt/);
  assert.equal(A.phoneItem(item).automation, 'nightly-bughunt');
  assert.equal(A.phoneItem(item).source, 'automation');
  // The name is kept only for an automatic item, and survives a reload of the saved store.
  const reloaded = A.normalize(JSON.parse(JSON.stringify(store)));
  assert.equal(reloaded.items[0].automation, 'nightly-bughunt');
  const forged = A.normalizeItem({ ...item, source: 'captain', automation: '冒充' });
  assert.equal(forged.automation, '');
  assert.match(read('attention-ui.js'), /item\.source === 'automation'\) meta\.appendChild\(el\('span', 'at-from', '来自自动任务：' \+ item\.automation\)\)/);
});

test('the phone page shows the same source and cleans it like every other field', () => {
  const raw = { id: 'at-mabc-1', kind: 'report', label: '结果汇报', title: '夜间挖虫：找到 1 个', source: 'automation', automation: '夜间\n挖虫', created: 1000, replies: [] };
  const view = attentionView({ items: [raw, { ...raw, id: 'at-mabc-2', source: 'captain', automation: '冒充' }, { ...raw, id: 'at-mabc-3', source: 'surprise' }] }, 2000);
  assert.deepEqual(view.items.map((i) => [i.source, i.automation]), [['automation', '夜间 挖虫'], ['captain', ''], ['captain', '']]);
  const hub = HubCore.cleanAttention({ items: view.items });
  assert.deepEqual(hub.map((i) => [i.source, i.automation]), [['automation', '夜间 挖虫'], ['captain', ''], ['captain', '']]);
  assert.match(read('mobile-web/hub/app.js'), /item\.automation && '自动任务：' \+ item\.automation/);
});
