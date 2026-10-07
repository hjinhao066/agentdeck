# 随手记待办

一句话一条；不含有效 `@ai` 标记的是你自己的事，AI 不碰。有该标记的交给 AgentDeck 队长，关联任务卡存在 `~/.agents/boards/tasks/todo.json`，待办原文仍按下面的方式存储。

## 在哪里记

- **桌面**：侧边栏「待办」（搜索下面，右侧数字是未完成条数）。打开就聚焦输入框，打一句话回车就存，可以连记；
  圆圈勾掉，已完成折叠在下面，点圈可放回。悬停或键盘聚焦一行时出现铅笔（编辑，回车保存、Esc 取消）和垃圾桶
  （删除，提示条里可撤销）。双击文字也能编辑。中文输入法选词时的回车不会误存。
- **速记**：在 AgentDeck 窗口里任何地方（包括终端里）按 Mac `⌘T` / Windows `Ctrl+Shift+T`，上方弹出一条速记框，
  回车存好后自动收起，焦点回到原来的终端；Esc 或点别处放弃。待办页开着时，快捷键只是把光标放进页面的输入框。
  只在 AgentDeck 窗口里有效，不注册系统级热键。
- **手机总台**：底部「待办」标签。能记、能看、能勾掉/放回，不能改字和删除（防误删，桌面上做）。

## 数据

`~/.agents/boards/todos/<设备 id>.json`，随 `~/.agents` 的 git 每 30 分钟在 Mac 和 Windows 之间同步。
测试实例（`--test-user-data`）写在实例自己的 `todos/` 目录。

- **每台电脑只写自己的文件**（设备 id 来自 `userData/device.json`），文件里是这台电脑看到的完整清单。
  两台都写同一个文件会让 git `pull --rebase` 冲突，而一冲突整个 `~/.agents` 同步都会停。
- 读的时候合并目录里所有文件：同一 `id` 的用户字段取 `updated` 最新的那份；相同原文和 `textUpdated` 的 `ai` 单独按 `ai.updated` 合并，旧设备勾选不会回退 AI 状态/产物/确认标记；不同内容版本不继承旧 `ai`；`deleted: true` 的不显示（保留原文以便撤销，
  也防止另一台的旧副本把它带回来）。写入是临时文件 + 改名；别的电脑的坏文件跳过，自己的坏文件不覆盖、拒绝写入。
- 文件格式：

```json
{ "version": 1, "device": "dev-…", "host": "…", "updated": "…",
  "items": [ { "id": "td-…", "text": "一行字，最多 500 字", "done": false, "doneAt": null,
               "created": "ISO 时间", "updated": "ISO 时间", "deleted": false,
               "source": "desktop | phone", "device": "dev-…", "ai": null } ] }
```

- 个人待办 `ai: null`；AI 待办的 `ai` 数据字段见下文。新增 `textUpdated`、`textDevice` 记录内容版本的时间和保存设备，勾选和状态回填不会改变它们。以后的版本加的未知字段仍原样保留。
- 队长读取用 `todo list` 获取合并结果；直接读 `todos/*.json` 的工具需复用 `TodoStore` 合并规则，不自行按整条 `updated` 覆盖 `ai`，跳过 `deleted`。
  不要直接改这些文件；队长读写状态使用下面的 `board-cli todo` 命令。

## 手机接口

`GET <前缀>api/todos` → `{ items }`：未删除的条目带 `id,text,done,doneAt,created,updated`，AI 待办另带 `ai`（已完成最多 200 条），
删除的只给 `{id, deleted:true, updated}`，不带原文。

`POST <前缀>api/todos`：

- `{ "op": "add", "text": "…" }`
- `{ "op": "update", "id": "td-…", "done": true|false, "base"?: { text, done, doneAt, created, updated } }`
  ——`base` 让一台电脑能勾掉另一台刚记、还没通过 git 同步过来的那条。

和发消息给队长同一道门：未登录 401（在路由之前判断），精确 Origin、Fetch Metadata、设备 cookie、CSRF，
读完请求体后再验一次登录。请求体是字段白名单，其他操作（删除、改字、`ai`）一律 400。`api/info` 的能力表里有 `todos`。

总台同时读两台电脑并按 `updated` 合并；写入只发给一台：在别的标签里选过的那台（没选过就是默认的 Mac），它不在线才记到另一台。
两台本来就是同一份清单，所以这里允许换一台记（发给队长的消息仍然永远不改发）。发不出去时写明原因，草稿留在输入框。

