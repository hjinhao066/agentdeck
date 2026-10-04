# 任务看板数据与流转接口

本层不创建界面。界面作者直接调用 `window.TaskBoard`，所有文件读写通过
受主页面校验的 preload IPC 到主进程；页面不持有 Node、任意 IPC 或可选文件路径。
默认 `dispatcher=gemini`，可改回 `captain`。自动流转和心跳均不调用模型；
只有明确开始卡片时，Gemini 调度模式会开模型会话。

## 文件与字段

正本：`~/.agents/boards/tasks/<project>.json`，UTF-8，无 BOM。
Windows 使用相同的用户主目录布局，随现有 `~/.agents` 私有 git 同步。
不要把实际卡片、会话数据提交到 AgentDeck 的公开代码仓库。
每份文件：`{ "version": 1, "project": "项目名", "cards": [...] }`。
项目名可含中文，必须是 Windows/macOS 都合法的文件名，不含目录分隔符或保留名。

| 字段 | 类型 / 约定 |
| --- | --- |
| id | 全局唯一字符串，默认 `t-UUID`；不可重用 |
| project | 文件项目名；建卡后不可改 |
| title / detail | 标题 / 完整任务说明 |
| status | `todo` 待办、`doing` 进行中（也是「开始」入口）、`review` 待验收、`needs_user` 等用户、`done` 完成 |
| flag | `null` 正常、`failed` 失败、`blocked` 前置未完成、`held` 挂起 |
| order | 项目内非负数字，允许小数插入；界面按 project/order/id 排序 |
| depends_on | 前置卡片 ID 数组，允许跨项目；不能缺失或成环 |
| assignee | `null` 或 `{agent, model}`；未显式指定模型时先为 `default`，识别到本会话实际模型后更新，不猜账号配置 |
| session_id | 当前执行或审查会话 ID，未派活为 `null` |
| latest_receipt | 命令结果或失败原因的第一句/第一行，不按字符数截断；完整原文仍在会话和队长回执通道 |
| verify | boolean，执行完成后是否进入待验收 |
| rework_count | 累计验收驳回次数 |
| created / updated | ISO 日期；updated 可作为编辑的乐观并发版本 |
| archived | boolean，归档不删除文件或卡片，依赖仍可引用完成卡 |
| important | 可选 boolean，默认 false；明确标为重要的卡片交队长调度，与 verify 独立 |

程序还保存 `attempt_id`、`review_session`、`attempt_closed`、`last_event`、
`last_failure_attempt`、`consecutive_failures`、`dispatch_session_id`、
`dispatch_claim`、`start_previous_status`；迁移卡另有 `migration_source`。
客户端编辑时保留这些字段以及未知字段，不自行构造或删除流转标记。

每次读写重读磁盘，无长期数据缓存；本机进程锁放系统临时目录，写入使用同目录
临时文件 + fsync + rename，并在覆盖前校验原文，同步期间变化时重读重试。
编辑必须带 `updated`，过期编辑失败，重新读取后再编辑。无效 JSON、git 冲突标记、
重复 ID、坏依赖会报错，原文件保留。进程被强杀遗留的锁包含 owner.json，确认 PID
已退出后才能删除对应系统临时目录里的 `agentdeck-tasks-*.lock`。
git 同步并非分布式数据库：两台离线同时修改同一字段仍需解决 git 冲突；持久化
调度认领随 git 传播后其他机器不再重复开始，但同步前的两机同时操作不能保证全局互斥。
共享文件暂时有冲突时，命令回执仍原样交队长；流转事件留在本机私有 config.json，
队长列的程序心跳重试写入，文件解决冲突后恢复，无需再次消耗模型 token 提交。

## 界面接口

