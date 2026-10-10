'use strict';
// start() queued a round every syncMs onto the previous one (syncOnce chains
// this.tail). When a round takes longer than the interval (a slow or hung hub:
// every request waits its 10 s timeout; a snapshot of tens of MB), rounds piled
// up, then ran back to back with no pause, and stop() left every queued round to run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FleetClient } = require('../sync-client');
const { TaskStore } = require('../task-board');

test('a hub slower than the sync interval does not pile up rounds, and stop() ends them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-round-backlog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'token'), 'token-value\n', { mode: 0o600 });
  let heartbeats = 0;
  let running = 0, most = 0;
  // Every round takes about three intervals (the hub answers slowly).
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/heartbeat')) { heartbeats += 1; running += 1; most = Math.max(most, running); }
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (url.includes('/v1/snapshot')) running -= 1;
    const body = url.includes('/v1/snapshot') ? { devices: [], cards: [], history: [] } : { devices: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const fleet = new FleetClient({
    baseUrl: 'http://hub.invalid', tokenFile: path.join(root, 'token'), device: { id: 'dev-mac', name: 'mac', platform: 'darwin' },
    taskStore: new TaskStore(path.join(root, 'tasks')), historyDir: path.join(root, 'history'), stateFile: path.join(root, 'state.json'),
    syncMs: 50, fetchImpl,
  });
  fleet.start();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fleet.stop();
  const atStop = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  t.diagnostic(`${atStop} rounds started in 1 s; ${heartbeats - atStop} more after stop()`);
  assert.ok(atStop >= 2, 'rounds keep coming while the hub is slow');
  assert.equal(most, 1, 'one round at a time');
  assert.ok(heartbeats - atStop <= 0, `${heartbeats - atStop} rounds started after stop()`);
});
