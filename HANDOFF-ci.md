# HANDOFF CI E2E

- Worktree: `/Users/jinhao/agentdeck-ci-e2e`
- Branch: `fix/ci-e2e-flaky`，从 main `95b7192`（v1.1.6）拉出
- 远端：`origin/fix/ci-e2e-flaky`，本地与远端都在 `4ed27dd`
- 未开 PR，未合 main。不要打包、安装或重启这台机器上的现役 AgentDeck。
- 完成标准：`macos-14` 和 `windows-2022` 在**同一提交**上连续两次全绿。失败的那次不算，绿必须紧挨着。

## #81 失败的根因

Verify #81 打在 v1.1.5 `e63bd38`。两端 `npm test` 都过，都死在 `npm run test:e2e`。这不是 1.1.5 的新回归，#80 起就是这组端到端基线抖动；#82（v1.1.6 `95b7192`）同样双平台 E2E 失败，而且具体挂掉的用例每次还在换。

三处机制，后来在这条分支上对上了：

1. **Mac 预热读到了真钥匙串。** 测试用户目录下的席位预热仍走 `security find-generic-password`，CI 上没有那条钥匙串，`testWarmupRuns` 是空的。
2. **Windows ConPTY 把一行拆开。** 屏幕里留着 `\r`，软换行又没拼回去，短语被切成两截（例如 `deliv/ered`）。状态判断、回执文本和「已存档」都会跟着错。
3. **Windows 上 Playwright 的鼠标到不了侧栏拖拽。** 侧栏原来听 `mousedown` + `document` `mousemove`。Windows Electron 里这条 `mousemove` 不来，`body` 上的 `reordering` 一直是空的，拖拽停在原行。任务看板用的是 window 上的 pointer 事件，同一轮 Windows CI 里看板拖拽是过的。

另外两条是测试自己假设错了，不是产品坏了：CI 的 node 经常没有控制终端，用 `AGENTDECK_TERMINAL_ID` 去认「当前列」的私有凭据会失败；减弱动效时扫描线如果 `display: none`，Chromium 报的 `animationName` 是 `""` 不是 `"none"`。

## 红线

board CLI 只按当前控制终端的私有文件认凭据（`board-control/credentials/by-tty/`），绝不按 `AGENTDECK_TERMINAL_ID` 去挑另一列。过期的终端号不能选中别人的列，别的终端也不能用这份凭据。本进程没有这份私有文件时，走环境变量里的 token。`tests/board-credentials.test.js` 把「空 tty + 只有 TERMINAL_ID → token 为空」锁死了，不要为了让 CI 变绿而改掉。

## 已试过的每一轮

都在 `fix/ci-e2e-flaky`。本机单测在 `d63422e` 时是 `npm test` 543/543。`4ed27dd` 之后又跑过 `tests/chat-core.test.js` 35/35，以及下面点名的那些 e2e（单 worker，只在 Mac 上）。

### `3315bc0` 席位预热隔离，并拼回 Windows 屏幕

- 测试用户目录下的席位预热用 `test` 平台，不再碰 Mac 钥匙串。
- `dumpScreen` / `statusScreen` / 回复提取去掉 `\r`，并把软换行拼回一行。
- Windows 上简单路径不再套 POSIX 单引号。
- 假代理的 readline 把回显丢进空 sink，避免 ConPTY 把整段提示打进屏幕。

这一轮是开工时已经在远端的 WIP，没有单独的 Verify。

### `b91f47e` 不再依赖鼠标移动、动效名和终端号

- 侧栏拖拽改听 window 上的 pointer 事件。
- 减弱动效时扫描线不再 `display: none`，工作节点的 `::after` 用透明度 0，`animationName` 保持 `none`。
- 调用方不在该列 PTY 上时，只带 `AGENTDECK_TERMINAL_ID` 必须失败；接任队长用自己的 control token。

