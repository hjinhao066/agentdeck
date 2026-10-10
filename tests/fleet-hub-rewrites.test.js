'use strict';
// A captain chat rewrites a turn in place now and then (a reply read again off
// the screen, its steps redrawn). The hub kept the whole earlier transcript in
// `alternatives` for each such save, never capped: after the 608 MB outage was
// fixed (2026-10-09) the live hub still grew ~0.8 MB per rewrite of the main
// captain chat, one whole copy each time, 5 copies (4.5 MB) within 4 hours.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');

const turn = (i) => ({ kind: 'turn', id: 'turn-' + i, user: '队长指令 ' + i, reply: '回复正文'.repeat(300) + i, done: true, steps: ['读取', '派活'] });
const chat = (n) => Array.from({ length: n }, (_, i) => turn(i));
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (turns) => crypto.createHash('sha256').update(JSON.stringify(turns)).digest('hex');
function hubIn(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-rewrites-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'store.json');
}
const push = (store, opId, turns) => store.pushHistory({ opId, sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: hash(turns), turns: copy(turns) });

test('a rewritten turn costs the hub that turn, not another whole transcript', (t) => {
  const store = new SharedStore({ file: hubIn(t) });
  const turns = chat(60);
  push(store, 'op-first-0000', turns);
  const before = fs.statSync(store.file).size;
  for (let k = 0; k < 5; k++) {
    turns[10 + k].reply = '重新读出来的回复 ' + k;     // read off the screen again: not a prefix of the old one
    turns.push(turn(60 + k));
    push(store, `op-rewrite-${k}-0000`, turns);
  }
  const grown = fs.statSync(store.file).size - before;
  const oneTurn = Buffer.byteLength(JSON.stringify(turn(0)));
  t.diagnostic(`transcript ${before} bytes; five rewrites grew the hub by ${grown} bytes (one turn is ${oneTurn})`);
  assert.ok(grown < oneTurn * 20, `five one-turn rewrites grew the hub by ${grown} bytes`);
  const record = store.data.history['cap-1@dev-mac'];
  assert.equal(record.alternatives.length, 5);
  assert.deepEqual(record.alternatives[0].changed, [{ index: 10, turn: turn(10) }], 'the turn as it was before the rewrite');
  assert.equal(record.alternatives[0].turns, undefined);
  assert.equal(record.alternatives[0].turnCount, 60);
});

test('a shorter divergent save keeps every turn it dropped or rewrote', (t) => {
  const store = new SharedStore({ file: hubIn(t) });
  const first = { prompt: 'first', reply: 'complete' };
  const second = { prompt: 'second', reply: 'complete' };
  store.pushHistory({ opId: 'op-history-newer', sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), turns: [first, second] });
  store.pushHistory({ opId: 'op-history-diverged', sessionId: 'cap-mac', deviceId: 'dev-mac', contentHash: 'c'.repeat(64), turns: [{ ...first, reply: 'different' }] });
  const alt = store.snapshot().history[0].alternatives[0];
  assert.deepEqual(alt.changed, [{ index: 0, turn: first }, { index: 1, turn: second }]);
  assert.equal(alt.contentHash, 'a'.repeat(64));
});

test('whole-transcript copies an older hub kept become the turns each later save rewrote', (t) => {
  const file = hubIn(t);
  const v1 = chat(4);
  const v2 = copy(v1); v2[1].reply = '第一次改写';
  const v3 = copy(v2); v3[2].reply = '第二次改写'; v3.push(turn(4));
  const record = (turns, extra = {}) => ({ sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: hash(turns), updatedAt: '2026-10-09T01:00:00.000Z', summary: '', turns, ...extra });
  fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 1, devices: {}, cards: {}, ops: {}, history: { 'cap-1@dev-mac': record(v3, { alternatives: [record(v1), record(v2)] }) } }));
  const store = new SharedStore({ file });
  const kept = store.data.history['cap-1@dev-mac'];
  assert.deepEqual(kept.turns, v3);
  assert.deepEqual(kept.alternatives.map((alt) => alt.changed), [[{ index: 1, turn: v1[1] }], [{ index: 2, turn: v2[2] }]]);
  assert.deepEqual(kept.alternatives.map((alt) => alt.contentHash), [hash(v1), hash(v2)]);
  assert.deepEqual(kept.alternatives.map((alt) => alt.turnCount), [4, 4]);
  // loaded again (after the hub saved it), nothing more changes
  store._save();
  assert.deepEqual(new SharedStore({ file }).data.history['cap-1@dev-mac'], JSON.parse(JSON.stringify(kept)));
});
