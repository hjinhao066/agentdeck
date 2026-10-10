# 队长提示词：10000 字上限与规则对照清单

基线：`64043df`（release/1.5，改动前）。本清单由脚本逐行比对基线与改动后的 `MainCore.instructions()` 输出生成，四种组合（Mac／Windows × 后台回执／旧回执注入）全部比对。

## 结论

- 原有规则一行没删、一个字没改：四种组合共 260 行基线文本，逐字原样保留 260 行，缺失 0 行，顺序不变。这次没有做任何压缩改写，所以不存在“等义不等义”的判断。
- 只新增两行，都是 DeepSeek 兜底说明（见第 3 节）。
- 2.0.7 起规则 16 按用户 2026-10-09 的新规改写（验收派 Opus 5.5 新开会话，简单的核对 Sonnet 5.5，界面活一律 Opus 5.5，不派 Gemini 等别家模型），不再是「原样保留」；表里第 36 行单独标明。
- 只有队长提示词的一次粘贴上限提到 10000（`MainCore.BRIEFING_LIMIT`）。其他所有提示词、发给任何 CLI 的，仍是 8000 字以上存文件（`MainCore.LONG_PROMPT`），行为和改动前一样。
- 10000 字能不能完整收到，第 6 节是实测结果：Claude Code（默认队长）在 Mac、CI macOS、CI Windows Server 2022／2025 上，10000 字都一字不差到了模型；Codex 在 Mac 上同样一字不差，但在 CI Windows 上任何长度都收不好（含 200 字和改动前 7990 字的原文），是改动前就有的问题；Cursor 在本机 Mac 上实测通过；agy 因额度用尽只证到 CLI 收下、没证到模型；用户自己的 Windows 电脑全部需在 Windows 机器上验证。

| 组合 | 基线行数 | 基线字数 | 现行数 | 现字数 | 加「读看板继续。」后 | 距上限 | 缺失行 |
|---|---|---|---|---|---|---|---|
| Mac，后台回执 | 65 | 7930 | 67 | 8367 | 8375 | 1625 | 0 |
| Windows，后台回执 | 65 | 7990 | 67 | 8427 | 8435 | 1565 | 0 |
| Mac，旧回执注入 | 65 | 7631 | 67 | 8068 | 8076 | 1924 | 0 |
| Windows，旧回执注入 | 65 | 7691 | 67 | 8128 | 8136 | 1864 | 0 |

字数按 JavaScript 字符串长度计（与程序判断是否降级为文件指针的口径一致），并发上限按默认 30；上限 5–50 时字数相差不超过 2。

## 1. 逐条对照（Mac，后台回执）

「原字数／现字数」是该行的字符数，相等且逐字相同才记「原样保留」。

