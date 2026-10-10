// The check mark a copy button shows once the text is on the clipboard. The write is
// asynchronous, and a list redraws while it runs (an AI status change, a refresh), so the
// button that was clicked can be gone by the time the write is done. The mark is therefore
// kept as state, not on the clicked node: `done(key)` puts it on whatever button carries the
// key now, and a button built afterwards for the same key (`adopt`) picks it up for the rest
// of its time. Pure logic shared by the pages and the unit tests; timers are injected.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CopyMark = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHOW_MS = 1200;

  // options: find(key) -> the buttons carrying the key now (array or iterable); show(node);
  // hide(node); now / setTimer / clearTimer for tests.
  function create(options) {
    const o = options || {};
    const find = o.find || (() => []);
    const show = o.show || (() => {});
    const hide = o.hide || (() => {});
    const now = o.now || (() => Date.now());
    const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    const showMs = o.showMs > 0 ? o.showMs : SHOW_MS;
    const until = new Map(); // key -> when the mark ends

    const place = (key, node, ms) => {
      show(node);
      clearTimer(node.checkTimer);
      node.checkTimer = setTimer(() => {
        node.checkTimer = null;
        // A newer copy of the same key moved the end; its own timer will hide the node.
        // (A timer can fire a few ms early, hence the margin.)
        if ((until.get(key) || 0) - now() < 50) hide(node);
      }, ms);
    };

    return {
      // The text is on the clipboard: mark every button that carries the key.
      done(key) {
        const t = now();
        for (const [k, end] of until) if (end <= t) until.delete(k);
        until.set(key, t + showMs);
        for (const node of Array.from(find(key) || [])) place(key, node, showMs);
      },
      // A button was just built for the key: show the mark if it is still on.
      adopt(key, node) {
        const left = (until.get(key) || 0) - now();
        if (left > 0) place(key, node, left);
        return node;
      },
      marked(key) { return (until.get(key) || 0) > now(); },
    };
  }

  return { create, SHOW_MS };
});