```js
await TaskBoard.list({ project: 'agentdeck', status: 'todo' }); // 默认不返回归档卡
await TaskBoard.list({ archived: true });                   // 包含归档卡
const { card } = await TaskBoard.add({
  project: 'agentdeck', title: '修复 A', detail: '清楚的任务要求',
  depends_on: [], verify: true, important: false
});
await TaskBoard.update(card.id, { title: '新标题', order: 1.5 }, card.updated);
// update 只允许 title/detail/order/depends_on/verify/important，必须提供旧 updated。
await TaskBoard.move(card.id, 'doing', card.updated); // 进入开始，由心跳发现
await TaskBoard.archiveDone('agentdeck');
await TaskBoard.startCard(card.id); // 拖到开始优先用这个接口，即时认领、调度
TaskBoard.settings();              // {dispatcher:'gemini'}
TaskBoard.settings('captain');     // 持久化到本机 config.json
const unsubscribe = TaskBoard.onChange(() => refreshFromTaskBoard());
unsubscribe();
```

| 方法 | 参数与默认值 | 返回值 |
| --- | --- | --- |
| `list(filter = {})` | 可选 `project`、`status`、`archived`；`archived: true` 表示包含归档卡，并非只返回归档卡 | `Promise<Card[]>`，按 project/order/id 排序 |
| `add(input)` | 必填 `project`、非空 `title`；可选 `id`、`detail`（默认空）、`depends_on`（默认空数组）、`verify`、`important`（均默认 false） | `Promise<{card, notices}>`；创建 todo 卡，order 为本项目最大值 + 1，有未完成前置时 flag=blocked |
| `update(id, patch, updated)` | patch 仅含 title/detail/order/depends_on/verify/important；updated 必填 | `Promise<{card, notices}>` |
| `move(id, status, updated?)` | status 为五种状态之一；界面应带 updated 防止过期拖动，队长 CLI 不带该参数 | `Promise<{card, notices}>`；清除旧会话绑定，移入 doing 时检查前置 |
| `archiveDone(project?)` | 省略 project 则归档全部项目中未归档的 done 卡 | `Promise<{cards, notices}>`；可重复调用 |
| `startCard(id)` | 必须已有队长；拒绝 archived/done/held/review 卡和前置未完成的卡 | `Promise<{card, dispatcher, session_id?} \| {ignored: true, card?}>` |
| `settings(dispatcher?)` | 仅接受 gemini/captain；省略则只读，缺省 gemini | 同步返回 `{dispatcher}`，设置写入本机 config.json |
| `onChange(callback)` | 文件变化通知；回调不接收卡片正文 | 同步返回取消订阅函数 |

`add` 忽略输入中的初始状态、会话绑定和 order；需建卡后通过对应接口修改。
ID 只接受 1–160 个 ASCII 字母、数字、下划线或连字符；标题和说明最多各
2,000,000 个 JavaScript 字符。order 必须为非负有限数，布尔字段不接受字符串。
卡片没有颜色字段，界面按 project 关联现有项目色板。

读返回数组；修改返回 `{card, notices}`，归档返回 `{cards, notices}`。
`startCard` 返回 `{card, dispatcher, session_id?}`，重复开始返回 `{ignored:true}`。
修改接口 reject 时由界面展示错误，重新读卡片后重试；不要先乐观覆盖文件。
`onChange` 只提示重新读取，不携带正文或路径，不保证每次写入都有独立通知。
首次打开界面先订阅，再 `list()`；刷新时串行处理或丢弃旧请求结果，避免较早的
读取覆盖较新的视图。离开页面取消订阅。启动返回的 card 是调度过程中的快照，
后续绑定和 delivered 标记以重新 `list()` 为准。
底层固定桥 `deck.taskBoard(op,input)` 的内部 `bind/event/claim/dispatch/dispatched/dispatcherReceipt/identity`
留给会话层使用，界面不要直接调用。

常见错误包括过期 updated、非法项目名或字段、找不到卡片、前置未完成、卡片
已绑定活跃会话、本机写锁占用、共享 JSON 冲突、未创建队长。校验失败不会覆盖
有问题的文件；写锁占用可稍后重试，过期编辑需重新读取并让用户重做该次编辑，冲突
需先解决共享文件。不要把失败请求当作派活成功。`startCard` 的 ignored 表示
本次没有新派活；held 只能由队长明确移回 todo/doing 解挂。

