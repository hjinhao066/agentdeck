const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notification', {
  onItems: (callback) => ipcRenderer.on('notification:items', (_event, items) => callback(items)),
  open: (id) => ipcRenderer.send('notification:action', { id, action: 'open' }),
  dismiss: (id) => ipcRenderer.send('notification:action', { id, action: 'dismiss' }),
});
