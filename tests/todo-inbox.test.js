'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const B = require('../board-core');
const key = 'todo-' + 'a'.repeat(64);
const errorKey = 'todo-error-' + 'b'.repeat(64);

function boot(saved) {
  const captain = { id: 'captain', isMain: true, cmd: 'claude' }, columns = [captain];
  const config = { folders: [], captainHistory: [], todoDeliveries: {}, todoInbox: {}, mainSession: {
    colId: captain.id, cmd: captain.cmd, gen: 1, pending: [], inflight: [], tasks: [], waitlist: [],
  } };
  if (saved) Object.assign(config, JSON.parse(JSON.stringify(saved)));
  let durable, saveWorks = true;
  const window = {
    MainCore: M, BoardCore: B, Sidebar: { render() {} },
    deck: { onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, saveConfigSync(value) {
      if (!saveWorks) return false;
      durable = JSON.parse(JSON.stringify(value)); return true;
    } },
    ChatUI: { hasDraft: () => false, turnsOf: () => [], updateCard() {}, addCard() {} },
  };
  const elements = new Map();
  const context = vm.createContext({ window, document: {
    getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); },
    querySelectorAll: () => [],
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = { config, platform: 'darwin', columns: () => columns, terms: new Map(),
    saveConfig() {}, flushConfig() {}, userComposing: () => false, columnLabel: (col) => col.id,
    captainTurnDone() {}, showToast() {}, jumpToColumn() {}, sendWhenReady(_col, _text, options) { options?.onSent?.(); },
    createMain({ cmd }) { const col = { id: 'new-captain', isMain: true, cmd }; columns.push(col); return col; },
  };
  const api = window.MainSession; api.init(host);
  const delivery = (caller = captain) => api.handle({ id: 'delivery', action: 'main-todo-delivery', nativeWeb: true, taskId: key, result: '待办原文和任务说明' }, caller);
  function recreate() { columns.forEach((col) => { col.isMain = false; }); config.mainSession = null; return api.create('claude', ''); }
  return { api, config, host, captain, columns, delivery, recreate, window,
    failSave(value) { saveWorks = !value; }, durable: () => durable };
}

test('unread Todo persists outside Captain and is restored after deletion/recreation once', async () => {
  const w = boot(); await w.delivery(); await w.delivery();
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(Object.keys(w.durable().todoInbox).length, 1);
  assert.equal(w.config.todoDeliveries[key], undefined, 'acceptance is not confirmation');
  const fresh = w.recreate();
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.pending[0].colId, fresh.id);
  await w.delivery(fresh);
  assert.equal(w.config.mainSession.pending.length, 1);
  const reply = await w.api.handle({ action: 'main-receipts', wait: true }, fresh);
  assert.match(reply.result, /待办原文和任务说明/);
  assert.equal(Object.keys(w.durable().todoInbox).length, 0);
  assert.equal(w.durable().todoDeliveries[key], true);
  const another = w.recreate(); await w.delivery(another);
  assert.equal(w.config.mainSession.pending.length, 0, 'confirmed versions never repeat');
});

test('a persisted queue survives app restart with no Captain and waits for the newly created Captain', async () => {
  const first = boot(); await first.delivery();
  const saved = first.durable(); saved.mainSession = null;
  const next = boot(saved);
  assert.equal(next.config.mainSession, null);
  assert.equal(Object.keys(next.config.todoInbox).length, 1);
  const captain = next.recreate();
  assert.equal(next.config.mainSession.pending.length, 1);
  assert.match((await next.api.handle({ action: 'main-receipts' }, captain)).result, /待办原文和任务说明/);
  assert.equal(Object.keys(next.durable().todoInbox).length, 0);
});

test('relaunch restores one unread copy and migrates old acceptance-only pending data', async () => {
  const w = boot(); await w.delivery();
  w.config.todoInbox = {}; w.config.todoDeliveries[key] = true;
  w.api.init(w.host);
  assert.equal(Object.keys(w.config.todoInbox).length, 1);
  assert.equal(w.config.todoDeliveries[key], undefined);
  assert.equal(w.config.mainSession.pending.length, 1);
  w.api.init(w.host);
  assert.equal(w.config.mainSession.pending.length, 1);
  await w.api.handle({ action: 'main-receipts' }, w.captain);
  w.api.init(w.host);
  assert.equal(w.config.mainSession.pending.length, 0);
  assert.equal(Object.keys(w.config.todoInbox).length, 0);
});

