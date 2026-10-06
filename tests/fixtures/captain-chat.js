// A 队长 conversation in the shapes the desktop really saves. A reply is read
// off the terminal screen after the TUI has drawn its Markdown as plain rows, so
// titles are bare lines, long items are wrapped onto indented rows, a table is
// rows of │ cells or "key: value" records, and terminal residue rides along:
// the echo of a prompt, the tail of a file diff, tool summaries, the scroll
// hint, the rating prompt. The texts are 队长's own replies about AgentDeck,
// with names and paths made neutral. Between the messages sit the dispatch cards.
const MIN = 60000;

const WHY = [
  '已按你说的换人：原来的会话已停，1.2.0 安装改由另一个会话处理，状态栏确认模型是对的。它的任务是停掉循环、查原因、修脚本、重装并重启。',
  '',
  '为什么一晚上没更新到 1.2',
  '',
  '- 昨晚一共出了三个版本：1.1.9、1.1.10、1.1.11。你记得的 1.1.11 是 23:48 装上的，也是现在在跑的版本。',
  '- 1.2.0 在凌晨 3:57 打好包，两轮终审都通过，4:01 开始安装，第一步就失败了。',
  '- 失败后安装脚本没有停，而是每十几秒重试一次，一直空转到今天上午 10:26，共两千多次。',
  '',
  '昨晚 21:00 到凌晨 4:00 做完的活（约 55 张卡）',
  '',
  '- AgentDeck 修复和功能：',
  '  - 重启后旧回执重发',
  '  - 派活前看额度自动换模型',
  '  - 看板拖到“进行中”自动开会话',
  '  - 自动验收闭环',
  '- AgentDeck 发版：Windows 升到 1.1.11；1.2.0 合入 9 条已审分支并打包。',
  '',
  '没做成的',
  '',
  '- Relay 交接重构：额度用尽，停在半路。',
  '- 任务看板视觉重做：会话没交回执就结束了，要重派。  Jump to bottom (click) ↓',
].join('\n');

// the tail of a file diff printed above the reply; its first row begins with "+"
const BUG = [
  '+已归档）；c-board-a1 永动机轮换跳过用尽席位 + 查 03:51–10:25 队长空转（卡',
  '        + t-de2b812b，报告 /Users/me/reports/agentdeck-perpetual-gap/report.md）',
  '        +；c-board-a2 安装脚本防死循环 + 结果核对 + 失败推手机（卡 t-5b22411e）。',
  '    144 +',
  '    145  ## 卡在哪',
  '    146  未处理回执和提问在 AgentDeck 中保留；额度用尽的会话保持原席位。',
  '    147',
  '',
  '你说得对，这是严重 bug，三件事都已经派出去了，现在 3 个会话在干活。',
  '',
  '1.2.0 为什么失败（已查明）',
  '',
  '凌晨第一次安装其实装成功了。但后台任务装完又把安装器重新拉起了一次，这次找不到已经用掉的暂存包，就判定失败，把刚装好的 1.2.0 回滚成了 1.1.11，然后不停重复失败。',
  '',
  '旧任务已停掉，脚本改成只执行一次、失败只恢复一次。预演和三项回归都通过了，现在正在重装1.2.0，装完 AgentDeck 会重启，我这边会断一下。1.1.11 和完整数据都留了备份。',
  '',
  '以后怎么防（在做）',
  '',
  '- 正式安装脚本最多试 3 次，之后恢复旧版并停下，后台任务跑完自己卸载。',
  '- 安装卡只有新版本真的跑起来才算完成，“马上要装了”的回执不算数。',
  '- 安装失败直接推到你手机。',
  '',
  '席位轮换（在做）',
  '',
  '- 你的要求已记进看板：现在只在 CN 和 US2 之间换，US 到周五前跳过。',
  '- 机制照你说的改：',
  '  - 哪个席位用尽就跳过哪个，只在剩下有额度的之间换。',
  '  - 额度数据过期的席位不能当成有额度直接切过去。',
  '  - 新队长 3 分钟内没开工就换下一个，连续 3 次失败推手机，不再静默空等。',
  '- 你问是不是换到了没额度的队长上空转：我现在不能确定。看板记的是 3:51 从 US 换到 CN，而 CN 的 5小时额度大约 3:50 才重置，所以很可能是新队长一启动就撞了额度，没人接手。这只是推测，我让队员用日志把 2:59 到 10:25的时间线还原出来，写清哪些是证实的。',
  '',
  '装好重启后我接着派剩下的活（合回 main 打标签、Relay 交接重构、手机对话页修整）。',
].join('\n');

