# 0.8.0 review

Reviewed the shared Windows/macOS main process, renderer, preload, board core and
CLI, notification/state flow, dependencies and packaging. This is a code review
and regression pass, not a penetration-test certification.

## Fixed

| Finding | Change |
|---|---|
| Electron 30 and vulnerable build dependencies | Electron 44.4.1, current locked builder/rebuild dependencies; npm audit reports zero known advisories after update |
| Privileged IPC lacked origin/frame checks | Main-window identity, exact local URL and main-frame checks on every deck channel; popup gets a separate minimal bridge |
| Navigation/popups could leave the trusted local page | Deny navigation, new windows and webviews; explicit sandbox; restrictive CSP; deny unneeded permissions |
| Terminal IDs reached filesystem paths without checks | Shared safe-ID validation rejects traversal, Windows special paths and control characters |
| A giant PTY write bypassed the replay cap | Enforce the 200k-character bound on individual chunks too; atomic session writes |
| Nested AgentDeck could inherit a managed capability into a manual terminal | Strip inherited board capability environment before granting a fresh token |
| Board request processing had unbounded file reads and pending queue | 64 KiB/file, regular-file checks, filename/request-ID matching, 64 files/tick and 256 pending requests; private Unix control directory |
| Prompt fragments were written to a temp log | Remove prompt/title logging; cap title cache, pending title requests and CLI output; drain stderr |
| External popup scripts added process overhead and platform gaps | One sandboxed notification window for both platforms; cancel/dedupe by terminal; no extra PowerShell process per event |
| Background Chromium throttling delayed screen checks | Keep the deck renderer timer active while hidden/minimized |
| Tall terminals omitted the only real output | Ignore trailing empty viewport rows before extracting the last 40 content lines |
| Input-method scroll guard reversed explicit column navigation | Explicit navigation bypasses the guard, scrolls first, then focuses input |
| Stale notification IDs selected another terminal | Report the stale target and leave the current terminal unchanged |
| Windows editor .cmd launch failed and async errors could crash | Encoded, literal-quoted PowerShell launcher and handled child-process errors |
| Continuous watch-ai dumps duplicated notifications and disk writes | Disable legacy spools by default; preserve explicit opt-in compatibility |

## Remaining boundaries

- A terminal intentionally runs arbitrary commands as the logged-in OS user.
  Board tokens restrict app routing, not another same-user process reading files
  or inspecting processes. Use OS isolation for untrusted agents.
- Existing agent commands that bypass their own permission prompts are preserved.
  AgentDeck does not make those agents a security sandbox.
- Automatic titles retain the existing provider behavior: OpenRouter when its
  local key exists, otherwise the Claude CLI, then a local fallback. Up to 400
  characters of submitted text may be sent to that configured provider.
- Session replay stores recent terminal output locally, which can contain user
  data. It is bounded and uses private Unix permissions, but is not encrypted.
- Generic AI completion remains heuristic. Silent tools and new TUI designs can
  produce early or missed notifications; resumed activity retracts stale cards.
- macOS CI artifacts are unsigned/unnotarized without the owner's certificate.
  Local Windows tests cannot prove behavior on the owner's physical Mac.

## 队长 (main session) and Schedule (0.9.0)

- 队长 can type into every column, including manual ones. That power sits only in
  the column the user created from the sidebar: its terminal is the one manual
  column spawned with an in-memory board token, `main-*` actions are rejected for
  any other caller, and the columns it drives never receive a token. No new IPC
  channel or Node capability reaches the page.
- `answer` sends only y, n, 1-9, Enter or Esc, and only to a column that is
  currently at a confirmation prompt; `tell` refuses such a column. The 队长 is
  instructed to escalate irreversible decisions to the user, but it is an agent
  following instructions, not an enforced policy.
- Workers it opens use the same launch command as the 队长 (Claude: bypass
  permissions, by user request). They run unattended with that agent's own power.
- Receipts are short fields parsed from the worker's final reply and capped in
  length; no full output, log or file body is copied into the 队长's context.
- Schedule types prompts only into sessions the user picked, only while the app
  runs, and never fires runs that were due while it was closed.

## Web page preview in the side pane

