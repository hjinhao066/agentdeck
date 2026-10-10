'use strict';
// On the user's Mac with sync on (2026-10-09) the main process received ~1 MB/s
// from the hub: every 10 s round downloaded every captain transcript again, and
// the hub kept a whole extra copy of a transcript each time a dispatch card in it
// changed state (a turn's `task` field), so the copies piled up (27 copies,
// 20 MB, for one captain chat of 0.46 MB within 5 hours).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

const TOKEN = 'captain-traffic-token';

// A captain chat shaped like the real one: prompts and replies, and every third
// turn a dispatch card whose task status the chat view updates as the worker runs.
function captainChat(count) {
  return {
    turns: Array.from({ length: count }, (_, i) => ({
      kind: i % 3 ? 'turn' : 'card', id: 'turn-' + i, ts: new Date(Date.UTC(2026, 9, 9, 1, i)).toISOString(),
      user: '队长指令 ' + i, done: true, reply: '回复正文'.repeat(200),
      ...(i % 3 ? {} : { task: { id: 't-card-' + i, status: 'doing' } }),
    })),
  };
}
const copy = (value) => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-traffic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: TOKEN });
  t.after(() => server.close());
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const client = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    let roundBytes = 0;
    const fleet = new FleetClient({
      baseUrl: server.url, tokenFile, device: { id: 'dev-' + name, name, platform: 'darwin' },
      taskStore: new TaskStore(path.join(dir, 'tasks'), { deviceId: 'dev-' + name }),
      historyDir: path.join(dir, 'history'), stateFile: path.join(dir, 'fleet-state.json'),
      sessions: () => [{ id: 'cap-1', role: 'captain', title: '队长' }], syncMs: 60_000,
      // Counts every byte the hub sends back (heartbeat, uploads, snapshot, fetches).
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        const text = await response.text();
        roundBytes += Buffer.byteLength(text);
        return new Response(text, { status: response.status, headers: response.headers });
      },
    });
    return { fleet, dir, bytes: () => roundBytes, reset: () => { roundBytes = 0; } };
  };
  return { store, server, client };
}
// The worker behind each card moves on (doing -> review -> done): each move is
// one save of the captain chat, the same as the chat view does.
async function moveCards(mac, chat, moves) {
  for (let k = 0; k < moves; k++) {
    const card = chat.turns[(k * 3) % chat.turns.length];
    card.task = { ...card.task, status: ['review', 'done'][k % 2] };
    mac.fleet.noteCaptain('cap-1', copy(chat));
    assert.equal((await mac.fleet.syncOnce()).error, null);
  }
}
// A GET as a 2.0.2 client makes it: Node's fetch asks for gzip and deflate.
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { authorization: 'Bearer ' + TOKEN, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('dispatch cards changing state in the captain chat keep no whole transcript copies on the hub', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const chat = captainChat(60);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  await moveCards(mac, chat, 20);
  const record = f.store.data.history['cap-1@dev-mac'];
  assert.deepEqual(record.turns.filter((turn) => turn.task).map((turn) => turn.task.status).slice(0, 4), ['review', 'done', 'review', 'done'], 'the hub has the latest card states');
  assert.equal((record.alternatives || []).length, 0, `the hub keeps ${(record.alternatives || []).length} whole copies of a transcript whose only change was card status`);
});

test('a save that rewrites a reply still keeps the version it replaced', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-traffic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SharedStore({ file: path.join(root, 'store.json') });
  const push = (opId, turns) => store.pushHistory({ opId, sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: crypto.createHash('sha256').update(JSON.stringify(turns)).digest('hex'), turns });
  const first = captainChat(3).turns;
  push('op-first-0000', first);
  const rewritten = copy(first);
  rewritten[1].reply = '改写后的回复';
  push('op-rewrite-0000', rewritten);
  const record = store.data.history['cap-1@dev-mac'];
  assert.equal(record.alternatives.length, 1);
  assert.deepEqual(record.alternatives[0].changed, [{ index: 1, turn: first[1] }], 'the turn as it was before the rewrite');
});

test('a hub file with copies kept for card-status moves drops them when it loads; real rewrites stay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-captain-traffic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'store.json');
  const turns = captainChat(6).turns;
  const version = (edit) => { const next = copy(turns); edit(next); return { sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: crypto.randomBytes(32).toString('hex'), summary: '', turns: next }; };
  const a0 = version((v) => { v[1].reply = '最早的回复'; });                    // rewritten later: a real alternative
  const a1 = version(() => {});                                                   // then only card states move
  const a2 = version((v) => { v[0].task.status = 'review'; });
  const current = { ...version((v) => { v[0].task.status = 'done'; v[3].task.status = 'review'; }), alternatives: [a0, a1, a2] };
  fs.writeFileSync(file, JSON.stringify({ version: 1, seq: 1, devices: {}, cards: {}, ops: {}, history: { 'cap-1@dev-mac': current } }));
  const store = new SharedStore({ file });
  const kept = store.data.history['cap-1@dev-mac'].alternatives;
  assert.deepEqual(kept.map((alt) => alt.contentHash), [a0.contentHash]);
});

test('an idle round on the other computer does not download the captain transcripts again', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const win = f.client('win');
  const chat = captainChat(60);
  const transcript = Buffer.byteLength(JSON.stringify(chat.turns));
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  await moveCards(mac, chat, 4);
  assert.equal((await win.fleet.syncOnce()).error, null);
  const file = path.join(win.dir, 'history', 'cap-1--dev-mac.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).turns, chat.turns, 'the other computer has the whole transcript');
  // Nothing changed anywhere: the next round is idle.
  win.reset();
  assert.equal((await win.fleet.syncOnce()).error, null);
  t.diagnostic(`transcript ${transcript} bytes; one idle round downloaded ${win.bytes()} bytes`);
  // Every 10 s (SYNC_MS), so this is per-10-seconds traffic on each computer.
  assert.ok(win.bytes() < transcript / 10, `an idle round downloaded ${win.bytes()} bytes for a ${transcript}-byte transcript nobody changed`);
  // One more card moves: the other computer fetches that transcript once and has it.
  await moveCards(mac, chat, 1);
  assert.equal((await win.fleet.syncOnce()).error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).turns, chat.turns);
  assert.equal(win.fleet.snapshot().history[0].sessionId, 'cap-1');
});

test('a 2.0.2 client still gets whole transcripts, gzipped when it asks for gzip', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const chat = captainChat(60);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  const plain = await rawGet(f.server.url + '/v1/snapshot', {});
  assert.equal(plain.headers['content-encoding'], undefined);
  const zipped = await rawGet(f.server.url + '/v1/snapshot', { 'accept-encoding': 'gzip, deflate' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  const body = JSON.parse(zlib.gunzipSync(zipped.body).toString('utf8'));
  assert.deepEqual(body, JSON.parse(plain.body.toString('utf8')));
  assert.deepEqual(body.history[0].turns, chat.turns, 'the whole transcript, as 2.0.2 reads it');
  t.diagnostic(`snapshot ${plain.body.length} bytes plain, ${zipped.body.length} gzipped`);
  assert.ok(zipped.body.length < plain.body.length / 4);
});
