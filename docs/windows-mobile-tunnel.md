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
   `icacls.exe`，不经过 PowerShell 通配。
4. 检查 `known_hosts` 和公钥行。公钥印到标准输出，交给 VPS 账号配置；不要提交它。
5. 写入 `endpoint.json`（`publicOrigin`、`basePath` `/win/`、`label` `Windows`）、
   守护脚本、隐藏启动器和任务 XML。
6. `schtasks /Create` 注册 `\AgentDeck-Mobile-Tunnel-Win`。没有 `/Run`，所以现在
   不会连上 VPS。下次登录才启动；上线验收时再手动 `schtasks /Run`。

`endpoint.json` 写好后，正在运行的 AgentDeck 不会自动重读。需要按现有设置页逻辑
关掉再打开网页服务，安装器不做这一步。

## 守护进程为什么不弹窗

计划任务的动作是 `C:\Windows\System32\wscript.exe`，启动器调用
`WScript.Shell.Run(..., 0, True)`。窗口样式 `0` 是隐藏，`True` 会一直等到守护进程
退出，任务计划程序才能把它看成正在运行。不要改成直接启动 `powershell.exe`：这台
机器的默认控制台宿主是 Windows Terminal，直接启动会弹出终端，关掉窗口还会把隧道
一起杀掉。

`agentdeck-tunnel.ps1` 用 PowerShell 5.1，在隐藏进程里循环运行 `ssh.exe`
（`CreateNoWindow`）。ssh 一退出就 `Start-Sleep -Seconds 10` 再连，包括正常退出，
避免空转。脚本里的路径操作都用 `-LiteralPath`，方括号不会被当成通配符。不要双击
这个 ps1。

任务设置：登录触发、只在当前交互会话、`LeastPrivilege`、不保存密码、`Hidden`、
执行时间 `PT0S`（不在 72 小时后被杀掉）、`IgnoreNew`（不叠第二条隧道）、
`WakeToRun` 为 false。不改电源计划，也不阻止睡眠。监督进程自己崩溃时，任务按
1 分钟间隔重试；ssh 断开由脚本里的 10 秒退避处理。

另外加了 `ClearAllForwardings=yes` 和 `PreferredAuthentications=publickey`，避免
用户的 ssh 配置再转发到 43122，或弹出密码框。

## 卸载

预览：

```sh
node scripts/install-mobile-tunnel.js --platform win32 --uninstall --dry-run \
  --config /path/to/tunnel.json --out /path/to/empty-dir
```

在 Windows 上执行会结束并删除计划任务，然后只删除这三个生成文件：

- `agentdeck-tunnel.ps1`
- `agentdeck-tunnel-hidden.vbs`
- `AgentDeck-Mobile-Tunnel-Win.xml`

私钥、公钥、`known_hosts`、`tunnel.json`、`endpoint.json` 和 `tunnel-error.log`
都保留。确认不再需要密钥时再手工删除，并用 `-LiteralPath`：

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\tunnel_ed25519"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\tunnel_ed25519.pub"
```

没有 `tunnel.json` 时可以手工卸载：

```powershell
schtasks.exe /End /TN \AgentDeck-Mobile-Tunnel-Win
schtasks.exe /Delete /TN \AgentDeck-Mobile-Tunnel-Win /F
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\agentdeck-tunnel.ps1"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\agentdeck-tunnel-hidden.vbs"
Remove-Item -LiteralPath "$env:USERPROFILE\.config\agentdeck-remote\AgentDeck-Mobile-Tunnel-Win.xml"
```

这些命令都不停止 AgentDeck。

## 日志

守护脚本把 ssh 的退出码和截断后的 stderr 追加到
`%USERPROFILE%\.config\agentdeck-remote\tunnel-error.log`。日志里不应出现私钥。
