'use strict';
// Closing 队长 broke "deck order equals sidebar order" (AGENTS.md, SidebarCore.orderedColumns).
// Its background sessions become ordinary loose sessions, listed after the folders, but
// removeCol only spliced 队长 out of `columns`: in the deck they stayed in front of every
// folder's sessions, so swiping walked a different order from the list on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SidebarCore = require('../sidebar-core.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
// A top-level function, from its declaration to the closing brace at column 0.
function fn(name) {
  const begin = source.indexOf(`\nfunction ${name}(`);
  assert.ok(begin >= 0, `renderer.js still defines ${name}`);
  return source.slice(begin, source.indexOf('\n}\n', begin) + 3);
}

function deck() {
  const folders = [{ id: 'f1', name: '项目', collapsed: false }];
  // What renderer.js builds at launch: 队长, its background sessions, the folder's sessions, loose ones.
  const columns = SidebarCore.orderedColumns([
    { id: 'A', folderId: 'f1' }, { id: 'B' },
    { id: 'captain', isMain: true }, { id: 'crew1', captainCrew: true }, { id: 'crew2', captainCrew: true },
  ].map((c) => ({ role: 'manual', taskId: 't-' + c.id, folderId: null, ...c })), folders);
  const terms = new Map(columns.map((c) => [c.id, { wrap: { remove() {} }, term: { dispose() {}, focus() {} }, disposers: [] }]));
  const context = vm.createContext({
    columns, terms, focusedId: 'captain', peekId: null, zoomedId: null, activeView: 'terminals',
    config: { links: [], mainSession: { colId: 'captain' }, folders },
    SidebarCore, deckEl: { appendChild() {} },
    window: { deck: { ptyKill() {} } },
    confirm: () => true,
    SidePane: { holdsTerminalOf: () => false, restoreTerminal() {} },
    ChatUI: { onColumnRemoved() {}, isChatMode: () => false, setMode() {}, focusInput: () => false },
    TaskBoardUI: { close() {} }, Pages: { hide() {} },
    updateColumnStyles() {}, fitAll() {}, syncNav() {}, scrollColumnInDeck() {}, focusColumnInput() {},
    cancelManagedRequests() {}, releaseManagedSubtree() {}, saveConfig() {}, renderColNav() {}, isManagedDescendant: () => false,
    columnLabel: (col) => col.id,
  });
  vm.runInContext(['isBackstage', 'deckColumns', 'managedSubtree', 'removeCol', 'detachColumn', 'focusColumnByIndex', 'reflowDeck'].map(fn).join('\n'), context);
  return { context, folders };
}

test('after closing 队长 the deck walks the sessions in the order the sidebar lists them', () => {
  const d = deck();
  vm.runInContext("removeCol(columns.find((c) => c.id === 'captain'))", d.context);
  const deckOrder = vm.runInContext('deckColumns()', d.context).map((c) => c.id);
  // The sidebar (sidebar.js renderBody): 队长 is gone, so folders first, then loose sessions.
  const { crew, groups, loose } = SidebarCore.groupSessions(d.context.columns, d.folders);
  const sidebarOrder = [...crew, ...groups.flatMap((g) => g.items), ...loose].map((c) => c.id);
  assert.deepEqual(sidebarOrder, ['A', 'crew1', 'crew2', 'B']);
  assert.deepEqual(deckOrder, sidebarOrder, 'deck order differs from sidebar order after closing 队长');
});
