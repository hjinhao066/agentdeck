# AgentDeck

A Windows/macOS multi-column terminal app for running AI agents side by side.
Each column has its own shell, output history and input. The Conductor Board
adds explicit task relationships without taking control of manual terminals.

The Captain can delegate public research to the local, already signed-in ChatGPT
web subscription without a Claude/Codex model turn:

```sh
node "$AGENTDECK_BOARD_CLI" new --agent chatgpt-web --title "公开调研" --task "解释水的冰点，附公开来源链接。"
# Optional: use the existing skill's verified Deep Research workflow.
node "$AGENTDECK_BOARD_CLI" new --agent chatgpt-web --web-mode deep-research --title "公开研究" --task "需要研究的公开问题"
```

`chatgpt-web` is a native executor, not a shell command. It reuses
`~/.agents/skills/ask-chatgpt-web/` and `~/.agents/tools/ask-chatgpt-web/cli.mjs`
(install that tool's dependencies first). Default chat waits up to 30 minutes;
Deep Research waits up to 60 minutes, automatically confirms the research plan
once, and must pass the skill's actual mode/report verification. Both require
the actual **6 Pro** selection; there is no model fallback. `--command` and
`--seat` cannot be combined with this executor.

The same thing is available without the command line: the **派给** picker in the
队长 column's chat composer (`派给：队长` by default) offers 网页版 ChatGPT · 普通 and
· Deep Research. With either chosen, Enter sends the text as one web request
through the same checks and queue as `new --agent chatgpt-web`
(`MainSession.dispatchWeb`), never into the 队长's terminal; the title is the first
line of the question, files cannot be attached, and the picker returns to 队长
after each request. While it is chosen the composer shows that the request is for
public research only and goes to the ChatGPT page, and that it uses neither a
Claude seat nor a launch command (the launch command of such a session is locked
in its edit dialog for the same reason).

A request waiting behind another one, or behind the cooldown, is shown as
**排队中** (card status, a hollow status dot in the column header and sidebar, the
`排队` count of the folded card line), not 干活中, until the executor reports that
the page has been opened for it. Underneath, its task stays `working` with
`webPhase: 'queued'`; the executor's `progress` events carry `phase`
(`queued`/`running`).

The task body is the exact research question, without the terminal worker
instruction suffix. The Captain must review it for credentials and sensitive
personal information before dispatch; obvious credentials are rejected before
storage/sending. Only public research is supported. `ledger`, `peek`, `receipts`,
`tell`, `stop`, and board-card `--task-id` use the usual session/receipt lifecycle.
`tell` submits a new question, not a follow-up in the prior webpage. `tell --now`
cancels the current question and sends the new one ahead of that session's queued
questions; `--replace` drops those queued questions (`--replace --now` does both).
Failed receipts show “没做成” in the ledger and status dot; cancelled work shows
“已中断”. A report excerpt and the absolute full Markdown path return through the existing completion
channel. Reports stay local under `~/reports/agentdeck-chatgpt-web/<run-id>/`.
If only the tool's final foreground self-check returns exit 98
(indeterminate/user window changes), a verified, fully exported answer is still
delivered with the self-check result in the receipt. Missing or incomplete output
still fails for both exit 97 and 98. With exit 97 (a reported foreground violation),
a verified, fully exported answer is delivered too, but the receipt starts with
`⚠【异常】工具抢了前台` and retains the existing `failed` marker: the ledger/status
dot and the Captain's unread receipt show the abnormal run, alongside the answer
excerpt and full report path. This marker reports the foreground violation, not
a missing answer. Other tool errors and cancellation retain their failure behavior.

Requests in one app execute FIFO, one at a time, with at least 60 seconds after
the previous request ends. The existing skill also protects the local browser
with its own lock/cooldown/pending-request checks. A conflicting external request,
login problem, quota limit, or timeout returns a distinct failed receipt; it is
not retried. A restart never resends a question that was already handed to the
executor. Failed/suspended requests may keep their dedicated browser tab: the
user must confirm generation has ended and close it before another request.
Missing login requires the user to log in manually; AgentDeck never logs in,
reads cookies/storage, or records browser credentials. Webpage stdout/stderr and
raw diagnostics are not copied into AgentDeck logs or conversations.

## Layout

The window follows the Cursor / Codex desktop layout, with AgentDeck's deck in
the middle:

- **待办** (sidebar, under 搜索): your own one-line to-dos, kept apart from the
  agents' task cards. Type and press Enter; ⌘T (Ctrl+Shift+T on Windows) records one
  from anywhere in the window. The phone hub has the same list. See [docs/todo.md](docs/todo.md).
- **Left sidebar** (collapsible, resizable): 新对话, 队长, 待我处理, 任务看板, 搜索, 待办, Schedule, Artifacts, Skills,
  then the 队长 row (once the Captain exists) with a folding arrow for the
  sessions it runs in the background, folders, loose sessions and 已归档.
  Every session is a live terminal column.
  待我处理 collects decisions, login/payment requests and reports that the Captain
  files; each question is shown first, with one-tap answers when the Captain
  offers them. Reply to each item with its original context for the Captain, or
  tick it into the folded 已完成 section. Two columns: 要你处理 (the sidebar number;
  only a reply or 已处理 ticks it) and 做完了你还没看 (a blue dot): a Captain report is
  read once its Captain reply, or the report itself, was on screen for 1.5 s on the
  desktop or the phone hub. Board cards that stop for the user go to
  the Captain first, never straight onto this page. The phone hub shows both computers' items. See [待我处理](docs/attention.md).
  Drag a session to reorder it, into a folder, out of one, or onto 已归档.
  Right-click or ⋯ for rename / move to folder / archive / delete. The deck shows
  sessions in exactly the sidebar order (队长 first, then folders, then loose
  sessions), so swiping walks the list; the 队长's background sessions are not
  deck columns until you open one.
  The 队长 row is pinned: clicking it selects the Captain and shows its saved
  conversation; it cannot be dragged, put in a folder, archived or deleted from the list.
  Sessions the 队长 opens with `new` run in the background: the arrow at the far
  left of its row unfolds the indented list without selecting the Captain.
  Clicking the Captain row still opens its conversation. Muted counts below it
  stay visible even when folded (干活中 / 停在确认 / 完成 / 失败 / 排队).
  The list shows
  work in progress on top (in the order it was handed out), then work waiting
  for a slot, then finished sessions, most recently finished first; it re-sorts
  as work starts and finishes.
  Captain and worker titles occupy their own full-width line and wrap in narrow
  sidebars; model badges and timestamps/actions sit below the title.
  Worker titles are slightly smaller than navigation labels and use at most two
  lines. The Captain row keeps its full height when the list scrolls. Activity
  subtitles show progress/status text, filtering out terminal shortcut hints
  and settings such as `Thinking: xhigh`.
  ⌘+/⌘−/⌘0 (Ctrl on Windows/Linux) grow, shrink and reset sidebar text when
  focus or the most recent click is outside the terminal/chat content. Titles,
  model labels and status text scale together from 77% to 154%; this size is
  saved independently of terminal/chat text and survives restart. In a terminal
  or chat, the same shortcuts still adjust terminal/chat text instead.
  Their columns keep running at a normal size but sit outside the deck, and their
  popups are left to the 队长. Opening one (from that list or a task card) shows it right after the 队长 until you move on to another
  column. 拉到前台 in its menu, or dragging it into a folder or 对话, makes it an
  ordinary session; dropping a session on the 队长 row (or 交给队长后台)
  hands it back. Sessions the 队长 only `tell`s something keep their place.
- **Center**: the deck. Two-finger swipe left/right pages between sessions; the
  top bar picks 自由 (the free-layout icon: per-column widths) or 2–5 equal
  columns. The top bar holds only 架构图, sidebar toggle, 新对话, the width
  switch, the chat/terminal switch and the right-pane toggle; 广播 is in the
  sidebar footer. It never wraps: when space runs short the width switch
  shrinks to the active choice plus a menu, and the sidebar is capped so the
  deck keeps at least 360px. Terminal output
  stays within its assigned column width, including when switching views or zooming.
  Scroll up in a terminal or conversation to pause following output. New output
  preserves your reading position and shows 有新内容 ↓ at the bottom; click it
  or scroll to the bottom to resume following.
- **Session status dots** read each terminal’s entire current screen every 1.5 s,
  including unfocused and backstage sessions. Codex Working, Claude thinking/interrupt,
  Gemini/agy timed cancel spinners and Cursor busy indicators keep the dot yellow
  even during silent background tools. Wrapped rows are joined; old scrollback
  and replayed output do not keep a finished session yellow. Once the busy
  indicator disappears, the existing two-tick debounce permits green.
  Codex's `Worked for …` divider followed by its ready prompt excludes prior
  turn indicators above that divider; new busy or confirmation rows below it
  still block delivery. Ordinary `tell` and `tell --now` use this same readiness.
  Cursor's `→ Add a follow-up … ctrl+c to stop` input row is busy evidence;
  only its ready input row can end a submitted turn, including during silent
  initialization. Thinking/Waiting/Running rows anywhere on the live screen
  override its ready row; a running turn also waits for ten seconds of quiet.
  `ledger` marks an assignment complete after its command receipt and shows a
  separate terminal status if that agent is still running or waiting. Cursor's
  session status stays working while its terminal is busy, retaining the receipt.
- **Subscription quota**: a compact 额度 block at the bottom of the sidebar has
  one row per provider: a brand-coloured icon plus name (Claude seats show only
  the flag, with a crown on the Captain's seat), then a 5h and a 7d cell, with
  "5h / 7d" named once in the header. Each cell is remaining % + reset time over
  a thin bar; used up is ⊘ + reset time in red with the row tinted red, a window
  with no number is — over an empty bar. If the whole row has no numeric windows
  or recovery time, the 5h cell shows 正常 / 已用尽 / 未知 / 过期 instead. With the
  sidebar collapsed, a gauge icon in the top bar (tinted by the provider closest to running out) opens the same
  rows in a popover. Hover, click or focus a row for
  each window with its exact reset time/date, account, seat, source, sample time,
  confidence and Captain rotation plan in one tooltip. Details stay beside the rows,
  wrap to the available width and remain inside the window when it resizes; a reset
  time breaks only between the clock and the countdown, never mid-phrase. Only one
  detail opens at a time: keyboard focus keeps its own, while the mouse can look at
  other rows past a clicked one. Config dir/model
  diagnostics stay in the row's data-detail.
  Gemini uses only agy’s Gemini pool; Cursor follows Grok 4.7 only.
  Claude shows a separate item per `claudeSeats` configuration, with both
  5-hour/weekly percentages and resets, and the running Captain’s
  seat marked. No configuration shows one `~/.claude` item; missing seat usage
  says 未登录/无数据. Remaining ≤20% is
  amber and ≤10% is red. AgentDeck passively reads live TUI screens first, then
  known local quota caches every 30 seconds. While the app is open, each Claude
  seat also refreshes independently at launch and every 15 minutes using the
  native CLI's read-only OAuth usage endpoint, without model messages. Both
  Claude items show sample times; failed reads show unknown and the query time.
  Credentials stay in the main process and authenticate only to Anthropic's
  fixed HTTPS origin; no token logging, redirects, login or token renewal.
  Codex additionally uses the official
  read-only account/rateLimits/read RPC once per minute without model turns.
  It sends no slash commands. Missing data is unknown; passive observations expire
  after 15 minutes and Claude server samples after 30 minutes. A failed Claude
  refresh invalidates its old numbers immediately, never inventing a percentage.
  See [quota sources and limits](QUOTA_SOURCES.md).
  Claude 5-hour remaining ≤2% also sends a Bark phone alert (`critical`, shared volume 4 by default),
  naming the CN/US seat and reset time when available. It uses the existing
  `barkKeyFile` setting and sends once until a newer sample recovers above the
  threshold or belongs to a reset window, including across app restarts.
  Unknown/stale quota and weekly-only exhaustion do not trigger it.
- **Right pane** (collapsible, ⌘\\): 预览, 终端 and 浏览器 tabs.
- **Archive** stops the session's terminal but keeps its conversation and last
  output; restoring replays that output and relaunches the agent. New Claude and
  Grok columns resume their own saved model session by ID; older columns without
  an ID start fresh and show a warning. Delete removes the session and its conversation.
  Click and automatic archive recheck the live screen, open turns, drafts,
  delivery and recent output of the session and its children before stopping
  a PTY. A completion receipt alone does not permit archiving a busy terminal;
  the Captain's explicit `archive --id` remains the authorized override.
- **Schedule** sends a prompt to a session (or a fresh one) once, on chosen
  weekdays at a time, or every N minutes/hours. It runs only while AgentDeck is
  open; a run that was due while it was closed is shown as missed, not fired
  late. A busy session is retried for up to 30 minutes.
  Clicking a schedule opens its detail: the prompt, next and last run, and the
  reply the last run got. Schedule also **watches tasks another scheduler runs**
  (a cron job on another machine, for one): each is described by a JSON file in
  `~/.agents/schedules/` and listed with its timetable, last run and
  「待你审核 N 条」. Its detail shows the latest report (earlier ones too) and a
  做 / 不做 with an optional reason for every numbered suggestion. A decision is
  kept on this machine first, written by the task's own command, and sent to
  队长 as a message; it never opens a card or starts work. When the machine
  holding the data is out of reach the last copy is shown with 「数据截至 …」 and
  decisions wait until it is back. See
  [docs/schedule-watched-tasks.md](docs/schedule-watched-tasks.md).
- **Artifacts** has two tabs. 回执交付 collects the files the crew listed in
  their receipts (the 「文件：」 list `ledger` prints), grouped by project, with no
  action from anyone: it reads each session's last receipt, 队长's task list and
  the task cards in 队长's conversations, so receipts from before this feature
  count too. A path appears once, under the session that delivered it last
  (Windows paths ignore case and slash direction); sessions without a project
  go under 未分组; a file no longer on disk stays listed, greyed out and
  labelled. Each row previews on the right and has icon buttons to copy the
  path, show it in Finder/Explorer and jump to the session. 回复里提到的 is the
  earlier collection: files and links the agents mentioned in their replies.
- **Skills** lists every `SKILL.md` the agent CLIs on this machine can see, so
  you can read one rendered or edit its full Markdown and save it (⌘S). See below.

私人手机网页端：设置齿轮 →「手机网页端」开启，仅监听 `127.0.0.1`。
可通过 VPS HTTPS + 自动恢复的 SSH 隧道在外访问，手机无需 VPN；入口口令、
设备 token 登录及 CSRF 保护。聊天式界面：查看队长对话、会话、只读看板与队员输出，并给队长派活。
部署、首次登录、吊销和回滚见 [手机网页端说明](docs/mobile-web.md)。

## 版本更新

Click the version (`V1.9.0`) at the foot of the sidebar: a panel rises beside
the sidebar (Esc, the × icon, the version again or a click outside closes it).
On top, 每日进展: one day's finished cards as a big number, the last days as
columns (click one, or use the arrows), then rework, rejected reviews, cards
waiting on the user, deliveries and the busiest projects. It only reads the
nightly statistics in `~/reports/daily-progress/YYYY-MM-DD.json` (written by
`~/.agents/tools/daily-progress/`; AgentDeck never recounts) and says so when
there are none yet. Below it, every version on one line, newest first: planned
ones (正在做 / 计划, items still waiting on the user marked 待你定) on dashed
dots, then the released ones with their changes in plain words. A dot on the
version button means this version's panel has not been opened yet. The copy
icon puts one version on the clipboard as plain text. The versions come from
`release-notes.json` at the repository root and the panel content is drawn by
`mobile-web/hub/releases.js`, both shared with the phone hub; see 发版流程 for
how a release updates the file.

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

队长可用「讨论一下」命令行组织 Opus 5.5 与网页 ChatGPT 6 Pro，先各自独答，
再匿名互评修订，最后保留分歧与少数派合成答案：
`node /绝对路径/新源码/board-cli.js discuss start --topic "题目、约束和需要决定的事"`。
使用现役队长终端的控制凭据即可启动后台流程，现役安装的工具要集成新版本后才有此命令。
进度、断点恢复、取消、参与者配置及额度说明见 [docs/discuss.md](docs/discuss.md)。
本次没有桌面或手机讨论入口，长文与逐轮原稿只存本机私有讨论目录。

任务看板数据、CLI、自动流转及界面的读写入口见
[任务看板接口说明](docs/task-board-api.md)。正本是 `~/.agents/boards/tasks/<项目名>.json`；
`new --task-id ... --project ...` 绑定卡片，命令回执自动流转，文件监听和每 60 秒巡检
发现外部开始操作。`TaskBoard.startCard(id)` 默认用 Gemini Flash 调度，设置可改回队长。
队长 `task move` 回 doing 不自动开调度员；未归档的关联会话阻止重复自动调度。
额度/登录/限流失败不累计连续失败；开新会话前检查所选 provider/Claude 席位额度，
已用尽的任务排队到额度恢复，显示「额度用尽，稍后自动开」。
会话恢复干活时，自动生成的「已结束，未提交回执」提示会从回执栏及任务卡清除；真实命令回执保留。
Codex 的状态行写着「Waiting for background terminal」（队员在 `sleep 300` 里等长任务）、「Waiting for agents」或「Compacting context」，或底栏有「N background terminal running」时，同样算还在干活：不发「已结束，未提交回执」，也不把会话标成已完成。队员真的干完、闲着超过三分钟没交回执，仍照常提醒。
Claude 队员回合结束后还有后台 shell / Monitor 在跑时，输入框上方的状态行会写「✻ Baked for 1m · done 8:27 AM · 1 shell, 1 monitor still running」（窄列会折成两行，中间可夹「Update available!」），输入框下方的自定义状态栏不带数字；这一行紧贴输入框时同样算还在干活（底栏的「N shell … still running」照旧认），不发「已结束，未提交回执」、不计自动归档。任务结束、状态行不再带数字后重新计三分钟，仍不交回执照常提醒。
这种「回合已结束、只剩后台 shell / Monitor」的队员，圆点照旧黄色、回执计时照旧等，但输入框是空闲的：队长的 `tell` 立即送达，不再排「待补充」干等（真正在干活、停在确认提示、额度等待时仍然等）。Claude Code 输入框里灰色的「下一步建议」是 dim 文字，不算草稿；用户自己手打的字（默认颜色）仍算草稿，`tell` 不会盖上去。队长开的 Claude 会话启动时带 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0`（Claude Code 自带开关，对应设置项 `promptSuggestionEnabled`），不再显示这行建议；用户手开的终端和自己的 Claude 设置不动。
睡眠或断网打断：会话停在提示符、屏幕写着「Your computer went to sleep mid-response」「Connection lost mid-response」「Can't reach the API server」（Claude），或「There was a network issue connecting to the server」「write: broken pipe」（agy）时，不算「已结束，未提交回执」，也不算已完成。程序等电脑醒来（系统睡眠/唤醒事件，或页面长时间没有轮询）并且网络在线后，再静置 15 秒，给它发一句简短的「接着做」（要求任务其实已做完就 complete）；之后每次间隔 30 秒、1 分钟、2 分钟、4 分钟，最多 4 次，睡眠期间和断网时一次都不发。会话重新干活并持续 1 分钟后这一轮清零，下一次睡眠重新计；每个任务累计最多 20 次。连续 4 次仍没恢复，向队长交一条「被睡眠或断网打断」异常回执（来源 sleep，不算验收不通过）。只有睡眠事件、屏幕上没有这些字样时（任务干到一半睡眠，醒来 10 分钟内回合结束且没回执），只发 1 次，仍无效就回到原来的三分钟规则。队长 stop、你自己按 Esc 中断、已经交过回执或已关闭的任务不会被续接；屏幕上引号、代码、diff 里引用这些英文不算。规则在 `sleep-resume-core.js`，会话侧在 `main-session.js` 的 `sleepResumeStep`。
Cursor 的活动标记优先于输入占位符，整个屏幕都参与判定；运行中的回合需静默至少 10 秒才判空闲。
提交完成回执后，任务仍为完成，但 Cursor 会话只要还在运行就继续显示「干活中」。
看板页面从侧边栏「任务看板」或终端架构图右上角的「任务看板」切换打开：每个项目是一个
可折叠分组（标题栏显示未完成数和各状态数量，折叠状态会记住，可一键展开/收起全部），分组共用
同一套状态列（待办 / 进行中 / 待验收 / 需要你，完成默认折成数量）和固定列头；卡片是标题加一行
最近动态和更新时间，每格默认 3 张，其余「展开剩余 N 项」。「需要你」在顶部提醒条和分组红色数量
里突出，点开对应卡片详情，可直接回答并交给队长继续推进。项目可拖动排序，卡片可在列内排序或
拖到其他状态；拖到「进行中」会通知队长安排。全部做完的项目归入底部「已完成的 Agent」。
筛选行的项目标签横向铺满整行：第一行右端是统计和工具图标（展开全部、收起全部、动效、刷新），标签先排在它们
左边，放不下就换行、从第二行起占满整个宽度；每个标签都完整显示、可以点，点一个只看那个项目。
详情中的会话入口可跳到对应终端。架构图只画正在跑的会话，看板列出全部任务。
「高优先级」是你点名要优先、要立刻开始的事：看板卡片、侧边栏会话、架构图会话卡片和手机任务列表
都带同一个蓝色旗标，同一栏里排在最前，排队等空位时也排在普通活前面。队长建卡或派活时加
`--priority high`，事后用 `task priority` 改；你也可以在卡片详情里点旗形按钮，或在侧边栏会话的
右键菜单里勾「高优先级」。细节见 [任务看板接口说明](docs/task-board-api.md) 的「高优先级」一节。
看板外观是「星图」（深色是夜空，浅色是晨空，结构相同）：卡片是玻璃质感，状态用顶边的光区分——
进行中金色（只有队员真的在干活的卡才有呼吸光晕和沿顶边流动的光）、待验收紫色、需要你橙色并带角标、
失败红色。卡片还在等的前置任务用发光连线连起来（前置在右边就从列间空隙走，同一列走左侧）：
前置在推进时线变亮，有人在做时线上有光点流动，前置卡住（失败、额度、等你）时是橙色虚线；前置被
「展开剩余 N 项」或折叠分组收起时，线接到那个折叠处。悬停、聚焦或打开一张卡会点亮它自己的连线。
标题栏有完成百分比和按状态分段的进度条，分组条底边是该项目的完成进度。卡片状态变化时滑到新位置并
闪一下新状态的颜色。动效只用位移和透明度、不用背景模糊；系统开了「减少动态效果」时全部静止。
筛选行右侧（刷新左边）的星光图标按钮是动效开关：点一下看板和终端架构图一起静止（连线、描边、颜色都留着，只是不动），
再点恢复；这个选择会记住。系统开着「减少动态效果」时按钮只提示这一点，动效保持关闭。架构图工具栏里是同一个开关。
终端架构图（v3「静夜调度台」，日夜两套）：深色是和 App 同一族的石墨灰，浅色是瓷白；画布上铺一层细点阵，跟着平移和缩放走
（任务看板仍是星空背景）。颜色只用在有含义的地方：每个项目一条自己颜色的线，需要你处理的卡（待补充、失败）整张带颜色。
队长在顶部居中，下面是项目框。
项目框横排（「智能一页」，默认就是它）：所有项目按顺序从左到右排成一行。每个框几张卡宽（1–4 张，不超过框里的卡数）
不写死阈值，由智能一页把各框的列数组合一起试一遍来定：先要整张图一屏放下（为此可以缩小，但不小于架构图 100% 的 80%，
而且卡片上最小的字——模型、账号、时间和「高优」「小队长」小标，画布上都是 11.5px——在屏幕上不小于 10 个像素：
Retina 这类 2 倍屏上就是 80%，Windows 100% 缩放这类 1 倍屏上是 124%，125% / 150% 缩放的屏幕在两者之间），再挑放得最大的（挑列数时最大按 100% 比），其次挑各框高矮最接近的（一个框比别的框高出一截要扣分），都一样时列数少的优先。
比如 11 / 3 / 1 张卡的三个项目在 14 寸 MacBook 上是 agentdeck 3 张宽、另两个 1 张宽；每个项目只有 1–2 张卡时全是 1 张宽；
一个项目 20 张卡、其他很少时它 4 张宽；窄窗口列数少一些、略缩小。窗口变大变小、会话增减时自动重算：收起侧栏、最大化、
贴边分屏这类一次性的变化马上排、框、卡片和缩放平滑移过去；连续拖窗口时跟着排，停下约 0.16 秒后（尺寸又变过的话）
再排一次，同样平滑过去。正在用的排法只要还放得下、又不比新算的差太多（缩放差不到 3%）就保持不动，免得框来回跳。
列数定下后，一屏放得下的整张图会放大或缩小到正好铺满可用区域的宽或高（留出边距），最大放大到架构图 100% 的 140%，
卡片和字一起放大，上下左右居中；一屏放不下才缩小，最小到上面的下限。放大后字仍清楚：只在拖动、滚轮和过渡动画进行时
画布才整体交给显卡缩放，一停下就按当前比例重新画字。一行要缩小才放得下、而折成几排（像文字换行，
从左往右读，排不下的接到最矮那一栏下面）能把整张图放大 22% 以上时，就折行排（比如六个只有一两张卡的项目
挤成细细一条时，折成两排放到 100% 以上；门槛特意不取 6/5、5/4 这种正好等于「几个框排一行 ÷ 少一个」的值）。
一行和折行之间也有 3% 的保持：已经是一行时折行要再好 3% 才换过去，已经折行时要差出 3% 才换回一行，
所以在同一个宽度附近来回拖窗口、差几个像素不会来回跳。缩到下限仍一屏放不下时退回按栏排：用智能一页算出的列数，项目从左往右排，窗口宽度放得下几个就排几个，
排不下的接到当前最矮那一栏的下面（几栏差不多高时先放左边），保持 100%（1 倍屏上 124%，同样是为了最小的字不小于
10 像素）往下滚着看，画布底部提示一句当前保持的比例，不出现横向滚动；窗口放不下那么宽的框时
它少几列；加减一张卡时各项目仍留在原来那一栏（新排法明显更矮时才重排），免得整张图跳来跳去。
架构图自己的 100% 是画布原始大小的 70%（1.3 及以前显示为 70% 的那个大小）：智能一页最大放大到 140%，按栏排也一样
（整张图放得下就放大铺满，放不下就保持 100%、1 倍屏上 124% 往下滚）；
缩放范围 40%–250%，「缩小 / 放大」按钮每次走 10%
并落在整十上，点中间的比例回到 100%，⌘/Ctrl+滚轮和触控板捏合照旧连续缩放。保存的视角仍按画布原始大小记
（老版本存下的值不用换算，屏幕上大小不变，只是读数变了：原来的 70% 现在读 100%，原来的 100% 读 143%）。
手动拖过卡片或项目框之后，当时那套排法会被留住，窗口再变大小也不会把手摆的位置顶乱；手动缩放平移过之后视角也归你。
所以以前手动拖过框的图，升级后打开仍是原来那套排法；点一下右下角「智能一页」就换成新的横排。「智能一页」按钮在自动排法时
是亮的，手动摆过后变暗、带一个小圆点；离开自动排法的那一次拖动可以「撤销」回去（撤销按钮出现，画布底部也提示一句）。
画布右下角（图例行右侧）的图标按钮：「一键整理」把拖乱的框和卡片对齐排回网格——按你摆的先后（像读文字一样：顶边差不多高的
框算一行、从左往右读，再读下一行）排，记住这个先后，不动你手动设的缩放，移动有过渡动画；「撤销」回到整理前
的位置和缩放（再手动拖一下就不能撤了）；缩小 / 比例 / 放大；「智能一页」把排布、先后和缩放全部交回自动，按当前
窗口重新算、缩放回到正好铺满一屏的大小（最大 140%），一页放不下时在画布底部提示一句，同样可以撤销。系统开了「减少动态效果」时整理直接到位、没有动画。
没有会话在干活/待补充/排队的项目默认收进底部「非活跃项目」托盘（真实数量，点 chip 展开到画布，失败项目标红）；
项目里再有会话开工会自动重新显示，不动你的视角。
卡片三层：第一行是状态（图标、颜色和文字，永远完整）和模型 / 账号（模型图标统一成灰色；账号是模型后面的一个小文字标签，
显示席位背后登录的账号短名，即邮箱 @ 前那段，还没识别出账号时显示席位代号 CN / US / US2；旗帜只在侧栏显示）。这一行放不下时
账号先让位，最少留几个字母、从左边省略（保留能区分 hjinhao066 和 hjinhao066us 的结尾），然后才轮到模型名，状态从不截断；
悬停账号标签看完整账号。然后是标题（最多两行），最后一行是一句最新进展和时间；进展换了新内容时这一行轻轻浮现一下。
干活中的卡显示终端里最新的一行（没有就显示会话自己用 progress 报的进展），提问、失败、交回的结果照常显示；
CLI 自己的升级提示（Update available、brew upgrade 等）、AgentDeck 打进终端的话（重发：…、（AgentDeck 约定）…、回执命令）
和重启续接时的说明不当进展显示，终端把长行折开时按整行判断。完整内容在悬停提示里；「···」或失败卡片的「查看」
打开详情浮层（完整回执、会话报的进展、实时活动、文件、打开终端；Esc 关闭）。
架构图只留当前的活：做完的队长会话没有新指令 10 分钟后自动归档（AgentDeck 重启后也照此处理，重启时已超时的在终端安静约 1 分钟后归档）；
失败或停下的会话要等它的看板卡片已完成、或同一张卡已由另一个会话接手才自动归档，没人接手的失败留在图上等队长处理。
项目框标题的数字只统计图上还在的会话（不含已归档历史），和队长框一致。
项目名不分大小写（AgentDeck 和 agentdeck 是同一个项目框，显示最早那个会话写的写法，已存数据不改）；
项目里没有任何干活、待补充、排队、失败、停下、空闲的会话（全部已完成或已归档）时，项目框从图上消失，有新会话再出现；「显示已归档」时仍列出全部项目。
连线像地铁线：队长出来的主干是中性的银灰色，每个项目一条自己颜色的线，从框左边的缝隙下来、沿卡片左侧往下，在每张卡的
状态行处进站（一个小圆点）；几张卡宽的项目在标题下方横过去接其他几列。线不穿过任何项目的标题，也不穿过别的项目框；
同一栏里排在下面的项目框，线从栏与栏之间的空隙走下来。执行中的线路更亮、带一圈柔光，上面有一小段带拖尾的高光沿线流动；
有会话在干活时，队长下方的总枢纽每隔几秒向外扩一圈淡光。结束的线变细变暗、不动；审查是紫色虚线；悬停卡片高亮它从队长出发的整条路径，其余连线变暗。
小队长分层：队长用 `new --sub-captain` 开的会话是小队长（它的列上 `subCaptain: true`），它开出来的会话列上记着
`subCaptainId` = 小队长的列 id（交回总队长时删掉）；只有这个 id 指向一个还开着、标着 subCaptain 的列时才算分层，
小队长被归档或关掉、标记没了、指向的列不在了，这些会话就回到队长下面。旧的 create-child 记录（子会话的 parentTaskId
是父会话的 taskId）也照样认。小队长卡片标题前有一个项目颜色的「小队长」小标（和队长同款的小皇冠，悬停看带了几个队员）。
它的队员排在它正下方、往里缩进一级（队员再派的再缩一级，最多缩两级），下面垫一块项目颜色的浅色托底框，从小队长卡片
底部沿缩进的那道缝画线进到每个队员卡片左侧；队员跟小队长待在同一个项目框里，小队长连同队员占一列、排在框里最前面，
其他会话排在旁边。队长的线只连到小队长；队员交的结果和提问给小队长，不画回队长的线，提问时状态写「在问小队长」，
交回的标记写「结果已交回小队长」。悬停一个队员会高亮队长 → 小队长 → 它的整条线。
卡片是安静的实心面板：干活中只有状态图标在转、进展前有一个项目颜色的小圆点，卡片本身不发光不闪；待补充整张浅橙底、橙色细边和一圈淡橙光晕；
失败同样换成浅红底和红边；做完的标题稍淡；排队的是虚线框。项目框是铺在点阵上的一张底板（遮住点阵），标题左边是项目颜色的小方块。
队长卡是一条「指挥栏」：反色的皇冠图标、大号数字的计数（细竖线分隔），下面一条细彩条按状态分段显示全部会话各占多少。
项目框标题两行：项目名（折叠箭头在右端），下一行是计数（项目标题和图例里的状态图标不转，只有卡片和队长的转）。
架构图标签右边的清单图标从右侧滑出「版本进度」抽屉（架构图让出位置，不被遮住；Esc 或关闭图标收起，
开合状态会记住）。版本取 agentdeck 项目卡片里提到的、比当前 App 新的最小版本号（如 1.1.4）。
纳入这一版的卡：① 点名——`version` 字段、标题或说明写了这个版本号；② 在做——agentdeck 里进行中、
待验收或等你的卡，且没写更晚的版本号；③ 已纳入——之前在这一版里出现过，做完也留着打勾；
④ 前置——上面这些卡 `depends_on` 的卡（顺着依赖链找，跨项目也算）。归档卡只算完成的。
抽屉顶部是百分比和按状态分段的进度条，下面按 需要处理 / 进行中 / 待验收 / 待办 / 已完成 分组，
每张卡显示标题、状态点（完成打勾）、负责模型、最近回执一句话和耗时（从建卡算起），
看板文件变化时实时刷新。规则也写在抽屉底部「哪些卡算进这一版」里。

侧边栏队长行只占一行：皇冠、状态点、队长、小数字徽章（干活中的队员数）、模型胶囊和切换账号按钮；
各状态计数、最近活动时间和当前状态行放在悬停提示里。

队长行的 Relay 图标可选 CN 🇨🇳、US 🇺🇸、US2 🇺🇸（美国二号）三个独立 Claude 席位，
或 ChatGPT（Codex GPT-6.1 Sol）：
先存进度看板，再重开队长读看板继续，运行中的队员保持原席位。
侧边栏底部齿轮统一配置席位名称、目录和 Relay 名称。旧 CN/US 配置自动补 US2，额度区同时显示旗帜与名称以区分 US/US2；未登录 US2 不影响现有席位。
用户登录步骤见 [Claude 席位](CLAUDE_SEATS.md)；队长 `new --agent claude --seat us2` 可指定席位，`quota` 显示三席独立额度。默认开启「永动机」：
当前 Claude 的可信 5 小时剩余 ≤3% 或真实限流时，在队长空闲后自动接力
下一个可用 Claude 席位（US2 → US → CN → US2，未登录或用尽跳过）；没有已确认可用的 Claude 席位时交给 Codex GPT-6.1 Sol，恢复后优先回 Claude。
额度区的手动轮换按钮只在 Claude 席位之间切换；所有 Claude 席位用尽后的 Codex 接力由永动机执行，或从 Relay 菜单明确选择。
设置可关闭或改阈值。每次轮换留横幅、对话记录及普通 Bark 提醒，10 分钟内不回切同一目标。
默认打开「优先用快到期的席位」图标开关：当前和目标席位的 5 小时余额、每周额度和重置时间都可信时，
队长空闲后优先使用重置至少早 10 分钟、还有可用额度的席位；同边界抖动不切换，数据未知时只保留低额度切换。
每周剩余 ≤ 阈值的席位不能接力，也不预热。额度详情有一行说明当前席位、预热和切换策略。
目的席位的 5 小时和每周额度都必须有新鲜、归属匹配的采样且高于阈值；
重置时间到不等于额度已恢复，必须重新采样确认。未知或过期数据先刷新（每席位最多每分钟一次），
刷新失败继续跳过，已确认可用的席位按既定顺序轮换。周额度耗尽的席位无需移除配置，恢复后自动回池。
新队长有三分钟启动监督：必须送达提示词且观察到工作输出或队长命令；启动时限流或退出立即视作失败，
否则到时仍未开工就尝试下一个已确认可用的席位，再兜底 Codex。失败重试不受普通十分钟冷却限制，
同一轮不会重复尝试已失败的席位；连续三次失败或没有剩余目的地即停止，
通过 `notify-user --urgent` 相同通道发本机与手机紧急提醒。失败次数、期限和停止状态跨应用重启保留。
输入框有未发送内容时不会强行替换。处理后手动 Relay，或在席位设置重新开启永动机，可开始新一轮。
这些检查仅在 AgentDeck 运行时有效，外部安装器必须自行保证宿主退出后的恢复。
`perpetualCaptain.order` 仅控制顺序，删除其中一个 ID 不会禁用该席位；目前没有单席位禁用开关。
首次第二账号登录、凭据隔离和 quota-bar 数据接口见 [CLAUDE_SEATS.md](CLAUDE_SEATS.md)。

席位设置默认开启「额度窗口预热」：有账号及目录归属证明的 5 小时窗口重置约
一分钟后，配置列表中的席位没有 Claude 会话占用时，后台用 Sonnet 5.5 / low 发送一个字母请求。
当前队长的窗口到点后也会在它空闲、同席位没有其他会话时补一次；普通输入恢复会取消补请求。
新官方采样确认新窗口已开始计时后，再按上述规则去使用另一个更快到期的窗口。
每个窗口成功一次，失败最多重试一次；未知重置时间不发送。请求不创建可见列或队员，
额度详情显示已预热及 CLI 原生返回的下次重置时间。席位开始普通会话会取消预热子进程。
永动机和预热直接消费官方额度分支保存的 `config.quotas['Claude:<seatId>'].sample`，
复用 `fiveHour` 的剩余百分比、绝对重置时间及成功采样时间；不另行查询额度。
官方采样核对席位、配置目录和凭据槽位指纹；账号或目录变化后，旧采样不能触发自动操作，
该限制保存到磁盘并跨重启保留。新官方采样确认所有窗口可用后，可解除旧的无期限限流记录。

One standing column, opened from the sidebar entry 队长 (creating it the first
time, with the agent you pick; afterwards it only returns to it). Once created it
also has its own pinned row at the top of the session list. There is only ever
one, always the first column of the deck. You tell it what
you want; it hands the work to other columns and brings back short receipts. It
does not do the work in its own column. On restart, an existing Captain is briefed
again with the current provider, model and effort instructions.

在队长设置中可关闭「重启后自动续上」。冷启动只恢复退出前尚未完成的队员任务，每批最多两个；正常新建和归档恢复仍走普通派发。完整任务、最后回执和未送达补充指令保存到私有配置与 `restart-resume.json`，不截断正文。每轮启动按任务记录送达 claim，连续重启仍能续派；`complete` 已关闭的卡片不会被迟到的续接复活。

真续接要求列自己的明确会话号及工作目录归属；无法证明归属时新开重发，不从全局最近会话或唯一工作目录猜号。Codex、Cursor、Antigravity 的 `complete` / `ask` / `progress` 会携带各自 shell 工具环境中的 `CODEX_THREAD_ID` / `CURSOR_CONVERSATION_ID` / `ANTIGRAVITY_CONVERSATION_ID`，经本列回执认证后保存归属，并支持重启及归档恢复时续接原对话。新终端不继承父进程的这三个 ID；还没提交过回执、CLI 没注入有效 UUID、目录变化或 ID 与另一列重复时，仍新开重发。Codex metadata 完整读取首行，agy 数据库中的任意文件 URL 不作为归属凭据。每次尝试的终端启动和批次排队最多等待 30 秒，获得槽位后卡片核验与指令送达最多等待 45 秒。原会话启动失败或未能按时送达时，同列重开一次并重发卡片任务、最后回执和补充正文；重发仍失败则向队长交失败回执。指令送达即算续接成功，之后的进程退出或额度耗尽按普通任务失败处理，不再新开重发。卡片已关闭、归档、待验收或转交时，停止旧任务并向队长提交含会话、任务、卡片和停派原因的回执，不改动已关闭或转交的卡片。退出给收尾指令最多 800ms 的送达机会；应用暂停不代表队员已确认安全停工。退出等待页面落盘最多 1.5 秒，另有独立进程 5 秒 OS 退出兜底。


- It controls every session (ones it opened, ones you opened, terminals you started
  yourself) through `node "$AGENTDECK_BOARD_CLI" ledger | new | tell | read |
  receipts | answer | peek | quota | briefing | handoff | stop | archive` (`node "$env:AGENTDECK_BOARD_CLI" …` in Windows PowerShell
  columns), run in its own terminal. Only the 队长's terminal holds the
  control capability token those commands need. Every column has a separate
  submission-only token, so a worker can report its own task without controlling
  any session.
- Use `new --project "项目名"` to group sessions on the terminal architecture
  map and `--reviews id1,id2` to declare exactly which sessions a reviewer checks.
  One Captain directly assigns work, workers sit above reviewers, and completed
  projects fold into a summary. Project chevrons save your fold/expand choice.
  These remain real sessions that you can open and speak to directly.
- New sessions it opens use the same launch command as the 队长 (Claude: bypass
  permissions) unless it picks another with `--agent claude|agy|cursor|grok|codex` or a full
  `--command`. Its instructions list the providers and the models their CLIs report
  on this account, with a routing preference: ordinary execution (bulk work,
  imports, routine backend changes, tests, deployments and migrations) to Antigravity
  `gemini-3.8-flash-high` or Cursor `grok-4.7-high-fast`; architecture, key decisions,
  reviews and UI design to Cursor CLI
  `claude-opus-5-5-high`, then `claude-sonnet-5-5-high` (or Claude Code), and Cursor's
  `grok-4.7-high-fast` only when those are unavailable. The standalone `grok` CLI is
  not used unless you name it. It also picks an effort tier per task: `medium` for
  simple work, `high` for ordinary code, `xhigh` for complex work or a task that
  already failed, `max` for the most critical. Cursor takes the tier as the model
  id's suffix (`claude-opus-5-5-medium|high|xhigh|max`, same for
  `claude-sonnet-5-5-`); so does Antigravity (`gemini-3.8-flash-low|medium|high`,
  no xhigh/max), Claude Code takes `--effort`. Before a session starts, `new`
  checks the command: an Antigravity `--effort` is folded into the model id (agy
  otherwise silently switches to another model) and a missing `--model` gets
  Flash; Claude 4.x and Haiku 4.x or older (including the bare `haiku` alias) are
  refused with a message telling the 队长 what to use instead. Haiku 5.5 is allowed
  (Claude Code `--model claude-haiku-5-5 --effort medium|high`, measured on claude
  2.1.294; Cursor's `claude-haiku-5-5-<tier>` and `claude-haiku-5-5-thinking-<tier>`
  pass the check too) and is the 队长's first choice for simple, lightweight work;
  Codex GPT-6 Luna is the fallback when Claude quota runs short.
  On macOS/Linux, app launches invoke the Codex binary directly so a shell
  function that adds `--yolo` cannot duplicate the explicit bypass flag.
  The 队长 can read observed subscription quotas with `quota` and switches
  provider when a worker reports a limit. At most the configured concurrency limit (default 30) background sessions work at
  once: a further `new` waits (its card says 等空位, the only thing called 排队) and starts by itself, oldest
  first among available providers, when one finishes. Quota-held requests do not
  block available providers. `queue list` shows unsent requests with their card/queue
  ids, launch commands and wait reasons; `queue cancel --task-id <card-or-queue-id>`
  cancels one (repeating it is harmless). `new --task-id` with a changed launch command,
  model or Claude seat replaces the old queued request and starts when its provider
  and a slot are available. An unchanged command is refused. Moving a card to
  `done` or `todo` through `task move` or the board UI cancels its unsent request.
  Queue responses distinguish quota, critical memory, the actual occupied-slot
  count and earlier executable requests; the concurrency limit is not an active count.
  To reopen verification, use `new --task-id <card-id> --reviews <original-worker-id>`.
  This binds the card's existing review round, including after an explicit move back
  to `doing`: a leading `通过` completes it; `不通过` or `--failed` returns the full
  findings to the original worker, restoring it if archived. The reviewer receipt
  never starts another review, and repeated reviews of the same execution round
  count as one failure. Queued reviews cannot bind a later execution round.
  Live sessions waiting on exhausted quota keep their lifecycle/archiving protection
  but release their work slot. A finished background session is archived after 10
  minutes with nothing new once the 队长 has its receipt (never one you have
  open); `tell` to it restores it first, and `ledger` lists those and the waiting work.
  Archiving ends the terminal, so a session that is working, waiting on an
  answer or has printed anything in the last minute is never archived, by the
  app or by a click, and nothing asks about it (a click on a busy one only
  shows a short notice). The Captain can explicitly interrupt it with
  `stop --id <session-id>` (Esc, keeps the terminal, cancels unsent supplements),
  or end and archive it with `archive --id <session-id>` even while busy, without
  a confirmation dialog. Both commands protect the Captain's own session.
  If a new session stops on a startup dialog before the task can go in (Cursor
  asks "Do you trust this workspace?" in a folder it has not seen), nothing is
  typed into the dialog; the 队长 is sent its text once and answers with
  `answer --key enter`, after which the task goes in. `answer --key` takes one
  key (`y`, `n`, `1`-`9`, `enter`, `esc`, `tab`, `space`, `up`, `down`, `left`,
  `right`) or a comma list that is pressed one key at a time, such as
  `down,enter` or `down:2,enter`. A lone `y`/`n`/digit is still followed by
  Enter; a list is exact. Claude Code's folder-trust menu starts on "No, exit"
  and leaves on `1`, `2` and `y`, so only `down,enter` picks "Yes, I trust this
  folder". For a Claude session in a copy made by `new --worktree` the menu does
  not come up: see the code copies paragraph below.
  New sessions appear under the Captain's folding arrow and get the task as
  their first message; opening one reveals its column temporarily. The app
  appends a contract: finish without waiting on the user, then submit through
  the agent's shell tool:
  `node "$AGENTDECK_BOARD_CLI" complete --result "One to three sentences" [--files path1,path2] [--failed "Reason"]`.
  Use `ask --question "Decision needed"` to ask the Captain, and
  `progress --message "Current progress"` for long work. PowerShell uses
  `$env:AGENTDECK_BOARD_CLI`; Bash uses `$AGENTDECK_BOARD_CLI` on either platform.
  Files are absolute paths, separated by commas. Do not include file bodies.
  The CLI, private control directory and submission token are inherited by
  Claude, Codex, Antigravity and Cursor, including manually opened sessions.
- Command submissions are authoritative and preserve the original Unicode,
  whitespace, result, question, failure and file paths without terminal reflow
  or truncation. A submission is
  shown as a card in the 队长 column (click the title to jump there), stored as the
  column's last receipt, and read through the Captain's background channel.
  With Claude Code, the Captain runs `receipts --wait` using Bash
  `run_in_background: true`. The command blocks until unread receipts, questions
  or confirmation notices arrive, prints their summaries and exits. Bash's task
  completion notification wakes the model; after processing it the Captain starts
  another listener, keeping exactly one active. A timeout prints nothing and exits
  successfully and the Captain quietly starts a replacement without a user update.
  Omit `--timeout` to wait indefinitely. Local interactive Claude Code 2.1.288+
  supports background commands without a time limit (including the installed
  2.1.289); older versions and unattended/SDK runs require a finite Bash timeout:
  use `receipts --wait --timeout 6900` with Bash `timeout: 7200000` (115/120 minutes).
  See [Claude's background command limits](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands).
  A private per-Captain exclusive lease prevents duplicate consumers, and every
  wait checks the application instance and its Captain capability. Restarting the
  app or ending/replacing the Captain invalidates the old wait; it exits within
  the next polling/check interval instead of becoming an orphan.
  The app monitors process death and existing quota, throttle, login and
  confirmation/permission states through its status loop. Silence thresholds are
  30 minutes for Codex/unknown agents, 20 for Claude and 15 for Gemini/agy/Cursor.
  These create labelled abnormal receipts immediately on detection. Silence
  requests inspection; it does not end, retry or reassign a thinking worker.
  Each task's ongoing exception is reported once: answering a prompt or returning
  to work rearms input notices, and new tasks always receive their own failure
  receipts. Silence is deduplicated per task and last-output timestamp, retained
  across restarts; fresh output rearms a later silence notice. Relay reminds its
  new Captain of unresolved input even if the previous Captain read it. An exit with code zero before
  a command receipt is also an abnormal receipt, rather than a successful task.
  If unread receipts have waited three minutes with no live listener, the app
  sends one fixed reminder through the existing guarded Captain prompt path
  when its agent is idle and the user's input is empty. Receipt text stays in the
  channel; no repeated model heartbeat is scheduled. Reading all pending receipts
  or registering a new listener rearms this exceptional reminder.
  The timeout is in seconds
  (other legacy CLI commands retain their existing timeout units).
  Codex execution session IDs do not by themselves wake an idle model. An
  opt-in [native Codex Captain host](docs/native-codex-captain.md) owns a private
  app-server and uses native tool-output turns for 60-second whole-board checks.
  It confirms stable receipt IDs only after successful turns; it does not inject
  receipt text into terminal input. Existing Codex columns need an intentional
  Captain command switch after runtime integration; installing the script alone
  does not connect them. Claude's existing listener channel is unchanged.
  An instruction added to a session that is still busy
  shows as 待补充 and goes in when the session frees up.
  It does not expire while waiting: after 30 minutes the Captain receives a
  single 仍在排队 reminder, and delivery continues waiting for an idle prompt.
  If the session exits or becomes unavailable, its failure card keeps the full
  unsent instruction. The receipt includes `read --id <task-id>` to retrieve it
  even after the worker has gone; unsent text is not in the worker's chat history.
  Additions waiting for the same session are combined in order into one prompt,
  with one receipt contract; their cards point to the last card for the result.
  `tell --to <session-id> --message "…" --replace` cancels all unsent additions
  and keeps this one. `--now` first sends Esc and then sends the additions as
  soon as the input is ready; combine `--replace --now` to send just the new
  instruction. Both keep the user-input guard. Quota exhaustion automatically
  creates a failed task receipt with the
  provider's reason. The terminal stays open with 额度用尽/等待 in the dot/sidebar;
  pending additions cannot be delivered until the quota screen clears. Agent
  launch wrappers report every exit before a command receipt as a failure even
  when the parent shell stays alive; PTY exits include their exit code/signal or spawn error.
  **Receipts never pass through the Captain's input box.** They also stay out
  of your next chat message. The background command uses the same Captain-only
  capability token as `receipts`; workers and independent terminals cannot read
  it. A cancelled listener leaves no long-lived request to consume later receipts.
  Agents without background completion notifications can read `receipts` manually.
  The legacy input injection path is an explicit fallback: with AgentDeck closed,
  set `mainSession.legacyReceiptInjection` to `true` in its userData `config.json`;
  absent/false is the default background mode. Set it back to `false` to disable
  both idle injection and inclusion in your next chat message. Legacy injection
  and work handed to sessions still wait for an empty, quiet input box and protect
  your keys during paste/Enter. A worker stopped at a confirmation prompt is handed
  to the 队长 with only the prompt's last lines; it answers with `answer` when sure
  and asks you otherwise. A pause between tool calls, between two instructions or a silent
  start (Cursor can print nothing for a minute or two) is not a stop: a turn that
  ended without a command receipt gets a three-minute grace period. Only a
  finished, uninterrupted turn can trigger the
  fallback: “已结束，未提交回执”, with no screen content or inferred files.
  Claude workers whose live footer still reports background shells/monitors/tasks
  running remain busy even after the model's reply. They produce no missing-command
  receipt and cannot auto-archive; the three-minute grace starts after their
  background work ends. Old quoted counters and zero/completed counts are ignored.
  The Captain's own permanent receipt listener does not keep its foreground busy.
  Screen 【回执】/【提问】 blocks, examples, contract echoes and Doing… never count
  as submissions. A late command replaces the fallback notice. Prompt submission
  waits for the paste redraw
  to settle before pressing Enter once, including in background sessions.
  Legacy receipts and ledger summaries have at most **300 characters of summary
  and 5 file paths**. Command-submitted receipts remain complete in the receipts
  channel. Overflow
  says `其余见 read`; the worker's saved reply and local task card keep the source
  receipt. Questions and confirmation prompts keep their existing formats.
- `peek --id <session-id> [--lines 40]` reads live terminal output, with ANSI
  styling removed (1–1000 terminal rows). It reads the active screen and recent
  scrollback, even while someone is reading older output. It sends no input,
  changes no focus or scroll position, and never restores an archived session.
  Unlike `read`, it does not read saved chat replies.
- The heartbeat is the app's status loop: it checks each dispatched column's state
  every 1.5 s and never copies a column's full output into the 队长.

### 自动回执入口 (scheduled scripts)

A job that runs on this computer without any AgentDeck terminal (launchd, Task
Scheduler, cron: the nightly bug hunt is one) has no terminal token, so the
Captain commands refuse it. It uses its own door instead:
`node <config>/board-control/tools/agentdeck-board.js automation receipt|task-add|inbox-report|status --source <script name> ...`
(`automation help`). The door has a token of its own that the app makes and keeps
(`board-control/automation.json`, mode 600, never shown on screen), works only on
this computer, and can do exactly three things, each marked 「自动任务：<名字>」 and
never shown as the user's words: tell the Captain (a receipt it reads as a notice,
not as an order), add a 待办 card (it starts nothing), file a 结果汇报 on
待我处理. It cannot dispatch work, `tell`, read a conversation or change a setting;
extra fields are refused, and it is rate limited (6 a minute per name, 12 in all).
Settings has a switch to stop it and a button to reset the token. An older
AgentDeck has no such door and the command fails, so a script should fall back to
a report and a local notification. See [自动回执入口](docs/automation-receipt.md).

### Battery mode (电池模式)

Settings → 电池模式 → 没插电时: **省电** (default) or **不限制**, plus how many sessions may be open at
once on battery (1–10, default 3; greyed out under 不限制). Electron's `powerMonitor` reports the power source at launch and on every
`on-battery` / `on-ac` event, so it switches at once in both directions; on `resume` and `unlock-screen`
it asks again in case a plug change during sleep sent no event. A failed read counts as plugged in.
Plugged in, or set to 不限制, every value below is exactly what it was before.

On battery (`battery-core.js` holds the numbers; the page, main process and tests share them):

- **Concurrency**: the live cap is `min(settings cap, battery cap)`. Sessions already working above it are
  never stopped. New `new` requests join the ordinary queue, the card says 电池供电，稍后自动开, and they
  open by themselves when a slot frees or the Mac is plugged in. Raising the battery cap or choosing 不限制
  fills the free slots at once. Like the settings cap, it only limits opening new sessions: `tell` to an
  open, idle crew member is not held back, so more sessions than the cap can end up working.
- **Task text**: work handed to a session ends with 当前电池供电：不要跑全量 E2E，只跑相关单测，E2E 留到接电后
  (decided when the text is sent, so work that waited and went out after plugging in does not carry it).
- **Calm UI**: motion is held off (star map, board, status-light halos, drag cable) without touching the
  user's own 动效 switch; terminal cursors stop blinking.
- **Slower background polling** (normal → battery): status tick 1.5 s → 3 s, board request pick-up 250 ms →
  750 ms, quota cache re-read 30 s → 2 min, Claude seat tick 30 s → 2 min (one seat is actually sampled every
  15 min instead of 5), seat list refresh 30 s → 2 min, captain watchdog 1.5 s → 3 s. Receipts and questions
  still arrive; they only wait a little longer for the next pick-up.
- A small battery icon (one low charge segment, no lightning bolt, neutral color) beside 额度 in the sidebar
  (and in the toolbar while the sidebar is collapsed) shows only while battery mode is active; hover it for
  what is limited, click it to open settings at 电池模式.
- `ledger` and `quota` end with one extra line only while battery mode is active: the live cap and how many
  sessions work. Plugged in or 不限制 they print word for word what they did before.

**临时拉满 (boost)**: the main way to get full strength while away from the charger, and it leaves battery mode alone.
When the user tells the Captain 「强度拉满」, the Captain runs `settings battery --boost on [--for 2h | --until 23:59]`
(`--boost off` takes it back). While it is on, battery power no longer lowers the live cap (`BatteryCore.effectiveCap`:
the settings cap still rules), waiting work opens at once, and the battery mode, its limit, the calm UI and the slower
polling stay as they were. It ends by itself when the Mac is plugged in (and does not come back on unplugging), when 不限制
is chosen, at its end time, or when someone cancels it. It is kept as `config.batteryBoost = { until }` (0 = no end time) so a
restart keeps it, unless it has ended. Asking for it while nothing limits (plugged in, or mode 关) is refused with a reason.
It shows as 已临时拉满 in: the sidebar battery icon (tooltip and name), the desktop settings box (a row with an × that cancels
it), the phone hub's 设置 card (a 临时拉满 box with the length 直到取消 / 2 小时 / 今天 23:59, one button to start it and an ×
to cancel), and the Captain's `ledger` / `quota` line.

**Changing it from elsewhere** (the desktop settings box is not the only way; the page stays the one owner of the
setting, so these go through it and never edit `config.json` behind its back):

- **Phone / tablet hub**: the gear icon in the hub's top bar opens 设置, one card per computer with 电池模式
  (自动 / 关) and the 电池并发上限 stepper (− / +, 1–10). A tap is applied at once through `GET/POST <prefix>api/battery`
  (login, CSRF and same-origin checks like every write; body only `mode` and/or `cap`, validated on the desktop). A computer
  on an older build answers 404 and the card says to update it instead of showing controls.
- **Captain**: `node "$AGENTDECK_BOARD_CLI" settings battery` reads (mode, limit, power source, what applies now);
  `settings battery --mode off|auto [--cap 1-10]` changes it. Out-of-range or unknown values are refused with a reason,
  never clamped.
- Either way (`MainSession.setBattery`): the shared state changes, the live cap follows and waiting work that now fits opens,
  `config.json` is written immediately, and an open desktop settings box shows the new values. Lowering the limit never
  stops running sessions. `off` lifts the limit while keeping the saved number for later.

Tests simulate the power source: unit tests inject a `BatteryCore` state; the E2E starts on AC and emits
`powerMonitor` events (`AGENTDECK_TEST_POWER=battery` starts a test instance on battery).

### Automatic context saving (Claude Code Captain)

Enabled by default at **150k tokens**. Open the sidebar's **settings icon** to
change the threshold in k tokens or turn it off. The setting is saved locally.
AgentDeck reads the live TUI status rows below the input box, such as
`Context: … 290k/1000k`, including wrapped rows. A percentage alone, a missing
status or a quoted line in a reply does not trigger it. Other agent providers
are not sent Claude's `/clear` command.

When usage is strictly above the threshold, the Captain is idle with quiet output,
and both its chat composer (including attachments) and terminal input are empty:

1. The Captain column's top line announces the process, with a cancellation icon.
2. AgentDeck sends `把当前进度写进 ~/.agents/boards/ 对应看板，写完只回复 已存档`.
3. Only that turn's final reply `已存档` permits `/clear`. Failed or missing
   acknowledgements leave the context intact; a stage times out after 5 minutes.
4. Once the live usage drops below half the previous usage and the Captain is
   idle again, AgentDeck resends its instructions with `读看板继续`.

No terminal is restarted. The column, workers, task cards and unread receipts
stay in place. The conversation before `/clear` is checkpointed into a separate
read-only Captain history file; it is not sent back into the model context. Every
send rechecks the idle and user-input guards.
New user messages cancel the remaining steps. The cancellation icon also stops
the next steps, but cannot undo a command already being submitted. Cancellation
or failure pauses automatic retries until usage falls back to the threshold
(or the user saves new settings). If `/clear` does not reduce the reported usage,
rebriefing waits and then pauses with a notice. This relies on Claude's status
and acknowledgement; AgentDeck does not inspect or independently verify the board.

The Captain's instructions also require: `不读大文件正文，只看报告的结论段；查进度优先 peek`.
Use `read` only for details needed from a saved worker reply.

When you submit a reset yourself, AgentDeck also rebriefs the Captain:

- Claude: `/clear`, `/reset`, `/new`; Codex: `/clear`, `/new`, including a
  single-line name. Both the composer and commands typed in the raw terminal
  are observed. Other providers, worker columns and bare shells are excluded.
- A submitted command arms a candidate for 60 seconds. Success requires a newly
  emitted `Conversation cleared`, `Context cleared` or `(no content)` line,
  used/total footer tokens falling below half their previous value, or Codex's
  native `% context left` footer showing the same drop in used context. A startup
  title or screen repaint alone is insufficient. Failures and cancelled workspace
  pickers do not confirm a reset; a new unrelated submission drops an unconfirmed
  candidate. Low-context Claude clears can be confirmed by
  `(no content)` even when no numeric decrease is available.
- On confirmation, the pre-command conversation is saved to Captain history
  without replacing the column or PTY. Unread receipts, questions and live task
  cards carry over. The current instructions are sent once. Their closing
  paragraph tells the Captain to run `handoff` first and follow its takeover
  steps: report ready when nothing is open, carry on unprompted when authorised
  work is out, and leave paused or cancelled work alone. That paragraph is
  not appended again: the briefing has to stay inside its own 10,000-character
  inline limit (`MainCore.BRIEFING_LIMIT`), past which it is replaced by a
  file pointer that hides the closing. The delivery waits for an idle
  agent, three seconds of quiet output, and empty composer/terminal input,
  including attachments, and rechecks these guards when sending.
- Raw terminal history recall, Tab completion and cursor edits make the tracked
  command uncertain and are deliberately excluded. Multiline pastes, quoted
  slash commands and Ctrl+L never arm detection. If a CLI gives no success line
  and no measurable footer decrease (for example an already empty Codex context),
  automatic rebriefing cannot confirm the reset. Use `briefing` as the fallback.

`node "$AGENTDECK_BOARD_CLI" briefing` prints the complete current Captain
instructions, with original newlines. It is read-only: it does not send input,
consume receipts or save the response to config. Only the Captain capability can
use it. When the user says `你是队长`, first run `ledger` to verify that this
terminal is the Captain, then read `briefing` and `handoff`.

`node "$AGENTDECK_BOARD_CLI" handoff` prints a one-page overview of the Captain
handoff (hard limit 6000 characters, `config.captainHandoffOverview`) and rewrites
`~/.agents/boards/agentdeck-captain-handoff.md` plus seven detail files in
`~/.agents/boards/agentdeck-captain-handoff/` (all unfinished tasks, waiting
receipts and questions, what waits for the user, delivery state, older decisions,
older user messages, the takeover playbook). The overview starts with one
pointer line to the user profile (`~/.agents/memory/about-user.md`, read on demand,
not quoted), then the user's
latest words, what is running and waiting, high-priority tasks, the decisions in
force, and a table of contents; nothing that is squeezed out of the page leaves
the files. It is read-only for sessions and cards. The same page is written when a
seat Relay replaces the Captain. The briefing holds the stable rules, the
handoff the changing state; see [docs/relay-handoff.md](docs/relay-handoff.md). An
installed version that returns
`Unknown action` for `briefing` needs this feature integrated and installed; a
source branch alone does not change the running app.

The queue verification and command semantics are documented in
[Captain control report](docs/captain-control-report.md).
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

Sessions open in terminal view on startup, when selected after another session
or page, and when created or restored. The icon button to the right of 自由 / 2–5
switches every current column to terminal, then back to chat. Its icon and
tooltip show the next action. A column’s own 终端/对话 toggle switches only
that column; it stays in that view until you leave for another session or page.
The next global click unifies all current columns again. The global choice resets
to terminal on the next app launch.
Each turn in chat shows
your prompt (pinned while you read its answer) and the agent's final reply,
rendered as Markdown, not commands or tool output. The real terminal is still
running underneath: use the 终端/对话 toggle in a column header to switch.
Prompts typed in the raw terminal also appear in the chat, including Chinese
text; terminal mouse reports are excluded. Each prompt and final reply has a
visible copy button that copies its plain text. Older chats containing repeated
mouse-report fragments are cleaned when loaded, preserving adjacent text.

The chat reads in a centred column, each reply under the name of who is speaking
(队长 with its crest). An agent's reply shows its words only: the echo of a
prompt, a file-diff tail, tool summaries and the TUI's own hints are taken out
when it is shown, by the same rules as the phone page, and its titles, nested
lists and tables are set as such; copy and share give the same clean text. The
saved reply is unchanged, and a plain shell's output is shown as it is. The
cards 队长 leaves between two messages (work handed out, receipts back) sit
folded behind one line with their count and state; click it to open them.

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
  --dangerously-skip-permissions --effort high`, `agy --dangerously-skip-permissions --model gemini-3.8-flash-high`
  (Antigravity's effort is the model id's suffix, `-low|-medium|-high`; given
  `--effort` beside such an id it silently runs a different model), `grok --permission-mode bypassPermissions`, `cursor-agent --force --model claude-opus-5-5-high` (`cursor-agent`,
  never `agent`, which other tools also install), Codex with the managed options
  supported by its local `--help`. AgentDeck probes the executable once per app
  run, removes unsupported saved options, and adds the bypass option and
  `--no-daemon` only when available. Older Windows Codex versions can launch
  without `--no-daemon`; model and resume arguments are preserved.
- The composer takes pasted screenshots, dropped files and files picked with +
  as attachments; they are sent as paths ahead of the text.
- Prompts have no length limit. One longer than 8000 characters is saved as a
  private `.txt` in userData/`long-prompts` (pruned after 60 days) and the agent
  gets its opening plus "read this file first"; the bubble shows the file. The
  Captain's own briefing is the one exception: it is pasted whole up to 10,000
  characters, so its rules and closing paragraph are never behind a pointer.
- Automatic sends (Schedule, 队长) never type into a bare shell, which would run
  each line as a command: on macOS/Linux they wait until something other than the
  shell is in the column's foreground; on Windows until the agent's screen shows.
- Left sidebar rows and column header leftmost compact identity badges show
  the tool/provider (Cursor, Antigravity/Gemini, Claude, Grok, Codex/ChatGPT)
  alongside the short current model label (e.g. `Opus 5.5`), updating live
  when switching models inside the CLI while preserving the tool provider (for
  instance, Cursor remains Cursor even when running Claude or Gemini models).
  The last confirmed provider, model and effort are saved with the session and
  restored after relaunch; saved chat replies and prior terminal output are
  checked when recovering older sessions without a known agent launch command.
  The launch command fixes the tool identity; the actual TUI footer (including
  Claude's custom Opus/Sonnet statusline) supplies the live model. Model examples
  above that footer and cached models belonging to another tool are ignored;
  the launch model is used when no valid live or saved model is available.
  Model families such as Grok, GPT-6
  Luna and Meta Muse Spark appear in the label even when Cursor is the launching
  tool. Full provider, model and effort appear in the tooltip; plain shells
  display no fake model.
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
- Cmd/Ctrl minus, plus and zero adjust the terminal and chat text together (8–32,
  default 13). The native View menu uses the same control; it does not zoom the
  page, so the sidebar and column geometry stay stable.
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

The Captain alerts the user when a reply finishes and stays quiet for 12
seconds, or when its terminal stops at a confirmation/input prompt. Completion
is still a screen/quiet-output heuristic when no recognized busy indicator is
present; a live busy indicator keeps the turn open even without new output. Independent
manual terminals also alert when a turn submitted by the user (composer or raw
terminal) finishes and stays quiet for 12 seconds. Automatic sends, startup,
restored history and resumed sessions do not arm manual alerts; a new user
submission is required after every restart or renderer reload. Workers
never create notifications, popups, sounds or Dock badges, including while peeked
or moved to the foreground. Worker questions and receipts go to the Captain.

- Uses native macOS Notification Center / Windows system notifications, with
  title 「队长」 or the manual terminal's title and the reply's first sentence
  (at most 60 Unicode characters). Clicking restores the exact column without
  redirecting a stale ID.
- Settings (gear icon) independently toggle system notifications and sound.
  macOS offers Glass or Tink, played for at most one second at 35% playback volume.
  Windows uses its default notification sound; unavailable native notifications
  are gracefully skipped.
- Sound is muted when AgentDeck is focused and the notifying column is visible.
  Each turn alerts once (including input followed by completion); sounds from
  consecutive turns are at least 30 seconds apart. Resumed work retracts an old
  notification. Settings persist in the local profile.
- Confirmation detection requires dialog controls (options, y/n or a confirmation
  footer). Prose such as Gemini's “waiting for confirmation” is not a prompt.
- macOS requires notification permission and a signed application. OS Focus /
  Do Not Disturb can suppress banners. See the [Electron native notification API](https://www.electronjs.org/docs/latest/api/notification).

Settings → **Bark 本机密钥文件路径（barkKeyFile）** saves only a local path,
for example `~/.secrets/bark-key.txt`; the file contains only the device key.
An empty path uses the Captain’s existing private file `~/.secrets/bark-key.txt`;
an explicit path takes precedence (an unreadable explicit file never falls back to another device). The authenticated Captain can send
`node "$AGENTDECK_BOARD_CLI" notify-user --message "需要你亲自操作"` for a local
alert, adding `--urgent` for Bark (`critical`, volume 4, `minuet`).
`node "$AGENTDECK_BOARD_CLI" notify-user --test` sends a **【测试】** Bark alert
with `critical`, the same configurable volume **4** by default, and `minuet`; use `--test` alone.
On Windows PowerShell use `$env:AGENTDECK_BOARD_CLI`.
Workers cannot use this command. Phone alerts require Bark's critical-alert
permission and are independent of local notification/sound toggles. Missing or
invalid key files return a setup hint; network errors are redacted. Tests use
isolated profiles and a fake transport, never the real key or phone.

Settings → 通知 also configures the shared critical volume (0–10), sleep quiet
hours (default **23:00–10:00**, Seattle time, including daylight saving), and class quiet hours.
Every Bark path, including offline installation-result alerts, follows these
hours. Local reminders and Captain receipts are still recorded immediately.
Phone reminders are kept in private `userData/bark-pending.json`, deduplicated
by category/seat or identical content, and merged into one push when quiet hours
end (checked every 30 seconds while AgentDeck is open). Immediate daytime alerts
also enter the durable queue before sending; failed sends stay queued and retry
after one minute, for at most 24 hours. With a blank key path and no default key
file on this machine, the phone push is skipped with a setup hint instead of queued. Settings shows the last delivery error, and seat-alert failures
also leave a persistent Captain question receipt. Restarting restores the queue; while the app is closed
there is no timer to deliver it.

Class quiet hours use the locally authenticated `gws calendar events list` CLI,
reading expanded events for the next 14 days once every 24 hours after success and
caching only start/end times in private `userData/bark-calendar.json`. The defaults
match IMT 540 and IMT 598 B on the primary calendar; Settings can edit calendars,
course names and weekly fallback periods (`barkNotifications.weeklyClasses`).
Cancelled/declined and all-day events are excluded. Missing CLI/auth, incomplete
reads, or stale caches use the configured weekly course periods in Seattle time.
The current defaults are Tuesday/Thursday 10:30–12:20 and Tuesday 15:30–17:20;
update these each term. A fresh calendar, including an empty holiday schedule,
takes precedence. Clearing weekly periods leaves only sleep protection; Settings
explicitly warns that classes may then ring. A failed fetch retries after 15
minutes (also after restart); changing calendars/course names or the refresh icon
can retry immediately. The CLI receives the app’s augmented PATH. Refresh also
retries phone delivery, still respecting all quiet hours. If a process died during
sending and delivery is uncertain, automatic retries pause, Settings and a Captain
seat-alert receipt explain it; check the phone before explicitly refreshing.
A successful send whose cleanup write fails only retries disk cleanup, not sending.
The app does not install the CLI or request calendar credentials automatically.

The legacy watch-ai bridge is disabled, including with `AGENTDECK_LEGACY_WATCH=1`,
to avoid bypassing this policy. Child terminals export
`AGENTDECK_NATIVE_NOTIFICATIONS=1`; external hooks must honor that guard. For the
known Windows `~/.claude/hooks/claude-popup.ps1`, `node scripts/migrate-popup-hook.js`
backs up and adds the guard without affecting terminals outside AgentDeck.
The bundled xterm does not play audio for terminal BEL.

### Codex receipt environment

AgentDeck adds `--no-daemon` to Codex launches when the local executable lists
it in `--help`, including custom commands and restored sessions. Unsupported
managed options are removed before launch; a failed help probe falls back to
launching without those options. A shared Codex app server uses its own process environment
and can lose the current terminal's receipt/control channel variables. Embedded
servers inherit the column environment. This does not edit Codex user settings.
See [Windows compatibility](docs/windows-codex-launch.md) for the version-specific
investigation and verification procedure.

The bridge prefers environment credentials when this process's controlling
terminal has no private file. If a shell policy filters the tokens, the
standalone bridge reads the credential file indexed by that tty
(`board-control/credentials/by-tty/`), never by `AGENTDECK_TERMINAL_ID`: a
shared Codex daemon keeps a stale terminal id and must not select another
column. An empty `CONTROL_DIR` does not search the home profile. The managed
copy can locate its own profile without `CONTROL_DIR`; it never searches other
profiles.
Files are private (0600, directory 0700 on POSIX), rotate when a PTY starts, and
are removed on spawn failure, PTY exit, archive/kill, quit and the next app startup.
Workers retain submission-only capabilities; only the Captain has control access.
These capabilities route trusted local processes and are not an OS sandbox.
Already running Codex sessions must be relaunched to adopt the new launch flags.

## Development and builds

Use Node.js 22.12+ or 24 LTS and `npm ci`. node-pty 1.1 includes Node-API binaries
for Windows x64/arm64 and macOS x64/arm64, so those platforms do not require a C++
toolchain for ordinary installs. `npm run rebuild` is an explicit source-rebuild
fallback and requires the appropriate compiler toolchain.
The install check also restores executable permissions on the macOS PTY helper;
the upstream npm tarball otherwise installs that file without execute bits.
The build downloader is pinned to `@electron/get` 5.1.0 so electron-builder's
older downloader does not pull in the vulnerable HTTP cache dependency chain.

```sh
npm test
npm run test:smoke
npm run test:e2e
npm audit
npm start
npm run dist:win
npm run dist:mac
```

### 发版流程

全量 `npm run test:e2e` 大约 191 项，单线程要 30 分钟以上，本机内存紧时还会超时。小版本不要拿它当发版门禁。

- **功能分支**：只跑 `npm test`，再加上和这次改动相关的 E2E spec。不要在功能分支上跑全量 E2E。
- **发版**（小版本打包前）：跑 `npm test` 和 `npm run test:smoke`。冒烟复用现有用例，用 Playwright 标签 `@smoke` 标出，不另抄一份测试。命令是 `playwright test --grep @smoke --workers=1`，单 worker，目标 5 分钟内。覆盖：应用能启动并显示主界面；队长用 board-cli `new` / `tell` 派活且队员收到；队员回执回到队长；会话归档后能恢复；终端能显示输出；额度区能显示；任务看板能打开。
- **全量**：`npm run test:e2e` 夜里跑，或换一台机器跑。冒烟通过不能代替全量。

冒烟故意不包含已知容易超时的路径：队长并发上限和自动归档等待、屏幕回执的三分钟兜底、通知静默窗、十一路架构图验收、席位轮换，以及会整应用重启的用例。这些仍留在全量里。

**发版必须先写「版本更新」**：在仓库根目录的 `release-notes.json` 里，把这一版加到 `released` 最前面（版本号如 `2.0`、日期 `YYYY-MM-DD`、一句标题、3–6 条写给用户看的大白话，每条不超过 60 字），并把它从 `upcoming` 里拿掉；顺手更新 `upcoming`（接下来做什么，用户还没拍板的写 `"state": "pending"`，界面上显示「待你定」）和 `updated`。只改这一个文件，桌面端（侧栏底部点版本号）和手机总台（总览最下面、平板侧栏底部的版本号）都读它（每日进展另读本机统计文件，不在这个文件里）。漏改有两道提醒：`npm test` 里的 `tests/release-notes.test.js` 要求最新一条等于 package.json 的版本；`scripts/release.js` 合完分支、升完版本号后先查这一条，不对就停下，不进测试和打包。规则写在 `mobile-web/hub/core.js` 的 `releaseProblems`。

本机 Mac 可用一条命令准备发版（先收齐已验收的分支，避免边合边反复测试、打包）：

```sh
node scripts/release.js --base origin/release/1.1.11 origin/fix/example --dry-run
node scripts/release.js --base origin/release/1.1.11 origin/fix/example
# 显式版本接受 1.2、1.2.0 或 1.2.1；从 1.2.0 默认进到 1.3.0
node scripts/release.js 1.2 --base origin/release/1.1.11 origin/fix/example
```

先自行 `git fetch origin`，再指定基线；默认基线是当前 HEAD。省略版本号时进一位次版本号：1.1.11 → 1.2.0，分支/目录对外叫 `release/1.2` / `agentdeck-release-1.2`，默认不生成 1.1.12；显式 patch 版本可用于补丁发版，必须严格高于基线，非零 patch 的分支/目录/安装脚本标签使用完整版本（如 1.2.1），避免覆盖 1.2 的产物。原先只接受 .0 是 1.2.0 集成时按次版本发版的约定，现正式支持补丁版本。脚本把基线和待合分支解析成固定提交，在独立 worktree 依次合并；冲突即停止，报告列出文件，手动解决并提交后按原命令续跑。已有目录必须属于同一发布计划，其他 worktree 和历史报告不会被覆盖。`--worktree DIR` / `--output DIR` 可另选绝对路径，输出须在源码目录外。`--dry-run` 只读，不创建目录、不测试、不打包。

已手动审查并合并的发布分支可用 `node scripts/release.js 1.2.1 --prepared --output <源码外独立目录>`。要求当前分支为与完整版本对应的 `release/1.2.1`、工作区干净、package.json 与 lockfile 三处版本一致；该模式不创建 worktree、不合分支、不升版本，保留依赖准备、持锁单测/单 worker 冒烟、audit、打包及校验/耗时报告。可加 `--dry-run`；不可与分支列表、`--base`、`--worktree` 共用。

只需交付「包就绪」、安装和手机部署另行安排时，加 `--package-only`：

```sh
node scripts/release.js 1.2.4 --prepared --package-only --output /Users/jinhao/reports/agentdeck-1.2.4/fast-release --dry-run
node scripts/release.js 1.2.4 --prepared --package-only --output /Users/jinhao/reports/agentdeck-1.2.4/fast-release
```

该选项保留完整单测、单 worker 冒烟、audit、正式 `dist:mac -- --publish never`、SHA256、DMG 挂载校验、签名和包内运行文件逐字节校验，沿用输入一致时的测试/构建缓存；不生成安装脚本，也不构建、上传或核对手机总台。计划固定记录 `packageOnly: true`，同一输出目录不能切换模式；JSON/Markdown 成功状态为 `package-ready`，手机状态为 `deferred`，不能据此称手机部署或线上验收通过。`--dry-run` 明列跳过和延期事项；不带此选项的默认流程保持以下手机部署门禁。

流程：同步 package.json 与 lockfile 版本 → 核对 `release-notes.json` 最新一条就是这一版 → 依赖安装/原生模块检查/Electron 准备 → 持全机锁依次跑单测和单 worker 冒烟，audit 并行 → 签名 DMG → SHA256 与强制校验挂载/签名/全部运行文件逐字节核对并行 → 生成安装脚本 → **自动构建/上传手机总台，保留精确回滚点，从公网核对版本、提交、构建时间和资源字节** → JSON/Markdown 逐步耗时报告。手机步骤最多尝试 3 次，失败恢复部署前链接并停止，退出非零；未部署、缺回执、线上版本不符均在发版报告标 🔴。桌面构建命中缓存也不能跳过手机部署。`--dry-run` 不部署。详情见 [手机部署与核对](docs/mobile-release.md)。测试锁统一为 `/tmp/agentdeck-test.lock`，owner 记录进程、分支和时间；失败或取消会释放自己的锁，锁等待时长单列入报告。其他测试命令也须持这把锁。脚本不会删除别人的锁；只有超过 40 分钟且 owner 进程确已退出时才能人工清理。

`release.js` 自己持锁，直接运行它即可，不要在外层再拿同一把锁。单独运行 `npm test` 或 E2E 命令时，用 shell 加外层锁，结束时删除自己的 owner 文件并释放目录。

子进程清除现役 `AGENTDECK_*` 凭据；调用者环境保留，仍能提交自己的回执。同一 worktree 的依赖安装可复用；成功测试和构建只有在完整 Git tree、依赖文件/权限、Node/平台/系统/签名与测试环境都相同时复用，DMG 还须通过哈希校验。首次依赖指纹计算与门禁重叠执行，异步遍历并分块读取依赖，哈希期间持续读取测试和 audit 的输出；audit 每次运行，缓存包每次重新核对。

发版脚本不合 main、不打 tag、不推送、不安装、不退出或启动应用；默认正式执行会更新 VPS 的手机静态总台，并写出 mobile-deploy-result.json，`--package-only` 则延期全部手机步骤。结果默认在相邻 `reports/agentdeck-1.2/`，默认内含 `install-1.2.sh`，它调用仓库的正式安装引擎；`--package-only` 不生成它。安装统一用此入口或 `scripts/restart-agentdeck.sh`，回滚用 `scripts/rollback-agentdeck.sh`；禁止会话临时手写安装脚本、添加 launchd 失败重启任务。

手动指定发布产物时运行：

```sh
bash scripts/restart-agentdeck.sh --go --dmg /absolute/path/AgentDeck-X.Y.Z-arm64.dmg --sha256 <SHA256> --version X.Y.Z
bash scripts/rollback-agentdeck.sh --go --backup /absolute/path/backup
```

不带 `--go` 只显示计划，不再内置历史版本的 DMG 路径或校验值。

正式安装引擎 `scripts/install-agentdeck.js` 使用一次性 detached 子进程，不注册 launchd，也没有 KeepAlive 或失败自动重启。校验 DMG/签名/目标版本/asar、备份旧应用与用户数据后，最多尝试安装三次；失败恢复旧应用并退出。结果原子写入 userData 的 `install-result.json`，包含目标版本、现役版本、进程状态、尝试次数与失败原因。成功要求目标应用已启动并持续存活，磁盘上出现新版本并不算完成。真实安装证据须加入最终报告，不能用 fixture 测试冒充。

安装会话开始前通过 `progress --install-id ID --target-version VERSION --message "安装待核对"` 登记待核对（正式脚本负责调用）。普通 `complete` 无法结束待核对的任务；应用启动后读取并持续检查结果文件，匹配原任务后提交成功或失败回执。停在安全点、准备安装均只用 `progress`，不用 `complete`。安装失败或回滚走 `notify-user --urgent`；应用停机时复用同一 Bark 发送器离线推送，说明目标版本、失败原因和现役版本。密钥仍从本机配置的密钥文件读取。

入口使用稳定的安装标识和 `install-entry.lock`／`install.lock`／`install-claims` 阻止并发、崩溃后重入及同一安装包重新计数；不会自动删除遗留锁。发现上次 pending、未确认结果或已有 claim 时会拒绝开始，请先检查日志、结果与所属进程，处理失败原因后再由维护者清理相应标记。托管会话必须使用支持待核对协议的应用版本；旧版不能确认登记时安全退出，不以普通 progress 冒充成功登记。`--with-data` 仅允许独立终端使用，避免覆盖正在运行的任务控制状态。 若回滚到尚未包含结果读取机制的旧二进制，它不能自动提交新协议回执；离线 Bark 仍报告失败，结果文件保留，卡片不得据此冒报成功。

Mac distribution uses the local `AgentDeck Dev` signing identity, pinned in `build/signing-identity.json`.
macOS privacy grants follow the app's designated requirement, so every release must keep it
(`identifier "com.jinhao.agentdeck" and certificate leaf = H"<pinned sha1>"`); `scripts/release.js` runs
`scripts/signing-check.js` before the build and on the packaged app and fails on an ad-hoc fallback.
Never recreate the certificate; see `docs/macos-signing-and-permissions.md`. On a CI host
without that certificate, use `CSC_IDENTITY_AUTO_DISCOVERY=false` and
`npx electron-builder --mac --config.mac.identity=null --publish never`.
CI builds are unsigned and not notarized; they are not equivalent to a signed
local installation. Windows CI produces an NSIS installer. Its build step sets
`ELECTRON_BUILDER_7Z_FILTER=BCJ`: the NSIS decoder cannot read the ARM64 filter
that newer 7-Zip selects for bundled ARM64 PTY binaries. Use the same setting
for local Windows packaging and compare the installed files with the CI payload.

Test a packaged app with `AGENTDECK_TEST_EXECUTABLE` set to its executable before
running `npm run test:e2e`. Tests use temporary userData and empty shell columns,
never the real layout or live agent sessions. Test windows are shown without
activating the app; each spec opens its own instance, and CI runs the suite once
against source and once against the packaged app. With `--test-user-data=<dir>` the
Skills page scans `<dir>/skills-home` instead of the real home folder, so tests
never list or edit the user's own skills.
Fixture cleanup first requests normal Electron quit, then kills only its isolated process tree
after 10 seconds if native teardown stalls, with an explicit warning in the test log.
This cleanup is not a graceful-shutdown assertion; `restart-resume-exit.spec.js`
checks actual exit separately and does not use that fallback.

Windows E2E shell probes run script files rather than inline `node -e` code,
so PowerShell cannot reinterpret JavaScript quotes or Windows path backslashes.
The stand-in agent uses raw input like a real TUI. ConPTY may convert alternate
screen switches to redraws; peek tests check real PTY output and the xterm
alternate buffer separately. A ConPTY terminal name is not a foreground-process
name, so shell readiness is verified by the command's output.
The first automatic prompt in a Windows terminal waits for 500 ms of quiet TUI
output, avoiding startup input loss. Later prompts keep the existing delivery checks.
`captain-briefing-paste.spec.js` sends the Captain briefing, and one grown to
exactly 10,000 characters, through a real PTY to stand-in agents and compares
what reached their stdin with what was sent. `real-cli-briefing.spec.js` is
skipped unless `AGENTDECK_REAL_CLI` names installed CLIs. With `claude,codex` it
runs that real CLI as the Captain with an empty config directory and a local
stand-in for its model API (no login, no quota), and compares the CLI's own model
request with the briefing. With `cursor,agy` it uses that CLI's own login
read-only (a little quota) and checks that the model can answer codes hidden from
the first to the last line of a 10,000-character text. Run it on each platform
before raising `MainCore.BRIEFING_LIMIT`, and when a Captain CLI changes how it
takes a paste. Results so far, including the real Codex TUI on Windows mangling
pasted prompts of any length, are in `docs/captain-briefing-checklist.md`.
ConPTY reset evidence, replay filtering and deck navigation fixes apply only on
Windows; macOS keeps its existing reset, status and navigation behavior.

Security boundaries: the renderer is sandboxed with a restrictive CSP and no
Node integration. Main IPC accepts only the deck's local main frame. Session
identifiers are validated before file access. Session replay is capped at 200k
characters per column and written atomically. Local processes running as the
same OS user remain trusted; the board token is not an OS security sandbox.

AI contributors must follow [AGENTS.md](AGENTS.md), including immediate commit
and GitHub synchronization after every completed change.

See [CONDUCTOR_BOARD.md](CONDUCTOR_BOARD.md) for managed task operations.

## Two-machine sync (1.2)

Mac and Windows each run AgentDeck and talk to one sync service (the existing
VPS is the intended deployment target, reached over WireGuard). This branch
does not deploy that service or configure either installed app. The app heartbeats every sync round, every 10
seconds, and the service marks a machine offline 45 seconds after its last
heartbeat, which covers shutdown and sleep. Task cards, their fields, and
saved captain transcripts are shared; a change is visible on the other side
within a minute. Edits to different fields of the same card merge. Edits to
the same field stay as two copies and the card shows 冲突. The sidebar section
两机 shows online/offline, the last-seen time, and any sync error.

The service is `node sync-server.js --data <dir> --token-file <path>`. Bind it
to the WireGuard address when it is deployed; the default listen address is
loopback. Each desktop keeps its settings in `userData/fleet.json` (not the
deck `config.json`, which the window rewrites):

```json
{ "baseUrl": "https://sync.example", "tokenFile": "/absolute/path/to/token" }
```

The token file contains only the token. It is not committed, not passed on the
command line, and not written into logs or task JSON. `~/.agents` git sync is
unchanged and is not the live channel. This build does not choose which
computer runs a task, move work off a sleeping machine, or switch captains
from a phone. Cards and sessions carry `deviceId` for those later steps.

Offline edits persist in `fleet-state.json`. A request retains its operation ID
and original payload until acknowledged, even across a process restart; later
edits wait separately and are rebased on the accepted card. Snapshot downloads
preserve pending edits, including changes made by other local board writers.
Older revisioned task snapshots restored by Git keep their older revision when
submitted, so they cannot silently replace newer server edits.
Repeated operations do not increment a card revision or add a second conflict.
All conflicting alternatives and captain turns are retained. Older transcript
prefixes cannot shorten newer history; divergent saves retain the prior version
in the history record's `alternatives`. Credential-shaped fields are stripped,
but transcript prose is preserved, so sync only to a trusted private service.
Requests time out after 10 seconds and retry on subsequent sync rounds.
If the hub loses a card or rolls back behind a pending edit's revision, the
client discards that edit's old base and queues the complete local card with a
new operation ID and revision zero for the next round. Newer local fields are
retained as conflicts if an older hub copy already exists. A failed individual
task or transcript upload stays queued and visible as a sync error while other
uploads and snapshot downloads continue. Store ID indexes have no prototype,
including after loading JSON, so prototype-shaped IDs are ordinary keys.

Serialize local verification with the whole-machine `/tmp/agentdeck-test.lock`
before running unit tests, E2E, or the transport smoke. Record the owning PID,
branch and start time in `owner`, and remove that file and directory on exit.

Run `node scripts/fleet-two-machine-smoke.js --ssh winpc --report /absolute/report.md`
for a repeatable native Mac/Windows transport check. It uses fresh temporary
stores and credentials and an SSH reverse forward bound to loopback. It verifies
the production 10-second sync interval, 45-second offline lease, two-way task and
captain history propagation, conflicts, operation replay, and offline outbox
recovery after a peer process restart. It removes its temporary directories and
forward when done. Omit `--ssh` to rehearse with a separate local Node process;
`--quick` shortens timers only for that local rehearsal. This does not exercise
the Windows Electron UI or install, rebuild, or restart either installed app.



Coding tasks can pass `new --worktree <repo> [--base ref] [--branch name]`. AgentDeck adds a git worktree under `~/agentdeck-worktrees/<repo>/<branch>` and starts the session there. After the session is archived, the copy is removed only when the tree has no uncommitted, untracked, stashed, or ignored files and the branch is merged into main/master (or origin's default branch) or is still present on a remote. Any ignored file or directory blocks that automatic removal, including `node_modules`. A copy whose ignored content is entirely inside `node_modules`, and whose branch is already merged or pushed, is marked manually cleanable and listed by `worktree clean` with its path, branch, a summary of the ignored content, and the size. Other ignored paths, such as `dist`, `build`, `out`, and `.env`, are kept and named, and are not offered in that list. `worktree clean` only lists. Deleting one copy requires `--apply` and `--path` for that copy, and the same checks run again. Removal never uses `git worktree remove --force`.

Claude Code asks "do you trust this folder" once per directory and judges a linked worktree on its own path (trust for the repository or a parent folder does not carry over), with "No, exit" as the default row. So that an unattended session does not die there, AgentDeck records the answer itself right after it creates a copy and before the session starts: `projects[<copy path>].hasTrustDialogAccepted = true` in the global file of the Claude seat that will run the session (`~/.claude.json` for the default seat, `<seat dir>/.claude.json` for the others), written the way Claude Code writes it (same lock directory, atomic rename, other content untouched). Only that one directory is recorded (its real path, and the path as given when they differ); the repository, `~/agentdeck-worktrees` and the home folder are never trusted, a damaged seat file is left alone, and only a linked worktree under `~/agentdeck-worktrees` is accepted. Other agents do not change Claude's seat file. If the record cannot be written the task still starts and the 队长 is told once; it can then answer the menu with `answer --key down,enter`.

Antigravity (`agy`) and Cursor CLI (`cursor-agent`) also receive startup directory trust for copies AgentDeck creates with `new --worktree`, and for directories the Captain explicitly names with `new --cwd`. AgentDeck saves that exact authorization on the column (`trustedCwd`); automatic reviewers inherit it only while the executor's cwd still matches. Default/inherited directories, manual columns, edited directories, home and filesystem roots receive no automatic trust. Startup is bound to the authorized directory even if a shell profile changes cwd. Compound shell commands, argument expressions/escapes and CLI workspace overrides (`--workspace`, `--add-dir`, `--worktree`/`-w`, `--project`, etc.) keep the normal manual confirmation path.

- **agy:** before launching, append only the directory and its real-path alias to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, using the official CLI's exact-string format and native path separators. The installed official CLI's `CliSetting.IsTrustedWorkspace`/`Store.TrustWorkspace` confirm exact membership, without parent-directory inheritance. Existing settings and trust entries are retained; writes use a temporary file and atomic rename. Invalid JSON, malformed trust arrays and nonregular files are kept intact and a toast reports registration failure. No screen prompt is automatically answered.
- **Cursor:** launch with its official `--trust` flag, which records the CLI's own workspace decision before displaying a trust dialog. Interactive support requires **Cursor CLI 2026.07.20 or newer**, as described in the [official release notes](https://cursor.com/docs/release-notes); older interactive versions are not covered. AgentDeck does not write Cursor's internal `.workspace-trusted` markers or enable additional permission flags.

Both paths use the same code on macOS and Windows (agy's Windows config is `%USERPROFILE%\.gemini\antigravity-cli\settings.json`; Cursor handles its own state). Regression tests cover native Windows path spelling and PowerShell launch construction. Windows hardware/CLI execution has not been verified for this change. Tests use temporary homes and stand-in programs; no live trust configuration or model session is changed.

A prompt that carries an image path (for example a screenshot) is turned into an attachment by Claude Code, which says "Pasting…" in its footer while it reads the file and drops an Enter pressed meanwhile. AgentDeck therefore waits (at most 30 s) until that footer is gone before it presses Enter, so the task is submitted instead of sitting in the input box.

The Captain briefing is static across turns and context resets. Claude workers must use an explicit `--model claude-opus-5-5` or `--model claude-sonnet-5-5` and `--effort`, then be checked with `peek`. Nontrivial user tasks go into `~/.agents/boards/` before dispatch. Important work is checked by Gemini 3.8 Flash; failures go back to the worker for up to two rounds before the Captain handles escalation. When every Claude seat, Codex, Cursor and Gemini is exhausted or below the threshold and work must not stop, the briefing lets the Captain open a pay-as-you-go DeepSeek-backed Claude Code (`claude-ds` by absolute path, Mac only) for simple to medium work; it is outside every measured quota pool, so it opens while the subscriptions wait. Notification and token-saver controls share the Settings dialog.

Claude's macOS quota reader and seat-isolated Relay are described in
[Claude usage API](docs/claude-usage-api.md). Claude percentages in quota UI and
`board-cli quota` are remaining; `↻` identifies each window's next reset.
Confirmed Claude-seat/Codex credential logout raises critical Bark with the
seat's login command and a Captain question receipt; the quota panel shows red
`未登录` with a pale-red row and a login-command copy icon in its details.
Two explicit provider samples at least 30 seconds apart are required; network
failures do not alert. Details, polling delay and provider coverage are in the
same usage document.
