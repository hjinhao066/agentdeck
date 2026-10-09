# 命令详解

下面每条命令前面都加 `node "$AGENTDECK_BOARD_CLI"`；Windows PowerShell 写成 `node "$env:AGENTDECK_BOARD_CLI"`，Bash 工具里（含 Windows）一律用前一种。

2. 和别的会话打交道，只用下面这些终端命令：

- handoff   生成当前交接快照并刷新交接文件；开工、Relay、清空、重启后先跑。briefing 只读核心提示词；用户说「你是队长」先跑 ledger 验证身份，再读这两个
- ledger   列出全部会话：id、标题、状态、最近回执
- discuss start --topic "题目"   「讨论一下」/group discussion/do a group discussion/group chat 就发起；status 查全部，status/wait/resume/cancel --id ID 查/等/续/取消。unknown 先核对旧请求，确认结束才 resume --retry JOB --confirmed-ended JOB；discuss help 读规约。
- task add --project "项目" --title "标题" [--detail "说明"] [--depends 卡片id,卡片id] [--verify] [--priority high]；task list [--project "项目"] [--status todo|doing|review|needs_user|done]；task move --id 卡片id --status 状态；task priority --id 卡片或会话id --level high|normal；task archive --done [--project "项目"]
- queue list；queue cancel --task-id 卡片或排队id；同卡 new 换命令/模型会替换，移到 done/todo 撤队
- quota   只读各家订阅额度；派活前可跑 quota，避开已用尽或快用尽的；未知不代表可用
- settings battery [--boost on|off [--for 2h|--until 23:59]] [--mode off|auto] [--cap 1-10]   电池模式：不带参数只读；用户说「强度拉满」就 --boost on（临时越过电池上限，接电源或到时间自动恢复），说恢复或不要了就 --boost off；立即生效
- new --title "标题" --task "任务正文" [--project "项目名"] [--reviews id[,id]] [--task-id id] [--cwd 目录] [--worktree 仓库] [--priority high] [--seat 账号名|cn|us|us2] [--agent claude|agy|cursor|grok|codex|chatgpt-web | --command "启动命令"]   --seat 为已登录 Claude 席位；默认同队长；网页仅公开调研，先审查敏感信息；--web-mode deep-research；禁 --seat/--command
- tell --to 会话id --message "指令" [--replace] [--now]   发给已有会话；--replace 替换未送达的补充；--now 先中断，就绪后发送，可与 --replace 同用；普通补充合并发送
- stop --id 会话id   发送 Esc，中断当前操作，保留终端；未发送的补充指令取消
- archive --id 会话id   结束终端并归档，保留对话；正在干活也执行，不弹确认框
- read --id 会话id [--turns 3] [--find 关键词]   读某个会话已保存的对话；恢复、诊断、验收、核对矛盾或用户追问时按需读；清空上下文前的队长对话也这样读，id 列在 ledger 最后
- read --id captain-history --find "关键词" [--turns 3]   搜全部清空前的队长记录
- peek --id 会话id [--lines 40]   只读看终端实时屏幕/最近输出（最多1000行）；不发输入，不恢复已归档会话。查进度或诊断卡住时用
- receipts [--wait] [--timeout 秒]   取回未读回执；--wait 阻塞等回执/提问，超时输出空并退出，省略 timeout 一直等
- answer --to 会话id --key y|n|1-9|enter|esc|up|down   回答确认或权限提示；菜单如 down,enter
- inbox need|report|resolve、notify-user：完整用法在 briefing --topic inbox。
- briefing [--topic 名]   不带参数只读核心提示词；--topic 名 读一份规范，--topic all 读全部，--topic list 列出每份规范的名字和什么时候读。
