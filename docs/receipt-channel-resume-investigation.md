# 恢复/重启后的队员回执被拒：调查记录（未修复）

现象：队长 `new` 出来的队员会话，经过「归档 → tell 自动恢复」或 AgentDeck 重启后，
`complete` / `progress` / `ask` 报「缺少回执通道凭证」或 board-cli.js:46
「This terminal is independent…」，队长只看到「已结束，未提交回执」。

## 已核对、未发现缺陷的路径

- `main.js` `spawnPty`：每次新建 PTY（新建、恢复、重启都走这里）都会先删掉继承来的
  `AGENTDECK_*`，再无条件写入新的 `AGENTDECK_RECEIPT_TOKEN`、`AGENTDECK_CONTROL_DIR`、
  `AGENTDECK_BOARD_CLI`，并登记到 `receiptSessions`。队员（`captainCrew`，`role: 'manual'`）
  本来就只拿回执凭证、不拿控制凭证，这与是否恢复无关。
- `setupBoardControl()` 在 `createWindow()` 之前执行，重启时不存在 `boardControlDir` 为空的窗口期。
- `killPty` / 旧 PTY 迟到的 `onExit` 都有代际判断，不会删掉新 PTY 的凭证。
- `restoreArchived` 保留列 id 和 `captainCrew`；`main-tell` 恢复后立即 `dispatch`，
  送达时写 `startedAt`，`MainSession.submit` 能按列 id 找到任务。

board-cli.js:46 只在 agent 的 shell 里**读不到** `AGENTDECK_CONTROL_DIR` 或
`AGENTDECK_RECEIPT_TOKEN` 时出现。按上面的代码，PTY 的环境里两者都在，所以问题更可能在
PTY 之后：agent 把环境变量过滤掉了。

## 尚未验证的线索

- Codex 的 `shell_environment_policy` 默认会去掉名字含 `KEY` / `SECRET` / `TOKEN`
  的环境变量，`AGENTDECK_RECEIPT_TOKEN` 正好会被去掉，而 `AGENTDECK_CONTROL_DIR` 还在。
  这与 board-cli.js:46 的报错完全吻合，但它会影响所有 Codex 队员，而不只是恢复后的会话；
  需要确认出问题的 4 个会话是不是 Codex（或其它会过滤 `*TOKEN*` 的 agent）。
- 需要现场信息才能定位：出问题的会话用的 agent 和命令行；在该会话 agent 的 shell 工具里
  运行 `env | grep AGENTDECK_`（只看变量名，不要贴凭证值）的结果。
