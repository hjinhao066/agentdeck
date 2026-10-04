# AgentDeck 1.1.4 integration checkpoint

Integration branch: `release/1.1.4`. Base: `origin/main` at `2d58205`.
The runtime version remains `1.1.3`; this checkpoint does not publish a release.

## Delivered branches

The inherited worktree was clean at `9eca98b`, already synchronized with GitHub.
All eight requested branch tips are ancestors of that commit, merged in order:

| Branch | Delivered tip | Merge commit | Resolution |
| --- | --- | --- | --- |
| fix/cursor-status | 190db85 | c99c048 | No recorded manual conflict |
| fix/quota-chatgpt-grok | 1d34436 | 140fda3 | No recorded manual conflict |
| fix/web-login-copy | 3fb69b4 | 041cc0f | No recorded manual conflict |
| feat/progress-drawer | 5b94844 | 37e0a80 | No recorded manual conflict |
| feat/arch-scifi | 2146480 | c3b1255 | No recorded manual conflict |
| feat/crew-grouping | e030b8c | 275a70d | No recorded manual conflict |
| feat/chat-redesign | 6619b51 | b3302d0 | No recorded manual conflict |
| feat/hermes-entry | ba1f9c5 | 9eca98b | Keep crew grouping exports and add HERMES_HUB_URL in sidebar-core.js; remove the worker's HANDOFF.md |

`ccd69eb` adds both requested regression cases: ledger status follows the live
terminal without a command receipt, and the full `→ … ctrl+c to stop` input row
means busy for every provider. The full unit suite covers these cases and the
individual feature suites.

The four pending deliveries (`fix/task-move-quota-dispatch`,
`fix/cursor-claude-ready`, `feat/quota-panel`, task board v2) were not integrated.
No `feat/three-ends-*` delivery was integrated.
The revised cursor-claude-ready tip `7629479` supersedes `33cd755`, but remains
held until the Captain confirms its re-verification passed.

## Integration corrections

- Ordinary archive rejects recent output for one minute. Chat history and
  workspace archive tests now wait for this real precondition rather than
  archiving immediately after a reply. They keep the archive guard enabled.
- The workspace test waits for a newly mounted column's initial focus before
  switching it to chat, so initial terminal navigation cannot race its click.
- Rename, remove-link, Schedule delete/edit and Skills refresh use icon buttons
  with tooltips, accessible names, 32 px targets and visible keyboard focus.
  Page close and side-pane close/refresh also have accessible names.

The shared `main.js` shutdown handler from chat-redesign applies to every spec:
`before-quit` flushes output, closes PTYs and removes credentials; `will-quit`
calls `app.exit(0)` followed by `process.exit(0)`. Both direct
`application.close()` and the `closeElectron` helper completed in the executed
batches without an afterAll/afterEach exit timeout. Chat and Captain tests also
verified persistence through isolated quit/relaunch.

## Validation on macOS

All E2E batches ran sequentially with `--workers=1`, temporary profiles and
stand-in agents. The first A–H logs came from the inherited, still-running
batch script; it was allowed to finish before starting another batch.

| Batch | Specs | Actual result |
| --- | --- | --- |
| A | status-light | 6 passed |
| B | captain | 24 passed |
| C | quota, mobile-web | 9 passed, including both desktop login copy buttons through preload/main |
| D | captain-row, version-label | 3 passed, 1 optional screenshot skipped |
| E | sidebar-captain, sidebar-title-one-line, hermes-entry | 11 passed, 1 optional screenshot skipped |
| F, initial | chat-redesign, chat | 20 passed, 1 archive-precondition failure |
| F, corrected | chat | 15 passed |
| G | crew-map-scifi, crew-map, crew-map-projects | 10 passed |
| H | crew-map-acceptance | 2 passed |
| I | captain-row, chat-redesign, crew-map-scifi with screenshots enabled | 10 passed; includes D's previously skipped screenshot case |
| J, initial | skills, workspace | 14 passed, 2 precondition failures |
| J, corrected | workspace | 11 passed; Skills' 5 cases already passed in the initial J batch |
| K | npm run test:smoke | 8 passed in 1.4 minutes |

Unit tests passed **493/493**, with no skips or failures.
Repeated tests in these batches are not additional independent coverage.
The final outcomes cover 106 distinct passing E2E cases; Hermes' optional
screenshot-only case was not enabled. Initial failures are retained in the logs.

Screenshot and log root: `/Users/jinhao/reports/agentdeck-1.1.4/`.
Images use synthetic fixture conversations and isolated task boards, not the
active app's sessions or private task store. Full-window dark/light images:

- `drawer/version-progress-dark.png`, `drawer/version-progress-light.png`
  show sidebar, architecture map, version drawer and quota block together.
- `chat/chat-redesign-dark.png`, `chat/chat-redesign-light.png` show the chat page;
  `chat/*-expanded.png` show expanded work and changed files.
- `architecture/final-{dark,light}-{1440,1920}.png` show the multi-project map.

Visual review found no overlap between the sidebar, map, drawer, quota block
or chat content in these fixtures. Missing quota data is displayed as unknown;
live quota data and login clipboard behavior have separate functional coverage.

No CI runs exist for this release branch: the current workflows trigger on
main, pull requests, tags or manual dispatch. The available dual-platform
workflow packages apps, so it was not dispatched under the no-packaging rule.
Windows physical-device verification and full/packaged E2E remain unperformed.
No version bump, tag, package, merge to main, installation or restart of the
active AgentDeck was performed.
