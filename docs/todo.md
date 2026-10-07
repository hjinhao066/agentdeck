# 随手记待办

一句话一条；不含 `@ai`、也不以独立的「空格 + AI」结尾的是你自己的事，AI 不碰。符合任一标记的交给 AgentDeck 队长，关联任务卡存在 `~/.agents/boards/tasks/todo.json`，待办原文仍按下面的方式存储。

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
- 读的时候合并目录里所有文件：同一 `id` 取 `updated` 最新的那份；`deleted: true` 的不显示（保留原文以便撤销，
  也防止另一台的旧副本把它带回来）。写入是临时文件 + 改名；别的电脑的坏文件跳过，自己的坏文件不覆盖、拒绝写入。
- 文件格式：

```json
{ "version": 1, "device": "dev-…", "host": "…", "updated": "…",
  "items": [ { "id": "td-…", "text": "一行字，最多 500 字", "done": false, "doneAt": null,
               "created": "ISO 时间", "updated": "ISO 时间", "deleted": false,
               "source": "desktop | phone", "device": "dev-…", "ai": null } ] }
```

- 个人待办 `ai: null`；AI 待办的 `ai` 数据字段见下文。新增 `textUpdated`、`textDevice` 记录内容版本的时间和保存设备，勾选和状态回填不会改变它们。以后的版本加的未知字段仍原样保留。
- 队长和其他 AI 读：把 `todos/*.json` 都读进来，按 `id` 取 `updated` 最新的一份，跳过 `deleted`。
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

本地字面匹配 `@ai`，大小写、半角/全角 `@`、前后空格、`@ ai` 和紧邻中英文都认，按字面子串匹配。另一种写法是结尾独立的「空格 + AI」（大小写都认），如「查一下西雅图到温哥华的火车 AI」；中间出现 AI、OpenAI、学AI、AI 后有标点或别的字都不触发。第一步存储仍会折叠空白并去掉首尾空格，所以末尾多余空格不影响识别。建卡标题/任务正文去掉结尾 AI 标记，待办原文保留。没有意图判断。不使用关键词推断或模型分类，保存事件、应用启动和每小时兜底扫描都没有模型调用。已勾掉、已删除及个人待办不投递。

每个内容版本由保存/编辑它的设备投递，另一台只读取同步状态；这避免 Git 尚未同步时两台同时唤醒队长。手机用 base 在另一台勾选尚未同步的条目时，该副本以 awaitingOrigin 等待原始文件，合并后恢复内容归属和 AI 状态，不在另一台重复派单。原设备未开 AgentDeck 时等待该设备启动，不在另一台自动抢单。原文通过第一步的 Git 同步仍然存在两台。旧版数据以 `created` 和 `device` 作为内容版本/所有者；没有设备字段的旧记录由首次本地扫描认领。仅修改勾选或保存相同文字不重交；文字变化生成新任务卡，改回旧文字也算新版本。删除或去掉所有 AI 标记后不再投递，已派出的旧工作不会被强制中断；旧版本回填拒绝。

先原子写 `ai` 投递记录，再复用 `TaskStore.add` 建卡（项目 `todo`，确定性 `todo-<版本 SHA256>` id），最后将完整模板放入队长的 `mainSession.pending`。没有队长时留在本地；创建队长、保存、文件变更、启动及每小时扫描会重试。队长用现有 `receipts --wait` 或原生 host snapshot/ack 接收，输入框不会被写入。队长配置中的 `todoDeliveries` 保留每版本的去重标记，同步保存成功才确认 `deliveredAt`。崩溃在建卡/确认中间也不会重复建卡或排第二条通知。

纯字面匹配仍有可预期误判：如「了解一下 AI」「学习 AI」「研究生成式 AI」可能本来在说话题，也会当作给 AI 的任务；引用 `@ai` 或带 `@ai` 子串的邮箱也可能触发。要保留为个人待办，可写「了解 AI 是什么」「学习AI」等不满足标记的文字。检测不会调用模型消除歧义，队长应把这个边界告诉用户。

模板要求拿到实物：资料本身搜全保存后附总结，电子书 PDF/EPUB 本身落盘；缺用户才有的材料时「等用户提供，不要自己猜、不要瞎编」。病历、CT、证件、财务材料只在本机处理/存放，不得上传在线服务。默认不发手机提醒；等材料、办完都静默。Todo 卡片排除普通 `needs_user` Bark；仅回填 `failed` 时走现有 `notify-user --urgent` 的函数一次，手机正文只给通用异常提示，不带待办原文、原因或路径。发送前落盘异常标记，网络失败不自动重复响铃。

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
| `exceptionNotifiedAt` | 本版本异常提醒已尝试时间；null 为尚未提醒 |

允许 queued→working/needs_user/done/failed，working→needs_user/done/failed，needs_user→working/done/failed，failed→working/needs_user/done；done 为终态，同状态可重试回填。重试或返工不再次提醒同版本。内容编辑重置 `ai`，下一次本地扫描建立新版本。

追加后台验证：

```sh
node --test tests/todo-ai.test.js tests/todo-store.test.js tests/board-cli.test.js tests/task-board.test.js tests/needs-user-bark.test.js tests/notify-user.test.js tests/mobile-todos.test.js tests/mobile-hub-todo.test.js
npx playwright test tests/e2e/todo.spec.js tests/e2e/todo-ai.spec.js tests/e2e/mobile-hub-todo.spec.js
```

先取得 README 的全机测试锁；测试 Electron 使用 `--test-user-data` 后台透明且不可聚焦窗口、隔离文件和模拟 agent/Bark，手机 Chromium 测试用默认 headless。勿使用真实模型冒烟或正在运行的用户应用。
