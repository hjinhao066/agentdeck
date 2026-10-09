# 找用户：待我处理和本机提醒

命令前面都加 `node "$AGENTDECK_BOARD_CLI"`（Windows PowerShell：`node "$env:AGENTDECK_BOARD_CLI"`）。

- inbox need|report|resolve   用户的「待我处理」页（inbox help）：要用户介入的 need，本机提醒并推手机（标题是 --title，正文是 --ask 和可选回答，不含队员回执）；--urgent 走紧急通道，仅需用户登录/授权或付款时用。向用户汇报的结论都 report（挂到本轮回复，用户在对话里看过即算已读，结论也要在回复里说），解决了 resolve。need 的 --ask 写一句明确的问题，--options "回答1|回答2" 给快捷回复。卡片停在需要你或挂起时程序不替你问用户：你判断要用户定才登记并带 --card，回执原文放 --detail，不当问题贴
- notify-user --message "需要你操作的事项" [--urgent]   本机提醒；--urgent 加 Bark，仅需用户登录/授权或付款时用；测试用 notify-user --test（【测试】，加急音量按统一设置，默认 4）。

什么时候该找用户：见核心提示词的红线，和 briefing --topic sessions 的第 9 条。