// drawn two columns in; a table too wide for the terminal became records, and
// reflow glued the third record onto the second
const PROGRESS = [
  '今天已经落地的',
  '',
  '  版本: 1.2.0',
  '  Mac: 上午 10:34 装上',
  '  Windows: 已升',
  '  手机网页: —',
  '  主要内容: 两机同步、一条命令发版、排队卡死修复等 9 条',
  '  版本: 1.2.1',
  '  Mac: 14:04 装上',
  '  Windows: 已升',
  '  手机网页: 已上线',
  '  主要内容: 安装防死循环、席位轮换跳过用尽席位、监听不再空转、手机对话页气泡、手机页面单独部署版本: 1.2.2 Mac: 15:20 装上Windows: 还没升手机网页: 已上线主要内容: Relay 交接重构、看板星图外观、“指令送不进去”修复',
  '',
  '  正在做的 4 件事',
  '',
  '  - 1.2.2 收尾（Cursor Grok）：合回 main、打标签、Windows 升到 1.2.2。已经动了 11',
  '    个文件，正在等一条命令跑完。',
  '  - 修 3 条架构图旧测试失败（Cursor Grok）：在排查，已动 2 个文件。',
  '  - 排查看板拖拽排序偶发失败（Cursor Grok）：还在分析阶段。',
  '  - 星图卡片状态标签省略小修（Opus）：测试已写好，正在出截图。',
  '',
  '  这后三条修完会合成 1.2.3。',
  '',
  '  额度',
  '  - Claude：CN（我在用）每周剩 36%；US2 每周剩 60%，5 小时额度已恢复到 95%。',
  '  - Codex：每周剩 25%，只留给集成打包。',
  '  - Cursor Grok：正常，现在的主力。',
  '',
  '  等你的两件事（都不阻塞发版）',
  '  - US 席位的重置卡是否生效：额度面板从凌晨 4:02 起一直没有新数据，仍显示每周用尽。',
  '  - Windows 上的 GitHub 登录失效，需要你重新登录一下。',
].join('\n');

// the echo of the prompt with a diff tail right under it, a tool summary, a
// numbered list with a wrapped item, the rating prompt under the reply
const STEPS = [
  '❯ 三端统一那件事不用等我回家，你直接推进，需要我做什么…',
  '        +rts/agentdeck-roadmap/，队长先看图）',
  '        +；c-board-a3 路线图对账。加上两个在跑的会话共 8 个。',
  '    146 +',
  '    147  ## 卡在哪',
  '    148  未处理回执和提问在 AgentDeck 中',
  '         保留；额度用尽的会话保持原席位',
  '         。',
  '    149',
  '',
  'Ran 1 shell command',
  '',
  '你说得对，不需要等你回家。之前停着是在等你点头，并不是非要你人在电脑前；队员直接用 SSH 连 VPS 和 Windows 就能干。现在按你说的直接推进。',
  '',
  '先说清一点：三端统一不只是改 VPS 配置，是四步连着走，顺序不能乱。',
  '',
  '1. 侦察（已派 Cursor Grok，只读）：查清 VPS 上 Caddy 和 SSH 的现状、Windows在不在线、现在手机是经哪条路连到 Mac 的。',
  '2. Mac',
  '   先装带多机支持的新版：这部分代码改的是手机网页的服务端，会和刚做的发图片接口撞在一起，合并后我会让Opus 再做一次安全复核。',
  '3. 再动 VPS：部署新的 Caddy 配置和手机总台页面。',
  '4. 最后 Windows：升级 AgentDeck，建到 VPS 的隧道。',
  '',
  '唯一真正的风险在第 3 步：你现在就是用手机经这台 VPS 的 Caddy 连回来的。如果配置改坏了，你的手机会连不上，也就没法叫我修。所以这一步我会要求先校验配置、失败自动回滚。',
  '',
  'How is Claude doing this session? (optional)',
  '1: Bad    2: Fine   3: Good   0: Dismiss',
].join('\n');

