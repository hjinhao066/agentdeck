# HANDOFF: feat/seat-prewarm

Worktree: /Users/jinhao/agentdeck-seat-prewarm (branch feat/seat-prewarm, from main e63bd38). No source changes yet; only reading and diagnosis done.
node_modules is a symlink to ~/agentdeck/node_modules (gitignored).

## Findings
- An idle-window warmup already exists on main: quota-warmup-core.js, quota-warmup-service.js, quota-warmup-main.js, quota-warmup-occupancy.js. Settings toggle `quotaWarmup.enabled` (default on, icon button) is in claude-seats-ui.js. Docs: CLAUDE_SEATS.md "额度窗口预热", README. Plan: extend it, do not build a parallel feature.
- It already does: fire ~60s after a proven 5h reset, only if the seat is unoccupied, weekly above threshold, once per window, 1 retry after 60s, state in quota-warmup-state.json.
- Gaps against the brief: (a) no forced usage refresh before deciding, so stale/unknown data is not re-sampled; (b) failure backoff is fixed 60s with max 2 attempts, and a logged-out seat is not flagged or kept quiet; (c) weekly floor is the rotation threshold (3%), no named constant or rationale; (d) panel text says "已预热 · 下次重置 xx:xx", brief wants "窗口已激活 ↻HH:MM"; (e) no tests for several conditions listed in the brief.
- US usage-query failure, cause found by one real GET on the US seat (read-only, 2026-10-04): quota-claude.js officialUsage() throws 'invalid-usage' unless BOTH windows have utilization and an absolute resets_at, and readCredentials() rejects an expired accessToken with no refresh path. So after a window resets on an idle seat, or once its access token expires with no live claude session, the query fails and createRefresh keeps the old sample ("用量查询失败，等待 Claude 刷新凭据"). This sample showed five_hour with utilization 0 and a resets_at, so the "null window" theory is not confirmed from that single sample; expired token on an idle seat remains the most likely cause. Only a claude run on that seat refreshes the token.
- That one real request is the allowed manual test budget for the GET; no real `claude -p` has been run.

## Next
1. Write failing unit tests first (tests/quota-warmup*.test.js), then extend quota-warmup-core/service: forced refresh before deciding, FAILURE backoff (exponential, capped), not-logged-in flag with no retry, named WEEKLY_FLOOR constant with rationale, unknown stays no-op.
2. After the warmup request, force a usage re-sample (claudeQuotaRefresh.tick({force, seatId})) so the refreshed credentials are used.
3. Panel/quota command text: "窗口已激活 ↻HH:MM" (claude-seats-ui.js warmupDetail, and the quota command).
4. Update CLAUDE_SEATS.md and README; run npm test, then quota-warmup.spec.js with --workers=1; push; send the receipt with board-cli complete.
