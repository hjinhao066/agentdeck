# 修复进度：看板写锁回收、手机端超时与重试去重（体检报告建议 2、4）

返工：草稿（8a1bd58，Haiku 4.5 所做）逐行复核后全部推翻重做，草稿的三个单测文件是自己模拟自己的空壳，已改写成测真代码的测试。

## 状态：全部完成

| 项 | 提交 | 证据 |
|---|---|---|
| ① 看板写锁回收 | 433a430 | `tests/task-board-stale-lock.test.js` 12 项；草稿上跑 6 项失败（抢活锁、删无主锁、两个写入者同时进锁），修后全过，Windows 也全过 |
| ② 手机端 15 秒超时「没连上，重试」 | 1532670 | `tests/e2e/mobile-web-timeout.spec.js` 3 项；改前 3 项全失败，改后 Mac、Windows 都 3/3 |
| ③ 重试去重（服务端按 key） | 48f6ab1 | `tests/mobile-web-deduplication.test.js` 9 项；草稿上 8 项失败，修后全过 |
| ④ E2E 送 Windows | 5ad802d | 2 个 spec 共 6 项全过（用 t-1d02d7dd 的新版 e2e-remote-win.js，旧版和别的任务共用 work 目录，跑到一半被换成别的提交） |
| ⑤ 图标按钮与深浅截图 | 1532670 | 重试/编辑/关闭均为图标按钮，E2E 断言 title、aria-label、44px、Tab 可达且有焦点框；截图在 /Users/jinhao/reports/agentdeck-fix-lock-mobile/ |

全量 `npm test`：1790 项，1777 通过，0 失败。

## 已知限制

- 看板锁：接管旧锁时若一个进程在「读到死锁记录」和「挪走」之间停住超过 1 小时（比如合盖睡眠），而期间那条接管记录已被清掉，仍有极小概率误挪新锁；挪完会核对，发现挪错会立即放回。
- 去重的 key 只记在内存里一天，桌面 AgentDeck 重启后忘掉。
- 旧版电脑（没有 send-dedupe）在总台上不带 key，仍是 8 秒超时和旧提示。
