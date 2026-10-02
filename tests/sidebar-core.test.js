'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sidebar-core');

const cols = () => ['a', 'b', 'c', 'd'].map((id) => ({ id, folderId: null }));

test('deck order follows the sidebar: folders first, then loose sessions', () => {
  const folders = [{ id: 'f1', name: 'Work' }, { id: 'f2', name: 'Home' }];
  const list = cols();
  list[2].folderId = 'f2';
  list[3].folderId = 'f1';
  list[1].folderId = 'gone';             // folder deleted elsewhere: treated as loose
  assert.deepEqual(S.orderedColumns(list, folders).map((c) => c.id), ['d', 'c', 'a', 'b']);
  const { groups, loose } = S.groupSessions(list, folders);
  assert.deepEqual(groups.map((g) => g.items.map((c) => c.id)), [['d'], ['c']]);
  assert.deepEqual(loose.map((c) => c.id), ['a', 'b']);
});

test('moving a session into a folder, before another one, and back out', () => {
  const folders = [{ id: 'f1', name: 'Work' }];
  let list = cols();
  list = S.moveColumn(list, folders, 'c', { folderId: 'f1' });
  assert.deepEqual(list.map((c) => c.id), ['c', 'a', 'b', 'd']);
  list = S.moveColumn(list, folders, 'd', { folderId: 'f1', beforeId: 'c' });
  assert.deepEqual(list.map((c) => c.id), ['d', 'c', 'a', 'b']);
  list = S.moveColumn(list, folders, 'd', { folderId: null });
  assert.deepEqual(list.map((c) => c.id), ['c', 'a', 'b', 'd']);
  assert.equal(list.find((c) => c.id === 'd').folderId, null);
  // an unknown folder id never sticks
  list = S.moveColumn(list, folders, 'a', { folderId: 'nope' });
  assert.equal(list.find((c) => c.id === 'a').folderId, null);
});

test('deleting a folder keeps its sessions as loose ones', () => {
  const list = cols();
  list[0].folderId = 'f1';
  const left = S.removeFolder(list, [{ id: 'f1', name: 'x' }], 'f1');
  assert.deepEqual(left, []);
  assert.equal(list[0].folderId, null);
});

test('folder and archive normalization drops junk and duplicates', () => {
  assert.deepEqual(S.normalizeFolders([{ id: 'f1', name: '  A\nB ' }, { id: 'f1' }, { id: '../x' }, null]),
    [{ id: 'f1', name: 'A B', collapsed: false }]);
  assert.equal(S.nextFolderName([{ name: '新文件夹' }, { name: '新文件夹 2' }]), '新文件夹 3');
  const archived = S.normalizeArchived([{ id: 'old', archivedAt: 1 }, { id: 'new', archivedAt: 5 }, { id: 'new' }, { id: 'bad/id' }]);
  assert.deepEqual(archived.map((a) => a.id), ['new', 'old']);
});

test('队长 is always the first column, pinned on its own, never inside folders or loose sessions', () => {
  const list = [{ id: 'a' }, { id: 'm', isMain: true, folderId: 'f1' }, { id: 'b', folderId: 'f1' }];
  const folders = [{ id: 'f1', name: 'Work' }];
  assert.deepEqual(S.orderedColumns(list, folders).map((c) => c.id), ['m', 'b', 'a']);
  assert.equal(S.captainOf(list).id, 'm');
  assert.equal(S.captainOf([{ id: 'a' }]), null);
  const { groups, loose } = S.groupSessions(list, folders);
  assert.deepEqual(groups[0].items.map((c) => c.id), ['b']);
  assert.deepEqual(loose.map((c) => c.id), ['a']);
  assert.deepEqual(S.moveColumn(list, folders, 'a', { folderId: 'f1', beforeId: 'b' }).map((c) => c.id), ['m', 'a', 'b']);
  // dropping a session before 队长 still leaves 队长 first
  assert.deepEqual(S.moveColumn(list, folders, 'a', { folderId: null, beforeId: 'm' })[0].id, 'm');
});

test('队长 cannot be dragged into a folder or reordered', () => {
  const list = [{ id: 'm', isMain: true, folderId: null }, { id: 'a', folderId: null }, { id: 'b', folderId: 'f1' }];
  const folders = [{ id: 'f1', name: 'Work' }];
  const after = S.moveColumn(list, folders, 'm', { folderId: 'f1', beforeId: 'b' });
  assert.deepEqual(after.map((c) => c.id), ['m', 'b', 'a']);
  assert.equal(list[0].folderId, null);
});
