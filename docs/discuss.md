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
node "$DISCUSS_CLI" discuss help
```

长题目可以用 `--topic-file /绝对路径/question.md` 替代 `--topic`。发起时加 `--gemini`，便加入 Antigravity 的 `gemini-3.8-flash-high`；参与者也可用 `--participants-file /绝对路径/participants.json` 配置，汇总者用 `--summarizer <成员ID>` 指定。所有入选成员都必须完成，失败不会自动剔除。参与者文件是 JSON 数组，例如：

```json
[
  {"id":"opus","provider":"claude","model":"claude-opus-5-5","tier":"subscription"},
  {"id":"chatgpt","provider":"chatgpt-web","model":"6 Pro","tier":"Pro"}
]
```

`provider` 支持 `claude`、`chatgpt-web`、`agy`；网页当前只接受 `6 Pro` / `Pro`。Claude 根据本机配置与最新官方额度选可用席位，并要求能证明 Extra Usage 已关闭；启用或无法核对额外按量消费、额度或订阅登录时暂停，不修改用户账户设置。实际模型取运行时事件或网页元数据；档位证据如实标明运行时回报、显式 CLI 参数或模型 ID，不把参数当作运行时回报。

默认两轮指「独立回答一轮 + 全员互评并修订一轮」，不是两次互评。第二轮仍有具体实质分歧才加第三轮，最多三轮；可加 `--max-rounds 2` 禁止第三轮。到上限会保留分歧，不强凑共识。每轮收齐并冻结后才进入下一轮。互评只标稳定方案代号，每位评委的材料顺序独立洗牌；明确作者身份和署名会去掉，客观产品、公司名称与公开引用保留，避免曲解论据。这是流程匿名，不能保证模型认不出自己的文字或其他身份线索。

命令需要队长的控制凭据，普通队员不能发起、取消或恢复。讨论使用独立后台执行器，直接启动订阅 CLI 并复用现有网页执行器、技能锁、冷却和待处理请求保护；这样源码入口能在不重启现役应用时先用。参与者不出现在 `ledger`、`peek`、会话列表里，也不占应用内会话并发名额；进度以 `discuss status/wait` 为准。网页确认未发送的 `LOCKED/COOLDOWN` 会后台等待，不绕锁抢发。桌面和手机入口本次不提供。

## 失败、重启与取消

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID>
node "$DISCUSS_CLI" discuss cancel --id <讨论ID>
```

重启后先看 `status`，再用 `resume` 继续；已完成的稿和冻结轮次保留。额度不足、模型核验不符、登录失败或参与者超时会暂停并说明原因，不会把暂停算成功。明确未发送的失败可安全续跑；已发送或无法确认的作业保持阻塞，`resumeBlocked` 说明缺什么，`resumedJobs` 列出真正续跑的作业。处理额度或登录后仍要检查这些字段，不能把命令退出成功当成整场已经恢复。

网页请求一旦已发送或发送状态不明，`resume` 不会再次提同一题。先核对保留的旧请求；若能导出完整答案，可用恢复入口导入原请求的稿，附上实际模型和档位。不要为了推进而直接重复发题。取消会停止后续派发并保留已有产物；取消后迟到结果不会使讨论变成完成。

从 `status` 取对应 `job` ID，核对导出原稿及实际选择的模型，再导入：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --job <作业ID> \
  --result-file /绝对路径/原请求完整稿.md --model "6 Pro" --tier Pro --effort Pro
```

`--effort` 必须与 `status` 中该参与者配置的档位一致，不能把缺少证据的档位改成其他值来导入。

执行器会先检查已落盘的原请求产物。导出稿的讨论标签可容忍 Markdown 转义、包裹和尾随文字；仍解析不到或字段不足时标为 `metadata-needed`，保留完整答案，不为补字段重新问模型。队长读过原稿后，可给同一作业补一个 JSON 文件：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --job <作业ID> \
  --metadata-file /绝对路径/metadata.json
```

互评元数据示例：`{"materialDisagreement":false,"disagreements":[],"minority":[]}`。汇总还需 `summary` 和 `faithful`；这些值必须依据原稿填写，不能为过闸随便填。补字段保留原答案及实际模型证据，不是一次新的模型调用。

