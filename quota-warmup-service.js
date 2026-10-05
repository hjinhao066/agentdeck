'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./quota-warmup-core');
const Q = require('./quota-core');
const P = require('./perpetual-captain-core');

function createWarmupService({ stateFile, logFile, getSettings, getSeats, readSeat, occupied, run, getThreshold = () => 3, now = Date.now }) {
  let state;
  try { state = W.normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
  catch (_) { state = W.normalizeState(); }
  state = W.recoverRunning(state, now());
  let stopped = false, ticking = false;
  const inflight = new Map();
  const persist = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  const dirKey = (dir) => {
    const key = String(dir || '').replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' || /^(?:[a-z]:\/|\/\/)/i.test(key) ? key.toLowerCase() : key;
  };
  const identityMatches = (info, d) => info?.accountKey === d.accountKey && dirKey(info?.configDir) === dirKey(d.configDir);
  async function sample() {
    const result = [];
    for (const seat of getSeats()) {
      let info;
      try { info = await readSeat(seat); } catch (_) { continue; }
      const owner = state.owners?.[seat.id];
      const changed = owner && (owner.accountKey !== info?.accountKey || dirKey(owner.configDir) !== dirKey(info?.configDir));
      const officialNotBefore = Math.max(owner?.officialNotBefore || 0, info?.quota?.officialNotBefore || 0, changed ? now() : 0);
      if (officialNotBefore > (owner?.officialNotBefore || 0)) delete state.seats[seat.id];
      if (info?.accountKey && info?.configDir) {
        state.owners ||= {};
        state.owners[seat.id] = { accountKey: info.accountKey, configDir: info.configDir,
          ...(officialNotBefore ? { officialNotBefore } : {}) };
      }
      // Consume the same quota structure as the bar/Relay, plus the existing
      // seat-bound native cache. The API reader is owned by the quota feature.
      const records = [info?.quota?.sample, info?.usage].filter((record) => P.bound(record,
        { ...info, id: seat.id, configuredDir: seat.configDir, officialNotBefore }) &&
        Number.isFinite(record.at) && (!record.seatId || record.seatId === seat.id));
      const samples = records.map((record) => {
        const w = record.windows?.find((w) => w.key === 'fiveHour' || w.label === '5 小时');
        const resetAt = Number.isFinite(w?.resetAt) && w.resetAt > 0 ? w.resetAt : w ? Q.resetTime(w.resetText, record.at) : null;
        const weekly = record.windows?.find((w) => w.key === 'weekly' || w.label === '每周');
        const weeklyReset = Number.isFinite(weekly?.resetAt) ? weekly.resetAt : weekly ? Q.resetTime(weekly.resetText, record.at) : null;
        return { at: record.at, resetAt, weeklyRemaining: weekly?.remaining,
          weeklyReset };
      }).filter((s) => s.resetAt).sort((a, b) => b.at - a.at);
      const sample = samples[0];
      state = W.observe(state, { seatId: seat.id, accountKey: info?.accountKey, configDir: info?.configDir,
        resetAt: sample?.resetAt, at: sample?.at, proven: !!sample }, now());
      const warmupEligible = info?.loggedIn !== false && Number.isFinite(sample?.weeklyRemaining) &&
        sample.weeklyRemaining > P.normalizeSettings({ threshold: getThreshold() }).threshold && sample.weeklyReset > now();
      if (info?.accountKey && info?.configDir) result.push({ ...seat, ...info, warmupEligible });
    }
    return result;
  }
  async function tick() {
    if (stopped || ticking || !W.normalizeSettings(getSettings()).enabled) return;
    ticking = true;
    try {
      const seats = await sample();
      const busy = await occupied(seats);
      const d = W.decide({ settings: getSettings(), state,
        seats: seats.map((s) => ({ ...s, occupied: busy.has(s.id) })), now: now() });
      if (!d || stopped || !W.normalizeSettings(getSettings()).enabled) { persist(); return; }
      const seat = getSeats().find((s) => s.id === d.seatId);
      const fresh = seat && await readSeat(seat);
      const latest = (await sample()).find((s) => s.id === d.seatId);
      if (!seat || !identityMatches(fresh, d) || !identityMatches(latest, d) || latest?.warmupEligible !== true || state.seats[d.seatId]?.resetAt !== d.resetAt || (await occupied(seats)).has(d.seatId)) return;
      if (stopped || !W.normalizeSettings(getSettings()).enabled) return;
      // Claim durably before spawning: crashes cannot turn a window into
      // unlimited attempts. A new normal session can abort only this child.
      state = W.begin(state, d); persist();
      const controller = new AbortController(); inflight.set(d.seatId, controller);
      let result;
      try { result = await run(seat, { signal: controller.signal }); }
      catch (_) { result = { success: false, reason: 'execution-failed' }; }
      finally { inflight.delete(d.seatId); }
      const configuredAfter = getSeats().find((s) => s.id === d.seatId);
      const after = configuredAfter ? await readSeat(configuredAfter).catch(() => null) : null;
      const matched = identityMatches(after, d);
      const success = matched && result?.ok === true && !controller.signal.aborted;
      state = W.finish(state, { ...d, success, newResetAt: success ? result.resetAt : null,
        provenNative: success && result.provenNative === true }, now());
      persist();
      fs.appendFileSync(logFile, JSON.stringify({ seat: seat.name, seatId: seat.id,
        time: new Date(now()).toISOString(), attempt: d.attempt, outcome: success ? 'warmed' : 'failed',
        reason: success ? '' : controller.signal.aborted ? 'seat-in-use' : matched ? 'request-failed' : 'identity-changed',
        newResetAt: success && result.provenNative ? result.resetAt || null : null }) + '\n', { mode: 0o600 });
    } finally { ticking = false; }
  }
  return {
    tick,
    cancel: (seatId) => inflight.get(seatId)?.abort(),
    snapshot: async () => {
      const seats = await sample();
      persist();
      return seats.map((s) => ({ seatId: s.id, warmupEligible: s.warmupEligible, ...state.seats[s.id] }));
    },
    dispose: () => { stopped = true; for (const controller of inflight.values()) controller.abort(); },
  };
}
module.exports = { createWarmupService };
