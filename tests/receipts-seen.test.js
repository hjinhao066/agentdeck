'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');

function boot() {
  const captain = { id: 'captain', isMain: true, cmd: 'claude' };
  const columns = [captain];
  const config = {
    folders: [], captainHistory: [], platform: 'darwin',
    mainSession: {
      colId: captain.id, cmd: 'claude', gen: 1, pending: [], inflight: [], tasks: [],
      fresh: false, crewMarked: true, waitlist: [],
    },
  };
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '' }]]), prompts = [], authFailures = [];
  const window = {
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, seatAuthFailure: (input) => { authFailures.push(input); } }, MainCore: M, BoardCore: B, Sidebar: { render() {} },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {}, retireChat: () => null, captainArchives: () => [] },
  };
  const elements = new Map();
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = {
    config, platform: 'darwin', saveConfig() {}, columns: () => columns, terms, userComposing: () => false,
    captainColumnVisible: () => false, isBackstage: () => false,
    columnLabel: (col) => col.id, showToast() {}, sendWhenReady: (_col, text, options) => { prompts.push(text); options?.onSent?.(); }, jumpToColumn() {},
    respawnColumn(col) {
      col.isMain = false;
      const fresh = { id: 'captain-us', isMain: true, cmd: col.cmd || 'claude' };
      columns.push(fresh);
      terms.set(fresh.id, { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '' });
      return fresh;
    },
  };
  window.MainSession.init(host);
  return { api: window.MainSession, config, captain, columns, host, prompts, authFailures };
}

function receipt(summary) {
  return { taskId: 'task-' + summary, colId: 'worker', title: summary, ts: Date.now(), summary, files: [] };
}

test('confirmed seat logout queues one durable question without settling any worker task', async () => {
  const { api, config, captain, host } = boot();
  const task = { id: 'work', colId: 'worker', title: 'pending work', status: 'working' };
  config.mainSession.tasks.push(task);
  let flushed = 0; host.flushConfig = () => { flushed++; };
  const alert = { action: 'seat-auth-alert', nativeSeatAuth: true, alertId: 'alert-us-1', provider: 'Claude', seatId: 'us',
    message: 'US 席位掉登录，任务无法继续。请重新登录；队长请改派其他席位。' };
  await assert.rejects(api.handle({ ...alert, nativeSeatAuth: false }, captain), /只能由程序确认/);
  await api.handle(alert, null);
  await api.handle(alert, null);
  assert.equal(config.mainSession.pending.length, 1);
  assert.equal(config.mainSession.pending[0].question, alert.message);
  assert.equal(config.mainSession.pending[0].source, 'seat-auth');
  assert.equal(task.status, 'working');
  assert.equal(task.receipt, undefined);
  assert.equal(flushed, 1);

  api.init(host);
  const read = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(read.result, /US 席位掉登录/);
  await api.handle(alert, null);
  assert.equal(config.mainSession.pending.length, 0);
  await api.handle({ ...alert, alertId: 'alert-us-2' }, null);
  assert.equal(config.mainSession.pending.length, 1);
});

test('seat authentication signals use authenticated failed receipts, never successful result prose', async () => {
  const { api, config, columns, authFailures } = boot();
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true }; columns.push(worker);
  const assign = (id) => config.mainSession.tasks.push({ id, colId: worker.id, gen: 1, title: id, status: 'working', startedAt: Date.now() });
  assign('failed-login');
  await api.submit({ action: 'complete', result: '任务无法执行', failed: 'Not logged in' }, worker);
  assert.equal(authFailures.length, 1);
  assert.equal(authFailures[0].colId, worker.id);
  assert.equal(authFailures[0].message, 'Not logged in');
  assign('successful-work');
  await api.submit({ action: 'complete', result: '已补 Not logged in 的回归测试' }, worker);
  assert.equal(authFailures.length, 1);
});

test('automatic process failure receipts also signal authentication failures once', () => {
  const { api, config, columns, host, authFailures } = boot();
  const worker = { id: 'worker', cmd: 'claude', captainCrew: true }; columns.push(worker);
  config.mainSession.tasks.push({ id: 'crashed', colId: worker.id, gen: 1, title: 'crashed', status: 'working', startedAt: Date.now() });
  const entry = { alive: false, state: 'exited', lastScreen: '', exitReason: 'Not logged in', lastOutputAt: Date.now() };
  host.terms.set(worker.id, entry);
  api.onTick(worker.id, entry);
  api.onTick(worker.id, entry);
  assert.equal(authFailures.length, 1);
  assert.equal(authFailures[0].message, 'Not logged in');
});

