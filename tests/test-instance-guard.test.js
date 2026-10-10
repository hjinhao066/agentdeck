'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { install, cancelled, isPageDialog, describe, NAMES } = require('../test-instance-guard');

function setup(env = {}) {
  const lines = [];
  const errors = [];
  const dialog = Object.fromEntries(NAMES.map((name) => [name, () => { throw new Error('a real ' + name + ' opened'); }]));
  const proc = new EventEmitter();
  install({ dialog, proc, env, appendFile: (file, text) => lines.push([file, text]), writeStderr: (text) => errors.push(text) });
  return { dialog, proc, lines, errors };
}

test('every dialog call is answered as cancelled and never opens', async () => {
  const { dialog } = setup();
  assert.equal(dialog.showErrorBox('t', 'c'), undefined);
  assert.equal(dialog.showMessageBoxSync({ message: 'm' }), 0);
  assert.equal(dialog.showMessageBoxSync({}, { message: 'm', buttons: ['Delete', 'Cancel'], cancelId: 1 }), 1, 'the named cancel button');
  assert.deepEqual(await dialog.showMessageBox({ message: 'm', buttons: ['OK'] }), { response: 0, checkboxChecked: false });
  assert.deepEqual(await dialog.showOpenDialog({ properties: ['openFile'] }), { canceled: true, filePaths: [] });
  assert.equal(dialog.showOpenDialogSync({}), undefined);
  assert.deepEqual(await dialog.showSaveDialog({}), { canceled: true, filePath: undefined });
  assert.equal(dialog.showSaveDialogSync({}), undefined);
  assert.equal(await dialog.showCertificateTrustDialog({}), undefined);
});

test('a page alert/confirm/prompt (async showMessageBox with an AbortSignal) is passed through, a main-process message box is not', async () => {
  const calls = [];
  const dialog = { showMessageBox: (...args) => { calls.push(args); return Promise.resolve({ response: 5 }); }, showMessageBoxSync: () => 9 };
  install({ dialog, proc: new EventEmitter(), env: {} });
  const page = { message: 'sure?', buttons: ['OK', 'Cancel'], signal: new AbortController().signal };
  assert.deepEqual(await dialog.showMessageBox({ webContents: {} }, page), { response: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], page);
  assert.deepEqual(await dialog.showMessageBox({ message: 'x' }), { response: 0, checkboxChecked: false }, 'no signal: blocked');
  assert.equal(dialog.showMessageBoxSync({ message: 'x', signal: new AbortController().signal }), 0, 'sync is always blocked');
  assert.equal(calls.length, 1);
  assert.equal(isPageDialog('showOpenDialog', [{ signal: {} }]), false);
});

test('notes go to E2E_DIALOG_GUARD_LOG only when it is set', () => {
  const noted = setup({ E2E_DIALOG_GUARD_LOG: '/tmp/guard.log' });
  noted.dialog.showOpenDialogSync({});
  noted.dialog.showErrorBox('t', 'c');
  noted.proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(noted.lines, [
    ['/tmp/guard.log', 'guard loaded\n'], ['/tmp/guard.log', 'blocked showOpenDialogSync\n'],
    ['/tmp/guard.log', 'blocked showErrorBox\n'], ['/tmp/guard.log', 'uncaughtException boom\n'],
  ]);
  const quiet = setup();
  quiet.dialog.showMessageBoxSync({});
  quiet.proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(quiet.lines, []);
});

test('an uncaught exception reaches stderr as one line whether or not a log file is set; a blocked dialog does not', () => {
  const quiet = setup();
  quiet.dialog.showErrorBox('t', 'c');
  assert.deepEqual(quiet.errors, [], 'a blocked dialog is not an error line');
  const error = new Error('boom\nsecond line');
  quiet.proc.emit('uncaughtException', error);
  assert.equal(quiet.errors.length, 1);
  assert.equal(quiet.errors[0], describe(error) + '\n');
  assert.match(quiet.errors[0], /^\[test-instance-guard\] uncaughtException: boom at /);
  assert.ok(!quiet.errors[0].includes('second line'));
  assert.equal(quiet.errors[0].trimEnd().split('\n').length, 1);
  const logged = setup({ E2E_DIALOG_GUARD_LOG: '/tmp/guard.log' });
  logged.proc.emit('uncaughtException', new Error('again'));
  assert.equal(logged.errors.length, 1);
  assert.match(logged.errors[0], /again/);
  quiet.proc.emit('uncaughtException', 'not an error object');
  assert.match(quiet.errors[1], /uncaughtException: not an error object\n$/);
});