// the reply begins inside a diff tail: its first row lost its indent when the
// reply was trimmed. Then a table the terminal drew with box lines: its rules
// are gone and its rows are glued onto one line.
const TABLE = [
  '上），用户未反对',
  '    25',
  '    26 +- [10-05 16:11] 用户要求队长持续多派活，不要只留两三个在跑｜路线图对账产出后按清单',
  '       +派（/Users/me/reports/agentdeck-roadmap/next-batch.md）',
  '    27 +',
  '    28  ## 交付状态',
  '',
  '那边尤其靠它。按你说的交给 Sonnet 5.5：',
  '  - Grok 已收到指令，停止改代码，只写完交接文件、推送、交回执。',
  '  - Sonnet 还没开出来：任务卡还挂在 Grok',
  '    名下，系统不让同一张卡同时开两个会话。Grok 回执一到我就开，不用你再说。',
  '',
  '  UI 那几件：一件做完，两件之前被额度打断、没交任何回执。现在 CN 席位 5小时额度还剩 97%，我已用 Opus 5.5 在 CN上重开，都要求接着已有成果做，不从零重来。',
  '',
  '  │         UI 任务          │                     状态                      │ │ 桌面额度区改版           │ 已做完并推送到分支 feat/quota-panel-compact   │ │ 终端架构图重做           │ 刚重开，Opus·CN                               │ │ 手机网页显示各账号额度   │ 刚重开，Opus·CN                               │',
  '',
  '  额度：',
  '  - Claude US 用尽，20:19 恢复。',
  '  - Codex 本周只剩 8%。',
  '',
  '  完整记录在 /Users/me/reports/agentdeck-ui-batch/report.md，那两张要不要现在也重派，你说一声。',
].join('\n');

// a long message of the user's own: the bubble clips it and offers the rest
const ASKED = ['失败后安装脚本没有停，而是每十几秒重试一次，一直空转到今天上午，共两千多次？这种问题是很严重的 bug。你看一下后续怎么解决：比如最多重试 3 次或者 4 次，然后就停下来回头报告，这个肯定要你来解决。',
  '另外，队长换席位这个事情你再记一下：我们当前换席位的话，暂时先跳过 US，相当于现在只在 US2 跟 CN 之间换，因为 US 已经没有额度了。这个席位的问题你应该能解决一下。',
  '还有，这 6 个小时相当于都没有干活。想办法，这个必须要有人解决：以后安装失败要第一时间告诉我，不能等我早上自己发现；队长换席位之后如果新队长没有接上，也要有人知道。'].join('\n\n');

