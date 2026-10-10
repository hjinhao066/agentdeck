// AgentDeck's own window shortcuts: which keydown means which action, and how
// each one is written for the user. Pure helpers shared by the page and the
// unit tests. No DOM, no Electron.
//
// A Mac keeps ⌘ plus a key. On Windows (and Linux) the ⌘ key is the Windows key,
// which the system takes for itself (Win+N, Win+1…), and a plain Ctrl+letter
// belongs to the terminal (Ctrl+C stops a program, Ctrl+R searches history,
// Ctrl+W deletes a word). So there the letters take Ctrl+Shift, as 速记待办 does,
// and moving between columns takes Alt: Ctrl+Shift+←/→ selects a word in
// PowerShell, and Ctrl+Shift+1 is three keys for something pressed all day.
// Alt+←/→ moves between panes in Windows Terminal too; Alt+1…9 switches tabs in
// GNOME Terminal and Konsole.
//
// Keys that 速记待办 must not take on Windows are listed in todo-shortcut-core.js
// (WIN_TAKEN); a unit test keeps the two lists in step.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppShortcutsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // win: the KeyboardEvent.code pressed with Ctrl+Shift; winAlt: pressed with Alt.
  // Reading the physical key keeps Shift (Ctrl+Shift+/ is "?") and the keyboard
  // layout from changing the shortcut.
  const ACTIONS = {
    newColumn:   { mac: '⌘N', win: 'KeyT', name: '新对话' },
    closeColumn: { mac: '⌘W', win: 'KeyW', name: '关闭当前列' },
    search:      { mac: '⌘F', win: 'KeyF', name: '列内搜索' },
    broadcast:   { mac: '⌘B', win: 'KeyB', name: '广播输入' },
    crewMap:     { mac: '⌘⇧B', win: 'KeyM', name: '终端架构图' },
    help:        { mac: '⌘/', win: 'Slash', name: '快捷键说明' },
    zoom:        { mac: '⌘⏎', win: 'Enter', name: '放大 / 还原当前列' },
    jumpWaiting: { mac: '⌘J', win: 'KeyJ', name: '跳到等你回复的列' },
    reload:      { mac: '⌘⇧R', win: 'KeyR', name: '重新载入界面' },
    searchAll:   { mac: '⌘K', win: 'KeyK', name: '搜索全部对话' },
    sidePane:    { mac: '⌘\\', win: 'Backslash', name: '右侧栏' },
    column:      { mac: '⌘1…9', winAlt: 'Digit', name: '跳到第 N 列' },
    prevColumn:  { mac: '⌘←', winAlt: 'ArrowLeft', name: '聚焦左边一列' },
    nextColumn:  { mac: '⌘→', winAlt: 'ArrowRight', name: '聚焦右边一列' },
  };
  const WIN_KEY_NAMES = { Slash: '/', Backslash: '\\', Enter: 'Enter', ArrowLeft: '←', ArrowRight: '→', Digit: '1…9' };

  function lower(k) { return typeof k === 'string' ? k.toLowerCase() : ''; }

  // Mac: exactly the ⌘ keys AgentDeck has always had. ⇧ only changes B and R;
  // K and \ need ⌘ alone.
  function macAction(e) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    const k = lower(e.key);
    if (k === 'n') return { action: 'newColumn' };
    if (k === 'w') return { action: 'closeColumn' };
    if (k === 'f') return { action: 'search' };
    if (k === 'b') return { action: e.shiftKey ? 'crewMap' : 'broadcast' };
    if (e.key === '/') return { action: 'help' };
    if (e.key === 'Enter') return { action: 'zoom' };
    if (k === 'j') return { action: 'jumpWaiting' };
    if (k === 'r' && e.shiftKey) return { action: 'reload' };
    if (k === 'k' && !e.shiftKey) return { action: 'searchAll' };
    if (e.key === '\\' && !e.shiftKey) return { action: 'sidePane' };
    if (/^[1-9]$/.test(e.key)) return { action: 'column', index: Number(e.key) - 1 };
    if (e.key === 'ArrowLeft') return { action: 'prevColumn' };
    if (e.key === 'ArrowRight') return { action: 'nextColumn' };
    return null;
  }

  // The physical key; a synthetic event without a code falls back to its key.
  function codeOf(e) {
    if (e.code) return e.code === 'NumpadEnter' ? 'Enter' : e.code;
    const k = e.key;
    if (typeof k !== 'string') return '';
    if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
    if (/^[0-9]$/.test(k)) return 'Digit' + k;
    return { '/': 'Slash', '?': 'Slash', '\\': 'Backslash', '|': 'Backslash' }[k] || k;
  }

  function winAction(e) {
    if (e.metaKey) return null;
    const code = codeOf(e);
    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      for (const [action, a] of Object.entries(ACTIONS)) if (a.win === code) return { action };
      return null;
    }
    // Alt alone: Ctrl+Alt is AltGr on many European layouts (AltGr+7 types {),
    // and the number pad is left alone, where Alt+digits types a character code.
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const digit = /^Digit([1-9])$/.exec(code);
      if (digit) return { action: 'column', index: Number(digit[1]) - 1 };
      if (code === 'ArrowLeft') return { action: 'prevColumn' };
      if (code === 'ArrowRight') return { action: 'nextColumn' };
    }
    return null;
  }

  // The keydown written the aria-keyshortcuts way: "Alt+ArrowLeft", "Control+Shift+T".
  function ariaCombo(e) {
    const key = /^[a-z]$/i.test(e.key || '') ? e.key.toUpperCase() : e.key;
    return [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+');
  }
  // A focused control that lists the key in its aria-keyshortcuts keeps it: on
  // Windows a 任务看板 card moves to the next lane with Alt+→ rather than the
  // deck moving to the next column.
  function ownedByTarget(e) {
    const t = e.target;
    const list = t && typeof t.getAttribute === 'function' ? t.getAttribute('aria-keyshortcuts') : '';
    return !!list && list.split(/\s+/).includes(ariaCombo(e));
  }

  // { action, index? } for a keydown that is one of AgentDeck's shortcuts, else null.
  function match(e, mac) {
    if (!e || (e.type && e.type !== 'keydown') || ownedByTarget(e)) return null;
    return mac ? macAction(e) : winAction(e);
  }

  // How the shortcut is written in tooltips and the help page: ⌘N on a Mac,
  // Ctrl+Shift+T on Windows.
  function label(action, mac) {
    const a = ACTIONS[action];
    if (!a) return '';
    if (mac) return a.mac;
    if (a.winAlt) return 'Alt+' + WIN_KEY_NAMES[a.winAlt];
    return 'Ctrl+Shift+' + (WIN_KEY_NAMES[a.win] || a.win.replace(/^Key/, ''));
  }

  // The Ctrl+Shift letters AgentDeck uses on Windows, as "Shift+X" → name, for 速记待办.
  function winLetters() {
    const out = {};
    for (const a of Object.values(ACTIONS)) {
      const m = /^Key([A-Z])$/.exec(a.win || '');
      if (m) out['Shift+' + m[1]] = a.name;
    }
    return out;
  }

  // "⌘" or "Ctrl+" in front of a key both platforms share (⌘S / Ctrl+S).
  function mod(mac) { return mac ? '⌘' : 'Ctrl+'; }

  return { ACTIONS, match, label, winLetters, mod };
});
