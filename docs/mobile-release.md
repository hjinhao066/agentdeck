# 手机总台部署与版本核对

`mobile-web/hub/` 是独立交付物：VPS `/srv/agentdeck-hub` 的五个静态文件不会随着 Mac/Windows 安装应用而更新。`/mac/*` 与 `/win/*` 的 JSON API、登录和退出由各自现役应用经 SSH 反向隧道实时提供；不属于静态部署。当前 Caddy 用 VPS 回环 43122/43123，静态更新不用改 Caddy 或隧道。同 VPS 的 Hermes 有 WireGuard 路由，与这两个前缀不同。

## 发版门禁

现有 `node scripts/release.js …` 在桌面包校验完成后自动执行 `scripts/mobile-release.js deploy`。普通发版与 `--prepared` 均不可跳过；缓存命中仍执行。`--dry-run` 只列计划。

1. 从干净 checkout 的已提交 Git blob 构建五个文件，校验 CSP，给生成的 `index.html` 嵌入 `agentdeck-version`、`agentdeck-commit`、`agentdeck-builtAt` meta；JS/CSS URL 带提交号，避免刷新后复用旧资源。源码与页面样式不改。
2. 写出 `release.json`，记录完整版本、40 位提交号、UTC 构建时间和五文件 SHA256。与发版版本/提交不一致时在上传前停止。
3. SSH 管理身份经 `sudo -n` 操作 `/srv`；远端目录锁防并发部署。记录原始符号链接作为回滚点（相对/绝对链接均保留原文）。已有总台不存在或不是链接则停止，不盲目覆盖目录。
4. tar 上传到唯一 release 目录，原子切链接。从 **`https://agentdeck.18-139-28-180.sslip.io/` 公网入口**读取真实 HTML、五文件与 manifest，精确核对版本/提交/时间/字节及 `Cache-Control: no-store`；每次读取带随机查询参数、禁重定向、10 秒超时。认证只过 Caddy Basic，不请求电脑登录 token。
5. 上传/公网核对最多 3 次，共用同一个候选 release 和部署前回滚点；失败恢复原链接，核对 readlink，再释放自己的锁并退出非零。报告区分 `rollback=restored` 与 `rollback=failed`；后者需按报告的 `previous` 人工恢复，不自动无限重试。SSH 操作各有 60 秒上限。取消时也尝试恢复；断网/进程强杀不能保证远端恢复，不能把失败回执当成功。

`mobile-deploy-result.json` 记录尝试次数、旧链接、线上元信息、结果与回滚状态；`mobile-deploy.log` 记录命令结果。发版报告手机步骤缺失/未部署/失败/线上不符一律 🔴，整个 release 非零退出。每次运行先移除旧成功回执，避免空命令复用历史结果。旧 release 不自动删除，保证回滚点不被保留策略清走；可在验收后手工清理非现役且不再需要的 release。

部署可独立执行（输出目录须在源码目录外）：

```sh
npm run mobile:deploy -- --output /absolute/report-directory
# 从任意已验收分支或完整提交直接发布静态页面，不 checkout/merge/bump、不打包应用：
npm run mobile:deploy -- --ref origin/feat/reviewed-phone-ui --output /absolute/unique-report-directory
# 一条命令恢复该次部署前的精确版本，并从公网核对旧页面：
npm run mobile:rollback -- --receipt /absolute/unique-report-directory/mobile-deploy-result.json
```

`--ref` 先解析并固定提交，HTML/JS/CSS 和 package 版本均取该提交的 Git blob；不会把当前未提交文件发布出去，也不改变工作区。先 `git fetch origin` 再传已验收 ref；每次独立部署选择新报告目录，保留可用回执。回滚命令读取回执的目标/旧链接/旧页 SHA256，只有当前线上链接仍是这份回执的候选版本才恢复，防旧回执覆盖后来上线的版本；公网核对最多 3 次。手机浏览器重新加载一次会重新拿 `no-store` HTML 和带新提交参数的 JS/CSS；不新增 service worker。已打开的旧页面要浏览器重新加载才切换（总台页内的刷新图标只更新 API 数据）。

## 单独上线的边界和兼容性