| # | 位置 | 原文开头 | 原字数 | 现字数 | 结果 |
|---|---|---|---|---|---|
| 1 | 开头 | 你是 AgentDeck 的「队长」：常驻的总负责人。你听懂用户要什… | 66 | 66 | 原样保留 |
| 2 | — | （空行） | 0 | 0 | 原样保留 |
| 3 | 规则 | 规则： | 3 | 3 | 原样保留 |
| 4 | 规则 1 | 1. 不要在这一列里改文件、跑任务或写实现过程，实际工作和返工都交给… | 106 | 106 | 原样保留 |
| 5 | 规则 2 | 2. 和别的会话打交道，只用下面这些终端命令： | 23 | 23 | 原样保留 |
| 6 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" notify… | 156 | 156 | 原样保留 |
| 7 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" handof… | 122 | 122 | 原样保留 |
| 8 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" ledger… | 60 | 60 | 原样保留 |
| 9 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" task a… | 322 | 322 | 原样保留 |
| 10 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" queue … | 105 | 105 | 原样保留 |
| 11 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" quota … | 78 | 78 | 原样保留 |
| 12 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" new --… | 338 | 338 | 原样保留 |
| 13 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" tell -… | 149 | 149 | 原样保留 |
| 14 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" stop -… | 77 | 77 | 原样保留 |
| 15 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" archiv… | 77 | 77 | 原样保留 |
| 16 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" read -… | 139 | 139 | 原样保留 |
| 17 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" read -… | 95 | 95 | 原样保留 |
| 18 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" peek -… | 109 | 109 | 原样保留 |
| 19 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" receip… | 111 | 111 | 原样保留 |
| 20 | 规则 2 命令 | node "$AGENTDECK_BOARD_CLI" answer… | 106 | 106 | 原样保留 |
| 21 | 规则 3 | 3. 目标清楚就派活：目标、范围和验收要求明确且已获授权，直接拆开派… | 145 | 145 | 原样保留 |
| 22 | 规则 4 | 4. 派活单步原则：一个会话一次只派一件活，忙碌时不要连着追加。互不… | 112 | 112 | 原样保留 |
| 23 | 规则 5 | 5. 界面类的活要写明图标规则：任务正文里必须写明——复制、删除、编… | 117 | 117 | 原样保留 |
| 24 | 规则 5 续行 | 大项目由你直接拆块派给正式会话，不层层外包；同一项目的会话用同一个 … | 88 | 88 | 原样保留 |
| 25 | 规则 5 续行 | 派活时说明：Claude 会话默认不要自己开 Claude 子 ag… | 72 | 72 | 原样保留 |
| 26 | 规则 6 | 6. 没点名目录不传 --cwd，点名才传。写代码的活加 --wor… | 101 | 101 | 原样保留 |
| 27 | 规则 7 | 7. 派完马上用一两句话告诉用户交给了哪个会话、已启动还是在排队，不… | 103 | 103 | 原样保留 |
| 28 | 规则 8 | 8. 回执走后台通道，不经过你的输入框，也不附在用户消息里。开工后立… | 464 | 464 | 原样保留 |
| 29 | 规则 9 | 9. 队员向你提问、或停在确认/权限提示时，你来拿主意：先看清它问的… | 122 | 122 | 原样保留 |
| 30 | 规则 10 | 10. 判断会话卡没卡先用 peek，至少等 5 分钟：启动、复杂分… | 101 | 101 | 原样保留 |
| 31 | 规则 11 | 11. 你开的会话在后台跑，用户看不到，靠你汇报。同一时间最多 30… | 102 | 102 | 原样保留 |
| 32 | 规则 12 | 12. 做完的会话没有新指令 10 分钟后会自动归档（终端关掉，对话… | 82 | 82 | 原样保留 |
| 33 | 规则 13 | 13. 任务看板：用户交代的任务默认先记进看板，用 task add… | 426 | 426 | 原样保留 |
| 34 | 规则 14 | 14. 并发上限 30（设置可改）。把控看内存压力等级：压缩和 sw… | 237 | 237 | 原样保留 |
| 35 | 规则 15 | 15. 节省上下文：不读大文件正文，只看报告的结论段；查进度优先 p… | 109 | 109 | 原样保留 |
| 36 | 规则 16 | 16. 重要的活完成后，派 Opus 5.5 新开会话验收（简单的核对派 Sonnet 5.5；界面活一律 Opus 5.5），不派 Gemini 等别家模型：… | 112 | 158 | **按用户 2026-10-09 的新规改写**（不再是原样；取代旧文字「派 Gemini 3.8 Flash 验收」，见 `memory/review-use-claude-sessions.md`，界面活见 `agentdeck-ui-must-be-opus.md`） |
| 37 | 规则 17 | 17. 本提示词只放稳定规则；动态状态和恢复顺序看 handoff。… | 154 | 154 | 原样保留 |
| 38 | — | （空行） | 0 | 0 | 原样保留 |
| 39 | 可用 agent | 可用 agent：new --command 写完整命令，--mod… | 41 | 41 | 原样保留 |
| 40 | 可用 agent | Antigravity：agy --dangerously-skip… | 477 | 477 | 原样保留 |
| 41 | 可用 agent | Cursor CLI：cursor-agent --force --… | 129 | 129 | 原样保留 |
| 42 | 可用 agent | Claude Code：claude --dangerously-s… | 347 | 347 | 原样保留 |
| 43 | 可用 agent | Claude Code、Cursor、Codex 命令仍禁止 Cla… | 93 | 93 | 原样保留 |
| 44 | 可用 agent | Codex：使用 --agent codex，默认模型 GPT-6.… | 177 | 177 | 原样保留 |
| 45 | 可用 agent | 独立的 Grok CLI（grok）：用户的订阅已经取消，用户没点名… | 68 | 68 | 原样保留 |
| 46 | — | （空行） | 0 | 0 | 原样保留 |
| 47 | 模型分工 | 模型分工（用户点名优先）： | 13 | 13 | 原样保留 |
| 48 | 模型分工 | - Opus 5.5：UI 设计、最关键核心代码、最终审核（Clau… | 103 | 103 | 原样保留 |
| 49 | 模型分工 | - Sonnet 5.5：重要代码与核心改动（Claude Code… | 99 | 99 | 原样保留 |
| 50 | 模型分工 | - Codex GPT-6.1 Sol：批量写代码、写测试、CI/C… | 61 | 61 | 原样保留 |
| 51 | 模型分工 | - Codex GPT-6 Luna：简单的轻量代码与杂项活（--c… | 67 | 67 | 原样保留 |
| 52 | 模型分工 | - Gemini 3.8 Flash：检索、整理、中文写作、简单到中… | 216 | 216 | 原样保留 |
| 53 | 模型分工 | - Cursor Grok 4.7：脏活、抓数据、外部信息采集（cu… | 84 | 84 | 原样保留 |
| 54 | 模型分工 | - 数据抓取兜底：网上的数据抓不到时，不要盲目手写无头爬虫死磕，先找… | 120 | 120 | 原样保留 |
| 55 | 模型分工 | - 额度轮换：quota 只读被动观测，未知不代表可用，不要因此换模… | 126 | 126 | 原样保留 |
| 56 | — | （空行） | 0 | 0 | 原样保留 |
| 57 | 档位 | 用多大的档位（effort）： | 15 | 15 | 原样保留 |
| 58 | 档位 | - 简单的活（查找、小改动、整理）：medium | 27 | 27 | 原样保留 |
| 59 | 档位 | - 一般的写代码（默认）：high | 20 | 20 | 原样保留 |
| 60 | 档位 | - 复杂的活，或者同一件事已经失败过：xhigh | 27 | 27 | 原样保留 |
| 61 | 档位 | - 最关键、最难的活：max | 17 | 17 | 原样保留 |
| 62 | 档位 | Cursor 把档位写在模型名最后，只用这些名字：claude-op… | 208 | 208 | 原样保留 |
| 63 | 档位 | Claude Code 用 --effort 写档位。Antigra… | 158 | 158 | 原样保留 |
| 64 | — | （空行） | 0 | 0 | 原样保留 |
| 65 | 结尾段 | 开工先跑 handoff，照它的「接手动作」做：没有待办就简短回复「… | 284 | 284 | 原样保留 |

