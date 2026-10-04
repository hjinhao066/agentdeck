(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QuotaWarmupCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RESET_DELAY_MS = 60_000;
  const RETRY_DELAY_MS = 60_000;
  const MAX_ATTEMPTS = 2;
  const STATUSES = ['pending', 'running', 'retry', 'succeeded', 'abandoned'];
  const seatId = (value) => value === 'cn' || value === 'us';
  const time = (value) => Number.isFinite(value) && value > 0 ? value : null;
  const account = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
  function directory(value) {
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value) || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value)) return '';
    const dir = value.replace(/\\/g, '/').replace(/\/$/, '');
    return /^(?:[a-z]:\/|\/\/)/i.test(dir) ? dir.toLowerCase() : dir;
  }
  function normalizeSettings(value) {
    return { enabled: !value || typeof value !== 'object' || value.enabled !== false };
  }
  function normalizeState(value) {
    const seats = {};
    for (const [id, raw] of Object.entries(value && typeof value === 'object' ? value.seats || {} : {})) {
      if (!seatId(id) || !raw || !account(raw.accountKey) || !directory(raw.configDir) || !time(raw.resetAt)) continue;
      const attempts = Number.isInteger(raw.attempts) && raw.attempts >= 0 && raw.attempts <= MAX_ATTEMPTS ? raw.attempts : 0;
      const status = STATUSES.includes(raw.status) ? raw.status : attempts >= MAX_ATTEMPTS ? 'abandoned' : attempts ? 'retry' : 'pending';
      const out = { accountKey: raw.accountKey, configDir: raw.configDir, resetAt: raw.resetAt, attempts, status };
      for (const key of ['lastAt', 'retryAt', 'warmAt', 'warmWindowResetAt', 'newResetAt']) if (time(raw[key])) out[key] = raw[key];
      seats[id] = out;
    }
    const owners = {};
    for (const [id, raw] of Object.entries(value && typeof value === 'object' ? value.owners || {} : {})) {
      if (!seatId(id) || !account(raw?.accountKey) || !directory(raw?.configDir)) continue;
      owners[id] = { accountKey: raw.accountKey, configDir: raw.configDir };
      if (time(raw.officialNotBefore)) owners[id].officialNotBefore = raw.officialNotBefore;
    }
    return { seats, ...(Object.keys(owners).length ? { owners } : {}) };
  }
  function matches(saved, event) {
    return !!saved && account(event.accountKey) && saved.accountKey === event.accountKey && !!directory(event.configDir) && directory(saved.configDir) === directory(event.configDir);
  }
  function nextWindow(previous, event) {
    const out = { accountKey: event.accountKey, configDir: event.configDir, resetAt: event.resetAt, attempts: 0, status: 'pending' };
    for (const key of ['warmAt', 'warmWindowResetAt', 'newResetAt']) if (time(previous?.[key])) out[key] = previous[key];
    if (out.warmAt && event.resetAt > out.warmWindowResetAt) out.newResetAt = event.resetAt;
    return out;
  }
  function observe(value, event, now = Date.now()) {
    const state = normalizeState(value);
    if (!event || !seatId(event.seatId)) return state;
    let previous = state.seats[event.seatId];
    if (previous && ((account(event.accountKey) && previous.accountKey !== event.accountKey) ||
      (directory(event.configDir) && directory(previous.configDir) !== directory(event.configDir)))) {
      delete state.seats[event.seatId]; previous = null;
    }
    // An unknown reset may keep a proven window, but cannot invent another one.
    if (event.proven !== true || !account(event.accountKey) || !directory(event.configDir) || !time(event.resetAt) ||
      (time(event.at) && event.at > now + 60_000) || (previous && event.resetAt <= previous.resetAt)) return state;
    state.seats[event.seatId] = nextWindow(previous, event);
    return state;
  }
  function due(saved, now) {
    return saved.resetAt + RESET_DELAY_MS <= now && saved.attempts < MAX_ATTEMPTS &&
      (saved.status === 'pending' || (saved.status === 'retry' && time(saved.retryAt) && saved.retryAt <= now));
  }
  function decide({ settings, state: value, seats = [], now = Date.now() } = {}) {
    if (!normalizeSettings(settings).enabled) return null;
    const state = normalizeState(value);
    for (const seat of seats) {
      if (!seat || !seatId(seat.id) || seat.occupied !== false || seat.warmupEligible === false) continue;
      const saved = state.seats[seat.id];
      if (!matches(saved, seat) || !due(saved, now)) continue;
      return { seatId: seat.id, accountKey: saved.accountKey, configDir: saved.configDir, resetAt: saved.resetAt, attempt: saved.attempts + 1, at: now };
    }
    return null;
  }
  function begin(value, event) {
    const state = normalizeState(value), saved = state.seats[event?.seatId];
    if (!event || !matches(saved, event) || saved.resetAt !== event.resetAt || event.attempt !== saved.attempts + 1 || !time(event.at) || !due(saved, event.at)) return state;
    saved.attempts = event.attempt; saved.status = 'running'; saved.lastAt = event.at;
    delete saved.retryAt;
    return state;
  }
  function fail(saved, now) {
    saved.status = saved.attempts >= MAX_ATTEMPTS ? 'abandoned' : 'retry';
    if (saved.status === 'retry') saved.retryAt = now + RETRY_DELAY_MS; else delete saved.retryAt;
  }
  function finish(value, event, now = Date.now()) {
    const state = normalizeState(value), saved = state.seats[event?.seatId];
    if (!event || !matches(saved, event) || saved.resetAt !== event.resetAt || saved.status !== 'running' || event.attempt !== saved.attempts || !time(now) || now < saved.lastAt) return state;
    if (event.success !== true) { fail(saved, now); return state; }
    saved.status = 'succeeded'; saved.warmAt = now; saved.warmWindowResetAt = saved.resetAt;
    if (event.provenNative === true && time(event.newResetAt) && event.newResetAt > now && event.newResetAt > saved.resetAt) {
      saved.newResetAt = event.newResetAt;
      state.seats[event.seatId] = nextWindow(saved, { ...saved, resetAt: event.newResetAt });
    }
    return state;
  }
  // Called once on startup, when requests belonging to the old process no
  // longer exist. A started request already consumed its attempt in begin().
  function recoverRunning(value, now = Date.now()) {
    const state = normalizeState(value);
    for (const saved of Object.values(state.seats)) if (saved.status === 'running') fail(saved, now);
    return state;
  }
  return { RESET_DELAY_MS, RETRY_DELAY_MS, MAX_ATTEMPTS, normalizeSettings, normalizeState, observe, decide, begin, finish, recoverRunning };
});
