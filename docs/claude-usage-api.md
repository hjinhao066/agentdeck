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
expired and the refresh token is still in date, the reader renews it **only when no
Claude runs on that seat**: a CLI on the seat renews its own token, and a second writer
racing it for one Keychain item can sign that CLI out. The check is the quota warm-up's
process inventory (AgentDeck's own Claude columns, including an idle Captain, and
registered external sessions; anything it cannot place counts as busy). Renewal and
AgentDeck starting a Claude on the same seat (a column's launch line, the warm-up's run)
are serialized per seat, and the credential is read again inside that lock. The reader
then posts one refresh to `https://platform.claude.com/v1/oauth/token` and writes the
rotated credential back to that seat's Keychain item (macOS, secret on stdin) or
credential file. With a Claude running on the seat the expired token is only read and
the seat's numbers are 未知 until that session renews it. A refresh that fails leaves
the previous usage sample untouched, so an idle seat stays queryable.

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
expired access token with a refresh token is still treated as logged in; the reader
renews it when no Claude runs on the seat (above), otherwise its usage reads as 未知.
Missing credentials, malformed credentials, or an
expired access token without a live refresh token give a seat-specific login
reason. A locked or unreadable Keychain gives a verification/access-permission
reason, not a login instruction. Network, permission and ordinary usage-query
failures keep login state unknown. An official HTTP 401 or OAuth `invalid_grant`
is an explicit authentication failure and participates in logout confirmation.

## Seat logout alerts

The main process watches actual quota/account polls for a transition from a
previously working login to **confirmed 未登录**. Claude uses its configured
seat directory and credential service: missing credentials, expired access
without a usable refresh token, rejected refresh, or an official 401 are logout
proofs. Two proofs at least 30 seconds apart confirm the outage. After the first
proof, an extra check runs after 30 seconds; network/permission/ordinary query
failure breaks the consecutive confirmation. An authenticated failed worker
receipt (including a process failure receipt) mentioning `Not logged in` or
`未登录` only triggers a fresh provider check; the text itself never counts as
either confirmation, including GitHub/login-related failure prose. Successful
result prose is ignored.

Claude's normal first check is within about 5 minutes, or 15 minutes in idle
battery mode, followed by the 30-second confirmation (plus request timeouts).
The existing Codex account/quota RPC is checked about once a minute (up to two
minutes with the battery tick); explicit `account: null` confirms credential
absence. Only a successful authenticated quota response proves Codex recovery:
cached account identity alone cannot clear an outage. Remotely revoked Codex
tokens that do not appear as `account: null` cannot reliably be classified by
this sampler. Cursor and Antigravity have no reliable authentication probe in
their existing local quota snapshots and are not included in these alerts.

Confirmation immediately submits critical Bark through the same private-key
sender as `notify-user --urgent` and queues a question in the normal Captain
`receipts` channel. The message names the seat, explains that its work fails or
queues, gives that directory's login command, and asks the Captain to reassign
affected work. For example, a seat configured as `~/.claude-us` gets
`CLAUDE_CONFIG_DIR=~/.claude-us claude auth login`; the default directory gets
`env -u CLAUDE_CONFIG_DIR claude auth login`. Custom paths are quoted safely;
Windows gets the equivalent PowerShell environment command. The sampler never
runs the login command itself.

Bark uses the shared configurable critical volume (default 4) and quiet-hours
queue: 23:00–10:00 Seattle time by default, plus fresh cached class periods when
the local authenticated calendar CLI is available, otherwise configurable weekly
periods (Tuesday/Thursday 10:30–12:20; Tuesday 15:30–17:20 by default). During quiet hours the local
reminder and Captain receipt stay immediate; the phone alert is persisted and
merged after quiet hours, checked every 30 seconds while the app is open.
Unavailable/stale calendars visibly fall back to weekly periods. Empty weekly
settings leave only sleep protection and show an explicit warning. Calendar
failures retry in 15 minutes; Settings edits/manual refresh can retry immediately.

The quota panel shows a pale-red row and red **未登录**, with the generated login
command and a copy icon in the details (last line in the sidebar, level with the row;
the detail stays 300 ms after the pointer leaves the row so the icon can be reached); it hides cached percentages and excludes the
seat from existing quota fallback choices. Recovery is silent and requires a
fresh successful provider query. Confirmed logged-out seats recheck every 30
seconds (plus request time) for the first 10 minutes and every 2 minutes after that,
even if an intervening query is unknown; recovery
removes that seat’s queued phone alert without ringing. Each seat/outage sends only once, including
across app restarts; a confirmed recovery rearms the next outage. The private
`userData/seat-auth-state.json` keeps the episode latch and undelivered Captain
receipts. A missing Captain does not delay Bark; its receipt waits until one
exists. Never-logged-in seats show 未登录 after confirmation without a dropout
alert. On upgrade, a fresh bound quota sample can establish the prior login.
Blank Bark settings use the same private Captain key file `~/.secrets/bark-key.txt`.
Where the setting is blank and that file does not exist (Windows by default), a phone
reminder is dropped with a setup hint instead of queued; an explicit path that cannot
be read still queues and retries. Queued reminders older than 24 hours are discarded.
Daytime sends are durable too: failure retains the outbox for a 60-second retry,
with an explicit Settings error and a once-per-outage Captain exception receipt.
If the outbox cannot be saved, this is reported instead of claiming queued delivery.
An interrupted send with unknown outcome (owner process gone, or the send record
older than 60 seconds) pauses automatic resends until manual refresh; successful-send cleanup errors retry saving without repeated ringing.
Native reminders preserve front-window silence and never activate a window.

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
