'use strict';
const Q = require('./quota-core');

function settings(value = {}) {
  return {
    thresholdPercent: Q.percent(value?.thresholdPercent) ?? 2,
    volume: Number.isInteger(value?.volume) && value.volume >= 0 && value.volume <= 10 ? value.volume : 3,
  };
}

// Main-process state is separate from renderer config: delayed config saves
// must never overwrite a delivery latch. Persist before awaiting the network.
function createQuotaLowBark({ state = {}, saveState, sendBark }) {
  return function check(config, now = Date.now()) {
    if (typeof config.barkKeyFile !== 'string' || !config.barkKeyFile.trim()) return Promise.resolve([]);
    const options = settings(config.claudeQuotaAlert), alerts = [];
    let changed = false;
    for (const seat of Q.claudeSeats(config.claudeSeats)) {
      const entry = config.quotas?.[Q.seatKey(seat.id)], sample = entry?.sample;
      if (entry?.scope !== 'claude' || (entry.configDir && entry.configDir !== seat.configDir) ||
          !sample || !Number.isFinite(sample.at) || sample.at > now + 60000 || now - sample.at > Q.FRESH_MS) continue;
      const w = sample.windows?.find((w) => w.label === '5 小时');
      if (!w || Q.percent(w.remaining) === null || (w.resetAt && w.resetAt <= now)) continue;
      const fallback = `seat:${seat.configDir}`, key = entry.accountKey ? `account:${entry.accountKey}` : fallback;
      // Learning an account identity after its first screen sample is not a reset.
      if (key !== fallback && state[fallback] && !state[key]) {
        state[key] = state[fallback]; delete state[fallback]; changed = true;
      }
      const old = state[key];
      if (old && sample.at < old.at) continue;
      const reset = old?.resetAt && sample.at >= old.resetAt && sample.at > old.at;
      const recovered = old && sample.at > old.at && w.remaining > options.thresholdPercent;
      const next = { at: sample.at, resetAt: !reset && old?.notified ? old.resetAt || w.resetAt || null : w.resetAt || null,
        notified: !!old?.notified && !reset && !recovered };
      if (w.remaining <= options.thresholdPercent && !next.notified) {
        next.notified = true;
        const resetText = w.resetAt ? new Date(w.resetAt).toLocaleString() : w.resetText;
        alerts.push({ title: 'Claude 额度即将用尽', volume: options.volume,
          message: `Claude ${seat.name}（${seat.id.toUpperCase()} 席位）5 小时额度快用完：剩余 ${w.remaining}%。` +
            (resetText ? `重置时间：${resetText}。` : '') });
      }
      if (JSON.stringify(old) !== JSON.stringify(next)) { state[key] = next; changed = true; }
    }
    if (changed) saveState(state); // A failed write prevents sending without a durable latch.
    return Promise.all(alerts.map((alert) => sendBark(alert)));
  };
}
module.exports = { settings, createQuotaLowBark };
