(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayStartupCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STARTUP_MS = 3 * 60_000;
  const MAX_FAILURES = 3;
  const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  const time = (value) => Number.isFinite(value) && value > 0;

  function normalize(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const failures = Array.isArray(value.failures) ? value.failures.filter(validId).slice(0, MAX_FAILURES) : [];
    const stopped = value.stopped === true || failures.length >= MAX_FAILURES;
    const raw = value.attempt;
    const attempt = !stopped && raw && validId(raw.colId) && validId(raw.targetId) && time(raw.at)
      ? { colId: raw.colId, targetId: raw.targetId, at: raw.at,
        deadline: time(raw.deadline) ? Math.min(raw.deadline, raw.at + STARTUP_MS) : raw.at + STARTUP_MS,
        promptSent: raw.promptSent === true, ...(time(raw.promptSentAt) ? { promptSentAt: raw.promptSentAt } : {}), output: raw.output === true } : null;
    return { attempt, failures, stopped, reason: typeof value.reason === 'string' ? value.reason : null };
  }

  function begin(value, { colId, targetId, at } = {}) {
    const state = normalize(value);
    if (state.stopped || !validId(colId) || !validId(targetId) || !time(at)) return state;
    state.attempt = { colId, targetId, at, deadline: at + STARTUP_MS, promptSent: false, output: false };
    state.reason = null;
    return state;
  }

  function fail(value, reason) {
    const state = normalize(value);
    if (!state.attempt) return { state, action: 'none' };
    state.failures.push(state.attempt.targetId);
    state.attempt = null;
    state.reason = typeof reason === 'string' ? reason : 'startup-failed';
    state.stopped = state.failures.length >= MAX_FAILURES;
    return { state, action: state.stopped ? 'stop' : 'retry' };
  }

  function check(value, { colId, promptSent, output, quota, exited, now } = {}) {
    const state = normalize(value);
    const attempt = state.attempt;
    if (!attempt || attempt.colId !== colId) return { state, action: 'none' };
    // A brief reply or startup output cannot hide an immediate quota failure.
    if (quota === true) return fail(state, 'quota');
    if (exited === true) return fail(state, 'exited');
    attempt.promptSent ||= promptSent === true;
    attempt.output ||= output === true;
    if (!time(now) || now < attempt.deadline) return { state, action: 'waiting' };
    if (!attempt.promptSent || !attempt.output) {
      return fail(state, !attempt.promptSent ? 'prompt-not-sent' : 'no-output');
    }
    return { state: normalize(), action: 'healthy' };
  }

  return { STARTUP_MS, MAX_FAILURES, normalize, begin, check, fail };
});
