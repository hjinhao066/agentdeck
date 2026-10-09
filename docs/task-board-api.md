# 任务看板数据与流转接口

本层不创建界面。界面作者直接调用 `window.TaskBoard`，所有文件读写通过
受主页面校验的 preload IPC 到主进程；页面不持有 Node、任意 IPC 或可选文件路径。
默认 `dispatcher=gemini`，可改回 `captain`。自动流转和心跳均不调用模型；
只有明确开始卡片时，Gemini 调度模式会开模型会话；带 `verify` 的卡片进入待验收后，
心跳会让主界面自动开一个审查会话（见「自动验收」）。

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
| flag | `null` 正常、`failed` 失败、`blocked` 前置未完成、`held` 挂起、`quota` 额度/登录/限流问题 |
| order | 项目内非负数字，允许小数插入；界面按 project/order/id 排序 |
| depends_on | 前置卡片 ID 数组，允许跨项目；不能缺失或成环 |
| assignee | `null` 或 `{agent, model}`；未显式指定模型时先为 `default`，识别到本会话实际模型后更新，不猜账号配置 |
| session_id | 当前执行或审查会话 ID，未派活为 `null` |
| latest_receipt | 命令结果或失败原因的第一句/第一行，不按字符数截断；完整原文仍在会话和队长回执通道 |
| verify | boolean，执行完成后是否进入待验收 |
| rework_count | 累计验收驳回次数 |
| created / updated | ISO 日期；updated 可作为编辑的乐观并发版本 |
| archived | boolean，归档不删除文件或卡片，依赖仍可引用完成卡 |
| important | 可选 boolean，默认 false。**这就是「高优先级」**：用户点名要优先、要立刻开始的卡片（只有普通和高优先级两档）。没有这个字段的旧卡片按普通处理。除了下面「高优先级」一节的标记和排序，它保留原有作用：这类卡片交队长调度，不交便宜调度员。与 verify 独立 |

