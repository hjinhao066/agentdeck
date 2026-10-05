# HANDOFF CI E2E

- Worktree: `/Users/jinhao/agentdeck-ci-e2e`
- Branch: `fix/ci-e2e-flaky`，从 main `95b7192`（v1.1.6）拉出
- 远端：`origin/fix/ci-e2e-flaky`。产品代码停在 `4ed27dd`；其后的提交只更新本交接，没有新的修复。
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

1. 只等 [37247904645](https://github.com/hjinhao066/agentdeck/actions/runs/37247904645)。它测的是 `4ed27dd`，不是后面的交接提交。两边都绿的话，第二次用 `gh workflow run "Verify and package both platforms" --ref 4ed27dd`，让连续两次都落在这份产品代码上。不要为了交接提交再开一轮，那会把连续计数打断。
2. 有一边红，就下那一边的 log / `test-results-*` artifact，只改还红的用例。凭据模型不要动。
3. 仍然不要开 PR、不要合 main、不要在这台机器上打包或重启 AgentDeck。
4. 本地要复跑时用单 worker，例如 `npx playwright test <spec> --workers=1`。清 `AGENTDECK_` 变量只能放在子进程里。

## 第二位接手人的记录（run 37247904645 的结果，暂停于额度）

因 CN 席位额度要留给下一版，这件**暂停，不是放弃**。本节只记录，没有新的产品代码改动，产品代码仍停在 `4ed27dd`。

### 结果

[Verify run 37247904645](https://github.com/hjinhao066/agentdeck/actions/runs/37247904645)（提交 `4ed27dd`，约 31 分钟）：

- **macOS（job `111569361935`）：成功。** `npm test`、e2e、打包、打包后 e2e 全过。Mac 这边 `4ed27dd` 可以算过了，还差第二次连续绿（见「下一步」）。
- **Windows（job `111569361795`）：失败。** e2e 222 过、5 失败、4 跳过、23 没跑；打包未执行。

### Windows 还失败的 5 项

上一轮（`d634`）的 6 条里，`layout.spec.js:158`、`mobile-web.spec.js:465`、`perpetual-effort.spec.js:81` 这一轮没再失败；拖拽两条仍在，并多出两条新的。

| 用例 | 现象 |
| --- | --- |
| `captain.spec.js:194`（断言在 216 行） | 页内派发 pointer 事件把队员拖到「对话」区后，`.nav-crew` 里它的行仍在（期望 0，实际 1）。这条一失败，同一串行文件里后面 23 个用例都没跑，所以 captain.spec 后半可能还藏着别的 Windows 问题，现在看不到。 |
| `claude-seats.spec.js:204`（断言在 222 行） | `ChatUI.setMode(cn,'chat')` 后 `seat-captain` 列的 `.composer textarea` 一直 not visible，`fill` 超时。与上一轮同一位置，`4ed27dd` 的「点在 .chat 里不切回终端」没解决它。 |
| `deck-navigation.spec.js:6` | 整条 60 秒超时。上一轮没出现，**新出现**。 |
| `scroll-peek.spec.js:62`（断言在 73 行） | 开始时 `.terminal-new-content`（「有新内容 ↓」）本该隐藏却可见。上一轮没出现，**新出现**。 |
| `workspace.spec.js:167`（断言在 190 行） | 页内派发 pointer 事件拖「Session d」进文件夹「Work」后，d 仍在「对话」列表里，文件夹是空的（失败现场的页面快照可证）。 |

### 根因判断

- **拖拽两条（captain:216、workspace:190）：** 已排除 Playwright 的 `page.mouse` 路径（现在是页内派发 `PointerEvent`），事件也确实冒到了 window。`sidebar.js` 的 `dropTargetAt` 靠 `document.elementFromPoint(x, y)` 判落点，返回 null 或落在 `listEl` 之外就什么都不做。**我的判断（未证实）**：Windows CI 桌面分辨率小（GitHub Windows 跑机常见 1024×768），而 `main.js` 要 1600×950 的窗口，实际可视区比 Mac 小；落点坐标取自拖之前的 `boundingBox()`，若落点在可视区外或被别的元素盖住，`elementFromPoint` 就拿不到文件夹头 / 「对话」区。其余几条（composer 不可见、deck-navigation 超时、scroll-peek 的新内容按钮）也都是「依赖版面大小」的类型，和这个假设吻合。
- **小屏假设验证到哪一步：** 只在 Mac 上做了一次，且**没有得出结论**。我写了个预加载脚本（`/private/tmp/claude-501/-Users-jinhao/94077dcd-3031-4518-b941-336076a4c56e/scratchpad/shrink.js`，不在仓库里），在 `electron.launch` 之后用 `BrowserWindow.setSize` 缩窗口。`SHRINK=1024x700` 下 `workspace.spec.js -g "dragging a session"` **通过**（4.6 秒）。**我没有核实窗口真的缩到了 1024×700**；800×500 和 1024×400 两档被中断，没跑。所以「Mac 缩窗口复现不了」目前只是弱证据，不能据此排除小屏假设，也不能当作假设成立。
- 失败现场的 trace（artifact `test-results-Windows`，artifact id `11320276981`）只有测试器步骤，**没有浏览器内的 DOM / 视口信息**（Electron 的 page 没被 Playwright 录），所以从 trace 里读不出 Windows 的实际窗口尺寸。需要主动打出来。
- main 上的既有失败（perpetual-captain:124、quota-warmup:182/215）：这一轮 Mac、Windows 都没出现，跟本次问题无关，不用处理。

### 红线与没动的东西

- 没改凭据模型，没放宽断言，没加重试，没跳过测试。
- 没开 PR、没合 main、没打包安装、没碰现役 AgentDeck。

### 下一步

1. **先量，不要猜。** 在 Windows 上把真实窗口尺寸打出来。不要再用 30 分钟的全量工作流试：另起一个临时调试分支（例如 `ci-debug-win`，推送触发，不动 `verify.yml`），只在 `windows-2022` 上跑上面 5 个 spec，`npm ci` 之后直接 `npx playwright test <spec> --workers=1`，并在失败点前用 `page.evaluate` 打印 `innerWidth/innerHeight`、`screen.width/height`、`devicePixelRatio`、拖拽落点的 `elementFromPoint` 结果和目标元素的 `getBoundingClientRect`。几分钟一轮。调试分支用完要删，调试工作流不进 `fix/ci-e2e-flaky`。
2. 量出来的窗口尺寸如果确实小：回到 Mac，用同样尺寸真正缩窗口（先确认 `getBounds()` 生效）复现，再决定是产品版面要修（窄屏下列头、composer 可见性、落点）还是测试要先 `setSize` / 把落点滚进可视区。落点取自拖之前的 `boundingBox()`，要在拖之前先 `scrollIntoViewIfNeeded()` 并确认在可视区内——这是测试自己的前提，不算放宽断言。
3. `captain.spec.js:194` 先修好之前，后面那 23 个用例在 Windows 上是黑盒；修好后可能冒出新的失败，要预留一轮。
4. 全部修好后，按「完成标准」：`macos-14` 和 `windows-2022` 在**同一提交**上连续两次全绿，才算数。Mac 已有一次绿（`4ed27dd`），但产品代码一改，Mac 也要重来。
