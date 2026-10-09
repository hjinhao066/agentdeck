'use strict';
// scripts/fleet-store-compact.js: a hub file too large to load (the live one was
// 608 MB on 2026-10-09) is walked entry by entry and rewritten small, with the
// same rules the hub applies when it loads a file it can read.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');
const { compact, main } = require('../scripts/fleet-store-compact');

const NOW = Date.parse('2026-10-09T20:00:00Z');
// Text that trips a byte-level walker if it gets strings wrong.
const TRICKY = '队长说："{不是对象}" [也不是列表] \\ 反斜杠 \\" 引号 😀 , : }';
const turns = (n, edit = () => {}) => {
  const list = Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'turn' : 'card', id: 'turn-' + i, user: TRICKY + i, reply: '回复' + i, done: true, ...(i % 2 ? {} : { task: { id: 't-' + i, status: 'doing' } }) }));
  edit(list);
  return list;
};
const record = (list) => ({ sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex'), updatedAt: '2026-10-09T01:00:00.000Z', summary: TRICKY, turns: list });

function oldHubFile() {
  const rewritten = record(turns(4, (l) => { l[1].reply = '最早的回复'; }));           // a real alternative
  const moved = record(turns(4));                                                         // superseded by a card move only
  const current = { ...record(turns(4, (l) => { l[0].task.status = 'done'; })), alternatives: [rewritten, moved] };
  return {
    version: 1, seq: 42,
    devices: { 'dev-mac': { id: 'dev-mac', name: TRICKY, platform: 'darwin', lastSeenAt: '2026-10-09T18:17:08.000Z', sessions: [] } },
    cards: { 't-1': { id: 't-1', title: TRICKY, project: 'agentdeck', status: 'doing', revision: 3, trail: [{ revision: 3, keys: ['status'] }], conflicts: [] } },
    ops: {
      'op-hist-0001': { status: 200, body: { record: current, duplicate: false } },
      'op-hist-0002': { status: 200, body: { record: current, duplicate: true } },
      'op-task-0001': { status: 200, body: { card: { id: 't-1', title: TRICKY }, merged: false, conflict: false } },
    },
    history: { 'cap-1@dev-mac': current, 'cap-2@dev-win': { ...record(turns(2)), sessionId: 'cap-2', deviceId: 'dev-win' } },
  };
}
function files(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-store-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'old', 'store.json');
  fs.mkdirSync(path.dirname(input));
  fs.writeFileSync(input, JSON.stringify(oldHubFile()));
  return { root, input, output: path.join(root, 'new', 'store.json') };
}

test('the compacted file keeps cards, devices and transcripts, names each upload instead of copying it, and drops card-move copies', (t) => {
  const { input, output } = files(t);
  const before = fs.readFileSync(input);
  const log = t.mock.method(console, 'log', () => {});
  assert.equal(main([input, output]), 0);
  assert.ok(fs.readFileSync(input).equals(before), 'the old file is only read');
  const old = oldHubFile();
  const hub = new SharedStore({ file: output });
  assert.deepEqual(JSON.parse(JSON.stringify(hub.data.cards)), old.cards);
  assert.deepEqual(JSON.parse(JSON.stringify(hub.data.devices)), old.devices);
  assert.equal(hub.data.seq, 42);
  const kept = hub.data.history['cap-1@dev-mac'];
  assert.deepEqual(kept.turns, old.history['cap-1@dev-mac'].turns);
  assert.deepEqual(kept.alternatives.map((alt) => alt.changed), [[{ index: 1, turn: old.history['cap-1@dev-mac'].alternatives[0].turns[1] }]], 'the rewritten reply stays (that turn only), the card-move copy goes');
  assert.deepEqual(hub.data.history['cap-2@dev-win'], old.history['cap-2@dev-win']);
  assert.deepEqual({ ...hub.data.ops['op-hist-0002'].body }, { sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: kept.contentHash, updatedAt: kept.updatedAt, duplicate: true });
  assert.deepEqual(hub.data.ops['op-task-0001'].body, old.ops['op-task-0001'].body);
  const stats = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(stats.receiptsShrunk, 2);
  assert.equal(stats.copiesBefore, 2);
  assert.equal(stats.copiesAfter, 1);
  assert.ok(stats.bytesAfter < stats.bytesBefore);
});

test('it gives what the hub itself makes of a file it can still load', (t) => {
  const { input } = files(t);
  const { data } = compact(fs.readFileSync(input), NOW);
  const hub = new SharedStore({ file: input, now: () => NOW });
  assert.equal(JSON.stringify(data), JSON.stringify(hub.data));
});

test('it never replaces an existing file, nor writes over its input', (t) => {
  const { input, output } = files(t);
  fs.mkdirSync(path.dirname(output));
  fs.writeFileSync(output, 'keep me');
  assert.throws(() => main([input, output]), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep me');
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(main([input, input]), 2);
  assert.equal(error.mock.callCount(), 1);
});

test('a file that is not a fleet hub file is refused', (t) => {
  const { root } = files(t);
  const other = path.join(root, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ version: 2, cards: {}, devices: {}, history: {} }));
  assert.throws(() => main([other, path.join(root, 'out.json')]), /Not a version 1 fleet hub file/);
  assert.equal(fs.existsSync(path.join(root, 'out.json')), false);
});
