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

读返回数组；修改返回 `{card, notices}`，归档返回 `{cards, notices}`。
`startCard` 返回 `{card, dispatcher, session_id?}`，重复开始返回 `{ignored:true}`。
修改接口 reject 时由界面展示错误，重新读卡片后重试；不要先乐观覆盖文件。
`onChange` 只提示重新读取，不携带正文或路径。首次打开界面先 `list()`，再订阅。
底层固定桥 `deck.taskBoard(op,input)` 的内部 `bind/event/claim/dispatch/dispatched/dispatcherReceipt/identity`
留给会话层使用，界面不要直接调用。

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