程序还保存 `attempt_id`、`review_session`、`attempt_closed`、`last_event`、
`last_failure_attempt`、`consecutive_failures`、`session_host`、`session_bound_at`、
`dispatch_session_id`、`dispatch_host`、`dispatch_bound_at`、
`dispatch_claim`、`dispatch_wait`（额度排队提示）、`resource_failure`（quota/auth/rate_limit）、`start_previous_status`；迁移卡另有 `migration_source`。
自动验收另存（只在 `verify=true` 的卡片上出现）：`review_round`（第几轮验收，每次执行回执进入待验收加一）、
`exec_receipt`（本轮执行会话的回执全文、文件、会话 id、尝试 id 和执行者 `{agent, model}`；审查会话绑定后
`session_id`/`assignee` 会换成审查者，所以单独留一份）、`review_claim`（本轮审查认领 `{round, key, owner, delivered}`）、
`review_block`（选不出审查者或结论不明确时的 `{round, reason}`，界面显示给队长）、`review_reject`（审查员不通过的
原话 `{round, findings, key, owner, delivered}`，用于自动返工）。
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
// 只改优先级用 priority({ id, level: 'high' | 'normal' })：不校验 updated，只翻转 important 一个字段。
await TaskBoard.move(card.id, 'doing', card.updated); // 进入开始，由心跳发现
await TaskBoard.archiveDone('agentdeck');
await TaskBoard.startCard(card.id); // 显式开始，按 dispatcher 设置调度
await TaskBoard.requestStart(card.id); // 拖到进行中：与 startCard 使用同一派活路径
await TaskBoard.reorder(card.id, { before: otherCard.id }); // 同项目排序，也可 after；无锚点放末尾
await TaskBoard.answer(card.id, '用户的答案'); // 回答需要你，交给队长继续推进
TaskBoard.settings();              // {dispatcher:'gemini'}
TaskBoard.settings('captain');     // 持久化到本机 config.json
TaskBoard.autoVerify();            // true；默认开启自动验收
TaskBoard.autoVerify(false);       // 总开关，持久化到本机 config.json，心跳下一次巡检生效
const unsubscribe = TaskBoard.onChange(() => refreshFromTaskBoard());
unsubscribe();
```

| 方法 | 参数与默认值 | 返回值 |
| --- | --- | --- |
| `list(filter = {})` | 可选 `project`、`status`、`archived`、`priority`（`high` 或 `normal`）；`archived: true` 表示包含归档卡，并非只返回归档卡 | `Promise<Card[]>`，按 project/order/id 排序 |
| `add(input)` | 必填 `project`、非空 `title`；可选 `id`、`detail`（默认空）、`depends_on`（默认空数组）、`verify`、`important`（均默认 false）、`priority`（`high` 等同 `important: true`，给了就以它为准） | `Promise<{card, notices}>`；创建 todo 卡，order 为本项目最大值 + 1，有未完成前置时 flag=blocked |
| `setPriority(id, level)` | 用户在界面上点的入口。id 是卡片、会话或排队项；level 为 `high` 或 `normal` | `Promise<string>`（一句结果）。有卡片就改卡片；把还在待办的卡片标成高优先级时给队长发一条看板通知 |
| `update(id, patch, updated)` | patch 仅含 title/detail/order/depends_on/verify/important；updated 必填 | `Promise<{card, notices}>` |
| `move(id, status, updated?)` | status 为五种状态之一；界面应带 updated 防止过期拖动，队长 CLI 不带该参数 | `Promise<{card, notices}>`；移入 doing 时保留未归档会话作为占用标记并检查前置；其他移动清除绑定 |
| `archiveDone(project?)` | 省略 project 则归档全部项目中未归档的 done 卡 | `Promise<{cards, notices}>`；可重复调用 |
| `startCard(id)` | 必须已有队长；拒绝 archived/done/held/review 卡和前置未完成的卡 | `Promise<{card, dispatcher, session_id?} \| {queued:true, card} \| {ignored:true, card?, occupied?:true}>`；occupied 表示未归档会话占用 |
| `requestStart(id)` | 拖到进行中的入口；必须已有队长，沿用开始校验 | 同 `startCard`；按当前 dispatcher 派活 |
| `reorder(id, anchor = {})` | 可选 before 或 after 卡片 ID，只接受同项目锚点，两者不可同时提供；无锚点放项目末尾 | `Promise<{card, notices}>`；只改 order，必要时重排项目内序号 |
| `answer(id, reply)` | 非空答案，必须已有队长 | 通知队长；需要你的卡回到 doing，活跃会话保留绑定，无绑定时认领并通知队长 |
| `settings(dispatcher?)` | 仅接受 gemini/captain；省略则只读，缺省 gemini | 同步返回 `{dispatcher}`，设置写入本机 config.json |
| `autoVerify(enabled?)` | 布尔；省略则只读，缺省 true（不接受其他类型） | 同步返回当前是否开启；关闭后心跳不再认领审查、不再自动返工，已开的会话不受影响 |
| `onChange(callback)` | 文件变化通知；回调不接收卡片正文 | 同步返回取消订阅函数 |

队长手动开的审查会话（卡片在待验收时用 `new --task-id` 绑定的会话）不要求固定措辞，但回执以「不通过」开头时
同样按驳回处理：卡片回到进行中并记一次返工，由队长把意见发回原执行会话；它不会因为审查会话结束而置完成。

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
需先解决共享文件。不要把失败请求当作派活成功。

本机写锁是系统临时目录里的一个文件夹（报错里带着它的路径），里面的 `owner.json` 记着进程号、电脑名和加锁时间。
持锁进程在写入途中崩溃留下的锁，下一次写入会自动接管：只有确认那个进程已经退出才接管
（进程号不存在；或进程号被一个加锁之后才启动的新进程占用），活着的写入者无论写多久都不抢；
记录读不出、或写着别的电脑名的锁一律不动。接管时把旧锁挪到按旧记录命名的位置而不是原地删除，
两个进程同时接管同一把死锁只有一个能成功，也不会挪走别人刚加的新锁。`startCard` 的 ignored 表示
本次没有新派活；held 只能由队长明确移回 todo/doing 解挂。

## 看板界面

入口两处，打开的是同一个页面：侧边栏一级入口「任务看板」（和「队长」「搜索」同级，
再点一次关闭）、终端架构图右上角「架构图 / 自由画布 /
任务看板」切换里的「任务看板」。看板页右上角是同一组切换，点「架构图」或「自由画布」
回到架构图；Esc 或关闭图标回到原来的页面。分工：架构图只画现在正在跑的会话，
任务看板列出全部任务。纯逻辑在 `task-board-ui-core.js`（有单元测试），界面在
`task-board-ui.js`。

- 布局：顶部是「全部 / 各项目」筛选条（带数量，筛选后任务和统计同步更新）和需要你/完成统计，
  下面一条「需要你」提醒条，再下面是固定的全局列头：待办 / 进行中 / 待验收 / 需要你 / 完成。
  每个项目是一个可折叠分组，标题栏横贯整个看板（36–40px）：折叠箭头、项目色点、名称、
  「N 件待完成」，右侧是各状态数量（需要你为红色，可点开该组第一个问题）。所有分组共用同一套
  列宽，列头在滚动时固定。点标题栏折叠/展开，折叠状态记在本机；顶部有「展开全部 / 收起全部」
  图标。完成列默认折成一个数量，点列头展开。没有任何待办的项目归入底部可展开的「已完成的
  Agent」（它们不参与拖动排序）。空列只显示一个淡色短横线。容器宽度小于 740px（含详情抽屉
  打开且窗口较窄时）各分组的列改为在标题栏下竖排，每列自带标签。项目名不分大小写；颜色用
  `CrewMapCore.projectHue(项目名)`，与架构图一致，只用于小色点。
- 卡片：标题（16px，最多两行）加一行「最近动态 + 更新时间」。动态依次取：失败原因、挂起、
  等「X」完成、最近回执、运行状态（队员正在干活 / 已派给队员 / 还没有队员在做）、说明。
  「进行中」卡片的小圆点只表示是否真有队员在做，运行提示与它一致。失败卡显示失败标记和原因，
  红色边框；额度/登录/限流显示对应标记。「需要你」卡片这一行显示问题。每格默认显示 3 张，
  其余用「展开剩余 N 项」。卡片很窄时（详情抽屉打开）更新时间隐藏，动态占满整行，时间仍在
  悬停提示里。「谁在做」只出现在悬停提示和详情抽屉里。
- 高优先级：未完成的高优先级卡片在标题前带实心蓝色旗标「高优」，卡片左边一条同色细边，并排在
  同一格的最前面（两类内部仍按拖动顺序）；项目标题栏显示「旗标 + 未完成的高优先级数量」，折叠时也看得到。
  已完成的只留一个不上色的小旗，不再前移。旗标有悬停提示和 `aria-label="高优先级"`。详情抽屉右上角的
  旗形图标按钮（`aria-pressed`）点一下标记、再点取消。Alt+↑/↓ 和拖动不能把卡片移过两类之间的分界线。
  蓝色只用于这个标记（`--prio`），不和干活中（黄）、失败/停在确认（红）、完成（绿）、额度（橙黄）混用。
- 「需要你」提醒条：每个等待中的卡片是一个按钮，点开该卡详情；「处理」打开第一个。
- 点卡片（或键盘 Enter）打开详情抽屉，显示完整说明、负责会话和相关文件；通过会话入口
  跳到对应终端，已归档的会话先恢复。「需要你」把问题放在答案框上方，发送后交给队长继续推进。
- 项目筛选、项目折叠和拖动排序、完成列开关、已完成区开关保存在本机 config.json；卡片列内拖动排序通过
  `reorder` 保存到任务正本，跨列拖动遵守原流转校验。拖到进行中调用 `requestStart`，与显式开始一样按当前 dispatcher 派活；依赖未完成时提示原因并留在原列。
  Alt+方向键提供卡片排序/状态移动；无操作时只读任务数据，刷新不改卡片。
- 打开时订阅 `onChange`，关闭时取消订阅。打开后焦点进入项目筛选入口，Esc 或关闭
  图标关闭并返回侧边栏入口；键盘切换终端列也关闭看板。当前筛选项目没有可见卡片时，
  同一次刷新自动切回全部项目。

界面里的复制、刷新、关闭、展开/收起等常见动作一律是图标按钮（复制为两个重叠方框，成功后短暂变勾），
都带悬停提示、`aria-label`、键盘焦点和不小于 28px 的点击面积。

复制路径和编号统一使用 `deck.clipboardWrite(text)`，同步读取使用 `deck.clipboardRead()`；
两者都走 release 的 `clipboard:write-sync` / `clipboard:read-sync` 主进程通道。
隔离测试 profile 使用私有剪贴板，复制失败不会显示成功。

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
node "$AGENTDECK_BOARD_CLI" task add --project agentdeck --title "线上故障" --priority high
node "$AGENTDECK_BOARD_CLI" task priority --id t-卡片ID或会话ID --level high   # 改回普通用 normal
node "$AGENTDECK_BOARD_CLI" task list --priority high
node "$AGENTDECK_BOARD_CLI" new --title "马上查告警" --task "完整任务" --priority high
```

