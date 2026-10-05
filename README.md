# AgentDeck

A Windows/macOS multi-column terminal app for running AI agents side by side.
Each column has its own shell, output history and input. The Conductor Board
adds explicit task relationships without taking control of manual terminals.

## Layout

The window follows the Cursor / Codex desktop layout, with AgentDeck's deck in
the middle:

- **Left sidebar** (collapsible, resizable): 新对话, 队长, 搜索, Schedule, Artifacts, Skills,
  then the 队长 row (once the Captain exists) with a folding arrow for the
  sessions it runs in the background, folders, loose sessions and 已归档.
  Every session is a live terminal column.
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
  confidence and Captain rotation plan in one tooltip; config dir/model
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
  Claude 5-hour remaining ≤2% also sends a Bark phone alert (`critical`, volume 3),
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

任务看板数据、CLI、自动流转及界面的读写入口见
[任务看板接口说明](docs/task-board-api.md)。正本是 `~/.agents/boards/tasks/<项目名>.json`；
`new --task-id ... --project ...` 绑定卡片，命令回执自动流转，文件监听和每 60 秒巡检
发现外部开始操作。`TaskBoard.startCard(id)` 默认用 Gemini Flash 调度，设置可改回队长。
队长 `task move` 回 doing 不自动开调度员；未归档的关联会话阻止重复自动调度。
额度/登录/限流失败不累计连续失败；开新会话前检查所选 provider/Claude 席位额度，
已用尽的任务排队到额度恢复，显示「额度用尽，稍后自动开」。
会话恢复干活时，自动生成的「已结束，未提交回执」提示会从回执栏及任务卡清除；真实命令回执保留。
Cursor 的活动标记优先于输入占位符，整个屏幕都参与判定；运行中的回合需静默至少 10 秒才判空闲。
提交完成回执后，任务仍为完成，但 Cursor 会话只要还在运行就继续显示「干活中」。
看板页面从侧边栏「任务看板」或终端架构图右上角的「任务看板」切换打开：每个项目是一个
可折叠分组（标题栏显示未完成数和各状态数量，折叠状态会记住，可一键展开/收起全部），分组共用
同一套状态列（待办 / 进行中 / 待验收 / 需要你，完成默认折成数量）和固定列头；卡片是标题加一行
最近动态和更新时间，每格默认 3 张，其余「展开剩余 N 项」。「需要你」在顶部提醒条和分组红色数量
里突出，点开对应卡片详情，可直接回答并交给队长继续推进。项目可拖动排序，卡片可在列内排序或
拖到其他状态；拖到「进行中」会通知队长安排。全部做完的项目归入底部「已完成的 Agent」。
详情中的会话入口可跳到对应终端。架构图只画正在跑的会话，看板列出全部任务。
终端架构图（A 版，日夜两套）：队长在顶部居中，下面是项目分组，组内按窗口宽度排 3/2/1 列卡片网格；
没有会话在干活/待补充/排队的项目默认收进底部「非活跃项目」托盘（真实数量，点 chip 展开到画布，失败项目标红）；
项目里再有会话开工会自动重新显示，不动你的视角。画布右下角（图例行右侧）有缩小/比例/放大/「适应画布」；
首次进入自动适应一次，没手动拖动或缩放过时实时更新会重新适应，动过之后保持你的视角。
卡片标题最多两行，「···」或失败卡片的「查看」打开详情浮层（完整回执、文件、实时活动、打开终端；Esc 关闭）。
架构图只留当前的活：做完的队长会话没有新指令 10 分钟后自动归档（AgentDeck 重启后也照此处理，重启时已超时的在终端安静约 1 分钟后归档）；
失败或停下的会话要等它的看板卡片已完成、或同一张卡已由另一个会话接手才自动归档，没人接手的失败留在图上等队长处理。
项目框标题的数字只统计图上还在的会话（不含已归档历史），和队长框一致。
项目名不分大小写（AgentDeck 和 agentdeck 是同一个项目框，显示最早那个会话写的写法，已存数据不改）；
项目里没有任何干活、待补充、排队、失败、停下、空闲的会话（全部已完成或已归档）时，项目框从图上消失，有新会话再出现；「显示已归档」时仍列出全部项目。
连线是细蓝线，只有执行中的线路有少量移动光点，审查是紫色虚线；悬停卡片高亮它的路径。
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
下一个可用 Claude 席位（US2 → US → CN → US2，未登录或用尽跳过）；所有已登录席位都用尽才交给 Codex GPT-6.1 Sol，恢复后优先回 Claude。
额度区的手动轮换按钮只在 Claude 席位之间切换；所有 Claude 席位用尽后的 Codex 接力由永动机执行，或从 Relay 菜单明确选择。
设置可关闭或改阈值。每次轮换留横幅、对话记录及普通 Bark 提醒，10 分钟内不回切同一目标。
默认打开「优先用快到期的席位」图标开关：当前和目标席位的 5 小时余额、每周额度和重置时间都可信时，
队长空闲后优先使用重置至少早 10 分钟、还有可用额度的席位；同边界抖动不切换，数据未知时只保留低额度切换。
每周剩余 ≤ 阈值的席位不能接力，也不预热。额度详情有一行说明当前席位、预热和切换策略。
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
  receipts | answer | peek | quota | briefing | stop | archive` (`node "$env:AGENTDECK_BOARD_CLI" …` in Windows PowerShell
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
  Flash; Claude 4.x and Haiku models are refused with a message telling the 队长
  what to use instead.
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
  `answer --key enter`, after which the task goes in.
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
  With Claude Code, the Captain runs `receipts --wait --timeout 300` using Bash
  `run_in_background: true`. The command blocks until unread receipts, questions
  or confirmation notices arrive, prints their summaries and exits. Bash's task
  completion notification wakes the model; after processing it the Captain starts
  another listener, keeping exactly one active. A timeout prints nothing and exits
  successfully; omit `--timeout` to wait indefinitely. The timeout is in seconds
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
  launch wrappers report nonzero exit codes as failures even when the parent
  shell stays alive; PTY exits include their exit code/signal or spawn error.
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
  finished, uninterrupted turn or a reported normal agent exit can trigger the
  fallback: “已结束，未提交回执”, with no screen content or inferred files.
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
  paragraph tells the Captain to read the handoff, inspect the ledger and
  receipts, restart interrupted work, and keep dispatching. That paragraph is
  not appended again: the combined text would exceed the inline prompt limit
  and be replaced by a file pointer. The delivery waits for an idle
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
terminal is the Captain, then read `briefing` and the board's Captain handoff. An
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
An empty path disables phone alerts. The authenticated Captain can send
`node "$AGENTDECK_BOARD_CLI" notify-user --message "需要你亲自操作"` for a local
alert, adding `--urgent` for Bark (`critical`, volume 4, `minuet`).
`node "$AGENTDECK_BOARD_CLI" notify-user --test` sends a **【测试】** Bark alert
with `critical`, volume **3**, and `minuet`; use `--test` alone.
On Windows PowerShell use `$env:AGENTDECK_BOARD_CLI`.
Workers cannot use this command. Phone alerts require Bark's critical-alert
permission and are independent of local notification/sound toggles. Missing or
invalid key files return a setup hint; network errors are redacted. Tests use
isolated profiles and a fake transport, never the real key or phone.

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

本机 Mac 可用一条命令准备发版（先收齐已验收的分支，避免边合边反复测试、打包）：

```sh
node scripts/release.js --base origin/release/1.1.11 origin/fix/example --dry-run
node scripts/release.js --base origin/release/1.1.11 origin/fix/example
# 显式版本也接受 1.2 或 1.2.0；从 1.2.0 默认进到 1.3.0
node scripts/release.js 1.2 --base origin/release/1.1.11 origin/fix/example
```

先自行 `git fetch origin`，再指定基线；默认基线是当前 HEAD。省略版本号时进一位次版本号：1.1.11 → 1.2.0，分支/目录对外叫 `release/1.2` / `agentdeck-release-1.2`，不再生成 1.1.12。脚本把基线和待合分支解析成固定提交，在独立 worktree 依次合并；冲突即停止，报告列出文件，手动解决并提交后按原命令续跑。已有目录必须属于同一发布计划，其他 worktree 和历史报告不会被覆盖。`--worktree DIR` / `--output DIR` 可另选绝对路径，输出须在源码目录外。`--dry-run` 只读，不创建目录、不测试、不打包。

流程：同步 package.json 与 lockfile 版本 → 依赖安装/原生模块检查/Electron 准备 → 持全机锁依次跑单测和单 worker 冒烟，audit 并行 → 签名 DMG → SHA256 与强制校验挂载/签名/全部运行文件逐字节核对并行 → 生成安装脚本和 JSON/Markdown 逐步耗时报告。测试锁统一为 `/tmp/agentdeck-test.lock`，owner 记录进程、分支和时间；失败或取消会释放自己的锁，锁等待时长单列入报告。其他测试命令也须持这把锁。脚本不会删除别人的锁；只有超过 40 分钟且 owner 进程确已退出时才能人工清理。

`release.js` 自己持锁，直接运行它即可，不要在外层再拿同一把锁。单独运行 `npm test` 或 E2E 命令时，用 shell 加外层锁，结束时删除自己的 owner 文件并释放目录。

子进程清除现役 `AGENTDECK_*` 凭据；调用者环境保留，仍能提交自己的回执。同一 worktree 的依赖安装可复用；成功测试和构建只有在完整 Git tree、依赖文件/权限、Node/平台/系统/签名与测试环境都相同时复用，DMG 还须通过哈希校验。首次依赖指纹计算与门禁重叠执行，异步遍历并分块读取依赖，哈希期间持续读取测试和 audit 的输出；audit 每次运行，缓存包每次重新核对。

脚本不合 main、不打 tag、不推送、不安装、不退出或启动应用。结果默认在相邻 `reports/agentdeck-1.2/`，内含 `install-1.2.sh`；安装脚本要求先退出 AgentDeck，校验 DMG/签名/版本/asar，备份配置与会话数据，复制并校验完整新程序，再通过重命名保留旧程序、替换安装。失败还原旧程序，产生 `install-timing.tsv`（整秒计时）。安装完成后由发布操作者启动应用并检查持续存活；这些真实安装/启动耗时须加入最终报告，不能用 fixture 演练耗时冒充。

Mac distribution uses the local `AgentDeck Dev` signing identity. On a CI host
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

The Captain briefing is static across turns and context resets. Claude workers must use an explicit `--model claude-opus-5-5` or `--model claude-sonnet-5-5` and `--effort`, then be checked with `peek`. Nontrivial user tasks go into `~/.agents/boards/` before dispatch. Important work is checked by Gemini 3.8 Flash; failures go back to the worker for up to two rounds before the Captain handles escalation. Notification and token-saver controls share the Settings dialog.

Claude's macOS quota reader and seat-isolated Relay are described in
[Claude usage API](docs/claude-usage-api.md). Claude percentages in quota UI and
`board-cli quota` are remaining; `↻` identifies each window's next reset.
