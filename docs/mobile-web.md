# 私人手机网页端

设置齿轮 →「手机网页端」→ 开启「本地网页服务」。默认关闭，始终只监听
`127.0.0.1:43121`，不开放局域网或公网端口。首次开启生成 256 位随机 token；
配置及登录设备哈希保存在此实例的 `config.json`（0600）。开关不需要重启应用。
端口冲突会提示错误，不扩大监听范围或更换端口。

## 手机远程访问

链路是手机 HTTPS → VPS Caddy → VPS `127.0.0.1:43122` → SSH 反向隧道 →
Mac `127.0.0.1:43121`。手机无需 VPN；Mac 主动连接 VPS，不修改 WireGuard 或网络路由。
使用独立子域名，把桌面设置的「私人 HTTPS 地址」设为该 origin（不能带子路径）。

先在 VPS 配置独立 Caddy 站点和 SSH 专用账号。Caddy 全站 `basicauth`（2.8+ 名为
`basic_auth`），只存 bcrypt 哈希；反代必须去掉 `Authorization`，覆盖 `Host` 为该域名、
`X-Forwarded-Proto` 为 `https`、`X-Forwarded-For` 为连接来源 IP，防止手机伪造 IP 绕过封禁。
TLS 由 Caddy 自动管理。访问日志删除 URI、请求头、响应头，不记录 token、设备 cookie 或口令。
token 只通过 JSON POST，禁止放在 URL 中。

SSH 专用账号只允许 remote forwarding，`PermitListen 127.0.0.1:43122`、`GatewayPorts no`、
`MaxSessions 0`，禁 PTY/agent/X11，服务器 ClientAlive 30 秒×3 清理睡眠留下的连接。
专用私钥只留在 Mac 的 `~/.config/agentdeck-remote/`（0700 目录，0600 文件），固定服务器 host key。
不要用拥有 VPS 管理权限的 key 作为常驻隧道身份。

Mac 的私有 `~/.config/agentdeck-remote/tunnel.json` 格式如下，只有路径及公开地址，
不包含登录 token 或明文密码：

```json
{
  "host": "your-vps.example",
  "user": "agentdeck-tunnel",
  "identityFile": "/absolute/private/path/tunnel_ed25519",
  "knownHostsFile": "/absolute/private/path/known_hosts",
  "localPort": 43121,
  "remotePort": 43122,
  "publicOrigin": "https://your-private-entry.example"
}
```

运行 `node scripts/install-mobile-tunnel.js`，只安装/加载专用 LaunchAgent，绝不启动或重启
AgentDeck。它用系统 SSH，登录 Mac 后自动启动、失败每约 10 秒重连，15 秒×3 客户端心跳。
安装器写 `endpoint.json`；将来 AgentDeck 自动读取此公开 origin，网页服务仍默认关闭。
可选的 `vps-access.json`（0600）含 `username`、`password`，只供可信桌面设置显示/复制
Caddy 入口口令，网页 API 从不读取或返回它。密钥及以上本地文件禁止提交仓库。

手机第一次使用有两步：打开私人地址，输入 Caddy 入口账号/口令；随后输入桌面设置中
复制的登录 token。浏览器记住设备 30 天，之后无需反复输入 token。
Caddy Basic 凭据由浏览器管理，重启浏览器后可能再问入口口令。
设置中的垃圾桶图标「吊销所有设备并更换登录 token」会立即拒绝全部旧设备、旧 token 和旧 CSRF。
手机的退出图标只吊销当前设备；吊销 Caddy 凭据需另行换 VPS 的 bcrypt 哈希。

开启带私人 origin 的安装版 AgentDeck 会注册 macOS 登录项，以便重启后登录 Mac 自动恢复
网页服务；系统若要求批准会在设置中提示。LaunchAgent 独立恢复 SSH 链路。
睡眠时无法执行任务或访问 Mac，唤醒联网后恢复；关机/FileVault 尚未登录时不可访问。
不阻止 Mac 睡眠、不修改电源策略、不需要手机安装 VPN。

## 登录与写入保护

远程设备 cookie 为 `__Host-agentdeck_mobile`，随机值，HttpOnly、Secure、SameSite=Strict、
Path=/，无 Domain；本地 HTTP 模式用 `agentdeck_mobile`（HttpOnly/Strict），远程模式一律 Secure。
只存随机 cookie 的 SHA-256 哈希与有效期，最多 20 台设备。每次登录随机生成，旧版确定性 cookie 不再有效。
所有资源及 API 鉴权，精确 Host/Origin/Fetch Metadata 检查；只信任固定 origin 经 loopback
代理传来的单个合法 IP，重复关键头会拒绝。Bearer token 只适用于本地客户端，错误显式凭据不能回退 cookie。

