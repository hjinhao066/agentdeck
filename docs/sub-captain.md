# 小队长（sub-captain）

一个项目要长期多线并行时，队长（下称总队长）可以开一个「小队长」：它统筹这个项目，
自己开子会话分头干活。子会话的回执、提问、停在确认提示，都只进小队长的 `receipts`，
不再涌到总队长那里；总队长只收小队长自己的阶段汇报和它上报的问题。

## 总队长怎么开

```
node "$AGENTDECK_BOARD_CLI" new --sub-captain --project "秋招" --title "秋招小队长" --task "目标、范围、验收标准；阶段结果用 complete 汇报"
```

- `--sub-captain` 只有总队长能用，必须带 `--project`。其余参数和普通 `new` 一样
  （`--agent`、`--command`、`--cwd`、`--worktree`、`--task-id`、`--priority`…），
  只是不能用 `chatgpt-web`（网页会话没有终端，开不了子会话）。
- 带 `--task-id` 绑看板卡片时：小队长平时的 `complete` 是阶段汇报，不动卡片；
  只有 `complete --final` 算最终交付，卡片才完成（带 `--verify` 的卡这时进待验收、开审查轮）。
- 程序把「小队长规则」接在任务正文后面一起发过去：怎么开子会话、怎么挂回执监听、
  怎么汇报。重启续接时规则跟着任务一起恢复。

## 小队长能用的命令

小队长的终端拿到一枚**受限**的控制令牌：只认下面这些命令，而且只对它自己用
`create-child` 开的子会话有效；对别的会话、对总队长一律拒绝（「不是你开的子会话」）。

| 命令 | 作用 |
|---|---|
| `create-child --title "…" --task "…" [--agent …\|--command "…"] [--cwd 目录]` | 开子会话，立刻返回子会话 id，不等它做完。不写 `--agent` 就用小队长同款模型。照常受全局并发上限，满了自动排队。 |
| `receipts [--wait] [--timeout 秒]` | 取自己子会话的回执、提问、确认提示。始终恰好挂一个 `receipts --wait`。 |
| `ledger` | 只列自己的子会话（含已归档、排队中的）。 |
| `tell` / `peek` / `read` / `answer` / `stop` / `archive` | 和总队长的用法一样，只能对自己的子会话。 |
| `complete` / `ask` / `progress` | 向总队长汇报。小队长的 `complete` 可以多次，每次都作为阶段汇报送到总队长，不动看板卡片；绑了卡片的最终交付用 `complete --final`。`ask` 也随时能问。 |

`new`、`task`、`inbox`、`notify-user`、`queue`、`settings`、`briefing`、`handoff`、
`discuss`、`receipts --snapshot/--ack` 都只有总队长能用。

## 回执怎么走

- 子会话的命令回执、提问、停在确认/权限提示、「已结束，未提交回执」、长时间无输出、
  额度用尽、进程退出、「待补充」排队超时，全部进小队长的 `receipts`。
  不管这条指令是小队长发的还是总队长直接 `tell` 的，回执都归小队长。
- 子会话的列已经被关掉，或者还在排队、没开出来就失败了，这条失败回执也照样给小队长
  （按派活记录上的 `subCaptainId` 认）。
- 子会话的派活卡片显示在小队长的对话里，不在总队长的对话里。
- 兜底：小队长的 `receipts --wait` 不在（重启后它跟着终端没了，或者模型忘了重挂），
  子会话回执等了 3 分钟、小队长又空着时，程序往小队长终端里打一句提醒，让它取回执、重挂监听
  （输入框里有用户没发的字就不打）；10 分钟还没人取，给总队长发一条「小队长 X 有 N 条子会话回执
  M 分钟没取」。每堆回执各提醒一次，取走后重新计。
- 小队长自己的回执、提问照常进总队长的 `receipts`。

## 总队长看到什么

`ledger` 里子会话缩进在小队长下面，小队长那行写着子会话个数和「子会话回执待它取」的条数：

