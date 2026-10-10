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
//   5. that delivers nothing either: tell the user (onFail), so it is never silent. The hint
//      says what is on the clipboard when it is not text (files, rich content): that is not
//      "held by another program" and retrying will not help.
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
  // Chromium's paste is asked for, and its paste event may still come after we gave up
  // waiting for it; that late one is swallowed for this long so a failure hint and a late
  // paste never both happen (the user pressing again would paste twice).
  const NATIVE_WAIT_MS = 300;
  const NATIVE_GRACE_MS = 1500;
  // A paste chord (Shift+Insert, Ctrl+Shift+V, Cmd+V) is answered by its paste event within this long.
  const ALLOW_MS = 500;

  // Plain Ctrl+V: not Cmd (a Mac pastes with Cmd+V natively, untouched) and not Shift/Alt
  // (Ctrl+Shift+V and other bindings keep their behavior). Windows, Linux and a Mac's Ctrl+V
  // all take the same path.
  function isCtrlV(e) {
    return !!e && e.type === 'keydown' && !!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
      (e.key === 'v' || e.key === 'V' || e.code === 'KeyV');
  }

  // The keys with which a person (or a program simulating one, Type4Me's Shift+Insert) asks for a
  // paste other than the plain Ctrl+V: Shift+Insert, Ctrl+Shift+V, Cmd+V. A further modifier held
  // by the user (Type4Me's own hotkey may still be down) does not stop them counting. There is no
  // right-click paste in a terminal column, so the mouse is never a paste chord.
  // Only these let ONE paste through while the late-paste guard is up (see createNativePaste);
  // a left click or an ordinary key does not, because Chromium's late paste can still arrive
  // after one and pressing Ctrl+V again as the hint says would then paste twice.
  function isPasteChord(e) {
    if (!e || e.type !== 'keydown') return false;
    if (e.key === 'Insert' || e.code === 'Insert') return !!e.shiftKey; // Shift+Insert
    if (!(e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) return false;
    return !!e.metaKey || (!!e.ctrlKey && !!e.shiftKey);                // Cmd+V, Ctrl+Shift+V
  }

  // The hint under a failed Ctrl+V. `kind` is what the clipboard holds: 'other' (files or
  // anything that is not text or a picture) or 'none' / unknown.
  function failureHint(kind) {
    return kind === 'other'
      ? '粘贴不了：剪贴板里不是文字也不是截图（可能是复制的文件），终端只能粘贴文字和截图'
      : '粘贴失败：剪贴板里没读到文字（可能被别的程序占用，也可能复制的不是文字），请再按一次 Ctrl+V';
  }

  // The toast when a paste event carried a picture but the main process could not read one off the
  // clipboard. `kind` is what the clipboard holds ('other': files, an image file copied in the file
  // manager among them): retrying will not help there, so it says so; `where` names the box.
  function pictureFailureHint(kind, where) {
    return kind === 'other'
      ? `粘贴不了：剪贴板里是文件，${where || '这里'}只能粘贴文字和截图`
      : '剪贴板里的截图没读出来，请再粘贴一次';
  }

  // Chromium's own paste, asked of the main process, arrives as a paste event with the text.
  // options: listen(fn) -> stop; subscribes to paste events seen in the capture phase that carry
  // text, fn(text) returns true when it took the event (the page then stops it, so xterm does
  // not paste it a second time); request() -> Promise<boolean> (true: Chromium ran);
  // setTimer / clearTimer. The result is the text it delivered, '' for none.
  // The function it returns has .userInput(event): the page calls it for every key in the column.
  // A paste chord (isPasteChord: Shift+Insert, Ctrl+Shift+V, Cmd+V) lets the next paste event
  // through for ALLOW_MS while the late-paste guard stays up; the guard goes on swallowing
  // everything else, so Chromium's late paste is still dropped and a Ctrl+V pressed again as the
  // hint says pastes once. A mouse press or an ordinary key changes nothing.
  function createNativePaste(options) {
    const o = options || {};
    const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    const waitMs = o.waitMs > 0 ? o.waitMs : NATIVE_WAIT_MS;
    const graceMs = o.graceMs >= 0 ? o.graceMs : NATIVE_GRACE_MS;
    const now = o.now || (() => Date.now());
    const guards = new Set(); // late-paste guards still up
    let allowUntil = -1;      // a paste chord was pressed: the next paste event is the user's own
    const lift = () => { allowUntil = -1; for (const g of [...guards]) g.stop(); };
    const nativePaste = function nativePaste() {
      // A new request takes over from the guards of the one before: its own paste event must
      // reach it, not be swallowed as that earlier one's late arrival.
      lift();
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        let stop = () => {};
        const finish = (text, late) => {
          if (done) return;
          done = true;
          clearTimer(timer);
          stop();
          // Gave up waiting but Chromium may still deliver: take that paste and drop it.
          if (late && graceMs > 0) {
            const stopListening = o.listen(() => {
              if (now() <= allowUntil) { allowUntil = -1; return false; } // the user's own paste: one
              return true;
            });
            const guard = { timer: null, stop() { guards.delete(guard); clearTimer(guard.timer); try { stopListening(); } catch (_) {} } };
            guard.timer = setTimer(() => guard.stop(), graceMs);
            guards.add(guard);
          }
          resolve(text);
        };
        stop = o.listen((text) => {
          if (done || !text) return false;
          finish(text, false);
          return true;
        });
        timer = setTimer(() => finish('', true), waitMs);
        let asked;
        try { asked = Promise.resolve(o.request()); } catch (_) { asked = Promise.reject(); }
        asked.then((ran) => { if (!ran) finish('', false); }, () => finish('', false));
      });
    };
    nativePaste.userInput = (e) => {
      if (!guards.size || !isPasteChord(e)) return;
      allowUntil = now() + ALLOW_MS;
    };
    return nativePaste;
  }

  // readText() -> string | Promise<string>; readImage() -> Promise<boolean> (true: a path was
  // typed); pasteNative() -> Promise<string> (the text Chromium's own paste delivered, '' for none);
  // pasteText(text); readKind() -> Promise<'image' | 'other' | 'none'> (what a failed paste found on
  // the clipboard); onFail(kind); sendHeld(data) sends one key that waited; passes(data) -> true
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
    const readKind = o.readKind || (async () => 'none');
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
      try { run(); } catch (_) { outcome = 'failed'; } finally {
        // A throwing paste or hint never loses a key: each waits no longer than this.
        const keys = waiting; waiting = [];
        for (const d of keys) { try { sendHeld(d); } catch (_) {} }
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
      const found = await attemptOf(readKind);
      if (gen !== generation) return 'cancelled';
      return finish('failed', () => onFail(found === 'other' ? 'other' : 'none'));
    }

    return {
      // The Ctrl+V key. Resolves with how it ended: 'text', 'image' (a screenshot's path was
      // typed), 'native' (Chromium's paste delivered it), 'failed' (nothing could be pasted; the
      // user was told), 'ignored' (a press was already running) or 'cancelled'.
      // It never rejects: anything that goes wrong ends as 'failed' with the held keys released.
      press() {
        if (pending) return Promise.resolve('ignored');
        pending = true;
        const gen = ++generation;
        return run(gen).catch(() => {
          if (gen !== generation || !pending) return 'failed';
          return finish('failed', noop);
        });
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

  return { create, createNativePaste, isCtrlV, isPasteChord, failureHint, pictureFailureHint, INTERVAL_MS, WINDOW_MS, NATIVE_WAIT_MS, NATIVE_GRACE_MS, ALLOW_MS };
});
