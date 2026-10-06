// Battery mode: pure helpers shared by the page and the main process. No DOM, no
// Electron. The power source itself comes from Electron's powerMonitor (main.js);
// everything here only turns "on battery?" + the user's setting into numbers.
//
// Battery mode is active only when the setting is 自动 and the Mac runs on battery.
// Plugged in (or setting 关闭) nothing in here changes any value.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BatteryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODE_DEFAULT = 'auto';
  const CAP_DEFAULT = 3;
  const CAP_MIN = 1;
  const CAP_MAX = 10;
  function normalizeMode(value) { return value === 'off' ? 'off' : MODE_DEFAULT; }
  function normalizeCap(value) {
    if (value == null || value === '') return CAP_DEFAULT;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n)) return CAP_DEFAULT;
    return Math.min(CAP_MAX, Math.max(CAP_MIN, n));
  }
  function isActive(mode, onBattery) { return normalizeMode(mode) === 'auto' && onBattery === true; }

  // The live number of sessions allowed to work: the settings cap, lowered to the
  // battery cap while battery mode is active. `limited` says the battery is what
  // sets it, so queue cards can say so.
  function effectiveCap(baseCap, prefs) {
    const base = Number.isInteger(baseCap) && baseCap > 0 ? baseCap : 30;
    if (!prefs || !isActive(prefs.mode, prefs.onBattery)) return { cap: base, limited: false };
    const cap = Math.min(base, normalizeCap(prefs.cap));
    return { cap, limited: cap < base };
  }

  // Background polling, normal → on battery (ms). One table so the page, the main
  // process, the report and the tests agree. Receipts and questions travel through
  // the board request channel and the status tick; both only get slower, never off.
  const POLL = {
    boardRequests: [250, 750],       // main: pick up complete/ask/progress commands
    statusTick: [1500, 3000],        // page: screen read + status light per session
    quotaCache: [30_000, 120_000],   // page: re-read the cached quota samples
    claudeQuotaTick: [30_000, 120_000], // main: check which Claude seats are due
    claudeQuotaSample: [300_000, 900_000], // main: how often one seat is actually sampled
    claudeSeatsRefresh: [30_000, 120_000], // page: seat list refresh
    claudeSeatsWatchdog: [1500, 3000],    // page: crashed/unstarted captain watchdog
  };
  function pollMs(key, active) {
    const pair = POLL[key];
    if (!pair) throw new Error('Unknown poll: ' + key);
    return active ? pair[1] : pair[0];
  }

  // Appended to the end of work handed to a session while on battery.
  const TASK_NOTE = '当前电池供电：不要跑全量 E2E，只跑相关单测，E2E 留到接电后';
  function withTaskNote(text, active) {
    const body = String(text == null ? '' : text);
    if (!active || body.includes(TASK_NOTE)) return body;
    return body.replace(/\s+$/, '') + '\n\n' + TASK_NOTE;
  }

  // Queue card text for new work held back by the battery cap.
  function queueReason(title, cap, active) {
    return `已排队：电池供电，稍后自动开新会话「${title}」（电池模式同时最多 ${cap} 个会话干活，现有 ${active} 个；接电或有空位后自动开，不用重派）。`;
  }

  // What battery mode changes right now, one line each, for the sidebar tooltip.
  function describe(prefs, baseCap) {
    const active = isActive(prefs?.mode, prefs?.onBattery);
    if (!active) {
      return normalizeMode(prefs?.mode) === 'off' ? ['电池模式：不限制（设置里选了「不限制」）'] : ['电池模式：待命，接电源时不做任何限制'];
    }
    const { cap } = effectiveCap(baseCap, prefs);
    return [
      '电池模式：电池供电，已启用',
      `同时最多开 ${cap} 个会话（已在跑的不中断，新开的排队，接电后自动补位）`,
      '派给队员的任务末尾提醒：不跑全量 E2E，只跑相关单测',
      '关闭动效（星图、状态灯呼吸）和终端光标闪烁',
      '后台轮询放慢（状态检测 3 秒、额度 2 分钟），回执和提问照常送达',
    ];
  }

  // The one line `ledger` and `quota` add for the Captain, only while battery mode is on
  // (plugged in or 不限制 they print nothing extra). The cap limits opening new sessions;
  // `tell` to an idle crew member is not counted, so more than `cap` can end up working.
  function statusLine(prefs, baseCap, working) {
    if (!isActive(prefs?.mode, prefs?.onBattery)) return '';
    const { cap } = effectiveCap(baseCap, prefs);
    const busy = Number.isInteger(working) && working >= 0 ? `，现在 ${working} 个在干活` : '';
    return `电池模式：开（电池供电），同时最多开 ${cap} 个会话（设置上限 ${baseCap}）${busy}；超出的新会话排队，接电后自动补位`;
  }

  // The live state of this page: power source + settings, with change listeners.
  function create() {
    const s = { onBattery: false, mode: MODE_DEFAULT, cap: CAP_DEFAULT };
    const listeners = new Set();
    const snapshot = () => ({ onBattery: s.onBattery, mode: s.mode, cap: s.cap, active: isActive(s.mode, s.onBattery) });
    return {
      snapshot,
      active: () => isActive(s.mode, s.onBattery),
      set(next = {}) {
        const before = JSON.stringify(snapshot());
        if ('onBattery' in next) s.onBattery = next.onBattery === true;
        if ('mode' in next) s.mode = normalizeMode(next.mode);
        if ('cap' in next) s.cap = normalizeCap(next.cap);
        if (JSON.stringify(snapshot()) === before) return false;
        for (const fn of [...listeners]) { try { fn(snapshot()); } catch (_) { /* a listener must not stop the others */ } }
        return true;
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // setInterval whose period follows the power state; the returned handle has stop().
      // The default timers are wrapped: a browser's setTimeout throws when called as a method of another object.
      every(key, fn, timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) }) {
        let timer = null, stopped = false;
        const loop = () => {
          timer = timers.setTimeout(() => {
            // Keep ticking after an error, but say so, as setInterval did.
            try { const r = fn(); if (r && typeof r.catch === 'function') r.catch((err) => console.error(`[battery] ${key} tick failed:`, err)); }
            catch (err) { console.error(`[battery] ${key} tick failed:`, err); }
            if (!stopped) loop();
          }, pollMs(key, isActive(s.mode, s.onBattery)));
          if (timer && typeof timer.unref === 'function') timer.unref();
        };
        loop();
        return { stop() { stopped = true; timers.clearTimeout(timer); } };
      },
    };
  }

  return {
    MODE_DEFAULT, CAP_DEFAULT, CAP_MIN, CAP_MAX, POLL, TASK_NOTE,
    normalizeMode, normalizeCap, isActive, effectiveCap, pollMs, withTaskNote, queueReason, describe, statusLine, create,
    shared: create(),
  };
});