## 2. 其余三种组合

Windows 版只有命令行前缀不同（`node "$env:AGENTDECK_BOARD_CLI"`）；旧回执注入版只有规则 8 不同。脚本对这三种组合同样逐行比对：

- Windows，后台回执：基线 65 行全部原样保留，缺失 0 行；新增 2 行，与 Mac 版相同。
- Mac，旧回执注入：基线 65 行全部原样保留，缺失 0 行；新增 2 行，与 Mac 版相同。
- Windows，旧回执注入：基线 65 行全部原样保留，缺失 0 行；新增 2 行，与 Mac 版相同。
- 旧回执注入版的规则 8（165 字，开头「8. 已显式开启旧回执注入回退：队员的回执和提问会在输入框为空且 a…」）：原样保留。

## 3. 新增内容（仅两行）

- 第 46 行（280 字，「可用 agent」末尾）：

  > DeepSeek 兜底（仅 Mac，按量扣费，用户已同意启用）：new --command "/Users/jinhao/.local/claude-deepseek/bin/claude-ds --dangerously-skip-permissions"，必须写绝对路径；复杂一点的活在命令里加 --model opus。参数以共享记忆 ~/.agents/memory/deepseek-fallback-enabled.md 为准。它不是 Claude 席位，不套用上面 Claude 小弟的 --model claude-…／--effort 写法。

- 第 57 行（149 字，「模型分工」末尾）：

  > - DeepSeek 兜底：Claude 各席位、Codex、Cursor、Gemini 都用尽或低于阈值而活不能停时才用，还有订阅额度就不用。只派简单到中等的代码、测试、整理；UI 设计、最关键代码、最终审核不派，等订阅额度恢复。标题和回执写明「DeepSeek 兜底」，派出的活必须带独立审查。

内容依据共享记忆 `~/.agents/memory/deepseek-fallback-enabled.md`：触发条件、绝对路径命令、`--model opus`、适用与不适用范围、标题与回执写明、独立审查、按量扣费、仅 Mac。

## 4. 上一轮被删的四处限定条件

上一轮（分支 `agentdeck/t-caea1429-d529-4e35-83f2-f2568ce72e4c`，提交 `bc87ade`，已回退）为了挤进 8000 字删掉了下面四处。本次都在，并由单测 `tests/captain-briefing-limit.test.js` 固定：

| 原文 | 位置 | 出现次数（基线 → 现在） |
|---|---|---|
| Claude Code 额度受限时，可改用 Cursor 里的同名模型（claude-opus-5-5-high、claude-sonnet-5-5-high）。 | 可用 agent · Claude Code | 1 → 1 |
| agy 第三方模型的剩余额度目前无法读取，遇到限流就换另一个已实测模型。 | 模型分工 · Gemini 3.8 Flash | 1 → 1 |
| 其余模型必须使用上面列出的完整 ID。 | 可用 agent · Antigravity | 1 → 1 |
| 未知不代表可用 | 规则 2 quota 命令、模型分工 · 额度轮换 | 2 → 2 |

上一轮同时删掉的其它文字（Antigravity 行里三个模型的全名和 Gemini 用尽后的分工、Claude Code 行的「Opus 留给 UI、最关键的代码和终审；重要代码用 Sonnet。」）也都原样在第 1 节的对应行里。

## 5. 上限是怎么改的

第一版把所有提示词的上限一起提到了 10000，审查指出没有证据证明每个 CLI、两个平台都能完整收下。真正需要更大上限的只有队长提示词，所以改成只放宽它：

