'use strict';
// The sidebar's 两机 section listed 「队长记录 · 永动机/ LOGIN · 10/8 5:54 PM」 again
// and again (2026-10-10): the first 8 transcripts in the hub's order (the oldest),
// each with the time it was uploaded. A saved chat stamps each turn's `ts`/`end` as
// a number, which Date.parse reads as NaN, so no transcript ever had its own
// start or end time; ones uploaded together all showed the same upload minute.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');
const { SharedStore } = require('../shared-store');
const FleetUI = require('../fleet-ui');

function client(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-history-times-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'token'), 'token-value\n', { mode: 0o600 });
  return new FleetClient({
    baseUrl: 'http://hub.invalid', tokenFile: path.join(root, 'token'), device: { id: 'dev-mac', name: 'Mac', platform: 'darwin' },
    taskStore: new TaskStore(path.join(root, 'tasks')), historyDir: path.join(root, 'history'), stateFile: path.join(root, 'state.json'),
  });
}

test('a saved captain chat (turn times as numbers) is sent with its own start and end', (t) => {
  const fleet = client(t);
  const start = Date.parse('2026-10-08T17:54:00.000Z'), end = Date.parse('2026-10-08T19:30:00.000Z');
  fleet.noteCaptain('cap-1', { turns: [
    { id: 't1', user: '永动机/ LOGIN', ts: start, end: start + 60_000, done: true },
    { id: 't2', user: '继续', ts: end - 120_000, end, done: true },
  ] });
  const item = fleet.historyOutbox.get('cap-1');
  assert.equal(item.startedAt, '2026-10-08T17:54:00.000Z');
  assert.equal(item.endedAt, '2026-10-08T19:30:00.000Z');
});

test('the same transcript sent again with its times fills the times the hub lacked', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-history-times-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = new SharedStore({ file: path.join(root, 'store.json') });
  const upload = { sessionId: 'cap-1', deviceId: 'dev-mac', contentHash: 'a'.repeat(64), summary: '永动机/ LOGIN', turns: [{ user: '永动机/ LOGIN', ts: 1 }] };
  hub.pushHistory({ ...upload, opId: 'op-first-0000' });
  const again = hub.pushHistory({ ...upload, opId: 'op-again-0000', startedAt: '2026-10-08T17:54:00.000Z', endedAt: '2026-10-08T19:30:00.000Z' });
  assert.equal(again.body.duplicate, true);
  const record = new SharedStore({ file: path.join(root, 'store.json') }).snapshot().history[0];
  assert.equal(record.startedAt, '2026-10-08T17:54:00.000Z');
  assert.equal(record.endedAt, '2026-10-08T19:30:00.000Z');
  assert.equal(record.contentHash, 'a'.repeat(64));
});

test('两机 lists the most recent captain records, each with its own time', () => {
  const now = Date.parse('2026-10-10T04:30:00.000Z');
  const old = Array.from({ length: 9 }, (_, i) => ({ sessionId: 'cap-old-' + i, deviceId: 'dev-win', summary: '永动机/ LOGIN', updatedAt: '2026-10-09T00:54:53.000Z', startedAt: null, endedAt: null }));
  const recent = { sessionId: 'cap-new', deviceId: 'dev-mac', summary: '今天的队长', updatedAt: '2026-10-09T00:54:53.000Z', startedAt: '2026-10-10T01:00:00.000Z', endedAt: '2026-10-10T04:20:00.000Z' };
  const model = FleetUI.viewModel({ configured: true, devices: [], history: [...old, recent] }, now);
  assert.equal(model.history.length, 8);
  assert.equal(model.history[0].sessionId, 'cap-new', 'the newest first');
  assert.match(model.history[0].text, /^今天的队长 · /);
  assert.equal(model.history[0].text, '今天的队长 · ' + FleetUI.formatLastSeen('2026-10-10T04:20:00.000Z', now), 'the chat\'s own last time, not its upload time');
});
