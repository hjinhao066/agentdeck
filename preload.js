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
  // `cont` = up to two follow-up terminal lines, used to re-join paths the
  // agent's TUI hard-wrapped across lines.
  revealPath: (p, id, cont) => ipcRenderer.send('reveal-path', { raw: p, id, cont }),
  // Option+click: open the path in the editor (VS Code/Cursor) at its :line.
  openInEditor: (p, id, cont) => ipcRenderer.send('open-in-editor', { raw: p, id, cont }),
  // Replay text saved when the app last quit (read-once; null if none).
  ptySaved: (id) => ipcRenderer.invoke('pty:saved', { id }),
  // True if Claude Code has a resumable session in this cwd (→ use --continue).
  claudeHasSession: (cwd) => ipcRenderer.invoke('claude:has-session', { cwd }),

  ptySpawn: (id, cwd, cols, rows) => ipcRenderer.send('pty:spawn', { id, cwd, cols, rows }),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  // Hot-reload support: check if a pty survived a renderer reload, replay its buffer.
  ptyIsAlive: (id) => ipcRenderer.invoke('pty:is-alive', { id }),
  ptyReplay: (id) => ipcRenderer.invoke('pty:replay', { id }),
  reloadRenderer: () => ipcRenderer.send('reload-renderer'),

  // Transient feedback messages (e.g. clicked path doesn't exist).
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m.text)),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m.id, m.data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m.id)),
});
