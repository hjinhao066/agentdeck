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
  "perpetualCaptain": { "enabled": true, "threshold": 3 },
  "captainRelayCodex": { "name": "ChatGPT", "command": "codex --model gpt-6.1-sol --no-daemon -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox" }
}
```

CN是中国 Google 邮箱的 Claude 订阅，US是美国 Google 邮箱的订阅。
只在本机读取账号元数据，界面只接收打码邮箱，不接收凭据。本机已用真实 CLI 只读核对，CN 和 US 都已登录 Pro；账号元数据和凭据位置独立。
没有配置时按上述默认值迁移；每列的 `claudeSeatId` 与 `claudeConfigDir` 在首次启动时绑定并持久保存。以后改活动席位或席位设置只影响新会话；原队员、恢复会话和重开会话仍用原目录。Relay 只为替换后的队长重新绑定目录，不写登录凭据。


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
Relay 只重开队长列，不重启 AgentDeck。侧边栏 Claude 模型标签右侧的旗帜表示该会话实际绑定的 CN/US 席位，悬停或聚焦可查看账号名与目录；其他 provider 不显示 Claude 旗帜。

ChatGPT 接力仍使用 `isMain` 列和新建的专属控制 token；队长能力与 provider 无关。
启动 Codex 使用 `--no-daemon` 保留本列环境，丢失环境时只从本列私有能力文件恢复控制通道；绕过 shell 的 codex() 函数，避免重复追加 bypass 参数。`ledger/new/tell/receipts`
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

## 永动机自动轮换

默认开启，侧边栏齿轮 → 席位设置中用电源图标开关，5 小时剩余阈值默认
3%，可改为 0–100%。开关有 tooltip、无障碍名称、键盘焦点和按下状态。
Bark 密钥文件路径复用 `barkKeyFile`，只保存路径；每次切换发送普通 `active`
提醒，不带 critical 或音量。未配置/发送失败不撤销已完成的 Relay，界面告知原因。

- 当前 Claude 席位的**可信 5 小时**剩余 ≤ 阈值，或收到本席位真实用尽/限流报错，
  等队长回合结束、进入静默的 quota 等待后切到另一个已登录 Claude 席位。
  目标须可信剩余 > 阈值，或未知且没有用尽/低额度标记。
- 两个 Claude 都有真实用尽/限流证据或可信剩余 0 时切到 Codex GPT-6.1 Sol，通常 `high`。
  双低但仍有余额、未知或仅未登录，不直接视为“两席位用尽”。
  当前未处理失败回执，或同名未完任务有过失败时用 `xhigh`；旧的无关失败不升级。
  自动 Relay 固定这个模型和档位，手动 Relay 保留配置命令。
- 用尽/低额度的重置时间过去，或看到绑定本账号的恢复证据后，下一次队长空闲
  优先回到 Claude；工作中、确认提示上、发送中、有未发草稿或附件时不自动切。
- 每个目标席位/提供方 10 分钟内不重复进入，但首次 CN → US → Codex 可以连续推进。
  轮换记录及冷却时间存本机配置，重载不清掉防抖。手动选择仍可明确覆盖自动策略。

自动切换使用 Relay 本地持久存档，不再要求额度临界的模型多跑一次存档回合：
完整旧对话保存成功后，写 `agentdeck-captain-handoff.md` 的队长交接、最近指令、
任务和短回执，再重开**仅队长**的 PTY。重开前再次检查空闲与草稿。
新队长自动收到当前提示词及读取 `briefing`、看板交接、`ledger` 的接续指令，
并被要求先确认旧监听已退出，再重挂恰好一个后台 `receipts --wait --timeout 300`。
旧令牌撤销，新队长拿新控制令牌；队员及未读回执、提问、排队任务保持原样。
每次切换留下带目标、原因和时间的横幅与持久对话记录。
存档失败保留原队长，一分钟后才重试，不会每个 heartbeat 弹提示。

## 额度窗口预热

「设置 · 席位」提供默认开启的图标开关。主进程直接读取现有
`config.quotas['Claude:<seatId>'].sample` 中已验证账号和目录的 5 小时重置时间，
兼容已有的席位原生 `agentdeck-usage.json`；不另写 OAuth 查询器。
采样须 `accountBound: true`、当前账号 `accountKey`、对应 `configDir` 和原始 `at`。
重置后等待 60 秒，再每 30 秒检查。
CN/US 有存活的 Claude 会话、发现归属不明的外部 Claude 进程或无法完成进程扫描时，
都保守跳过。正常会话开始时只取消 AgentDeck 自己启动的预热进程。

预热使用该席位环境中的 `claude --print --model claude-sonnet-5-5 --effort low`，
关闭工具、自定义扩展、MCP 和会话持久化，独立临时工作目录，不创建列、不进入队员列表。
不读取密码或 OAuth token，不执行登录、登出、安装或更新命令。
每窗尝试状态在启动前原子写入用户数据目录 `quota-warmup-state.json`；成功封窗，
失败按 1、5、15 分钟退避，每窗最多 4 次，应用崩溃后的未完成请求也计入尝试次数。
请求被认证拒绝时标为「未登录」，本窗口不再重试，重新登录或出现新窗口后才恢复；
钥匙串里没有可用凭据的席位同样标「未登录」，不采样不预激活。
预热只管把 5 小时窗口用足，不看每周额度（每周剩多少都照常预激活）。

动手前先强制重采该席位的官方用量（同席位 5 分钟内至多一次）：新采样已显示 5 小时窗口在计时则不动作；
采样失败且原因未知（断网、接口错误）也不动作，不占尝试次数。仅两种失败视为可以动作：
接口明确没有 5 小时窗口，或闲置席位的访问令牌已过期（只有一次 Claude 请求能刷新它）。
请求成功后立刻再采样一次，面板据此离开旧数据并记录新窗口。

每次尝试在 `quota-warmup.log` 写席位、时间、结果和可信新重置时间。
原生 `rate_limit_event` 的 5 小时窗口及现有可信额度采样能更新下次重置时间；模型输出、七天窗口和
“现在加 5 小时”都不能作为依据。额度详情和 `quota` 命令显示「窗口已激活 ↻HH:MM」，
CLI 没有返回时间时显示未知。账号或配置目录变更会隔离之前的预热记录。

## 与 feat/quota-bar 的数据约定

读取同一个 `config.claudeSeats`，勿按显示名称索引账号。主进程可使用
`credentialLocation(seat, home)` 取得 metadataPath、credentialsPath、keychainService、
usagePath；不会读取或返回 token。现有全局 ccstatusline 缓存和第三方会话状态行不能归属于两个席位，屏幕百分比不进入配置席位的额度摘要。唯一例外是会话自己的状态行「5h剩余 X% · 7d剩余 Y%」：它由该 Claude 会话标准输入里的 `rate_limits` 计算，属于该会话登录的账号；AgentDeck 只在该列自己的状态行变化时，按该列绑定的席位目录写入 `agentdeck-usage.json`（来源「Claude 会话状态行」，带账号指纹和目录），状态行不含重置时间，所以重置显示未知；用尽报错和恢复时间仍按报错会话的绑定席位保留，并记录 `sourceColumnId` 供浮层和 quota 命令追溯；过了恢复时间自动清除。

每席位本地缓存为 `<configDir>/agentdeck-usage.json`，不建符号链接。被动捕获 Claude
原生 `/usage` 面板中的 5 小时/每周剩余与重置文本，记录产生它的列 id、固定目录及账号指纹。数字必须与缓存自身记录的账号和目录一致；当前登录元数据不能给旧缓存补归属。
上下文百分比、费用、共享 statusline 的百分比都不会写为额度。没有实际数据时
返回 null，额度摘要显示未知；不能据此推断未登录、账号尚有额度或账号用尽。缓存还必须携带 `accountKey`（账号 ID 的 SHA256 前 16 位；旧元数据无 ID 时使用邮箱指纹）和展开后的 `configDir`，与本席位当前元数据和目录一致才可使用。旧缓存缺少归属或账号已变更时不复制、不补猜归属，只等待本席位新数据；侧边栏额度区、悬停浮层和 `board-cli quota` 使用同一校验后的摘要。

```json
{
  "at": 1791000000000,
  "source": "Claude /usage",
  "accountKey": "<账号 ID 的 SHA256 前 16 位；旧元数据无 ID 时使用邮箱指纹>",
  "configDir": "/Users/example/.claude-us",
  "sourceColumnId": "producing-column-id",

  "windows": [
    { "key": "fiveHour", "remaining": 70, "resetText": "5pm (America/Los_Angeles)" },
    { "key": "weekly", "remaining": 20, "resetText": "Oct 8" }
  ]
}
```

主进程 `readUsage(seat, home)` 或页面的受限
`deck.claudeSeatUsage(seatId)` 返回经过白名单过滤的用量。
`deck.claudeSeats()` 返回配置目录、打码邮箱、不可逆账号指纹、登录凭据存在状态及 usagePath，
不返回账号原始邮箱或凭据。`claude-seat-changed` 事件的 detail 是 `{seatId}`，
供额度区立即刷新。1.0.0 的 quota-bar 已合入，同一配置的 CN/US 各显示独立一行（1.1.x 起额度从顶栏移到侧边栏底部）；无真实数据时显示未知。Relay 不主动发送用量查询。

### 1.1.1 独立额度刷新

应用打开时，主进程在启动及每 15 分钟各采一次配置中的席位；30 秒心跳检查到期，
不依赖席位有没有会话，也不碰队长/队员的输入、进程或 Relay 状态。启动查询期间显示未知。
取数是 Claude Code 原生 `/usage` 同源的只读
`GET https://api.anthropic.com/api/oauth/usage`；不启动 Claude、不调用模型、不登录、
不续 token，也不改现有凭据。macOS 在内存中读取该席位的独立 Keychain 项，
无项时读取其 `.credentials.json`；Windows 读取该席位自己的凭据文件。
过期、缺少 profile scope、缺登录、网络错误、429、非 200 或无实际窗口数据均显示未知；
不重试、不借另一个席位的登录、不从旧缓存补数字。某席位失败不阻止另一席位采样。

