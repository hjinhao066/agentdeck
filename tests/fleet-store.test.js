'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore, LEASE_MS } = require('../shared-store');
const { TaskStore } = require('../task-board');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function store(t, leaseMs = LEASE_MS) {
  const root = tmp(t);
  let now = Date.parse('2026-10-04T00:00:00.000Z');
  const hub = new SharedStore({ file: path.join(root, 'hub', 'store.json'), leaseMs, now: () => now });
  return { root, hub, advance: (ms) => { now += ms; }, at: () => now };
}
const setOf = (extra) => ({ project: 'agentdeck', title: '共享任务', detail: '说明', status: 'todo', ...extra });

test('heartbeat lease: a machine goes offline 45s after its last heartbeat and stays recoverable', (t) => {
  const { root, hub, advance } = store(t);
  hub.heartbeat({ id: 'dev-mac', name: 'MacBook', platform: 'darwin', version: '1.2.0', sessions: [{ id: 'cap', role: 'captain', title: '队长' }] });
  assert.equal(hub.devices()[0].online, true);
  assert.equal(hub.devices()[0].sessions[0].deviceId, 'dev-mac');
  advance(LEASE_MS);
  assert.equal(hub.devices()[0].online, true);
  advance(1);
  const offline = hub.devices()[0];
  assert.equal(offline.online, false);
  assert.equal(offline.lastSeenAt, '2026-10-04T00:00:00.000Z');
  const again = new SharedStore({ file: path.join(root, 'hub', 'store.json'), now: () => Date.parse('2026-10-04T00:00:46.000Z') });
  assert.equal(again.devices()[0].online, false);
  assert.equal(again.devices()[0].name, 'MacBook');
});

test('disjoint field edits merge; the same field keeps both copies and retries are idempotent', (t) => {
  const { hub } = store(t);
  const created = hub.pushTask({ opId: 'op-create-01', cardId: 'card-1', expectedRevision: 0, deviceId: 'dev-mac', set: setOf({ deviceId: 'dev-other' }) });
  assert.equal(created.status, 200);
  assert.equal(created.body.card.revision, 1);
  assert.equal(created.body.card.deviceId, 'dev-mac');
  const title = hub.pushTask({ opId: 'op-title-0001', cardId: 'card-1', expectedRevision: 1, deviceId: 'dev-mac', set: { title: '甲改的标题' } });
  assert.equal(title.status, 200);
  const detail = hub.pushTask({ opId: 'op-detail-001', cardId: 'card-1', expectedRevision: 1, deviceId: 'dev-win', set: { detail: '乙改的说明' } });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.card.title, '甲改的标题');
  assert.equal(detail.body.card.detail, '乙改的说明');
  assert.equal(detail.body.card.deviceId, 'dev-mac');
  const clash = hub.pushTask({ opId: 'op-clash-0001', cardId: 'card-1', expectedRevision: 1, deviceId: 'dev-win', set: { title: '乙也改了标题' } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.card.title, '甲改的标题');
  assert.equal(clash.body.card.detail, '乙改的说明');
  assert.equal(clash.body.conflict, true);
  const fields = clash.body.card.conflicts.at(-1).fields;
  assert.equal(fields.title.kept, '甲改的标题');
  assert.equal(fields.title.other, '乙也改了标题');
  const replay = hub.pushTask({ opId: 'op-clash-0001', cardId: 'card-1', expectedRevision: 1, deviceId: 'dev-win', set: { title: '不该再写一次' } });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.card.title, '甲改的标题');
  assert.equal(hub.snapshot().cards.filter((card) => card.id === 'card-1').length, 1);
  assert.equal(hub.snapshot().cards[0].trail, undefined);
});

test('captain history ignores a duplicate upload and strips credential fields', (t) => {
  const { hub } = store(t);
  const turns = [{ prompt: '继续看板', token: 'must-not-land', nested: { apiKey: 'nope', note: '留着' } }];
  const first = hub.pushHistory({ opId: 'op-hist-0001', sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), summary: '继续看板', turns });
  assert.equal(first.body.record.turns[0].token, undefined);
  assert.equal(first.body.record.turns[0].nested.apiKey, undefined);
  assert.equal(first.body.record.turns[0].nested.note, '留着');
  const again = hub.pushHistory({ opId: 'op-hist-0002', sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), summary: '继续看板', turns });
  assert.equal(again.body.duplicate, true);
  assert.equal(hub.snapshot().history.length, 1);
  const other = hub.pushHistory({ opId: 'op-hist-0003', sessionId: 'cap-win', deviceId: 'dev-win', contentHash: 'b'.repeat(64), summary: 'Windows 队长', turns: [{ prompt: '另一台' }] });
  assert.equal(other.status, 200);
  assert.equal(hub.snapshot().history.length, 2);
});

