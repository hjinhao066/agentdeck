# Passive subscription quota

Research on this Mac, 2026-10-03. No credentials were printed, no provider
endpoint was called and no input was sent to an existing session. The installed
AgentDeck and real agent processes were left running. Research selected only
quota fields; authentication files were not opened.

| Provider | Screen source (preferred) | Local fallback | Confidence |
| --- | --- | --- | --- |
| Claude Code | Dedicated footer `Session: …%`, `Weekly: …%`, associated `Reset:` / `Weekly Reset:`; custom `5h …% · 7d …%`; native `/usage` cards if the user already opened one | `~/.cache/ccstatusline/usage.json`: `sessionUsage`, `sessionResetAt`, `weeklyUsage`, `weeklyResetAt` | Screen: high for what CLI displays. Cache: medium, third-party and optional. Percentages are **used**, so display 100 − used. |
| Codex | An already visible `/status` card: `5-hour limit: …% left`, `Weekly limit: …% left` (also explicit `% used`) | `$CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl`, default `~/.codex`; `event_msg` / `token_count` / `rate_limits` with `used_percent`, `window_minutes`, `resets_at` | High for a server-reported sample; not a live account query. Identify windows by 300/10080 minutes, not primary/secondary order. |
| Cursor | Provider heading for “正常”; anchored usage-limit errors for “已用尽”, with a reset when present | No reliable subscription percentage cache found in the local CLI/config paths inspected | “正常” is low confidence: only no exhaustion seen. Explicit exhaustion is high confidence for that error, not for unrelated models. No percentage is invented. |
| Antigravity (`agy`) | Provider heading, `Individual quota reached` / `Resets in …`, plus supported usage-limit errors | Optional `~/.gemini/antigravity-cli/agy_statusline_debug.json`, **only** `quota.{gemini-5h,gemini-weekly,3p-5h,3p-weekly}.{remaining_fraction,reset_time}` and file mtime leave the reader | Medium: an optional CLI debug snapshot, not a stable public API. Gemini and third-party windows remain separately labelled. No snapshot → normal/exhausted/unknown from observed screens. |

Local findings: Claude's configured status script currently consumes the native
`rate_limits.five_hour` / `seven_day` fields and renders `5h` / `7d`; saved
session screens also contained the older Session/Reset form. The ccstatusline
cache is present. Recent Codex logs contained **only a weekly primary window**,
so a 5-hour number cannot be inferred. agy's debug snapshot contains all four
quota groups above, with numeric fractions and ISO reset timestamps. Cursor's
installed source contains usage-policy RPC definitions, but that does not
establish a reusable local cache. AgentDeck does not invoke those RPCs.

References: [Claude status line documentation](https://code.claude.com/docs/en/statusline)
documents rate-limit percentages and Unix reset timestamps;
[Codex rate-limit tests](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs)
and [status card implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/status/card.rs)
describe server samples and the TUI;
[Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
describe `status` as authentication status. The agy schema above was observed
locally; it is not claimed to be a documented compatibility contract.

## Behavior and limits

- Read live rows below the input box and dedicated usage/status card rows. Never
  interpret Context %, token counts, cost or conversational mentions as quota.
  Ignore restored output above AgentDeck's replay separator and task-contract echoes.
- Fresh screen numbers win over cache numbers for 15 minutes. Cache polling is
  every 30 seconds; every sample exposes its source and time. Unchanged screen
  observations are not stamped fresh on every redraw. Caches are bounded async
  reads (Claude 16 KB, agy 64 KB, up to 8 recent Codex tails of 1 MB each in the
  current/previous daily folders), not recursive history scans.
- The top number is the lowest known remaining window; tooltip lists every
  known window. This is conservative across agy's Gemini/third-party pools,
  even when the model being considered uses another pool. Unknown windows are
  not silently filled in. Unknown/no active session is labelled 未知. 正常 means
  only no quota error observed, never a guarantee that a new task will succeed.
- A detected exhaustion persists in `config.quotas` across session removal and
  app/renderer restart. A redraw/another normal session cannot clear it. A known
  reset expires the block into unknown until fresh data arrives; no automatic
  100% is assigned. An unknown reset stays blocked until an explicit CLI reset
  message. A numeric-zero block can also clear on a newer positive quota sample.
- Relative durations, local clocks and clocks with IANA zones are converted to an
  absolute time at observation. Unsupported zones/date formats are retained as
  time-shaped text; no expiration is guessed.
  Repeated unchanged errors do not move a relative reset forward.
- Quota exhaustion blocks normal automatic delivery through the existing
  session quota state. `quota` itself is Captain-only, read-only, returns one
  line per provider and does not consume receipts or cache a board response.
  Captain instructions suggest checking it before delegation. Provider switching
  remains a Captain decision; this change does not automatically create tasks.
- This feature aggregates by provider and assumes the machine's current login.
  Separate accounts/config directories are not identified without credentials.
  A per-model exhaustion conservatively marks its provider exhausted. Account
  switching with an unknown-reset block needs a new explicit reset observation.
- No credentials/settings/auth files are read by the implementation. agy's
  snapshot and Codex logs may contain identity or conversation data, but only
  allowlisted quota fields are returned to the renderer. Test profiles disable
  all real local-cache reads; E2Es use offline stand-ins and isolated userData.
