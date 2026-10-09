'use strict';
// Each card operation's receipt kept a whole copy of the card (median 1.8 KB on the
// live hub, up to the 2 MB a detail may hold) for 30 days, and the whole hub file is
// rewritten on every heartbeat. A retry is answered with the card as the hub has it
// now, which is what the client takes as its base anyway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');

function hubFile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-card-receipts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'store.json');
}
const create = { title: '卡片', project: 'agentdeck', status: 'todo', detail: '很长的说明'.repeat(10_000) };

test('a card operation keeps no copy of the card for its replay', (t) => {
  const hub = new SharedStore({ file: hubFile(t) });
  const first = hub.pushTask({ opId: 'op-create-0000', cardId: 't-1', expectedRevision: 0, deviceId: 'dev-mac', set: create });
  assert.equal(first.body.card.detail, create.detail, 'the answer itself still carries the card');
  const receipt = Buffer.byteLength(JSON.stringify(hub.data.ops['op-create-0000']));
  t.diagnostic(`card ${Buffer.byteLength(JSON.stringify(first.body.card))} bytes; receipt ${receipt} bytes`);
  assert.ok(receipt < 256, `the receipt is ${receipt} bytes`);
});

test('a retry is answered with the card as the hub has it now, and is not applied again', (t) => {
  const hub = new SharedStore({ file: hubFile(t) });
  hub.pushTask({ opId: 'op-create-0000', cardId: 't-1', expectedRevision: 0, deviceId: 'dev-mac', set: create });
  const doing = { opId: 'op-doing-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { status: 'doing' } };
  const first = hub.pushTask(doing);
  assert.equal(first.body.card.revision, 2);
  hub.pushTask({ opId: 'op-title-0000', cardId: 't-1', expectedRevision: 2, deviceId: 'dev-win', set: { title: '新标题' } });
  const again = new SharedStore({ file: hub.file }).pushTask(doing);
  assert.equal(again.status, 200);
  assert.deepEqual({ ...again.body, card: undefined }, { ...first.body, card: undefined }, 'same outcome (merged, conflict)');
  assert.equal(again.body.card.revision, 3, 'not applied a second time');
  assert.equal(again.body.card.title, '新标题');
  assert.equal(again.body.card.status, 'doing');
});

test('a replayed conflict is still a conflict', (t) => {
  const hub = new SharedStore({ file: hubFile(t) });
  hub.pushTask({ opId: 'op-create-0000', cardId: 't-1', expectedRevision: 0, deviceId: 'dev-mac', set: create });
  hub.pushTask({ opId: 'op-mac-title-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { title: 'Mac 的标题' } });
  const late = { opId: 'op-win-title-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-win', set: { title: 'Windows 的标题' } };
  const first = hub.pushTask(late);
  assert.equal(first.status, 409);
  const again = hub.pushTask(late);
  assert.equal(again.status, 409);
  assert.equal(again.body.conflict, true);
  assert.equal(again.body.card.conflicts.length, 1, 'no second conflict');
});

test('card receipts an older hub kept whole name their card when it loads, and replay as above', (t) => {
  const file = hubFile(t);
  const card = { id: 't-1', title: '卡片', project: 'agentdeck', status: 'doing', revision: 4, conflicts: [], trail: [{ revision: 4, keys: ['status'] }] };
  fs.writeFileSync(file, JSON.stringify({
    version: 1, seq: 3, devices: {}, cards: { 't-1': card }, history: {},
    ops: { 'op-old-card-0000': { status: 200, body: { card: { ...card, revision: 2, status: 'todo' }, merged: false, conflict: false } } },
  }));
  const hub = new SharedStore({ file });
  assert.deepEqual({ ...hub.data.ops['op-old-card-0000'].body }, { cardId: 't-1', merged: false, conflict: false });
  const replay = hub.pushTask({ opId: 'op-old-card-0000', cardId: 't-1', expectedRevision: 1, deviceId: 'dev-mac', set: { status: 'todo' } });
  assert.equal(replay.body.card.revision, 4);
  assert.equal(replay.body.card.trail, undefined, 'the public card, as every answer gives it');
});
