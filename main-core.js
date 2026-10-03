// Pure helpers behind 队长 (Captain), the main session: the instructions it starts
// with, the receipt contract appended to work it hands out, reading a receipt
// back out of a finished reply, and the short ledger it sees. No DOM, no
// Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Sessions 队长 lets work at once (owner's choice); more `new` calls wait.
  const MAX_ACTIVE = 15;
  // A finished background session is archived after this long with nothing new.
  const ARCHIVE_AFTER = 10 * 60_000;
  const MAX_SUMMARY = 400;
  const MAX_FAILURE = 240;
  const MAX_FILES = 10;
  const MAX_PATH = 500;
  const STATUS = { plain: '未开始', working: '干活中', quota: '额度用尽/等待', input: '等你回复', done: '已完成', exited: '已退出' };
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

  const oneLine = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

  // Appended by the app to every instruction 队长 hands out. Workers do the
  // work without waiting on the user; a question goes to 队长, not the user.
  const RECEIPT_CONTRACT = [
    '',
    '---',
    '（AgentDeck 约定）这是队长派给你的活：直接干完，不要停下来等用户确认。',
    '拿不准、需要别人拍板时，在最终回复的最后单独写下面两行，然后停下，队长会回复你：',
    '【提问】',
    '问题：一两句话说清要队长决定什么',
    '做完或做不下去时，在最终回复的最后单独写：',
    '【回执】',
    '摘要：一到三句话说清结果',
    '文件：每行一个落盘文件的完整路径，没有就写 无',
    '失败：没做成时写一两句原因，做成了就不写这一行',
    '回执里不要贴文件正文。',
  ].join('\n');

  // Only models each CLI listed on the owner's accounts; launch commands match
  // BoardCore's presets.
  const PROVIDERS = [
    'Antigravity：agy --dangerously-skip-permissions --model gemini-3.8-flash-high　Antigravity 只用 Gemini 3.8 Flash，绝不用 Gemini 3.1 Pro，其他模型（包括 Claude）一律不用。档位写在模型名最后：gemini-3.8-flash-low、gemini-3.8-flash-medium、gemini-3.8-flash-high。绝对不要加 --effort：Antigravity 看到 --effort 会悄悄换成 Claude 模型！',
    'Cursor CLI：cursor-agent --force --model grok-4.7-high-fast　主要用 Grok 4.7 跑脏活和数据抓取。Cursor 会话刚开的头 1–2 分钟可能没有任何输出，属于正常初始化，别急着判定卡死。',
    'Claude Code：claude --dangerously-skip-permissions --effort high　默认模型是 Opus 5.5，留给 UI、最关键的代码和终审；重要代码和核心改动加 --model claude-sonnet-5-5。Claude Code 额度受限时，可改用 Cursor 里的同名模型（claude-opus-5-5-high、claude-sonnet-5-5-high）。',
    '不要用 Claude 4.x 和 Haiku 这些旧模型（包括 Antigravity 里的 Claude Sonnet 4.6、Claude Opus 4.6）：用户不要，new 会直接拒绝。',
    'Codex：使用 --agent codex，默认模型 GPT-6.1 Sol；简单活改用 --command "codex -m gpt-6-luna"。免确认沙箱参数 AgentDeck 会自动补齐，不要手动拼接 --dangerously-bypass-approvals-and-sandbox，避免参数重复导致启动失败。',
    '独立的 Grok CLI（grok）：用户的订阅已经取消，用户没点名就不要用它派活（Cursor 里的 grok 模型不受影响）。',
  ];
  const ROUTING = [
    'Opus 5.5：UI 设计、最关键核心代码、最终审核（Claude Code 默认，或 Cursor claude-opus-5-5-high）。',
    'Sonnet 5.5：重要代码与核心改动（Claude Code 加 --model claude-sonnet-5-5，或 Cursor claude-sonnet-5-5-high）。',
    'Codex GPT-6.1 Sol：批量写代码、写测试、CI/CD 修复（直接用 --agent codex）。',
    'Codex GPT-6 Luna：简单的轻量代码与杂项活（--command "codex -m gpt-6-luna"）。',
    'Gemini 3.8 Flash：检索、整理、中文写作、简单到中等代码（Antigravity，放开用，不消耗 Claude 额度；不用 Gemini 3.1 Pro）。',
    'Cursor Grok 4.7：脏活、抓数据、外部信息采集（cursor-agent --force --model grok-4.7-high-fast）。',
    '数据抓取兜底：网上的数据抓不到时，不要盲目手写无头爬虫死磕，先找 GitHub 现成工具、OpenCLI、agent-reach 技能；若仍抓不到再考虑调度 Muse.ai 或 ChatGPT 浏览器（computer use）。',
    '额度轮换：你看不到各家的实时额度。某个会话说额度用完、被限流或没登录，就用 new 换下一个开新会话重派，并告诉用户换成了哪个。',
  ];
  // Effort tiers, lowest first. Cursor takes the tier as the model id's suffix
  // and lists exactly these ids for Opus and Sonnet.
  const EFFORT = Object.freeze([
    { tier: 'medium', when: '简单的活（查找、小改动、整理）' },
    { tier: 'high', when: '一般的写代码（默认）' },
    { tier: 'xhigh', when: '复杂的活，或者同一件事已经失败过' },
    { tier: 'max', when: '最关键、最难的活' },
  ].map(Object.freeze));
  const CURSOR_MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']
    .flatMap((m) => EFFORT.map((e) => `${m}-${e.tier}`)));

  // The board CLI path is an environment variable: PowerShell (Windows columns)
  // reads it as $env:NAME, POSIX shells as $NAME.
  function boardCli(platform) {
    return platform === 'win32' ? 'node "$env:AGENTDECK_BOARD_CLI"' : 'node "$AGENTDECK_BOARD_CLI"';
  }

  // note: extra lines (after a context reset) placed before the closing line.
  function instructions(platform, note, legacyReceiptInjection = false) {
    const cli = boardCli(platform);
    const bashCli = boardCli('darwin'); // Bash tool uses POSIX env syntax, including on Windows.
    return [
      '你是 AgentDeck 的「队长」：常驻的总负责人。你听懂用户要什么，把活派给各个会话（deck 里的列，也就是你的队员），再把简短回执告诉用户。',
      '',
      '规则：',
      '1. 不要在这一列里改文件、跑任务或写实现过程。实际工作都交给别的会话。只有两件事你自己做：读写进度看板（见第 11 条），以及只读的 sysctl vm.swapusage（见第 12 条）。',
      '2. 和别的会话打交道，只用下面这些终端命令：',
      `   ${cli} ledger                          列出全部会话：id、标题、状态、最近回执`,
      `   ${cli} new --title "一句话标题" --task "任务正文" [--cwd 目录] [--agent claude|agy|cursor|grok|codex | --command "完整启动命令"]   新开一个会话并把任务作为它的第一条消息；--agent 和 --command 都不写就用和你一样的 agent`,
      `   ${cli} tell --to 会话id --message "指令" [--replace] [--now]   把指令发进已有的会话。--replace 清掉尚未送达的待补充指令，只保留这一条；--now 先中断当前操作，再在输入框就绪时立即发指令，可与 --replace 同用。普通待补充指令会合并成一条发送`,
      `   ${cli} stop --id 会话id                 发送 Esc，中断当前操作，保留终端；未发送的补充指令取消`,
      `   ${cli} archive --id 会话id              结束终端并归档，保留对话；即使正在干活也执行，不弹确认框`,
      `   ${cli} read --id 会话id [--turns 3] [--find 关键词]   读某个会话已保存的对话，只在用户追问细节时用；清空上下文前的队长对话也这样读，id 列在 ledger 最后`,
      `   ${cli} read --id captain-history --find "关键词" [--turns 3]   跨全部清空前的队长记录搜索，按需读取简短结果`,
      `   ${cli} peek --id 会话id [--lines 40]   只读查看终端实时屏幕/最近输出（去颜色，最多1000行）；不发任何输入，也不会恢复已归档的会话。需要检查进度或诊断卡住时才用，比 read 省上下文`,
      `   ${cli} receipts [--wait] [--timeout 秒]  取回还没看过的回执；--wait 阻塞等回执/提问，超时输出空并退出，省略 timeout 就一直等`,
      `   ${cli} answer --to 会话id --key y|n|1|2|3|enter|esc   回答停在确认或权限提示上的会话`,
      '3. 派活单步原则：一个会话一次只派一件活！绝对不要在会话正在忙碌（working）时连续向其追加多件任务。如果用户一条消息里有几件互不依赖的事，或者一个复杂大任务能拆解，拆开分别交给不同的会话并行跑。同一件活的补充和修改用 tell 发回原会话，只转发新指令，不要把文件正文再贴一遍；用户要改方向、放弃正在做的，用 tell --replace --now，只有用户明确要停才用 stop。',
      '4. 用户没点名目录时不要传 --cwd；点名了就传那个目录。',
      '5. 派完马上用一两句话告诉用户交给了哪个会话，不要等结果；用户可以接着派活。',
      legacyReceiptInjection
        ? '6. 已显式开启旧回执注入回退：队员的回执和提问会在输入框为空且 agent 空闲时自动发给你（以【AgentDeck 新回执】开头），也会附在用户的下一条消息里。不要再挂 receipts --wait 后台监听。看完用一两句话告诉用户结果；需要接着做的，直接派下去。回答用几句话，不要把别的会话的全文、长日志或文件正文搬进来。'
        : `6. 回执走后台通道，不经过你的输入框，也不附在用户消息里。开工后立即用 Claude Code 的 Bash 工具（run_in_background: true）运行 ${bashCli} receipts --wait --timeout 300（Bash 中用 POSIX 环境变量写法，包括 Windows）；始终保持恰好一个后台监听，不要在终端输入框里运行它，不要重复挂多个。命令有未读回执/提问就输出【AgentDeck 新回执】并退出，Bash 的后台完成通知会唤醒你；读取该任务的输出，处理完立即再用 run_in_background: true 挂一个。超时空输出也立即重挂；恢复会话或清空上下文后先检查是否已有监听，只在没有时启动。若当前工具不支持后台完成通知，明确告知用户并用 receipts 按需读取，不能改用输入框注入。看完用一两句话告诉用户结果；需要接着做的，直接派下去。回答用几句话，不要把别的会话的全文、长日志或文件正文搬进来。`,
      '7. 队员向你提问、或停在确认/权限提示时，你来拿主意：有把握就用 tell 或 answer 回复它，让它接着干；没把握，或者涉及删除数据、花钱、对外发布这类不可逆的事，再请用户决定，并说清要用户决定什么。',
      '8. 判断会话卡没卡先用 peek，至少等 5 分钟！会话启动、复杂分析或大模型深度思考时，终端可能数分钟内没有完整文本输出，这完全正常，绝对不要急着判定会话卡死；排查状态优先使用轻量 peek 察看终端滚动尾部，至少观察 5 分钟以上再做介入或重试。',
      `9. 你开的会话在后台跑，用户平时看不到它们，靠你的汇报了解进度。同一时间最多 ${MAX_ACTIVE} 个会话在干活：再 new 会自动排队，有空位时 AgentDeck 自动开新会话并把任务发过去，不用你重派。用 tell 给还在忙的会话追加指令会标记为「待补充」，等它空下来自动执行。`,
      `10. 做完的会话没有新指令 ${ARCHIVE_AFTER / 60_000} 分钟后会自动归档（终端关掉，对话保留）；以后用 tell 发给它会自动恢复。`,
      '11. 开工先跑 ledger，再看 ~/.agents/boards/ 里进行中的看板（每个项目一份 <项目名>.md：在做什么、谁在做、卡在哪、等用户拍板什么、最后更新时间）。以 ledger 和看板为准，不要凭记忆猜进度。派活、收回执、项目有进展或卡住时，顺手把对应看板里那几行改掉，并在「更新记录」加一行；还没有看板的新项目，按 ~/.agents/boards/README.md 的格式建一份。看板只写事实和文件路径，不写密钥、不贴长日志。',
      `12. 并发上限 ${MAX_ACTIVE}，按 swap 把控：一次要开好几个会话之前，在终端跑 sysctl vm.swapusage（Mac），free 剩不到 1GB 就少开，等有会话收工再开；上限始终是 ${MAX_ACTIVE} 个并发。Windows 没有这个命令，就按 ledger 里干活的会话数把控，宁可少开，绝不把宿主机内存跑崩。`,
      '',
      '可用的 agent。每件活可以选不同的 provider 和模型：用 new --command 写下面的完整启动命令，要换模型就改 --model 后面的名字。',
      ...PROVIDERS.map((p) => `   ${p}`),
      '',
      '派给谁（模型分工路由偏好，用户明确点名 agent 或模型时按用户要求）：',
      ...ROUTING.map((r) => `   - ${r}`),
      '',
      '用多大的档位（effort）：',
      ...EFFORT.map((e) => `   - ${e.when}：${e.tier}`),
      `   Cursor 把档位写在模型名最后，只用这些名字：${CURSOR_MODELS.join('、')}。`,
      '   Claude Code 用 --effort 写档位。Antigravity 把档位写在模型名最后，只有 low、medium、high（没有 xhigh 和 max），不能加 --effort。',
      '',
      ...(note ? [note, ''] : []),
      '现在只回复一句「队长已就绪」，然后等用户的指令。',
    ].join('\n');
  }

  // What a freshly cleared 队长 is told: where its old conversation is, and
  // the work still out. Ids and titles only, never the old conversation.
  const MAX_NOTE_TASKS = 20;
  function resetNote(oldId, active) {
    const lines = ['用户刚清空了你的模型上下文。'];
    if (oldId) lines.push(`清空前的对话没有删，存在 ${oldId}；用户问起以前的事时用 read --id ${oldId} --find 关键词 按需读，不要整段搬进来。`);
    const list = (active || []).slice(-MAX_NOTE_TASKS);
    if (list.length) {
      lines.push('清空前派出去、还没结束的活（回执和提问会照常发给你）：');
      list.forEach((t) => lines.push(`   - 「${oneLine(t.title, 60)}」(${t.colId})：${TASK_STATUS[t.status] || t.status}`));
    }
    return lines.join('\n');
  }
  const TASK_STATUS = { waiting: '排队等空位', queued: '待补充', working: '干活中', quota: '额度用尽/等待', input: '停在确认', asking: '在问你' };

  // A launch command's words, quotes kept; the program's bare name.
  const WORDS = /(?:[^\s"'\\]|\\.|"(?:\\.|[^"])*"|'[^']*')+/g;
  const unquote = (w) => String(w).replace(/^["']|["']$/g, '');
  const programName = (w) => unquote(w).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

  // A relaunch after a reset must start the agent fresh, never pick up the
  // cleared conversation again: drop resume flags from the launch command.
  function freshCommand(cmd) {
    const source = String(cmd || '');
    const words = source.match(WORDS) || [];
    if (!words.length) return '';
    const name = programName(words[0]);
    if (!['claude', 'cursor-agent', 'agy', 'gemini', 'grok', 'codex'].includes(name)) return source;
    const claude = name === 'claude';
    const out = [words[0]];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (['cursor-agent', 'codex'].includes(name) && i === 1 && /^resume$/i.test(w)) {
        if (words[i + 1] && !words[i + 1].startsWith('-')) i++;
        continue;
      }
      if (name === 'codex' && w === '--last') continue;
      if (/^--(continue|resume)=/.test(w)) continue;
      if (w === '--continue' || (claude && w === '-c')) continue;
      if (w === '--resume' || (claude && w === '-r')) {
        if (words[i + 1] && !words[i + 1].startsWith('-')) i++;
        continue;
      }
      out.push(w);
    }
    return out.length === words.length ? source : out.join(' ');
  }

  // Models the owner never wants work handed to, in any CLI: Claude 4.x and
  // older, and Haiku (Antigravity lists claude-sonnet-4-6, claude-opus-4-6-thinking).
  const OLD_MODEL = /^(?:claude-)?haiku|^(?:claude-)?(?:sonnet|opus)-[0-4](?!\d)|^claude-[0-4](?!\d)/i;
  // Antigravity's effort is the model id's suffix; xhigh and max do not exist.
  const AGY_TIER = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
  const AGY_MODEL = 'gemini-3.8-flash-high';

  // Checks a launch command 队长 picked before a session runs it: { cmd } or
  // { error } for 队长. Antigravity given --effort next to a model id that has
  // its own tier silently runs a different model (it fell back to Claude
  // Sonnet 4.6), and without --model it runs whatever was used last; so the
  // flag goes, its tier moves into the id, and a missing model gets Flash.
  function checkCommand(cmd) {
    const source = String(cmd || '').trim();
    const words = source.match(WORDS) || [];
    if (!words.length) return { cmd: source };
    for (let i = 1; i < words.length; i++) {
      const m = /^--model(=.*)?$/.exec(words[i]);
      const id = m ? unquote(m[1] ? m[1].slice(1) : words[i + 1] || '') : '';
      if (OLD_MODEL.test(id)) {
        return { error: `用户不用 ${id.slice(0, 60)}（Claude 4.x 和 Haiku 都不用）。量大的普通活用 Antigravity 的 gemini-3.8-flash-high（或 -medium、-low）；写代码和重要的活用 Cursor 的 claude-opus-5-5-high 或 claude-sonnet-5-5-high，或者 Claude Code（默认 Opus 5.5，要 Sonnet 加 --model claude-sonnet-5-5）。` };
      }
    }
    // Codex hands out autonomous work like every other agent: no confirmation prompts.
    // Added unless a bypass flag (or its --yolo alias) is already there, since a duplicate fails to start.
    if (programName(words[0]) === 'codex') {
      const bypass = words.some((w) => /^(?:--yolo|--dangerously-bypass-approvals-and-sandbox)$/.test(w));
      return { cmd: bypass ? source : [words[0], '--dangerously-bypass-approvals-and-sandbox', ...words.slice(1)].join(' ') };
    }
    if (programName(words[0]) !== 'agy') return { cmd: source };
    const out = [words[0]];
    let effort = '';
    let model = -1;
    for (let i = 1; i < words.length; i++) {
      const e = /^--effort(?:=(.*))?$/.exec(words[i]);
      if (e) { effort = unquote(e[1] !== undefined ? e[1] : words[++i] || '').toLowerCase(); continue; }
      out.push(words[i]);
      if (/^--model=/.test(words[i])) model = out.length - 1;
      else if (words[i] === '--model' && i + 1 < words.length) { out.push(words[++i]); model = out.length - 1; }
    }
    // right after the program: Go flags stop at the first plain argument
    if (model < 0) { out.splice(1, 0, '--model', AGY_MODEL); model = 2; }
    const eq = /^--model=/.test(out[model]);
    const id = unquote(eq ? out[model].slice(8) : out[model]);
    const family = /^(gemini-[\d.]+-(?:flash|pro))-(?:low|medium|high)$/.exec(id);
    let tier = AGY_TIER[effort];
    if (family && tier) {
      if (/-pro$/.test(family[1]) && tier === 'medium') tier = 'high';   // Pro has only high and low
      out[model] = (eq ? '--model=' : '') + `${family[1]}-${tier}`;
    }
    return { cmd: out.join(' ') === words.join(' ') ? source : out.join(' ') };
  }

  // Sessions 队长 opened before they were marked captainCrew: its first card
  // for that column went out right as the column was created. A column id
  // starts with its creation time in ms (renderer newId); a session 队长 only
  // told something to was created long before.
  function openedByCaptain(columns, tasks) {
    const ids = new Set();
    for (const t of Array.isArray(tasks) ? tasks : []) {
      const born = /^c(\d{13})/.exec(t && t.colId);
      const lag = born ? t.sentAt - Number(born[1]) : NaN;
      if (lag >= 0 && lag < 10_000 && columns.some((c) => c.id === t.colId && !c.isMain)) ids.add(t.colId);
    }
    return ids;
  }

  // Background sessions with work still out: the latest card for the column
  // is not finished (a question waits on 队长 too). Each holds a slot.
  const OPEN = ['queued', 'working', 'quota', 'input', 'asking'];
  function latestTasks(tasks) {
    const latest = new Map();
    (Array.isArray(tasks) ? tasks : []).forEach((t) => { if (t && t.colId) latest.set(t.colId, t); });
    return latest;
  }
  function activeCrew(tasks, crewIds) {
    const ids = new Set();
    latestTasks(tasks).forEach((t, colId) => { if (crewIds.has(colId) && OPEN.includes(t.status)) ids.add(colId); });
    return ids;
  }
  // The 后台 list: sessions at work first (in the order they were sent work),
  // then finished ones, most recently finished first.
  // items: [{ id, state (terminal), lastActive (last turn time) }]
  function crewOrder(items, tasks) {
    const latest = latestTasks(tasks);
    const busy = (it) => it.state === 'working' || it.state === 'input' || it.state === 'quota' || OPEN.includes(latest.get(it.id)?.status);
    const sent = (it) => latest.get(it.id)?.sentAt || 0;
    const finished = (it) => Math.max(latest.get(it.id)?.doneAt || 0, it.lastActive || 0);
    return {
      running: items.filter(busy).sort((a, b) => sent(a) - sent(b)).map((it) => it.id),
      finished: items.filter((it) => !busy(it)).sort((a, b) => finished(b) - finished(a)).map((it) => it.id),
    };
  }
  // Whether a finished background session can be archived now: its last card
  // is closed, 队长 has its receipt, nothing ran for ARCHIVE_AFTER.
  // s: { tasks, pending, inflight }; lastActive: its last turn's time.
  function archivable(s, colId, lastActive, now, after = ARCHIVE_AFTER) {
    const last = latestTasks(s.tasks).get(colId);
    if (!last || OPEN.includes(last.status)) return false;
    if ([...(s.pending || []), ...(s.inflight || [])].some((p) => p.colId === colId)) return false;
    return now - Math.max(last.doneAt || 0, last.sentAt || 0, lastActive || 0) >= after;
  }

  // Earlier 队长 conversations (config.captainHistory). Only this metadata is
  // capped; the chat files themselves are never deleted with it.
  const MAX_HISTORY = 50;
  const HISTORY_ID = /^[A-Za-z0-9_-]{1,80}$/;
  function normalizeHistory(list) {
    const seen = new Set();
    const num = (v) => (Number.isFinite(v) ? v : 0);
    return (Array.isArray(list) ? list : []).filter((h) => h && typeof h.id === 'string' && HISTORY_ID.test(h.id) && !seen.has(h.id) && seen.add(h.id))
      .map((h) => ({ id: h.id, from: num(h.from), to: num(h.to), turns: Math.max(0, Math.round(num(h.turns))), clearedAt: num(h.clearedAt) }))
      .slice(-MAX_HISTORY);
  }
  function stamp(ts) {
    if (!ts) return '?';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function historyText(list, shown = 10) {
    if (!list || !list.length) return '';
    const recent = list.slice(-shown).reverse();
    const lines = recent.map((h) => `${h.id}  ${stamp(h.from)} 到 ${stamp(h.to)}  ${h.turns} 条`);
    const more = list.length > recent.length ? `\n    （更早的还有 ${list.length - recent.length} 段）` : '';
    return '清空上下文前的队长对话（用 read --id 读，可加 --find 关键词）：\n' + lines.map((l) => '    ' + l).join('\n') + more;
  }

  // Reads the 【回执】 block the worker wrote at the end of its reply. Without
  // one, falls back to the reply's last lines and any file paths in it, and
  // says so: a quiet screen is not proof the task succeeded.
  function parseReceipt(reply, findFiles) {
    // a reply is reflowed for the bubble, which can glue 摘要 and 文件 onto
    // one line: put every field label back at the start of its own line
    const text = afterContract(reply).replace(/\r\n?/g, '\n')
      .replace(/([^\n])\s*(摘要|文件|失败|问题)\s*[:：]/g, '$1\n$2：');
    // Only a block starting on its own line outside a fenced example can be
    // the final receipt. Inline mentions and the contract's placeholders aren't.
    let marker = null;
    let fenced = false;
    let offset = 0;
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const m = !fenced && /^\s*(?:⏺\s*)?(【(回执|提问)】|\[(回执|提问)\])\s*$/.exec(line);
      if (m) marker = { at: offset, kind: m[2] || m[3] };
      offset += line.length + 1;
    }
    const at = marker && marker.kind === '回执' ? marker.at : -1;
    const out = { summary: '', files: [], images: [], failed: '', question: '', explicit: false };
    if (marker && marker.kind === '提问') {
      const q = /^\s*(?:问题|question)\s*[:：]\s*([\s\S]*)$/i.exec(text.slice(marker.at).split('\n').slice(1).join('\n'));
      const body = q ? q[1].trim() : '';
      const compact = body.replace(/\s/g, '');
      const finalQuestion = body.split('\n').slice(1).every((line) => /^[ \t]+\S/.test(line));
      if (body && finalQuestion && !compact.startsWith('一两句话') && !/[【\[](?:回执|提问)[】\]]|```|~~~/.test(body)) {
        out.question = oneLine(body, MAX_SUMMARY);
        out.explicit = true;
      }
      return out;
    }
    const addFile = (p) => {
      const f = String(p || '').trim().replace(/^[`'"]+|[`'"，。,;；]+$/g, '').slice(0, MAX_PATH);
      // The contract requires absolute on-disk paths. TUI footers (for example
      // "Update available!") can follow the final files field in an extracted reply.
      if (!/^(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(f) || out.files.includes(f) || out.files.length >= MAX_FILES) return;
      out.files.push(f);
    };
    let finalBlock = true;
    if (at >= 0) {
      let field = '';
      for (const raw of text.slice(at).split('\n').slice(1)) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(摘要|文件|失败|summary|files?|failed|failure)\s*[:：]\s*(.*)$/i.exec(line);
        if (m) {
          field = /^(摘要|summary)$/i.test(m[1]) ? 'summary' : /^(失败|failed|failure)$/i.test(m[1]) ? 'failed' : 'files';
          if (field === 'files') m[2].split(/[,，;；\s]+(?=~?[\\/]|[A-Za-z]:[\\/])/).forEach(addFile);
          else out[field] = (out[field] ? out[field] + ' ' : '') + m[2];
          continue;
        }
        if (field === 'files') {
          const path = line.replace(/^[-*•]\s*/, '');
          if (!/^(?:[`'"]?(?:~?[\\/]|[A-Za-z]:[\\/])|无$|没有文件$|Update available|Run npm install|[✻✽]|https?:\/\/)/i.test(path)) finalBlock = false;
          addFile(path);
        }
        else if (field) out[field] += ' ' + line;
      }
    } else {
      const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      out.summary = paras.slice(-2).join(' ');
      if (findFiles) findFiles(text).forEach(addFile);
    }
    out.summary = oneLine(out.summary, MAX_SUMMARY);
    out.failed = oneLine(out.failed, MAX_FAILURE);
    // Truncated/reflowed copies of the template must not become real receipts.
    const placeholder = /^一到三句话|^没做成时写/.test(out.summary.replace(/\s/g, '')) || /^没做成时写/.test(out.failed.replace(/\s/g, ''));
    out.explicit = at >= 0 && !!out.summary && !placeholder && finalBlock && !/```|~~~/.test(text.slice(at));
    if (at >= 0 && !out.explicit) out.failed = '';
    if (placeholder) { out.summary = ''; out.failed = ''; out.files = []; }
    out.images = out.files.filter((f) => IMAGE.test(f.replace(/:\d+(?::\d+)?$/, '')));
    return out;
  }

  // What the model sees about new receipts, prepended to the user's next message.
  function receiptsForModel(items) {
    if (!items.length) return '';
    const lines = items.map((r) => {
      if (r.question) return `- 「${oneLine(r.title, 60)}」(${r.colId}) 向你提问：${r.question}`;
      if (r.waiting) return `- 「${oneLine(r.title, 60)}」(${r.colId}) 停在确认提示上：\n${r.waiting.split('\n').map((l) => '    ' + l).join('\n')}`;
      const parts = [`- 「${oneLine(r.title, 60)}」(${r.colId})：${r.failed ? '没做成，' + r.failed : r.summary || '已停下，没有写回执'}`];
      if (r.files && r.files.length) parts.push(`  文件：${r.files.join('；')}`);
      return parts.join('\n');
    });
    return '【AgentDeck 新回执】\n' + lines.join('\n') + '\n\n';
  }

  // ---- text the user is typing in the Captain's own input box ----
  // Receipts are typed into that box and sent with Enter, so they must never
  // go in while the box holds something the user has not sent yet.
  // typing: { draft (what the key tracker rebuilt), unknown (history recall or
  // another edit it cannot follow), lastKeyAt }.
  function draftBlocks(typing, now, quietMs) {
    if (!typing) return false;
    return !!typing.draft || !!typing.unknown || now - (typing.lastKeyAt || 0) < quietMs;
  }
  // The agent's input box on screen, read the way the user sees it. plain and
  // masked are the same rows; masked has dim, inverse and coloured cells
  // (placeholder text, the caret) replaced by \u0000, so what is left is text
  // someone typed. null when no box is recognised (no rule lines around a
  // prompt row): the key tracker is then the only evidence.
  const RULE = /^[\s╭╰]*[─━═]{8,}[\s╮╯]*$/;
  const PROMPT_ROW = /^[\s│┃]*[>❯›]\s?/;
  function inputBoxText(plain, masked) {
    const rules = [];
    plain.forEach((line, i) => { if (RULE.test(line)) rules.push(i); });
    if (rules.length < 2) return null;
    const top = rules[rules.length - 2];
    const bottom = rules[rules.length - 1];
    if (bottom - top < 2 || bottom - top > 12) return null;
    const head = PROMPT_ROW.exec(plain[top + 1]);
    if (!head) return null;
    const rows = [masked[top + 1].slice(head[0].length), ...masked.slice(top + 2, bottom)];
    return rows.map((r) => r.replace(/\u0000/g, '').replace(/[│┃]\s*$/, '').trim()).filter(Boolean).join('\n');
  }
  // The task contract is echoed above whatever the worker answers; a receipt
  // only counts below it (the echo has the receipt's own field names in it).
  const CONTRACT_END = new RegExp('回执里不要贴文件正文'.split('').join('\\s*') + '\\s*。?');
  function afterContract(screen) {
    const text = String(screen || '');
    let from = 0;
    for (let m; (m = CONTRACT_END.exec(text.slice(from)));) from += m.index + m[0].length;
    const rest = from ? text.slice(from) : text;
    // The end may have scrolled/wrapped out of the captured screen: an
    // unfinished contract echo has no final answer below it yet.
    return /AgentDeck\s*约定/.test(rest) ? '' : rest;
  }

  function terminalActivity(screen) {
    const lines = String(screen || '').split('\n').slice(-20);
    let quota = -1, resumed = -1, working = -1, queued = false;
    lines.forEach((line, i) => {
      if (/^\s*[⏺⎿✻✽●!⚠]*\s*(?:you['’]?(?:ve| have) hit your (?:(?:usage|session|weekly) )?limit|(?:usage |weekly |session )?limit (?:reached|exceeded)|you['’]?(?:re| are) out of (?:extra )?usage|continuing (?:automatically at|at|shortly).*esc to cancel)\b/i.test(line)) quota = i;
      if (/^\s*[⏺✻✽●]*\s*(?:usage limit reset\b|automatic continue cancel(?:led|ed)\b)/i.test(line)) resumed = i;
      if (/^\s*[⏺✻✽✳✶✢✺●*·]*\s*Doing\s*(?:…|\.\.\.)/i.test(line)) working = i;
      if (/press up to edit queued messages/i.test(line)) queued = true;
    });
    if (quota > resumed && quota > working) return 'quota';
    if (working >= 0 || queued) return 'working';
    return '';
  }

  function statusLabel(state) { return STATUS[state] || STATUS.plain; }

  // node-pty reports the foreground process as a bare name ("zsh", "-zsh")
  // on macOS but can fall back to the shell's full path ("/bin/zsh").
  const SHELL_NAMES = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu|pwsh|powershell|cmd)(\.exe)?$/i;
  function isShellProcess(name) {
    const base = String(name || '').trim().replace(/^.*[\\/]/, '');
    return !base || SHELL_NAMES.test(base);
  }

  // ConPTY has no foreground-process name. Ignore old agent chrome above the
  // latest PowerShell prompt, including prompts wrapped across terminal rows.
  function windowsAgentOutput(screen) {
    const lines = String(screen || '').split('\n');
    let prompt = -1;
    lines.forEach((line, i) => { if (/^\s*PS /i.test(line)) prompt = i; });
    return lines.slice(prompt + 1).join('\n');
  }
  function isWindowsShellPrompt(screen) {
    return /(?:^|\n)\s*PS [^>]*>\s*$/i.test(String(screen || '').trimEnd());
  }

  // One compact line per session for `ledger`.
  function ledgerText(rows) {
    if (!rows.length) return '还没有别的会话。';
    return rows.map((r) => {
      let line = `${r.id}  「${oneLine(r.title, 60)}」  ${statusLabel(r.state)}`;
      if (r.folder) line += `  文件夹:${oneLine(r.folder, 30)}`;
      if (r.receipt) line += `\n    回执：${r.receipt.failed ? '没做成，' + r.receipt.failed : r.receipt.summary || '已停下，没有写回执'}` +
        (r.receipt.files && r.receipt.files.length ? `\n    文件：${r.receipt.files.join('；')}` : '');
      return line;
    }).join('\n');
  }

  // A session's saved turns for `read`, newest last, each cut short. find keeps
  // only turns containing every word of it. Task cards (in a 队长 conversation)
  // show as the work handed out and its receipt.
  function readText(title, turns, n, find) {
    const count = Math.max(1, Math.min(10, Math.round(Number(n) || 3)));
    const words = String(find || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const hit = (t) => { const low = `${t.user}\n${t.reply}`.toLowerCase(); return words.every((w) => low.includes(w)); };
    const picked = turns.filter((t) => (t.user || t.reply) && hit(t)).slice(-count);
    if (!picked.length) return words.length ? `「${title}」里没有包含「${oneLine(find, 60)}」的对话。` : `「${title}」还没有保存的对话。`;
    return picked.map((t) => (t.sourceId ? `记录：${t.sourceId}\n` : '') + (t.kind === 'task'
      ? `派活：「${oneLine(t.user, 120)}」${t.task && t.task.colId ? ` (${t.task.colId})` : ''}\n回执：${oneLine(t.reply, 800) || '（还没有）'}`
      : `用户：${oneLine(t.user, 600)}\n回复：${oneLine(t.reply, 800) || '（没有文字回复）'}`)).join('\n\n');
  }

  return {
    RECEIPT_CONTRACT, STATUS, EFFORT, CURSOR_MODELS, MAX_ACTIVE, ARCHIVE_AFTER, activeCrew, archivable, crewOrder, isShellProcess, windowsAgentOutput, isWindowsShellPrompt, boardCli, instructions, parseReceipt, draftBlocks, inputBoxText, afterContract, terminalActivity,
    receiptsForModel, statusLabel, ledgerText, readText, resetNote, freshCommand, checkCommand, openedByCaptain, normalizeHistory, historyText, MAX_SUMMARY, MAX_HISTORY,
  };
});
