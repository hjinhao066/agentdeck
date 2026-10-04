# Native Codex Captain host (opt-in)

This adapter drives the entire task board while AgentDeck is open, without a
new user message. It owns one private `codex app-server --listen stdio://`
process in the Captain column's environment. Every 60 seconds it takes an
authenticated board/receipt snapshot; an idle Captain with open tasks, running
workers or unread receipts gets a native `turn/start` with `input: []` and a
`toolOutput`. Busy ticks coalesce. The model verifies receipts, checks the board,
resolves blockers and dispatches the next work. An empty completed board does
not start a model turn. Checks of active boards use model tokens.

This is a separate launch mode. Existing `codex --no-daemon` Captain columns
remain unchanged and **are not connected** by installing a script. Their
embedded app-server has no externally addressable endpoint. A generic
`exec_command` session or completed command item is not an idle-model wakeup.
`codex queue` cannot attach to that embedded instance. No terminal input is
injected to deliver receipts or initiate periodic checks.

## Deploy to an existing Captain

1. Integrate this branch into a new complete application runtime. The installed
   1.1.2 runtime does not contain this adapter. It needs the native
   host/driver, authenticated `receipts --snapshot/--ack` bridge, and Captain
   command-edit identity fix. Copying only the script into an older running
   AgentDeck is insufficient. A new installed application runtime requires the
   normal coordinated app restart; do that after current work is safe. This
   task does not install, stop or restart the live application.
2. Once that runtime is running, finish the current Captain acceptance round,
   save the task-board handoff and let its current serial receipt wait exit.
   Do not leave a Claude background listener or another external receipt reader
   consuming this same Captain's queue. Do not resume its old Codex thread in a
   parallel process. The board is the handoff boundary, not the old model memory.
3. On the Captain column header, click the existing pencil button
   **编辑（标题、目录、启动命令）**. Keep the working directory and replace the
   startup command with:

   ```text
   node "/Users/jinhao/Library/Application Support/agentdeck/board-control/tools/codex-captain-host.js" gpt-6.1-sol
   ```

   Use the actual profile's `board-control/tools` path if different. `node` and
   an authenticated `codex` CLI must be available on PATH. Tested local Codex:
   `0.160.0`. Save. This deliberately replaces **only the Captain PTY/context**;
   AgentDeck keeps its worker columns, board, pending receipts and old Captain
   chat. Captain identity/control credentials are updated to the replacement
   column before it can accept new board commands. The normal Captain briefing
   is sent once as startup setup; automatic checks use only the native RPC.
4. The terminal displays `OpenAI Codex · native Captain host`. Within the next
   60-second idle check, open work/unread receipts cause a native model turn.
   Confirm a real acceptance/next dispatch and receipt acknowledgement; process
   existence or that header alone is not proof of successful continuation.

**Relay is not required.** The existing default ChatGPT Relay command still
launches the ordinary Codex TUI; selecting it alone does not enable this host.
After the host-enabled runtime is installed, this switch needs only a Captain
restart, not an app restart. This is a minimal plain-text native host, not the full Codex TUI; it
supports ordinary prompts and `/clear` or `/new`. Codex TUI-specific menus and
its quota/context footer are not supplied. Default worker launches use ordinary
Codex, never another Captain host; explicit `--agent` continues to work.

## Recovery, ownership and rollback

- A private profile lock permits one host. A live owner is rejected; only a
  dead process's lock is reclaimed. One timer is created per host. Clearing
  the native thread rebinds that timer; it does not add a listener.
  The host first authenticates as the current Captain. Native-mode columns
  reject consuming `receipts`/`receipts --wait` calls, and switching to this mode
  disables legacy input injection so a second delivery channel cannot drain
  or inject the same queue.
- The binding records the Captain column ID and native thread ID. A restart
  resumes that same native thread only for that same column. A never-used empty
  native thread has no persisted rollout; in that specific case it starts fresh.
  Errors for an existing thread otherwise remain visible, not silently discarded.
- `receipts --snapshot` returns up to 50 pending records with persisted stable
  `receiptId`s, without draining them. `receipts --ack '["id"]'` removes only
  those exact IDs, idempotently, after the delivered native turn completes
  successfully. Failed/interrupted turns, RPC/ack failures and crashes leave
  records available for retry. Late arrivals are not accidentally acknowledged.
  Backlogs over 50 are retained rather than silently truncated.
- Delivery is **at least once across crashes**. A model may finish a side effect
  before its acknowledgement is persisted. The model instructions require
  checking receipt IDs and durable board/task state before repeating dispatches.
  This does not promise arbitrary side effects exactly once.
- Roll back through the same pencil button: restore the previous Captain
  command (normally `codex --no-daemon --dangerously-bypass-approvals-and-sandbox`).
  Saving replaces only that Captain, closing its owned native server/timer.
  Unacknowledged receipts remain; workers and board remain. Resume the Captain's
  previously agreed serial waits. Do not leave a second reader running.
- The CLI script's Ctrl+C closes its own host/server, not any worker. Do not use
  global `pkill codex` or restart the application merely to switch launch modes.

## Verification

The opt-in tests run real Codex in isolated AgentDeck profiles with stand-in
workers that submit authenticated `complete` commands:

```sh
npm test
npx playwright test background-receipts.spec.js native-receipts.spec.js --workers=1
AGENTDECK_NATIVE_CODEX_SMOKE=1 npx playwright test native-receipts.spec.js
```

In a managed terminal, clear inherited `AGENTDECK_*` only in the test child
process, then set the test flags there. Keep the parent receipt environment.

The native integration test proves complete → native turn → board verification
→ a proof artifact and exactly one follow-up dispatch → successful-turn receipt
acknowledgement, with no receipt text injected into the Captain terminal. It
also rejects a second host and verifies clear/recovery. The separate entry test
uses the actual host copied to `board-control/tools`, launches it by the Captain
pencil edit, preserves worker routing, and proves a receipt is handled under the
production 60-second timer. The first test verifies a 75-record backlog across
renderer reloads, a snapshot larger than 12 KB, late arrivals and idempotent ack.
None of these tests attaches to the currently active production Captain.

Protocol reference: [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
`turn/start` accepts native `toolOutput`; merely inserting history items or
observing command completion does not itself initiate a model turn.
