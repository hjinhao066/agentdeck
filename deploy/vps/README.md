# VPS 部署包：三端入口（块 D）

给 `https://agentdeck.18-139-28-180.sslip.io/` 加上按路径分流：`/` 是静态总台，`/mac/*` → VPS `127.0.0.1:43122`（Mac 隧道），`/win/*` → VPS `127.0.0.1:43123`（Windows 隧道）。方案见 `~/reports/agentdeck-three-ends/DESIGN.md`。

本目录最初是三端上线准备包；入口现已上线。日常静态发布使用正式 [部署与版本核对流程](../../docs/mobile-release.md)：`scripts/release.js` 自动执行，或 `npm run mobile:deploy -- --ref <已验收ref> --output <源码外目录>` 单独发布。旧 `deploy-hub.sh` 保留为底层手工工具，不具备版本构建/公网验收门禁；普通静态更新不调用 Caddy/sshd 安装脚本。

| 文件 | 作用 |
| --- | --- |
| `Caddyfile.agentdeck` | 站点段落（BEGIN/END 标记之间）。Caddy 2.6.x 语法 |
| `caddyfile_block.py` | 只替换 Caddyfile 里这一个站点；还原；取出现有入口口令（不打印） |
| `install-caddy-site.sh` | 备份 → 取口令 → 换段落 → `caddy validate` → reload。`--check` 只校验 |
| `rollback-caddy-site.sh` | 只还原这一段，其他站点的后续改动保留 |
| `sshd_agentdeck-tunnel-win.conf` | Windows 隧道账号的 sshd 受限片段 |
| `tunnel-account.sh` | 建/删账号 `agentdeck-tunnel-win`，写受限 authorized_keys，`sshd -t` 后才 reload；`verify` 只读复核 sshd 实际生效的限制 |
| `deploy-hub.sh` | 总台静态文件的原子发布 / 回滚 / 列表 |
| `lib.sh` | 脚本公用函数 |

所有脚本的路径和命令都能用环境变量覆盖（见 `lib.sh`），测试靠这个在临时目录里跑真脚本。

## 本地验证（不碰任何服务器）

```bash
# Caddy 2.6.2（与 VPS 同版本）。macOS arm64 例子；sha512 见发布页 caddy_2.6.2_checksums.txt
curl -fsSLO https://github.com/caddyserver/caddy/releases/download/v2.6.2/caddy_2.6.2_mac_arm64.tar.gz
tar xzf caddy_2.6.2_mac_arm64.tar.gz caddy
CADDY_BIN=$PWD/caddy node --test --test-concurrency=1 tests/vps-caddy.test.js tests/vps-scripts.test.js tests/vps-sshd.test.js
```

没有 `caddy` 时 Caddy 相关用例会明确跳过；没有 sshd 或无法启动非特权 sshd 时 sshd 用例跳过。Windows 上整组跳过（POSIX 脚本）。

测试做了什么：

