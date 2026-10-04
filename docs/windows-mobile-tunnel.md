# Windows 手机隧道

Windows 用自己的 SSH 账号 `agentdeck-tunnel-win` 和自己的 ed25519 密钥，把 VPS 的
`127.0.0.1:43123` 反代到本机 `127.0.0.1:43121`。Mac 仍用 `agentdeck-tunnel` 和 `43122`。
两边的密钥都不能去听对方的端口。

安装器只注册当前用户的登录计划任务，并写出守护脚本。它不启动这条隧道，也不启动、
关闭或重启 AgentDeck，不读取登录 token，不写 `vps-access.json`。

真正连上 VPS 留到上线步骤。在那之前用 `--dry-run` 即可检查参数。dry-run 不生成密钥、
不调用 `schtasks`、不连接 SSH。

## 准备

在 Windows 上手工放好下面两个文件，不要放进 git：

- `%USERPROFILE%\.config\agentdeck-remote\tunnel.json`
- `%USERPROFILE%\.config\agentdeck-remote\known_hosts`

`tunnel.json` 只有路径和公开地址，没有私钥、token 或入口口令：

```json
{
  "host": "18.139.28.180",
  "publicOrigin": "https://agentdeck.18-139-28-180.sslip.io",
  "windowsUser": "COMPUTER\\your-account",
  "directory": "C:\\Users\\YOURNAME\\.config\\agentdeck-remote"
}
```

省略时，账号固定为 `agentdeck-tunnel-win`，本地端口 `43121`，远端端口 `43123`，
`basePath` 为 `/win/`，`label` 为 `Windows`。写成 Mac 的账号、`43122`、`/mac/`
或 `binance-proxy` 密钥时，安装器直接拒绝。私钥路径只能是该目录下的
`tunnel_ed25519`，不能指向 `.ssh` 里的个人密钥。

`known_hosts` 只能有一行，预先钉死服务器 host key，不要用 `ssh-keyscan` 临时接受：

```text
18.139.28.180 ssh-ed25519 AAAA...
```

不要加注释、通配符或第二台主机。安装器不会改写这行。

## 在 macOS 上预览

```sh
node scripts/install-mobile-tunnel.js --platform win32 --dry-run \
  --config /path/to/tunnel.json --out /path/to/empty-dir
```

`--out` 里会有计划任务 XML、`agentdeck-tunnel.ps1`、`agentdeck-tunnel-hidden.vbs`、
`endpoint.json` 和 `plan.json`。标准输出里应能看到：

- `StrictHostKeyChecking=yes`
- `ExitOnForwardFailure=yes`
- `-R 127.0.0.1:43123:127.0.0.1:43121`

不带 `--dry-run` 时，macOS 上的 Windows 分支拒绝执行，也不会去装 Mac 的 LaunchAgent。

## 在 Windows 上安装

确认 `C:\Windows\System32\OpenSSH\ssh.exe` 存在后，在仓库目录执行：

```powershell
node .\scripts\install-mobile-tunnel.js
```

也可以显式传入 `--config`。安装器会：

1. 用 `whoami` 核对 `windowsUser` 就是当前账号。
2. 仅当 `tunnel_ed25519` 不存在时运行 `ssh-keygen -t ed25519`，空密码，注释为
   `agentdeck-tunnel-win`。已有文件不会覆盖。
3. 用 `icacls` 去掉私钥的继承，并删掉 SYSTEM、Administrators、Everyone、Users、
   Authenticated Users 这些 SID，只给当前用户读取 `(R)`。这是直接调用
   `icacls.exe`，不经过 PowerShell 通配。设完再跑一次不带参数的 `icacls` 把结果
   读回来；如果还看得到继承、别的用户或其他 SID，安装器报错退出，不注册计划任务。
   不靠 Node 的 `mode 0o600`，Windows 会忽略它。
4. 检查 `known_hosts` 和公钥行。公钥印到标准输出，交给 VPS 账号配置；不要提交它。
5. 写入 `endpoint.json`（`publicOrigin`、`basePath` `/win/`、`label` `Windows`）、
   守护脚本、隐藏启动器和任务 XML。带空格的路径写进
   `UserKnownHostsFile="路径"`，引号里面的反斜杠再加倍，避免 OpenSSH 按空格把路径拆开。
6. `schtasks /Create` 注册 `\AgentDeck-Mobile-Tunnel-Win`。没有 `/Run`。
   触发器是 `LogonTrigger`，而且 `StartWhenAvailable` 为 false：安装当时不会拉起，
   开机停在登录界面时也不会拉起，只有这个用户登录之后才会跑。上线验收时若要立刻
   连通，再手动 `schtasks /Run`。

`endpoint.json` 写好后，正在运行的 AgentDeck 不会自动重读。需要按现有设置页逻辑
关掉再打开网页服务，安装器不做这一步。

## 守护进程为什么不弹窗

计划任务的动作是 `C:\Windows\System32\wscript.exe`，启动器调用
`WScript.Shell.Run(..., 0, True)`。窗口样式 `0` 是隐藏，`True` 会一直等到守护进程
退出，任务计划程序才能把它看成正在运行。不要改成直接启动 `powershell.exe`：这台
机器的默认控制台宿主是 Windows Terminal，直接启动会弹出终端，关掉窗口还会把隧道
一起杀掉。

