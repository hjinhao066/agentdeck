# Claude 席位与Relay

设置（侧边栏底部齿轮 → Claude 席位与 Relay → 席位设置）中的席位列表是名称和目录的唯一配置源。CN/US/Relay 是统一配置的名称，之后仍可在同一处修改；历史会话按稳定 id 记席位，不按名称记。

```json
{
  "claudeSeats": [
    { "id": "cn", "name": "CN", "icon": "🇨🇳", "configDir": "~/.claude" },
    { "id": "us", "name": "US", "icon": "🇺🇸", "configDir": "~/.claude-us" }
  ],
  "activeClaudeSeatId": "cn",
  "captainRelayLabel": "Relay",
  "captainRelayCodex": { "name": "ChatGPT", "command": "codex --model gpt-6.1-sol --dangerously-bypass-approvals-and-sandbox" }
}
```

CN是中国 Google 邮箱的 Claude 订阅，US是美国 Google 邮箱的订阅。
只在本机读取账号元数据，界面只接收打码邮箱，不接收凭据。本机已用真实 CLI 只读核对，CN 和 US 都已登录 Pro；账号元数据和凭据位置独立。
没有配置时按上述默认值迁移；每列的 `claudeSeatId` 持久保存。

## 首次准备（macOS）

```sh
node scripts/setup-claude-us.js
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_SECURESTORAGE_CONFIG_DIR -u CLAUDE_CODE_HOST_CREDS_FILE -u CLAUDE_CODE_HOST_GATEWAY_LINEAGE CLAUDE_CONFIG_DIR="$HOME/.claude-us" claude auth login
```

第二条命令由用户在普通终端亲自运行，在浏览器里选美国邮箱的 Claude
订阅账号。不要在现有队长终端运行 `/logout`。每台电脑各登录一次；
Windows 可用 `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.claude-us"; claude auth login`，
符号链接准备脚本的文件链接可能需要开发者模式或管理员权限。

准备脚本只给US创建目录/链接，不修改CN，不读写 Keychain，不复制凭据。
技能、CLAUDE.md、settings、hooks、plugins、projects（含自动记忆和对话）、
已有的 history/file-history/transcripts 等指向CN同一份。重复运行安全，
遇到已有不同内容拒绝覆盖。未来新增共享文件后可重跑脚本。

`.claude.json` 含 `oauthAccount`，必须独立；首次只复制其中的 projects（信任与
项目级配置）、本地 mcpServers 和已完成的 UI 引导标记；不复制权限绕过确认。
旧 US 配置已登录却缺少引导标记时，重跑准备脚本只补缺失标记，保留该账号及其他配置。之后这些全局 MCP 定义变更需人工同步这两个字段，
不能链接整个 `.claude.json`。云连接器和 MCP 的 OAuth 每账号各授权一次。
凭据文件、用量缓存、运行时缓存、进程锁不共享。

