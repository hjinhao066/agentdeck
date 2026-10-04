const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  loadConfig: () => ipcRenderer.sendSync('load-config-sync'),
  saveConfig: (cfg) => ipcRenderer.send('save-config', cfg),
  envInfo: () => ipcRenderer.sendSync('env-info-sync'),
  quotaLocal: () => ipcRenderer.invoke('quota:local'),
  clipboardWrite: (t) => clipboard.writeText(t),
  clipboardRead: () => clipboard.readText(),
  // Resolve a dropped File's real filesystem path (File.path is deprecated).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Push a column's rendered screen text so the watch-ai daemon can see it.
  agentdeckDump: (id, title, text) => ipcRenderer.send('agentdeck:dump', { id, title, text }),
  // Screen unchanged: just bump the spool's mtime so watch-ai keeps seeing it
  // as live (it treats files older than ~8s as dead columns).
  agentdeckTouch: (id) => ipcRenderer.send('agentdeck:touch', { id }),
  // Pasted-image support: if the clipboard holds an image, main saves it to a
  // temp PNG and returns the path (null otherwise).
  pasteImageSave: () => ipcRenderer.invoke('paste-image:save'),
  // Dock badge: how many columns are blocked waiting for the user.
  setAttnCount: (n) => ipcRenderer.send('attn:count', n),
  // Windows popup for a non-Claude column turning done/input (click → jump).
  notifyState: (payload) => ipcRenderer.send('notify-state', payload),
  // Retract this column's popup — it fired "done" but the agent resumed working.
  notifyCancel: (payload) => ipcRenderer.send('notify-cancel', payload),
  // Column state transitions, mirrored to the main-process diagnostic log.
  stateDebug: (payload) => ipcRenderer.send('state-debug', payload),
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
  // Auto column naming: compress a submitted prompt into a ≤10-char label.
  summarizeTitle: (text) => ipcRenderer.invoke('title:summarize', { text }),

  // Saved conversations (prompts + final replies), kept in userData/chats.
  chatLoadAll: () => ipcRenderer.invoke('chat:load-all', {}),
  chatSave: (id, chat) => ipcRenderer.send('chat:save', { id, chat }),
  chatDelete: (id) => ipcRenderer.send('chat:delete', { id }),
  // Right-hand pane: file preview, embedded browser.
  previewRead: (raw, id, cont) => ipcRenderer.invoke('preview:read', { raw, id, cont }),
  sideBrowserOpen: (url) => ipcRenderer.send('side:browser-open', { url }),
  sideBrowserPdf: (raw, id, cont) => ipcRenderer.send('side:browser-pdf', { raw, id, cont }),
  sideBrowserBounds: (b) => ipcRenderer.send('side:browser-bounds', b),
  sideBrowserAction: (action) => ipcRenderer.send('side:browser-action', { action }),
  onBrowserState: (cb) => ipcRenderer.on('side:browser-state', (_e, m) => cb(m)),
  // Skills page: keys come from the listing; main re-checks every path.
  skillsList: () => ipcRenderer.invoke('skills:list', {}),
  skillsRead: (key) => ipcRenderer.invoke('skills:read', { key }),
  skillsSave: (key, text, hash) => ipcRenderer.invoke('skills:save', { key, text, hash }),

  ptySpawn: (id, cwd, cols, rows, managed) => ipcRenderer.send('pty:spawn', { id, cwd, cols, rows, managed }),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  // keepReplay: save the output first (archiving), so restoring can replay it.
  ptyKill: (id, keepReplay) => ipcRenderer.send('pty:kill', { id, keepReplay: !!keepReplay }),
  // Composer "+" button: pick files to mention; returns their paths.
  pickFiles: () => ipcRenderer.invoke('pick-files', {}),
  // A prompt too long for the terminal is saved as a private .txt; returns its path.
  saveLongPrompt: (text) => ipcRenderer.invoke('prompt:save-long', { text }),
  // Hot-reload support: check if a pty survived a renderer reload, replay its buffer.
  ptyIsAlive: (id) => ipcRenderer.invoke('pty:is-alive', { id }),
  ptyForeground: (id) => ipcRenderer.invoke('pty:foreground', { id }),
  ptyReplay: (id) => ipcRenderer.invoke('pty:replay', { id }),
  reloadRenderer: () => ipcRenderer.send('reload-renderer'),

  // Transient feedback messages (e.g. clicked path doesn't exist).
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m.text)),
  onFontSize: (cb) => ipcRenderer.on('font-size', (_e, m) => cb(m.delta)),
  // External "jump to this column" request (popup-notification click).
  onFocusColumn: (cb) => ipcRenderer.on('focus-column', (_e, m) => cb(m.id)),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m.id, m.data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m.id)),
  // Capability-checked commands emitted by conductor-managed terminals via
  // board-cli.js. Manual terminals never receive the control token.
  onBoardCommand: (cb) => ipcRenderer.on('board:command', (_e, m) => cb(m)),
  boardRespond: (payload) => ipcRenderer.send('board:response', payload),
  boardReady: () => ipcRenderer.send('board:ready'),
});