test('a restart does not resend receipts the background channel already returned', async () => {
  const { api, config, captain, host } = boot();
  config.mainSession.pending.push(receipt('already-taken'));
  config.mainSession.inflight.push({ taskId: 'legacy', colId: 'worker', title: '注入', ts: 1, summary: 'typed-not-acked', files: [] });
  const first = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(first.result, /already-taken/);
  assert.equal(config.mainSession.pending.length, 0);
  assert.ok(config.mainSession.receiptsSeen.length >= 1);
  assert.ok(config.mainSession.inflight.some((item) => item.summary === 'already-taken' && config.mainSession.receiptsSeen.includes(item.receiptId)));

  api.init(host);
  assert.equal(config.mainSession.inflight.length, 0);
  assert.deepEqual([...config.mainSession.pending.map((item) => item.summary)], ['typed-not-acked']);
  const again = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(again.result, /typed-not-acked/);
  assert.doesNotMatch(again.result, /already-taken/);
});

test('a receipt that arrives during restart is delivered and an already-read one is not', async () => {
  const { api, config, captain, host } = boot();
  config.mainSession.pending.push(receipt('already-taken'));
  const first = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(first.result, /already-taken/);
  config.mainSession.pending.push(receipt('arrived-during-restart'));

  api.init(host);
  const next = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(next.result, /arrived-during-restart/);
  assert.doesNotMatch(next.result, /already-taken/);
  assert.equal(config.mainSession.pending.length, 0);
});

test('Relay keeps the seen set: already-read receipts are not resent and unread ones are', async () => {
  const { api, config, captain, columns } = boot();
  config.mainSession.pending.push(receipt('already-taken'));
  const first = await api.handle({ action: 'main-receipts', wait: true }, captain);
  assert.match(first.result, /already-taken/);
  config.mainSession.pending.push(receipt('still-unread'));
  const seen = config.mainSession.receiptsSeen.slice();

  const fresh = api.clearContext({ seatId: 'us', checkpointPath: '/tmp/captain-checkpoint.md', relayMessage: 'relay' });
  assert.equal(fresh.id, 'captain-us');
  assert.equal(config.mainSession.colId, 'captain-us');
  assert.deepEqual([...config.mainSession.receiptsSeen], [...seen]);
  assert.deepEqual([...config.mainSession.pending.map((item) => item.summary)], ['still-unread']);

  const caller = columns.find((col) => col.id === 'captain-us');
  const next = await api.handle({ action: 'main-receipts', wait: true }, caller);
  assert.match(next.result, /still-unread/);
  assert.doesNotMatch(next.result, /already-taken/);
});

for (const [status, readBeforeRelay] of [['working', true], ['working', false], ['queued', true], ['queued', false]]) test('Relay reminds unresolved ' + status + ' input once when its previous notification was ' + (readBeforeRelay ? 'read' : 'unread'), async () => {
  const { api, config, captain, columns, host, prompts } = boot();
  const worker = { id: 'worker', cmd: 'codex' }; columns.push(worker);
  const entry = { alive: true, state: 'input', lastOutputAt: Date.now(), lastScreen: 'Delete 40 files? [y/n]' };
  host.terms.set(worker.id, entry);
  const task = { id: 'input-task', colId: worker.id, gen: 1, status, title: 'decision', sentAt: Date.now() };
  config.mainSession.tasks.push(task);
  api.onTick(worker.id, entry);
  assert.equal(task.status, status === 'queued' ? 'queued' : 'input'); assert.equal(config.mainSession.pending.length, 1);
  if (readBeforeRelay) await api.handle({ action: 'main-receipts', wait: true }, captain);
  // An upgrade may still carry the previous version's permanent gate.
  config.mainSession.exceptionSeen = ['worker:input'];
  const fresh = api.clearContext({ seatId: 'us', checkpointPath: '/tmp/captain-checkpoint.md' });
  assert.equal(config.mainSession.pending.length, 1);
  assert.equal(config.mainSession.pending[0].taskId, task.id);
  const text = prompts.at(-1);
  assert.match(text, /receipts --wait 监听（不设超时）/);
  assert.match(text, /没有才安静重挂，不用向用户汇报/);
  assert.doesNotMatch(text, /--timeout 300/);
  assert.match((await api.handle({ action: 'main-receipts', wait: true }, fresh)).result, /Delete 40 files/);
  api.onTick(worker.id, entry);
  assert.equal(config.mainSession.pending.length, 0, 'the same unresolved prompt does not repeat within the new context');
});
