(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PerpetualCaptainCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COOLDOWN_MS = 10 * 60_000;
  const FRESH_MS = 15 * 60_000;
  const CODEX_ID = 'chatgpt';
  const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
  const time = (value) => Number.isFinite(value) && value > 0 ? value : null;
  const percent = (value) => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  function normalizeSettings(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const threshold = percent(value.threshold);
    return { enabled: value.enabled !== false, threshold: threshold === null ? 3 : threshold };
  }
  function normalizeState(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const seats = {};
    for (const [id, raw] of Object.entries(value.seats || {})) {
      if (!validId(id) || !raw || typeof raw !== 'object') continue;
      const seat = {};
      for (const key of ['exhaustedAt', 'resetAt', 'lowAt', 'lowResetAt', 'recoveredAt', 'clearedAt', 'enteredAt', 'leftAt', 'officialNotBefore']) if (time(raw[key])) seat[key] = raw[key];
      if (percent(raw.lowRemaining) !== null) seat.lowRemaining = raw.lowRemaining;
      for (const key of ['accountKey', 'configDir']) if (typeof raw[key] === 'string' && raw[key]) seat[key] = raw[key];
      seats[id] = seat;
    }
    const last = value.lastSwitch;
    const lastSwitch = last && validId(last.fromId) && validId(last.targetId) && time(last.at)
      ? { fromId: last.fromId, targetId: last.targetId, reason: String(last.reason || ''), at: last.at } : null;
    return { seats, lastSwitch };
  }
  function recover(seat, now) {
    for (const [atKey, resetKey] of [['exhaustedAt', 'resetAt'], ['lowAt', 'lowResetAt']]) {
      if (!seat[atKey] || !seat[resetKey] || seat[resetKey] > now) continue;
      seat.recoveredAt = Math.max(seat.recoveredAt || 0, seat[resetKey]);
      seat.clearedAt = Math.max(seat.clearedAt || 0, seat[atKey], seat[resetKey]);
      delete seat[atKey]; delete seat[resetKey];
      if (atKey === 'lowAt') delete seat.lowRemaining;
    }
    return seat;
  }
  function observe(value, event, now = Date.now()) {
    const state = normalizeState(value);
    for (const seat of Object.values(state.seats)) recover(seat, now);
    if (!event || !validId(event.seatId)) return state;
    let seat = state.seats[event.seatId] || (state.seats[event.seatId] = {});
    const identityChanged = (event.accountKey && seat.accountKey && event.accountKey !== seat.accountKey) ||
      (event.configDir && seat.configDir && event.configDir !== seat.configDir);
    const officialNotBefore = Math.max(seat.officialNotBefore || 0, identityChanged ? now : 0);
    if ((event.accountKey && event.accountKey !== seat.accountKey) || (event.configDir && seat.configDir && event.configDir !== seat.configDir)) {
      // A new login/directory cannot inherit the previous account's quota lock.
      seat = state.seats[event.seatId] = { enteredAt: seat.enteredAt, leftAt: seat.leftAt };
    }
    if (time(officialNotBefore)) seat.officialNotBefore = officialNotBefore;
    for (const key of ['accountKey', 'configDir']) if (typeof event[key] === 'string' && event[key]) seat[key] = event[key];
    const at = time(event.at);
    if (!at || at > now + 60_000 || at <= (seat.clearedAt || 0)) return state;
    if (event.resumed && at > (seat.exhaustedAt || 0)) {
      delete seat.exhaustedAt; delete seat.resetAt; delete seat.lowAt; delete seat.lowResetAt; delete seat.lowRemaining;
      seat.recoveredAt = at; seat.clearedAt = at;
    }
    if (!event.resumed && event.exhausted && at >= (seat.exhaustedAt || 0) && (!time(event.resetAt) || event.resetAt > now)) {
      const newer = at > (seat.exhaustedAt || 0);
      seat.exhaustedAt = at;
      if (time(event.resetAt)) seat.resetAt = event.resetAt; else if (newer) delete seat.resetAt;
    }
    const remainingAt = time(event.remainingAt) || at;
    const remaining = percent(event.remaining);
    if (event.trusted === true && remaining !== null && now - remainingAt <= FRESH_MS && remainingAt <= now + 60_000 &&
      remainingAt > (seat.clearedAt || 0) && (!time(event.resetAt) || event.resetAt > now)) {
      if (remaining <= normalizeSettings({ threshold: event.threshold }).threshold && remainingAt >= (seat.lowAt || 0)) {
        const newer = remainingAt > (seat.lowAt || 0);
        seat.lowAt = remainingAt; seat.lowRemaining = remaining;
        if (time(event.resetAt)) seat.lowResetAt = event.resetAt; else if (newer) delete seat.lowResetAt;
      } else if (remainingAt > (seat.lowAt || 0)) {
        delete seat.lowAt; delete seat.lowResetAt; delete seat.lowRemaining;
      }
      // A positive numeric sample alone cannot clear a real rate-limit error.
    }
    return state;
  }
  function sameDir(actual, info) {
    const clean = (value) => {
      const dir = typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/$/, '') : '';
      return /^(?:[a-z]:\/|\/\/)/i.test(dir) ? dir.toLowerCase() : dir;
    };
    const dir = clean(actual);
    return !!dir && [info.configDir, info.configuredDir].some((expected) => dir === clean(expected));
  }
  function bound(evidence, info) {
    if (!evidence || !info || !sameDir(evidence.configDir, info)) return false;
    // The API's credential key identifies the current seat's storage slot,
    // not its account. Known account contradictions still invalidate it.
    if (evidence.official === true) return evidence.provider === 'Claude' && evidence.scope === 'claude' &&
      evidence.seatId === info.id && !!info.credentialKey && evidence.credentialKey === info.credentialKey &&
      (!time(info.officialNotBefore) || (time(evidence.at) && evidence.at >= info.officialNotBefore)) &&
      (!evidence.accountKey || (!!info.accountKey && evidence.accountKey === info.accountKey));
    return evidence.accountBound === true && !!info.accountKey && evidence.accountKey === info.accountKey;
  }
  function seatQuota(saved = {}, info = {}, now = Date.now()) {
    if (!saved || typeof saved !== 'object') saved = {};
    if (!info || typeof info !== 'object') info = {};
    info = { ...info, officialNotBefore: Math.max(time(info.officialNotBefore) || 0, time(saved.officialNotBefore) || 0) };
    const sample = saved.sample;
    const fresh = sample && time(sample.at) && sample.at <= now + 60_000 && now - sample.at <= FRESH_MS;
    const fiveHour = fresh && bound(sample, info) && (sample.windows || []).find((window) =>
      (window.key === 'fiveHour' || window.label === '5 小时') && percent(window.remaining) !== null && (!time(window.resetAt) || window.resetAt > now));
    const block = saved.blocked;
    // Native errors carry their source column and seat directory. Cached
    // percentages additionally need the account fingerprint from that sample.
    const errorBound = block && !block.numeric && !!block.sourceColumnId && sameDir(block.configDir, info) &&
      (!block.accountKey || (!!info.accountKey && block.accountKey === info.accountKey));
    const numericBound = block && block.numeric && ((bound(block, info) &&
      (block.official !== true || (time(block.at) && now - block.at <= FRESH_MS))) ||
      (bound(sample, info) && (sample.official !== true || fresh) && sample.at >= block.at && (sample.windows || []).some((window) => window.exhausted)));
    const blocked = block && time(block.at) && block.at <= now + 60_000 && (!time(block.resetAt) || block.resetAt > now) && (errorBound || numericBound);
    const officialRecovery = fresh && sample.official === true && bound(sample, info) && sample.windows?.length &&
      sample.windows.every((window) => percent(window.remaining) !== null && window.remaining > 0 &&
        !window.exhausted && time(window.resetAt) && window.resetAt > now);
    const recovery = saved.resumed || (fresh && (sample.resumed || officialRecovery) ? sample : null);
    const resumed = recovery && time(recovery.at) && recovery.at <= now + 60_000 && recovery.at > (block?.at || 0) &&
      (bound(recovery, info) || (recovery.sourceColumnId && sameDir(recovery.configDir, info) &&
        (!recovery.accountKey || (!!info.accountKey && recovery.accountKey === info.accountKey))));
    return {
      remaining: fiveHour ? fiveHour.remaining : null,
      remainingAt: fiveHour ? sample.at : null,
      resetAt: fiveHour ? time(fiveHour.resetAt) : null,
      trusted: !!fiveHour,
      exhausted: !!blocked,
      exhaustedAt: blocked ? block.at : null,
      exhaustedResetAt: blocked ? time(block.resetAt) : null,
      resumedAt: resumed ? recovery.at : null,
    };
  }
  function status(seat, saved, threshold, now) {
    const state = recover({ ...saved }, now);
    const at = time(seat.remainingAt);
    const trusted = seat.trusted === true && percent(seat.remaining) !== null && at && at <= now + 60_000 && now - at <= FRESH_MS && (!time(seat.resetAt) || seat.resetAt > now);
    const low = trusted ? seat.remaining <= threshold : !!state.lowAt && state.lowRemaining <= threshold;
    const numericExhausted = trusted ? seat.remaining === 0 : !!state.lowAt && state.lowRemaining === 0;
    const exhausted = !!state.exhaustedAt || numericExhausted || (seat.exhausted === true && (!time(seat.exhaustedResetAt) || seat.exhaustedResetAt > now));
    const lastMove = Math.max(state.enteredAt || 0, state.leftAt || 0);
    return { state, trusted, low, exhausted, available: seat.loggedIn === true && !low && !exhausted,
      cooling: !!lastMove && now - lastMove < COOLDOWN_MS };
  }
  function decide({ settings, state: value, currentId, seats = [], busy = false, draft = false, briefing = false, switching = false, now = Date.now() } = {}) {
    const config = normalizeSettings(settings), state = normalizeState(value);
    if (!config.enabled || busy || draft || briefing || switching || !validId(currentId)) return null;
    const claude = seats.filter((seat) => seat && validId(seat.id) && seat.id !== CODEX_ID).map((seat) =>
      ({ seat, ...status(seat, state.seats[seat.id] || {}, config.threshold, now) }));
    if (!claude.length) return null;
    const current = claude.find(({ seat }) => seat.id === currentId);
    const candidates = claude.filter(({ seat, available, cooling }) => seat.id !== currentId && available && !cooling);
    if (currentId === CODEX_ID) {
      const enteredCodexAt = state.lastSwitch?.targetId === CODEX_ID ? state.lastSwitch.at : 0;
      const target = candidates.find(({ seat, state: saved, trusted }) =>
        (saved.recoveredAt && saved.recoveredAt > enteredCodexAt) || (trusted && seat.remaining > config.threshold && seat.remainingAt > enteredCodexAt));
      return target ? { targetId: target.seat.id, reason: 'claude-recovered', at: now } : null;
    }
    if (!current || (!current.exhausted && !current.low)) return null;
    const reason = current.exhausted ? 'quota-exhausted' : 'threshold';
    if (candidates.length) return { targetId: candidates[0].seat.id, reason, remaining: current.trusted ? current.seat.remaining : null, at: now };
    // A healthy seat in its cooldown is temporarily unavailable, not exhausted.
    // Stay put until it can be used rather than hopping through Codex.
    if (claude.some(({ available }) => available)) return null;
    // A low positive quota or an unknown login is not evidence of exhaustion.
    // Codex is the fallback only after both Claude seats are actually exhausted.
    if (claude.length < 2 || claude.some(({ exhausted }) => !exhausted)) return null;
    const codex = state.seats[CODEX_ID] || {};
    const codexMove = Math.max(codex.enteredAt || 0, codex.leftAt || 0);
    if (codexMove && now - codexMove < COOLDOWN_MS) return null;
    return { targetId: CODEX_ID, reason: 'claude-unavailable', remaining: current.trusted ? current.seat.remaining : null, at: now };
  }
  function recordSwitch(value, event) {
    const state = normalizeState(value);
    if (!event || !validId(event.fromId) || !validId(event.targetId) || event.fromId === event.targetId || !time(event.at)) return state;
    const from = state.seats[event.fromId] || (state.seats[event.fromId] = {});
    const target = state.seats[event.targetId] || (state.seats[event.targetId] = {});
    from.leftAt = event.at; target.enteredAt = event.at;
    state.lastSwitch = { fromId: event.fromId, targetId: event.targetId, reason: String(event.reason || ''), at: event.at };
    return state;
  }
  return { COOLDOWN_MS, FRESH_MS, CODEX_ID, normalizeSettings, normalizeState, observe, bound, seatQuota, decide, recordSwitch };
});
