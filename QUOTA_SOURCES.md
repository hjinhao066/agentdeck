# Subscription quota sources and model scope

Verified on this Mac, 2026-10-03. No tokens, credentials, raw authentication
responses or conversations were printed. The installed app and its terminals
were left running. Quota probes made no inference requests.

| Item | What it displays | Account/model tooltip | Source and confidence |
| --- | --- | --- | --- |
| Claude seats | One item per configured seat: 5-hour + weekly remaining %, independent resets, actual running Captain seat; missing data = 未登录/无数据 | Observed model; masked email from that seat profile | That seat’s dedicated status footer / already visible `/usage` / local quota cache. CLI high, optional cache medium. |
| Codex / ChatGPT | Every server-reported 300-minute / 10080-minute window; no inferred 5-hour number | Observed model, account-shared Codex bucket; masked email from official `account/read` | Official read-only `account/rateLimits/read`, local JSONL `event_msg.token_count.rate_limits`, already visible `/status`. High for the server's sample. |
| Cursor / **Grok 4.7** | Normal/exhausted/unknown from **Grok 4.7 sessions only**, with reset when shown. Percentage currently unavailable | Grok 4.7 (including effort/fast variant when observed); masked current CLI profile email | Selected-model screen. Normal is low confidence: only no error observed. Explicit exhaustion is high confidence for that session. Claude/other-model errors are ignored by this top-bar item. |
| Antigravity / **Gemini** | `gemini-5h` and `gemini-weekly` remaining %, resets; selected Gemini screen status as fallback | Gemini model when observed, otherwise Gemini shared group; masked snapshot email | Optional `~/.gemini/antigravity-cli/agy_statusline_debug.json`. Medium: optional CLI debug snapshot, not a documented public contract. **Never consumes `3p-*` Claude quota.** |

## Claude seat contract (with `feat/claude-seats`)

- Configuration: `claudeSeats: [{id: 'us', name: '🇺🇸 US', configDir:
  '~/.claude'}, {id: 'cn', name: '🇨🇳 CN', configDir: '~/.claude-cn'}]`.
  Names and directories are configurable; these paths are examples, not a migration.
  The final directories come from `feat/claude-seats`. IDs `us` / `cn` receive
  🇺🇸 / 🇨🇳 flags without duplicating a flag already present in the name.
  No configuration falls back to **one** `~/.claude` item (`default`). Never
  create a second seat or presume a login in this quota feature.
- `column.claudeSeatId` binds a live screen to its seat. The Captain badge uses
  the actual `mainSession.colId` column's `claudeSeatId`, not
  `activeClaudeSeatId` (the next-launch preference). Legacy untagged columns
  bind only to the `~/.claude` seat; unknown explicit seat IDs are ignored.
- Each item shows `5h …% · 7d …%` in the top bar, both reset timestamps in its
  tooltip, model and masked account. Missing windows say `无数据`; if neither
  window can be read, show `未登录/无数据`. A welcome/model banner alone cannot
  prove Claude quota or login. An explicit exhausted error remains visible
  even if an older numeric footer still shows a positive percentage.
- Confirmed by inspecting the sibling branch's `claude-seats-main.js`:
  **`<configDir>/agentdeck-usage.json`** is its canonical snapshot:
  `{at, source: 'Claude /usage', windows: [{key: 'fiveHour'|'weekly',
  remaining, resetText}]}`. The quota reader consumes it directly. Relative
  resets use the original `at`; touching/copying a file never refreshes it.
- Also support per-directory `usage-cache.json`, `usage.json`, and
  `.cache/ccstatusline/usage.json`: ccstatusline's `sessionUsage/weeklyUsage`
  or native `five_hour/seven_day.utilization|used_percentage` with
  `resets_at` (including a `rate_limits` wrapper). Reads are capped at 16 KB.
  Pick the newest valid fresh snapshot for each seat; never add two caches'
  windows or guess a missing denominator.
- Configured seats **never** use `~/.cache/ccstatusline/usage.json`, which can
  be shared by status scripts. Only the unconfigured legacy single item keeps
  that fallback. Configured-seat cache paths must resolve inside that seat's
  directory; a symlink to another seat's cache is ignored. No login attempt or
  real seat switch is made by this feature.
- Quota state is independent under `config.quotas['Claude:<seatId>']` (legacy
  default: `Claude`). Seat config-directory/account changes discard old state.
  Captain `quota` returns one line per seat plus three other providers.
