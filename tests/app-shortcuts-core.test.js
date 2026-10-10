'use strict';
// AgentDeck's window shortcuts: ⌘ on a Mac; Ctrl+Shift+letter and Alt+1…9 /
// Alt+←→ on Windows, where ⌘ is the Windows key and Ctrl+letter is the terminal's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../app-shortcuts-core.js');
const Todo = require('../todo-shortcut-core.js');

const ev = (key, code, mods = {}) => ({ type: 'keydown', key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const action = (e, mac) => { const hit = S.match(e, mac); return hit && hit.action; };

test('a Mac keeps every ⌘ shortcut it had', () => {
  const cmd = { metaKey: true };
  assert.equal(action(ev('n', 'KeyN', cmd), true), 'newColumn');
  assert.equal(action(ev('w', 'KeyW', cmd), true), 'closeColumn');
  assert.equal(action(ev('f', 'KeyF', cmd), true), 'search');
  assert.equal(action(ev('b', 'KeyB', cmd), true), 'broadcast');
  assert.equal(action(ev('B', 'KeyB', { metaKey: true, shiftKey: true }), true), 'crewMap');
  assert.equal(action(ev('/', 'Slash', cmd), true), 'help');
  assert.equal(action(ev('Enter', 'Enter', cmd), true), 'zoom');
  assert.equal(action(ev('j', 'KeyJ', cmd), true), 'jumpWaiting');
  assert.equal(action(ev('R', 'KeyR', { metaKey: true, shiftKey: true }), true), 'reload');
  assert.equal(action(ev('r', 'KeyR', cmd), true), null);
  assert.equal(action(ev('k', 'KeyK', cmd), true), 'searchAll');
  assert.equal(action(ev('\\', 'Backslash', cmd), true), 'sidePane');
  assert.deepEqual(S.match(ev('3', 'Digit3', cmd), true), { action: 'column', index: 2 });
  assert.equal(action(ev('ArrowLeft', 'ArrowLeft', cmd), true), 'prevColumn');
  assert.equal(action(ev('ArrowRight', 'ArrowRight', cmd), true), 'nextColumn');
});

test('on a Mac, Ctrl and the Windows keys are left to the terminal', () => {
  assert.equal(S.match(ev('T', 'KeyT', { ctrlKey: true, shiftKey: true }), true), null);
  assert.equal(S.match(ev('1', 'Digit1', { altKey: true }), true), null);
  assert.equal(S.match(ev('n', 'KeyN', { ctrlKey: true }), true), null);
  assert.equal(S.match(ev('n', 'KeyN', { metaKey: true, ctrlKey: true }), true), null);
  assert.equal(S.match(ev('n', 'KeyN', { metaKey: true, altKey: true }), true), null);
});

test('Windows: Ctrl+Shift+letter reaches every action, read by physical key', () => {
  const cs = { ctrlKey: true, shiftKey: true };
  const want = {
    KeyT: 'newColumn', KeyW: 'closeColumn', KeyF: 'search', KeyB: 'broadcast', KeyM: 'crewMap', Slash: 'help',
    Enter: 'zoom', NumpadEnter: 'zoom', KeyJ: 'jumpWaiting', KeyR: 'reload', KeyK: 'searchAll', Backslash: 'sidePane',
  };
  // Shift turns the key into a capital or another symbol (Ctrl+Shift+/ is "?").
  const shifted = { Slash: '?', Backslash: '|', Enter: 'Enter', NumpadEnter: 'Enter' };
  for (const [code, name] of Object.entries(want)) {
    const key = shifted[code] || code.slice(3);
    assert.equal(action(ev(key, code, cs), false), name, code);
  }
  // A synthetic event without a code still works.
  assert.equal(action(ev('T', '', cs), false), 'newColumn');
  assert.equal(action(ev('?', '', cs), false), 'help');
});

test('Windows: Alt+1…9 and Alt+←/→ move between columns', () => {
  for (let n = 1; n <= 9; n++) assert.deepEqual(S.match(ev(String(n), 'Digit' + n, { altKey: true }), false), { action: 'column', index: n - 1 });
  assert.equal(action(ev('ArrowLeft', 'ArrowLeft', { altKey: true }), false), 'prevColumn');
  assert.equal(action(ev('ArrowRight', 'ArrowRight', { altKey: true }), false), 'nextColumn');
  // Alt+0, the number pad (Alt codes) and AltGr (Ctrl+Alt) type characters instead.
  assert.equal(S.match(ev('0', 'Digit0', { altKey: true }), false), null);
  assert.equal(S.match(ev('1', 'Numpad1', { altKey: true }), false), null);
  assert.equal(S.match(ev('{', 'Digit7', { altKey: true, ctrlKey: true }), false), null);
});

test('Windows leaves the terminal its keys', () => {
  // ⌘ is the Windows key there.
  for (const [key, code] of [['n', 'KeyN'], ['w', 'KeyW'], ['1', 'Digit1'], ['ArrowLeft', 'ArrowLeft'], ['k', 'KeyK']]) {
    assert.equal(S.match(ev(key, code, { metaKey: true }), false), null, code);
  }
  // Plain Ctrl+letter: ^C, ^W, ^R, ^T, ^K… go to the program in the column.
  for (const k of 'TWFBMJRKNCV') assert.equal(S.match(ev(k.toLowerCase(), 'Key' + k, { ctrlKey: true }), false), null, k);
  // Terminal copy / paste, Claude Code's undo (Ctrl+Shift+-) and PowerShell's
  // select-word (Ctrl+Shift+←/→) and jump-word (Ctrl+←/→) are not ours.
  for (const code of ['KeyC', 'KeyV', 'KeyN', 'Minus', 'ArrowLeft', 'ArrowRight', 'Digit1']) {
    assert.equal(S.match(ev('x', code, { ctrlKey: true, shiftKey: true }), false), null, code);
  }
  assert.equal(S.match(ev('ArrowLeft', 'ArrowLeft', { ctrlKey: true }), false), null);
  // Alt letters stay with Claude Code (Alt+P model, Alt+T thinking, Alt+V image).
  for (const k of 'PTVOM') assert.equal(S.match(ev(k.toLowerCase(), 'Key' + k, { altKey: true }), false), null, k);
  // Ctrl+Shift+Alt is something else, and a keyup is never a shortcut.
  assert.equal(S.match(ev('T', 'KeyT', { ctrlKey: true, shiftKey: true, altKey: true }), false), null);
  assert.equal(S.match({ ...ev('T', 'KeyT', { ctrlKey: true, shiftKey: true }), type: 'keyup' }, false), null);
});

test('a focused control that declares the key keeps it (任务看板 cards move with Alt+←/→)', () => {
  const card = { getAttribute: (name) => (name === 'aria-keyshortcuts' ? 'Enter Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : null) };
  const alt = (key) => ({ ...ev(key, key, { altKey: true }), target: card });
  assert.equal(S.match(alt('ArrowRight'), false), null);
  assert.equal(S.match(alt('ArrowLeft'), false), null);
  // Keys the card does not list still work from it.
  assert.deepEqual(S.match({ ...ev('2', 'Digit2', { altKey: true }), target: card }, false), { action: 'column', index: 1 });
  assert.equal(action({ ...ev('T', 'KeyT', { ctrlKey: true, shiftKey: true }), target: card }, false), 'newColumn');
  // On a Mac the card's Alt keys never were ⌘ keys.
  assert.equal(action({ ...ev('ArrowRight', 'ArrowRight', { metaKey: true }), target: card }, true), 'nextColumn');
  // Elsewhere Alt+→ moves the deck.
  assert.equal(action({ ...ev('ArrowRight', 'ArrowRight', { altKey: true }), target: { getAttribute: () => null } }, false), 'nextColumn');
});

test('Windows: search also answers to Ctrl+Alt+F, since Microsoft Pinyin takes Ctrl+Shift+F', () => {
  const ca = { ctrlKey: true, altKey: true };
  assert.equal(action(ev('f', 'KeyF', ca), false), 'search');
  assert.equal(action(ev('F', 'KeyF', ca), false), 'search'); // Caps Lock
  assert.equal(action(ev('F', 'KeyF', { ctrlKey: true, shiftKey: true }), false), 'search');
  // AltGr is Ctrl+Alt: when the key types a character (AltGr+F is [ in Hungarian), it is typing.
  assert.equal(S.match(ev('[', 'KeyF', ca), false), null);
  // No other Ctrl+Alt key is ours (Windows Terminal switches tabs with Ctrl+Alt+1…9),
  // nor Ctrl+Alt+Shift+F, nor F3 (PowerShell's CharacterSearch).
  for (const [key, code] of [['t', 'KeyT'], ['1', 'Digit1'], ['ArrowLeft', 'ArrowLeft'], ['k', 'KeyK']]) {
    assert.equal(S.match(ev(key, code, ca), false), null, code);
  }
  assert.equal(S.match(ev('F', 'KeyF', { ctrlKey: true, altKey: true, shiftKey: true }), false), null);
  assert.equal(S.match(ev('F3', 'F3'), false), null);
  // A Mac keeps ⌘F only.
  assert.equal(S.match(ev('f', 'KeyF', ca), true), null);
  // 速记待办 cannot take it either.
  assert.match(Todo.problem('Mod+Alt+F', false), /列内搜索/);
  assert.equal(Todo.problem('Mod+Alt+F', true), '');
});

test('letting Alt go first after Alt+1 does not hand the keyboard to the menu bar', () => {
  const G = S.altReleaseGuard();
  const down = (key, mods = {}) => G.keydown({ type: 'keydown', key, altKey: false, ctrlKey: false, repeat: false, ...mods });
  const up = (key) => G.keyup({ type: 'keyup', key });
  // Alt+1 with Alt released first (the review's case D), and with the digit released first.
  down('Alt', { altKey: true }); down('1', { altKey: true });
  assert.equal(up('Alt'), true);
  assert.equal(up('1'), false);
  down('Alt', { altKey: true }); down('1', { altKey: true }); up('1');
  assert.equal(up('Alt'), true);
  // Ctrl+Alt+F, and a held Alt that repeats before the arrow.
  down('Control', { ctrlKey: true }); down('Alt', { altKey: true, ctrlKey: true }); down('f', { altKey: true, ctrlKey: true });
  assert.equal(up('Alt'), true);
  down('Alt', { altKey: true }); down('Alt', { altKey: true, repeat: true }); down('ArrowRight', { altKey: true });
  assert.equal(up('Alt'), true);
  // Alt alone still opens the menu bar, also right after a chord.
  down('Alt', { altKey: true });
  assert.equal(up('Alt'), false);
  // AltGr typing is not Alt: its release is never cancelled.
  down('Control', { ctrlKey: true }); down('AltGraph', { altKey: true, ctrlKey: true }); down('{', { altKey: true, ctrlKey: true });
  assert.equal(up('AltGraph'), false);
  // A chord interrupted by leaving the window (Alt+Tab) does not carry over.
  down('Alt', { altKey: true }); down('Tab', { altKey: true }); G.reset();
  assert.equal(up('Alt'), false);
});

test('the guard cancels the Alt release in the page, through real listeners', () => {
  const listeners = {};
  const win = { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  S.installAltReleaseGuard(win);
  const fire = (type, init) => { const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, altKey: false, ctrlKey: false, repeat: false, ...init }; listeners[type].forEach((fn) => fn(e)); return e; };
  fire('keydown', { key: 'Alt', altKey: true });
  fire('keydown', { key: '1', altKey: true });
  assert.equal(fire('keyup', { key: 'Alt' }).defaultPrevented, true);
  fire('keydown', { key: 'Alt', altKey: true });
  assert.equal(fire('keyup', { key: 'Alt' }).defaultPrevented, false);
  assert.equal(typeof listeners.blur[0], 'function');
});

test('labels follow the platform: ⌘N on a Mac, Ctrl+Shift+T on Windows', () => {
  const win = {
    newColumn: 'Ctrl+Shift+T', closeColumn: 'Ctrl+Shift+W', search: 'Ctrl+Shift+F 或 Ctrl+Alt+F', broadcast: 'Ctrl+Shift+B',
    crewMap: 'Ctrl+Shift+M', help: 'Ctrl+Shift+/', zoom: 'Ctrl+Shift+Enter', jumpWaiting: 'Ctrl+Shift+J',
    reload: 'Ctrl+Shift+R', searchAll: 'Ctrl+Shift+K', sidePane: 'Ctrl+Shift+\\',
    column: 'Alt+1…9', prevColumn: 'Alt+←', nextColumn: 'Alt+→',
  };
  for (const [name, text] of Object.entries(win)) {
    assert.equal(S.label(name, false), text, name);
    assert.match(S.label(name, true), /^⌘/, name);
    assert.doesNotMatch(S.label(name, false), /⌘|⇧|⌥/, name);
  }
  assert.equal(S.label('newColumn', true), '⌘N');
  assert.equal(S.label('crewMap', true), '⌘⇧B');
  assert.equal(S.label('nope', false), '');
  assert.equal(S.mod(true) + 'S', '⌘S');
  assert.equal(S.mod(false) + 'S', 'Ctrl+S');
});

test('速记待办 cannot take a key AgentDeck uses on Windows, and its default is free', () => {
  for (const [combo, name] of Object.entries(S.winLetters())) {
    assert.match(Todo.problem('Mod+' + combo, false), new RegExp(name), combo);
  }
  const quick = Todo.fromEvent(ev('N', 'KeyN', { ctrlKey: true, shiftKey: true }), false);
  assert.equal(quick, Todo.DEFAULT);
  assert.equal(S.match(ev('N', 'KeyN', { ctrlKey: true, shiftKey: true }), false), null);
});

test('the help page labels every shortcut it shows on Windows', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<script src="app-shortcuts-core\.js"><\/script>/);
  const help = html.slice(html.indexOf('id="helpDialog"'), html.indexOf('id="helpClose"'));
  assert.ok(help.length > 1000, 'found the help dialog');
  // Every ⌘ in the help text is relabeled for Windows: by action, with data-win, or
  // (速记待办, which can be changed) by todo-ui.js.
  const kbds = help.match(/<kbd[^>]*>[^<]*⌘[^<]*<\/kbd>/g);
  assert.ok(kbds.length >= 15);
  for (const k of kbds) assert.match(k, /data-shortcut="[a-zA-Z]+"|data-win="[^"]+"|id="helpTodoKey"/, k);
  for (const [, name] of help.matchAll(/data-shortcut="([a-zA-Z]+)"/g)) assert.ok(S.ACTIONS[name], name);
  for (const name of Object.keys(S.ACTIONS)) assert.ok(help.includes(`data-shortcut="${name}"`), `help shows ${name}`);
});
