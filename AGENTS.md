# AgentDeck contributor instructions

Applies to all AI tools and all files in this repository, on Windows and macOS.

## Synchronization is part of every task

1. Before edits, run `git status --short --branch`, `git fetch origin`, and inspect
   incoming changes. Fast-forward a clean branch before working. Preserve other
   people's uncommitted files; never reset, clean, or force-push over them.
2. Read this file, `README.md`, and the relevant implementation and tests. Both
   platforms share this repository; do not create divergent Windows/Mac copies.
3. Implement the complete change and add regression tests for meaningful bugs.
   Feature branches run `npm test` plus the E2E specs that cover the change.
   **Run E2E only through `npm run e2e -- <spec>` (or `npm run test:smoke` /
   `test:e2e`), never bare `playwright test`**: one machine-wide queue lets a single
   group run at a time so 20 sessions do not stall the Mac; wait for your turn, do
   not remove its lock. To use the Windows PC instead, `node scripts/e2e-remote-win.js
   <branch> <spec>` (README 「E2E 排队与 Windows 远程跑」).
   To spare a loaded Mac, run `node scripts/e2e-auto.js tests/e2e/a.spec.js [b.spec.js] [-- playwright args]`:
   specs carrying a Windows platform skip (`test.skip(process.platform === 'win32', ...)`) go through
   the local queue; the others go to the Windows PC as one group, in the background over ssh (a
   non-desktop session, so no window appears), and fall back to the local queue when ssh or the
   remote setup fails. Windows tests the working tree as it is now, a dirty tree included. A test
   failing on Windows stays a failure (it is not re-run on the Mac); a spec that only works on
   macOS/POSIX needs the platform skip above. Measured numbers and the recommended
   `AGENTDECK_E2E_SLOTS`: `docs/e2e-windows-background.md`; re-measure with
   `scripts/perf-e2e-benchmark.js`.
   A patch release runs `npm test` and `npm run test:smoke` (see README 发版流程).
   Full `npm run test:e2e` runs overnight or on another machine. Run `npm audit`
   before packaging. Run the packaged E2E suite when runtime, preload, native
   modules or packaging changes.
4. Update user/developer documentation when behavior or build steps change.
5. Fetch again, integrate concurrent remote commits without losing either side,
   commit the task's source/tests/docs/lockfile, and **push to GitHub in the same
   task**. Verify local HEAD matches the remote branch. A local-only commit is
   not delivered. If authentication or a branch policy blocks a push, report the
   exact blocker and retain the commit; never claim a successful upload.
6. For installed desktop apps, stop the app, rebuild, install the complete new
   runtime, verify fresh executable and packaged source contents, then relaunch
   and verify it stays alive. On Windows launch via Explorer. Do not ask the
   user to rebuild/restart. Honor an explicit user instruction not to restart.
7. Check Windows and macOS CI results. Distinguish CI build/test coverage from
   physical-device verification; never claim a Mac was updated without access.

## Architecture invariants

- Each column is an independent node-pty shell. Do not introduce tmux.
- Use xterm Canvas, never WebGL (multi-column GPU context eviction corrupts text).
- Orange scrollbars are intentional. Preserve Chinese IME and voice input.
- Never expose Node or arbitrary IPC to the page. Validate the originating main
  frame and payloads. System notifications are created only in the main process.
- Notification arrival does not steal focus. A click restores the main window,
  reveals the exact column and focuses its input: the composer in chat mode,
  the xterm textarea in terminal mode. Stale IDs never fall
  back to another terminal. Retract obsolete notifications and deduplicate turns.
  The Captain and user-submitted turns in independent manual terminals notify;
  startup/replay never arms manual alerts. All workers (including peeked/foreground
  sessions) are silent. Mute sound when the focused window shows the notifying
  column, with at least 30 seconds between sounds. Never re-enable legacy watch-ai spools.
- Automatic input (队长 receipts, work handed to a session) must never go through
  an input box holding text the user has not sent: gate on `userComposing` and pass
  `guardUserInput` to `ChatUI.sendPrompt`. Never press Enter on the user's behalf
  for text that is not AgentDeck's own. Keys and clicks that arrive while it types
  wait for its Enter; wheel, pointer moves, focus and terminal replies never wait
  (`ChatCore.passesInputHold`): full-screen agents are scrolled by the wheel.
- Screen-based completion is a quiet-output heuristic, not proof of task success.
- Do not log prompts, tokens or terminal contents. Do not commit local settings,
  session output, screenshots containing user data, keys, or installed bundles.
- Managed terminal tokens provide app-level routing, not an OS sandbox against
  programs running as the same user. Never inherit control tokens into manual columns
  (the exceptions are the 队长 column, which the user creates explicitly, and a 小队长
  the 队长 opens with `new --sub-captain`, whose token is limited to its own children).
