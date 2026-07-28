# Conductor Board

AgentDeck's Conductor Board is a live orchestration workspace built on the
existing column and `node-pty` session model. Board nodes are not mocks. The
selected node moves its existing xterm element into the board inspector, so the
graph and the full interactive terminal stay visible together.

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
