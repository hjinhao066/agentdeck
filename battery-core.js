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
    // 临时拉满: the Captain (or the user, from the phone) lifts the battery limit for a while; the settings cap still applies.
    if (prefs.boost === true) return { cap: base, limited: false };
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

  // 临时拉满 ends when the user or Captain cancels it, at the plug-in, or at `until` (ms; 0/absent = no end time).
  const BOOST_MAX_MINUTES = 2880;
  function boostUntilText(until) {
    if (!Number.isFinite(until) || until <= 0) return '直到取消或接电源';
    const d = new Date(until), pad = (n) => String(n).padStart(2, '0');
    return `到 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function boostLive(prefs, now) {
    return prefs?.boost === true && (!Number.isFinite(prefs.boostUntil) || !(prefs.boostUntil > 0) || now < prefs.boostUntil);
  }

  // What battery mode changes right now, one line each, for the sidebar tooltip.
  function describe(prefs, baseCap) {
    const active = isActive(prefs?.mode, prefs?.onBattery);
    if (!active) {
      return normalizeMode(prefs?.mode) === 'off' ? ['电池模式：不限制（设置里选了「不限制」）'] : ['电池模式：待命，接电源时不做任何限制'];
    }
    const { cap } = effectiveCap(baseCap, prefs);
    if (prefs.boost === true) return [
      `电池模式：电池供电，已临时拉满（${boostUntilText(prefs.boostUntil)}）`,
      `同时最多开 ${cap} 个会话（不受省电上限限制，接电源或取消后恢复）`,
      '派给队员的任务末尾提醒：不跑全量 E2E，只跑相关单测',
      '关闭动效（星图、状态灯呼吸）和终端光标闪烁',
      '后台轮询放慢（状态检测 3 秒、额度 2 分钟），回执和提问照常送达',
    ];
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
    if (prefs.boost === true) return `电池模式：已临时拉满（${boostUntilText(prefs.boostUntil)}），同时最多开 ${cap} 个会话（设置上限 ${baseCap}）${busy}；接电源、到时间或 settings battery --boost off 后恢复省电上限 ${normalizeCap(prefs.cap)}`;
    return `电池模式：开（电池供电），同时最多开 ${cap} 个会话（设置上限 ${baseCap}）${busy}；超出的新会话排队，接电后自动补位`;
  }

  // A change asked for from outside the settings page (the phone hub, the Captain's `settings battery`).
  // Strict where the settings box clamps: a stray 99 or "banana" is refused with a reason, never quietly turned into 10 or 自动.
  // Returns { change: { mode?, cap? } } with at least one field, or { error }.
  function parseChange(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!source) return { error: '需要 mode（auto 或 off）、cap（1–10）或 boost（on 或 off）。' };
    const extra = Object.keys(source).find((key) => !['mode', 'cap', 'boost', 'boostMinutes'].includes(key));
    if (extra) return { error: `不认识的项：${extra}。只能改 mode、cap 和 boost。` };
    const change = {};
    if (source.boost !== undefined) {
      if (typeof source.boost !== 'boolean') return { error: 'boost 只能是 on 或 off。' };
      change.boost = source.boost;
    }
    if (source.boostMinutes !== undefined) {
      const m = source.boostMinutes;
      if (source.boost !== true) return { error: '到期时间只能和 boost on 一起设。' };
      if (!Number.isInteger(m) || m < 1 || m > BOOST_MAX_MINUTES) return { error: `拉满的时长要是 1–${BOOST_MAX_MINUTES} 分钟。` };
      change.boostMinutes = m;
    }
    if (source.mode !== undefined) {
      if (source.mode !== 'auto' && source.mode !== 'off') return { error: 'mode 只能是 auto（自动）或 off（不限制）。' };
      change.mode = source.mode;
    }
    if (source.cap !== undefined) {
      const raw = source.cap;
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,3}$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < CAP_MIN || n > CAP_MAX) return { error: `cap 要是 ${CAP_MIN}–${CAP_MAX} 的整数。` };
      change.cap = n;
    }
    if (!Object.keys(change).length) return { error: '需要 mode（auto 或 off）、cap（1–10）或 boost（on 或 off）。' };
    return { change };
  }

  // Everything a remote screen needs about the setting, one plain object (JSON-safe).
  function readout(prefs, baseCap, working) {
    const mode = normalizeMode(prefs?.mode), cap = normalizeCap(prefs?.cap);
    const onBattery = prefs?.onBattery === true;
    const base = Number.isInteger(baseCap) && baseCap > 0 ? baseCap : 30;
    const active = isActive(mode, onBattery);
    const boost = active && prefs?.boost === true;
    const live = effectiveCap(base, { mode, cap, onBattery, boost });
    return {
      mode, cap, capMin: CAP_MIN, capMax: CAP_MAX, onBattery, active,
      boost, boostUntil: boost && Number.isFinite(prefs.boostUntil) && prefs.boostUntil > 0 ? prefs.boostUntil : null,
      baseCap: base, effectiveCap: live.cap, limited: live.limited,
      ...(Number.isInteger(working) && working >= 0 ? { working } : {}),
    };
  }

  // The read-only view for the Captain's `settings battery`: what is set, what the power is, what applies now.
  function settingsText(view) {
    const lines = [
      `电池模式：${view.mode === 'off' ? '关（不限制）' : '自动（没插电时省电）'}`,
      `电池并发上限：${view.cap}（可设 ${view.capMin}–${view.capMax}${view.mode === 'off' ? '，现在不生效' : ''}）`,
      `现在供电：${view.onBattery ? '电池' : '接电源'}`,
      view.active
        ? `现在生效：电池供电，同时最多开 ${view.effectiveCap} 个会话（设置上限 ${view.baseCap}）${view.boost ? '，已临时拉满' : '；超出的新会话排队'}`
        : `现在生效：不限制，同时最多开 ${view.effectiveCap} 个会话`,
    ];
    if (view.boost) lines.push(`临时拉满：开（${boostUntilText(view.boostUntil)}），不受电池上限限制；settings battery --boost off 取消`);
    else if (view.active) lines.push('临时拉满：关（用户要拉满强度时 settings battery --boost on [--for 2h | --until 23:59]）');
    if (view.working !== undefined) lines.push(`现在 ${view.working} 个在干活`);
    return lines.join('\n');
  }

  // The live state of this page: power source + settings, with change listeners.
  function create() {
    const s = { onBattery: false, mode: MODE_DEFAULT, cap: CAP_DEFAULT, boost: false, boostUntil: 0 };
    const listeners = new Set();
    const snapshot = () => ({ onBattery: s.onBattery, mode: s.mode, cap: s.cap, active: isActive(s.mode, s.onBattery), boost: s.boost, boostUntil: s.boostUntil });
    return {
      snapshot,
      active: () => isActive(s.mode, s.onBattery),
      set(next = {}) {
        const before = JSON.stringify(snapshot());
        if ('onBattery' in next) s.onBattery = next.onBattery === true;
        if ('mode' in next) s.mode = normalizeMode(next.mode);
        if ('cap' in next) s.cap = normalizeCap(next.cap);
        if ('boost' in next) s.boost = next.boost === true;
        if ('boostUntil' in next) s.boostUntil = Number.isFinite(next.boostUntil) && next.boostUntil > 0 ? next.boostUntil : 0;
        // 临时拉满 only makes sense while battery mode is limiting: plugging in, or 不限制, ends it.
        if (!isActive(s.mode, s.onBattery) || !s.boost) { s.boost = false; s.boostUntil = 0; }
        if (JSON.stringify(snapshot()) === before) return false;
        for (const fn of [...listeners]) { try { fn(snapshot()); } catch (_) { /* a listener must not stop the others */ } }
        return true;
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // True when a boost ran out of time just now (and is off).
      expireBoost(now = Date.now()) {
        if (!s.boost || !(s.boostUntil > 0) || now < s.boostUntil) return false;
        return this.set({ boost: false });
      },
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
    MODE_DEFAULT, CAP_DEFAULT, CAP_MIN, CAP_MAX, BOOST_MAX_MINUTES, POLL, TASK_NOTE,
    normalizeMode, normalizeCap, isActive, effectiveCap, pollMs, withTaskNote, queueReason, describe, statusLine, parseChange, readout, settingsText, boostUntilText, boostLive, create,
    shared: create(),
  };
});
