'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../todo-shortcut-core.js');

const key = (code, mods = {}) => ({ type: 'keydown', code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, ...mods });

test('the default is ⌘⇧N on a Mac and Ctrl+Shift+N on Windows, never ⌘T (Topit takes it system-wide)', () => {
  assert.equal(C.DEFAULT, 'Mod+Shift+N');
  assert.equal(C.label(C.DEFAULT, true), '⌘⇧N');
  assert.equal(C.label(C.DEFAULT, false), 'Ctrl+Shift+N');
  assert.equal(C.label(undefined, true), '⌘⇧N');
  assert.equal(C.label('Mod+Alt+7', true), '⌘⌥7');
  assert.equal(C.label('Mod+Shift+Alt+Q', false), 'Ctrl+Shift+Alt+Q');
});

test('a saved value that is not a shortcut falls back to the default', () => {
  for (const bad of [undefined, null, '', 'Mod+T+T', 'Shift+N', 'Mod+Shift+n', 'Mod+Shift+F5', 'Mod+Alt+Shift+N', 42, {}]) {
    assert.equal(C.normalize(bad), C.DEFAULT, String(bad));
  }
  assert.equal(C.normalize('Mod+T'), 'Mod+T');
});

test('keydowns are read by physical key, so Shift, ⌥ or an input method do not change the letter', () => {
  assert.equal(C.fromEvent(key('KeyN', { metaKey: true, shiftKey: true }), true), 'Mod+Shift+N');
  assert.equal(C.fromEvent(key('KeyN', { ctrlKey: true, shiftKey: true }), false), 'Mod+Shift+N');
  assert.equal(C.fromEvent(key('Digit7', { metaKey: true, altKey: true }), true), 'Mod+Alt+7');
  // No Mod, a lone modifier or a key that is not a letter or digit spells nothing.
  assert.equal(C.fromEvent(key('KeyN', { shiftKey: true }), true), null);
  assert.equal(C.fromEvent(key('ShiftLeft', { metaKey: true, shiftKey: true }), true), null);
  assert.equal(C.fromEvent(key('ArrowLeft', { metaKey: true }), true), null);
  // Each platform has its own Mod: Ctrl on a Mac is the terminal's, ⌘ is not Ctrl on Windows.
  assert.equal(C.fromEvent(key('KeyN', { ctrlKey: true, shiftKey: true }), true), null);
  assert.equal(C.fromEvent(key('KeyN', { metaKey: true, shiftKey: true }), false), null);
  assert.equal(C.fromEvent(key('KeyN', { metaKey: true, ctrlKey: true, shiftKey: true }), true), null);
});

test('matches only the exact combo, once per press', () => {
  const ev = key('KeyN', { metaKey: true, shiftKey: true });
  assert.equal(C.matches(ev, C.DEFAULT, true), true);
  assert.equal(C.matches({ ...ev, shiftKey: false }, C.DEFAULT, true), false); // ⌘N stays 新对话
  assert.equal(C.matches({ ...ev, altKey: true }, C.DEFAULT, true), false);
  assert.equal(C.matches({ ...ev, repeat: true }, C.DEFAULT, true), false);
  assert.equal(C.matches({ ...ev, type: 'keyup' }, C.DEFAULT, true), false);
  assert.equal(C.matches(key('KeyT', { metaKey: true }), 'Mod+T', true), true);
  assert.equal(C.matches(key('KeyN', { ctrlKey: true, shiftKey: true }), C.DEFAULT, false), true);
});

test('AgentDeck\'s own keys and the usual editing keys are refused with the reason', () => {
  assert.equal(C.problem('Mod+N', true), '⌘N 已经是「新对话」，换一个。');
  assert.equal(C.problem('Mod+J', true), '⌘J 已经是「跳到等你回复的列」，换一个。');
  assert.equal(C.problem('Mod+Shift+B', true), '⌘⇧B 已经是「任务看板」，换一个。');
  assert.match(C.problem('Mod+C', true), /复制/);
  assert.match(C.problem('Mod+Shift+4', true), /截屏/);
  assert.equal(C.problem(null, true), '要按住 ⌘，再加一个字母或数字。');
  assert.equal(C.problem(null, false), '要按住 Ctrl，再加一个字母或数字。');
  // Windows: plain Ctrl+letter belongs to the terminal.
  assert.match(C.problem('Mod+N', false), /Shift 或 Alt/);
  assert.match(C.problem('Mod+Shift+C', false), /终端复制/);
  for (const ok of ['Mod+Shift+N', 'Mod+T', 'Mod+Alt+N', 'Mod+Shift+T', 'Mod+E']) assert.equal(C.problem(ok, true), '', ok);
  for (const ok of ['Mod+Shift+N', 'Mod+Alt+T', 'Mod+Shift+E']) assert.equal(C.problem(ok, false), '', ok);
  // AgentDeck's own Ctrl+Shift letters on Windows (Ctrl+Shift+T is 新对话 there).
  assert.equal(C.problem('Mod+Shift+T', false), 'Ctrl+Shift+T 已经是「新对话」，换一个。');
  assert.equal(C.problem(C.DEFAULT, true), '');
  assert.equal(C.problem(C.DEFAULT, false), '');
});