## 测试

```
node --test tests/todo-store.test.js tests/mobile-todos.test.js tests/mobile-hub-todo.test.js
AGENTDECK_TODO_SHOTS=<目录> npx playwright test tests/e2e/todo.spec.js
AGENTDECK_HUB_SCREENSHOT_DIR=<目录> npx playwright test tests/e2e/mobile-hub-todo.spec.js
```

## 第二步：AI 后台（现有 Todo 界面不变）

本地字面匹配 `@ai`，大小写、半角/全角 `@`、前后空格、`@ ai` 都认；标记后是中文字符、结尾、空白或标点都认（下划线不算），中文也可紧邻标记之前，例如 `@ai查火车`、`帮我@ai找本书`、`＠AI查资料`。标记后紧跟英文字母或数字不触发，例如 `@aiden`、`@air_france`、`@ai2`；邮箱 `me@ai.com`、`用户@ai中文.com` 也不触发。建卡标题、任务正文和待办均保留原文。没有意图判断。不使用关键词推断或模型分类，保存事件、应用启动和每小时兜底扫描都没有模型调用。已勾掉、已删除及个人待办不投递。

每个内容版本由保存/编辑它的设备投递，另一台只读取同步状态；这避免 Git 尚未同步时两台同时唤醒队长。手机用 base 在另一台勾选尚未同步的条目时，该副本以 awaitingOrigin 等待原始文件，合并后恢复内容归属和 AI 状态，不在另一台重复派单。原设备未开 AgentDeck 时等待该设备启动，不在另一台自动抢单。原文通过第一步的 Git 同步仍然存在两台。旧版数据以 `created` 和 `device` 作为内容版本/所有者；没有设备字段的旧记录由首次本地扫描认领。仅修改勾选或保存相同文字不重交；文字变化生成新任务卡，改回旧文字也算新版本。删除或去掉所有 AI 标记后不再投递，已派出的旧工作不会被强制中断；旧版本回填拒绝。

先原子写 `ai` 投递记录，再复用 `TaskStore.add` 建卡（项目 `todo`，确定性 `todo-<版本 SHA256>` id），最后将完整模板持久保存到会话之外的 `config.todoInbox`，经队长现有的 `mainSession.pending` 接收。没有队长时留在本地；创建队长、保存、文件变更、启动及每小时扫描会重试。队长用现有 `receipts --wait` 或原生 host snapshot/ack 接收，输入框不会被写入。未读通知在删除/重建队长、重启后补送；收件队列同步保存成功才确认 `deliveredAt`（接受时间，不代表已读）。只有 `receipts` 消费、原生 host ack 或旧注入模式成功完成该轮才清队列，并写 `todoDeliveries` 已读去重标记；snapshot 不清，保存失败回滚。崩溃在建卡/确认中间也不会重复建卡或排第二条通知。旧版仍在 pending 的通知会迁移；旧版已经删除且正文丢失的未读通知无法从旧接受标记判断是否读过。

纯字面匹配仍有可预期误判：句子里引用独立的 `@ai`（如「记住文档里的 @ai 标记」）也会触发；人名和邮箱边界已排除。普通 AI 话题不触发。要保留为个人待办，不写该标记即可。检测不会调用模型消除歧义，队长应把这个边界告诉用户。

模板要求拿到实物：资料本身搜全保存后附总结，电子书 PDF/EPUB 本身落盘；缺用户才有的材料时「等用户提供，不要自己猜、不要瞎编」。病历、CT、证件、财务材料只在本机处理/存放，不得上传在线服务。默认不发手机提醒；等材料、办完都静默。Todo 卡片排除普通 `needs_user` Bark；仅回填 `failed` 时进入本机持久提醒队列，60 秒内失败合并为一条通用数量提示，走现有 `main-notify-user` 完整队长路由。Todo 的普通加急级别为 Bark `timeSensitive`，不发送 critical/强制音量；沿用前台静音及 30 秒声音间隔。本地时间 23:00–10:00 不发本机/手机提醒，攒到 10:00 后合并发送，重启不丢。仓库暂无免打扰设置项，时段集中在 `todo-failure-notifications.js` 的 `DEFAULT_QUIET_HOURS`，另一项统一设置任务接入这里。无队长时保留队列，发送前再校验时段；手机正文不带原文、原因或路径。每批网络请求只尝试一次，网络失败/未配置密钥会给队长脱敏异常回执，不反复响铃。

