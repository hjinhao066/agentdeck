# E2E on the Windows PC, in the background

`scripts/e2e-auto.js` sends E2E specs to the Windows PC over ssh so the Mac's queue stays free.
Everything below was measured, not estimated; the raw data and the full tables are in
`~/reports/agentdeck-e2e-windows/` (`benchmark.md`, `runs/`).

## Routing

```bash
node scripts/e2e-auto.js tests/e2e/chat.spec.js tests/e2e/quota-warmup.spec.js
node scripts/e2e-auto.js tests/e2e/chat.spec.js -- --grep "prompt typed"   # Playwright options after --
node scripts/e2e-auto.js --status                                         # local queue
```

- **Mac-only spec**: carries a platform skip that is true on Windows (`test.skip(process.platform === 'win32', …)`,
  `{ skip: process.platform !== 'darwin' }`, `test.describe.skip(…)`, `test.fixme(…)`, `os.platform()`, a
  `const isWin = process.platform === 'win32'` alias). The condition is evaluated for win32; a skip that also
  depends on something else (a loop variable, an env var) does not count. A skip inside one test sends the
  whole file to the Mac (the safe side). Runs through the local queue.
- **Everything else**: one Windows group (all specs together, one bundle, one queue slot).
- **Windows offline, or ssh/setup failure** (exit 255, 75, 10–15): the specs run on the local queue instead.
- **A test failing on Windows is a failure.** It is not silently re-run on the Mac. A spec that only works on
  macOS/POSIX and has no skip marker fails there; add the marker.
- **What Windows tests is your working tree**, uncommitted changes and new files included (a throw-away commit
  is built with a temporary index; HEAD, your index, branches and the stash are untouched).
- Unknown arguments before `--` are an error (they used to be dropped silently).

## How the Windows side is laid out (`%USERPROFILE%\agentdeck-e2e-win`)

| Folder | What |
|---|---|
| `hub` | one git repository holding the commits sent so far |
| `checkouts\<run>` | the job's own checkout (a git worktree), removed after the run; `node_modules` is linked in |
| `deps\<lockfile key>` | `node_modules` for one lockfile (+ platform, CPU, Node version): installed once under a lock, then read-only |
| `inbox\<run>`, `runs\<run>` | uploaded tools/bundle and the run's results; removed by the dispatcher |

Several jobs can run at once (`AGENTDECK_E2E_SLOTS`), also for different commits. Jobs with the same lockfile
wait for one installer and reuse its folder (the log says "waiting for another job to finish installing
dependencies"; a lock older than 30 min is broken; waiting longer than 25 min gives up with exit 15, and
`e2e-auto` then falls back to the Mac). The Electron binary is downloaded and started once during that install,
because the first launch after a fresh install often fails while the virus scanner holds the files.
Folders are not pruned automatically: remove `deps\<key>` of old lockfiles by hand when the disk is short.

## Background: nothing on the user's desktop

The ssh login runs in session 0; the desktop is session 1. A process in session 0 cannot draw on the desktop
and cannot take its focus. Priorities are not changed. From an ssh session the desktop's windows cannot be
listed, so the evidence is the process session: `scripts/verify-windows-background.ps1 -Mode sample` records,
every few seconds, the sessions of all processes started from `agentdeck-e2e-win`. In every measured run
that was `0` only.

## Measured (same commit, chat.spec.js + quota-warmup.spec.js, 24 tests, workers=1)

| | per group, wall clock | Playwright only |
|---|---|---|
| Mac queue, Mac busy (load ≈ 108) | 147 s | |
| Mac queue, Mac idle (load ≈ 9) | 93 s | |
| Windows, 1 group | 238 s | 140 s |
| Windows, 2 groups at once | 209–219 s | 125–134 s |
| Windows, 3 groups at once | 241–243 s | 146–149 s |

Windows is not faster per group (1.6× longer than a busy Mac, 2.6× longer than an idle one; roughly 90 s of the
wall clock is upload, checkout and fetching results). Its value is parallelism: 3 groups at once take as long as
1, a throughput of 2.9×, and each group sent there frees 93–147 s of the Mac's queue. Defender (MsMpEng) stayed
at 2–3 % of the machine (peak ≤ 9 %) with the exclusions in place. These runs happened while the user was in a
Zoom call, so total CPU was 75–96 % before and during; the share caused by the tests cannot be separated.
`AGENTDECK_E2E_SLOTS=3` is the measured-safe value; 4 or more was not measured.

Re-measure with `scripts/perf-e2e-benchmark.js` (`--mode win --groups N` / `--mode mac`, same `--sha`); it prints
the numbers it measured and nothing else.