- A previewed `.html` file is untrusted content that runs scripts. It never enters the
  deck's own document: it is loaded in a separate sandboxed `WebContentsView` (no
  preload, `nodeIntegration` off, `contextIsolation` on, no `<webview>`) in the
  non-persistent `agentdeck-preview` session, from `agentdeck-preview://<128-bit random>/`.
  That scheme is answered only by this session's handler and only for the page open now.
- Files: the folder the page lies in, on real paths (`..`, encoded dots, backslashes,
  absolute paths, symbolic links leading out, hidden files, key and credential names and
  non-web formats are refused). A page in the home folder, one level below it, a drive
  root or the temporary folder gets only itself.
- Network: `file:`, loopback, private and link-local addresses, single-label and
  `.local`-style names, and every scheme but public `http(s)` are cancelled in the
  session's `onBeforeRequest`. Permissions, downloads, dialogs (`alert`, `confirm`) and popups are denied; navigation
  stays on the page's own address; only a public web link is passed to the browser tab.
- Remaining boundary: the check is on the host name, so a public name that resolves to a
  local address (DNS rebinding) is not caught; the same holds for any page in the browser
  tab. A page can send what it can read (its own folder) to the public web.
- Reading tools: the file watch is set only on a path resolved like a preview click
  (`resolveClick`), one file at a time, and reports a counter, not a path. Find in a page
  passes only the typed words (at most 200 characters) to Chromium's find in the page's
  own view; the page's `before-input-event` takes only ⌘F/Ctrl+F and passes nothing it
  typed. Find in a note marks text with highlight ranges and writes no markup.

## Skills page

- The page lists, reads and saves skills over three handle channels behind the
  same main-frame check. It never sends a path: it gets opaque keys from the
  listing, and the main process re-resolves the real path on every read and
  write, requires it to be an existing regular `SKILL.md` up to 1 MB inside the
  skill root it was listed under, and rejects it if a link or the root moved.
- Links out of the skill roots are listed as blocked, not crawled, read or
  written. Plugin install paths outside the tool's plugin folder are skipped.
- Writes go to a temporary file in the same folder and are renamed over the real
  file, keeping its mode; symlinks pointing at it are left alone. A content hash
  from the read must still match, otherwise the save is refused as a conflict.
  The main process refuses binary, non-UTF-8 and hard-linked files itself, not
  just the page. After the temp file is written and the hash checked again, the
  path, root and link count are re-checked right before the rename.
- A `--test-user-data` profile scans `<profile>/skills-home`, never the real
  home folder.
- Skill text is rendered with the same sanitizing Markdown renderer as chat
  bubbles and is never typed into a terminal.

## Validation

- Unit tests: board ownership/CLI plus notification timing, repeated turns,
  input cancellation, traversal, IPC provenance and large replay chunks.
- Real Electron E2E: five PTYs, popup click to offscreen column, real keyboard
  input, minimized window, zoom, Board view, multiple cards, injection-safe text,
  cancellation, stale targets and restricted popup APIs/navigation.
- Run the same E2E suite against packaged binaries to catch missing ASAR files
  and native-module packaging regressions.
- GitHub Actions verifies Windows and macOS and packages Windows plus both Mac
  CPU architectures. Physical-device update status must be reported separately.

Reference: [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Captain-only native notifications (feat/captain-notify)

- Removed the notification BrowserWindow and its separate renderer/preload.
  Notification IPC keeps the main-frame origin check and rechecks the target's
  `isMain` flag against the current saved configuration. Non-Captain alerts are
  rejected even if an outdated renderer sends them.
- Per-turn deduplication and sound cooldown are enforced in the main process.
  Notification text is plain text, reduced to one sentence and 60 Unicode
  characters. Native click callbacks cannot redirect a cancelled alert.
- macOS audio uses `execFile` with fixed `/usr/bin/afplay`, fixed volume/duration,
  and a two-value system-sound whitelist; no prompt text becomes shell code or
  a sound path. Test profiles replace notifications/audio with recording doubles.
- watch-ai spool production is disabled even with the old opt-in flag; known
  external hooks still receive the existing native-notifications environment guard.
  macOS native banners require OS permission and a signed executable, which
  source E2E with notification doubles does not verify.
