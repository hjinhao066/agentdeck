'use strict';
// 2.0.1 black window (10-08): the first upload of a whole board rewrote the
// 6 MB fleet-state.json for every pending card on every card sent (453 x 453
// synchronous fsync'd writes), and the main process never got to the window.
// The large fixture is that machine's shape: hundreds of never-synced cards and
// a state file of several MB that still holds 49 captain transcripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore, MUTABLE_KEYS } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient, readFleetSettings, START_DELAY_MS } = require('../sync-client');
const { TaskStore, newCard } = require('../task-board');

const LARGE = { pending: 453, synced: 21, chats: 49, detail: '说明'.repeat(1500) };
const SMALL = { pending: 60, synced: 5, chats: 0, detail: '说明' };
const TOKEN = 'fleet-load-token-value';
const REPLY = '回复正文';

function pick(card) {
  const out = {};
  for (const key of MUTABLE_KEYS) if (card[key] !== undefined) out[key] = card[key];
  return out;
}
function chatTurns(i) {
  return Array.from({ length: 20 }, (_, n) => ({ prompt: `队长 ${i} 第 ${n} 轮`, reply: REPLY.repeat(750), ts: new Date(Date.UTC(2026, 9, 1, 0, i, n)).toISOString() }));
}

async function fixture(t, { pending, synced, chats, detail }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  // Only the client's disk work is measured; the hub keeps its store in memory.
  store._save = () => { store.data.seq += 1; };
  const server = await startSyncServer({ store, token: TOKEN });
  t.after(() => server.close());
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });

  const dir = path.join(root, 'mac');
  const taskDir = path.join(dir, 'tasks');
  fs.mkdirSync(taskDir, { recursive: true });
  const cards = [];
  for (let i = 0; i < pending + synced; i++) {
    const card = newCard({ project: 'agentdeck', title: `卡片 ${i}`, detail }, '2026-10-08T09:00:00.000Z');
    card.order = i;
    if (i >= pending) card.revision = 3;
    cards.push(card);
  }
  fs.writeFileSync(path.join(taskDir, 'agentdeck.json'), JSON.stringify({ version: 1, project: 'agentdeck', cards }, null, 2) + '\n');
  const stateFile = path.join(dir, 'fleet-state.json');
  // The 2.0.1 state file: every pending card queued, transcripts inline.
  fs.writeFileSync(stateFile, JSON.stringify({
    bases: cards.slice(pending).map((card) => [card.id, { revision: card.revision, fields: pick(card) }]),
    taskOutbox: cards.slice(0, pending).map((card, i) => ({ opId: `op-fixture-${i}`, cardId: card.id, expectedRevision: 0, set: pick(card) })),
    historyOutbox: Array.from({ length: chats }, (_, i) => ({ opId: `op-history-${i}`, sessionId: `cap-${i}`, contentHash: String(i % 10).repeat(64), turns: chatTurns(i), summary: '' })),
    devices: [], history: [], lastSyncAt: null,
  }));
  for (const card of cards.slice(pending)) store.pushTask({ opId: 'op-seed-' + card.id.slice(2), cardId: card.id, expectedRevision: 0, deviceId: 'dev-win', set: pick(card) });
  return { root, server, store, tokenFile, dir, taskDir, stateFile, cards };
}

// Counts every fsync'd replace of the state file, board files and downloaded
// transcripts. With a limit, a run past it stops instead of grinding through
// the old ~100,000 writes.
function watchWrites(t, { stateFile, taskDir }, limit = Infinity) {
  const counts = { state: 0, stateBytes: 0, board: 0, history: 0 };
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === stateFile) {
      counts.state += 1;
      counts.stateBytes += fs.statSync(from).size;
      if (counts.state > limit) throw new Error(`fleet-state.json written more than ${limit} times`);
    } else if (path.dirname(to) === taskDir) counts.board += 1;
    else if (path.basename(path.dirname(to)) === 'history') counts.history += 1;
    return rename.apply(this, arguments);
  };
  t.after(() => { fs.renameSync = rename; });
  return counts;
}