- `vps-caddy`：本机起临时 Caddy（`admin off`，只监听回环）+ 两个假后端。验证无口令全 401；`/` 返回总台和 CSP 等安全头；`/mac/*`、`/win/*` 各转各的、前缀和查询串原样；Host / X-Forwarded-* 被覆盖、Authorization 被去掉；含糊路径（`..`、`//`）404；一台后端停掉或挂起时另一台和总台不受影响，停掉的返回 `502 {"offline":true}`；访问日志没有 URI、请求头、口令、cookie；用真 Chromium 验证两台的 `__Secure-agentdeck_mac`（Path=/mac/）和 `__Secure-agentdeck_win`（Path=/win/）只发给各自的前缀。另外：`GET /mac/api/info` 和 `GET /win/api/info`（免机器登录的探测，仍要入口口令）原样转发；前缀上每个响应的 CSP 被盖成 `default-src 'none'; sandbox`，并带 `nosniff`；HTML / JS / SVG / 没有 Content-Type / 给另一台种 cookie 的响应换成 `403 {"error":"blocked"}`；假后端在 `/win/` 下返回带脚本的 HTML 时，Chromium 里这份文档读不到 `/mac/api/snapshot`。再加：假后端在一个前缀下返回 3xx（301/302/303/307/308，带 `Location: /另一台/…`，JSON、HTML、无 Content-Type 都试）或 304 时，浏览器和总台的 `fetch`（默认跟随跳转）拿到 `403 {"error":"blocked"}`，没有 `Location`/`Refresh`，另一台后端一个请求都收不到；JSON 响应里的 `Location`、`Refresh`、`Clear-Site-Data`、`Content-Disposition`、`Link`、CORS 头、`Service-Worker-Allowed` 被删；`Set-Cookie` 只在 `POST <前缀>/login`、`POST <前缀>/logout` 放行且必须是本机 cookie 名，其他路径、其他方法、别台的 cookie 名、炸弹 cookie 都换成 blocked；登录/`api/info`/后端自己的 401 照常。
- `vps-sshd`：本机起真 OpenSSH（非特权），装上本包的片段和 authorized_keys 选项：Windows 密钥能占自己的端口并真能通流量；占不了 Mac 的端口；非回环、本地转发、执行命令、未登记密钥都被拒。片段和密钥选项两层各自单独也挡得住。
- `vps-scripts`：真脚本 + 真 `caddy validate` + 假系统命令，覆盖备份、只换一段、重复运行（含同一秒内连装连回滚：备份目录不复用、重复安装不产生托管段落的“备份”、默认回滚只选原始段落备份、遇到托管段落拒绝）、回滚（含期间别的站点被改）、校验失败/reload 失败自动还原、公钥校验、Mac 账号端口核验、create 中途失败（含 SIGTERM）撤回片段/authorized_keys/新建账号、`verify` 只读复核（Mac 账号被放宽或 Windows 片段没生效就失败）、root 生效设置前后对比、remove 先结束会话再删账号、总台发布与回滚（含远端登录 shell 不是 bash）。

## 上线步骤（块 E，需批准；在 VPS 上以 root 运行）

前置：Windows 公钥 `tunnel_ed25519.pub` 由块 C 产生，**只传 `.pub`**（脚本会拒绝私钥）。`scp` 到 VPS 的临时位置，用后删除。

0. **先核对 Mac 隧道账号的端口限制**（这个包不管理它，所以要先看实际生效的设置；只读，不改任何东西）
   ```bash
   ./tunnel-account.sh verify
   # 等价的手工检查：sshd -T -C user=agentdeck-tunnel,host=localhost,addr=127.0.0.1 | grep '^permitlisten '   # 必须正好是：permitlisten 127.0.0.1:43122
   ```
   **以后每次改动 sshd 配置（包括 Mac 账号的片段、`Include`、系统或 OpenSSH 升级之后）都再跑一次 `verify`**：有人放宽 Mac 账号的限制不会自己报警，只有 `verify` 会发现。`verify` 在 Windows 片段装好后还会核对它实际生效（`PermitListen`、`PermitOpen none` 等），失败时退出码非 0。
   `verify` 报错（比如 `permitlisten any`）就**先不要上线**：被攻陷的 Mac 可以在 Windows 掉线时抢占 43123，冒充 Windows，收走 `__Secure-agentdeck_win` cookie。先给 Mac 账号补上 sshd 层的限制（`Match User agentdeck-tunnel` 下加 `PermitListen 127.0.0.1:43122`，按现役配置补全，改完 `sshd -t` 再 reload），再继续。下面的 `tunnel-account.sh create` 会自己再核一遍，不符就拒绝、什么都不建。
1. **Windows 隧道账号**（不影响现有 Mac 隧道）
   ```bash
   ./tunnel-account.sh create --pubkey /root/win_tunnel.pub --dry-run   # 先看计划
   ./tunnel-account.sh create --pubkey /root/win_tunnel.pub
   ```
   脚本先核对 Mac 账号的端口限制（见第 0 步），再备份；装上片段后 `sshd -t` 通过、核对实际生效设置（`sshd -T -C user=agentdeck-tunnel-win`，含 `PermitOpen none`），并对比安装前后 `sshd -T -C user=root` 完全一致（片段的 `Match` 不能外溢到别的用户；VPS 的 OpenSSH 版本和开发机不同，所以要实测）后才 reload；任何一步不过都不 reload，并把这次运行改过的东西全部撤回：旧片段、`authorized_keys`（原来有就原样还原，没有就删掉）、以及这次新建的账号（原来就有的账号不会被删）。运行中途失败（命令出错、reload 失败、Ctrl-C/SIGTERM）同样撤回。reload 不会断开现有 SSH 会话。