每 IP 10 分钟内 5 次登录失败封禁 15 分钟，全局 10 分钟 30 次失败暂停新登录 15 分钟，
返回 429 与 Retry-After；有效设备可以继续使用。限制状态留在服务内存，应用重启重置。
所有 POST 要精确 Origin；登录前依赖同源 JSON 与 Fetch Metadata，登录后的发送/退出
还需通过 `/api/auth` 获取的设备专属 CSRF token。服务重启后刷新会重新获取 CSRF；
上传完成时再次验证登录/CSRF/封禁，吊销或封禁不能被尚未结束的上传绕过。

手机页是聊天布局：顶部一条紧凑标题栏（队长名、状态点、模型），队长最近的对话占满中间、
最新在底部；输入框一行起步、随内容长高，在底部标签栏上方。
对话只有一来一回，规则与总台共用（页面加载 `/core.js`，即 `mobile-web/hub/core.js`）：右边是你的气泡（鲜绿色），
左边是带皇冠和「队长」名字的回复气泡；派活卡、回执、通知、工具步骤和终端残留都不显示，详见 `docs/mobile-hub.md`。
左侧侧边栏以桌面侧边栏为蓝本：队长入口行 → 按项目分组的队员会话（状态点，等你处理的排最前）
→ 底部固定的额度区（紧凑表格：表头 5h/7d 只写一次，每个账号一行两列，各列为剩余百分比、重置时间和细进度条；
某窗口缺失显示「—」，整行无数据显示「未知」；点行从底部升起详情面板，列出两个窗口的精确重置时间、状态、
打码账号、数据来源和采样时间，关闭图标、Esc 或点遮罩收起；行多时本区自己滚动）→ 版本号。标题栏左上角菜单图标、
屏幕左缘右滑可打开；遮罩、关闭图标、左滑或 Esc 关闭；打开时背后整页 inert，焦点移入并在关闭时归还。
额度与桌面侧边栏同一份数据（`QuotaCore.mobile`），手机端不另外采样：用尽显示红色与恢复时间，
数据过期或从未采样显示灰色「数据已旧/未知」，不会把旧数字当成可用；读取失败保留原行并标「未能更新」。
对话页标题旁的席位小标（如「CN 26%」，低于 10% 橙、用尽红、过期/未知灰）点开即跳到额度区，不增加标题栏高度。
底部标签栏保留：对话（队长）、会话、看板（只读）、更多（额度入口、深色模式开关、退出本设备）。
「会话」标签打开侧边栏（保留等你处理的数量角标），不再另设会话列表页，避免两处重复同一份列表；
看队员输出时「会话」标签高亮。标签栏贴底，背景延伸到
iOS 安全区最底部；输入框获得焦点且软键盘弹起时标签栏隐藏，输入框贴住键盘。
等你回复/确认的会话（停在确认、在问你）另以标题栏下一行提示条显示，点开看该队员输出；
从队员输出页点返回，回到打开它的那一页。
队员输出页的输入框把回复发给队长并注明「关于队员「名称」」，由队长转达，网页不直连队员。
队长回复做极简 Markdown（加粗、列表、行内代码、可横滚并带复制图标的代码块、http(s) 链接新窗口打开），
全部用 textContent 拼 DOM，不解析 HTML。输入框最多 6 行且不超过可视高度 30%。连不上桌面端时
显示「暂时连不上桌面端，正在自动重连…」，保留草稿、禁止发送，每 5 秒自动重试。
每 5 秒在页面可见时刷新；保留阅读位置和未发消息。复制/刷新/重新加载页面/发送/返回/添加图片/移除图片/重试上传采用图标、
tooltip、aria-label、键盘焦点、44px 点击面积；复制成功短暂变勾。深浅主题跟随系统并可切换。
静态文件打包在 `app.asar` 内，界面更新随安装包发布，需重启 AgentDeck 生效。
AgentDeck 更新后，点标题栏右上角「重新加载页面」图标（带框的单箭头，区别于双箭头的「刷新」数据图标）
整页重新加载即可拿到新页面；未发出的文字和已上传完成的图片先存进本标签页的 sessionStorage，
加载后放回输入框并清掉存档（仍在上传或上传失败的图片不随之保留）。
看板只读，输出不执行 HTML/终端控制序列，API 不提供任意 IPC、文件路径或队员控制
（对话接口只返回手机上传图片的 id，不返回桌面附件路径）。