- Profile identity is `<configDir>/.claude.json`'s
  `oauthAccount.emailAddress`, except the default directory uses the CLI's
  existing `~/.claude.json`. Only a masked label and comparison hash leave
  the reader; no credential/keychain read is needed for this feature. An
  absent quota is labelled with the combined “未登录/无数据” without guessing
  whether the account is signed in.

## Research and integration decisions

### Codex / ChatGPT 5-hour gap

- [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)
  documents `account/read`, `account/rateLimits/read` and
  `account/rateLimits/updated`. `usedPercent`, `windowDurationMins`, `resetsAt`
  describe each window. `rateLimitsByLimitId.codex` is selected explicitly;
  review/premium/other buckets must not be presented as shared Codex quota.
- [kimbyungsu/codex-usage-monitor](https://github.com/kimbyungsu/codex-usage-monitor/blob/main/src/usageService.ts)
  uses those official read RPCs. [CodexBar](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/UsageFetcher.swift)
  independently uses `account/rateLimits/read`; its alternate
  [OAuth usage fetcher](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift)
  queries the private `/wham/usage` endpoint. Prefer the official RPC; do not
  extract OAuth credentials or add a duplicate private API integration.
- **Integrated**: a short-lived `codex app-server`, initialized over stdio,
  calls only `account/read` (`refreshToken: false`) and
  `account/rateLimits/read`. No `thread/start`, `turn/start`, login or reset
  redemption. The CLI handles its own authentication. Poll at most once per
  minute, with an 8-second timeout and 1 MB stdout cap, silent stderr/errors,
  direct executable (no shell), and kill only this new child on completion.
  Missing/unsupported CLI or API-key login falls back to existing local/screen
  observations. Test profiles never start this client.
- **Real Mac result**: both recent JSONL events and the official RPC return
  only a `primary` 10080-minute weekly window; `secondary` is null. The RPC
  sample was **28% used / 72% remaining** during research. No 300-minute window
  was returned. Tooltip says “5 小时：服务端未提供，无法取得数字”. If a future
  response contains 300 minutes, it is already supported. `primary` does not
  automatically mean five hours.
- [ccusage](https://github.com/ccusage/ccusage/blob/main/docs/guide/index.md)
  reports local token usage and estimated cost; these are not an authoritative
  subscription denominator. [AIPulse's own explanation](https://github.com/ccusage/ccusage/discussions/944)
  uses historical token peaks as a Claude proxy and uses Codex's existing
  JSONL rate limits for Codex. Neither creates a missing official 5-hour
  window. No token-based quota estimates were integrated.

### Cursor Grok 4.7 percentage gap

- [Cursor's official model/pricing docs](https://cursor.com/docs/models-and-pricing)
  distinguish **Cursor Models** (Grok 4.7/4.6/4.5, Composer) from **Other
  Models** (including Claude), with separate monthly billing pools. A Claude
  exhaustion or an undifferentiated overall percentage is not Grok quota.
- [CodexBar's Cursor integration](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Cursor/CursorStatusProbe+UsageSummary.swift)
  reads `/api/usage-summary`, using
  [Cursor.app's local auth database](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Cursor/CursorAppAuth.swift).
  Researched the read-only `state.vscdb` key names: auth/profile keys exist,
  but no usage cache key was found. A **one-time read-only research probe**
  authenticated in memory with this app token, sent it only to
  `https://cursor.com/api/usage-summary` and printed response field types only.
  The response contains `individualUsage.plan.{used,limit,remaining,
  autoPercentUsed,apiPercentUsed,totalPercentUsed}` and `onDemand`; it exposes
  **no identified Cursor Models/Grok 4.7 pool**. No credentials or raw response
  were saved. Production code does not read this DB or call this endpoint.
- CodexBar's [`get-sand-usage-status`](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Cursor/CursorSandUsage.swift)
  reports **Grok Bot**, not Cursor CLI's Grok 4.7 model pool.
  [Official Grok Bot billing](https://cursor.com/help/grok-bot/plans) describes
  its separate weekly included allowance. It was rejected for this item.
- [ofershap/cursor-usage-tracker](https://github.com/ofershap/cursor-usage-tracker)
  requires team/Enterprise Admin API credentials. The
  [official Admin API](https://docs.cursor.com/en/account/teams/admin-api)
  is for organization/team metrics; it is not an individual CLI quota reader.
- The installed Cursor CLI contains usage-policy RPC definitions, but no
  verified public individual-model quota contract or reusable numeric local
  cache was established. **Keep observed Grok status; do not show an overall,
  Claude, Grok Bot or guessed percentage.**

## Observation and privacy behavior

### Claude low-quota phone alerts

- Reuses the Bark sender from `origin/feat/captain-notify` (`0a850e0`), extracted
  as `createBarkSender` in `notify-user.js`; the Captain helper keeps its existing
  behavior. This branch does not add the `notify-user` board command or its UI.
- Local settings: `claudeQuotaAlert: {thresholdPercent: 2, volume: 3}`. No new
  interface is required. `barkKeyFile` remains the existing absolute (or `~/`)
  local file path holding only the Bark device key. No configured path means
  no delivery. The key is read privately and sent only in the body of an HTTPS
  POST to `https://api.day.app/push`; errors never expose it.
- Only fresh, numeric Claude **5-hour** windows can trigger, inclusively at the
  threshold. The message identifies the seat by name and CN/US ID and includes
  its reset timestamp/text when available. All sends use `level=critical` and
  the configured volume (default 3), regardless of desktop sound preferences.
- Startup checks the saved fresh sample; subsequent checks use the same
  `save-config` path as top-bar live/cache observations. Sampling remains the
  existing 1.5-second screen loop / 30-second local-cache poll.
- `userData/quota-bark-state.json` stores delivery latches independently from
  renderer settings. Known account hashes deduplicate across seats; without
  identity, the seat configuration directory is the fallback. Learning identity
  is not a reset. Unknown/stale/missing windows never clear a latch. A newer
  sample above the threshold rearms it; a post-reset sample rearms it even
  without an observed recovery. Relative reset drift does not create a new window.
- Persist before sending to prevent concurrent saves/restarts from flooding.
  Each window makes at most one delivery attempt; network/invalid-key failures
  show a redacted notice and are not automatically retried. A crash between
  persistence and delivery can lose that attempt. Unidentifiable account switches
  cannot be reliably distinguished until identity or recovery is sampled.
- Test profiles replace Bark HTTP with an offline recorder (without the key).
  Relevant specs: `quota-low-bark.spec.js`, `quota.spec.js`, `claude-seats.spec.js`.

- Live dedicated footers/cards only: Context %, token counts, cost and prose
  about quota never become quota. Restored output and task-contract echoes are
  excluded. Unknown model identity on Cursor/agy is ignored until a selected
  model is identified; it is never presumed to be Grok/Gemini.
- Remaining = 100 minus explicit used %. Headline is the lowest fresh window
  **within the selected pool**, not across agy Gemini/Claude. Missing windows
  are never filled. “正常” means only no observed exhaustion, not guaranteed
  availability. Missing/15-minute-old data is unknown.
- An exhaustion persists until its reset, an explicit reset observation or
  (for numeric zeros) a newer positive sample. Old provider-wide state from
  the first quota-bar version has no model scope and is discarded, preventing
  persisted Claude failures from poisoning Gemini/Grok. Known account changes
  clear that provider's old sample/block; unidentifiable logins cannot be
  reliably distinguished.
- Account tooltip uses the current profile, not a per-terminal authentication
  guarantee: Claude per-seat `oauthAccount.emailAddress` as above, Cursor
  `authInfo.email` in `.cursor/cli-config.json`, agy snapshot `email`, Codex
  official account email. Only masked labels plus an email hash for change
  detection leave the main process. Profile JSON is size capped; no raw
  settings/auth data reaches IPC. Configured Claude directories are supported per seat; alternate directories
  for other providers remain unsupported and are not falsely identified.
- Local fallback reads are bounded: Claude 16 KB, agy 64 KB, up to eight 1 MB
  Codex tails from current/previous daily folders. Only allowlisted quota,
  model and masked identity fields leave the reader. Local polling is 30 s.
- Captain-only `quota` remains read-only; it neither changes tasks nor consumes
  receipts. The existing per-session exhausted state still blocks automatic
  delivery into that exhausted session, even when its model is intentionally
  excluded from the selected top-bar pool.
- New screenshots under `~/reports/agentdeck-quota-bar/screenshots-v2/` use
  **simulated offline fixtures**, including all percentages and demo accounts;
  they are not screenshots of this Mac's live quota. E2E profiles disable all
  real cache/profile/RPC reads and use stand-ins only.
