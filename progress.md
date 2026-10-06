# 待我处理（卡 t-1cfef8e1）进度

停在安全点：2026-10-06，队长要装 1.5 并重启。分支 `agentdeck/t-1cfef8e1-517a-4b3d-aea5-b8a7d5cb61b6`，基于 main 45240be。
这个文件只是进度记录，合并前删掉（Todo 分支也有一个 progress.md）。

## 已完成（都已提交）

- `attention-core.js`：数据模型和规则（纯函数，桌面、主进程、测试共用）。
  - 条目两类：need（要你处理：拍板/登录授权/付款/回答/验收卡住）、report（结果汇报）。
  - 落盘：这台电脑的 `config.json` 里 `config.attention`（不进 git）。已完成最多留 200 条，未完成的永不删。
  - 自动打勾：用户回复（回复带原条目交给队长）、用户点「已处理/知道了」、队长 `inbox resolve`、
    关联卡片 done/归档（只对 need）、看板派生条目所在卡片不再等用户、登记时正在等回答的会话答完了。
  - 看板派生：needs_user 卡（每次进入「需要你」算一条）、held 卡自动出现；队长对同一张卡登记 need 时替换掉派生条目。
- `board-cli.js`：`inbox need|report|list|resolve|help`。`notify-user` 也自动登记一条 need。
- `main.js`：放行 `main-inbox`；`inbox need` 新登记时走和 notify-user 一样的本机提醒（--urgent 加 Bark）；手机接口接线。
- `main-session.js`：`main-inbox` 交给 AttentionUI；notify-user 同时登记；导出 `userNotice`（用户回复作为回执交队长）。
- `main-core.js`：队长说明里 notify-user 那行换成 inbox 一行（保留 --urgent 仅登录/授权/付款的规则）；win32 恰好 8000 字，预算用满。
- `attention-ui.js`：桌面页（侧边栏「待我处理」在队长下面，带角标；要你处理在前、结果汇报在后、已完成默认收起；
  就地回复、已处理/知道了、全部知道了、放回待处理；复制/跳到会话/复制路径/在访达中显示为图标按钮）。
  已读：卡片大半在屏上停 1.5 秒算读过（定时测量，不用 IntersectionObserver，后台窗口也可靠）。
- `pages.js`/`sidebar.js`/`renderer.js`/`index.html`/`package.json`/`style.css`：入口、图标、脚本、打包清单、样式。
- `mobile-web.js`：`GET/POST api/attention`（逐字段重建，read/reply/done/reopen 白名单，CSRF/Origin/登录同发消息）。
- 手机总台 `mobile-web/hub/`：「待我处理」标签（总览后面，带角标），两台电脑合并显示，回复/勾掉只发给那条所在的电脑；
  失败原因显示在那一条下面，草稿保留。规则在 core.js 末尾单独一段（不碰 Todo 分支改的导出行）。
- 测试：`tests/attention-core.test.js`、`tests/mobile-attention.test.js`、`tests/mobile-hub-attention.test.js`；
  相关单测共 307 项全过（含加载 main-session 的各 *-session 测试、main-core、board-cli、release、mobile-*）。
- 手机 E2E `tests/e2e/mobile-hub-attention.spec.js` 2/2 通过；截图在 /Users/jinhao/reports/agentdeck-attention-page/
  （phone-1-list-dark、phone-2-reply-dark、phone-3-done-dark、phone-4-light）。

## 进行中 / 下一步

1. 桌面 E2E `tests/e2e/attention.spec.js` 已写好但还没跑通：第一次跑在 beforeAll 报 `terms is not defined`，
   原因是 firstWindow 后没等页面脚本加载就 evaluate。修法：beforeAll 里先 `await expect(page.locator('.xterm')).toHaveCount(1)`
   再 evaluate（和 notify-user.spec.js 一样），并挂 pageerror 看有没有脚本错误。要等接电/队长说继续再跑，单独跑这一个 spec。
2. 跑通后桌面截图 desktop-1..5 落到 /Users/jinhao/reports/agentdeck-attention-page/。
3. 文档：README 布局一节加「待我处理」、新 docs/attention.md（数据、规则、CLI、手机接口）、docs/mobile-hub.md 补一句。
4. 删除本 progress.md，最终提交、推送，交回执。

## 没做 / 留意

- 队长决定文件「等用户决定」里约 33 条手写条目不自动导入（只读、格式不统一）；装好后由队长用 inbox need 逐条登记。
- 旧的单机手机页 `mobile-web/app.js` 没加这个页面（总台有）。
- 和 Todo 分支（feat/todo-quick-capture-1.5）预计冲突很小：侧边栏入口加在队长和任务看板之间、样式插在文件中间、
  hub 的导出用末尾单独一段扩展；mobile-web.js 构造参数没改签名行。两边都有 `.navigation button { position: relative; }`（相同规则）。
