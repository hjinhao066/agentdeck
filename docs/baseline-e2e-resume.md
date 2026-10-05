# Restart checkpoint — fix/baseline-e2e

Worktree: `/Users/jinhao/agentdeck-baseline-e2e`.
Base: local release/1.1.11 e6794ae, authorized after origin ref was found absent.
Do not touch primary worktree or agentdeck-1.1.11. Dependencies are a local
symlink to agentdeck-1.1.10/node_modules (Electron44.4.1/Playwright1.63.0).

Committed and pushed: 955c328 fixes automatic Codex rejection and tty-bound
replacement capability test. Current WIP includes strict stderr diagnostics,
quota temporary failure diagnostics, and root-cause notes in baseline-e2e.md.

Validation:
- npm test: 816 total, 803 pass, 0 fail, 13 pre-existing skips. Output persisted
  at /tmp/agentdeck-baseline-unit.log.
- First targeted single-worker run: captain Codex fallback reproduced expected
  chatgpt/actual us; effort external pipe capability reproduced exit1; other
  five captain cases and quota-seats strict83% passed (6 pass/2 fail).
  Caveat: spec loaded before effort edit, and captain Electron launched before
  product fix. Failure source line mappings reflect later edits.
- Second targeted single-worker run after fix: first3 captain cases passed,
  including full CN-US-Codex-restored-CN path. Rest interrupted at restart
  checkpoint. Task test processes were stopped by owned PID/descendant list.
- gh run list for branch: no CI runs; verify workflow triggers main/PR and
  runs full E2E+packaging, which user prohibits for this task. Do not trigger it.

Next:
1. Finish effort validation with strict code=0 diagnostic stderr message.
2. Investigate quota-seats83% historical failure; strict expectation is correct
   per CLAUDE_SEATS.md/session-owned footer design. It passed once under clean
   environment, so root cause is unresolved. Temporary catch prints only
   isolated fake-profile diagnostics; remove before final delivery.
   Candidate from investigation: after page.reload, renderer reconnect awaits
   ptyIsAlive/ptyReplay. Cache quota assertions can pass before reconnect finishes;
   statusline input/new data may precede old replay and get overwritten by it.
   Inspect pty:data/reconnect ordering and create controlled reproducer.
   ChatUI default global mode is terminal; updateAgentIdentityBadge already calls
   ChatUI.readFooter in terminal mode, so do not "fix" missing footer mode handling.
3. Run only npm test and directly relevant E2E specs, all E2E --workers=1.
   Always strip inherited AGENTDECK_* and ELECTRON_RUN_AS_NODE only in child test
   process; retain outer shell credentials for progress/complete commands.
4. Complete docs, commit/push, verify remote SHA, submit board CLI complete with
   absolute comma-separated paths. No main merge/package/install/live restart.

Sub-agent findings: effort obsolete supplied terminal-ID recovery assumption;
actual private-file recovery is controlling-tty-only (d3fb8b4). Quota remains
unresolved (no product/spec behavior changes), candidate replay race above.
