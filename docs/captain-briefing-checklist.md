# 队长提示词：10000 字上限与规则对照清单

基线：`64043df`（release/1.5，改动前）。本清单由脚本逐行比对基线与改动后的 `MainCore.instructions()` 输出生成，四种组合（Mac／Windows × 后台回执／旧回执注入）全部比对。

## 结论

- 原有规则一行没删、一个字没改：四种组合共 260 行基线文本，逐字原样保留 260 行，缺失 0 行，顺序不变。这次没有做任何压缩改写，所以不存在“等义不等义”的判断。
- 只新增两行，都是 DeepSeek 兜底说明（见第 3 节）。
- 一次粘贴上限由 8000 提到 10000（`MainCore.LONG_PROMPT`，全仓唯一一处）。

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
| 36 | 规则 16 | 16. 重要的活完成后，派 Gemini 3.8 Flash 验收：… | 112 | 112 | 原样保留 |
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

## 5. 与 8000 有关的地方

| 位置 | 原来 | 现在 |
|---|---|---|
| `main-core.js` `LONG_PROMPT` | 没有（数字散在两处） | `10000`，唯一定义；另加 `SAVER_RESUME`（省上下文清空后追加的「读看板继续。」） |
| `chat-ui.js` `sendPrompt` | `const LONG_PROMPT = 8000`，超过就存文件、只发指针 | 读 `MainCore.LONG_PROMPT` |
| `main-session.js` `enqueue`（排队的活） | `body.length > 8000` 先存文件 | 读 `M.LONG_PROMPT` |
| `main-session.js` 省上下文重发 | `briefingText() + '\n\n读看板继续。'` | `briefingText() + M.SAVER_RESUME`，文字不变 |
| `main-core.js`、`main-session.js` 注释 | 写着 8000 | 改为指向 `LONG_PROMPT` |
| `README.md` 三处 | 8000／8,000／“会超出上限” | 10,000，并写明常量名 |
| `tests/main-core.test.js`、`task-priority.test.js`、`launchers.test.js` | 断言 `<= 8000` | 断言 `<= M.LONG_PROMPT` |
| `tests/paste-image-prompt.test.js` | 按 `const LONG_PROMPT = 8000;` 截取源码 | 改截取锚点，替身环境带上 `MainCore` |
| `tests/queue-dispatch.test.js` | 9000 字触发存文件 | `M.LONG_PROMPT + 1` 字 |
| `tests/e2e/workspace.spec.js` | 9618 字的“超长消息” | 12018 字（否则新上限下不再存文件） |

没有动、也不该动的 8000：手机端单条消息上限（`mobile-web.js`、`main-session.js` 的 `sendMessage`／`mobileMessages` 校验、`mobile-web/` 页面的 `maxlength`、`docs/mobile-web.md` 及其测试）。那是手机接口的输入校验，不是粘贴上限；8000 字以内的手机消息在新上限下照样整段粘贴。其余 8000 都是毫秒超时。

## 6. 单测

`tests/captain-briefing-limit.test.js`（新增，7 条）：

1. 上限是 10000；Mac／Windows × 两种回执方式 × 并发上限 5／30／50，提示词加「读看板继续。」都在上限内。超限时的报错写明：调高 `LONG_PROMPT`，不要删规则。
2. 省上下文重发的原文（提示词 + 「读看板继续。」）经真实的 `ChatUI.sendPrompt` 代码整段粘贴：不存文件，一次粘贴加一次回车，结尾段和「读看板继续。」是粘贴内容的最后一句。Mac、Windows 各两种回执方式。
3. 提示词长到正好 10000 字仍整段粘贴；10001 字才降级为文件指针（此时粘贴内容里没有「读看板继续」，全文在文件里）。Mac、Windows 都测。
4. `chat-ui.js` 和排队逻辑都读同一个常量，源码里没有第二份数字。
5. DeepSeek 兜底说明的每个要点都在，Mac、Windows 两份。
6. 第 4 节四处限定条件和规则 1–17 的编号都在。
7. 各家订阅额度全部用尽时，DeepSeek 命令（带或不带 `--model opus`）仍判为可开，不排队，并通过模型检查。

把 `LONG_PROMPT` 改回 8000 复跑，上面第 1–3 条和三个旧文件里的长度断言共 6 条失败，说明这些测试确实卡在这个数上。

## 7. 自己复核

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

`git diff 64043df -- main-core.js` 里，规则文本只有新增行，没有删除行。

## 8. 已知边界和没有验证的部分

- 没有在真实 Claude Code／Codex 终端里粘贴 10000 字实测（仓库约定真实 CLI 冒烟要用户明确要求并用隔离配置）。依据是：AgentDeck 自己的输入通道上限是 100 万字符；现有 7990 字的提示词早已走同一条“大段粘贴”路径；新提示词只比它长约 440 字。
- E2E 只跑了覆盖这次改动的三个文件：`tests/e2e/workspace.spec.js`（含改过长度的超长消息用例）、`captain-token-saver.spec.js`、`captain-rebrief.spec.js`，27 条全部通过。全量 E2E 没有跑。
- 自动验收（`--verify`）遇到 DeepSeek 执行会话：命令不带 `--model` 时程序认不出它是哪家模型，卡片会停在 review 并写明原因，需要队长手动派审查（规则 13 已有这个分支）；带 `--model opus` 时按 Anthropic 家族处理，审查者从 Google／OpenAI 里选。这是现有行为，本次没有改。
- `claude-ds` 本身是否可用、`--model opus` 是否映射正确，以共享记忆为准，本次没有启动它。
