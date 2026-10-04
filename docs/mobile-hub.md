# 手机总台（`mobile-web/hub/`）

一组静态文件（`index.html`、`core.js`、`app.js`、`style.css`、`machines.json`），部署在手机入口的根路径。页面本身没有数据和密钥，只同源请求每台电脑自己的前缀（`/mac/…`、`/win/…`），接口契约见三端方案 2.2 节。旧的 `mobile-web/` 不变，继续供本机直连和回滚。

## 行为

- **五种状态**：先请求无需登录的 `api/info`：200＝新版，再请求 `api/snapshot`（200＝在线，401＝需要登录）；`api/info` 返回 401 或 404＝旧版，显示「需要升级」，不出登录框。两个请求都适用：502 加 `{"offline":true}`＝离线；8 秒超时＝无响应（可能在睡眠）。机器在线期间不再重复探测，快照失败后下一轮重新探测。契约以外的结果（其他状态码、不带 `offline` 的 502、手机断网）显示「连接异常」，同样不能派活。
- **派活**：每条消息只发往「发给」里选中的那台电脑。两台都在线时默认 Mac；顶栏选了某台电脑，目标跟着变。目标离线、无响应、未登录、需升级或队长未启动时，发送按钮禁用并写明原因，**不会改发另一台**。发送失败的消息留在对话里，点铅笔放回输入框。
- **登录**：每台电脑各自登录，token 只用 JSON POST 发往该电脑的前缀，页面不保存。退出一台不影响另一台；退出类图标要点两次。
- **本地存储**：只有主题、所选电脑，以及每台电脑的元数据（最后在线时间、会话数、干活数、队长状态、主机名、版本）。对话、回执、输出、看板和草稿都不落盘。
- **轮询**：页面可见时，选中的电脑每 5 秒、其余 15 秒、连不上的 30 秒；刷新按钮立即拉取全部。
- **看板**：按卡片 `updated` 合并两台的结果，用 `dispatch_claim.owner` 对主机名标出领取的电脑。

## 增删电脑

改 `machines.json`：`id` 为小写字母数字，`basePath` 必须是 `/<id>/`，`default: true` 的那台是默认派活目标。

## 本地试用和测试

```
node tests/fixtures/hub-proxy.js          # 假的 Caddy 加两台假电脑，打印地址和测试 token
node --test tests/mobile-hub.test.js
AGENTDECK_HUB_SCREENSHOT_DIR=<目录> npx playwright test tests/e2e/mobile-hub.spec.js --workers=1
```

`tests/fixtures/hub-proxy.js` 只在本机 loopback 上运行，不连接真实的 AgentDeck、VPS 或共享看板。