| 位置 | 原来 | 现在 |
|---|---|---|
| `main-core.js` | 没有常量（8000 散在两处） | `LONG_PROMPT = 8000`：普通提示词，数值不变；`BRIEFING_LIMIT = 10000`：只给队长提示词；`SAVER_RESUME`：省上下文清空后追加的「读看板继续。」 |
| `chat-ui.js` `sendPrompt` | `const LONG_PROMPT = 8000`，超过就存文件、只发指针 | `prompt.length > (o.inlineLimit \|\| MainCore.LONG_PROMPT)`：不带 `inlineLimit` 的调用和原来完全一样 |
| `main-session.js` 三处发队长提示词（首次、清空上下文后重发、省上下文重发） | 走普通上限 | 各带 `inlineLimit: M.BRIEFING_LIMIT`；全仓只有这三处带 |
| `main-session.js` `enqueue`（排队的活） | `body.length > 8000` 先存文件 | 读 `M.LONG_PROMPT`，仍是 8000 |
| `main-core.js`、`main-session.js` 注释，`README.md` | 写着 8000 或“会超出上限” | 写明两个上限各管什么 |
| `tests/main-core.test.js`、`task-priority.test.js`、`launchers.test.js` | 断言提示词 `<= 8000` | 断言 `<= M.BRIEFING_LIMIT` |
| `tests/paste-image-prompt.test.js` | 按 `const LONG_PROMPT = 8000;` 截取源码 | 改截取锚点，替身环境带上 `MainCore` |
| `tests/queue-dispatch.test.js` | 9000 字触发存文件 | `M.LONG_PROMPT + 1` 字 |
| `tests/e2e/workspace.spec.js` 超长消息用例 | 9618 字存文件 | 不变（第一版改过，已改回）：它现在正好证明普通提示词在 8000–10000 之间仍然存文件 |

没有动、也不该动的 8000：手机端单条消息上限（`mobile-web.js`、`main-session.js` 的 `sendMessage`／`mobileMessages` 校验、`mobile-web/` 页面的 `maxlength`、`docs/mobile-web.md` 及其测试）。那是手机接口的输入校验。其余 8000 都是毫秒超时。

## 6. 10000 字完整接收的证据

受影响的只有队长那一列：队长提示词现在是 8367（Mac）／8427（Windows）字，超过了普通上限。要证明的是：当队长的 CLI 能把最长 10000 字的提示词一字不差收下并交给模型。其他 CLI 作为队员收到的提示词没有变化（普通提示词仍是 8000 字以上存文件，见第 7 节）。

### 6.1 一览：哪些已实证，哪些待 Windows

“CI Windows”是 GitHub Actions 的 Windows Server 2022／2025 虚拟机：原生 Windows、经 ConPTY，跑的是 AgentDeck 源码。它不是用户自己的 Windows 电脑，下表最后一列单独列出。

| 当队长的 CLI | 本机 Mac | CI macOS 14 | CI Windows Server 2022／2025 | 用户自己的 Windows 电脑 |
|---|---|---|---|---|
| 替身 agent（只测 AgentDeck → 终端这一段） | ✅ 键入、括号粘贴都逐字一致 | ✅ 同左 | ✅ 两台都逐字一致，粘贴标记完整 | **需在 Windows 机器上验证** |
| Claude Code（默认队长，各 Claude 席位） | ✅ 8367、10000 字逐字一致（2.1.291／2.1.294，假接口） | ✅ 同左（2.1.292／2.1.293） | ✅ 8427、10000 字逐字一致；200～10000 五档全部一次提交（2.1.292／2.1.293） | **需在 Windows 机器上验证** |
| Codex（ChatGPT Relay 默认队长命令 `codex --no-daemon`） | ✅ 8367、10000 字逐字一致；五档全部一次提交（0.160.1／0.161.0） | ✅ 同左 | ❌ 任何长度都收不好，改动前的 7990 字原文也一样（见 6.3），不是这次改动造成的 | **需在 Windows 机器上验证**（CI 结果说明很可能同样有问题） |
| Cursor（本机登录，Auto 模型） | ✅ 10000 字里的 10 个代码，模型全部答对 | 未测（CI 没有登录） | 未测（CI 没有登录） | **需在 Windows 机器上验证** |
| agy（Gemini 3.8 Flash，本机登录） | ⚠️ CLI 收下并提交了整段（会话记录显示到最后一个代码和问题），但额度用尽，模型没有回答：没证到模型 | 未测（CI 没有登录） | 未测（CI 没有登录） | **需在 Windows 机器上验证** |
| DeepSeek 兜底 claude-ds | 未单独跑：脚本最后 `exec claude`，就是 Claude Code 本体，见 Claude Code 一行；单独跑要按量扣钱 | 不适用 | 不适用（仅 Mac） | 不适用（仅 Mac） |
| Grok CLI | 未测：用户订阅已取消 | 未测 | 未测 | 未测 |
| Codex 原生队长宿主（可选模式，`codex-captain-host.js`） | 未测 | 未测 | 未测 | **需在 Windows 机器上验证** |