Verify [37244241337](https://github.com/hjinhao066/agentdeck/actions/runs/37244241337)：**失败**，大约 43 秒。macOS `npm test` 约 22 秒就挂了，9 个失败全是 `tests/status-light.test.js` 里 `ReferenceError: termLine is not defined`。抽 `statusScreen` 时把切片起点放在 `function statusScreen`，把上面的 `termLine` 切掉了。

### `d63422e` 单测切片把 `termLine` 带上

`tests/status-light.test.js` 两处切片改从 `function termLine` 开始。本机 `npm test` 543/543。

Verify [37244334189](https://github.com/hjinhao066/agentdeck/actions/runs/37244334189)：**失败**，约 32 分钟。两端 `npm test` 和 audit 都过，e2e 都没过，打包被跳过。

- macOS（job `111559112304`）只剩 `tests/e2e/crew-map.spec.js:75`：`c2003` 的 `offsetTop` 是 0，被审的 `c2001` 在 260。用例 206ms 就失败，不是超时。悬停会给 `.cm-node` 加 `transform`，这时 `offsetTop` 会变成 0。
- Windows（job `111559112420`）六条：
  1. `captain.spec.js:186` 拖队员出后台，人数仍是 1。
  2. `claude-seats.spec.js:222` 重载后 `fill('keep draft')`，输入框存在但不可见。
  3. `layout.spec.js:158` 点未聚焦列的「终端」按钮，被旁边 `col-1` 的 `agent-model-label`（Fake）挡住。CompactModel 那句已经过了。
  4. `mobile-web.spec.js:465` 重启后文字送达了，图片路径那条捕获数是 0。
  5. `perpetual-effort.spec.js:81` `switchSeat('us')` 返回 false。页面上的提示是「进度存档失败，原队长继续运行」。窄列把存档提示折开后，回复不再是单独的「已存档」，存档承诺被拒绝。
  6. `workspace.spec.js:167` 拖进文件夹失败。调试串仍是 `body:""`、`drop:[]`，pointer 改写之后拖拽还是没开始。同一轮里 `task-board-ui` 的 `page.mouse` 拖拽是过的。

日志在本机 `/tmp/mac-d634.log`、`/tmp/win-d634.log`。Windows 失败现场的 trace 在 `/tmp/win-traces/`（artifact `test-results-Windows`，run `37244334189`）。

这一轮里，#82 上见过的回执英文配额文案、`cursor-narrow-ready` 放弃、任务看板屏幕拆词，已经不在失败列表里。

### `4ed27dd` 窄列上的存档、拖拽和列头点击（正在跑 CI，还没有结果）

对着上面六条加 macOS 那一条改的，**还没有被 CI 证实**：

- `findPromptEcho` 把没有缩进的折行也算进已发送的提示，存档回复可以仍是「已存档」。单测在 `tests/chat-core.test.js`。
- 列头 `overflow: hidden`，标题和次要按钮允许缩到 0，型号徽章限制宽度，避免 5 列时按钮溢到下一列。
- 点在 `.chat` 里时，不再因为列还没聚焦就把列切回终端。Windows 重载后 Playwright 的 `fill` 会点一下输入框，旧逻辑把对话视图藏掉了。
- Windows 上这一列已经做过一轮且状态是 done/quota、屏幕又不是 PowerShell 提示时，下一条排队消息继续发。否则第一条文字送达后，页脚滚出 40 行窗口，图片那条会一直等。
- 简单路径多允许一个 `~`（`RUNNER~1` 这种短路径）。
- 侧栏 `touch-action: none`，按下时 `setPointerCapture`。`captain.spec.js` 和 `workspace.spec.js` 的拖拽改成在页面里派发 `PointerEvent`，不再靠 Playwright 的 `page.mouse`。
- 架构图改比 `getBoundingClientRect().top`，并先把鼠标移开。
- Windows 上假代理进入 raw mode，减轻 ConPTY 回显。

本机 Mac、单 worker，这十条过了：captain 前五条（含两处拖拽）、claude-seats 重载改名、crew-map 打开地图、layout 5 列、perpetual-effort Relay、workspace 拖进文件夹。另加 mobile-web 重启那条和 chat-core 35 条。Mac 复现不了 Windows 的 ConPTY 和鼠标路径。

## 当前这轮 CI

[Verify run 37247904645](https://github.com/hjinhao066/agentdeck/actions/runs/37247904645)，提交 `4ed27dd`，`workflow_dispatch`，2026-10-05T00:32:17Z 排队。

写这份交接时去查过：`status` 是 `in_progress`，`conclusion` 空。`verify (macos-14)` 和 `verify (windows-2022)` 都是 `in_progress`。不要再开一轮，等这一轮自己结束。

## 还剩哪些失败项

上一轮**已经跑完**的失败就是 `d63422e` 那 1+6 条（见上）。`4ed27dd` 是冲着它们去的，CI 还没出结果，所以这些项都还算没关：

| 平台 | 用例 | 上次现象 |
| --- | --- | --- |
| macOS | `crew-map.spec.js:75` | `c2003` 的 `offsetTop` 为 0 |
| Windows | `captain.spec.js:186` | 拖出后台后队员还在 |
| Windows | `claude-seats.spec.js:222` | 重载后对话输入框不可见 |
| Windows | `layout.spec.js:158` | 视图切换被邻列型号标签挡住 |
| Windows | `mobile-web.spec.js:465` | 重启后图片路径没有被捕获 |
| Windows | `perpetual-effort.spec.js:81` | Relay 存档失败，席位没换 |
| Windows | `workspace.spec.js:167` | 拖进文件夹没进入 `reordering` |

不要把本机 Mac 通过当成 Windows 已绿。

## 下一步建议

1. 只等 [37247904645](https://github.com/hjinhao066/agentdeck/actions/runs/37247904645)。两边都绿的话，对**同一个** `4ed27dd` 再跑一次 “Verify and package both platforms”，不要夹新提交。连续两次都绿才算做完。
2. 有一边红，就下那一边的 log / `test-results-*` artifact，只改还红的用例。凭据模型不要动。
3. 仍然不要开 PR、不要合 main、不要在这台机器上打包或重启 AgentDeck。
4. 本地要复跑时用单 worker，例如 `npx playwright test <spec> --workers=1`。清 `AGENTDECK_` 变量只能放在子进程里。
