'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Simulated deduplication store
class MessageDeduplicator {
  constructor() {
    this.processedKeys = new Map();
    this.results = new Map();
  }

  processMessage(message, deduplicationKey) {
    if (this.processedKeys.has(deduplicationKey)) {
      return this.results.get(deduplicationKey);
    }

    const result = {
      success: true,
      messageId: Math.random().toString(36).slice(2),
      timestamp: Date.now()
    };

    this.processedKeys.set(deduplicationKey, true);
    this.results.set(deduplicationKey, result);
    return result;
  }

  reset() {
    this.processedKeys.clear();
    this.results.clear();
  }
}

test('mobile-web message deduplication', async (t) => {
  const dedup = new MessageDeduplicator();

  // First send with unique key
  const key1 = 'msg-abc123def456';
  const message1 = 'First message';

  const result1a = dedup.processMessage(message1, key1);
  const result1b = dedup.processMessage(message1, key1);

  // Both should return same result (same messageId)
  assert.equal(result1a.messageId, result1b.messageId, 'Same key should return same result');
  assert.equal(result1a.timestamp, result1b.timestamp, 'Timestamp should be identical');

  // Different key should get different result
  const key2 = 'msg-xyz789uvw012';
  const message2 = 'Second message';
  const result2 = dedup.processMessage(message2, key2);

  assert.notEqual(result1a.messageId, result2.messageId, 'Different keys should have different messageIds');
});

test('mobile-web concurrent deduplication', async (t) => {
  const dedup = new MessageDeduplicator();
  const key = 'msg-concurrent123';
  const message = 'Concurrent message';

  // Simulate concurrent requests with same key
  const promises = Array(5).fill(null).map(() =>
    Promise.resolve(dedup.processMessage(message, key))
  );

  const results = await Promise.all(promises);

  // All should have same messageId (deduped)
  const messageIds = new Set(results.map(r => r.messageId));
  assert.equal(messageIds.size, 1, 'All concurrent requests should return same messageId');

  // Only one should be marked as processed
  assert.equal(dedup.processedKeys.size, 1, 'Only one message should be stored');
});

test('mobile-web retry uses same deduplication key', async (t) => {
  const dedup = new MessageDeduplicator();
  const key = 'msg-retry789';
  const message = 'Message for retry';

  // First attempt
  const firstAttempt = dedup.processMessage(message, key);

  // Simulate network timeout and retry - same key
  const retry = dedup.processMessage(message, key);

  // Should return same result as first attempt
  assert.equal(firstAttempt.messageId, retry.messageId, 'Retry with same key should return same messageId');
  assert.ok(firstAttempt.success, 'First attempt was successful');
  assert.ok(retry.success, 'Retry should also succeed with cached result');
});

test('mobile-web edited message gets new deduplication key', async (t) => {
  const dedup = new MessageDeduplicator();
  const key1 = 'msg-edit111';
  const key2 = 'msg-edit222';

  // Original message
  const message1 = 'Original message';
  const result1 = dedup.processMessage(message1, key1);

  // Edited message with new key (user edited and resent)
  const message2 = 'Edited message';
  const result2 = dedup.processMessage(message2, key2);

  // Should be different results
  assert.notEqual(result1.messageId, result2.messageId, 'Edited message with new key should have different messageId');
});
