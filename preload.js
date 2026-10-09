const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deck', {
  loadConfig: () => ipcRenderer.sendSync('load-config-sync'),
  saveConfig: (cfg) => ipcRenderer.send('save-config', cfg),
  saveConfigSync: (cfg) => ipcRenderer.sendSync('save-config-sync', cfg),
  restartManifestLoad: () => ipcRenderer.sendSync('restart-manifest-load'),
  restartManifestSave: (doc) => ipcRenderer.sendSync('restart-manifest-save', doc),
  onParkForRestart: (cb) => ipcRenderer.on('park-for-restart', (_e, m) => cb(m && m.sessions)),
  parkForRestartDone: () => ipcRenderer.send('park-for-restart-done'),
  mobileWebSettings: (input) => ipcRenderer.invoke('mobile-web:settings', input),
  automationSettings: (input) => ipcRenderer.invoke('automation:settings', input),
  onMobileRequest: (cb) => ipcRenderer.on('mobile-web:request', (_e, m) => cb(m)),
  mobileRespond: (payload) => ipcRenderer.send('mobile-web:response', payload),
  envInfo: () => ipcRenderer.sendSync('env-info-sync'),
  // 版本更新 page: this build's release-notes.json (read only).
  releaseNotes: () => ipcRenderer.invoke('release-notes:read', {}),
  // 每日进展: counts from the nightly daily-progress files (read only).
  dailyProgress: () => ipcRenderer.invoke('daily-progress:read', {}),
  memoryPressure: () => ipcRenderer.invoke('memory-pressure'),
  // Battery mode: whether the Mac runs on battery now, and a push when it changes.
  powerState: () => ipcRenderer.sendSync('power-state'),
  onPowerChanged: (cb) => ipcRenderer.on('power:changed', (_e, m) => cb(!!(m && m.onBattery))),
  // The machine going to sleep / waking, with main's own timestamp.
  onPowerSleep: (cb) => ipcRenderer.on('power:sleep', (_e, m) => cb(!!(m && m.asleep), Number.isFinite(m && m.at) ? m.at : Date.now())),
  quotaLocal: () => ipcRenderer.invoke('quota:local'),
  quotaRefresh: (seatId) => ipcRenderer.invoke('quota:refresh', { seatId }),
  onQuotaUpdated: (cb) => ipcRenderer.on('quota:updated', (_e, samples) => cb(samples)),
  ptyHasChildWork: (id) => ipcRenderer.invoke('pty:has-child-work', { id }),
  seatAuthFailure: (payload) => ipcRenderer.invoke('seat-auth:failure', payload),
  barkStatus: () => ipcRenderer.invoke('bark:status'),
  refreshBarkCalendar: () => ipcRenderer.invoke('bark:refresh'),
  // Electron gives a preload no `clipboard` module, so main reads and writes
  // it. A failed write throws: a copy button must not report success for it.
  clipboardWrite: (t) => { if (ipcRenderer.sendSync('clipboard:write-sync', t) !== true) throw new Error('Clipboard write failed.'); },
  clipboardRead: () => ipcRenderer.sendSync('clipboard:read-sync') || '',
  // Resolve a dropped File's real filesystem path (File.path is deprecated).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Retired bridge: main only removes old spools; it never writes new ones.
  agentdeckDump: (id, title, text) => ipcRenderer.send('agentdeck:dump', { id, title, text }),
  // Kept for older renderers; this also only removes old spools.
  agentdeckTouch: (id) => ipcRenderer.send('agentdeck:touch', { id }),
  // Pasted-image support: if the clipboard holds an image, main saves it to a
  // temp PNG and returns the path (null otherwise).
  pasteImageSave: () => ipcRenderer.invoke('paste-image:save'),
  // Dock badge: how many columns are blocked waiting for the user.
  setAttnCount: (n) => ipcRenderer.send('attn:count', n),
  // Captain native system notification (click → exact column).
  notifyState: (payload) => ipcRenderer.send('notify-state', payload),
  // Retract an obsolete Captain notification.
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
  // Artifacts: which delivered files are still on disk (0 gone, 1 file, 2 folder).
  artifactsStat: (paths) => ipcRenderer.invoke('artifacts:stat', { paths }),
  sideBrowserOpen: (url) => ipcRenderer.send('side:browser-open', { url }),
  sideBrowserPdf: (raw, id, cont) => ipcRenderer.send('side:browser-pdf', { raw, id, cont }),
  sideBrowserBounds: (b) => ipcRenderer.send('side:browser-bounds', b),
  sideBrowserAction: (action) => ipcRenderer.send('side:browser-action', { action }),
  onBrowserState: (cb) => ipcRenderer.on('side:browser-state', (_e, m) => cb(m)),
  // Skills page: keys come from the listing; main re-checks every path.
  skillsList: () => ipcRenderer.invoke('skills:list', {}),
  skillsRead: (key) => ipcRenderer.invoke('skills:read', { key }),
  skillsSave: (key, text, hash) => ipcRenderer.invoke('skills:save', { key, text, hash }),
  // Schedule's watched tasks: reports another scheduler left, and the user's 做 / 不做 on them.
  scheduleFeeds: (fresh) => ipcRenderer.invoke('schedule-feed:list', { fresh: !!fresh }),
  scheduleFeedDetail: (id, options) => ipcRenderer.invoke('schedule-feed:detail', { ...(options || {}), id }),
  scheduleFeedDecide: (id, decision) => ipcRenderer.invoke('schedule-feed:decide', { ...(decision || {}), id }),
  scheduleFeedSettle: (id) => ipcRenderer.invoke('schedule-feed:settle', { id }),
  scheduleFeedNotified: (id, seqs) => ipcRenderer.invoke('schedule-feed:notified', { id, seqs }),

  chatgptWebRun: (payload) => ipcRenderer.invoke('chatgpt-web:run', payload),
  chatgptWebCancel: (id) => ipcRenderer.invoke('chatgpt-web:cancel', { id }),
  chatgptWebStatus: (id) => ipcRenderer.invoke('chatgpt-web:status', { id }),

  ptySpawn: (id, cwd, cols, rows, managed, seatId, configDir, crew) => ipcRenderer.send('pty:spawn', { id, cwd, cols, rows, managed, seatId, configDir, crew }),
  claudeSeats: (fresh) => ipcRenderer.invoke('seats:list', { fresh: fresh === true }),
  validateClaudeSeats: (seats) => ipcRenderer.invoke('seats:validate', { seats }),
  captainCheckpoint: (payload) => ipcRenderer.invoke('seats:checkpoint', payload),
  captainHandoff: (payload) => ipcRenderer.invoke('seats:handoff', payload),
  claudeSeatUsage: (seatId) => ipcRenderer.invoke('seats:usage', { seatId }),
  claudeWarmupStatus: () => ipcRenderer.invoke('seats:warmup-status'),
  claudeWarmupIdle: (colId, idle) => ipcRenderer.invoke('seats:warmup-idle', { colId, idle }),
  recordClaudeSeatUsage: (colId, seatId, configDir, usage) => ipcRenderer.invoke('seats:record-usage', { colId, seatId, usage, configDir }),
  captainRelayNotify: (colId, message, urgent = false) => ipcRenderer.invoke('captain:relay-notify', { colId, message, urgent }),

  prepareLaunch: (id, command) => ipcRenderer.invoke('pty:prepare-launch', { id, command }),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  // keepReplay: save the output first (archiving), so restoring can replay it.
  ptyKill: (id, keepReplay) => ipcRenderer.send('pty:kill', { id, keepReplay: !!keepReplay }),
  // Composer "+" button: pick files to mention; returns their paths.
  pickFiles: () => ipcRenderer.invoke('pick-files', {}),
  // A prompt too long for the terminal is saved as a private .txt; returns its path.
  saveLongPrompt: (text) => ipcRenderer.invoke('prompt:save-long', { text }),
  // Hot-reload support: check if a pty survived a renderer reload, replay its buffer.
  ptyIsAlive: (id, seatId) => ipcRenderer.invoke('pty:is-alive', { id, seatId }),
  ptyForeground: (id) => ipcRenderer.invoke('pty:foreground', { id }),
  ptyReplay: (id, snapshot = false) => ipcRenderer.invoke('pty:replay', { id, snapshot }),
  reloadRenderer: () => ipcRenderer.send('reload-renderer'),

  // Transient feedback messages (e.g. clicked path doesn't exist).
  onToast: (cb) => ipcRenderer.on('toast', (_e, m) => cb(m.text)),
  onFontSize: (cb) => ipcRenderer.on('font-size', (_e, m) => cb(m.delta)),
  // External "jump to this column" request (popup-notification click).
  onFocusColumn: (cb) => ipcRenderer.on('focus-column', (_e, m) => cb(m.id)),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, m) => cb(m.id, m.data, m.sequence)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, m) => cb(m.id, m.reason)),
  // Capability-checked commands emitted by conductor-managed terminals via
  // board-cli.js. Manual terminals never receive the control token.
  onBoardCommand: (cb) => ipcRenderer.on('board:command', (_e, m) => cb(m)),
  boardRespond: (payload) => ipcRenderer.send('board:response', payload),
  boardReady: () => ipcRenderer.send('board:ready'),
  // Fixed shared task store; no caller-selected paths or arbitrary IPC.
  taskBoard: (op, input) => ipcRenderer.invoke('task-board:request', { op, input }),
  // 随手记待办: list / add / update / remove on the fixed to-do folder only.
  todos: (op, input) => ipcRenderer.invoke('todos:request', { op, input }),
  onTodosChanged: (cb) => ipcRenderer.on('todos:changed', () => cb()),
  prepareWorktree: (input) => ipcRenderer.invoke('worktree:prepare', input || {}),
  reclaimWorktree: (record) => ipcRenderer.invoke('worktree:reclaim', { record }),
  fleetState: () => ipcRenderer.invoke('fleet:state'),
  onTaskStart: (cb) => ipcRenderer.on('task-board:start', (_e, m) => cb(m)),
  onTaskReview: (cb) => ipcRenderer.on('task-board:review', (_e, m) => cb(m)),
  onTaskRework: (cb) => ipcRenderer.on('task-board:rework', (_e, m) => cb(m)),
  onTasksChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('task-board:changed', listener);
    return () => ipcRenderer.removeListener('task-board:changed', listener);
  },
});
