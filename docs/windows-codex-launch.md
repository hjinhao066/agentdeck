# Windows Codex launch compatibility

Read-only SSH investigation (2026-10-04): Windows resolves Codex to
`D:\npm-global\codex.ps1`, version `codex-cli 0.154.0`. Its root `--help`
accepts `--dangerously-bypass-approvals-and-sandbox` but does **not** list
`--no-daemon`. Mac runs `codex-cli 0.160.0` and lists both options.

The launch preset (board-core), captain/worker command check (main-core),
relay command (claude-seats-core), and final shell command (board-core)
currently inject `--no-daemon` unconditionally. Windows rejects that option
before the TUI starts, so the captain briefing cannot be delivered. This is
an unsupported option, not evidence of a broken login or tunnel.

Fix in progress: probe local root help before each executable's first launch,
cache capabilities, and add/filter the two managed flags at the final launch
boundary, including saved and resumed commands. PowerShell quoted executable
paths require the `&` call operator. Do not replace the live Windows app during
investigation.