| 改动 | 是否可只发静态总台 |
| --- | --- |
| `mobile-web/hub/index.html`、`style.css` 的布局/字号/颜色；`app.js/core.js` 用现有字段分组、折叠、复制、渲染；`machines.json` 现有电脑配置 | 可以，只需静态部署和手机刷新；仍需验收旧应用契约 |
| 在总台展示可选新字段/新只读接口，缺失时保留旧行为或隐藏该模块 | 可先单发兼容页面；新能力要等应用提供数据才能使用 |
| `mobile-web.js`、`main.js` 或 preload/IPC 新增 API/字段、派活能力、认证/CSRF/上传/同步协议 | 必须更新对应电脑的应用；单发页面不能使本机接口出现 |
| `mobile-web/` 单机直连页（hub 目录之外） | 由安装应用实时提供，不在这次 VPS 五文件中；要应用更新 |
| Caddy 路由、认证配置、隧道账号/端口 | 属基础设施变更，不属于静态部署脚本 |

总台兼容基线是三端 v2 契约（如 1.1.7）：`api/info` 探测、`api/snapshot` 的 machine/sessions、设备登录与 CSRF。更老应用的 info=401/404 显示「需要升级」且禁发，不白屏。可选时间/boardVersion、machine hostname/appVersion、会话 model/回执信息、turn kind/images/steps 缺失仍能导航和阅读旧 user/reply；quota=404 不显示额度，tasks 缺 cards 或404显示空看板。缺 csrfToken 或 captain 禁止发送并保留草稿，不改发另一台。新增静态特性必须延续这套缺字段回退；不能把需要新版 API 的强依赖当作“只改网页”。兼容 E2E 将这些缺字段组合和404作为回归场景，不需要改现有页面源码。

静态单独上线可以保留同一应用版本号，**提交号/构建时间才标识新的网页产物**。默认 `mobile:check` 比较安装应用版本，不要求网页与应用 Git SHA 相同；若特意发布更高 package 版本的兼容网页，默认检查会报告版本差异。可用 `--version` 和 `--commit` 明确核对该次独立上线。

## 随时只读核对

```sh
npm run mobile:check
# 发布操作者也可明确核对候选版本/提交：
npm run mobile:check -- --version 1.3.0 --commit <完整40位提交号>
```

默认与本机安装版比较：macOS 读取 `/Applications/AgentDeck.app/Contents/Info.plist`，Windows 读取 `%LOCALAPPDATA%/Programs/agentdeck/resources/app.asar` 的 package.json。这个值是安装目录的版本；如人为替换安装目录却没重启，需操作者核对运行进程。不会拿当前源码 package.json 冒充现役版本。旧页面没有 stamp、版本不符、认证/网络失败均红色输出并退出 1。可将这个现成命令接入零模型健康检查；本改动不新增定时任务。

## 现有私有配置

- 管理 key：`~/portfolio-tracker/binance-proxy.pem`，身份 `ubuntu@18-139-28-180.sslip.io`。需要 `sudo -n`，不用受限的隧道 key。
- 已信任 host key：默认 `~/.ssh/known_hosts`，`HostKeyAlias=18.139.28.180`，`StrictHostKeyChecking=yes`；网络连接使用 sslip 主机名。
- Basic：`~/.config/agentdeck-remote/vps-access.json` 的 `username,password`，仅在进程内用于 HTTP 头，不放命令行、报告或仓库。坏 JSON 只报固定错误，不回显原文。
- 可选本机覆盖文件：`~/.config/agentdeck-remote/mobile-deploy.json`；键为 `target,origin,identityFile,authFile,hostKeyAlias`。不需要创建即可使用当前环境。公网 origin 只接受上述 sslip HTTPS 入口；测试可用 loopback HTTP。

旧 `deploy/vps/deploy-hub.sh` 是手工底层工具，不是正式发版门禁：没有版本构建和公网验收；其回滚按目录时间取前一份，不能代替新事务保存的精确链接。新发版只用 `mobile-release.js`。

## 验证边界

单测用临时 Git 仓库、假的远端目录和 loopback HTTP 服务执行真实 tar/原子链接切换，覆盖版本不符、旧页无 stamp、资源不符、重定向、缓存头错误、上传失败、三次停止、精确回滚与发版门禁。相关 E2E 为 `mobile-hub.spec.js` / `mobile-web.spec.js` / `mobile-release.spec.js`，持全机测试锁、单 worker；最后一份将生成产物部署到假远端，以真实浏览器验证重新加载一次执行新提交的 JS，回滚后恢复旧提交。本次实现没有对真实 VPS 跑过新部署脚本，首次真实部署演练留给下一次发版。
