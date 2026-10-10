'use strict';
// A git rebase on the shared ~/.agents folder can put an older copy of a card file back
// for a moment. The sync client must not push that copy as this machine's edit: the hub
// keeps the finished card, but every push would still leave one more conflict record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

const TOKEN = 'fleet-secret-token-value';
async function hub(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json') });
  const server = await startSyncServer({ store, token: TOKEN });
  t.after(() => server.close());
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  return { root, server, store, tokenFile };
}
function machine(root, name, id, url, tokenFile) {
  const dir = path.join(root, name);
  const tasks = new TaskStore(path.join(dir, 'tasks'), { deviceId: id });
  const posts = [];
  const fetchImpl = async (target, options) => {
    if (options && options.method === 'POST' && String(target).endsWith('/v1/tasks')) posts.push(JSON.parse(options.body));
    return fetch(target, options);
  };
  const client = new FleetClient({
    baseUrl: url, tokenFile, device: { id, name, platform: 'darwin' }, taskStore: tasks,
    historyDir: path.join(dir, 'history'), stateFile: path.join(dir, 'state.json'),
    sessions: () => [], version: '1.2.0', syncMs: 40, fetchImpl,
  });
  return { tasks, client, posts, dir, id };
}
function edit(side, patch) {
  const card = side.tasks.list()[0];
  side.client.noteResult(side.tasks.update({ id: card.id, updated: card.updated, patch }));
}
function move(side, status) {
  side.client.noteResult(side.tasks.move({ id: side.tasks.list()[0].id, status }));
}
// A card that went through several accepted edits: revision 5 on the hub and on both machines.
async function finishedCard(t) {
  const { root, server, store, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', server.url, tokenFile);
  const win = machine(root, 'win', 'dev-win', server.url, tokenFile);
  mac.client.noteResult(mac.tasks.add({ project: 'agentdeck', title: '修同步', detail: '待开工' }));
  await mac.client.syncOnce();
  const first = mac.tasks.list()[0];
  assert.equal(first.revision, 1);
  const todoDraft = JSON.parse(JSON.stringify(first));
  for (const step of [() => move(mac, 'doing'), () => edit(mac, { detail: '做到一半' }), () => edit(mac, { detail: '做完了' }), () => move(mac, 'done')]) {
    step();
    await mac.client.syncOnce();
  }
  await win.client.syncOnce();
  assert.equal(mac.tasks.list()[0].revision, 5);
  return { mac, win, store, todoDraft, id: first.id };
}

test('an older card file that git put back is not pushed, and the hub copy is written over it', async (t) => {
  const { mac, win, store, todoDraft, id } = await finishedCard(t);
  assert.equal(mac.client.bases.get(id).revision, 5);
  const conflictsBefore = store.snapshot().cards[0].conflicts.length;
  const pushes = mac.posts.length;
  // What the rebase leaves on disk for a moment: revision 1, status todo.
  mac.tasks.upsertSynced(todoDraft);
  assert.equal(mac.tasks.list()[0].revision, 1);
  mac.client._seedTasks();
  assert.equal(mac.client.taskOutbox.has(id), false, 'nothing is queued for the older copy');
  await mac.client.syncOnce();
  assert.equal(mac.posts.length, pushes, 'no request carried the older copy');
  const card = mac.tasks.list()[0];
  assert.equal(card.status, 'done');
  assert.equal(card.revision, 5);
  assert.equal(card.detail, '做完了');
  assert.equal(store.snapshot().cards[0].conflicts.length, conflictsBefore, 'the hub recorded no new conflict');
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].status, 'done');
});

test('an older copy that was already queued is taken back out of the outbox', async (t) => {
  const { mac, store, todoDraft, id } = await finishedCard(t);
  // An earlier build (or a queue written before the file changed) holds the older copy as a pending push.
  mac.client.taskOutbox.set(id, { opId: 'op-leftover-stale', cardId: id, expectedRevision: 1, set: { status: 'todo', detail: '待开工' } });
  mac.tasks.upsertSynced(todoDraft);
  mac.client.noteCard(mac.tasks.list()[0]);
  assert.equal(mac.client.taskOutbox.has(id), false);
  await mac.client.syncOnce();
  assert.equal(mac.tasks.list()[0].status, 'done');
  assert.equal(store.snapshot().cards[0].status, 'done');
});

test('a real edit at the same revision is still pushed', async (t) => {
  const { mac, win, id } = await finishedCard(t);
  const pushes = mac.posts.length;
  edit(mac, { detail: '补一句说明' });
  assert.equal(mac.tasks.list()[0].revision, 5);
  assert.equal(mac.client.taskOutbox.get(id).expectedRevision, 5);
  await mac.client.syncOnce();
  assert.equal(mac.posts.length, pushes + 1);
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].detail, '补一句说明');
});

test('a card file without a revision field still queues its change on the base revision', async (t) => {
  const { mac, id } = await finishedCard(t);
  const plain = JSON.parse(JSON.stringify(mac.tasks.list()[0]));
  delete plain.revision;
  plain.title = '老卡改了标题';
  mac.tasks.upsertSynced(plain);
  assert.equal(mac.tasks.list()[0].revision, undefined);
  mac.client._seedTasks();
  const queued = mac.client.taskOutbox.get(id);
  assert.ok(queued, 'a card from before revisions is not mistaken for an older copy');
  assert.equal(queued.expectedRevision, 5);
  assert.equal(queued.set.title, '老卡改了标题');
});

test('a card made on this machine, with no revision yet, is pushed to the hub', async (t) => {
  const { root, server, store, tokenFile } = await hub(t);
  const mac = machine(root, 'mac', 'dev-mac', server.url, tokenFile);
  mac.tasks.add({ project: 'agentdeck', title: '本机新建' });
  await mac.client.syncOnce();
  assert.equal(mac.posts.length, 1);
  assert.equal(store.snapshot().cards[0].title, '本机新建');
  assert.equal(mac.tasks.list()[0].revision, 1);
});

test('an edit made while the hub is unreachable waits, then goes up once it is back', async (t) => {
  const { mac, win, id } = await finishedCard(t);
  const real = mac.client.fetchImpl;
  mac.client.fetchImpl = async () => { throw new Error('offline'); };
  edit(mac, { detail: '断网时改的' });
  await mac.client.syncOnce();
  assert.match(mac.client.error, /连不上/);
  assert.equal(mac.client.taskOutbox.get(id).set.detail, '断网时改的');
  assert.equal(mac.tasks.list()[0].detail, '断网时改的');
  mac.client.fetchImpl = real;
  await mac.client.syncOnce();
  assert.equal(mac.client.taskOutbox.size, 0);
  await win.client.syncOnce();
  assert.equal(win.tasks.list()[0].detail, '断网时改的');
});
