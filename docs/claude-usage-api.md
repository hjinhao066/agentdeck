# Claude seat usage and Relay

Claude quota percentages are **remaining**, everywhere: sidebar, collapsed-sidebar
quota popup, tooltip, and `board-cli quota`. For example:
`5h 91% ↻02:50 · 7d 90% ↻10-07 03:00`; an exhausted window shows
`5h 已用尽 ↻00:09`. Times use the OS local timezone; weekly resets include month/day.
Refresh is an icon with a tooltip and accessible name. Dark/light warning colors
are chosen for readable contrast on the sidebar.

On macOS the main process reads each seat's separate Keychain service and sends
`GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`.
CN's default service is `Claude Code-credentials`. Other services append the first
8 hex characters of SHA256 of the absolute normalized configuration directory.
No token crosses IPC or enters config/cache/logs. The reader never logs a raw
exception or HTTP response, runs login/logout, or prints a credential. Requests
refuse redirects and time out after 8 seconds. When the stored access token is
expired and the refresh token is still in date, the reader posts one refresh to
`https://platform.claude.com/v1/oauth/token` and writes the rotated credential
back to that seat's Keychain item (macOS, secret on stdin) or credential file.
A refresh that fails leaves the previous usage sample untouched. An idle seat
therefore stays queryable after Claude itself has exited.

Sampling happens on startup, about every five minutes, refresh-button clicks, and
new CLI exhaustion observations for the affected seat. Concurrent requests for a
seat share one in-flight query. Failures leave previous numbers and their sample
time intact, and include a safe failure reason. After three consecutive failures,
the last successful API remaining percentages and reset times stay visible,
alongside the original sampling time and `数据已旧`. Screen/local fallback cannot
replace these values or stamp a redraw as a fresh API sample. Reset timestamps already
passed are marked as awaiting a new sample; this does not invent a new window.
Isolated Electron test profiles never query real Keychain entries or the API.
Windows uses the existing per-directory credential-file reader and bound cache/screen sources.

## Stable integration fields

The existing store is `config.quotas['Claude:<seatId>']`, e.g. `Claude:cn` / `Claude:us`.
Its `sample.windows` contains:

| Field | Meaning |
| --- | --- |
| `key` | `fiveHour` or `weekly` (choose by key, never by array position) |
| `used` | Percentage **used**, 0–100, directly from API `utilization` |
| `remaining` | Percentage **remaining**, 0–100: `100 - used`, rounded to 0.1 |
| `resetAt` | Absolute Unix milliseconds, parsed from API `resets_at` |
| `resetText` | ISO timestamp, retained for older adapters |
| `exhausted` | `used === 100`; use `resetAt` to determine whether that sampled window has ended |
| `label` | Display label `5 小时` / `每周`; not an integration key |

Sample metadata: `at` is the last **successful** sample's Unix milliseconds;
`source` is `Claude OAuth usage`; `confidence` is `高（服务端采样）`; `official` is true;
`seatId` and `configDir` identify the configured seat. `accountKey` is the
profile account-ID fingerprint (with the existing email migration fallback).
The account and directory are verified again after a request and before cache
writes or sample publication. Unbound or mismatched samples remain unknown.

`officialStatus.failures`, `.checkedAt`, `.failure` live beside `.sample` on the
store entry. `checkedAt` is the last attempt's time; never use it as sample time.
A new successful API sample sets failures to zero and rebuilds numeric exhaustion
from the new windows. Genuine CLI exhaustion stays latched until its reset or
an explicit resume observation. `blocked.resetAt` is the latest reset of
exhausted windows (both windows must recover before a seat is usable).

Compact statusline `5h N%` / `7d N%` values mean remaining; they are never
interpreted as used. `Session:` / `Weekly:` legacy used-percent cards and native
`% used` cards keep their explicit used semantics. Configured seats still reject
shared/unbound footer numbers.

For captain switching/preheating, read
`sample.windows.find(w => w.key === 'fiveHour').remaining` and `.resetAt`, with
`sample.at` and `officialStatus` as freshness context. A stale retained number
must not be treated as proof of availability after its reset time.

## Relay authentication boundary

Each PTY is bound to its seat's credential service at birth. CN clears
`CLAUDE_CONFIG_DIR`; US sets the absolute directory before creating the shell.
Inherited OAuth/API overrides are cleared. The launch wrapper reasserts the seat
after shell profiles, so Claude (and its child daemon) selects storage/socket
namespace from the intended configuration directory before startup. This checks
the launch environment; it does not inspect an already running daemon socket. AgentDeck
never reconfigures an already started Claude daemon or copies its tokens.

A legacy spawn without a seat ID resolves the configured active seat. Repeated
spawns only reuse a PTY with the same credential binding. Renderer reconnection
also checks that binding, so changing a seat/directory replaces a stale process.
Relay keeps its existing durable checkpoint/new-column behavior. Config writes
are flushed before the spawn IPC to avoid racing recently edited seat settings.

Valid Keychain OAuth credentials work even without profile email metadata. An
expired access token with a refresh token is still treated as logged in. The
usage reader refreshes that token itself so an idle seat does not depend on a
running Claude process. Missing credentials, malformed credentials, or an
expired access token without a live refresh token give a seat-specific login
reason. A locked or unreadable Keychain gives a verification/access-permission
reason, not a login instruction. An API network/401/403 failure only affects
usage sampling.

This branch does not restart installed AgentDeck or migrate running terminals.
These process-binding fixes take effect when the new runtime is installed and
columns are next spawned/reconnected.

## Focused verification

Function branches run the affected specs with one worker, after any release-test
load gate has cleared; they do not run the full E2E suite:

```sh
npx playwright test tests/e2e/claude-usage-api.spec.js tests/e2e/quota.spec.js tests/e2e/quota-seats.spec.js tests/e2e/claude-seats.spec.js --workers=1
```

The screenshot fixture uses an explicit empty-command column, so it cannot fall
back to the app's default real agent launchers. Quota detail appears when its item
receives focus, including after a mouse click on refresh, and remains accessible
from the keyboard. Isolated profiles do not read real credentials or query usage.
