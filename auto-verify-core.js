(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoVerifyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Attempt ids are deterministic per card and round, so a replayed request
  // (restart, heartbeat, quota recovery) lands on the same attempt, never a second one.
  const REVIEW_PREFIX = 'auto-review-';
  const REWORK_PREFIX = 'auto-rework-';
  const reviewAttemptId = (cardId, round) => `${REVIEW_PREFIX}${cardId}-r${round}`;
  const reworkAttemptId = (cardId, round) => `${REWORK_PREFIX}${cardId}-r${round}`;
  const isReviewAttempt = (id) => typeof id === 'string' && id.startsWith(REVIEW_PREFIX);
  // The round of this card's automatic review attempt; Infinity for any other id,
  // so only a review of an older round can be told apart as void.
  const reviewAttemptRound = (cardId, id) => {
    const head = `${REVIEW_PREFIX}${cardId}-r`;
    return typeof id === 'string' && id.startsWith(head) && /^\d+$/.test(id.slice(head.length)) ? Number(id.slice(head.length)) : Infinity;
  };

  // Who made a model. Only used to describe an executor in a message; the reviewer is
  // not chosen by it any more (see pickReviewer). First matching rule wins; the model
  // name beats the agent's default.
  const FAMILY_RULES = [
    { model: /claude|opus|sonnet|haiku/i, family: 'anthropic' },
    { model: /gpt|codex|^o\d/i, family: 'openai' },
    { model: /gemini/i, family: 'google' },
    { model: /grok/i, family: 'xai' },
    { agent: /^Claude$/, family: 'anthropic' },
    { agent: /^Codex$/, family: 'openai' },
    { agent: /^Grok$/, family: 'xai' },
    { agent: /^Antigravity$/, family: 'google' },
  ];
  const FAMILY_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI' };
  function familyOf(assignee, rules = FAMILY_RULES) {
    const a = assignee || {};
    const rule = rules.find((r) => (!r.model || r.model.test(a.model || '')) && (!r.agent || r.agent.test(a.agent || '')));
    return rule ? rule.family : null;
  }

  // Who may review (the user's rule of 2026-10-09): a fresh Claude session of its own, Opus 5.5
  // for anything important and Sonnet 5.5 for a simple card. No hunting for another provider and
  // no Gemini/agy reviewer; a session separate from the executor's is the independence asked for.
  // `command` is used as written; `model` says which kind of card it suits.
  const CANDIDATES = [
    { id: 'claude-opus', label: 'Claude Opus 5.5', family: 'anthropic', model: 'opus', command: 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high' },
    { id: 'claude-sonnet', label: 'Claude Sonnet 5.5', family: 'anthropic', model: 'sonnet', command: 'claude --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high' },
  ];
  // Interface work is always reviewed by Opus 5.5, whatever else is true of the card (the user's standing
  // rule: UI gets an Opus final review; a small interface change made by Sonnet is not "simple").
  // It is recognised from what was handed in and what the card says:
  //  - a file that is a page, a style, an image or a UI script (*.css/.html/.svg/.png/.jpg/…, *-ui.js,
  //    *-ui-core.js, renderer.js, sidebar*.js, side-pane.js, style/theme files, mobile-web/, .jsx/.tsx/.vue);
  //  - a screenshot or interface word in the title, the card's text or the receipt (界面, 页面, 样式, 布局,
  //    视觉, 配色, 主题, 深色/浅色, 按钮, 图标, 弹窗, 侧栏, 手机端, 截图, UI, CSS, layout, theme, sidebar, button, icon).
  // A false hit costs an Opus review; a miss would put a Sonnet on a screen.
  // The words are the user's own: pages (历史页, 设置页), design, charts (用量图, 柱状图, 图表), menus, fonts, windows,
  // the star map and the architecture diagram, besides the plain interface words; the English ones take their plurals.
  const UI_FILE = /\.(?:css|scss|less|html?|svg|png|jpe?g|gif|webp|bmp|jsx|tsx|vue)$|(?:^|[\\/])(?:[^\\/]*-ui(?:-core)?\.js|renderer\.js|sidebar[^\\/]*\.js|side-pane\.js|chat-ui\.js|pages\.js|mobile-web\.js|crew-map[^\\/]*\.js|preview-[^\\/]*\.js|[^\\/]*(?:style|theme)[^\\/]*\.(?:js|css)|mobile-web[\\/].+)$/i;
  const UI_WORDS = /界面|页面|页|设计|样式|布局|视觉|配色|主题|深色|浅色|按钮|图标|弹窗|窗口|菜单|字体|侧栏|手机端|网页端|截图|动效|动画|图表|用量图|柱状图|折线图|饼图|星图|架构图|流程图|\bUI\b|\bUX\b|\bCSS\b|\blayouts?\b|\btheme[sd]?\b|\bsidebars?\b|\bbuttons?\b|\bicons?\b|\bmenus?\b|\bfonts?\b|\btooltips?\b|\bmodals?\b|\bdialogs?\b|\bscreenshots?|\bmock-?ups?\b/i;
  function isUiWork({ card, receipt } = {}) {
    const exec = receipt || (card && card.exec_receipt) || {};
    // receipts list deliverables (a report, a screenshots folder), not code: a path is read for its words too
    if ((Array.isArray(exec.files) ? exec.files : []).some((f) => typeof f === 'string' && (UI_FILE.test(f) || UI_WORDS.test(f)))) return true;
    return UI_WORDS.test([card && card.title, card && card.detail, exec.text].filter(Boolean).join('\n'));
  }
  // A card is simple when nothing about it asks for the best reviewer: not interface work, not marked
  // 高优先级, a short receipt with few files, and an executor that was not on Opus (whoever put Opus on
  // it judged it important). Everything else is reviewed by Opus.
  const SIMPLE_FILES = 3;
  const SIMPLE_RECEIPT = 800;
  function reviewIsSimple({ card, receipt } = {}) {
    if (!card || card.important === true || isUiWork({ card, receipt })) return false;
    const exec = receipt || card.exec_receipt || {};
    if (/opus/i.test((exec.assignee && exec.assignee.model) || '')) return false;
    const files = Array.isArray(exec.files) ? exec.files.length : 0;
    return files <= SIMPLE_FILES && String(exec.text || card.latest_receipt || '').length <= SIMPLE_RECEIPT;
  }

  // A test instance (--test-user-data) must never start a real model on its own. Which program a launch
  // line runs, by name (a path, quotes, `command`, env assignments and .exe/.cmd/.bat/.ps1 are looked through).
  // A stand-in is anything else: `node fake-agent.js`.
  const REAL_AGENTS = new Set(['claude', 'claude-ds', 'agy', 'antigravity', 'gemini', 'codex', 'cursor-agent', 'cursor', 'grok']);
  function realAgentProgram(command) {
    const words = String(command || '').match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
    let i = words[0] === 'command' || words[0] === '&' ? 1 : 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const name = String(words[i] || '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
    return REAL_AGENTS.has(name) ? name : '';
  }
  // The reason a test instance refuses an automatic opener (dispatcher, auto review) its command; '' when it may run.
  function testInstanceRefusal(command, what) {
    const name = realAgentProgram(command);
    return name ? `测试实例里${what}只许开替身命令，不开真的 ${name}（它会真的调用模型、可能乱派活、花额度）。命令：${String(command).slice(0, 80)}` : '';
  }
  // One argument for the shell the Captain's terminal runs, in single quotes so that nothing inside is interpreted.
  // PowerShell reads ' and the typographic single quotes ‘ ’ ‚ ‛ as quotes (a doubled one is the character itself);
  // a double typographic quote cannot end a single-quoted string there, but a line break is flattened anyway.
  // POSIX shells: ' becomes '\''. Never a character filter: a card title is anybody's text.
  function quoteArg(value, platform) {
    const text = String(value == null ? '' : value).replace(/[\r\n\u2028\u2029]+/g, ' ');
    if (platform === 'win32') return "'" + text.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q) + "'";
    return "'" + text.replace(/'/g, "'\\''") + "'";
  }
  // The `new` command the Captain puts in another Claude reviewer by hand, ready to paste. The model and the effort
  // go in --command (new has no --model / --effort / --verify of its own and refuses them); the title names the model
  // that runs, like the automatic reviewer's does. A card that could not be read is reviewed by Opus.
  function manualReviewCommand({ card, receipt, cli, platform = 'darwin', executorId = '<执行会话>', seat = '' }) {
    const opus = !reviewIsSimple({ card, receipt });
    const model = opus ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
    const title = reviewTitle(card.title || '', opus ? 'Claude Opus 5.5' : 'Claude Sonnet 5.5');
    const q = (v) => quoteArg(v, platform);
    const program = cli || (platform === 'win32' ? 'node "$env:AGENTDECK_BOARD_CLI"' : 'node "$AGENTDECK_BOARD_CLI"');
    return [program, 'new', '--task-id', q(card.id), '--project', q(card.project || ''), '--title', q(title),
      '--task', q(`独立审查卡片 ${card.id}，按验收要求逐条核对后给出通过或不通过`), '--reviews', q(executorId),
      ...(seat ? ['--seat', q(seat)] : []),
      '--command', `"claude --dangerously-skip-permissions --model ${model} --effort high"`].join(' ');
  }

  // stanceOf(command, seatId) is the passive-quota judgment `quota` shows (QuotaCore.commandStance):
  // ok / low / unmetered may start a session (ok first); out and error never; unknown (no reading,
  // an old one, a failing query) is never taken for "has quota". Only the last-resort Claude
  // fallback may still use an unknown seat, and says so (`unverified`).
  // The program name comes from quota-core's commandIdentity, the reading `quota` uses for the same command: `claude.exe`,
  // a quoted or full path to it, `command claude` and NAME=value prefixes are all Claude; `claude-ds` and `node claude` are not.
  const quotaCore = () => {
    try { return typeof module === 'object' && module.exports ? require('./quota-core') : globalThis.QuotaCore; } catch (_) { return globalThis.QuotaCore; }
  };
  const isClaudeCommand = (command) => {
    const identity = quotaCore()?.commandIdentity;
    if (typeof identity === 'function') return identity(command).name === 'claude';
    return /^(?:command\s+)?(?:"[^"]*claude"|'[^']*claude'|[^\s]*claude)(?:\s|$)/.test(String(command || '').trim());
  };
  const RANK = { ok: 0, unmetered: 1, low: 2 };
  const WHY = { out: '额度用尽', error: '登录或额度查询出错', unknown: '额度读数过期或没有，不能当作有额度', unmetered: '没有额度读数' };
  // The first Claude seat with room for this command, a seat a new session would use first
  // leading the list. `weak` is the first seat whose reading is only unknown.
  function pickSeat({ candidate, command, seats, stanceOf, why }) {
    let best = null, weak = null;
    for (const seat of seats) {
      const stance = stanceOf(command, seat.id);
      const name = `${candidate.label}（${seat.label || seat.id}）`;
      if (RANK[stance] !== undefined) {
        if (!best || RANK[stance] < RANK[best.stance]) best = { candidate, cmd: command, seat, stance };
        if (stance === 'ok') break;
      } else {
        why.push(`${name}：${WHY[stance] || WHY.unknown}`);
        if (stance !== 'out' && stance !== 'error') weak = weak || { candidate, cmd: command, seat, stance };
      }
    }
    return { best, weak };
  }
  function pickReviewer({ card, receipt, simple, candidates = CANDIDATES, seats, stanceOf = () => 'unmetered' }) {
    let wantSimple = simple !== undefined ? !!simple : reviewIsSimple({ card, receipt });
    if (wantSimple && (card || receipt) && isUiWork({ card, receipt })) wantSimple = false;   // interface work: Opus, whatever else says
    // the model that suits the card leads; table order decides the rest
    const lead = candidates.filter((c) => c.model === (wantSimple ? 'sonnet' : 'opus'));
    const ordered = [...lead, ...candidates.filter((c) => !lead.includes(c))];
    const seatList = Array.isArray(seats) ? seats : [];
    const why = [];
    let weak = null;
    for (const candidate of ordered) {
      const done = (pick, extra = {}) => ({ candidate, cmd: pick.cmd, seat: pick.seat, stance: pick.stance, simple: wantSimple, family: candidate.family, ...extra });
      if (!isClaudeCommand(candidate.command)) {
        const stance = stanceOf(candidate.command, '');
        if (RANK[stance] === undefined) { why.push(`${candidate.label}：${WHY[stance] || WHY.unknown}`); continue; }
        return done({ cmd: candidate.command, seat: null, stance });
      }
      if (!seatList.length) { why.push(`${candidate.label}：没有已登录的 Claude 席位`); continue; }
      const found = pickSeat({ candidate, command: candidate.command, seats: seatList, stanceOf, why });
      if (found.best) return done(found.best);
      weak = weak || found.weak;
    }
    if (weak) return { candidate: weak.candidate, cmd: weak.cmd, seat: weak.seat, stance: weak.stance, simple: wantSimple, family: weak.candidate.family, unverified: true };
    return { reason: `没有可用的审查者（Claude 各席位额度都用尽或出错）。${why.join('；')}` };
  }

  // The dispatcher is the cheap session that tidies a card and runs `new` once. Gemini Flash
  // first (it spends no Claude quota), but only while a fresh reading says it has room; when
  // Gemini is out, stale, failing or unread, a Claude Haiku 5.5 session. Haiku because this is a
  // short, rule-following turn, the kind of job the user hands to Haiku 5.5 ("便宜调度员"); it
  // draws on the same account pool as Sonnet, so Sonnet would be no more available, only dearer.
  const DISPATCHERS = [
    { id: 'gemini-flash', label: 'Gemini 3.8 Flash（Antigravity）', family: 'google', agent: 'agy' },
    { id: 'claude-haiku', label: 'Claude Haiku 5.5', family: 'anthropic', command: 'claude --dangerously-skip-permissions --model claude-haiku-5-5 --effort medium' },
  ];
  function pickDispatcher({ candidates = DISPATCHERS, commandOf, seats, stanceOf = () => 'unmetered' }) {
    const seatList = Array.isArray(seats) ? seats : [];
    const why = [];
    let weak = null, claudeTried = 0, claudeError = 0, fallbackSeat = null;
    for (const candidate of candidates) {
      const cmd = commandOf(candidate);
      if (!isClaudeCommand(cmd)) {
        // a provider other than Claude must have a fresh reading that says there is room
        const stance = stanceOf(cmd, '');
        if (stance === 'ok' || stance === 'low') return { candidate, cmd, seat: null, stance, family: candidate.family };
        why.push(`${candidate.label}：${WHY[stance] || WHY.unknown}`);
        continue;
      }
      if (!seatList.length) { why.push(`${candidate.label}：没有已登录的 Claude 席位`); continue; }
      for (const seat of seatList) {
        claudeTried++;
        if (stanceOf(cmd, seat.id) === 'error') claudeError++;
        else fallbackSeat = fallbackSeat || seat;
      }
      const found = pickSeat({ candidate, command: cmd, seats: seatList, stanceOf, why });
      if (found.best) return { candidate, cmd, seat: found.best.seat, stance: found.best.stance, family: candidate.family };
      weak = weak || found.weak;
    }
    if (weak) return { candidate: weak.candidate, cmd: weak.cmd, seat: weak.seat, stance: weak.stance, unverified: true, family: weak.candidate.family };
    // every Claude seat has a damaged login or a failing query: no Haiku is opened on it, the Captain is told instead.
    // Otherwise nothing is usable now and the Haiku waits for quota; `fallbackSeat` is the first seat that is not
    // damaged (the active one leads), so the wait and the later start never land on a damaged seat.
    const allError = claudeTried > 0 && claudeError === claudeTried;
    return { reason: `没有可用的调度会话（Gemini 与 Claude 额度都用尽或出错）。${why.join('；')}`, allError, fallbackSeat: allError ? null : fallbackSeat };
  }

  // A card title often ends with the executor's own make, e.g. "（Opus 5.5 high·066us）". A review
  // session is titled with what it really runs, so those marks come out of the card's title first.
  const MODEL_PART = /^(?:claude\s*)?(?:opus|sonnet|haiku)(?:[\s-]*\d+(?:\.\d+)?)?(?:\s*(?:low|medium|high|xhigh|max))?$|^(?:gemini|gpt|codex|grok|cursor|agy|antigravity|deepseek)\b.*$|^(?:cn|us2?|\d{3}us|default)$/i;
  function stripModelMarks(title) {
    return String(title || '').replace(/[（(]([^（()）]*)[）)]/g, (whole, inner) => {
      const parts = inner.split(/[，,、·/|]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (!parts.some((p) => MODEL_PART.test(p))) return whole;
      // "Opus 5.5 high·066us" leaves nothing; "放进 Hermes 网站，Opus 5.5" keeps its first half
      const kept = parts.filter((p) => !MODEL_PART.test(p));
      return kept.length ? `（${kept.join('，')}）` : '';
    }).replace(/\s+/g, ' ').trim();
  }
  // "审查：<card, executor's marks removed>（Claude Opus 5.5）": the provider and model that really run.
  function reviewTitle(cardTitle, label, max = 80, prefix = '审查：') {
    const mark = `（${label}）`;
    const room = max - prefix.length - mark.length;
    const kept = room > 0 ? stripModelMarks(cardTitle).slice(0, room).trim() : '';
    return `${prefix}${kept}${mark}`;
  }

  // The reviewer states its verdict first. Anything else is not a verdict:
  // the card then waits for the Captain rather than being guessed done or failed.
  const LEAD = /^[\s>*#_`~\-–—\[\]【】「」"'（()）]+/;
  function verdict(text) {
    const head = String(text || '').trim().replace(LEAD, '');
    if (/^(?:不通过|未通过|验收不通过|审查不通过|不予通过|fail(?:ed)?|reject(?:ed)?)(?![a-z])/i.test(head)) return 'fail';
    if (/^(?:通过|验收通过|审查通过|pass(?:ed)?|approved?)(?=$|[\s:：，,。.！!；;—–\-（(*\]】」"'`])/i.test(head)) return 'pass';
    return 'unclear';
  }

  const list = (items) => (items && items.length ? items.map((f) => `  - ${f}`).join('\n') : '  （回执没有列出文件）');
  // Everything the reviewer needs in one message: the card, the executor's full
  // receipt and files, which session did it, and the fixed checklist.
  function reviewPrompt({ card, receipt }) {
    const exec = receipt || {};
    const who = exec.assignee ? `${exec.assignee.agent || '?'} / ${exec.assignee.model || '?'}` : '未记录';
    return [
      '你是 AgentDeck 的验收审查员，独立审查另一个会话刚交回的活。只审不改。',
      `卡片 id：${card.id}\n项目：${card.project}\n标题：${card.title}\n说明：${card.detail || '（无）'}`,
      `被审查的执行会话：${exec.session_id || '未记录'}（${who}）`,
      `执行会话的回执全文：\n${exec.text || card.latest_receipt || '（没有回执）'}`,
      `它列出的文件：\n${list(exec.files)}`,
      '验收要求（每一条都要亲自核对，不能只信回执）：',
      '1. 回执里列出的文件，逐个用命令确认真的存在、内容不是空的。',
      '2. 回执提到的提交，确认提交号真实存在，并且已经推送到远程（例如 git fetch 后 git branch -r --contains <提交号>，或 git ls-remote）。',
      '3. 测试亲自跑一遍，只跑和这次改动相关的测试，不跑全量 E2E；以你亲眼看到的结果为准，不照抄回执里的数字。',
      '4. 回执提到的截图，确认文件真的落盘（路径存在、文件大小不为 0）。',
      '5. 看改动记录（git diff / git log），有没有删除测试用例，或者放宽断言来让测试变绿。',
      '6. 只审不改：不要修改、提交、推送任何文件，也不要替对方修复问题。',
      '结论必须明确，二选一，并且回执的第一个词就是结论：',
      '- 通过：complete --result "通过：一两句话说明你核对了什么"（不要加 --failed）。',
      '- 不通过：complete --result "不通过" --failed "不通过：1) 具体问题（哪个文件/命令/实际结果） 2) …"，把每个问题写具体，对方会按原文返工。',
      '没写明确结论的回执不会被当成通过。',
    ].join('\n');
  }

  // What goes back to the original executor: the reviewer's words unchanged.
  function reworkMessage({ card, findings }) {
    return [
      `卡片「${card.title}」（${card.id}）的验收没有通过。请按下面审查员的原话逐条返工，改完照常 complete 交回执（写清改了什么、文件、你亲自跑过的测试结果）。`,
      '审查结论原文：',
      findings,
    ].join('\n');
  }

  return { REVIEW_PREFIX, REWORK_PREFIX, reviewAttemptId, reworkAttemptId, isReviewAttempt, reviewAttemptRound, FAMILY_RULES, FAMILY_NAMES, familyOf, CANDIDATES, DISPATCHERS, reviewIsSimple, isUiWork, isClaudeCommand, quoteArg, realAgentProgram, testInstanceRefusal, manualReviewCommand, pickReviewer, pickDispatcher, stripModelMarks, reviewTitle, verdict, reviewPrompt, reworkMessage };
});
