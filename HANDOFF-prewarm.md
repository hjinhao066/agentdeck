# HANDOFF: feat/seat-prewarm (restart for 1.1.7)

Worktree: /Users/jinhao/agentdeck-seat-prewarm, branch feat/seat-prewarm.
Remote: ca3d860 (prewarm part) is pushed; the WIP commit on top (auto-continue) is pushed with this file.

## Done
- Prewarm part committed+pushed (ca3d860): forced re-sample, backoff 1/5/15 min, needs-login, usage failure reasons, "窗口已激活 ↻HH:MM". Weekly quota condition fully removed (no WEEKLY_FLOOR, no getThreshold). npm test was 553 pass.
- Auto-continue at quota wall (uncommitted before this WIP): main-core.js continuePlan/continuationPrompt; main-session.js continueElsewhere/runContinue (+ task.prompt, enqueue returns task, pump picks any seat with quota for queued continuations); quota-core.js now recognises "Usage limit reached · continuing automatically at …" (this line was NOT detected as quota before: root cause of workers sitting at the wall); docs in CLAUDE_SEATS.md/README; captain prompt line updated.
- tests/quota-continuation.test.js (8 tests) pass; npm test 561 pass.
- Findings for the receipt: (2) workers keep the seat bound at column creation, captain switch does not move them, so old-seat leftover is used by workers still running there; new workers always get config.activeClaudeSeatId = the captain's current seat (already the status quo, no code change). (3) before this work, a worker at the wall only got a failed receipt (and the CLI wall line was not even recognised); captain had to re-dispatch by hand; no per-worker seat option exists in `new`.

## E2E state
- Pre-existing failures on origin main in this Mac env (not ours): quota-warmup.spec US-seat tests (occupied seat..., official quota fields...), perpetual-captain.spec:124 (ledger command fails, hermes node path).
- Related E2E run (workers=1): captain, command-receipts, quota, quota-seats, claude-seats, task-board, seat-usage-refresh pass except flaky teardown; claude-seats:106/167 and task-board:118 pass when rerun alone.
- NEW E2E in tests/e2e/captain.spec.js ("a Claude worker at the CN quota wall carries on in the US seat") plus fake-agent flag --quota-wall-cn and a `claude` shim on PATH in launch(): currently FAILS (no US column appears). Not yet diagnosed. Next: add a temporary console.log of columns/terms state/tasks/quotas after 15s to see whether quota is detected (state 'quota'), whether continueElsewhere returns false (cmd via launchCommand wrapper, claudeSeatId, prompt), or runContinue throws (toast). Fix, or if env-specific drop the E2E and rely on the vm test.

## Next
1. Diagnose/fix the new E2E; rerun related E2E with --workers=1 (captain.spec, quota-warmup.spec).
2. npm test; commit; push; fetch/verify HEAD == origin.
3. Submit receipt with board-cli complete: answer plain-language Q2, Q3, and the switch-rule note (new workers use the new seat = already status quo; running workers are not interrupted and hop seats on wall = new this time). Do not merge main / package / install / restart.
