# Long-standing E2E failures

Base: `release/1.1.11` / `origin/release/1.1.11` at `e6794ae`. The
remote branch was pushed after this worktree was created.

## Automatic Captain relay — product regression

`perpetual-captain.spec.js` must keep expecting CN → US → Codex in its
two-login fixture. The default configurable order is US2 → US → CN, but
US2 has no login in that fixture and is skipped. README's Captain section
and `PerpetualCaptainCore.decide` require Codex after every logged-in Claude
seat proves exhaustion, followed by a return to recovered Claude.

Commit `3d2474a` added the quota banner's Claude-only restriction to the shared
`switchSeat` validation. That inadvertently rejected automatic Codex fallback
as well. Limit the Codex exclusion to `validateRotation` (the quota banner).
The existing E2E remains the regression test for archives, handoff, worker
continuity, alerts, and the restored Claude seat; its Codex assertions stay
unchanged.

## Replacement Captain receipts — outdated test assumption

Commit `d3fb8b4` binds private credential recovery to the controlling tty,
never to a caller-supplied `AGENTDECK_TERMINAL_ID`. See README's "Codex receipt
environment" and `board-credentials.js:resolveBoardAuth`.

The spec's `cli` helper is an external pipe-based subprocess. It has no
replacement Captain tty and must explicitly supply the freshly rotated
control token on macOS as well as Windows. Use that token to receive the
pending receipt; require terminal-ID-only access to fail on every platform.
Keep rejection of old capabilities, independent-token isolation, receipt
preservation, successful replacement receipt delivery, and queue clearing.

## Account-owned statusline after reload — product race

The 83% assertion is correct: CLAUDE_SEATS.md assigns native `5h剩余` /
`7d剩余` statuslines to the session's own login, whereas the stand-in's
machine-wide Session/Weekly footer cannot override an account-bound cache.
The fallback cache in this fixture is 19%.

Renderer reload previously wrote incoming live PTY output immediately while
awaiting the surviving PTY's buffered replay. A new 83% statusline could arrive
before that older replay, which then overwrote the new screen. Depending on
subsequent redraws and the 1.5s sampling tick, the quota would remain 19% or
recover, explaining the intermittent baseline failure.

PTY chunks now carry a monotonically increasing sequence in their in-memory
buffer. The renderer requests a snapshot containing both data and its sequence,
queues live chunks until replay parsing completes, then applies only chunks
newer than the snapshot. Output already included in replay is not duplicated.
The existing string-only `ptyReplay(id)` calls keep their return type; the
renderer opts into `ptyReplay(id, true)`. Cold saved-session replay also drains
new output after its replay separator.

The quota-seats E2E holds an old replay snapshot in the isolated main process,
sends a real PTY statusline once, and releases the snapshot only after the IPC
data arrives. Its stand-in then suppresses unrelated redraws and PTY echo so
a later Captain rebrief cannot rescue a broken replay. The test requires both
the actual terminal screen and the account-bound quota to retain 83%, with the
other seat still exhausted and unchanged. Original numeric assertions remain.
The isolated test application has an owned-process shutdown fallback, matching
the Captain spec, so native teardown cannot hang the test worker indefinitely.
