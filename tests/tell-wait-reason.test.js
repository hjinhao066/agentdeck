'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');

test('tellWaitReason allows tell when status shows done + background process', () => {
  // Real case: narrow column with folded status line showing turn is done,
  // but background shell is still running. tell should NOT be blocked.
  const screen = '❯ \n✻ Churned for 3m 55s · done\n9:16 PM · 1 shell still\nrunning';
  const entry = { alive: true, state: 'done', lastScreen: screen };

  const reason = M.tellWaitReason({ entry, screen, cmd: 'claude' });
  assert.equal(reason, '', 'tell should be allowed after turn completes, even with background process');
});

test('tellWaitReason blocks tell when turn is still working', () => {
  // When status shows "Doing...", tell should still be blocked
  const screen = '❯ \n✻ Doing …';
  const entry = { alive: true, state: 'working', lastScreen: screen };

  const reason = M.tellWaitReason({ entry, screen, cmd: 'claude' });
  assert.ok(reason, 'tell should be blocked when turn is working');
});