## 看板界面

入口三处，打开的是同一个页面：侧边栏一级入口「任务看板」（和「队长」「搜索」同级，
再点一次关闭）、顶栏架构图按钮右侧的看板图标、终端架构图右上角「架构图 / 自由画布 /
任务看板」切换里的「任务看板」。看板页右上角是同一组切换，点「架构图」或「自由画布」
回到架构图；Esc 或关闭图标回到原来的页面。分工：架构图只画现在正在跑的会话，
任务看板列出全部任务。纯逻辑在 `task-board-ui-core.js`（有单元测试），界面在
`task-board-ui.js`。

- 布局：每个项目一条泳道，横向五列 待办 / 进行中 / 待验收 / 需要你 / 完成，列头
  显示总数并在滚动时固定。项目名不分大小写（`AgentDeck` 与 `agentdeck` 同一条
  泳道，显示多数卡片用的写法）；颜色用 `CrewMapCore.projectHue(项目名)`，同样不分
  大小写，与架构图一致。窗口窄于五列最小宽度时横向滚动，卡片不挤压、不重叠。
- 卡片：标题（最多两行）、负责会话的模型徽标和会话名（会话不在时显示 assignee 或
  「会话已关闭」，未派活显示「未派活」）、最近回执摘要（最多两行）、标签（失败、
  等「X」完成、可并行、挂起、返工次数）和更新时间。失败卡留在原状态列，左侧红条。
- 点有会话的卡片（或键盘 Enter）关闭看板并跳到那一列；已归档的会话先恢复。
- 筛选项目、按最近更新 / 任务顺序排序、刷新图标；「完成」列头的归档图标调用
  `archiveDone`（筛选了项目时对该项目的每种写法各调一次）。除归档外不写数据。
- 打开时订阅 `onChange`，关闭时取消订阅。

## 命令

队长终端使用 `node "$AGENTDECK_BOARD_CLI"`（PowerShell 为
`node "$env:AGENTDECK_BOARD_CLI"`）。任务写命令必须有队长能力；所有 AI 都能
直接只读共享 JSON。会话环境沿用上一分支的命令回执通道。

```sh
node "$AGENTDECK_BOARD_CLI" task add --project agentdeck --title "修复 A" --detail "要求" --verify
node "$AGENTDECK_BOARD_CLI" task add --project agentdeck --title "后续 B" --depends t-前置ID
node "$AGENTDECK_BOARD_CLI" task list --project agentdeck --status todo
node "$AGENTDECK_BOARD_CLI" new --project agentdeck --task-id t-卡片ID --title "修复 A" --task "完整任务" --agent codex
node "$AGENTDECK_BOARD_CLI" task move --id t-卡片ID --status doing
node "$AGENTDECK_BOARD_CLI" task archive --done --project agentdeck
```

add 返回 JSON 对象（含 card），list 返回 JSON 数组，move/archive 返回 JSON 对象。
CLI 没有 task update、settings 或 start 子命令，也没有 `--important` 参数；
这些操作使用界面接口。task list 不含归档卡，含归档查询使用 `list({archived:true})`。
不裁剪列表或说明。`--project` 无卡片时仅为会话项目元数据；有 `--task-id` 时必须
匹配卡片项目，省略则从卡片继承。重复请求不会重新派活，旧会话/旧尝试的回执
不会改当前卡。`new` 排队时保留关联，真正开会话时再次校验前置和 held 状态。

## 流转

| 事件 | 结果 |
| --- | --- |
| 指令真正送到执行会话 | doing；排队不会假装已开工 |
| 执行 complete | verify=true → review，否则 done；记录第一句结果 |
| ask | needs_user；写第一句问题，完整问题仍给队长 |
| complete --failed / 崩溃 / 额度用尽 | doing + failed，给队长失败原因；同一尝试多种失败事件只计一次 |
| 所有前置 done | 后续 todo 的 blocked 自动清除，可开始（不会偷偷启动） |
| review 卡片 new --task-id | 绑定审查会话；审查期间仍 review |
| 审查 complete | done，清除连续失败次数 |
| 审查 complete --failed / 队长从 review move 回 doing | rework_count+1，doing + failed；队长用 new 或原会话 tell 返工 |
| 连续失败达到两次 | doing + held，通知队长，不派活、不重试 |
| held 后队长明确 move 到 todo/doing | 解挂，清零连续失败次数，保留累计 rework_count |
| 已结束却三分钟无命令回执 | needs_user，只有「已结束，未提交回执」，不把屏幕当成功结果 |