test('a stderr that throws does not break the handler', () => {
  const proc = new EventEmitter();
  install({ dialog: {}, proc, env: {}, writeStderr: () => { throw new Error('EPIPE'); } });
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('x')));
});

test('a log file that cannot be written does not break the dialog answer', () => {
  const dialog = { showMessageBoxSync: () => 7 };
  install({ dialog, proc: new EventEmitter(), env: { E2E_DIALOG_GUARD_LOG: '/nope' }, appendFile: () => { throw new Error('EACCES'); } });
  assert.equal(dialog.showMessageBoxSync({}), 0);
});

test('a dialog function Electron does not have is left alone', () => {
  const dialog = { showErrorBox: () => 'real' };
  install({ dialog, proc: new EventEmitter(), env: {} });
  assert.equal(dialog.showErrorBox(), undefined);
  assert.equal(dialog.showOpenDialog, undefined);
});

test('cancelled ignores a parent window argument when it looks for cancelId', () => {
  assert.equal(cancelled('showMessageBoxSync', [{ webContents: {}, cancelId: 9 }, { buttons: ['a', 'b'], cancelId: 1 }]), 1);
  assert.equal(cancelled('showMessageBoxSync', [{ webContents: {} }, { buttons: ['a'] }]), 0);
});

// main.js is not loadable under node (it needs Electron), so its wiring is checked on the source: the module is required only in the
// --test-user-data branch, right after the argument is recognised, and nothing reads a script path from the environment.
test('main.js loads the guard only for --test-user-data, from the app itself, and the package ships it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const requires = main.split('\n').filter((line) => line.includes('test-instance-guard'));
  assert.ok(requires.some((line) => /^if \(tudArg\) require\('\.\/test-instance-guard'\)\.install\(\{ dialog \}\);$/.test(line)), requires.join('\n'));
  assert.equal(requires.filter((line) => line.includes('require(')).length, 1, 'one require, only in the test-instance branch');
  assert.ok(main.indexOf("app.setPath('userData'") < main.indexOf("require('./test-instance-guard')"));
  assert.ok(!/require\(process\.env|require\(env/.test(main), 'no environment variable names a script to load');
  assert.ok(require('../package.json').build.files.includes('test-instance-guard.js'));
});

// isPageDialog lets an async showMessageBox through when its options carry `signal`, so main-process code must not pass one. The scan
// reads the argument text of each `showMessageBox(` / `showMessageBoxSync(` call (balanced parentheses) in the top-level sources. It
// only sees a `signal` written inside the call; options built in a variable first are out of its reach.
function messageBoxCallsWithSignal(source) {
  const found = [];
  const call = /\bshowMessageBox(?:Sync)?\s*\(/g;
  let match;
  while ((match = call.exec(source))) {
    let depth = 1;
    let i = call.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    if (/\bsignal\b/.test(source.slice(call.lastIndex, i))) found.push(source.slice(match.index, i));
  }
  return found;
}

test('main-process code never passes a signal to showMessageBox (the guard would take it for a page dialog)', () => {
  assert.equal(messageBoxCallsWithSignal("dialog.showMessageBox(win, { message: 'x', signal: ctl.signal })").length, 1, 'scanner catches it');
  assert.equal(messageBoxCallsWithSignal("await dialog.showMessageBox(win, { message: f(1), buttons: ['a'] })").length, 0);
  assert.equal(messageBoxCallsWithSignal('dialog.showMessageBox({ signal })').length, 1);
  const root = path.join(__dirname, '..');
  const sources = fs.readdirSync(root).filter((name) => name.endsWith('.js') && name !== 'test-instance-guard.js');
  assert.ok(sources.includes('main.js'));
  for (const name of sources) {
    const hits = messageBoxCallsWithSignal(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.deepEqual(hits, [], name + ' passes signal to showMessageBox');
  }
});
