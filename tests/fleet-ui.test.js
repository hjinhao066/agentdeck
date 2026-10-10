'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewModel, conflictText, formatLastSeen } = require('../fleet-ui');

const now = Date.parse('2026-10-04T12:00:00.000Z');

test('fleet status names online and offline machines and keeps both conflict copies visible', () => {
  const model = viewModel({
    configured: true, selfId: 'dev-mac', lastSyncAt: '2026-10-04T11:59:50.000Z', conflictCount: 1,
    devices: [
      { id: 'dev-mac', name: 'MacBook', platform: 'darwin', online: true, lastSeenAt: '2026-10-04T11:59:50.000Z' },
      { id: 'dev-win', name: 'Windows', platform: 'win32', online: false, lastSeenAt: '2026-10-04T11:00:00.000Z' },
    ],
    history: [{ sessionId: 'cap-win', deviceId: 'dev-win', summary: 'Windows 队长', updatedAt: '2026-10-04T11:00:00.000Z' }],
  }, now);
  assert.equal(model.rows[0].status, '在线');
  assert.equal(model.rows[0].name, 'MacBook（本机）');
  assert.match(model.rows[0].seen, /刚刚/);
  assert.equal(model.rows[1].status, '离线');
  assert.match(model.rows[1].seen, /最后在线/);
  assert.match(model.notice, /冲突/);
  assert.equal(model.history[0].text.includes('Windows 队长'), true);
  assert.equal(viewModel({ configured: false }, now).notice, '两机同步未配置');
  assert.match(viewModel({ configured: true, error: '同步失败：连不上同步服务', devices: [] }, now).notice, /连不上/);
  const text = conflictText({ conflicts: [{ fields: { title: { kept: '甲的标题', other: '乙的标题' } } }] });
  assert.match(text, /保留「甲的标题」/);
  assert.match(text, /另一份「乙的标题」/);
});

test('the one-line summary names the computers by kind and says only what needs a look', () => {
  const devices = [
    { id: 'dev-mac', name: 'jinhaodeMacBook-Pro.local', platform: 'darwin', online: true, lastSeenAt: '2026-10-04T11:59:50.000Z' },
    { id: 'dev-win', name: 'owenJH', platform: 'win32', online: false, lastSeenAt: '2026-10-01T09:00:00.000Z' },
  ];
  const failing = viewModel({ configured: true, selfId: 'dev-mac', devices, error: '同步失败：服务状态 500', history: [] }, now);
  assert.deepEqual(failing.rows.map((r) => r.short), ['Mac', 'Windows']);
  assert.equal(failing.rows[0].name, 'jinhaodeMacBook-Pro.local（本机）', 'the detail keeps the full name');
  assert.equal(failing.lineState, '同步失败', 'the line says it in one word; the detail has the whole message');
  assert.equal(failing.notice, '同步失败：服务状态 500');
  // an old time reads as Chinese, never as an English locale date
  assert.equal(failing.rows[1].seen, '最后在线 3 天前');
  assert.equal(formatLastSeen('2026-08-01T09:00:00.000Z', now), '8月1日');
  const conflict = viewModel({ configured: true, selfId: 'dev-mac', devices, conflictCount: 2, lastSyncAt: '2026-10-04T11:59:00.000Z', history: [] }, now);
  assert.equal(conflict.lineState, '2 处冲突');
  assert.equal(conflict.noticeKind, 'warn');
  assert.equal(viewModel({ configured: true, selfId: 'dev-mac', devices, lastSyncAt: '2026-10-04T11:59:00.000Z', history: [] }, now).noticeKind, 'ok');
  assert.equal(viewModel({ configured: false }, now).lineState, '未配置');
  assert.equal(viewModel({ configured: true, devices: [], history: [] }, now).lineState, '连接中…');
  // two computers of one kind are told apart by their own names
  const twoMacs = viewModel({ configured: true, selfId: 'a', devices: [
    { id: 'a', name: 'studio', platform: 'darwin', online: true }, { id: 'b', name: 'air', platform: 'darwin', online: true }] }, now);
  assert.deepEqual(twoMacs.rows.map((r) => r.short), ['studio', 'air']);
});

test('captain records read as their own line, without a repeated 队长记录 prefix', () => {
  const model = viewModel({ configured: true, selfId: 'dev-mac', devices: [], lastSyncAt: '2026-10-04T11:59:00.000Z',
    history: [{ sessionId: 's1', deviceId: 'dev-win', summary: '/LOGIN', updatedAt: '2026-10-04T11:59:30.000Z' }] }, now);
  assert.equal(model.history[0].text, '/LOGIN · 刚刚');
});
