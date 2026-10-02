# AgentDeck

A Windows/macOS multi-column terminal app for running AI agents side by side.
Each column has its own shell, output history and input. The Conductor Board
adds explicit task relationships without taking control of manual terminals.

## Layout

The window follows the Cursor / Codex desktop layout, with AgentDeck's deck in
the middle:

- **Left sidebar** (collapsible, resizable): 新对话, 队长, 搜索, Schedule, Artifacts, Skills,
  then the 队长 row (once the Captain exists), folders, loose sessions and 已归档.
  Every session is a live terminal column.
  Drag a session to reorder it, into a folder, out of one, or onto 已归档.
  Right-click or ⋯ for rename / move to folder / archive / delete. The deck shows
  sessions in exactly the sidebar order (队长 first, then folders), so swiping walks the list.
  The 队长 row is pinned: clicking it selects the Captain and shows its saved
  conversation; it cannot be dragged, put in a folder, archived or deleted from the list.
- **Center**: the deck. Two-finger swipe left/right pages between sessions; the
  top bar picks 自由 (per-column widths) or 2–5 equal columns. Terminal output
  stays within its assigned column width, including when switching views or zooming.
- **Right pane** (collapsible, ⌘\\): 预览, 终端 and 浏览器 tabs.
- **Archive** stops the session's terminal but keeps its conversation and last
  output; restoring replays that output and relaunches the agent (Claude resumes
  with `--continue`). Delete removes the session and its conversation.
- **Schedule** sends a prompt to a session (or a fresh one) once, on chosen
  weekdays at a time, or every N minutes/hours. It runs only while AgentDeck is
  open; a run that was due while it was closed is shown as missed, not fired
  late. A busy session is retried for up to 30 minutes.
- **Artifacts** lists files and links that agents mentioned in their replies.
- **Skills** lists every `SKILL.md` the agent CLIs on this machine can see, so
  you can read one rendered or edit its full Markdown and save it (⌘S). See below.

## Skills

The Skills page scans the shared originals in `~/.agents/skills` and each tool's
own folder: `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills`,
Antigravity's `~/.gemini/antigravity/global_skills` and `builtin/skills`,
`~/.cursor/skills` and `skills-cursor`, `~/.grok/skills` and `bundled/skills`,
plus skills inside installed plugins (Claude's `installed_plugins.json`, the
Codex/Cursor/Grok plugin caches, Gemini extensions). Nested skills (for example
examples or agents inside a skill) are found too; `node_modules` and `.git` are
skipped.

- Copies are grouped by their real file. A skill under `~/.agents/skills` is
  shown once as 共享正本, with the tools that link to it; tabs per tool show only
  that tool's own skills. Two real copies with the same name stay separate.
- Saving a shared skill writes only the original file. Tool links are never
  replaced by copies, so every tool linked to it sees the change.
- Saves are atomic and keep the file mode. If the file changed after you opened
  it, nothing is written and the page says so; reload to pick up the change.
- Binary, non-UTF-8 and hard-linked files can be read but are never saved.
- Only existing `SKILL.md` files up to 1 MB are opened. A link pointing outside
  the skill folders is listed but never read or written. Plugin and built-in
  skills can be overwritten by the tool's next update.
- Nothing on this page creates, deletes, installs or syncs skills, and a skill's
  text is only shown, never sent to an agent.

## 队长 (Captain)

One standing column, opened from the sidebar entry 队长 (creating it the first
time, with the agent you pick; afterwards it only returns to it). Once created it
also has its own pinned row at the top of the session list. There is only ever
one, always the first column of the deck. You tell it what
you want; it hands the work to other columns and brings back short receipts. It
does not do the work in its own column. On restart, an existing Captain is briefed
again with the current provider, model and effort instructions.

- It controls every session (ones it opened, ones you opened, terminals you started
  yourself) through `node "$AGENTDECK_BOARD_CLI" ledger | new | tell | read |
  receipts | answer` (`node "$env:AGENTDECK_BOARD_CLI" …` in Windows PowerShell
  columns), run in its own terminal. Only the 队长's terminal holds the
  capability token those commands need; the columns it drives get none.
