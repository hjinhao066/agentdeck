'use strict';
// A test instance (`--test-user-data=<dir>`) must never put a dialog in front of the user. main.js installs this right after it
// recognises that argument, before the app is ready: every main-process dialog call is answered as "cancelled" and noted, and an
// uncaught exception is noted instead of opening Electron's error box. A page's own alert/confirm/prompt is not touched (see
// isPageDialog). It loads no outside code and reads no script path from anywhere. Notes go to the file named by
// E2E_DIALOG_GUARD_LOG, and only when that variable is set. An uncaught exception is also written to stderr as one line, set or not,
// so a real crash of the main process stays visible in every spec's output. Blocked dialogs are not: answering them is the guard's
// job and some specs provoke them on purpose; the log file is where a spec reads them.
//
// Main-process code must never pass `signal` to dialog.showMessageBox: that is how a page dialog is told apart (isPageDialog), so such
// a call would be let through and really open in a test instance. tests/test-instance-guard.test.js scans the sources for it.
const fs = require('fs');

const MESSAGE_BOXES = ['showMessageBox', 'showMessageBoxSync'];
const NAMES = ['showErrorBox', ...MESSAGE_BOXES, 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showCertificateTrustDialog'];

// The answer a user's "cancel" would have produced. A message box that names its cancel button gets that one.
function cancelled(name, args) {
  if (name === 'showErrorBox') return undefined;
  const sync = name.endsWith('Sync');
  if (MESSAGE_BOXES.includes(name)) {
    const options = [...args].reverse().find((arg) => arg && typeof arg === 'object' && !arg.webContents && !arg.isDestroyed);
    const response = options && Number.isInteger(options.cancelId) ? options.cancelId : 0;
    return sync ? response : Promise.resolve({ response, checkboxChecked: false });
  }
  if (name.startsWith('showOpenDialog')) return sync ? undefined : Promise.resolve({ canceled: true, filePaths: [] });
  if (name.startsWith('showSaveDialog')) return sync ? undefined : Promise.resolve({ canceled: true, filePath: undefined });
  return Promise.resolve();   // showCertificateTrustDialog
}

// Electron raises a page's alert/confirm/prompt itself, from a WebContents handler, as an asynchronous `dialog.showMessageBox(window,
// options)` whose options carry an AbortSignal (probed on this Electron; nothing in the app calls showMessageBox). Those are left
// alone: answering them here at once would take them away from Playwright (`page.on('dialog')` then fails with "No dialog is
// showing"), and a page dialog only opens when something in the page asks for one. A showMessageBox without that signal comes
// from main-process code and is blocked.
function isPageDialog(name, args) {
  const options = args[args.length - 1];
  return name === 'showMessageBox' && !!options && typeof options === 'object' && !!options.signal;
}

// One stderr line: the message and the first stack frame (no terminal contents, no prompts).
function describe(error) {
  const message = error && error.message !== undefined ? String(error.message) : String(error);
  const frame = error && typeof error.stack === 'string' ? error.stack.split('\n').find((line) => /^\s+at /.test(line)) : '';
  return '[test-instance-guard] uncaughtException: ' + message.split('\n')[0] + (frame ? ' ' + frame.trim() : '');
}

// `dialog` and `proc` are the Electron dialog module and the process object of the main process.
function install({ dialog, proc = process, env = process.env, appendFile = fs.appendFileSync, writeStderr = (text) => process.stderr.write(text) }) {
  const note = (line) => {
    const file = env.E2E_DIALOG_GUARD_LOG;
    if (file) { try { appendFile(file, line + '\n'); } catch (_) {} }
  };
  for (const name of NAMES) {
    if (typeof dialog[name] !== 'function') continue;
    const real = dialog[name];
    dialog[name] = (...args) => {
      if (isPageDialog(name, args)) return real.apply(dialog, args);
      note('blocked ' + name);
      return cancelled(name, args);
    };
  }
  proc.on('uncaughtException', (error) => {
    note('uncaughtException ' + (error && error.message));
    try { writeStderr(describe(error) + '\n'); } catch (_) {}
  });
  note('guard loaded');
}

module.exports = { install, cancelled, isPageDialog, describe, NAMES };
