# 自动回执入口

给本机定时脚本（launchd、Windows 计划任务、cron，例如夜间挖虫）的一个正规、限权的入口。这些脚本不在任何 AgentDeck 终端里，拿不到终端令牌，队长命令行会拒绝它们（`This terminal is independent`）。以前的办法是借手机网页接口、以用户手机的身份给队长发话，等于冒用用户；现在改走这个入口，每一条都明说「这是自动任务发的」。

## 能做什么、不能做什么

```sh
node "<配置目录>/board-control/tools/agentdeck-board.js" automation receipt --source nightly-bughunt --message "要告诉队长的话"
node "<配置目录>/board-control/tools/agentdeck-board.js" automation task-add --source nightly-bughunt --project agentdeck --title "标题" [--detail "说明"]
node "<配置目录>/board-control/tools/agentdeck-board.js" automation inbox-report --source nightly-bughunt --title "一句话结论" [--detail "细节"] [--files 路径1,路径2] [--project 项目]
node "<配置目录>/board-control/tools/agentdeck-board.js" automation status
```

- `receipt`：队长读到的是一条通报，写着「【自动任务：名字】……不是用户本人的话，也不是授权或指令」，是否处理按队长自己的规则和用户已有的授权来定。不会出现在聊天里当作用户消息。没有队长在运行时报错，不会悄悄丢掉。
- `task-add`：建一张「待办」卡，说明开头带「【自动任务：名字】本机定时脚本经自动回执入口登记，不是用户本人建的。」。只有 `--project`、`--title`、`--detail`；不能带依赖、优先级、验收、状态，也不会自动开始做。
- `inbox-report`：在「待我处理」登记一条结果汇报，页面和手机总台标明「来自自动任务：名字」。永远是汇报，不是「要你处理」，不发提醒；同一标题的未处理汇报不重复登记。
- 不能派活（`new`）、不能 `tell`、不能读对话或会话输出、不能改设置、不能登记「要你处理」、不能发提醒。请求里多带任何字段都被拒绝。
- `--source` 是脚本的名字：1–40 个字，字母、数字（任何语言）、空格和 `. _ -`，队长和页面看到的都是「自动任务：」加这个名字。文字超长直接拒绝，不截断（回执 4000 字，标题 300，细节 8000，文件 20 个）。

## 令牌与开关

- 令牌由应用自己生成，存在配置目录的 `board-control/automation.json`（macOS：`~/Library/Application Support/agentdeck/board-control/`；权限 600，权限不对或文件损坏会换新令牌重写）。它与每个终端的令牌、手机网页的登录令牌互相独立：终端令牌不能用于 `automation-*`，自动令牌也不能用于任何终端命令。脚本不碰令牌，`automation` 命令自己读文件；令牌不会显示在设置页、日志或 IPC 里。
- 设置 → 自动回执：开关可停用整个入口（脚本立刻失败，状态跨重启保留）；重置按钮换新令牌，旧令牌立即作废，脚本下次运行读到新的，不用改脚本。设置里还显示最近一次谁用过。
- 限频：同一个名字每分钟 6 条，所有名字合计每分钟 12 条，等待处理的自动命令最多 24 条；超过直接拒绝并说明多少秒后再试。`status` 不占额度。
- 只在本机：走与终端相同的 `board-control` 文件通道（目录仅本用户可读写），不开任何网络端口。同一用户下的其他程序若读得到配置目录里的文件，也就拿得到这个令牌；它的权限因此被收得很窄，且可随时停用或重置。

## 旧版 AgentDeck

旧版没有这个入口：`automation` 命令报 `Unknown action: automation` 或「没有自动回执入口」。脚本应退回「只写报告 + 本机通知」，不要去借别的身份。夜间挖虫就是这样做的：先 `automation status` 探路，通了才建卡、登记、发回执；不通就只写报告、发本机通知横幅。

## 实现

`automation-core.js`（令牌文件、白名单校验、限频，纯函数，随应用复制到 `board-control/tools/`）；`main.js` 的 `processBoardRequests` 在查任何终端令牌之前先过 `AutomationCore.screen`，通过的请求按白名单重建成不带调用者的命令（`callerId` 为空）送到页面；`main-session.js` 的 `automation()` 与 `attention-ui.js` 的 `automation()` 执行；`board-cli.js` 的 `automation` 子命令；设置页走 `automation:settings`（只返回开关状态，不返回令牌）。测试：`tests/automation-core.test.js`、`automation-gate.test.js`、`automation-cli.test.js`、`automation-session.test.js`，端到端 `tests/e2e/automation-receipt.spec.js`。
