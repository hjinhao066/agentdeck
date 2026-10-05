# Schedule: watched tasks

Schedule lists two kinds of task. The ones AgentDeck sends itself (a prompt to a
session, on a timetable) and the ones **another scheduler runs**: a cron job on
another machine, a LaunchAgent, anything that leaves dated reports behind.
AgentDeck never runs a watched task. It shows what the task is, when it runs,
how the last run went and its latest report, and it takes the user's 做 / 不做
on the numbered suggestions a report may carry.

Code: `schedule-feed-core.js` (pure: descriptions, reports, decisions, the line
队长 gets), `schedule-feed.js` (main process: reading, the kept copy, the
decision journal), `pages.js` (the list card and the detail view).

## Describing a task

One JSON file per task in `~/.agents/schedules/`. The folder is shared between
machines, so `platforms.<process.platform>` overrides the top level:

```json
{
  "id": "nightly-radar",
  "name": "竞品与灵感雷达",
  "label": "雷达",
  "about": "一两句人话：它每天做什么，产出什么。",
  "runner": "Windows 上的 Hermes",
  "when": { "time": "20:30", "timeZone": "America/Los_Angeles" },
  "job": { "file": "D:/hermes/cron/jobs.json", "id": "0123456789ab" },
  "platforms": {
    "win32": {
      "source": { "root": "D:/state/radar" },
      "decide": ["python", "D:/state/radar/scripts/radar.py", "--root", "D:/state/radar", "decide", "--id", "{id}", "--decision", "{decision}", "--reason", "{reason}"]
    },
    "darwin": {
      "source": { "ssh": "winpc", "root": "D:/state/radar" },
      "mirror": "~/radar-mirror",
      "decide": ["python3", "~/radar-mirror/scripts/record_decision.py", "--id", "{id}", "--decision", "{decision}", "--reason", "{reason}"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and `-`. Names the kept copy under `userData/schedule-feeds/<id>/`. |
| `name`, `about`, `runner` | Shown as written. `label` is the short word in 「雷达审核：…」 (defaults to the name). |
| `when` | Daily time in the task's own zone. Used for 下次运行 when the scheduler's record is missing or old. |
| `source.root` | The task's folder (layout below). With `source.ssh` it is on a Windows machine and read through `ssh <alias> powershell`; without it, it is on this disk. `ssh` is a host alias or `user@host`, never an option. |
| `mirror` | Optional read-only copy on this machine, shown when the source is out of reach. |
| `job` | Optional. A Hermes `cron/jobs.json` and the job id in it: gives 上次运行, 下次运行 and whether the last run succeeded. Read the same way as the source. |
| `decide` | Optional argv (no shell). `{id}`, `{decision}` (`accepted` / `rejected`) and `{reason}` are filled in. Without it the task shows reports only. |

Folder layout under `source.root` (and `mirror`):

```
reports/YYYY-MM-DD.md      the report as written; one per run day
reports/YYYY-MM-DD.json    optional: { "recommendations": [{ "id", "title", "change", "benefit", "effort", "stance", "reason", "project_url" }], "projects": [{ "name", "url" }] }
decisions.json             { "decisions": [{ "id", "decision", "reason", "at" }] }, written only by the task's own tools
```

A suggestion is a `### ADR-0001 · 标题` heading inside one `##` section of the
report (any `LETTERS-digits` id). Everything else in the report stays Markdown
and is rendered as it is, links included. A task with no such headings simply
shows its latest report; the 待审核 parts never appear for it.

## Reading, and being out of reach

Every answer is asked for twice: first what this machine already holds (at
once), then the source itself (`fresh`). A remote read is one ssh round trip
that returns the report dates, the reports this machine lacks, `decisions.json`
and the job file, base64-encoded; what comes back is kept under
`userData/schedule-feeds/<id>/`. A read less than a minute old is not repeated,
and a machine that just failed to answer is not asked again for 30 seconds,
unless the user presses refresh.

When the source does not answer, the page shows the newer of the kept copy and
the mirror, says 「现在连不上」 and 「数据截至 …」 (when the copy was read, or the
mirror's file time), and still takes decisions.

## Decisions

- A decision is appended to this machine's journal
  (`userData/schedule-feeds/<id>/journal.json`) **before** anything else, so a
  dead connection or a restart cannot lose it. The page shows 已决定 from the
  journal at once.
- The task's own `decide` command then writes it. Entries are written one at a
  time in the order they were made; a failure leaves them 待同步 and they are
  retried every five minutes while any wait, on every visit, and on refresh.
  AgentDeck never writes into the source folder or the mirror itself.
- The latest word on a suggestion wins, wherever it was recorded. 改主意 adds a
  new decision; nothing is edited.
- 队长 is told through `MainSession.sendMessage`, the queue a message typed on
  the phone uses: it waits for 队长 to be idle and never passes through a
  half-written message. The line says what was decided, the reason, whether it
  has been written yet, and that it is a direction on record, not an order to
  start. With no 队长 running the line waits in the journal and goes out when
  one is.
- A decision never opens a session, creates a task card or starts work. There
  is deliberately no way to accept several suggestions at once.

## Calls

Plain JSON in and out, behind `window.deck` on the desktop
(`scheduleFeeds`, `scheduleFeedDetail`, `scheduleFeedDecide`,
`scheduleFeedSettle`, `scheduleFeedNotified`) and as methods of
`createScheduleFeeds()` for any other front end:

| Method | Returns |
| --- | --- |
| `list({ fresh })` | `{ feeds: [summary] }`: name, timetable, `status`, `openCount`, `offline`, `asOf`, `unsynced`, `latest` |
| `detail(id, { date, fresh, force })` | the summary plus `report` (`lead`, `items` with `decided`, `rest`, `detail`) and `dates` |
| `decide(id, { itemId, decision, reason, date })` | `{ ok, entry }` once the journal holds it |
| `settle(id)` | tries the waiting writes now; `{ unsynced, syncError }` |
| `notified(id, seqs)` | marks journal entries as told to 队长 |

## Tests

`tests/schedule-feed.test.js` and `tests/e2e/schedule-radar.spec.js` run on
copies of `tests/fixtures/schedule-feed/` in a temp folder. A `--test-user-data`
profile reads descriptions only from `<profile>/schedule-home/.agents/schedules`,
so a test run cannot list, read or decide on a real task.