消息只送当前队长，复用桌面 `sendWhenReady`，等待空闲、agent 前台并保护桌面未发草稿。
点发送后自己的气泡立刻出现并一直留着（发送中 → 已发出等队长接收 → 被桌面端的对话记录原位接替；失败的变红，可重发或放回输入框），
同样内容紧接着再发会先提示「刚才那条已发出」；规则与总台相同，见 [mobile-hub.md](mobile-hub.md)。
「已排队」表示本实例接受，待发消息在本地配置按序持久化，重启/单次等待超时后继续；
不是模型已完成。最多 20 条等待消息，单条 1–8000 字符。队长没有启动时拒绝发送。

## 发图片

输入框左侧的图片图标打开系统选择器（相册、拍照，可多选），也可以把图片粘贴进输入框；
一条消息最多 6 张，可以只发图不写字。图片选中后立即上传，输入框上方显示缩略图：上传中有进度条，
失败可点重试图标，每张可单独移除；全部传完才能发送。超过 800KB 或不是 JPEG/PNG/GIF/WebP 的图
（如 iPhone 的 HEIC）先在手机上用 canvas 转成最长边 1600 的 JPEG；浏览器解不了的格式会提示换图。

和桌面贴截图同一条路：图片落盘后，队长终端收到的是「图片路径 + 文字」，由 agent 自己读文件。
文件在 `userData/mobile-uploads/`（目录 0700、文件 0600）。服务启动和每次上传时清理超过 30 天的；
目录最多 200 张、共 200MB，超出时从最旧的开始删掉一天以前的图腾位置，还不够就拒绝上传（507），
手机上提示「空间满了，请明天再发图」。对话里自己发的图以固定大小的缩略图显示，点开看原图；
已被清理的旧图不再显示。键盘弹起时缩略图缩小（上传失败的那张保持原大小）、输入框最多 4 行，给对话区留位置。
移除和重试两个图标的点击区上下分开、互不重叠；点它们不会让输入框失去焦点。

