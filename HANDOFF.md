# HANDOFF — 对话页重设计（feat/chat-redesign）

已 rebase 到 origin/main `2d58205`（v1.1.3）。worktree `~/agentdeck-chat-redesign`（node_modules 是指向 `~/agentdeck/node_modules` 的符号链接，不要提交）。
设计说明：`/Users/jinhao/reports/agentdeck-chat-redesign/DESIGN.md`。参考截图列表：同目录 `reference-screenshots.txt`。

## 做到哪
已完成，并且自己写的 spec 全部通过：
- 用户消息靠右显示为圆角气泡，最大宽度 85%；图片缩略图在气泡上方；复制、编辑图标在悬停或聚焦时出现。agent 回复靠左，没有气泡，用 Markdown 渲染。代码块带语言标签和复制图标，引用块带左侧竖线。
- 每轮顶部居中显示时间：今天/昨天/周五 21:46/9月1日/跨年带年份（`ChatCore.turnTimeLabel`）。
- 过程折叠行：
  - 有完成时间：「处理了 18分43秒 ›」
  - 没有完成时间、有过程：「N 条过程消息 ›」
  - 老数据：「过程 ›」，展开后提示没有保存，并带终端图标按钮。
  - 超过 8 条时，更早的部分折叠成「前面 N 条消息 ›」。
  - 进行中的一轮显示「处理中 Xs」，每次刷新时更新。
- 网页卡片：地球图标、域名和路径、「打开方式 ⌄」菜单（侧栏打开 / 系统浏览器 / 复制链接，支持 Esc 和方向键）。改动文件卡片：「改了 N 个文件 +A −D」，点开列出文件，点文件在侧栏预览。
- 回复下方的图标按钮：复制（成功后变勾）、分享（把问和答复制成 Markdown）、在终端查看。都带 title、aria-label、28px 点击区域和 :focus-visible 焦点环。
- 修了一个原有 bug：`linkify` 之前没按位置排序，同一行里出现 URL 时，URL 前面的文件路径不会变成链接。
- 深浅主题新增的变量：`--bubble-bg --code-bg --card-bg --diff-add --diff-del`。

## 设计决定（队长已批准）
- 每轮新增**可选**字段 `end`（完成时间 ms）和 `steps`（过程摘要，≤40 行、≤8KB UTF-8，保留最新的部分）。由 `normalizeChat` 校验和截断，老数据和老版本都能照常读。
- 改动文件和网址都在渲染时从 steps 和 reply 推出来，不另外存。
- 文案用中文，和应用其它界面保持一致。截图里的 Worked for 对应「处理了」，Open in 对应「打开方式」。
- 输入框（composer）的代码没动。导出列表和 v 对象的写法已经调整过，与 `origin/fix/draft-sync` 的 `git merge-tree` 没有冲突。

## 改了哪些文件
- `chat-core.js`：turnLines / extractSteps / capSteps / editsFromSteps / fmtDuration / turnTimeLabel，normalizeChat 加了 end/steps，代码块加了 data-lang。
- `chat-ui.js`：turnRows / assistantRow / processRow / webCard / editCard / decorateCode / copyButton，finalizeTurn 和 onLeave 会记录 steps 和 end。
- `style.css`：对话轮次相关的整段样式和主题变量。
- `renderer.js`：新增 ICONS.share 和 ICONS.diff。
- 测试：`tests/chat-core.test.js` 新增 6 项，新建 `tests/e2e/chat-redesign.spec.js`，`fake-agent.js` 加了「work with tools」模式。

## 测试（在 AgentDeck 托管终端里，必须在子进程里清掉 AGENTDECK_* 变量）
```bash
cat > /tmp/clean.sh <<'EOF'
#!/bin/bash
unset AGENTDECK_COL_ID AGENTDECK_TERMINAL_ID AGENTDECK_RECEIPT_TOKEN AGENTDECK_CONTROL_DIR AGENTDECK_BOARD_CLI AGENTDECK_NATIVE_NOTIFICATIONS AGENTDECK_MANAGED AGENTDECK_CONTROL_TOKEN
exec "$@"
EOF
chmod +x /tmp/clean.sh
/tmp/clean.sh npm test                                   # 结果：462/462 通过
AGENTDECK_CHAT_SHOTS=/Users/jinhao/reports/agentdeck-chat-redesign \
  /tmp/clean.sh npx playwright test tests/e2e/chat-redesign.spec.js --workers=1   # 结果：6/6 通过，并生成截图
```
截图：改后 `/Users/jinhao/reports/agentdeck-chat-redesign/chat-redesign-{dark,light}.png` 和 `-expanded.png`；改前（origin/main 同一段对话）`chat-before-{dark,light}.png`。

## 收尾（2026-10-04）
- rebase 到 origin/main `2d58205` 无冲突。`tests/chat-core.test.js` 34/34。`chat-redesign.spec.js` 6/6，`chat.spec.js` 15/15，`workspace.spec.js` 11/11，单 worker。
- 对话页变重之后，`app.exit(0)` 在 `will-quit` 里会返回但进程不结束，Playwright 等不到退出。`main.js` 在它后面补了 `process.exit(0)`。
- 与 `origin/fix/draft-sync` 的试合并能自动合上，没有改坏草稿同步。之前那 3 项失败不是两个 spec 互相污染：在合并后的代码上单独跑也是同样 2 项失败（第三项「发出去就清空」通过）。原因是 v1.1.3 每次启动都在终端，而 draft-sync 的 spec 仍假设一打开就是对话。在试合并目录里让 spec 先 `ChatUI.setMode(..., 'chat')` 之后，单独跑 3/3，接着跑 chat-redesign 再跑 draft-sync 也是 3/3。该 spec 属于 draft-sync，没有并进这个分支。试合并目录没有带上上面的 `process.exit`，所以那边 chat-redesign 的 afterAll 仍会卡在退出。
- 还没合并进 main，没打包，没安装，没重启现役。
