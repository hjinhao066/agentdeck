// Sleep / network resume: a session whose turn was cut short by the computer
// sleeping or the network dropping is not "finished without a receipt". It is
// nudged to carry on once the machine is awake and online again, a few times,
// with growing gaps, and only then reported to the Captain as an anomaly.
// No DOM and no Electron; the clock and the network flag are passed in.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SleepResume = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The error sits just above the input box, so only the last rows are read.
  // The same words higher up are an earlier turn, or text a session quoted.
  const TAIL_ROWS = 14;
  // Seen in the wild on 2026-10-07 (Claude Code and agy). Anything else that
  // a sleep cuts short is still caught by the suspend/resume events.
  const SIGNS = [
    ['sleep', /Your computer went to sleep mid-response/i],
    ['network', /Connection lost mid-response/i],
    ['network', /Can['’]t reach the API server/i],
    ['network', /There was a network issue connecting to the server/i],
    ['network', /\bwrite: broken pipe\b/i],
  ];
  const LEAD = /^[\s│┃⎿⏺●✗✕⚠!·•*]+/;
  // Only label words may come before the sentence: "API Error: ", "Error (retry 3/10): ".
  const LABEL = /^(?:[A-Za-z][A-Za-z0-9 ()/,'’_-]*[:.]\s*)*$/;

  // 'sleep' | 'network' | ''. A line counts only when the sentence starts it
  // (after the bullet and an "API Error:" style label); a quote, a code line
  // or a diff row that merely contains the words does not.
  function interruption(screen) {
    const rows = String(screen || '').split('\n').filter((line) => line.trim()).slice(-TAIL_ROWS);
    for (let i = rows.length - 1; i >= 0; i--) {
      const text = rows[i].replace(LEAD, '');
      if (!text || /^["'`#/+\-|<>(\[{]/.test(text) || text.length > 240) continue;
      for (const [kind, re] of SIGNS) {
        const at = text.search(re);
        if (at >= 0 && at <= 60 && LABEL.test(text.slice(0, at))) return kind;
      }
    }
    return '';
  }

  const SETTLE_MS = 10_000;        // the error stays on screen this long before the first nudge
  const WAKE_MS = 15_000;          // after waking, the network gets this long to come back
  const GAPS = [0, 30_000, 60_000, 120_000, 240_000]; // wait before attempt n, from the previous one
  const MAX_SCREEN = 4;            // nudges per episode when the screen shows the error
  const MAX_EVENT = 1;             // when only the sleep event suggests it
  const LIFETIME = 20;             // nudges per task, across episodes
  const EVENT_WINDOW = 10 * 60_000; // a turn that ends this soon after waking counts as cut short
  const RECOVER_MS = 60_000;       // working again this long after a nudge closes the episode
  const IMPLICIT_WAKE_GAP = 3 * 60_000; // no tick for this long also means the machine slept

  // Whether the machine is awake, and when it last woke. Fed by suspend/resume
  // events, and by a long silence between ticks in case an event is missed.
  function createClock(now) {
    const time = typeof now === 'function' ? now : () => Date.now();
    let asleep = false, wokeAt = 0, beatAt = time();
    return {
      suspend() { asleep = true; },
      resume(at) { asleep = false; wokeAt = Number.isFinite(at) ? at : time(); beatAt = time(); },
      // Ticks only run while awake, so a long silence before this one means
      // the machine slept, whether or not its events arrived (or arrived yet).
      beat() {
        const t = time();
        if (t - beatAt > IMPLICIT_WAKE_GAP) { asleep = false; wokeAt = t; }
        beatAt = t;
      },
      snapshot() { return { asleep, wokeAt }; },
    };
  }

  function online(nav) {
    return !(nav && nav.onLine === false);
  }

  // Why a turn counts as cut short: the screen says so, or the machine slept
  // while the task was working and the turn ended soon after it woke.
  function evidence(input) {
    if (interruption(input.screen)) return 'screen';
    const clock = input.clock || {};
    const slept = Number.isFinite(input.sleptAt) && input.sleptAt > 0;
    if (slept && !clock.asleep && clock.wokeAt && input.sleptAt <= clock.wokeAt && input.now - clock.wokeAt < EVENT_WINDOW) return 'event';
    return '';
  }

  // wait | send | giveup. `sr` is the task's episode record
  // { firstSeenAt, attempts, lastAt, evidence }; ctx { now, clock, online, lifetime }.
  function decide(sr, ctx) {
    const clock = ctx.clock || {};
    if (clock.asleep || ctx.online === false) return { action: 'wait', why: clock.asleep ? 'asleep' : 'offline' };
    if (clock.wokeAt && ctx.now - clock.wokeAt < WAKE_MS) return { action: 'wait', why: 'waking' };
    if (ctx.now - sr.firstSeenAt < SETTLE_MS) return { action: 'wait', why: 'settling' };
    const gap = GAPS[Math.min(sr.attempts, GAPS.length - 1)];
    if (sr.lastAt && ctx.now - sr.lastAt < gap) return { action: 'wait', why: 'gap' };
    const max = sr.evidence === 'screen' ? MAX_SCREEN : MAX_EVENT;
    if (sr.attempts >= max) return { action: 'giveup', why: 'attempts' };
    if ((ctx.lifetime || 0) >= LIFETIME) return { action: 'giveup', why: 'lifetime' };
    return { action: 'send', attempt: sr.attempts + 1 };
  }

  function message() {
    return '接着做。刚才电脑睡眠或网络中断打断了你，从停下的地方继续。如果任务其实已经做完，用 complete 提交回执。';
  }
  function failure(sr) {
    return '被睡眠或断网打断，已自动发「接着做」' + sr.attempts + ' 次，会话仍没恢复。请检查该会话。';
  }

  return {
    TAIL_ROWS, SETTLE_MS, WAKE_MS, GAPS, MAX_SCREEN, MAX_EVENT, LIFETIME, EVENT_WINDOW, RECOVER_MS, IMPLICIT_WAKE_GAP,
    interruption, createClock, online, evidence, decide, message, failure,
    // The page's one clock, fed by main-session's onPower and ticks.
    clock: createClock(),
  };
});
