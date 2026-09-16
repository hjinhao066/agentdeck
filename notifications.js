'use strict';
const path = require('path');
const { trustedSender, validId } = require('./security');

// A single sandboxed, non-activating window holds the notification queue.
// No shell scripts, per-terminal processes, or notification permissions needed.
function createNotifications({ BrowserWindow, ipcMain, screen, focusColumn, getMainWindow }) {
  const items = new Map();
  const file = path.join(__dirname, 'notification.html');
  let win = null;
  let ready = false;
  function position() {
    if (!win || win.isDestroyed() || !items.size) return;
    const main = getMainWindow();
    const display = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(380, area.width - 24);
    const height = Math.min(440, items.size * 96 + 16, area.height - 24);
    win.setBounds({ x: area.x + area.width - width - 12,
      y: area.y + area.height - height - 12, width, height });
  }
  function refresh() {
    if (!items.size) {
      if (win && !win.isDestroyed()) {
        if (ready) win.webContents.send('notification:items', []);
        win.hide();
      }
      return;
    }
    if (!win || win.isDestroyed()) {
      ready = false;
      win = new BrowserWindow({ width: 380, height: 112, show: false,
        frame: false, resizable: false, minimizable: false, maximizable: false,
        skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#15191f',
        title: 'AgentDeck notifications',
        webPreferences: { preload: path.join(__dirname, 'notification-preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.webContents.on('did-finish-load', () => { ready = true; refresh(); });
      win.on('closed', () => { win = null; ready = false; });
      win.loadFile(file);
    }
    position();
    if (ready) {
      win.webContents.send('notification:items', [...items.values()]);
      win.showInactive();
    }
  }
  function cancel(id) { items.delete(id); refresh(); }
  ipcMain.on('notification:action', (event, data) => {
    if (!trustedSender(event, win, file) || !data || !items.has(data.id)) return;
    if (data.action === 'open') { cancel(data.id); focusColumn(data.id); }
    else if (data.action === 'dismiss') cancel(data.id);
  });
  screen.on('display-metrics-changed', position);
  screen.on('display-removed', position);
  return {
    show({ id, title, state }) {
      if (!validId(id) || !['input', 'done'].includes(state)) return;
      items.set(id, { id, title: String(title || 'Terminal').slice(0, 120), state });
      // Bound the queue while keeping every ordinary multi-terminal event.
      if (items.size > 100) items.delete(items.keys().next().value);
      refresh();
    },
    cancel,
    dispose() {
      items.clear();
      screen.removeListener('display-metrics-changed', position);
      screen.removeListener('display-removed', position);
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}
module.exports = { createNotifications };