`agentdeck-tunnel.ps1` 用 PowerShell 5.1，在隐藏进程里循环运行 `ssh.exe`
（`CreateNoWindow`）。ssh 退出后先等 10 秒，之后每次加倍，最多 300 秒，包括正常退出，
避免空转。连上并保持约 30 秒以上后，下次等待回到 10 秒。认证失败、host key 对不上、
密钥权限或格式不对，直接把等待拉到 300 秒，不再快速重试。脚本里的路径操作都用
`-LiteralPath`；日志轮转用 .NET 的 `File.Move`，方括号不会被当成通配符。不要双击
这个 ps1。

`tunnel-error.log` 达到 64KB 就改名为 `tunnel-error.log.1` 再重新写，只留这一份旧日志。

任务设置：`LogonTrigger` 只在该用户登录之后拉起，不在安装时、也不在出现登录界面之前运行。
只在当前交互会话、`LeastPrivilege`、不保存密码、`Hidden`、执行时间 `PT0S`（不在 72 小时后被杀掉）、
`IgnoreNew`（不叠第二条隧道）、`WakeToRun` 为 false、`StartWhenAvailable` 为 false。
不改电源计划，也不阻止睡眠。监督进程自己崩溃时，任务按 1 分钟间隔重试。

另外加了 `PreferredAuthentications=publickey`，避免弹出密码框。不要加
`ClearAllForwardings=yes`：OpenSSH 会连命令行上的 `-R` 一起清掉，ssh 照样连上 VPS，
却不会监听 43123。用户 ssh 配置里如果多出转发到 43122，VPS 的 `PermitListen` 会拒绝，
`ExitOnForwardFailure=yes` 让这次连接直接退出。

## 卸载

预览：

```sh
node scripts/install-mobile-tunnel.js --platform win32 --uninstall --dry-run \
  --config /path/to/tunnel.json --out /path/to/empty-dir
```

`tunnel.json` 不必完整，也不必仍然有效。没有这个文件、文件损坏、或里面只剩无关字段时，
Windows 上的卸载会用 `%USERPROFILE%\.config\agentdeck-remote`。文件里如果写了 `directory`，
就用那一个目录。计划任务已经不存在时，卸载仍继续删文件，再执行一次也是成功。

在 Windows 上执行会结束并删除计划任务，然后删除这些生成文件：

- `agentdeck-tunnel.ps1`
- `agentdeck-tunnel-hidden.vbs`
- `AgentDeck-Mobile-Tunnel-Win.xml`
- `endpoint.json`

私钥、公钥、`known_hosts`、`tunnel.json` 和 `tunnel-error.log` 都保留。确认不再需要密钥时再手工删除，并用 `-LiteralPath`：

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\tunnel_ed25519"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\tunnel_ed25519.pub"
```

也可以不经过安装器，手工卸载：

```powershell
schtasks.exe /End /TN \AgentDeck-Mobile-Tunnel-Win
schtasks.exe /Delete /TN \AgentDeck-Mobile-Tunnel-Win /F
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\agentdeck-tunnel.ps1"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\agentdeck-tunnel-hidden.vbs"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\AgentDeck-Mobile-Tunnel-Win.xml"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\endpoint.json"
```

`schtasks /Delete` 报任务不存在时可以忽略。这些命令都不停止 AgentDeck。

## 日志

守护脚本把 ssh 的退出码和截断后的 stderr 追加到
`%USERPROFILE%\.config\agentdeck-remote\tunnel-error.log`。超过 64KB 就轮转。日志里不应出现私钥。

## Windows 真机上线前必测清单

下面几项这次只在 macOS 上做了静态检查和参数解析，没有连 Windows，也没有生成密钥。
在真机安装并让隧道连上 VPS 之前，要逐项做完：

1. `known_hosts` 路径含空格、中文和方括号时，`ssh` 实际拿到的 `UserKnownHostsFile` 仍是完整路径，不会按空格拆开。
2. `icacls` 回读只有当前用户的 `(R)`，没有继承，也没有 Administrators、SYSTEM、Everyone、Users。
3. 安装当时、以及开机后还停在登录界面时，计划任务都不运行。该用户登录后才由 `LogonTrigger` 拉起，桌面上没有终端窗口。
4. ssh 退出后等待从 10 秒递增到最多 300 秒。认证失败、host key 不符、密钥权限或格式错误不会快速连打。
5. `tunnel-error.log` 超过 64KB 后变成一份 `.1`，新日志重新开始。
6. 计划任务已经不存在时再卸载一次仍然成功，并删掉脚本和 `endpoint.json`。`tunnel.json` 缺失或损坏时也能卸到默认目录。私钥、公钥、`known_hosts`、`tunnel.json` 和日志还在。
7. 全程不启动、不关闭、不重启 AgentDeck。
8. 隧道真正连上 VPS 的 `127.0.0.1:43123` 仍留给上线步骤，安装器自己不会 `schtasks /Run`。
