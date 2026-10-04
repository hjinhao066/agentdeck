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

手机页是聊天布局：顶部一条紧凑标题栏（队长名、状态点、模型），队长最近 20 轮对话占满中间、
最新在底部；底部输入框一行起步、随内容长高，贴住底部并随 iOS 安全区和软键盘上移。
左上菜单抽屉列出队长与各队员（状态点、最近回执）、只读任务看板、主题切换和退出本设备。
等你回复/确认的会话（停在确认、在问你）以标题栏下一行提示条显示，点开看该队员输出。
队员输出页的输入框把回复发给队长并注明「关于队员「名称」」，由队长转达，网页不直连队员。
每 5 秒在页面可见时刷新；保留阅读位置和未发消息。复制/刷新/发送/菜单/关闭/返回/退出采用图标、
tooltip、aria-label、键盘焦点、44px 点击面积；复制成功短暂变勾。深浅主题跟随系统并可切换。
静态文件打包在 `app.asar` 内，界面更新随安装包发布，需重启 AgentDeck 生效。
看板只读，输出不执行 HTML/终端控制序列，API 不提供任意 IPC、文件路径或队员控制。

消息只送当前队长，复用桌面 `sendWhenReady`，等待空闲、agent 前台并保护桌面未发草稿。
「已排队」表示本实例接受，待发消息在本地配置按序持久化，重启/单次等待超时后继续；
不是模型已完成。最多 20 条等待消息，单条 1–8000 字符。队长没有启动时拒绝发送。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/login` | `{token}`；同源首次登录，设设备 cookie |
| GET | `/api/auth` | `{authenticated, csrfToken}` |
| POST | `/logout` | 同源 + CSRF，吊销本设备 |
| GET | `/api/captain` | `{id,title,status,turns}` 最近对话 |
| GET | `/api/sessions` | `{sessions}` 活动会话 |
| GET | `/api/tasks` | `{cards}` 只读看板 |
| GET | `/api/output?id=…` | `{id,title,text}` 队员最近输出 |
| POST | `/api/captain` | `{message}` + CSRF，接受后 `{queued:true}` |

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
