'use strict';
// The column edit dialog (title, folder, launch command) stays open while the
// user types. Meanwhile 队长 opens background sessions and finished ones are
// archived, which inserts and removes columns. Save must apply to the column
// the dialog was opened for, never to whichever column now sits at the same
// position: a changed command restarts that column's terminal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const begin = source.indexOf('// ---- Add / edit dialog ----');
const end = source.indexOf('// ---- Conductor Board control plane ----');
assert.ok(begin >= 0 && end > begin, 'renderer.js still has the edit dialog section');
const dialogSource = source.slice(begin, end);

function page(columns) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: false, disabled: false, onclick: null, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll: () => [], showModal() { this.open = true; }, close() { this.open = false; }, focus() {} });
    return elements.get(id);
  };
  const calls = { respawned: [], added: [], titled: [], toasts: [], cleared: [] };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    setTimeout: () => 0,
    columns,
    columnLabel: (col) => col.displayTitle || col.title,
    addColumn: (c) => calls.added.push(c),
    setColumnDisplayTitle: (col, title) => { calls.titled.push([col.id, title]); col.displayTitle = title; },
    saveConfig: () => {},
    respawnColumn: (col) => calls.respawned.push(col.id),
    showToast: (text) => calls.toasts.push(text),
    MainSession: { clearContext: (options) => calls.cleared.push(options) },
    ChatGPTWebCore: { LABEL: '网页版 ChatGPT', NO_SEAT_NOTE: '' },
  });
  vm.runInContext(dialogSource, context);
  return { context, element, calls };
}

test('save edits the column the dialog was opened for, after a session is inserted before it', () => {
  const a = { id: 'a', title: 'A', cwd: '/a', cmd: 'claude' };
  const b = { id: 'b', title: 'B', cwd: '/b', cmd: 'codex' };
  const columns = [a, b];
  const { context, element, calls } = page(columns);
  vm.runInContext('openDialog(1)', context);            // the user edits B
  assert.equal(element('cmdInput').value, 'codex');
  columns.unshift({ id: 'crew', title: 'crew', cwd: '/crew', cmd: 'agy' });   // 队长 opens a background session
  element('cmdInput').value = 'codex --model gpt-6-luna';
  element('dlgSave').onclick();
  assert.equal(b.cmd, 'codex --model gpt-6-luna', 'B got the new command');
  assert.equal(a.cmd, 'claude', 'A, now at the edited position, is untouched');
  assert.deepEqual(calls.respawned, ['b'], 'only B restarts');
  assert.deepEqual(calls.titled, [], 'no column was renamed');
});

test('save after the edited column was archived changes nothing and says so', () => {
  const a = { id: 'a', title: 'A', cwd: '/a', cmd: 'claude' };
  const b = { id: 'b', title: 'B', cwd: '/b', cmd: 'codex' };
  const columns = [a, b];
  const { context, element, calls } = page(columns);
  vm.runInContext('openDialog(0)', context);            // the user edits A
  columns.splice(0, 1);                                 // A is archived meanwhile
  element('titleInput').value = 'renamed';
  element('cmdInput').value = 'grok';
  element('dlgSave').onclick();
  assert.equal(b.cmd, 'codex');
  assert.equal(b.title, 'B');
  assert.deepEqual(calls.respawned, []);
  assert.deepEqual(calls.titled, []);
  assert.equal(calls.toasts.length, 1);
  assert.equal(element('colDialog').open, false, 'the dialog closes');
});

test('adding a column still works', () => {
  const columns = [{ id: 'a', title: 'A', cwd: '', cmd: '' }];
  const { context, element, calls } = page(columns);
  vm.runInContext('openDialog()', context);
  element('titleInput').value = 'New';
  element('cmdInput').value = 'claude';
  element('dlgSave').onclick();
  assert.equal(calls.added.length, 1);
  assert.equal(calls.added[0].cmd, 'claude');
  assert.equal(calls.added[0].title, 'New');
});
