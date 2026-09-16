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
