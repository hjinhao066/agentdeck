'use strict';
// The sidebar counts only the conflicts that appeared after "全部标为已看". The mark is
// kept on this computer (the client's own state file); no card is changed, so nothing new
// has to be synced and the card's 冲突 tag still shows every record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-seen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tasks = new TaskStore(path.join(root, 'tasks'), { deviceId: 'dev-mac' });
  const open = () => new FleetClient({
    baseUrl: 'http://127.0.0.1:9', tokenFile: path.join(root, 'token'), device: { id: 'dev-mac', name: 'mac', platform: 'darwin' },
    taskStore: tasks, historyDir: path.join(root, 'history'), stateFile: path.join(root, 'state.json'), sessions: () => [],
  });
  return { root, tasks, open };
}
const conflict = (id, at) => ({ id, at, deviceId: 'dev-mac', baseRevision: 1, fields: { title: { kept: '保留', other: '旧稿' } } });
function put(tasks, id, conflicts) {
  const card = tasks.list({ archived: true }).find((item) => item.id === id) || tasks.add({ project: 'agentdeck', title: '卡 ' + id, id }).card;
  tasks.upsertSynced({ ...card, revision: 3, conflicts });
}

test('every conflict counts until the mark is set, and only newer ones count after it', (t) => {
  const { tasks, open } = setup(t);
  put(tasks, 't-one', [conflict('cf-1', '2026-10-09T13:24:00.000Z'), conflict('cf-2', '2026-10-09T19:00:00.000Z')]);
  put(tasks, 't-two', [conflict('cf-3', '2026-10-10T06:32:00.000Z')]);
  const client = open();
  assert.equal(client.snapshot().conflictCount, 3);
  assert.equal(client.snapshot().conflictTotal, 3);
  const before = JSON.stringify(tasks.list({ archived: true }));
  client.ackConflicts();
  assert.equal(client.snapshot().conflictCount, 0);
  assert.equal(client.snapshot().conflictTotal, 3, 'the records are all still there');
  assert.equal(JSON.stringify(tasks.list({ archived: true })), before, 'no card changed');
  // a conflict the hub records later
  put(tasks, 't-two', [conflict('cf-3', '2026-10-10T06:32:00.000Z'), conflict('cf-4', '2026-10-10T08:00:00.000Z')]);
  assert.equal(client.snapshot().conflictCount, 1);
  assert.equal(client.snapshot().conflictTotal, 4);
  client.ackConflicts();
  assert.equal(client.snapshot().conflictCount, 0);
});

test('the mark survives a restart of this computer', (t) => {
  const { tasks, open } = setup(t);
  put(tasks, 't-one', [conflict('cf-1', '2026-10-09T13:24:00.000Z')]);
  const first = open();
  first.ackConflicts();
  first.stop();
  const second = open();
  assert.equal(second.snapshot().conflictCount, 0);
  put(tasks, 't-one', [conflict('cf-1', '2026-10-09T13:24:00.000Z'), conflict('cf-2', '2026-10-10T09:00:00.000Z')]);
  assert.equal(second.snapshot().conflictCount, 1);
});

test('a conflict record without a usable time is counted once and can still be marked', (t) => {
  const { tasks, open } = setup(t);
  put(tasks, 't-odd', [conflict('cf-x', 'not a time')]);
  const client = open();
  assert.equal(client.snapshot().conflictCount, 1);
  client.ackConflicts();
  assert.equal(client.snapshot().conflictCount, 0);
});

test('with no conflicts the mark changes nothing and the count stays zero', (t) => {
  const { tasks, open } = setup(t);
  put(tasks, 't-clean', []);
  const client = open();
  client.ackConflicts();
  assert.equal(client.snapshot().conflictCount, 0);
  assert.equal(client.snapshot().conflictTotal, 0);
});
