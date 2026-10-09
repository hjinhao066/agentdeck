# 随手记待办

你自己要做的小事，一句话一条。和派给 AI 的任务卡（`~/.agents/boards/tasks/`）分开存、分开显示。

## 在哪里记

- **桌面**：侧边栏「待办」（搜索下面，右侧数字是未完成条数）。打开就聚焦输入框，打一句话回车就存，可以连记；
  圆圈勾掉，已完成折叠在下面，点圈可放回。悬停或键盘聚焦一行时出现铅笔（编辑，回车保存、Esc 取消）和垃圾桶
  （删除，提示条里可撤销）。双击文字也能编辑。中文输入法选词时的回车不会误存。
- **速记**：在 AgentDeck 窗口里任何地方（包括终端里、待办页上）按 Mac `⌘⇧N` / Windows `Ctrl+Shift+N`，窗口正中弹出
  速记框，光标已在输入框里。回车存好后框不关，新的一条出现在下面列表最上面并亮一下，可以接着记（一次冒出几件事时不用反复按快捷键；
  存没存上看列表就知道）。列表按时间排：未完成在前、最新的在上，后面是已完成的；点圆圈就地勾掉或放回。
  Esc 或右上角 × 关闭并清空没存的字；点框外任何地方也关闭，但打了一半的字留着，下次按快捷键还在。关闭后焦点回到原来的地方（比如终端）。
  只在 AgentDeck 窗口里有效，不注册系统级热键。
- **换快捷键**：设置 →「快捷键」→ 点「速记待办」右边的按键框，再按想用的组合键；Esc 取消，旁边的箭头恢复默认。
  Mac 要带 `⌘`（可再加 `⇧`、`⌥`），Windows 要 `Ctrl` 加 `Shift` 或 `Alt`（Ctrl 加字母留给终端），再加一个字母或数字。
  和 AgentDeck 自己的快捷键（`⌘N` 新对话、`⌘J`、`⌘K`、`⌘1…9` 等）或复制粘贴这类通用键撞了会提示换一个。
  别的软件注册的系统级热键会先把按键截走，AgentDeck 收不到：原来的 `⌘T` 就被窗口置顶工具 Topit 占了
  （按下只看到 Topit 的图标亮），所以 2.0.1 起默认改成 `⌘⇧N`。按了没反应时先换一个键试试。
- **手机总台**：底部「待办」标签，点它光标直接进输入框。总台记得上次停在哪个标签，网址末尾加 `#todo` 直接打开待办
  （可以加到手机主屏）。能记、能看、能勾掉/放回，不能改字和删除（防误删，桌面上做）。

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

- `ai` 是给以后「交给 AI」留的位置。这一版永远写 `null`，读到别的值原样保留，界面和接口都不碰它；
  以后的版本加的未知字段也原样保留。
- 队长和其他 AI 读：把 `todos/*.json` 都读进来，按 `id` 取 `updated` 最新的一份，跳过 `deleted`。
  不要直接改这些文件；以后要让队长改，走 AgentDeck（board-cli 命令）。

## 手机接口

`GET <前缀>api/todos` → `{ items }`：未删除的条目只有 `id,text,done,doneAt,created,updated`（已完成最多 200 条），
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