2. **总台静态文件先上**（Caddy 切换后 `/` 就不再指向 Mac，总台要先就位）
   ```bash
   # 在 Mac 上，用你自己的管理员 SSH；TARGET 的父目录必须已存在
   deploy/vps/deploy-hub.sh push mobile-web/hub admin@<vps>:/srv
   ```
   总台不得用内联脚本/样式/事件属性（站点 CSP 会拦），`push` 会检查。
3. **校验 Caddy 段落（不改任何东西）**
   ```bash
   ./install-caddy-site.sh --check
   ```
   入口口令可以内联在站点里（`basicauth { … }`），也可以像现役那样 `import /etc/caddy/agentdeck-mobile.auth`（文件里只有那一条 `basicauth`）。两种都会被原样取出；`import` 带参数、通配符、片段名，或被引入的文件里除了 `basicauth` 还有别的指令，都拒绝，请手工建口令文件。旧的被引入文件不删，回滚后旧段落还会 `import` 它。
4. **写入并 reload**
   ```bash
   ./install-caddy-site.sh
   ```
   备份在 `/var/backups/agentdeck-three-ends/<UTC 时间>/`（root 专用；旧段落里有口令哈希；同一秒内再备份会得到 `…Z-01`，不会覆盖）。**只有第一次安装（被替换的是原始段落）才会备份**；之后重复运行时被替换的已经是本包托管的段落，不再新建备份，原始段落的备份原样保留，回滚才有东西可还原。入口口令哈希被原样放进 `/etc/caddy/agentdeck-basicauth.caddy`（root:caddy 0640），从不打印。
