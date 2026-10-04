# HANDOFF：架构图 A 版（feat/arch-a）— 第 2 次交接（2026-10-04，额度暂停）

- worktree：/Users/jinhao/agentdeck-arch-a，分支 feat/arch-a，基于 main 95b7192（v1.1.6）
- origin/release/1.1.7 没动 crew-map*.js / style.css 架构图段，继续以 main 为底即可。
- 规格：/Users/jinhao/reports/agentdeck-arch-a/SPEC.md；参考图 design-A-dark-reference.png
- node_modules：worktree 里没有，跑测试前 `ln -s /Users/jinhao/agentdeck/node_modules node_modules`（别提交）。
- 进度：**源文件仍未改动**。本次重读了 crew-map-core.js、crew-map.js、style.css 1760–2155、index.html 118–172、
  renderer.js（showView 943 调 CrewMap.render；4050 CrewMap.init 宿主接口；applyTheme 设 html[data-theme]），
  以及 4 个 E2E（crew-map / -projects / -acceptance / -scifi）和 tests/crew-map-core.test.js。
- 本 commit 只有这份交接文件（WIP），合并前删掉它。

## 已拍板的设计决定（照做即可）
1. 布局（core.layout）：队长置顶居中；组内列数按视口宽度定：宽屏 3 列、中 2 列、窄 1 列（不再搜 1..N 列）；
   项目仍按货架打包但每排居中；卡片加宽（约 nodeW 288–300，nodeH 按内容约 150–170）；
   工人行间距缩到 ~20，审查行之前留 ~52（审查线横段要走这个缝）；组内边距 ~20。
2. 组内派出线：第 2 行起的卡片从左侧进入，**同一列共用一条竖向走线通道**（x = 卡片.x - gapX/2，去掉 lane 偏移），
   审查会话也走它左边最近的通道；同项目派出线允许共享（noSharedStretch 已放行）。
3. 非活跃项目 = 没有 working/input/queued 节点。默认收进**底部托盘**（放在 viewport 和图例之间的独立一行，不浮在画布上）：
   左侧展开箭头 + "非活跃项目 N 个项目（x 已完成 · y 失败）" + 每个项目一个 chip（有失败的 chip 红色并带 ✕数）。
   点 chip = 把该项目展开到画布（aria-pressed），再点收回；箭头 = 全部展开/收起。用户从托盘展开后平滑适应一次。
   collapsedProjects 仍是覆盖值；新增纯函数 reopenOnActivity(prevKeys, projects, overrides)：
   项目活跃节点集合出现新 id 时清掉覆盖值 → 自动重新显示，且**不改视角**。首轮渲染只记录不清除。
4. 画布：fit 抽成纯函数 computeFit(bounds, {w,h}, insets, {min,max})；首次进入自动适应一次（无动画）；
   之后实时结构变化不再 fit；窗口 resize 只有在用户没手动动过视角时才重新 fit；
   点「适应画布」/整理 → 平滑过渡（canvas 加 .cm-smooth，transform .32s，reduced-motion 关掉）。
   用户平移/缩放/按钮缩放置 userView=true，fit 后清零。
5. 控件挪到底部图例行右侧：[归档切换][整理] | [−][100%（点它回 100%）][+] | [⛶ 适应画布]（图标+文字）。
   需要改 E2E：acceptance/scifi 里 "controls 文字必须为空" 的断言，对 fit 和比例按钮放宽。
6. 卡片：顶行 状态图标+文字 / 模型徽章（host.renderBadge 保留品牌色）/ ··· 详情按钮；标题最多 2 行；回执 2 行；
   live 行（实时活动，refresh() 原地更新）；底部 时钟+时间、✓ 已交回。点卡片仍打开真实终端（保留现有交互和测试）；
   ··· 打开详情浮层（放在 viewport 里不随缩放，靠近卡片、夹在视口内；含完整回执、文件、实时行、「打开终端」；
   Esc/外部点击/× 关闭；refresh 时若打开则更新内容）。失败卡片右下加红色「查看」按钮 → 打开同一详情浮层。
   不要编造参考图里的"N 人协作"。状态文字保留现有 干活中/待补充/排队/已完成/失败/已停下（测试依赖）。
7. 管道：细蓝线（暗 ~#4C7EF0，执行中更亮 #7AA5FF；亮 #2563EB），圆角沿用 rounded()；
   流动改成少量圆点光点：stroke-dasharray "0.1 260" + round cap + 宽 4，约 6s 一圈，只给执行中线路；
   已结束线路静止且更淡；审查 = 紫色虚线，routes 给审查线加 st-<审查者状态>，只有 st-working 才流动。
   悬停卡片：svg 加 .cm-hovering 淡化其它线，给 data-from/data-to=该 id 的线加 .hl，并叠一条该卡完整派出 points 的高亮路径。
   光晕收敛：暗色 halo 透明度 ~0.12，亮色不要 halo。
8. 主题变量（#crewMap）：
   暗：画布 #0C1016、卡片 #151A22、标题 #E8ECF2、辅助 #9AA4B2、弱 #7D8696、边框细灰蓝、
       运行 #F5B83D、完成 #3DD68C、失败 #F07178、队长紫 #A78BFA。
   亮：画布 #F6F7F9、卡片 #FFFFFF、标题 #182230、辅助 #475467、弱 #667085、
       运行 #B54708、完成 #067647、失败 #B42318（失败卡底 #FEF3F2）、队长紫 #6941C6（队长底 #F4F0FF）。
   点阵极淡；去掉队长 aurora 动画、工作卡顶部扫描光、项目框 backdrop-filter（性能）；
   项目框保留极淡色相区分（acceptance 断言两组背景/边框不同）。scifi 测试里 glass(blur) 断言要随之删掉。
9. 测试：单测补 布局列数/托盘分组/reopenOnActivity/computeFit；E2E 补 主题切换、托盘展开收起、适应画布、
   实时更新保留视角（改 MainSession 状态后 CrewMap.view() 不变）。单 worker：
   `npx playwright test tests/e2e/crew-map*.spec.js --workers=1`，再 `npm test`。
10. 截图：AGENTDECK_CREW_MAP_SHOTS=/Users/jinhao/reports/agentdeck-arch-a/shots 跑 acceptance；
    报告写 /Users/jinhao/reports/agentdeck-arch-a/report.md；提交推送 feat/arch-a（不合 main、不打包、不重启）；
    最后按原要求用 $AGENTDECK_BOARD_CLI complete 回执。

## 下一步（从这里接着做）
按 1→9 顺序改 crew-map-core.js → crew-map.js → index.html（控件挪到 .cm-legend 右侧、加托盘容器）→ style.css 架构图段 → 测试 → 截图 → 报告。
