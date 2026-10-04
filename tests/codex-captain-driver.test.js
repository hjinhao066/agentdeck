'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriver } = require('../codex-captain-driver');
const tick = () => new Promise((r) => setImmediate(r));

function fixture(options = {}) {
  const sent = [], ack = [], errors = [];
  const driver = createDriver({
    rpc: async (method, params) => { sent.push({ method, params }); return { turn: { id: 't' + sent.length } }; },
    snapshot: async () => ({ active: true, unread: 1, open: 3, receipts: [{ receiptId: 'r-1', summary: 'worker complete' }] }),
    acknowledge: async (ids) => ack.push(ids), onError: (e) => errors.push(e.message), intervalMs: 100000,
    ...options,
  });
  driver.bind('captain');
  return { driver, sent, ack, errors };
}

test('timer starts a native tool-output turn without user input or receipt consumption', async () => {
  const f = fixture({ intervalMs: 15 });
  try {
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(f.sent.length, 1, 'in-flight turns coalesce further timer ticks');
    assert.equal(f.sent[0].method, 'turn/start');
    assert.deepEqual(f.sent[0].params.input, []);
    assert.equal(JSON.parse(f.sent[0].params.toolOutput.output).receipts[0].receiptId, 'r-1');
    assert.deepEqual(f.ack, [], 'acceptance is not completion');
  } finally { f.driver.close(); }
});

test('successful completion acknowledges only the exact delivered receipt ids', async () => {
  const f = fixture();
  try {
    await f.driver.requestCheck();
    f.driver.event('turn/completed', { threadId: 'other', turn: { id: 't1', status: 'completed' } });
    await tick(); assert.deepEqual(f.ack, []);
    f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status: 'completed' } });
    await tick(); assert.deepEqual(f.ack, [['r-1']]);
    f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status: 'completed' } });
    await tick(); assert.equal(f.ack.length, 1);
  } finally { f.driver.close(); }
});

test('failed and interrupted turns leave receipts unread for retry', async () => {
  for (const status of ['failed', 'interrupted']) {
    const f = fixture();
    try {
      await f.driver.requestCheck();
      f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status } });
      await tick(); assert.deepEqual(f.ack, []);
      await f.driver.requestCheck(); assert.equal(f.sent.length, 2);
    } finally { f.driver.close(); }
  }
});

test('clear rebind ignores old completions and keeps one scheduler', async () => {
  const f = fixture();
  try {
    await f.driver.requestCheck();
    f.driver.bind('fresh');
    f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status: 'completed' } });
    await tick(); assert.deepEqual(f.ack, []);
    await f.driver.requestCheck(); assert.equal(f.sent[1].params.threadId, 'fresh');
  } finally { f.driver.close(); }
});

test('RPC and acknowledgement failures retain receipts and do not spin', async () => {
  const f = fixture({ rpc: async () => { throw new Error('disconnected'); } });
  try {
    await f.driver.requestCheck(); await tick();
    assert.deepEqual(f.errors, ['disconnected']); assert.deepEqual(f.ack, []);
  } finally { f.driver.close(); }
  const g = fixture({ acknowledge: async () => { throw new Error('ack failed'); } });
  try {
    await g.driver.requestCheck();
    g.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status: 'completed' } });
    await tick(); assert.deepEqual(g.errors, ['ack failed']);
  } finally { g.driver.close(); }
});

test('finished boards do not start model turns', async () => {
  const f = fixture({ snapshot: async () => ({ active: false }) });
  try { await f.driver.requestCheck(); assert.deepEqual(f.sent, []); } finally { f.driver.close(); }
});

test('a user turn starting during snapshot prevents a second turn from being queued', async () => {
  let resolve;
  const f = fixture({ snapshot: () => new Promise((r) => { resolve = r; }) });
  try {
    const checking = f.driver.requestCheck();
    f.driver.event('turn/started', { threadId: 'captain', turn: { id: 'user' } });
    resolve({ active: true, receipts: [] }); await checking;
    assert.deepEqual(f.sent, []);
  } finally { f.driver.close(); }
});

test('completion before the turn/start response is still acknowledged once', async () => {
  let f;
  f = fixture({ rpc: async () => {
    f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 'fast', status: 'completed' } });
    await tick(); return { turn: { id: 'fast' } };
  } });
  try { await f.driver.requestCheck(); await tick(); assert.deepEqual(f.ack, [['r-1']]); } finally { f.driver.close(); }
});

test('a lost RPC response cannot start a second turn while the accepted turn is running', async () => {
  let f, calls = 0;
  f = fixture({ rpc: async () => {
    calls++;
    f.driver.event('turn/started', { threadId: 'captain', turn: { id: 'accepted' } });
    throw new Error('response lost');
  } });
  try {
    await f.driver.requestCheck(); await f.driver.requestCheck();
    assert.equal(calls, 1); assert.deepEqual(f.ack, []);
  } finally { f.driver.close(); }
});

test('shutdown ignores late completions and cancels the scheduler', async () => {
  const f = fixture({ intervalMs: 15 });
  await f.driver.requestCheck(); f.driver.close();
  f.driver.event('turn/completed', { threadId: 'captain', turn: { id: 't1', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 45));
  assert.deepEqual(f.ack, []); assert.equal(f.sent.length, 1);
});