5. **reload 之后的检查**（口令请手输，别写进命令行）
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://agentdeck.18-139-28-180.sslip.io/            # 401
   curl -sS -o /dev/null -w '%{http_code}\n' https://agentdeck.18-139-28-180.sslip.io/win/api/snapshot   # 401
   curl -sS -i -u phone https://agentdeck.18-139-28-180.sslip.io/ | head -20                        # 200 + CSP
   curl -sS -u phone https://agentdeck.18-139-28-180.sslip.io/win/api/snapshot                      # {"offline":true}（隧道还没连时）
   ss -ltnp | grep -E ':4312[23] '                      # 只应绑定 127.0.0.1
   ! grep -q '"uri"' /var/log/caddy/agentdeck-access.log && echo "access log has no URI"
   ```

## 回滚

- **Caddy**：`./rollback-caddy-site.sh`（默认用最近一份**原始段落**的备份，也可传备份目录；备份里装的是本包托管段落时拒绝，不会再出现“回滚了其实没变”）。它只把 BEGIN/END 之间换回安装前的旧段落，不整份覆盖 Caddyfile，期间别的站点的改动保留；先 `caddy validate` 通过才写入并 reload。口令文件、日志文件、总台目录保留（无害）。
- **总台**：`deploy-hub.sh rollback admin@<vps>:/srv`（指回上一个版本）。
- **Windows 账号**：`./tunnel-account.sh remove`（删片段和账号，`sshd -t` 后 reload；Mac 账号不动）。
- **每台电脑的 `endpoint.json`**：把 `basePath` 和 `label` **一起删掉**。Mac 是 `~/.config/agentdeck-remote/endpoint.json` 里的 `/mac/` 和 `Mac`，Windows 是 `%USERPROFILE%\.config\agentdeck-remote\endpoint.json` 里的 `/win/` 和 `Windows`。只删其中一个不算回滚：留下 `basePath` 而 `label` 不合法时网页服务会拒绝启动，只留下 `label` 也还是半套配置。两个字段一起删除后，在那台电脑的设置页关掉再打开网页服务，才回到没有前缀的旧行为。
- 手工回滚：备份目录里有安装前的整份 `Caddyfile` 仅供对照，**不要整份覆盖**回去。

## 设计说明和已知限制

- **前缀不剥**：用 `handle`，不是 `handle_path`。AgentDeck 自己校验前缀，Caddy 配错也到不了别的机器的路由。
- **前缀响应一律盖头，非 JSON 直接拦**：`/mac/` 和 `/win/` 同源，cookie 的 Path 挡不住一台被攻陷。它在 `/win/` 下返回的 HTML 可以去读 `/mac/api/snapshot`，拿走 CSRF token 再给 Mac 派活。所以这两个前缀的每个响应都覆盖成 `Content-Security-Policy: default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`，外加 `X-Content-Type-Options: nosniff`（后端自己带的宽松 CSP 会被换掉）。只放行**状态码 2xx/4xx/5xx**且 `Content-Type` 恰好是 `application/json` 或 `application/json;…`（例如 `charset=utf-8`）的响应。HTML、JS、SVG、纯文本、没有 Content-Type、3xx、以及不合规的 `Set-Cookie`，都换成 `403 {"error":"blocked"}`，不把后端的页面交给浏览器。这不是隧道断开：断开仍然是 `502 {"offline":true}`。`GET <前缀>/api/info` 是 JSON，照常转发；入口 basicauth 仍然盖住它，机器侧的免登录由 AgentDeck 自己决定。
- **为什么要拦 3xx**：不限状态码的话，`/win/` 返回 `302/307 Location: /mac/…` 会原样到浏览器；总台的 `fetch` 默认跟随同源跳转，会带着 Mac 的 cookie 去读 Mac，307/308 还会把 POST 连同 Mac 的 CSRF token 重发到 Mac 接口，等于绕过跨机隔离。现在 3xx 一律 403；同时从响应里删掉 `Location`、`Refresh`、`Clear-Site-Data`（能清空整个源的 cookie）、`Content-Disposition`、`Link`、`Access-Control-Allow-Origin`、`Access-Control-Allow-Credentials`、`Service-Worker-Allowed`。总台（块 B）的 `fetch` 另外用 `redirect: 'error'`，两层各自挡。
- **304、101、SSE 会变成 403**：304 没有 Content-Type，101（WebSocket 升级）不是 JSON，`text/event-stream` 也不是；它们都不在放行范围里，一律 403。块 A/B 不要依赖条件请求（ETag/If-None-Match）、WebSocket 或 SSE，只用普通 JSON 的 GET/POST。
- **Set-Cookie 只在登录/登出放行**：每个前缀有两个 `reverse_proxy`：`POST <前缀>/login`、`POST <前缀>/logout` 一个，允许 `Set-Cookie`，且必须以本机 cookie 名开头（`__Secure-agentdeck_mac` / `__Secure-agentdeck_win`）；其余路径一个，响应里只要有 `Set-Cookie` 就 403。这样后端不能在 `api/snapshot` 之类的路径上夹带 cookie（例如 `__Secure-agentdeck_mac=junk; Path=/mac/api/` 让另一台的用户重名 cookie 被踢下线，或 4KB 的 `Path=/` 炸弹 cookie 让后端因请求头过长返回 431）。
- **Set-Cookie 匹配的限度（夹带仍可能发生，影响仅限可用性）**：Caddy 2.6 的响应头匹配是「这个头的任一值命中即可」，没法逐条核对。所以登录/登出那一个响应里如果既有本机 cookie、又夹带别的 `Set-Cookie`，夹带的那些挡不住。前提：某台机器已被攻陷，而且用户正在它上面登录或登出（其他路径带 `Set-Cookie` 一律 403）。能造成的后果只有可用性：同名同 Path 的 cookie（例如 `__Secure-agentdeck_mac=junk; Path=/mac/`）会直接覆盖真 cookie，用户被登出，要重新登录；多条 4KB 的 `Path=/` 炸弹 cookie 能让请求头超长，两台机器的前缀都返回 431，直到清掉该站点的 cookie。拿不到、也伪造不了另一台的有效 cookie：cookie 是 HttpOnly，服务端只认已登记的哈希，CSRF 绑定在凭据上。块 A 的「恰有一个合法就接受」只解决同名但 Path 不同、与真 cookie 并存的垃圾 cookie（不会因此被踢），解决不了覆盖和炸弹；那两种情形清除该站点的 cookie、重新登录即可恢复。
- **Caddy 自己的错误页**：401（要求入口口令）、404、502 没有 sandbox CSP，但响应体固定为空或 `{"offline":true}`，没有可执行内容。
- **含糊路径一律 404**：Caddy 按"清理后"的路径选后端，却把原始路径转给后端；`/mac/../win/…` 会因此被送到 Windows 那台。所以 Caddyfile 在 `route` 里先拦含 `./`、`../`、`//` 的路径（要用 `expression` 匹配原始路径，`path_regexp` 拦不住）。浏览器本来不会发这种路径。
- **大小写与编码**：Caddy 的路径匹配不区分大小写，`/MAC/…`、`/%6dac/…` 会原样转给 Mac；由 AgentDeck 自己的前缀校验（区分大小写、校验原始路径）拒绝。块 A 的校验必须基于原始路径。
- **`/mac`、`/win`（不带斜杠）**：落到总台静态页，返回 404；总台只使用带斜杠的前缀。
- **离线**：连不上后端 3 秒内失败，返回 `502 {"offline":true}`，仅限 Caddy 自己产生的 502/503/504。后端自己返回的状态码和响应体（包括 AgentDeck 的 JSON 401）原样透传。隧道半开（睡眠）时 Caddy 不设响应超时，由手机 8 秒超时判定"无响应"；sshd 的 ClientAlive 约 90 秒内清理死连接。
- **转发头**：`Authorization` 去掉；`Host` 固定为公网域名；`X-Forwarded-Proto` 固定 `https`；`X-Forwarded-For` 只含连接 IP；`Forwarded`、`X-Real-IP` 去掉；Caddy 自己会把 `X-Forwarded-Host` 设为客户端看到的 Host。`caddy validate` 会提示 `header_up X-Forwarded-For` 多余（Caddy 默认就这样），保留是为了即使全局配置了 `trusted_proxies` 也不会被伪造。
- **日志**：访问日志删除 `request>uri`、`request>headers`、`resp_headers`、`user_id`。2.6.2 实测：后端不可达（502）时 Caddy 的 stderr/journal 里没有 error 行，更没有 URI 或凭据；测试会断言这一点，升级 Caddy 后重跑 `vps-caddy` 复核。
- **校验用户**：脚本用 `caddy` 用户运行 `caddy validate`，避免 root 校验时创建 root 属主的日志文件，导致服务进程之后打不开。日志文件会预先建好并交给 `caddy`。
- **账号**：`agentdeck-tunnel-win` 用 `usermod -p '*'`（无口令但不是"锁定"），否则部分系统上 sshd 会拒绝公钥登录。端口 43123 只属于这个账号；Mac 账号只能用 43122——这一条靠 Mac 账号自己的 sshd 配置，不归本包管理，所以 `create` 前会用 `sshd -T -C user=agentdeck-tunnel` 核对 `permitlisten` 正好是 `127.0.0.1:43122`，不符就拒绝（第 0 步）。Windows 片段另有 `PermitOpen none`（连本地转发也没有）。`remove` 先删 `authorized_keys`、再 `pkill -u` 结束它的会话、再 `userdel`：隧道在线时直接 `userdel` 会失败，账号残留。
- **远端 shell**：`deploy-hub.sh` 给远端的命令用 POSIX 单引号引用，登录 shell 是 bash、dash、sh 都行；远端只要装有 `bash`（脚本里用 `bash -c` 执行）。
- **入口口令**：Caddy 的 `basicauth` 只存 bcrypt 哈希，`caddy hash-password` 默认 cost 14，登录后 Caddy 会缓存校验结果。
- **站点地址**：写死 `agentdeck.18-139-28-180.sslip.io`。现有站点段落如果用了多地址或非简单写法，`caddyfile_block.py` 会拒绝（exit 2）并提示手工处理，不会猜。
