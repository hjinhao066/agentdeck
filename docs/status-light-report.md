# Status light regression (1.1.1)

Base: `origin/release/1.1.0` (`18ed8b7`), branch: `fix/status-light`.

## Cause and change

The renderer already polls every column every 1.5 seconds, including backstage
and unfocused columns; `backgroundThrottling` is already disabled. The old loop
classifies `dumpScreen(term)` (last 40 terminal rows), then searches only the last
15 rows for general busy indicators and the last 20 for `terminalActivity`.
A live Codex `Working (11m 27s • esc to interrupt)` above a tall/wrapped input or
footer is therefore missed. Two idle ticks turn the dot green. Focusing/refitting
can move the indicator back into that tail. The regression reproduces this
failure with a silent, unfocused stand-in PTY; the original user's screen/buffer
was not captured, so its exact geometry was not physically verified.

Classification now reads the entire active terminal screen (`baseY` and `rows`),
independent of the reader's scroll position or focus, joining xterm wrapped rows.
It recognizes Codex Working, Claude interrupt/thinking spinners, Gemini/agy timed
cancel/thinking spinners and Cursor stop/thinking/responding indicators. A busy
indicator beats quiet output and generic waiting prose. It excludes scrollback
and replayed output; ordinary prose, idle thinking settings and completed Claude
`Baked for …` lines do not count. The existing debounce still turns genuine
completion green. Reply/history extraction retains its existing bounded dump.

## Receipt listener inspection (no separate receipt change)

There is a shared false-fallback path. `ChatUI.onTick` refuses to finish a turn
while `entry.state` is working; if classification incorrectly becomes done, quiet
output can instead finish the turn. `MainSession.onTick` then starts its three-
minute no-command grace period for a finished turn in done state, ultimately
emitting `已结束，未提交回执`. Its secondary `terminalActivity(lastScreen)` guard
only scans the last 20 rows and recognizes Doing/queued messages, not Codex
Working, so it cannot rescue the reported Codex case. A focus/refit can cancel
the grace period by restoring working before expiry. Process-ended tasks have a
separate legitimate path. The listener and turn-finalization code are unchanged;
correct status now keeps quiet busy turns open and resets the grace period.

## Validation scope

Final results on macOS source: `npm test` **218 passed**; related source E2E
**21 passed** (status-light, command-receipts, notifications and scroll-peek);
`npm audit --audit-level=high` **0 vulnerabilities**. Tests use isolated temporary
profiles and stand-in agents and close only the Electron instance they launched.
`npm audit` is included. No full E2E, packaged E2E, real-provider smoke task,
package build, installation, app restart, merge or physical Windows verification.
Branch pushes do not trigger the repository's main-only verify workflow;
Windows/macOS CI for this commit has not been run.
