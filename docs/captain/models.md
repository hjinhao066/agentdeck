# 模型清单、分工和档位

可用 agent：new --command 写完整命令，--model 选模型。
- Antigravity：agy --dangerously-skip-permissions --model gemini-3.8-flash-high。agy models 当前还列出并已实测可生成：claude-sonnet-4-6（Claude Sonnet 4.6 Thinking）、claude-opus-4-6-thinking（Claude Opus 4.6 Thinking）、gpt-oss-120b-medium（GPT-OSS 120B Medium）。Gemini 有额度时优先 Flash；Gemini 周额度用尽后，普通代码、批量实现和测试用 GPT-OSS，日常代码用 Sonnet 4.6，复杂推理、架构和审查用 Opus 4.6。只对 Gemini Flash 写档位后缀：gemini-3.8-flash-low、gemini-3.8-flash-medium、gemini-3.8-flash-high；其余模型必须使用上面列出的完整 ID。绝对不要给 agy 加 --effort：它会悄悄换成另一个模型。
- Cursor CLI：cursor-agent --force --model grok-4.7-high-fast　主要用 Grok 4.7 跑脏活和数据抓取。Cursor 会话刚开的头 1–2 分钟可能没有任何输出，属于正常初始化，别急着判定卡死。
- Claude Code：claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high　每次开 Claude 小弟必须显式写 --model claude-opus-5-5、--model claude-sonnet-5-5 或 --model claude-haiku-5-5，并显式写 --effort；本机默认模型不是 Opus，不写可能跑成别的模型。开工后用 peek 看状态行确认模型，不符就修正命令重新派活。Opus 留给 UI、最关键的代码和终审；重要代码用 Sonnet。Claude Code 额度受限时，可改用 Cursor 里的同名模型（claude-opus-5-5-high、claude-sonnet-5-5-high）。
- Claude Code、Cursor、Codex 命令仍禁止 Claude 4.x 和 Haiku 4.x 及更早（Haiku 5.5 可用，写完整 ID claude-haiku-5-5，不能只写 haiku）。只有 agy 可用上面列出的两个 Claude 4.6 模型；其他旧模型仍禁止。
- Codex：使用 --agent codex，默认模型 GPT-6.1 Sol。现阶段暂不消耗 ChatGPT 额度，执行类的活不派 Codex，用户点名才用。免确认沙箱参数（--dangerously-bypass-approvals-and-sandbox）和 --no-daemon 由 AgentDeck 按本机支持情况自动补齐，不要手动拼接。
- 独立的 Grok CLI（grok）：用户的订阅已经取消，用户没点名就不要用它派活（Cursor 里的 grok 模型不受影响）。
- DeepSeek 兜底（仅 Mac，按量扣费，用户已同意启用）：new --command "/Users/jinhao/.local/claude-deepseek/bin/claude-ds --dangerously-skip-permissions"，必须写绝对路径；复杂一点的活在命令里加 --model opus。参数以共享记忆 ~/.agents/memory/deepseek-fallback-enabled.md 为准。它不是 Claude 席位，不套用上面 Claude 小弟的 --model claude-…／--effort 写法。

程序硬拦的两件事，不用自己记：禁用的旧模型 new 会直接拒绝并提示可用模型；给 agy 写的 --effort 会被程序去掉（Gemini 改写成档位后缀）。

模型分工（用户点名优先）：
- Opus 5.5：UI 设计、最关键核心代码、最终审核（Claude Code 显式 --model claude-opus-5-5，或 Cursor claude-opus-5-5-high）。
- Sonnet 5.5：重要代码与核心改动（Claude Code 加 --model claude-sonnet-5-5，或 Cursor claude-sonnet-5-5-high）。
- Haiku 5.5：批量写代码、写测试、CI/CD 修复，以及简单的轻量代码与杂项活（Claude Code 显式 --model claude-haiku-5-5 并写 --effort，简单活 medium）；碰到复杂或要改核心逻辑的升级给 Sonnet 5.5。
- Gemini 3.8 Flash：检索、整理、中文写作、简单到中等代码（Antigravity，不消耗 Claude 额度；不用 Gemini 3.1 Pro）。Gemini 周额度用尽时，agy GPT-OSS 120B Medium 做批量代码与测试；Sonnet 4.6 做日常代码；Opus 4.6 Thinking 做架构、复杂推理与审查。agy 第三方模型的剩余额度目前无法读取，遇到限流就换另一个已实测模型。
- Cursor Grok 4.7：脏活、抓数据、外部信息采集（cursor-agent --force --model grok-4.7-high-fast）。
- 数据抓取兜底：网上的数据抓不到时，不要盲目手写无头爬虫死磕，先找 GitHub 现成工具、OpenCLI、agent-reach 技能；若仍抓不到再考虑调度 Muse.ai 或 ChatGPT 浏览器（computer use）。
- 额度轮换：quota 只读被动观测，未知不代表可用，不要因此换模型。额度用尽或低于阈值时按同级换能用的模型，标题和回执写明原本派了谁；--command 点名的不换，只排队。会话自己报用完、限流或没登录时，用 new 换下一个重派并告诉用户。
- DeepSeek 兜底：Claude 各席位、Codex、Cursor、Gemini 都用尽或低于阈值而活不能停时才用，还有订阅额度就不用。只派简单到中等的代码、测试、整理；UI 设计、最关键代码、最终审核不派，等订阅额度恢复。标题和回执写明「DeepSeek 兜底」，派出的活必须带独立审查。

用多大的档位（effort）：
- 简单的活（查找、小改动、整理）：medium
- 一般的写代码（默认）：high
- 复杂的活，或者同一件事已经失败过：xhigh
- 最关键、最难的活：max
Cursor 把档位写在模型名最后，只用这些名字：claude-opus-5-5-medium、claude-opus-5-5-high、claude-opus-5-5-xhigh、claude-opus-5-5-max、claude-sonnet-5-5-medium、claude-sonnet-5-5-high、claude-sonnet-5-5-xhigh、claude-sonnet-5-5-max。
Claude Code 用 --effort 写档位。Antigravity 的 Gemini Flash 把档位写在模型名最后，只有 low、medium、high（没有 xhigh 和 max）；Claude 4.6 与 GPT-OSS 使用完整模型 ID，不追加档位。agy 绝不能加 --effort。
