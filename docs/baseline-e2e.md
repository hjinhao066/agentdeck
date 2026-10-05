# Long-standing E2E failures

Base: local `release/1.1.11` at `e6794ae` (the release branch had not
been pushed when this worktree was created).

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
