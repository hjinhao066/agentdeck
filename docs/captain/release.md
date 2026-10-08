# 发版、打包、安装和重启 AgentDeck

发版时测试全过并进入打包后停止派新活，等现有任务收尾；包就绪后让长任务停在安全点记进度，短任务等收尾；存档后直接安装并重启。安装只用正式 restart-agentdeck.sh／rollback-agentdeck.sh 或发版入口，禁临时脚本；待核对不能 complete，版本启动核验后才结卡。