- Chat view: the xterm of a chat-mode column stays mounted (hidden, never
  `display:none`) so PTY size, status dots and notifications keep working. Bubbles
  hold only the user prompt and the agent's final reply. Left/right swipe between
  columns is the core interaction; do not change the deck wheel or scroll code.
- A reply is saved as it was read off the screen and cleaned when shown: agent
  columns take terminal residue out with the phone hub's `cleanReply`
  (`mobile-web/hub/core.js`, loaded by `index.html`). One set of rules for both
  ends; fix a rule there, never in a desktop copy. Titles, lists and tables are
  then read back from the plain rows (`ChatCore.tidyReply`). 队长's dispatch cards
  between two messages fold behind one `.task-run` line and stay direct children
  of the chat list; a turn with nothing to read is hidden, never deleted.
- Saved conversations live in `userData/chats` (private, never committed, never
  pushed to this public repo). Any cloud sync must target a separate private repo.
  Folders, archived sessions and schedules are in the local `config.json` too.
- History is durable: every turn is kept (no turn-count eviction; the chat view
  renders a window and loads older turns on request). Prompts submitted in the raw
  terminal are recorded in either view, except lines typed at a password prompt.
  A turn still open when the app closes or its terminal is replaced keeps the
  reply captured so far and is marked `interrupted`, never shown as complete.
  A chat too large to write is refused with a toast, never trimmed. Column ids
  (and so chat files) survive archive, restore and relaunch.
- Deck order always equals sidebar order (队长, its background sessions, folders,
  then loose sessions; `SidebarCore.orderedColumns`). Background sessions
  (`captainCrew` while a 队长 exists) are `.backstage`: built and sized off-deck,
  skipped by navigation and popups, shown after 队长 only while opened (`peekId`). Reorder by moving live column nodes, never by
  rebuilding terminals. Archive kills the PTY with `keepReplay` so restore can
  replay the saved output; the startup prune must keep archived ids. The archive has no
  cap (`SidebarCore.normalizeArchived` keeps every entry, the sidebar pages it): never
  drop an entry to shorten the list, its chat and replay would be orphaned. At launch
  `archive-recovery.js` runs before that prune and puts a chat file nothing lists back into
  the archive (only one the user spoke in; never a 队长 chat; `config.json` copied aside
  first; never deletes or rewrites a chat). A test profile reads no backup outside itself.
- Open columns are rebuilt at launch through a field whitelist (`renderer.js`,
  `config.columns = saved.columns.map(...)`). A field the app must still find on a column
  after a restart (`worktree`, `executor`/`webMode`, ...) has to be added there with its
  type check and to `tests/relaunch-keeps-column-fields.test.js`. Archived entries and
  restored columns are kept whole, so only an open column loses a forgotten field.
- Archiving ends a terminal, so a session that is working, waiting on an answer or
  printing output is never archived, automatically or by click, and never asks first
  (`archiveColumn` shows a notice and stops). The automatic archive reads the terminal itself one more time
  before it ends one. The Captain's explicit capability-checked
  `archive --id` command can end and archive a busy worker without confirmation;
  `stop --id` only sends Esc and cancels unsent supplements. Quota waits stay open
  and block automatic delivery; assigned tasks receive failure receipts with the
  provider reason. Work that cannot go in because the
  session sits on a startup dialog is reported to the 队长 once, never typed into it.
  A launched command line that has drawn nothing (only its echoed launch line is on
  screen: `MainCore.launchEchoOnly`) is not an agent however quiet it is: no automatic
  send goes into it, and a 队长 dispatch to it fails after `MainCore.startupLimit`
  (3 minutes, Cursor 6) with an anomaly receipt (`source: 'startup'`, 启动失败 / 任务没送达,
  last screen rows, full text kept for `read`). Never the 已结束，未提交回执 path.
- Schedule runs only while the app is open, never fires overdue runs late at
  launch (reported as missed), and sends through the same path as the composer.
- Schedule's watched tasks (`schedule-feed.js`, `docs/schedule-watched-tasks.md`) are
  run by another scheduler; AgentDeck only reads their reports. A 做 / 不做 goes into
  this machine's journal first and is then written by the task's own `decide` command:
  never write into a task's folder or its mirror, never drop a waiting decision, and
  never let a decision open a session, create a card or start work. No bulk accept.
  A test profile reads task descriptions only from inside the profile.
- A command line launched in this run gets no automatic input before the agent has drawn
  its own prompt below the launch line and held still (`promptSettled`,
  `MainCore.agentPromptDrawn`); the last run's replay is never the live screen, on any
  platform (`MainCore.afterReplay`). Text AgentDeck typed that the agent did not take is
  AgentDeck's own (`entry.autoSent`), never the user's draft. After every start the 队长
  must be back within a minute and each continued crew task within its limit
  (`RestartResume.createRestartWatch`); typed text is no proof of that. Whoever is not back
  is reported once (待我处理, phone, critical Bark via `restart:alarm`), and ticked off later.
  A crew task closed only by the three-minute 已结束，未提交回执 fallback is unfinished: every
  start continues it however the app went down (`RestartResume.provisionalStop`).
