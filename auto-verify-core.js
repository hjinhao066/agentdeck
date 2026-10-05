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

  // Who made a model: the reviewer must come from a different one than the
  // executor. First matching rule wins; the model name beats the agent's default.
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

  // The dispatcher's routing table, restricted to who may verify: Gemini 3.8 Flash
  // is the Captain's default verifier (rule 16, spends no Claude quota), Codex
  // GPT-6.1 Sol next, Opus 5.5 is the final-review model, Opus 4.6 Thinking on
  // Antigravity is its "审查" model. Preference order; `agent` resolves through
  // BoardCore.commandForAgent, `command` is used as written.
  const CANDIDATES = [
    { id: 'gemini-flash', label: 'Gemini 3.8 Flash（Antigravity）', family: 'google', agent: 'agy' },
    { id: 'codex-sol', label: 'Codex GPT-6.1 Sol', family: 'openai', agent: 'codex' },
    { id: 'claude-opus', label: 'Claude Opus 5.5', family: 'anthropic', command: 'claude --dangerously-skip-permissions --model claude-opus-5-5 --effort high' },
    { id: 'agy-opus-46', label: 'Opus 4.6 Thinking（Antigravity）', family: 'anthropic', command: 'agy --dangerously-skip-permissions --model claude-opus-4-6-thinking' },
  ];

  // The reviewer must differ from the executor and have quota left. `quotaOut(cmd)`
  // is the same passive-quota judgment the dispatcher uses; unknown is not out.
  // Never picks the executor's own family and never guesses an unknown one.
  function pickReviewer({ executor, candidates = CANDIDATES, commandOf, quotaOut = () => false, rules = FAMILY_RULES }) {
    const own = familyOf(executor, rules);
    if (!own) {
      const who = executor && (executor.agent || executor.model) ? `${executor.agent || '?'} / ${executor.model || '?'}` : '未记录';
      return { reason: `看不出执行会话（${who}）用的是哪家模型，无法保证审查者与它不同` };
    }
    const why = [];
    for (const candidate of candidates) {
      if (candidate.family === own) { why.push(`${candidate.label}：与执行会话同属 ${FAMILY_NAMES[own] || own}`); continue; }
      const cmd = commandOf(candidate);
      if (quotaOut(cmd)) { why.push(`${candidate.label}：额度用尽`); continue; }
      return { candidate, cmd, family: candidate.family, executorFamily: own };
    }
    return { reason: `没有可用的审查者（必须和执行会话不同提供方）。${why.join('；')}` };
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
      '- 不通过：complete --failed "不通过：1) 具体问题（哪个文件/命令/实际结果） 2) …"，把每个问题写具体，对方会按原文返工。',
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

  return { REVIEW_PREFIX, REWORK_PREFIX, reviewAttemptId, reworkAttemptId, isReviewAttempt, FAMILY_RULES, FAMILY_NAMES, familyOf, CANDIDATES, pickReviewer, verdict, reviewPrompt, reworkMessage };
});