官方说明：
[环境变量](https://code.claude.com/docs/en/env-vars)、
[凭据隔离](https://code.claude.com/docs/en/authentication#credential-management)。
本机 2.1.288 的实现：默认未设置目录时 Keychain 服务名是
`Claude Code-credentials`；显式目录时追加该目录 SHA256 的前八位。
`/Users/jinhao/.claude-us` 对应 `Claude Code-credentials-f5148bc0`。
AgentDeck 把路径展开成固定绝对路径；默认CN保持 `CLAUDE_CONFIG_DIR` 未设置，
避免把现有默认登录变成另一个 Keychain 名称。内部环境和启动命令都清除订阅
以外的继承认证覆盖项，启动命令再次设置席位，防止 shell profile 改回别的账号。
用户 settings 中也不要设置会覆盖席位的认证变量。

## Relay行为

Claude 队长行右侧的Relay图标打开席位选择，标注当前席位。未登录席位禁用；
也可选 ChatGPT（Codex GPT-6.1 Sol）接力当队长；Codex 队长可以再交回 CN/US。额度用尽时队长列顶部出现提示和
直接换到另一席的图标。输入框还有草稿时先保留草稿并拒绝切换。

顺序是：保存原队长完整对话与进度看板 → 原队长对话转为历史 → 新 id/新 PTY
用所选席位启动 → 重发队长提示词和「读看板继续」。未完成回复记为 interrupted；
回执、提问、等待队列和正在跑的队员都保留。任何存档错误都保留原队长。
新会话默认当前席位；已有会话（包括归档后恢复）继续使用原席位。
Relay 只重开队长列，不重启 AgentDeck。

ChatGPT 接力仍使用 `isMain` 列和新建的专属控制 token；队长能力与 provider 无关。
启动 Codex 时绕过 shell 的 codex() 函数，避免重复追加 bypass 参数。`ledger/new/tell/receipts`
从 Codex 队长的 PTY 子进程执行时有效；独立终端没有能力 token，仍被拒绝。
切到 ChatGPT 后 activeClaudeSeatId 保留上次 Claude 席位，显式新开 Claude 队员时用它；
未指定 agent 的队员沿用 Codex。返回 Claude 时复用之前的 Claude 命令（没有则显式 Opus 5.5）。

默认接续看板是 `~/.agents/boards/agentdeck-captain-handoff.md`，不覆盖项目看板。
包含会话 id、任务状态和短回执，并指向私有 userData/chats 下完整对话。
回到应用时仍携带最近一次Relay的看板路径。

已接入 1.0.0 的 token-saver：`MainSession.checkpointForSeatSwitch(snapshot)`
与自动省上下文共用互斥状态。空闲 Claude 队长复用 `ARCHIVE_PROMPT`，只接受
完整、未中断且严格为「已存档」的回复；Relay 不发送 `/clear`。失败、取消或
五分钟超时都保留原队长。忙碌、额度耗尽、已退出或 Codex 队长直接使用本地
持久存档；每条路径都先保存完整对话和本地接续看板，再允许重开 PTY。

## 与 feat/quota-bar 的数据约定

读取同一个 `config.claudeSeats`，勿按显示名称索引账号。主进程可使用
`credentialLocation(seat, home)` 取得 metadataPath、credentialsPath、keychainService、
usagePath；不会读取或返回 token。现有全局 ccstatusline 缓存不能归属于两个席位。

每席位本地缓存为 `<configDir>/agentdeck-usage.json`，不建符号链接。被动捕获 Claude
原生 `/usage` 面板中的 5 小时/每周剩余与重置文本，记录产生它的列的席位。
上下文百分比、费用、共享 statusline 的百分比都不会写为额度。没有实际数据时
返回 null，额度区应显示未知；不能据此推断账号尚有额度或账号用尽。

```json
{
  "at": 1791000000000,
  "source": "Claude /usage",
  "windows": [
    { "key": "fiveHour", "remaining": 70, "resetText": "5pm (America/Los_Angeles)" },
    { "key": "weekly", "remaining": 20, "resetText": "Oct 8" }
  ]
}
```

主进程 `readUsage(seat, home)` 或页面的受限
`deck.claudeSeatUsage(seatId)` 返回经过白名单过滤的用量。
`deck.claudeSeats()` 返回配置目录、打码邮箱、登录凭据存在状态及 usagePath，
不返回账号原始邮箱或凭据。`claude-seat-changed` 事件的 detail 是 `{seatId}`，
供额度区立即刷新。1.0.0 的 quota-bar 已合入，同一配置的 CN/US 各显示独立一行（1.1.x 起额度从顶栏移到侧边栏底部）；无真实数据时显示未知。Relay 不主动发送用量查询。

## 验证边界

测试使用独立 userData、假 agent 和独立席位目录，不运行真实 AI 模型，也不读取
真实登录凭据。用户已完成 US 首次登录；真实双账号切换另用显式授权的独立原生 CLI smoke 验收，
与模拟账号 E2E 的结果分别记录。不得用自动测试代替用户登录。源码 E2E 不重启现役应用；本任务禁止打包/安装，因此
没有打包版或 Windows 实机验收。
