# HANDOFF — feat/mobile-nav-image（WIP，未完成）

- worktree：`/Users/jinhao/agentdeck-mobile-nav-image`，基线 origin/release/1.1.5 (443ef19)。`node_modules` 是指向 `~/agentdeck/node_modules` 的符号链接，勿提交。
- 截图目录：`/Users/jinhao/reports/agentdeck-mobile-nav-image/`（before-* 已出；after-* 还没正式出）。截图脚本在其中 `harness/`（fake.js 起假数据服务，无需 Electron；`node after.js <worktree> <输出目录> [one]`，用 CDP `Emulation.setSafeAreaInsetsOverride` 模拟 iOS 安全区）。

## 已做（代码写完，仅用假数据截图目测过，未跑任何测试）
- 底部问题根因：输入框下方只有 42px 空白（8px + 安全区），没有任何入口，所有导航藏在左上角抽屉里；没有色差问题。
- 标签栏：对话 / 会话（等你处理角标）/ 看板 / 更多（深色模式开关、退出）。抽屉已删。键盘弹起时标签栏隐藏（`keyboard-open`：输入框有焦点且可视高度比同宽度下最高值矮 120px 以上）。
- 发图：`POST /api/upload`（octet-stream，一次一张，按文件头认 JPEG/PNG/GIF/WebP，4MB，服务端生成 32 位 hex 文件名，落 `userData/mobile-uploads`，0600）、`GET /api/image?id=`、`POST /api/captain` 新增 `images`（≤6 个 id）。图片路径经 `MainSession.sendMessage(message, images)` → `sendWhenReady(..., { atts })` → `ChatUI.sendPrompt` 的附件路径，与桌面贴图同一方式。前端：选图/拍照/粘贴、缩略图、单张移除、上传进度、失败重试、对话里显示已发图片。大图和 HEIC 在前端用 canvas 转 JPEG（最长边 1600）。
- 服务端 `requestTimeout` 仍是 10 秒，没有放宽。

## 下一步
1. `tests/mobile-web.test.js` 补上传单测：未登录 401、缺 CSRF 403、错 Origin 403、非图片/HEIC 415、超大 413、文件名服务端生成、`/api/image` 鉴权与非法 id、目录内符号链接 404、captain `images` 超 6 张/重复/不存在 400、空文字带图可发、过期清理。
2. 重写 `tests/e2e/mobile-web.spec.js`：所有 `打开会话列表`/抽屉/`切换主题`/`返回队长对话` 的断言已失效（返回按钮现在叫「返回」，主题是「更多」页的 `#theme` 开关，退出在「更多」页）；补标签栏切换、角标、键盘弹起隐藏、选图/粘贴/移除/发送、上传被拒。键盘用例要先让 `#message` 获得焦点再缩小视口。
3. 清掉 AGENTDECK_* 变量后跑 `npm test` 和该 e2e（单 worker）。
4. 更新 `docs/mobile-web.md`（布局段落、接口表、上传限制）。
5. 正式出 after-* 截图（两种尺寸 × 深浅），删本文件，提交、推送、发完成回执。

## 要在回执里明说的
- 真机 iPhone 没测过；HEIC 依赖浏览器自己能解码（iPhone Safari 可以，相册选图通常已自动转 JPEG），解不了的设备会提示换格式。
- 弱网下单张上传超过 10 秒会失败，需点重试。
