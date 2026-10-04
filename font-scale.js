// One text-size step for the whole deck. Terminal glyphs, conversation
// text, and sidebar/board UI type share this percent. Panel boxes, icons,
// and borders do not. No DOM, no Electron.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FontScale = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 80;
  const MAX = 200;
  const STEP = 10;
  const DEFAULT = 100;
  const TERMINAL_BASE = 13;

  function normalize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT;
    const n = value;
    const snapped = Math.round(n / STEP) * STEP;
    return Math.min(MAX, Math.max(MIN, snapped));
  }

  function adjust(current, delta) {
    const base = normalize(current);
    if (delta === 0) return DEFAULT;
    if (delta === 1 || delta === -1) return normalize(base + delta * STEP);
    return base;
  }

  function terminalFontSize(percent) {
    return Math.max(1, Math.round(TERMINAL_BASE * normalize(percent) / 100));
  }

  // Older configs stored a terminal pixel size (default 13) and, separately,
  // a sidebar pixel size. The pixel size becomes the shared percent; the
  // sidebar size is not a second control anymore.
  function fromPixels(px) {
    if (typeof px !== 'number' || !Number.isFinite(px)) return DEFAULT;
    return normalize(Math.round((px / TERMINAL_BASE) * 100));
  }

  function resolve(saved) {
    if (saved && typeof saved.fontScale === 'number') return normalize(saved.fontScale);
    if (saved && typeof saved.fontSize === 'number') return fromPixels(saved.fontSize);
    return DEFAULT;
  }

  // Cmd/Ctrl plus, minus, and 0. The unshifted equals key is plus. Shift is
  // allowed because the main-keyboard plus is Shift+=. Alt and both modifiers
  // together are not this shortcut.
  function keyDelta(input) {
    if (!input || input.alt || input.altKey || input.isComposing) return null;
    const type = input.type;
    if (type && type !== 'keyDown' && type !== 'keydown') return null;
    const meta = !!(input.meta || input.metaKey);
    const ctrl = !!(input.control || input.ctrlKey);
    if (meta === ctrl) return null;
    const key = input.key;
    const code = input.code || '';
    if (key === '+' || key === '=' || code === 'NumpadAdd') return 1;
    if (key === '-' || key === '_' || code === 'NumpadSubtract') return -1;
    if (key === '0' || code === 'Numpad0') return 0;
    return null;
  }

  return {
    MIN, MAX, STEP, DEFAULT, TERMINAL_BASE,
    normalize, adjust, terminalFontSize, fromPixels, resolve, keyDelta,
  };
});