add 返回 JSON 对象（含 card），list 返回 JSON 数组，move/archive 返回 JSON 对象。
CLI 没有 task update、settings 或 start 子命令；这些操作使用界面接口。`important`
在命令行里叫优先级：`--priority high|normal` 和 `task priority`（见下一节）。task list 不含归档卡，含归档查询使用 `list({archived:true})`。
不裁剪列表或说明。`--project` 无卡片时仅为会话项目元数据；有 `--task-id` 时必须
匹配卡片项目，省略则从卡片继承。重复请求不会重新派活，旧会话/旧尝试的回执
不会改当前卡。`new` 排队时保留关联，真正开会话时再次校验前置和 held 状态。
队长的 `task move ... --status doing` 会消费自动开始边沿，不开调度员；队长随后
`new --task-id` 或 `tell` 安排返工（verify 卡的审查不通过由自动验收直接返工，不需要这一步）。`new` 拒绝仍活跃的执行/审查尝试；旧会话已归档
或旧尝试已失败时允许替换，即使旧数据漏写 attempt_closed。

## 流转

| 事件 | 结果 |
| --- | --- |
| 指令真正送到执行会话 | doing；排队不会假装已开工 |
| 执行 complete | verify=true → review，否则 done；记录第一句结果 |
| ask | needs_user；写第一句问题，完整问题仍给队长 |
| 普通 complete --failed / 崩溃 | doing + failed，给队长失败原因；同一尝试多种失败事件只计一次 |
| quota/process/automatic 来源的额度用尽 / 未登录 / 限流（执行、审查或调度） | doing + quota，保留连续失败计数，不计返工、不触发 held；失败原因给队长。command 的失败文案不做资源分类，照常累计失败 |
| 所有前置 done | 后续 todo 的 blocked 自动清除，可开始（不会偷偷启动） |
| review 卡片 new --task-id | 绑定审查会话；审查期间仍 review（verify 卡片通常由「自动验收」开，不必手动） |
| 审查 complete | done，清除连续失败次数 |
| 审查 complete --failed / 队长从 review move 回 doing | rework_count+1，doing + failed；自动验收的审查员不通过会自动返工，其余由队长用 new 或原会话 tell 返工 |
| 自动验收：verify 卡进入 review | 心跳认领本轮，主界面开一个不同提供方的审查会话；选不出则停在 review 并写明原因 |
| 自动验收：审查员写「通过」 | done |
| 自动验收：审查员不通过 | 原话发回原执行会话（已归档先恢复）返工；返工 complete 后进入下一轮审查 |
| 自动验收：执行会话被补充指令后再交一次回执（审查还没开，或审查员正在审） | 旧一轮审查作废（旧审查员之后的结论被忽略），新回执成为下一轮：review_round 加一，重新选一个不同提供方的审查员；连续失败两次 held 的规则不变，held 的卡不再自动审 |
| 连续失败达到两次 | doing + held，通知队长，不派活、不重试 |
| held 后队长明确 move 到 todo/doing | 解挂，清零连续失败次数，保留累计 rework_count |
| 已结束却三分钟无命令回执 | needs_user，只有「已结束，未提交回执」，不把屏幕当成功结果 |
| 新会话的命令行启动后一直没画出界面（屏幕上只有启动命令的回显），等满 3 分钟（Cursor 6 分钟） | 任务正文一个字都不送进终端；以 `source=startup` 的失败回执：doing + failed（连续两次 held），不是 needs_user、不是「已结束，未提交回执」。回执写明启动失败、任务没送达、等了多久、终端最后几行；原文可用 `read --id` 取回 |

