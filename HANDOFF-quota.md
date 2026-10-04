# HANDOFF：手机网页端额度 + 侧边栏（feat/mobile-quota）

- worktree：`/Users/jinhao/agentdeck-mobile-quota`，分支 `feat/mobile-quota`，基线 `10307cb`（origin/feat/mobile-nav-image）。
- 状态（2026-10-04 重启前）：**只完成了调研和方案，还没有任何代码改动**。本文件是唯一提交，做完后删掉。

## 已确认的事实

- 额度数据在渲染进程 `config.quotas`，桌面侧边栏 `renderQuotaBar()`（renderer.js ~3642）用 `QuotaCore.items()` + `QuotaCore.summary()` 出每行（`cells` 5h/7d、`out`、`recoveryAt`、`sampledAt`、`stale`、`account`、`shortText`）。队长 CLI 的 quota 走 `QuotaCore.text()`，同一份数据。
- 手机端数据通道：`mobile-web.js` → `main.js requestMobile(op)` → `renderer.js window.deck.onMobileRequest`（~3206，现有 op：sessions / output / captain-history / captain）。
- 邮箱打码：`claude-seats-core.js maskEmail`（`h***@gmail.com`）；`quota-codex.js` 是两位前缀 `hj***@`，手机接口要统一再打一次。
- 会话的项目在 `col.project`；桌面版本号是 `env.version`；队长席位用 `claudeCaptainSeatId()`，非 Claude 队长按 `agentProvider` 匹配。
- 桌面侧边栏结构：`#navTop`（队长等入口）/ `#navList`（队长行 + 队员分组）/ `#navQuota`（额度，标题 + 刷新图标 + `#quotaBar`）/ `#navBottom`（版本号）。相关样式 style.css 103–252、321–382、2452–2459；状态色 `--st-*`，额度色 `--quota-*`，皇冠 `#e0a91c`。

## 方案（未动手）

1. `quota-core.js` 加纯函数 `mobile(store, now, seats, captainSeatId, captainProvider)`：每行只出白名单字段（key、label、short、captain、cells、out、recoveryAt、sampledAt、stale、failed、state、account 已打码、note），不含 configDir / token / detail。`summary()` 需多带一个查询失败次数。
2. `renderer.js` 的 `onMobileRequest` 加 `op === 'quota'`，返回 `{ rows, version }`；sessions op 加 `project`。
3. `mobile-web.js`：构造参数加 `getQuota`；`GET /api/quota` 放在登录校验之后（和其他只读接口同样做法），服务端再按白名单过滤并重新打码邮箱。`main.js` 接上 `getQuota: () => requestMobile('quota')`。
4. 手机界面（mobile-web/）：
   - 左侧抽屉 `#drawer`（标题栏左上角菜单图标按钮打开、左缘右滑打开、遮罩/关闭图标/Esc 关闭、打开时 `#app` inert、焦点进出管理）。内容：队长入口行 → 按项目分组的会话列表（状态点）→ 底部固定额度区（标题 + 刷新图标按钮，每账号一行 5h/7d 百分比 + 重置时间 + 2px 进度条，点行展开详情；过高时本区滚动）→ 版本号。
   - 底部标签栏保留：对话 / 会话 / 看板 / 更多。「会话」标签改成打开抽屉（保留等你处理的角标），不再有单独的会话列表页，避免两处重复同一个列表；看队员输出时「会话」标签高亮。回执里要说明这个取舍。
   - 「更多」页只留一个「额度」入口行（打开抽屉并滚到额度区）。
   - 对话页标题旁小指示 `#seat-chip`（如「CN 26%」，<10% 橙、用尽红、过期/未知灰），点击打开抽屉并滚到额度区，不增加标题栏高度。
   - 视觉取桌面 token：rail 背景、hairline、`--st-*` 状态点、`--quota-*`、7px 圆角行；深浅主题都做。
5. 测试：`tests/quota-core.test.js`、`tests/mobile-web.test.js` 补单测（未登录 401、邮箱打码、无敏感字段）；`tests/e2e/mobile-web.spec.js` 改原会话页相关断言，补抽屉、额度区渲染、用尽/过期/未知三态；单 worker 跑。清掉 `AGENTDECK_*` 变量再跑（用 bash 包装脚本逐个 unset）。
6. 截图到 `/Users/jinhao/reports/agentdeck-mobile-quota/`：390×844、430×932 × 深浅主题，含用尽和数据过期，另加「桌面侧边栏 vs 手机侧边栏」对照。

## 下一步

从方案第 1 步开始写代码。红线不变：不合 main/release、不打包安装重启、不连 VPS、不动现役配置、不开 Claude 子 agent。做完推送并用 board CLI 发完成回执（做了什么、commit、测试通过数、截图目录、会话标签取舍的理由）。
