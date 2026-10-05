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
  const terms = new Map([[captain.id, { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '' }]]);
  const window = {
    deck: { onTaskStart() {} }, MainCore: M, BoardCore: B, Sidebar: { render() {} },
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
    columnLabel: (col) => col.id, showToast() {}, sendWhenReady() {}, jumpToColumn() {},
    respawnColumn(col) {
      col.isMain = false;
      const fresh = { id: 'captain-us', isMain: true, cmd: col.cmd || 'claude' };
      columns.push(fresh);
      terms.set(fresh.id, { alive: true, state: 'done', lastOutputAt: 0, lastScreen: '' });
      return fresh;
    },
  };
  window.MainSession.init(host);
  return { api: window.MainSession, config, captain, columns, host };
}

function receipt(summary) {
  return { taskId: 'task-' + summary, colId: 'worker', title: summary, ts: Date.now(), summary, files: [] };
}

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
