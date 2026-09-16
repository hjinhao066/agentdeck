const test = require('node:test');
const assert = require('node:assert/strict');
const { advance, QUIET_MS } = require('../notification-policy');

test('startup idle never notifies, even with replayed history', () => {
  let { next, action } = advance({}, { state: 'done', hasWorked: true, now: 0 });
  assert.equal(action, null);
  assert.equal(advance(next, { state: 'done', hasWorked: true, now: 60000 }).action, null);
});
test('completion requires continuous quiet and fires once per turn', () => {
  let state = { state: 'working' };
  for (const now of [0, 3000, QUIET_MS - 1]) {
    const result = advance(state, { state: 'done', hasWorked: true, now });
    state = result.next;
    assert.equal(result.action, null);
  }
  let result = advance(state, { state: 'done', hasWorked: true, now: QUIET_MS });
  assert.equal(result.action, 'done');
  assert.equal(advance(result.next, { state: 'done', hasWorked: true, now: 60000 }).action, null);
  result = advance(result.next, { state: 'working', hasWorked: true, now: 61000 });
  assert.equal(result.action, 'cancel');
  state = advance(result.next, { state: 'done', hasWorked: true, now: 62000 }).next;
  assert.equal(advance(state, { state: 'done', hasWorked: true, now: 74000 }).action, 'done');
});
test('streaming output and mid-task pauses defer completion', () => {
  const state = advance({ state: 'working' }, { state: 'done', hasWorked: true, now: 0 }).next;
  assert.equal(advance(state, { state: 'done', hasWorked: true, lastActivity: 11000, now: 12000 }).action, null);
  const working = advance(state, { state: 'working', hasWorked: true, now: 14000 }).next;
  const idle = advance(working, { state: 'done', hasWorked: true, now: 15000 }).next;
  assert.equal(advance(idle, { state: 'done', hasWorked: true, now: 26000 }).action, null);
});
test('input notifies immediately, replaces done, and retracts when work resumes', () => {
  let result = advance({ state: 'working' }, { state: 'input', hasWorked: true, now: 0 });
  assert.equal(result.action, 'input');
  assert.equal(advance(result.next, { state: 'input', hasWorked: true, now: 2000 }).action, null);
  assert.equal(advance(result.next, { state: 'working', hasWorked: true, now: 3000 }).action, 'cancel');
  assert.equal(advance(result.next, { state: 'exited', now: 3000 }).action, 'cancel');
});
