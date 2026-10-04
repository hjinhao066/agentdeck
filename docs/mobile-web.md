# 本地手机网页端（第一步）

桌面 AgentDeck 的侧边栏齿轮 →「手机网页端」→ 开启「本地网页服务」。
默认关闭，开启后仅监听 `127.0.0.1:43121`；设置显示本地地址及登录 token，
复制 token，在同一台电脑的浏览器打开地址并登录。第一次开启使用随机 token，
保存在该实例的本地 `config.json`；关闭再开启沿用它。端口被占用会显示错误，
不会绑定其他网卡或自动寻找公网入口。开启和关闭无需重启桌面应用。

这一阶段适配手机竖屏，但手机通过局域网无法直接访问电脑的 loopback 地址。
没有反向代理、公网入口、多机切换或推送通知。

登录后使用 HttpOnly、SameSite=Strict cookie 记住浏览器。每个资源和 API 都鉴权；
也可通过 `Authorization: Bearer <token>` 请求 API。token 不放入 URL 或页面存储。
服务使用本地 HTTP，因此 cookie 不带 Secure。只接受绑定地址的 Host 和同源写请求。

页面提供会话列表（队长、活动队员的标题、模型、状态和最新回执摘要）、只读任务看板
（来自 `task-board.js`，按项目和状态分列）、队员最近 100 行输出（最多 16000 字符）、
给队长发消息（1–8000 字符）。深浅主题跟随系统，可用图标切换并记住选择。
已归档会话不在活动会话列表内。输出按纯文本显示，不执行终端控制序列或 HTML。

消息仅送给当前队长，复用桌面 `sendWhenReady` 通道：等待队长空闲且 agent 在前台，
保护桌面尚未发送的输入，不能向队员发消息。网页的「已排队」表示当前实例已接受，
并非模型完成；等待中的消息按顺序存入本地配置，重启后继续送达，进入队长的聊天历史。
单次等待超时保留队列并重试，最多接受 20 条待发消息。未创建/启动队长时拒绝发送。

固定接口：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| POST | `/login` | `{token}` 登录，成功设置 cookie |
| GET | `/api/sessions` | `{sessions: [{id, title, model, status, isMain, receipt}]}` |
| GET | `/api/tasks` | `{cards: [...]}` |
| GET | `/api/output?id=<队员ID>` | `{id, title, text}` |
| POST | `/api/captain` | `{message}`，接受后 `{queued: true}` |

未登录的 `/` 返回 401 登录页；其他未鉴权资源及错误 token 均返回 401。
API 不暴露任意 IPC、文件路径、队员控制或看板修改接口。

开发验证：`npm test`；首次先 `npx playwright install chromium`，相关隔离桌面/浏览器 E2E：
`npm run test:e2e -- tests/e2e/mobile-web.spec.js`。
截图可指定 `AGENTDECK_MOBILE_SCREENSHOT_DIR=<绝对目录>`，仅使用 fixture 数据。
测试创建临时 `--test-user-data`，任务目录为该 profile 下的 `tasks/`，只运行 stand-in agent。
