# 讨论一下：队长命令行

多个 AI 先独立回答同一个题目，再看匿名的上一轮完整稿、互评并修订，最后由汇总者给出一个答案。默认成员是 Claude Code **Opus 5.5**（`claude-opus-5-5`）和网页 ChatGPT **6 Pro**，Opus 同时负责汇总；没有默认 Codex。只用已登录的订阅命令行和网页，不走按量付费 API，也不以 DeepSeek 或弱模型兜底。

## 发起与进度

当前任务分支可以在现役队长终端立即运行，使用新源码入口，无需重启应用。现役安装的 `$AGENTDECK_BOARD_CLI` 还没有这些子命令；先把下列 `DISCUSS_CLI` 换成该任务分支 `board-cli.js` 的完整路径，保留现役终端的 `AGENTDECK_` 凭据。将来集成新版本后可直接使用 `$AGENTDECK_BOARD_CLI`。

用户用中文说「讨论一下」，或用英文说「group discussion」「do a group discussion」「group chat」等表达要让多个 AI 讨论时，队长就发起讨论，把用户给出的题目与约束放进 `--topic`。例如「讨论一下：某题目」时运行：

```sh
DISCUSS_CLI="/绝对路径/任务分支/board-cli.js"
node "$DISCUSS_CLI" discuss start --topic "比较两种方案，列出约束、主要风险和决定性证据。"
node "$DISCUSS_CLI" discuss status
node "$DISCUSS_CLI" discuss status --id <讨论ID>
node "$DISCUSS_CLI" discuss wait --id <讨论ID>
```

长题目可以用 `--topic-file /绝对路径/question.md` 替代 `--topic`。发起时加 `--gemini`，便加入 Antigravity 的 `gemini-3.8-flash-high`；参与者也可用 `--participants-file /绝对路径/participants.json` 配置，汇总者用 `--summarizer <成员ID>` 指定。所有入选成员都必须完成，失败不会自动剔除。参与者文件是 JSON 数组，例如：

```json
[
  {"id":"opus","provider":"claude","model":"claude-opus-5-5","tier":"subscription"},
  {"id":"chatgpt","provider":"chatgpt-web","model":"6 Pro","tier":"Pro"}
]
```

`provider` 支持 `claude`、`chatgpt-web`、`agy`；网页当前只接受 `6 Pro` / `Pro`。Claude 根据本机配置与最新官方额度选可用席位，并要求能证明 Extra Usage 已关闭；启用或无法核对额外按量消费、额度或订阅登录时暂停，不修改用户账户设置。实际模型取运行时事件或网页元数据；档位证据如实标明运行时回报、显式 CLI 参数或模型 ID，不把参数当作运行时回报。

默认两轮指「独立回答一轮 + 全员互评并修订一轮」，不是两次互评。第二轮仍有具体实质分歧才加第三轮，最多三轮；到上限会保留分歧，不强凑共识。每轮收齐并冻结后才进入下一轮。互评只标方案代号，隐藏作者标签；这是流程匿名，不能保证模型认不出自己的文字。

命令需要队长的控制凭据，普通队员不能发起、取消或恢复。调度在后台执行，网页沿用现有 ChatGPT 执行器及其锁、冷却与待处理请求保护，不接管用户页面。桌面和手机入口本次不提供。

## 失败、重启与取消

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID>
node "$DISCUSS_CLI" discuss cancel --id <讨论ID>
```

重启后先看 `status`，再用 `resume` 继续；已完成的稿和冻结轮次保留。额度不足、模型核验不符、登录失败或参与者超时会暂停并说明原因，不会把暂停算成功。额度恢复后也需要明确续跑，不偷偷切型号。

网页请求一旦已发送或发送状态不明，`resume` 不会再次提同一题。先核对保留的旧请求；若能导出完整答案，可用恢复入口导入原请求的稿，附上实际模型和档位。不要为了推进而直接重复发题。取消会停止后续派发并保留已有产物；取消后迟到结果不会使讨论变成完成。

从 `status` 取对应 `job` ID，核对导出原稿及实际选择的模型，再导入：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --job <作业ID> \
  --result-file /绝对路径/原请求完整稿.md --model "6 Pro" --tier Pro --effort Pro
```

原稿应保留末尾讨论元数据；互评稿需要实质分歧判断，汇总稿需要摘要与忠实性核对。优先接回原请求答案；执行器也会先检查已落盘的原请求产物。确实需要重发时，必须先确认旧网页生成已结束、关闭它并解除工具的 pending 状态，再明确授权对应作业的新尝试：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --retry <作业ID> --confirmed-ended <作业ID>
```

这条确认不能用来绕过仍在运行的请求。仍有其他失败或状态不明的成员时，讨论继续暂停。执行器还活着时不允许另开一个续跑；用 `wait --id <讨论ID> --timeout 3600` 等它完成或暂停。

## 产物与隐私

每场讨论放在 `~/.agents-state/agentdeck/discussions/<讨论ID>/`，避开共享看板与技能同步仓库。包含原题 `question.md`、共同脱敏题目 `public-question.md`、各轮各人的原稿与输入、冻结信息、模型核验、`disagreements.md` 和最终 `final.md`。`run.json` 留有参与者、讨论 ID、轮次、成员、尝试、状态、分歧与少数派；`final-meta.json` 留有实际模型记录与忠实性核对，供以后界面读取。长文不塞进共享任务看板。结束时生成结论摘要、主要分歧和 `final.md` 的完整路径，原稿留在讨论目录。新版本会投递队长回执；现役旧应用不认识新回执协议时，`receipt.json` 保留待投递标记，队长用 `wait --id` 直接取结论与路径。

网页每轮新开提问，自带原题和该轮材料全文，不要求它读取本机文件。每次真正出站的完整内容都会脱敏，涵盖用户名、邮箱、用户路径、凭据、IP/域名和会话 ID；实际发送副本也会存档。只提供可以外发的题目与材料，不自动附上仓库、记忆、终端历史或环境变量。自动规则不能保证识别所有私人背景组合。

最终提示要求证据优先、保留最强少数派及其适用条件，并逐份核对有没有歪曲或遗漏各方原意；模型给出的核对不等于事实已经由外部证据验证。最终稿不会自动触发实施。

## 额度与适用题目

两成员两轮加汇总通常是 **5 次模型调用**（Opus 3 次、网页 2 次）；加入 Gemini 是 **7 次**，增加第三轮再加每位成员各 1 次。重试另计。互评要读全体原稿，文字量会远高于直问一次，不能按调用次数估计实际额度扣减。余额未知就记未知，不编造 token 账单。

网页单次允许等约 30 分钟，完整两轮可先预留 15–30 分钟，排队、冷却与复杂问题会更久。这个范围是规划估计，不是性能承诺。适合错误方向会浪费几天的方案选择、重大系统边界、跨模块根因和规则盲点；查一个事实、改一句文案和明确的小修通常直接问一个模型即可。

提示词改编自 MIT 项目 [agent-council](https://github.com/yogirk/agent-council)、[Council Plus Advisors](https://github.com/jacob-bd/llm-council-plus) 和 [Ensemble](https://github.com/raiyanyahya/ensemble)，以本地设计报告的三套中文草稿为基础。
