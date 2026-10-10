'use strict';
// The hub refuses a request body over 2,000,000 bytes (every version), and a client
// sent each captain chat whole in one request: on the user's Mac (2026-10-09) the
// largest live captain chat had reached 991 KB and was growing ~140 KB an hour. Past
// the limit that chat stopped reaching the hub, the phone and the other machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

const TOKEN = 'big-chat-token';
const LIMIT = 2_000_000;

// A captain chat of about `bytes` once serialized: Chinese prose (3 bytes a
// character in UTF-8), quotes and backslashes that JSON escapes, and dispatch cards.
function bigChat(bytes, prefix = '') {
  const turns = [];
  let size = 2;
  for (let i = 0; size < bytes; i++) {
    const turn = {
      kind: i % 3 ? 'turn' : 'card', id: 'turn-' + i, ts: new Date(Date.UTC(2026, 9, 9, 1, 0, i)).toISOString(),
      user: prefix + '队长指令 ' + i, done: true,
      reply: ('回复正文 "引号" \\反斜杠\\ 换行\n表情😀 ').repeat(300) + i,
      ...(i % 3 ? {} : { task: { id: 't-card-' + i, status: 'doing' } }),
    };
    turns.push(turn);
    size += Buffer.byteLength(JSON.stringify(turn)) + 1;
  }
  return { turns };
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const hashOf = (turns) => crypto.createHash('sha256').update(JSON.stringify(turns)).digest('hex');

// An older hub answers 404 to every path it does not know.
function olderHub(fetchImpl) {
  return async (url, options) => {
    const { pathname } = new URL(url);
    if (pathname !== '/v1/history' && pathname.startsWith('/v1/history/')) {
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return fetchImpl(url, options);
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-big-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'hub', 'store.json');
  const hub = { store: new SharedStore({ file }) };
  hub.server = await startSyncServer({ store: hub.store, token: TOKEN });
  t.after(() => hub.server.close());
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  // Every request any client makes goes to the hub serving now.
  const realFetch = (url, options) => fetch(hub.server.url + new URL(url).pathname + new URL(url).search, options);
  const client = (name, { older = false } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    const sent = [];
    const send = older ? olderHub(realFetch) : realFetch;
    const fleet = new FleetClient({
      baseUrl: 'http://hub.invalid', tokenFile, device: { id: 'dev-' + name, name, platform: 'darwin' },
      taskStore: new TaskStore(path.join(dir, 'tasks'), { deviceId: 'dev-' + name }),
      historyDir: path.join(dir, 'history'), stateFile: path.join(dir, 'fleet-state.json'),
      sessions: () => [{ id: 'cap-1', role: 'captain', title: '队长' }], syncMs: 60_000,
      // Records every request body the client sends, and fails like the hub does
      // (it ends the connection) on one over the limit.
      fetchImpl: async (url, options) => {
        const bytes = options.body ? Buffer.byteLength(options.body) : 0;
        sent.push({ path: new URL(url).pathname, bytes });
        if (bytes > LIMIT) throw new TypeError('fetch failed');
        return send(url, options);
      },
    });
    t.after(() => fleet.stop());
    const uploaded = () => sent.filter((item) => item.path.startsWith('/v1/history')).reduce((sum, item) => sum + item.bytes, 0);
    return { fleet, dir, sent, uploaded, reset: () => { sent.length = 0; } };
  };
  // The hub process restarts on the same data file: what it staged in memory is gone.
  const restart = async () => {
    await hub.server.close();
    hub.store = new SharedStore({ file });
    hub.server = await startSyncServer({ store: hub.store, token: TOKEN });
  };
  return { hub, client, restart };
}
const onHub = (f, device = 'dev-mac') => f.hub.store.data.history['cap-1@' + device];
const fileOf = (machine, device = 'dev-mac') => JSON.parse(fs.readFileSync(path.join(machine.dir, 'history', 'cap-1--' + device + '.json'), 'utf8'));

test('a captain chat over 2 MB reaches the hub and the other machine whole', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const win = f.client('win');
  const chat = bigChat(2_600_000);
  assert.ok(Buffer.byteLength(JSON.stringify(chat.turns)) > LIMIT);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.ok(mac.sent.every((item) => item.bytes < LIMIT), 'no single request over the hub limit');
  assert.equal(onHub(f).contentHash, hashOf(chat.turns));
  assert.deepEqual(onHub(f).turns, chat.turns);
  assert.equal((await win.fleet.syncOnce()).error, null);
  assert.deepEqual(fileOf(win).turns, chat.turns, 'the other machine has every turn');
});

test('once the hub has a big chat, a new turn uploads only what is new', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const chat = bigChat(2_600_000);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  // The last reply streams on and a new turn arrives; a dispatch card moves on.
  chat.turns[chat.turns.length - 1].reply += ' 接着写';
  chat.turns.push({ kind: 'turn', id: 'turn-new', ts: '2026-10-09T05:00:00.000Z', user: '新指令', done: true, reply: '新回复' });
  mac.reset();
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.ok(mac.uploaded() < 50_000, `uploaded ${mac.uploaded()} bytes for one new turn`);
  assert.deepEqual(onHub(f).turns, chat.turns);
  assert.equal(onHub(f).contentHash, hashOf(chat.turns));
  // A rewrite in the middle (存看板并清空上下文) sends from that turn on, and the
  // hub still keeps the turn it replaced.
  const before = copy(chat.turns[5]);
  chat.turns[5].reply = '改写后的回复';
  mac.reset();
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.ok(mac.sent.every((item) => item.bytes < LIMIT));
  assert.deepEqual(onHub(f).turns, chat.turns);
  assert.deepEqual(onHub(f).alternatives.at(-1).changed, [{ index: 5, turn: before }]);
});