// The longest stretch the event loop could not run a 10 ms timer.
function watchLoop() {
  let last = Date.now(), worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  return () => { clearInterval(timer); return Math.max(worst, Date.now() - last); };
}

function client(f, { tasks, fetchImpl } = {}) {
  return new FleetClient({
    baseUrl: f.server.url, tokenFile: f.tokenFile, device: { id: 'dev-mac', name: 'mac', platform: 'darwin' },
    taskStore: tasks || new TaskStore(f.taskDir, { deviceId: 'dev-mac' }),
    historyDir: path.join(f.dir, 'history'), stateFile: f.stateFile,
    sessions: () => [{ id: 'cap-0', role: 'captain', title: '队长' }], version: '2.0.2', syncMs: 60_000,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

test('loading a 6 MB state with 453 queued cards and noting 49 transcripts writes nothing', async (t) => {
  const f = await fixture(t, LARGE);
  assert.ok(fs.statSync(f.stateFile).size > 4_000_000, 'fixture state is several MB');
  const counts = watchWrites(t, f);
  const started = Date.now();
  const fleet = client(f);
  t.diagnostic(`construct ${Date.now() - started} ms, ${counts.state} state writes`);
  assert.equal(counts.state, 0, 'loading and seeding the board writes nothing');
  // main.js notes every captain transcript at startup; unchanged ones are no-ops.
  for (let i = 0; i < LARGE.chats; i++) fleet.noteCaptain(`cap-${i}`, { turns: chatTurns(i) });
  assert.equal(counts.state, 0, 'noting captain transcripts writes nothing');
  assert.equal(fleet.taskOutbox.size, LARGE.pending);
});

test('the first upload of 453 never-synced cards writes the state file at most 20 times and keeps the event loop free', async (t) => {
  const f = await fixture(t, LARGE);
  const counts = watchWrites(t, f, 20);
  const fleet = client(f);
  for (let i = 0; i < LARGE.chats; i++) fleet.noteCaptain(`cap-${i}`, { turns: chatTurns(i) });
  const started = Date.now();
  const stall = watchLoop();
  const snap = await fleet.syncOnce();
  const worstGap = stall();
  t.diagnostic(`first upload: ${counts.state} state writes, ${(counts.stateBytes / 1e6).toFixed(1)} MB, ${counts.board} board writes, sync ${Date.now() - started} ms, worst loop stall ${worstGap} ms`);
  assert.equal(snap.error, null);
  assert.equal(fleet.taskOutbox.size, 0);
  assert.equal(f.store.snapshot().cards.length, LARGE.pending + LARGE.synced);
  assert.equal(f.store.snapshot().history.length, LARGE.chats);
  assert.ok(counts.state <= 20, `state file written ${counts.state} times`);
  assert.ok(counts.board <= 20, `board written ${counts.board} times`);
  assert.ok(worstGap < 1500, `event loop blocked for ${worstGap} ms`);
  // A restart reads the acknowledged state back and has nothing to send.
  assert.equal(client(f).taskOutbox.size, 0);
});

test('reseeding the board leaves unchanged queued cards and their operation IDs alone', async (t) => {
  const f = await fixture(t, SMALL);
  const tasks = new TaskStore(f.taskDir, { deviceId: 'dev-mac' });
  const fleet = client(f, { tasks });
  // The IDs saved by the previous run survive loading and seeding.
  for (let i = 0; i < SMALL.pending; i++) assert.equal(fleet.taskOutbox.get(f.cards[i].id).opId, `op-fixture-${i}`);
  fleet._seedTasks();
  for (const card of tasks.list({ archived: true })) fleet.noteCard(card);
  for (let i = 0; i < SMALL.pending; i++) assert.equal(fleet.taskOutbox.get(f.cards[i].id).opId, `op-fixture-${i}`);

  // A real edit to an unsent card still replaces its queued operation.
  const card = tasks.list().find((item) => item.id === f.cards[1].id);
  fleet.noteResult(tasks.update({ id: card.id, updated: card.updated, patch: { title: '改过的标题' } }));
  assert.notEqual(fleet.taskOutbox.get(card.id).opId, 'op-fixture-1');
  assert.equal(fleet.taskOutbox.get(card.id).set.title, '改过的标题');
});

test('captain transcripts waiting to upload are never written into the state file', async (t) => {
  const f = await fixture(t, SMALL);
  // The hub takes the cards but not the transcripts, so they stay queued.
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/v1/history')) throw new Error('history upload down');
    return fetch(url, options);
  };
  const fleet = client(f, { fetchImpl });
  for (let i = 0; i < 3; i++) fleet.noteCaptain(`cap-${i}`, { turns: chatTurns(i) });
  const snap = await fleet.syncOnce();
  assert.match(snap.error, /同步失败/);
  assert.equal(fleet.historyOutbox.size, 3);
  assert.equal(fleet.taskOutbox.size, 0);
  const saved = fs.readFileSync(f.stateFile, 'utf8');
  assert.ok(saved.includes(f.cards[0].id), 'the round was saved');
  assert.equal(saved.includes(REPLY + REPLY), false, 'captain transcripts stay out of the state file');
  // The next round still uploads them from memory.
  fleet.fetchImpl = fetch;
  assert.equal((await fleet.syncOnce()).error, null);
  assert.equal(f.store.snapshot().history.length, 3);
});

test('an idle round rewrites neither the state file, the board, nor the downloaded transcripts', async (t) => {
  const f = await fixture(t, SMALL);
  const fleet = client(f);
  for (let i = 0; i < 3; i++) fleet.noteCaptain(`cap-${i}`, { turns: chatTurns(i) });
  assert.equal((await fleet.syncOnce()).error, null);
  assert.equal(fs.readdirSync(path.join(f.dir, 'history')).length, 3);
  const counts = watchWrites(t, f);
  assert.equal((await fleet.syncOnce()).error, null);
  assert.equal((await fleet.syncOnce()).error, null);
  assert.deepEqual(counts, { state: 0, stateBytes: 0, board: 0, history: 0 });
});

test('sync waits after launch before its first round', () => {
  assert.equal(START_DELAY_MS, 15_000);
  const env = { AGENTDECK_FLEET_URL: 'http://127.0.0.1:9', AGENTDECK_FLEET_TOKEN_FILE: '/tmp/token' };
  assert.equal(readFleetSettings({ env }).startDelayMs, START_DELAY_MS);
  assert.equal(readFleetSettings({ env: { ...env, AGENTDECK_FLEET_START_DELAY_MS: '0' } }).startDelayMs, 0);
  assert.equal(readFleetSettings({ env: { ...env, AGENTDECK_FLEET_START_DELAY_MS: 'soon' } }).startDelayMs, START_DELAY_MS);
});

// Review of 1a85b2a: the transcripts an older build left in fleet-state.json
// must reach their own files on disk before the state file drops them, and
// stay there until the hub has them, so a crash or a failed upload loses none.
test('transcripts left in an old state file survive a crash during migration and a failed upload', async (t) => {
  const f = await fixture(t, { ...SMALL, chats: 12 });
  const historyDown = async (url, options) => {
    if (url.endsWith('/v1/history')) throw new Error('history upload down');
    return fetch(url, options);
  };
  // Run 1 dies after writing a few migrated files, before saving anything else.
  const rename = fs.renameSync;
  let moved = 0;
  fs.renameSync = function (from, to) {
    if (path.basename(path.dirname(to)) !== path.basename(f.dir) && path.dirname(path.dirname(to)) === f.dir && ++moved > 4) throw new Error('power cut');
    return rename.apply(this, arguments);
  };
  try { client(f, { fetchImpl: historyDown }); } catch (_) {}
  fs.renameSync = rename;
  // Run 2 migrates, saves its round (the old copies leave the state file), and
  // dies with every transcript upload having failed.
  const second = client(f, { fetchImpl: historyDown });
  assert.equal(second.historyOutbox.size, 12);
  assert.match((await second.syncOnce()).error, /同步失败/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8').includes(REPLY + REPLY), false, 'the state file no longer carries them');
  // Run 3 still has all twelve and delivers them.
  const third = client(f);
  assert.equal(third.historyOutbox.size, 12);
  assert.equal((await third.syncOnce()).error, null);
  assert.equal(f.store.snapshot().history.length, 12);
  assert.equal(client(f).historyOutbox.size, 0, 'delivered transcripts are not sent again after a restart');
});

test('old transcripts stay in the state file when their own files cannot be written', async (t) => {
  const f = await fixture(t, { ...SMALL, chats: 3 });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to !== f.stateFile && path.dirname(path.dirname(to)) === f.dir && path.basename(path.dirname(to)) !== 'tasks' && path.basename(path.dirname(to)) !== 'history') throw new Error('disk full');
    return rename.apply(this, arguments);
  };
  const fleet = client(f, { fetchImpl: async (url, options) => { if (url.endsWith('/v1/history')) throw new Error('down'); return fetch(url, options); } });
  await fleet.syncOnce();
  fs.renameSync = rename;
  assert.ok(fs.readFileSync(f.stateFile, 'utf8').includes(REPLY + REPLY), 'unmigrated transcripts are kept where they were');
  const restarted = client(f);
  assert.equal(restarted.historyOutbox.size, 3);
  assert.equal((await restarted.syncOnce()).error, null);
  assert.equal(f.store.snapshot().history.length, 3);
});

test('a whole batch is saved as attempted before its first request, and a crash mid-batch uploads nothing twice', async (t) => {
  const f = await fixture(t, { ...SMALL, pending: 120, synced: 0 });
  let posts = 0, onDisk = null;
  const crashing = async (url, options) => {
    if (url.endsWith('/v1/tasks')) {
      // What the state file says when the first request leaves (asserted below:
      // a throw in here would only become a sync error).
      if (!onDisk) onDisk = JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).taskOutbox.filter((item) => item.attempted).map((item) => item.opId);
      // The power goes after the 70th request reached the hub.
      if (++posts > 70) throw new Error('power cut');
    }
    return fetch(url, options);
  };
  await client(f, { fetchImpl: crashing }).syncOnce();
  assert.deepEqual(onDisk, Array.from({ length: 50 }, (_, i) => `op-fixture-${i}`), 'the first batch of 50 is on disk as attempted');
  const restarted = client(f);
  assert.equal((await restarted.syncOnce()).error, null);
  const cards = f.store.snapshot().cards;
  assert.equal(cards.length, 120);
  assert.ok(cards.every((card) => card.revision === 1 && !(card.conflicts || []).length), 'no card was applied twice');
  assert.equal(restarted.taskOutbox.size, 0);
});

test('one acknowledged card the board rejects does not hold back the rest of its batch', async (t) => {
  const f = await fixture(t, { ...SMALL, pending: 5, synced: 0 });
  const bad = f.cards[2].id;
  const tampering = async (url, options) => {
    const response = await fetch(url, options);
    if (!url.endsWith('/v1/tasks') || JSON.parse(options.body).cardId !== bad) return response;
    const body = await response.json();
    body.card.depends_on = ['t-not-downloaded-yet'];
    return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  const fleet = client(f, { fetchImpl: tampering });
  assert.match((await fleet.syncOnce()).error, /Unknown dependency/);
  assert.deepEqual([...fleet.taskOutbox.keys()], [bad]);
  for (const card of f.cards) if (card.id !== bad) assert.equal(fleet.bases.get(card.id).revision, 1);
});

test('the latest sync time is saved when sync stops, even after idle rounds', async (t) => {
  const f = await fixture(t, SMALL);
  const fleet = client(f);
  assert.equal((await fleet.syncOnce()).error, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await fleet.syncOnce()).error, null);
  const latest = fleet.lastSyncAt;
  fleet.stop();
  assert.equal(client(f).lastSyncAt, latest);
});
