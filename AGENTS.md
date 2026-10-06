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
  for text that is not AgentDeck's own.
- Screen-based completion is a quiet-output heuristic, not proof of task success.
- Do not log prompts, tokens or terminal contents. Do not commit local settings,
  session output, screenshots containing user data, keys, or installed bundles.
- Managed terminal tokens provide app-level routing, not an OS sandbox against
  programs running as the same user. Never inherit control tokens into manual columns
  (the one exception is the 队长 column, which the user creates explicitly).
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
  replay the saved output; the startup prune must keep archived ids.
- Archiving ends a terminal, so a session that is working, waiting on an answer or
  printing output is never archived, automatically or by click, and never asks first
  (`archiveColumn` shows a notice and stops). The Captain's explicit capability-checked
  `archive --id` command can end and archive a busy worker without confirmation;
  `stop --id` only sends Esc and cancels unsent supplements. Quota waits stay open
  and block automatic delivery; assigned tasks receive failure receipts with the
  provider reason. Work that cannot go in because the
  session sits on a startup dialog is reported to the 队长 once, never typed into it.
- Schedule runs only while the app is open, never fires overdue runs late at
  launch (reported as missed), and sends through the same path as the composer.
- Automatic sends go through `sendWhenReady`/`agentInForeground`: never type
  prose into a column whose foreground process is a shell (unless it is a plain
  shell column a Schedule targets on purpose). Prompts are never truncated; long
  ones go out as a file via `prompt:save-long`.
- The status lines under a chat composer are read from the rows below the TUI's
  input box; `extractReply` must keep cutting that box and everything below it.
- 队长 (main session, `main-session.js`/`main-core.js`): exactly one column with
  `isMain`, always first in the deck. Once it exists, the sidebar also shows it as
  a protected row pinned above the folders (selecting it shows its conversation);
  that row is never dragged, filed into a folder, archived or deleted like an
  ordinary session, and the top 队长 entry stays for creating/jumping. Its terminal is
  the only manual column spawned with a control token; `main-*` board actions are
  accepted only from that column. Columns it drives never get a control token;
  every column has a separate capability restricted to submitting its own
  complete/ask/progress commands. Nothing new
  is exposed to the page: the existing board request channel carries it.
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
- Receipts come from authenticated worker complete/ask/progress commands and
  retain their original text and paths. Never parse screen receipt/question
  blocks. After a finished turn has waited three minutes without a command,
  report only 已结束，未提交回执. Agent crashes and quota exhaustion create failure
  receipts. Full output, logs and file bodies never go into the 队长's context.
  Automated tests must use the stand-in agent (`--command`); real CLI smoke tasks
  require an explicit user request and an isolated profile.
- Relay handoff (`relay-handoff-core.js`, `docs/relay-handoff.md`): the app rewrites
  `agentdeck-captain-handoff.md` whole from one snapshot (board cards, dispatch records,
  live sessions, unread receipts); the Captain's `agentdeck-captain-decisions.md` is only
  ever read. One record per task card, derived from the card's binding, attempt and review
  round, never from the last row of a session's records. A session ending is not a task
  finishing and not a review passing. Under the length budget only explanations shrink:
  unfinished tasks, blockers, limits and open decisions are never dropped. The briefing
  stays static; anything that changes belongs in the handoff. A `receipts --wait` that a
  newer one replaced must leave without consuming, and a Captain command past its CLI's
  deadline must not run.
- The side pane browser is a sandboxed `WebContentsView` with its own partition,
  http(s) only, permissions and downloads denied. Previews are read in the main
  process with size caps; the page never gets a raw path it did not click on.
