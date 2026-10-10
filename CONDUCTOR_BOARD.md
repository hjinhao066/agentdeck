# Conductor Board

AgentDeck's board view is built on the existing column and `node-pty` session
model. It has one page, **队伍** (called 终端架构图 / 架构图 before 2.0.5); its tab
row also switches to **任务看板** and **Token 用量**. Nothing on it is a mock:
clicking a card opens that real column.

The 自由画布 (free canvas) tab, with its draggable task cards, link cables,
terminal inspector, **Auto arrange**, **New terminal** and **Assign conductor
task**, was removed in 2.0.5. A profile last left on it opens on 队伍. What it had
saved stays in `config.json` (in the app's user-data directory) and is not shown:
card positions under `boardPositions`, relationships under `links`.

## 队伍

The board button (Cmd+Shift+B) opens on **队伍**. The map is a read-only
projection of 队长's ledger sources: `config.mainSession.tasks`, the live columns
and `config.archived` (`crew-map-core.js` builds, lays out and routes it,
`crew-map.js` draws it; no new IPC). Its own state is `config.crewMap`
(dragged card `positions`, project offsets `projectPositions`, pan/zoom
`view`, `showReturn`, and `collapsedProjects`), checked on load. The entry is the
leftmost top-bar icon, directly beside the sidebar collapse/expand icon.

- It is a canvas: drag empty space to pan, Cmd/Ctrl+wheel or pinch to zoom,
  drag a card to move it. The corner controls zoom, fit, re-run the automatic
  layout (**整理**, clearing card/project positions and fitting the window) and
  show/hide archived sessions. Opening or resizing automatically fits all visible
  nodes; manual card/project positions survive refresh, reopening and reload.
- Three kinds of line, each with its own port and arrow direction:
  **派出** (accent) leaves the bottom of 队长 and enters a session's top, or a
  review session's left side down the gap beside what it reviews; **审查**
  (violet, dashed) runs down from each reviewed session into its review;
  **收回** (green, red for a question or a failure) leaves a session's
  bottom-right, runs under everything and up the right edge into 队长's right
  side. A reviewed session's result goes back through its review. Lines nest
  in the automatic layout (unit-tested). Return lines and their chevrons are
  hidden by default; returned cards carry **✓ 已交回**. The legend icon toggles
  return lines, with its pressed state and preference saved.
- Projects appear side by side in named groups (unmarked sessions go in **其他**).
  Soft theme-aware backgrounds and borders distinguish projects. There is one
  real Captain above them. The viewport chooses a grid: both projects and workers
  wrap into rows as needed, including a large ungrouped crew. Declared reviewers
  sit below their workers; lower-row dispatch lines use card gutters. Dragging a
  project background/header moves its cards and cables together.
- Open a session with `new --title "接口" --task "实现接口" --project "客户门户"`.
  A reviewer uses the same project and explicit session ids:
  `new --title "审查" --task "检查结果" --project "客户门户" --reviews id1,id2`.
  Only those ids get review lines; titles, file mentions and prompt text do not
  infer relationships. Unknown ids and the Captain's id are refused. Targets
  can be archived sessions. Review metadata and project names survive waiting
  for a concurrency slot, task-card pruning, archive/restore and relaunch.
- Each group has a chevron icon with a tooltip, accessible name and keyboard
  control. Projects whose sessions all succeeded (`done`) start as a single
  summary row; failed, stopped and waiting projects stay open. A user's explicit
  fold/expand choice is saved in `config.crewMap.collapsedProjects`.
- Cards show title, agent/model, state and the newest receipt, refreshed on the
  status tick. Fixed card slots show at most two full title lines and two full
  receipt lines, ellipsizing excess text. Controls use icons with tooltips,
  accessible names and keyboard focus. Clicking opens the real session (an archived one is restored),
  where the user can talk directly to its agent. Hidden archived work remains
  available through the archive control; completed projects retain their summary.
- The Captain directly splits a project into sessions and collects their
  reviewed results. Its briefing asks it to use one `--project` for that work
  and `--reviews` for reviewers, and to tell Claude sessions not to launch
  Claude sub-agents by default; Codex/Gemini sessions may use sub-agents.

## Terminal roles

- **Conductor**: owns a top-level task and may create managed child terminals.
- **Worker**: a managed child. Workers may create downstream workers.
- **Manual**: an independent user terminal. It receives no board-control
  capability and cannot be controlled by a conductor.

The `+` button always creates manual terminals. Since 2.0.5 the app has no
control to start a conductor task or to grant a terminal control; conductors and
workers saved before then keep working with the commands below.

## Managed-terminal commands

Managed PTYs receive a per-session capability token and the path to
`agentdeck-board.js`. The helper is copied from the packaged app into the
application's user-data directory at startup.

```powershell
node "$env:AGENTDECK_BOARD_CLI" create-child --title "Task" --task "Instructions" --agent claude
node "$env:AGENTDECK_BOARD_CLI" spawn-child --title "Task" --task "Instructions" --agent claude
node "$env:AGENTDECK_BOARD_CLI" wait --task "task-id"
node "$env:AGENTDECK_BOARD_CLI" send --task "task-id" --message "Follow-up"
node "$env:AGENTDECK_BOARD_CLI" progress --message "Current progress"
node "$env:AGENTDECK_BOARD_CLI" complete --result "Result and validation"
node "$env:AGENTDECK_BOARD_CLI" status
```

`create-child` waits for the returned worker result. `spawn-child` plus `wait`
allows parallel delegation. `send` is restricted to the caller's managed
descendants. Manual terminals never receive the token or helper environment.
Task completion is explicit: a worker must call `complete`; terminal-idle
heuristics never release a waiting parent. Pending commands and waits survive a
renderer reload, while removing a task or revoking control returns a clear
cancellation to any waiting caller.

AgentDeck waits for a recognized agent prompt before delivering managed task
instructions and pauses at trust or permission prompts. If an agent takes
longer than two minutes to become ready, delivery pauses and the task's progress
says so. Raw shells keep the task instead of executing natural-language
instructions as shell code.

## Display titles

A session's title is editable from the sidebar (double-click or rename). The
custom `displayTitle` is persisted and used in the terminal header, sidebar,
队伍 and notifications. Internal column IDs, stable task IDs, and automatic
titles remain unchanged.
