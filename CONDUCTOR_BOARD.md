# Conductor Board

AgentDeck's Conductor Board is a live orchestration workspace built on the
existing column and `node-pty` session model. Board nodes are not mocks. The
selected node moves its existing xterm element into the board inspector, so the
graph and the full interactive terminal stay visible together.

## 终端架构图 (default tab)

The board button (Cmd+Shift+B) opens on the **架构图** tab; the free canvas
described below is the second tab (**自由画布**). The map is a read-only
projection of 队长's ledger sources: `config.mainSession.tasks`, the live columns
and `config.archived` (`crew-map-core.js` builds, lays out and routes it,
`crew-map.js` draws it; no new IPC). Its own state is `config.crewMap`
(`mode`, dragged card `positions`, pan/zoom `view`, and `collapsedProjects`), checked on load.

- It is a canvas: drag empty space to pan, Cmd/Ctrl+wheel or pinch to zoom,
  drag a card to move it. The corner controls zoom, fit, re-run the automatic
  layout (clearing dragged positions) and show/hide archived sessions.
- Three kinds of line, each with its own port and arrow direction:
  **派出** (accent) leaves the bottom of 队长 and enters a session's top, or a
  review session's left side down the gap beside what it reviews; **审查**
  (violet, dashed) runs down from each reviewed session into its review;
  **收回** (green, red for a question or a failure) leaves a session's
  bottom-right, runs under everything and up the right edge into 队长's right
  side. A reviewed session's result goes back through its review. Lines nest
  so no two share a stretch (unit-tested).
- Projects appear side by side in named groups (unmarked sessions go in **其他**).
  There is one real Captain above them, workers on the first row and declared
  reviewers on the second. Dragging a worker keeps it in its project and row.
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
  status tick. Clicking opens the real session (an archived one is restored),
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

The `+` button and **New terminal** always create manual terminals. A manual
terminal becomes managed only when the user explicitly creates a delegation
relationship and checks the control-grant option. AgentDeck explains that this
restarts the shell so the capability can be injected. Removing that link
revokes control and restores the terminal to manual mode.

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
longer than two minutes to become ready, the Board shows a visible paused state
and the inspector offers **Send task** to retry. Raw shells keep the task on the
Board instead of executing natural-language instructions as shell code.

## User-created relationships

Drag the blue output port on any node directly onto another node to create a
directional, persisted relationship. The relationship dialog opens only after
the cable is dropped, so the source and target are already selected. Clicking
the output port remains as a keyboard-friendly fallback: click the destination
card next.

- **Delegation**: source assigns work to target. Control remains off unless the
  user explicitly grants it.
- **Dependency**: target waits on source. The edge reports **Blocked** until the
  source is complete.
- **Message / handoff**: a visible channel for an explicit task, result, or
  progress message.

Creating a link never merges contexts and never copies terminal history. Only
the text entered in the relationship dialog is sent (a first-time control grant
wraps that text in the documented managed-terminal protocol). Click an edge
label to edit or remove the relationship. Control grants reject cycles, and a
terminal has at most one controlling parent.

## Canvas layout

Every card can be dragged freely by its body. Its `{x, y}` canvas position is
persisted by stable task ID and restored across renderer reloads and app
restarts. Directional cables and relationship labels follow the card live while
it moves. Newly created terminals get a collision-safe automatic position.

**Auto arrange** restores a clean DAG layout at any time: conductors and workers
are placed in dependency-depth lanes, while independent manual terminals remain
in their own lane. Auto arrange writes those positions back to the same
freeform model, so users can immediately continue adjusting the result.

## Display titles

Every node title is editable by double-click, Enter, or F2. The custom
`displayTitle` is persisted and used in the board, terminal header, sidebar,
inspector, notifications, and relationship dialogs. Internal column IDs,
stable task IDs, and automatic titles remain unchanged.
