# AgentDeck

A Windows/macOS multi-column terminal app for running AI agents side by side.
Each column has its own shell, output history and input. The Conductor Board
adds explicit task relationships without taking control of manual terminals.

## Desktop notifications

Notifications are built into the app on both platforms. No PowerShell popup
script, watch-ai daemon, or OS notification permission is needed.

- A permission/input prompt shows a persistent popup. Completed output shows a
  popup after at least 12 seconds of stable idle state and no further PTY output.
- Works for Claude, Codex, Grok, Antigravity and manually launched agents. Screen
  detection is heuristic: a silent tool can look idle, and unknown prompt formats
  may be missed. The popup intentionally says output stopped, not task succeeded.
- Popups stay above ordinary windows without stealing the keyboard. Multiple
  columns share a scrollable stack; close a card to dismiss it.
- Click a card to restore AgentDeck, leave Board view, scroll/re-zoom to that
  exact terminal, and focus its input. A deleted terminal never redirects to an
  unrelated column. Resumed work retracts its obsolete popup.
- The app must be running. macOS Spaces/fullscreen visibility is requested; OS
  secure desktops and other OS restrictions can still cover ordinary app windows.

Legacy watch-ai screen dumps are off by default (also avoids plaintext screen
copies). Set `AGENTDECK_LEGACY_WATCH=1` only when deliberately using that bridge.
If an existing Claude hook independently displays popups, skip that hook's popup
when `AGENTDECK_NATIVE_NOTIFICATIONS=1`; leave hooks in other terminals unchanged.
For the known Windows `~/.claude/hooks/claude-popup.ps1`, run
`node scripts/migrate-popup-hook.js` once. It backs up and adds only this guard.

## Development and builds

Use Node.js 22.12+ or 24 LTS and `npm ci`. node-pty 1.1 includes Node-API binaries
for Windows x64/arm64 and macOS x64/arm64, so those platforms do not require a C++
toolchain for ordinary installs. `npm run rebuild` is an explicit source-rebuild
fallback and requires the appropriate compiler toolchain.

```sh
npm test
npm run test:e2e
npm audit
npm start
npm run dist:win
npm run dist:mac
```

Mac distribution uses the local `AgentDeck Dev` signing identity. On a CI host
without that certificate, use `CSC_IDENTITY_AUTO_DISCOVERY=false` and
`npx electron-builder --mac --config.mac.identity=null --publish never`.
CI builds are unsigned and not notarized; they are not equivalent to a signed
local installation. Windows CI produces an NSIS installer.

Test a packaged app with `AGENTDECK_TEST_EXECUTABLE` set to its executable before
running `npm run test:e2e`. Tests use temporary userData and empty shell columns,
never the real layout or live agent sessions.

Security boundaries: the renderer is sandboxed with a restrictive CSP and no
Node integration. Main IPC accepts only the deck's local main frame. Session
identifiers are validated before file access. Session replay is capped at 200k
characters per column and written atomically. Local processes running as the
same OS user remain trusted; the board token is not an OS security sandbox.

AI contributors must follow [AGENTS.md](AGENTS.md), including immediate commit
and GitHub synchronization after every completed change.

See [CONDUCTOR_BOARD.md](CONDUCTOR_BOARD.md) for managed task operations.
