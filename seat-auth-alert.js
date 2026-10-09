'use strict';
const crypto = require('crypto');
const Q = require('./quota-core');
const S = require('./claude-seats-core');

const CONFIRM_MS = 30_000;
// A seat nobody signs back into is rechecked quickly at first, then slowly:
// every check reads the seat's credential or starts the provider's CLI.
const FAST_RECHECK_MS = 10 * 60_000, SLOW_RECHECK_MS = 2 * 60_000;
const quote = (value, platform) => "'" + value.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'";
function loginCommand(provider, seat, home, platform = process.platform) {
  const variable = provider === 'Claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  // --email pre-fills the sign-in page; the browser may still be on another claude.ai account.
  const email = provider === 'Claude' && S.cleanEmail(seat.email);
  const command = provider === 'Claude' ? 'claude auth login' + (email ? ' --email ' + email : '') : 'codex login';
  const standard = provider === 'Claude' ? '~/.claude' : '~/.codex';
  const dir = S.configDir(seat, home, platform), base = S.configDir({ configDir: standard }, home, platform);
  const same = platform === 'win32' ? dir.toLowerCase() === base.toLowerCase() : dir === base;
  if (platform === 'win32') return `Remove-Item Env:${variable} -ErrorAction SilentlyContinue; ` +
    (same ? '' : `$env:${variable}=${quote(dir, platform)}; `) + command;
  if (same) return `env -u ${variable} ${command}`;
  // Keep simple ~/ paths readable and expandable; shell-quote every other path.
  const value = /^~\/[a-zA-Z0-9_./-]+$/.test(seat.configDir) ? seat.configDir : quote(dir, platform);
  return `${variable}=${value} ${command}`;
}
function loginHint(email) {
  email = S.cleanEmail(email);
  return email ? `授权页右上角的账号要是 ${email}，不是就先在网页里切换账号再授权。\n` : '';
}
function authFailure(message) {
  return typeof message === 'string' && (/\bnot (?:logged|signed) in\b|未登录|尚未登录|请先登录/i.test(message) ||
    message.split('\n').some((line) => Q.resourceError(line) === 'auth'));
}