test('the hub that lost the chat, or restarted halfway through an upload, gets it whole again', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac');
  const chat = bigChat(2_300_000);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  // The hub's file is restored from before the chat existed.
  delete f.hub.store.data.history['cap-1@dev-mac'];
  chat.turns.push({ kind: 'turn', id: 'turn-a', user: '再问', done: true, reply: '再答' });
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.deepEqual(onHub(f).turns, chat.turns, 'sent whole in the same round');
  // The hub restarts after the first pieces arrived and before the chat is put together.
  chat.turns[0].reply = '从头改写';
  mac.fleet.noteCaptain('cap-1', copy(chat));
  const fetchImpl = mac.fleet.fetchImpl;
  let pieces = 0;
  mac.fleet.fetchImpl = async (url, options) => {
    if (new URL(url).pathname === '/v1/history/part' && ++pieces === 2) await f.restart();
    return fetchImpl(url, options);
  };
  assert.notEqual((await mac.fleet.syncOnce()).error, null, 'that round reports the failure');
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.deepEqual(onHub(f).turns, chat.turns);
});

test('a new client with an older hub: small chats sync as before, a big one says the hub needs upgrading', async (t) => {
  const f = await fixture(t);
  const mac = f.client('mac', { older: true });
  const chat = bigChat(300_000);
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  chat.turns.push({ kind: 'turn', id: 'turn-a', user: '再问', done: true, reply: '再答' });
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.deepEqual(onHub(f).turns, chat.turns);
  const big = bigChat(2_300_000, '大 ');
  mac.fleet.noteCaptain('cap-1', copy(big));
  const card = mac.fleet.taskStore.add({ project: 'agentdeck', title: '照常同步的卡' });
  mac.fleet.noteResult(card);
  const error = (await mac.fleet.syncOnce()).error;
  assert.match(error, /超过 2 MB/);
  assert.match(error, /升级/);
  assert.doesNotMatch(error, /连不上/);
  assert.equal(Object.values(f.hub.store.data.cards).filter((item) => item.title === '照常同步的卡').length, 1, 'cards still sync');
  assert.deepEqual(onHub(f).turns, chat.turns, 'the hub keeps the last version it could take');
});

test('an older client keeps saving whole chats on a new hub, and a new client picks up from them', async (t) => {
  const f = await fixture(t);
  const chat = bigChat(500_000);
  const post = (body) => fetch(f.hub.server.url + '/v1/history', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await post({ opId: 'op-older-0001', sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: hashOf(chat.turns), turns: chat.turns, summary: '' });
  assert.equal(answer.status, 200);
  assert.deepEqual(onHub(f).turns, chat.turns);
  const mac = f.client('mac');
  chat.turns.push({ kind: 'turn', id: 'turn-a', user: '再问', done: true, reply: '再答' });
  mac.fleet.noteCaptain('cap-1', copy(chat));
  assert.equal((await mac.fleet.syncOnce()).error, null);
  assert.deepEqual(onHub(f).turns, chat.turns);
});
