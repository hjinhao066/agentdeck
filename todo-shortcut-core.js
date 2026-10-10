// The 速记待办 shortcut: pure helpers shared by the page and the unit tests.
// No DOM, no Electron.
//
// A shortcut is stored as a string such as "Mod+Shift+N". "Mod" is ⌘ on a Mac
// and Ctrl on Windows; the key is a letter or a digit read from KeyboardEvent.code,
// so it does not change with the keyboard layout, Shift or an input method.
// It is a window shortcut (handled in the page), never a system-wide one: another
// program that registered the same keys system-wide gets them first (Topit takes ⌘T).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TodoShortcutCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT = 'Mod+Shift+N';
  const SHAPE = /^Mod(\+Shift)?(\+Alt)?\+([A-Z0-9])$/;

  // AgentDeck's own Mod shortcuts and the editing/system ones every app keeps.
  // Keys are "<Shift?><Alt?><key>"; only letters and digits can be recorded.
  const MAC_TAKEN = {
    N: '新对话', W: '关闭当前列', F: '搜索', B: '广播输入', J: '跳到等你回复的列', K: '搜索全部对话',
    1: '跳到第 N 列', 2: '跳到第 N 列', 3: '跳到第 N 列', 4: '跳到第 N 列', 5: '跳到第 N 列',
    6: '跳到第 N 列', 7: '跳到第 N 列', 8: '跳到第 N 列', 9: '跳到第 N 列', 0: '字号复位',
    C: '复制', V: '粘贴', X: '剪切', A: '全选', Z: '撤销', Q: '退出 AgentDeck', H: '隐藏窗口', M: '最小化窗口',
    'Shift+B': '任务看板', 'Shift+R': '重新载入界面', 'Shift+Z': '重做',
    'Shift+3': '系统截屏', 'Shift+4': '系统截屏', 'Shift+5': '系统截屏',
  };
  // On Windows a plain Ctrl+letter belongs to the terminal (Ctrl+C stops a
  // program, Ctrl+R searches history…), so a shortcut needs Shift or Alt too.
  // AgentDeck's own Ctrl+Shift letters (app-shortcuts-core.js) are taken as well.
  const WIN_TAKEN = {
    'Shift+C': '终端复制', 'Shift+V': '终端粘贴',
    'Shift+T': '新对话', 'Shift+W': '关闭当前列', 'Shift+F': '列内搜索', 'Shift+B': '广播输入',
    'Shift+M': '队伍', 'Shift+J': '跳到等你回复的列', 'Shift+R': '重新载入界面', 'Shift+K': '搜索全部对话',
    'Alt+F': '列内搜索',
  };

  function normalize(value) { return typeof value === 'string' && SHAPE.test(value) ? value : DEFAULT; }
  function parts(combo) {
    const m = SHAPE.exec(normalize(combo));
    return { shift: !!m[1], alt: !!m[2], key: m[3] };
  }
  function keyOf(code) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(String(code || ''));
    return m ? (m[1] || m[2]) : null;
  }
  // The combo a keydown spells, ignoring whether it is allowed; null when the
  // event has no Mod key or no letter/digit (a lone modifier, an arrow…).
  function fromEvent(e, mac) {
    if (!e) return null;
    const mod = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    const key = keyOf(e.code);
    if (!mod || !key) return null;
    return 'Mod' + (e.shiftKey ? '+Shift' : '') + (e.altKey ? '+Alt' : '') + '+' + key;
  }
  function matches(e, combo, mac) {
    return !!e && e.type === 'keydown' && !e.repeat && fromEvent(e, mac) === normalize(combo);
  }
  // Why a combo cannot be the shortcut, in words for the settings row; '' when it can.
  function problem(combo, mac) {
    if (typeof combo !== 'string' || !SHAPE.test(combo)) return mac ? '要按住 ⌘，再加一个字母或数字。' : '要按住 Ctrl，再加一个字母或数字。';
    const p = parts(combo);
    const name = (p.shift ? 'Shift+' : '') + (p.alt ? 'Alt+' : '') + p.key;
    if (!mac && !p.shift && !p.alt) return '终端要用 Ctrl 加字母，请再加上 Shift 或 Alt。';
    const taken = (mac ? MAC_TAKEN : WIN_TAKEN)[name];
    return taken ? `${label(combo, mac)} 已经是「${taken}」，换一个。` : '';
  }
  function label(combo, mac) {
    const p = parts(combo);
    if (mac) return '⌘' + (p.shift ? '⇧' : '') + (p.alt ? '⌥' : '') + p.key;
    return 'Ctrl+' + (p.shift ? 'Shift+' : '') + (p.alt ? 'Alt+' : '') + p.key;
  }

  return { DEFAULT, normalize, fromEvent, matches, problem, label };
});
