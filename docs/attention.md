# 待我处理

桌面侧边栏与手机总台都有「待我处理」。上面是只有用户能做的事（拍板、登录或授权、付款、回答、验收卡住），下面是结果汇报；各组里新条目在前，已完成默认折叠。侧栏与手机标签的角标是未完成的「要你处理」加未读汇报，不是全部条目数。条目大部分在屏上停留 1.5 秒算已读，读过的待处理事项仍留在角标里。

## 登记和解决

只有队长的终端能执行 `inbox` 控制命令，队员不能代替队长登记。使用运行中应用提供的 CLI：

```sh
node "$AGENTDECK_BOARD_CLI" inbox need --type decide --title "迁移旧数据要你拍板" --ask "回复迁移或保留旧库" --project example --card t-example --detail "两种方案的取舍" --files /absolute/path/report.md
node "$AGENTDECK_BOARD_CLI" inbox report --title "迁移预检已通过" --project example
node "$AGENTDECK_BOARD_CLI" inbox list
node "$AGENTDECK_BOARD_CLI" inbox list --all
node "$AGENTDECK_BOARD_CLI" inbox resolve --id at-example-1234 --note "用户已口头确认"
```

`need` 的 `--type` 支持 `decide|login|pay|question|review|other`，默认 `other`。登记可带项目、卡片、会话、细节和文件路径；引用的卡片或会话必须存在。标题最多 300 字、要用户做的事 1000 字、细节 8000 字、文件 20 个；超限拒绝登记，长证据放在文件里。`notify-user --message` 也登记一条待处理事项。新登记的 need 使用本机提醒；`--urgent` 仅用于需用户亲自登录、授权或付款的阻塞，沿用 Bark 提醒规则。

看板的「需要你」与验收 held 卡自动出现。队长为同一张卡登记 need 后，替换看板派生条目。每次重新进入「需要你」是新的一条。

用户逐条回复后，该条自动打勾归到「已完成」；回复连同原标题、当时请用户做的事、条目 id 与项目/卡片/会话引用，通过回执渠道交给队长。看板派生的提问走看板 answer 路径，卡片回到进行中。用户也可点「已处理」或「知道了」，汇报可「全部知道了」；已完成可放回待处理。点击已处理会告知队长，勾掉看板派生条目本身不改卡片。

关联卡片完成或归档会勾掉 need（不会自动勾掉汇报）；看板派生条目不再等用户、登记时等回答的会话后来已答复，也会自动勾掉。旧的手写队长决定文件不会自动导入，需队长逐条登记。

## 存储与手机接口

规则在 `attention-core.js`，桌面接线在 `attention-ui.js`。每台电脑将数据写在私有 `userData/config.json` 的 `attention` 字段，不进入代码仓库；未完成永不删，已完成保留最近 200 条。手机总台合并两台在线电脑的列表，每条操作只发往所属电脑；旧的单机手机页面没有这个标签。

`GET /api/attention` 返回逐字段清理的 items 和 counts，不暴露内部回执 id 或派生 key。`POST /api/attention` 仅允许以下载荷，沿用登录、同源与 CSRF 校验：

```json
{ "op": "read", "ids": ["at-example-1234"] }
{ "op": "reply", "id": "at-example-1234", "text": "保留旧库" }
{ "op": "done", "id": "at-example-1234" }
{ "op": "reopen", "id": "at-example-1234" }
```

回复最多 4000 字，一次已读最多 100 个 id。没有队长时拒绝回复，不勾掉原条目。手机请求失败会在该条下面显示原因，并保留草稿。

## 验证

持全机 `/tmp/agentdeck-test.lock` 后，单独运行 `tests/e2e/attention.spec.js` 与 `tests/e2e/mobile-hub-attention.spec.js`，以及相关 `attention-core`、`mobile-*`、`main-core`、`board-cli` 和加载 `main-session` 的单测。桌面使用独立 profile 的任务库和普通 shell 队长，手机使用 loopback 代理与两台假电脑，不接触真实共享数据或已安装应用。设置 `AGENTDECK_ATTENTION_SHOTS` 为报告目录可生成桌面及手机截图。
