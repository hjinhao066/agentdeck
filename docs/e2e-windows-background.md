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

- **Mac-only spec**: carries a platform skip that is true on Windows, written as `test.skip(<cond>)`,
  `test.describe.skip(<cond>)` or `test.fixme(<cond>)` (also recognised: a `skip: <cond>` option, which
  Playwright itself ignores, so do not write it on purpose), where `<cond>` uses only `process.platform` /
  `os.platform()`, a `const isWin = process.platform === 'win32'` style alias, string literals and `! && || == != === !==`.
  The condition is evaluated for win32. Not recognised: `if (process.platform === 'win32') test.skip()`,
  `testInfo.skip(…)`, `process.platform.startsWith('win')`, and a skip after a regex literal containing a quote;
  such a spec goes to Windows, fails there visibly, and the log says to add the marker. A skip that also depends on
  something else (a loop variable, an env var) does not count. A skip inside one test sends the whole file to
  the Mac (the safe side). Runs through the local queue, at the same time as the Windows group.
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

Disk (each install is about 545 MB): the key leaves out the root `version` of the lockfile, so a release bump
does not install again. After every job the folders are pruned to the 2 most recently used; a folder a running
job uses (marker in `deps\<key>\.users`) or is installing is never removed, and each removal happens under that
folder's own lock. Before a new install the free space must be at least 2 GB (`AGENTDECK_E2E_MIN_FREE_BYTES`);
otherwise old folders are pruned first and, if that is not enough, the job exits with 16 and `e2e-auto` falls
back to the Mac. A job's checkout is deleted when it ends; checkouts left by killed jobs are swept (older than
3 hours) when the next job starts. The install lock records its owner process: a lock whose owner is gone is
taken over at once, one whose owner is alive is respected (3 hours at most). All deletions go through
a check that the target is a direct child of `checkouts` or `deps`, and every Windows path the dispatcher puts
in a command line is quoted (home folders with a space are refused anyway).

## Background: nothing on the user's desktop

The ssh login runs in session 0; the desktop is session 1. A process in session 0 cannot draw on the desktop
and cannot take its focus. Priorities are not changed. From an ssh session the desktop's windows cannot be
listed, so the evidence is the process session: `scripts/verify-windows-background.ps1 -Mode sample` records,
every few seconds, the sessions of all processes started from `agentdeck-e2e-win`. In every measured run
that was `0` only.

## Measured (same commit, chat.spec.js + quota-warmup.spec.js, 24 tests, workers=1)

No multiples are given for parallel runs: Windows was never free of other sessions' E2E jobs for the length of a
run (about a dozen attempts for 1, 2 and 3 groups, each with the "jobs alive" count of the sampler; every attempt
had another job overlapping), so a clean throughput figure could not be measured. What was measured:

| | per group, wall clock | Playwright only | note |
|---|---|---|---|
| Mac queue, Mac busy (load ≈ 108) | 147 s | | |
| Mac queue, Mac idle (load ≈ 9) | 93 s | | |
| Windows, 1 group | 238 s | 140 s | one run, no job count recorded (28 test processes, one job's worth) |
| Windows, 1 group, one other job overlapping | 206–216 s | 124–133 s | four runs |
| Windows, 2 groups | 209–218 s | 125–134 s | four runs; in two of them another job was there only in the first seconds, in two it overlapped |
| Windows, 3 groups, one other job overlapping | 212–217 s (a third group waited 72–78 s for a slot) | 125–133 s | two runs |

Per group, Windows is slower than the Mac (about 90 s of the wall clock is upload, checkout and fetching results;
the Playwright time alone is 124–140 s against 93–147 s). Group times did not grow when 2–3 jobs were on the machine
at once, but that is not a throughput measurement. Each group sent to Windows frees 93–147 s of the Mac's queue.
Defender (MsMpEng) stayed at 2–3 % of the machine (peak ≤ 9 %) with the exclusions in place. The runs happened
while the user was in a Zoom call, so total CPU was 68–96 % before and during; the share caused by the tests cannot
be separated. `AGENTDECK_E2E_SLOTS=3` is the value used throughout; 4 or more was not tried.

Re-measure with `scripts/perf-e2e-benchmark.js` (`--mode win --groups N` / `--mode mac`, same `--sha`); it prints
the numbers it measured and nothing else, and the sampler's `maxJobs` tells whether the run was alone on the machine.