- Automatic sends go through `sendWhenReady`/`agentInForeground`: never type
  prose into a column whose foreground process is a shell (unless it is a plain
  shell column a Schedule targets on purpose). Prompts are never truncated; long
  ones go out as a file via `prompt:save-long`. A terminal without bracketed paste reads
  line by line and the tty drops what a line holds past ~1 KB, so a line over `ChatCore.LINE_MODE_BYTES`
  there goes out the same way, as one short pointer line.
- The status lines under a chat composer are read from the rows below the TUI's
  input box; `extractReply` must keep cutting that box and everything below it.
- 队长 (main session, `main-session.js`/`main-core.js`): exactly one column with
  `isMain`, always first in the deck. Once it exists, the sidebar also shows it as
  a protected row pinned above the folders (selecting it shows its conversation);
  that row is never dragged, filed into a folder, archived or deleted like an
  ordinary session, and the top 队长 entry stays for creating/jumping. Its terminal is
  the only manual column spawned with a full control token; `main-*` board actions are
  accepted only from that column. Columns it drives never get a control token, except a
  小队长 it opens with `new --sub-captain` (`docs/sub-captain.md`): that token reaches only
  `MainSession`'s SUB_ACTIONS, and only on sessions whose `subCaptainId` is that 小队长.
  Its children's receipts wait in `mainSession.subReceipts[id]`, never in the 队长's pending;
  archiving or closing it never ends a child, it hands them back (`releaseSubCrew`).
  Every column has a separate capability restricted to submitting its own
  complete/ask/progress commands. Nothing new
  is exposed to the page: the existing board request channel carries it.
- 自动回执入口 (`automation-core.js`, `docs/automation-receipt.md`): the only door for scheduled
  scripts that run in no AgentDeck terminal. Its own token (`board-control/automation.json`, mode
  600, never shown or logged), checked by `AutomationCore.screen` before any terminal token. It may
  tell 队长 (a notice labelled 「自动任务：名字」, never the user's words), add a 待办 card, and file a
  结果汇报; nothing else (no `new`, `tell`, read, setting, 要你处理 or alert), no extra request
  fields, rate limited, stoppable and resettable in Settings. A caller-supplied `automation` marker is
  dropped; the page honors it only from the gate's own stamp (empty `callerId`). Never let a script
  borrow the phone page, a terminal token or the user's identity.
- Captain prompt (`MainCore.instructions`, `captain-rules.js`, `docs/captain/*.md`): the pasted
  prompt is only the core (identity, red lines, one line per command, the "before X read Y"
  list), at most `MainCore.CORE_LIMIT` characters. Every other rule is in a rule file read with
  `briefing --topic <name>`; `MainCore.BRIEFING_TOPICS` and the files must match. Never drop a
  rule to make room: move it to a rule file and add its trigger. A rule the program enforces
  stays out of the core. A user's `~/.agents/captain/<topic>.md` is appended, never a
  replacement. A new model context (new Captain, clear, Relay) gets the core; an app restart
  that brings the same conversation back (`mainSession.briefed` matches) gets only
  `MainCore.restartNotice`, never the prompt again.
- Task boards (`task-board.js`, `task-heartbeat.js`): shared UTF-8 JSON in
  `~/.agents/boards/tasks`, fresh reads and atomic writes; invalid synced JSON
  is never overwritten. UI uses the fixed `TaskBoard` bridge documented in
  `docs/task-board-api.md`. A Gemini dispatcher has only one exception to the
  submission-only capability: `main-new` for its explicitly assigned card, once.
  The zero-token watcher/poll heartbeat claims only new start edges, not content
  changes or worker activity; respect durable claims and held cards. Automatic
  verification (`docs/task-board-api.md`「自动验收」) is claimed once per review round
  there too: never open a second reviewer for a round, never review with the
  executor's own provider/model family, never mark a card done without a clear
  reviewer verdict, and keep it inside the ordinary `new` queue and limits. Tests must
  use the isolated profile task store and stand-in agents, never real shared data.
- Clearing the 队长's context keeps the old chat as a `captainArchive` file under
  the old id. The 队长 column shows those read-only from the chats already loaded
  (no terminal restart, no new main-process read); they never enter its model context.
- The 队长's own terminal (the column the renderer flags `captain` to `pty:spawn`, never a worker or 小队长) starts
  with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`AgentSessions.captainEnvironment`, setting `captainAutoCompactWindow`,
  default 200000, 0/empty = not set) and its Claude launch line gets `--settings` with a PreCompact hook that adds
  `MainCore.COMPACT_NOTE` to every compaction (`captainLaunchCommand`). Nothing else gets either; a value the user
  already exports and a launch line that already passes `--settings` are left alone.