test('a corrupt store is left untouched', (t) => {
  const root = tmp(t);
  const file = path.join(root, 'store.json');
  fs.writeFileSync(file, '{');
  assert.throws(() => new SharedStore({ file }), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('synced snapshot replaces the local cache and keeps an unsent local card', (t) => {
  const root = tmp(t);
  const tasks = new TaskStore(path.join(root, 'tasks'), { deviceId: 'dev-mac' });
  const local = tasks.add({ project: 'agentdeck', title: '还没发出去', detail: '本地' }).card;
  assert.equal(local.deviceId, 'dev-mac');
  tasks.replaceSynced([
    { id: 'remote-1', project: 'agentdeck', title: '来自另一台', detail: '共享', status: 'doing', flag: null, order: 0, depends_on: [], assignee: null, session_id: 'worker-1', latest_receipt: '', verify: false, rework_count: 0, created: local.created, updated: local.updated, archived: false, revision: 3, deviceId: 'dev-win', updatedByDevice: 'dev-win' },
  ], [local.id]);
  const ids = tasks.list({ archived: true }).map((card) => card.id).sort();
  assert.deepEqual(ids, [local.id, 'remote-1'].sort());
  tasks.replaceSynced([
    { id: 'remote-1', project: 'agentdeck', title: '来自另一台', detail: '改过', status: 'doing', flag: null, order: 0, depends_on: [], assignee: null, session_id: 'worker-1', latest_receipt: '', verify: false, rework_count: 0, created: local.created, updated: local.updated, archived: false, revision: 4, deviceId: 'dev-win', conflicts: [{ id: 'cf-1', at: local.updated, deviceId: 'dev-mac', baseRevision: 3, fields: { title: { kept: '来自另一台', other: '本地标题' } } }] },
  ]);
  const left = tasks.list({ archived: true });
  assert.deepEqual(left.map((card) => card.id), ['remote-1']);
  assert.equal(left[0].conflicts[0].fields.title.other, '本地标题');
  assert.equal(fs.existsSync(path.join(root, 'tasks', 'agentdeck.json')), true);
});

test('all conflict alternatives survive more than twenty concurrent edits and reload', (t) => {
  const { hub } = store(t);
  hub.pushTask({ opId: 'op-many-create', cardId: 'card-1', expectedRevision: 0, deviceId: 'dev-mac', set: setOf() });
  for (let i = 0; i < 25; i++) hub.pushTask({ opId: 'op-many-conflict-' + i, cardId: 'card-1', expectedRevision: 0, deviceId: 'dev-win', set: { title: 'alternative-' + i } });
  const restored = new SharedStore({ file: hub.file });
  const card = restored.snapshot().cards[0];
  assert.equal(card.conflicts.length, 25);
  assert.equal(card.conflicts[0].fields.title.other, 'alternative-0');
  const local = new TaskStore(path.join(path.dirname(hub.file), 'local'));
  local.upsertSynced(card);
  assert.equal(local.list()[0].conflicts.length, 25);
});

test('older captain uploads cannot shorten history and divergent saves retain both versions', (t) => {
  const { hub } = store(t);
  const push = (opId, hash, turns) => hub.pushHistory({ opId, sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: hash.repeat(64), turns });
  const first = { prompt: 'first', reply: 'complete' };
  const second = { prompt: 'second', reply: 'complete' };
  push('op-history-newer', 'a', [first, second]);
  push('op-history-older', 'b', [first]);
  assert.equal(hub.snapshot().history[0].turns.length, 2);
  push('op-history-diverged', 'c', [{ ...first, reply: 'different' }]);
  const record = hub.snapshot().history[0];
  assert.equal(record.turns[0].reply, 'different');
  assert.deepEqual(record.alternatives[0].turns, [first, second]);
});

test('a late operation replay remains idempotent after more than two thousand other operations', (t) => {
  const { hub } = store(t);
  const input = { opId: 'op-durable-replay', cardId: 'card-1', expectedRevision: 0, deviceId: 'dev-mac', set: setOf() };
  const first = hub.pushTask(input);
  // Represent other clients' already-committed operation receipts without 2000 disk fsyncs.
  for (let i = 0; i < 2000; i++) hub.data.ops['op-other-' + i] = { status: 200, body: {} };
  hub.pushTask({ opId: 'op-next-change', cardId: 'card-1', expectedRevision: 1, deviceId: 'dev-win', set: { title: 'newer' } });
  const reloaded = new SharedStore({ file: hub.file });
  assert.deepEqual(reloaded.pushTask(input), first);
  assert.equal(reloaded.snapshot().cards[0].title, 'newer');
  assert.equal(reloaded.snapshot().cards[0].revision, 2);
  assert.deepEqual(reloaded.snapshot().cards[0].conflicts, []);
});

test('incomplete captain snapshots cannot replace later completed replies', (t) => {
  const { hub } = store(t);
  const push = (opId, hash, turns) => hub.pushHistory({ opId, sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: hash.repeat(64), turns });
  const pending = { id: 'turn-1', prompt: 'question', reply: 'par', done: false, end: null };
  const complete = { ...pending, reply: 'partial became complete', done: true, end: 'complete' };
  push('op-history-pending', 'a', [pending]);
  push('op-history-complete', 'b', [complete]);
  assert.deepEqual(hub.snapshot().history[0].alternatives, []);
  push('op-history-late-pending', 'c', [pending]);
  assert.deepEqual(hub.snapshot().history[0].turns, [complete]);
});

test('all ID dictionaries have no prototype in fresh and loaded stores', (t) => {
  const { hub } = store(t);
  for (const name of ['cards', 'ops', 'devices', 'history']) assert.equal(Object.getPrototypeOf(hub.data[name]), null, name);
  hub.heartbeat({ id: '__proto__', name: 'prototype device', platform: 'win32' });
  const input = { opId: '__proto__', sessionId: 'constructor', deviceId: '__proto__', contentHash: 'a'.repeat(64), turns: [{ prompt: 'ordinary history' }] };
  const first = hub.pushHistory(input);
  assert.equal(first.status, 200);
  assert.deepEqual(hub.pushHistory(input), first);
  const reloaded = new SharedStore({ file: hub.file });
  for (const name of ['cards', 'ops', 'devices', 'history']) assert.equal(Object.getPrototypeOf(reloaded.data[name]), null, name);
  assert.deepEqual(reloaded.pushHistory(input), first);
  assert.equal(reloaded.snapshot().history[0].turns[0].prompt, 'ordinary history');
  assert.equal(reloaded.devices()[0].id, '__proto__');
});