// Only fresh, explicit sampler proofs enter here. Neither stale quota numbers
// nor a generic query/network failure is evidence that a login was lost.
function createSeatAuthMonitor({ state = {}, saveState, onAlert, onStatus, onRecovery, home, platform = process.platform,
  id = () => crypto.randomUUID() } = {}) {
  state = Object.fromEntries(Object.entries(state).filter(([key, e]) => e && ['Claude', 'Codex'].includes(e.provider) &&
    key === (e.provider === 'Claude' ? Q.seatKey(e.seatId) : 'Codex') && typeof e.configDir === 'string' &&
    Number.isFinite(e.lastAt)).map(([key, e]) => {
    const receipts = (Array.isArray(e.receipts) ? e.receipts : [])
      .filter((r) => r && typeof r.id === 'string' && typeof r.message === 'string' && r.message.length <= 4000);
    return [key, { ...e, receipts, alertId: e.alertId || (e.notified ? receipts[0]?.id || id() : undefined) }];
  }));
  function observe(seat, sample) {
    if (!seat || !['Claude', 'Codex'].includes(sample?.provider) || !Number.isFinite(sample.at)) return false;
    const key = sample.provider === 'Claude' ? Q.seatKey(seat.id) : sample.provider;
    let previous = state[key];
    if (previous?.configDir !== seat.configDir) previous = null;
    if (previous && sample.at <= previous.lastAt) return false;
    const next = { ...(previous || { receipts: state[key]?.receipts || [] }), provider: sample.provider, seatId: seat.id, name: seat.name,
      configDir: seat.configDir, lastAt: sample.at };
    if (sample.provider === 'Claude') next.email = S.cleanEmail(seat.email);
    let changedStatus = false, alert, recovered;
    if (sample.authStatus === 'logged-in') {
      if (next.status === 'logged-out') recovered = { provider: sample.provider, seatId: seat.id, configDir: seat.configDir, alertId: next.alertId };
      changedStatus = next.status !== 'logged-in';
      next.status = 'logged-in'; next.statusAt = sample.at; next.wasLoggedIn = true;
      next.misses = 0; next.notified = false; delete next.firstMissAt; delete next.outSince;
    } else if (sample.authStatus === 'logged-out') {
      next.firstMissAt ??= sample.at;
      next.misses = (next.misses || 0) + 1;
      if (next.misses >= 2 && sample.at - next.firstMissAt >= CONFIRM_MS) {
        changedStatus = next.status !== 'logged-out';
        next.status = 'logged-out'; next.statusAt = sample.at; next.outSince ??= sample.at;
        if (next.wasLoggedIn && !next.notified) {
          const command = loginCommand(sample.provider, seat, home, platform);
          const name = sample.provider === 'Claude' ? `Claude ${seat.name}（${seat.id}）席位` : 'Codex 席位';
          alert = { id: id(), provider: sample.provider, seatId: seat.id,
            message: `${name}掉登录了，派到这里的任务会失败或排队。请现在打开终端运行：\n${command}\n${loginHint(sample.provider === 'Claude' && seat.email)}完成网页登录后，AgentDeck 会自动检查恢复；队长请把受影响的任务改派到其他已登录席位。` };
          next.notified = true; next.receipts = [...(next.receipts || []), alert];
          next.alertId = alert.id; next.deliveryFailureReported = false; next.cancellationFailureReported = false;
        }
      }
    } else {
      next.misses = 0; delete next.firstMissAt;
    }
    // Persist the episode latch before sending, including across app relaunch.
    const saved = { ...state, [key]: next };
    saveState(saved); state = saved;
    if (recovered) onRecovery?.(recovered);
    if (changedStatus) onStatus?.(statusSample(next));
    if (alert) onAlert?.(alert);
    return true;
  }
  function statusSample(entry) {
    return { provider: entry.provider, scope: Q.SCOPES[entry.provider], seatId: entry.seatId,
      configDir: entry.configDir, at: entry.statusAt, authOnly: true, authStatus: entry.status, source: '席位登录确认',
      loginCommand: loginCommand(entry.provider, entry, home, platform) };
  }
  return {
    observe,
    samples: () => Object.values(state).filter((e) => ['logged-in', 'logged-out'].includes(e.status)).map(statusSample),
    needsConfirmation: (seat, provider) => {
      const e = state[provider === 'Claude' ? Q.seatKey(seat.id) : provider];
      return e?.configDir === seat.configDir && (e.misses > 0 || e.status === 'logged-out');
    },
    recheckDelay: (seat, provider, at) => {
      const e = state[provider === 'Claude' ? Q.seatKey(seat.id) : provider];
      return e?.configDir === seat.configDir && e.status === 'logged-out' && at - e.outSince > FAST_RECHECK_MS ? SLOW_RECHECK_MS : CONFIRM_MS;
    },
    recordDeliveryFailure: (alertIdOrKey, message, kind = 'delivery') => {
      if (typeof alertIdOrKey !== 'string' || typeof message !== 'string' || !message.trim()) return false;
      const key = Object.keys(state).find((key) => state[key].alertId === alertIdOrKey ||
        `seat-auth:${state[key].provider}:${state[key].seatId}` === alertIdOrKey);
      const entry = key && state[key];
      const reported = kind === 'cancel' ? 'cancellationFailureReported' : 'deliveryFailureReported';
      if (!entry?.alertId || entry[reported]) return false;
      const name = entry.provider === 'Claude' ? `Claude ${entry.name}（${entry.seatId}）席位` : 'Codex 席位';
      const receipt = { id: id(), provider: entry.provider, seatId: entry.seatId,
        message: `${name}掉登录提醒异常：${message.trim().slice(0, 500)}` };
      const saved = { ...state, [key]: { ...entry, [reported]: true, receipts: [...(entry.receipts || []), receipt] } };
      saveState(saved); state = saved;
      return true;
    },
    pendingReceipts: () => Object.values(state).flatMap((e) => e.receipts || []),
    acknowledge: (alertId) => {
      const key = Object.keys(state).find((k) => state[k].receipts?.some((r) => r.id === alertId));
      if (!key) return;
      const saved = { ...state, [key]: { ...state[key], receipts: state[key].receipts.filter((r) => r.id !== alertId) } };
      saveState(saved); state = saved;
    },
  };
}
module.exports = { CONFIRM_MS, FAST_RECHECK_MS, SLOW_RECHECK_MS, loginCommand, loginHint, authFailure, createSeatAuthMonitor };
