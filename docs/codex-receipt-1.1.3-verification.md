# Codex receipt verification on 1.1.3

Verified on macOS on 2026-10-04, from a new worktree and branch
`fix/codex-receipt-1.1.3-verification`, based on fetched main `2d58205`
(`package.json` version 1.1.3).

## Previous attempts

Both previous worktrees were clean and their changes are already merged into
main and the `v1.1.3` tag (`97de1ed`):

- `agentdeck-codex-receipt-env`, `fix/codex-receipt-env`: `8ab0dc6`
  restores the per-column receipt environment across launches and restores.
- `agentdeck-codex-receipt`, `fix/codex-receipt-credentials`: `d3fb8b4`
  binds private credentials to the actual PTY, prefers that identity over stale
  daemon environment tokens, and uses the slave path before `ps` reports a TTY.
  Its final commit `ee281c6` handles PTY startup/quit cleanup.

`git merge-base --is-ancestor` returned 0 for each of these three commits
against both main and `v1.1.3`. The receipt CLI, credentials resolver and Codex
launch normalization files are unchanged between the tag and this branch's base.

## Finding

The original failure path is already fixed for fresh 1.1.3 launches: a shared
Codex daemon could retain its own environment instead of the current column's
CLI path and receipt token. Launch normalization now adds `--no-daemon` to
default, custom and restored Codex commands. The managed bridge can also recover
credentials from its own profile using the caller's controlling TTY when
environment variables have been filtered.

Added one regression spec that launches a Codex-shaped stand-in in a real
AgentDeck PTY, removes every `AGENTDECK_*` variable only from the spawned CLI
child, invokes the profile's managed bridge, and verifies the exact `complete`
summary in the worker, task and Captain's `receipts` output. This joins the
previous separate tests for TTY auth and environment-authenticated completion.
No production code change was needed.

This fallback requires actually invoking the managed bridge: `node ""` cannot
recover a missing CLI path. Already-running Codex sessions also keep their old
launch mode until relaunched; the installed app and existing sessions were not
changed during this task. The POSIX TTY fallback spec skips Windows; Windows
receipt submission continues to use inherited environment capabilities.

## Validation

Only the affected unit files and corresponding specs were run, with one worker:

```sh
node --test --test-concurrency=1 tests/board-credentials.test.js tests/board-cli.test.js tests/board-core.test.js tests/command-receipts.test.js tests/launchers.test.js
node node_modules/@playwright/test/cli.js test tests/e2e/command-receipts.spec.js tests/e2e/launchers.spec.js --workers=1
```

All 53 unit tests passed. The unmodified baseline specs passed 17/17, and the
new filtered-environment PTY case passed independently (1/1).
The final run of both specs, including that case, passed 18/18 in 52.9 seconds.
All Electron tests use temporary profiles and stand-ins, without real Codex
account calls. No installation, packaged build, restart of the active app, or
full E2E run was performed.
