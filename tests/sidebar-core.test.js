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

test('sessions 队长 opened sit right under it, in the sidebar and the deck', () => {
  const folders = [{ id: 'f1', name: 'Work' }];
  const list = [{ id: 'a' }, { id: 'w1', captainCrew: true }, { id: 'b', folderId: 'f1' }, { id: 'm', isMain: true }, { id: 'w2', captainCrew: true }];
  assert.deepEqual(S.orderedColumns(list, folders).map((c) => c.id), ['m', 'w1', 'w2', 'b', 'a']);
  const { crew, groups, loose } = S.groupSessions(list, folders);
  assert.deepEqual(crew.map((c) => c.id), ['w1', 'w2']);
  assert.deepEqual(groups[0].items.map((c) => c.id), ['b']);
  assert.deepEqual(loose.map((c) => c.id), ['a']);
  // with no 队长 they are ordinary loose sessions
  const orphans = list.filter((c) => !c.isMain);
  assert.deepEqual(S.groupSessions(orphans, folders).crew, []);
  assert.deepEqual(S.orderedColumns(orphans, folders).map((c) => c.id), ['b', 'a', 'w1', 'w2']);
});

test('a session leaves 队长 when filed elsewhere, and can be put back or reordered there', () => {
  const folders = [{ id: 'f1', name: 'Work' }];
  let list = [{ id: 'm', isMain: true }, { id: 'w1', captainCrew: true }, { id: 'w2', captainCrew: true }, { id: 'a' }];
  list = S.moveColumn(list, folders, 'w1', { folderId: 'f1' });
  assert.deepEqual(list.map((c) => c.id), ['m', 'w2', 'w1', 'a']);
  assert.equal(list.find((c) => c.id === 'w1').captainCrew, false);
  list = S.moveColumn(list, folders, 'w2', { folderId: null });
  assert.deepEqual(list.map((c) => c.id), ['m', 'w1', 'a', 'w2']);
  assert.equal(list.find((c) => c.id === 'w2').captainCrew, false);
  // back under 队长: to the end, or before one of its sessions
  list = S.moveColumn(list, folders, 'a', { crew: true });
  assert.deepEqual(list.map((c) => c.id), ['m', 'a', 'w1', 'w2']);
  list = S.moveColumn(list, folders, 'w2', { crew: true, folderId: 'f1' });
  assert.deepEqual(list.map((c) => c.id), ['m', 'a', 'w2', 'w1']);
  assert.equal(list.find((c) => c.id === 'w2').folderId, null, 'under 队长 means in no folder');
  list = S.moveColumn(list, folders, 'w2', { crew: true, beforeId: 'a' });
  assert.deepEqual(list.map((c) => c.id), ['m', 'w2', 'a', 'w1']);
  // a beforeId outside the target group goes to the end of the group instead
  list = S.moveColumn(list, folders, 'w1', { crew: true, beforeId: 'm' });
  assert.deepEqual(list.map((c) => c.id), ['m', 'w2', 'a', 'w1']);
  // without a 队长 there is nothing to go under
  const solo = [{ id: 'a' }, { id: 'b' }];
  S.moveColumn(solo, folders, 'b', { crew: true });
  assert.equal(solo[1].captainCrew, false);
});

test('activity subtitles discard TUI controls and keep actual progress', () => {
  const C = require('../chat-core');
  const activity = (text) => S.activityLine(C.cutInputBox(text.split('\n')));
  const controls = ['← for agents · ? for shortcuts ⚠…', 'Thinking: xhigh',
    'esc to interrupt', '⏵⏵ bypass permissions on (shift+tab to cycle)',
    'Context: 23% | Session: 26.0%', 'Model: GPT-6.1 Sol', 'Claude Code'];
  for (const hint of controls) {
    assert.equal(activity(hint), '', hint);
    assert.equal(activity('正在跑侧边栏回归测试\n' + hint), '正在跑侧边栏回归测试', hint);
  }
  assert.equal(activity('正在验证布局\n────────────────────\n> 提示占位文字\n────────────────────\nThinking: xhigh'), '正在验证布局');
  assert.equal(activity('> 用户输入\n← for agents · ? for shortcuts'), '');
  assert.equal(activity('Thinking: how to preserve the progress line'), 'Thinking: how to preserve the progress line');
  assert.equal(activity('Proceed with the change? (y/n)'), 'Proceed with the change? (y/n)');
  assert.equal(activity('✻ Doing…\nPress up to edit queued messages'), '✻ Doing…');
});


test('crew members group by model, busiest group first, recent activity inside the group', () => {
  const groups = S.crewModelGroups([
    { id: 'a', label: 'Opus 5.5', iconProvider: 'Claude', seat: 'us', working: true, lastActive: 10 },
    { id: 'b', label: 'Opus 5.5', iconProvider: 'Claude', seat: 'us', working: false, lastActive: 50 },
    { id: 'c', label: 'Opus 5.5', iconProvider: 'Claude', seat: 'cn', working: true, lastActive: 5 },
    { id: 'd', label: 'Grok 4.7', iconProvider: 'Grok', seat: '', working: true, lastActive: 1 },
    { id: 'e', label: 'Grok 4.7', iconProvider: 'Grok', seat: '', working: true, lastActive: 40 },
    { id: 'f', label: '', iconProvider: '', seat: '', working: false, lastActive: 3 },
    { id: 'g', label: 'Opus 5.5', iconProvider: 'Claude', seat: 'us', working: true, lastActive: 50 },
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.seat, g.flag, g.working, g.ids]), [
    ['Opus 5.5', 'us', '🇺🇸', 2, ['b', 'g', 'a']],
    ['Grok 4.7', '', '', 2, ['e', 'd']],
    ['Opus 5.5', 'cn', '🇨🇳', 1, ['c']],
    ['终端', '', '', 0, ['f']],
  ]);
  assert.equal(S.normalizeCollapsedModels([' Opus 5.5\u001fus ', ' Opus 5.5\u001fus ', '', 3, 'x'.repeat(200)]).length, 1);
});

test('sidebar text size restores defaults for invalid settings and clamps its independent range', () => {
  for (const value of [undefined, null, '16', NaN, Infinity, -Infinity]) assert.equal(S.normalizeFontSize(value), 13);
  assert.equal(S.normalizeFontSize(16), 16);
  assert.equal(S.normalizeFontSize(-1), 10);
  assert.equal(S.normalizeFontSize(32), 20);
});

test('Hermes hub link is the https console address the main process will open', () => {
  assert.match(S.HERMES_HUB_URL, /^https:\/\/hub\.18-139-28-180\.sslip\.io\/$/);
  assert.match(S.HERMES_HUB_URL, /^https?:\/\//i); // same guard as main's open-external
});