上传接口的限制：走同一套登录 cookie、Origin、Fetch Metadata 和 CSRF 检查，读完请求体后再验一次；
请求体只收 `application/octet-stream` 原始字节，一次一张，最大 4MB；类型只看文件头
（JPEG/PNG/GIF/WebP），不看扩展名和 Content-Type，其余一律 415；文件名由服务端随机生成
（32 位十六进制 + 扩展名），客户端文件名不参与；读取和发送只接受这种 id，且必须是上传目录下的
普通文件，路径和符号链接都不认。回显同样要登录。服务的 10 秒请求超时没有放宽，
弱网下单张传不完会失败，需点重试。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/login` | `{token}`；同源首次登录，设设备 cookie |
| GET | `/api/auth` | `{authenticated, csrfToken}` |
| POST | `/logout` | 同源 + CSRF，吊销本设备 |
| GET | `/api/captain` | `{id,title,status,turns}` 最近对话 |
| GET | `/api/sessions` | `{sessions}` 活动会话 |
| GET | `/api/tasks` | `{cards}` 只读看板 |
| GET | `/api/output?id=…` | `{id,title,text}` 队员最近输出 |
| GET | `/api/quota` | `{rows,version,now}` 只读额度行：服务端按白名单重建字段，账号统一打码为 `h***@example.com`，带 `source` 来源说明（至多 60 字，如 `Claude OAuth usage`），不含配置目录、token 或原始明细 |
| POST | `/api/captain` | `{message, images?}` + CSRF，`images` 为至多 6 个上传 id，接受后 `{queued:true}` |
| POST | `/api/upload` | 原始图片字节 + CSRF，返回 `{id}` |
| GET | `/api/relay` | `{captainId,currentId,switching,seats,job,now}` 队长所在账号和可换的账号。`seats[]` 只有 `id,name,provider,account(已打码),current,selectable,reason,weekly,recoveryAt,cells`；`reason` 为 `current/login/onboarding/exhausted/low/unknown/''`，只有 `''` 和 `unknown` 可选。`job` 是手机发起的最近一次切换 `{id,status:switching|done|failed,fromId,fromName,targetId,targetName,startedAt,finishedAt,error}`，只在内存里，应用重启后为 `null` |
| POST | `/api/relay` | `{seatId, expectCurrent?}` + CSRF，发起手动切换（桌面端 Relay 的同一条路径）。立即返回 `{started:true,id}`，结果轮询 GET。桌面端拒绝时 409 `{started:false,error}`，`error` 是可直接给用户看的原因，队长不变 |
| GET | `/api/battery` | `{mode:auto/off,cap,capMin:1,capMax:10,onBattery,active,baseCap,effectiveCap,working?}` 这台电脑的电池模式：设置的模式和电池并发上限、现在是否电池供电、是否正在限制、实际生效的同时会话数。固定字段，没有路径和命令。旧版没有这个路由（404）；`/api/info` 的 `capabilities` 含 `battery` 表示可读可改 |
| POST | `/api/battery` | `{mode?, cap?}`（至少一个）+ CSRF，立即生效并写回配置；返回和 GET 一样的 JSON。`mode` 只能是 `auto` / `off`，`cap` 是 1–10 的整数；多余的键、范围外的值 400（`error` 是可直接给用户看的原因），什么都不改。走渲染进程 `MainSession.setBattery`，和桌面设置页、队长的 `settings battery` 是同一条路径 |
| GET | `/api/image?id=…` | 已登录设备读取自己上传的图片 |
| GET | `/api/todos` | `{items}` 随手记待办：未删除的只有 `id,text,done,doneAt,created,updated`，删除的只有 `{id,deleted,updated}`，见 [todo.md](todo.md) |
| POST | `/api/todos` | `{op:'add',text}` 或 `{op:'update',id,done,base?}` + CSRF，返回 `{item}`；只能记和勾，不能删、不能改字 |
| POST | `/api/file` | `{path, offset?}` + CSRF，只读预览一个文件或文件夹，见下文「文件和链接预览」。返回 JSON：Markdown/文本/代码的正文（最多 1MB）、图片和 PDF 的 base64 分片（每片 768KB，`next` 为下一片位置；图片上限 12MB，PDF 32MB）、文件夹列表，或只有文件名和大小（不能预览的类型、超限的文件）。拒绝 403 `{code:'denied'}`，不存在 404 `{code:'missing'}`。`api/info` 的 `capabilities` 带 `files` |

设置了前缀时，以上路径都相对于前缀（`/win/login`、`/win/api/auth` 等），内置页面和资源除外。

## 多台电脑（路径前缀）

一个手机入口可以同时接 Mac 和 Windows：VPS 的 Caddy 按路径把 `/mac/*`、`/win/*`
**不剥前缀**地转到各自隧道，AgentDeck 自己校验并去掉前缀。每台电脑独立保存 token、
设备 cookie、CSRF 密钥和登录封禁计数，互相不知道对方的凭据。

每台的 `~/.config/agentdeck-remote/endpoint.json`（隧道安装器写入，不含密钥）可带两项：

```json
{ "publicOrigin": "https://your-private-entry.example", "basePath": "/win/", "label": "Windows" }
```

- `basePath`：一段小写字母/数字/连字符，前后各一个 `/`，例如 `/mac/`、`/win/`。不写或写成空字符串＝旧行为，逐字节不变。
  每次在设置页开关网页服务时重新读取 `endpoint.json`，**以本次读到的内容为准**，不沿用上一次的值，不需要重启应用；
  它不写进 `config.json`。回滚：删掉（或清空）`basePath` 与 `label`，再在设置页关开一次网页服务即可回到旧模式，无需重启应用。
  只有「不写」和 `""` 算无前缀；`null`、`false`、`0`、数字、格式不合法的字符串一律让服务拒绝启动并在设置中提示，不会悄悄退回无前缀。
- `label`：手机总台里显示的名称，1–32 个字符，不能含控制符、双向控制符、零宽字符、行/段分隔符、引号（`"` `'` `` ` `` 及弯引号）和尖括号，
  首尾不能是空白；只在设置了 `basePath` 时生效。不写则按平台显示 Mac / Windows，其它平台显示固定的 `AgentDeck`（绝不回退成主机名）。
  无 `basePath` 时 `label` 被忽略：服务照常以旧模式启动（保证回滚时本机登录不断），仅在 `status.warning` 与日志里记一条警告。
  有 `basePath` 而 `label` 不合法时拒绝启动。
- 桌面设置页只读显示「手机入口中的名称：Windows · /win/」。

配置了 `basePath` 后：

- 来自公网 Host 的请求路径必须以前缀开头，否则 404（在任何鉴权之前，含带有效 Bearer 或 cookie 的请求）。
  本机 `127.0.0.1` 直连仍走无前缀的旧路径，前缀路径在直连上是 404。原有 Host、Origin、Fetch Metadata、
  单个 X-Forwarded-For 校验全部保留。
- 公网设备 cookie 改为 `__Secure-agentdeck_<前缀名>`（如 `__Secure-agentdeck_win`，Path=`/win/`），HttpOnly、Secure、
  SameSite=Strict、无 Domain。用 `__Secure-` 而不是 `__Host-`，因为后者要求 Path=/，无法按机器隔离。
  服务端只认已登记哈希，注入的同名 cookie 登不上。请求里带了多个同名 cookie 时，**恰有一个**是已登记且未过期的设备
  cookie 才接受（夹带的垃圾 cookie 不会把用户踢下线）；一个都没有、或有多个合法的（有歧义）一律按未登录处理。本机直连仍用旧 cookie。
- 未登录访问前缀下任何路径（包括 `/win/`）都返回 JSON 401，不返回内嵌登录页，也不提供旧的内置页面和静态资源
  （旧页面使用绝对路径，只适用于本机直连）。登录用 `POST /win/login`。
- 吊销（设置页垃圾桶）和手机退出只影响这一台。

新增接口（相对于前缀，例如 `/win/api/snapshot`；无前缀的直连也可用）：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `api/snapshot` | `{apiVersion:2, machine:{id,label,platform,hostname,appVersion}, now, csrfToken, captain:{id,title,status,turns}, sessions, boardVersion}`；一次返回手机总台每 5 秒需要的数据 |

| GET | `api/info` | **无需登录**的能力探测：`{app:'agentdeck', apiVersion:2, capabilities:['snapshot','basePath'], machine:{id,label,platform}}`；不含 hostname、精确版本号、token 或任何会话数据（需要版本号请在登录后读 `api/snapshot`）。只响应 GET，HEAD 不当探测处理 |

手机总台的判定：先请求 `api/info`。200＝新版（再请求 `api/snapshot`，401 即需要登录）；401 或 404＝旧版，
旧版对前缀路径一律回 401，所以应显示「需要升级 AgentDeck」而不是登录框。`api/info` 仍受前缀、Host、
Origin 和代理校验约束，不计入登录失败次数。

`machine.id` 是前缀名（`win`），无前缀时为 `local`。`boardVersion` 是看板文件名、大小、mtime 的 16 位哈希，
不含任何卡片内容，只在看板文件变化时改变，读取失败时为空字符串。`csrfToken` 与 `GET api/auth` 相同。

开启带私人 origin 的安装版 AgentDeck 会在 macOS 和 Windows 上注册登录项（Electron `openAtLogin`），
Windows 若被系统「启动」应用设置禁用，设置页会提示。测试用 `--test-user-data` 实例从不改登录项，也不读取 endpoint.json。

## 验证与回滚

`npm test`；`npm run test:e2e -- tests/e2e/mobile-web.spec.js`（仅相关测试）。
E2E 使用临时 `--test-user-data`、独立 tasks/chats、stand-in agent；不能读取真实会话作为截图夹具。
可设置 `AGENTDECK_MOBILE_SCREENSHOT_DIR` 输出模拟数据截图。
托管 shell 跑测试前必须清除继承的全部 `AGENTDECK_*`，避免触碰现役控制目录。

关闭桌面网页开关停止监听。删除隧道用：

```sh
launchctl bootout "gui/$(id -u)/com.jinhao.agentdeck-mobile-tunnel"
rm "$HOME/Library/LaunchAgents/com.jinhao.agentdeck-mobile-tunnel.plist"
```

VPS 改前必须备份 Caddyfile；回滚只移除新站点（若期间有其他站点更新不要覆盖整份旧配置），
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 成功后再 `systemctl reload caddy`。
可删除专用 SSH 账号/配置并 `sshd -t` 后 reload ssh。Mac 自动启动可在系统「登录项」中关闭。
所有部署和验证均不得停止、打包、安装、替换或重启现役 AgentDeck。

## 手机上切换队长的账号

出门在外、队长所在账号额度快用完时，可以在手机上把队长换到另一个账号，不用回电脑。这就是桌面端的手动 Relay：
`POST /api/relay` → 渲染进程 `ClaudeSeats.mobileSwitch` → `switchSeat`，先存档交接再换队长，所有检查不变。

- **接口此前不存在**：1.2.2 及更早只有 `captain:relay-notify` 这条桌面内部通道，没有 HTTP 接口；`/api/relay` 是这次新增的。
  VPS 入口按前缀原样转发 JSON 响应，不按路径放行，所以 `/mac/api/relay`、`/win/api/relay` 不需要改 Caddy。
- **哪些账号能选**（`PerpetualCaptainCore.manualChoices`）：队长在用的、没登录的、停在首次启动引导的、额度用尽的、剩余不高于永动机阈值的都不能选，
  各带原因和恢复时间；额度未知的可以选（与桌面菜单一致），确认时提醒。ChatGPT 额度用尽时不能选。
  手动切换不受永动机开关和 10 分钟回切冷却限制。服务端按白名单重建字段，带阻断原因或不认识原因的账号一律不可选；页面再校验一次。
- **二次确认**：选账号只进入确认页，点「确认切换」才发请求。请求带 `expectCurrent`（手机看到的当前账号），
  队长已被永动机或桌面换走时桌面端拒绝，不会按过期画面切错。
- **过程和结果**：桌面端立即应答，手机每 1.5 秒读一次 `GET /api/relay`，按 `job.id` 认自己的那次切换，显示「正在切换」（带已等时长）、
  「已换到…」或「没有换成」加原因。连不上时保持「正在切换」并说明；应用中途重启（`job` 丢失）时看队长现在所在账号：到了目标就算成功，否则失败。
  成功后立即重读会话和对话，页面自动接到新队长，不用刷新。关掉面板切换照常进行，结果显示在页面顶部提示行。
- **失败时原队长不变**：桌面输入框有未发送内容、存档失败、新队长启动失败、目标账号未登录等，`switchSeat` 在关掉旧终端之前就返回，
  原因经 `options.reason` 以大白话送到手机。
- **两台电脑分开切**：每台电脑只回答自己前缀下的 `api/relay`，用自己的设备 cookie 和 CSRF token；手机总台的面板从打开起绑定一台电脑，
  标题和确认语都带电脑名。
- **入口**：手机总台在每台电脑的总览卡和队长对话页顶部；单机页在侧边栏额度旁、「更多」里，以及队长账号 5 小时额度不高于 10% 时对话页顶部的提示条。
  旧版应用（接口 404）、离线或没有队长的电脑不显示入口。
- **界面用词**：页面上只说「账号」「切换队长」，不出现 Relay、seat、席位。

## 文件和链接预览

对话、回执、看板回执和「待我处理」里出现的本机路径（`~/`、`/Users/`、`/tmp/`、`C:\` 等开头）和网页链接都可以点。网页链接在新标签页打开；
文件在宽屏（≥1180×600，平板横放）右侧预览栏打开，其余（手机、平板竖放）在底部升起的面板里打开：半屏起步，点把手或上拖到全屏，下拉过三分之二或快速下滑关闭，
点遮罩或 Esc 也关闭，焦点回到原来的链接。支持 Markdown（与对话同一套渲染）、PDF（pdf.js 画在 canvas 上，按需画页、远处的页释放内存；
iOS 内嵌 PDF 只显示第一页，所以不用 iframe）、图片、纯文本和代码、文件夹列表；其他类型只显示文件名、大小和「不能预览」。复制路径、下载、重新读取、
放大、关闭都是图标按钮。

谁能读什么（`file-preview-core.js`，电脑端判定，网页不参与）：
- 只读。只允许：队长回复、队员回执、看板回执、「待我处理」里点名过的路径（手机上自己打的字不算），点名的文件夹至少在家目录下两层才连带里面的文件；
  或在 `~/reports`、`~/.agents/boards` 里。
- 先解析真实路径（`..`、符号链接都展开）再判断；点名一个符号链接不等于点名它指向的文件。系统目录一律不给。
- 密钥类一律拒绝，点名也不行：`.ssh`、`.gnupg`、`.aws` 等目录，`.agents-vault-pass`、`.env*`、`id_*`、`*.pem/*.key` 等，名字以 token/secret/credentials/auth 结尾的文件，
  `.claude*`、`.codex`、`.gemini`、`.config` 等目录里除文档和图片外的文件，`~/.config/agentdeck-remote`、AgentDeck 自己的数据目录，以及 shell 配置和历史。
- 未点名的路径不管存不存在都答「不在范围内」，不泄露是否存在。
- 回答只有 JSON（入口代理只放行 JSON），路径放在 POST 正文里，不进网址和日志。