验收失败后的执行完成不会清除验收失败计数，两轮验收都失败仍会挂起。
执行会话的选择由队长或调度员安排，验收会话的选择见「自动验收」；这些状态和阈值不由 AI 判断。
停止/归档一个忙会话的卡片不会假装成功，需要队长明确更新卡片。

## 自动验收

带 `--verify`（`verify=true`）的卡片，执行会话交回执进入「待验收」后，不需要队长动手：

1. **认领（心跳，不调用模型）**：每轮验收只认领一次。条件：`status=review`、`verify`、未归档、无 flag、
   带本轮 `review_round` 和 `exec_receipt`、还没有审查会话绑定（`review_session` 不为真）、本轮没有认领也没有
   `review_block`、本机没有别的会话正在这张卡上干活。认领先原子写入 `review_claim`（带本机 hostname），再通知主界面；
   尚未送达的认领在重启后原样再送一次，不会重新认领。没带 `--verify` 的卡、手动移进 review 的卡、升级前就停在
   review 的旧卡（没有 `exec_receipt`）都不会被自动认领。
2. **选审查者**：必须和执行会话**不同提供方/模型**。按「谁做的模型」分家族（Anthropic / OpenAI / Google / xAI；
   看模型名，看不出再看 agent：Cursor 里跑的 Claude 算 Anthropic，agy 里跑的 GPT-OSS 算 OpenAI），
   执行者的家族看不出来也不猜。候选按调度员分工表的顺序：Gemini 3.8 Flash（队长说明第 16 条的默认验收者，不耗
   Claude 额度）、Codex GPT-6.1 Sol、Claude Opus 5.5（终审模型）、Antigravity 的 Opus 4.6 Thinking（审查模型）。
   跳过同家族的，也跳过按 `commandQuota` 判断已用尽的（未知不算用尽）。选不出就写 `review_block`（原因里列出每个
   候选为什么不行）、给队长一条通知、卡片留在 review，不会自己审自己，也不会直接算完成；额度之后恢复不会自动再试，
   由队长手动 `new --task-id` 开审查会话（绑定后 `review_block` 清除）。
