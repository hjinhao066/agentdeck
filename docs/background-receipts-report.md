# 队长后台回执通道

默认模式中，队员回执、提问和确认提示只进入回执队列；不会注入队长终端，
也不会附在用户从聊天输入框发送的消息中。卡片、ledger 和已保存的摘要仍可查看。

`node "$AGENTDECK_BOARD_CLI" receipts --wait [--timeout 秒]` 阻塞等待未读项，
有结果就输出摘要并以 0 退出；超时以 0 退出且 stdout 为空。省略超时则持续等待。
CLI 使用已有的队长权限通道进行短请求轮询，空结果不写 config 缓存；
已超时的请求不会消费后来到达的回执。没有权限的终端仍被拒绝。

队长提示词要求 Claude Code 通过 Bash 工具设置 `run_in_background: true`
运行 `receipts --wait --timeout 300`，保持恰好一个监听；收到任务完成通知后
读取任务输出、处理回执，再立即挂下一个。空输出超时也重挂，恢复会话时检查
是否已有监听。后台通知的实际唤醒由 Claude Code 提供。

恰好一个监听由程序兜底：每个 `receipts --wait` 进程带自己的标识和启动时间，同一队长终端里更晚启动且
还在轮询的监听接管通道，更早的那个下次轮询收到一行说明后以 0 退出，不消费回执；停止轮询超过 15 秒的监听不算。
席位 Relay 关掉旧终端时旧令牌作废，旧终端里的监听下一次轮询即被拒绝。

后台通道取走的回执不会再投递。取走之后队长没有再开始并完成过一轮工作（例如额度用尽时监听仍在运行）的回执，
在 Relay 和重启时列进交接（`handoff` 第 5 节），由接任的队长逐条核对，保留到下一次 Relay。接任的队长没做完一轮工作就又被换下时，继续带给再下一任。

旧输入注入路径保留为 `config.json` 中的
`mainSession.legacyReceiptInjection: true`；缺省/false 为后台通道。
开关控制自动注入和用户消息附带回执两条路径。编辑磁盘配置应在应用关闭时进行。
旧模式仍受用户输入保护；测试显式开启它来覆盖回退行为。

## 半句话验收

自动验证命令：

```sh
npm test
npm run test:e2e
npm audit --audit-level=high
```

`tests/e2e/background-receipts.spec.js` 使用独立临时 userData、假 agent 和
现有权限控制通道，不重启现役应用、不使用真实模型、不写系统剪贴板。
它用键盘在队长原始终端输入 `my unfinished sentence`，不按 Enter；
后台监听期间向真实队员 PTY 派一件任务，读取其完成回执，再等待多个状态 tick，
检查输入草稿仍完整且假 agent 从未收到这句话或自动回执。
只有测试模拟用户按 Enter 后，假 agent 才收到原句，且内容与原句完全相等。
还检查聊天发送不带回执、空输入框时不自动注入、提问后台读取、超时空输出、
过期请求不消费回执、非队长被拒绝。旧 captain E2E 覆盖显式开启后的注入回退。

将来安装此分支后，Claude Code 实机验收：

1. 确认队长已经通过 Bash `run_in_background: true` 挂了一个监听。
2. 在队长原始终端输入半句话，不按 Enter；再让已派出的队员完成任务。
3. 观察 Bash 后台任务完成通知和队长处理回执；半句话应仍留在输入框，
   用户消息记录中不应出现它，也不应有通过输入框注入的回执。
4. 用户自己按 Enter 后，才应发送这句话；聊天输入框也同样验证一次。

本任务只提交源码和隔离测试，未打包、安装或重启现役 AgentDeck；
自动测试验证了控制通道和输入行为，未使用真实 Claude Code 验证后台通知唤醒。

## 本机验证结果

- `npm test`：150 passed。
- `npm run test:e2e`：94 passed（5.8 分钟）。
- 最终源码串行复跑 background-receipts + captain：25 passed（3.4 分钟）。
- `npm audit --audit-level=high`：0 vulnerabilities；`git diff --check` 通过。
- 一次与完整套件并行的补充运行在既有 `tell --replace` 用例失败；
  完整套件和随后串行复跑该用例均通过，未改动该任务派发逻辑或削弱断言。
- 本次验证在 macOS 源码隔离实例完成；未打包，未做 Windows 实机验证。
