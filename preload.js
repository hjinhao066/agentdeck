const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  loadConfig: () => ipcRenderer.sendSync('load-config-sync'),
  saveConfig: (cfg) => ipcRenderer.send('save-config', cfg),
  envInfo: () => ipcRenderer.sendSync('env-info-sync'),
  clipboardWrite: (t) => clipboard.writeText(t),
  // Resolve a dropped File's real filesystem path (File.path is deprecated).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Push a column's rendered screen text so the watch-ai daemon can see it.
  agentdeckDump: (id, title, text) => ipcRenderer.send('agentdeck:dump', { id, title, text }),
  // Open a URL in the default browser; reveal a local path in Finder.
  openExternal: (url) => ipcRenderer.send('open-external', url),
  revealPath: (p, id) => ipcRenderer.send('reveal-path', { raw: p, id }),
  // Option+click: open the path in the editor (VS Code/Cursor) at its :line.
  openInEditor: (p, id) => ipcRenderer.send('open-in-editor', { raw: p, id }),
  // Replay text saved when the app last quit (read-once; null if none).
  ptySaved: (id) => ipcRenderer.invoke('pty:saved', { id }),

  ptySpawn: (id, cwd, cols, rows) => ipcRenderer.send('pty:spawn', { id, cwd, cols, rows }),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  // Hot-reload support: check if a pty survived a renderer reload, replay its buffer.
  ptyIsAlive: (id) => ipcRenderer.invoke('pty:is-alive', { id }),
  ptyReplay: (id) => ipcRenderer.invoke('pty:replay', { id }),
  reloadRenderer: () => ipcRenderer.send('reload-renderer'),

  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m.id, m.data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m.id)),
});