网页前台自检 `FRONT_UNSURE` 有可核验完整稿时保留答案；`FRONT_STOLEN` 表示工具抢了前台，会存稿并暂停。核对该稿、确认后台行为已修复后，显式接回保存的答案：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --accept-saved
```

这不会重新提同一题，也不会替你修复浏览器工具。确实需要重发时，必须先确认旧网页生成已结束、关闭它并解除工具的 pending 状态，再明确授权对应作业的新尝试：

```sh
node "$DISCUSS_CLI" discuss resume --id <讨论ID> --retry <作业ID> --confirmed-ended <作业ID>
```

这条确认不能用来绕过仍在运行的请求。能安全续跑的成员可以先恢复，其他作业留在 `resumeBlocked`；本轮全体有效答案齐之前不会进入下一轮。执行器还活着时不允许另开一个续跑；用 `wait --id <讨论ID> --timeout 3600` 等它完成或暂停。

新版本的 `handoff` 会带未完讨论 ID、状态与轮次，不带题目和原稿；`discuss help` 从安装工具目录读取随程序提供的说明。只用源码入口先试用时，现役旧应用的 `briefing/handoff` 不会自动升级，接班队长先运行源码的 `discuss status` 和 `discuss help`。无需改写现役工具或重启应用。

## 产物与隐私

每场讨论放在 `~/.agents-state/agentdeck/discussions/<讨论ID>/`，避开共享看板与技能同步仓库，目录权限为 0700、文件为 0600（Windows 使用本机目录权限）。包含原题 `question.md`、共同脱敏题目 `public-question.md`、各轮各人的原稿与输入、冻结信息、模型核验、`disagreements.md` 和最终 `final.md`。`run.json` 留有参与者、讨论 ID、轮次、成员、尝试、状态、分歧与少数派；`final-meta.json` 留有实际模型记录和核对来源，供以后界面读取。长文不塞进共享任务看板。结束时生成结论摘要、主要分歧和 `final.md` 的完整路径，原稿留在讨论目录。新版本会投递队长回执；现役旧应用不认识新回执协议时，`receipt.json` 保留待投递标记，队长用 `wait --id` 直接取结论与路径。

网页每轮新开提问，自带原题和该轮材料全文，不要求它读取本机文件。原题、新增原稿及分歧材料都经过发送前扫描，邮件、用户路径、明确标注的姓名地址、电话、身份证、IP、内部主机和会话标识会脱敏；普通公开可核查引用 URL 保留。引用路径含明确身份模式时整条 URL 脱敏，不改造路径冒充仍可核查的链接；URL 编码不绕过已知凭据的硬拦。实际发送副本存档，代码标识符、文件名、时间比例和普通 token/key/secret 讲解保持原意。

已识别凭据会触发 `privacy-blocked` 硬暂停，不会仅换成星号继续发送。该讨论不能靠 `resume` 绕过；清理材料后新建讨论。原题、原稿和私有映射仍可能含敏感明文，只在上述本机私有目录保留，不进入 Git。无标签的中文姓名、地址、任意无上下文密钥与散列不能可靠区分，`limitations` 如实记录；不要把自动扫描当作所有隐私已经清除。

最终提示要求证据优先、保留最强少数派及其适用条件，并让汇总者自查有没有歪曲或遗漏。`faithful` 是模型自述或队长补录，`externallyVerified=false` 表示未做独立外部核验；少数派数组检查也不能证明每一条都已忠实进入正文。默认 Opus 既参与又汇总，用户仍应结合证据读稿。最终稿不会自动触发实施。

## 额度与适用题目

两成员两轮加汇总通常是 **5 次模型调用**（Opus 3 次、网页 2 次）；加入 Gemini 是 **7 次**，增加第三轮再加每位成员各 1 次。重试另计。互评要读全体原稿，文字量会远高于直问一次，不能按调用次数估计实际额度扣减。余额未知就记未知，不编造 token 账单。

网页工具进程有外层 30 分钟期限，等待未发送网页的锁/冷却也有期限；每次启动执行器或显式续跑的执行预算为 60 分钟，包含排队和各轮等待，不是从讨论创建起永久累计的上限。到期暂停并保存稿，可能已发送的请求仍需核对，不能自动重问。取消或超时不保证技能保留的请求页已关闭，需确认旧生成结束并处理 pending 页面。

完整两轮可先预留 15–30 分钟，排队、冷却与复杂问题会更久。这个范围是规划估计，不是性能承诺。适合错误方向会浪费几天的方案选择、重大系统边界、跨模块根因和规则盲点；查一个事实、改一句文案和明确的小修通常直接问一个模型即可。本轮未运行真实账号或可选 Gemini 联调，假参与者不代表实际账号已跑通。

提示词改编自 MIT 项目 [agent-council](https://github.com/yogirk/agent-council)、[Council Plus Advisors](https://github.com/jacob-bd/llm-council-plus) 和 [Ensemble](https://github.com/raiyanyahya/ensemble)，以本地设计报告的三套中文草稿为基础。