- New sessions it opens use the same launch command as the 队长 (Claude: bypass
  permissions) unless it picks another with `--agent claude|agy|cursor|grok|codex` or a full
  `--command`. Its instructions list the providers and the models their CLIs report
  on this account, with a routing preference: bulk ordinary work to Antigravity
  `gemini-3.8-flash-high`; code and important work to Cursor CLI
  `claude-opus-5-5-high`, then `claude-sonnet-5-5-high` (or Claude Code), and Cursor's
  `grok-4.7-high-fast` only when those are unavailable. The standalone `grok` CLI is
  not used unless you name it. It also picks an effort tier per task: `medium` for
  simple work, `high` for ordinary code, `xhigh` for complex work or a task that
  already failed, `max` for the most critical. Cursor takes the tier as the model
  id's suffix (`claude-opus-5-5-medium|high|xhigh|max`, same for
  `claude-sonnet-5-5-`); Antigravity and Claude Code take `--effort`.
  AgentDeck cannot read live quotas; the 队长 switches
  provider when a worker reports a limit. New sessions appear in the sidebar and the
  deck, and get the task as their first message. The app appends a contract: finish without waiting on the user, ask the
  队长 with 【提问】 when unsure, and end with a short 【回执】 (summary, file paths,
  failure reason; never file bodies).
- When a worker's turn ends, its receipt or question is read from its final reply,
  shown as a card in the 队长 column (click the title to jump there), stored as the
  column's last receipt, and delivered to the 队长's agent by itself when it is idle
  (or with your next message). A worker stopped at a confirmation prompt is handed
  to the 队长 with only the prompt's last lines; it answers with `answer` when sure
  and asks you otherwise. A quiet screen without a receipt is shown as 已停下, not
  as success.
- The heartbeat is the app's status loop: it checks each dispatched column's state
  every 1.5 s and never copies a column's full output into the 队长.
- 清空上下文 (only in the 队长 header) clears only the 队长's model context. Its
  column restarts as a fresh agent process (resume flags such as `--continue` are
  dropped from its launch command, and it is not resumed on the next app start until
  it has finished a turn of its own) and gets the default instructions again, plus a
  short note: the id of its old conversation and the work still out. Other columns
  are never restarted or interrupted. Unread receipts and questions, and receipts
  typed to the old context it had not answered yet, go to the new 队长; cards for
  unfinished work move to the new chat and their receipts arrive there. If the 队长
  is busy, the confirmation says its current turn will be cut off.
- The old conversation is kept, not deleted: it stays in userData/`chats` under the
  old column id. `ledger` lists the latest ones (`config.json` keeps metadata for the
  last 50; older files stay on disk) and the 队长 reads one on demand with
  `read --id <old id> [--turns N] [--find 关键词]`, with the same capability-token
  check as every other command. Nothing from it is put into the new context unasked.
  For you, the 队长 column has a 查看清空上下文前的队长对话 button above its current
  chat: each earlier conversation opens read-only from the saved file, without
  restarting anything.
  `read --id captain-history --find "关键词"` searches across all retired Captain
  chats, including ones older than the metadata list. It requires a keyword and
  returns only a few matching turns (default 3, at most 10), each cut short.

## Chat view and side pane

Every column opens as a chat page, on every launch. Each turn shows
your prompt (pinned while you read its answer) and the agent's final reply,
rendered as Markdown, not commands or tool output. The real terminal is still
running underneath: use the 终端/对话 toggle in a column header to switch.
Prompts typed in the raw terminal also appear in the chat, including Chinese
text; terminal mouse reports are excluded. Each prompt and final reply has a
visible copy button that copies its plain text. Older chats containing repeated
mouse-report fragments are cleaned when loaded, preserving adjacent text.

