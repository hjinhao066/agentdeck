# Windows Codex launch compatibility

Read-only SSH investigation (2026-10-04): Windows resolves Codex to
`D:\npm-global\codex.ps1`, version `codex-cli 0.154.0`. Its root `--help`
accepts `--dangerously-bypass-approvals-and-sandbox` but does **not** list
`--no-daemon`. Mac runs `codex-cli 0.160.0` and lists both options.

The original launch preset (board-core), captain/worker command check (main-core),
relay command (claude-seats-core), and final shell command (board-core)
injected `--no-daemon` unconditionally. Windows rejects that option
before the TUI starts, so the captain briefing cannot be delivered. This is
an unsupported option, not evidence of a broken login or tunnel.

The final launch boundary now probes local root help before each executable's
first launch and caches the result for that app run. Captain creation, workers,
manual launcher buttons, relay, and restored/resumed commands use the same
preparation channel. Only declared managed flags are added; unsupported saved
flags and duplicate `--yolo` aliases are removed. Model, effort, resume, and
arguments after `--` are preserved. A missing, malformed, or timed-out help
probe starts without managed flags instead of blocking launch.

PowerShell resolves the executable rather than a profile function, uses
`-LiteralPath` for explicit paths, and invokes quoted executables with `&`.
Unix launches use `command` to bypass wrappers that append another `--yolo`.
The probe reads help only and does not change Codex configuration or login.

The asynchronous probe also keeps prompt delivery gated until the launch is
sent. Windows waits for a PowerShell prompt before typing the command, then
requires recognizable Codex TUI rows before sending the captain briefing or
worker task. A wrapped executable path containing `codex` does not count as a
running agent; otherwise the briefing can be interpreted as shell commands.

Regression checks: `npm test` and
`npx playwright test tests/e2e/codex-launch.spec.js tests/e2e/launchers.spec.js tests/e2e/captain.spec.js`.
The Codex stand-in rejects unsupported options and records received captain
briefing and worker tasks in an isolated profile. It covers both capability
sets, including paths with spaces and brackets. Windows device checks must
use an isolated build/profile; installing the release remains a separate step.