后台扫描、目录监听、状态写入、投递确认或提醒队列出现异常，会写本机临时目录下的 `agentdeck-notify.log`（只有阶段和错误码）并提交「Todo 后台异常」回执。回执只含通用说明，不包含原始异常文本、待办正文、私有文件路径或凭据；没有队长时本机 `todo-backend-errors.json` 保存待补送回执。连续同一故障只排一条异常回执，恢复后再次故障算新事件。

### 队长命令和状态

只限当前设备队长控制能力；普通/队员终端不可读写，网页/手机写入仍不可指定 `ai`。`main-todo` 复用既有鉴权的 board 请求/响应目录。状态必须附当前任务卡 id，防止旧任务回填覆盖编辑后的新任务。

```sh
node "$AGENTDECK_BOARD_CLI" todo list
node "$AGENTDECK_BOARD_CLI" receipts --wait
# 从 todo list 或新任务回执取实际 id；以下两个占位 id 要替换。
node "$AGENTDECK_BOARD_CLI" todo status --id td-… --task-id todo-… --status working
node "$AGENTDECK_BOARD_CLI" todo status --id td-… --task-id todo-… --status needs_user --message "等你提供病历和 CT 报告；不要上传在线服务"
node "$AGENTDECK_BOARD_CLI" todo status --id td-… --task-id todo-… --status done --files "/absolute/reports/source.pdf,/absolute/reports/summary.md"
node "$AGENTDECK_BOARD_CLI" todo status --id td-… --task-id todo-… --status failed --message "检索失败的具体原因"
```

队长照常用 `new --task-id <卡片 id> ...` 派活；接手、等待、验收完毕或失败后由队长明确回填，不把屏幕结束或队员说明当作完成证明。`done` 必须有至少一个本机存在的文件绝对路径（不接受目录），但文件质量/是否搜全仍由队长验收。AI 完成不自动勾掉用户的 `done`。回填同时更新关联卡片：working→doing，needs_user→needs_user（具体缺材料进入 `user_question`），done→done，failed→needs_user + failed 标记；当前基线的「需要你」看板据此读取等待/失败原因。

`ai` 供下步界面读取：

| 字段 | 含义 |
| --- | --- |
| `status` | queued 已交给 AI；working AI 正在办；needs_user 等你提供；done 已办完；failed 没办成 |
| `taskId`, `revision` | 关联卡片 id、内容版本 SHA256；回填必须携带 taskId |
| `ownerDevice` | 该版本投递/回填的设备 |
| `submittedAt`, `updated` | 投递记录创建时间、AI 状态更新时间（ISO） |
| `deliveredAt` | 队长队列持久接受时间；null 表示建卡/等待队长/等待确认，界面可显示待投递 |
| `message` | 缺材料、失败原因或说明；原文保留在待办 `text` |
| `files` | done 的去重绝对产物文件路径列表；其他状态为空 |
| `exceptionNotifiedAt` | 本版本异常提醒登记时间（不表示手机送达）；null 为尚未提醒 |

允许 queued→working/needs_user/done/failed，working→needs_user/done/failed，needs_user→working/done/failed，failed→working/needs_user/done；done 为终态，同状态可重试回填。重试或返工不再次提醒同版本。内容编辑重置 `ai`，下一次本地扫描建立新版本。

追加后台验证：

```sh
node --test tests/todo-ai.test.js tests/todo-store.test.js tests/todo-inbox.test.js tests/todo-backend-errors.test.js tests/todo-failure-notifications.test.js tests/receipts-seen.test.js tests/board-cli.test.js tests/task-board.test.js tests/needs-user-bark.test.js tests/notify-user.test.js tests/mobile-todos.test.js tests/mobile-hub-todo.test.js
npx playwright test tests/e2e/todo.spec.js tests/e2e/todo-ai.spec.js tests/e2e/mobile-hub-todo.spec.js
```

先取得 README 的全机测试锁；测试 Electron 使用 `--test-user-data` 后台透明且不可聚焦窗口、隔离文件和模拟 agent/Bark，手机 Chromium 测试用默认 headless。勿使用真实模型冒烟或正在运行的用户应用。