3. **开会话**：走和 `new` 同一个入口（`placeSession`）：并发上限、内存吃紧暂停、额度用尽都进同一个排队，
   不绕过。会话标题「审查：卡片标题」，`--reviews` 指向被审查会话，工作目录沿用执行会话。尝试 id 固定为
   `auto-review-<卡片id>-r<轮次>`，所以重启、额度恢复、心跳重跑只会落到同一个尝试上。排队中的审查会话在真正开之前
   会再确认这一轮仍是待验收，否则放弃。连续三次开不出来也转 `review_block` 交队长。
4. **审查任务**包含：卡片标题和说明、执行会话回执全文和它列的文件、被审查的会话 id 和执行者，以及固定验收要求：
   亲自核对文件存在、提交已推送、只跑相关测试（不跑全量 E2E）、截图落盘、有没有删用例或放宽断言；只审不改；
   结论的第一个词必须是「通过」或「不通过」，不通过要列具体问题。
5. **结论**：`complete` 以「通过」开头 → done。`complete --failed`，或 `complete` 以「不通过」开头 → 不通过。
   没写明确结论的回执**不算通过**：卡片留在 review，写 `review_block` 并通知队长。
   不通过按原有规则 `rework_count+1`、doing + failed，并把审查员的原话（`review_reject.findings`，不裁剪）
   连同固定说明发回原执行会话；原会话已归档就先恢复再绑定卡片（尝试 id `auto-rework-<卡片id>-r<轮次>`）。
   返工后会话交回执，进入下一轮并自动开新的审查会话。只有审查员亲手写的结论才会发回；审查会话崩溃、额度用尽
   不是审查意见，按原有失败规则处理并通知队长，不自动返工。
6. **挂起**：连续两轮不通过仍按原有阈值 `held`，通知队长，不再自动返工或重审。
   原执行会话已经找不到时，不通过的原话作为通知交队长，不重试。

手动补开审查时使用 `new --task-id <卡片id> --reviews <原执行会话id>`。显式审查绑定当前执行回执的
审查轮次（`review_verdict: true`），即使卡片已显式移回 doing，也按第 5 条处理结论，保留原执行回执，
不会把审查结果当成一次新执行再套审查。`--reviews` 必须包含卡片记录的原执行会话；旧卡无执行回执时，
以第一个被审查会话及其回执建立来源，该会话必须绑定这张卡片。排队时保留轮次，派发前校验，过期轮次不再开出。
同一执行轮次重复审查或手动打回仅计一次失败；返工交回新执行回执才进入下一轮。
不带 `--reviews` 的旧式手动审查仍接受普通完成摘要。