// a long message sent while 队长 was still busy: the turn was read from the middle
// of its echo, so the saved reply opens with the end of the user's own words
const LATE = '接着上面那件事说：课前预习的材料以后能不能自动整理成一份文档，每天晚上发到我的阅读器上，睡前直接看。另外我刚才看到另外几个会话在取课程资料的时候好像出了点问题，是不是那个网站把自动访问拦住了？它有没有公开的数据接口之类的？印象里是有的，你研究一下能不能直接走接口。这件事很重要，弄好以后后面的课程资料就不用我自己去管了，你这边直接就能拉下来。如果官方没有现成的接口，就上网搜一下，应该已经有人解决过这个问题。';
const LATE_TAIL = LATE.slice(LATE.indexOf('印象里是有的'));
const LATE_REPLY = [
  LATE_TAIL,
  '',
  'Ran 2 shell commands',
  '',
  '先更正一处',
  '',
  '之前我说那张卡「正在自动审查」是错的，它实际没有触发自动审查。我已经手动补派了审查，它会核对编译和测试，以及会不会影响你日常的录音和粘贴。',
  '',
  '你这几条消息的处理：',
  '',
  '课程资料和课前预习',
  '',
  '- 取资料的会话没有被网站拦住，正在正常取材料。它用的就是网站自带的数据接口，借本机已登录的会话在后台调。',
  '- 它已经查到两门课，下次课都是明天，所以今晚先出这两门的预习材料。',
  '',
  '发到阅读器',
  '',
  '可以做：材料整理成一份文档后，每晚定时发一份过去。这件事我记了一张卡，等预习材料的格式定下来就派。',
].join('\n');

const card = (title, status, receipt) => ({ colId: 'gone-' + title.length, title, status, project: 'agentdeck', receipt: receipt ? { files: [], images: [], failed: '', explicit: true, source: 'command', ...receipt } : null });

// now: the time of the last turn. Returns the saved chat's turns.
function turns(now) {
  let ts = now - 9 * 60 * MIN;
  const at = (minutes) => (ts += minutes * MIN);
  const said = (id, user, reply, worked) => { const start = at(6); return { id, ts: start, end: start + worked * 1000, user, reply, done: true, atts: [] }; };
  const task = (id, title, status, receipt) => ({ id, ts: at(1), kind: 'task', user: title, reply: receipt ? receipt.summary || '' : '', done: true, atts: [], task: card(title, status, receipt) });
  return [
    said('f-why', '怎么一晚上了，一个版本都没有更新过来？为什么 1.2 失败了？一晚上你都干了哪些活，告诉我。', WHY, 59),
    task('k-wrap', '1.2.1 收尾：合回 main + tag + Windows 升级（Cursor Grok）', 'done', { summary: 'main 已快进到 32c8061，annotated tag v1.2.1 已推送并用 ls-remote 核对。Windows 实际运行版本是 1.2.1，一次安装成功，会话、聊天、设置和隧道都保留。', files: ['/Users/me/reports/agentdeck-1.2.1/wrap-up/report.md'] }),
    task('k-doc', '双机说明文档（Gemini Flash）', 'done', { summary: '后来又给这个会话发了新指令，结果看后面的卡片。', source: 'superseded' }),
    task('k-board', '任务看板视觉重做：比星光版更炫（Opus·US2）', 'failed', { failed: '额度用尽，会话没交回执就结束了。' }),
    said('f-bug', ASKED, BUG, 74),
    // a receipt delivery AgentDeck typed itself: only terminal residue came back
    { id: 'f-quiet', ts: at(3), end: ts + 9000, user: '', reply: 'Ran 1 shell command\n\nBackground command "Wait for receipts" completed (exit code 0)', done: true, atts: [] },
    task('k-install', '1.2.2 安装并重启（Cursor Grok）', 'done', { summary: 'AgentDeck 安装 1.2.2 成功；Target version and running process verified；现在运行 1.2.2。' }),
    said('f-steps', '三端统一那件事不用等我回家，你直接推进，需要我做什么再告诉我。', STEPS, 31),
    said('f-table', 'UI 那几件怎么样了？交接那边交给 Sonnet 吧。', TABLE, 44),
    said('f-late', LATE, LATE_REPLY, 144),
    said('f-progress', '现在怎么样了 推进到什么地步了', PROGRESS, 18),
    task('k-radar', 'Schedule 里看竞品雷达结果并直接审核（Opus·US2）', 'working', null),
    task('k-chat', 'Mac 桌面端队长对话页排版重做（Opus·US2）', 'queued', null),
  ];
}

module.exports = { turns, WHY, BUG, PROGRESS, STEPS, TABLE, ASKED, LATE, LATE_TAIL };