### 6.2 逐条记录

每一行都是 AgentDeck 自己经真实窗口、真实 PTY（Windows 上是 ConPTY）发出，按队长提示词的发法（`inlineLimit: MainCore.BRIEFING_LIMIT`），对端把收到的与发出的比较：

| 机器 | 对端 | 进入方式 | 内容 | 发出 | 收到 | 结果 | 来源 |
|---|---|---|---|---|---|---|---|
| 本机 Mac（Darwin 24.6.0） | 替身·按行读 | 键入 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 逐字一致 | 本机 E2E（2026-10-08） |
| 本机 Mac（Darwin 24.6.0） | 替身·记录原始字节 | 括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 逐字一致，粘贴标记完整 | 本机 E2E（2026-10-08） |
| CI macOS 14（Darwin 23.6.0） | 替身（两种） | 键入／括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2022（10.0.20348） | 替身·按行读 | 键入 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2022（10.0.20348） | 替身·记录原始字节 | 括号粘贴 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 逐字一致，粘贴标记完整 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2025（10.0.26100） | 替身·按行读 | 键入 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2025（10.0.26100） | 替身·记录原始字节 | 括号粘贴 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 逐字一致，粘贴标记完整 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| 本机 Mac（Darwin 24.6.0） | 真实 Claude Code 2.1.291／2.1.294（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 模型请求里逐字一致 | 本机 E2E（2026-10-08） |
| CI macOS 14（Darwin 23.6.0） | 真实 Claude Code 2.1.292（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 模型请求里逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2022（10.0.20348） | 真实 Claude Code 2.1.292（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 模型请求里逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2025（10.0.26100） | 真实 Claude Code 2.1.292（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8427／10000 | 8427／10000 | 模型请求里逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| 本机 Mac（Darwin 24.6.0） | 真实 Codex 0.160.1／0.161.0（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 模型请求里逐字一致 | 本机 E2E（2026-10-08） |
| CI macOS 14（Darwin 23.6.0） | 真实 Codex 0.160.1（假接口） | 括号粘贴 | 首次提示词／10000 字 | 8367／10000 | 8367／10000 | 模型请求里逐字一致 | [run 37588169178](https://github.com/hjinhao066/agentdeck/actions/runs/37588169178) |
| CI Windows Server 2022（10.0.20348） | 真实 Codex 0.160.1 `--no-daemon`（假接口） | 括号粘贴 | 首次提示词 | 8427 | 0 | ❌ 进了输入框但一直没提交；中段被 Codex 识别成「[Pasted Content 2474 chars]」 | [run 37589124183](https://github.com/hjinhao066/agentdeck/actions/runs/37589124183) |
| CI Windows Server 2025（10.0.26100） | 真实 Codex 0.160.1 `--no-daemon`（假接口） | 括号粘贴 | 首次提示词 | 8427 | 0 | ❌ 同上（「[Pasted Content 2884 chars]」） | [run 37589124183](https://github.com/hjinhao066/agentdeck/actions/runs/37589124183) |
| 本机 Mac（Darwin 24.6.0） | 真实 Cursor 2026.10.01-e373342（本机登录，Auto） | 括号粘贴 | 10000 字中性文字，藏 10 个代码 | 10000 | 模型答出 10/10 | ✅ 整段到了模型（不是逐字比较） | 本机 E2E（2026-10-08） |
| 本机 Mac（Darwin 24.6.0） | 真实 agy 1.3.1（本机登录，Gemini 3.8 Flash） | 括号粘贴 | 同上 | 10000 | 模型未回答 | ⚠️ CLI 提交了整段，会话记录显示到最后一个代码和问题；随后报「Individual quota reached」，没证到模型 | 本机 E2E（2026-10-08） |

- Cursor 第一次用 Grok 4.7 模型跑时，Cursor 报「You're out of usage」，改用 Auto 模型后通过；输入框里显示「[Pasted text #1 +57 lines]」，是整段粘贴进去的。
- agy 前两次跑停在“是否信任这个文件夹”的启动对话框上（AgentDeck 按规则不往启动对话框里打字），测试里改为替它确认后，第三次提交成功，但 Gemini 额度已经用尽（状态行 0/100）。额度恢复后可用 `AGENTDECK_REAL_CLI=agy` 重跑。
- CI 的 Codex 第一次失败是 Codex 在管理员终端里拒绝启动共享后台服务；按 AgentDeck 的启动方式加上 `--no-daemon` 后（提交 c363d72），出现的就是下面 6.3 说的输入问题。

### 6.3 长度阶梯：区分“这次改动造成的”和“本来就有的”

同一台机器上，同一个 CLI，依次收 200 字、4000 字、改动前的 Windows 队长提示词原文（7990 字，取自 `64043df`）、现在的 Windows 队长提示词（8427 字）、10000 字。如果只有超过 8000 的才出错，就是这次提上限造成的；如果改动前的 7990 字也一样出错，就是本来就有的。

| 机器 | CLI | 200 | 4000 | 7990（改动前原文） | 8427（现在） | 10000 | 来源 |
|---|---|---|---|---|---|---|---|
| CI Windows Server 2022（10.0.20348） | Codex 0.161.0 | ❌ 收到 199（丢 1 个换行） | ⚠️ 首个回车被吞，再按一次后逐字一致 | ❌ 收到 7982（「——」一带错乱） | ❌ 收到 8418（同上） | ⚠️ 首个回车被吞，再按一次后逐字一致 | [run 37814857576](https://github.com/hjinhao066/agentdeck/actions/runs/37814857576) |
| CI Windows Server 2022（10.0.20348） | Codex 0.161.0（复跑） | ❌ 收到 199（丢 1 个换行，键入方式） | ✅ 一次提交，逐字一致 | ❌ 收到 7982（「——」一带错乱） | ❌ 收到 8418（同上） | ❌ 收到 9999（丢 1 个换行） | [run 37817639186](https://github.com/hjinhao066/agentdeck/actions/runs/37817639186) |
| CI Windows Server 2025（10.0.26100） | Codex 0.161.0 | ❌ 收到 199（丢 1 个换行） | ⚠️ 首个回车被吞，再按一次后逐字一致 | ❌ 收到 7981 | ❌ 收到 8417 | ⚠️ 首个回车被吞，再按一次后逐字一致 | [run 37814857576](https://github.com/hjinhao066/agentdeck/actions/runs/37814857576) |
| CI Windows Server 2025（10.0.26100） | Codex 0.161.0（复跑） | ✅ 一次提交，逐字一致 | ❌ 收到 3999（丢 1 个换行） | ❌ 收到 7982（「——」一带错乱） | ❌ 收到 8418（同上） | ⚠️ 首个回车被吞，再按一次后逐字一致 | [run 37817639186](https://github.com/hjinhao066/agentdeck/actions/runs/37817639186) |
| CI Windows Server 2022（10.0.20348） | Claude Code 2.1.293 | ✅ | ✅ | ✅ | ✅ | ✅ | [run 37814857576](https://github.com/hjinhao066/agentdeck/actions/runs/37814857576) |
| CI Windows Server 2025（10.0.26100） | Claude Code 2.1.293 | ✅ | ✅ | ✅ | ✅ | ✅ | [run 37814857576](https://github.com/hjinhao066/agentdeck/actions/runs/37814857576) |
| CI macOS 14（Darwin 23.6.0） | Codex 0.161.0／Claude Code 2.1.293 | ✅ | ✅ | ✅ | ✅ | ✅ | [run 37814857576](https://github.com/hjinhao066/agentdeck/actions/runs/37814857576) |
| 本机 Mac（Darwin 24.6.0） | Codex 0.161.0 | ✅ | ✅ | ✅ | ✅ | ✅ | 本机 E2E（2026-10-08） |

- ✅ 表示 AgentDeck 一次回车就提交、模型请求里逐字一致。测试用 4 个 Codex 实例各 5 档，共 20 次，只有 2 次是这样。
- **改动前的 7990 字原文在 Windows 上 4 次全错，和现在的 8427 字错法一样**（都在规则 5 的「——」一带错乱）。200 字、4000 字也会丢换行或吞回车。所以这不是这次把上限提到 10000 造成的，也和长度无关：Codex 在 Windows 上本来就收不全 AgentDeck 粘贴进去的提示词。
- 同一台 Windows 机器上，记录原始字节的替身逐字收到了同样的内容（含「——」和全部换行），Claude Code 五档全对。说明 AgentDeck 到 ConPTY 这一段没有问题，丢字发生在 Codex 自己的 Windows 输入处理里（推测与 ConPTY 把输入转成按键事件、Codex 自带的“快速输入当粘贴”判断有关，没有进一步验证）。
- 这个问题不只影响队长：同一条发送路径也用于派给 Codex 队员的普通任务（200 字也丢了换行）。建议另开一张卡单独处理；本卡没有改它。
- CI 的 Windows Server 虚拟机和用户的桌面环境可能不同（Windows 版本、终端组件、Codex 版本），所以这一结论还要在用户自己的 Windows 电脑上确认。
- 原始记录：CI 日志里每个 Windows 任务的 [ladder] 和 [ladder-diff] 行。诊断脚本在临时分支 `ci-probe/t-0e2ef693`（不合并），只在这次取证时用。

### 6.4 两类对端各证明什么

- 替身 agent（`tests/e2e/captain-briefing-paste.spec.js`，随 `npm run test:e2e` 跑）：把 stdin 收到的东西原样记下，证明 AgentDeck 到终端这一段不丢不乱。一个按行读（键入方式），一个像 Claude Code 那样要求括号粘贴并记录原始字节。
- 真实 CLI（`tests/e2e/real-cli-briefing.spec.js`，默认跳过）：`AGENTDECK_REAL_CLI=claude,codex` 时真实的 Claude Code／Codex 当队长，用空的配置目录，模型接口指向本机的假接口，不登录、不耗额度，逐字比较 CLI 自己发给“模型”的那段文字。`AGENTDECK_REAL_CLI=cursor,agy` 时用本机已登录的 Cursor／agy（只读，不加 --force 之类的放权参数，会用掉一点额度），发一段 10000 字的中性文字，第一行到最后一行藏 10 个代码，要求模型全部改小写回答：模型答全了，说明整段都到了模型。这一种不是逐字比较。

## 7. 测试

单测 `tests/captain-briefing-limit.test.js`（8 条）：

1. `LONG_PROMPT` 是 8000、`BRIEFING_LIMIT` 是 10000；Mac／Windows × 两种回执方式 × 并发上限 5／30／50，提示词加「读看板继续。」都在 10000 内。超限时的报错写明：调高上限并重新取证，不要删规则。
2. 省上下文重发的原文经真实的 `ChatUI.sendPrompt` 代码整段粘贴：不存文件，一次粘贴加一次回车，「读看板继续。」是最后一句。Mac、Windows 各两种回执方式。
3. 提示词正好 10000 字仍整段粘贴；10001 字才降级为文件指针。Mac、Windows 都测。
4. 普通提示词对每个 CLI（Claude、Codex、Cursor、agy、Grok、DeepSeek）都还是 8000 整段粘贴，8001、9618、10000 字存文件。
5. 全仓只有队长提示词的三处发送带更大的上限；排队逻辑读普通上限；源码里没有第二份数字。
6. DeepSeek 兜底说明的每个要点都在，Mac、Windows 两份。
7. 第 4 节四处限定条件和规则 1–17 的编号都在。
8. 各家订阅额度全部用尽时，DeepSeek 命令（带或不带 `--model opus`）仍判为可开，并通过模型检查。

E2E：

- `tests/e2e/captain-briefing-paste.spec.js`（5 条，随 `npm run test:e2e` 跑）：队长首次提示词、正好 10000 字的提示词，分别到按行读的替身和括号粘贴的替身，逐字比较；10001 字存文件且文件内容完整；普通提示词 8000 整段、8001 存文件。
- `tests/e2e/real-cli-briefing.spec.js`（4 条，默认跳过）：真实 Claude Code、真实 Codex 当队长（假接口），首次提示词和 10000 字提示词；真实 Cursor、agy（本机登录）10000 字带代码的文字。
- 原有的 `captain-token-saver.spec.js`、`captain-rebrief.spec.js`、`workspace.spec.js`：CI macOS 27 条全过（[run 37586823915](https://github.com/hjinhao066/agentdeck/actions/runs/37586823915)）；Windows 上 `captain-token-saver.spec.js` 两条和 `workspace.spec.js` 的拖文件夹一条失败，这三条在改动前的 main 上同样失败（[run 37543370164](https://github.com/hjinhao066/agentdeck/actions/runs/37543370164)）。本机 Mac 这三个文件 27 条全过（2026-10-08）。

单测：`npm test` 全量 1311 条，1298 过、0 失败、13 跳过（本副本没装依赖，借主仓库的 node_modules 跑）。

## 8. 自己复核

规则有没有丢：

```bash
mkdir -p /tmp/briefing-base && git archive 64043df main-core.js quota-core.js claude-seats-core.js | tar -x -C /tmp/briefing-base
node -e '
const base = require("/tmp/briefing-base/main-core.js"), now = require("./main-core.js");
for (const p of ["darwin", "win32"]) for (const legacy of [false, true]) {
  const cur = now.instructions(p, "", legacy).split("\n"); let j = 0, missing = 0;
  for (const line of base.instructions(p, "", legacy).split("\n")) { const k = cur.indexOf(line, j); if (k < 0) missing++; else j = k + 1; }
  console.log(p, legacy ? "legacy" : "background", "missing lines:", missing, "chars:", cur.join("\n").length);
}'
```

10000 字能不能收全（在要验证的那台机器上跑，Windows 用 PowerShell 时把变量写成 `$env:AGENTDECK_REAL_CLI = "claude,codex"`）：

```bash
npx playwright test tests/e2e/captain-briefing-paste.spec.js
AGENTDECK_REAL_CLI=claude,codex npx playwright test tests/e2e/real-cli-briefing.spec.js
```

每条通过的用例都会打印一行 `[briefing-paste]` 或 `[real-cli]`，写明平台、系统版本、CLI 版本、发出和收到的字数。

## 9. 已知边界和没有验证的部分

- **用户自己的 Windows 电脑：以上所有 CLI 都需在 Windows 机器上验证。** 在那台机器的仓库里（PowerShell）：`npx playwright test tests/e2e/captain-briefing-paste.spec.js`，然后 `$env:AGENTDECK_REAL_CLI = "claude,codex,cursor,agy"; npx playwright test tests/e2e/real-cli-briefing.spec.js`。CI 的 Windows Server 虚拟机是原生 Windows，但不是用户的桌面环境。
- Codex 在 Windows 上收不全提示词（6.3）：改动前就有，本卡没修，建议另开卡。修好之前，Windows 上用 Codex 当队长（ChatGPT Relay）时，队长提示词会被改字或停在输入框里，改动前的 7990 字也一样。
- agy：模型层面没证到（额度用尽），额度恢复后用 `AGENTDECK_REAL_CLI=agy` 重跑。
- Cursor、agy 只在本机 Mac 上测过，CI 上没有登录不能测。
- Grok CLI、Codex 原生队长宿主没有测；claude-ds 没有单独跑（就是 Claude Code 本体）。
- 全量 E2E 没有跑，只跑了和这次改动相关的文件。

## 10. 1.6 集成补充

上面的逐行基线对照、字符数及定向 E2E 结果记录的是 `3959659` 独立审查时的状态。
1.6 同时合入「待我处理」：队长提示词的一条命令从 `notify-user` 改为 `inbox`，
保留原有处理规则并指向新的汇总入口。因此与 `64043df` 相比不再只有新增行。
集成后，默认并发上限 30 时，Mac 的后台／旧回执方式提示词分别为 8369／8070 字，
Windows 分别为 8429／8130 字；加上省上下文的「读看板继续。」分别为
8377／8078／8437／8138 字，仍在 10000 字上限内。
`tests/captain-briefing-limit.test.js` 在组合后的提示词上继续验证两种平台、两种回执方式、
并发上限 5／30／50 以及 10000／10001 字边界；1.6 的全量测试结果见发布报告。

## 11. 待我处理只放大白话问题（卡片 t-4605c6a8）

只改了一行：第 2 条命令清单里 `inbox need|report|resolve` 那一行，原文一字不动，在末尾追加一句：need 的 `--ask` 写一句明确的问题、`--options` 给快捷回复；卡片停在需要你或挂起时程序不替队长问用户，由队长判断要用户定才登记并带 `--card`，回执原文放 `--detail`。没有删改任何其他行。
默认并发上限 30 时，Mac 的后台／旧回执方式由 8775／8476 字变为 8884／8585 字，Windows 由 8843／8544 字变为 8952／8653 字；加「读看板继续。」后最长 8960 字，仍在 10000 字上限内。

## 12. 待我处理分两栏（卡片 t-71466b2b）

只改了一行：同一条 `inbox need|report|resolve` 命令行里，「向用户汇报的结论都 report」后面加了括号说明「挂到本轮回复，用户在对话里看过即算已读，结论也要在回复里说」（31 字）。没有删改任何其他行。
默认并发上限 30 时，Mac 的后台／旧回执方式由 8923／8624 字变为 8954／8655 字，Windows 由 8991／8692 字变为 9022／8723 字；加「读看板继续。」后最长 9030 字，仍在 10000 字上限内。`inbox help` 另加一行同样的口径。

## 13. 拆成「短核心 + 按需读的规范文件」（2.0.1，卡片 t-9f9b6f77）

第 1–12 节记录的是整份提示词一次贴完的做法，数字都是当时的。2.0.1 起：

- 每次注入的只有核心提示词（`MainCore.instructions()`）：身份、十条红线、每条命令一行、「做 X 前先读 Y」清单、结尾段。上限 `MainCore.CORE_LIMIT` = 2500 字，由 `tests/captain-briefing-limit.test.js` 和 `tests/captain-rules.test.js` 卡住。默认并发上限 30 时 Mac 后台回执 2332 字、Windows 2336 字；旧回执注入 2272／2276 字。
- 其余规则原文搬进 `docs/captain/` 的九个文件（models、dispatch、review、inbox、sessions、capacity、release、handoff、commands），用 `briefing --topic 名` 读。规则 2–17 保留原编号。逐条去向见 `~/reports/agentdeck-captain-prompt-slim/mapping.md`（本机报告，不进仓库）。
- 一次粘贴上限 `MainCore.BRIEFING_LIMIT` 仍是 10000，三处发送仍带 `inlineLimit`，第 6 节的取证继续有效；核心提示词远低于普通上限 8000，实际已用不到这个例外。
- AgentDeck 重启后，原会话续上的队长只收一条短通知（`MainCore.restartNotice`，约 230 字），不重贴提示词；新上下文（新建、清空、Relay）才贴核心。
- 超限时的做法变了：不是调高上限，而是把不是每一轮都要守的规则挪进规范文件、在触发清单里加一行。规则仍然一条不能删。

