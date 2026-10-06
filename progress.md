# 随手记待办 第一步 · 进度（2026-10-06，暂停已解除）

分支 `feat/todo-quick-capture-1.5`（基于 origin/main 45240be）。队长要求暂停：已做 WIP 提交，未合 main、未打 tag、未打包安装、未发完成回执。
设计：`/Users/jinhao/reports/jarvis-todo/step1.md`。格式与接口说明：`docs/todo.md`。

## 已完成

- 数据：`todo-store.js`。`~/.agents/boards/todos/<设备id>.json`，每台电脑只写自己的文件，读时按 id 取 `updated` 最新；删除留 `deleted:true`；`ai: null` 预留位。测试实例写 `userData/todos`。
- 主进程：`main.js` 新 IPC `todos:request`（list/add/update/remove）、目录 fs.watch 推 `todos:changed`；`preload.js` 加 `todos` / `onTodosChanged`；`package.json` build.files 加 `todo-ui.js`、`todo-store.js`。
- 桌面：`todo-ui.js` + `pages.js`（todo 页）+ `sidebar.js`（任务看板下「待办」+ 未完成数）+ `renderer.js`（todo 图标、init）+ `style.css`。回车记、勾/放回、铅笔原地编辑、垃圾桶删除带撤销、空状态；⌘T / Ctrl+Shift+T 速记框，焦点还给终端。
- 手机接口：`mobile-web.js` 的 `GET/POST api/todos`，在登录检查之后（未登录 401），POST 走 Origin/Fetch Metadata/CSRF，读完请求体再验登录；字段白名单，只能 add 和 update done（可带 base）；`api/info` 能力加 `todos`。
- 手机总台：`mobile-web/hub/`（index.html / app.js / core.js / style.css）第三个标签「待办」：记、看、勾/放回，合并两台电脑，写给选中的/默认 Mac，不在线换另一台；旧版提示升级。测试替身 `tests/fixtures/hub-proxy.js` 加了 todos。
- 文档：`docs/todo.md`（新）、`docs/mobile-web.md` 接口表、`docs/mobile-hub.md`、`README.md`。

## 测试（如实）

- `npm test`：1304 个，1291 过，13 跳过（平台），0 失败。新增单测 19 个：`tests/todo-store.test.js` 9、`tests/mobile-todos.test.js` 6、`tests/mobile-hub-todo.test.js` 4。
- 新 E2E：`tests/e2e/todo.spec.js` 9/9 过；`tests/e2e/mobile-hub-todo.spec.js` 6/6 过。
- 相关既有 E2E 一轮（13 个 spec，日志 `/Users/jinhao/reports/jarvis-todo/e2e-related-interim.log`）：83 过、5 失败、6 未跑。失败：
  1. `mobile-hub.spec.js:129`（dark、light 两条）——**本分支引入**。原因：待办页脚 `#todo-foot` 复用了 `.board-foot` 类，既有用例 `locator('.board-foot')` 在严格模式下匹配到 2 个元素。修法：待办页脚换独立类名（如 `todo-foot`，样式另写），不改既有用例。
  2. `task-board-ui.spec.js:212`（第 219 行）——**本分支引入**。用例断言侧边栏前 4 项是 `new, captain, tasks, navSearchSlot`，「待办」插在任务看板后面占了第 4 位。需要决定：把「待办」挪到搜索之后（不动既有用例），或更新这条断言把 todo 写进去（算改既有用例，要队长同意）。倾向前者。
  3. `sidebar-captain.spec.js:87`、`sidebar-title-one-line.spec.js:70`——共享记忆记录这两条在本机基线上本来就失败（不是本分支引入），**但这次还没在 45240be 上复跑核实**。
  - 6 条未跑的是失败用例所在串行组后面的用例，修完要重跑。

## 下一步

1. 修上面 1、2（改动很小），重跑 `mobile-hub.spec.js`、`task-board-ui.spec.js`。
2. 在干净的 45240be 副本上复跑 `sidebar-captain.spec.js`、`sidebar-title-one-line.spec.js`，确认是基线失败。
3. 重跑新 E2E 出最终截图，放 `/Users/jinhao/reports/jarvis-todo/step1-screens/`（现在 `interim/` 里是暂停前的 19 张：桌面宽/窄 × 深/浅、空状态、十几条、编辑、已完成、速记框；手机 390 记一条、列表、勾掉，深浅都有。手机页头「待办」标题是之后加的，截图里还没有）。
4. 删掉本文件或移出仓库，正式提交、推送，发完成回执（含需用户看一眼的界面取舍：快捷键 ⌘T/Ctrl+Shift+T 只在窗口内有效；手机不能改字/删除；手机待办标签放在第三位；Mac 不在线时手机自动记到 Windows）。

测试命令要在子进程里清掉 AGENTDECK_* 变量并拿 `/tmp/agentdeck-test.lock`（会话 scratchpad 里有 `clean.sh` / `locked.sh`，scratchpad 可能已被清理，照 README 重写即可）。

## 恢复后（暂停解除）

- 已修本分支引入的 2 处：待办页脚改用独立类 `todo-foot`（不再撞 `.board-foot`）；侧边栏「待办」挪到「搜索」下面，`#navTop` 前 4 项恢复为 `new, captain, tasks, navSearchSlot`，既有用例不改。自己的 `todo.spec.js` 按新位置断言。
- 相关单测 166/166；全量 `npm test` 1304：1291 过、13 跳过、0 失败。
- 电池供电，按队长要求 **E2E 留到接电后**：待重跑 `todo.spec.js`、`mobile-hub-todo.spec.js`、`mobile-hub.spec.js`、`task-board-ui.spec.js`，并在 45240be 干净副本上复跑 `sidebar-captain.spec.js`、`sidebar-title-one-line.spec.js` 取基线证据；最终截图落 `/Users/jinhao/reports/jarvis-todo/step1-screens/`。
