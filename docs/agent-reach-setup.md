# Agent-Reach 评估与安装指南

> 评估日期：2026-06-13。结论：**对 AgentDeck 的使用场景有帮助，建议在 Mac 本机安装。**

[Agent-Reach](https://github.com/Panniantong/Agent-Reach) 是给终端 AI agent
（Claude Code / OpenClaw / Cursor 等）加"上网读内容"能力的路由器：13 个平台
（Twitter/X、小红书、B站、Reddit、YouTube、V2EX、雪球、LinkedIn、RSS、网页等），
每个平台有首选/备选后端，失效自动切换。AgentDeck 的每一列跑的正是这类 agent，
装好后列里的 Claude Code 会自动获得 `agent-reach` skill。

## 评估结果（云端沙箱实测）

- ✅ 安装顺利：pipx 一条命令装好，v1.5.0，skill 自动注册到
  `~/.claude/skills/agent-reach`
- ✅ 设计合理：零配置渠道（全网搜索/网页/RSS/YouTube/GitHub）开箱即用，
  doctor 自检清晰
- ⚠️ 抓取测试在云端沙箱**无法完成**：沙箱网络出口白名单挡住了所有目标站点
  （小红书/B站/YouTube/Exa/Jina 全部 403）。这是沙箱限制，不是项目问题。
  **实际抓取测试需在 Mac 本机做**（AgentDeck 也运行在本机，正好一致）。

## Mac 本机安装

```bash
# 1. 核心（零配置渠道：搜索/网页/RSS/YouTube/GitHub/B站基础）
brew install pipx && pipx ensurepath
pipx install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto

# 2. 自检
agent-reach doctor
```

## 小红书配置（桌面首选：OpenCLI，复用 Chrome 登录态）

```bash
agent-reach install --env=auto --channels=opencli,xiaohongshu
```

要求：Chrome 打开、装了 OpenCLI 扩展、浏览器里登录过小红书。之后 agent 即可：

```bash
opencli xiaohongshu search "关键词" -f yaml   # 搜索笔记
opencli xiaohongshu note "NOTE_URL" -f yaml   # 读笔记（用搜索结果里含 xsec_token 的完整 URL）
opencli xiaohongshu comments NOTE_ID -f yaml  # 评论
```

注意事项：

- 小红书强制 xsec_token，**不能拿裸 note_id 直接读**，必须先搜索拿到完整 URL
- 高频请求会触发验证码，每次操作间隔 2-3 秒
- 只做读取，不要用它发帖/评论/点赞

## 验证抓取是否可用

装好后在 AgentDeck 任意一列对 Claude Code 说：

> 用 agent-reach 在小红书搜"AI 编程工具"，给我前 3 条笔记的标题和点赞数

或手动：`agent-reach doctor --json` 看 `xiaohongshu.active_backend`。
