(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NotificationPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const QUIET_MS = 12000;
  // One notification per turn. Continued output resets the quiet deadline,
  // even when a streaming agent has no recognizable spinner on screen.
  function advance(previous, { state, hasWorked, lastActivity = 0, now = Date.now() }) {
    const next = { ...previous, state };
    let action = null;
    if (state === 'done' && previous.notified === 'done' && lastActivity > (previous.lastActivity || 0)) {
      next.notified = null;
      next.since = now;
      action = 'cancel';
    }
    next.lastActivity = lastActivity;
    if (state === 'working' || state === 'plain' || state === 'exited') {
      if (next.notified) action = 'cancel';
      next.notified = null;
      next.since = null;
    } else if (state === 'input') {
      next.since = null;
      if (previous.state !== undefined && previous.state !== 'input') {
        next.notified = 'input';
        action = 'input';
      }
    } else if (state === 'done') {
      if (previous.state !== 'done') {
        next.since = now;
        if (previous.state === undefined) next.notified = 'done';
      }
      if (hasWorked && next.notified !== 'done' &&
          now - Math.max(next.since ?? now, lastActivity) >= QUIET_MS) {
        next.notified = 'done';
        action = 'done';
      }
    }
    return { next, action };
  }
  return { advance, QUIET_MS };
});