- Receipts come from authenticated worker complete/ask/progress commands and
  retain their original text and paths. Never parse screen receipt/question
  blocks. After a finished turn has waited three minutes without a command,
  report only 已结束，未提交回执. Agent crashes and quota exhaustion create failure
  receipts. A quota receipt is provisional: Claude and Codex continue by themselves
  when the limit resets, and once the terminal has visibly worked again (15 s, no
  quota wait on screen) the receipt is void: the task is working, the ledger line,
  the unread notice and the card's quota flag go (`reopenAfterQuota`). A process
  that exited, an instruction that never went in, and failures reported by the
  worker stay failed. Full output, logs and file bodies never go into the 队长's context.
  Automated tests must use the stand-in agent (`--command`); real CLI smoke tasks
  require an explicit user request and an isolated profile.
- Sleep and network interruption (`sleep-resume-core.js`, README 睡眠或断网打断): a worker
  turn that stopped at the prompt with a sleep/connection error, or that ended soon after
  the machine woke, is not 已结束，未提交回执 and not done. Wait for wake and network, then send
  one short "carry on" per spacing step, capped per episode and per task; only repeated
  failure reaches the Captain, as one `sleep` anomaly receipt. Never nudge a stopped, closed,
  interrupted or receipt-holding task, never type over a draft (`guardUserInput`), never nudge
  while asleep or offline. Tests drive the clock and the events, never a real sleep. After a wake
  `receipts --wait` must stay waiting: the registry's `wake()` restarts every listener's timer, and
  every other exit prints its reason (only app restart / ended Captain terminal / `--timeout` stay silent).
  A Claude "Not logged in" on a seat that a fresh check finds signed in is a blip, not a logout: the same
  rules carry it (evidence `login`: about a minute, one nudge); only the same error below that nudge is a
  failure receipt. A seat found signed out still gets the ordinary 未登录 receipt at once.
- Relay handoff (`relay-handoff-core.js`, `docs/relay-handoff.md`): the app rewrites
  `agentdeck-captain-handoff.md` whole from one snapshot (board cards, dispatch records,
  live sessions, unread receipts); the Captain's `agentdeck-captain-decisions.md` is only
  ever read. One record per task card, derived from the card's binding, attempt and review
  round, never from the last row of a session's records. A session ending is not a task
  finishing and not a review passing. Under the length budget only explanations shrink:
  unfinished tasks, blockers, limits and open decisions are never dropped. Pauses,
  cancellations and paused tasks waiting on the Captain (stopped, to check, hung after two
  failures) stay on the overview itself, one line each, even
  past the limit (the page then says so), and every decision-file entry keeps a line in
  `decisions-history.md`; the contents page counts what a file really lists. The briefing
  stays static; anything that changes belongs in the handoff. A `receipts --wait` that a
  newer one replaced must leave without consuming, and a Captain command past its CLI's
  deadline must not run.
- The side pane browser is a sandboxed `WebContentsView` with its own partition,
  http(s) only, permissions and downloads denied. Previews are read in the main
  process with size caps; the page never gets a raw path it did not click on.
- A previewed `.html` file runs its own scripts, so it is never put into the deck's
  page (no iframe, no `innerHTML`): it gets a second sandboxed `WebContentsView` without
  a preload, in the non-persistent `agentdeck-preview` session, served from
  `agentdeck-preview://<random>/`. Every limit is in `preview-html-core.js` and decided
  on real paths: only the open page's own folder (the page alone in a catch-all folder),
  no `file:`, no loopback or local-network address (the phone page and sync server
  listen there), nothing handed to the browser tab that the page could not fetch itself.
  Keep `tests/preview-html.test.js` and `tests/e2e/preview-html-themes.spec.js` passing.
- The preview's reading tools (`preview-reader.js`, wired in `side-pane.js`): find marks words
  with CSS highlight ranges and never rewrites a note's text; the main process watches only the
  file on screen (`preview:watch`, resolved like a click) and tells the page a number, never a
  path; ⌘F/Ctrl+F is the only key taken from a previewed page (`before-input-event`), whose find
  runs in its own view (`findInPage`). ⌘F elsewhere stays the conversation/terminal search.
  Keep `tests/preview-reader.test.js` and `tests/e2e/preview-reader.spec.js` passing.
- The Markdown reading view's extra syntax is behind `renderMarkdown`'s `rich` option:
  chat bubbles and the phone page must keep their output. Theme colours live in
  `preview-themes.js` as solid colours so the contrast test can read them; text in a
  theme is never under 4.5:1 or 11.5px, and `preview-themes.css` names no colour itself.
