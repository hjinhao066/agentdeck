'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewModel, conflictText } = require('../fleet-ui');

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
