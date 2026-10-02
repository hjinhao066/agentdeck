# AgentDeck contributor instructions

Applies to all AI tools and all files in this repository, on Windows and macOS.

## Synchronization is part of every task

1. Before edits, run `git status --short --branch`, `git fetch origin`, and inspect
   incoming changes. Fast-forward a clean branch before working. Preserve other
   people's uncommitted files; never reset, clean, or force-push over them.
2. Read this file, `README.md`, and the relevant implementation and tests. Both
   platforms share this repository; do not create divergent Windows/Mac copies.
3. Implement the complete change and add regression tests for meaningful bugs.
   Run `npm test`, `npm run test:e2e`, and `npm audit` before delivery. Run the
   packaged E2E suite when runtime, preload, native modules or packaging changes.
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
  frame and payloads. Notification windows have their own minimal bridge.
- Notification arrival does not steal focus. A click restores the main window,
  reveals the exact column and focuses its input: the composer in chat mode,
  the xterm textarea in terminal mode. Stale IDs never fall
  back to another terminal. Retract obsolete notifications and deduplicate turns.
- Screen-based completion is a quiet-output heuristic, not proof of task success.
- Do not log prompts, tokens or terminal contents. Do not commit local settings,
  session output, screenshots containing user data, keys, or installed bundles.
- Managed terminal tokens provide app-level routing, not an OS sandbox against
  programs running as the same user. Never inherit tokens into manual columns.
- Chat view: the xterm of a chat-mode column stays mounted (hidden, never
  `display:none`) so PTY size, status dots and notifications keep working. Bubbles
  hold only the user prompt and the agent's final reply. Left/right swipe between
  columns is the core interaction; do not change the deck wheel or scroll code.
- Saved conversations live in `userData/chats` (private, never committed, never
  pushed to this public repo). Any cloud sync must target a separate private repo.
- The side pane browser is a sandboxed `WebContentsView` with its own partition,
  http(s) only, permissions and downloads denied. Previews are read in the main
  process with size caps; the page never gets a raw path it did not click on.
