'use strict';
// The hub keeps the answer to every operation (data.ops) so a retried request gets
// the same answer. For a captain transcript upload that answer was the whole
// history record, never pruned: every save of a growing captain chat kept one more
// full copy, every launch (main.js notes each captain chat again under a new
// operation ID) one more copy of every chat, and the whole file is rewritten on
// each heartbeat. The live hub reached 608 MB on 2026-10-09, past what Node can
// read into one string, and stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');

const DAY = 24 * 60 * 60_000;

function hubAt(t, now = () => Date.parse('2026-10-09T12:00:00Z')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new SharedStore({ file: path.join(root, 'store.json'), now });
}
function push(store, opId, turns) {
  const copy = JSON.parse(JSON.stringify(turns));
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
  return store.pushHistory({ opId, sessionId: 'cap-1', deviceId: 'dev-mac', contentHash, turns: copy, summary: '' });
}
const turn = (i) => ({ kind: 'turn', id: 'turn-' + i, ts: new Date(Date.UTC(2026, 9, 9, 1, i)).toISOString(), user: '指令 ' + i, done: true, reply: '回复'.repeat(400) });

test('the hub file stays proportional to the transcripts it holds as a captain chat grows turn by turn', (t) => {
  const store = hubAt(t);
  const turns = [];
  for (let i = 0; i < 60; i++) {
    turns.push(turn(i));
    push(store, `op-save-${i}-0000`, turns);
  }
  // Two relaunches: every captain chat is noted again with a new operation ID.
  push(store, 'op-launch-1-0000', turns);
  push(store, 'op-launch-2-0000', turns);
  const held = Buffer.byteLength(JSON.stringify(store.snapshot().history));
  const file = fs.statSync(store.file).size;
  t.diagnostic(`history held ${held} bytes; hub file ${file} bytes (${(file / held).toFixed(1)}x)`);
  assert.ok(file < held * 1.5, `hub file is ${(file / held).toFixed(1)}x the history it holds`);
});

test('a transcript upload is answered with a receipt, and a retry gets the same receipt', (t) => {
  const store = hubAt(t);
  const turns = Array.from({ length: 60 }, (_, i) => turn(i));
  const answer = push(store, 'op-save-1-0000', turns);
  const bytes = Buffer.byteLength(JSON.stringify(answer.body));
  t.diagnostic(`transcript ${Buffer.byteLength(JSON.stringify(turns))} bytes uploaded; answer ${bytes} bytes`);
  assert.ok(bytes < 1024, `the answer to one upload is ${bytes} bytes`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.duplicate, false);
  assert.equal(answer.body.contentHash, store.snapshot().history[0].contentHash);
  assert.deepEqual(push(store, 'op-save-1-0000', turns), answer);
  assert.equal(push(store, 'op-save-2-0000', turns).body.duplicate, true);
});

test('receipts older than 30 days are dropped; newer ones keep answering retries', (t) => {
  let now = Date.parse('2026-10-09T12:00:00Z');
  const store = hubAt(t, () => now);
  const set = { title: 'card', project: 'agentdeck', status: 'todo' };
  store.pushTask({ opId: 'op-task-old-0000', cardId: 't-1', expectedRevision: 0, deviceId: 'dev-mac', set });
  now += 31 * DAY;
  const fresh = store.pushTask({ opId: 'op-task-new-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { status: 'doing' } });
  assert.equal(store.data.ops['op-task-old-0000'], undefined, 'a 31-day-old receipt is gone');
  assert.deepEqual(store.pushTask({ opId: 'op-task-new-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { status: 'doing' } }), fresh);
  assert.equal(store.data.cards['t-1'].revision, 2, 'the retry was answered, not applied again');
});

test('a hub file from an older hub has its whole-record receipts shrunk when it loads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'store.json');
  const record = { sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), updatedAt: '2026-10-09T01:00:00.000Z', summary: '', turns: [turn(1)] };
  fs.writeFileSync(file, JSON.stringify({
    version: 1, seq: 7, devices: {}, cards: {}, history: { 'cap-1@dev-mac': record },
    ops: { 'op-hist-0001-x': { status: 200, body: { record, duplicate: false } }, 'op-task-0001-x': { status: 200, body: { card: { id: 't-1' }, merged: false, conflict: false } } },
  }));
  const store = new SharedStore({ file, now: () => Date.parse('2026-10-09T12:00:00Z') });
  const receipt = store.data.ops['op-hist-0001-x'];
  assert.equal(receipt.body.record, undefined);
  assert.deepEqual({ ...receipt.body }, { sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), updatedAt: '2026-10-09T01:00:00.000Z', duplicate: false });
  assert.deepEqual(store.data.ops['op-task-0001-x'].body.card, { id: 't-1' }, 'a card receipt keeps the card its client reads back');
  assert.equal(store.snapshot().history[0].turns.length, 1, 'the transcript itself is untouched');
});