```
c-board-aaa  「秋招小队长」  已完成  小队长·子会话 2 个·子会话回执待它取 1 条  项目:秋招
  └ c-board-bbb  「Lenovo 简历」  干活中  项目:秋招
  └ c-board-ccc  「合并去重」  已完成  项目:秋招
      回执：…
```

总队长仍然可以直接 `peek`、`tell`、`read`、`answer`、`archive` 任何子会话。

侧栏「队长」下面，子会话嵌在小队长那一行下面、再缩进一格；小队长行左边的箭头（图标按钮，
有悬停提示和无障碍名称，键盘 Tab 到它按 Enter/空格）折叠、展开它的子会话，折叠状态会记住。

## 小队长结束时

- 小队长被归档（总队长 `archive`、手动归档、自动归档）或被关掉：**子会话不停**，全部交回总队长。
  总队长收到一条回执：「小队长「X」已归档。它开的 N 个子会话没有结束，已交回给你：…」，
  小队长还没取的子会话回执紧跟在后面一起转过来。之后这些子会话的回执直接给总队长。
  已归档的子会话也一并交回（以后 `tell` 恢复它，回执给总队长）。
- 还有活着的子会话，或还有子会话在排队等空位时，小队长不会被自动归档。
- 重启 AgentDeck 不影响分层：小队长重新拿到它的令牌，子会话仍归它，没取的回执还在。
  它的后台 `receipts --wait` 会随终端一起没掉，靠上面「兜底」的提醒重挂。

## 数据字段（给架构图等分层显示用）

都在渲染进程的列对象上（`columns` / `host.columns()`，已归档的在 `config.archived`），随 `config.json` 保存：

| 字段 | 在哪 | 含义 |
|---|---|---|
| `subCaptain: true` | 小队长的列 | 它是小队长。没有这个字段就是普通会话。 |
| `subCaptainId: "<小队长列 id>"` | 子会话的列 | 它归哪个小队长。交回总队长时这个字段被删掉。 |
| `subCrewCollapsed: true` | 小队长的列 | 侧栏里它的子会话被折叠（只是界面状态）。 |
| `subCaptainId` | `config.mainSession.tasks[]` 派活记录 | 这条派活卡片显示在哪个小队长的对话里。 |
| `subReceipts["<小队长列 id>"]` | `config.mainSession` | 小队长还没取的子会话回执。 |

取法：子会话 = `columns.filter((c) => c.subCaptainId === sub.id)`。只有当 `subCaptainId`
指向一个**还在的**、`subCaptain === true` 的列时才算分层；指向不存在的列就当普通会话。
架构图的 `crew-map.js` `collect()` 目前只抄了 `captainCrew`、`project` 等字段，要分层显示需在
columns 和 archived 两处各加 `subCaptain: c.subCaptain === true, subCaptainId: c.subCaptainId || ''`。

## 秋招试点怎么迁到正式小队长

试点「秋招小队长」是普通后台会话，没有控制令牌，所以 `create-child` 被拒，只能用会话内子 agent
或请总队长代开。迁法：

1. 总队长开正式小队长，接手试点日志：
   ```
   node "$AGENTDECK_BOARD_CLI" new --sub-captain --project "秋招" --title "秋招小队长" --task "接手秋招统筹。先读 /Users/jinhao/reports/autumn-recruit/captain-log.md，从最新一节接续；以后的子会话一律用 create-child 开，日志继续写在这个文件。阶段结果用 complete 汇报，要用户拍板用 ask。"
   ```
2. 试点会话：等它会话内的子 agent 做完，`tell` 它把交接写进 captain-log.md，然后总队长 `archive` 它。
3. 总队长替试点代开、还在跑的会话（P2-NC、待核池分拣、小红书、Glassdoor 等）不搬家，留在总队长名下
   做完（没有改归属的命令，也不需要：它们交回执后，总队长把结论 `tell` 给新小队长即可）。
   之后这条线上的新活都由新小队长 `create-child` 开。
4. `--project "秋招"` 保持和以前一样，看板、架构图里同一个项目。