- A new blank session (no launch command, nothing said yet) offers Claude,
  Antigravity, Grok, Cursor CLI and Codex (ChatGPT) buttons. A click types that agent's launch
  command into the session's own shell; the terminal and its history stay. Only once
  the agent really is the foreground process is the command saved for the session,
  so reopening AgentDeck starts it again. A CLI that is not installed is reported
  under the buttons and the session stays blank. Windows cannot report the
  foreground process: there an agent whose screen is not recognized within 15
  seconds is reported as unconfirmed, nothing is saved, and the buttons stay. A
  launch is sent only from a recognized PowerShell prompt. A half-typed line is cleared first with editing keys only (^U; Ctrl+End, Ctrl+Home
  in PowerShell), never ^C. The buttons also disappear when you
  start an agent in the terminal yourself. Defaults: `claude
  --dangerously-skip-permissions --effort high`, `agy --dangerously-skip-permissions --model gemini-3.8-flash-high
  --effort high`, `grok --permission-mode bypassPermissions`, `cursor-agent --force --model claude-opus-5-5-high` (`cursor-agent`,
  never `agent`, which other tools also install), `codex --dangerously-bypass-approvals-and-sandbox`.
- The composer takes pasted screenshots, dropped files and files picked with +
  as attachments; they are sent as paths ahead of the text.
- Prompts have no length limit. One longer than 8000 characters is saved as a
  private `.txt` in userData/`long-prompts` (pruned after 60 days) and the agent
  gets its opening plus "read this file first"; the bubble shows the file.
- Automatic sends (Schedule, 队长) never type into a bare shell, which would run
  each line as a command: on macOS/Linux they wait until something other than the
  shell is in the column's foreground; on Windows until the agent's screen shows.
- Left sidebar rows and column header leftmost compact identity badges show
  the tool/provider (Cursor, Antigravity/Gemini, Claude, Grok, Codex/ChatGPT)
  alongside the short current model label (e.g. `Opus 5.5`), updating live
  when switching models inside the CLI while preserving the tool provider (for
  instance, Cursor remains Cursor even when running Claude or Gemini models).
  The last confirmed provider, model and effort are saved with the session and
  restored after relaunch; the prior terminal output is also checked when
  recovering older sessions. Model families such as Grok, GPT-6 Luna and Meta
  Muse Spark appear in the label even when Cursor is the launching tool. Full
  provider, model and effort appear in the tooltip; plain shells display no fake
  model.
- Under the composer, the agent's own status lines (model, context, session,
  cost, resets, permission mode) are copied live from the terminal with their
  colors, extending to the right edge of allocated content and cleanly
  overflow-clipped without CSS ellipsis. They are found as the rows below the
  TUI's input box. PTYs set `CCSTATUSLINE_WIDTH=4096` so ccstatusline emits the
  whole line rather than shortening it to xterm's wider character cells. Wrapped
  rows are joined before the smaller footer font is clipped. Other CLI-side
  truncation still cannot be recovered after the missing text has been discarded.

- Clicking a link or file path in a bubble opens it in the right side pane, with
  tabs for 预览 (code, Markdown, images, directories), 终端 and 浏览器 (PDF opens
  there too). Cmd/Ctrl-click uses the system browser or file manager, Option-click
  the editor.
- The left sidebar searches every conversation, titles and full text of prompts and
  replies only. Shortcuts: ⌘/Ctrl+K search, ⌘/Ctrl+\ toggle the side pane.
- Conversations are saved locally in the app's userData folder under `chats`
  (one private JSON file per session, written atomically) and are not committed.
  Folders, archived sessions and schedules live in the
  local `config.json` in the same folder. Turning a reply into a bubble is heuristic, so a TUI
  that redraws unusually may produce an imperfect bubble; the terminal view
  always has the full output. Syncing to a private GitHub repo is planned.

### Conversation history

AgentDeck removes inherited Claude child-session and skip-history flags from each
new terminal, so an agent launching the app cannot disable independent CLI history.

- Every prompt and final reply is kept across quitting and relaunching, whether
  you typed it in the composer or straight into the terminal (in either view).
  A line typed at a password or passphrase prompt is not recorded.
- No turn is ever dropped to make room. A long chat shows its latest 150 turns;
  显示更早的… loads older ones, and search reaches every turn.