不重复靠四层：持久化的认领/返工标记（每轮一个）、固定尝试 id（`new` 按它去重，`bind` 对同一尝试幂等）、
队列里已有这张卡的请求就不再排、已有以该尝试 id 创建的会话就只补标记。队长已经手动开了（或排了）审查会话的卡，
自动开审查直接放弃。队长任何 `task move` 或重新绑定都会取代尚未送出的自动返工。

总开关 `TaskBoard.autoVerify(false)`（本机 config.json 的 `taskBoard.autoVerify`，缺省开启）。
调试日志只记 `task-board review claimed id=… round=…`，不含卡片正文。

## 高优先级

用户说某件事「高优先级」，意思是要队长立刻放到后台开始做。只有两档：普通和高优先级。

- **存在哪**：有卡片时就是卡片的 `important` 字段（随看板同步到另一台电脑，旧版本也认得这个字段）。
  会话不另存一份：绑在这张卡上的执行会话、审查会话和排队项都从卡片读。没挂卡直接派的活
  （`new --priority high` 不带 `--task-id`）把标记记在**这件活**的派活记录上（排队时也在排队项上），
  不记在会话上。所以同一个会话里：这件活还没成功完成（在做、失败、被叫停）时接着 `tell` 的指令算同一件事，
  沿用标记；这件活完成之后再 `tell` 的是新活，按普通处理，需要的话再用 `task priority` 标。
  会话自己的 `important` 只在它手上没有未完成的活时才用（用户给空闲会话打的标记），下一件活会把它接走。
- **队长怎么标**：`task add --priority high` 建卡时标；`new --priority high` 派活时标（带 `--task-id`
  就写到卡片上）；事后用 `task priority --id <卡片id|会话id|排队id> --level high|normal` 改。
  只有队长能标，调度员不能。
- **输出里怎么看**：`ledger` 的会话行和「排队等空位」里带 `【高优先级】`；`task list` / `task add`
  的 JSON 给高优先级卡片多一行 `"priority": "high"`（普通卡片没有这一行），`task list --priority high`
  只列高优先级；`queue list` 的高优先级项带 `"priority": "high"`；`handoff` 总览写「用户点名的高优先级（N 条）」，
  `tasks.md` 里对应的任务带 `【高优先级】` 并排在同组最前。
- **界面**：看板卡片见上面「看板界面」；侧边栏的会话名前有蓝色小旗，同一模型分组里排在前面，
  排队项同样；会话右键菜单有「高优先级」勾选项；终端架构图的会话卡片和排队卡片在标题前带「高优」旗标；
  手机网页端（单机页和总台）的任务卡片带「高优先级」旗标并排在同状态最前。会话自己的那件活做完后，
  它身上的旗标消失，之后派给它的普通活不会再带出旗标。架构图不因为优先级挪动卡片位置。
- **排队**：等空位的活里，高优先级排在普通活前面，两类内部仍然先来先到（排队项的 `order` 是到达序号，
  标记后又取消会回到原位）。有空位时，一条高优先级的新请求不会被排在前面的普通活挡住。
  不打断任何已经在跑的会话，不突破同时干活上限、额度和内存暂停。
- **用户自己点**：把一张还在待办、没人做的卡片标成高优先级，会经回执通道告诉队长一次
  「用户在任务看板把卡片 X 标为高优先级…请立刻安排」；已经在做的卡片、取消标记、队长自己的命令都不发通知。
- **原有路由不变**：`important` 的卡片拖到进行中仍然交队长调度，不交便宜调度员。

## startCard、心跳与调度

需要已存在的队长。`requestStart`（拖动或键盘移到进行中）与 `startCard` 共用派活入口、认领和配额排队逻辑。默认 Gemini 开后台 Antigravity
`agy --dangerously-skip-permissions --model gemini-3.8-flash-high`，使用与队长相同的
模型分工表，把卡片整理成一件任务，执行 `new --task-id ... --project ...`。
该会话没有队长 control token，只允许自己的 complete/ask/progress，以及为
这一个卡片开一次执行会话；不能改其他卡、读取队长或控制其他终端。
important=true、空 detail、需要用户澄清、已有失败的卡片交队长；Gemini 发现内容
说不清也用 ask 转交。并发满时交队长安排。dispatcher=captain 时只给后台回执
通道发「用户要开始卡片 X」，不向输入框注入。