test('native snapshot is read-only; only ack clears durable Todo queue and deduplicates later retries', async () => {
  const w = boot(); await w.delivery();
  const snapshot = JSON.parse((await w.api.handle({ action: 'main-receipts-snapshot' }, w.captain)).result);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(Object.keys(w.config.todoInbox).length, 1);
  const fresh = w.recreate();
  await w.api.handle({ action: 'main-receipts-ack', receiptIds: [snapshot.receipts[0].receiptId] }, fresh);
  assert.equal(Object.keys(w.durable().todoInbox).length, 0);
  assert.equal(w.durable().todoDeliveries[key], true);
  await w.delivery(fresh);
  assert.equal(w.config.mainSession.pending.length, 0);
});

test('failed synchronous acceptance rolls back and can safely retry', async () => {
  const w = boot(); w.failSave(true);
  await assert.rejects(w.delivery(), /持久保存/);
  assert.equal(w.config.mainSession.pending.length, 0);
  assert.equal(Object.keys(w.config.todoInbox).length, 0);
  w.failSave(false); await w.delivery();
  assert.equal(w.config.mainSession.pending.length, 1);
});

for (const mode of ['main-receipts', 'main-receipts-ack']) test(mode + ' save failure leaves queue and pending unread for retry', async () => {
  const w = boot(); await w.delivery(); w.failSave(true);
  const message = { action: mode, receiptIds: ['r-' + key] };
  await assert.rejects(w.api.handle(message, w.captain), /持久保存/);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.inflight.length, 0);
  assert.equal(Object.keys(w.config.todoInbox).length, 1);
  assert.equal(w.config.todoDeliveries[key], undefined);
  assert.equal(w.config.mainSession.receiptsSeen.length, 0);
  w.failSave(false); await w.api.handle(message, w.captain);
  assert.equal(w.config.mainSession.pending.length, 0);
  assert.equal(Object.keys(w.durable().todoInbox).length, 0);
});

test('backend exception receipts use the same durable Captain channel and survive recreation', async () => {
  const w = boot();
  const error = { id: errorKey, action: 'main-todo-error', nativeWeb: true, stage: 'scan', result: 'Todo 后台扫描出错，稍后重试。' };
  await w.api.handle(error, w.captain); await w.api.handle(error, w.captain);
  assert.equal(w.config.mainSession.pending.length, 1);
  const fresh = w.recreate();
  const reply = await w.api.handle({ action: 'main-receipts' }, fresh);
  assert.match(reply.result, /Todo 后台扫描出错/);
  await w.api.handle(error, fresh);
  assert.equal(w.config.mainSession.pending.length, 0);
});

function legacyTurn(w) {
  w.config.mainSession.legacyReceiptInjection = true;
  const prefix = w.api.outgoingPrefix(w.captain);
  assert.match(prefix, /待办原文和任务说明/);
  w.config.mainSession.inflight[0].deliveryTurnId = 'legacy-turn';
  return { id: 'legacy-turn', ts: Date.now(), done: true, reply: '收到' };
}

test('a finished legacy-injected turn confirms the durable Todo receipt before removing inflight', async () => {
  const w = boot(); await w.delivery();
  const turn = legacyTurn(w);
  assert.equal(Object.keys(w.config.todoInbox).length, 1, 'typing a prefix is not confirmation');
  w.api.onTurnDone(w.captain.id, turn);
  assert.equal(Object.keys(w.durable().todoInbox).length, 0);
  assert.equal(w.durable().todoDeliveries[key], true);
  assert.equal(w.config.mainSession.inflight.length, 0);
  const fresh = w.recreate(); await w.delivery(fresh);
  assert.equal(w.config.mainSession.pending.length, 0);
});

test('an interrupted legacy turn leaves Todo unread and requeues it without confirming', async () => {
  const w = boot(); await w.delivery(); const turn = legacyTurn(w);
  w.api.onTurnDone(w.captain.id, { ...turn, interrupted: true });
  assert.equal(Object.keys(w.config.todoInbox).length, 1);
  assert.equal(w.config.todoDeliveries[key], undefined);
  assert.equal(w.config.mainSession.pending.length, 1);
  assert.equal(w.config.mainSession.pending[0].deliveryTurnId, undefined);
  assert.equal(w.config.mainSession.inflight.length, 0);
});

test('legacy delivery confirmation save failure keeps the durable queue and inflight for retry and reports it', async () => {
  const w = boot(); await w.delivery(); const turn = legacyTurn(w), notices = [];
  w.host.showToast = (message) => notices.push(message); w.failSave(true);
  w.api.onTurnDone(w.captain.id, turn);
  assert.equal(Object.keys(w.config.todoInbox).length, 1);
  assert.equal(w.config.todoDeliveries[key], undefined);
  assert.equal(w.config.mainSession.inflight.length, 1);
  assert.equal(notices.length, 1);
  w.failSave(false); w.api.onTurnDone(w.captain.id, turn);
  assert.equal(Object.keys(w.durable().todoInbox).length, 0);
  assert.equal(w.config.mainSession.inflight.length, 0);
});
