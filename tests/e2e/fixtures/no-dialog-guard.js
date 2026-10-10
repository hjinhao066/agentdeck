// Loaded into Electron's main process before the app: `electron -r <this file> <app path> ...`.
// A test instance must never put a dialog in front of the user. Every dialog call is answered as "cancelled" and noted in the file
// named by E2E_DIALOG_GUARD_LOG (when set), and an uncaught exception is noted instead of opening Electron's error box.
// NODE_OPTIONS cannot do this: Playwright removes it from the app's environment.
const fs = require('fs');
const { dialog } = require('electron');
const note = (line) => { const file = process.env.E2E_DIALOG_GUARD_LOG; if (file) { try { fs.appendFileSync(file, line + '\n'); } catch (_) {} } };
note('guard loaded');
for (const name of ['showErrorBox', 'showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showCertificateTrustDialog']) {
  if (typeof dialog[name] !== 'function') continue;
  dialog[name] = (...args) => {
    note('blocked ' + name);
    if (name === 'showErrorBox') return undefined;
    if (name.endsWith('Sync')) return name.startsWith('showMessageBox') ? 0 : undefined;
    return Promise.resolve({ response: 0, checkboxChecked: false, canceled: true, filePaths: [], filePath: undefined });
  };
}
process.on('uncaughtException', (error) => note('uncaughtException ' + (error && error.message)));