自动调度和 `new` 开会话前读取本机被动额度观测，按命令所选 provider 和当前
Claude 席位判断。额度明确已用尽，或剩余不高于同级换模型阈值时，换成对照表里
另一家能用的模型再开；会话标题和回执写「原本派X，因额度换成Y」，并通知队长。
「未知」不换走，也不能当作替换目标。对照表里没有独立额度池的模型（Cursor 的
Claude、agy 的 claude-sonnet-4-6 与 gpt-oss-120b-medium）可以当作替换。
`--command` 点名模型时不自动换，只排队并说明原因。没有可换模型且已用尽时仍不开
PTY，显示「额度用尽，稍后自动开」。
调度卡保留未送出的 dispatch_claim，队长列心跳/任务库巡检在额度恢复或出现可换
模型后重试；排队执行会话同样等到能开再开工，其他已能开的排队任务仍能先执行。
未知额度不等于可用，但也不伪造用尽状态；Cursor/Antigravity 只使用已支持的模型额度池。
队长在等待期间手动 new 绑定或排队同一卡片，会消费认领，旧调度请求不再开会话。

主进程监听 tasks 目录（含原子 rename），100ms 合并通知，另每 60 秒巡检。
发现外部卡片新进入 doing 且没有执行/调度会话、没有 failed/held/blocked 时，
先原子写入 `dispatch_claim`，再通知同一个 startCard 入口。派出前重查认领键及 doing 状态，卡片被拖回或认领被替换后丢弃旧请求；并重查
执行/调度指针和本机未归档的卡片关联会话，刚开的执行或审查会话也阻止重复调度。
未归档的已完成会话仍阻止自动调度，但允许队长显式 new 替换。普通内容更新、队员
开工事件、重复文件通知均不启动调度。同一卡片同一次开始只认领一次；退出重开
保留 delivered 标记，尚未送出的本机认领在有队长后接续。再次开始必须先回 todo，
再通过 startCard 或移入 doing；只要仍有关联的未归档调度员或队员会话，拖回再开始也不会叠开会话。历史迁移卡已标认领完成，避免重复派旧活。
新执行/调度绑定由主进程记录本机 hostname，不接受调用方指定归属。已关闭的尝试若本机
找不到旧会话，移回 doing 时清除旧绑定；未关闭的本机旧会话缺失时也可直接 new 重绑，
无需先移动卡片。旧版本无 hostname 的绑定，用本机归档和 mainSession.tasks 的派活记录
证明归属：曾在本机派活、当前列已消失的 id 视为关闭。明确属于另一台机器，或既无机器
归属也无本机记录的未关闭绑定继续保护，不能仅凭本机 ledger 缺失就覆盖远端工作。
新绑定尚未开工、配置尚未落盘的 15 秒内保留占用；已开工或有本机删除记录时无需等待。
心跳单次扫描复用一份会话配置，下次扫描重新读取。
拖到进行中遇到旧会话占用时，界面提示队长检查未归档会话，不再声称有队员正在做。
终端状态与侧栏额度采样共用原生错误识别，只接受完整额度提示、原生重置/重试后缀、
登录指引或明确的 API 错误码/错误类型；Rate limit、Unauthorized、Limit reached 等
普通回复的主题前缀不再触发额度失败回执或额度缓存。
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

自动验收另有单测 `tests/auto-verify.test.js`（家族与选择、结论解析、认领/轮次/返工状态、心跳重复触发和重启）
和 `tests/auto-verify-session.test.js`（真实任务库 + 心跳 + `main-session.js` 的整条链路：不同提供方、排队与内存/额度、
重启恢复、选不出审查者、归档执行会话恢复、两轮失败挂起）。
task-board spec 覆盖依赖解锁、回执原文、两轮验收挂起、异常退出/额度失败、
旧会话回执、Gemini 单卡权限和排队、外部原子写入、认领去重、设置持久化、
同步冲突后流转重试；自动验收两条用例（用替身审查员，页面里临时替换候选表）：一轮不通过返工、
二轮通过，以及选不出审查者后手动接手。该 spec 开头把 `autoVerify` 关掉，因为其余用例自己手动开审查会话。其 Gemini 可执行文件替换为 stand-in；它验证调度入口与
权限，不代表已实测真实 Gemini 模型或两台机器同时同步。全量 E2E 留给合并
main 时运行；本分支验证不包含打包运行、安装或物理 Windows 设备。