- Quitting while an agent is still answering keeps the reply seen so far and
  marks the turn as unfinished. The same happens if a session's terminal is
  restarted mid-turn.
- Archive, restore, relaunch and clearing the 队长's context keep each chat under
  its session's id.
- Limits: history only exists from when AgentDeck recorded it. Older or deleted
  conversations and agent CLIs' own transcripts are not imported. A reply is the
  screen-extracted final answer, cut at 20,000 characters. A prompt over 8,000
  characters goes out as a file, and its bubble keeps the opening plus that file.
  All chats are loaded into memory at launch. A single chat file larger than
  64 MB is no longer written: you get a warning, and what was saved before stays.
  Delete (not archive) removes a session's conversation for good.

## Desktop notifications

Notifications are built into the app on both platforms. No PowerShell popup
script, watch-ai daemon, or OS notification permission is needed.

- A permission/input prompt shows a persistent popup. Completed output shows a
  popup after at least 12 seconds of stable idle state and no further PTY output.
- Works for Claude, Codex, Grok, Antigravity and manually launched agents. Screen
  detection is heuristic: a silent tool can look idle, and unknown prompt formats
  may be missed. The popup intentionally says output stopped, not task succeeded.
- Popups stay above ordinary windows without stealing the keyboard. Cards are
  compact (~191×54 px per card, halved again for minimal footprint), stacked in
  the bottom-right corner with 12px margin; close a card to dismiss it.
- Click a card to restore AgentDeck, leave Board view, scroll/re-zoom to that
  exact terminal, and focus its input. A deleted terminal never redirects to an
  unrelated column. Resumed work retracts its obsolete popup.
- The app must be running. macOS Spaces/fullscreen visibility is requested; OS
  secure desktops and other OS restrictions can still cover ordinary app windows.

Legacy watch-ai screen dumps are off by default (also avoids plaintext screen
copies). Set `AGENTDECK_LEGACY_WATCH=1` only when deliberately using that bridge.
If an existing Claude hook independently displays popups, skip that hook's popup
when `AGENTDECK_NATIVE_NOTIFICATIONS=1`; leave hooks in other terminals unchanged.
For the known Windows `~/.claude/hooks/claude-popup.ps1`, run
`node scripts/migrate-popup-hook.js` once. It backs up and adds only this guard.

## Development and builds

Use Node.js 22.12+ or 24 LTS and `npm ci`. node-pty 1.1 includes Node-API binaries
for Windows x64/arm64 and macOS x64/arm64, so those platforms do not require a C++
toolchain for ordinary installs. `npm run rebuild` is an explicit source-rebuild
fallback and requires the appropriate compiler toolchain.
The install check also restores executable permissions on the macOS PTY helper;
the upstream npm tarball otherwise installs that file without execute bits.

```sh
npm test
npm run test:e2e
npm audit
npm start
npm run dist:win
npm run dist:mac
```

Mac distribution uses the local `AgentDeck Dev` signing identity. On a CI host
without that certificate, use `CSC_IDENTITY_AUTO_DISCOVERY=false` and
`npx electron-builder --mac --config.mac.identity=null --publish never`.
CI builds are unsigned and not notarized; they are not equivalent to a signed
local installation. Windows CI produces an NSIS installer.

Test a packaged app with `AGENTDECK_TEST_EXECUTABLE` set to its executable before
running `npm run test:e2e`. Tests use temporary userData and empty shell columns,
never the real layout or live agent sessions. With `--test-user-data=<dir>` the
Skills page scans `<dir>/skills-home` instead of the real home folder, so tests
never list or edit the user's own skills.

Security boundaries: the renderer is sandboxed with a restrictive CSP and no
Node integration. Main IPC accepts only the deck's local main frame. Session
identifiers are validated before file access. Session replay is capped at 200k
characters per column and written atomically. Local processes running as the
same OS user remain trusted; the board token is not an OS security sandbox.

AI contributors must follow [AGENTS.md](AGENTS.md), including immediate commit
and GitHub synchronization after every completed change.

See [CONDUCTOR_BOARD.md](CONDUCTOR_BOARD.md) for managed task operations.
