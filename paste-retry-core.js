// Ctrl+V in a terminal column: read the clipboard, and when it reads empty try
// again for a moment before giving up. Pure logic shared by the page and the
// unit tests; no DOM, no Electron, timers are injected.
//
// Why: the clipboard can be held by another program for a few milliseconds after
// it changes (Windows clipboard history, Ditto and PixPin all read it the moment
// it changes), and a read made then comes back empty. Giving up on the first empty
// read made a voice tool's automatic paste, and the user's own Ctrl+V, fail
// without a word.
//
// One press runs this ladder, one step at a time, never blocking the page:
//   1. read the text; if there is some, paste it;
//   2. text empty: ask for an image on the clipboard (screenshot -> file path);
//   3. both empty: wait INTERVAL_MS and look again, until WINDOW_MS have passed;
//   4. still nothing: let Chromium's own paste deliver the text;
//   5. that delivers nothing either: tell the user (onFail), so it is never silent.
// While a press is running, a second Ctrl+V does nothing (no double paste) and
// every other key the terminal produces is held in order and sent right after the
// outcome, so a key typed meanwhile never lands in front of the paste.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PasteRetryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERVAL_MS = 50;
  const WINDOW_MS = 500;

  // readText() -> string | Promise<string>; readImage() -> Promise<boolean> (true: a path was
  // typed); pasteNative() -> Promise<string> (the text Chromium's own paste delivered, '' for none);
  // pasteText(text); onFail(); sendHeld(data) sends one key that waited; passes(data) -> true
  // for data that never waits (terminal replies, wheel, focus), as in the input hold.
  function create(options) {
    const o = options || {};
    const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    const interval = o.intervalMs > 0 ? o.intervalMs : INTERVAL_MS;
    const windowMs = o.windowMs > 0 ? o.windowMs : WINDOW_MS;
    const now = o.now || (() => Date.now());
    const noop = () => {};
    const readText = o.readText || (() => '');
    const readImage = o.readImage || (async () => false);
    const pasteText = o.pasteText || noop;
    const pasteNative = o.pasteNative || (async () => '');
    const onFail = o.onFail || noop;
    const sendHeld = o.sendHeld || noop;
    const passes = o.passes || (() => false);

    let pending = false; // a press is running
    let waiting = [];    // keys typed while pending, in order
    let generation = 0;  // a cancel makes a late answer stale
    let timer = null;
    let wake = null;

    // Any step may throw or reject: that counts as "nothing there", never as a broken key.
    const attemptOf = (fn) => new Promise((resolve) => {
      try { Promise.resolve(fn()).then(resolve, () => resolve(null)); } catch (_) { resolve(null); }
    });
    const pause = (ms) => new Promise((resolve) => {
      wake = resolve;
      timer = setTimer(() => { timer = null; wake = null; resolve(); }, ms);
    });

    const finish = (outcome, run) => {
      // Clear the state first: the paste itself emits input, which must not be held.
      pending = false;
      try { run(); } finally {
        const keys = waiting; waiting = [];
        for (const d of keys) sendHeld(d);
      }
      return outcome;
    };

    async function run(gen) {
      // The window is measured on the clock, not in tries: a read that fails can itself take a
      // while (Chromium keeps retrying a held clipboard before it gives up).
      const start = now();
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) {
          if (now() - start + interval > windowMs) break;
          await pause(interval);
          if (gen !== generation) return 'cancelled';
        }
        const text = await attemptOf(readText);
        if (gen !== generation) return 'cancelled';
        if (typeof text === 'string' && text) return finish('text', () => pasteText(text));
        const image = await attemptOf(readImage);
        if (gen !== generation) return 'cancelled';
        if (image === true) return finish('image', noop);
      }
      const native = await attemptOf(pasteNative);
      if (gen !== generation) return 'cancelled';
      if (typeof native === 'string' && native) return finish('native', () => pasteText(native));
      return finish('failed', onFail);
    }

    return {
      // The Ctrl+V key. Resolves with how it ended: 'text', 'image' (a screenshot's path was
      // typed), 'native' (Chromium's paste delivered it), 'failed' (nothing could be pasted; the
      // user was told), 'ignored' (a press was already running) or 'cancelled'.
      press() {
        if (pending) return Promise.resolve('ignored');
        pending = true;
        return run(++generation);
      },
      // Terminal input. true: it was kept to follow the paste, do not send it now.
      hold(data) {
        if (!pending || passes(data)) return false;
        waiting.push(data);
        return true;
      },
      // Drop a running press (the terminal is going away); held keys are released.
      cancel() {
        if (!pending) return;
        generation++;
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (wake) { const w = wake; wake = null; w(); }
        finish('cancelled', noop);
      },
      get pending() { return pending; },
    };
  }

  return { create, INTERVAL_MS, WINDOW_MS };
});
