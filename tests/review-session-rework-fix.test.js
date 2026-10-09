'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TaskStore } = require('../task-board');

test('rework: bind() returns stopSession when card in review is being reworked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-rework-test-'));
  try {
    const reviewSessionId = 'review-1';
    let sessions = [];

    const store = new TaskStore(root, { sessions: () => sessions });

    // Create and execute card
    const result1 = store.add({
      project: 'test',
      title: 'test card',
      detail: 'test',
      verify: true
    });
    const cardId = result1.card.id;

    // Step 1: Initial execution binding
    const exec1 = store.bind({
      id: cardId,
      project: 'test',
      session_id: 'exec-1',
      attempt_id: 'attempt-1',
      assignee: { agent: 'Claude', model: 'default' }
    });
    assert.equal(exec1.card.session_id, 'exec-1');

    // Step 2: Move to review with review session
    store.move({ id: cardId, status: 'review' });
    store.mutate((docs) => {
      const c = store.find(docs, cardId);
      c.session_id = reviewSessionId;
      c.review_session = true;
      c.review_verdict = true;
      c.attempt_closed = false;
      return {};
    });

    // Step 3: Add review session to active sessions list
    sessions.push({
      id: reviewSessionId,
      archived: false,
      active: true,
      boardId: cardId
    });

    // Verify setup
    let card = store.list({ archived: true }).find(c => c.id === cardId);
    assert.equal(card.session_id, reviewSessionId, 'card should have review session');
    assert.equal(card.review_session, true, 'review_session should be true');

    // Step 4: Rework (bind without explicit review)
    // bind() should detect this is a rework and return stopSession
    const rework = store.bind({
      id: cardId,
      project: 'test',
      session_id: 'exec-2',
      attempt_id: 'attempt-2',
      assignee: { agent: 'Claude', model: 'default' }
    });

    // Verify bind returns the session ID that needs to be stopped
    assert.equal(rework.stopSession, reviewSessionId, 'bind() should return stopSession=review-1');
    assert.equal(rework.card.session_id, 'exec-2', 'should bind to new executor');
    assert.equal(rework.card.review_session, false, 'should clear review_session');
    assert.equal(rework.card.attempt_closed, false, 'should have attempt_closed=false');

    // Step 5: Simulate external cleanup - stop the old review session
    // (In real code, MainSession or dispatcher would call archiveColumn here)
    const sessionToStop = sessions.find(s => s.id === rework.stopSession);
    assert.ok(sessionToStop, 'stopSession should refer to an existing session');
    sessionToStop.archived = true;
    sessionToStop.active = false;

    // Step 6: Verify the new binding is clean
    const updated = store.list({ archived: true }).find(c => c.id === cardId);
    assert.equal(updated.session_id, 'exec-2', 'card now bound to new executor');
    assert.equal(updated.review_session, false, 'review_session is cleared');
    assert.equal(updated.attempt_closed, false, 'new execution marked as active');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
