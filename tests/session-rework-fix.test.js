'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TaskStore } = require('../task-board');

test('rework: Card in review with active review_session should allow new bind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-session-test-'));
  try {
    const reviewSessionId = 'review-1';
    let cardId = null;
    let sessions = [];

    const store = new TaskStore(root, { sessions: () => sessions });

    // Create a card with verify=true to enable review
    const result1 = store.add({
      project: 'test',
      title: 'test card',
      detail: 'test',
      verify: true
    });
    const card = result1.card;
    cardId = card.id;

    // Step 1: Bind to an executor (first attempt)
    const exec1 = store.bind({
      id: card.id,
      project: 'test',
      session_id: 'exec-1',
      attempt_id: 'attempt-1',
      assignee: { agent: 'Claude', model: 'default' }
    });
    assert.equal(exec1.card.session_id, 'exec-1');
    assert.equal(exec1.card.attempt_closed, false);

    // Step 2: Move card to review and simulate review session taking over
    store.move({ id: card.id, status: 'review' });
    store.mutate((docs) => {
      const c = store.find(docs, card.id);
      c.session_id = reviewSessionId;
      c.review_session = true;
      c.review_verdict = true;
      c.attempt_closed = false;  // Review session still active (attempt_closed=false)
      return {};
    });

    let updated = store.list({ archived: true }).find(c => c.id === card.id);
    assert.equal(updated.session_id, reviewSessionId, 'setup: session_id should point to review session');
    assert.equal(updated.review_session, true, 'setup: card has active review_session');
    assert.equal(updated.attempt_closed, false, 'setup: review attempt still active');

    // Step 3: Add the review session to the active sessions list
    // This simulates the review session still being active and holding the card
    sessions.push({
      id: reviewSessionId,
      archived: false,
      active: true,
      boardId: cardId
    });

    // Step 4: Simulate the external process of stopping the review session
    // (In real code, this would be done by MainSession or similar before calling bind)
    sessions[0].archived = true;
    sessions[0].active = false;

    // Step 5: Try to bind a new executor (reworking the card)
    // With the fix, this should succeed even though the old review session is being cleaned up
    let bindSucceeded = false;
    let bindError = null;
    try {
      const rework = store.bind({
        id: card.id,
        project: 'test',
        session_id: 'exec-2',
        attempt_id: 'attempt-2',
        assignee: { agent: 'Claude', model: 'default' }
      });
      bindSucceeded = true;

      // Verify the new binding
      assert.equal(rework.card.session_id, 'exec-2', 'should bind to new executor');
      assert.equal(rework.card.review_session, false, 'should clear review_session');
      assert.equal(rework.card.attempt_closed, false, 'should have attempt_closed=false for new execution');
    } catch (e) {
      bindError = e.message;
    }

    assert.ok(bindSucceeded, `bind should succeed, but got error: ${bindError}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