验收失败后的执行完成不会清除验收失败计数，两轮验收都失败仍会挂起。
执行/验收会话的选择由队长或调度员安排；这些状态和阈值不由 AI 判断。
停止/归档一个忙会话的卡片不会假装成功，需要队长明确更新卡片。

## startCard、心跳与调度

需要已存在的队长。默认 Gemini 开后台 Antigravity
`agy --dangerously-skip-permissions --model gemini-3.8-flash-high`，使用与队长相同的
模型分工表，把卡片整理成一件任务，执行 `new --task-id ... --project ...`。
该会话没有队长 control token，只允许自己的 complete/ask/progress，以及为
这一个卡片开一次执行会话；不能改其他卡、读取队长或控制其他终端。
important=true、空 detail、需要用户澄清、已有失败的卡片交队长；Gemini 发现内容
说不清也用 ask 转交。并发满时交队长安排。dispatcher=captain 时只给后台回执
通道发「用户要开始卡片 X」，不向输入框注入。

主进程监听 tasks 目录（含原子 rename），100ms 合并通知，另每 60 秒巡检。
发现外部卡片新进入 doing 且没有执行/调度会话、没有 failed/held/blocked 时，
先原子写入 `dispatch_claim`，再通知同一个 startCard 入口。普通内容更新、队员
开工事件、重复文件通知均不启动调度。同一卡片同一次开始只认领一次；退出重开
保留 delivered 标记，尚未送出的本机认领在有队长后接续。再次开始必须先回 todo，
再通过 startCard 或移入 doing。历史迁移卡已标认领完成，避免重复派旧活。
日志通过已有主进程诊断日志（系统临时目录 `agentdeck-notify.log`）记录
`task-board start claimed`、卡片 ID、项目和认领键，
不记录卡片正文或能力 token；无变化不调用模型、不产生日志。

手机/其他机器写卡应保留所有字段，原子写入文件，将 todo 改为 doing 并更新 updated。
更推荐未来网页经本接口 `startCard`，不要把 task move 当作绕过依赖/挂起检查的手段。

## 初始迁移

运行 `node scripts/migrate-task-boards.js`，只读取 `agentdeck.md`、
`hermes-savings-v2.md`、`type4me-windows.md`，不修改原文。不扫描其他 Markdown。
针对这三份现有板的已知条目，排除已完成的历史 G8、VPS、回执分支等，按条目标题
生成稳定 ID；已存在项目 JSON 一律跳过。实际文件写在共享 boards/tasks，
不会随软件启动重复迁移。MD 后续出现新格式或任务时，用 task add 建卡。
代码测试使用临时目录，Electron `--test-user-data` 的任务库在该 profile/tasks，
不读写用户的正本。

## 验证范围

功能分支运行完整单测及三个相关 Electron spec，串行使用一个 worker：

```sh
npm test
npm run test:e2e -- tests/e2e/task-board.spec.js tests/e2e/command-receipts.spec.js tests/e2e/captain.spec.js --workers=1
npm audit
```

task-board spec 覆盖依赖解锁、回执原文、两轮验收挂起、异常退出/额度失败、
旧会话回执、Gemini 单卡权限和排队、外部原子写入、认领去重、设置持久化、
同步冲突后流转重试。其 Gemini 可执行文件替换为 stand-in；它验证调度入口与
权限，不代表已实测真实 Gemini 模型或两台机器同时同步。全量 E2E 留给合并
main 时运行；本分支验证不包含打包运行、安装或物理 Windows 设备。
