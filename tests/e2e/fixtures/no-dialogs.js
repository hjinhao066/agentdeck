'use strict';
// Loaded into a test Electron's main process through NODE_OPTIONS=--require (before
// main.js): every native dialog becomes a no-op that writes one line to stderr, so a
// failing test never leaves a modal box on the desktop. Plain Node children (the
// stand-in agents, the usage scanner) load it too and are left alone.
if (process.versions.electron && process.type === 'browser') {
  const { dialog } = require('electron');
  const note = (name) => (...args) => {
    const text = args.find((a) => typeof a === 'string') || (args.find((a) => a && typeof a === 'object' && a.message) || {}).message || '';
    process.stderr.write(`[no-dialogs] ${name} suppressed: ${String(text).slice(0, 200)}\n`);
  };
  dialog.showErrorBox = note('showErrorBox');
  dialog.showMessageBox = async (...args) => { note('showMessageBox')(...args); return { response: 0, checkboxChecked: false }; };
  dialog.showMessageBoxSync = (...args) => { note('showMessageBoxSync')(...args); return 0; };
  dialog.showOpenDialog = async (...args) => { note('showOpenDialog')(...args); return { canceled: true, filePaths: [] }; };
  dialog.showOpenDialogSync = (...args) => { note('showOpenDialogSync')(...args); return undefined; };
  dialog.showSaveDialog = async (...args) => { note('showSaveDialog')(...args); return { canceled: true, filePath: '' }; };
  dialog.showSaveDialogSync = (...args) => { note('showSaveDialogSync')(...args); return undefined; };
}
