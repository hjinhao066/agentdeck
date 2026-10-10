'use strict';
// Loaded into a test Electron's main process with Electron's own `-r <this file>` before
// the app path (Playwright removes NODE_OPTIONS from a launch's env, so that route never
// reaches Electron): every native dialog becomes a no-op that writes one line to stderr,
// so a failing test never leaves a modal box on the desktop. Each replacement carries
// `noDialogs: true` so a spec can check the guard is really in place.
if (process.versions.electron && process.type === 'browser') {
  const { dialog } = require('electron');
  const mark = (f) => Object.assign(f, { noDialogs: true });
  const note = (name) => (...args) => {
    const text = args.find((a) => typeof a === 'string') || (args.find((a) => a && typeof a === 'object' && a.message) || {}).message || '';
    process.stderr.write(`[no-dialogs] ${name} suppressed: ${String(text).slice(0, 200)}\n`);
  };
  dialog.showErrorBox = mark(note('showErrorBox'));
  dialog.showMessageBox = mark(async (...args) => { note('showMessageBox')(...args); return { response: 0, checkboxChecked: false }; });
  dialog.showMessageBoxSync = mark((...args) => { note('showMessageBoxSync')(...args); return 0; });
  dialog.showOpenDialog = mark(async (...args) => { note('showOpenDialog')(...args); return { canceled: true, filePaths: [] }; });
  dialog.showOpenDialogSync = mark((...args) => { note('showOpenDialogSync')(...args); return undefined; });
  dialog.showSaveDialog = mark(async (...args) => { note('showSaveDialog')(...args); return { canceled: true, filePath: '' }; });
  dialog.showSaveDialogSync = mark((...args) => { note('showSaveDialogSync')(...args); return undefined; });
}