token 仅作为固定 Anthropic HTTPS 地址的认证头使用，不进命令行参数、日志、缓存、
renderer 或回执；不跟随重定向、不使用环境变量覆盖地址。请求绝对超时 8 秒、
响应上限 64 KB；Keychain 查询超时 2 秒并只结束自己的子进程。
本地成功记录只包含 `{at, source: 'Claude OAuth usage', windows, accountKey, configDir}`。
请求前后校验账号指纹和目录；途中换账号、账号缺失或目录变化即丢弃结果，不给旧数据补猜归属。
缓存读取和轮询内存样本也重新校验当前账号。失败不写成权威空样本，不清除已确认的用尽报错；
先前成功样本只在归属仍一致且未过期时可用。页面通过受限 quota IPC 取白名单字段，
分别显示两席位的 5h/7d 与成功采样时间，悬停/键盘焦点显示重置及完整时间。
成功服务端样本最多保留 30 分钟；过去的重置窗口显示无数据，不猜测重置后百分比。
启动时先保留各席位已有的真实缓存；首次和到期额度读取等待当前在途查询完成，
并发读取共用同一次 GET，不把尚未开始/尚未完成的查询标成失败。macOS 查询钥匙串
同时指定当前 OS 用户名和该席位的服务名，与 Claude Code 的查找方式一致。
该端点是 CLI 内部接口，非公开稳定 API；变动时安全退为未知。

## 验证边界

测试使用独立 userData、假 agent 和独立席位目录，不运行真实 AI 模型，也不读取
真实登录凭据。用户已完成 US 首次登录；真实双账号切换另用显式授权的独立原生 CLI smoke 验收，
与模拟账号 E2E 的结果分别记录。不得用自动测试代替用户登录。源码 E2E 不重启现役应用；本任务禁止打包/安装，因此
没有打包版或 Windows 实机验收。
