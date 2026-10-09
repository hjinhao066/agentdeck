'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mobile-web/hub/core');

// The hub sends a message's deduplicationKey only to a computer that says it
// takes keys (an older build refuses unknown fields), and only then tells the
// user that a retry after a timeout is safe.
const info = (capabilities) => ({ status: 200, body: { app: 'agentdeck', apiVersion: 2, capabilities } });

test('a computer that takes send keys is told apart from one that does not', () => {
  assert.deepEqual(Core.classifyInfo(info(['snapshot', 'basePath', 'send-dedupe'])), { current: true, dedupe: true });
  assert.deepEqual(Core.classifyInfo(info(['snapshot', 'basePath'])), { current: true, dedupe: false });
});

test('a timed-out send says 没连上 and offers 重试 only when the retry cannot duplicate', () => {
  assert.equal(Core.sendFailure({ timedOut: true }, 'Mac', true), '没连上 Mac（15 秒没有回音）。点右边的重试，队长不会收到两遍。');
  // An older computer: a retry could deliver twice, so the user looks first.
  assert.match(Core.sendFailure({ timedOut: true }, 'Mac'), /可能已经排队，也可能没有/);
  assert.equal(Core.sendFailure({ failed: true }, 'Mac', true), '手机连不上入口，消息没有发出。');
  assert.match(Core.sendFailure({ status: 502, body: { offline: true } }, 'Mac', true), /没有转给另一台电脑/);
});
