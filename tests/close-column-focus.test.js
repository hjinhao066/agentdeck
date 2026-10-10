'use strict';
// Closing or archiving the focused session moves focus (and the deck's scroll)
// to its neighbour. The neighbour is counted in the deck the user sees: while
// a 队长 runs background sessions, those sit in `columns` but not in the deck,
// and counting them sent focus several columns to the right, often to the last.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AppShortcutsCore = require('../app-shortcuts-core.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
// A top-level function, from its declaration to the closing brace at column 0.
function fn(name) {
  const begin = source.indexOf(`\nfunction ${name}(`);
  assert.ok(begin >= 0, `renderer.js still defines ${name}`);
  return source.slice(begin, source.indexOf('\n}\n', begin) + 3);
}
// The window shortcut listener that follows focusColumnByIndex.
function cmdShortcuts() {
  const begin = source.indexOf("document.addEventListener('keydown', (e) => {\n  const hit = AppShortcutsCore.match(e, env.platform === 'darwin');");
  assert.ok(begin >= 0, 'renderer.js still has the shortcut listener');
  return source.slice(begin, source.indexOf('\n}, true);\n', begin) + '\n}, true);\n'.length);
}

function deck(ids, focused, platform = 'darwin') {
  const columns = ids.map((id) => ({ id, taskId: 't-' + id, role: 'manual', isMain: id === 'captain', captainCrew: id.startsWith('crew') }));
  const terms = new Map(columns.map((c) => [c.id, { wrap: { remove() {} }, term: { dispose() {}, focus() {} }, disposers: [] }]));
  let keydown = null;
  const context = vm.createContext({
    columns, terms, focusedId: focused, peekId: null, zoomedId: null, activeView: 'terminals',
    config: { links: [], mainSession: null },
    document: { addEventListener: (type, listener) => { if (type === 'keydown') keydown = listener; } },
    window: { deck: { ptyKill() {}, reloadRenderer() {} } },
    confirm: () => true,
    SidePane: { holdsTerminalOf: () => false, restoreTerminal() {} },
    ChatUI: { onColumnRemoved() {}, isChatMode: () => false, setMode() {}, focusInput: () => false },
    TaskBoardUI: { close() {} }, Pages: { hide() {} },
    updateColumnStyles() {}, fitAll() {}, syncNav() {}, scrollColumnInDeck() {}, focusColumnInput() {},
    cancelManagedRequests() {}, releaseManagedSubtree() {}, saveConfig() {}, renderColNav() {}, isManagedDescendant: () => false,
    columnLabel: (col) => col.id,
    AppShortcutsCore, env: { platform },
  });
  vm.runInContext([fn('isBackstage'), fn('deckColumns'), fn('managedSubtree'), fn('removeCol'), fn('detachColumn'), fn('focusColumnByIndex'), cmdShortcuts()].join('\n'), context);
  const press = (mods) => keydown({ type: 'keydown', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: {}, preventDefault() {}, stopPropagation() {}, ...mods });
  return {
    context, columns, press,
    pressCmdW: () => press({ metaKey: true, key: 'w', code: 'KeyW' }),
    pressCtrlShiftW: () => press({ ctrlKey: true, shiftKey: true, key: 'W', code: 'KeyW' }),
  };
}

const IDS = ['captain', 'crew1', 'crew2', 'crew3', 'A', 'B', 'C', 'D'];

test('closing the focused session focuses its right-hand neighbour in the deck', () => {
  const d = deck(IDS, 'A');
  vm.runInContext("removeCol(columns.find((c) => c.id === 'A'))", d.context);
  assert.equal(d.context.focusedId, 'B');
});

test('Cmd+W focuses the right-hand neighbour too', () => {
  const d = deck(IDS, 'B');
  d.pressCmdW();
  assert.deepEqual(d.columns.map((c) => c.id), ['captain', 'crew1', 'crew2', 'crew3', 'A', 'C', 'D']);
  assert.equal(d.context.focusedId, 'C');
});

test('closing the last session focuses the one before it; without background sessions nothing changes', () => {
  const last = deck(IDS, 'D');
  vm.runInContext("removeCol(columns.find((c) => c.id === 'D'))", last.context);
  assert.equal(last.context.focusedId, 'C');
  const plain = deck(['A', 'B', 'C'], 'B');
  plain.pressCmdW();
  assert.equal(plain.context.focusedId, 'C');
});

test('on Windows Ctrl+Shift+W closes the column and Win+W does nothing', () => {
  const d = deck(IDS, 'B', 'win32');
  d.pressCmdW();
  assert.equal(d.columns.length, IDS.length);
  d.pressCtrlShiftW();
  assert.deepEqual(d.columns.map((c) => c.id), ['captain', 'crew1', 'crew2', 'crew3', 'A', 'C', 'D']);
  assert.equal(d.context.focusedId, 'C');
});

test('on Windows Alt+1…9 and Alt+←/→ move focus between the columns in the deck', () => {
  const d = deck(['A', 'B', 'C'], 'A', 'win32');
  d.press({ altKey: true, key: 'ArrowRight', code: 'ArrowRight' });
  assert.equal(d.context.focusedId, 'B');
  d.press({ altKey: true, key: '3', code: 'Digit3' });
  assert.equal(d.context.focusedId, 'C');
  d.press({ altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.equal(d.context.focusedId, 'B');
  // Ctrl+Shift+← selects a word in PowerShell; it stays the terminal's.
  d.press({ ctrlKey: true, shiftKey: true, key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.equal(d.context.focusedId, 'B');
});
